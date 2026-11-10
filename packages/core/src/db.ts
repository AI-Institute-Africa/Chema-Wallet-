// Tiny row helpers for plain-SQL code paths.

/** The first row, or throw: for statements that must return one (INSERT … RETURNING). */
export function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a row from ${what}`);
  return row;
}
