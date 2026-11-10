// Minimal SQL surface shared by node-postgres (runtime) and PGlite (tests).
// No ORM: ledger paths write plain parameterised SQL.

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  /** Single parameterised statement. Pass jsonb params as JSON.stringify(...) with a ::jsonb cast. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Multi-statement SQL with no parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface SqlClient extends Queryable {
  /** Runs fn in one transaction on one connection; rolls back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
