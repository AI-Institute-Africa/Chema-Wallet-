// `pnpm audit:verify` — walks audit_log from genesis and checks the hash chain.
// Exit 0 = intact, 1 = broken (prints first bad seq), 2 = usage/connection error.
import { createPgClient } from '@chema/shared';
import { verifyChain } from './chain';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

const db = createPgClient(url, 1);
try {
  const report = await verifyChain(db);
  if (report.ok) {
    console.log(`audit chain OK: ${report.count} rows, head ${report.head}`);
  } else {
    console.error(`audit chain BROKEN at seq ${report.seq}: ${report.problem} (${report.count} rows verified before it)`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('audit verify failed:', err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  await db.close();
}
