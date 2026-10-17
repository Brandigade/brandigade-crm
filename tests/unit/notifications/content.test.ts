import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dailyDigestEmail,
  describeDue,
  dueRelation,
  escapeHtml,
  links,
  taskAssignedEmail,
  taskReminderEmail,
  testEmail,
  trimNotes,
  type TaskEmailContext,
} from "../../../lib/server/notifications/content.js";
import type { TaskRow } from "../../../lib/server/notifications/rules.js";

const env = { ...process.env };
beforeEach(() => {
  process.env.APP_URL = "https://crm.example/";
  process.env.APP_NAME = "Brandigade CRM";
});
afterEach(() => {
  process.env = { ...env };
});

const EVIL = `<img src=x onerror="alert(1)">`;
const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  workspace_id: "ws1",
  title: `Fix ${EVIL} & "quotes"`,
  status: "todo",
  due_date: "2026-10-17",
  due_time: "10:00",
  reminder: "at_due",
  priority: "medium",
  assigned_to: "ed",
  notes: `${EVIL}\nline two`,
  workstream: "Call",
  ...over,
});
const ctx = (over: Partial<TaskEmailContext> = {}): TaskEmailContext => ({
  task: task(),
  lead: { id: "c1", name: `Maya ${EVIL}`, company: `Cedar <b>&</b> Crumb`, email: `maya"onmouseover="x@cedar.example`, phone: "+1 (415) 555-0143" },
  deal: { id: "d1", title: `Deal ${EVIL}`, stage: "proposal" },
  workspaceTz: "Asia/Karachi",
  recipientTz: "Asia/Karachi",
  recipientName: `Eddie ${EVIL}`,
  asOwner: false,
  assignedByName: `Olivia ${EVIL}`,
  now: new Date("2026-10-17T05:00:20Z"),
  ...over,
});

