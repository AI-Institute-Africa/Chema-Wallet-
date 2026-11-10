import { describe, expect, it } from 'vitest';
import { scanText } from './secret-scan.mjs';

// Fixtures are assembled at runtime so this file never trips the scanner itself.
const j = (...parts: string[]) => parts.join('');

describe('secret-scan', () => {
  it.each([
    ['private key', j('-----BEGIN RSA ', 'PRIVATE KEY-----')],
    ['AWS access key', j('AKIA', 'ABCDEFGHIJKLMNOP')],
    ['GitHub token', j('ghp_', 'a'.repeat(36))],
    ['connection string with password', j('postgres://chema:', 'hunter22secret', '@db:5432/x')],
    ['hard-coded credential', j('password', ' = "', 'Sup3rS3cretValue', '"')],
  ])('detects %s', (rule, line) => {
    expect(scanText(line).map((h) => h.rule)).toContain(rule);
  });

  it.each([
    'DATABASE_URL=postgres://chema:change-me@localhost:55432/chema',
    'DATABASE_URL: postgres://chema:${POSTGRES_PASSWORD}@postgres:5432/chema',
    'const passwordMinLength = 12;',
    "redact: ['password']",
  ])('ignores placeholders and benign text: %s', (line) => {
    expect(scanText(line)).toEqual([]);
  });

  it('honours the allow marker', () => {
    expect(scanText(j('AKIA', 'ABCDEFGHIJKLMNOP', ' // secret-scan:', 'allow'))).toEqual([]);
  });
});
