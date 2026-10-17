/* ============================================================
   DEMO MODE
   Without a Supabase project the CRM can run as a demo: the same screens
   and the same data layer (js/data.js), backed by an in-browser stand-in
   for the Supabase client. The automated app tests (tests/app/) run the
   CRM against this stand-in too, so it covers every table call, filter and
   RPC the app makes. Keep it in step when the app starts using new ones.

   It only imitates storage. Email sync, calling and notification emails
   need the real server; in the demo those screens say so.
============================================================ */
const DEMO_STORE_KEY = "brandigade-crm-demo-v4";
const DEMO_USER = { id:"demo-owner", email:"you@brandigade.com" };
const DEMO_WS = "ws-brandigade";

function isoDay(offsetDays){
  const d = new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0,10);
}
function isoAt(offsetDays, hour){
  const d = new Date(); d.setDate(d.getDate() + offsetDays); d.setHours(hour || 10, 0, 0, 0);
  return d.toISOString();
}

// The sample CRM, in the in-memory state shape. demoSeedStore() turns it into
// table rows with the same mapping the real app uses.
function demoState(){
  const s = seedState();
  s.companies = [
    {id:"co1", name:"Cedar & Crumb Bakery", industry:"Food & beverage", website:"cedarandcrumb.example", phone:"+1 415 555 0142", city:"San Francisco", notes:"Family-owned, 4 locations. Expanding into wholesale."},
    {id:"co2", name:"Northwind Realty", industry:"Real estate", website:"northwindrealty.example", phone:"+1 646 555 0187", city:"New York", notes:""},
    {id:"co3", name:"Lumen Health Clinics", industry:"Healthcare", website:"lumenhealth.example", phone:"+1 312 555 0119", city:"Chicago", notes:"Rebrand tied to opening of 3 new clinics."},
    {id:"co4", name:"Atlas Outdoor Co.", industry:"Retail", website:"atlasoutdoor.example", phone:"+1 303 555 0165", city:"Denver", notes:""},
    {id:"co5", name:"Kinfolk Coffee Roasters", industry:"Food & beverage", website:"kinfolkcoffee.example", phone:"+1 503 555 0133", city:"Portland", notes:"Packaging refresh for retail bags."},
    {id:"co6", name:"Brightpath Academy", industry:"Education", website:"brightpath.example", phone:"+1 512 555 0108", city:"Austin", notes:""},
  ];
  s.contacts = [
    {id:"c1", firstName:"Maya", lastName:"Rivera", email:"maya@cedarandcrumb.example", phone:"+1 415 555 0143", title:"Founder", companyId:"co1", status:"customer", ownerId:"demo-owner", source:"Referral", notes:"Prefers calls before 11am."},
    {id:"c2", firstName:"Daniel", lastName:"Okafor", email:"d.okafor@northwindrealty.example", phone:"+1 646 555 0188", title:"Marketing Director", companyId:"co2", status:"prospect", ownerId:"demo-sara", source:"Event", notes:""},
    {id:"c3", firstName:"Priya", lastName:"Shah", email:"priya.shah@lumenhealth.example", phone:"+1 312 555 0120", title:"VP Brand", companyId:"co3", status:"prospect", ownerId:"demo-owner", source:"Website", notes:"Decision by end of quarter."},
    {id:"c4", firstName:"Tom", lastName:"Becker", email:"tom@atlasoutdoor.example", phone:"+1 303 555 0166", title:"Head of E-commerce", companyId:"co4", status:"lead", ownerId:"demo-omar", source:"Outbound", notes:""},
    {id:"c5", firstName:"Hana", lastName:"Kim", email:"hana@kinfolkcoffee.example", phone:"+1 503 555 0134", title:"Co-owner", companyId:"co5", status:"customer", ownerId:"demo-sara", source:"Social media", notes:""},
    {id:"c6", firstName:"Leo", lastName:"Martins", email:"leo@brightpath.example", phone:"+1 512 555 0109", title:"Principal", companyId:"co6", status:"lead", ownerId:"demo-omar", source:"Referral", notes:""},
    {id:"c7", firstName:"Grace", lastName:"Liu", email:"grace.liu@lumenhealth.example", phone:"+1 312 555 0121", title:"Procurement", companyId:"co3", status:"prospect", ownerId:"demo-owner", source:"Website", notes:""},
    {id:"c8", firstName:"Sam", lastName:"Whitfield", email:"sam@northwindrealty.example", phone:"", title:"CEO", companyId:"co2", status:"inactive", ownerId:"demo-sara", source:"Event", notes:""},
  ];
  s.deals = [
    {id:"d1", title:"Wholesale packaging system", companyId:"co1", contactId:"c1", value:18500, stage:"negotiation", ownerId:"demo-owner", closeDate:isoDay(9), notes:"Scope: 6 SKUs, dieline + print management."},
    {id:"d2", title:"Brand identity refresh", companyId:"co2", contactId:"c2", value:42000, stage:"proposal", ownerId:"demo-sara", closeDate:isoDay(21), notes:""},
    {id:"d3", title:"Clinic launch campaign", companyId:"co3", contactId:"c3", value:65000, stage:"qualified", ownerId:"demo-owner", closeDate:isoDay(40), notes:"Three openings, staggered."},
    {id:"d4", title:"Website redesign", companyId:"co4", contactId:"c4", value:28000, stage:"lead", ownerId:"demo-omar", closeDate:isoDay(55), notes:""},
    {id:"d5", title:"Retail bag packaging", companyId:"co5", contactId:"c5", value:12400, stage:"won", ownerId:"demo-sara", closeDate:isoDay(-6), closedAt:isoDay(-6), notes:""},
    {id:"d6", title:"Social content retainer", companyId:"co1", contactId:"c1", value:9600, stage:"won", ownerId:"demo-owner", closeDate:isoDay(-40), closedAt:isoDay(-40), notes:"12-month retainer."},
    {id:"d7", title:"Enrolment brochure", companyId:"co6", contactId:"c6", value:6500, stage:"lead", ownerId:"demo-omar", closeDate:isoDay(28), notes:""},
    {id:"d8", title:"Signage wayfinding", companyId:"co3", contactId:"c7", value:21000, stage:"proposal", ownerId:"demo-owner", closeDate:isoDay(16), notes:""},
    {id:"d9", title:"Investor deck design", companyId:"co2", contactId:"c8", value:7800, stage:"lost", ownerId:"demo-sara", closeDate:isoDay(-20), closedAt:isoDay(-20), notes:"Went with in-house team."},
  ];
  s.activities = [
    {id:"a1", type:"meeting", source:"manual", subject:"Packaging review on site", body:"Walked through dielines. Maya wants a matte finish sample.", contactId:"c1", dealId:"d1", companyId:"co1", at:isoAt(-1, 15), by:"demo-owner"},
    {id:"a2", type:"email", source:"manual", subject:"Sent proposal v2", body:"Updated timeline and added the logo animation option.", contactId:"c2", dealId:"d2", companyId:"co2", at:isoAt(-2, 11), by:"demo-sara"},
    {id:"a3", type:"call", source:"manual", subject:"Discovery call", body:"Budget confirmed for Q4. Next: workshop with clinic managers.", contactId:"c3", dealId:"d3", companyId:"co3", at:isoAt(-3, 9), by:"demo-owner"},
    {id:"a4", type:"note", source:"manual", subject:"Competitor note", body:"Atlas is also talking to a Denver agency.", contactId:"c4", dealId:"d4", companyId:"co4", at:isoAt(-4, 16), by:"demo-omar"},
    {id:"a5", type:"email", source:"manual", subject:"Final artwork delivered", body:"", contactId:"c5", dealId:"d5", companyId:"co5", at:isoAt(-6, 14), by:"demo-sara"},
    {id:"a6", type:"call", source:"manual", subject:"Intro call", body:"Interested in a spring brochure.", contactId:"c6", dealId:"d7", companyId:"co6", at:isoAt(-8, 10), by:"demo-omar"},
  ];
  s.board = [
    {id:"b1", title:"Send matte finish samples to Cedar & Crumb", workstream:"Follow-up", column:"todo", dueDate:isoDay(1), dueTime:"10:00", reminder:"at_due", priority:"high", assignedTo:"demo-owner", dealId:"d1", contactId:"c1", notes:""},
    {id:"b2", title:"Chase Northwind on proposal feedback", workstream:"Call", column:"todo", dueDate:isoDay(-1), dueTime:"15:00", reminder:"none", priority:"medium", assignedTo:"demo-sara", dealId:"d2", contactId:"c2", notes:""},
    {id:"b3", title:"Prep clinic workshop agenda", workstream:"Meeting", column:"doing", dueDate:isoDay(4), dueTime:null, reminder:"none", priority:"medium", assignedTo:"demo-owner", dealId:"d3", contactId:"c3", notes:""},
    {id:"b4", title:"Draft signage cost estimate", workstream:"Proposal", column:"doing", dueDate:isoDay(6), dueTime:null, reminder:"none", priority:"low", assignedTo:"demo-owner", dealId:"d8", contactId:"c7", notes:""},
    {id:"b5", title:"Invoice Kinfolk for packaging", workstream:"Admin", column:"done", dueDate:isoDay(-3), dueTime:null, reminder:"none", priority:"none", assignedTo:"demo-sara", dealId:"d5", contactId:"c5", notes:""},
  ];
  s.settings = { currency:"USD", seeded:true };
  return s;
}

