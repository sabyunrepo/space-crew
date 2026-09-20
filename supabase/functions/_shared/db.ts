/** Minimal SQL client contract the Postgres repository is written against.
 * Both the real postgres.js pool (crew-api/index.ts, crew-api/sbp-entry.ts)
 * and the PGlite test harness (tests/server/postgres-repository.test.ts) adapt
 * to this shape, so postgres-repository.ts never imports a driver directly -
 * it stays a plain, portable module that `npm run typecheck` can check like
 * any other file under supabase/functions/_shared. */
export interface DbTx {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}
export interface DbPool {
  begin<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  /** One statement, no surrounding transaction. A single statement is already
   * atomic, so a read that fits in one is two round trips cheaper than begin()
   * - which matters for snapshot(), the call every client repeats every few
   * seconds as the broadcast safety net. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}
