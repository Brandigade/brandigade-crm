/* ============================================================
   CALLING (Twilio)
   Owned by the dialer integration. Contract (docs/ARCHITECTURE.md):
     - click-to-call on contacts (hook "contact:row-actions"), the record
       header (hook "record:actions") and the task view (hook "task:actions")
     - call bar, disposition prompt after each call, incoming call panel with
       the matched lead's details, recording playback
     - window.DialerUI = { call({ contactId, taskId, number }), playRecording(callId, container), openDisposition(callId) }
       used by js/timeline.js on call items
   Server routes: /api/voice/* (lib/server/voice/routes.ts)

   How it works
     * Calls run in the browser through the Twilio Voice JavaScript SDK,
       loaded from jsDelivr (pinned version + SRI) only when calling is set up
       and the person is an owner or editor.
     * The browser only says which CRM record to call. The server looks the
       number up on that record, so nobody can dial a number that isn't saved
       on a contact or company.
     * The microphone is requested when the first call starts (or from the
       Profile page's "Test microphone"), never on page load.
     * Without calling set up, Call buttons are tel: links that open the
       device's own dialer, followed by a "Log this call" prompt.
============================================================ */
window.DialerUI = window.DialerUI || {};

(function(){
  const VOICE_SDK_VERSION = "2.18.5";
  const VOICE_SDK_URL = "https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@" + VOICE_SDK_VERSION + "/dist/twilio.min.js";
  const VOICE_SDK_SRI = "sha256-NdPLGyLjCfmIRySoklCuzS3k8VVq17Z6e8XgbHPct0o=";
  const DEFAULT_ANNOUNCEMENT = "This call may be recorded for quality and training purposes.";

  const ICON = {
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    hangup: '<path d="M3.6 14.6l2.1-1.6a1.6 1.6 0 0 0 .6-1.5l-.3-1.6a14.8 14.8 0 0 1 12 0l-.3 1.6a1.6 1.6 0 0 0 .6 1.5l2.1 1.6a1.6 1.6 0 0 0 2.1-.2l.9-1a1.6 1.6 0 0 0 0-2.2C19.7 7.4 16 6 12 6S4.3 7.4 0.6 11.2a1.6 1.6 0 0 0 0 2.2l.9 1a1.6 1.6 0 0 0 2.1.2z"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/>',
    micOff: '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V5a3 3 0 0 0-5.9-.8"/><path d="M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.7 3M12 18v4M8 22h8"/>',
    keypad: '<circle cx="6" cy="5" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="18" cy="5" r="1.4"/><circle cx="6" cy="11" r="1.4"/><circle cx="12" cy="11" r="1.4"/><circle cx="18" cy="11" r="1.4"/><circle cx="6" cy="17" r="1.4"/><circle cx="12" cy="17" r="1.4"/><circle cx="18" cy="17" r="1.4"/><circle cx="12" cy="22" r="1.2"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

  // Everything the dialer knows right now.
  const D = {
    sdkPromise: null,
    devicePromise: null,
    device: null,
    token: null,           // { token, identity, incoming, expiresAt }
    phone: "off",          // off | loading | ready | outgoing | error | unsupported
    phoneError: "",
    receiveInbound: null,  // null until loaded; no preferences row = true
    prefLoading: null,
    micOk: false,
    active: null,          // the call in progress (see newSession)
    incoming: null,        // a ringing incoming call: { call, callId, contactId, from, recording }
    setup: null,           // GET /voice/setup (owner)
    setupError: "",
    setupLoading: false,
  };

  /* ---------- Small helpers ---------- */
  const canCall = () => currentRole === "owner" || currentRole === "editor";
  const isDemo = () => typeof DEMO !== "undefined" && DEMO;
  const callingLive = () => !!(appFeatures && appFeatures.calling) && canCall() && !isDemo();
  const recordingOn = () => !!(state.settings && state.settings.callRecording === "on");
  const dispositions = () => (typeof CALL_DISPOSITIONS !== "undefined" ? CALL_DISPOSITIONS : {
    connected:"Connected", left_voicemail:"Left voicemail", no_answer:"No answer", busy:"Busy",
    wrong_number:"Wrong number", not_interested:"Not interested", callback_requested:"Call back", other:"Other",
  });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const telHref = (n) => "tel:" + String(n || "").replace(/[^0-9+*#,;]/g, "");
  const firstName = (c) => (c && (c.firstName || contactName(c))) || "";
  // A call that just ended still shows "Call ended" for a moment; it doesn't block the next one.
  const onCall = () => !!(D.active && !D.active.finished);
  function el(tag, cls, html){
    const e = document.createElement(tag);
    if(cls) e.className = cls;
    if(html != null) e.innerHTML = html;
    return e;
  }
  function fmtClock(sec){
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
  }

  /* ---------- Who a call is for ---------- */
  // Resolves { contactId, companyId, dealId, taskId } to what the UI shows and
  // where a hand-logged call goes. The server resolves the number itself.
  function describeTarget(opts){
    opts = opts || {};
    let task = opts.taskId ? findRecord("board", opts.taskId) : null;
    let deal = opts.dealId ? dealById(opts.dealId) : (task && task.dealId ? dealById(task.dealId) : null);
    let contact = opts.contactId ? contactById(opts.contactId) : null;
    if(!contact && task) contact = taskLead(task);
    if(!contact && deal && deal.contactId && !opts.companyId) contact = contactById(deal.contactId);
    if(contact){
      const co = companyById(contact.companyId);
      const viaCompany = !contact.phone && co && co.phone;
      const number = opts.number || contact.phone || (co && co.phone) || "";
      const logToDeal = deal && deal.contactId === contact.id;
      return {
        contactId: contact.id, companyId: null, dealId: deal ? deal.id : null, taskId: task ? task.id : null,
        number, numberParam: opts.number || null,
        name: contactName(contact), sub: [co ? co.name : "", viaCompany && !opts.number ? "company line" : ""].filter(Boolean).join(" · "),
        logKind: logToDeal ? "deal" : "contact", logId: logToDeal ? deal.id : contact.id,
      };
    }
    const company = opts.companyId ? companyById(opts.companyId) : null;
    if(company){
      return { contactId: null, companyId: company.id, dealId: null, taskId: null, number: opts.number || company.phone || "",
        numberParam: opts.number || null, name: company.name, sub: "Main number", logKind: "company", logId: company.id };
    }
    return null;
  }

  /* ---------- Call buttons ---------- */
  // Live calling: a button that calls through the CRM. Otherwise a tel: link
  // that opens the device's dialer, then asks to log the call (never a dead button).
  function callButton(target, opts){
    opts = opts || {};
    const label = opts.label || "Call";
    const compact = !!opts.compact;
    const html = svg("phone") + (compact ? "" : `<span>${escapeHtml(label)}</span>`);
    const cls = "btn btn-sm btn-icon dialer-call-btn" + (compact ? " dialer-call-compact" : "");
    if(callingLive() && D.phone !== "unsupported"){
      const b = el("button", cls, html);
      b.type = "button";
      b.title = `Call ${target.name} from the CRM`;
      b.setAttribute("aria-label", `Call ${target.name}`);
      b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); DialerUI.call(target); });
      return b;
    }
    const a = el("a", cls, html);
    a.href = telHref(target.number);
    a.dataset.alwaysEnabled = "true";
    a.title = `Call ${target.number} with your phone`;
    a.setAttribute("aria-label", `Call ${target.name} with your phone`);
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      if(canCall()) setTimeout(() => openLogPrompt(target), 400);
    });
    return a;
  }

  CRMHooks.on("contact:row-actions", (c) => {
    const t = describeTarget({ contactId: c.id });
    return t && t.number ? callButton(t, { compact: true }) : null;
  });
  CRMHooks.on("record:actions", (kind, record) => {
    if(!record) return null;
    let t = null, label = "Call";
    if(kind === "contact"){ t = describeTarget({ contactId: record.id }); if(t && !record.phone) label = "Call company"; }
    else if(kind === "company") t = describeTarget({ companyId: record.id });
    else if(kind === "deal" && record.contactId){
      t = describeTarget({ contactId: record.contactId, dealId: record.id });
      if(t) label = "Call " + firstName(contactById(record.contactId));
    }
    return t && t.number ? callButton(t, { label }) : null;
  });
  CRMHooks.on("task:actions", (task, lead) => {
    if(!task || !lead) return null;
    const t = describeTarget({ contactId: lead.id, taskId: task.id });
    return t && t.number ? callButton(t, { label: "Call " + firstName(lead) }) : null;
  });

  /* ---------- The Twilio Voice SDK ---------- */
  function loadSdk(){
    if(window.Twilio && window.Twilio.Device) return Promise.resolve(window.Twilio);
    if(D.sdkPromise) return D.sdkPromise;
    D.sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = VOICE_SDK_URL;
      s.integrity = VOICE_SDK_SRI;
      s.crossOrigin = "anonymous";
      s.async = true;
      s.onload = () => (window.Twilio && window.Twilio.Device ? resolve(window.Twilio) : reject(new Error("The calling component didn't start.")));
      s.onerror = () => reject(new Error("Couldn't load the calling component from cdn.jsdelivr.net. Check your connection or ad blocker, then try again."));
      document.head.appendChild(s);
    }).catch((e) => { D.sdkPromise = null; throw e; });
    return D.sdkPromise;
  }

  async function fetchToken(){
    const t = await api("/voice/token", { method:"POST", body:{} });
    D.token = t;
    return t;
  }

  function setPhone(status, error){
    D.phone = status;
    D.phoneError = error || "";
    updateProfilePanel();
  }

  // Twilio error codes -> what to tell the person.
  function friendlyError(err){
    const code = err && (err.code || (err.originalError && err.originalError.code));
    const name = err && err.name;
    if(code === 31401 || code === 31402 || code === 31208 || name === "NotAllowedError" || (err && err.micBlocked)){
      return "Microphone access is blocked. Allow the microphone for this site (the icon in the address bar), then try again.";
    }
    if(err && err.noMic) return "No microphone was found. Plug one in or check your sound settings.";
    if([20101, 20103, 20104, 20157, 31202, 31204, 31205].includes(code)) return "Your calling session expired. Reconnecting; try again in a moment.";
    if([31000, 31003, 31005, 31009, 53000, 53001, 53405].includes(code)) return "Couldn't reach Twilio. Check your internet connection and try again.";
    if(code === 31486) return "The line is busy.";
    if(code === 31480) return "The person isn't available right now.";
    if(err && err.status === 503) return "Calling isn't set up on the server yet.";
    if(err && err.status === 501) return "Calling isn't available in the demo.";
    if(err && err.status === 403) return err.message || "You're not allowed to make calls.";
    return (err && err.message) || "Something went wrong with the call.";
  }

  function ensureDevice(){
    if(D.device) return Promise.resolve(D.device);
    if(D.devicePromise) return D.devicePromise;
    if(!callingLive()) return Promise.reject(new Error(isDemo() ? "Calling isn't available in the demo." : "Calling isn't set up yet."));
    setPhone("loading");
    D.devicePromise = (async () => {
      if(!window.RTCPeerConnection || !navigator.mediaDevices){
        setPhone("unsupported");
        throw new Error("This browser can't make calls. Use a current version of Chrome, Edge, Firefox or Safari.");
      }
      const Twilio = await loadSdk();
      if(Twilio.Device.isSupported === false){
        setPhone("unsupported");
        throw new Error("This browser can't make calls. Use a current version of Chrome, Edge, Firefox or Safari.");
      }
      const t = await fetchToken();
      const device = new Twilio.Device(t.token, {
        closeProtection: "A call is in progress. Leaving this page will end it.",
        codecPreferences: ["opus", "pcmu"],
        appName: "brandigade-crm",
        logLevel: "error",
        tokenRefreshMs: 60000,
      });
      wireDevice(device);
      D.device = device;
      setPhone("outgoing");
      return device;
    })().catch((e) => {
      D.devicePromise = null;
      if(D.phone !== "unsupported") setPhone("error", friendlyError(e));
      throw e;
    });
    return D.devicePromise;
  }

  function wireDevice(device){
    device.on("registering", () => setPhone("loading"));
    device.on("registered", () => setPhone("ready"));
    device.on("unregistered", () => { if(D.device === device && D.phone !== "error") setPhone("outgoing"); });
    device.on("tokenWillExpire", () => { refreshToken().catch(e => console.warn("Calling token refresh failed", e)); });
    device.on("incoming", onIncoming);
    device.on("error", (err) => {
      console.warn("Twilio device error", err && err.code, err && err.message);
      const code = err && err.code;
      if([20101, 20104, 31204, 31205].includes(code)){ refreshToken().catch(() => setPhone("error", friendlyError(err))); return; }
      if(!D.active) setPhone("error", friendlyError(err));
    });
  }

  async function refreshToken(){
    if(!D.device) return;
    const t = await fetchToken();
    D.device.updateToken(t.token);
    await syncRegistration();
  }

  // Ring this browser for incoming calls only while the person wants that.
  async function syncRegistration(){
    const device = D.device;
    if(!device) return;
    const want = !!(D.receiveInbound && D.token && D.token.incoming && canCall());
    try{
      if(want && device.state !== "registered" && device.state !== "registering") await device.register();
      else if(!want && device.state === "registered") await device.unregister();
      if(!want && D.phone !== "error") setPhone("outgoing");
    }catch(e){
      setPhone("error", friendlyError(e));
    }
  }

  function destroyDevice(){
    if(D.device){ try{ D.device.destroy(); }catch(e){} }
    D.device = null; D.devicePromise = null; D.token = null;
    setPhone("off");
  }

  // Asks for the microphone once, right before the first call.
  async function ensureMicrophone(){
    if(D.micOk) return;
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      throw new Error("This browser can't use a microphone on this page. Calls need a secure (https) page in a current browser.");
    }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      stream.getTracks().forEach(t => t.stop());
      D.micOk = true;
    }catch(e){
      if(e && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw Object.assign(new Error("blocked"), { micBlocked:true });
      if(e && (e.name === "NotFoundError" || e.name === "OverconstrainedError")) throw Object.assign(new Error("none"), { noMic:true });
      throw e;
    }
  }

  /* ---------- Placing a call ---------- */
  DialerUI.call = function(opts){
    const target = opts && opts.name && opts.logKind ? opts : describeTarget(opts);
    if(!target){ notify("Can't call", "That record isn't in the CRM anymore."); return; }
    if(!target.number){ notify("No phone number", "Add a phone number to this record first."); return; }
    if(!canCall()){ window.location.href = telHref(target.number); return; }
    if(!callingLive() || D.phone === "unsupported"){
      window.location.href = telHref(target.number);
      setTimeout(() => openLogPrompt(target), 400);
      return;
    }
    startCall(target);
  };

  function newSession(direction, target, extra){
    return Object.assign({
      direction, target, call:null, status:"connecting", startedAt:Date.now(), answeredAt:null, endedAt:null,
      muted:false, keypad:false, callId:null, callSid:null, recording:recordingOn(), error:"", finished:false, accepted:false, timer:null,
    }, extra || {});
  }

  async function startCall(target){
    if(onCall() || D.incoming){ notify("Already on a call", "Finish the current call first."); return; }
    const s = newSession("outbound", target);
    D.active = s;
    renderBar();
    try{
      await ensureMicrophone();
      const device = await ensureDevice();
      if(D.active !== s) return; // hung up while connecting
      if(D.token && Date.parse(D.token.expiresAt) - Date.now() < 60000) await refreshToken();
      const params = {};
      ["contactId", "companyId", "taskId", "dealId"].forEach(k => { if(target[k]) params[k] = target[k]; });
      // A specific number may be asked for, but the server only dials it if it is saved on the record.
      if(target.numberParam) params.number = target.numberParam;
      const call = await device.connect({ params });
      s.call = call;
      wireCall(s, call);
      if(D.active !== s){ try{ call.disconnect(); }catch(e){} }
    }catch(e){
      console.warn("Call failed to start", e);
      failSession(s, friendlyError(e));
    }
  }

  function wireCall(s, call){
    call.on("ringing", () => { if(!s.accepted){ s.status = "ringing"; renderBar(); } });
    call.on("accept", () => {
      s.accepted = true; s.status = "in-call"; s.answeredAt = Date.now();
      s.callSid = (call.parameters && call.parameters.CallSid) || s.callSid;
      startTimer(s); renderBar();
    });
    call.on("reconnecting", () => { s.status = "reconnecting"; renderBar(); });
    call.on("reconnected", () => { s.status = s.accepted ? "in-call" : "ringing"; renderBar(); });
    call.on("mute", (muted) => { s.muted = !!muted; renderBar(); });
    call.on("error", (err) => { s.error = friendlyError(err); renderBar(); });
    ["disconnect", "cancel", "reject"].forEach(ev => call.on(ev, () => finishSession(s)));
  }

  function startTimer(s){
    clearInterval(s.timer);
    s.timer = setInterval(() => { if(D.active === s) updateBarClock(); else clearInterval(s.timer); }, 1000);
  }

  function failSession(s, message){
    if(s.finished) return;
    s.finished = true; s.status = "failed"; s.error = message; s.endedAt = Date.now();
    clearInterval(s.timer);
    renderBar();
    notify("Call didn't go through", message);
    setTimeout(() => { if(D.active === s){ D.active = null; renderBar(); } }, 6000);
  }

  async function finishSession(s){
    if(s.finished) return;
    s.finished = true; s.status = "ended"; s.endedAt = Date.now();
    clearInterval(s.timer);
    if(s.call && s.call.parameters && s.call.parameters.CallSid) s.callSid = s.call.parameters.CallSid;
    renderBar();
    setTimeout(() => { if(D.active === s){ D.active = null; renderBar(); } }, 2500);
    const suggested = s.accepted ? "connected" : "no_answer";
    let callId = s.callId;
    if(!callId && s.callSid) callId = await lookupCallId(s.callSid);
    if(callId) DialerUI.openDisposition(callId, { suggested, session:s });
    else if(s.direction === "outbound") notify("Call ended", "This call wasn't saved in the CRM, so there's no outcome to add.");
  }

  // The calls row for an outgoing call (row level security: any member can read calls).
  async function lookupCallId(callSid){
    for(let i = 0; i < 6; i++){
      try{
        const { data } = await sb.from("calls").select("id").eq("provider_call_sid", callSid).maybeSingle();
        if(data && data.id) return data.id;
      }catch(e){}
      await sleep(700);
    }
    return null;
  }

  /* ---------- Call bar ---------- */
  function barEl(){
    let bar = document.getElementById("dialer-bar");
    if(bar) return bar;
    bar = el("div", "dialer-bar hidden");
    bar.id = "dialer-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Current call");
    bar.innerHTML = `
      <div class="dialer-keypad hidden" role="group" aria-label="Keypad">
        ${["1","2","3","4","5","6","7","8","9","*","0","#"].map(k => `<button type="button" class="dialer-key" data-key="${k}">${k}</button>`).join("")}
      </div>
      <div class="dialer-bar-row">
        <span class="status-dot"></span>
        <div class="dialer-who"><div class="dialer-name"></div><div class="dialer-sub"></div></div>
        <div class="dialer-state" aria-live="polite"></div>
        <span class="tl-pill dialer-rec hidden" title="This call is recorded. The other person hears the announcement first.">Recording</span>
        <div class="dialer-controls">
          <button type="button" class="btn btn-sm btn-icon dialer-mute" aria-pressed="false">${svg("mic")}<span>Mute</span></button>
          <button type="button" class="btn btn-sm btn-icon dialer-keypad-btn" aria-expanded="false">${svg("keypad")}<span>Keypad</span></button>
          <button type="button" class="btn btn-sm btn-danger btn-icon dialer-hangup">${svg("hangup")}<span>Hang up</span></button>
        </div>
      </div>`;
    document.body.appendChild(bar);
    bar.querySelector(".dialer-mute").addEventListener("click", () => {
      const s = D.active;
      if(s && s.call && s.accepted) s.call.mute(!s.call.isMuted());
    });
    bar.querySelector(".dialer-keypad-btn").addEventListener("click", () => {
      const s = D.active; if(!s) return;
      s.keypad = !s.keypad; renderBar();
    });
    bar.querySelector(".dialer-keypad").addEventListener("click", (e) => {
      const k = e.target.closest(".dialer-key");
      if(k) sendDigit(k.dataset.key);
    });
    bar.querySelector(".dialer-hangup").addEventListener("click", hangUp);
    return bar;
  }

  function sendDigit(d){
    const s = D.active;
    if(s && s.call && s.accepted && /^[0-9*#]$/.test(d)){ try{ s.call.sendDigits(d); }catch(e){} }
  }
  document.addEventListener("keydown", (e) => {
    const s = D.active;
    if(!s || !s.keypad || !s.accepted) return;
    if(e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if(/^[0-9*#]$/.test(e.key)) sendDigit(e.key);
  });

  function hangUp(){
    const s = D.active;
    if(!s) return;
    if(s.finished){ D.active = null; renderBar(); return; }
    if(s.call){ try{ s.call.disconnect(); }catch(e){} }
    else { s.finished = true; D.active = null; renderBar(); } // still connecting: nothing to hang up yet
  }

  const STATUS_TEXT = { connecting:"Connecting…", ringing:"Ringing…", reconnecting:"Reconnecting…", ended:"Call ended", failed:"Didn't connect" };
  function updateBarClock(){
    const s = D.active, bar = document.getElementById("dialer-bar");
    if(!s || !bar) return;
    const stateEl = bar.querySelector(".dialer-state");
    if(s.status === "in-call") stateEl.textContent = fmtClock((Date.now() - s.answeredAt) / 1000);
    else if(s.status === "ended" && s.answeredAt) stateEl.textContent = "Call ended · " + fmtClock((s.endedAt - s.answeredAt) / 1000);
    else stateEl.textContent = STATUS_TEXT[s.status] || "";
  }

  function renderBar(){
    const s = D.active;
    const bar = s ? barEl() : document.getElementById("dialer-bar");
    if(!bar) return;
    bar.classList.toggle("hidden", !s);
    document.body.classList.toggle("dialer-on-call", !!s);
    if(!s) return;
    const t = s.target || {};
    bar.querySelector(".dialer-name").textContent = (s.direction === "inbound" ? "Incoming · " : "") + (t.name || "Unknown caller");
    bar.querySelector(".dialer-sub").textContent = s.error || [t.sub, t.number].filter(Boolean).join(" · ");
    bar.querySelector(".dialer-sub").classList.toggle("dialer-error", !!s.error);
    const dot = bar.querySelector(".status-dot");
    dot.className = "status-dot " + (s.status === "in-call" ? "ok" : s.status === "failed" ? "bad" : s.status === "ended" ? "" : "warn");
    bar.querySelector(".dialer-rec").classList.toggle("hidden", !s.recording || s.finished);
    const live = !!(s.call && s.accepted && !s.finished);
    const mute = bar.querySelector(".dialer-mute");
    mute.disabled = !live;
    mute.setAttribute("aria-pressed", s.muted ? "true" : "false");
    mute.classList.toggle("active", s.muted);
    mute.innerHTML = svg(s.muted ? "micOff" : "mic") + `<span>${s.muted ? "Unmute" : "Mute"}</span>`;
    const kp = bar.querySelector(".dialer-keypad-btn");
    kp.disabled = !live;
    kp.setAttribute("aria-expanded", s.keypad && live ? "true" : "false");
    bar.querySelector(".dialer-keypad").classList.toggle("hidden", !(s.keypad && live));
    const hang = bar.querySelector(".dialer-hangup");
    hang.innerHTML = svg("hangup") + `<span>${s.finished ? "Close" : s.status === "connecting" ? "Cancel" : "Hang up"}</span>`;
    updateBarClock();
  }

  /* ---------- Incoming calls ---------- */
  function onIncoming(call){
    const params = call.customParameters || new Map();
    const get = (k) => (typeof params.get === "function" ? params.get(k) : params[k]) || "";
    const info = {
      call, callId: get("callId"), contactId: get("contactId"), recording: get("recording") === "on",
      from: (call.parameters && call.parameters.From) || "",
    };
    if(!canCall()){ try{ call.reject(); }catch(e){} return; }
    if(onCall() || D.incoming){
      try{ call.reject(); }catch(e){}
      notify("Missed call", `${callerLabel(info)} called while you were on another call.`);
      return;
    }
    if(D.active && D.active.finished){ D.active = null; renderBar(); } // clear a call that just ended
    D.incoming = info;
    const gone = () => { if(D.incoming === info){ D.incoming = null; renderIncoming(); } };
    call.on("cancel", () => { if(D.incoming === info){ gone(); notify("Missed call", `${callerLabel(info)} stopped ringing (a teammate answered or the caller hung up).`); } });
    call.on("reject", gone);
    call.on("disconnect", () => { if(D.incoming === info) gone(); });
    call.on("error", (err) => { if(D.incoming === info){ info.error = friendlyError(err); renderIncoming(); } });
    renderIncoming();
  }

  function callerLabel(info){
    const c = info.contactId ? contactById(info.contactId) : null;
    return c ? contactName(c) : (info.from || "Someone");
  }

  function incomingEl(){
    let p = document.getElementById("dialer-incoming");
    if(p) return p;
    p = el("div", "dialer-incoming hidden");
    p.id = "dialer-incoming";
    p.setAttribute("role", "alertdialog");
    p.setAttribute("aria-label", "Incoming call");
    document.body.appendChild(p);
    return p;
  }

  function renderIncoming(){
    const info = D.incoming;
    const p = info ? incomingEl() : document.getElementById("dialer-incoming");
    if(!p) return;
    p.classList.toggle("hidden", !info);
    if(!info){ p.innerHTML = ""; return; }
    const c = info.contactId ? contactById(info.contactId) : null;
    const co = c ? companyById(c.companyId) : null;
    let details;
    if(c){
      const deals = state.deals.filter(d => d.contactId === c.id && OPEN_STAGES.includes(d.stage));
      const local = lastTouch(a => a.contactId === c.id);
      const touched = [c.lastActivityAt, local].filter(Boolean).sort().pop() || null;
      details = `
        <div class="dialer-in-meta">
          ${co ? `<span>${escapeHtml(co.name)}</span>` : ""}
          <span class="pill pill-${escapeHtml(c.status || "lead")}">${escapeHtml(statusLabel(c.status))}</span>
        </div>
        <div class="dialer-in-section">
          <div class="dialer-in-label">Open deals</div>
          ${deals.length ? deals.map(d => `<div class="dialer-in-deal"><span>${escapeHtml(d.title)} <span class="sub">· ${escapeHtml(stageById(d.stage).label)}</span></span><b>${escapeHtml(fmtMoney(d.value))}</b></div>`).join("") : '<div class="sub">No open deals</div>'}
        </div>
        <div class="dialer-in-section"><div class="dialer-in-label">Last activity</div><div>${touched ? escapeHtml(relTime(touched)) : "Never"}</div></div>`;
    } else {
      details = `<div class="dialer-in-section sub">${info.contactId ? "This lead isn't in your list right now." : "This number isn't saved on any lead."}</div>`;
    }
    p.innerHTML = `
      <div class="dialer-in-head">
        <span class="eyebrow">Incoming call</span>
        ${info.recording ? '<span class="tl-pill dialer-rec" title="This call is recorded. The caller heard the announcement.">Recording</span>' : ""}
      </div>
      <div class="dialer-in-name">${escapeHtml(c ? contactName(c) : "Unknown caller")}</div>
      <div class="dialer-in-number">${escapeHtml(info.from || "Number withheld")}</div>
      ${details}
      ${info.error ? `<div class="dialer-error">${escapeHtml(info.error)}</div>` : ""}
      <div class="dialer-in-links">
        ${c ? '<button type="button" class="panel-link" data-act="open">Open record</button>' : (info.from ? '<button type="button" class="panel-link" data-act="add">Add as new contact</button>' : "")}
      </div>
      <div class="dialer-in-actions">
        <button type="button" class="btn btn-danger btn-icon" data-act="decline">${svg("hangup")}<span>Decline</span></button>
        <button type="button" class="btn btn-primary btn-icon dialer-accept" data-act="accept">${svg("phone")}<span>Accept</span></button>
      </div>`;
    p.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => incomingAction(b.dataset.act)));
    const acceptBtn = p.querySelector('[data-act="accept"]');
    if(acceptBtn) acceptBtn.focus();
  }

  async function incomingAction(act){
    const info = D.incoming;
    if(!info) return;
    if(act === "open"){ openRecordModal("contact", info.contactId); return; }
    if(act === "add"){ openRecordModal("contact", null, { phone: info.from }); return; }
    if(act === "decline"){
      try{ info.call.reject(); }catch(e){}
      D.incoming = null; renderIncoming();
      return;
    }
    if(act === "accept"){
      try{ await ensureMicrophone(); }
      catch(e){ info.error = friendlyError(e); renderIncoming(); return; }
      if(D.incoming !== info) return; // it stopped ringing meanwhile
      const c = info.contactId ? contactById(info.contactId) : null;
      const co = c ? companyById(c.companyId) : null;
      const target = c
        ? { contactId: c.id, name: contactName(c), sub: co ? co.name : "", number: info.from, logKind:"contact", logId:c.id }
        : { contactId: null, name: "Unknown caller", sub: "", number: info.from, logKind:null, logId:null };
      const s = newSession("inbound", target, { callId: info.callId || null, recording: info.recording, call: info.call });
      wireCall(s, info.call);
      D.incoming = null; renderIncoming();
      D.active = s; renderBar();
      try{ info.call.accept(); }
      catch(e){ failSession(s, friendlyError(e)); }
    }
  }

  /* ---------- After a call: outcome and notes ---------- */
  function overlay(id, title){
    let o = document.getElementById(id);
    if(o) return o;
    o = el("div", "modal-overlay hidden dialer-overlay");
    o.id = id;
    o.innerHTML = `
      <div class="task-modal dialer-modal" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
        <div class="task-modal-head"><h3 id="${id}-title">${escapeHtml(title)}</h3><span class="task-modal-close" data-close="1" title="Close">&times;</span></div>
        <div class="task-modal-body"></div>
        <div class="task-modal-foot"><div class="dialer-modal-msg" aria-live="polite"></div><div style="flex:1;"></div>
          <button type="button" class="btn btn-ghost" data-close="1"></button>
          <button type="button" class="btn btn-primary" data-save="1"></button>
        </div>
      </div>`;
    o.addEventListener("click", (e) => { if(e.target === o || e.target.closest("[data-close]")) closeOverlay(o); });
    document.body.appendChild(o);
    return o;
  }
  function closeOverlay(o){ if(o){ o.classList.add("hidden"); o._token = null; } }
  function dispositionOptions(selected){
    return '<option value="">Choose…</option>' + Object.entries(dispositions())
      .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  }

  DialerUI.openDisposition = async function(callId, opts){
    opts = opts || {};
    if(!callId) return;
    if(!canCall()){ notify("Can't add an outcome", "Viewers can't change calls."); return; }
    const o = overlay("dialer-disposition", "How did the call go?");
    const token = {};
    o._token = token;
    const body = o.querySelector(".task-modal-body");
    const msg = o.querySelector(".dialer-modal-msg");
    const save = o.querySelector("[data-save]");
    o.querySelector("[data-close]:not(.task-modal-close)").textContent = "Skip";
    save.textContent = "Save outcome";
    msg.textContent = ""; msg.className = "dialer-modal-msg";
    const s = opts.session;
    const who = s && s.target ? s.target.name : "";
    body.innerHTML = `
      <div class="panel-sub dialer-modal-sub">${escapeHtml(who ? (s.direction === "inbound" ? "Call from " : "Call with ") + who : "Loading the call…")}</div>
      <div class="tm-field"><label for="dialer-disp-outcome">Outcome</label><select id="dialer-disp-outcome">${dispositionOptions(opts.suggested || "")}</select></div>
      <div class="tm-field"><label for="dialer-disp-notes">Notes</label><textarea id="dialer-disp-notes" maxlength="20000" placeholder="What was discussed, next steps…"></textarea></div>`;
    o.classList.remove("hidden");
    save.disabled = false;
    save.onclick = async () => {
      const disposition = body.querySelector("#dialer-disp-outcome").value;
      const notes = body.querySelector("#dialer-disp-notes").value.trim();
      if(!disposition && !notes){ body.querySelector("#dialer-disp-outcome").focus(); msg.textContent = "Pick an outcome or write a note."; return; }
      save.disabled = true; msg.className = "dialer-modal-msg"; msg.textContent = "Saving…";
      const { error } = await sb.rpc("set_call_disposition", { p_call: callId, p_disposition: disposition, p_notes: notes });
      if(o._token !== token) return;
      if(error){
        save.disabled = false;
        msg.className = "dialer-modal-msg dialer-error";
        msg.textContent = error.code === "42501" ? "You can only add the outcome of your own calls (the owner can add any)." : "Not saved: " + friendlyDbError(error);
        return;
      }
      closeOverlay(o);
      notify("Call outcome saved", dispositions()[disposition] || "Notes added");
      if(typeof refreshOpenTimeline === "function") refreshOpenTimeline();
    };
    setTimeout(() => { const f = body.querySelector("#dialer-disp-outcome"); if(f && o._token === token) f.focus(); }, 30);

    // Fill in what is already saved (an outcome added earlier, the lead's name).
    try{
      const { data, error } = await sb.from("calls").select("id, direction, contact_id, disposition, notes, duration_seconds, status").eq("id", callId).maybeSingle();
      if(o._token !== token) return;
      if(error) throw error;
      if(!data){ msg.className = "dialer-modal-msg dialer-error"; msg.textContent = "This call isn't in the CRM."; save.disabled = true; return; }
      const c = data.contact_id ? contactById(data.contact_id) : null;
      const sub = body.querySelector(".dialer-modal-sub");
      const label = (data.direction === "inbound" ? "Call from " : "Call with ") + (c ? contactName(c) : (who || "an unknown number"));
      sub.textContent = label + (data.duration_seconds ? " · " + fmtDuration(data.duration_seconds) : "");
      if(data.disposition) body.querySelector("#dialer-disp-outcome").value = data.disposition;
      const notesEl = body.querySelector("#dialer-disp-notes");
      if(data.notes && !notesEl.value) notesEl.value = data.notes;
    }catch(e){
      if(o._token === token){ const sub = body.querySelector(".dialer-modal-sub"); if(sub && !who) sub.textContent = "Call"; }
    }
  };

  /* ---------- Without calling set up: log a call made from the phone ---------- */
  function openLogPrompt(target){
    if(!target || !canCall()) return;
    const o = overlay("dialer-log", "Log this call");
    const token = {};
    o._token = token;
    const body = o.querySelector(".task-modal-body");
    const msg = o.querySelector(".dialer-modal-msg");
    const save = o.querySelector("[data-save]");
    o.querySelector("[data-close]:not(.task-modal-close)").textContent = "Not now";
    save.textContent = "Log call";
    save.disabled = false;
    msg.textContent = ""; msg.className = "dialer-modal-msg";
    const why = isDemo()
      ? "Calling through the CRM isn't available in the demo, so the call opened on your device."
      : "Calling through the CRM isn't set up yet, so the call opened on your device.";
    body.innerHTML = `
      <div class="dialer-note">${escapeHtml(why)} Log it here so it shows on the timeline. Automatic call logging and recording start once calling is set up.</div>
      <div class="tm-field"><label for="dialer-log-outcome">Outcome</label><select id="dialer-log-outcome">${dispositionOptions("")}</select></div>
      <div class="tm-field"><label for="dialer-log-subject">Summary</label><input id="dialer-log-subject" type="text" maxlength="400" /></div>
      <div class="tm-field"><label for="dialer-log-notes">Notes</label><textarea id="dialer-log-notes" maxlength="20000" placeholder="What was discussed, next steps…"></textarea></div>`;
    body.querySelector("#dialer-log-subject").value = "Call with " + target.name;
    o.classList.remove("hidden");
    save.onclick = () => {
      if(o._token !== token) return;
      const disposition = body.querySelector("#dialer-log-outcome").value;
      const summary = body.querySelector("#dialer-log-subject").value.trim() || ("Call with " + target.name);
      const label = dispositions()[disposition];
      const a = logActivity(target.logKind, target.logId, {
        type: "call",
        subject: (summary + (label ? " · " + label : "")).slice(0, 500),
        body: body.querySelector("#dialer-log-notes").value.trim(),
        meta: { disposition: disposition || null, via: "device" },
      });
      if(!a){ msg.className = "dialer-modal-msg dialer-error"; msg.textContent = "You can't log activities with view-only access."; return; }
      closeOverlay(o);
      notify("Call logged", summary);
      if(typeof refreshOpenTimeline === "function") refreshOpenTimeline();
    };
    setTimeout(() => { const f = body.querySelector("#dialer-log-outcome"); if(f && o._token === token) f.focus(); }, 30);
  }

  CRMHooks.on("escape", () => {
    ["dialer-disposition", "dialer-log"].forEach(id => closeOverlay(document.getElementById(id)));
  });

  /* ---------- Recordings on the timeline ---------- */
  DialerUI.playRecording = async function(callId, container){
    if(!container) return;
    const open = container.querySelector(".dialer-recording");
    if(open){ open.remove(); return; } // the button toggles the player
    const box = el("div", "dialer-recording");
    box.textContent = "Loading the recording…";
    box.addEventListener("click", (e) => e.stopPropagation());
    container.appendChild(box);
    try{
      const res = await api("/voice/recordings/" + encodeURIComponent(callId));
      if(!box.isConnected) return;
      box.innerHTML = "";
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.setAttribute("controlsList", "nodownload");
      audio.src = res.url;
      audio.addEventListener("error", () => {
        box.classList.add("dialer-error");
        const n = box.querySelector(".dialer-rec-note");
        if(n) n.textContent = "The recording couldn't be played. The link may have expired: close it and press Play recording again.";
      });
      box.appendChild(audio);
      box.appendChild(el("div", "dialer-rec-note", "The link to this recording works for 5 minutes."));
      audio.play().catch(() => {});
    }catch(e){
      box.classList.add("dialer-error");
      box.textContent = recordingError(e);
    }
  };

  function recordingError(e){
    if(e && e.status === 501) return "Recordings aren't available in the demo.";
    if(e && e.status === 403) return e.message || "You aren't allowed to play call recordings.";
    if(e && e.status === 404) return "This recording isn't available yet. Recordings appear a minute or two after a call ends.";
    if(e && e.status === 503) return "Recordings need the CRM server, which isn't fully set up.";
    if(e && e.status === 0) return e.message;
    return "Couldn't load the recording: " + ((e && e.message) || "unknown error");
  }

  /* ---------- Profile page: my calling settings ---------- */
  async function loadPreference(){
    if(!currentUser || D.prefLoading) return D.prefLoading;
    D.prefLoading = (async () => {
      try{
        const { data, error } = await sb.from("user_preferences").select("calls_receive_inbound").eq("user_id", currentUser.id).maybeSingle();
        if(error) throw error;
        D.receiveInbound = data ? data.calls_receive_inbound !== false : true;
      }catch(e){
        console.warn("Couldn't load the calling preference", e);
        if(D.receiveInbound === null) D.receiveInbound = true;
      }finally{
        D.prefLoading = null;
        updateProfilePanel();
      }
    })();
    return D.prefLoading;
  }

  const saveReceiveInbound = guardEdit(async function(value, input){
    const before = D.receiveInbound;
    D.receiveInbound = value;
    updateProfilePanel();
    const { error } = await sb.from("user_preferences").upsert({ user_id: currentUser.id, calls_receive_inbound: value }, { onConflict: "user_id" });
    if(error){
      D.receiveInbound = before;
      if(input) input.checked = !!before;
      updateProfilePanel();
      notify("Setting not saved", friendlyDbError(error));
      return;
    }
    notify(value ? "Calls will ring here" : "Incoming calls turned off", value ? "This browser rings for incoming calls while the CRM is open." : "You can still make calls.");
    if(D.device) refreshToken().catch(e => setPhone("error", friendlyError(e)));
    else if(value && callingLive()) ensureDevice().then(syncRegistration).catch(() => {});
  });

  function phoneStatus(){
    if(isDemo()) return ["", "Not available in the demo"];
    if(!appFeatures.calling) return ["warn", "Not set up yet"];
    if(!canCall()) return ["", "Viewers can't make calls"];
    switch(D.phone){
      case "loading": return ["warn", "Connecting…"];
      case "ready": return ["ok", "Ready: calls ring in this browser"];
      case "outgoing": return ["ok", D.receiveInbound && D.token && D.token.incoming ? "Ready to call · connecting for incoming calls…" : "Ready to call (not receiving calls)"];
      case "error": return ["bad", "Problem: " + D.phoneError];
      case "unsupported": return ["bad", "This browser can't make calls"];
      default: return ["", D.receiveInbound === false ? "Starts when you place your first call" : "Not connected"];
    }
  }

  function renderProfilePanel(){
    const host = document.getElementById("profile-calling-section");
    if(!host || !currentUser) return;
    let panel = document.getElementById("dialer-profile-panel");
    if(!panel){
      panel = el("div", "panel feature-panel dialer-panel");
      panel.id = "dialer-profile-panel";
      panel.innerHTML = `
        <div class="panel-head"><h3>Calling</h3><span class="dialer-status"><span class="status-dot"></span><span class="dialer-status-text"></span></span></div>
        <div class="panel-sub">Call leads from the CRM in your browser. Calls, outcomes and recordings appear on the lead's timeline.</div>
        <div class="dialer-note hidden" data-role="note"></div>
        <div class="setting-row" data-row="inbound">
          <div><div class="setting-label"><label for="dialer-receive-inbound">Receive calls in the browser</label></div>
            <div class="setting-help">When someone calls the CRM's number, this browser rings while the CRM is open. Turn it off and you can still make calls.</div></div>
          <label class="switch"><input type="checkbox" id="dialer-receive-inbound" /><span class="slider"></span></label>
        </div>
        <div class="setting-row" data-row="mic">
          <div><div class="setting-label">Microphone</div>
            <div class="setting-help" data-role="mic-text">The browser asks for your microphone when your first call starts. Check it now if you like.</div>
            <div class="dialer-meter hidden" aria-hidden="true"><span></span></div></div>
          <button type="button" class="btn btn-sm" data-act="mic">Test microphone</button>
        </div>
        <div class="setting-row" data-row="phone">
          <div><div class="setting-label">Browser phone</div><div class="setting-help" data-role="phone-text"></div></div>
          <button type="button" class="btn btn-sm" data-act="connect">Connect now</button>
        </div>`;
      host.appendChild(panel);
      panel.querySelector("#dialer-receive-inbound").addEventListener("change", (e) => saveReceiveInbound(e.target.checked, e.target));
      panel.querySelector('[data-act="mic"]').addEventListener("click", testMicrophone);
      panel.querySelector('[data-act="connect"]').addEventListener("click", () => {
        ensureDevice().then(syncRegistration).catch(e => setPhone(D.phone === "unsupported" ? "unsupported" : "error", friendlyError(e)));
      });
    }
    updateProfilePanel();
  }

  function updateProfilePanel(){
    const panel = document.getElementById("dialer-profile-panel");
    if(!panel) return;
    const [dot, text] = phoneStatus();
    panel.querySelector(".dialer-status .status-dot").className = "status-dot " + dot;
    panel.querySelector(".dialer-status-text").textContent = text;
    const note = panel.querySelector('[data-role="note"]');
    let noteText = "";
    if(isDemo()) noteText = "Calling isn't available in the demo. Call buttons open your device's dialer and you can log the call by hand.";
    else if(!canCall()) noteText = "You have view-only access, so you can't make or take calls in the CRM. Call buttons open your device's dialer.";
    else if(!appFeatures.calling) noteText = "Calling isn't set up yet. Until the CRM owner connects Twilio, Call buttons open your device's dialer and you can log the call by hand. Your choices below are kept for later.";
    note.textContent = noteText;
    note.classList.toggle("hidden", !noteText);
    const live = callingLive();
    panel.querySelector('[data-row="inbound"]').classList.toggle("hidden", !canCall() || isDemo());
    panel.querySelector('[data-row="mic"]').classList.toggle("hidden", !canCall());
    panel.querySelector('[data-row="phone"]').classList.toggle("hidden", !live);
    const sw = panel.querySelector("#dialer-receive-inbound");
    sw.checked = D.receiveInbound !== false;
    sw.disabled = D.receiveInbound === null || !canCall();
    panel.querySelector('[data-role="phone-text"]').textContent = text;
    const connect = panel.querySelector('[data-act="connect"]');
    connect.classList.toggle("hidden", D.phone === "ready" || D.phone === "loading" || D.phone === "unsupported" || (D.phone === "outgoing" && !D.receiveInbound));
    connect.textContent = D.phone === "error" ? "Reconnect" : "Connect now";
  }

  async function testMicrophone(){
    const panel = document.getElementById("dialer-profile-panel");
    if(!panel) return;
    const out = panel.querySelector('[data-role="mic-text"]');
    const meter = panel.querySelector(".dialer-meter");
    const bar = meter.querySelector("span");
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      out.textContent = "This browser can't use a microphone on this page (it needs a secure https page and a current browser).";
      return;
    }
    out.textContent = "Asking for your microphone…";
    let stream;
    try{ stream = await navigator.mediaDevices.getUserMedia({ audio:true }); }
    catch(e){
      out.textContent = e && (e.name === "NotAllowedError" || e.name === "SecurityError")
        ? "Microphone access is blocked. Allow the microphone for this site (the icon in the address bar), then test again."
        : e && e.name === "NotFoundError" ? "No microphone was found. Plug one in or check your sound settings." : "The microphone couldn't be used: " + ((e && e.message) || e);
      return;
    }
    D.micOk = true;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx){ stream.getTracks().forEach(t => t.stop()); out.textContent = "Your microphone works."; return; }
    out.textContent = "Your microphone works. Say something to see the level.";
    meter.classList.remove("hidden");
    let ctx;
    try{
      ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const until = Date.now() + 5000;
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for(let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        bar.style.width = Math.min(100, Math.round(peak / 128 * 180)) + "%";
        if(Date.now() < until) requestAnimationFrame(tick);
        else { stream.getTracks().forEach(t => t.stop()); try{ ctx.close(); }catch(e){} meter.classList.add("hidden"); out.textContent = "Your microphone works."; }
      };
      tick();
    }catch(e){
      stream.getTracks().forEach(t => t.stop());
      if(ctx) try{ ctx.close(); }catch(x){}
      meter.classList.add("hidden");
      out.textContent = "Your microphone works.";
    }
  }

  /* ---------- Team page: the owner's calling settings ---------- */
  const COUNTRIES = [
    ["", "Not set (numbers need a country code)"],
    ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["IE", "Ireland"], ["AU", "Australia"], ["NZ", "New Zealand"],
    ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["KW", "Kuwait"], ["BH", "Bahrain"], ["OM", "Oman"],
    ["PK", "Pakistan"], ["IN", "India"], ["BD", "Bangladesh"], ["LK", "Sri Lanka"], ["SG", "Singapore"], ["MY", "Malaysia"],
    ["PH", "Philippines"], ["ZA", "South Africa"], ["NG", "Nigeria"], ["KE", "Kenya"], ["EG", "Egypt"],
    ["DE", "Germany"], ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"], ["NL", "Netherlands"], ["BE", "Belgium"],
    ["CH", "Switzerland"], ["AT", "Austria"], ["SE", "Sweden"], ["NO", "Norway"], ["DK", "Denmark"], ["PL", "Poland"],
    ["PT", "Portugal"], ["TR", "Türkiye"], ["MX", "Mexico"], ["BR", "Brazil"],
  ];
  const ACCESS = [["owner", "Only the owner (and the person on the call)"], ["editors", "The owner and editors"], ["all", "Everyone on the team, viewers too"]];

  function renderTeamPanel(){
    const host = document.getElementById("team-integrations-section");
    let panel = document.getElementById("dialer-team-panel");
    if(currentRole !== "owner"){ if(panel) panel.remove(); return; }
    if(!host) return;
    if(!panel){
      panel = el("div", "panel feature-panel dialer-panel");
      panel.id = "dialer-team-panel";
      panel.innerHTML = `
        <div class="panel-head"><h3>Calling</h3><span class="dialer-status"><span class="status-dot"></span><span class="dialer-status-text"></span></span></div>
        <div class="panel-sub">Calls go through Twilio. The CRM only calls numbers saved on contacts and companies, and every call lands on the lead's timeline.</div>
        <div class="dialer-setup" data-role="setup"></div>
        <div class="setting-row">
          <div><div class="setting-label"><label for="dialer-rec-switch">Record calls</label></div>
            <div class="setting-help">Recording laws differ from place to place. Some US states (for example California, Florida and Pennsylvania) and many countries require everyone on a call to agree to being recorded. When recording is on, the other person hears the announcement below at the start of every call, and you see a Recording badge in the CRM during the call, so both sides know. Voicemail messages are always recorded. Check the rules that apply to you and your leads before turning this on.</div></div>
          <label class="switch"><input type="checkbox" id="dialer-rec-switch" /><span class="slider"></span></label>
        </div>
        <div class="setting-row dialer-stack">
          <div><div class="setting-label"><label for="dialer-rec-announcement">Recording announcement</label></div>
            <div class="setting-help">Spoken to the other person at the start of every recorded call.</div></div>
          <textarea id="dialer-rec-announcement" maxlength="300" rows="2"></textarea>
        </div>
        <div class="setting-row">
          <div><div class="setting-label"><label for="dialer-rec-access">Who can play recordings</label></div>
            <div class="setting-help">Recordings are private files. Allowed people get a link that works for a few minutes.</div></div>
          <select id="dialer-rec-access">${ACCESS.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join("")}</select>
        </div>
        <div class="setting-row">
          <div><div class="setting-label"><label for="dialer-country">Default country for phone numbers</label></div>
            <div class="setting-help">Used for numbers saved without a country code, like (415) 555-0143, and to recognise who is calling.</div></div>
          <select id="dialer-country"></select>
        </div>`;
      host.appendChild(panel);
      panel.querySelector("#dialer-rec-switch").addEventListener("change", (e) => setRecording(e.target.checked, e.target));
      panel.querySelector("#dialer-rec-announcement").addEventListener("change", (e) => saveCallSetting("recordingAnnouncement", e.target.value.replace(/\s+/g, " ").trim().slice(0, 300) || undefined));
      panel.querySelector("#dialer-rec-access").addEventListener("change", (e) => saveCallSetting("recordingAccess", e.target.value));
      panel.querySelector("#dialer-country").addEventListener("change", (e) => saveCallSetting("defaultCountry", e.target.value || undefined));
      loadSetup();
    }
    updateTeamPanel();
  }

  function updateTeamPanel(){
    const panel = document.getElementById("dialer-team-panel");
    if(!panel) return;
    const s = state.settings || {};
    const ok = !!appFeatures.calling;
    panel.querySelector(".dialer-status .status-dot").className = "status-dot " + (isDemo() ? "" : ok ? "ok" : "warn");
    panel.querySelector(".dialer-status-text").textContent = isDemo() ? "Demo" : ok ? "Set up" : "Not set up yet";
    const sw = panel.querySelector("#dialer-rec-switch");
    sw.checked = s.callRecording === "on";
    const ann = panel.querySelector("#dialer-rec-announcement");
    if(document.activeElement !== ann){ ann.value = s.recordingAnnouncement || ""; }
    ann.placeholder = DEFAULT_ANNOUNCEMENT;
    panel.querySelector("#dialer-rec-access").value = ["owner", "editors", "all"].includes(s.recordingAccess) ? s.recordingAccess : "editors";
    const country = panel.querySelector("#dialer-country");
    const cur = String(s.defaultCountry || "");
    const list = COUNTRIES.some(([c]) => c === cur) ? COUNTRIES : COUNTRIES.concat([[cur, cur]]);
    if(country.options.length !== list.length) country.innerHTML = list.map(([c, l]) => `<option value="${escapeHtml(c)}">${escapeHtml(l)}</option>`).join("");
    country.value = cur;

    const setup = panel.querySelector('[data-role="setup"]');
    let html;
    if(isDemo()) html = "Calling isn't available in the demo. Call buttons open the device's dialer and calls can be logged by hand.";
    else if(D.setupLoading && !D.setup) html = "Checking the calling setup…";
    else if(D.setupError) html = `<span class="dialer-error">Couldn't check the calling setup: ${escapeHtml(D.setupError)}</span> <button type="button" class="panel-link" data-act="retry">Try again</button>`;
    else if(D.setup && D.setup.configured) html = `Connected to Twilio. Calls come from <b>${escapeHtml(D.setup.callerId || "")}</b>, and calls to that number ring the browsers of owners and editors who take calls (Profile page).`;
    else {
      const missing = D.setup && D.setup.missing && D.setup.missing.length ? D.setup.missing : [];
      html = "Calling isn't set up yet, so Call buttons open the device's dialer and calls are logged by hand. To connect Twilio, add "
        + (missing.length ? missing.map(m => `<code>${escapeHtml(m)}</code>`).join(", ") : "the <code>TWILIO_*</code> settings")
        + " to the server's environment and run <code>npm run setup:twilio</code> (see .env.example).";
    }
    setup.innerHTML = html;
    const retry = setup.querySelector('[data-act="retry"]');
    if(retry) retry.addEventListener("click", loadSetup);
  }

  async function loadSetup(){
    if(isDemo() || D.setupLoading) return;
    D.setupLoading = true; D.setupError = "";
    updateTeamPanel();
    try{ D.setup = await api("/voice/setup"); }
    catch(e){ D.setupError = e && e.status === 501 ? "not available in the demo" : ((e && e.message) || "unknown error"); }
    finally{ D.setupLoading = false; updateTeamPanel(); }
  }

  const setRecording = guardOwnerOnly(async function(on, input){
    if(on){
      const ok = await confirmDialog("Turn on call recording? Every call will start with the announcement, and both sides are recorded. Make sure recording calls is allowed where you and your leads are (some places require everyone's consent).", "Turn on recording");
      if(!ok){ if(input) input.checked = false; return; }
    }
    await saveCallSetting("callRecording", on ? "on" : "off");
    notify(on ? "Call recording on" : "Call recording off", on ? "New calls are recorded after the announcement." : "New calls aren't recorded. Voicemail still is.");
  });

  const saveCallSetting = guardOwnerOnly(async function(key, value){
    if(value === undefined) delete state.settings[key];
    else state.settings[key] = value;
    await saveSettings();
    updateTeamPanel();
  });

  /* ---------- Wiring ---------- */
  CRMHooks.on("profile:render", () => {
    if(!canCall() && (D.device || D.active)) destroyDevice(); // e.g. demoted to viewer
    renderProfilePanel();
  });
  CRMHooks.on("team:render", renderTeamPanel);
  CRMHooks.on("app:ready", async () => {
    if(!currentUser) return;
    await loadPreference();
    if(callingLive() && D.receiveInbound) ensureDevice().then(syncRegistration).catch((e) => console.warn("Browser phone didn't start", e));
    renderProfilePanel();
  });

  // For tests and debugging.
  DialerUI._state = D;
  DialerUI.describeTarget = describeTarget;
  DialerUI.SDK_URL = VOICE_SDK_URL;
})();