function demoSeedStore(){
  const now = new Date().toISOString();
  const ago = (days) => new Date(Date.now() - days*86400000).toISOString();
  const store = {
    profiles: [
      {id:"demo-owner", email:"you@brandigade.com", display_name:"You", avatar_data:null, is_platform_admin:true, created_at:ago(120)},
      {id:"demo-sara", email:"sara@brandigade.com", display_name:"Sara Malik", avatar_data:null, is_platform_admin:false, created_at:ago(110)},
      {id:"demo-omar", email:"omar@brandigade.com", display_name:"Omar Haddad", avatar_data:null, is_platform_admin:false, created_at:ago(90)},
      {id:"demo-lina", email:"lina@brandigade.com", display_name:null, avatar_data:null, is_platform_admin:false, created_at:ago(2)},
    ],
    workspaces: [
      {id:DEMO_WS, name:"Brandigade", status:"active", created_by:"demo-owner", created_at:ago(120), settings:{}},
    ],
    workspace_members: [
      {workspace_id:DEMO_WS, user_id:"demo-owner", role:"owner", invited:false, created_at:ago(120)},
      {workspace_id:DEMO_WS, user_id:"demo-sara", role:"editor", invited:false, created_at:ago(110)},
      {workspace_id:DEMO_WS, user_id:"demo-omar", role:"editor", invited:false, created_at:ago(90)},
      {workspace_id:DEMO_WS, user_id:"demo-lina", role:"viewer", invited:true, created_at:ago(2)},
    ],
  };
  const s = demoState();
  store.workspaces[0].settings = s.settings;
  DATA_TABLES.forEach(t => {
    store[t.table] = s[t.coll].map((rec, i) => {
      const row = t.toRow(rec, DEMO_WS);
      row.created_at = new Date(Date.now() - (120 - i) * 3600000).toISOString();
      if(t.table === "activities") row.actor_id = rec.by || null;
      return row;
    });
  });
  store.workspace_state = [];
  void now;
  return store;
}

