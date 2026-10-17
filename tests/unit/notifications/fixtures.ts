// A small CRM for the notification tests: one workspace in Karachi time
// (UTC+5, no DST), an owner, an editor and a viewer, a lead at a company, a
// deal and a task.
import { memDb } from "./memdb.js";
import type { OutgoingEmail, SendResult, SenderConfig } from "../../../lib/server/notifications/sender.js";

export const WS = "ws1";

export const SMTP_SENDER: SenderConfig = {
  kind: "smtp",
  from: { name: "Brandigade CRM", address: "crm@crm.test" },
  label: "SMTP server 127.0.0.1:57325",
  smtp: { host: "127.0.0.1", port: 57325, secure: false },
};

export function baseTask(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    workspace_id: WS,
    title: "Send <samples> & pricing",
    status: "todo",
    due_date: "2026-10-17",
    due_time: "10:00:00",
    reminder: "15_min",
    priority: "high",
    assigned_to: "ed",
    assigned_by: "owner",
    assignment_version: 1,
    deal_id: "d1",
    contact_id: null,
    notes: "  Bring the matte finish.\n\n\n\nAsk about <Q4> budget  ",
    workstream: "Follow-up",
    legacy_id: null,
    ...over,
  };
}

export function crm(over: Record<string, Record<string, unknown>[]> = {}) {
  return memDb({
    workspaces: [{ id: WS, name: "Brandigade", status: "active", settings: { timezone: "Asia/Karachi", currency: "USD" } }],
    workspace_members: [
      { workspace_id: WS, user_id: "owner", role: "owner", created_at: "2026-01-01T00:00:00Z" },
      { workspace_id: WS, user_id: "ed", role: "editor", created_at: "2026-01-02T00:00:00Z" },
      { workspace_id: WS, user_id: "vi", role: "viewer", created_at: "2026-01-03T00:00:00Z" },
    ],
    profiles: [
      { id: "owner", email: "owner@crm.test", display_name: "Olivia Owner", is_platform_admin: false },
      { id: "ed", email: "editor@crm.test", display_name: "Eddie <Editor>", is_platform_admin: false },
      { id: "vi", email: "viewer@crm.test", display_name: null, is_platform_admin: false },
    ],
    user_preferences: [],
    companies: [{ id: "co1", workspace_id: WS, name: "Cedar & Crumb" }],
    contacts: [{ id: "c1", workspace_id: WS, first_name: "Maya", last_name: "Rivera", email: "maya@cedar.example", phone: "+1 415 555 0143", company_id: "co1" }],
    deals: [{ id: "d1", workspace_id: WS, title: "Wholesale packaging", stage: "negotiation", contact_id: "c1", company_id: "co1" }],
    tasks: [baseTask()],
    job_queue: [],
    sent_task_emails: [],
    ...over,
  });
}

/** A fake sender that records what it was asked to send. */
export function fakeSend(opts: { fail?: Error } = {}) {
  const sent: OutgoingEmail[] = [];
  const send = async (msg: OutgoingEmail, _cfg: SenderConfig): Promise<SendResult> => {
    if (opts.fail) throw opts.fail;
    sent.push(msg);
    return { provider: "smtp", messageId: `<m${sent.length}@crm.test>` };
  };
  return { sent, send };
}

/** A job row as claim_jobs() returns it. */
export function jobRow(kind: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: 1,
    kind,
    payload,
    dedupe_key: `${kind}:test`,
    workspace_id: WS,
    status: "running",
    attempts: 1,
    max_attempts: 6,
    run_after: "2026-10-17T00:00:00Z",
    result: null,
    ...over,
  } as any;
}
