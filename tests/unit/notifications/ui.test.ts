// The Profile "Email notifications" panel and the owner's Team panel, in the
// real front end (index.html + js/*.js in jsdom) against the demo Supabase
// stand-in, the same way tests/app/test_crm.cjs runs the app.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const html = fs
  .readFileSync(path.join(root, "index.html"), "utf8")
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/g, "")
  .replace('<script src="config.js"></script>', "")
  .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (_m: string, src: string) => "<script>\n" + fs.readFileSync(path.join(root, src), "utf8").replace(/<\/script>/g, "<\\/script>") + "\n</script>");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ApiReply = { status?: number; body: unknown };
interface BootOpts {
  role?: "owner" | "editor" | "viewer";
  notifications?: boolean;
  api?: (path: string, method: string, body: unknown) => ApiReply | undefined;
  prefs?: Record<string, unknown>[];
  demo?: boolean;
}

async function boot(opts: BootOpts = {}) {
  const role = opts.role || "owner";
  const user = { id: "u1", email: "me@x.co" };
  const calls: { path: string; method: string; body: unknown }[] = [];
  let store: any = null;
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://x.test/",
    beforeParse(w: any) {
      w.Element.prototype.scrollIntoView = function () {};
      w.AudioContext = undefined;
      w.fetch = async (u: string, o: any = {}) => {
        const p = u.replace(/^\/api/, "");
        const body = o.body ? JSON.parse(o.body) : null;
        calls.push({ path: p, method: o.method || "GET", body });
        let reply: ApiReply = { body: { error: "Not found", code: "not_found" }, status: 404 };
        if (p === "/config") reply = { body: { features: { gmail: false, outlook: false, calling: false, notifications: !!opts.notifications } } };
        const custom = opts.api?.(p, o.method || "GET", body);
        if (custom) reply = custom;
        const status = reply.status || 200;
        return { ok: status < 400, status, json: async () => reply.body };
      };
      if (opts.demo) {
        w.BRANDIGADE_AUTODEMO = true;
        return;
      }
      w.BRANDIGADE_CONFIG = { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" };
      w.supabase = {
        createClient: () => {
          store = {
            profiles: [
              { id: "u1", email: "me@x.co", display_name: "Me", avatar_data: null, is_platform_admin: false, created_at: "2026-01-01T00:00:00Z" },
              { id: "u0", email: "boss@x.co", display_name: "Boss", avatar_data: null, is_platform_admin: false, created_at: "2026-01-01T00:00:00Z" },
            ],
            workspaces: [{ id: "ws1", name: "Brandigade", status: "active", created_at: "2026-01-01T00:00:00Z", settings: { timezone: "Asia/Karachi", seeded: true } }],
            workspace_members: [
              { workspace_id: "ws1", user_id: "u1", role, invited: false, created_at: "2026-01-02T00:00:00Z" },
              ...(role === "owner" ? [] : [{ workspace_id: "ws1", user_id: "u0", role: "owner", invited: false, created_at: "2026-01-01T00:00:00Z" }]),
            ],
            companies: [], contacts: [], deals: [], tasks: [], activities: [],
            user_preferences: opts.prefs || [],
          };
          const client = w.createDemoClient({ store, user });
          delete client.api; // use the real /api paths (answered by fetch above)
          client.auth.getSession = async () => ({ data: { session: { user, access_token: "t" } } });
          return client;
        },
      };
    },
  });
  const w = dom.window;
  const d = w.document;
  for (let i = 0; i < 40 && !d.getElementById("auth-screen").classList.contains("hidden"); i++) await sleep(50);
  await sleep(100);
  const nav = (tab: string) => d.querySelector(`.nav-item[data-tab="${tab}"]`).click();
  const change = (el: any, value?: unknown) => {
    if (el.type === "checkbox") el.checked = value === undefined ? !el.checked : !!value;
    else el.value = String(value);
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  return { w, d, calls, store: () => store, nav, change };
}

