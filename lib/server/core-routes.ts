import type { Route } from "./router.js";
import { appUrl, features, publicFeatures } from "./env.js";
import { badRequest, json, notFound, readJson, str } from "./http.js";
import { OWNER, requireAuth } from "./auth.js";
import { adminClient } from "./supabase.js";
import { requireCronSecret, runDaily, runTick } from "./cron.js";

// Routes shared by the whole CRM: configuration, team management, health and
// the scheduler entry points. Feature routes live in their own modules.

/** Only links back into this app may be used as the invite landing page. */
function safeRedirect(candidate: unknown): string {
  const base = appUrl();
  if (typeof candidate !== "string" || !candidate) return base + "/";
  try {
    const u = new URL(candidate);
    if (u.origin === new URL(base).origin) return u.toString();
  } catch {
    /* fall through */
  }
  return base + "/";
}

async function teamAdmin(req: Request): Promise<Response> {
  const auth = await requireAuth(req, { roles: OWNER });
  const admin = adminClient();
  const body = await readJson<Record<string, unknown>>(req);
  const workspaceId = str(body.workspaceId, 64) || auth.workspaceId;
  if (workspaceId !== auth.workspaceId) throw badRequest("Unknown workspace");

  const { data: workspace } = await admin.from("workspaces").select("id,status").eq("id", workspaceId).maybeSingle();
  if (!workspace) throw notFound("Workspace not found");

  if (body.action === "invite") {
    const email = str(body.email, 320).trim().toLowerCase();
    const role = body.role === "editor" ? "editor" : "viewer";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("A valid email is required");

    // Already has an account? Add them straight to the CRM.
    const { data: existing } = await admin.from("profiles").select("id").ilike("email", email).maybeSingle();
    let userId = existing?.id as string | undefined;
    let emailed = false;
    if (!userId) {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: safeRedirect(body.redirectTo),
        data: { invited_workspace: workspaceId, invited_role: role },
      });
      if (error || !data?.user) throw badRequest(error?.message || "Invite failed");
      userId = data.user.id;
      emailed = true;
    }

    const { error: memberErr } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: userId, role, invited: emailed });
    if (memberErr) {
      if (memberErr.code === "23505") throw badRequest("That person is already on the team");
      if (emailed) await admin.auth.admin.deleteUser(userId!); // don't leave an orphan login behind
      throw badRequest(memberErr.message);
    }
    return json({ success: true, userId, emailed });
  }

  if (body.action === "remove") {
    const userId = str(body.userId, 64);
    if (!userId) throw badRequest("userId is required");
    if (userId === auth.userId) throw badRequest("You can't remove yourself");

    const { data: target } = await admin
      .from("workspace_members")
      .select("role,invited")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!target) throw notFound("That person isn't on the team");
    if (target.role === "owner") throw badRequest("The owner can't be removed");

    const { error } = await admin.from("workspace_members").delete().eq("workspace_id", workspaceId).eq("user_id", userId);
    if (error) throw badRequest(error.message);

    // An invite that was never accepted and has no other workspace: delete the unused login too.
    if (target.invited) {
      const { count } = await admin.from("workspace_members").select("*", { count: "exact", head: true }).eq("user_id", userId);
      if (!count) await admin.auth.admin.deleteUser(userId);
    }
    return json({ success: true });
  }

  throw badRequest("Unknown action");
}

/** Integration health for the owner's Team page. Never returns secret values. */
async function systemStatus(req: Request): Promise<Response> {
  await requireAuth(req, { roles: OWNER });
  const admin = adminClient();
  const [scheduler, queue, accounts] = await Promise.all([
    admin.rpc("scheduler_status").then((r) => (r.error ? { error: r.error.message } : r.data)),
    admin
      .from("job_queue")
      .select("kind,status,last_error,updated_at")
      .in("status", ["retry", "dead"])
      .order("updated_at", { ascending: false })
      .limit(10)
      .then((r) => r.data || []),
    admin.from("email_accounts").select("status").then((r) => r.data || []),
  ]);
  const mailbox = (accounts as { status: string }[]).reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1;
    return acc;
  }, {});
  return json({
    features: { ...publicFeatures(), cron: features.cron(), tokenEncryption: features.tokenEncryption() },
    appUrl: appUrl(),
    scheduler,
    mailboxes: mailbox,
    recentJobProblems: queue,
  });
}

export const coreRoutes: Route[] = [
  { method: "GET", path: "/api/config", handler: () => json({ features: publicFeatures() }) },
  { method: "GET", path: "/api/health", handler: () => json({ ok: true, time: new Date().toISOString() }) },
  { method: "POST", path: "/api/team-admin", handler: teamAdmin },
  { method: "GET", path: "/api/system/status", handler: systemStatus },
  {
    method: "POST",
    path: "/api/cron/tick",
    handler: async (req) => {
      requireCronSecret(req);
      return json(await runTick());
    },
  },
  {
    method: "GET",
    path: "/api/cron/daily",
    handler: async (req) => {
      requireCronSecret(req);
      return json(await runDaily());
    },
  },
];
