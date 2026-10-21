/* ============================================================
   SYSTEM STATUS (owner only, Team page)
   What the server has set up and whether background work is healthy:
   integrations configured, the every-minute scheduler, mailbox
   connections and recent background job failures. Reads
   GET /api/system/status, which never returns secret values.
============================================================ */
let systemStatusCache = null;   // { at, data } or { at, error }
let systemStatusLoading = false;

const INTEGRATION_LABELS = [
  ["gmail", "Gmail"], ["outlook", "Outlook"], ["notifications", "Notification emails"],
  ["calling", "Calling (Twilio)"], ["cron", "Scheduler secret"], ["tokenEncryption", "Token encryption key"],
];

async function loadSystemStatus(force){
  if(systemStatusLoading) return;
  if(!force && systemStatusCache && Date.now() - systemStatusCache.at < 60000) return;
  systemStatusLoading = true;
  drawSystemStatus();
  try{
    systemStatusCache = { at: Date.now(), data: await api("/system/status") };
  }catch(e){
    systemStatusCache = { at: Date.now(), error: e.status === 501 ? "demo" : (e.message || "Couldn't load the status") };
  }finally{
    systemStatusLoading = false;
    drawSystemStatus();
  }
}

function drawSystemStatus(){
  const host = document.getElementById("team-integrations-section");
  if(!host) return;
  let panel = document.getElementById("system-status-panel");
  if(currentRole !== "owner"){ if(panel) panel.remove(); return; }
  if(!panel){
    panel = document.createElement("div");
    panel.id = "system-status-panel";
    panel.className = "panel feature-panel";
    host.appendChild(panel);
  }
  const head = `<div class="panel-head"><h3>System status</h3><button type="button" class="panel-link" id="system-status-refresh" data-always-enabled="true">Refresh</button></div>`;
  const c = systemStatusCache;
  let body;
  if(!c || (systemStatusLoading && !c.data)){
    body = '<div class="empty-note">Checking…</div>';
  } else if(c.error === "demo"){
    body = '<div class="empty-note">Not available in the demo.</div>';
  } else if(c.error){
    body = `<div class="empty-note" style="color:var(--bad);">${escapeHtml(c.error)}</div>`;
  } else {
    const d = c.data;
    const f = d.features || {};
    const rows = INTEGRATION_LABELS.map(([k, label]) =>
      `<div class="setting-row"><div><div class="setting-label"><span class="status-dot ${f[k] ? "ok" : "warn"}"></span>${escapeHtml(label)}</div></div><div class="sub">${f[k] ? "Set up" : "Not set up"}</div></div>`).join("");
    const sch = d.scheduler || {};
    const job = (sch.jobs || []).find(j => j.name === "crm-tick");
    const last = (sch.lastRuns || [])[0];
    let schedState = "bad", schedText = "Not installed";
    if(sch.cron === "not installed"){ schedText = "pg_cron is not available"; }
    else if(sch.error){ schedText = "Unknown: " + sch.error; }
    else if(job && job.active && sch.configured !== false){
      schedState = last && last.status !== "succeeded" ? "warn" : "ok";
      schedText = "Runs every minute" + (last ? ` · last run ${relTime(last.start_time)} (${last.status})` : " · no runs yet");
    } else if(job && sch.configured === false){
      schedState = "warn"; schedText = "Installed, but the app address isn't configured (run npm run setup:cron)";
    }
    const mb = d.mailboxes || {};
    const mbText = Object.keys(mb).length ? Object.entries(mb).map(([s, n]) => `${n} ${s.replace(/_/g, " ")}`).join(", ") : "None connected";
    const problems = (d.recentJobProblems || []).slice(0, 5);
    body = rows +
      `<div class="setting-row"><div><div class="setting-label"><span class="status-dot ${schedState}"></span>Background work</div><div class="setting-help">Syncs mailboxes and sends notification emails.</div></div><div class="sub" style="text-align:right;">${escapeHtml(schedText)}</div></div>` +
      `<div class="setting-row"><div><div class="setting-label">Mailboxes</div></div><div class="sub">${escapeHtml(mbText)}</div></div>` +
      (problems.length
        ? `<div style="margin-top:10px;"><div class="setting-label" style="margin-bottom:4px;">Recent problems</div>${problems.map(p =>
            `<div class="sub" style="padding:3px 0;"><span class="status-dot ${p.status === "dead" ? "bad" : "warn"}"></span>${escapeHtml(p.kind)} · ${escapeHtml(p.status)} · ${relTime(p.updated_at)}${p.last_error ? " · " + escapeHtml(String(p.last_error).slice(0, 140)) : ""}</div>`).join("")}</div>`
        : '<div class="sub" style="margin-top:10px;">No recent background problems.</div>');
  }
  panel.innerHTML = head + body;
  const btn = panel.querySelector("#system-status-refresh");
  if(btn) btn.addEventListener("click", () => loadSystemStatus(true));
}

CRMHooks.on("team:render", () => { drawSystemStatus(); loadSystemStatus(false); });
