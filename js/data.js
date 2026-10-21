/* ============================================================
   DATA LAYER
   The screens work on the in-memory `state` (camelCase records, the same
   shape the CRM always had). This file is the only place that knows how
   that state maps to the Supabase tables:

     loadAppState()      reads every table into `state`
     saveState()         saves only the records that changed since the last
                         save or remote update (debounced), so two people
                         editing different records never overwrite each other
     subscribeRealtime() applies other people's changes as they happen

   Row level security decides what each person may read and write; viewers
   never write (saveState() returns early and the database refuses anyway).
   Loaded before js/app.js; everything here is only called after login.
============================================================ */
const nz = v => (v === "" || v === undefined ? null : v);
const isUuid = v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isoOrNull = v => { if(!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

// How many of the newest activities the dashboard keeps in memory. Each
// record's full timeline is paged from the server (js/timeline.js).
const ACTIVITY_WINDOW = 300;

// Order matters: parents are saved before the records that point at them.
const DATA_TABLES = [
  {
    coll: "companies", table: "companies",
    toRow: (c, ws) => ({
      id: c.id, workspace_id: ws, name: c.name || "Unnamed company",
      industry: nz(c.industry), website: nz(c.website), phone: nz(c.phone), city: nz(c.city), notes: nz(c.notes),
    }),
    fromRow: r => ({
      id: r.id, name: r.name || "", industry: r.industry || "", website: r.website || "", phone: r.phone || "",
      city: r.city || "", notes: r.notes || "", createdAt: r.created_at, legacyId: r.legacy_id || null,
    }),
  },
  {
    coll: "contacts", table: "contacts",
    toRow: (c, ws) => ({
      id: c.id, workspace_id: ws, first_name: c.firstName || "", last_name: nz(c.lastName), email: nz(c.email),
      phone: nz(c.phone), title: nz(c.title), company_id: nz(c.companyId), status: c.status || "lead",
      owner_id: nz(c.ownerId), source: nz(c.source), notes: nz(c.notes),
    }),
    fromRow: r => ({
      id: r.id, firstName: r.first_name || "", lastName: r.last_name || "", email: r.email || "", phone: r.phone || "",
      title: r.title || "", companyId: r.company_id || "", status: r.status || "lead", ownerId: r.owner_id || "",
      source: r.source || "", notes: r.notes || "", lastActivityAt: isoOrNull(r.last_activity_at),
      createdAt: r.created_at, legacyId: r.legacy_id || null,
    }),
  },
  {
    coll: "deals", table: "deals",
    toRow: (d, ws) => ({
      id: d.id, workspace_id: ws, title: d.title || "Untitled deal", company_id: nz(d.companyId), contact_id: nz(d.contactId),
      value: Math.max(0, Number(d.value) || 0), stage: d.stage || "lead", owner_id: nz(d.ownerId),
      close_date: nz(d.closeDate), closed_at: nz(d.closedAt), notes: nz(d.notes),
    }),
    fromRow: r => {
      const d = {
        id: r.id, title: r.title || "", companyId: r.company_id || "", contactId: r.contact_id || "",
        value: Number(r.value) || 0, stage: r.stage || "lead", ownerId: r.owner_id || "", closeDate: r.close_date || "",
        notes: r.notes || "", createdAt: r.created_at, legacyId: r.legacy_id || null,
      };
      if(r.closed_at) d.closedAt = r.closed_at;
      return d;
    },
  },
  {
    coll: "board", table: "tasks",
    toRow: (t, ws) => ({
      id: t.id, workspace_id: ws, title: t.title || "Untitled task", workstream: t.workstream || "General",
      status: t.column || "todo", due_date: nz(t.dueDate), due_time: t.dueTime ? String(t.dueTime).slice(0, 5) : null,
      reminder: t.reminder || "none", priority: t.priority || "none", assigned_to: nz(t.assignedTo),
      deal_id: nz(t.dealId), contact_id: nz(t.contactId), notes: nz(t.notes),
    }),
    fromRow: r => ({
      id: r.id, title: r.title || "", workstream: r.workstream || "General", column: r.status || "todo",
      dueDate: r.due_date || null, dueTime: r.due_time ? String(r.due_time).slice(0, 5) : null,
      reminder: r.reminder || "none", priority: r.priority || "none", assignedTo: r.assigned_to || null,
      dealId: r.deal_id || null, contactId: r.contact_id || null, notes: r.notes || "",
      completedAt: r.completed_at || null, assignedAt: r.assigned_at || null, assignedBy: r.assigned_by || null,
      createdBy: r.created_by || null, createdAt: r.created_at, legacyId: r.legacy_id || null,
    }),
  },
  {
    // Only hand-logged activities are saved from here. Emails, calls and task
    // events are written by the server and only ever read by the app.
    coll: "activities", table: "activities",
    tracked: a => (a.source || "manual") === "manual",
    toRow: (a, ws) => ({
      id: a.id, workspace_id: ws, type: a.type || "note", source: "manual", subject: a.subject || "", body: nz(a.body),
      occurred_at: isoOrNull(a.at) || new Date().toISOString(), contact_id: nz(a.contactId), company_id: nz(a.companyId),
      deal_id: nz(a.dealId), visibility: a.visibility === "private" ? "private" : "team",
      owner_user_id: a.visibility === "private" ? (a.ownerUserId || (currentUser && currentUser.id)) : null,
      meta: a.meta && typeof a.meta === "object" && !Array.isArray(a.meta) ? a.meta : {},
    }),
    fromRow: r => ({
      id: r.id, type: r.type, source: r.source || "manual", event: r.event || null, subject: r.subject || "",
      body: r.body || "", at: isoOrNull(r.occurred_at), by: r.actor_id || null, contactId: r.contact_id || "",
      companyId: r.company_id || "", dealId: r.deal_id || "", relatedContactIds: r.related_contact_ids || [],
      visibility: r.visibility || "team", ownerUserId: r.owner_user_id || null,
      emailMessageId: r.email_message_id || null, callId: r.call_id || null, taskId: r.task_id || null,
      meta: r.meta || {},
    }),
  },
];
const DATA_TABLE_BY_COLL = Object.fromEntries(DATA_TABLES.map(t => [t.coll, t]));

// What the database last confirmed for each tracked record: coll -> Map(id -> row JSON).
let syncedSnapshot = {};
const isTracked = (t, rec) => !t.tracked || t.tracked(rec);
const rowJson = (t, rec) => JSON.stringify(t.toRow(rec, currentWorkspace ? currentWorkspace.id : null));
const snapFor = t => (syncedSnapshot[t.coll] = syncedSnapshot[t.coll] || new Map());

function snapshotAll(){
  syncedSnapshot = {};
  DATA_TABLES.forEach(t => {
    const m = snapFor(t);
    state[t.coll].forEach(rec => { if(isTracked(t, rec)) m.set(rec.id, rowJson(t, rec)); });
  });
}

// PostgREST returns at most 1000 rows per request, so read in pages.
async function selectAll(table, build){
  const page = 1000;
  let out = [];
  for(let from = 0; ; from += page){
    const { data, error } = await build(sb.from(table).select("*")).range(from, from + page - 1);
    if(error) throw error;
    out = out.concat(data || []);
    if(!data || data.length < page) break;
  }
  return out;
}

async function loadAppState(){
  const ws = currentWorkspace.id;
  const next = seedState();
  try{
    const [wsRes, ...rows] = await Promise.all([
      sb.from("workspaces").select("settings").eq("id", ws).maybeSingle(),
      ...DATA_TABLES.map(t => t.coll === "activities"
        ? sb.from("activities").select("*").eq("workspace_id", ws).order("occurred_at", { ascending:false }).limit(ACTIVITY_WINDOW)
            .then(r => { if(r.error) throw r.error; return r.data || []; })
        : selectAll(t.table, q => q.eq("workspace_id", ws).order("created_at", { ascending:true }).order("id", { ascending:true }))),
    ]);
    if(wsRes && wsRes.error) throw wsRes.error;
    next.settings = { ...next.settings, ...((wsRes && wsRes.data && wsRes.data.settings) || {}) };
    DATA_TABLES.forEach((t, i) => { next[t.coll] = rows[i].map(t.fromRow); });
    state = next;
    snapshotAll();
    return true;
  }catch(e){
    console.error("Loading the CRM failed", e);
    state = next;
    snapshotAll();
    notify("Couldn't load the CRM", friendlyDbError(e) + " Reload the page to try again.");
    return false;
  }
}

// A brand-new CRM starts with a few welcome tasks, once.
async function seedWelcomeTasksIfNew(){
  if(currentRole !== "owner" || state.settings.seeded) return;
  const empty = DATA_TABLES.every(t => state[t.coll].length === 0);
  state.settings.seeded = true;
  if(empty){
    state.board = SEED_BOARD.map(t => ({ ...t, id: newId(), assignedTo: null, dueDate: null, dueTime: null, reminder: "none", priority: "none" }));
    saveState();
  }
  await saveSettings();
}

/* ---------- Saving ---------- */
let saveTimer = null;
let flushing = false, flushQueued = false, retryDelayMs = 2000, offlineNotified = false;

function saveState(){
  if(currentRole === "viewer" || !currentWorkspace) return; // viewers never write
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 300);
}

function pendingChanges(){
  const plan = [];
  DATA_TABLES.forEach(t => {
    const snap = snapFor(t);
    const upserts = [], seen = new Set();
    state[t.coll].forEach(rec => {
      if(!rec || !rec.id || !isTracked(t, rec)) return;
      seen.add(rec.id);
      const json = rowJson(t, rec);
      if(snap.get(rec.id) !== json) upserts.push({ id: rec.id, json });
    });
    const deletes = [...snap.keys()].filter(id => !seen.has(id));
    if(upserts.length || deletes.length) plan.push({ t, upserts, deletes });
  });
  return plan;
}
function hasPendingChanges(){ return pendingChanges().length > 0; }

async function flushState(){
  if(!currentWorkspace || currentRole === "viewer") return;
  if(flushing){ flushQueued = true; return; }
  flushing = true;
  const plan = pendingChanges();
  let failedTable = null;
  try{
    for(const { t, upserts } of plan){
      if(!upserts.length) continue;
      failedTable = t;
      for(let i = 0; i < upserts.length; i += 500){
        const chunk = upserts.slice(i, i + 500);
        const { error } = await sb.from(t.table).upsert(chunk.map(u => JSON.parse(u.json)), { onConflict: "id" });
        if(error) throw error;
        chunk.forEach(u => snapFor(t).set(u.id, u.json));
      }
    }
    for(const { t, deletes } of plan.slice().reverse()){
      if(!deletes.length) continue;
      failedTable = t;
      for(let i = 0; i < deletes.length; i += 200){
        const ids = deletes.slice(i, i + 200);
        const { error } = await sb.from(t.table).delete().in("id", ids);
        if(error) throw error;
        ids.forEach(id => snapFor(t).delete(id));
      }
    }
    retryDelayMs = 2000;
    if(offlineNotified){ offlineNotified = false; notify("Back online", "Your changes are saved."); }
  }catch(e){
    console.error("Save failed", e);
    if(isTransientError(e)){
      // Keep the change and try again shortly.
      if(!offlineNotified){ offlineNotified = true; notify("Change not saved yet", "Check your connection. The CRM keeps trying."); }
      setTimeout(saveState, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 60000);
    } else {
      // The database refused the change: show why and go back to what is saved.
      notify("Change not saved", friendlyDbError(e));
      if(failedTable) await reloadTable(failedTable);
      renderAll();
      if(typeof renderRecordRelated === "function" && openRecord.kind) renderRecordRelated();
      applyRolePermissions();
    }
  }finally{
    flushing = false;
    if(flushQueued){ flushQueued = false; saveState(); }
  }
}

async function reloadTable(t){
  try{
    const ws = currentWorkspace.id;
    const rows = t.coll === "activities"
      ? ((await sb.from("activities").select("*").eq("workspace_id", ws).order("occurred_at", { ascending:false }).limit(ACTIVITY_WINDOW)).data || [])
      : await selectAll(t.table, q => q.eq("workspace_id", ws).order("created_at", { ascending:true }).order("id", { ascending:true }));
    state[t.coll] = rows.map(t.fromRow);
    const m = new Map();
    state[t.coll].forEach(rec => { if(isTracked(t, rec)) m.set(rec.id, rowJson(t, rec)); });
    syncedSnapshot[t.coll] = m;
  }catch(e){ console.error("Reload failed", e); }
}

function isTransientError(e){
  if(!e) return false;
  const code = e.code || "";
  if(/^[0-9A-Z]{5}$/.test(code) || /^PGRST/.test(code)) return false; // Postgres / PostgREST said no
  return true; // network failure, timeout, gateway error
}

function friendlyDbError(e){
  const code = (e && e.code) || "";
  if(code === "42501") return "You don't have permission to make that change.";
  if(code === "23514" || code === "22001") return "One of the fields is too long or not valid.";
  if(code === "23503") return "It refers to a record that was just deleted by someone else.";
  if(code === "23505") return "That record already exists.";
  if(code === "22P02" || code === "22007" || code === "22008") return "One of the values isn't in the right format.";
  return (e && e.message) || "Unknown error.";
}

// Workspace settings (currency, calling options...) are owner-only.
async function saveSettings(){
  if(currentRole !== "owner" || !currentWorkspace) return;
  const { error } = await sb.from("workspaces").update({ settings: state.settings }).eq("id", currentWorkspace.id);
  if(error){ console.error("Settings not saved", error); notify("Setting not saved", friendlyDbError(error)); }
}

// The team's time zone (used for reminder emails) is recorded by the first
// person with edit rights to open the CRM, as before.
async function ensureTeamTimezone(){
  if(state.settings.timezone || currentRole === "viewer") return;
  let tz;
  try{ tz = Intl.DateTimeFormat().resolvedOptions().timeZone; }catch(e){ return; }
  if(!tz) return;
  const { error } = await sb.rpc("ensure_workspace_timezone", { p_workspace: currentWorkspace.id, p_timezone: tz });
  if(!error) state.settings.timezone = tz;
}

/* ---------- Realtime ---------- */
let realtimeChannels = [];
let remoteRenderTimer = null;

function subscribeRealtime(){
  realtimeChannels.forEach(ch => { try{ sb.removeChannel(ch); }catch(e){} });
  const wsId = currentWorkspace.id;
  const data = sb.channel("crm-data-" + wsId);
  DATA_TABLES.forEach(t => {
    ["INSERT", "UPDATE"].forEach(ev => data.on("postgres_changes",
      { event: ev, schema: "public", table: t.table, filter: "workspace_id=eq." + wsId },
      payload => applyRemoteChange(t, payload)));
    // Supabase can't filter delete events; they only carry the id.
    data.on("postgres_changes", { event: "DELETE", schema: "public", table: t.table }, payload => applyRemoteChange(t, payload));
  });
  data.on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspaces", filter: "id=eq." + wsId }, payload => {
    if(payload.new && payload.new.settings) state.settings = { ...seedState().settings, ...payload.new.settings };
    scheduleRemoteRender("settings");
  });
  // Feature modules add their own listeners before the channel opens.
  CRMHooks.emit("realtime:channel", data, wsId);
  data.subscribe();

  const members = sb.channel("members-" + wsId)
    .on("postgres_changes", { event:"*", schema:"public", table:"workspace_members", filter:"workspace_id=eq." + wsId }, async () => {
      await fetchTeam();
      const me = teamList.find(p => currentUser && p.id === currentUser.id);
      if(!me){ notify("Access removed", "You no longer have access to the CRM."); await fetchMyWorkspaces(); return afterWorkspacesLoaded(); }
      if(me.role !== memberRole){ memberRole = me.role; setEffectiveRole(); renderWhoAmI(); }
      renderAll(); applyRolePermissions();
    })
    .subscribe();
  realtimeChannels = [data, members];
}

