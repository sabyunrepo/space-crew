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
}
