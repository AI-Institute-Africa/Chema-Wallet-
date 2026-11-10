import { createPgClient } from '@chema/shared';
import { buildApp } from './app';

const port = Number(process.env['PORT'] ?? 7600);
const host = process.env['HOST'] ?? '0.0.0.0';
const databaseUrl = process.env['DATABASE_URL'];

const db = databaseUrl ? createPgClient(databaseUrl) : undefined;
const app = buildApp({ ...(db ? { db } : {}), version: process.env['APP_VERSION'] ?? '0.0.0' });

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