describe("Profile: Email notifications", () => {
  it("loads the defaults, autosaves each change and says so", async () => {
    const { d, store, nav, change } = await boot({ prefs: [{ user_id: "u1", calls_receive_inbound: false, notify_task_overdue: false }] });
    nav("profile");
    const panel = d.getElementById("notif-prefs-panel");
    expect(panel).toBeTruthy();
    expect(panel.querySelector("h3").textContent).toBe("Email notifications");
    expect(panel.textContent).toContain("Emails go to me@x.co");
    const q = (id: string) => d.getElementById(id) as any;
    expect(q("np-task_assigned").checked).toBe(true);
    expect(q("np-task_reminders").checked).toBe(true);
    expect(q("np-task_overdue").checked).toBe(false); // from the saved row
    expect(q("np-daily_digest").checked).toBe(false);
    expect(q("np-digest-hour").value).toBe("8");
    expect(q("np-digest-hour").disabled).toBe(false); // also sets overdue mornings, so usable with the digest off
    const tz = q("np-timezone");
    expect(tz.value).toBe("");
    expect(tz.options[0].textContent).toBe("Team time zone (Asia/Karachi)");
    expect(panel.textContent).toContain("As the CRM owner you also get the reminders for unassigned tasks.");

    change(q("np-daily_digest"), true);
    await sleep(30);
    change(q("np-digest-hour"), 7);
    change(q("np-timezone"), "Europe/Berlin");
    await sleep(80);
    const row = store().user_preferences.find((r: any) => r.user_id === "u1");
    expect(row).toMatchObject({ notify_daily_digest: true, digest_hour: 7, timezone: "Europe/Berlin", notify_task_overdue: false });
    expect(row.calls_receive_inbound).toBe(false); // the calling setting in the same row is untouched
    expect(d.getElementById("notif-save-state").textContent).toBe("Saved");
    expect(store().user_preferences).toHaveLength(1);
  });

  it("shows the not-set-up state instead of a test button when the server has no sender", async () => {
    const { d, nav } = await boot({ notifications: false });
    nav("profile");
    expect(d.querySelector("[data-notif-action='send-test']")).toBeNull();
    expect(d.getElementById("notif-test").textContent).toContain("Email sending isn't set up on the server yet");
    expect(d.getElementById("notif-banner").classList.contains("hidden")).toBe(false);
  });

  it("sends a test email and reports the outcome, including the rate limit", async () => {
    let n = 0;
    const { d, nav, calls } = await boot({
      notifications: true,
      api: (p, m) => {
        if (p !== "/notifications/test" || m !== "POST") return undefined;
        n++;
        return n === 1
          ? { body: { sent: true, to: "me@x.co", provider: "smtp" } }
          : { status: 429, body: { error: "You can send one test email a minute. Try again in a moment.", code: "rate_limited" } };
      },
    });
    nav("profile");
    expect(d.getElementById("notif-banner").classList.contains("hidden")).toBe(true);
    (d.querySelector("[data-notif-action='send-test']") as any).click();
    await sleep(50);
    expect(calls.some((c) => c.path === "/notifications/test" && c.method === "POST")).toBe(true);
    expect(d.querySelector(".notif-test-result").textContent).toContain("Sent to me@x.co");
    (d.querySelector("[data-notif-action='send-test']") as any).click();
    await sleep(50);
    const result = d.querySelector(".notif-test-result");
    expect(result.textContent).toBe("You can send one test email a minute. Try again in a moment.");
    expect(result.classList.contains("is-bad")).toBe(true);
  });

  it("viewers manage their own preferences too", async () => {
    const { d, nav, change, store } = await boot({ role: "viewer", notifications: true });
    nav("profile");
    const sw = d.getElementById("np-task_reminders") as any;
    expect(sw.disabled).toBe(false);
    expect((d.querySelector("[data-notif-action='send-test']") as any).disabled).toBe(false);
    change(sw, false);
    await sleep(50);
    expect(store().user_preferences.find((r: any) => r.user_id === "u1")).toMatchObject({ notify_task_reminders: false });
    expect(d.getElementById("notif-prefs-panel").textContent).not.toContain("As the CRM owner");
  });

  it("demo mode: settings work, test emails explain why they can't", async () => {
    const { d, nav, change, w } = await boot({ demo: true });
    nav("profile");
    expect(d.getElementById("notif-banner").textContent).toContain("demo");
    expect(d.getElementById("notif-test").textContent).toContain("demo doesn't have");
    change(d.getElementById("np-task_assigned"), false);
    await sleep(50);
    expect(d.getElementById("notif-save-state").textContent).toBe("Saved");
    const saved = w.eval("demoStore.user_preferences");
    expect(saved.find((r: any) => r.user_id === "demo-owner")).toMatchObject({ notify_task_assigned: false });
  });
});

