import type { SupabaseClient } from "@supabase/supabase-js";
import type { Route } from "./router.js";
import { appUrl, features, publicFeatures, serverUrl } from "./env.js";
import { badRequest, errorSummary, forbidden, json, notFound, readJson, redirect, str } from "./http.js";
import { OWNER, requireAuth, requireUser } from "./auth.js";
import { adminClient, anonClient } from "./supabase.js";
import { randomToken, sha256Hex } from "./crypto.js";
import { requireCronSecret, runDaily, runTick } from "./cron.js";
import { sendEmail, senderConfig, type OutgoingEmail, type SenderConfig } from "./notifications/sender.js";
import { teamInviteEmail } from "./notifications/content.js";

// Routes shared by the whole CRM: configuration, team management, health and
// the scheduler entry points. Feature routes live in their own modules.

// Inviting someone who already has a login. Anyone can sign up with any
// address, so an existing account proves nothing about who owns the mailbox:
// the server keeps a pending invite (workspace_invites) and emails a join link
// to the address. Opening it signs the person in (GET /api/team/join, a fresh
// Supabase sign-in link each time, so mail scanners that open links can't use
// the invite up), and the CRM then calls POST /api/team/join: only then is the
// membership created, the account's password replaced and its other sessions
// signed out, so whoever registered the address beforehand loses access.
const INVITE_DAYS = 7;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const joinLanding = (token: string) => `${appUrl()}/?join=${encodeURIComponent(token)}`;

type InviteMailer = (msg: OutgoingEmail, cfg: SenderConfig) => Promise<unknown>;
const defaultMailer: InviteMailer = (msg, cfg) => sendEmail(msg, {}, cfg);
let inviteMailer: InviteMailer = defaultMailer;
export function __setInviteMailerForTests(fn: InviteMailer | null) {
  inviteMailer = fn || defaultMailer;
}

interface OpenInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: "admin" | "editor" | "viewer";
}

async function openInvite(admin: SupabaseClient, token: string): Promise<OpenInvite | null> {
  if (!INVITE_TOKEN.test(token)) return null;
  const { data, error } = await admin
    .from("workspace_invites")
    .select("id,workspace_id,email,role")
    .eq("token_hash", sha256Hex(token))
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return (data as OpenInvite | null) ?? null;
}

/** Creates (or replaces) the pending invite and emails the join link. */
async function inviteExistingAccount(
  admin: SupabaseClient,
  opts: { workspaceId: string; email: string; role: "admin" | "editor" | "viewer"; invitedBy: string; inviterName: string | null },
): Promise<"crm" | "supabase"> {
  const token = randomToken(32);
  await admin.from("workspace_invites").delete().eq("workspace_id", opts.workspaceId).eq("email", opts.email).is("accepted_at", null);
  const { data: row, error } = await admin
    .from("workspace_invites")
    .insert({
      workspace_id: opts.workspaceId,
      email: opts.email,
      role: opts.role,
      token_hash: sha256Hex(token),
      invited_by: opts.invitedBy,
      expires_at: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !row) throw badRequest((error as { message?: string } | null)?.message || "The invite couldn't be saved");
  try {
    const cfg = senderConfig();
    if (cfg) {
      const content = teamInviteEmail({ inviterName: opts.inviterName, role: opts.role, link: `${serverUrl()}/api/team/join?token=${token}`, expiresDays: INVITE_DAYS });
      await inviteMailer({ to: opts.email, subject: content.subject, html: content.html, text: content.text, idempotencyKey: `invite:${row.id}` }, cfg);
      return "crm";
    }
    // No email sender of the CRM's own: Supabase's sign-in link email, which
    // lands on the same join step (that link expires sooner, per Supabase Auth).
    const { error: otpErr } = await anonClient().auth.signInWithOtp({
      email: opts.email,
      options: { shouldCreateUser: false, emailRedirectTo: joinLanding(token) },
    });
    if (otpErr) throw otpErr;
    return "supabase";
  } catch (err) {
    await admin.from("workspace_invites").delete().eq("id", row.id);
    console.error("Invite email failed:", errorSummary(err));
    throw badRequest(`The invite email couldn't be sent: ${err instanceof Error ? err.message : "unknown error"}`, "invite_not_sent");
  }
}

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
    const role: "admin" | "editor" | "viewer" = body.role === "admin" ? "admin" : body.role === "editor" ? "editor" : "viewer";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("A valid email is required");

    // Already has an account? Supabase stores addresses lowercased, so match
    // exactly (no pattern matching that could pick someone else's account).
    const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (existing?.id) {
      const existingId = existing.id as string;
      const { data: already } = await admin.from("workspace_members").select("user_id").eq("workspace_id", workspaceId).eq("user_id", existingId).maybeSingle();
      if (already) throw badRequest("That person is already on the team");
      const { data: found } = await admin.auth.admin.getUserById(existingId);
      const confirmed = !!found?.user?.email_confirmed_at;
      const { count: memberships } = await admin.from("workspace_members").select("*", { count: "exact", head: true }).eq("user_id", existingId);
      if (!confirmed && !memberships) {
        // A sign-up that was never confirmed: replace it with a proper invite.
        await admin.auth.admin.deleteUser(existingId);
      } else {
        const { data: me } = await admin.from("profiles").select("display_name,email").eq("id", auth.userId).maybeSingle();
        const via = await inviteExistingAccount(admin, {
          workspaceId,
          email,
          role,
          invitedBy: auth.userId,
          inviterName: (me?.display_name as string | null) || (me?.email as string | null) || null,
        });
        return json({ success: true, pending: true, emailed: true, via });
      }
    }
    // A new login: Supabase emails the invite link, which only the mailbox's
    // owner can open, and they choose their password from it.
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: safeRedirect(body.redirectTo),
      data: { invited_workspace: workspaceId, invited_role: role },
    });
    if (error || !data?.user) throw badRequest(error?.message || "Invite failed");
    const userId = data.user.id;

    const { error: memberErr } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: userId, role, invited: true });
    if (memberErr) {
      await admin.auth.admin.deleteUser(userId); // don't leave an orphan login behind
      if (memberErr.code === "23505") throw badRequest("That person is already on the team");
      throw badRequest(memberErr.message);
    }
    return json({ success: true, userId, emailed: true });
  }

  if (body.action === "cancel_invite") {
    const inviteId = str(body.inviteId, 64);
    if (!UUID.test(inviteId)) throw badRequest("inviteId is required");
    const { error } = await admin.from("workspace_invites").delete().eq("id", inviteId).eq("workspace_id", workspaceId).is("accepted_at", null);
    if (error) throw badRequest(error.message);
    return json({ success: true });
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

/** The join link in the invite email: signs the person in, then lands on the join step. */
async function joinLink(_req: Request, ctx: { url: URL }): Promise<Response> {
  const token = ctx.url.searchParams.get("token") || "";
  const back = (reason: string) => redirect(`${appUrl()}/?join_error=${reason}`);
  const admin = adminClient();
  const invite = await openInvite(admin, token);
  if (!invite) return back("expired");
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: invite.email, options: { redirectTo: joinLanding(token) } });
  const link = data?.properties?.action_link;
  if (error || !link) {
    console.error("Couldn't create the sign-in link for an invite:", errorSummary(error));
    return back("failed");
  }
  return redirect(link);
}

