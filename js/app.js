/* ============================================================
   STATIC DATA
============================================================ */
const APP_NAME = "Brandigade CRM";

const ICONS = {
  dashboard:'<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  pipeline:'<path d="M3 4h18l-7 8v6l-4 2v-8z"/>',
  contacts:'<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5.5-4.5-6.5"/>',
  companies:'<path d="M3 21V7l7-4v18M10 21h11V10l-11-3"/><path d="M14 13h3M14 17h3M6 10h1M6 14h1"/>',
  board:'<path d="M9 11l2 2 4-4"/><rect x="3" y="3" width="18" height="18" rx="3"/>',
  profile:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  team:'<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>',
};

const TABS = [
  {id:"dashboard", label:"Dashboard"},
  {id:"pipeline", label:"Pipeline"},
  {id:"contacts", label:"Contacts"},
  {id:"companies", label:"Companies"},
  {id:"board", label:"Tasks"},
  {id:"profile", label:"Profile"},
  {id:"team", label:"Team"},
];
function visibleTabs(){ return TABS; }

const STAGES = [
  {id:"lead", label:"Lead", prob:10},
  {id:"qualified", label:"Qualified", prob:25},
  {id:"proposal", label:"Proposal sent", prob:50},
  {id:"negotiation", label:"Negotiation", prob:75},
  {id:"won", label:"Won", prob:100},
  {id:"lost", label:"Lost", prob:0},
];
const OPEN_STAGES = ["lead","qualified","proposal","negotiation"];

