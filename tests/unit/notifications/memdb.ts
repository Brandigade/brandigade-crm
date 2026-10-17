// An in-memory stand-in for the service-role Supabase client, rich enough for
// lib/server/notifications: tables of rows, the filters the module uses, and
// the enqueue_job RPC with its dedupe-key semantics. (tests/unit/core/
// fake-supabase.ts only records calls; these tests need real query results.)
type Row = Record<string, any>;

export interface MemDb {
  client: any;
  tables: Record<string, Row[]>;
  /** Every RPC call: { name, args }. */
  rpcCalls: { name: string; args: any }[];
  /** Make the next queries on a table fail. */
  failTable: Set<string>;
  jobs(): Row[];
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function memDb(initial: Record<string, Row[]> = {}, auth?: { users?: Record<string, { id: string; email: string }> }): MemDb {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(initial)) tables[k] = clone(v);
  const table = (name: string) => (tables[name] = tables[name] || []);
  const rpcCalls: { name: string; args: any }[] = [];
  const failTable = new Set<string>();
  let jobSeq = 1000;

  function query(name: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let rows: Row[] = [];
    let patch: Row = {};
    const order: [string, boolean][] = [];
    let limit: number | null = null;
    let head = false;
    let wantCount = false;
    let onConflict = "id";
    const q: any = {};
    const add = (f: (r: Row) => boolean) => {
      filters.push(f);
      return q;
    };
    q.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) head = true;
      if (opts?.count) wantCount = true;
      return q;
    };
    q.eq = (c: string, v: any) => add((r) => r[c] === v);
    q.neq = (c: string, v: any) => add((r) => r[c] !== v);
    q.in = (c: string, vals: any[]) => add((r) => vals.includes(r[c]));
    q.is = (c: string, v: any) => add((r) => (r[c] ?? null) === v);
    q.not = (c: string, operator: string, v: any) => add((r) => (operator === "is" ? (r[c] ?? null) !== v : r[c] !== v));
    q.gt = (c: string, v: any) => add((r) => r[c] != null && r[c] > v);
    q.gte = (c: string, v: any) => add((r) => r[c] != null && r[c] >= v);
    q.lt = (c: string, v: any) => add((r) => r[c] != null && r[c] < v);
    q.lte = (c: string, v: any) => add((r) => r[c] != null && r[c] <= v);
    q.like = (c: string, pattern: string) => {
      const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$");
      return add((r) => re.test(String(r[c] ?? "")));
    };
    q.order = (c: string, o?: { ascending?: boolean }) => {
      order.push([c, o?.ascending !== false]);
      return q;
    };
    q.limit = (n: number) => {
      limit = n;
      return q;
    };
    q.insert = (r: Row | Row[]) => {
      op = "insert";
      rows = ([] as Row[]).concat(r);
      return q;
    };
    q.upsert = (r: Row | Row[], o?: { onConflict?: string }) => {
      op = "upsert";
      rows = ([] as Row[]).concat(r);
      if (o?.onConflict) onConflict = o.onConflict;
      return q;
    };
    q.update = (p: Row) => {
      op = "update";
      patch = p;
      return q;
    };
    q.delete = () => {
      op = "delete";
      return q;
    };
    const run = () => {
      if (failTable.has(name)) return { data: null, error: { message: `${name} is unavailable` }, count: null };
      const t = table(name);
      const matched = () => t.filter((r) => filters.every((f) => f(r)));
      if (op === "insert" || op === "upsert") {
        for (const input of rows) {
          const existing = op === "upsert" ? t.find((r) => onConflict.split(",").every((k) => r[k] === input[k])) : null;
          if (existing) Object.assign(existing, clone(input));
          else t.push(clone(input));
        }
        return { data: null, error: null, count: null };
      }
      if (op === "update") {
        const m = matched();
        m.forEach((r) => Object.assign(r, clone(patch), { updated_at: new Date().toISOString() }));
        return { data: null, error: null, count: m.length };
      }
      if (op === "delete") {
        const m = matched();
        tables[name] = t.filter((r) => !m.includes(r));
        return { data: null, error: null, count: m.length };
      }
      let out = matched();
      if (order.length) {
        out = out.slice().sort((a, b) => {
          for (const [c, asc] of order) {
            if (a[c] === b[c]) continue;
            if (a[c] == null) return 1;
            if (b[c] == null) return -1;
            return (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      const count = out.length;
      if (limit != null) out = out.slice(0, limit);
      return { data: head ? null : clone(out), error: null, count: wantCount ? count : null };
    };
    q.maybeSingle = async () => {
      const r = run();
      return { ...r, data: r.error ? null : Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
    };
    q.single = async () => {
      const r = run();
      if (Array.isArray(r.data) && !r.data.length) return { data: null, error: { message: "No rows", code: "PGRST116" } };
      return { ...r, data: Array.isArray(r.data) ? r.data[0] : r.data };
    };
    q.then = (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
    return q;
  }

  async function rpc(name: string, args: any) {
    rpcCalls.push({ name, args: clone(args) });
    if (name === "enqueue_job") {
      const jobs = table("job_queue");
      if (args.p_dedupe_key && jobs.some((j) => j.dedupe_key === args.p_dedupe_key)) return { data: null, error: null };
      const now = new Date().toISOString();
      const id = ++jobSeq;
      jobs.push({
        id,
        kind: args.p_kind,
        payload: clone(args.p_payload),
        dedupe_key: args.p_dedupe_key,
        run_after: args.p_run_after,
        workspace_id: args.p_workspace,
        max_attempts: args.p_max_attempts,
        status: "pending",
        attempts: 0,
        result: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      });
      return { data: id, error: null };
    }
    if (name === "claim_jobs") {
      // Same rules as public.claim_jobs(): ready, not exhausted, lease expired if running.
      const now = Date.now();
      const ready = table("job_queue")
        .filter(
          (j) =>
            args.p_kinds.includes(j.kind) &&
            j.attempts < j.max_attempts &&
            Date.parse(j.run_after) <= now &&
            (["pending", "retry"].includes(j.status) || (j.status === "running" && Date.parse(j.locked_until) < now)),
        )
        .sort((a, b) => Date.parse(a.run_after) - Date.parse(b.run_after))
        .slice(0, args.p_limit);
      ready.forEach((j) => {
        j.status = "running";
        j.attempts += 1;
        j.locked_until = new Date(now + args.p_lease_seconds * 1000).toISOString();
      });
      return { data: clone(ready), error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  }

  const client = {
    from: query,
    rpc,
    auth: {
      getUser: async (token: string) => {
        const u = auth?.users?.[token];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
  };
  return { client, tables, rpcCalls, failTable, jobs: () => table("job_queue") };
}
