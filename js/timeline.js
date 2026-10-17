/* ============================================================
   UNIFIED ACTIVITY TIMELINE
   One chronological list on every contact (lead), company and deal:
   emails, calls, task changes, notes and meetings. The list comes from the
   get_timeline() database function, which applies row level security, so
   private emails only ever reach their mailbox owner. It refreshes when
   activities change (js/data.js forwards realtime events).

   Other modules add actions to items without touching this file:
     EmailUI.openViewer(item) / EmailUI.openComposer({ replyTo })   js/email.js
     DialerUI.playRecording(callId, container)                      js/dialer.js
     DialerUI.openDisposition(callId)                               js/dialer.js
============================================================ */
const TASK_ICON = '<path d="M9 11l2 2 4-4"/><rect x="3" y="3" width="18" height="18" rx="3"/>';
const LOCK_ICON = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';
const TIMELINE_FILTERS = [
  { id:"all", label:"All", types:null },
  { id:"email", label:"Emails", types:["email"] },
  { id:"call", label:"Calls", types:["call"] },
  { id:"task", label:"Tasks", types:["task"] },
  { id:"note", label:"Notes & meetings", types:["note", "meeting"] },
];
const TIMELINE_PAGE = 30;
const CALL_DISPOSITIONS = {
  connected:"Connected", left_voicemail:"Left voicemail", no_answer:"No answer", busy:"Busy",
  wrong_number:"Wrong number", not_interested:"Not interested", callback_requested:"Call back", other:"Other",
};
const CALL_STATUS_LABELS = {
  initiated:"Dialling", ringing:"Ringing", "in-progress":"In progress", completed:"Completed",
  busy:"Busy", "no-answer":"No answer", failed:"Failed", canceled:"Cancelled",
};

// The open record's timeline: { kind, id, filter, items, cursor, done, loading, error, seq }
let timelineView = null;

function fmtDuration(sec){
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
function fmtDateTime(iso){
  if(!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
}

// get_timeline() rows -> the activity shape the rest of the app uses.
function timelineRowToItem(r){
  const a = DATA_TABLE_BY_COLL.activities.fromRow(r);
  a.email = r.email || null;
  a.call = r.call || null;
  a.task = r.task || null;
  return a;
}

function renderTimelineSection(box, kind, id){
  const same = timelineView && timelineView.kind === kind && timelineView.id === id;
  // Keep whatever was being typed if the section is redrawn for the same record.
  const prevForm = same ? {
    type: (document.getElementById("act-type") || {}).value,
    subject: (document.getElementById("act-subject") || {}).value,
    body: (document.getElementById("act-body") || {}).value,
    priv: (document.getElementById("act-private") || {}).checked,
  } : null;

  const sec = document.createElement("section");
  sec.className = "timeline-section";
  sec.innerHTML = `
    <div class="panel-head" style="margin-bottom:6px;"><h4>Activity</h4><span class="panel-sub tl-live" title="Updates automatically">Live</span></div>
    <div class="log-form" id="log-form">
      <div class="tm-row">
        <div class="tm-field" style="flex:0 0 120px;"><select id="act-type" aria-label="Activity type">${ACTIVITY_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join("")}</select></div>
        <div class="tm-field"><input id="act-subject" type="text" maxlength="500" placeholder="What happened?" aria-label="Activity summary" /></div>
      </div>
      <div class="tm-field"><textarea id="act-body" maxlength="20000" placeholder="Details (optional)" aria-label="Activity details"></textarea></div>
      <div class="log-form-foot">
        <label class="tl-private-toggle"><input type="checkbox" id="act-private" /> Only visible to me</label>
        <button type="button" class="btn btn-primary" id="act-log-btn">Log activity</button>
      </div>
    </div>
    <div class="tl-filters" role="tablist" aria-label="Filter activity"></div>
    <div class="timeline" id="rm-timeline" aria-live="polite"></div>
    <div class="tl-more-wrap"><button type="button" class="btn btn-ghost tl-more hidden" data-always-enabled="true">Show older activity</button></div>`;
  box.appendChild(sec);

  if(prevForm){
    if(prevForm.type) sec.querySelector("#act-type").value = prevForm.type;
    sec.querySelector("#act-subject").value = prevForm.subject || "";
    sec.querySelector("#act-body").value = prevForm.body || "";
    sec.querySelector("#act-private").checked = !!prevForm.priv;
  }
  sec.querySelector("#act-log-btn").addEventListener("click", logActivityFromTimeline);
  sec.querySelector("#act-subject").addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); logActivityFromTimeline(); } });
  if(currentRole === "viewer") sec.querySelector("#log-form").classList.add("hidden");

  const filter = same ? timelineView.filter : "all";
  const chips = sec.querySelector(".tl-filters");
  TIMELINE_FILTERS.forEach(f => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tl-chip" + (f.id === filter ? " active" : "");
    b.dataset.alwaysEnabled = "true";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", f.id === filter ? "true" : "false");
    b.textContent = f.label;
    b.addEventListener("click", () => {
      if(!timelineView) return;
      timelineView.filter = f.id;
      chips.querySelectorAll(".tl-chip").forEach(c => { const on = c === b; c.classList.toggle("active", on); c.setAttribute("aria-selected", on ? "true" : "false"); });
      loadTimeline(true);
    });
    chips.appendChild(b);
  });
  sec.querySelector(".tl-more").addEventListener("click", () => loadTimeline(false));

  timelineView = same
    ? Object.assign(timelineView, { el: sec })
    : { kind, id, filter, items: [], cursor: null, done: false, loading: false, error: null, seq: 0, el: sec };
  // Show what we already have straight away, then refresh from the server.
  if(same && timelineView.items.length) drawTimeline();
  loadTimeline(true);
}

