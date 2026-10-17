// The words and layout of every notification email: HTML + plain text.
// Everything that comes from the CRM (titles, notes, names, addresses) is
// escaped; links are built only from APP_URL and record ids.
import { appName, appUrl } from "../env.js";
import {
  DAY,
  MINUTE,
  addDays,
  formatClock,
  formatDate,
  formatInstant,
  formatShortDate,
  humanizeDuration,
  localParts,
  naiveLocalToUtc,
  normalizeDate,
  normalizeTime,
  zoneLabel,
} from "./time.js";
import type { TaskRow } from "./rules.js";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface LeadInfo {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
}

export interface DealInfo {
  id: string;
  title: string;
  stage: string | null;
}

export interface TaskEmailContext {
  task: TaskRow;
  lead: LeadInfo | null;
  deal: DealInfo | null;
  /** Zone the naive due date/time is in (the team's). */
  workspaceTz: string;
  /** Zone times are shown in (the recipient's). */
  recipientTz: string;
  recipientName: string;
  /** The recipient gets it as the owner because the task is unassigned. */
  asOwner: boolean;
  /** Display name of whoever assigned the task, if known. */
  assignedByName: string | null;
  now: Date;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const links = {
  task: (id: string) => `${appUrl()}/?task=${encodeURIComponent(id)}`,
  contact: (id: string) => `${appUrl()}/?contact=${encodeURIComponent(id)}`,
  settings: () => `${appUrl()}/#profile`,
  app: () => `${appUrl()}/`,
};

const PRIORITY: Record<string, { label: string; color: string }> = {
  low: { label: "Low", color: "#16946C" },
  medium: { label: "Medium", color: "#C9821A" },
  high: { label: "High", color: "#D2445B" },
};
const STAGES: Record<string, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal sent",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const taskTitle = (t: TaskRow) => oneLine(t.title) || "Untitled task";
const subjectTitle = (t: TaskRow) => clip(taskTitle(t), 90);

/** Notes as shown in an email: trimmed, at most ~1000 characters. */
export function trimNotes(notes: unknown): string {
  const s = String(notes ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clip(s, 1000);
}

/** When the task is due, in words, in the recipient's time zone. */
export function describeDue(task: TaskRow, workspaceTz: string, recipientTz: string): string | null {
  const date = normalizeDate(task.due_date);
  if (!date) return null;
  const time = normalizeTime(task.due_time);
  if (!time) return formatDate(date);
  const at = naiveLocalToUtc(date, time, workspaceTz);
  const text = `${formatInstant(at, recipientTz)} (${zoneLabel(recipientTz)})`;
  return recipientTz === workspaceTz ? text : `${text} · ${formatClock(time)} ${zoneLabel(workspaceTz)}`;
}

/** "Due in 15 min" / "Due now" / "Due today" / "Overdue by 2 hours" at `now`. */
export function dueRelation(task: TaskRow, workspaceTz: string, recipientTz: string, now: Date): { short: string; sentence: string } {
  const date = normalizeDate(task.due_date);
  if (!date) return { short: "Reminder", sentence: "This task has no due date." };
  const time = normalizeTime(task.due_time);
  if (!time) {
    const today = localParts(now, recipientTz).date;
    if (date === today) return { short: "Due today", sentence: "This task is due today." };
    if (date === addDays(today, 1)) return { short: "Due tomorrow", sentence: "This task is due tomorrow." };
    if (date < today) return { short: "Overdue", sentence: `This task was due ${formatShortDate(date)} and is still open.` };
    return { short: `Due ${formatShortDate(date)}`, sentence: `This task is due ${formatShortDate(date)}.` };
  }
  const delta = naiveLocalToUtc(date, time, workspaceTz).getTime() - now.getTime();
  if (Math.abs(delta) < 2 * MINUTE) return { short: "Due now", sentence: "This task is due now." };
  if (delta > 0) {
    const phrase = Math.abs(delta - DAY) < 2 * MINUTE ? "1 day" : humanizeDuration(delta);
    return { short: `Due in ${phrase}`, sentence: `This task is due in ${phrase}.` };
  }
  return { short: "Overdue", sentence: `This task was due ${humanizeDuration(delta)} ago and is still open.` };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const INK = "#22224A";
const MUTED = "#666A8E";
const ACCENT = "#4F6CF0";
const LINE = "#DFE3F3";

function button(href: string, label: string, primary = true): string {
  const style = primary
    ? `display:inline-block;background:${ACCENT};color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;margin:0 8px 8px 0;`
    : `display:inline-block;background:#ffffff;color:${ACCENT};border:1px solid ${LINE};padding:9px 17px;border-radius:8px;text-decoration:none;font-weight:600;margin:0 8px 8px 0;`;
  return `<a href="${escapeHtml(href)}" style="${style}">${escapeHtml(label)}</a>`;
}

function layout(opts: { eyebrow: string; heading: string; bodyHtml: string; footerReason: string }): string {
  const name = escapeHtml(appName());
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.heading)}</title></head>` +
    `<body style="margin:0;padding:0;background:#F5F7FD;">` +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:Helvetica,Arial,sans-serif;color:${INK};font-size:14px;line-height:1.5;">` +
    `<div style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:22px 24px;">` +
    `<p style="color:${MUTED};margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;">${name} · ${escapeHtml(opts.eyebrow)}</p>` +
    `<h2 style="margin:0 0 14px;font-size:19px;">${escapeHtml(opts.heading)}</h2>` +
    opts.bodyHtml +
    `</div>` +
    `<p style="color:${MUTED};font-size:12px;margin:14px 4px 0;">${escapeHtml(opts.footerReason)} ` +
    `<a href="${escapeHtml(links.settings())}" style="color:${ACCENT};">Change your notification settings</a>.</p>` +
    `</div></body></html>`
  );
}

