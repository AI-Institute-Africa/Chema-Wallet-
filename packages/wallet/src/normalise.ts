// Normalisation for duplicate detection (docs/05 Fraud controls). Lossy on
// purpose: it only decides what a human should look at, never an outcome.

const NAME_NOISE = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'rev', 'pastor', 'late', 'the']);

function words(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/** "The late Mr. Tendai  MOYO" and "Moyo, Tendai" normalise alike (token order ignored). */
export function normaliseName(name: string): string {
  return words(name)
    .filter((w) => !NAME_NOISE.has(w))
    .sort()
    .join(' ');
}

export function normaliseLocation(location: string): string {
  return words(location).join(' ');
}