async function loadTimeline(reset){
  const view = timelineView;
  if(!view || !view.el) return;
  const seq = ++view.seq;
  const f = TIMELINE_FILTERS.find(x => x.id === view.filter) || TIMELINE_FILTERS[0];
  if(reset){ view.cursor = null; view.done = false; }
  view.loading = true;
  view.error = null;
  if(reset && !view.items.length) drawTimeline();
  try{
    const args = { p_kind: view.kind, p_id: view.id, p_limit: TIMELINE_PAGE, p_types: f.types };
    if(!reset && view.cursor){ args.p_before = view.cursor.at; args.p_before_id = view.cursor.id; }
    const { data, error } = await sb.rpc("get_timeline", args);
    if(error) throw error;
    if(timelineView !== view || seq !== view.seq) return; // a newer load replaced this one
    const items = (data || []).map(timelineRowToItem);
    view.done = items.length < TIMELINE_PAGE;
    const last = items[items.length - 1];
    // Hand-logged activities this browser already has always show, saved or
    // not: a page requested just before a save finished doesn't contain them
    // yet, and the realtime echo that would reload the list may never come
    // (e.g. right after sign-in, before the channel has joined).
    const local = state.activities.filter(a => a.source === "manual" && activityFilterFor(view.kind, view.id)(a) &&
      (!f.types || f.types.includes(a.type)) && !items.some(i => i.id === a.id) &&
      (view.done || !last || String(a.at) >= String(last.at)));
    const merged = reset ? local.concat(items) : view.items.concat(items);
    view.items = merged.filter((a, i) => merged.findIndex(b => b.id === a.id) === i);
    if(last) view.cursor = { at: last.at, id: last.id };
  }catch(e){
    if(timelineView !== view || seq !== view.seq) return;
    console.error("Timeline failed to load", e);
    view.error = friendlyDbError(e);
  }finally{
    if(timelineView === view && seq === view.seq){ view.loading = false; drawTimeline(); }
  }
}

function drawTimeline(){
  const view = timelineView;
  if(!view || !view.el) return;
  const list = view.el.querySelector("#rm-timeline");
  const more = view.el.querySelector(".tl-more");
  list.innerHTML = "";
  if(view.error && !view.items.length){
    list.innerHTML = `<div class="tl-state tl-error">Couldn't load the activity: ${escapeHtml(view.error)} <button type="button" class="panel-link" data-always-enabled="true">Try again</button></div>`;
    list.querySelector("button").addEventListener("click", () => loadTimeline(true));
  } else if(!view.items.length){
    list.innerHTML = view.loading
      ? '<div class="tl-state">Loading activity…</div>'
      : `<div class="empty-note">${view.filter === "all" ? "Nothing here yet. Emails, calls, tasks and notes for this record will appear here." : "No activity of this type yet."}</div>`;
  }
  view.items.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).forEach(a => list.appendChild(renderActivityItem(a, { withContext: view.kind !== "contact", openRecordOnClick: false })));
  more.classList.toggle("hidden", view.done || !view.items.length);
  more.disabled = !!view.loading;
  more.textContent = view.loading && view.items.length ? "Loading…" : "Show older activity";
}