describe("Team: Notification emails (owner)", () => {
  const statusBody = {
    sender: { configured: true, kind: "gmail", label: "Gmail account crm@gmail.com", from: "Brandigade CRM <crm@gmail.com>" },
    last24h: { sent: 4, skipped: 2, failed: 1, waiting: 0 },
    recentFailures: [
      { id: 9, kind: "notify.task_reminder", status: "dead", attempts: 1, maxAttempts: 6, error: "Recipient <script>x</script> rejected", at: new Date().toISOString(), taskId: "t1", taskTitle: "Call <b>Maya</b>", recipient: "Eddie" },
    ],
  };
  it("shows the sender, counts and failures without clearing the shared container", async () => {
    let n = 0;
    const { d, w, nav, calls } = await boot({ notifications: true, api: (p) => (p === "/notifications/status" ? (n++, { body: statusBody }) : undefined) });
    nav("team");
    const host = d.getElementById("team-integrations-section");
    const other = d.createElement("div");
    other.id = "someone-elses-panel";
    host.insertBefore(other, host.firstChild);
    w.eval("renderAll()");
    w.eval("renderAll()");
    await sleep(30);
    expect(d.getElementById("someone-elses-panel")).toBeTruthy();
    expect(host.querySelectorAll("#notif-team-panel")).toHaveLength(1);
    const panel = d.getElementById("notif-team-panel");
    expect(panel.textContent).toContain("Sending through Gmail account crm@gmail.com");
    expect(panel.textContent).toContain("4 sent · 2 skipped · 1 failed");
    expect(panel.querySelector(".notif-fail b").textContent).toBe("Call <b>Maya</b>");
    expect(panel.innerHTML).not.toContain("<script>");
    expect(panel.textContent).toContain("Recipient <script>x</script> rejected");
    expect(n).toBe(1); // re-renders reuse what was loaded
    (panel.querySelector("[data-notif-action='refresh-status']") as any).click();
    await sleep(30);
    expect(calls.filter((c) => c.path === "/notifications/status")).toHaveLength(2);
  });
  it("explains what to set when no sender is configured", async () => {
    const { d, nav } = await boot({ api: (p) => (p === "/notifications/status" ? { body: { ...statusBody, sender: { configured: false }, recentFailures: [] } } : undefined) });
    nav("team");
    await sleep(30);
    const panel = d.getElementById("notif-team-panel");
    expect(panel.textContent).toContain("Not set up");
    expect(panel.textContent).toContain("GMAIL_APP_PASSWORD");
    expect(panel.textContent).toContain("No delivery problems.");
  });
  it("shows load errors", async () => {
    const { d, nav } = await boot({ api: (p) => (p === "/notifications/status" ? { status: 500, body: { error: "Something went wrong on the server.", code: "server_error" } } : undefined) });
    nav("team");
    await sleep(30);
    expect(d.getElementById("notif-team-panel").textContent).toContain("Couldn't load the notification status: Something went wrong on the server.");
  });
  it("is not shown to editors and viewers", async () => {
    for (const role of ["editor", "viewer"] as const) {
      const { d, nav, calls } = await boot({ role });
      nav("team");
      expect(d.getElementById("notif-team-panel")).toBeNull();
      expect(calls.some((c) => c.path === "/notifications/status")).toBe(false);
    }
  });
  it("demo mode says it needs the server", async () => {
    const { d, nav } = await boot({ demo: true });
    nav("team");
    await sleep(30);
    expect(d.getElementById("notif-team-panel").textContent).toContain("demo doesn't have");
  });
});

describe("NotificationsUI.teamDueInstant (for the in-app reminder)", () => {
  it("reads due times in the team's zone exactly like the server, DST included", async () => {
    const { naiveLocalToUtc } = await import("../../../lib/server/notifications/time.js");
    const { w } = await boot();
    const ui = w.NotificationsUI;
    expect(ui.teamDueInstant("2026-10-17", "10:00").toISOString()).toBe("2026-10-17T05:00:00.000Z"); // team zone: Asia/Karachi
    expect(ui.teamDueInstant("2026-10-17", null).toISOString()).toBe("2026-10-16T19:00:00.000Z");
    expect(ui.teamDueInstant("", "10:00")).toBeNull();
    for (const zone of ["America/New_York", "Europe/Berlin", "Australia/Sydney", "Asia/Kolkata"]) {
      for (const date of ["2026-03-08", "2026-03-29", "2026-04-05", "2026-10-04", "2026-10-25", "2026-11-01"]) {
        for (const time of ["00:00", "00:30", "01:30", "02:00", "02:30", "03:00", "03:30", "09:15", "23:59"]) {
          expect(ui.teamDueInstant(date, time, zone).getTime()).toBe(naiveLocalToUtc(date, time, zone).getTime());
        }
      }
    }
  });
});
