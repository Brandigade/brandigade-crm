// The dialer UI (js/dialer.js) running inside the whole CRM front end in
// jsdom, on the in-browser Supabase stand-in from js/demo.js, with a fake
// Twilio Voice SDK and fake /api responses. Nothing reaches a network.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const html = fs
  .readFileSync(path.join(root, "index.html"), "utf8")
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/g, "")
  .replace('<script src="config.js"></script>', "")
  .replace(/<script src="(js\/[\w-]+\.js)"><\/script>/g, (_m: string, src: string) => "<script>\n" + fs.readFileSync(path.join(root, src), "utf8").replace(/<\/script>/g, "<\\/script>") + "\n</script>");

const U = { owner: "10000000-0000-4000-8000-000000000001", viewer: "10000000-0000-4000-8000-000000000002" };
const IDS = {
  ws: "20000000-0000-4000-8000-000000000001",
  co: "30000000-0000-4000-8000-000000000001",
  maya: "40000000-0000-4000-8000-000000000001",
  nophone: "40000000-0000-4000-8000-000000000002",
  deal: "50000000-0000-4000-8000-000000000001",
  call: "60000000-0000-4000-8000-000000000001",
};
const CALL_SID = "CA" + "1".repeat(32);

function store(settings: Record<string, unknown> = {}) {
  const t = "2026-01-01T00:00:00Z";
  return {
    profiles: [
      { id: U.owner, email: "owner@x.co", display_name: "Olivia", avatar_data: null, is_platform_admin: false, created_at: t },
      { id: U.viewer, email: "viewer@x.co", display_name: "Vera", avatar_data: null, is_platform_admin: false, created_at: t },
    ],
    workspaces: [{ id: IDS.ws, name: "Brandigade", status: "active", created_at: t, settings: { seeded: true, timezone: "UTC", currency: "USD", ...settings } }],
    workspace_members: [
      { workspace_id: IDS.ws, user_id: U.owner, role: "owner", invited: false, created_at: t },
      { workspace_id: IDS.ws, user_id: U.viewer, role: "viewer", invited: false, created_at: t },
    ],
    companies: [{ id: IDS.co, workspace_id: IDS.ws, name: "Cedar & Crumb", phone: "+1 415 555 0142", created_at: t }],
    contacts: [
      { id: IDS.maya, workspace_id: IDS.ws, first_name: "Maya", last_name: "Rivera", phone: "+1 415 555 0143", company_id: IDS.co, status: "customer", created_at: t },
      { id: IDS.nophone, workspace_id: IDS.ws, first_name: "Noah", last_name: "Phoneless", phone: null, company_id: null, status: "lead", created_at: t },
    ],
    deals: [{ id: IDS.deal, workspace_id: IDS.ws, title: "Wholesale rebrand", contact_id: IDS.maya, company_id: IDS.co, value: 25000, stage: "proposal", created_at: t }],
    tasks: [], activities: [], calls: [] as any[], user_preferences: [] as any[],
  };
}

// ---- A stand-in for the Twilio Voice SDK (window.Twilio) ----
const fakeTwilioSource = `
  class Emitter { constructor(){ this.h = {}; } on(e, f){ (this.h[e] = this.h[e] || []).push(f); return this; } emit(e, ...a){ (this.h[e] || []).forEach(f => f(...a)); } }
  class FakeCall extends Emitter {
    constructor(parameters, custom){ super(); this.parameters = parameters || {}; this.customParameters = new Map(Object.entries(custom || {})); this.muted = false; this.digits = []; this.accepted = false; this.rejected = false; }
    mute(m){ this.muted = m; this.emit("mute", m, this); }
    isMuted(){ return this.muted; }
    sendDigits(d){ this.digits.push(d); }
    disconnect(){ this.emit("disconnect", this); }
    accept(){ this.accepted = true; this.emit("accept", this); }
    reject(){ this.rejected = true; this.emit("reject"); }
  }
  class FakeDevice extends Emitter {
    constructor(token, options){ super(); FakeDevice.instances.push(this); this.token = token; this.options = options; this.state = "unregistered"; this.connects = []; }
    async register(){ this.state = "registered"; this.emit("registered"); }
    async unregister(){ this.state = "unregistered"; this.emit("unregistered"); }
    updateToken(t){ this.token = t; }
    async connect(o){ const c = new FakeCall({}, {}); c.connectParams = o.params; this.connects.push(c); return c; }
    destroy(){ this.state = "destroyed"; }
  }
  FakeDevice.instances = [];
  FakeDevice.isSupported = true;
  window.Twilio = { Device: FakeDevice, FakeCall };
`;