// Remote changes redraw the open record (js/data.js calls renderRecordRelated),
// which reloads this list. Modules that change a timeline item themselves
// (a call outcome, an email made private) can ask for a refresh.
function refreshOpenTimeline(){
  if(timelineView && timelineView.el && document.body.contains(timelineView.el)) loadTimeline(true);
}

const logActivityFromTimeline = guardEdit(function(){
  const { kind, id } = openRecord;
  if(!kind || !id) return;
  const subjectEl = document.getElementById("act-subject");
  const subject = subjectEl.value.trim();
  if(!subject){ subjectEl.focus(); return; }
  logActivity(kind, id, {
    type: document.getElementById("act-type").value,
    subject,
    body: document.getElementById("act-body").value.trim(),
    visibility: document.getElementById("act-private").checked ? "private" : "team",
  });
  subjectEl.value = "";
  document.getElementById("act-body").value = "";
  document.getElementById("act-private").checked = false;
  if(timelineView){
    const a = state.activities[0];
    if(a && !timelineView.items.some(i => i.id === a.id)) timelineView.items.unshift(a);
    drawTimeline();
  }
});

/* ---------- One timeline item ---------- */
function activityIcon(type){
  if(type === "task") return TASK_ICON;
  const t = ACTIVITY_TYPES.find(x => x.id === type) || ACTIVITY_TYPES[3];
  return t.icon;
}

function addressLabel(list){
  return (list || []).map(x => x && (x.name || x.email)).filter(Boolean).slice(0, 3).join(", ");
}

function taskEventTitle(a){
  const m = a.meta || {};
  const title = a.subject || (a.task && a.task.title) || "Task";
  switch(a.event){
    case "created": return "Task created: " + title;
    case "completed": return "Task completed: " + title;
    case "reopened": return "Task reopened: " + title;
    case "started": return "Task started: " + title;
    case "moved": return "Task moved to " + ((COLUMNS.find(c => c.id === m.status) || {}).label || "To do") + ": " + title;
    case "assigned": return m.assigned_to ? `Task assigned to ${personName(m.assigned_to) || "a teammate"}: ${title}` : "Task unassigned: " + title;
    case "rescheduled": return (m.due_date ? `Task due ${fmtDay(m.due_date)}${m.due_time ? " " + String(m.due_time).slice(0, 5) : ""}: ` : "Due date removed: ") + title;
    case "deleted": return "Task deleted: " + title;
    default: return title;
  }
}

