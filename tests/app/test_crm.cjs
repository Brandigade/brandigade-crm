// Runs the whole CRM front end in jsdom against the in-browser Supabase
// stand-in from js/demo.js (the same one demo mode uses).
//  A. "Connected" mode: the admin opens a fresh company CRM; server calls
//     (/api/...) are captured from fetch.
//  B. Data layer: only changed records are saved, remote changes are applied,
//     unsaved local edits survive an echo, legacy backups get new ids.
//  C. Demo mode with the sample data.
//  D. Sign-up that needs email confirmation.
//  E. Someone who signed up without an invite.
//  F. Deep links and the timeline.
// npm run test:app
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
// Inline the app's own scripts and drop the CDN + config.js tags.
const raw = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/g, "")
  .replace('<script src="config.js"></script>', "")
  .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (_, src) => "<script>\n" + fs.readFileSync(path.join(root, src), "utf8").replace(/<\/script>/g, "<\\/script>") + "\n</script>");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

function freshStore() {
  return {
    profiles: [
      { id: "u1", email: "me@x.co", display_name: null, avatar_data: null, is_platform_admin: true, created_at: "2026-01-01T00:00:00Z" },
      { id: "u2", email: "ed@x.co", display_name: "Ed", avatar_data: null, is_platform_admin: false, created_at: "2026-01-02T00:00:00Z" },
    ],
    workspaces: [{ id: "ws1", name: "Brandigade", status: "active", created_at: "2026-01-01T00:00:00Z", settings: {} }],
    workspace_members: [{ workspace_id: "ws1", user_id: "u1", role: "owner", invited: false, created_at: "2026-01-01T00:00:00Z" }],
    companies: [], contacts: [], deals: [], tasks: [], activities: [],
  };
}

function boot(html, { connected, user, url, store: givenStore } = {}) {
  user = user || { id: "u1", email: "me@x.co" };
  const fnCalls = [];
  let store = null, client = null;
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: url || "https://x.test/",
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = function () {};
      w.AudioContext = undefined;
      w.fetch = async (u, o) => {
        o = o || {};
        fnCalls.push({ u, method: o.method || "GET", body: o.body ? JSON.parse(o.body) : null });
        let body = { success: true };
        if (u.endsWith("/api/config")) body = { features: { gmail: false, outlook: false, calling: false, notifications: false } };
        return { ok: true, status: 200, json: async () => body };
      };
      if (connected) {
        w.BRANDIGADE_CONFIG = { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" };
        w.supabase = {
          createClient: () => {
            store = givenStore || freshStore();
            client = w.createDemoClient({ store, user });
            delete client.api; // force the real /api paths (captured by fetch)
            client.auth.getSession = async () => ({ data: { session: { user, access_token: "t" } } });
            return client;
          },
        };
      }
    },
  });
  return { w: dom.window, d: dom.window.document, fnCalls, getStore: () => store, getClient: () => client };
}