describe("escaping", () => {
  it("escapes every CRM value in the HTML", () => {
    for (const email of [taskAssignedEmail(ctx()), taskReminderEmail(ctx())]) {
      expect(email.html).not.toContain("<img");
      expect(email.html).not.toContain('onerror="');
      expect(email.html).not.toContain("<b>&</b>");
      expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
      expect(email.html).toContain("Cedar &lt;b&gt;&amp;&lt;/b&gt; Crumb");
      // No attribute can be broken out of.
      expect(email.html).not.toMatch(/onmouseover="/);
    }
  });
  it("subjects are plain text on one line", () => {
    const e = taskAssignedEmail(ctx({ task: task({ title: "Line one\r\nBcc: x@y.z" }) }));
    expect(e.subject).toBe("Assigned to you: Line one Bcc: x@y.z");
    const long = taskAssignedEmail(ctx({ task: task({ title: "x".repeat(300) }) }));
    expect(long.subject.length).toBeLessThan(110);
  });
  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("links", () => {
  it("are built from APP_URL and record ids only", () => {
    expect(links.task("t1")).toBe("https://crm.example/?task=t1");
    expect(links.contact("a&b")).toBe("https://crm.example/?contact=a%26b");
    expect(links.settings()).toBe("https://crm.example/#profile");
    const e = taskReminderEmail(ctx());
    expect(e.html).toContain('href="https://crm.example/?task=t1"');
    expect(e.html).toContain('href="https://crm.example/?contact=c1"');
    expect(e.html).toContain('href="https://crm.example/#profile"');
    expect(e.html).toContain('href="tel:+14155550143"');
    expect(e.text).toContain("Open task: https://crm.example/?task=t1");
    expect(e.text).toContain("Open lead: https://crm.example/?contact=c1");
    expect(e.text).toContain("https://crm.example/#profile");
  });
  it("no lead -> no lead button", () => {
    const e = taskAssignedEmail(ctx({ lead: null }));
    expect(e.html).not.toContain("?contact=");
    expect(e.text).not.toContain("Open lead");
  });
});

describe("content", () => {
  it("has the task, notes, lead, deal, due, priority and assignment", () => {
    const e = taskAssignedEmail(ctx());
    expect(e.text).toContain(`Task: Fix ${EVIL} & "quotes"`);
    expect(e.text).toContain("Due: Sat 17 Oct 2026, 10:00 AM (Karachi time)");
    expect(e.text).toContain("Priority: Medium");
    expect(e.text).toContain(`Lead: Maya ${EVIL} · Cedar <b>&</b> Crumb`);
    expect(e.text).toContain(`Deal: Deal ${EVIL} (Proposal sent)`);
    expect(e.text).toContain("Type: Call");
    expect(e.text).toContain(`Assignment: Assigned to you by Olivia ${EVIL}`);
    expect(e.text).toContain(`Notes:\n${EVIL}\nline two`);
    expect(e.html).toContain("line two"); // notes keep their line breaks
    expect(e.html).toMatch(/&gt;<br>line two/);
  });
  it("trims notes", () => {
    expect(trimNotes("  \n\nhello\n\n\n\nworld  \n")).toBe("hello\n\nworld");
    expect(trimNotes("x".repeat(5000)).length).toBe(1000);
    expect(trimNotes(null)).toBe("");
  });
  it("shows the due time in the recipient's zone", () => {
    expect(describeDue(task(), "Asia/Karachi", "Asia/Karachi")).toBe("Sat 17 Oct 2026, 10:00 AM (Karachi time)");
    expect(describeDue(task(), "Asia/Karachi", "America/New_York")).toBe("Sat 17 Oct 2026, 1:00 AM (New York time) · 10:00 AM Karachi time");
    expect(describeDue(task({ due_time: null }), "Asia/Karachi", "America/New_York")).toBe("Sat 17 Oct 2026");
    expect(describeDue(task({ due_date: null }), "Asia/Karachi", "UTC")).toBeNull();
  });
  it("describes how soon it's due", () => {
    const tz = "Asia/Karachi";
    expect(dueRelation(task(), tz, tz, new Date("2026-10-17T05:00:20Z")).short).toBe("Due now");
    expect(dueRelation(task(), tz, tz, new Date("2026-10-17T04:45:00Z")).short).toBe("Due in 15 min");
    expect(dueRelation(task(), tz, tz, new Date("2026-10-17T04:00:00Z")).short).toBe("Due in 1 hour");
    expect(dueRelation(task(), tz, tz, new Date("2026-10-16T05:00:30Z")).short).toBe("Due in 1 day");
    expect(dueRelation(task(), tz, tz, new Date("2026-10-17T08:00:00Z")).short).toBe("Overdue");
    expect(dueRelation(task({ due_time: null }), tz, tz, new Date("2026-10-16T19:00:30Z")).short).toBe("Due today");
  });
  it("tells the owner why they get someone else's reminder", () => {
    expect(taskReminderEmail(ctx({ asOwner: true, task: task({ assigned_to: null }) })).text).toContain("Unassigned, so it comes to you as the CRM owner");
    expect(taskReminderEmail(ctx({ asOwner: true })).text).toContain("no longer on the team");
  });
  it("digest: short, specific, escaped", () => {
    const item = (id: string, title: string) => ({ task: task({ id, title }), due: "Mon 19 Oct", leadName: `Lead ${EVIL}`, dealTitle: null });
    const e = dailyDigestEmail({
      recipientName: "Eddie",
      localDate: "2026-10-19",
      timeZone: "Asia/Karachi",
      sections: { overdue: [item("a", `A ${EVIL}`)], today: [], upcoming: [item("b", "B")], more: { overdue: 2, today: 0, upcoming: 0 } },
    });
    expect(e.subject).toBe("Your tasks for Mon 19 Oct: 3 overdue, 1 in the next 7 days");
    expect(e.html).not.toContain("<img");
    expect(e.html).toContain("and 2 more in the CRM.");
    expect(e.html).toContain('href="https://crm.example/?task=a"');
    expect(e.text).toContain("Overdue (3)");
    expect(e.text).toContain("Next 7 days (1)");
    expect(e.text).not.toContain("Due today (");
  });
  it("test email says how it was sent", () => {
    const e = testEmail({ recipientName: `Ed ${EVIL}`, senderLabel: "Gmail account crm@gmail.com", now: new Date("2026-10-17T05:00:00Z"), timeZone: "Asia/Karachi" });
    expect(e.subject).toBe("Test email from Brandigade CRM");
    expect(e.html).not.toContain("<img");
    expect(e.text).toContain("Sent Sat 17 Oct 2026, 10:00 AM (Karachi time) through Gmail account crm@gmail.com.");
  });
});