function textLayout(opts: { heading: string; lines: string[]; footerReason: string }): string {
  return [opts.heading, "", ...opts.lines, "", "--", `${opts.footerReason} Change your notification settings: ${links.settings()}`].join("\n");
}

function priorityBadge(priority: string | null | undefined): string {
  const p = priority ? PRIORITY[priority] : undefined;
  if (!p) return "";
  return ` <span style="display:inline-block;background:${p.color};color:#ffffff;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;vertical-align:middle;">${escapeHtml(p.label)}</span>`;
}

function detailRow(label: string, valueHtml: string): string {
  return (
    `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};vertical-align:top;white-space:nowrap;font-size:13px;">${escapeHtml(label)}</td>` +
    `<td style="padding:6px 0;vertical-align:top;font-size:13.5px;">${valueHtml}</td></tr>`
  );
}

function leadHtml(lead: LeadInfo): string {
  const parts = [`<a href="${escapeHtml(links.contact(lead.id))}" style="color:${ACCENT};font-weight:600;">${escapeHtml(lead.name)}</a>`];
  if (lead.company) parts.push(escapeHtml(lead.company));
  if (lead.email) parts.push(`<a href="mailto:${escapeHtml(encodeURIComponent(lead.email).replace(/%40/g, "@"))}" style="color:${ACCENT};">${escapeHtml(lead.email)}</a>`);
  if (lead.phone) parts.push(`<a href="tel:${escapeHtml(lead.phone.replace(/[^0-9+]/g, ""))}" style="color:${ACCENT};">${escapeHtml(lead.phone)}</a>`);
  return parts.join(" · ");
}

function leadText(lead: LeadInfo): string {
  return [lead.name, lead.company, lead.email, lead.phone].filter(Boolean).join(" · ");
}

function assignmentLine(ctx: TaskEmailContext): string {
  if (ctx.asOwner) return ctx.task.assigned_to ? "Its assignee is no longer on the team, so it comes to you as the CRM owner" : "Unassigned, so it comes to you as the CRM owner";
  return ctx.assignedByName ? `Assigned to you by ${ctx.assignedByName}` : "Assigned to you";
}

