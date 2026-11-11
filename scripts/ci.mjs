#!/usr/bin/env node
// `pnpm verify`: typecheck → lint → test → secret scan → scope audit → dependency audit (runtime deps, high+). Stops at first failure
// and exits with that step's status (no pipes, so exit codes are real).
import { spawnSync } from 'node:child_process';

const steps = ['typecheck', 'lint', 'test', 'secret-scan', 'scope-audit', 'dep-audit'];

for (const name of steps) {
  console.log(`\n▶ ${name}`);
  // Fixed command strings only (no user input), so shell mode is safe here.
  const res = spawnSync(`pnpm run ${name}`, { stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error(`✖ ${name} failed (exit ${res.status ?? res.signal})`);
    process.exit(res.status ?? 1);
  }
}
console.log('\n✔ all checks passed');
