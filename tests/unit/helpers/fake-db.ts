import type { Db } from "@/lib/data/types";

/**
 * Minimal fake of the Supabase client for unit tests (NO real database is involved).
 * `rpc` answers from a map of handlers; `from(table)` returns a chainable, awaitable builder whose result comes
 * from `tables[table]`. Every call is recorded so tests can assert what the code asked the database to do.
 */
export type PgResult = { data: unknown; error: null | { code?: string; message?: string; details?: string | null; hint?: string | null } };
export type Call = { op: string; args: unknown[] };

export function fakeDb(opts: {
  rpc?: Record<string, (args: Record<string, unknown>) => PgResult>;
  tables?: Record<string, PgResult | ((calls: Call[]) => PgResult)>;
}) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const tableCalls: { table: string; calls: Call[] }[] = [];

  const db = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      const h = opts.rpc?.[name];
      return Promise.resolve(h ? h(args) : { data: null, error: { code: "42883", message: `no handler for ${name}` } });
    },
    from(table: string) {
      const calls: Call[] = [];
      tableCalls.push({ table, calls });
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const spec = opts.tables?.[table];
              const res: PgResult = typeof spec === "function" ? spec(calls) : (spec ?? { data: [], error: null });
              return (resolve: (v: PgResult) => unknown) => Promise.resolve(res).then(resolve);
            }
            return (...args: unknown[]) => {
              calls.push({ op: prop, args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { db: db as unknown as Db, rpcCalls, tableCalls };
}

export const ok = (data: unknown): PgResult => ({ data, error: null });
export const pgErr = (code: string, message: string, details?: string, hint?: string): PgResult => ({
  data: null,
  error: { code, message, details: details ?? null, hint: hint ?? null },
});
