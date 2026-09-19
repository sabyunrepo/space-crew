// Hand-written minimal type shape for the bundled postgres.js driver
// (vendor/postgres.js), used only so `deno check` / `tsc` can verify
// index.ts locally. TypeScript picks this up automatically because it sits
// next to postgres.js with the same basename (the standard "types for a
// plain JS module" pattern).
//
// This file is NOT part of the deployed function: build.mjs excludes any
// *.d.ts file from dist/files.json (the platform also forbids the double
// dot in a deployed filename).

export interface Row {
  // deno-lint-ignore no-explicit-any
  [column: string]: any;
}

export interface Sql {
  (strings: TemplateStringsArray, ...args: unknown[]): Promise<Row[]>;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  end(options?: { timeout?: number }): Promise<void>;
}

export default function postgres(url: string, options?: Record<string, unknown>): Sql;
