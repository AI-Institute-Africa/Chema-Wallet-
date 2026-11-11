import { describe, expect, it } from 'vitest';
import { auditRepo, auditText } from './scope-audit.mjs';

// Fixtures assembled at runtime so this file never trips the audit itself.
const j = (...parts: string[]) => parts.join('');

describe('scope audit (P10: out-of-scope rails, hard-coded fees)', () => {
  it.each([
    ['bank transfer rail', j("rail: 'BA", "NK'")],
    ['bank transfer rail', j('Pay by bank ', 'transfer')],
    ['remittance (Mukuru)', j('Send with Muk', 'uru')],
    ['remittance (WorldRemit)', j('World', 'Remit')],
    ['USSD', j('Dial *151# (US', 'SD)')],
    ['InnBucks', j('Inn', 'Bucks wallet')],
    ['hard-coded fee amount', j('const platformFee', 'Minor = 100n;')],
    ['hard-coded fee rate', j('commission', 'Rate = 2.5')],
    ['fee copy with an amount', j('A fee ', 'of $1 applies')],
  ])('detects %s', (rule, line) => {
    expect(auditText(line).map((h) => h.rule)).toContain(rule);
  });

  it.each([
    'CHECK ((fee_minor = 0) = (fee_payer IS NULL))',
    "fee: m(r.fee_minor),",
    "{t('disclosure.fee', { amount: formatMoney(quote.providerFee) })}",
    'const banking = true; // unrelated word',
  ])('ignores benign text: %s', (line) => {
    expect(auditText(line)).toEqual([]);
  });

  it('honours the allow marker (tests proving a rail is absent)', () => {
    expect(auditText(j("rail: 'BA", "NK' // scope-audit:", 'allow'))).toEqual([]);
  });

  it('the repository is clean: zero hits in UI, copy, API, migrations, runbooks and tests', () => {
    expect(auditRepo().map((h) => `${h.file}:${h.line} ${h.rule}`)).toEqual([]);
  });
});
