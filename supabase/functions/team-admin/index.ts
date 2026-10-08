// team-admin: invite people to a workspace and remove them.
//
// Why an edge function: creating logins and sending invite emails needs the
// service-role key, which must never reach the browser. The browser calls this
// with the signed-in user's JWT; we check they own the workspace (or are a
// platform admin) before doing anything privileged.
//
// Body: { action: "invite", workspaceId, email, role: "editor"|"viewer", redirectTo? }
//       { action: "remove", workspaceId, userId }
//
// Secret: APP_URL (where invite links land). SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DEFAULT_REDIRECT = Deno.env.get("APP_URL") || "http://localhost:3000";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Not signed in" }, 401);

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await callerClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Your session has expired. Sign in again." }, 401);
    const callerId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || "");
    if (!workspaceId) return json({ error: "workspaceId is required" }, 400);

    // Caller must own this workspace, or be a platform admin.
    const [{ data: membership }, { data: callerProfile }, { data: workspace }] = await Promise.all([
      admin.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", callerId).maybeSingle(),
      admin.from("profiles").select("is_platform_admin").eq("id", callerId).maybeSingle(),
      admin.from("workspaces").select("id,name,status").eq("id", workspaceId).maybeSingle(),
    ]);
    if (!workspace) return json({ error: "Workspace not found" }, 404);
    const isPlatformAdmin = !!callerProfile?.is_platform_admin;
    if (membership?.role !== "owner" && !isPlatformAdmin) {
      return json({ error: "Only the workspace owner can manage the team" }, 403);
    }
    if (workspace.status !== "active" && !isPlatformAdmin) {
      return json({ error: "This workspace is suspended. Contact support to reactivate it." }, 403);
    }

    if (body.action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      const role = body.role === "editor" ? "editor" : "viewer";
      if (!email || !email.includes("@")) return json({ error: "A valid email is required" }, 400);

      // Already has an account? Add them straight to the workspace.
      const { data: existing } = await admin.from("profiles").select("id").ilike("email", email).maybeSingle();
      let userId = existing?.id as string | undefined;
      let emailed = false;
      if (!userId) {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: body.redirectTo || DEFAULT_REDIRECT,
          data: { invited_workspace: workspaceId, invited_role: role },
        });
        if (error || !data?.user) return json({ error: error?.message || "Invite failed" }, 400);
        userId = data.user.id;
        emailed = true;
      }

      const { error: memberErr } = await admin.from("workspace_members")
        .insert({ workspace_id: workspaceId, user_id: userId, role, invited: emailed });
      if (memberErr) {
        if (memberErr.code === "23505") return json({ error: "That person is already in this workspace" }, 400);
        if (emailed) await admin.auth.admin.deleteUser(userId!); // don't leave an orphan login behind
        return json({ error: memberErr.message }, 400);
      }
      return json({ success: true, userId, emailed });
    }

    if (body.action === "remove") {
      const userId = String(body.userId || "");
      if (!userId) return json({ error: "userId is required" }, 400);
      if (userId === callerId) return json({ error: "You can't remove yourself" }, 400);

      const { data: target } = await admin.from("workspace_members").select("role,invited")
        .eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
      if (!target) return json({ error: "That person isn't in this workspace" }, 404);
      if (target.role === "owner" && !isPlatformAdmin) return json({ error: "The owner can't be removed" }, 400);

      const { error } = await admin.from("workspace_members").delete().eq("workspace_id", workspaceId).eq("user_id", userId);
      if (error) return json({ error: error.message }, 400);

      // An invite that was never accepted and has no other workspace: delete the unused login too.
      if (target.invited) {
        const { count } = await admin.from("workspace_members").select("*", { count: "exact", head: true }).eq("user_id", userId);
        if (!count) await admin.auth.admin.deleteUser(userId);
      }
      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
});
