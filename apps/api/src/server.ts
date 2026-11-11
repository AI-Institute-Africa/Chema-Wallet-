import { createCoreServices, LocalFsBlobStore, loadSecrets, MockMalwareScanner, type CoreServices, type Secrets } from '@chema/core';
import { OpsService } from '@chema/ops';
import { createPgClient } from '@chema/shared';
import { buildApp } from './app';
import { walletCommands } from '@chema/wallet';
import { parseOrigins } from './cors';
import { buildContributions, type ContributionsWiring } from './contributions';
import { buildClaims, type ClaimsWiring } from './fidelity';
import { chooseOtpProvider } from './otp';
import { buildPayments, type PaymentsWiring } from './payments';
import { buildPayouts } from './payouts';
import { buildWhatsApp, chooseWhatsAppProviders } from './whatsapp';
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
// Admin portal (apps/admin, P09): WhatsApp hand-offs link to it and CORS allows it.
const portalUrl = process.env['CHEMA_PORTAL_URL'] ?? 'http://localhost:3001';
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

// P06: Fidelity claim path (mock adapter outside production; flag off by default).
const claims: ClaimsWiring | undefined = core && secrets ? buildClaims(core, secrets) : undefined;

// P07: payouts, governance, closure (payouts.enabled + rail flags off by default).
const payouts = core && payments && secrets ? buildPayouts(core, payments.rails, secrets) : undefined;

// P08: WhatsApp channel (simulator outside production; Meta stub behind channel.whatsapp, D16).
const waProviders = core ? await chooseWhatsAppProviders(core, process.env) : undefined;
const whatsapp =
  core && secrets && contributions && payouts && wallets && waProviders
    ? buildWhatsApp(core, {
        secrets,
        providers: waProviders.providers,
        contributions: contributions.service,
        wallets: wallets.commands,
        payouts,
        ...(claims ? { claims: claims.service } : {}),
        publicBaseUrl,
        portalUrl,
      })
    : undefined;
// P09: admin portal back end (queues, maker-checker, reports, audit explorer).
const ops = core ? new OpsService(core) : undefined;
const metaVerifyToken = process.env['CHEMA_META_VERIFY_TOKEN'];

const app = buildApp({
  ...(db ? { db } : {}),
  ...(core ? { core } : {}),
  ...(payments ? { payments: payments.service } : {}),
  ...(wallets ? { wallets } : {}),
  ...(contributions ? { contributions: contributions.service } : {}),
  ...(claims ? { claims: claims.service } : {}),
  ...(payouts ? { payouts } : {}),
  ...(whatsapp ? { whatsapp } : {}),
  ...(ops ? { ops } : {}),
  ...(metaVerifyToken && metaVerifyToken.length >= 16 ? { metaVerifyToken } : {}),
  // Browser origin(s) for CORS; defaults to the public web app + the admin portal.
  corsOrigins: parseOrigins(process.env['CHEMA_WEB_ORIGINS'] ?? `${publicBaseUrl},${portalUrl}`),
  version: process.env['APP_VERSION'] ?? '0.0.0',
});
reportIdleDbError = (err) => app.log.warn({ err }, 'idle database connection lost');
if (startupWarning) app.log.warn({ reason: startupWarning }, 'core services disabled: only health routes are served');
if (core) app.log.warn(`${otpChoice.warning}; malware scanning is a MOCK`);
for (const w of waProviders?.warnings ?? []) app.log.warn(w);
if (claims) app.log.warn(claims.mock ? 'Fidelity adapter is a MOCK (D14)' : 'Fidelity adapter is the unconfigured stub (D14): claim calls answer 503');
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