(async () => {
  // ---------- A. The admin opens a fresh company CRM ----------
  let { w, d, fnCalls, getStore } = boot(raw, { connected: true });
  const txt = (id) => d.getElementById(id).textContent;
  const nav = (id) => d.querySelector(`.nav-item[data-tab="${id}"]`).click();
  await sleep(700);
  const store = getStore();
  ok(d.getElementById("auth-screen").classList.contains("hidden"), "the admin goes straight into the CRM");
  const navs = [...d.querySelectorAll(".nav-item")].map((e) => e.textContent.trim());
  ok(navs.join("|") === "Dashboard|Pipeline|Contacts|Companies|Tasks|Profile|Team", "nav: " + navs.join("|"));
  ok(d.title === "Brandigade CRM" && d.querySelector(".sidebar .brand-lockup img").getAttribute("src") === "assets/logo-white.png", "Brandigade branding from the asset files");
  ok(d.querySelectorAll("#d-next .list-row").length === 3, "new workspace starts with welcome tasks");
  ok(store.tasks.length === 4 && store.workspaces[0].settings.seeded === true, "welcome tasks saved once to the tasks table");
  ok(fnCalls.some((c) => c.u === "/api/config"), "loads the server feature flags");

  // company + contact + activity + deal
  nav("companies");
  d.getElementById("add-company-btn").click();
  d.getElementById("rm-name").value = "Globex <b>Co</b>"; d.getElementById("rm-industry").value = "Retail";
  d.getElementById("rm-save-btn").click(); await sleep(600);
  const co = w.eval("state.companies[0]");
  ok(co && co.name === "Globex <b>Co</b>" && /^[0-9a-f-]{36}$/.test(co.id), "company saved with a UUID");
  ok(!d.querySelector("#companies-tbody b"), "company name HTML-escaped");
  ok(store.companies.length === 1 && store.companies[0].workspace_id === "ws1" && store.companies[0].industry === "Retail", "saved to the companies table");
  d.getElementById("rm-close").click();
  nav("contacts");
  d.getElementById("add-contact-btn").click();
  d.getElementById("rm-firstName").value = "Rana"; d.getElementById("rm-email").value = "rana@globex.co"; d.getElementById("rm-companyId").value = co.id;
  d.getElementById("rm-save-btn").click(); await sleep(600);
  const ct = w.eval("state.contacts[0]");
  ok(ct && ct.companyId === co.id && ct.ownerId === "u1", "contact saved with company and owner");
  ok(store.contacts[0].company_id === co.id && store.contacts[0].email_normalized === "rana@globex.co", "contact row has the company link and normalized email");
  ok(!!d.querySelector("#rm-related .tl-filters") && d.querySelectorAll("#rm-related .tl-chip").length === 5, "record shows the unified timeline with type filters");
  d.getElementById("act-subject").value = "Intro call"; d.getElementById("act-type").value = "call"; d.getElementById("act-log-btn").click(); await sleep(600);
  ok(w.eval("state.activities.find(a => a.subject === 'Intro call').contactId") === ct.id, "activity logged in state");
  ok(store.activities.some((a) => a.subject === "Intro call" && a.contact_id === ct.id && a.source === "manual" && a.actor_id === "u1"), "activity saved to the activities table");
  ok([...d.querySelectorAll("#rm-timeline .tl-title")].some((e) => e.textContent.includes("Intro call")), "logged activity appears on the timeline");
  d.getElementById("act-subject").value = "Private thought"; d.getElementById("act-private").checked = true; d.getElementById("act-log-btn").click(); await sleep(600);
  const priv = store.activities.find((a) => a.subject === "Private thought");
  ok(priv && priv.visibility === "private" && priv.owner_user_id === "u1", "private note saved as private to its author");
  ok([...d.querySelectorAll("#rm-timeline .tl-item")].some((e) => e.textContent.includes("Private thought") && e.querySelector(".tl-pill-private")), "private note is marked on the timeline");
  [...d.querySelectorAll("#rm-related .panel-link")].find((b) => b.textContent.includes("Add deal")).click();
  d.getElementById("rm-title").value = "Rebrand"; d.getElementById("rm-value").value = "25000"; d.getElementById("rm-stage").value = "proposal";
  d.getElementById("rm-save-btn").click(); await sleep(600);
  d.getElementById("rm-close").click();
  ok(txt("d-pipeline-value").replace(/[^0-9]/g, "") === "25000" && txt("d-weighted").replace(/[^0-9]/g, "") === "12500", "pipeline and weighted forecast");
  ok(store.deals.length === 1 && store.deals[0].contact_id === ct.id && store.deals[0].company_id === co.id && Number(store.deals[0].value) === 25000, "deal saved with links");
  nav("pipeline");
  const deal = w.eval("state.deals[0]");
  const ev = new w.Event("drop", { bubbles: true, cancelable: true }); ev.dataTransfer = { getData: () => deal.id };
  d.querySelector('.board-col-body[data-stage="won"]').dispatchEvent(ev); await sleep(600);
  ok(w.eval("state.deals[0].stage") === "won" && txt("d-win-rate") === "100%", "drag to Won updates win rate");
  ok(store.deals[0].stage === "won" && !!store.deals[0].closed_at, "won deal saved with its close date");

  nav("contacts");
  for (const n of ["Two", "Three", "Four"]) { d.getElementById("add-contact-btn").click(); d.getElementById("rm-firstName").value = n; d.getElementById("rm-save-btn").click(); await sleep(450); d.getElementById("rm-close").click(); }
  ok(w.eval("state.contacts.length") === 4 && store.contacts.length === 4, "no contact limit");

  // team
  nav("team");
  ok(!d.getElementById("ws-seats") && !d.getElementById("ws-name-input"), "team page has no plan usage or workspace rename");
  d.getElementById("new-invite-email").value = "new@x.co"; d.getElementById("new-invite-role").value = "editor";
  d.getElementById("add-invite-btn").click(); await sleep(400);
  const invite = fnCalls.find((c) => c.u === "/api/team-admin");
  ok(invite && invite.method === "POST" && invite.body.workspaceId === "ws1" && invite.body.role === "editor" && invite.body.email === "new@x.co", "invite goes to the server's team-admin route");
  d.getElementById("ws-currency").value = "AED"; d.getElementById("ws-currency").dispatchEvent(new w.Event("change")); await sleep(500);
  ok(/AED/.test(txt("d-pipeline-value")) && store.workspaces[0].settings.currency === "AED", "currency setting saved to the workspace");
  const tz = w.Intl.DateTimeFormat().resolvedOptions().timeZone;
  ok(store.workspaces[0].settings.timezone === tz && txt("ws-timezone") === tz, "team time zone saved for reminder emails");

  // tasks
  nav("board");
  d.getElementById("add-task-trigger").click();
  const now = new Date(Date.now() - 60000);
  const pad = (n) => String(n).padStart(2, "0");
  d.getElementById("tm-title").value = "Write <b>report</b>";
  d.getElementById("tm-due-date").value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  d.getElementById("tm-due-time").value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  d.getElementById("tm-reminder").value = "at_due"; d.getElementById("tm-deal").value = deal.id;
  d.getElementById("tm-save-btn").click(); await sleep(600);
  const task = w.eval("state.board.at(-1)");
  ok(!d.querySelector("#board .card-title b") && task.dealId === deal.id, "task saved, escaped, linked to deal");
  ok(task.contactId === ct.id, "a task on a deal is linked to the deal's main contact");
  const taskRow = store.tasks.find((t) => t.id === task.id);
  ok(taskRow && taskRow.contact_id === ct.id && taskRow.reminder === "at_due" && taskRow.assigned_to === "u1", "task row saved with lead, reminder and assignee");
  ok(store.activities.some((a) => a.source === "task" && a.event === "created" && a.task_id === task.id), "task creation shows on the timeline");
  ok(w.eval("notificationHistory.length") >= 1, "reminder that just went off notifies the assignee in the app");
  const notifCount = w.eval("notificationHistory.length");
  w.eval("checkReminders()");
  ok(w.eval("notificationHistory.length") === notifCount, "the same reminder never rings twice");
  w.eval(`state.board.push({ id: newId(), title: "Someone else's", column: "todo", dueDate: "${task.dueDate}", dueTime: "${task.dueTime}", reminder: "at_due", priority: "none", assignedTo: "u2", workstream: "General" })`);
  w.eval("checkReminders()");
  ok(w.eval("notificationHistory.length") === notifCount, "reminders for other people's tasks don't ring here");
  w.eval("state.board.pop()");
  d.querySelector(`#board .card[data-id="${task.id}"]`).click();
  d.getElementById("tm-close-btn") && d.getElementById("tm-close-btn").click();
  d.getElementById("tm-cancel-btn").click();
  w.eval(`openTaskViewModal("${task.id}")`);
  ok(d.getElementById("tv-contact").textContent.includes("Rana"), "task view shows the associated lead");
  d.getElementById("tv-close-btn").click();

  // Escape used to throw (closeCreateWorkspace no longer existed)
  let escErr = null; w.addEventListener("error", (e) => { escErr = e.error; });
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(20);
  ok(!escErr, "Escape closes dialogs without errors");

  // viewer lockdown
  w.eval('currentRole="viewer"'); w.eval("applyRolePermissions()"); nav("contacts");
  ok(d.getElementById("add-contact-btn").disabled && !d.getElementById("contacts-search").disabled, "viewer: add disabled, search usable");
  const before = JSON.stringify(store.contacts);
  w.eval("state.contacts[0].firstName = 'Hacked'; saveState()"); await sleep(500);
  ok(JSON.stringify(store.contacts) === before, "viewer cannot save");
  w.eval("state.contacts[0].firstName = 'Rana'");
  w.eval('currentRole="owner"'); w.eval("applyRolePermissions()");

  // ---------- B. Data layer ----------
  const stamps = Object.fromEntries(store.contacts.map((c) => [c.id, c.updated_at]));
  await sleep(15);
  w.eval(`state.contacts.find(c => c.id === "${ct.id}").title = "CMO"; saveState()`); await sleep(500);
  const changed = store.contacts.filter((c) => c.updated_at !== stamps[c.id]).map((c) => c.id);
  ok(changed.length === 1 && changed[0] === ct.id && store.contacts.find((c) => c.id === ct.id).title === "CMO", "saving only writes the record that changed");
  w.eval(`sb.from("contacts").insert({ id: "11111111-2222-4333-8444-555555555555", workspace_id: "ws1", first_name: "Remote", status: "lead" }).then(() => {})`); await sleep(200);
  ok(w.eval(`!!state.contacts.find(c => c.firstName === "Remote")`) && [...d.querySelectorAll("#contacts-tbody tr")].some((tr) => tr.textContent.includes("Remote")), "a teammate's new contact appears without reloading");
  w.eval(`sb.from("contacts").delete().eq("id", "11111111-2222-4333-8444-555555555555").then(() => {})`); await sleep(200);
  ok(!w.eval(`state.contacts.find(c => c.firstName === "Remote")`), "a teammate's deletion is applied");
  // A remote echo must not wipe an edit that hasn't been saved yet.
  w.eval(`state.contacts.find(c => c.id === "${ct.id}").title = "CEO"`);
  w.eval(`sb.from("contacts").update({ notes: "from elsewhere" }).eq("id", "${ct.id}").then(() => {})`); await sleep(200);
  ok(w.eval(`state.contacts.find(c => c.id === "${ct.id}").title`) === "CEO", "an unsaved local edit survives a remote update");
  w.eval("saveState()"); await sleep(500);
  ok(store.contacts.find((c) => c.id === ct.id).title === "CEO", "...and is saved afterwards");
  // Legacy backup (ids like "c1") imports with fresh UUIDs and intact links.
  const legacy = w.eval(`normalizeImportedIds(mergeWithSeed({ companies:[{id:"co1",name:"Old Co"}], contacts:[{id:"c1",firstName:"Old",companyId:"co1"}], deals:[{id:"d1",title:"Old deal",contactId:"c1",companyId:"co1",stage:"lead",value:5}], board:[{id:"b1",title:"Old task",dealId:"d1",column:"todo"}], activities:[{id:"a1",type:"note",subject:"Old note",contactId:"c1",at:"2026-01-01T00:00:00Z"}] }))`);
  const isU = (v) => /^[0-9a-f-]{36}$/.test(v);
  ok(isU(legacy.companies[0].id) && legacy.contacts[0].companyId === legacy.companies[0].id && legacy.deals[0].contactId === legacy.contacts[0].id && legacy.board[0].dealId === legacy.deals[0].id && legacy.activities[0].contactId === legacy.contacts[0].id, "legacy backups get UUIDs with every link kept");

  // ---------- C. Demo mode ----------
  ({ w, d } = boot(raw, {}));
  await sleep(300);
  ok(!d.getElementById("demo-btn").classList.contains("hidden"), "unconfigured copy offers the demo");
  d.getElementById("demo-btn").click(); await sleep(900);
  ok(d.body.classList.contains("is-demo") && w.eval("currentWorkspace.name") === "Brandigade", "demo opens the Brandigade CRM");
  ok(w.eval("state.deals.length") === 9 && w.eval("teamList.length") === 4, "demo sample data loaded");
  ok(d.querySelectorAll("#pipeline .card").length === 9, "demo pipeline renders");
  ok(d.querySelectorAll("#d-activity .tl-item").length === 6, "demo dashboard shows recent activity");
  w.eval('state.deals[0].title="Renamed in demo";saveState()'); await sleep(600);
  const stored = JSON.parse(w.localStorage.getItem("brandigade-crm-demo-v4"));
  ok(stored && stored.workspaces.length === 1 && stored.deals.find((x) => x.id === "d1").title === "Renamed in demo", "demo changes persist in the browser");
  w.eval('openRecordModal("contact", "c1")'); await sleep(200);
  ok(d.querySelectorAll("#rm-timeline .tl-item").length >= 1, "demo contact shows its timeline");

  // ---------- D. Sign-up that needs email confirmation ----------
  const signUps = [];
  const dom3 = new JSDOM(raw, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://x.test/crm/",
    beforeParse(w3) {
      w3.Element.prototype.scrollIntoView = function () {}; w3.AudioContext = undefined;
      w3.BRANDIGADE_CONFIG = { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" };
      w3.supabase = { createClient: () => {
        const c = w3.createDemoClient({ store: freshStore(), user: { id: "u9", email: "new@x.co" } });
        c.auth.getSession = async () => ({ data: { session: null } });
        c.auth.signUp = async (a) => { signUps.push(a); return { data: { user: { id: "u9" }, session: null }, error: null }; };
        return c;
      } };
    },
  });
  const d3 = dom3.window.document; await sleep(400);
  d3.getElementById("auth-mode-link").click();
  d3.getElementById("auth-email").value = "new@x.co"; d3.getElementById("auth-password").value = "secret123";
  d3.getElementById("auth-form").dispatchEvent(new dom3.window.Event("submit", { cancelable: true })); await sleep(300);
  ok(signUps.length === 1 && signUps[0].options.emailRedirectTo === "https://x.test/crm/", "sign-up sends the site address for the confirmation link");
  ok(d3.getElementById("auth-success").classList.contains("show") && d3.getElementById("auth-success").textContent.includes("new@x.co"), "sign-up tells the user to check their email");
  ok(d3.getElementById("auth-submit-btn").textContent === "Log in" && !d3.getElementById("auth-submit-btn").disabled, "form switches to log in after sign-up");

  // ---------- E. Signed up without an invite ----------
  const u4 = boot(raw, { connected: true, user: { id: "u2", email: "ed@x.co" } });
  await sleep(700);
  ok(!u4.d.getElementById("auth-screen").classList.contains("hidden") && !u4.d.getElementById("auth-noaccess-view").classList.contains("hidden"), "uninvited user is told to ask the admin for an invite");
  ok(u4.w.eval("currentWorkspace") === null, "uninvited user never opens the CRM");

  // ---------- F. Deep links from notification emails ----------
  const linkStore = freshStore();
  linkStore.workspaces[0].settings = { seeded: true, timezone: "UTC" };
  linkStore.contacts.push({ id: "aaaaaaaa-0000-4000-8000-000000000001", workspace_id: "ws1", legacy_id: "c7", first_name: "Linked", status: "lead", created_at: "2026-01-01T00:00:00Z" });
  linkStore.tasks.push({ id: "aaaaaaaa-0000-4000-8000-000000000002", workspace_id: "ws1", legacy_id: "b101", title: "Legacy task", status: "todo", reminder: "none", priority: "none", workstream: "General", created_at: "2026-01-01T00:00:00Z" });
  const u5 = boot(raw, { connected: true, url: "https://x.test/?task=b101", store: linkStore });
  await sleep(800);
  ok(!u5.d.getElementById("task-view-modal-overlay").classList.contains("hidden") && u5.d.getElementById("tv-title").textContent === "Legacy task", "an old reminder link (?task=<old id>) opens the task");
  const u6 = boot(raw, { connected: true, url: "https://x.test/?contact=aaaaaaaa-0000-4000-8000-000000000001", store: (() => { const s = JSON.parse(JSON.stringify(linkStore)); return s; })() });
  await sleep(800);
  ok(!u6.d.getElementById("record-modal-overlay").classList.contains("hidden") && u6.d.getElementById("rm-title").textContent === "Linked", "?contact=<id> opens the lead record");

  console.log(fail ? `FAILED (${fail})` : "ALL PASS");
  process.exit(fail ? 1 : 0);
})();
