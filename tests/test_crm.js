// Runs the whole CRM in jsdom.
//  A. "Connected" mode: the admin opens a fresh company CRM against an in-memory
//     Supabase stand-in (the same one demo mode uses), with team-admin calls
//     captured from fetch.
//  B. Demo mode with the sample data.
//  C. Sign-up that needs email confirmation.
//  D. Someone who signed up without an invite.
// npm install jsdom && node tests/test_crm.js
const {JSDOM}=require("jsdom");const fs=require("fs");
const raw=fs.readFileSync(__dirname+"/../index.html","utf8")
  .replace(/<script src="https:\/\/cdn[^>]*><\/script>/,"").replace('<script src="config.js"></script>',"");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fail=0;const ok=(c,m)=>{console.log((c?"PASS ":"FAIL ")+m);if(!c)fail++};

function freshStore(){
  return {
    profiles:[{id:"u1",email:"me@x.co",display_name:null,avatar_data:null,is_platform_admin:true,created_at:"2026-01-01T00:00:00Z"},
              {id:"u2",email:"ed@x.co",display_name:"Ed",avatar_data:null,is_platform_admin:false,created_at:"2026-01-02T00:00:00Z"}],
    workspaces:[{id:"ws1",name:"Brandigade",status:"active",created_at:"2026-01-01T00:00:00Z"}],
    workspace_members:[{workspace_id:"ws1",user_id:"u1",role:"owner",invited:false,created_at:"2026-01-01T00:00:00Z"}],
    workspace_state:[{workspace_id:"ws1",data:{},updated_at:"2026-01-01T00:00:00Z"}],
  };
}

function boot(html,{connected,user}={}){
  user=user||{id:"u1",email:"me@x.co"};
  const fnCalls=[];let store=null;
  const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://x.test/",beforeParse(w){
    w.Element.prototype.scrollIntoView=function(){};w.AudioContext=undefined;
    w.fetch=async(u,o)=>{fnCalls.push({u,body:JSON.parse(o.body)});return{ok:true,status:200,json:async()=>({success:true})}};
    if(connected){
      w.BRANDIGADE_CONFIG={supabaseUrl:"https://x.supabase.co",supabaseAnonKey:"anon"};
      w.supabase={createClient:()=>{
        store=freshStore();
        const c=w.createDemoClient({store,user});
        delete c.teamAdmin; // force the real edge-function path (captured by fetch)
        c.auth.getSession=async()=>({data:{session:{user,access_token:"t"}}});
        return c;
      }};
    }
  }});
  return {w:dom.window,d:dom.window.document,fnCalls,getStore:()=>store};
}

