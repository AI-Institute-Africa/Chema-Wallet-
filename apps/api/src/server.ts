import { createCoreServices, LocalFsBlobStore, loadSecrets, MockMalwareScanner, type CoreServices, type Secrets } from '@chema/core';
import { createPgClient } from '@chema/shared';
import { buildApp } from './app';
import { walletCommands } from '@chema/wallet';
import { parseOrigins } from './cors';
import { buildContributions, type ContributionsWiring } from './contributions';
import { chooseOtpProvider } from './otp';
import { buildPayments, type PaymentsWiring } from './payments';
import type { WalletWiring } from './wallet-routes';

const port = Number(process.env['PORT'] ?? 7600);
const host = process.env['HOST'] ?? '0.0.0.0';
const databaseUrl = process.env['DATABASE_URL'];

// Reported through the app logger once it exists (the pool outlives no request).
let reportIdleDbError: (err: Error) => void = () => undefined;
const db = databaseUrl ? createPgClient(databaseUrl, 10, (err) => reportIdleDbError(err)) : undefined;

const otpChoice = chooseOtpProvider(process.env);
let core: CoreServices | undefined;
let secrets: Secrets | undefined;
let startupWarning: string | undefined;
if (db) {
  try {
    secrets = loadSecrets();
    core = createCoreServices({
      db,
      secrets,
      // Real SMS/WhatsApp OTP delivery is decision D16 (channel.* flags); until then codes go
      // nowhere, or to CHEMA_DEV_OTP_FILE on a developer machine (refused in production).
      otp: otpChoice.provider,
      blobs: new LocalFsBlobStore(process.env['CHEMA_BLOB_DIR'] ?? '.data/blobs'),
      scanner: new MockMalwareScanner(),
    });
  } catch (err) {
    startupWarning = err instanceof Error ? err.message : 'core services unavailable';
  }
}

// Base of the public web app for share links + QR codes (docs/05 Public activation).
const publicBaseUrl = process.env['CHEMA_PUBLIC_BASE_URL'] ?? 'http://localhost:3000';
const ipHashKey = process.env['CHEMA_REPORT_IP_KEY'];
const wallets: WalletWiring | undefined = core
  ? {
      commands: walletCommands({ flags: core.flags, publicBaseUrl }),
      publicBaseUrl,
      ...(ipHashKey && ipHashKey.length >= 16 ? { ipHashKey: Buffer.from(ipHashKey) } : {}),
    }
  : undefined;

let payments: PaymentsWiring | undefined;
if (core) {
  try {
    payments = await buildPayments(core);
  } catch (err) {
    startupWarning = err instanceof Error ? err.message : 'payments unavailable';
  }
}
// P05: public page + contributions (signed links use CHEMA_AUTH_SECRET-derived keys).
const contributions: ContributionsWiring | undefined =
  core && payments && secrets ? buildContributions(core, payments.service, { secrets, publicBaseUrl }) : undefined;

const app = buildApp({
  ...(db ? { db } : {}),
  ...(core ? { core } : {}),
  ...(payments ? { payments: payments.service } : {}),
  ...(wallets ? { wallets } : {}),
  ...(contributions ? { contributions: contributions.service } : {}),
  // Web app origin(s) for CORS; defaults to the public web base URL.
  corsOrigins: parseOrigins(process.env['CHEMA_WEB_ORIGINS'] ?? publicBaseUrl),
  version: process.env['APP_VERSION'] ?? '0.0.0',
});
reportIdleDbError = (err) => app.log.warn({ err }, 'idle database connection lost');
if (startupWarning) app.log.warn({ reason: startupWarning }, 'core services disabled: only health routes are served');
if (core) app.log.warn(`${otpChoice.warning}; malware scanning is a MOCK`);
if (payments) {
  app.log.warn('payment rails are MOCKS; contributions are accepted only into verified ACTIVE wallets');
  if (payments.ephemeralWebhookSecret) app.log.warn('CHEMA_MOCK_WEBHOOK_SECRET unset: mock webhook secret is per-process');
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db?.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
