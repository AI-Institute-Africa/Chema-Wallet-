import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin, { looksLikeMoney } from './index.js';

const linter = new Linter({ configType: 'flat' });
const config: Linter.Config[] = [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser as Linter.Parser },
    plugins: { chema: plugin },
    rules: { 'chema/no-number-money': 'error' },
  },
];

function lint(code: string): string[] {
  return linter
    .verify(code, config, 'fixture.ts')
    .map((m) => (m.ruleId === 'chema/no-number-money' ? m.message : `OTHER: ${m.message}`));
}

describe('chema/no-number-money', () => {
  it.each([
    'let amount: number = 0;',
    'function pay(feeMinor: number) {}',
    'interface Payment { gross: number; net?: number }',
    'type T = { totalRaised: number | null };',
    'class W { balance: number = 0 }',
    'const amounts: number[] = [];',
    'function walletTotal(): number { return 0 }',
    'interface P { payout_amount: number }',
  ])('reports %s', (code) => {
    const msgs = lint(code);
    expect(msgs.length, code).toBeGreaterThan(0);
    expect(msgs[0]).toMatch(/money amount/);
  });

  it.each([
    'let amount: bigint = 0n;',
    'let contributorCount: number = 0;',
    'let slaHours: number = 24;',
    'let retentionYears: number = 7;',
    'const MINOR_DIGITS: Record<string, number> = {};',
    'function retryAttempts(n: number): number { return n }',
    'let network: number = 1;',
    'let checksum: string = "";',
  ])('allows %s', (code) => {
    expect(lint(code)).toEqual([]);
  });

  it('splits camel and snake case into words', () => {
    expect(looksLikeMoney('netAmountMinor')).toBe(true);
    expect(looksLikeMoney('internetSpeed')).toBe(false);
    expect(looksLikeMoney('fee_count')).toBe(false);
  });
});