function applyRemoteChange(t, payload){
  if(!currentWorkspace) return;
  const list = state[t.coll];
  const snap = snapFor(t);
  if(payload.eventType === "DELETE"){
    const id = payload.old && payload.old.id;
    if(!id) return;
    const i = list.findIndex(r => r.id === id);
    if(i >= 0) list.splice(i, 1);
    snap.delete(id);
    scheduleRemoteRender(t.coll);
    return;
  }
  const row = payload.new;
  if(!row || row.workspace_id !== currentWorkspace.id) return;
  const rec = t.fromRow(row);
  const i = list.findIndex(r => r.id === rec.id);
  if(i >= 0){
    const local = list[i];
    const pendingLocal = isTracked(t, local) && snap.has(rec.id) && snap.get(rec.id) !== rowJson(t, local);
    if(pendingLocal){
      // Our own unsaved edit wins locally; the next save sends it.
      snap.set(rec.id, rowJson(t, rec));
      saveState();
    } else {
      list[i] = rec;
      if(isTracked(t, rec)) snap.set(rec.id, rowJson(t, rec));
    }
  } else {
    if(t.coll === "activities"){
      list.unshift(rec);
      if(list.length > ACTIVITY_WINDOW + 50){
        list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        list.splice(ACTIVITY_WINDOW).forEach(old => snap.delete(old.id));
      }
    } else {
      list.push(rec);
    }
    if(isTracked(t, rec)) snap.set(rec.id, rowJson(t, rec));
  }
  scheduleRemoteRender(t.coll);
}

