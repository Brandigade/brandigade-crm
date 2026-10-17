// A tiny scriptable stand-in for the service-role Supabase client used by
// lib/server code. Tests register responses per table/rpc and inspect calls.
export interface Call {
  kind: "from" | "rpc" | "auth";
  name: string;
  op?: string;
  args?: unknown;
  filters: [string, string, unknown][];
}

type Responder = (call: Call) => { data?: unknown; error?: unknown; count?: number } | undefined;

export function fakeSupabase(
  responders: Record<string, Responder> = {},
  auth?: {
    getUser?: (t: string) => any;
    users?: Record<string, { email_confirmed_at: string | null }>;
    /** Overrides for the admin auth calls, by name (e.g. "signOut": () => ({ error: ... })). */
    admin?: Record<string, (...args: any[]) => any>;
  },
) {
  const calls: Call[] = [];
  const respond = (call: Call) => {
    calls.push(call);
    const r = responders[`${call.kind}:${call.name}:${call.op ?? ""}`] || responders[`${call.kind}:${call.name}`];
    const out = (r && r(call)) || {};
    return { data: out.data ?? null, error: out.error ?? null, count: out.count ?? null };
  };
  const builder = (name: string) => {
    const call: Call = { kind: "from", name, op: "select", filters: [] };
    const b: any = {};
    for (const m of ["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "ilike", "order", "limit", "range", "not"]) {
      b[m] = (...a: unknown[]) => {
        if (["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "ilike"].includes(m)) call.filters.push([m, String(a[0]), a[1]]);
        return b;
      };
    }
    b.select = (..._a: unknown[]) => b;
    for (const op of ["insert", "update", "upsert", "delete"]) {
      b[op] = (args?: unknown) => { call.op = op; call.args = args; return b; };
    }
    b.single = async () => respond(call);
    b.maybeSingle = async () => respond(call);
    b.then = (res: any, rej: any) => Promise.resolve(respond(call)).then(res, rej);
    return b;
  };
  const client: any = {
    from: builder,
    rpc: async (name: string, args: unknown) => respond({ kind: "rpc", name, args, filters: [] }),
    auth: {
      getUser: async (t: string) => (auth?.getUser ? auth.getUser(t) : { data: { user: null }, error: { message: "bad" } }),
      admin: {
        inviteUserByEmail: async (email: string, opts: unknown) => {
          calls.push({ kind: "auth", name: "invite", args: { email, opts }, filters: [] });
          return { data: { user: { id: "new-user" } }, error: null };
        },
        getUserById: async (id: string) => {
          calls.push({ kind: "auth", name: "getUserById", args: id, filters: [] });
          const u = auth?.users?.[id];
          return { data: { user: u ? { id, ...u } : null }, error: u ? null : { message: "not found" } };
        },
        deleteUser: async (id: string) => {
          calls.push({ kind: "auth", name: "deleteUser", args: id, filters: [] });
          return { data: null, error: null };
        },
        generateLink: async (params: unknown) => {
          calls.push({ kind: "auth", name: "generateLink", args: params, filters: [] });
          return auth?.admin?.generateLink?.(params) ?? { data: { properties: { action_link: "http://sb.test/auth/v1/verify?token=otp" } }, error: null };
        },
        updateUserById: async (id: string, attrs: unknown) => {
          calls.push({ kind: "auth", name: "updateUserById", args: { id, attrs }, filters: [] });
          return auth?.admin?.updateUserById?.(id, attrs) ?? { data: { user: { id } }, error: null };
        },
        signOut: async (jwt: string, scope?: string) => {
          calls.push({ kind: "auth", name: "signOut", args: { jwt, scope }, filters: [] });
          return auth?.admin?.signOut?.(jwt, scope) ?? { data: null, error: null };
        },
      },
    },
  };
  return { client, calls };
}