const CONTACT_STATUSES = [
  {id:"lead", label:"Lead"}, {id:"prospect", label:"Prospect"},
  {id:"customer", label:"Customer"}, {id:"inactive", label:"Inactive"},
];
const SOURCES = ["Referral","Website","Social media","Event","Outbound","Other"];
const INDUSTRIES = ["Retail","Food & beverage","Hospitality","Real estate","Technology","Healthcare","Education","Finance","Fashion","Non-profit","Other"];
const ACTIVITY_TYPES = [
  {id:"call", label:"Call", icon:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'},
  {id:"email", label:"Email", icon:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'},
  {id:"meeting", label:"Meeting", icon:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'},
  {id:"note", label:"Note", icon:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'},
];

// Sample tasks shown only the first time a real workspace is opened (before anything is saved).
const SEED_BOARD = [
  {id:"b1", title:"Welcome. Click a card to edit it", workstream:"General", column:"todo"},
  {id:"b2", title:"Add your first client on the Contacts page", workstream:"Follow-up", column:"todo"},
  {id:"b3", title:"Invite a teammate from the Team page", workstream:"Admin", column:"doing"},
  {id:"b4", title:"Set up the CRM", workstream:"Admin", column:"done"},
];

const COLLECTIONS = ["board","companies","contacts","deals","activities"];

function escapeHtml(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ============================================================
   SUPABASE CONFIG
   config.js is written by `npm run build` (and served by `npm run dev`) from
   the SUPABASE_URL and SUPABASE_ANON_KEY environment variables. The anon key
   is public by design; row level security in supabase/migrations/ is the
   real access control.
============================================================ */
const APP_CONFIG = window.BRANDIGADE_CONFIG || {};
const SUPABASE_URL = APP_CONFIG.supabaseUrl || "https://YOUR-PROJECT-REF.supabase.co";
const SUPABASE_ANON_KEY = APP_CONFIG.supabaseAnonKey || "YOUR-ANON-PUBLIC-KEY";
const API_BASE = (APP_CONFIG.apiBase || "/api").replace(/\/$/, "");

let DEMO = false;

/* ============================================================
   EXTENSION HOOKS
   Feature modules (js/timeline.js, js/email.js, js/dialer.js,
   js/notifications.js) plug into the core screens through these hooks
   instead of editing them. See docs/ARCHITECTURE.md for the list.
============================================================ */
const CRMHooks = {
  _handlers: {},
  on(name, fn){ (this._handlers[name] = this._handlers[name] || []).push(fn); },
  // Calls every handler; returns their non-empty results. A failing module
  // never breaks the core screen.
  emit(name, ...args){
    const out = [];
    (this._handlers[name] || []).forEach(fn => {
      try{ const r = fn(...args); if(r != null) out.push(r); }
      catch(e){ console.error("Hook " + name + " failed", e); }
    });
    return out;
  },
};

// What the server has set up (email providers, calling, notification sender).
// Filled from GET /api/config when the CRM opens.
let appFeatures = { gmail:false, outlook:false, calling:false, notifications:false };

// Calls the CRM's own server API (api/index.ts) as the signed-in person.
// Throws an Error with .status and .code on failure.
async function api(path, opts){
  opts = opts || {};
  if(sb && sb.api) return sb.api(path, opts); // demo mode stand-in
  const { data: { session } } = await sb.auth.getSession();
  if(!session) throw Object.assign(new Error("Your session has expired. Please sign in again."), { status:401 });
  const headers = { "Authorization": "Bearer " + session.access_token };
  if(opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try{
    res = await fetch(API_BASE + path, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }catch(e){
    throw Object.assign(new Error("Couldn't reach the CRM server. Check your connection and try again."), { status:0 });
  }
  const json = await res.json().catch(() => ({}));
  if(!res.ok || json.error) throw Object.assign(new Error(json.error || ("Request failed (" + res.status + ")")), { status:res.status, code:json.code });
  return json;
}

// Invites and removals go through the server (it holds the service-role key).
async function callTeamAdminFunction(payload){
  return api("/team-admin", { method:"POST", body:payload });
}
const REMEMBER_PREF_KEY = "brandigade-crm-remember-pref";

function isConfigured(){
  return !(SUPABASE_URL.includes("YOUR-PROJECT-REF") || SUPABASE_ANON_KEY.includes("YOUR-ANON"));
}

function buildSupabaseClient(persist){
  if(DEMO) return createDemoClient();
  if(typeof supabase === "undefined" || !SUPABASE_URL.startsWith("http") || !isConfigured()) return null;
  return supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // needed so the password-reset email link works
      storage: persist ? window.localStorage : window.sessionStorage,
      storageKey: "brandigade-crm-auth",
    },
  });
}

function getRememberPref(){
  try{
    const v = window.localStorage.getItem(REMEMBER_PREF_KEY);
    return v === null ? true : v === "1";
  }catch(e){ return true; }
}
function setRememberPref(persist){
  try{ window.localStorage.setItem(REMEMBER_PREF_KEY, persist ? "1" : "0"); }catch(e){}
}

let sb = buildSupabaseClient(getRememberPref());

let currentUser = null;     // { id, email }
let currentRole = "viewer"; // role in the current workspace: "owner" | "admin" | "editor" | "viewer"
let memberRole = "viewer";  // membership role in the CRM
let isPlatformAdmin = false;
let myWorkspaces = [];      // the CRM, if this person has been added: [{id, name, status, role}]
let currentWorkspace = null;
let onLoggedInStarted = false; // guards against onLoggedIn() running twice; see onLoggedIn()
let teamList = [];          // [{id, email, role, display_name, avatar_data, confirmed}]
let state = seedState();

// In memory the CRM keeps the shape it always had (camelCase records in
// state.board / companies / contacts / deals / activities). js/data.js maps
// them to the database tables, saves only what changed, and applies changes
// made by other people as they arrive.
function seedState(){
  return {
    board: [],
    companies: [],
    contacts: [],
    deals: [],
    activities: [],
    settings: { currency: "USD" },
  };
}

// Normalises a backup file into the state shape.
function mergeWithSeed(saved){
  const seed = seedState();
  if(!saved || Object.keys(saved).length === 0) return seed;
  COLLECTIONS.forEach(key => { if(Array.isArray(saved[key])) seed[key] = saved[key]; });
  if(saved.settings) seed.settings = {...seed.settings, ...saved.settings};
  return seed;
}

function guardEdit(fn){
  return function(...args){
    if(currentRole === "viewer") return;
    return fn.apply(this, args);
  };
}
// Who may change a record (the database enforces the same rule): the owner and
// admins change everything; editors change what is theirs (companies they
// created, leads and deals they own or created, tasks assigned to them or
// created by them); viewers change nothing. Everyone reads everything.
function isCrmAdmin(){ return currentRole === "owner" || currentRole === "admin"; }
const RECORD_OWNER_FIELD = { company: null, contact: "ownerId", deal: "ownerId", task: "assignedTo" };
function canEditRecord(kind, rec){
  if(currentRole === "viewer") return false;
  if(!rec || isCrmAdmin()) return true;
  const me = currentUser && currentUser.id;
  if(!me) return false;
  const ownerField = RECORD_OWNER_FIELD[kind];
  return rec.createdBy === me || (!!ownerField && rec[ownerField] === me);
}
// Only the creator (or an admin) may hand a record to someone else: after the
// handover an owner who didn't create it would lose it.
function canReassignRecord(rec){
  if(currentRole === "viewer") return false;
  return !rec || isCrmAdmin() || (!!currentUser && rec.createdBy === currentUser.id);
}
// Marks controls a person may not use on this record; applyRolePermissions() keeps them off.
function lockControls(els, locked){
  els.forEach(el => {
    if(!el) return;
    if(locked){ el.dataset.locked = "true"; el.disabled = true; }
    else { delete el.dataset.locked; }
  });
}
function recordReadOnlyNote(kind, rec){
  const ownerField = RECORD_OWNER_FIELD[kind];
  const who = (ownerField && rec[ownerField]) || rec.createdBy;
  return who ? `Only ${personName(who)}, the owner or an admin can change this.` : "Only the owner or an admin can change this.";
}

function guardOwnerOnly(fn){
  return function(...args){
    if(currentRole !== "owner") return;
    return fn.apply(this, args);
  };
}

// Records get random UUIDs, so two people creating records at the same
// moment can never collide (the old per-document counters could).
function newId(){
  if(window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  const b = new Uint8Array(16);
  if(window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
  else for(let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return h.slice(0,8) + "-" + h.slice(8,12) + "-" + h.slice(12,16) + "-" + h.slice(16,20) + "-" + h.slice(20);
}
function nextId(){ return newId(); }

function exportData(){
  const backup = {
    exportedAt: new Date().toISOString(),
    board: state.board, companies: state.companies, contacts: state.contacts, deals: state.deals,
    activities: state.activities.filter(a => (a.source || "manual") === "manual"),
    settings: { currency: state.settings.currency, timezone: state.settings.timezone },
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const slug = currentWorkspace ? currentWorkspace.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "workspace";
  a.download = `brandigade-crm-${slug}-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const importData = guardEdit(function(file){
  const reader = new FileReader();
  reader.onload = async () => {
    let parsed;
    try{ parsed = JSON.parse(reader.result); }
    catch(e){ notify("Import failed", "That file isn't a backup exported from this CRM."); return; }
    if(!await confirmDialog("Import this backup? It replaces every contact, company, deal and task in the CRM. Synced emails and calls are kept.", "Import")) return;
    const imported = normalizeImportedIds(mergeWithSeed(parsed));
    const synced = state.activities.filter(a => (a.source || "manual") !== "manual");
    state.board = imported.board; state.companies = imported.companies; state.contacts = imported.contacts;
    state.deals = imported.deals; state.activities = synced.concat(imported.activities);
    saveState();
    renderAll();
    notify("Import complete", "The CRM now matches the backup file.");
  };
  reader.readAsText(file);
});

/* ============================================================
   IN-PAGE DIALOGS (no alert/confirm, so it also works inside embedded previews)
============================================================ */
let confirmResolver = null;
function confirmDialog(message, okLabel){
  const overlay = document.getElementById("confirm-overlay");
  document.getElementById("confirm-message").textContent = message;
  document.getElementById("confirm-ok").textContent = okLabel || "Confirm";
  overlay.classList.remove("hidden");
  document.getElementById("confirm-ok").focus();
  return new Promise(resolve => { confirmResolver = resolve; });
}
function closeConfirm(result){
  document.getElementById("confirm-overlay").classList.add("hidden");
  if(confirmResolver){ const r = confirmResolver; confirmResolver = null; r(result); }
}
function notify(title, body){ showToast(title, body || "", "none"); }

// Demo mode (sample data in this browser, no Supabase) lives in js/demo.js.

/* ============================================================
   AUTH
============================================================ */
function showAuthError(msg){
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.classList.add("show");
}
function clearAuthError(){ document.getElementById("auth-error").classList.remove("show"); }
function showAuthSuccess(msg){
  const el = document.getElementById("auth-success");
  el.textContent = msg;
  el.classList.add("show");
}
function clearAuthSuccess(){ document.getElementById("auth-success").classList.remove("show"); }

function showAuthView(view){
  clearAuthError();
  clearAuthSuccess();
  document.getElementById("auth-login-view").classList.toggle("hidden", view !== "login");
  document.getElementById("auth-forgot-view").classList.toggle("hidden", view !== "forgot");
  document.getElementById("auth-reset-view").classList.toggle("hidden", view !== "reset");
  document.getElementById("auth-noaccess-view").classList.toggle("hidden", view !== "noaccess");
}

let authMode = "login"; // "login" | "signup"

// True from the moment an invite/recovery link is detected until the person
// finishes setting a password (or the link turns out to be expired).
let onPasswordSetupScreen = false;
function isPasswordSetupLink(){ return onPasswordSetupScreen; }

let authFormReady = false;
function setupAuthForm(){
  if(authFormReady) return;
  authFormReady = true;
  const form = document.getElementById("auth-form");
  const modeLink = document.getElementById("auth-mode-link");
  const toggleText = document.getElementById("auth-toggle");
  const submitBtn = document.getElementById("auth-submit-btn");
  const rememberChk = document.getElementById("auth-remember");
  rememberChk.checked = getRememberPref();

  const pwInput = document.getElementById("auth-password");
  const pwToggleBtn = document.getElementById("password-toggle-btn");
  pwToggleBtn.addEventListener("click", () => {
    const showing = pwInput.type === "text";
    pwInput.type = showing ? "password" : "text";
    pwToggleBtn.textContent = showing ? "Show" : "Hide";
  });

  modeLink.addEventListener("click", () => {
    authMode = authMode === "login" ? "signup" : "login";
    submitBtn.textContent = authMode === "login" ? "Log in" : "Sign up";
    toggleText.firstChild.textContent = authMode === "login" ? "Don't have an account yet? " : "Already have an account? ";
    modeLink.textContent = authMode === "login" ? "Sign up" : "Log in";
    clearAuthError();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError();
    clearAuthSuccess();
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const remember = rememberChk.checked;
    const idleLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = authMode === "signup" ? "Creating your account…" : "Logging in…";
    try{
      if(remember !== getRememberPref() || !sb){
        setRememberPref(remember);
        sb = buildSupabaseClient(remember);
        if(!sb) throw new Error("This CRM isn't connected to Supabase yet.");
        attachAuthStateListener();
      }
      if(authMode === "signup"){
        const emailRedirectTo = window.location.origin + window.location.pathname;
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo } });
        if(error) throw error;
        if(!data || !data.session){
          showAuthSuccess("Almost there. We sent a confirmation link to " + email + ". Open it to finish signing up, then log in here.");
          modeLink.click();
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if(error) throw error;
      }
    }catch(err){
      showAuthError(err.message || "Something went wrong. Please try again.");
    }finally{
      submitBtn.disabled = false;
      if(submitBtn.textContent.endsWith("…")) submitBtn.textContent = idleLabel;
    }
  });

  const forgotForm = document.getElementById("forgot-form");
  const forgotSubmitBtn = document.getElementById("forgot-submit-btn");
  document.getElementById("forgot-password-link").addEventListener("click", () => {
    document.getElementById("forgot-email").value = document.getElementById("auth-email").value;
    showAuthView("forgot");
  });
  document.getElementById("back-to-login-link").addEventListener("click", () => showAuthView("login"));

  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError();
    const email = document.getElementById("forgot-email").value.trim();
    forgotSubmitBtn.disabled = true;
    try{
      if(!sb) throw new Error("Not connected to Supabase.");
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if(error) throw error;
      showAuthSuccess("Check " + email + " for a link to reset your password.");
    }catch(err){
      showAuthError(err.message || "Couldn't send that reset link. Please try again.");
    }finally{
      forgotSubmitBtn.disabled = false;
    }
  });

  document.getElementById("noaccess-signout-link").addEventListener("click", async () => {
    if(!DEMO && sb) await sb.auth.signOut();
    window.location.reload();
  });

  const resetForm = document.getElementById("reset-form");
  const resetSubmitBtn = document.getElementById("reset-submit-btn");
  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError();
    const pw1 = document.getElementById("reset-password").value;
    const pw2 = document.getElementById("reset-password-confirm").value;
    if(pw1 !== pw2){ showAuthError("Those two passwords don't match."); return; }
    resetSubmitBtn.disabled = true;
    if(pendingJoin){
      try{ await submitJoin(pw1); }
      catch(err){ showAuthError(err.message || "Couldn't join the team. Please try again."); }
      resetSubmitBtn.disabled = false;
      return;
    }
    try{
      const { error } = await sb.auth.updateUser({ password: pw1 });
      if(error) throw error;
      onPasswordSetupScreen = false;
      const { data: { session } } = await sb.auth.getSession();
      if(session) await onLoggedIn(session.user);
    }catch(err){
      showAuthError(err.message || "Couldn't set that password. Please try again.");
      resetSubmitBtn.disabled = false;
    }
  });
}

let myProfile = null;

function initials(name, email){
  const source = ((name && name.trim()) || (email || "")).trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if(name && parts.length > 1) return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  return source.charAt(0).toUpperCase() || "?";
}

function fillAvatarEl(el, profile){
  el.innerHTML = "";
  // Only embedded images: a remote URL would reveal teammates' IP addresses.
  if(profile && typeof profile.avatar_data === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(profile.avatar_data)){
    const img = document.createElement("img");
    img.src = profile.avatar_data;
    img.alt = "";
    img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;";
    el.appendChild(img);
  } else {
    el.textContent = initials(profile && profile.display_name, profile && profile.email);
  }
}

async function fetchMyProfile(){
  const { data, error } = await sb.from("profiles").select("id,email,display_name,avatar_data,is_platform_admin").eq("id", currentUser.id).single();
  if(error || !data){ console.error("Could not load your profile", error); myProfile = { id: currentUser.id, email: currentUser.email }; isPlatformAdmin = false; return; }
  myProfile = data;
  isPlatformAdmin = !!data.is_platform_admin;
}

async function fetchMyWorkspaces(){
  const { data, error } = await sb.from("workspace_members")
    .select("role,invited,created_at,workspaces(id,name,status)")
    .eq("user_id", currentUser.id).order("created_at", { ascending:true });
  if(error){ console.error("Could not load your workspaces", error); myWorkspaces = []; return; }
  myWorkspaces = (data || []).filter(m => m.workspaces).map(m => ({ ...m.workspaces, role: m.role }));
}

// Invites to people who already had a login, until they open the join link.
let pendingInvites = [];
async function fetchPendingInvites(){
  if(DEMO || memberRole !== "owner"){ pendingInvites = []; return; }
  const { data, error } = await sb.from("workspace_invites")
    .select("id,email,role,created_at,expires_at")
    .eq("workspace_id", currentWorkspace.id).is("accepted_at", null).order("created_at", { ascending:true });
  if(error){ console.error("Could not load pending invites", error); pendingInvites = []; return; }
  const now = Date.now();
  pendingInvites = (data || []).filter(i => Date.parse(i.expires_at) > now);
}

async function fetchTeam(){
  await fetchPendingInvites();
  const { data, error } = await sb.from("workspace_members")
    .select("user_id,role,invited,created_at,profiles(id,email,display_name,avatar_data)")
    .eq("workspace_id", currentWorkspace.id).order("created_at", { ascending:true });
  if(error){ console.error("Could not load team list", error); teamList = []; return; }
  teamList = (data || []).map(m => ({
    id: m.user_id, role: m.role, confirmed: !m.invited,
    email: (m.profiles && m.profiles.email) || "", display_name: m.profiles && m.profiles.display_name, avatar_data: m.profiles && m.profiles.avatar_data,
  }));
}

// Realtime subscriptions live in js/data.js (subscribeRealtime).

function renderWhoAmI(){
  const whoEl = document.getElementById("who-am-i");
  if(!whoEl || !currentUser) return;
  const avatarEl = document.createElement("div");
  avatarEl.className = "avatar";
  fillAvatarEl(avatarEl, myProfile);
  const name = (myProfile && myProfile.display_name) || currentUser.email;
  whoEl.innerHTML = "";
  whoEl.appendChild(avatarEl);
  const textDiv = document.createElement("div");
  textDiv.innerHTML = `${escapeHtml(name)}<br/><span class="role-pill role-${memberRole}">${memberRole}</span>`;
  whoEl.appendChild(textDiv);
  const topbarAvatar = document.getElementById("topbar-avatar");
  if(topbarAvatar) fillAvatarEl(topbarAvatar, myProfile);
}

function setEffectiveRole(){
  currentRole = memberRole;
}

// Opens the CRM after sign-in, or explains that the person hasn't been invited yet.
function afterWorkspacesLoaded(){
  if(!myWorkspaces.length){ return showNoAccess(); }
  return enterWorkspace(myWorkspaces[0].id);
}

function showNoAccess(){
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("auth-loading").classList.add("hidden");
  document.querySelector(".auth-box").classList.remove("is-loading");
  document.getElementById("auth-form-wrap").classList.remove("hidden");
  showAuthView("noaccess");
}

let appBooted = false;
async function enterWorkspace(wsId){
  const ws = myWorkspaces.find(w => w.id === wsId);
  if(!ws) return;
  currentWorkspace = ws;
  memberRole = ws.role;
  setEffectiveRole();

  closeRecordModal(); closeTaskModal(); closeTaskViewModal();
  await Promise.all([fetchTeam(), loadAppFeatures()]);
  await loadAppState();
  // Reminder emails read due times in the team's time zone; the first person to
  // open the CRM with edit rights records theirs.
  await ensureTeamTimezone();
  await seedWelcomeTasksIfNew();

  document.getElementById("auth-screen").classList.add("hidden");
  renderWhoAmI();
  renderNav();
  renderAll();
  if(!appBooted){
    appBooted = true;
    bindEvents();
    loadNotificationHistory();
    renderNotifBell();
    startReminderChecks();
  } else {
    checkReminders();
  }
  applyRolePermissions();
  subscribeRealtime();
  switchTab("dashboard");
  CRMHooks.emit("app:ready", { workspace: currentWorkspace, user: currentUser, role: currentRole });
}

// Which integrations the server has credentials for. Without a server (the
// demo, or opening index.html as a file) everything shows as not set up.
async function loadAppFeatures(){
  try{
    const res = await api("/config");
    appFeatures = { ...appFeatures, ...((res && res.features) || {}) };
  }catch(e){
    console.warn("Couldn't load the server configuration", e);
  }
}

// Finds a record by its id, or by the id it had before records moved to their
// own tables (links in older reminder emails use those).
function findRecord(coll, id){
  if(!id) return null;
  return state[coll].find(r => r.id === id) || state[coll].find(r => r.legacyId && r.legacyId === id) || null;
}

async function onLoggedIn(user){
  // Reentrancy guard: initAuth()'s getSession() check and the SIGNED_IN event
  // can both resolve around the same moment. Set synchronously before any await.
  if(onLoggedInStarted) return;
  onLoggedInStarted = true;

  currentUser = { id: user.id, email: user.email };
  await fetchMyProfile();
  await fetchMyWorkspaces();
  await afterWorkspacesLoaded();
  if(!currentWorkspace) return;

  // Deep links from notification emails: ?task=<id>, ?contact=<id>,
  // ?company=<id> or ?deal=<id>. Modules see the rest (e.g. OAuth results).
  const params = new URLSearchParams(window.location.search);
  const handled = CRMHooks.emit("app:deeplink", params).some(Boolean);
  const task = findRecord("board", params.get("task"));
  const recordLink = ["contact", "company", "deal"].map(kind => ({ kind, rec: findRecord(RECORD_KINDS[kind].collection, params.get(kind)) })).find(x => x.rec);
  if(params.get("task")){
    switchTab("board");
    setTimeout(() => openTaskViewModal(task ? task.id : params.get("task")), 50);
  } else if(recordLink){
    switchTab(recordLink.kind === "deal" ? "pipeline" : recordLink.kind === "company" ? "companies" : "contacts");
    setTimeout(() => openRecordModal(recordLink.kind, recordLink.rec.id), 50);
  } else if(!handled){
    const hashTab = (window.location.hash || "").replace("#", "");
    if(visibleTabs().some(t => t.id === hashTab)) switchTab(hashTab);
  }
  if([...params.keys()].length) window.history.replaceState({}, "", window.location.pathname + window.location.hash);
}

function applyRolePermissions(){
  const isViewer = currentRole === "viewer";
  document.querySelectorAll("main input, main select, main textarea, main button").forEach(el => {
    if(el.dataset.alwaysEnabled) return;
    el.disabled = isViewer || el.dataset.locked === "true";
  });
  document.querySelectorAll(".card").forEach(el => { el.draggable = !isViewer && el.dataset.locked !== "true"; });
  document.querySelectorAll(".card-del, .btn-del").forEach(el => {
    const off = isViewer || el.dataset.locked === "true";
    el.style.pointerEvents = off ? "none" : "";
    el.style.opacity = off ? "0.3" : "";
  });
  document.querySelectorAll(".role-select").forEach(el => { el.disabled = currentRole !== "owner"; });
  ["ws-currency"].forEach(id => { const el = document.getElementById(id); if(el) el.disabled = currentRole !== "owner"; });
  const importBtn = document.getElementById("import-btn");
  if(importBtn) importBtn.disabled = isViewer;
}

async function initAuth(){
  setupAuthForm();
  if(!initAuth.signoutBound){
    initAuth.signoutBound = true;
    const doSignOut = async () => {
      if(DEMO){ window.location.reload(); return; }
      await sb.auth.signOut();
      window.location.reload();
    };
    document.getElementById("signout-link").addEventListener("click", doSignOut);
    document.getElementById("mobile-signout-btn").addEventListener("click", doSignOut);
  }

  if(!sb){
    document.getElementById("auth-loading").classList.add("hidden");
    document.querySelector(".auth-box").classList.remove("is-loading");
    document.getElementById("auth-form-wrap").classList.remove("hidden");
    showAuthError("This file isn't connected to a Supabase project yet. Fill in SUPABASE_URL and SUPABASE_ANON_KEY near the top of the <script>.");
    return;
  }

  // Detect a password-recovery or invite link from the URL itself.
  const isInviteLink = window.location.hash.includes("type=invite") || window.location.search.includes("type=invite");
  const isRecoveryLink = window.location.hash.includes("type=recovery") || window.location.search.includes("type=recovery");
  const cameFromRecoveryLink = !DEMO && (isInviteLink || isRecoveryLink);
  // A join link from an invite email (someone who already had a login).
  const startParams = new URLSearchParams(window.location.search);
  const joinToken = DEMO ? null : startParams.get("join");
  const joinError = DEMO ? null : startParams.get("join_error");
  onPasswordSetupScreen = cameFromRecoveryLink || !!joinToken;

  attachAuthStateListener();

  const { data: { session } } = await sb.auth.getSession();

  if(joinToken){ await completeJoin(joinToken, session); return; }
  if(joinError){
    history.replaceState(null, "", window.location.pathname);
    revealAuthForm();
    showAuthView("login");
    showAuthError("That invite link has expired, was cancelled or was already used. Ask the CRM owner to invite you again.");
    if(session) await onLoggedIn(session.user);
    return;
  }

  if(cameFromRecoveryLink){
    history.replaceState(null, "", window.location.pathname);
    document.getElementById("auth-loading").classList.add("hidden");
    document.querySelector(".auth-box").classList.remove("is-loading");
    document.getElementById("auth-form-wrap").classList.remove("hidden");
    if(session){
      const note = document.getElementById("reset-view-note");
      const submitBtn = document.getElementById("reset-submit-btn");
      if(isInviteLink){
        note.textContent = "Welcome to Brandigade CRM. Set a password so you can log in on your own from now on.";
        submitBtn.textContent = "Set password and continue";
      } else {
        note.textContent = "Choose a new password for your account.";
        submitBtn.textContent = "Set new password";
      }
      showAuthView("reset");
    } else {
      onPasswordSetupScreen = false;
      showAuthView("login");
      showAuthError(isInviteLink
        ? "That invite link has expired or was already used. Ask the owner to send a new one."
        : "That reset link has expired or was already used. Please request a new one.");
    }
    return;
  }

  if(session){
    await onLoggedIn(session.user);
  } else {
    document.getElementById("auth-loading").classList.add("hidden");
    document.querySelector(".auth-box").classList.remove("is-loading");
    document.getElementById("auth-form-wrap").classList.remove("hidden");
  }
}

function revealAuthForm(){
  document.getElementById("auth-loading").classList.add("hidden");
  document.querySelector(".auth-box").classList.remove("is-loading");
  document.getElementById("auth-form-wrap").classList.remove("hidden");
}

// The person opened the join link from an invite email and is now signed in
// (the link signs them in). They choose a new password on the next screen; the
// server checks it is the invited address, sets that password (signing out
// every session of the account, including any held by whoever registered the
// address before), and adds them to the team. Then we sign in again with it.
let pendingJoin = null; // { token, email }
async function completeJoin(token, session){
  history.replaceState(null, "", window.location.pathname);
  revealAuthForm();
  if(!session){
    onPasswordSetupScreen = false;
    showAuthView("login");
    showAuthError("That sign-in link has expired. Open the link in your invite email again to get a new one.");
    return;
  }
  pendingJoin = { token, email: session.user.email };
  document.getElementById("reset-view-note").textContent = "You've been invited to Brandigade CRM. To join, choose a new password for " + session.user.email + ".";
  document.getElementById("reset-submit-btn").textContent = "Join the team";
  ["reset-password", "reset-password-confirm"].forEach(id => document.getElementById(id).setAttribute("minlength", "8"));
  showAuthView("reset");
}

// Called by the password form while a join is pending.
async function submitJoin(password){
  const join = pendingJoin;
  try{
    await api("/team/join", { method:"POST", body:{ token: join.token, password } });
  }catch(err){
    if(err.status === 403){
      onPasswordSetupScreen = false;
      document.querySelector("#auth-noaccess-view .auth-note").textContent = err.message;
      showAuthView("noaccess");
      return;
    }
    if(err.code === "invite_expired"){
      pendingJoin = null;
      onPasswordSetupScreen = false;
      showAuthView("login");
      showAuthError(err.message);
      const { data: { session } } = await sb.auth.getSession();
      if(session) await onLoggedIn(session.user);
      return;
    }
    throw err;
  }
  pendingJoin = null;
  const { data, error } = await sb.auth.signInWithPassword({ email: join.email, password });
  onPasswordSetupScreen = false;
  if(error || !data.session){
    showAuthView("login");
    showAuthError("You've joined the team. Log in with your new password.");
    return;
  }
  await onLoggedIn(data.session.user);
}

function handleAuthStateChange(event, session){
  if(event === "PASSWORD_RECOVERY"){
    onPasswordSetupScreen = true;
    document.getElementById("auth-loading").classList.add("hidden");
    document.querySelector(".auth-box").classList.remove("is-loading");
    document.getElementById("auth-form-wrap").classList.remove("hidden");
    showAuthView("reset");
    return;
  }
  if(event === "SIGNED_IN" && session && !currentUser){
    if(isPasswordSetupLink()) return;
    onLoggedIn(session.user);
  }
  if(event === "SIGNED_OUT"){
    window.location.reload();
  }
}

function attachAuthStateListener(){ sb.auth.onAuthStateChange(handleAuthStateChange); }

/* ============================================================
   NAV
============================================================ */
function renderNav(){
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  visibleTabs().forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "nav-item" + (i===0 ? " active" : "");
    el.dataset.tab = t.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t.id] || ""}</svg><span>${t.label}</span>`;
    el.addEventListener("click", () => switchTab(t.id));
    el.addEventListener("keydown", (e) => { if(e.key === "Enter" || e.key === " "){ e.preventDefault(); switchTab(t.id); } });
    nav.appendChild(el);
  });
}

function switchTab(id){
  if(!visibleTabs().some(t => t.id === id)) id = "dashboard";
  TABS.forEach(t => document.getElementById("tab-"+t.id).classList.toggle("hidden", t.id !== id));
  document.querySelectorAll(".nav-item").forEach(el => {
    const on = el.dataset.tab === id;
    el.classList.toggle("active", on);
    if(on) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  });
  revealActiveNavItem();
  if(id === "dashboard") renderDashboard();
}

// On narrow screens the nav is a sideways-scrolling strip: keep the current tab in
// view when it changes from elsewhere (a dashboard link, the avatar, a deep link).
function revealActiveNavItem(){
  const nav = document.getElementById("nav");
  const active = nav && nav.querySelector(".nav-item.active");
  if(!active || nav.scrollWidth <= nav.clientWidth) return;
  const n = nav.getBoundingClientRect(), a = active.getBoundingClientRect();
  if(a.left >= n.left && a.right <= n.right) return;
  nav.scrollLeft += (a.left + a.width / 2) - (n.left + n.width / 2);
}

/* ============================================================
   LOOKUPS & FORMATTING
============================================================ */
function fmtMoney(v){
  const n = Number(v) || 0;
  try{
    return new Intl.NumberFormat(undefined, { style:"currency", currency:(state.settings && state.settings.currency) || "USD", maximumFractionDigits:0 }).format(n);
  }catch(e){ return Math.round(n).toLocaleString(); }
}
function fmtMoneyShort(v){
  const n = Number(v) || 0;
  try{
    return new Intl.NumberFormat(undefined, { style:"currency", currency:(state.settings && state.settings.currency) || "USD", notation:"compact", maximumFractionDigits:1 }).format(n);
  }catch(e){ return fmtMoney(n); }
}
function fmtDay(iso){
  if(!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T12:00" : iso);
  return d.toLocaleDateString(undefined, { month:"short", day:"numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
function relTime(iso){
  if(!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if(diff < 60000) return "just now";
  if(diff < 3600000) return Math.round(diff/60000) + " min ago";
  if(diff < day) return Math.round(diff/3600000) + " h ago";
  if(diff < 2*day) return "yesterday";
  if(diff < 30*day) return Math.round(diff/day) + " days ago";
  return fmtDay(iso);
}
function todayIso(){ const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }

function personById(id){ return teamList.find(p => p.id === id) || null; }
function personName(id){ const p = personById(id); return p ? (p.display_name || p.email) : ""; }
function companyById(id){ return state.companies.find(c => c.id === id) || null; }
function contactById(id){ return state.contacts.find(c => c.id === id) || null; }
function dealById(id){ return state.deals.find(d => d.id === id) || null; }
function contactName(c){ return c ? [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unnamed" : ""; }
function stageById(id){ return STAGES.find(s => s.id === id) || STAGES[0]; }
function stageColor(id){ return `var(--stage-${id})`; }
function lastTouch(filterFn){
  const acts = state.activities.filter(filterFn);
  if(!acts.length) return null;
  return acts.reduce((a, b) => (a.at > b.at ? a : b)).at;
}

/* ============================================================
   DASHBOARD
============================================================ */
function renderDashboard(){
  const now = new Date();
  const dEl = document.getElementById("d-date");
  if(dEl) dEl.textContent = now.toLocaleDateString(undefined, { weekday:"long", month:"long", day:"numeric" });

  const open = state.deals.filter(d => OPEN_STAGES.includes(d.stage));
  const openValue = open.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const weighted = open.reduce((s, d) => s + (Number(d.value) || 0) * stageById(d.stage).prob / 100, 0);
  const monthPrefix = todayIso().slice(0,7);
  const wonMonth = state.deals.filter(d => d.stage === "won" && (d.closedAt || d.closeDate || "").startsWith(monthPrefix));
  const won = state.deals.filter(d => d.stage === "won").length;
  const lost = state.deals.filter(d => d.stage === "lost").length;

  document.getElementById("d-pipeline-value").textContent = fmtMoney(openValue);
  document.getElementById("d-pipeline-count").textContent = open.length + (open.length === 1 ? " open deal" : " open deals");
  document.getElementById("d-weighted").textContent = fmtMoney(weighted);
  document.getElementById("d-won-month").textContent = fmtMoney(wonMonth.reduce((s, d) => s + (Number(d.value) || 0), 0));
  document.getElementById("d-won-count").textContent = wonMonth.length + (wonMonth.length === 1 ? " deal closed" : " deals closed");
  document.getElementById("d-win-rate").textContent = (won + lost) ? Math.round(won / (won + lost) * 100) + "%" : "–";
  document.getElementById("d-win-hint").textContent = (won + lost) ? `${won} won, ${lost} lost` : "No closed deals yet";
  document.getElementById("d-contacts").textContent = state.contacts.length;
  document.getElementById("d-team-size").textContent = teamList.length || "–";

  // Stage bars
  const barsEl = document.getElementById("d-stages");
  const byStage = OPEN_STAGES.map(id => {
    const ds = state.deals.filter(d => d.stage === id);
    return { stage: stageById(id), count: ds.length, value: ds.reduce((s, d) => s + (Number(d.value) || 0), 0) };
  });
  const maxVal = Math.max(1, ...byStage.map(b => b.value));
  barsEl.innerHTML = byStage.map(b => `
    <div class="stage-bar-row">
      <span>${b.stage.label}</span>
      <div class="stage-bar-track"><div class="stage-bar-fill" style="width:${Math.max(b.value ? 3 : 0, b.value / maxVal * 100)}%;background:${stageColor(b.stage.id)};"></div></div>
      <span class="stage-bar-val"><b>${fmtMoney(b.value)}</b> · ${b.count}</span>
    </div>`).join("");

  // Closing soon
  const in30 = new Date(now.getTime() + 30*86400000).toISOString().slice(0,10);
  const closing = open.filter(d => d.closeDate && d.closeDate <= in30).sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  document.getElementById("d-closing-total").textContent = closing.length ? fmtMoney(closing.reduce((s, d) => s + (Number(d.value) || 0), 0)) : "";
  const closingEl = document.getElementById("d-closing");
  closingEl.innerHTML = "";
  if(!closing.length) closingEl.innerHTML = '<div class="empty-note">No open deals are due to close in the next 30 days.</div>';
  closing.slice(0, 6).forEach(d => {
    const co = companyById(d.companyId);
    const overdue = d.closeDate < todayIso();
    const row = document.createElement("div");
    row.className = "list-row";
    row.tabIndex = 0;
    row.innerHTML = `
      <div class="lr-main"><div class="lr-title">${escapeHtml(d.title)}</div><div class="lr-sub">${escapeHtml(co ? co.name : "No company")} · ${stageById(d.stage).label}</div></div>
      <div class="lr-side"><div><b>${fmtMoney(d.value)}</b></div><div class="card-due-badge${overdue ? " overdue" : ""}">${fmtDay(d.closeDate)}</div></div>`;
    row.addEventListener("click", () => openRecordModal("deal", d.id));
    closingEl.appendChild(row);
  });

  // Tasks
  const tasksOpen = state.board.filter(t => t.column !== "done");
  const done = state.board.filter(t => t.column === "done").length;
  const total = state.board.length;
  const overdue = state.board.filter(t => t.column !== "done" && t.dueDate && new Date(t.dueDate + "T" + (t.dueTime || "23:59")) < now).length;
  document.getElementById("d-tasks-overdue").textContent = overdue;
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById("d-progress").style.width = pct + "%";
  document.getElementById("d-progress-label").textContent = total ? `${done} of ${total} tasks complete (${pct}%)` : "No tasks yet.";

  const upcoming = tasksOpen.slice().sort((a, b) => {
    const da = a.dueDate ? new Date(a.dueDate + "T" + (a.dueTime || "00:00")).getTime() : Infinity;
    const db = b.dueDate ? new Date(b.dueDate + "T" + (b.dueTime || "00:00")).getTime() : Infinity;
    return da - db;
  }).slice(0, 5);
  const nextEl = document.getElementById("d-next");
  nextEl.innerHTML = "";
  if(!upcoming.length){ nextEl.innerHTML = '<div class="empty-note">Every task is complete.</div>'; }
  upcoming.forEach(t => {
    const row = document.createElement("div");
    row.className = "list-row";
    row.tabIndex = 0;
    const due = formatDueBadge(t);
    const priority = t.priority || "none";
    const deal = t.dealId ? dealById(t.dealId) : null;
    row.innerHTML =
      `<div class="lr-main"><div class="lr-title">${escapeHtml(t.title)}</div><div class="lr-sub">${escapeHtml(t.workstream || "")}${deal ? " · " + escapeHtml(deal.title) : ""}</div></div>` +
      `<div class="lr-side" style="display:flex;gap:6px;align-items:center;">` +
      (priority !== "none" ? `<span class="priority-badge priority-${priority}">${priorityLabel(priority)}</span>` : "") +
      (due ? `<span class="card-due-badge${due.overdue ? " overdue" : ""}">${due.text}</span>` : "") + `</div>`;
    row.addEventListener("click", () => { switchTab("board"); openTaskViewModal(t.id); });
    nextEl.appendChild(row);
  });

  // Recent activity
  const actEl = document.getElementById("d-activity");
  const recent = state.activities.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  actEl.innerHTML = recent.length ? "" : '<div class="empty-note">Calls, emails and meetings you log on a contact or deal show up here.</div>';
  recent.forEach(a => actEl.appendChild(makeTimelineItem(a, true)));
}

/* ============================================================
   PIPELINE (deals Kanban)
============================================================ */
function populateOwnerFilter(){
  const sel = document.getElementById("pipeline-owner");
  const cur = sel.value;
  sel.innerHTML = '<option value="">Everyone\'s deals</option>' +
    teamList.filter(p => p.confirmed !== false).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.display_name || p.email)}</option>`).join("");
  sel.value = cur;
}

function renderPipeline(){
  populateOwnerFilter();
  const q = (document.getElementById("pipeline-search").value || "").trim().toLowerCase();
  const owner = document.getElementById("pipeline-owner").value;
  const deals = state.deals.filter(d => {
    if(owner && d.ownerId !== owner) return false;
    if(!q) return true;
    const co = companyById(d.companyId);
    return (d.title + " " + (co ? co.name : "") + " " + contactName(contactById(d.contactId))).toLowerCase().includes(q);
  });

  const openDeals = deals.filter(d => OPEN_STAGES.includes(d.stage));
  const openValue = openDeals.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const weighted = openDeals.reduce((s, d) => s + (Number(d.value) || 0) * stageById(d.stage).prob / 100, 0);
  document.getElementById("pipeline-summary").innerHTML =
    `<span>Open <b>${fmtMoney(openValue)}</b></span><span>Weighted <b>${fmtMoney(weighted)}</b></span><span><b>${openDeals.length}</b> open deals</span>`;

  const wrap = document.getElementById("pipeline");
  wrap.innerHTML = "";
  STAGES.forEach(stage => {
    const items = deals.filter(d => d.stage === stage.id);
    const col = document.createElement("div");
    col.className = "board-col stage-" + stage.id;
    col.style.setProperty("--col-color", stageColor(stage.id));
    col.innerHTML = `
      <div class="board-col-head"><span>${stage.label}</span><span class="n">${items.length}</span></div>
      <div class="board-col-total">${fmtMoney(items.reduce((s, d) => s + (Number(d.value) || 0), 0))}${OPEN_STAGES.includes(stage.id) ? ` · ${stage.prob}%` : ""}</div>
      <div class="board-col-body" data-stage="${stage.id}"></div>`;
    const body = col.querySelector(".board-col-body");
    items.sort((a, b) => (a.closeDate || "9").localeCompare(b.closeDate || "9")).forEach(d => body.appendChild(makeDealCard(d)));

    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", guardEdit((e) => {
      e.preventDefault();
      body.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      moveDealToStage(id, stage.id);
    }));
    wrap.appendChild(col);
  });
}

function moveDealToStage(id, stageId){
  const deal = dealById(id);
  if(!deal || deal.stage === stageId || !canEditRecord("deal", deal)) return;
  deal.stage = stageId;
  if(stageId === "won" || stageId === "lost") deal.closedAt = todayIso();
  else delete deal.closedAt;
  saveState(); renderPipeline(); renderDashboard(); renderCompanies();
  if(stageId === "won") notify("Deal won", `${deal.title} · ${fmtMoney(deal.value)}`);
}

function makeDealCard(d){
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = canEditRecord("deal", d);
  if(!card.draggable) card.dataset.locked = "true";
  card.tabIndex = 0;
  card.dataset.id = d.id;
  const co = companyById(d.companyId);
  const owner = personById(d.ownerId);
  const overdue = d.closeDate && OPEN_STAGES.includes(d.stage) && d.closeDate < todayIso();
  card.innerHTML = `
    <div class="card-title">${escapeHtml(d.title)}</div>
    <div class="card-meta">${escapeHtml(co ? co.name : "No company")}</div>
    <div class="card-value">${fmtMoney(d.value)}</div>
    <div class="card-meta-row">
      ${d.closeDate ? `<span class="card-due-badge${overdue ? " overdue" : ""}">${fmtDay(d.closeDate)}</span>` : ""}
      ${owner ? `<span class="card-assignee" title="${escapeHtml(owner.display_name || owner.email)}">${escapeHtml(initials(owner.display_name, owner.email))}</span>` : ""}
    </div>`;
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", d.id);
    setTimeout(() => card.style.opacity = "0.4", 0);
  });
  card.addEventListener("dragend", () => card.style.opacity = "1");
  card.addEventListener("click", () => openRecordModal("deal", d.id));
  return card;
}

/* ============================================================
   CONTACTS
============================================================ */
function statusLabel(id){ const s = CONTACT_STATUSES.find(x => x.id === id); return s ? s.label : "Lead"; }

function renderContacts(){
  const q = (document.getElementById("contacts-search").value || "").trim().toLowerCase();
  const status = document.getElementById("contacts-status").value;
  const rows = state.contacts.filter(c => {
    if(status && c.status !== status) return false;
    if(!q) return true;
    const co = companyById(c.companyId);
    return [contactName(c), c.email, c.phone, c.title, co ? co.name : ""].join(" ").toLowerCase().includes(q);
  }).sort((a, b) => contactName(a).localeCompare(contactName(b)));

  document.getElementById("contacts-count").textContent = `${rows.length} of ${state.contacts.length}`;
  const tbody = document.getElementById("contacts-tbody");
  tbody.innerHTML = "";
  if(!rows.length){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${state.contacts.length ? "No contacts match that search." : "No contacts yet. Add the first one with New contact."}</td></tr>`;
    return;
  }
  rows.forEach(c => {
    const co = companyById(c.companyId);
    const owner = personById(c.ownerId);
    const local = lastTouch(a => a.contactId === c.id);
    const touched = [c.lastActivityAt, local].filter(Boolean).sort().pop() || null;
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.tabIndex = 0;
    tr.dataset.id = c.id;
    tr.innerHTML = `
      <td><div class="cell-name"><div class="avatar avatar-sm">${escapeHtml(initials(contactName(c), c.email))}</div><div><div style="font-weight:600;">${escapeHtml(contactName(c))}</div><div class="sub">${escapeHtml(c.title || "")}</div></div></div></td>
      <td>${escapeHtml(co ? co.name : "")}</td>
      <td>${escapeHtml(c.email || "")}</td>
      <td style="white-space:nowrap;" class="phone-cell">${escapeHtml(c.phone || "")}</td>
      <td><span class="pill pill-${escapeHtml(c.status || "lead")}">${statusLabel(c.status)}</span></td>
      <td>${escapeHtml(owner ? (owner.display_name || owner.email) : "")}</td>
      <td class="sub" style="white-space:nowrap;">${touched ? relTime(touched) : "Never"}</td>`;
    // e.g. a click-to-call button next to the number (js/dialer.js)
    CRMHooks.emit("contact:row-actions", c).flat().forEach(el => { if(el instanceof window.Node) tr.querySelector(".phone-cell").appendChild(el); });
    tr.addEventListener("click", () => openRecordModal("contact", c.id));
    tbody.appendChild(tr);
  });
}

/* ============================================================
   COMPANIES
============================================================ */
function renderCompanies(){
  const q = (document.getElementById("companies-search").value || "").trim().toLowerCase();
  const rows = state.companies.filter(c => !q || [c.name, c.industry, c.city, c.website].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  document.getElementById("companies-count").textContent = `${rows.length} of ${state.companies.length}`;
  const tbody = document.getElementById("companies-tbody");
  tbody.innerHTML = "";
  if(!rows.length){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${state.companies.length ? "No companies match that search." : "No companies yet. Add the first one with New company."}</td></tr>`;
    return;
  }
  rows.forEach(c => {
    const contacts = state.contacts.filter(x => x.companyId === c.id).length;
    const deals = state.deals.filter(d => d.companyId === c.id);
    const openVal = deals.filter(d => OPEN_STAGES.includes(d.stage)).reduce((s, d) => s + (Number(d.value) || 0), 0);
    const wonVal = deals.filter(d => d.stage === "won").reduce((s, d) => s + (Number(d.value) || 0), 0);
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.tabIndex = 0;
    tr.dataset.id = c.id;
    tr.innerHTML = `
      <td><div style="font-weight:600;">${escapeHtml(c.name)}</div><div class="sub">${escapeHtml(c.website || "")}</div></td>
      <td>${escapeHtml(c.industry || "")}</td>
      <td>${escapeHtml(c.city || "")}</td>
      <td class="num">${contacts}</td>
      <td class="num">${openVal ? fmtMoney(openVal) : "–"}</td>
      <td class="num">${wonVal ? fmtMoney(wonVal) : "–"}</td>`;
    tr.addEventListener("click", () => openRecordModal("company", c.id));
    tbody.appendChild(tr);
  });
}

/* ============================================================
   RECORD MODAL (contacts, companies, deals share one form engine)
============================================================ */
const opt = (value, label) => ({ value, label });
const teamOptions = () => [opt("", "Unassigned")].concat(teamList.filter(p => p.confirmed !== false).map(p => opt(p.id, p.display_name || p.email)));
const companyOptions = () => [opt("", "No company")].concat(state.companies.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => opt(c.id, c.name)));
const contactOptions = () => [opt("", "No contact")].concat(state.contacts.slice().sort((a, b) => contactName(a).localeCompare(contactName(b))).map(c => opt(c.id, contactName(c))));

const RECORD_KINDS = {
  contact: {
    collection:"contacts", idKind:"contact", prefix:"c", noun:"contact",
    title: r => contactName(r),
    fields: [
      [{key:"firstName", label:"First name", required:true}, {key:"lastName", label:"Last name"}],
      [{key:"email", label:"Email", type:"email"}, {key:"phone", label:"Phone", type:"tel"}],
      [{key:"title", label:"Job title"}, {key:"companyId", label:"Company", type:"select", options:companyOptions}],
      [{key:"status", label:"Status", type:"select", options:() => CONTACT_STATUSES.map(s => opt(s.id, s.label))}, {key:"ownerId", label:"Owner", type:"select", options:teamOptions}],
      [{key:"source", label:"Source", type:"select", options:() => [opt("", "Unknown")].concat(SOURCES.map(s => opt(s, s)))}],
      [{key:"notes", label:"Notes", type:"textarea"}],
    ],
    defaults: () => ({ status:"lead", ownerId: currentUser ? currentUser.id : "" }),
  },
  company: {
    collection:"companies", idKind:"company", prefix:"co", noun:"company",
    title: r => r.name,
    fields: [
      [{key:"name", label:"Company name", required:true}],
      [{key:"industry", label:"Industry", type:"select", options:() => [opt("", "Not set")].concat(INDUSTRIES.map(s => opt(s, s)))}, {key:"city", label:"City"}],
      [{key:"website", label:"Website"}, {key:"phone", label:"Phone", type:"tel"}],
      [{key:"notes", label:"Notes", type:"textarea"}],
    ],
    defaults: () => ({}),
  },
  deal: {
    collection:"deals", idKind:"deal", prefix:"d", noun:"deal",
    title: r => r.title,
    fields: [
      [{key:"title", label:"Deal name", required:true, placeholder:"e.g. Brand identity refresh"}],
      [{key:"companyId", label:"Company", type:"select", options:companyOptions}, {key:"contactId", label:"Main contact", type:"select", options:contactOptions}],
      [{key:"value", label:"Value", type:"number"}, {key:"closeDate", label:"Expected close", type:"date"}],
      [{key:"stage", label:"Stage", type:"select", options:() => STAGES.map(s => opt(s.id, s.label))}, {key:"ownerId", label:"Owner", type:"select", options:teamOptions}],
      [{key:"notes", label:"Notes", type:"textarea"}],
    ],
    defaults: () => ({ stage:"lead", ownerId: currentUser ? currentUser.id : "", closeDate: isoDay(30) }),
  },
};

let openRecord = { kind:null, id:null, prefill:null };

function openRecordModal(kind, id, prefill){
  const def = RECORD_KINDS[kind];
  const record = id ? state[def.collection].find(r => r.id === id) : null;
  if(id && !record) return;
  openRecord = { kind, id: record ? record.id : null, prefill: prefill || null };
  const values = record ? record : { ...def.defaults(), ...(prefill || {}) };

  document.getElementById("rm-heading").textContent = record ? def.title(record) : "New " + def.noun;
  const form = document.getElementById("rm-form");
  form.innerHTML = def.fields.map(row => `<div class="tm-row">${row.map(f => {
    const fid = "rm-" + f.key;
    const v = values[f.key] == null ? "" : values[f.key];
    let input;
    if(f.type === "select"){
      input = `<select id="${fid}">${f.options().map(o => `<option value="${escapeHtml(o.value)}"${String(o.value) === String(v) ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>`;
    } else if(f.type === "textarea"){
      input = `<textarea id="${fid}">${escapeHtml(v)}</textarea>`;
    } else {
      input = `<input id="${fid}" type="${f.type || "text"}" value="${escapeHtml(v)}"${f.type === "number" ? ' min="0" step="100"' : ""}${f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : ""} />`;
    }
    return `<div class="tm-field"><label for="${fid}">${f.label}${kind === "deal" && f.key === "value" ? " (" + escapeHtml(state.settings.currency) + ")" : ""}</label>${input}</div>`;
  }).join("")}</div>`).join("");

  document.getElementById("rm-layout").classList.toggle("single", !record);
  document.getElementById("rm-delete-btn").classList.toggle("hidden", !record);
  document.getElementById("rm-delete-btn").textContent = "Delete " + def.noun;
  document.getElementById("rm-save-btn").textContent = record ? "Save changes" : "Create " + def.noun;
  renderRecordActions(kind, record);
  renderRecordRelated();
  const editable = canEditRecord(kind, record);
  lockControls([...form.querySelectorAll("input, select, textarea")], !editable);
  if(editable && !canReassignRecord(record)) lockControls([document.getElementById("rm-ownerId")], true);
  document.getElementById("rm-save-btn").classList.toggle("hidden", !editable && currentRole !== "viewer");
  if(!editable) document.getElementById("rm-delete-btn").classList.add("hidden");
  let note = document.getElementById("rm-readonly-note");
  if(!note){
    note = document.createElement("div");
    note.id = "rm-readonly-note";
    note.className = "panel-sub";
    form.parentNode.insertBefore(note, form);
  }
  note.textContent = record && !editable && currentRole !== "viewer" ? recordReadOnlyNote(kind, record) : "";
  note.classList.toggle("hidden", !note.textContent);
  document.getElementById("record-modal-overlay").classList.remove("hidden");
  applyRolePermissions();
  const first = form.querySelector("input, select");
  if(first && !record) first.focus();
}

// Buttons in the record header (Email, Call...) come from the feature modules.
function renderRecordActions(kind, record){
  const bar = document.getElementById("rm-actions");
  if(!bar) return;
  bar.innerHTML = "";
  if(!record) return;
  CRMHooks.emit("record:actions", kind, record).flat().forEach(el => { if(el instanceof window.Node) bar.appendChild(el); });
}

function closeRecordModal(){
  document.getElementById("record-modal-overlay").classList.add("hidden");
  openRecord = { kind:null, id:null, prefill:null };
}

function readRecordForm(kind){
  const out = {};
  RECORD_KINDS[kind].fields.flat().forEach(f => {
    const el = document.getElementById("rm-" + f.key);
    if(!el) return;
    let v = el.value;
    if(f.type === "number") v = v === "" ? 0 : Math.max(0, Number(v) || 0);
    else if(typeof v === "string") v = v.trim();
    out[f.key] = v;
  });
  return out;
}

const saveRecordFromModal = guardEdit(function(){
  const { kind, id } = openRecord;
  if(!kind) return;
  const def = RECORD_KINDS[kind];
  const fields = readRecordForm(kind);
  const missing = def.fields.flat().find(f => f.required && !fields[f.key]);
  if(missing){ document.getElementById("rm-" + missing.key).focus(); return; }

  if(kind === "contact" && fields.email && state.contacts.some(c => c.id !== id && c.email && c.email.toLowerCase() === fields.email.toLowerCase())){
    notify("Possible duplicate", `Another contact already uses ${fields.email}. Saved anyway.`);
  }
  if(kind === "deal" && fields.contactId && !fields.companyId){
    const ct = contactById(fields.contactId);
    if(ct && ct.companyId) fields.companyId = ct.companyId;
  }

  let record;
  if(id){
    record = state[def.collection].find(r => r.id === id);
    if(!record || !canEditRecord(kind, record)) return;
    if(!canReassignRecord(record) && "ownerId" in fields) fields.ownerId = record.ownerId;
    if(kind === "deal" && record.stage !== fields.stage){
      if(fields.stage === "won" || fields.stage === "lost") fields.closedAt = todayIso();
      else record.closedAt = undefined;
    }
    Object.assign(record, fields);
  } else {
    record = { id: nextId(def.idKind, def.prefix), ...fields, createdBy: currentUser ? currentUser.id : null, createdAt: new Date().toISOString() };
    if(kind === "deal" && (fields.stage === "won" || fields.stage === "lost")) record.closedAt = todayIso();
    state[def.collection].push(record);
  }
  saveState();
  renderAll();
  applyRolePermissions();
  if(!id){
    // Keep the new record open so related items can be added straight away.
    openRecordModal(kind, record.id);
    notify(def.noun.charAt(0).toUpperCase() + def.noun.slice(1) + " created", def.title(record));
  } else {
    closeRecordModal();
  }
});

const deleteRecordFromModal = guardEdit(async function(){
  const { kind, id } = openRecord;
  if(!kind || !id) return;
  const def = RECORD_KINDS[kind];
  const record = state[def.collection].find(r => r.id === id);
  if(!record || !canEditRecord(kind, record)) return;
  let extra = "";
  if(kind === "company"){
    const n = state.contacts.filter(c => c.companyId === id).length;
    if(n) extra = ` Its ${n} contact${n === 1 ? "" : "s"} stay but lose the company link.`;
  }
  if(!await confirmDialog(`Delete ${def.title(record)}? This can't be undone.${extra}`, "Delete")) return;
  state[def.collection] = state[def.collection].filter(r => r.id !== id);
  // The database clears links to the deleted record itself (on delete set null),
  // including on records this person can't edit, so only the screen changes here.
  if(kind === "company"){
    changeLocallyOnly("contacts", c => c.companyId === id, c => { c.companyId = ""; });
    changeLocallyOnly("deals", d => d.companyId === id, d => { d.companyId = ""; });
  } else if(kind === "contact"){
    changeLocallyOnly("deals", d => d.contactId === id, d => { d.contactId = ""; });
    changeLocallyOnly("board", t => t.contactId === id, t => { t.contactId = null; });
  } else if(kind === "deal"){
    changeLocallyOnly("board", t => t.dealId === id, t => { t.dealId = null; });
  }
  // The database deletes the notes that only belonged to this lead or deal
  // (any author's); here they are just dropped from the screen.
  forgetLocalRecords("activities", a => (a.source || "manual") === "manual" && (
    (kind === "contact" && a.contactId === id && !a.dealId) ||
    (kind === "deal" && a.dealId === id && !a.contactId)
  ));
  saveState();
  closeRecordModal();
  renderAll();
});

function activityFilterFor(kind, id){
  if(kind === "contact") return a => a.contactId === id;
  if(kind === "deal") return a => a.dealId === id;
  if(kind === "company"){
    const contactIds = new Set(state.contacts.filter(c => c.companyId === id).map(c => c.id));
    return a => a.companyId === id || contactIds.has(a.contactId);
  }
  return () => false;
}

function miniDealRow(d){
  const row = document.createElement("div");
  row.className = "list-row";
  row.tabIndex = 0;
  row.innerHTML = `<div class="lr-main"><div class="lr-title">${escapeHtml(d.title)}</div><div class="lr-sub">${stageById(d.stage).label}${d.closeDate ? " · " + fmtDay(d.closeDate) : ""}</div></div><div class="lr-side"><b>${fmtMoney(d.value)}</b></div>`;
  row.addEventListener("click", () => openRecordModal("deal", d.id));
  return row;
}

function renderRecordRelated(){
  const { kind, id } = openRecord;
  const box = document.getElementById("rm-related");
  box.innerHTML = "";
  if(!kind || !id) return;

  const addSection = (title, actionLabel, onAction) => {
    const sec = document.createElement("section");
    sec.innerHTML = `<div class="panel-head" style="margin-bottom:4px;"><h4>${title}</h4>${actionLabel ? `<button type="button" class="panel-link">${actionLabel}</button>` : ""}</div><div class="mini-list"></div>`;
    if(actionLabel) sec.querySelector(".panel-link").addEventListener("click", guardEdit(onAction));
    box.appendChild(sec);
    return sec.querySelector(".mini-list");
  };

  if(kind === "contact"){
    const c = contactById(id);
    const list = addSection("Deals", "+ Add deal", () => openRecordModal("deal", null, { contactId:id, companyId:c.companyId || "", title:"" }));
    const ds = state.deals.filter(d => d.contactId === id);
    if(!ds.length) list.innerHTML = '<div class="empty-note">No deals with this contact yet.</div>';
    ds.forEach(d => list.appendChild(miniDealRow(d)));
  }
  if(kind === "company"){
    const cl = addSection("People", "+ Add contact", () => openRecordModal("contact", null, { companyId:id }));
    const cs = state.contacts.filter(c => c.companyId === id);
    if(!cs.length) cl.innerHTML = '<div class="empty-note">No contacts at this company yet.</div>';
    cs.forEach(c => {
      const row = document.createElement("div");
      row.className = "list-row";
      row.tabIndex = 0;
      row.innerHTML = `<div class="avatar avatar-sm">${escapeHtml(initials(contactName(c), c.email))}</div><div class="lr-main"><div class="lr-title">${escapeHtml(contactName(c))}</div><div class="lr-sub">${escapeHtml(c.title || c.email || "")}</div></div><span class="pill pill-${escapeHtml(c.status || "lead")}">${statusLabel(c.status)}</span>`;
      row.addEventListener("click", () => openRecordModal("contact", c.id));
      cl.appendChild(row);
    });
    const dl = addSection("Deals", "+ Add deal", () => openRecordModal("deal", null, { companyId:id }));
    const ds = state.deals.filter(d => d.companyId === id);
    if(!ds.length) dl.innerHTML = '<div class="empty-note">No deals with this company yet.</div>';
    ds.forEach(d => dl.appendChild(miniDealRow(d)));
  }
  if(kind === "deal"){
    const ts = addSection("Tasks", "+ Add task", () => { closeRecordModal(); openTaskModal(null, { dealId:id }); });
    const tasks = state.board.filter(t => t.dealId === id);
    if(!tasks.length) ts.innerHTML = '<div class="empty-note">No tasks linked to this deal.</div>';
    tasks.forEach(t => {
      const row = document.createElement("div");
      row.className = "list-row";
      row.tabIndex = 0;
      const due = formatDueBadge(t);
      row.innerHTML = `<div class="lr-main"><div class="lr-title" style="${t.column === "done" ? "text-decoration:line-through;color:var(--muted);" : ""}">${escapeHtml(t.title)}</div><div class="lr-sub">${COLUMNS.find(c => c.id === t.column).label}</div></div>${due ? `<span class="card-due-badge${due.overdue ? " overdue" : ""}">${due.text}</span>` : ""}`;
      row.addEventListener("click", () => { closeRecordModal(); openTaskModal(t.id); });
      ts.appendChild(row);
    });
  }

  // Feature modules can add their own sections (e.g. connected mailboxes).
  CRMHooks.emit("record:sections", kind, id, box);

  // The unified activity timeline (js/timeline.js): emails, calls, tasks and
  // notes in one list, with the form for logging an activity by hand.
  renderTimelineSection(box, kind, id);
  applyRolePermissions();
}

// Logs an activity by hand against a contact, company or deal. Returns it.
//   fields: { type, subject, body, visibility: "team" | "private", at, meta }
function logActivity(kind, id, fields){
  if(currentRole === "viewer") return null;
  const a = {
    id: newId(), type: fields.type || "note", source: "manual", subject: fields.subject || "", body: fields.body || "",
    at: fields.at || new Date().toISOString(), by: currentUser ? currentUser.id : null,
    contactId:"", dealId:"", companyId:"", relatedContactIds: [],
    visibility: fields.visibility === "private" ? "private" : "team",
    ownerUserId: fields.visibility === "private" && currentUser ? currentUser.id : null,
    meta: fields.meta || {},
  };
  if(kind === "contact"){ const c = contactById(id); a.contactId = id; a.companyId = c ? (c.companyId || "") : ""; }
  if(kind === "company"){ a.companyId = id; }
  if(kind === "deal"){ const d = dealById(id); a.dealId = id; a.contactId = d ? (d.contactId || "") : ""; a.companyId = d ? (d.companyId || "") : ""; }
  state.activities.unshift(a);
  saveState();
  renderDashboard();
  renderContacts();
  CRMHooks.emit("activity:logged", a);
  return a;
}

// Kept for older callers; the timeline module draws every activity type.
function makeTimelineItem(a, withContext){
  return renderActivityItem(a, { withContext: !!withContext });
}

/* ============================================================
   TASKS (Kanban)
============================================================ */
const COLUMNS = [
  {id:"todo", label:"To do"},
  {id:"doing", label:"In progress"},
  {id:"done", label:"Done"},
];

function renderBoard(){
  const board = document.getElementById("board");
  board.innerHTML = "";
  COLUMNS.forEach(col => {
    const colDiv = document.createElement("div");
    colDiv.className = "board-col col-" + col.id;
    const items = state.board.filter(t => t.column === col.id);
    colDiv.innerHTML = `
      <div class="board-col-head"><span>${col.label}</span><span class="n">${items.length}</span></div>
      <div class="board-col-body" data-col="${col.id}"></div>`;
    const body = colDiv.querySelector(".board-col-body");
    items.forEach(t => body.appendChild(makeCard(t)));

    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", guardEdit((e) => {
      e.preventDefault();
      body.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      const task = state.board.find(t => t.id === id);
      if(task && canEditRecord("task", task)){ task.column = col.id; saveState(); renderBoard(); renderDashboard(); }
    }));
    board.appendChild(colDiv);
  });

  const trigger = document.getElementById("add-task-trigger");
  if(trigger && !trigger.dataset.wired){
    trigger.dataset.wired = "true";
    trigger.addEventListener("click", () => openTaskModal(null));
  }
}

function priorityLabel(p){ return { none:"None", low:"Low", medium:"Medium", high:"High" }[p] || "None"; }

function formatDueBadge(t){
  if(!t.dueDate) return null;
  const d = new Date(t.dueDate + "T" + (t.dueTime || "00:00"));
  const now = new Date();
  const isOverdue = d < now && t.column !== "done";
  const dateStr = d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
  const timeStr = t.dueTime ? d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" }) : "";
  return { text: dateStr + (timeStr ? " · " + timeStr : ""), overdue: isOverdue };
}

// The lead a task is about: its own lead, or the main contact of its deal.
function taskLead(t){
  if(!t) return null;
  if(t.contactId){ const c = contactById(t.contactId); if(c) return c; }
  const d = t.dealId ? dealById(t.dealId) : null;
  return d && d.contactId ? contactById(d.contactId) : null;
}

function makeCard(t){
  const card = document.createElement("div");
  card.className = "card";
  const editable = canEditRecord("task", t);
  card.draggable = editable;
  if(!editable) card.dataset.locked = "true";
  card.tabIndex = 0;
  card.dataset.id = t.id;
  const priority = t.priority || "none";
  let metaRowHtml = priority !== "none" ? `<span class="priority-badge priority-${priority}">${priorityLabel(priority)}</span>` : "";
  const due = formatDueBadge(t);
  if(due) metaRowHtml += `<span class="card-due-badge${due.overdue ? " overdue" : ""}">${due.text}</span>`;
  if(t.assignedTo){
    const person = personById(t.assignedTo);
    if(person) metaRowHtml += `<span class="card-assignee">${escapeHtml((person.display_name || person.email).split(" ")[0])}</span>`;
  }
  const deal = t.dealId ? dealById(t.dealId) : null;
  const lead = taskLead(t);
  const context = [deal ? deal.title : "", lead ? contactName(lead) : ""].filter(Boolean).join(" · ");
  card.innerHTML = `
    <button type="button" class="card-del" title="Delete task" aria-label="Delete task">×</button>
    <div class="card-title">${escapeHtml(t.title)}</div>
    <div class="card-meta">${escapeHtml(t.workstream)}${context ? " · " + escapeHtml(context) : ""}</div>
    <div class="card-meta-row">${metaRowHtml}</div>`;
  if(!editable) card.querySelector(".card-del").dataset.locked = "true";
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", t.id);
    setTimeout(() => card.style.opacity = "0.4", 0);
  });
  card.addEventListener("dragend", () => card.style.opacity = "1");
  card.querySelector(".card-del").addEventListener("click", guardEdit((e) => {
    e.stopPropagation();
    if(!canEditRecord("task", t)) return;
    state.board = state.board.filter(x => x.id !== t.id);
    saveState(); renderBoard(); renderDashboard();
  }));
  card.addEventListener("click", () => openTaskModal(t.id));
  return card;
}

/* ============================================================
   TASK MODAL (add / edit)
============================================================ */
let editingTaskId = null;
let viewingTaskId = null;

function populateAssigneeOptions(){
  const sel = document.getElementById("tm-assigned");
  const current = sel.value;
  sel.innerHTML = '<option value="">Unassigned</option>';
  teamList.forEach(p => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.display_name || p.email;
    sel.appendChild(o);
  });
  sel.value = current;
  const dealSel = document.getElementById("tm-deal");
  dealSel.innerHTML = '<option value="">None</option>';
  state.deals.filter(d => OPEN_STAGES.includes(d.stage) || d.stage === "won").forEach(d => {
    const o = document.createElement("option");
    const co = companyById(d.companyId);
    o.value = d.id;
    o.textContent = d.title + (co ? " (" + co.name + ")" : "");
    dealSel.appendChild(o);
  });
  const contactSel = document.getElementById("tm-contact");
  contactSel.innerHTML = '<option value="">None</option>';
  state.contacts.slice().sort((a, b) => contactName(a).localeCompare(contactName(b))).forEach(c => {
    const o = document.createElement("option");
    const co = companyById(c.companyId);
    o.value = c.id;
    o.textContent = contactName(c) + (co ? " (" + co.name + ")" : "");
    contactSel.appendChild(o);
  });
}

function updateTmPriorityBadge(){
  const val = document.getElementById("tm-priority").value;
  const badge = document.getElementById("tm-priority-badge");
  if(val === "none"){ badge.classList.add("hidden"); return; }
  badge.className = "priority-badge priority-" + val;
  badge.textContent = priorityLabel(val);
}

function openTaskViewModal(taskId){
  const task = findRecord("board", taskId);
  viewingTaskId = task ? task.id : null;
  const notesEl = document.getElementById("tv-notes");
  const actions = document.getElementById("tv-actions");
  actions.innerHTML = "";

  if(!task){
    document.getElementById("tv-title").textContent = "Task not found";
    document.getElementById("tv-priority-badge").classList.add("hidden");
    ["tv-column","tv-workstream","tv-due","tv-assigned","tv-deal","tv-contact"].forEach(id => document.getElementById(id).textContent = "—");
    notesEl.textContent = "This task may have been deleted.";
    notesEl.classList.add("tv-empty");
    document.getElementById("tv-edit-btn").classList.add("hidden");
    document.getElementById("task-view-modal-overlay").classList.remove("hidden");
    return;
  }

  document.getElementById("tv-edit-btn").classList.remove("hidden");
  document.getElementById("tv-title").textContent = task.title;
  const priority = task.priority || "none";
  const priorityBadge = document.getElementById("tv-priority-badge");
  if(priority === "none") priorityBadge.classList.add("hidden");
  else { priorityBadge.className = "priority-badge priority-" + priority; priorityBadge.textContent = priorityLabel(priority); }

  const col = COLUMNS.find(c => c.id === task.column);
  document.getElementById("tv-column").textContent = col ? col.label : "To do";
  document.getElementById("tv-workstream").textContent = task.workstream || "—";

  const due = formatDueBadge(task);
  const dueEl = document.getElementById("tv-due");
  if(due){ dueEl.textContent = due.text + (due.overdue ? " (overdue)" : ""); dueEl.classList.remove("tv-empty"); }
  else { dueEl.textContent = "No due date set"; dueEl.classList.add("tv-empty"); }

  const assignedEl = document.getElementById("tv-assigned");
  const person = task.assignedTo ? personById(task.assignedTo) : null;
  assignedEl.textContent = person ? (person.display_name || person.email) : "Unassigned";
  assignedEl.classList.toggle("tv-empty", !person);

  const deal = task.dealId ? dealById(task.dealId) : null;
  const dealEl = document.getElementById("tv-deal");
  dealEl.classList.toggle("tv-empty", !deal);
  if(deal){
    dealEl.innerHTML = `<button type="button" class="panel-link" data-always-enabled="true">${escapeHtml(deal.title)}</button>`;
    dealEl.querySelector("button").addEventListener("click", () => { closeTaskViewModal(); openRecordModal("deal", deal.id); });
  } else {
    dealEl.textContent = "None";
  }

  const lead = taskLead(task);
  const contactEl = document.getElementById("tv-contact");
  contactEl.classList.toggle("tv-empty", !lead);
  if(lead){
    const co = companyById(lead.companyId);
    contactEl.innerHTML = `<button type="button" class="panel-link" data-always-enabled="true">${escapeHtml(contactName(lead))}</button>${co ? ` <span class="sub">· ${escapeHtml(co.name)}</span>` : ""}${lead.phone ? ` <span class="sub">· ${escapeHtml(lead.phone)}</span>` : ""}`;
    contactEl.querySelector("button").addEventListener("click", () => { closeTaskViewModal(); openRecordModal("contact", lead.id); });
  } else {
    contactEl.textContent = "None";
  }

  if(task.notes && task.notes.trim()){ notesEl.textContent = task.notes; notesEl.classList.remove("tv-empty"); }
  else { notesEl.textContent = "No notes added."; notesEl.classList.add("tv-empty"); }

  // e.g. "Call" (js/dialer.js) or "Email" (js/email.js) for the task's lead
  CRMHooks.emit("task:actions", task, lead).flat().forEach(el => { if(el instanceof window.Node) actions.appendChild(el); });
  document.getElementById("task-view-modal-overlay").classList.remove("hidden");
  applyRolePermissions();
}

function closeTaskViewModal(){
  document.getElementById("task-view-modal-overlay").classList.add("hidden");
  viewingTaskId = null;
}

function openTaskModal(taskId, prefill){
  populateAssigneeOptions();
  editingTaskId = taskId;
  const task = taskId ? state.board.find(t => t.id === taskId) : null;
  prefill = prefill || {};

  document.getElementById("task-modal-title").textContent = task ? "Edit task" : "New task";
  document.getElementById("tm-title").value = task ? task.title : (prefill.title || "");
  document.getElementById("tm-due-date").value = task ? (task.dueDate || "") : (prefill.dueDate || "");
  document.getElementById("tm-due-time").value = task ? (task.dueTime || "") : "";
  document.getElementById("tm-reminder").value = task ? (task.reminder || "none") : "at_due";
  document.getElementById("tm-priority").value = task ? (task.priority || "none") : "none";
  updateTmPriorityBadge();
  document.getElementById("tm-workstream").value = task ? (task.workstream || "General") : (prefill.workstream || "Follow-up");
  document.getElementById("tm-assigned").value = task ? (task.assignedTo || "") : (currentUser ? currentUser.id : "");
  document.getElementById("tm-column").value = task ? task.column : "todo";
  document.getElementById("tm-deal").value = task ? (task.dealId || "") : (prefill.dealId || "");
  document.getElementById("tm-contact").value = task ? (task.contactId || "") : (prefill.contactId || "");
  document.getElementById("tm-notes").value = task ? (task.notes || "") : (prefill.notes || "");
  document.getElementById("tm-delete-btn").classList.toggle("hidden", !task);
  const editable = canEditRecord("task", task);
  const overlay = document.getElementById("task-modal-overlay");
  lockControls([...overlay.querySelectorAll(".task-modal-body input, .task-modal-body select, .task-modal-body textarea")], !editable);
  if(editable && !canReassignRecord(task)) lockControls([document.getElementById("tm-assigned")], true);
  document.getElementById("tm-save-btn").classList.toggle("hidden", !editable && currentRole !== "viewer");
  if(!editable) document.getElementById("tm-delete-btn").classList.add("hidden");
  document.getElementById("task-modal-title").textContent = task ? (editable ? "Edit task" : "Task") : "New task";
  overlay.classList.remove("hidden");
  applyRolePermissions();
}

function closeTaskModal(){
  document.getElementById("task-modal-overlay").classList.add("hidden");
  editingTaskId = null;
}

const saveTaskFromModal = guardEdit(function(){
  const title = document.getElementById("tm-title").value.trim();
  if(!title){ document.getElementById("tm-title").focus(); return; }
  const fields = {
    title,
    dueDate: document.getElementById("tm-due-date").value || null,
    dueTime: document.getElementById("tm-due-time").value || null,
    reminder: document.getElementById("tm-reminder").value,
    priority: document.getElementById("tm-priority").value,
    workstream: document.getElementById("tm-workstream").value,
    assignedTo: document.getElementById("tm-assigned").value || null,
    column: document.getElementById("tm-column").value,
    dealId: document.getElementById("tm-deal").value || null,
    contactId: document.getElementById("tm-contact").value || null,
    notes: document.getElementById("tm-notes").value.trim(),
  };
  // A task on a deal is about that deal's main contact unless said otherwise.
  if(!fields.contactId && fields.dealId){
    const d = dealById(fields.dealId);
    if(d && d.contactId) fields.contactId = d.contactId;
  }
  if(editingTaskId){
    const task = state.board.find(t => t.id === editingTaskId);
    if(!task || !canEditRecord("task", task)) return;
    if(!canReassignRecord(task)) fields.assignedTo = task.assignedTo;
    Object.assign(task, fields);
  } else {
    state.board.push({ id: newId(), ...fields, createdBy: currentUser ? currentUser.id : null });
  }
  saveState(); renderBoard(); renderDashboard();
  checkReminders();
  closeTaskModal();
});

const deleteTaskFromModal = guardEdit(function(){
  if(!editingTaskId) return;
  const task = state.board.find(t => t.id === editingTaskId);
  if(!task || !canEditRecord("task", task)) return;
  state.board = state.board.filter(x => x.id !== editingTaskId);
  saveState(); renderBoard(); renderDashboard();
  closeTaskModal();
});

/* ============================================================
   REMINDER NOTIFICATIONS (in the open CRM)
   A toast, the bell and a chime when a task's reminder goes off, shown to
   the person the task is assigned to (unassigned tasks: the owner). Which
   reminders already went off is remembered per person in this browser.
   The matching reminder EMAIL is sent by the server
   (lib/server/notifications), whether or not anyone has the CRM open.
============================================================ */
const REMINDER_OFFSETS_MS = { none:null, at_due:0, "15_min":15*60*1000, "1_hour":60*60*1000, "1_day":24*60*60*1000 };
const MAX_REMINDER_LATE_MS = 24*60*60*1000;

function computeReminderTriggerTime(t){
  if(!t.dueDate || !t.reminder || t.reminder === "none") return null;
  const offset = REMINDER_OFFSETS_MS[t.reminder];
  if(offset === null || offset === undefined) return null;
  // Same moment as the reminder email: due times are in the team's time zone.
  const due = (window.NotificationsUI && NotificationsUI.teamDueInstant && NotificationsUI.teamDueInstant(t.dueDate, t.dueTime))
    || new Date(t.dueDate + "T" + (t.dueTime || "00:00"));
  return new Date(due.getTime() - offset);
}

function reminderKey(t){ return [t.id, t.dueDate, t.dueTime || "", t.reminder].join("|"); }
function firedRemindersStorageKey(){ return "brandigade-crm-fired-reminders:" + (currentUser ? currentUser.id : "anon"); }
function loadFiredReminders(){
  try{ return new Set(JSON.parse(window.localStorage.getItem(firedRemindersStorageKey()) || "[]")); }catch(e){ return new Set(); }
}
function saveFiredReminders(set){
  try{ window.localStorage.setItem(firedRemindersStorageKey(), JSON.stringify([...set].slice(-500))); }catch(e){}
}
function isMyReminder(t){
  if(!currentUser) return false;
  if(t.assignedTo) return t.assignedTo === currentUser.id;
  return currentRole === "owner";
}

function checkReminders(){
  const now = new Date();
  const fired = loadFiredReminders();
  let changed = false;
  state.board.forEach(t => {
    if(t.column === "done" || !isMyReminder(t)) return;
    const key = reminderKey(t);
    if(fired.has(key)) return;
    const trigger = computeReminderTriggerTime(t);
    if(!trigger || trigger > now) return;
    fired.add(key);
    changed = true;
    if(now - trigger > MAX_REMINDER_LATE_MS) return; // long past: don't ring for it
    const due = new Date(trigger.getTime() + REMINDER_OFFSETS_MS[t.reminder]);
    const timeStr = t.dueTime ? due.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" }) : "";
    const bodyText = "Due " + due.toLocaleDateString(undefined,{month:"short",day:"numeric"}) + (timeStr ? " · " + timeStr : "");
    showToast(t.title, bodyText, t.priority);
    addNotification(t.title, bodyText, t.id, t.priority);
    playBellSound();
  });
  if(changed) saveFiredReminders(fired);
}

let reminderIntervalHandle = null;
function startReminderChecks(){
  checkReminders();
  if(reminderIntervalHandle) clearInterval(reminderIntervalHandle);
  reminderIntervalHandle = setInterval(checkReminders, 20000);
}

/* ============================================================
   NOTIFICATION HISTORY (bell). Per browser, in localStorage.
============================================================ */
const NOTIF_STORAGE_KEY = "brandigade-crm-notifications";
let notificationHistory = [];

function loadNotificationHistory(){
  try{
    const raw = window.localStorage.getItem(NOTIF_STORAGE_KEY);
    notificationHistory = raw ? JSON.parse(raw) : [];
  }catch(e){ notificationHistory = []; }
}
function saveNotificationHistory(){
  try{ window.localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(notificationHistory)); }catch(e){}
}

function addNotification(title, body, taskId, priority){
  notificationHistory.unshift({
    id: "n" + Date.now() + Math.random().toString(36).slice(2,7),
    title, body, taskId, priority: priority || "none",
    createdAt: new Date().toISOString(), read:false,
  });
  if(notificationHistory.length > 30) notificationHistory.length = 30;
  saveNotificationHistory();
  renderNotifBell();
}

function renderNotifBell(){
  const badge = document.getElementById("notif-badge");
  if(!badge) return;
  const count = notificationHistory.length;
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.classList.toggle("hidden", count === 0);
}

function clearNotification(id){
  notificationHistory = notificationHistory.filter(n => n.id !== id);
  saveNotificationHistory(); renderNotifBell(); renderNotifDropdown();
}
function clearAllNotifications(){
  notificationHistory = [];
  saveNotificationHistory(); renderNotifBell(); renderNotifDropdown();
}

function renderNotifDropdown(){
  const list = document.getElementById("notif-list");
  if(!list) return;
  const clearAllBtn = document.getElementById("notif-clear-all");
  if(clearAllBtn) clearAllBtn.classList.toggle("hidden", notificationHistory.length === 0);
  if(notificationHistory.length === 0){ list.innerHTML = '<div class="notif-empty">No notifications yet.</div>'; return; }
  list.innerHTML = "";
  notificationHistory.forEach(n => {
    const item = document.createElement("div");
    item.className = "notif-item" + (n.taskId ? " clickable" : "");
    if(n.taskId) item.tabIndex = 0;
    const when = new Date(n.createdAt);
    const timeStr = when.toLocaleDateString(undefined,{month:"short",day:"numeric"}) + " · " + when.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
    const badgeHtml = (n.priority && n.priority !== "none") ? `<span class="priority-badge priority-${n.priority}" style="margin-left:6px;">${priorityLabel(n.priority)}</span>` : "";
    item.innerHTML = `
      <button type="button" class="notif-item-clear" title="Clear this notification" aria-label="Clear this notification" data-always-enabled="true">&times;</button>
      <div class="notif-item-title">${escapeHtml(n.title)}${badgeHtml}</div>
      <div class="notif-item-body">${escapeHtml(n.body)}</div>
      <div class="notif-item-time">${timeStr}</div>`;
    item.querySelector(".notif-item-clear").addEventListener("click", (e) => { e.stopPropagation(); clearNotification(n.id); });
    if(n.taskId){
      item.addEventListener("click", () => {
        toggleNotifDropdown(false);
        switchTab("board");
        setTimeout(() => openTaskModal(n.taskId), 50);
      });
    }
    list.appendChild(item);
  });
}

function toggleNotifDropdown(forceState){
  const dropdown = document.getElementById("notif-dropdown");
  if(!dropdown) return;
  const show = forceState !== undefined ? forceState : dropdown.classList.contains("hidden");
  dropdown.classList.toggle("hidden", !show);
  const bell = document.getElementById("notif-bell-btn");
  if(bell) bell.setAttribute("aria-expanded", show ? "true" : "false");
  if(show) renderNotifDropdown();
}

function showToast(title, body, priority){
  const container = document.getElementById("toast-container");
  if(!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  const badgeHtml = (priority && priority !== "none") ? `<span class="priority-badge priority-${priority}" style="margin-left:6px;">${priorityLabel(priority)}</span>` : "";
  toast.innerHTML = `<button type="button" class="toast-close" aria-label="Dismiss">&times;</button><div class="toast-title">${escapeHtml(title)}${badgeHtml}</div><div class="toast-body">${escapeHtml(body)}</div>`;
  toast.querySelector(".toast-close").addEventListener("click", () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => { if(toast.parentNode) toast.remove(); }, 6000);
}

// A soft two-tone bell, synthesized so the app stays one self-contained file.
function playBellSound(){
  try{
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.08;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.2);
    });
    setTimeout(() => ctx.close(), 1500);
  }catch(e){ /* audio blocked; the visual notification still shows */ }
}

/* ============================================================
   TEAM
============================================================ */
// An address may wrap after its "@" on a narrow screen rather than mid-word.
function breakableEmail(text){ return escapeHtml(text).replace(/@/g, "@<wbr>"); }

function renderTeam(){
  const invitePanel = document.getElementById("invite-panel");
  if(invitePanel) invitePanel.classList.toggle("hidden", currentRole !== "owner");
  const cur = document.getElementById("ws-currency");
  if(cur) cur.value = state.settings.currency || "USD";
  const tzEl = document.getElementById("ws-timezone");
  if(tzEl) tzEl.textContent = state.settings.timezone || "UTC";

  const tbody = document.getElementById("team-tbody");
  if(!tbody) return;
  tbody.innerHTML = "";
  teamList.forEach(person => {
    const tr = document.createElement("tr");
    const isYou = currentUser && person.id === currentUser.id;
    const displayName = person.display_name || person.email;
    const pendingTag = person.confirmed === false ? '<span class="pending-pill">Invited</span>' : "";
    tr.innerHTML = `<td></td><td><span style="font-weight:600;">${breakableEmail(displayName)}</span>${isYou ? '<span class="you-tag">YOU</span>' : ''}${pendingTag}<div class="sub">${breakableEmail(person.email)}</div></td><td></td><td></td>`;

    const avatarEl = document.createElement("div");
    avatarEl.className = "avatar";
    fillAvatarEl(avatarEl, person);
    tr.children[0].appendChild(avatarEl);

    const roleTd = tr.children[2];
    if(person.role === "owner"){
      roleTd.innerHTML = `<span class="role-pill role-owner">owner</span>`;
    } else {
      const select = document.createElement("select");
      select.className = "role-select";
      ["viewer","editor","admin"].forEach(r => {
        const o = document.createElement("option");
        o.value = r; o.textContent = r;
        if(r === person.role) o.selected = true;
        select.appendChild(o);
      });
      select.disabled = currentRole !== "owner";
      select.addEventListener("change", guardEdit(async (e) => {
        const newRole = e.target.value;
        select.disabled = true;
        try{
          const { error } = await sb.from("workspace_members").update({ role: newRole }).eq("workspace_id", currentWorkspace.id).eq("user_id", person.id);
          if(error) throw error;
          person.role = newRole;
        }catch(err){
          notify("Role not changed", err.message || "Unknown error");
          select.value = person.role;
        }finally{
          select.disabled = currentRole !== "owner";
        }
      }));
      roleTd.appendChild(select);
    }

    const removeTd = tr.children[3];
    if(currentRole === "owner" && person.role !== "owner" && !isYou){
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn-del";
      del.textContent = "×";
      del.title = person.confirmed === false ? "Cancel this invite" : "Remove from team";
      del.setAttribute("aria-label", del.title + ": " + displayName);
      del.addEventListener("click", guardOwnerOnly(() => removeTeamMember(person)));
      removeTd.appendChild(del);
    }
    tbody.appendChild(tr);
  });
  if(currentRole !== "owner") return;
  pendingInvites.forEach(inv => {
    const tr = document.createElement("tr");
    const role = ["admin", "editor"].includes(inv.role) ? inv.role : "viewer";
    tr.innerHTML = `<td></td><td><span style="font-weight:600;">${breakableEmail(inv.email)}</span><span class="pending-pill">Invite sent</span><div class="sub">Joins by opening the link in the email (until ${escapeHtml(fmtDay(inv.expires_at))})</div></td><td><span class="role-pill role-${role}">${role}</span></td><td></td>`;
    const avatarEl = document.createElement("div");
    avatarEl.className = "avatar";
    fillAvatarEl(avatarEl, { email: inv.email });
    tr.children[0].appendChild(avatarEl);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-del";
    del.textContent = "×";
    del.title = "Cancel this invite";
    del.setAttribute("aria-label", "Cancel the invite for " + inv.email);
    del.addEventListener("click", guardOwnerOnly(() => cancelInvite(inv)));
    tr.children[3].appendChild(del);
    tbody.appendChild(tr);
  });
}

const cancelInvite = guardOwnerOnly(async function(inv){
  if(!await confirmDialog(`Cancel the invite for ${inv.email}? The link in their email will stop working.`, "Cancel invite")) return;
  try{
    await callTeamAdminFunction({ action:"cancel_invite", workspaceId: currentWorkspace.id, inviteId: inv.id });
    pendingInvites = pendingInvites.filter(i => i.id !== inv.id);
    renderTeam();
  }catch(err){
    notify("Couldn't cancel that invite", err.message || "Unknown error");
  }
});

let inviteInFlight = false;
const addInvite = guardOwnerOnly(async function(){
  if(inviteInFlight) return;
  const emailInput = document.getElementById("new-invite-email");
  const email = emailInput.value.trim().toLowerCase();
  if(!email) return;
  if(teamList.some(p => (p.email || "").toLowerCase() === email)){ notify("Already on the team", email); return; }
  const role = document.getElementById("new-invite-role").value;
  const btn = document.getElementById("add-invite-btn");
  inviteInFlight = true;
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Sending invite…";
  try{
    const res = await callTeamAdminFunction({ action:"invite", workspaceId: currentWorkspace.id, email, role, redirectTo: window.location.origin + window.location.pathname });
    emailInput.value = "";
    await fetchTeam();
    renderTeam();
    if(DEMO) notify("Invite sent", email + " (demo: no email is sent)");
    else if(res && res.pending) notify("Invite sent", email + " already has a login, so they join by opening the link in the email.");
    else notify("Invite sent", email);
  }catch(err){
    notify("Invite not sent", err.message || "Unknown error");
  }finally{
    inviteInFlight = false;
    btn.disabled = currentRole !== "owner";
    btn.textContent = originalLabel;
  }
});

const removeTeamMember = guardOwnerOnly(async function(person){
  const verb = person.confirmed === false ? "Cancel the invite for" : "Remove";
  if(!await confirmDialog(`${verb} ${person.display_name || person.email}? They'll need a new invite to come back.`, person.confirmed === false ? "Cancel invite" : "Remove")) return;
  try{
    await callTeamAdminFunction({ action:"remove", workspaceId: currentWorkspace.id, userId: person.id });
    teamList = teamList.filter(p => p.id !== person.id);
    renderTeam();
  }catch(err){
    notify("Couldn't remove that person", err.message || "Unknown error");
  }
});

const saveCurrency = guardOwnerOnly(function(e){
  state.settings.currency = e.target.value;
  saveSettings();
  renderAll();
});

/* ============================================================
   PROFILE (self-service; allowed for every role)
============================================================ */
function renderProfile(){
  if(!myProfile) return;
  const preview = document.getElementById("profile-avatar-preview");
  if(preview) fillAvatarEl(preview, myProfile);
  const nameInput = document.getElementById("profile-name-input");
  if(nameInput && document.activeElement !== nameInput) nameInput.value = myProfile.display_name || "";
  document.getElementById("profile-email-readonly").textContent = myProfile.email;
  document.getElementById("profile-role-readonly").innerHTML = `<span class="role-pill role-${memberRole}">${memberRole}</span> in ${escapeHtml(currentWorkspace ? currentWorkspace.name : "")}${isPlatformAdmin ? ' · <span class="role-pill role-owner">platform admin</span>' : ""}`;
}

async function saveDisplayName(){
  const input = document.getElementById("profile-name-input");
  const newName = input.value.trim();
  try{
    const { error } = await sb.from("profiles").update({ display_name: newName || null }).eq("id", currentUser.id);
    if(error) throw error;
    myProfile.display_name = newName || null;
    const teamEntry = teamList.find(p => p.id === currentUser.id);
    if(teamEntry) teamEntry.display_name = myProfile.display_name;
    renderWhoAmI();
    renderTeam();
    const tag = document.getElementById("profile-name-saved");
    tag.classList.add("show");
    setTimeout(() => tag.classList.remove("show"), 1500);
  }catch(err){
    notify("Name not saved", err.message || "Unknown error");
  }
}

async function handleAvatarUpload(file){
  if(!file) return;
  if(!file.type.startsWith("image/")){ notify("Photo not uploaded", "Please choose an image file."); return; }
  try{
    const dataUrl = await resizeImageToDataUrl(file, 160);
    const { error } = await sb.from("profiles").update({ avatar_data: dataUrl }).eq("id", currentUser.id);
    if(error) throw error;
    myProfile.avatar_data = dataUrl;
    const teamEntry = teamList.find(p => p.id === currentUser.id);
    if(teamEntry) teamEntry.avatar_data = dataUrl;
    renderProfile(); renderWhoAmI(); renderTeam();
  }catch(err){
    notify("Photo not uploaded", err.message || "Unknown error");
  }
}

function resizeImageToDataUrl(file, targetSize){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't read that image"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = targetSize; canvas.height = targetSize;
        const ctx = canvas.getContext("2d");
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   EVENT BINDING (runs once after login)
============================================================ */
function bindEvents(){
  document.getElementById("add-invite-btn").addEventListener("click", addInvite);
  document.getElementById("new-invite-email").addEventListener("keydown", (e) => { if(e.key==="Enter") addInvite(); });
  document.getElementById("ws-currency").addEventListener("change", saveCurrency);

  document.getElementById("export-btn").addEventListener("click", exportData);
  const importFileInput = document.getElementById("import-file");
  document.getElementById("import-btn").addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", (e) => {
    if(e.target.files && e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("reset-demo-link").addEventListener("click", resetDemo);

  // CRM pages
  document.getElementById("add-deal-btn").addEventListener("click", () => openRecordModal("deal", null));
  document.getElementById("add-contact-btn").addEventListener("click", () => openRecordModal("contact", null));
  document.getElementById("add-company-btn").addEventListener("click", () => openRecordModal("company", null));
  document.getElementById("pipeline-search").addEventListener("input", renderPipeline);
  document.getElementById("pipeline-owner").addEventListener("change", renderPipeline);
  document.getElementById("contacts-search").addEventListener("input", renderContacts);
  document.getElementById("contacts-status").addEventListener("change", renderContacts);
  document.getElementById("companies-search").addEventListener("input", renderCompanies);
  document.querySelectorAll("[data-goto]").forEach(el => el.addEventListener("click", () => switchTab(el.dataset.goto)));

  // Record modal
  document.getElementById("rm-close").addEventListener("click", closeRecordModal);
  document.getElementById("rm-cancel-btn").addEventListener("click", closeRecordModal);
  document.getElementById("rm-save-btn").addEventListener("click", saveRecordFromModal);
  document.getElementById("rm-delete-btn").addEventListener("click", deleteRecordFromModal);
  document.getElementById("rm-form").addEventListener("submit", (e) => { e.preventDefault(); saveRecordFromModal(); });
  document.getElementById("record-modal-overlay").addEventListener("click", (e) => {
    if(e.target.id === "record-modal-overlay") closeRecordModal();
  });

  // Task modal
  document.getElementById("task-modal-close").addEventListener("click", closeTaskModal);
  document.getElementById("tm-priority").addEventListener("change", updateTmPriorityBadge);
  document.getElementById("task-view-modal-close").addEventListener("click", closeTaskViewModal);
  document.getElementById("tv-close-btn").addEventListener("click", closeTaskViewModal);
  document.getElementById("tv-edit-btn").addEventListener("click", () => {
    const id = viewingTaskId;
    closeTaskViewModal();
    if(id) openTaskModal(id);
  });
  document.getElementById("task-view-modal-overlay").addEventListener("click", (e) => {
    if(e.target.id === "task-view-modal-overlay") closeTaskViewModal();
  });
  document.getElementById("tm-cancel-btn").addEventListener("click", closeTaskModal);
  document.getElementById("tm-save-btn").addEventListener("click", saveTaskFromModal);
  document.getElementById("tm-delete-btn").addEventListener("click", deleteTaskFromModal);
  document.getElementById("task-modal-overlay").addEventListener("click", (e) => {
    if(e.target.id === "task-modal-overlay") closeTaskModal();
  });

  // Profile
  const avatarInput = document.getElementById("profile-avatar-input");
  document.getElementById("profile-avatar-btn").addEventListener("click", () => avatarInput.click());
  document.getElementById("profile-avatar-preview").addEventListener("click", () => avatarInput.click());
  avatarInput.addEventListener("change", (e) => {
    if(e.target.files && e.target.files[0]) handleAvatarUpload(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("profile-name-input").addEventListener("change", saveDisplayName);
  document.getElementById("profile-name-input").addEventListener("keydown", (e) => { if(e.key==="Enter") e.target.blur(); });

  document.getElementById("topbar-avatar").addEventListener("click", () => switchTab("profile"));
  document.getElementById("notif-bell-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleNotifDropdown(); });
  document.getElementById("notif-clear-all").addEventListener("click", (e) => { e.stopPropagation(); clearAllNotifications(); });
  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("notif-bell-wrap");
    if(wrap && !wrap.contains(e.target)) toggleNotifDropdown(false);
  });
  document.addEventListener("keydown", (e) => {
    if(e.key !== "Escape") return;
    if(!document.getElementById("confirm-overlay").classList.contains("hidden")) return closeConfirm(false);
    closeRecordModal(); closeTaskModal(); closeTaskViewModal(); toggleNotifDropdown(false);
    CRMHooks.emit("escape");
  });
  document.getElementById("sidebar-brand").addEventListener("click", () => switchTab("dashboard"));
  bindKeyboardSupport();
}

/* ============================================================
   KEYBOARD
   Rows and cards that open something on click open on Enter/Space too, and
   Tab stays inside the dialog on top (record, task, email, call, confirm)
   until it closes; focus then goes back to where it was.
============================================================ */
const KEY_CLICKABLE = '.card, tr.clickable, .list-row, .tl-item.clickable, .notif-item.clickable, [role="button"]:not(button):not(a[href])';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

function topOpenOverlay(){
  let top = null, topZ = -Infinity;
  document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(o => {
    const z = Number(window.getComputedStyle(o).zIndex) || 0;
    if(z >= topZ){ top = o; topZ = z; }
  });
  return top;
}

function bindKeyboardSupport(){
  document.addEventListener("keydown", (e) => {
    if(e.key === "Tab"){
      const overlay = topOpenOverlay();
      if(!overlay) return;
      const items = [...overlay.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length && !el.closest(".hidden"));
      if(!items.length){ e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], cur = document.activeElement;
      if(!overlay.contains(cur)){ e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if(e.shiftKey && cur === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && cur === last){ e.preventDefault(); first.focus(); }
      return;
    }
    if((e.key === "Enter" || e.key === " ") && !e.defaultPrevented && e.target instanceof window.Element && e.target.matches(KEY_CLICKABLE)){
      e.preventDefault();
      e.target.click();
    }
  });

  // Remember what had focus before a dialog opened, so closing it can go back there.
  let focused = null, focusedBefore = null;
  document.addEventListener("focusin", (e) => { focusedBefore = focused; focused = e.target; });
  const returnTo = new WeakMap();
  new window.MutationObserver(records => records.forEach(r => {
    const o = r.target;
    if(!o.classList || !o.classList.contains("modal-overlay")) return;
    const open = !o.classList.contains("hidden");
    if(open === !/(^|\s)hidden(\s|$)/.test(r.oldValue || "")) return;
    if(open){
      returnTo.set(o, focused && o.contains(focused) ? focusedBefore : focused);
      // A dialog that didn't focus a field itself gets focus, so Tab and screen readers start inside it.
      setTimeout(() => {
        if(o.classList.contains("hidden") || o.contains(document.activeElement)) return;
        const box = o.querySelector('[role="dialog"], [role="alertdialog"]') || o.firstElementChild;
        if(!box) return;
        if(!box.hasAttribute("tabindex")) box.setAttribute("tabindex", "-1");
        box.focus({ preventScroll:true });
      }, 0);
    } else {
      const back = returnTo.get(o);
      returnTo.delete(o);
      const cur = document.activeElement;
      if(back && back.focus && document.body.contains(back) && !back.closest(".hidden") && (!cur || cur === document.body || o.contains(cur))) back.focus({ preventScroll:true });
    }
  })).observe(document.body, { subtree:true, attributes:true, attributeFilter:["class"], attributeOldValue:true });
}

function renderAll(){
  renderDashboard();
  renderPipeline();
  renderContacts();
  renderCompanies();
  renderBoard();
  renderProfile();
  renderTeam();
  // Feature modules draw their sections (mailboxes, notification settings,
  // calling, integration status) into the containers on these pages.
  CRMHooks.emit("profile:render", document.getElementById("tab-profile"));
  CRMHooks.emit("team:render", document.getElementById("tab-team"));
}

function init(){
  document.getElementById("confirm-ok").addEventListener("click", () => closeConfirm(true));
  document.getElementById("confirm-cancel").addEventListener("click", () => closeConfirm(false));
  document.getElementById("demo-btn").addEventListener("click", startDemo);

  if(!isConfigured()){
    // A fresh copy that isn't connected to Supabase yet: explain setup, and offer the demo.
    if(window.BRANDIGADE_AUTODEMO){ startDemo(); return; }
    document.querySelector(".auth-box").classList.remove("is-loading");
    const loading = document.getElementById("auth-loading");
    loading.innerHTML = "<b>Not connected to Supabase yet.</b><br/>Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> (see README.md), then reload.<br/><br/>Or look around with sample clients first:";
    document.getElementById("demo-btn").classList.remove("hidden");
    return;
  }
  initAuth();
}

// Start once every script (data, demo, timeline, email, dialer...) has loaded.
function boot(){
  try{
    init();
  }catch(err){
    showBootError(err);
  }
}
function showBootError(err){
  console.error("App failed to initialize:", err);
  document.body.innerHTML =
    '<div style="padding:40px;font-family:sans-serif;max-width:640px;">' +
    '<h2>Brandigade CRM didn\'t load</h2>' +
    '<p>Open the browser console (F12) for the error, or reload the page. ' +
    'Your data lives in Supabase and has not been affected.</p></div>';
}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