function scheduleRemoteRender(coll){
  clearTimeout(remoteRenderTimer);
  remoteRenderTimer = setTimeout(() => {
    renderAll();
    if(openRecord.kind && !document.getElementById("record-modal-overlay").classList.contains("hidden")) renderRecordRelated();
    applyRolePermissions();
    CRMHooks.emit("data:changed", coll);
  }, 60);
}

// Drops records from the screen without asking the database to delete them
// (for rows the database removes itself, e.g. a deleted lead's notes).
function forgetLocalRecords(coll, predicate){
  const t = DATA_TABLE_BY_COLL[coll];
  const snap = snapFor(t);
  state[coll] = state[coll].filter(rec => {
    if(!predicate(rec)) return true;
    snap.delete(rec.id);
    return false;
  });
}

/* ---------- Imports ---------- */
// Backups made before records had UUIDs use ids like "c1". Give such records
// fresh ids and repoint every reference to them.
function normalizeImportedIds(s){
  const maps = { companies: new Map(), contacts: new Map(), deals: new Map(), board: new Map(), activities: new Map() };
  Object.keys(maps).forEach(coll => {
    s[coll] = (s[coll] || []).filter(r => r && typeof r === "object");
    s[coll].forEach(r => { const id = isUuid(r.id) ? r.id : newId(); maps[coll].set(String(r.id), id); r.id = id; });
  });
  const ref = (coll, v) => (v ? (maps[coll].get(String(v)) || (isUuid(v) ? v : "")) : "");
  const person = v => (isUuid(v) && teamList.some(p => p.id === v) ? v : "");
  s.contacts.forEach(c => { c.companyId = ref("companies", c.companyId); c.ownerId = person(c.ownerId); });
  s.deals.forEach(d => { d.companyId = ref("companies", d.companyId); d.contactId = ref("contacts", d.contactId); d.ownerId = person(d.ownerId); });
  s.board.forEach(t => { t.dealId = ref("deals", t.dealId) || null; t.contactId = ref("contacts", t.contactId) || null; t.assignedTo = person(t.assignedTo) || null; });
  s.activities = s.activities.filter(a => (a.source || "manual") === "manual");
  s.activities.forEach(a => { a.contactId = ref("contacts", a.contactId); a.companyId = ref("companies", a.companyId); a.dealId = ref("deals", a.dealId); });
  return s;
}
