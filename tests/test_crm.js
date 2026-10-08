// Runs the whole CRM in jsdom.
//  A. "Connected" mode: a fresh SaaS signup against an in-memory Supabase stand-in
//     (the same one demo mode uses), with team-admin calls captured from fetch.
//  B. Demo mode with the sample workspaces.
// npm install jsdom && node tests/test_crm.js
const {JSDOM}=require("jsdom");const fs=require("fs");
const raw=fs.readFileSync(__dirname+"/../index.html","utf8")
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/,"").replace('<script src="config.js"></script>',"");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fail=0;const ok=(c,m)=>{console.log((c?"PASS ":"FAIL ")+m);if(!c)fail++};

function freshStore(){
  return {
    plans:[
      {id:"free",name:"Free",seat_limit:3,contact_limit:2,price_monthly:0,sort_order:1},
      {id:"pro",name:"Pro",seat_limit:10,contact_limit:null,price_monthly:29,sort_order:2},
    ],
    profiles:[{id:"u1",email:"me@x.co",display_name:null,avatar_data:null,is_platform_admin:true,created_at:"2026-01-01T00:00:00Z"},
              {id:"u2",email:"ed@x.co",display_name:"Ed",avatar_data:null,is_platform_admin:false,created_at:"2026-01-02T00:00:00Z"}],
    workspaces:[], workspace_members:[], workspace_state:[],
  };
}

function boot(html,{connected}={}){
  const fnCalls=[];let store=null;
  const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://x.test/",beforeParse(w){
    w.Element.prototype.scrollIntoView=function(){};w.AudioContext=undefined;
    w.fetch=async(u,o)=>{fnCalls.push({u,body:JSON.parse(o.body)});return{ok:true,status:200,json:async()=>({success:true})}};
    if(connected){
      w.BRANDIGADE_CONFIG={supabaseUrl:"https://x.supabase.co",supabaseAnonKey:"anon"};
      w.supabase={createClient:()=>{
        store=freshStore();
        const c=w.createDemoClient({store,user:{id:"u1",email:"me@x.co"}});
        delete c.teamAdmin; // force the real edge-function path (captured by fetch)
        c.auth.getSession=async()=>({data:{session:{user:{id:"u1",email:"me@x.co"},access_token:"t"}}});
        return c;
      }};
    }
  }});
  return {w:dom.window,d:dom.window.document,fnCalls,getStore:()=>store};
}