interface Boot {
  w: any;
  d: Document;
  s: ReturnType<typeof store>;
  api: { path: string; method: string; body: any }[];
  rpc: { name: string; args: any }[];
  mic: { asked: number };
}

const opened: any[] = [];
afterEach(() => { while (opened.length) opened.pop().close(); });

function boot(o: { calling?: boolean; role?: "owner" | "viewer"; settings?: Record<string, unknown>; api?: (path: string, init: any) => { status?: number; body: any } | undefined } = {}): Boot {
  const s = store(o.settings);
  if (o.role === "viewer") { s.workspace_members[0].user_id = U.viewer; s.workspace_members[1].user_id = U.owner; s.workspace_members[0].role = "viewer"; s.workspace_members[1].role = "owner"; }
  const user = o.role === "viewer" ? { id: U.viewer, email: "viewer@x.co" } : { id: U.owner, email: "owner@x.co" };
  const apiCalls: Boot["api"] = [];
  const rpcCalls: Boot["rpc"] = [];
  const mic = { asked: 0 };
  let tokenN = 0;
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {}); // e.g. "navigation to tel: not implemented"
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://crm.example/", virtualConsole: vc,
    beforeParse(w: any) {
      w.Element.prototype.scrollIntoView = function () {};
      w.AudioContext = undefined;
      w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      w.RTCPeerConnection = function () {};
      Object.defineProperty(w.navigator, "mediaDevices", {
        value: { getUserMedia: async () => { mic.asked++; return { getTracks: () => [{ stop() {} }] }; } },
        configurable: true,
      });
      if (o.calling) w.eval(fakeTwilioSource);
      w.fetch = async (u: string, init: any = {}) => {
        const p = u.replace(/^\/api/, "");
        apiCalls.push({ path: p, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
        const custom = o.api?.(p, init);
        let res: { status?: number; body: any } = custom || { body: { success: true } };
        if (!custom) {
          if (p === "/config") res = { body: { features: { gmail: false, outlook: false, calling: !!o.calling, notifications: false } } };
          if (p === "/voice/token") {
            tokenN++;
            const pref = s.user_preferences.find((x: any) => x.user_id === user.id);
            res = { body: { token: "tok-" + tokenN, identity: "crm_x", incoming: !pref || pref.calls_receive_inbound !== false, ttl: 900, expiresAt: new Date(Date.now() + 900_000).toISOString() } };
          }
          if (p === "/voice/setup") res = { body: { configured: !!o.calling, missing: o.calling ? [] : ["TWILIO_ACCOUNT_SID"], callerId: o.calling ? "+14155550100" : null } };
        }
        const status = res.status ?? 200;
        return { ok: status < 400, status, json: async () => res.body };
      };
      w.BRANDIGADE_CONFIG = { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" };
      w.supabase = {
        createClient: () => {
          const client = w.createDemoClient({ store: s, user });
          delete client.api; // real /api paths, answered by the fetch above
          client.auth.getSession = async () => ({ data: { session: { user, access_token: "t" } } });
          const rpc = client.rpc;
          client.rpc = async (name: string, args: any) => {
            rpcCalls.push({ name, args });
            if (name === "set_call_disposition") {
              const c = s.calls.find((x: any) => x.id === args.p_call);
              if (!c) return { data: null, error: { code: "42501", message: "Not allowed" } };
              Object.assign(c, { disposition: args.p_disposition || null, notes: args.p_notes || null });
              return { data: null, error: null };
            }
            return rpc(name, args);
          };
          return client;
        },
      };
    },
  });
  opened.push(dom.window);
  return { w: dom.window, d: dom.window.document, s, api: apiCalls, rpc: rpcCalls, mic };
}