function renderActivityItem(a, opts){
  opts = opts || {};
  const item = document.createElement("div");
  item.className = "tl-item tl-" + (a.source === "manual" ? "manual" : a.source) + (a.visibility === "private" ? " tl-is-private" : "");
  item.dataset.id = a.id;
  const who = personName(a.by);
  const meta = a.meta || {};
  const parts = [];       // the grey line under the title
  let title = a.subject || "";
  let body = a.body || "";
  let badges = "";
  const actions = [];     // [label, handler]

  if(a.source === "email"){
    const e = a.email || {};
    const inbound = (e.direction || a.event) === "inbound";
    const from = e.from_name || e.from_address || meta.from_name || meta.from || "";
    const to = addressLabel(e.to || meta.to);
    title = a.subject || "(no subject)";
    parts.push(inbound ? "Email received" + (from ? " from " + from : "") : "Email sent" + (to ? " to " + to : ""));
    if(!inbound && who) parts.push("by " + who);
    if(e.has_attachments || meta.has_attachments) badges += '<span class="tl-pill">Attachment</span>';
    if(window.EmailUI && typeof EmailUI.openViewer === "function") actions.push(["Open", () => EmailUI.openViewer(a)]);
    if(window.EmailUI && typeof EmailUI.openComposer === "function" && currentRole !== "viewer" && (a.email || a.emailMessageId)){
      actions.push(["Reply", () => EmailUI.openComposer({ replyTo: a })]);
    }
  } else if(a.source === "call"){
    const c = a.call || {};
    const status = c.status || meta.status;
    const duration = c.duration_seconds != null ? c.duration_seconds : meta.duration_seconds;
    const disposition = c.disposition || meta.disposition;
    const isVoicemail = c.is_voicemail || meta.is_voicemail;
    title = isVoicemail ? "Voicemail" : ((c.direction || meta.direction) === "inbound" ? "Incoming call" : "Outgoing call");
    if(status && status !== "completed") parts.push(CALL_STATUS_LABELS[status] || status);
    if(duration) parts.push(fmtDuration(duration));
    if(who) parts.push(((c.direction || meta.direction) === "inbound" ? "answered by " : "by ") + who);
    const number = (c.direction || meta.direction) === "inbound" ? (c.from_number || meta.from) : (c.to_number || meta.to);
    if(number) parts.push(number);
    if(disposition) badges += `<span class="tl-pill tl-pill-disposition">${escapeHtml(CALL_DISPOSITIONS[disposition] || disposition)}</span>`;
    body = c.notes || a.body || "";
    const recordingAvailable = c.recording_available || meta.recording_available;
    if(recordingAvailable) badges += '<span class="tl-pill">Recorded</span>';
    if(recordingAvailable && window.DialerUI && typeof DialerUI.playRecording === "function"){
      actions.push(["Play recording", (ev, row) => DialerUI.playRecording(a.callId, row)]);
    }
    if(!disposition && currentRole !== "viewer" && window.DialerUI && typeof DialerUI.openDisposition === "function" && a.callId &&
       (!c.user_id || (currentUser && c.user_id === currentUser.id) || currentRole === "owner")){
      actions.push(["Add outcome", () => DialerUI.openDisposition(a.callId)]);
    }
  } else if(a.source === "task"){
    title = taskEventTitle(a);
    if(who) parts.push("by " + who);
    const t = a.task;
    if(t && a.event !== "deleted"){
      badges += `<span class="tl-pill">${escapeHtml((COLUMNS.find(c => c.id === t.status) || {}).label || t.status)}</span>`;
    }
    if(a.taskId && findRecord("board", a.taskId)) actions.push(["Open task", () => { closeRecordModal(); openTaskViewModal(a.taskId); }]);
    body = "";
  } else {
    const t = ACTIVITY_TYPES.find(x => x.id === a.type) || ACTIVITY_TYPES[3];
    parts.push(t.label);
    if(who) parts.push(who);
  }

  if(opts.withContext){
    const c = contactById(a.contactId), d = dealById(a.dealId), co = companyById(a.companyId);
    const ctx = [c ? contactName(c) : "", d ? d.title : (co ? co.name : "")].filter(Boolean).join(" · ");
    if(ctx) parts.push(ctx);
  }
  if(a.visibility === "private") badges += `<span class="tl-pill tl-pill-private" title="Only you can see this"><svg viewBox="0 0 24 24" aria-hidden="true">${LOCK_ICON}</svg>Private</span>`;

  const iconType = a.source === "task" ? "task" : a.type;
  item.innerHTML = `
    <div class="tl-icon t-${escapeHtml(iconType)}"><svg viewBox="0 0 24 24" aria-hidden="true">${activityIcon(iconType)}</svg></div>
    <div style="min-width:0;">
      <div class="tl-title">${escapeHtml(title)}${badges}</div>
      <div class="tl-meta"><span title="${escapeHtml(fmtDateTime(a.at))}">${relTime(a.at)}</span>${parts.length ? " · " + parts.map(escapeHtml).join(" · ") : ""}</div>
      ${body ? `<div class="tl-body">${escapeHtml(body)}</div>` : ""}
      <div class="tl-actions"></div>
      <div class="tl-extra"></div>
    </div>`;
  const actionsEl = item.querySelector(".tl-actions");
  const extra = item.querySelector(".tl-extra");
  actions.forEach(([label, fn]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "panel-link";
    b.dataset.alwaysEnabled = "true";
    b.textContent = label;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(ev, extra); });
    actionsEl.appendChild(b);
  });
  if(!actions.length) actionsEl.remove();

  // From the dashboard, an item opens the record it belongs to.
  if(opts.withContext && opts.openRecordOnClick !== false && (a.dealId || a.contactId)){
    item.classList.add("clickable");
    item.addEventListener("click", () => a.dealId && dealById(a.dealId) ? openRecordModal("deal", a.dealId) : (contactById(a.contactId) && openRecordModal("contact", a.contactId)));
  }
  return item;
}
