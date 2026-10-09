// send-due-task-emails — emails the assignee when a task's due date/time passes.
//
// Triggered every minute by pg_cron (see supabase/optional/email_reminders_cron.sql).
// Each task is emailed at most once per (workspace + task id + due date + due time),
// tracked in sent_task_emails, so changing a due date re-arms the email. Unassigned
// tasks go to the owner. Tasks that went overdue more than a day ago are skipped, so
// switching emails on doesn't send a pile of old reminders.
//
// Sending: through a Gmail account kept just for the CRM (GMAIL_USER + GMAIL_APP_PASSWORD,
// over SMTP on port 465), or through Resend if RESEND_API_KEY is set. With neither,
// the function does nothing. The deploy workflow sets these from GitHub secrets.
//   GMAIL_USER            e.g. brandigade.crm@gmail.com
//   GMAIL_APP_PASSWORD    a Google app password for that account
//   RESEND_API_KEY        alternative sender, from resend.com
//   DUE_TASK_FROM_EMAIL   Resend only, e.g. "Brandigade CRM <crm@brandigade.com>"
//   APP_URL               e.g. https://my-app.onrender.com  (used for the "Open task" link)
//   APP_NAME              shown in the button text, default "Brandigade CRM"
//   BOARD_TIMEZONE        fallback IANA zone for due dates, e.g. "Asia/Dubai" (default UTC).
//                         The app saves the team's zone in settings.timezone, which wins.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@6.9.14";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const GMAIL_USER = Deno.env.get("GMAIL_USER");
const GMAIL_APP_PASSWORD = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
const FROM_EMAIL = Deno.env.get("DUE_TASK_FROM_EMAIL") || "Brandigade CRM <crm@brandigade.com>";
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

const MAX_LATE_MS = 24 * 60 * 60 * 1000;

function validTimeZone(tz: unknown) {
  if (typeof tz !== "string" || !tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
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

let gmail: any = null;
async function sendGmail(to: string, subject: string, html: string) {
  gmail ??= nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  try {
    const info = await gmail.sendMail({ from: { name: APP_NAME, address: GMAIL_USER }, to, subject, html });
    return { id: info.messageId };
  } catch (err) {
    console.error("Gmail send failed", err);
    return { error: (err as Error).message || String(err) };
  }
}

const canSend = !!RESEND_API_KEY || !!(GMAIL_USER && GMAIL_APP_PASSWORD);
const sendEmail = RESEND_API_KEY ? sendResendEmail : sendGmail;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!canSend) return json({ success: true, skipped: "No email sender is set up" });

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
      const timeZone = validTimeZone(stateRow?.data?.settings?.timezone) || BOARD_TIMEZONE;
      const dueTasks = board.filter((t: any) => {
        if (!t.dueDate || t.column === "done") return false;
        const due = naiveLocalToUtc(t.dueDate, t.dueTime, timeZone);
        return due <= now && now.getTime() - due.getTime() < MAX_LATE_MS;
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

        const result: any = await sendEmail(to, subject, html);
        if (result && result.error) { errors.push(ws.id + "/" + t.id + ": " + JSON.stringify(result.error)); continue; }

        await admin.from("sent_task_emails").insert({ key, workspace_id: ws.id, task_id: String(t.id) });
        sent++;
      }
    }

    return json({ success: true, dueCount, sent, skipped, errors, via: RESEND_API_KEY ? "resend" : "gmail" });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
});