async function until(fn: () => unknown, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + fn.toString());
    await new Promise((r) => setTimeout(r, 20));
  }
}
const ready = (b: Boot) => until(() => b.d.getElementById("auth-screen")!.classList.contains("hidden") && b.w.eval("typeof currentWorkspace !== 'undefined' && !!currentWorkspace"));
const nav = (b: Boot, tab: string) => (b.d.querySelector(`.nav-item[data-tab="${tab}"]`) as HTMLElement).click();
const row = (b: Boot, id: string) => b.d.querySelector(`#contacts-tbody tr[data-id="${id}"]`)!;
const visible = (el: Element | null) => !!el && !el.classList.contains("hidden");
const device = (b: Boot) => b.w.Twilio.Device.instances[b.w.Twilio.Device.instances.length - 1];

describe("dialer UI with calling set up", () => {
  it("registers the browser phone, then calls a lead from the contacts table", async () => {
    const b = boot({ calling: true });
    await ready(b);
    await until(() => device(b) && device(b).state === "registered");
    expect(b.api.filter((c) => c.path === "/voice/token")).toHaveLength(1);
    expect(b.api.find((c) => c.path === "/voice/token")!.method).toBe("POST");
    expect(b.mic.asked).toBe(0); // no microphone prompt on page load

    nav(b, "contacts");
    expect(row(b, IDS.nophone).querySelector(".dialer-call-btn")).toBeNull();
    const btn = row(b, IDS.maya).querySelector("button.dialer-call-btn") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(b.d.getElementById("record-modal-overlay")!.classList.contains("hidden")).toBe(true); // the row didn't open
    const bar = await until(() => b.d.getElementById("dialer-bar"));
    expect(bar.querySelector(".dialer-name")!.textContent).toBe("Maya Rivera");
    const call = await until(() => device(b).connects[0]);
    expect(b.mic.asked).toBe(1);
    expect(call.connectParams).toEqual({ contactId: IDS.maya });

    call.emit("ringing");
    expect(bar.querySelector(".dialer-state")!.textContent).toBe("Ringing…");
    expect((bar.querySelector(".dialer-mute") as HTMLButtonElement).disabled).toBe(true);
    call.parameters.CallSid = CALL_SID;
    call.emit("accept", call);
    expect(bar.querySelector(".dialer-state")!.textContent).toBe("0:00");
    (bar.querySelector(".dialer-mute") as HTMLButtonElement).click();
    expect(call.muted).toBe(true);
    expect(bar.querySelector(".dialer-mute")!.textContent).toContain("Unmute");
    (bar.querySelector(".dialer-keypad-btn") as HTMLButtonElement).click();
    expect(visible(bar.querySelector(".dialer-keypad"))).toBe(true);
    (bar.querySelector('.dialer-key[data-key="5"]') as HTMLButtonElement).click();
    b.d.dispatchEvent(new b.w.KeyboardEvent("keydown", { key: "#", bubbles: true }));
    expect(call.digits).toEqual(["5", "#"]);

    // The server created the calls row; hanging up asks for the outcome.
    b.s.calls.push({ id: IDS.call, workspace_id: IDS.ws, provider_call_sid: CALL_SID, direction: "outbound", contact_id: IDS.maya, status: "completed", duration_seconds: 63 });
    (bar.querySelector(".dialer-hangup") as HTMLButtonElement).click();
    expect(bar.querySelector(".dialer-state")!.textContent).toContain("Call ended");
    const modal = await until(() => (visible(b.d.getElementById("dialer-disposition")) ? b.d.getElementById("dialer-disposition") : null));
    await until(() => modal!.querySelector(".dialer-modal-sub")!.textContent!.includes("1m 03s"));
    const outcome = modal!.querySelector("#dialer-disp-outcome") as HTMLSelectElement;
    expect(outcome.value).toBe("connected");
    expect([...outcome.options].map((x) => x.value)).toEqual(["", "connected", "left_voicemail", "no_answer", "busy", "wrong_number", "not_interested", "callback_requested", "other"]);
    (modal!.querySelector("#dialer-disp-notes") as HTMLTextAreaElement).value = "Wants a quote <b>Friday</b>";
    (modal!.querySelector("[data-save]") as HTMLButtonElement).click();
    await until(() => !visible(modal));
    expect(b.rpc.find((r) => r.name === "set_call_disposition")!.args).toEqual({ p_call: IDS.call, p_disposition: "connected", p_notes: "Wants a quote <b>Friday</b>" });
    expect(b.s.calls[0]).toMatchObject({ disposition: "connected" });
  });

  it("calls from the record header, deals and tasks, and passes their ids", async () => {
    const b = boot({ calling: true });
    await ready(b);
    b.w.eval(`openRecordModal("deal", "${IDS.deal}")`);
    const dealBtn = b.d.querySelector("#rm-actions .dialer-call-btn") as HTMLElement;
    expect(dealBtn.textContent).toBe("Call Maya");
    b.w.eval(`openRecordModal("company", "${IDS.co}")`);
    expect(b.d.querySelector("#rm-actions .dialer-call-btn")).toBeTruthy();
    b.w.eval(`openRecordModal("contact", "${IDS.nophone}")`);
    expect(b.d.querySelector("#rm-actions .dialer-call-btn")).toBeNull(); // no number anywhere
    b.w.eval(`openRecordModal("deal", "${IDS.deal}")`);
    (b.d.querySelector("#rm-actions .dialer-call-btn") as HTMLElement).click();
    const call = await until(() => device(b) && device(b).connects[0]);
    expect(call.connectParams).toEqual({ contactId: IDS.maya, dealId: IDS.deal });
  });

  it("shows an incoming call with the lead's details, and logs the outcome after it", async () => {
    const b = boot({ calling: true, settings: { callRecording: "on" } });
    await ready(b);
    await until(() => device(b) && device(b).state === "registered");
    const incoming = new b.w.Twilio.FakeCall({ From: "+14155550143", CallSid: "CA" + "2".repeat(32) }, { callId: IDS.call, contactId: IDS.maya, recording: "on" });
    device(b).emit("incoming", incoming);
    const panel = b.d.getElementById("dialer-incoming")!;
    expect(visible(panel)).toBe(true);
    const text = panel.textContent!;
    for (const part of ["Maya Rivera", "+14155550143", "Cedar & Crumb", "Customer", "Wholesale rebrand", "$25,000", "Recording"]) expect(text).toContain(part);
    expect(text).toContain("Last activity");
    (panel.querySelector('[data-act="accept"]') as HTMLButtonElement).click();
    await until(() => incoming.accepted);
    expect(visible(panel)).toBe(false);
    const bar = b.d.getElementById("dialer-bar")!;
    expect(bar.querySelector(".dialer-name")!.textContent).toBe("Incoming · Maya Rivera");
    expect(visible(bar.querySelector(".dialer-rec"))).toBe(true);
    b.s.calls.push({ id: IDS.call, workspace_id: IDS.ws, provider_call_sid: "CA" + "3".repeat(32), direction: "inbound", contact_id: IDS.maya, status: "completed" });
    incoming.disconnect();
    const modal = await until(() => (visible(b.d.getElementById("dialer-disposition")) ? b.d.getElementById("dialer-disposition") : null));
    await until(() => modal!.querySelector(".dialer-modal-sub")!.textContent!.startsWith("Call from Maya Rivera"));
  });

  it("handles unknown callers, declining and calls that stop ringing", async () => {
    const b = boot({ calling: true });
    await ready(b);
    await until(() => device(b) && device(b).state === "registered");
    const unknown = new b.w.Twilio.FakeCall({ From: "+12025550173" }, { callId: IDS.call });
    device(b).emit("incoming", unknown);
    const panel = b.d.getElementById("dialer-incoming")!;
    expect(panel.textContent).toContain("Unknown caller");
    expect(panel.textContent).toContain("isn't saved on any lead");
    expect(panel.querySelector('[data-act="add"]')).toBeTruthy();
    (panel.querySelector('[data-act="decline"]') as HTMLButtonElement).click();
    expect(unknown.rejected).toBe(true);
    expect(visible(panel)).toBe(false);

    const gone = new b.w.Twilio.FakeCall({ From: "+14155550143" }, { callId: IDS.call, contactId: IDS.maya });
    device(b).emit("incoming", gone);
    expect(visible(panel)).toBe(true);
    gone.emit("cancel");
    expect(visible(panel)).toBe(false);
    expect(b.d.getElementById("toast-container")!.textContent).toContain("Missed call");
  });

  it("plays recordings through a short-lived link, with clear errors", async () => {
    const responses: Record<string, { status: number; body: any }> = {
      ok: { status: 200, body: { url: "https://x.supabase.co/storage/v1/object/sign/call-recordings/a.mp3?token=1", expiresIn: 300 } },
      denied: { status: 403, body: { error: "You aren't allowed to play call recordings. The CRM owner decides who can (Team page).", code: "forbidden" } },
      missing: { status: 404, body: { error: "This recording isn't available yet.", code: "not_found" } },
    };
    const b = boot({ calling: true, api: (p) => (p.startsWith("/voice/recordings/") ? responses[p.split("/").pop()!] : undefined) });
    await ready(b);
    const box = b.d.createElement("div");
    b.d.body.appendChild(box);
    await b.w.DialerUI.playRecording("ok", box);
    const audio = box.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toContain("/storage/v1/object/sign/");
    expect(audio.controls).toBe(true);
    await b.w.DialerUI.playRecording("ok", box); // toggles closed
    expect(box.querySelector("audio")).toBeNull();
    await b.w.DialerUI.playRecording("denied", box);
    expect(box.textContent).toContain("aren't allowed");
    box.innerHTML = "";
    await b.w.DialerUI.playRecording("missing", box);
    expect(box.textContent).toContain("isn't available yet");
  });

  it("profile: turning incoming calls off saves the preference and stops ringing this browser", async () => {
    const b = boot({ calling: true });
    await ready(b);
    await until(() => device(b) && device(b).state === "registered");
    nav(b, "profile");
    const panel = b.d.getElementById("dialer-profile-panel")!;
    expect(panel.textContent).toContain("Ready: calls ring in this browser");
    const sw = panel.querySelector("#dialer-receive-inbound") as HTMLInputElement;
    expect(sw.checked).toBe(true);
    sw.checked = false;
    sw.dispatchEvent(new b.w.Event("change"));
    await until(() => device(b).state === "unregistered");
    expect(b.s.user_preferences).toEqual([expect.objectContaining({ user_id: U.owner, calls_receive_inbound: false })]);
    expect(device(b).token).toBe("tok-2"); // refreshed without the incoming grant
    await until(() => panel.textContent!.includes("not receiving calls"));
  });

  it("team: the owner's calling settings, drawn once and saved to the workspace", async () => {
    const b = boot({ calling: true });
    await ready(b);
    nav(b, "team");
    b.w.eval("renderAll(); renderAll();");
    expect(b.d.querySelectorAll("#dialer-team-panel")).toHaveLength(1);
    const panel = b.d.getElementById("dialer-team-panel")!;
    await until(() => panel.textContent!.includes("+14155550100"));
    const rec = panel.querySelector("#dialer-rec-switch") as HTMLInputElement;
    rec.checked = true;
    rec.dispatchEvent(new b.w.Event("change"));
    await until(() => visible(b.d.getElementById("confirm-overlay")));
    expect(b.d.getElementById("confirm-message")!.textContent).toContain("consent");
    (b.d.getElementById("confirm-ok") as HTMLButtonElement).click();
    await until(() => b.s.workspaces[0].settings.callRecording === "on");
    const ann = panel.querySelector("#dialer-rec-announcement") as HTMLTextAreaElement;
    ann.value = "  Brandigade records calls  for training. ";
    ann.dispatchEvent(new b.w.Event("change"));
    const access = panel.querySelector("#dialer-rec-access") as HTMLSelectElement;
    access.value = "owner";
    access.dispatchEvent(new b.w.Event("change"));
    const country = panel.querySelector("#dialer-country") as HTMLSelectElement;
    country.value = "GB";
    country.dispatchEvent(new b.w.Event("change"));
    await until(() => b.s.workspaces[0].settings.defaultCountry === "GB");
    expect(b.s.workspaces[0].settings).toMatchObject({ callRecording: "on", recordingAnnouncement: "Brandigade records calls for training.", recordingAccess: "owner", defaultCountry: "GB" });
    const ids = [...b.d.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("dialer UI without calling set up", () => {
  it("Call is a tel: link that opens the phone, then a prompt logs the call on the timeline", async () => {
    const b = boot({ calling: false });
    await ready(b);
    nav(b, "contacts");
    const link = row(b, IDS.maya).querySelector("a.dialer-call-btn") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("tel:+14155550143");
    expect(b.w.Twilio).toBeUndefined(); // the SDK is never loaded
    link.click();
    const modal = await until(() => (visible(b.d.getElementById("dialer-log")) ? b.d.getElementById("dialer-log") : null));
    expect(modal!.textContent).toContain("Automatic call logging and recording start once calling is set up");
    (modal!.querySelector("#dialer-log-outcome") as HTMLSelectElement).value = "no_answer";
    (modal!.querySelector("#dialer-log-notes") as HTMLTextAreaElement).value = "Rang out";
    (modal!.querySelector("[data-save]") as HTMLButtonElement).click();
    await until(() => b.s.activities.some((a: any) => a.type === "call"));
    expect(b.s.activities.find((a: any) => a.type === "call")).toMatchObject({ source: "manual", subject: "Call with Maya Rivera · No answer", body: "Rang out", contact_id: IDS.maya, company_id: IDS.co });
    expect(b.api.some((c) => c.path === "/voice/token")).toBe(false);
    nav(b, "profile");
    expect(b.d.getElementById("dialer-profile-panel")!.textContent).toContain("Calling isn't set up yet");
    nav(b, "team");
    await until(() => b.d.getElementById("dialer-team-panel")!.textContent!.includes("TWILIO_ACCOUNT_SID"));
  });

  it("viewers get a plain tel: link and no log prompt", async () => {
    const b = boot({ calling: true, role: "viewer" });
    await ready(b);
    nav(b, "contacts");
    const link = row(b, IDS.maya).querySelector("a.dialer-call-btn") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.dataset.alwaysEnabled).toBe("true");
    link.click();
    await new Promise((r) => setTimeout(r, 500));
    expect(b.d.getElementById("dialer-log")).toBeNull();
    expect(b.w.Twilio.Device.instances).toHaveLength(0); // viewers never get a browser phone
    expect(b.api.some((c) => c.path === "/voice/token")).toBe(false);
    nav(b, "team");
    expect(b.d.getElementById("dialer-team-panel")).toBeNull();
  });

  it("demo mode says recordings aren't available", async () => {
    const b = boot({ calling: false });
    await ready(b);
    b.w.eval("DEMO = true; sb.api = async () => { throw Object.assign(new Error('demo'), { status: 501 }); };");
    const box = b.d.createElement("div");
    await b.w.DialerUI.playRecording(IDS.call, box);
    expect(box.textContent).toContain("aren't available in the demo");
  });
});
