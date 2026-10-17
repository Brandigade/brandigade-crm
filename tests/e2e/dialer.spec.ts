import { expect, test, type Page } from "@playwright/test";
import { admin, gotoTab, loginToCrm } from "./helpers.js";

// Calling against the real front end and the LOCAL Supabase stack. There is no
// Twilio account, so:
//   * without TWILIO_* on the dev server, the tel: fallback and manual logging are tested;
//   * with fake TWILIO_* values on the dev server (calling "set up"), a stand-in
//     for the Twilio Voice SDK is injected before the page loads, so the call
//     bar, incoming panel and outcome prompt run for real without any call.
// Optional: SHOTS_DIR=<folder> saves screenshots of the calling UI.
const prefix = `CALLTEST ${Date.now().toString(36)}`;
const shots = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

// A stand-in for the Twilio Voice SDK, installed before the page's own scripts.
const FAKE_SDK = `
  class Emitter { constructor(){ this.h = {}; } on(e, f){ (this.h[e] = this.h[e] || []).push(f); return this; } emit(e, ...a){ (this.h[e] || []).forEach(f => f(...a)); } }
  class FakeCall extends Emitter {
    constructor(p, c){ super(); this.parameters = p || {}; this.customParameters = new Map(Object.entries(c || {})); this.muted = false; this.digits = []; }
    mute(m){ this.muted = m; this.emit("mute", m, this); }
    isMuted(){ return this.muted; }
    sendDigits(d){ this.digits.push(d); }
    disconnect(){ this.emit("disconnect", this); }
    accept(){ this.emit("accept", this); }
    reject(){ this.emit("reject"); }
  }
  class FakeDevice extends Emitter {
    constructor(token){ super(); this.token = token; this.state = "unregistered"; this.connects = []; FakeDevice.instances.push(this); }
    async register(){ this.state = "registered"; this.emit("registered"); }
    async unregister(){ this.state = "unregistered"; this.emit("unregistered"); }
    updateToken(t){ this.token = t; }
    async connect(o){ const c = new FakeCall({}, {}); c.connectParams = o.params; this.connects.push(c); return c; }
    destroy(){ this.state = "destroyed"; }
  }
  FakeDevice.instances = [];
  FakeDevice.isSupported = true;
  window.Twilio = { Device: FakeDevice, FakeCall };
  // No microphone prompt in headless Chromium.
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop(){} }] });
`;
const TEL_GUARD = `window.addEventListener("click", (e) => { if (e.target.closest && e.target.closest('a[href^="tel:"]')) e.preventDefault(); }, true);`;

async function callingConfigured(page: Page) {
  const res = await page.request.get("/api/config");
  return !!(await res.json()).features?.calling;
}

