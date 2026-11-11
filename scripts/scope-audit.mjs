#!/usr/bin/env node
// P10 scope audit (CLAUDE.md "MVP scope guardrails", docs/13 Commercial):
// out-of-scope rails and hard-coded fees must not appear in UI, copy, API,
// migrations, runbooks or tests. Spec/planning text (docs/, phases/,
// CLAUDE.md) names them on purpose and is exempt. A test that proves a rail
// is ABSENT may name it on a line marked `scope-audit:allow`.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const OUT_OF_SCOPE = [
  ['bank transfer rail', /\bbank[\s_-]*transfer\b|['"`]BANK['"`]|\bBANK[_-]/i],
  ['remittance (Mukuru)', /mukuru/i],
  ['remittance (WorldRemit)', /world[\s_-]*remit/i],
  ['USSD', /\bussd\b/i],
  ['InnBucks', /inn[\s_-]*bucks/i],
];

// A fee, commission or revenue-share amount written into code instead of
// coming from the (empty, flag-gated) fee schedule.
export const HARD_CODED_FEES = [
  ['hard-coded fee amount', /\b[A-Za-z_]*(?:fee|commission|surcharge|revenue_?share)[A-Za-z_]*\s*[:=]\s*(?:-?[1-9]|0\.\d*[1-9]|['"`][1-9])/i], // a zero is no fee
  ['hard-coded fee rate', /\b[A-Za-z_]*(?:fee|commission)[A-Za-z_]*(?:rate|pct|percent|bps)\s*[:=]\s*(?:[1-9]|0\.\d*[1-9])/i],
  ['fee copy with an amount', /\b(?:fee|charge)\s+of\s+(?:US)?\$\s?\d/i],
];

const SKIP = [
  /^docs\//,
  /^phases\//,
  /^CLAUDE\.md$/,
  /^PROGRESS\.md$/,
  /^scripts\/scope-audit/,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /pnpm-lock\.yaml$/,
  /\.(png|jpg|jpeg|gif|ico|pdf|woff2?)$/i,
];

export function auditText(text, file = '<text>', { fees = true } = {}) {
  const hits = [];
  const rules = fees ? [...OUT_OF_SCOPE, ...HARD_CODED_FEES] : OUT_OF_SCOPE;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('scope-audit:allow')) return;
    for (const [rule, re] of rules) if (re.test(line)) hits.push({ file, line: i + 1, rule, text: line.trim().slice(0, 120) });
  });
  return hits;
}

export function listFiles() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => f && !SKIP.some((re) => re.test(f)));
}

export function auditRepo() {
  const hits = [];
  for (const file of listFiles()) {
    let text;
    try {
      if (statSync(file).size > 2_000_000) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Fee rules target code; test fixtures may set fee schedules on purpose.
    hits.push(...auditText(text, file, { fees: !/\.test\.tsx?$|test-support\.ts$|testing\.ts$/.test(file) }));
  }
  return hits;
}

function main() {
  const hits = auditRepo();
  if (hits.length) {
    for (const h of hits) console.error(`scope-audit: ${h.file}:${h.line} ${h.rule}: ${h.text}`);
    console.error(`scope-audit: ${hits.length} finding(s).`);
    process.exit(1);
  }
  console.log('scope-audit: clean');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
