/* ============================================================
   NOTIFICATION PREFERENCES
   Owned by the notifications integration. Contract (docs/ARCHITECTURE.md):
     - Profile page: personal email notification settings in
       #profile-notifications-section (task assigned, reminders, overdue,
       daily digest + hour + time zone), saved straight to user_preferences
       (row level security: your own row), plus "Send me a test email"
     - Team page (owner): sender status and recent delivery failures, as a
       child panel of #team-integrations-section
   Server routes: /api/notifications/* (lib/server/notifications/routes.ts)
============================================================ */
(function(){
  const PREF_FIELDS = ["notify_task_assigned", "notify_task_reminders", "notify_task_overdue", "notify_daily_digest", "digest_hour", "timezone"];
  const DEFAULT_PREFS = { notify_task_assigned:true, notify_task_reminders:true, notify_task_overdue:true, notify_daily_digest:false, digest_hour:8, timezone:null };
  const KIND_LABELS = {
    "notify.task_assigned":"Task assigned", "notify.task_reminder":"Reminder", "notify.task_overdue":"Overdue",
    "notify.daily_digest":"Daily digest", "notify.test_email":"Test email",
  };
  const FALLBACK_ZONES = ["UTC", "Asia/Karachi", "Asia/Dubai", "Asia/Riyadh", "Asia/Kolkata", "Asia/Singapore", "Europe/London", "Europe/Berlin",
    "Europe/Istanbul", "Africa/Cairo", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "Australia/Sydney"];

  // Profile panel state (per signed-in person).
  const prefs = { userId:null, loading:false, loaded:false, error:null, saved:null, draft:null, saving:false, again:false, saveState:"", saveMsg:"", savedTimer:null,
                  test:{ busy:false, text:"", tone:"" } };
  // Team panel state.
  const status = { loading:false, loaded:false, error:null, errorStatus:0, data:null };

  const esc = (s) => escapeHtml(s);
  const teamZone = () => (state && state.settings && state.settings.timezone) || "UTC";
  const isDemo = () => typeof DEMO !== "undefined" && DEMO;
  const isOwner = () => currentRole === "owner";
  const hourLabel = (h) => (h % 12 === 0 ? 12 : h % 12) + ":00 " + (h < 12 ? "AM" : "PM");
  const dbMessage = (e) => (typeof friendlyDbError === "function" ? friendlyDbError(e) : "") || (e && e.message) || "Unknown error";

  function normalizePrefs(row){
    const out = Object.assign({}, DEFAULT_PREFS);
    if(row){
      PREF_FIELDS.forEach(k => { if(row[k] !== undefined && row[k] !== null) out[k] = row[k]; });
      if(row.timezone === null) out.timezone = null;
    }
    const h = Number(out.digest_hour);
    out.digest_hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
    out.timezone = typeof out.timezone === "string" && out.timezone ? out.timezone : null;
    return out;
  }
  const samePrefs = (a, b) => !!a && !!b && PREF_FIELDS.every(k => a[k] === b[k]);

  function zoneList(){
    let zones = [];
    try{ if(typeof Intl.supportedValuesOf === "function") zones = Intl.supportedValuesOf("timeZone"); }catch(e){}
    if(!zones || !zones.length) zones = FALLBACK_ZONES.slice();
    zones = zones.slice();
    if(!zones.includes("UTC")) zones.unshift("UTC");
    return zones;
  }

  /* ------------------------------------------------------------
     Profile: Email notifications
  ------------------------------------------------------------ */
  function buildPrefsPanel(){
    const panel = document.createElement("div");
    panel.className = "panel feature-panel notif-panel";
    panel.id = "notif-prefs-panel";
    panel.innerHTML = `
      <div class="panel-head"><h3>Email notifications</h3><span class="notif-save-state" id="notif-save-state" role="status" aria-live="polite"></span></div>
      <div class="panel-sub" id="notif-intro"></div>
      <div class="notif-banner hidden" id="notif-banner"></div>
      <div id="notif-prefs-body"></div>
      <div class="notif-test" id="notif-test"></div>`;
    panel.addEventListener("change", onPrefsChange);
    panel.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("[data-notif-action]");
      if(!btn) return;
      if(btn.dataset.notifAction === "retry-load") loadPrefs();
      if(btn.dataset.notifAction === "send-test") sendTestEmail();
    });
    return panel;
  }

  function switchRow(id, label, help){
    return `<div class="setting-row">
      <div><div class="setting-label" id="${id}-label">${label}</div><div class="setting-help">${help}</div></div>
      <label class="switch"><input type="checkbox" id="${id}" data-pref="${id.replace("np-", "notify_")}" aria-labelledby="${id}-label" data-always-enabled="true" /><span class="slider"></span></label>
    </div>`;
  }

  function renderPrefsBody(body){
    if(prefs.loading && !prefs.loaded){ body.innerHTML = `<div class="tl-state">Loading your notification settings…</div>`; return; }
    if(prefs.error && !prefs.loaded){
      body.innerHTML = `<div class="tl-state tl-error">Couldn't load your notification settings: ${esc(prefs.error)}</div>
        <button type="button" class="btn btn-sm" data-notif-action="retry-load" data-always-enabled="true">Try again</button>`;
      return;
    }
    if(!prefs.loaded) { body.innerHTML = ""; return; }
    if(!body.querySelector("#np-task_assigned")){
      const ownerNote = isOwner() ? " As the CRM owner you also get the reminders for unassigned tasks." : "";
      const hours = Array.from({ length:24 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join("");
      body.innerHTML =
        switchRow("np-task_assigned", "Task assigned to me", "When someone else assigns a task to you.") +
        switchRow("np-task_reminders", "Task reminders", "When a task's reminder goes off (at the due time, or 15 minutes, 1 hour or 1 day before, as set on the task)." + ownerNote) +
        switchRow("np-task_overdue", "Overdue tasks", "Once, when an open task is past due: an hour after its due time, or on the morning after its due date (at your digest hour).") +
        switchRow("np-daily_digest", "Daily digest", "Every day at your digest hour: your overdue tasks, today's tasks and the next 7 days. Skipped when there's nothing to report.") +
        `<div class="setting-row notif-select-row">
          <div>
            <div class="setting-label"><label for="np-digest-hour">Digest hour</label></div>
            <div class="setting-help">When your daily digest arrives, and when overdue emails for tasks without a due time go out.</div>
          </div>
          <select id="np-digest-hour" class="input notif-select notif-hour" data-pref="digest_hour" data-always-enabled="true">${hours}</select>
        </div>
        <div class="setting-row notif-select-row">
          <div>
            <div class="setting-label"><label for="np-timezone">My time zone</label></div>
            <div class="setting-help" id="np-timezone-help"></div>
          </div>
          <select id="np-timezone" class="input notif-select notif-tz" data-pref="timezone" data-always-enabled="true"></select>
        </div>`;
    }
    syncControls(body);
  }

  function syncControls(root){
    root = root || document.getElementById("notif-prefs-body");
    if(!root || !prefs.draft) return;
    const d = prefs.draft;
    ["task_assigned", "task_reminders", "task_overdue", "daily_digest"].forEach(k => {
      const el = root.querySelector("#np-" + k);
      if(el) el.checked = !!d["notify_" + k];
    });
    const hour = root.querySelector("#np-digest-hour");
    if(hour) hour.value = String(d.digest_hour);
    const tz = root.querySelector("#np-timezone");
    if(tz){
      const team = teamZone();
      const zones = zoneList();
      if(d.timezone && !zones.includes(d.timezone)) zones.unshift(d.timezone);
      const want = `team:${team}|${zones.length}`;
      if(tz.dataset.built !== want){
        tz.innerHTML = `<option value="">Team time zone (${esc(team)})</option>` +
          zones.map(z => `<option value="${esc(z)}">${esc(z.replace(/_/g, " "))}</option>`).join("");
        tz.dataset.built = want;
      }
      tz.value = d.timezone || "";
    }
    const help = root.querySelector("#np-timezone-help");
    if(help){
      help.textContent = "Used for your digest hour, overdue mornings and the times shown in your emails. " +
        "Due dates and times on tasks are always in the team's time zone (" + teamZone() + ")" +
        (d.timezone ? ", so emails show both." : ".");
    }
  }

  function renderSaveState(){
    const el = document.getElementById("notif-save-state");
    if(!el) return;
    el.className = "notif-save-state" + (prefs.saveState ? " is-" + prefs.saveState : "");
    el.textContent = prefs.saveState === "saving" ? "Saving…" : prefs.saveState === "saved" ? "Saved" : prefs.saveState === "error" ? "Not saved: " + prefs.saveMsg : "";
  }

  function renderTestRow(row){
    if(isDemo()){
      row.innerHTML = `<div class="notif-note">Test emails need the CRM server, which the demo doesn't have.</div>`;
      return;
    }
    if(!appFeatures.notifications){
      row.innerHTML = `<div class="notif-note"><span class="status-dot warn"></span>Email sending isn't set up on the server yet, so notification emails can't go out. ` +
        (isOwner() ? "See <b>Notification emails</b> on the Team page for what to set." : "The CRM owner can set it up.") + `</div>`;
      return;
    }
    const t = prefs.test;
    row.innerHTML = `<button type="button" class="btn btn-sm" data-notif-action="send-test" data-always-enabled="true" ${t.busy ? "disabled" : ""}>${t.busy ? "Sending…" : "Send me a test email"}</button>` +
      `<span class="notif-test-result ${t.tone ? "is-" + t.tone : ""}" role="status" aria-live="polite">${esc(t.text)}</span>`;
  }

  function renderPrefsPanel(panel){
    const email = (typeof myProfile !== "undefined" && myProfile && myProfile.email) || (currentUser && currentUser.email) || "";
    panel.querySelector("#notif-intro").innerHTML =
      `Emails go to <b>${esc(email)}</b>. Choose which ones you get; changes save automatically.`;
    const banner = panel.querySelector("#notif-banner");
    if(isDemo()){
      banner.className = "notif-banner";
      banner.textContent = "This is the demo: your choices are kept in this browser, but no emails are sent.";
    } else if(!appFeatures.notifications){
      banner.className = "notif-banner is-warn";
      banner.textContent = "Email sending isn't set up on the server yet. Your choices are saved and take effect once it is.";
    } else {
      banner.className = "notif-banner hidden";
      banner.textContent = "";
    }
    renderPrefsBody(panel.querySelector("#notif-prefs-body"));
    renderSaveState();
    renderTestRow(panel.querySelector("#notif-test"));
    if(typeof applyRolePermissions === "function") applyRolePermissions();
  }

  function renderProfileSection(){
    const host = document.getElementById("profile-notifications-section");
    if(!host || !currentUser) return;
    if(prefs.userId !== currentUser.id){
      Object.assign(prefs, { userId:currentUser.id, loading:false, loaded:false, error:null, saved:null, draft:null, saveState:"", saveMsg:"", test:{ busy:false, text:"", tone:"" } });
      host.innerHTML = "";
    }
    let panel = host.querySelector("#notif-prefs-panel");
    if(!panel){ panel = buildPrefsPanel(); host.appendChild(panel); }
    renderPrefsPanel(panel);
    if(!prefs.loaded && !prefs.loading && !prefs.error) loadPrefs();
  }

  function rerenderPrefs(){
    const panel = document.getElementById("notif-prefs-panel");
    if(panel) renderPrefsPanel(panel);
  }

  async function loadPrefs(){
    if(!sb || !currentUser) return;
    const userId = currentUser.id;
    prefs.loading = true; prefs.error = null;
    rerenderPrefs();
    try{
      const { data, error } = await sb.from("user_preferences").select(PREF_FIELDS.join(",")).eq("user_id", userId).maybeSingle();
      if(error) throw error;
      if(prefs.userId !== userId) return;
      prefs.saved = normalizePrefs(data);
      prefs.draft = Object.assign({}, prefs.saved);
      prefs.loaded = true;
    }catch(e){
      if(prefs.userId === userId) prefs.error = dbMessage(e);
    }finally{
      if(prefs.userId === userId){ prefs.loading = false; rerenderPrefs(); }
    }
  }

  function onPrefsChange(e){
    const el = e.target;
    const key = el && el.dataset && el.dataset.pref;
    if(!key || !prefs.draft) return;
    if(el.type === "checkbox") prefs.draft[key] = el.checked;
    else if(key === "digest_hour") prefs.draft[key] = Number(el.value);
    else if(key === "timezone") prefs.draft[key] = el.value || null;
    syncControls();
    savePrefs();
  }

  async function savePrefs(){
    if(prefs.saving){ prefs.again = true; return; }
    if(samePrefs(prefs.draft, prefs.saved)) return;
    const userId = currentUser.id;
    const values = Object.assign({}, prefs.draft);
    prefs.saving = true;
    prefs.saveState = "saving"; prefs.saveMsg = "";
    clearTimeout(prefs.savedTimer);
    renderSaveState();
    try{
      const row = { user_id:userId };
      PREF_FIELDS.forEach(k => { row[k] = values[k]; });
      // Only these columns: calling settings in the same row stay as they are.
      const { error } = await sb.from("user_preferences").upsert(row, { onConflict:"user_id" });
      if(error) throw error;
      prefs.saved = values;
      prefs.saveState = "saved";
      prefs.savedTimer = setTimeout(() => { if(prefs.saveState === "saved"){ prefs.saveState = ""; renderSaveState(); } }, 2500);
    }catch(e){
      prefs.saveState = "error"; prefs.saveMsg = dbMessage(e);
      prefs.draft = Object.assign({}, prefs.saved);
      prefs.again = false;
      syncControls();
    }finally{
      prefs.saving = false;
      renderSaveState();
      if(prefs.again){ prefs.again = false; savePrefs(); }
    }
  }

  async function sendTestEmail(){
    if(prefs.test.busy) return;
    prefs.test = { busy:true, text:"", tone:"" };
    rerenderPrefs();
    let text, tone;
    try{
      const res = await api("/notifications/test", { method:"POST", body:{} });
      if(!res || res.sent !== true) throw Object.assign(new Error("The server didn't confirm the email was sent."), { status:500 });
      text = "Sent to " + (res.to || "you") + ". It usually arrives within a minute.";
      tone = "ok";
    }catch(e){
      tone = "bad";
      if(e.status === 501) text = "Test emails need the CRM server, which the demo doesn't have.";
      else if(e.status === 503) text = "Email sending isn't set up on the server yet.";
      else text = e.message || "The test email wasn't sent.";
    }
    prefs.test = { busy:false, text, tone };
    rerenderPrefs();
  }

  /* ------------------------------------------------------------
     Team page (owner): sender status and delivery problems
  ------------------------------------------------------------ */
  function buildTeamPanel(){
    const panel = document.createElement("div");
    panel.className = "panel feature-panel notif-panel";
    panel.id = "notif-team-panel";
    panel.innerHTML = `
      <div class="panel-head"><h3>Notification emails</h3><button type="button" class="panel-link" data-notif-action="refresh-status" data-always-enabled="true">Refresh</button></div>
      <div class="panel-sub">Task assigned, reminder, overdue and daily digest emails to the team. Each person chooses theirs on their profile.</div>
      <div id="notif-status-body"></div>`;
    panel.addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest("[data-notif-action]");
      if(btn && btn.dataset.notifAction === "refresh-status") loadStatus();
    });
    return panel;
  }

  function failureLine(f){
    const kind = KIND_LABELS[f.kind] || f.kind || "Email";
    const what = f.taskTitle ? ` <b>${esc(f.taskTitle)}</b>` : f.taskId ? " <span class=\"notif-muted\">(task deleted)</span>" : "";
    const who = f.recipient ? ` <span class="notif-muted">to ${esc(f.recipient)}</span>` : "";
    const state = f.status === "dead"
      ? "Gave up" + (f.attempts > 1 ? " after " + f.attempts + " attempts" : "")
      : "Retrying (attempt " + (f.attempts || 1) + " of " + (f.maxAttempts || 6) + ")";
    const when = f.at && typeof relTime === "function" ? " · " + esc(relTime(f.at)) : "";
    return `<li class="notif-fail">
      <div><span class="tl-pill">${esc(kind)}</span>${what}${who}</div>
      <div class="notif-fail-err">${esc(f.error || "Unknown error")}</div>
      <div class="notif-muted">${esc(state)}${when}</div>
    </li>`;
  }

  function renderStatusBody(body){
    if(status.loading && !status.data){ body.innerHTML = `<div class="tl-state">Checking the email sender…</div>`; return; }
    if(status.error && !status.data){
      body.innerHTML = status.errorStatus === 501
        ? `<div class="tl-state">Sender status needs the CRM server, which the demo doesn't have.</div>`
        : `<div class="tl-state tl-error">Couldn't load the notification status: ${esc(status.error)}</div>`;
      return;
    }
    const d = status.data;
    if(!d){ body.innerHTML = ""; return; }
    const s = d.sender || {};
    const senderHtml = s.configured
      ? `<span class="status-dot ok"></span>Sending through ${esc(s.label || s.kind)}${s.from ? `<div class="setting-help">From: ${esc(s.from)}</div>` : ""}`
      : `<span class="status-dot bad"></span>Not set up, so no notification emails go out.
         <div class="setting-help">Set <code>RESEND_API_KEY</code> (with <code>NOTIFICATION_FROM_EMAIL</code>), or <code>GMAIL_USER</code> + <code>GMAIL_APP_PASSWORD</code>, or <code>SMTP_HOST</code> in the server's environment (see <code>.env.example</code>), then redeploy.</div>`;
    const c = d.last24h || {};
    const counts = `${c.sent || 0} sent · ${c.skipped || 0} skipped · ${c.failed || 0} failed` + (c.waiting ? ` · ${c.waiting} waiting` : "");
    const fails = Array.isArray(d.recentFailures) ? d.recentFailures : [];
    body.innerHTML = `
      <div class="setting-row"><div><div class="setting-label">Sender</div><div class="notif-status-line">${senderHtml}</div></div></div>
      <div class="setting-row"><div><div class="setting-label">Last 24 hours</div><div class="notif-status-line">${esc(counts)}</div>
        <div class="setting-help">Skipped emails no longer applied when they were due (task done or reassigned, notification switched off…).</div></div></div>
      <div class="setting-row notif-fails-row"><div style="width:100%;"><div class="setting-label">Delivery problems</div>
        ${fails.length ? `<ul class="notif-fails">${fails.map(failureLine).join("")}</ul>` : `<div class="notif-status-line"><span class="status-dot ok"></span>No delivery problems.</div>`}
      </div></div>` +
      (status.error ? `<div class="tl-state tl-error">Couldn't refresh: ${esc(status.error)}</div>` : "");
  }

  function renderTeamSection(){
    const host = document.getElementById("team-integrations-section");
    let panel = document.getElementById("notif-team-panel");
    if(!host || !isOwner()){ if(panel) panel.remove(); return; }
    if(!panel){ panel = buildTeamPanel(); host.appendChild(panel); }
    else if(panel.parentNode !== host) host.appendChild(panel);
    const btn = panel.querySelector("[data-notif-action='refresh-status']");
    if(btn){ btn.disabled = status.loading; btn.textContent = status.loading ? "Checking…" : "Refresh"; }
    renderStatusBody(panel.querySelector("#notif-status-body"));
    if(!status.loaded && !status.loading && !status.error) loadStatus();
  }

  async function loadStatus(){
    if(status.loading) return;
    status.loading = true; status.error = null; status.errorStatus = 0;
    renderTeamSection();
    try{
      const res = await api("/notifications/status");
      if(!res || typeof res.sender !== "object" || res.sender === null) throw Object.assign(new Error("The server sent an answer this page doesn't understand."), { status:500 });
      status.data = res;
      status.loaded = true;
    }catch(e){
      status.error = e.message || "Unknown error";
      status.errorStatus = e.status || 0;
    }finally{
      status.loading = false;
      renderTeamSection();
    }
  }

  /* ------------------------------------------------------------
     The moment a naive due date/time means in the team's time zone: the
     same rule the reminder emails use (lib/server/notifications/time.ts,
     DST-safe), so the in-app reminder can go off at the same moment.
  ------------------------------------------------------------ */
  const zoneFormatters = {};
  function zoneOffsetMs(ms, timeZone){
    const f = zoneFormatters[timeZone] || (zoneFormatters[timeZone] = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle:"h23", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit",
    }));
    const p = {};
    f.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  }
  function teamDueInstant(dueDate, dueTime, timeZone){
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate || "");
    if(!m) return null;
    const t = /^(\d{1,2}):(\d{2})/.exec(dueTime || "") || [null, "0", "0"];
    const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
    const tz = timeZone || teamZone();
    try{
      const before = zoneOffsetMs(naive - 864e5, tz), after = zoneOffsetMs(naive + 864e5, tz);
      const fits = [before, after].map(o => naive - o).filter(ms => naive - zoneOffsetMs(ms, tz) === ms).sort((a, b) => a - b);
      return new Date(fits.length ? fits[0] : naive - before);
    }catch(e){
      return new Date(dueDate.slice(0, 10) + "T" + (t[0] ? String(t[1]).padStart(2, "0") + ":" + t[2] : "00:00"));
    }
  }

  CRMHooks.on("profile:render", renderProfileSection);
  CRMHooks.on("team:render", renderTeamSection);

  window.NotificationsUI = Object.assign(window.NotificationsUI || {}, {
    reloadPreferences: loadPrefs,
    refreshStatus: loadStatus,
    /** (dueDate "yyyy-mm-dd", dueTime "HH:MM" | null, timeZone? = team's) -> Date | null */
    teamDueInstant,
  });
})();
