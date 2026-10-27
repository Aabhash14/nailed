import type { Db } from "@/lib/data/types";

/**
 * Stateful in-memory stand-in for the parts of Supabase the limiters and the staff digest use (NO real database).
 * - rpc("rate_limit_hit_info") follows the SQL in 20261019000005_abuse_controls.sql: fixed windows aligned to the
 *   epoch, a denied hit still counts, opportunistic cleanup of this key's windows older than the previous one.
 *   It runs synchronously at call time, so it is atomic like the real upsert.
 * - from(table) supports select (with { count: "exact" }), insert (unique key + window_start), delete, and the
 *   filters eq / in / gte / lt / lte, order, limit. Timestamp columns compare as instants.
 * The clock is the test's `now()`, used as the database clock.
 */
export type Row = Record<string, unknown>;
type Filter = { op: "eq" | "in" | "gte" | "lt" | "lte"; col: string; val: unknown };

const TIME_COLS = new Set(["window_start", "cancelled_at", "created_at"]);

function cmp(col: string, a: unknown, b: unknown): number {
  if (TIME_COLS.has(col)) return Date.parse(String(a)) - Date.parse(String(b));
  return a === b ? 0 : String(a) < String(b) ? -1 : 1;
}

export function memoryDb(opts: {
  now: () => number;
  tables?: Record<string, Row[]>;
  fail?: { rpc?: boolean; tables?: string[] };
  /** Extra RPC handlers (e.g. health_ping). */
  rpc?: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}) {
  const tables: Record<string, Row[]> = { rate_limits: [], orders: [], ...(opts.tables ?? {}) };
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const ops: { table: string; kind: string; filters: Filter[] }[] = [];

  function hit(args: Record<string, unknown>) {
    const key = String(args.p_key);
    const win = Number(args.p_window_seconds);
    const max = Number(args.p_max);
    const nowMs = opts.now();
    const start = Math.floor(nowMs / 1000 / win) * win * 1000;
    const rows = tables.rate_limits!;
    let row = rows.find((r) => r.key === key && Date.parse(String(r.window_start)) === start);
    if (!row) {
      row = { key, window_start: new Date(start).toISOString(), count: 0 };
      rows.push(row);
    }
    row.count = Number(row.count) + 1;
    tables.rate_limits = rows.filter((r) => !(r.key === key && Date.parse(String(r.window_start)) < start - win * 1000));
    const count = Number(row.count);
    const allowed = count <= max;
    return {
      data: [{ allowed, remaining: Math.max(max - count, 0), retry_after_seconds: allowed ? 0 : Math.max(Math.ceil((start + win * 1000 - nowMs) / 1000), 1) }],
      error: null,
    };
  }

  const db = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      if (opts.fail?.rpc) return Promise.resolve({ data: null, error: { code: "08006", message: "down" } });
      if (name === "rate_limit_hit_info") return Promise.resolve(hit(args));
      const extra = opts.rpc?.[name];
      if (extra) return Promise.resolve(extra(args));
      return Promise.resolve({ data: null, error: { code: "42883", message: `no handler for ${name}` } });
    },
    from(table: string) {
      const filters: Filter[] = [];
      let kind = "select";
      let countExact = false;
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      let insertRow: Row | null = null;
      const run = () => {
        ops.push({ table, kind, filters: [...filters] });
        if (opts.fail?.tables?.includes(table)) return { data: null, count: null, error: { code: "08006", message: "down" } };
        const all = (tables[table] ??= []);
        const match = (r: Row) =>
          filters.every((f) => {
            const v = r[f.col];
            if (f.op === "eq") return cmp(f.col, v, f.val) === 0;
            if (f.op === "in") return (f.val as unknown[]).some((x) => cmp(f.col, v, x) === 0);
            if (v === null || v === undefined) return false;
            const c = cmp(f.col, v, f.val);
            return f.op === "gte" ? c >= 0 : f.op === "lt" ? c < 0 : c <= 0;
          });
        if (kind === "insert" && insertRow) {
          const dup = all.some((r) => r.key === insertRow!.key && cmp("window_start", r.window_start, insertRow!.window_start) === 0);
          if (dup) return { data: null, count: null, error: { code: "23505", message: "duplicate key" } };
          all.push({ ...insertRow });
          return { data: null, count: null, error: null };
        }
        if (kind === "delete") {
          tables[table] = all.filter((r) => !match(r));
          return { data: null, count: null, error: null };
        }
        let rows = all.filter(match);
        const total = rows.length;
        if (order) {
          const o = order;
          rows = [...rows].sort((a, b) => cmp(o.col, a[o.col], b[o.col]) * (o.asc ? 1 : -1));
        }
        if (limit !== null) rows = rows.slice(0, limit);
        return { data: rows.map((r) => ({ ...r })), count: countExact ? total : null, error: null };
      };
      const builder = {
        select(_cols?: string, o?: { count?: string }) {
          if (o?.count === "exact") countExact = true;
          return builder;
        },
        insert(row: Row) {
          kind = "insert";
          insertRow = row;
          return builder;
        },
        delete() {
          kind = "delete";
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push({ op: "eq", col, val });
          return builder;
        },
        in(col: string, val: unknown[]) {
          filters.push({ op: "in", col, val });
          return builder;
        },
        gte(col: string, val: unknown) {
          filters.push({ op: "gte", col, val });
          return builder;
        },
        lt(col: string, val: unknown) {
          filters.push({ op: "lt", col, val });
          return builder;
        },
        lte(col: string, val: unknown) {
          filters.push({ op: "lte", col, val });
          return builder;
        },
        order(col: string, o?: { ascending?: boolean }) {
          order = { col, asc: o?.ascending !== false };
          return builder;
        },
        limit(n: number) {
          limit = n;
          return builder;
        },
        then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
          return Promise.resolve().then(run).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as Db, tables, rpcCalls, ops, rows: (key: string) => tables.rate_limits!.filter((r) => r.key === key) };
}
