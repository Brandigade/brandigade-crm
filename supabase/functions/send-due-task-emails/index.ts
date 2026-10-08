// send-due-task-emails — emails the assignee when a task's due date/time passes.
//
// Triggered every minute by pg_cron (see supabase/optional/email_reminders_cron.sql).
// Covers every active workspace. Each task is emailed at most once per
// (workspace + task id + due date + due time), tracked in sent_task_emails, so
// changing a due date re-arms the email. Unassigned tasks go to the workspace owner.
//
// Secrets to set (supabase secrets set NAME=value):
//   RESEND_API_KEY        required — from resend.com
//   DUE_TASK_FROM_EMAIL   e.g. "My App <notifications@mail.yourdomain.com>"
//                         (default onboarding@resend.dev only delivers to YOUR Resend login email)
//   APP_URL               e.g. https://my-app.onrender.com  (used for the "Open task" link)
//   APP_NAME              shown in the button text, default "Brandigade CRM"
//   BOARD_TIMEZONE        IANA zone the due dates are typed in, e.g. "Asia/Beirut" (default UTC)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("DUE_TASK_FROM_EMAIL") || "Brandigade CRM <onboarding@resend.dev>";
const APP_URL = (Deno.env.get("APP_URL") || "http://localhost:3000").replace(/\/$/, "");
const APP_NAME = Deno.env.get("APP_NAME") || "Brandigade CRM";
const BOARD_TIMEZONE = Deno.env.get("BOARD_TIMEZONE") || "UTC";

const PRIORITY_COLORS: Record<string, string> = { low: "#16946C", medium: "#C9821A", high: "#D2445B" };
const PRIORITY_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

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

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Due dates are typed as plain local date + time (no zone). Convert to a real
// instant using the board's timezone so "due at 09:00" means 09:00 THERE.
function naiveLocalToUtc(dateStr: string, timeStr: string | undefined, timeZone: string) {
  const naiveUtc = new Date(dateStr + "T" + (timeStr || "00:00") + ":00Z");
  const asIfUtc = new Date(naiveUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const asIfZoned = new Date(naiveUtc.toLocaleString("en-US", { timeZone }));
  const offsetMs = asIfZoned.getTime() - asIfUtc.getTime();
  return new Date(naiveUtc.getTime() - offsetMs);
}

function fmtDate(dueDate: string, dueTime?: string) {
  const parts = dueDate.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr = parts[2] + " " + months[parseInt(parts[1], 10) - 1] + " " + parts[0];
  if (!dueTime) return dateStr;
  const [hStr, mStr] = dueTime.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return dateStr + " - " + h + ":" + mStr + " " + ampm;
}

function priorityBadgeHtml(priority?: string) {
  if (!priority || priority === "none" || !PRIORITY_COLORS[priority]) return "";
  return "<span style='display:inline-block;background:" + PRIORITY_COLORS[priority] +
    ";color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;margin-left:8px;vertical-align:middle;'>" +
    PRIORITY_LABELS[priority] + "</span>";
}

async function sendResendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set, skipping send to " + to);
    return { skipped: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Resend send failed", res.status, body);
    return { error: body };
  }
  return { id: body.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const wsResp = await admin.from("workspaces").select("id,name,workspace_state(data)").eq("status", "active");
    if (wsResp.error || !wsResp.data) return json({ error: "Could not load workspaces" }, 500);

    const now = new Date();
    let sent = 0, skipped = 0, dueCount = 0;
    const errors: string[] = [];

    for (const ws of wsResp.data as any[]) {
      const stateRow = Array.isArray(ws.workspace_state) ? ws.workspace_state[0] : ws.workspace_state;
      const board = Array.isArray(stateRow?.data?.board) ? stateRow.data.board : [];
      const dueTasks = board.filter((t: any) => {
        if (!t.dueDate || t.column === "done") return false;
        return naiveLocalToUtc(t.dueDate, t.dueTime, BOARD_TIMEZONE) <= now;
      });
      if (!dueTasks.length) continue;
      dueCount += dueTasks.length;

      const memResp = await admin.from("workspace_members").select("user_id,role,profiles(email,display_name)").eq("workspace_id", ws.id);
      const members = (memResp.data || []) as any[];
      const owner = members.find((m) => m.role === "owner");
      const memberById = new Map(members.map((m) => [m.user_id, m]));

      for (const t of dueTasks) {
        const key = ws.id + "|" + t.id + "|" + t.dueDate + "|" + (t.dueTime || "");
        const existing = await admin.from("sent_task_emails").select("key").eq("key", key);
        if (existing.data && existing.data.length) { skipped++; continue; }

        const recipient: any = (t.assignedTo ? memberById.get(t.assignedTo) : owner) || owner;
        const to = recipient?.profiles?.email;
        if (!to) { skipped++; continue; }

        const subject = "Task due: " + (t.title || "Untitled task");
        const taskUrl = APP_URL + "/?workspace=" + encodeURIComponent(ws.id) + "&task=" + encodeURIComponent(String(t.id));
        const html =
          "<div style='font-family:Helvetica,Arial,sans-serif;color:#22224A;'>" +
          "<p style='color:#666A8E;margin:0 0 6px;font-size:13px;'>" + esc(ws.name) + "</p>" +
          "<h2 style='margin:0 0 12px;'>A task is due</h2>" +
          "<p style='font-size:16px;font-weight:600;margin:0 0 6px;'>" + esc(t.title || "Untitled task") + priorityBadgeHtml(t.priority) + "</p>" +
          "<p style='color:#666A8E;margin:0 0 16px;'>Due " + fmtDate(t.dueDate, t.dueTime) + (t.workstream ? " - " + esc(t.workstream) : "") + "</p>" +
          "<a href='" + taskUrl + "' style='display:inline-block;background:#4F6CF0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;'>Open task in " + esc(APP_NAME) + "</a>" +
          "</div>";

        const result: any = await sendResendEmail(to, subject, html);
        if (result && result.error) { errors.push(ws.id + "/" + t.id + ": " + JSON.stringify(result.error)); continue; }

        await admin.from("sent_task_emails").insert({ key, workspace_id: ws.id, task_id: String(t.id) });
        sent++;
      }
    }

    return json({ success: true, dueCount, sent, skipped, errors, boardTimezone: BOARD_TIMEZONE, fromEmail: FROM_EMAIL });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
});