function loadDemoStore(){
  try{
    const raw = window.localStorage.getItem(DEMO_STORE_KEY);
    if(raw){ const parsed = JSON.parse(raw); if(parsed && parsed.workspaces) return parsed; }
  }catch(e){}
  return demoSeedStore();
}
var demoStore; // var, not let: the client can be built before this line runs
function persistDemoStore(){
  if(!DEMO) return;
  try{ window.localStorage.setItem(DEMO_STORE_KEY, JSON.stringify(demoStore)); }catch(e){}
}

// An in-browser stand-in for the Supabase client.
//   opts.store  start from this store (tables of rows) instead of the demo data
//   opts.user   the signed-in user
function createDemoClient(opts){
  opts = opts || {};
  const store = demoStore = opts.store || loadDemoStore();
  const user = opts.user || DEMO_USER;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const err = (message, code) => ({ data:null, error:{ message, code: code || "DEMO" } });
  const nowIso = () => new Date().toISOString();
  const tableOf = (name) => (store[name] = store[name] || []);

  /* ----- realtime ----- */
  const listeners = [];
  function emit(table, eventType, row, old){
    listeners.slice().forEach(l => {
      if(l.table !== table || (l.event !== "*" && l.event !== eventType)) return;
      if(l.filter && eventType !== "DELETE"){
        const m = /^(\w+)=eq\.(.+)$/.exec(l.filter);
        if(m && String(row[m[1]]) !== m[2]) return;
      }
      const payload = { eventType, schema:"public", table, new: eventType === "DELETE" ? {} : clone(row), old: eventType === "DELETE" ? { id: old && old.id } : clone(old || {}) };
      setTimeout(() => { try{ l.cb(payload); }catch(e){ console.error(e); } }, 0);
    });
  }

  /* ----- what the database does on its own (defaults and triggers) ----- */
  function withDefaults(table, row){
    const r = clone(row);
    if(!r.id && table !== "workspace_members" && table !== "user_preferences") r.id = newId();
    if(!r.created_at) r.created_at = nowIso();
    r.updated_at = nowIso();
    if(table === "contacts"){
      r.email_normalized = r.email ? String(r.email).trim().toLowerCase() || null : null;
      r.phone_digits = r.phone ? String(r.phone).replace(/[^0-9]/g, "") || null : null;
      if(r.last_activity_at === undefined) r.last_activity_at = null;
    }
    if(table === "activities"){
      r.source = r.source || "manual";
      r.visibility = r.visibility || "team";
      r.related_contact_ids = r.related_contact_ids || [];
      r.meta = r.meta || {};
      if(r.source === "manual" && !r.actor_id) r.actor_id = user.id;
    }
    if(table === "tasks"){
      r.assignment_version = r.assigned_to ? 1 : 0;
      r.assigned_at = r.assigned_to ? nowIso() : null;
      r.assigned_by = r.assigned_to ? user.id : null;
      r.completed_at = r.status === "done" ? nowIso() : null;
      r.created_by = r.created_by || user.id;
    }
    return r;
  }
  function addActivity(row){
    const a = withDefaults("activities", row);
    tableOf("activities").push(a);
    emit("activities", "INSERT", a);
    touchContacts(a);
  }
  function touchContacts(a){
    if(a.visibility !== "team") return;
    const ids = [a.contact_id].concat(a.related_contact_ids || []).filter(Boolean);
    tableOf("contacts").forEach(c => {
      if(ids.includes(c.id) && (!c.last_activity_at || c.last_activity_at < a.occurred_at)){
        c.last_activity_at = a.occurred_at;
        emit("contacts", "UPDATE", c);
      }
    });
  }
  function taskLeadIds(t){
    let contact = t.contact_id || null;
    const deal = t.deal_id ? tableOf("deals").find(d => d.id === t.deal_id) : null;
    if(!contact && deal) contact = deal.contact_id || null;
    const c = contact ? tableOf("contacts").find(x => x.id === contact) : null;
    return { contact, company: (c && c.company_id) || (deal && deal.company_id) || null, deal: t.deal_id || null };
  }
  function taskEvents(op, oldRow, row){
    let events = [];
    if(op === "INSERT") events = ["created"];
    else if(op === "DELETE") events = ["deleted"];
    else {
      if(row.status !== oldRow.status) events.push(row.status === "done" ? "completed" : oldRow.status === "done" ? "reopened" : row.status === "doing" ? "started" : "moved");
      if(row.assigned_to !== oldRow.assigned_to) events.push("assigned");
      if(row.due_date !== oldRow.due_date || row.due_time !== oldRow.due_time) events.push("rescheduled");
    }
    const t = row || oldRow;
    const lead = taskLeadIds(t);
    events.forEach(ev => addActivity({
      workspace_id: t.workspace_id, type:"task", source:"task", event: ev, subject: t.title, occurred_at: nowIso(),
      actor_id: user.id, contact_id: lead.contact, company_id: lead.company, deal_id: lead.deal,
      task_id: op === "DELETE" ? null : t.id, meta: { task_id: t.id, status: t.status, due_date: t.due_date, assigned_to: t.assigned_to },
    }));
  }
  function afterWrite(table, op, oldRow, row){
    if(table === "tasks") taskEvents(op, oldRow, row);
    if(table === "activities" && op !== "DELETE") touchContacts(row);
  }

  /* ----- queries ----- */
  const embed = (table, row, cols) => {
    const out = clone(row);
    if(table === "workspace_members" && cols.includes("profiles(")) out.profiles = clone(tableOf("profiles").find(p => p.id === row.user_id) || null);
    if(table === "workspace_members" && cols.includes("workspaces(")){
      const ws = tableOf("workspaces").find(w => w.id === row.workspace_id);
      out.workspaces = ws ? clone(ws) : null;
    }
    return out;
  };
  function query(table){
    const q = { _filters:[], _op:"select", _cols:"*", _order:[], _limit:null, _range:null, _returning:false, _rows:null, _patch:null, _onConflict:"id" };
    q.select = (cols) => { if(q._op === "select") q._cols = cols || "*"; else q._returning = true; return q; };
    q.eq = (c, v) => { q._filters.push(r => r[c] === v); return q; };
    q.neq = (c, v) => { q._filters.push(r => r[c] !== v); return q; };
    q.in = (c, vals) => { q._filters.push(r => vals.includes(r[c])); return q; };
    q.is = (c, v) => { q._filters.push(r => (r[c] === undefined ? null : r[c]) === v); return q; };
    q.gt = (c, v) => { q._filters.push(r => r[c] > v); return q; };
    q.gte = (c, v) => { q._filters.push(r => r[c] >= v); return q; };
    q.lt = (c, v) => { q._filters.push(r => r[c] < v); return q; };
    q.lte = (c, v) => { q._filters.push(r => r[c] <= v); return q; };
    q.ilike = (c, v) => { const re = new RegExp("^" + String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i"); q._filters.push(r => re.test(String(r[c] || ""))); return q; };
    q.order = (c, o) => { q._order.push([c, !o || o.ascending !== false]); return q; };
    q.limit = (n) => { q._limit = n; return q; };
    q.range = (from, to) => { q._range = [from, to]; return q; };
    q.insert = (rows) => { q._op = "insert"; q._rows = [].concat(rows); return q; };
    q.upsert = (rows, o) => { q._op = "upsert"; q._rows = [].concat(rows); if(o && o.onConflict) q._onConflict = o.onConflict; return q; };
    q.update = (patch) => { q._op = "update"; q._patch = patch; return q; };
    q.delete = () => { q._op = "delete"; return q; };
    const match = () => tableOf(table).filter(r => q._filters.every(f => f(r)));
    const sortRows = (rows) => {
      if(!q._order.length) return rows;
      return rows.slice().sort((a, b) => {
        for(const [c, asc] of q._order){
          const x = a[c], y = b[c];
          if(x === y) continue;
          if(x == null) return 1;
          if(y == null) return -1;
          return (x > y ? 1 : -1) * (asc ? 1 : -1);
        }
        return 0;
      });
    };
    const run = () => {
      let changed = [];
      if(q._op === "insert" || q._op === "upsert"){
        for(const input of q._rows){
          const key = q._onConflict;
          const existing = q._op === "upsert" ? tableOf(table).find(r => key.split(",").every(k => r[k] === input[k])) : null;
          if(existing){
            const before = clone(existing);
            Object.assign(existing, clone(input), { updated_at: nowIso() });
            if(table === "contacts") Object.assign(existing, withDefaults("contacts", existing), { created_at: before.created_at, id: before.id });
            if(table === "tasks" && existing.assigned_to !== before.assigned_to){
              existing.assignment_version = (before.assignment_version || 0) + 1;
              existing.assigned_at = existing.assigned_to ? nowIso() : null;
              existing.assigned_by = existing.assigned_to ? user.id : null;
            }
            if(table === "tasks") existing.completed_at = existing.status === "done" ? (before.status === "done" ? before.completed_at : nowIso()) : null;
            changed.push(existing);
            emit(table, "UPDATE", existing, before);
            afterWrite(table, "UPDATE", before, existing);
          } else {
            if(table === "workspace_members" && tableOf(table).some(r => r.workspace_id === input.workspace_id && r.user_id === input.user_id)) return err("duplicate key value", "23505");
            const row = withDefaults(table, input);
            tableOf(table).push(row);
            changed.push(row);
            emit(table, "INSERT", row);
            afterWrite(table, "INSERT", null, row);
          }
        }
        persistDemoStore();
        return { data: q._returning ? changed.map(r => clone(r)) : null, error:null };
      }
      let rows = match();
      if(q._op === "update"){
        rows.forEach(r => {
          const before = clone(r);
          Object.assign(r, clone(q._patch), { updated_at: nowIso() });
          emit(table, "UPDATE", r, before);
          afterWrite(table, "UPDATE", before, r);
        });
        persistDemoStore();
        return { data: q._returning ? rows.map(r => clone(r)) : null, error:null };
      }
      if(q._op === "delete"){
        store[table] = tableOf(table).filter(r => !rows.includes(r));
        rows.forEach(r => {
          emit(table, "DELETE", null, r);
          afterWrite(table, "DELETE", r, null);
          // the database's delete_record_notes trigger
          if(table === "contacts" || table === "deals"){
            const own = a => a.source === "manual" && (table === "contacts" ? (a.contact_id === r.id && !a.deal_id) : (a.deal_id === r.id && !a.contact_id));
            tableOf("activities").filter(own).forEach(a => emit("activities", "DELETE", null, a));
            store.activities = tableOf("activities").filter(a => !own(a));
          }
          // the database's ON DELETE SET NULL
          const refs = { companies:["company_id"], contacts:["contact_id"], deals:["deal_id"], tasks:["task_id"] }[table] || [];
          refs.forEach(col => ["contacts", "deals", "tasks", "activities", "calls"].forEach(t2 => tableOf(t2).forEach(x => { if(x[col] === r.id) x[col] = null; })));
        });
        persistDemoStore();
        return { data: q._returning ? rows.map(r => clone(r)) : null, error:null };
      }
      rows = sortRows(rows);
      if(q._range) rows = rows.slice(q._range[0], q._range[1] + 1);
      if(q._limit != null) rows = rows.slice(0, q._limit);
      return { data: rows.map(r => embed(table, r, q._cols)), error:null };
    };
    q.single = () => { const r = run(); return Promise.resolve(r.error ? r : (r.data && r.data.length ? { data:r.data[0], error:null } : err("No rows", "PGRST116"))); };
    q.maybeSingle = () => { const r = run(); return Promise.resolve(r.error ? r : { data:(r.data && r.data[0]) || null, error:null }); };
    q.then = (resolve, reject) => Promise.resolve().then(run).then(resolve, reject);
    return q;
  }

  /* ----- functions (RPC) ----- */
  function getTimeline(a){
    const contacts = tableOf("contacts");
    const inKind = (x) => {
      if(a.p_kind === "contact") return x.contact_id === a.p_id || (x.related_contact_ids || []).includes(a.p_id);
      if(a.p_kind === "company"){
        const ids = contacts.filter(c => c.company_id === a.p_id).map(c => c.id);
        return x.company_id === a.p_id || ids.includes(x.contact_id) || (x.related_contact_ids || []).some(id => ids.includes(id));
      }
      if(a.p_kind === "deal"){
        const d = tableOf("deals").find(z => z.id === a.p_id);
        return x.deal_id === a.p_id || (!!(d && d.contact_id) && (x.contact_id === d.contact_id || (x.related_contact_ids || []).includes(d.contact_id)));
      }
      return a.p_kind === "workspace";
    };
    let rows = tableOf("activities").filter(x => (x.visibility === "team" || x.owner_user_id === user.id) && inKind(x));
    if(a.p_types && a.p_types.length) rows = rows.filter(x => a.p_types.includes(x.type));
    rows.sort((x, y) => (x.occurred_at === y.occurred_at ? (x.id < y.id ? 1 : -1) : (x.occurred_at < y.occurred_at ? 1 : -1)));
    if(a.p_before) rows = rows.filter(x => x.occurred_at < a.p_before || (a.p_before_id && x.occurred_at === a.p_before && x.id < a.p_before_id));
    rows = rows.slice(0, Math.min(Math.max(a.p_limit || 50, 1), 200));
    return rows.map(x => {
      const out = clone(x);
      const t = x.task_id ? tableOf("tasks").find(z => z.id === x.task_id) : null;
      out.task = t ? { id:t.id, title:t.title, status:t.status, due_date:t.due_date, due_time:t.due_time, assigned_to:t.assigned_to, priority:t.priority } : null;
      out.email = null;
      out.call = null;
      return out;
    });
  }
  async function rpc(name, args){
    args = args || {};
    if(name === "get_timeline") return { data: getTimeline(args), error:null };
    if(name === "ensure_workspace_timezone"){
      const ws = tableOf("workspaces").find(w => w.id === args.p_workspace);
      if(ws){ ws.settings = ws.settings || {}; if(!ws.settings.timezone) ws.settings.timezone = args.p_timezone; persistDemoStore(); }
      return { data:null, error:null };
    }
    if(name === "can_play_recording") return { data:false, error:null };
    return err("That needs the CRM server, which the demo doesn't have.");
  }

  /* ----- the CRM's own server API (api/index.ts) ----- */
  async function demoApi(path, o){
    o = o || {};
    if(path === "/config") return { features: { gmail:false, outlook:false, calling:false, notifications:false }, demo:true };
    if(path === "/team-admin") return teamAdmin(o.body || {});
    if(path === "/email/accounts") return { accounts: [] };
    throw Object.assign(new Error("This needs the CRM server. It isn't available in the demo."), { status:501, code:"demo" });
  }
  async function teamAdmin(payload){
    const ws = tableOf("workspaces").find(w => w.id === payload.workspaceId);
    if(!ws) throw new Error("Workspace not found");
    if(payload.action === "invite"){
      let prof = tableOf("profiles").find(p => p.email.toLowerCase() === payload.email);
      if(tableOf("workspace_members").some(m => m.workspace_id === ws.id && prof && m.user_id === prof.id)) throw new Error("That person is already on the team");
      if(!prof){ prof = { id:"demo-" + Date.now(), email:payload.email, display_name:null, avatar_data:null, is_platform_admin:false, created_at:nowIso() }; tableOf("profiles").push(prof); }
      const m = { workspace_id:ws.id, user_id:prof.id, role:payload.role, invited:true, created_at:nowIso() };
      tableOf("workspace_members").push(m);
      emit("workspace_members", "INSERT", m);
    } else if(payload.action === "remove"){
      store.workspace_members = tableOf("workspace_members").filter(m => !(m.workspace_id === ws.id && m.user_id === payload.userId));
    }
    persistDemoStore();
    return { success:true };
  }

  const session = { user, access_token:"demo" };
  return {
    from: query,
    rpc,
    api: demoApi,
    channel: () => {
      const mine = [];
      const ch = {
        on(type, filter, cb){ const l = { table: filter.table, event: filter.event || "*", filter: filter.filter, cb }; mine.push(l); listeners.push(l); return ch; },
        subscribe(){ return ch; },
        _listeners: mine,
      };
      return ch;
    },
    removeChannel: (ch) => { (ch && ch._listeners || []).forEach(l => { const i = listeners.indexOf(l); if(i >= 0) listeners.splice(i, 1); }); },
    auth: {
      getSession: async () => ({ data:{ session } }),
      onAuthStateChange: () => ({ data:{ subscription:{ unsubscribe(){} } } }),
      signOut: async () => ({}),
      signUp: async () => ({}), signInWithPassword: async () => ({}),
      resetPasswordForEmail: async () => ({}), updateUser: async () => ({}),
    },
  };
}

function startDemo(){
  DEMO = true;
  document.body.classList.add("is-demo");
  sb = createDemoClient();
  document.getElementById("demo-btn").classList.add("hidden");
  initAuth();
}

async function resetDemo(){
  if(!await confirmDialog("Reset the demo? Every change you made is replaced with the original sample data.", "Reset demo")) return;
  try{ window.localStorage.removeItem(DEMO_STORE_KEY); }catch(e){}
  sb = createDemoClient({ store: demoSeedStore() });
  persistDemoStore();
  await fetchMyProfile();
  await fetchMyWorkspaces();
  await enterWorkspace(myWorkspaces[0].id);
  notify("Demo reset", "Sample data restored.");
}
