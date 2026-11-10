import { createCoreServices, LocalFsBlobStore, loadSecrets, MockMalwareScanner, MockOtpProvider, type CoreServices } from '@chema/core';
import { createPgClient } from '@chema/shared';
import { buildApp } from './app';
import { buildPayments, type PaymentsWiring } from './payments';

const port = Number(process.env['PORT'] ?? 7600);
const host = process.env['HOST'] ?? '0.0.0.0';
const databaseUrl = process.env['DATABASE_URL'];

// Reported through the app logger once it exists (the pool outlives no request).
let reportIdleDbError: (err: Error) => void = () => undefined;
const db = databaseUrl ? createPgClient(databaseUrl, 10, (err) => reportIdleDbError(err)) : undefined;

let core: CoreServices | undefined;
let startupWarning: string | undefined;
if (db) {
  try {
    core = createCoreServices({
      db,
      secrets: loadSecrets(),
      // Real SMS/WhatsApp OTP delivery is decision D16 (channel.* flags); until then codes go nowhere.
      otp: new MockOtpProvider(),
      blobs: new LocalFsBlobStore(process.env['CHEMA_BLOB_DIR'] ?? '.data/blobs'),
      scanner: new MockMalwareScanner(),
    });
  } catch (err) {
    startupWarning = err instanceof Error ? err.message : 'core services unavailable';
  }
}

let payments: PaymentsWiring | undefined;
if (core) {
  try {
    payments = await buildPayments(core);
  } catch (err) {
    startupWarning = err instanceof Error ? err.message : 'payments unavailable';
  }
}

const app = buildApp({
  ...(db ? { db } : {}),
  ...(core ? { core } : {}),
  ...(payments ? { payments: payments.service } : {}),
  version: process.env['APP_VERSION'] ?? '0.0.0',
});
reportIdleDbError = (err) => app.log.warn({ err }, 'idle database connection lost');
if (startupWarning) app.log.warn({ reason: startupWarning }, 'core services disabled: only health routes are served');
if (core) app.log.warn('OTP delivery and malware scanning are MOCKS (no real provider configured)');
if (payments) {
  app.log.warn('payment rails are MOCKS; the contribution gate refuses every wallet until verification lands (P04/P05)');
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