(async()=>{
 // ---------- A. Fresh SaaS signup ----------
 let {w,d,fnCalls,getStore}=boot(raw,{connected:true});
 const txt=id=>d.getElementById(id).textContent;
 const nav=id=>d.querySelector(`.nav-item[data-tab="${id}"]`).click();
 await sleep(600);
 ok(!d.getElementById("auth-onboard-view").classList.contains("hidden"),"new user with no workspace sees onboarding");
 d.getElementById("onboard-name").value="Acme Agency";
 d.getElementById("onboard-form").dispatchEvent(new w.Event("submit",{cancelable:true}));
 await sleep(600);
 const store=getStore();
 ok(store.workspaces.length===1&&store.workspace_members[0].role==="owner","create_workspace makes the user owner");
 ok(d.getElementById("auth-screen").classList.contains("hidden")&&txt("ws-current")==="Acme Agency","app opens in the new workspace");
 const navs=[...d.querySelectorAll(".nav-item")].map(e=>e.textContent.trim());
 ok(navs.join("|")==="Dashboard|Pipeline|Contacts|Companies|Tasks|Profile|Team|Admin","nav incl. Admin for platform admin: "+navs.join("|"));
 ok(d.title==="Brandigade CRM"&&d.querySelector(".sidebar .brand-lockup img").alt==="Brandigade","Brandigade branding");
 ok(d.querySelectorAll("#d-next .list-row").length===3,"new workspace starts with welcome tasks");

 // company + contact + activity + deal
 nav("companies");
 d.getElementById("add-company-btn").click();
 d.getElementById("rm-name").value="Globex <b>Co</b>";d.getElementById("rm-industry").value="Retail";
 d.getElementById("rm-save-btn").click();await sleep(500);
 const co=w.eval("state.companies[0]");
 ok(co&&co.name==="Globex <b>Co</b>","company saved");
 ok(!d.querySelector("#companies-tbody b"),"company name HTML-escaped");
 const wsId=store.workspaces[0].id;
 ok(store.workspace_state.find(s=>s.workspace_id===wsId).data.companies.length===1,"saved to this workspace's state");
 d.getElementById("rm-close").click();
 nav("contacts");
 d.getElementById("add-contact-btn").click();
 d.getElementById("rm-firstName").value="Rana";d.getElementById("rm-email").value="rana@globex.co";d.getElementById("rm-companyId").value=co.id;
 d.getElementById("rm-save-btn").click();await sleep(500);
 const ct=w.eval("state.contacts[0]");
 ok(ct&&ct.companyId===co.id&&ct.ownerId==="u1","contact saved with company and owner");
 d.getElementById("act-subject").value="Intro call";d.getElementById("act-log-btn").click();await sleep(50);
 ok(w.eval("state.activities[0].contactId")===ct.id,"activity logged");
 [...d.querySelectorAll("#rm-related .panel-link")].find(b=>b.textContent.includes("Add deal")).click();
 d.getElementById("rm-title").value="Rebrand";d.getElementById("rm-value").value="25000";d.getElementById("rm-stage").value="proposal";
 d.getElementById("rm-save-btn").click();await sleep(500);
 d.getElementById("rm-close").click();
 ok(txt("d-pipeline-value").replace(/[^0-9]/g,"")==="25000"&&txt("d-weighted").replace(/[^0-9]/g,"")==="12500","pipeline and weighted forecast");
 nav("pipeline");
 const deal=w.eval("state.deals[0]");
 const ev=new w.Event("drop",{bubbles:true,cancelable:true});ev.dataTransfer={getData:()=>deal.id};
 d.querySelector('.board-col-body[data-stage="won"]').dispatchEvent(ev);await sleep(500);
 ok(w.eval("state.deals[0].stage")==="won"&&txt("d-win-rate")==="100%","drag to Won updates win rate");

 // plan limits: free plan here allows 2 contacts
 nav("contacts");
 d.getElementById("add-contact-btn").click();d.getElementById("rm-firstName").value="Two";d.getElementById("rm-save-btn").click();await sleep(500);d.getElementById("rm-close").click();
 d.getElementById("add-contact-btn").click();d.getElementById("rm-firstName").value="Three";d.getElementById("rm-save-btn").click();await sleep(500);
 ok(w.eval("state.contacts.length")===2,"contact limit blocks the 3rd contact on Free");
 d.getElementById("rm-close").click();

 // team
 nav("team");
 ok(txt("ws-seats")==="1 of 3"&&txt("ws-contacts")==="2 of 2"&&txt("ws-plan-name")==="Free","team page shows plan usage");
 d.getElementById("new-invite-email").value="new@x.co";d.getElementById("new-invite-role").value="editor";
 d.getElementById("add-invite-btn").click();await sleep(400);
 ok(fnCalls.length===1&&fnCalls[0].u.endsWith("/functions/v1/team-admin")&&fnCalls[0].body.workspaceId===wsId&&fnCalls[0].body.role==="editor","invite calls team-admin with the workspace");
 d.getElementById("ws-name-input").value="Acme & Co";d.getElementById("ws-rename-btn").click();await sleep(100);
 ok(store.workspaces[0].name==="Acme & Co"&&txt("ws-current")==="Acme & Co","owner renames workspace");
 d.getElementById("ws-currency").value="AED";d.getElementById("ws-currency").dispatchEvent(new w.Event("change"));await sleep(500);
 ok(/AED/.test(txt("d-pipeline-value")),"currency setting");

 // tasks
 nav("board");
 d.getElementById("add-task-trigger").click();
 d.getElementById("tm-title").value="Write <b>report</b>";d.getElementById("tm-due-date").value="2020-01-01";
 d.getElementById("tm-reminder").value="at_due";d.getElementById("tm-deal").value=deal.id;
 d.getElementById("tm-save-btn").click();await sleep(500);
 ok(!d.querySelector("#board .card-title b")&&w.eval("state.board.at(-1).dealId")===deal.id,"task saved, escaped, linked to deal");
 w.eval("checkReminders()");ok(w.eval("notificationHistory.length")>=1,"overdue reminder notifies");

 // second workspace + switcher
 const sw=d.getElementById("ws-switcher");sw.value="__new";sw.dispatchEvent(new w.Event("change"));
 ok(!d.getElementById("ws-create-overlay").classList.contains("hidden"),"switcher offers New workspace");
 d.getElementById("ws-create-name").value="Side Project";d.getElementById("ws-create-ok").click();await sleep(600);
 ok(txt("ws-current")==="Side Project"&&w.eval("state.contacts.length")===0,"second workspace starts empty");
 sw.value=wsId;sw.dispatchEvent(new w.Event("change"));await sleep(500);
 ok(txt("ws-current")==="Acme & Co"&&w.eval("state.contacts.length")===2,"switching back loads the first workspace's data");

 // admin console
 nav("admin");await sleep(300);
 ok(d.querySelectorAll("#admin-ws-tbody tr").length===2&&d.querySelectorAll("#admin-users-tbody tr").length===2,"admin lists workspaces and users");
 const row=[...d.querySelectorAll("#admin-ws-tbody tr")].find(r=>r.textContent.includes("Acme"));
 const planSel=row.querySelectorAll("select")[0];planSel.value="pro";planSel.dispatchEvent(new w.Event("change"));await sleep(300);
 ok(store.workspaces.find(x=>x.id===wsId).plan_id==="pro"&&txt("ws-plan-pill")==="Pro","admin upgrades a workspace to Pro");
 const row2=[...d.querySelectorAll("#admin-ws-tbody tr")].find(r=>r.textContent.includes("Acme"));
 const stSel=row2.querySelectorAll("select")[1];stSel.value="suspended";stSel.dispatchEvent(new w.Event("change"));await sleep(300);
 ok(store.workspaces.find(x=>x.id===wsId).status==="suspended"&&!d.getElementById("ws-banner").classList.contains("hidden"),"admin suspends a workspace and the banner shows");
 const prow=d.querySelector("#admin-plans-tbody tr");prow.querySelectorAll("input")[0].value="5";prow.querySelector("button").click();await sleep(300);
 ok(store.plans[0].seat_limit===5,"admin edits plan limits");
 const ubox=[...d.querySelectorAll("#admin-users-tbody tr")].find(r=>r.textContent.includes("ed@x.co")).querySelector("input");
 ubox.checked=true;ubox.dispatchEvent(new w.Event("change"));await sleep(300);
 ok(store.profiles.find(p=>p.id==="u2").is_platform_admin===true,"admin grants platform admin");

 // non-admins get no admin access, even through the client
 store.profiles[0].is_platform_admin=false;
 const r=await w.eval('sb.rpc("admin_list_workspaces")');
 ok(r.error&&/Platform admins only/.test(r.error.message),"admin RPC refused for non-admins");

 // viewer lockdown
 w.eval('currentRole="viewer"');w.eval("applyRolePermissions()");nav("contacts");
 ok(d.getElementById("add-contact-btn").disabled&&!d.getElementById("contacts-search").disabled,"viewer: add disabled, search usable");
 const before=JSON.stringify(store.workspace_state);w.eval("saveState()");await sleep(500);
 ok(JSON.stringify(store.workspace_state)===before,"viewer cannot save");

 // ---------- B. Demo mode ----------
 ({w,d}=boot(raw,{}));
 await sleep(300);
 ok(!d.getElementById("demo-btn").classList.contains("hidden"),"unconfigured copy offers the demo");
 d.getElementById("demo-btn").click();await sleep(800);
 ok(d.body.classList.contains("is-demo")&&txt("ws-current")==="Brandigade","demo opens the Brandigade workspace");
 ok(w.eval("state.deals.length")===9&&w.eval("teamList.length")===4,"demo sample data loaded");
 ok(d.querySelectorAll("#pipeline .card").length===9,"demo pipeline renders");
 d.querySelector('.nav-item[data-tab="admin"]').click();await sleep(300);
 ok(d.querySelectorAll("#admin-ws-tbody tr").length===4&&txt("adm-mrr").replace(/[^0-9]/g,"")==="128","demo admin console: 4 workspaces, $128 MRR (suspended excluded)");
 [...d.querySelectorAll("#admin-ws-tbody tr")].find(r=>r.textContent.includes("Northstar")).querySelector("button").click();await sleep(500);
 ok(txt("ws-current")==="Northstar Studio"&&!d.getElementById("ws-banner").classList.contains("hidden"),"admin opens a customer workspace with a notice");
 const stored=JSON.parse(w.localStorage.getItem("brandigade-crm-demo-v2"));
 ok(stored&&stored.workspaces.length===4,"demo store persists in the browser");

 console.log(fail?`FAILED (${fail})`:"ALL PASS");process.exit(fail?1:0);
})();
