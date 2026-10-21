// Database reads for notifications (service-role client; these run in
// background jobs and in owner-checked routes only).
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "../env.js";
import { prefsFrom, workspaceTimeZone, type Member, type Prefs, type TaskRow } from "./rules.js";
import type { DealInfo, LeadInfo } from "./content.js";

export const TASK_COLUMNS =
  "id,workspace_id,title,status,due_date,due_time,reminder,priority,assigned_to,assigned_by,assignment_version,deal_id,contact_id,notes,workstream,legacy_id";

/** Throws the PostgREST error (so the job is retried) or returns the data. */
export function must<T>(res: { data: T | null; error: unknown }, what: string): T | null {
  if (res.error) {
    const msg = (res.error as { message?: string }).message || String(res.error);
    throw new Error(`${what}: ${msg}`);
  }
  return res.data;
}

export interface WorkspaceContext {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  timeZone: string;
  members: Member[];
  prefsByUser: Map<string, Prefs>;
}

export function memberName(m: Pick<Member, "display_name" | "email"> | null | undefined): string {
  return (m && (m.display_name?.trim() || m.email?.split("@")[0])) || "there";
}

/** The workspace, its members (with profile email/name) and their preferences. */
export async function loadWorkspaceContext(db: SupabaseClient, workspaceId: string, row?: { name?: string; settings?: unknown }): Promise<WorkspaceContext | null> {
  let ws = row as { id?: string; name?: string; settings?: unknown } | undefined;
  if (!ws) {
    ws = must(await db.from("workspaces").select("id,name,settings").eq("id", workspaceId).maybeSingle(), "load workspace") || undefined;
    if (!ws) return null;
  }
  const memberRows = (must(
    await db.from("workspace_members").select("user_id,role,created_at").eq("workspace_id", workspaceId),
    "load members",
  ) || []) as { user_id: string; role: string; created_at: string | null }[];
  const ids = memberRows.map((m) => m.user_id);
  const [profiles, prefs] = ids.length
    ? await Promise.all([
        db.from("profiles").select("id,email,display_name").in("id", ids),
        db.from("user_preferences").select("*").in("user_id", ids),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  const profileRows = (must(profiles as any, "load profiles") || []) as { id: string; email: string | null; display_name: string | null }[];
  const prefRows = (must(prefs as any, "load preferences") || []) as (Partial<Prefs> & { user_id: string })[];
  const byId = new Map(profileRows.map((p) => [p.id, p]));
  const members: Member[] = memberRows.map((m) => ({
    user_id: m.user_id,
    role: m.role,
    created_at: m.created_at,
    email: byId.get(m.user_id)?.email?.trim() || null,
    display_name: byId.get(m.user_id)?.display_name || null,
  }));
  const settings = ws.settings && typeof ws.settings === "object" ? (ws.settings as Record<string, unknown>) : {};
  return {
    id: workspaceId,
    name: ws.name || "",
    settings,
    timeZone: workspaceTimeZone(settings, getEnv("BOARD_TIMEZONE")),
    members,
    prefsByUser: new Map(prefRows.map((p) => [p.user_id, prefsFrom(p)])),
  };
}

export function prefsOf(ctx: WorkspaceContext, userId: string): Prefs {
  return ctx.prefsByUser.get(userId) || prefsFrom(null);
}

export interface TaskDetails {
  task: TaskRow;
  lead: LeadInfo | null;
  deal: DealInfo | null;
}

const personName = (c: { first_name?: string | null; last_name?: string | null; email?: string | null }) =>
  [c.first_name, c.last_name].map((x) => (x || "").trim()).filter(Boolean).join(" ") || c.email || "Unnamed lead";

/** A task with its lead (the task's own, or the deal's main contact) and deal. */
export async function loadTaskDetails(db: SupabaseClient, taskId: string): Promise<TaskDetails | null> {
  const task = must(await db.from("tasks").select(TASK_COLUMNS).eq("id", taskId).maybeSingle(), "load task") as TaskRow | null;
  if (!task) return null;
  let deal: (DealInfo & { contact_id: string | null; company_id: string | null }) | null = null;
  if (task.deal_id) {
    deal = must(await db.from("deals").select("id,title,stage,contact_id,company_id").eq("id", task.deal_id).maybeSingle(), "load deal") as any;
  }
  const contactId = task.contact_id || deal?.contact_id || null;
  let lead: LeadInfo | null = null;
  let companyId: string | null = deal?.company_id || null;
  if (contactId) {
    const c = must(
      await db.from("contacts").select("id,first_name,last_name,email,phone,company_id").eq("id", contactId).maybeSingle(),
      "load lead",
    ) as any;
    if (c) {
      companyId = c.company_id || companyId;
      lead = { id: c.id, name: personName(c), company: null, email: c.email || null, phone: c.phone || null };
    }
  }
  if (lead && companyId) {
    const co = must(await db.from("companies").select("id,name").eq("id", companyId).maybeSingle(), "load company") as any;
    lead.company = co?.name || null;
  }
  return { task, lead, deal: deal ? { id: deal.id, title: deal.title, stage: deal.stage } : null };
}

/** Lead names and deal titles for a list of tasks (the digest). */
export async function loadTaskLabels(db: SupabaseClient, tasks: TaskRow[]): Promise<{ lead: Map<string, string>; deal: Map<string, string> }> {
  const dealIds = [...new Set(tasks.map((t) => t.deal_id).filter(Boolean))] as string[];
  const deals = dealIds.length
    ? ((must(await db.from("deals").select("id,title,contact_id").in("id", dealIds), "load deals") || []) as { id: string; title: string; contact_id: string | null }[])
    : [];
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const contactIds = [...new Set(tasks.map((t) => t.contact_id || (t.deal_id ? dealById.get(t.deal_id)?.contact_id : null)).filter(Boolean))] as string[];
  const contacts = contactIds.length
    ? ((must(await db.from("contacts").select("id,first_name,last_name,email").in("id", contactIds), "load leads") || []) as any[])
    : [];
  const contactById = new Map(contacts.map((c) => [c.id, personName(c)]));
  const lead = new Map<string, string>();
  const deal = new Map<string, string>();
  for (const t of tasks) {
    const d = t.deal_id ? dealById.get(t.deal_id) : undefined;
    const cid = t.contact_id || d?.contact_id || null;
    if (cid && contactById.has(cid)) lead.set(t.id, contactById.get(cid)!);
    if (d) deal.set(t.id, d.title);
  }
  return { lead, deal };
}
