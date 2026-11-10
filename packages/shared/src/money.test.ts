import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  add,
  compare,
  format,
  fromJSON,
  money,
  parseMinor,
  sub,
  sum,
  toJSON,
} from './money';

describe('Money', () => {
  it('adds and subtracts same-currency amounts exactly', () => {
    const a = money(1050n, 'USD');
    const b = money(25n, 'USD');
    expect(add(a, b).minor).toBe(1075n);
    expect(sub(a, b).minor).toBe(1025n);
    expect(sum([a, b, b], 'USD').minor).toBe(1100n);
  });

  it('refuses cross-currency arithmetic', () => {
    expect(() => add(money(1n, 'USD'), money(1n, 'ZWG'))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(1n, 'USD'), money(1n, 'ZWG'))).toThrow(CurrencyMismatchError);
  });

  it('rejects number (float) inputs at runtime', () => {
    expect(() => money(10.5 as unknown as bigint, 'USD')).toThrow(InvalidMoneyError);
    expect(() => money(10 as unknown as bigint, 'USD')).toThrow(InvalidMoneyError);
  });

  it('rejects unknown currencies', () => {
    expect(() => money(1n, 'EUR' as never)).toThrow(InvalidMoneyError);
  });

  it.each(['1.5', '1e3', ' 12', '', '01', '+5', 'NaN', 'Infinity'])(
    'parseMinor rejects %j',
    (input) => {
      expect(() => parseMinor(input)).toThrow(InvalidMoneyError);
    },
  );

  it('round-trips JSON as a string, beyond Number.MAX_SAFE_INTEGER', () => {
    const big = money(9007199254740993n, 'USD');
    const json = JSON.parse(JSON.stringify(toJSON(big))) as unknown;
    expect(fromJSON(json)).toEqual(big);
  });

  it('rejects JSON with numeric minor', () => {
    expect(() => fromJSON({ minor: 100, ccy: 'USD' })).toThrow(InvalidMoneyError);
  });

  it('formats for display', () => {
    expect(format(money(1250n, 'USD'))).toBe('12.50 USD');
    expect(format(money(5n, 'ZWG'))).toBe('0.05 ZWG');
    expect(format(money(-100n, 'USD'))).toBe('-1.00 USD');
  });
});