/** The task card shared by the assigned / reminder / overdue emails. */
function taskCard(ctx: TaskEmailContext, opts: { intro: string }): { html: string; text: string[] } {
  const t = ctx.task;
  const due = describeDue(t, ctx.workspaceTz, ctx.recipientTz);
  const notes = trimNotes(t.notes);
  const prio = t.priority && PRIORITY[t.priority] ? PRIORITY[t.priority].label : null;
  const rows: string[] = [];
  const text: string[] = [opts.intro, "", `Task: ${taskTitle(t)}`];
  if (due) {
    rows.push(detailRow("Due", escapeHtml(due)));
    text.push(`Due: ${due}`);
  }
  if (prio) {
    rows.push(detailRow("Priority", escapeHtml(prio)));
    text.push(`Priority: ${prio}`);
  }
  if (ctx.lead) {
    rows.push(detailRow("Lead", leadHtml(ctx.lead)));
    text.push(`Lead: ${leadText(ctx.lead)}`);
  }
  if (ctx.deal) {
    const stage = ctx.deal.stage ? STAGES[ctx.deal.stage] || ctx.deal.stage : null;
    rows.push(detailRow("Deal", escapeHtml(ctx.deal.title) + (stage ? ` <span style="color:${MUTED};">(${escapeHtml(stage)})</span>` : "")));
    text.push(`Deal: ${ctx.deal.title}${stage ? ` (${stage})` : ""}`);
  }
  if (t.workstream && t.workstream !== "General") {
    rows.push(detailRow("Type", escapeHtml(t.workstream)));
    text.push(`Type: ${t.workstream}`);
  }
  const assignment = assignmentLine(ctx);
  rows.push(detailRow("Assignment", escapeHtml(assignment)));
  text.push(`Assignment: ${assignment}`);

  let html =
    `<p style="margin:0 0 12px;">${escapeHtml(opts.intro)}</p>` +
    `<p style="font-size:16px;font-weight:600;margin:0 0 8px;">${escapeHtml(taskTitle(t))}${priorityBadge(t.priority)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px;">${rows.join("")}</table>`;
  if (notes) {
    html += `<div style="background:#F5F7FD;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:13.5px;white-space:normal;">${escapeHtml(notes).replace(/\n/g, "<br>")}</div>`;
    text.push("", "Notes:", notes);
  }
  html += `<div style="margin-top:6px;">${button(links.task(t.id), "Open task")}${ctx.lead ? button(links.contact(ctx.lead.id), "Open lead", false) : ""}</div>`;
  text.push("", `Open task: ${links.task(t.id)}`);
  if (ctx.lead) text.push(`Open lead: ${links.contact(ctx.lead.id)}`);
  return { html, text };
}

// ---------------------------------------------------------------------------
// The emails
// ---------------------------------------------------------------------------
export function taskAssignedEmail(ctx: TaskEmailContext): EmailContent {
  const by = ctx.assignedByName;
  const heading = by ? `${by} assigned you a task` : "You have a new task";
  const card = taskCard(ctx, { intro: by ? `${by} assigned this task to you in ${appName()}.` : `This task was assigned to you in ${appName()}.` });
  const footerReason = "You get this email when someone assigns you a task.";
  return {
    subject: `Assigned to you: ${subjectTitle(ctx.task)}`,
    html: layout({ eyebrow: "Task assigned", heading, bodyHtml: card.html, footerReason }),
    text: textLayout({ heading, lines: card.text, footerReason }),
  };
}

export function taskReminderEmail(ctx: TaskEmailContext): EmailContent {
  const rel = dueRelation(ctx.task, ctx.workspaceTz, ctx.recipientTz, ctx.now);
  const card = taskCard(ctx, { intro: rel.sentence });
  const footerReason = ctx.asOwner
    ? "You get task reminder emails, including reminders for unassigned tasks as the CRM owner."
    : "You get an email when a task's reminder goes off.";
  return {
    subject: `${rel.short}: ${subjectTitle(ctx.task)}`,
    html: layout({ eyebrow: "Task reminder", heading: rel.short, bodyHtml: card.html, footerReason }),
    text: textLayout({ heading: rel.short, lines: card.text, footerReason }),
  };
}

export function taskOverdueEmail(ctx: TaskEmailContext): EmailContent {
  const date = normalizeDate(ctx.task.due_date);
  const time = normalizeTime(ctx.task.due_time);
  let when = "earlier";
  if (date && time) {
    const local = localParts(naiveLocalToUtc(date, time, ctx.workspaceTz), ctx.recipientTz);
    when = `${formatShortDate(local.date)}, ${formatClock(local.time)}`;
  } else if (date) {
    when = formatShortDate(date);
  }
  const intro = `This task was due ${when} and is still open.`;
  const card = taskCard(ctx, { intro });
  const footerReason = "You get one email when a task you're responsible for becomes overdue.";
  return {
    subject: `Overdue: ${subjectTitle(ctx.task)}`,
    html: layout({ eyebrow: "Overdue task", heading: "This task is overdue", bodyHtml: card.html, footerReason }),
    text: textLayout({ heading: "This task is overdue", lines: card.text, footerReason }),
  };
}

export interface DigestItem {
  task: TaskRow;
  /** Pre-formatted due text in the recipient's zone, e.g. "Mon 19 Oct, 10:00 AM" or "Mon 19 Oct". */
  due: string;
  leadName: string | null;
  dealTitle: string | null;
}

