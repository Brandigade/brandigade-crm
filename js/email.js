/* ============================================================
   EMAIL (Gmail / Outlook)
   Owned by the email integration. Contract (docs/ARCHITECTURE.md):
     - Profile page: connected mailboxes in #profile-email-section
       (connect, reconnect, disconnect, sync now, sharing, status/errors)
     - Record header "Email" button (hook "record:actions") and task view
       "Email" button (hook "task:actions") open the composer
     - window.EmailUI = { openComposer({ to, contactId, replyTo }), openViewer(activity) }
       used by js/timeline.js for "Open" and "Reply" on email items
   Server routes: /api/email/* (lib/server/email/routes.ts)

   Untrusted email HTML is only ever shown inside a sandboxed iframe
   (no scripts, no same-origin) whose own Content-Security-Policy blocks
   remote images until the person asks for them.
============================================================ */
(function(){
  "use strict";

  const MAIL_ICON = '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>';
  const PROVIDERS = {
    google: { label: "Gmail", feature: "gmail" },
    microsoft: { label: "Outlook", feature: "outlook" },
  };
  const OAUTH_ERRORS = {
    access_denied: "You didn't allow access, so nothing was connected.",
    browser_mismatch: "For your security, finish connecting in the same browser where you clicked Connect. Please try again.",
    expired: "Connecting took longer than 10 minutes. Please try again.",
    invalid_state: "That sign-in link was already used or isn't valid any more. Start again with Connect.",
    missing_scopes: "The CRM needs permission to read and send email. Keep every box ticked on the consent screen and try again.",
    no_refresh_token: "The provider didn't give the CRM lasting access. Remove the CRM from your account's connected apps, then connect again.",
    no_mailbox: "That account has no mailbox the CRM can use (it needs Gmail or Exchange Online).",
    forbidden: "Only owners and editors can connect a mailbox.",
    not_configured: "This email provider isn't set up on the server yet. Ask the CRM owner.",
  };
  const ADDRESS_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
  const STALE_MS = 60 * 1000;

  const store = {
    accounts: null,     // null = not loaded yet
    loading: false,
    error: null,
    loadedAt: 0,
    unavailable: false, // demo / no server
    busy: {},           // accountId -> "sync" | "disconnect" | "settings"
    connecting: null,   // provider being connected
    pending: null,
  };

  const isDemo = () => (typeof DEMO !== "undefined" && DEMO) || store.unavailable;
  const isViewer = () => currentRole === "viewer";
  const providerLabel = (p) => (PROVIDERS[p] ? PROVIDERS[p].label : "Email");
  const featureOn = (p) => !!(appFeatures && PROVIDERS[p] && appFeatures[PROVIDERS[p].feature]);
  const anyFeature = () => featureOn("google") || featureOn("microsoft");
  const activeAccounts = () => (store.accounts || []).filter(a => a.status === "active");
  const myId = () => (currentUser ? currentUser.id : null);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; };
  const refreshTimeline = () => { if(typeof refreshOpenTimeline === "function") refreshOpenTimeline(); };

  function friendly(e, fallback){
    if(e && e.status === 501) return "That isn't available in the demo.";
    return (e && e.message) || fallback || "Something went wrong. Please try again.";
  }

  function mailtoHref(to, subject, body, cc){
    const enc = (s) => encodeURIComponent(s).replace(/%40/g, "@");
    const params = [];
    if(cc && cc.length) params.push("cc=" + cc.map(enc).join(","));
    if(subject) params.push("subject=" + encodeURIComponent(subject));
    if(body) params.push("body=" + encodeURIComponent(body));
    return "mailto:" + (to || []).map(enc).join(",") + (params.length ? "?" + params.join("&") : "");
  }

  function parseAddresses(text){
    const parts = String(text || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const valid = [], invalid = [];
    parts.forEach(p => {
      const m = /<([^<>]+)>$/.exec(p);
      const addr = (m ? m[1] : p).toLowerCase();
      if(ADDRESS_RE.test(addr) && addr.length <= 254){ if(!valid.includes(addr)) valid.push(addr); }
      else invalid.push(p);
    });
    return { valid, invalid };
  }

  /* ============================================================
     Mailboxes (GET /api/email/accounts)
  ============================================================ */
  function loadAccounts(force){
    if(store.pending) return store.pending;
    if(!force && store.accounts && Date.now() - store.loadedAt < STALE_MS) return Promise.resolve(store.accounts);
    store.loading = true;
    store.error = null;
    renderProfileSection();
    store.pending = (async () => {
      try{
        const res = await api("/email/accounts");
        store.accounts = Array.isArray(res && res.accounts) ? res.accounts : [];
        store.unavailable = false;
      }catch(e){
        if(e && e.status === 501){ store.unavailable = true; store.accounts = []; }
        else{ store.error = friendly(e, "Couldn't load your mailboxes."); if(!store.accounts) store.accounts = null; }
      }finally{
        store.loadedAt = Date.now();
        store.loading = false;
        store.pending = null;
        renderProfileSection();
        refreshComposerAccounts();
      }
      return store.accounts || [];
    })();
    return store.pending;
  }

  function replaceAccount(acc){
    if(!acc || !store.accounts) return;
    const i = store.accounts.findIndex(a => a.id === acc.id);
    if(acc.status === "disconnected"){ if(i >= 0) store.accounts.splice(i, 1); }
    else if(i >= 0) store.accounts[i] = acc;
    else store.accounts.push(acc);
  }

  let refreshTimer = null;
  function refreshSoon(){
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadAccounts(true), 400);
  }

  async function connect(provider){
    if(store.connecting) return;
    store.connecting = provider;
    renderProfileSection();
    try{
      const res = await api("/email/oauth/start", { method:"POST", body:{ provider } });
      if(!res || typeof res.url !== "string" || !/^https?:\/\//.test(res.url)) throw new Error("The server didn't return a sign-in link.");
      window.location.assign(res.url);
      // If the browser stays here (navigation blocked), let the person try again.
      setTimeout(() => { if(store.connecting === provider){ store.connecting = null; renderProfileSection(); } }, 15000);
    }catch(e){
      store.connecting = null;
      renderProfileSection();
      notify("Couldn't start connecting " + providerLabel(provider), friendly(e));
    }
  }

  async function syncNow(account, opts){
    opts = opts || {};
    if(store.busy[account.id]) return;
    store.busy[account.id] = "sync";
    renderProfileSection();
    try{
      const res = await api("/email/accounts/" + encodeURIComponent(account.id) + "/sync", { method:"POST", body:{} });
      if(res && res.account) replaceAccount(res.account);
      const r = res && res.result;
      if(r && r.stored) refreshTimeline();
      if(!opts.quiet){
        if(!r) notify("Sync started", "The mailbox is already syncing. New emails appear in a moment.");
        else if(r.ok) notify("Mailbox synced", r.stored ? r.stored + (r.stored === 1 ? " email" : " emails") + " with your leads added." + (r.done ? "" : " Still catching up; the rest follows automatically.") : (r.done ? "No new emails with your leads." : "Still catching up; the rest follows automatically."));
        else notify("Sync didn't finish", r.error || "The CRM will keep trying automatically.");
      }
    }catch(e){
      if(!opts.quiet) notify("Couldn't sync " + account.email_address, friendly(e));
      if(e && (e.code === "reconnect_required" || e.status === 404)) refreshSoon();
    }finally{
      delete store.busy[account.id];
      renderProfileSection();
    }
  }

  async function disconnect(account){
    const ok = await confirmDialog("Disconnect " + account.email_address + "? The CRM stops reading this mailbox and deletes its access. Emails already on lead timelines stay there.", "Disconnect");
    if(!ok) return;
    store.busy[account.id] = "disconnect";
    renderProfileSection();
    try{
      const res = await api("/email/accounts/" + encodeURIComponent(account.id) + "/disconnect", { method:"POST", body:{} });
      if(store.accounts) store.accounts = store.accounts.filter(a => a.id !== account.id);
      notify("Mailbox disconnected", account.provider === "microsoft"
        ? "To remove the CRM completely, also remove it from the apps with access to your Microsoft account."
        : (res && res.revoked ? "Google access was revoked." : "The CRM's saved access was deleted."));
    }catch(e){
      notify("Couldn't disconnect", friendly(e));
    }finally{
      delete store.busy[account.id];
      renderProfileSection();
      refreshComposerAccounts();
    }
  }

  async function updateSettings(account, patch, input){
    if(patch.p_sharing === "team"){
      const ok = await confirmDialog("Share this mailbox with the team? Every email with a lead already synced from it becomes visible to your teammates, including emails you made private one by one.", "Share with team");
      if(!ok){ if(input) input.checked = false; return; }
    }
    store.busy[account.id] = "settings";
    renderProfileSection();
    try{
      const { error } = await sb.rpc("update_email_account_settings", Object.assign({ p_account: account.id }, patch));
      if(error) throw error;
      if(patch.p_sharing) account.sharing = patch.p_sharing;
      if(patch.p_sync_enabled !== undefined) account.sync_enabled = patch.p_sync_enabled;
      if(patch.p_sharing) refreshTimeline();
      notify(patch.p_sharing ? (patch.p_sharing === "team" ? "Shared with the team" : "Mailbox is private") : (patch.p_sync_enabled ? "Syncing turned on" : "Syncing paused"),
        patch.p_sharing === "private" ? "Emails from this mailbox are now visible only to you." : "");
    }catch(e){
      notify("Setting not saved", (typeof friendlyDbError === "function" ? friendlyDbError(e) : "") || friendly(e));
    }finally{
      delete store.busy[account.id];
      renderProfileSection();
      refreshSoon();
    }
  }

  /* ============================================================
     Profile page: "Email accounts"
  ============================================================ */
  let lastRenderKey = "";

  function accountStatus(a){
    if(a.status === "reconnect_required") return { dot:"bad", text:"Needs reconnecting" };
    if(a.status === "error") return { dot:"bad", text:"Not syncing" };
    if(a.status === "disconnected") return { dot:"", text:"Disconnected" };
    if(!a.sync_enabled) return { dot:"", text:"Sync paused" };
    if(store.busy[a.id] === "sync" || a.syncing) return { dot:"ok", text:"Syncing…" };
    if(a.last_error) return { dot:"warn", text:"Last sync had a problem, retrying automatically" };
    if(!a.initial_sync_done) return { dot:"ok", text:"First sync in progress: emails from the last 30 days are on their way" };
    return { dot:"ok", text: a.last_synced_at ? "Synced " + relTime(a.last_synced_at) : "Waiting for the first sync" };
  }

  function switchRow(id, label, help, checked, disabled, onChange){
    const row = el("div", "setting-row");
    row.innerHTML = `<div><div class="setting-label" id="${id}-label">${escapeHtml(label)}</div><div class="setting-help">${escapeHtml(help)}</div></div>
      <label class="switch"><input type="checkbox" id="${id}" aria-labelledby="${id}-label" data-always-enabled="true"${checked ? " checked" : ""}${disabled ? " disabled" : ""}><span class="slider"></span></label>`;
    row.querySelector("input").addEventListener("change", (e) => onChange(e.target.checked, e.target));
    return row;
  }

  function button(label, cls, onClick, opts){
    opts = opts || {};
    const b = el("button", "btn btn-sm " + (cls || ""));
    b.type = "button";
    b.textContent = label;
    if(opts.always) b.dataset.alwaysEnabled = "true";
    if(opts.disabled) b.disabled = true;
    if(opts.busy) b.innerHTML = '<span class="email-spinner" aria-hidden="true"></span>' + escapeHtml(label);
    b.addEventListener("click", onClick);
    return b;
  }

  function renderAccount(a){
    const st = accountStatus(a);
    const busy = store.busy[a.id];
    const box = el("div", "email-account");
    box.dataset.id = a.id;
    const name = a.display_name && a.display_name.toLowerCase() !== a.email_address ? `<span class="email-account-name">${escapeHtml(a.display_name)}</span>` : "";
    box.innerHTML = `
      <div class="email-account-head">
        <div class="email-account-id">
          <span class="email-provider">${escapeHtml(providerLabel(a.provider))}</span>
          <span class="email-account-address">${escapeHtml(a.email_address)}</span>${name}
        </div>
        <div class="email-account-actions"></div>
      </div>
      <div class="email-account-status"><span class="status-dot ${st.dot}" aria-hidden="true"></span>${escapeHtml(st.text)}</div>
      ${a.last_error && a.status !== "disconnected" ? `<div class="email-account-error">${escapeHtml(a.last_error)}</div>` : ""}`;
    const actions = box.querySelector(".email-account-actions");
    if(!isViewer() && a.status === "active" && a.sync_enabled){
      actions.appendChild(button(busy === "sync" ? "Syncing…" : "Sync now", "", () => syncNow(a), { disabled: !!busy, busy: busy === "sync" }));
    }
    if(!isViewer() && (a.status === "reconnect_required" || a.status === "error")){
      actions.appendChild(button(store.connecting === a.provider ? "Opening…" : "Reconnect", "btn-primary", () => connect(a.provider),
        { disabled: !!busy || !!store.connecting || !featureOn(a.provider), busy: store.connecting === a.provider }));
    }
    actions.appendChild(button(busy === "disconnect" ? "Disconnecting…" : "Disconnect", "btn-ghost", () => disconnect(a), { always: true, disabled: !!busy, busy: busy === "disconnect" }));

    if(a.status !== "disconnected"){
      const settings = el("div", "email-account-settings");
      settings.appendChild(switchRow("email-share-" + a.id, "Share emails with the team",
        a.sharing === "team"
          ? "On: your teammates see emails between you and your leads on the leads' timelines."
          : "Off (private): only you see this mailbox's emails in the CRM. Teammates don't even see that they exist.",
        a.sharing === "team", !!busy, (on, input) => updateSettings(a, { p_sharing: on ? "team" : "private" }, input)));
      if(!isViewer()){
        settings.appendChild(switchRow("email-sync-" + a.id, "Sync this mailbox",
          "Off pauses syncing; emails already in the CRM stay there.", a.sync_enabled, !!busy || a.status !== "active",
          (on) => updateSettings(a, { p_sync_enabled: on })));
      }
      box.appendChild(settings);
    }
    return box;
  }

  function renderConnect(panel){
    const wrap = el("div", "email-connect");
    const accounts = store.accounts || [];
    if(isDemo()){
      wrap.innerHTML = '<div class="email-state">Mailboxes can\'t be connected in the demo. In the real CRM you connect Gmail or Outlook here.</div>';
    } else if(isViewer()){
      wrap.innerHTML = '<div class="email-state">Viewers can\'t connect mailboxes. Ask the CRM owner for editor access if you need your emails in the CRM.</div>';
    } else if(!anyFeature()){
      wrap.innerHTML = '<div class="email-state email-state-setup"><b>Email isn\'t set up yet.</b> The CRM owner needs to add the Google and/or Microsoft app credentials on the server before mailboxes can be connected.</div>';
    } else {
      const buttons = el("div", "email-connect-buttons");
      ["google", "microsoft"].forEach(p => {
        if(!featureOn(p)) return;
        const connecting = store.connecting === p;
        const b = el("button", "btn btn-icon" + (accounts.length ? "" : " btn-primary"));
        b.type = "button";
        b.disabled = !!store.connecting;
        b.innerHTML = (connecting ? '<span class="email-spinner" aria-hidden="true"></span>' : `<svg viewBox="0 0 24 24" aria-hidden="true">${MAIL_ICON}</svg>`) +
          escapeHtml(connecting ? "Opening " + providerLabel(p) + "…" : "Connect " + providerLabel(p));
        b.addEventListener("click", () => connect(p));
        buttons.appendChild(b);
      });
      wrap.appendChild(buttons);
      const missing = ["google", "microsoft"].filter(p => !featureOn(p)).map(providerLabel);
      wrap.appendChild(el("div", "email-note", escapeHtml(
        "You'll be sent to " + (featureOn("google") && featureOn("microsoft") ? "Google or Microsoft" : featureOn("google") ? "Google" : "Microsoft") +
        " to allow access, then brought back here. Only emails that involve one of your leads are copied into the CRM." +
        (missing.length ? " " + missing.join(" and ") + " isn't set up on the server yet." : ""))));
    }
    panel.appendChild(wrap);
  }

  function renderProfileSection(){
    const host = document.getElementById("profile-email-section");
    if(!host || !currentUser) return;
    const key = JSON.stringify([store.accounts, store.loading, store.error, store.busy, store.connecting, isDemo(), currentRole, appFeatures && appFeatures.gmail, appFeatures && appFeatures.outlook]);
    if(key === lastRenderKey && host.firstChild) return;
    lastRenderKey = key;

    host.innerHTML = "";
    const panel = el("section", "panel feature-panel email-panel");
    panel.setAttribute("aria-labelledby", "email-panel-title");
    panel.innerHTML = `<div class="panel-head"><h3 id="email-panel-title">Email accounts</h3><span class="panel-sub">Gmail and Outlook</span></div>
      <p class="panel-sub email-intro">Connect your work mailbox: emails between you and your leads show up on their timelines, and you can email leads straight from the CRM.</p>`;
    const list = el("div", "email-accounts");
    list.setAttribute("aria-live", "polite");
    if(store.accounts === null && store.loading){
      list.innerHTML = '<div class="email-state"><span class="email-spinner" aria-hidden="true"></span>Loading your mailboxes…</div>';
    } else if(store.error && !store.accounts){
      list.innerHTML = `<div class="email-state email-state-error">Couldn't load your mailboxes: ${escapeHtml(store.error)} <button type="button" class="panel-link" data-always-enabled="true">Try again</button></div>`;
      list.querySelector("button").addEventListener("click", () => loadAccounts(true));
    } else if(store.accounts && store.accounts.length){
      store.accounts.forEach(a => list.appendChild(renderAccount(a)));
      if(store.error) list.appendChild(el("div", "email-state email-state-error", escapeHtml("Couldn't refresh: " + store.error)));
    } else if(store.accounts && !isDemo() && !isViewer() && anyFeature()){
      list.innerHTML = '<div class="empty-note">No mailbox connected yet.</div>';
    }
    panel.appendChild(list);
    renderConnect(panel);
    host.appendChild(panel);
    if(typeof applyRolePermissions === "function") applyRolePermissions();
  }

  /* ============================================================
     Shared modal plumbing (composer + viewer)
  ============================================================ */
  const openModals = [];

  function makeOverlay(id, inner){
    const overlay = el("div", "modal-overlay email-overlay hidden");
    overlay.id = id;
    overlay.innerHTML = inner;
    // Before the confirm dialog, so "Discard?" prompts appear on top of us.
    const confirmEl = document.getElementById("confirm-overlay");
    if(confirmEl && confirmEl.parentNode === document.body) document.body.insertBefore(overlay, confirmEl);
    else document.body.appendChild(overlay);
    return overlay;
  }

  function showModal(m){
    m.returnFocus = document.activeElement;
    m.overlay.classList.remove("hidden");
    if(!openModals.includes(m)) openModals.push(m);
  }
  function hideModal(m){
    m.overlay.classList.add("hidden");
    const i = openModals.indexOf(m);
    if(i >= 0) openModals.splice(i, 1);
    if(m.returnFocus && typeof m.returnFocus.focus === "function" && document.body.contains(m.returnFocus)) m.returnFocus.focus();
  }

  // Escape closes only our top-most dialog, not the record underneath it.
  window.addEventListener("keydown", (e) => {
    if(e.key !== "Escape" || !openModals.length) return;
    const confirmEl = document.getElementById("confirm-overlay");
    if(confirmEl && !confirmEl.classList.contains("hidden")) return;
    e.stopPropagation();
    e.preventDefault();
    openModals[openModals.length - 1].requestClose();
  }, true);

  /* ============================================================
     Composer
  ============================================================ */
  let composer = null;

  function buildComposer(){
    const overlay = makeOverlay("email-composer-overlay", `
      <div class="task-modal email-composer" role="dialog" aria-modal="true" aria-labelledby="email-composer-title">
        <div class="task-modal-head">
          <h3 id="email-composer-title">New email</h3>
          <span class="task-modal-close" data-act="close" role="button" tabindex="0" aria-label="Close">&times;</span>
        </div>
        <div class="task-modal-body">
          <div class="email-blocked hidden"></div>
          <form class="email-fields" novalidate autocomplete="off">
            <div class="tm-field"><label for="ec-from">From</label><select id="ec-from"></select></div>
            <div class="tm-field"><label for="ec-to">To</label><input id="ec-to" type="text" inputmode="email" spellcheck="false" placeholder="name@company.com" /></div>
            <div class="tm-field"><label for="ec-cc">Cc</label><input id="ec-cc" type="text" inputmode="email" spellcheck="false" placeholder="Optional" /></div>
            <div class="tm-field"><label for="ec-subject">Subject</label><input id="ec-subject" type="text" maxlength="998" /></div>
            <div class="tm-field"><label for="ec-body">Message</label><textarea id="ec-body" rows="10"></textarea></div>
            <div class="email-reply-note hidden"></div>
            <div class="email-form-error hidden" role="alert"></div>
          </form>
        </div>
        <div class="task-modal-foot">
          <a class="btn email-mailto hidden" target="_blank" rel="noopener">Open in my email app</a>
          <div class="email-foot-spacer"></div>
          <button class="btn btn-ghost" type="button" data-act="cancel">Cancel</button>
          <button class="btn btn-primary" type="button" data-act="send">Send</button>
        </div>
      </div>`);
    const q = (s) => overlay.querySelector(s);
    const m = {
      overlay,
      from: q("#ec-from"), to: q("#ec-to"), cc: q("#ec-cc"), subject: q("#ec-subject"), body: q("#ec-body"),
      blocked: q(".email-blocked"), fields: q(".email-fields"), error: q(".email-form-error"), note: q(".email-reply-note"),
      send: q('[data-act="send"]'), mailto: q(".email-mailto"), title: q("#email-composer-title"),
      draft: null,
      requestClose: () => closeComposer(false),
    };
    q('[data-act="close"]').addEventListener("click", () => closeComposer(false));
    q('[data-act="close"]').addEventListener("keydown", (e) => { if(e.key === "Enter" || e.key === " ") closeComposer(false); });
    q('[data-act="cancel"]').addEventListener("click", () => closeComposer(false));
    m.send.addEventListener("click", sendDraft);
    m.fields.addEventListener("submit", (e) => { e.preventDefault(); });
    overlay.addEventListener("mousedown", (e) => { if(e.target === overlay) closeComposer(false); });
    [m.to, m.cc, m.subject, m.body].forEach(i => i.addEventListener("input", () => { if(m.draft) m.draft.dirty = true; updateMailto(); clearError(); }));
    [m.to, m.cc, m.subject].forEach(i => i.addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); } }));
    m.body.addEventListener("keydown", (e) => { if(e.key === "Enter" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); sendDraft(); } });
    return m;
  }

  function clearError(){ if(composer){ composer.error.classList.add("hidden"); composer.error.innerHTML = ""; } }
  function showError(html){ composer.error.innerHTML = html; composer.error.classList.remove("hidden"); }

  function updateMailto(){
    if(!composer) return;
    const to = parseAddresses(composer.to.value).valid;
    composer.mailto.href = mailtoHref(to, composer.subject.value, composer.body.value, parseAddresses(composer.cc.value).valid);
  }

  function setSendLabel(){
    const m = composer;
    if(!m.draft) return;
    const reason = m.draft.blockedReason;
    // Nothing to send with: no Send button at all (the reason and the alternatives are shown instead).
    m.send.classList.toggle("hidden", !!reason && reason !== "loading");
    m.send.disabled = !!m.draft.sending || !!reason;
    m.send.innerHTML = m.draft.sending ? '<span class="email-spinner" aria-hidden="true"></span>Sending…' : escapeHtml(m.draft.unconfirmed ? "Send again" : "Send");
  }

  function goToProfile(){
    closeComposer(true);
    if(typeof closeRecordModal === "function") closeRecordModal();
    if(typeof closeTaskViewModal === "function") closeTaskViewModal();
    switchTab("profile");
    const sec = document.getElementById("profile-email-section");
    if(sec && sec.scrollIntoView) sec.scrollIntoView({ behavior:"smooth", block:"start" });
  }

  // What the composer can do right now: null (send) or why not.
  function blockedReason(){
    if(isDemo()) return "demo";
    if(isViewer()) return "viewer";
    if(store.accounts === null) return store.error ? "error" : "loading";
    if(activeAccounts().length) return null;
    if((store.accounts || []).some(a => a.status === "reconnect_required" || a.status === "error")) return "reconnect";
    return anyFeature() ? "none" : "setup";
  }

  function refreshComposerAccounts(){
    const m = composer;
    if(!m || !m.draft || m.overlay.classList.contains("hidden")) return;
    const reason = blockedReason();
    m.draft.blockedReason = reason;
    const accounts = activeAccounts();
    const keep = m.from.value || m.draft.preferredAccount;
    m.from.innerHTML = accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml((a.display_name ? a.display_name + " <" + a.email_address + ">" : a.email_address) + " (" + providerLabel(a.provider) + ")")}</option>`).join("");
    if(keep && accounts.some(a => a.id === keep)) m.from.value = keep;
    m.from.closest(".tm-field").classList.toggle("hidden", accounts.length < 2);

    const msgs = {
      loading: '<span class="email-spinner" aria-hidden="true"></span>Loading your mailboxes…',
      error: "Couldn't load your mailboxes: " + escapeHtml(store.error || "") + ' <button type="button" class="panel-link" data-act="retry">Try again</button>',
      demo: "Sending email from the CRM isn't available in the demo. You can still open the email in your own email app.",
      viewer: "Viewers can't send email from the CRM. You can open it in your own email app instead.",
      setup: "Sending from the CRM isn't set up yet (the CRM owner needs to add the Gmail or Outlook app credentials). You can open it in your own email app instead.",
      reconnect: 'Your mailbox needs to be reconnected before you can send from the CRM. <button type="button" class="panel-link" data-act="profile">Reconnect on my Profile</button>',
      none: 'Connect your Gmail or Outlook mailbox to send email from the CRM, so it shows on the lead\'s timeline. <button type="button" class="panel-link" data-act="profile">Connect a mailbox</button>',
    };
    m.blocked.classList.toggle("hidden", !reason);
    m.blocked.innerHTML = reason ? msgs[reason] : "";
    const retry = m.blocked.querySelector('[data-act="retry"]');
    if(retry) retry.addEventListener("click", () => loadAccounts(true));
    const prof = m.blocked.querySelector('[data-act="profile"]');
    if(prof) prof.addEventListener("click", goToProfile);
    m.mailto.classList.toggle("hidden", !reason || reason === "loading");
    updateMailto();
    setSendLabel();
  }

  function normalizeMessage(x){
    if(!x) return null;
    return {
      id: x.id,
      account_id: x.account_id || null,
      owner_user_id: x.owner_user_id || null,
      direction: x.direction,
      from_address: x.from_address || "",
      from_name: x.from_name || "",
      to: x.to || x.to_addresses || [],
      cc: x.cc || x.cc_addresses || [],
      subject: x.subject || "",
    };
  }

  async function messageFor(activity){
    if(!activity) return null;
    const id = activity.emailMessageId || (activity.email && activity.email.id);
    if(activity.email && activity.email.id) return normalizeMessage(activity.email);
    if(!id) return null;
    try{
      const { data } = await sb.from("email_messages").select("id,account_id,owner_user_id,direction,from_address,from_name,to_addresses,cc_addresses,subject").eq("id", id).maybeSingle();
      return normalizeMessage(data);
    }catch(e){ return null; }
  }

  async function openComposer(opts){
    opts = opts || {};
    if(!composer) composer = buildComposer();
    const m = composer;
    if(m.draft && m.draft.sending){ showModal(m); return; }
    if(m.draft && m.draft.dirty && !m.overlay.classList.contains("hidden")){
      if(!(await confirmDialog("Discard the email you're writing?", "Discard"))) return;
    }
    const toList = Array.isArray(opts.to) ? opts.to : (opts.to ? [opts.to] : []);
    m.draft = {
      clientRequestId: newId(),
      contactId: opts.contactId || null,
      replyToMessageId: null,
      preferredAccount: null,
      dirty: false,
      sending: false,
      unconfirmed: false,
      blockedReason: null,
    };
    m.to.value = toList.filter(Boolean).join(", ");
    m.cc.value = "";
    m.subject.value = opts.subject || "";
    m.body.value = opts.body || "";
    m.title.textContent = opts.replyTo ? "Reply" : "New email";
    m.note.classList.add("hidden");
    clearError();
    showModal(m);
    refreshComposerAccounts();
    if(store.accounts === null || Date.now() - store.loadedAt > STALE_MS) loadAccounts(true);

    if(opts.replyTo){
      const draft = m.draft;
      const msg = opts.message ? normalizeMessage(opts.message) : await messageFor(opts.replyTo);
      if(m.draft !== draft) return; // replaced meanwhile
      if(msg){
        const mine = (store.accounts || []).map(a => a.email_address);
        const to = msg.direction === "inbound" ? [msg.from_address] : msg.to.map(x => x && x.email).filter(e => e && !mine.includes(e));
        if(!m.to.value) m.to.value = to.filter(Boolean).join(", ");
        const subj = msg.subject || "";
        if(!m.subject.value) m.subject.value = /^re\s*:/i.test(subj) ? subj : "Re: " + subj;
        draft.replyToMessageId = msg.id;
        draft.contactId = draft.contactId || opts.replyTo.contactId || null;
        if(msg.account_id && msg.owner_user_id === myId()) draft.preferredAccount = msg.account_id;
        m.note.textContent = "Replying to " + (msg.direction === "inbound" ? (msg.from_name || msg.from_address) : "your email") + (subj ? ": " + subj : "");
        m.note.classList.remove("hidden");
        refreshComposerAccounts();
      } else {
        showError("The email you're replying to isn't available, so this will be sent as a new email.");
      }
    }
    updateMailto();
    setTimeout(() => {
      const target = !m.draft.blockedReason ? (m.to.value ? (m.subject.value ? m.body : m.subject) : m.to) : m.overlay.querySelector('[data-act="cancel"]');
      if(target && target.focus) target.focus();
    }, 30);
  }

  async function closeComposer(force){
    const m = composer;
    if(!m || m.overlay.classList.contains("hidden")) return;
    if(!force && m.draft && m.draft.sending) return; // wait for the server's answer
    if(!force && m.draft && m.draft.dirty && !m.draft.blockedReason){
      if(!(await confirmDialog("Discard the email you're writing?", "Discard"))) return;
    }
    hideModal(m);
    m.draft = null;
  }

  async function sendDraft(){
    const m = composer;
    const d = m && m.draft;
    if(!d || d.sending || d.blockedReason) return;
    clearError();
    const to = parseAddresses(m.to.value);
    const cc = parseAddresses(m.cc.value);
    const bad = to.invalid.concat(cc.invalid);
    if(bad.length){ showError(escapeHtml("“" + bad[0] + "” isn't a valid email address.")); (to.invalid.length ? m.to : m.cc).focus(); return; }
    if(!to.valid.length){ showError("Add at least one recipient."); m.to.focus(); return; }
    if(to.valid.length + cc.valid.length > 50){ showError("At most 50 recipients per email."); return; }
    if(!m.subject.value.trim() && !m.body.value.trim()){ showError("Write a subject or a message."); m.subject.focus(); return; }
    if(d.unconfirmed){
      if(!(await confirmDialog("Send this email again? If the first attempt did go out, the recipients will get it twice.", "Send again"))) return;
      d.clientRequestId = newId();
      d.unconfirmed = false;
    }
    d.sending = true;
    setSendLabel();
    try{
      await api("/email/send", { method:"POST", body:{
        clientRequestId: d.clientRequestId,
        accountId: m.from.value || null,
        to: to.valid, cc: cc.valid,
        subject: m.subject.value.trim(),
        bodyText: m.body.value,
        contactId: d.contactId,
        replyToMessageId: d.replyToMessageId,
      }});
      d.sending = false;
      closeComposer(true);
      notify("Email sent", "To " + to.valid.join(", "));
      refreshTimeline();
    }catch(e){
      if(m.draft !== d) return;
      d.sending = false;
      const code = e && e.code;
      if(e && e.status === 501){ d.blockedReason = "demo"; refreshComposerAccounts(); }
      else if(code === "reconnect_required" || code === "no_mailbox" || code === "mailbox_unavailable"){
        showError(escapeHtml(e.message) + ' <button type="button" class="panel-link" data-act="profile">Go to my Profile</button>');
        const b = m.error.querySelector('[data-act="profile"]');
        if(b) b.addEventListener("click", goToProfile);
        refreshSoon();
      } else if(code === "send_unconfirmed"){
        d.unconfirmed = true;
        showError(escapeHtml(e.message));
      } else if(code === "send_in_progress"){
        showError("This email is still being sent. Give it a moment, then check the lead's timeline.");
      } else {
        showError(escapeHtml(friendly(e, "The email wasn't sent. Please try again.")));
      }
      setSendLabel();
    }
  }

  /* ============================================================
     Viewer
  ============================================================ */
  let viewer = null;

  function buildViewer(){
    const overlay = makeOverlay("email-viewer-overlay", `
      <div class="task-modal wide email-viewer" role="dialog" aria-modal="true" aria-labelledby="email-viewer-title">
        <div class="task-modal-head">
          <h3 id="email-viewer-title">Email</h3>
          <span class="task-modal-close" data-act="close" role="button" tabindex="0" aria-label="Close">&times;</span>
        </div>
        <div class="task-modal-body">
          <div class="email-viewer-state" aria-live="polite"></div>
          <div class="email-viewer-content hidden">
            <dl class="email-headers"></dl>
            <div class="email-flags"></div>
            <div class="email-images-bar hidden">
              <span>Remote images are hidden to protect your privacy.</span>
              <button type="button" class="btn btn-sm" data-act="images" data-always-enabled="true">Show images</button>
            </div>
            <iframe class="email-frame hidden" title="Email content" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>
            <div class="email-text hidden"></div>
            <div class="email-visibility hidden"></div>
          </div>
        </div>
        <div class="task-modal-foot">
          <span class="email-viewer-source"></span>
          <div class="email-foot-spacer"></div>
          <button class="btn btn-ghost" type="button" data-act="close-btn">Close</button>
          <button class="btn btn-primary hidden" type="button" data-act="reply">Reply</button>
        </div>
      </div>`);
    const q = (s) => overlay.querySelector(s);
    const v = {
      overlay, title: q("#email-viewer-title"), state: q(".email-viewer-state"), content: q(".email-viewer-content"),
      headers: q(".email-headers"), flags: q(".email-flags"), imagesBar: q(".email-images-bar"), frame: q(".email-frame"),
      text: q(".email-text"), visibility: q(".email-visibility"), reply: q('[data-act="reply"]'), source: q(".email-viewer-source"),
      current: null, seq: 0,
      requestClose: () => closeViewer(),
    };
    q('[data-act="close"]').addEventListener("click", closeViewer);
    q('[data-act="close"]').addEventListener("keydown", (e) => { if(e.key === "Enter" || e.key === " ") closeViewer(); });
    q('[data-act="close-btn"]').addEventListener("click", closeViewer);
    overlay.addEventListener("mousedown", (e) => { if(e.target === overlay) closeViewer(); });
    q('[data-act="images"]').addEventListener("click", () => { if(v.current){ v.current.showImages = true; drawBody(); } });
    v.reply.addEventListener("click", () => {
      const cur = v.current;
      if(!cur) return;
      closeViewer();
      openComposer({ replyTo: cur.activity, message: cur.msg });
    });
    return v;
  }

  function closeViewer(){
    if(!viewer || viewer.overlay.classList.contains("hidden")) return;
    hideModal(viewer);
    viewer.frame.removeAttribute("srcdoc");
    viewer.current = null;
    viewer.seq++;
  }

  // The email document inside the sandboxed frame. Its own CSP blocks every
  // network load (remote images included) unless the person allowed images.
  function srcdoc(html, showImages){
    const csp = "default-src 'none'; img-src " + (showImages ? "https: http: data: cid:" : "data: cid:") +
      "; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
      '<meta name="referrer" content="no-referrer"><base target="_blank">' +
      "<style>html,body{margin:0;padding:0;}body{padding:14px 16px;font:14px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;}" +
      "img{max-width:100%;height:auto;}table{max-width:100%;}pre{white-space:pre-wrap;}blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;}</style>" +
      "</head><body>" + html + "</body></html>";
  }

  const hasRemoteImages = (html) => /<img\b[^>]*\ssrc\s*=\s*["']?\s*https?:/i.test(html || "");

  function addressLine(list){
    return (list || []).filter(Boolean).map(a => a.name ? escapeHtml(a.name) + ' <span class="email-addr">&lt;' + escapeHtml(a.email) + "&gt;</span>" : escapeHtml(a.email)).join(", ");
  }

  function drawBody(){
    const v = viewer;
    const cur = v.current;
    const msg = cur.msg;
    if(msg.body_html){
      v.frame.classList.remove("hidden");
      v.text.classList.add("hidden");
      v.frame.setAttribute("srcdoc", srcdoc(msg.body_html, cur.showImages));
      v.imagesBar.classList.toggle("hidden", cur.showImages || !hasRemoteImages(msg.body_html));
    } else {
      v.frame.classList.add("hidden");
      v.frame.removeAttribute("srcdoc");
      v.imagesBar.classList.add("hidden");
      v.text.classList.remove("hidden");
      v.text.textContent = msg.body_text || msg.snippet || "(This email has no text.)";
    }
  }

  function drawFlags(){
    const v = viewer;
    const msg = v.current.msg;
    const flags = [];
    if(msg.visibility === "private") flags.push('<span class="tl-pill tl-pill-private">Private</span>');
    if(msg.has_attachments) flags.push(`<span class="email-flag">This email has attachments. Open it in ${escapeHtml(providerLabel(msg.provider))} to see them.</span>`);
    v.flags.innerHTML = flags.join(" ");
    v.flags.classList.toggle("hidden", !flags.length);
  }

  function drawVisibility(){
    const v = viewer;
    const cur = v.current;
    const msg = cur.msg;
    v.visibility.innerHTML = "";
    if(msg.owner_user_id !== myId()){ v.visibility.classList.add("hidden"); return; }
    v.visibility.classList.remove("hidden");
    const row = switchRow("email-private-" + msg.id, "Only visible to me",
      msg.visibility === "private"
        ? "Private: your teammates don't see this email. (If a teammate has the same email in their own shared mailbox, they still see their copy.)"
        : "Shared with the team. Turn on to hide this email from your teammates.",
      msg.visibility === "private", !!cur.saving, async (on, input) => {
        cur.saving = true;
        input.disabled = true;
        try{
          const { error } = await sb.rpc("set_email_visibility", { p_message: msg.id, p_visibility: on ? "private" : "team" });
          if(error) throw error;
          msg.visibility = on ? "private" : "team";
          notify(on ? "Email made private" : "Email shared with the team", "");
          refreshTimeline();
        }catch(e){
          input.checked = !on;
          notify("Couldn't change who can see this email", (typeof friendlyDbError === "function" ? friendlyDbError(e) : "") || friendly(e));
        }finally{
          cur.saving = false;
          if(viewer.current === cur){ drawFlags(); drawVisibility(); }
        }
      });
    v.visibility.appendChild(row);
  }

  async function openViewer(activity){
    if(!viewer) viewer = buildViewer();
    const v = viewer;
    const id = activity && (activity.emailMessageId || (activity.email && activity.email.id));
    const seq = ++v.seq;
    v.current = null;
    v.title.textContent = (activity && activity.subject) || "Email";
    v.content.classList.add("hidden");
    v.reply.classList.add("hidden");
    v.source.textContent = "";
    v.state.innerHTML = '<span class="email-spinner" aria-hidden="true"></span>Loading the email…';
    v.state.classList.remove("hidden");
    showModal(v);
    if(!id){ v.state.textContent = "This email isn't available any more."; return; }
    let data;
    try{
      const res = await sb.from("email_messages")
        .select("id,account_id,owner_user_id,provider,direction,from_address,from_name,to_addresses,cc_addresses,subject,snippet,body_text,body_html,has_attachments,sent_at,visibility")
        .eq("id", id).maybeSingle();
      if(res.error) throw res.error;
      data = res.data;
    }catch(e){
      if(seq !== v.seq) return;
      v.state.innerHTML = "Couldn't load the email: " + escapeHtml((typeof friendlyDbError === "function" ? friendlyDbError(e) : "") || friendly(e)) +
        ' <button type="button" class="panel-link" data-always-enabled="true">Try again</button>';
      v.state.querySelector("button").addEventListener("click", () => openViewer(activity));
      return;
    }
    if(seq !== v.seq) return;
    if(!data){
      v.state.textContent = isDemo() ? "Synced emails aren't available in the demo." : "This email isn't available. It may be private to the teammate whose mailbox it came from, or it was removed.";
      return;
    }
    v.current = { activity, msg: data, showImages: false, saving: false };
    v.state.classList.add("hidden");
    v.content.classList.remove("hidden");
    v.title.textContent = data.subject || "(no subject)";
    const from = data.from_address ? addressLine([{ email: data.from_address, name: data.from_name }]) : "";
    const rows = [["From", from], ["To", addressLine(data.to_addresses)], ["Cc", addressLine(data.cc_addresses)],
      ["Date", data.sent_at ? escapeHtml(typeof fmtDateTime === "function" ? fmtDateTime(data.sent_at) : new Date(data.sent_at).toLocaleString()) : ""]];
    v.headers.innerHTML = rows.filter(r => r[1]).map(r => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join("");
    drawFlags();
    const owner = data.owner_user_id === myId() ? "your" : ((typeof personName === "function" && personName(data.owner_user_id)) ? personName(data.owner_user_id) + "'s" : "a teammate's");
    v.source.textContent = (data.direction === "outbound" ? "Sent" : "Received") + " · from " + owner + " " + providerLabel(data.provider) + " mailbox";
    v.reply.classList.toggle("hidden", isViewer());
    drawBody();
    drawVisibility();
  }

  /* ============================================================
     Entry points on records and tasks
  ============================================================ */
  function emailButton(contact){
    const label = '<svg viewBox="0 0 24 24" aria-hidden="true">' + MAIL_ICON + "</svg>Email";
    if(isViewer()){
      // Viewers can't send from the CRM; their own email app still works.
      const a = el("a", "btn btn-sm btn-icon email-action", label);
      a.href = mailtoHref([contact.email]);
      a.dataset.alwaysEnabled = "true";
      a.title = "Email " + contact.email + " from your email app";
      return a;
    }
    const b = el("button", "btn btn-sm btn-icon email-action", label);
    b.type = "button";
    b.dataset.alwaysEnabled = "true";
    b.title = "Email " + contact.email;
    b.addEventListener("click", () => openComposer({ to: contact.email, contactId: contact.id }));
    return b;
  }

  CRMHooks.on("record:actions", (kind, record) => {
    if(!record) return null;
    let contact = null;
    if(kind === "contact") contact = record;
    else if(kind === "deal" && record.contactId) contact = contactById(record.contactId);
    if(!contact || !contact.email || !ADDRESS_RE.test(String(contact.email).trim())) return null;
    return emailButton({ id: contact.id, email: String(contact.email).trim() });
  });

  CRMHooks.on("task:actions", (task, lead) => {
    if(!lead || !lead.email || !ADDRESS_RE.test(String(lead.email).trim())) return null;
    return emailButton({ id: lead.id, email: String(lead.email).trim() });
  });

  /* ============================================================
     App lifecycle
  ============================================================ */
  CRMHooks.on("app:ready", () => {
    lastRenderKey = "";
    store.accounts = null;
    store.busy = {};
    loadAccounts(true);
  });

  CRMHooks.on("profile:render", () => {
    renderProfileSection();
    if(currentUser && !store.loading && (store.accounts === null || Date.now() - store.loadedAt > STALE_MS)) loadAccounts();
  });

  CRMHooks.on("realtime:channel", (channel) => {
    if(!currentUser || !channel || typeof channel.on !== "function") return;
    channel.on("postgres_changes", { event:"*", schema:"public", table:"email_accounts", filter:"user_id=eq." + currentUser.id }, refreshSoon);
  });

  CRMHooks.on("app:deeplink", (params) => {
    const connected = params.get("email_connected");
    const failed = params.get("email_error");
    if(!connected && !failed) return false;
    switchTab("profile");
    if(connected){
      notify("Mailbox connected", providerLabel(connected) + " is connected. Emails with your leads from the last 30 days appear on their timelines over the next few minutes.");
      loadAccounts(true).then(accounts => {
        (accounts || []).filter(a => a.provider === connected && a.status === "active" && a.sync_enabled && !a.initial_sync_done)
          .forEach(a => syncNow(a, { quiet: true }));
      });
    } else {
      notify("Mailbox not connected", OAUTH_ERRORS[failed] || "Something went wrong while connecting. Please try again.");
    }
    return true;
  });

  window.EmailUI = Object.assign(window.EmailUI || {}, {
    openComposer,
    openViewer,
    // For tests and other modules.
    _state: store,
    _reload: () => loadAccounts(true),
  });
})();
