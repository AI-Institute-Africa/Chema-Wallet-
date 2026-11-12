// `pnpm audit:verify [--anchors <file>]` — walks audit_log from genesis and
// checks the hash chain; with --anchors it also checks every externally
// anchored head (truncation of the newest rows, consistent rewrites).
// Exit 0 = intact, 1 = broken (prints first bad seq), 2 = usage/connection error.
import { createPgClient } from '@chema/shared';
import { FileAnchorSink, verifyChainWithAnchors } from './anchor';
import { verifyChain } from './chain';

function parseArgs(argv: readonly string[]): { anchors?: string } | null {
  const out: { anchors?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    const next = argv[i + 1];
    if (a === '--anchors' && next && !next.startsWith('--')) {
      out.anchors = next;
      i += 1;
      continue;
    }
    return null;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = process.env['DATABASE_URL'];
if (!args) {
  console.error('usage: audit:verify [--anchors <anchor-file.jsonl>]');
  process.exit(2);
}
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

const db = createPgClient(url, 1);
try {
  if (args.anchors) {
    const anchors = await new FileAnchorSink(args.anchors).readAll();
    const report = await verifyChainWithAnchors(db, anchors);
    if (report.ok) {
      console.log(`audit chain OK: ${report.count} rows, head ${report.head}; ${report.anchors} anchor(s) match`);
    } else {
      console.error(`audit chain BROKEN at seq ${report.seq}: ${report.problem} (${report.count} rows in the database chain)`);
      process.exitCode = 1;
    }
  } else {
    const report = await verifyChain(db);
    if (report.ok) {
      console.log(`audit chain OK: ${report.count} rows, head ${report.head} (no anchors checked: truncation of the newest rows is not detectable without --anchors)`);
    } else {
      console.error(`audit chain BROKEN at seq ${report.seq}: ${report.problem} (${report.count} rows verified before it)`);
      process.exitCode = 1;
    }
  }
} catch (err) {
  console.error('audit verify failed:', err instanceof Error ? err.message : err);
  process.exitCode = 2;
} finally {
  await db.close();
}