export interface DigestSections {
  overdue: DigestItem[];
  today: DigestItem[];
  upcoming: DigestItem[];
  /** How many more were left out of each list. */
  more: { overdue: number; today: number; upcoming: number };
}

export function dailyDigestEmail(opts: { recipientName: string; localDate: string; timeZone: string; sections: DigestSections }): EmailContent {
  const s = opts.sections;
  const counts = {
    overdue: s.overdue.length + s.more.overdue,
    today: s.today.length + s.more.today,
    upcoming: s.upcoming.length + s.more.upcoming,
  };
  const summary = [
    counts.overdue ? `${counts.overdue} overdue` : "",
    counts.today ? `${counts.today} due today` : "",
    counts.upcoming ? `${counts.upcoming} in the next 7 days` : "",
  ].filter(Boolean);
  const day = formatShortDate(opts.localDate);
  const heading = `Your tasks for ${day}`;

  const section = (title: string, items: DigestItem[], more: number, color: string) => {
    if (!items.length) return { html: "", text: [] as string[] };
    const li = items
      .map((it) => {
        const extra = [it.leadName, it.dealTitle].filter(Boolean).map((x) => escapeHtml(x)).join(" · ");
        return (
          `<li style="margin:0 0 8px;"><a href="${escapeHtml(links.task(it.task.id))}" style="color:${INK};font-weight:600;text-decoration:none;">${escapeHtml(taskTitle(it.task))}</a>` +
          `${priorityBadge(it.task.priority)}<br><span style="color:${MUTED};font-size:12.5px;">${escapeHtml(it.due)}${extra ? " · " + extra : ""}</span></li>`
        );
      })
      .join("");
    const moreHtml = more ? `<p style="color:${MUTED};font-size:12.5px;margin:0 0 10px;">and ${more} more in the CRM.</p>` : "";
    return {
      html: `<h3 style="font-size:14px;margin:16px 0 8px;color:${color};">${escapeHtml(title)} (${items.length + more})</h3><ul style="padding-left:18px;margin:0 0 6px;">${li}</ul>${moreHtml}`,
      text: [
        `${title} (${items.length + more})`,
        ...items.map((it) => `- ${taskTitle(it.task)} (${[it.due, it.leadName, it.dealTitle].filter(Boolean).join(" · ")}) ${links.task(it.task.id)}`),
        ...(more ? [`  and ${more} more in the CRM.`] : []),
        "",
      ],
    };
  };
  const parts = [
    section("Overdue", s.overdue, s.more.overdue, "#D2445B"),
    section("Due today", s.today, s.more.today, INK),
    section("Next 7 days", s.upcoming, s.more.upcoming, INK),
  ];
  const intro = `Good morning ${opts.recipientName}. Here's what's on your plate (times in ${zoneLabel(opts.timeZone)}).`;
  const footerReason = "You get this daily digest because you switched it on.";
  const bodyHtml =
    `<p style="margin:0 0 4px;">${escapeHtml(intro)}</p>` + parts.map((p) => p.html).join("") + `<div style="margin-top:14px;">${button(links.app(), "Open the CRM")}</div>`;
  return {
    subject: `Your tasks for ${day}: ${summary.join(", ")}`,
    html: layout({ eyebrow: "Daily digest", heading, bodyHtml, footerReason }),
    text: textLayout({ heading, lines: [intro, "", ...parts.flatMap((p) => p.text), `Open the CRM: ${links.app()}`], footerReason }),
  };
}

export function testEmail(opts: { recipientName: string; senderLabel: string; now: Date; timeZone: string }): EmailContent {
  const heading = "Email notifications work";
  const when = `${formatInstant(opts.now, opts.timeZone)} (${zoneLabel(opts.timeZone)})`;
  const lines = [
    `Hi ${opts.recipientName}, this is the test email you asked for from your profile in ${appName()}.`,
    `Sent ${when} through ${opts.senderLabel}.`,
    "Task assigned, reminder, overdue and digest emails will reach you the same way.",
  ];
  const footerReason = "You asked for this test email.";
  return {
    subject: `Test email from ${appName()}`,
    html: layout({
      eyebrow: "Test",
      heading,
      bodyHtml: lines.map((l) => `<p style="margin:0 0 10px;">${escapeHtml(l)}</p>`).join("") + button(links.settings(), "Notification settings"),
      footerReason,
    }),
    text: textLayout({ heading, lines: [...lines, "", `Notification settings: ${links.settings()}`], footerReason }),
  };
}