/**
 * Accepts an invite: the signed-in person must be the invited address. They
 * choose a new password on the join screen; it replaces the old one (which
 * whoever registered the address may know) and every session of the account
 * is signed out, after which the CRM signs them in with the new password.
 */
async function joinTeam(req: Request): Promise<Response> {
  const { user, token: jwt } = await requireUser(req);
  const body = await readJson<Record<string, unknown>>(req);
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8 || Buffer.byteLength(password) > 72) throw badRequest("Choose a password of at least 8 characters.", "weak_password");
  const admin = adminClient();
  const invite = await openInvite(admin, str(body.token, 200));
  if (!invite) throw badRequest("This invite has expired or was already used. Ask the CRM owner to invite you again.", "invite_expired");
  if ((user.email || "").toLowerCase() !== invite.email) {
    throw forbidden(`This invite is for ${invite.email}. Sign out, then open the link in the invite email again.`);
  }
  const { data: claimed, error: claimErr } = await admin
    .from("workspace_invites")
    .update({ accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq("id", invite.id)
    .is("accepted_at", null)
    .select("id");
  if (claimErr) throw claimErr;
  if (!Array.isArray(claimed) || !claimed.length) throw badRequest("This invite was already used.", "invite_expired");
  try {
    // Whoever else had this account open is signed out, and the password they
    // may know stops working (Supabase also ends this session with it).
    const { error: outErr } = await admin.auth.admin.signOut(jwt, "others");
    if (outErr) throw outErr;
    const { error: pwErr } = await admin.auth.admin.updateUserById(user.id, { password });
    if (pwErr) throw badRequest(pwErr.message || "That password can't be used.", "weak_password");
    const { error: memberErr } = await admin
      .from("workspace_members")
      .insert({ workspace_id: invite.workspace_id, user_id: user.id, role: invite.role, invited: false });
    if (memberErr && memberErr.code !== "23505") throw memberErr;
  } catch (err) {
    await admin.from("workspace_invites").update({ accepted_at: null, accepted_by: null }).eq("id", invite.id);
    throw err;
  }
  return json({ joined: true, workspaceId: invite.workspace_id, role: invite.role, email: invite.email });
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
  { method: "GET", path: "/api/team/join", handler: joinLink },
  { method: "POST", path: "/api/team/join", handler: joinTeam },
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
