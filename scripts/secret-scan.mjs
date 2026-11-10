#!/usr/bin/env node
// Fails if tracked or staged-untracked files contain likely secrets.
// Suppress a deliberate fixture line with the marker comment: secret-scan:allow
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RULES = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Anthropic/OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['connection string with password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!change-me@|\$\{)[^\s@/]{6,}@/i],
  ['hard-coded credential', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i],
];

const ALLOW = 'secret-scan:allow';
const SKIP = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|pdf|woff2?|zip)$/i];

export function scanText(text, file = '<text>') {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    for (const [name, re] of RULES) {
      if (re.test(line)) hits.push({ file, line: i + 1, rule: name });
    }
  });
  return hits;
}

function listFiles() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => f && !SKIP.some((re) => re.test(f)));
}

function main() {
  const hits = [];
  for (const file of listFiles()) {
    let text;
    try {
      if (statSync(file).size > 2_000_000) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // deleted in working tree
    }
    hits.push(...scanText(text, file));
  }
  if (hits.length) {
    for (const h of hits) console.error(`secret-scan: ${h.file}:${h.line} ${h.rule}`);
    console.error(`secret-scan: ${hits.length} finding(s). Remove the secret (rotate it if it was ever pushed).`);
    process.exit(1);
  }
  console.log('secret-scan: clean');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
