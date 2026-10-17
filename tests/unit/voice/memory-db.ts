// An in-memory stand-in for the Supabase client, with just enough PostgREST
// behaviour for lib/server/voice: filters, unique constraints, upsert with
// ignoreDuplicates, updated_at bumped on every update (so optimistic
// concurrency is exercised), RPCs, Storage and auth.getUser.
import { randomUUID } from "node:crypto";

export type Row = Record<string, any>;
type Rpc = (args: any, ctx: { db: MemoryDb; userId: string | null }) => { data?: unknown; error?: unknown } | unknown;

export interface MemoryDbOptions {
  /** Extra unique columns per table (id is always unique). */
  uniques?: Record<string, string[]>;
  rpc?: Record<string, Rpc>;
  /** access token -> user */
  users?: Record<string, { id: string; email?: string }>;
}

export interface MemoryDb {
  tables: Record<string, Row[]>;
  storage: Map<string, { bytes: Buffer; contentType?: string }>;
  log: { table: string; op: string; args?: unknown; filters: string[] }[];
  client: any;
  asUser(userId: string): any;
  /** Called before each update is applied: lets a test simulate a concurrent writer. */
  beforeUpdate?: (table: string, rows: Row[]) => void;
}

let tick = Date.parse("2026-10-17T10:00:00.000Z");
const nextStamp = () => new Date((tick += 1)).toISOString();

