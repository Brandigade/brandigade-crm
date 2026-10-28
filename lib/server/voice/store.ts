import type { SupabaseClient } from "@supabase/supabase-js";
import type { CountryCode } from "libphonenumber-js/max";
import type { CallPatch, CallRow } from "./call-state.js";
import { identityForUser } from "./config.js";
import { matchSuffix, pickCaller, type CallerMatch } from "./phone.js";

// Database access for the voice webhooks (service role: Twilio is not a CRM
// user, so every permission is checked in code before anything is written).

export async function loadWorkspace(db: SupabaseClient, id?: string): Promise<{ id: string; settings: Record<string, unknown> }> {
  let q = db.from("workspaces").select("id, settings");
  if (id) q = q.eq("id", id);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("The CRM workspace doesn't exist");
  return { id: data.id as string, settings: (data.settings || {}) as Record<string, unknown> };
}

/** The CRM membership of a user, or null for people who aren't on the team. */
export async function membershipOf(db: SupabaseClient, userId: string): Promise<{ workspaceId: string; role: string } | null> {
  const { data, error } = await db
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { workspaceId: data.workspace_id as string, role: data.role as string } : null;
}

/** Owners, admins and editors who take calls in the browser (no preferences row = yes). */
export async function inboundClients(db: SupabaseClient, workspaceId: string): Promise<{ userId: string; identity: string }[]> {
  const { data: members, error } = await db
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin", "editor"]);
  if (error) throw error;
  const ids = (members || []).map((m) => m.user_id as string);
  if (!ids.length) return [];
  const { data: prefs, error: pErr } = await db.from("user_preferences").select("user_id, calls_receive_inbound").in("user_id", ids);
  if (pErr) throw pErr;
  const off = new Set((prefs || []).filter((p) => p.calls_receive_inbound === false).map((p) => p.user_id as string));
  return ids.filter((id) => !off.has(id)).sort().map((userId) => ({ userId, identity: identityForUser(userId) }));
}

/** Finds the lead behind an incoming number (see pickCaller). */
export async function matchCaller(db: SupabaseClient, workspaceId: string, callerE164: string | null, country?: CountryCode): Promise<CallerMatch> {
  const suffix = matchSuffix(callerE164);
  if (!suffix) return { contactId: null, how: "none" };
  const { data, error } = await db
    .from("contacts")
    .select("id, phone, phone_digits")
    .eq("workspace_id", workspaceId)
    .like("phone_digits", `%${suffix}`)
    .limit(50);
  if (error) throw error;
  return pickCaller(callerE164, (data || []) as { id: string; phone: string | null; phone_digits: string | null }[], country);
}

export async function findCallBySid(db: SupabaseClient, sid: string | null | undefined): Promise<CallRow | null> {
  if (!sid) return null;
  const { data, error } = await db.from("calls").select("*").eq("provider_call_sid", sid).maybeSingle();
  if (error) throw error;
  return (data as CallRow) || null;
}

/** The call a recording belongs to: Twilio reports the parent or the dialled leg. */
export async function findCallForLeg(db: SupabaseClient, sids: (string | null | undefined)[]): Promise<CallRow | null> {
  for (const sid of sids) {
    if (!sid) continue;
    const byParent = await findCallBySid(db, sid);
    if (byParent) return byParent;
    const { data, error } = await db.from("calls").select("*").eq("provider_child_call_sid", sid).limit(1).maybeSingle();
    if (error) throw error;
    if (data) return data as CallRow;
  }
  return null;
}

/**
 * Inserts the call once. Twilio retries webhooks, so a second request for the
 * same CallSid gets the row the first one created (and nothing is changed).
 */
export async function insertCallOnce(db: SupabaseClient, row: Record<string, unknown>): Promise<CallRow> {
  const { error } = await db.from("calls").upsert(row, { onConflict: "provider_call_sid", ignoreDuplicates: true });
  if (error) throw error;
  const saved = await findCallBySid(db, row.provider_call_sid as string);
  if (!saved) throw new Error("The call couldn't be saved");
  return saved;
}

/**
 * Applies `compute(row)` with optimistic concurrency: the update only lands if
 * nobody changed the row since it was read (updated_at), otherwise the row is
 * read again and the change recomputed. Two callbacks arriving at the same
 * moment can't overwrite each other's progress.
 */
export async function updateCall(
  db: SupabaseClient,
  row: CallRow,
  compute: (current: CallRow) => CallPatch | null,
): Promise<CallRow> {
  let current = row;
  for (let attempt = 0; attempt < 5; attempt++) {
    const patch = compute(current);
    if (!patch || !Object.keys(patch).length) return current;
    const { data, error } = await db.from("calls").update(patch).eq("id", current.id).eq("updated_at", current.updated_at).select("*");
    if (error) throw error;
    if (data && data.length) return data[0] as CallRow;
    const { data: fresh, error: rErr } = await db.from("calls").select("*").eq("id", current.id).maybeSingle();
    if (rErr) throw rErr;
    if (!fresh) return current; // deleted meanwhile
    current = fresh as CallRow;
  }
  throw new Error("The call kept changing while it was being updated");
}