test.describe("calling", () => {
  let contactId = "";
  const callIds: string[] = [];

  test.beforeAll(async () => {
    const { data: ws } = await admin().from("workspaces").select("id").limit(1).single();
    const digits = String(100 + Math.floor(Math.random() * 899));
    const { data, error } = await admin()
      .from("contacts")
      .insert({ workspace_id: ws!.id, first_name: `${prefix} Lea`, last_name: "Caller", phone: `+44 20 7946 0${digits}` })
      .select("id")
      .single();
    if (error) throw error;
    contactId = data!.id;
  });

  test.afterAll(async () => {
    const db = admin();
    if (callIds.length) {
      await db.from("activities").delete().in("call_id", callIds);
      await db.from("calls").delete().in("id", callIds);
    }
    await db.from("activities").delete().eq("contact_id", contactId);
    await db.from("contacts").delete().eq("id", contactId);
  });

  test("without Twilio: Call opens the phone's dialer and the call can be logged by hand", async ({ page }) => {
    test.skip(await callingConfigured(page), "the dev server has calling set up");
    // Keep the browser from trying to open a tel: handler.
    await page.addInitScript({ content: TEL_GUARD });
    await loginToCrm(page, "editor");
    await gotoTab(page, "contacts");
    await page.locator("#contacts-search").fill(prefix);
    const link = page.locator(`#contacts-tbody tr[data-id="${contactId}"] a.dialer-call-btn`);
    await expect(link).toHaveAttribute("href", /^tel:\+442079460\d{3}$/);
    await link.click();
    const prompt = page.locator("#dialer-log");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("Automatic call logging and recording start once calling is set up");
    await shot(page, "fallback-log-prompt");
    await prompt.locator("#dialer-log-outcome").selectOption("callback_requested");
    await prompt.locator("#dialer-log-notes").fill("Call back Tuesday");
    await prompt.getByRole("button", { name: "Log call" }).click();
    await expect(prompt).toBeHidden();
    await expect.poll(async () => (await admin().from("activities").select("type, source, subject, body").eq("contact_id", contactId)).data).toEqual([
      { type: "call", source: "manual", subject: `Call with ${prefix} Lea Caller · Call back`, body: "Call back Tuesday" },
    ]);
    await page.locator(`#contacts-tbody tr[data-id="${contactId}"]`).click();
    await expect(page.locator("#rm-timeline .tl-item", { hasText: "· Call back" })).toBeVisible();
    await page.locator("#rm-close").click();

    await gotoTab(page, "profile");
    await expect(page.locator("#dialer-profile-panel")).toContainText("Calling isn't set up yet");
    await shot(page, "fallback-profile");
  });

  test("with calling set up: call bar, outcome, incoming call panel (fake Voice SDK)", async ({ page }) => {
    test.skip(!(await callingConfigured(page)), "start the dev server with (fake) TWILIO_* values to run this");
    await page.addInitScript({ content: FAKE_SDK });
    await loginToCrm(page, "editor");
    await expect.poll(() => page.evaluate(() => (globalThis as any).Twilio.Device.instances[0]?.state)).toBe("registered");
    const myId = await page.evaluate(() => (globalThis as any).eval("currentUser.id"));

    // Outgoing.
    await gotoTab(page, "contacts");
    await page.locator("#contacts-search").fill(prefix);
    await page.locator(`#contacts-tbody tr[data-id="${contactId}"] button.dialer-call-btn`).click();
    const bar = page.locator("#dialer-bar");
    await expect(bar).toBeVisible();
    await expect(bar.locator(".dialer-name")).toHaveText(`${prefix} Lea Caller`);
    const sid = "CA" + Date.now().toString(16).padStart(32, "0");
    const { data: ws } = await admin().from("workspaces").select("id").limit(1).single();
    const { data: row } = await admin()
      .from("calls")
      .insert({ workspace_id: ws!.id, provider_call_sid: sid, direction: "outbound", status: "in-progress", user_id: myId, contact_id: contactId, to_number: "+442079460000" })
      .select("id")
      .single();
    callIds.push(row!.id);
    await page.evaluate((s) => {
      const call = (globalThis as any).Twilio.Device.instances[0].connects[0];
      call.emit("ringing");
      call.parameters.CallSid = s;
      call.emit("accept", call);
    }, sid);
    await expect(bar.locator(".dialer-state")).toHaveText(/^0:0\d$/);
    await shot(page, "call-bar");
    await page.setViewportSize({ width: 390, height: 800 });
    await shot(page, "call-bar-phone");
    await page.setViewportSize({ width: 1360, height: 900 });
    await bar.getByRole("button", { name: "Hang up" }).click();
    const outcome = page.locator("#dialer-disposition");
    await expect(outcome).toBeVisible();
    await expect(outcome.locator("#dialer-disp-outcome")).toHaveValue("connected");
    await shot(page, "outcome");
    await outcome.locator("#dialer-disp-notes").fill("Sending the proposal");
    await outcome.getByRole("button", { name: "Save outcome" }).click();
    await expect(outcome).toBeHidden();
    await expect.poll(async () => (await admin().from("calls").select("disposition, notes").eq("id", row!.id).single()).data).toEqual({ disposition: "connected", notes: "Sending the proposal" });

    // Incoming, from the same lead.
    const { data: inbound } = await admin()
      .from("calls")
      .insert({ workspace_id: ws!.id, provider_call_sid: sid.replace(/^CA0/, "CA1"), direction: "inbound", status: "ringing", contact_id: contactId, from_number: "+442079460000" })
      .select("id")
      .single();
    callIds.push(inbound!.id);
    await page.evaluate(([callId, cid]) => {
      const T = (globalThis as any).Twilio;
      (globalThis as any).__incoming = new T.FakeCall({ From: "+442079460000" }, { callId, contactId: cid, recording: "off" });
      T.Device.instances[0].emit("incoming", (globalThis as any).__incoming);
    }, [inbound!.id, contactId]);
    const panel = page.locator("#dialer-incoming");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(`${prefix} Lea Caller`);
    await expect(panel).toContainText("Last activity");
    await shot(page, "incoming");
    await page.setViewportSize({ width: 390, height: 800 });
    await shot(page, "incoming-phone");
    await page.setViewportSize({ width: 1360, height: 900 });
    await panel.getByRole("button", { name: "Accept" }).click();
    await expect(bar.locator(".dialer-name")).toHaveText(`Incoming · ${prefix} Lea Caller`);
    await page.evaluate(() => (globalThis as any).__incoming.disconnect());
    await expect(outcome).toBeVisible();
    await outcome.getByRole("button", { name: "Skip" }).click();

    // The calls are on the lead's timeline.
    await page.locator(`#contacts-tbody tr[data-id="${contactId}"]`).click();
    await expect(page.locator("#rm-timeline .tl-item", { hasText: "Outgoing call" })).toContainText("Connected");
    await expect(page.locator("#rm-timeline .tl-item", { hasText: "Incoming call" })).toBeVisible();
    await page.locator("#rm-close").click();

    await gotoTab(page, "profile");
    await expect(page.locator("#dialer-profile-panel")).toContainText("Ready: calls ring in this browser");
    await shot(page, "profile-calling");
  });

  test("the owner's calling settings on the Team page @mobile", async ({ page }) => {
    await loginToCrm(page, "owner");
    await gotoTab(page, "team");
    const panel = page.locator("#dialer-team-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Record calls");
    await expect(panel).toContainText("everyone on a call to agree");
    await expect(panel.locator("#dialer-rec-access")).toHaveValue(/owner|editors|all/);
    await panel.scrollIntoViewIfNeeded();
    await shot(page, "team-calling-" + (page.viewportSize()!.width < 600 ? "phone" : "desktop"));
    const width = await page.evaluate(() => { const g = globalThis as any; return g.document.documentElement.scrollWidth - g.innerWidth; });
    expect(width).toBeLessThanOrEqual(1); // nothing sticks out on a phone
  });
});