(async()=>{
 // ---------- A. The admin opens a fresh company CRM ----------
 let {w,d,fnCalls,getStore}=boot(raw,{connected:true});
 const txt=id=>d.getElementById(id).textContent;
 const nav=id=>d.querySelector(`.nav-item[data-tab="${id}"]`).click();
 await sleep(600);
 const store=getStore();
 ok(d.getElementById("auth-screen").classList.contains("hidden"),"the admin goes straight into the CRM");
 ok(!d.getElementById("ws-switcher")&&!d.getElementById("tab-admin")&&!d.getElementById("auth-onboard-view"),"no workspace switcher, admin console or workspace setup");
 const navs=[...d.querySelectorAll(".nav-item")].map(e=>e.textContent.trim());
 ok(navs.join("|")==="Dashboard|Pipeline|Contacts|Companies|Tasks|Profile|Team","nav: "+navs.join("|"));
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

 // no contact limit
 nav("contacts");
 for(const n of ["Two","Three","Four"]){d.getElementById("add-contact-btn").click();d.getElementById("rm-firstName").value=n;d.getElementById("rm-save-btn").click();await sleep(400);d.getElementById("rm-close").click();}
 ok(w.eval("state.contacts.length")===4,"no contact limit");

 // team
 nav("team");
 ok(!d.getElementById("ws-seats")&&!d.getElementById("ws-name-input"),"team page has no plan usage or workspace rename");
 d.getElementById("new-invite-email").value="new@x.co";d.getElementById("new-invite-role").value="editor";
 d.getElementById("add-invite-btn").click();await sleep(400);
 ok(fnCalls.length===1&&fnCalls[0].u.endsWith("/functions/v1/team-admin")&&fnCalls[0].body.workspaceId===wsId&&fnCalls[0].body.role==="editor","invite calls team-admin for the CRM");
 d.getElementById("ws-currency").value="AED";d.getElementById("ws-currency").dispatchEvent(new w.Event("change"));await sleep(500);
 ok(/AED/.test(txt("d-pipeline-value")),"currency setting");
 ok(store.workspace_state[0].data.settings.timezone===w.Intl.DateTimeFormat().resolvedOptions().timeZone&&txt("ws-timezone")===store.workspace_state[0].data.settings.timezone,"team time zone saved for reminder emails");

 // tasks
 nav("board");
 d.getElementById("add-task-trigger").click();
 d.getElementById("tm-title").value="Write <b>report</b>";d.getElementById("tm-due-date").value="2020-01-01";
 d.getElementById("tm-reminder").value="at_due";d.getElementById("tm-deal").value=deal.id;
 d.getElementById("tm-save-btn").click();await sleep(500);
 ok(!d.querySelector("#board .card-title b")&&w.eval("state.board.at(-1).dealId")===deal.id,"task saved, escaped, linked to deal");
 w.eval("checkReminders()");ok(w.eval("notificationHistory.length")>=1,"overdue reminder notifies");

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
 ok(d.body.classList.contains("is-demo")&&w.eval("currentWorkspace.name")==="Brandigade","demo opens the Brandigade CRM");
 ok(w.eval("state.deals.length")===9&&w.eval("teamList.length")===4,"demo sample data loaded");
 ok(d.querySelectorAll("#pipeline .card").length===9,"demo pipeline renders");
 ok(!d.querySelector('.nav-item[data-tab="admin"]'),"demo has no admin console");
 w.eval('state.deals[0].title="Renamed in demo";saveState()');await sleep(600);
 const stored=JSON.parse(w.localStorage.getItem("brandigade-crm-demo-v3"));
 ok(stored&&stored.workspaces.length===1&&stored.workspace_state[0].data.deals[0].title==="Renamed in demo","demo changes persist in the browser");

 // ---------- C. Sign-up that needs email confirmation ----------
 const signUps=[];
 const dom3=new JSDOM(raw,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://x.test/crm/",beforeParse(w3){
   w3.Element.prototype.scrollIntoView=function(){};w3.AudioContext=undefined;
   w3.BRANDIGADE_CONFIG={supabaseUrl:"https://x.supabase.co",supabaseAnonKey:"anon"};
   w3.supabase={createClient:()=>{
     const c=w3.createDemoClient({store:freshStore(),user:{id:"u9",email:"new@x.co"}});
     c.auth.getSession=async()=>({data:{session:null}});
     c.auth.signUp=async(a)=>{signUps.push(a);return{data:{user:{id:"u9"},session:null},error:null}};
     return c;
   }};
 }});
 const d3=dom3.window.document;await sleep(400);
 d3.getElementById("auth-mode-link").click();
 d3.getElementById("auth-email").value="new@x.co";d3.getElementById("auth-password").value="secret123";
 d3.getElementById("auth-form").dispatchEvent(new dom3.window.Event("submit",{cancelable:true}));await sleep(300);
 ok(signUps.length===1&&signUps[0].options.emailRedirectTo==="https://x.test/crm/","sign-up sends the site address for the confirmation link");
 ok(d3.getElementById("auth-success").classList.contains("show")&&d3.getElementById("auth-success").textContent.includes("new@x.co"),"sign-up tells the user to check their email");
 ok(d3.getElementById("auth-submit-btn").textContent==="Log in"&&!d3.getElementById("auth-submit-btn").disabled,"form switches to log in after sign-up");

 // ---------- D. Signed up without an invite ----------
 const u4=boot(raw,{connected:true,user:{id:"u2",email:"ed@x.co"}});
 await sleep(600);
 ok(!u4.d.getElementById("auth-screen").classList.contains("hidden")&&!u4.d.getElementById("auth-noaccess-view").classList.contains("hidden"),"uninvited user is told to ask the admin for an invite");
 ok(u4.w.eval("currentWorkspace")===null,"uninvited user never opens the CRM");

 console.log(fail?`FAILED (${fail})`:"ALL PASS");process.exit(fail?1:0);
})();
