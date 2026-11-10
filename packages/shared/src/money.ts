// Money = integer minor units + ISO 4217 currency. No floats, no `number` amounts.
// USD is base; ZWG (ZiG) is display/secondary. Both use 2 minor digits.

export const CURRENCIES = ['USD', 'ZWG'] as const;
export type Currency = (typeof CURRENCIES)[number];

const MINOR_DIGITS: Record<Currency, number> = { USD: 2, ZWG: 2 };

export interface Money {
  readonly minor: bigint;
  readonly ccy: Currency;
}

export interface MoneyJSON {
  minor: string;
  ccy: Currency;
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

export function money(minor: bigint, ccy: Currency): Money {
  if (typeof minor !== 'bigint') {
    throw new InvalidMoneyError('minor units must be a bigint');
  }
  if (!isCurrency(ccy)) {
    throw new InvalidMoneyError(`unsupported currency: ${String(ccy)}`);
  }
  return Object.freeze({ minor, ccy });
}

export function zero(ccy: Currency): Money {
  return money(0n, ccy);
}

const INTEGER_STRING = /^-?(0|[1-9]\d*)$/;

/** Parse an integer minor-unit string. Rejects decimals, exponents, whitespace. */
export function parseMinor(value: string): bigint {
  if (typeof value !== 'string' || !INTEGER_STRING.test(value)) {
    throw new InvalidMoneyError(`not an integer minor-unit string: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function assertSameCcy(a: Money, b: Money): void {
  if (a.ccy !== b.ccy) throw new CurrencyMismatchError(a.ccy, b.ccy);
}

export function add(a: Money, b: Money): Money {
  assertSameCcy(a, b);
  return money(a.minor + b.minor, a.ccy);
}

export function sub(a: Money, b: Money): Money {
  assertSameCcy(a, b);
  return money(a.minor - b.minor, a.ccy);
}

export function neg(a: Money): Money {
  return money(-a.minor, a.ccy);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCcy(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.ccy === b.ccy && a.minor === b.minor;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0n;
}

export function sum(items: readonly Money[], ccy: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), zero(ccy));
}

export function toJSON(m: Money): MoneyJSON {
  return { minor: m.minor.toString(), ccy: m.ccy };
}

export function fromJSON(value: unknown): Money {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidMoneyError('money JSON must be an object');
  }
  const { minor, ccy } = value as Record<string, unknown>;
  if (typeof minor !== 'string') {
    throw new InvalidMoneyError('money JSON minor must be a string');
  }
  if (!isCurrency(ccy)) {
    throw new InvalidMoneyError(`unsupported currency: ${String(ccy)}`);
  }
  return money(parseMinor(minor), ccy);
}

/** Display only (e.g. "12.50 USD"). Never parse this back. */
export function format(m: Money): string {
  const digits = MINOR_DIGITS[m.ccy];
  const negative = m.minor < 0n;
  const abs = (negative ? -m.minor : m.minor).toString().padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const frac = abs.slice(abs.length - digits);
  return `${negative ? '-' : ''}${whole}.${frac} ${m.ccy}`;
}