export function memoryDb(init: Record<string, Row[]> = {}, opts: MemoryDbOptions = {}): MemoryDb {
  const tables: Record<string, Row[]> = {};
  for (const [k, rows] of Object.entries(init)) tables[k] = rows.map((r) => ({ ...r }));
  // contacts.phone_digits is a generated column in Postgres.
  for (const c of tables.contacts || []) c.phone_digits = c.phone ? String(c.phone).replace(/[^0-9]/g, "") || null : null;
  const t = (name: string) => (tables[name] = tables[name] || []);
  const uniques = { calls: ["provider_call_sid"], job_queue: ["dedupe_key"], user_preferences: ["user_id"], ...(opts.uniques || {}) };
  const storage = new Map<string, { bytes: Buffer; contentType?: string }>();
  const log: MemoryDb["log"] = [];
  const db: MemoryDb = { tables, storage, log, client: null, asUser: () => null };

  function withDefaults(table: string, row: Row): Row {
    const r = { ...row };
    if (!r.id && table !== "user_preferences" && table !== "workspace_members") r.id = randomUUID();
    if (!r.created_at) r.created_at = nextStamp();
    r.updated_at = nextStamp();
    if (table === "calls") {
      r.status ??= "initiated";
      r.started_at ??= r.created_at;
      for (const k of ["answered_at", "ended_at", "duration_seconds", "provider_child_call_sid", "user_id", "contact_id", "task_id", "deal_id",
        "recording_sid", "recording_status", "recording_duration_seconds", "recording_storage_path", "disposition", "notes"]) r[k] ??= null;
      r.is_voicemail ??= false;
      r.recording_enabled ??= false;
    }
    if (table === "contacts") r.phone_digits = r.phone ? String(r.phone).replace(/[^0-9]/g, "") || null : null;
    return r;
  }
  function conflicts(table: string, row: Row, except?: Row) {
    const cols = ["id", ...((uniques as Record<string, string[]>)[table] || [])];
    return t(table).find((x) => x !== except && cols.some((c) => row[c] != null && x[c] === row[c]));
  }

  function query(table: string, userId: string | null) {
    const q: any = {};
    const filters: ((r: Row) => boolean)[] = [];
    const desc: string[] = [];
    let op = "select";
    let payload: any;
    let options: any = {};
    let returning = false;
    let limitN: number | null = null;
    const orders: [string, boolean][] = [];
    const add = (name: string, fn: (r: Row) => boolean) => { desc.push(name); filters.push(fn); return q; };
    q.select = () => { if (op !== "select") returning = true; return q; };
    q.eq = (c: string, v: unknown) => add(`${c}=${v}`, (r) => r[c] === v || (r[c] != null && v != null && String(r[c]) === String(v)));
    q.neq = (c: string, v: unknown) => add(`${c}!=${v}`, (r) => r[c] !== v);
    q.in = (c: string, vs: unknown[]) => add(`${c} in`, (r) => vs.includes(r[c]));
    q.is = (c: string, v: unknown) => add(`${c} is ${v}`, (r) => (r[c] ?? null) === v);
    q.like = (c: string, p: string) => {
      const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$");
      return add(`${c} like ${p}`, (r) => r[c] != null && re.test(String(r[c])));
    };
    q.order = (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return q; };
    q.limit = (n: number) => { limitN = n; return q; };
    q.insert = (rows: unknown) => { op = "insert"; payload = rows; return q; };
    q.upsert = (rows: unknown, o?: unknown) => { op = "upsert"; payload = rows; options = o || {}; return q; };
    q.update = (patch: unknown) => { op = "update"; payload = patch; return q; };
    q.delete = () => { op = "delete"; return q; };
    const matched = () => t(table).filter((r) => filters.every((f) => f(r)));
    const run = (): { data: any; error: any } => {
      log.push({ table, op, args: payload, filters: desc });
      if (op === "insert" || op === "upsert") {
        const out: Row[] = [];
        for (const input of ([] as Row[]).concat(payload)) {
          const keys = op === "upsert" ? String(options.onConflict || "id").split(",") : [];
          const existing = op === "upsert" ? t(table).find((r) => keys.every((k) => r[k] === input[k])) : undefined;
          if (existing) {
            if (options.ignoreDuplicates) continue;
            Object.assign(existing, input, { updated_at: nextStamp() });
            out.push(existing);
            continue;
          }
          const row = withDefaults(table, input);
          if (conflicts(table, row)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          t(table).push(row);
          out.push(row);
        }
        return { data: returning ? out.map((r) => ({ ...r })) : null, error: null };
      }
      if (op === "update") {
        const rows = matched();
        db.beforeUpdate?.(table, rows);
        const still = rows.filter((r) => filters.every((f) => f(r))); // a concurrent writer may have changed them
        for (const r of still) Object.assign(r, payload, { updated_at: nextStamp() });
        return { data: returning ? still.map((r) => ({ ...r })) : null, error: null };
      }
      if (op === "delete") {
        const rows = matched();
        tables[table] = t(table).filter((r) => !rows.includes(r));
        return { data: returning ? rows : null, error: null };
      }
      let rows = matched().map((r) => ({ ...r }));
      for (const [c, asc] of orders.slice().reverse()) rows.sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)));
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };
    q.maybeSingle = async () => {
      const r = run();
      if (r.error) return r;
      const rows = Array.isArray(r.data) ? r.data : [];
      if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: rows[0] ?? null, error: null };
    };
    q.single = async () => {
      const r = await q.maybeSingle();
      return r.error || r.data ? r : { data: null, error: { code: "PGRST116", message: "no rows" } };
    };
    q.then = (res: any, rej: any) => Promise.resolve().then(run).then(res, rej);
    void userId;
    return q;
  }

  function makeClient(userId: string | null) {
    return {
      from: (table: string) => query(table, userId),
      rpc: async (name: string, args: unknown) => {
        log.push({ table: "rpc:" + name, op: "rpc", args, filters: [] });
        const fn = opts.rpc?.[name] ?? builtinRpc[name];
        if (!fn) return { data: null, error: { message: `no rpc ${name}` } };
        const out = fn(args, { db, userId }) as any;
        return out && typeof out === "object" && ("data" in out || "error" in out) ? { data: out.data ?? null, error: out.error ?? null } : { data: out ?? null, error: null };
      },
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, body: Buffer | Uint8Array, o: { contentType?: string; upsert?: boolean } = {}) => {
            const key = `${bucket}/${path}`;
            if (storage.has(key) && !o.upsert) return { data: null, error: { message: "The resource already exists" } };
            storage.set(key, { bytes: Buffer.from(body), contentType: o.contentType });
            return { data: { path }, error: null };
          },
          createSignedUrl: async (path: string, secs: number) => {
            const key = `${bucket}/${path}`;
            if (!storage.has(key)) return { data: null, error: { message: "Object not found" } };
            return { data: { signedUrl: `http://sb.test/storage/v1/object/sign/${key}?token=signed&expires=${secs}` }, error: null };
          },
          remove: async (paths: string[]) => { paths.forEach((p) => storage.delete(`${bucket}/${p}`)); return { data: paths, error: null }; },
        }),
      },
      auth: {
        getUser: async (token: string) => {
          const u = opts.users?.[token];
          return u ? { data: { user: { id: u.id, email: u.email ?? null } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
        },
      },
    };
  }

  const builtinRpc: Record<string, Rpc> = {
    enqueue_job: (a: any) => {
      if (a.p_dedupe_key && t("job_queue").some((j) => j.dedupe_key === a.p_dedupe_key)) return { data: null };
      const id = t("job_queue").length + 1;
      t("job_queue").push({ id, kind: a.p_kind, payload: a.p_payload, dedupe_key: a.p_dedupe_key, workspace_id: a.p_workspace, status: "pending", attempts: 0 });
      return { data: id };
    },
    // Mirrors public.can_play_recording() (migration 20261017100100_integrations.sql).
    can_play_recording: (a: any, ctx) => {
      const call = t("calls").find((c) => c.id === a.p_call);
      if (!call || !ctx.userId) return { data: false };
      const m = t("workspace_members").find((x) => x.workspace_id === call.workspace_id && x.user_id === ctx.userId);
      if (!m) return { data: false };
      const ws = t("workspaces").find((w) => w.id === call.workspace_id);
      const access = ws?.settings?.recordingAccess || "editors";
      if (access === "all") return { data: true };
      if (access === "owner") return { data: m.role === "owner" || call.user_id === ctx.userId };
      return { data: m.role === "owner" || m.role === "editor" };
    },
  };

  db.client = makeClient(null);
  db.asUser = (userId: string) => makeClient(userId);
  return db;
}
