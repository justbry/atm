import {Window} from "happy-dom";
import {readFileSync} from "node:fs";
const file=process.argv[2];
const errs=[];
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error:(...a)=>errs.push(a.map(String).join(" "))}});
win.addEventListener("error",e=>errs.push("window error: "+e.message));
const __h=readFileSync(file,"utf8"),__m=__h.match(/<script>([\s\S]*)<\/script>/);win.document.write(__h.replace(__m[0],""));
await win.happyDOM.waitUntilComplete();try{win.eval(__m[1]+"\n;window.__t={SC,people,roleGuard,kEmit,kParse,kCsv,kHist,kScope,kFilter,DISCLOSURE,bkFig,bkAggP,bkAgg,bkYear,bkSize,pMeta,perY,perQ,perM,vaAllowed,VW,reportDocCsv,pMetaOf:()=>P,render}")}catch(e){errs.push("eval error: "+e.message+" "+(e.stack||"").split("\n").slice(0,3).join(" / "))}
const d=win.document,$=s=>d.querySelector(s),$$=s=>[...d.querySelectorAll(s)],txt=s=>(($(s)||{}).textContent||"").replace(/\s+/g," ").trim();
const fails=[];const ok=(name,cond,info="")=>{console.log(cond?"ok  ":"FAIL",name,cond?"":info);if(!cond)fails.push(name)};
const tab=p=>$(`.tab[data-p=${p}]`).click(),sc=id=>{$("#sw").click();$(`[data-sc=${id}]`).click()};
ok("boots without errors",errs.length===0,errs.join(" | "));
ok("tabs",$$(".tab").map(t=>t.dataset.p).join(",")==="pl,dash,mem,bk,cod,led,rep",$$(".tab").map(t=>t.dataset.p).join(","));
// Plans stat
ok("plans collected stat",/Collected in Nov/.test(txt("#pl .strip")),txt("#pl .strip").slice(0,160));
// Dashboard on vol (derived)
tab("dash");
ok("dash money cards",$$("#dash .kcard").length===5,String($$("#dash .kcard").length));
ok("dash derived badge",/From this school's events/.test(txt("#dash .kt")));
ok("dash nov gross",/\$\d/.test(txt("#dash .kcard b")),txt("#dash .kcard b"));
$("#dash [data-dv=members]").click();ok("members view",$$("#dash .kcard").length===4,txt("#dash .kcard b"));
$("#dash [data-dv=risk]").click();ok("risk view",/Refund rate/.test(txt("#dash .kcards")),txt("#dash .kcards").slice(0,80));
$("#dash [data-dstep='-1']").click();ok("month step",$("#dash .kmonths button.on").dataset.dm==="9",$("#dash .kmonths button.on").dataset.dm);
// b4u fixture
sc("b4u");tab("dash");
ok("b4u fixture badge",/Fixture data/.test(txt("#dash .kt")));
ok("b4u jun gross",txt("#dash .kcard b")==="$623.00",txt("#dash .kcard b"));
const nets=$$("#dash .kcard b").map(b=>b.textContent);ok("b4u jun net",nets.includes("$592.04"),nets.join(","));
$("#dash [data-dv=members]").click();ok("b4u members paying 23",txt("#dash .kcard b")==="23",txt("#dash .kcard b"));
$("#dash [data-dsc=disputes]").click();$("#dash [data-dv=risk]").click();ok("disputes flags",$$("#dash .kflag").length>=5,String($$("#dash .kflag").length));
$("#dash [data-dsc=annual-prepay]").click();ok("annual note",!!$("#dash .note"));
$("#dash [data-dv=money]").click();$("#dash [data-dm='0']").click();ok("annual jan gross",txt("#dash .kcard b")==="$5,735.00",txt("#dash .kcard b"));
// empty school
sc("nw");tab("dash");ok("nw empty",/No payments yet/.test(txt("#dash")),txt("#dash").slice(0,90));
// bookings on vol
sc("vol");tab("bk");
ok("bk default week",/This week/.test(txt("#bchips b")),txt("#bchips b"));
ok("bk week day headers",$$("#bb tr.day").length===4,$$("#bb tr.day").map(r=>r.textContent.trim().slice(0,22)).join(" | "));
ok("bk week rows",$$("#bb tr.row").length===5,String($$("#bb tr.row").length));
ok("bk bulk on wed",!!$("#bb [data-bulk]"),txt("#bb [data-bulk]"));
$("#pp [data-bp='day:0']").click();
ok("bk today overdue",/Overdue/.test(txt("#bb")) && !!$("#bb [data-bulk=over]"),$$("#bb tr.day").map(r=>r.textContent.trim().slice(0,40)).join(" | "));
$("#bb [data-bulk=over]").click();
ok("bulk gone after confirm",$$("#bb [data-bulk]").length===0);
ok("bulk toast",/Attendance confirmed for 2/.test(txt("#ts")),txt("#ts"));
$("#pp [data-bp='day:1']").click();ok("bk tomorrow empty",/Nothing booked/.test(txt("#bb")),txt("#bb").slice(0,60));
$("#pp [data-bp='wk:1']").click();ok("bk next week (2 + 2 overdue pending)",$$("#bb tr.row").length===4,String($$("#bb tr.row").length));
$("#pp [data-bstep='1']").click();ok("bk step week",/Week of/.test(txt("#bchips b")),txt("#bchips b"));
$("#pp [data-bp='wk:0']").click();$("#bchips [data-b=apr]").click();ok("bk filter approval",$$("#bb tr.row").length===1,String($$("#bb tr.row").length));
// Roles are not plans: owner | admin | member chips, role filter, "no plan" for role holders without one
sc("vol");tab("mem");
const ids=()=>$$("#mb tr.row").map(r=>r.dataset.id),row=id=>$(`#mb tr.row[data-id=${id}]`),rt=id=>(row(id)?.textContent||"").replace(/\s+/g," ").trim();
ok("mem role column",$$("#mem thead th").map(t=>t.textContent).includes("Role"),$$("#mem thead th").map(t=>t.textContent).join(","));
ok("mem role chips owner/admin/member",$$("#mb .kr-owner").length===1&&$$("#mb .kr-admin").length===2&&$$("#mb .kr-member").length===5,[".kr-owner",".kr-admin",".kr-member"].map(c=>$$("#mb "+c).length).join("/"));
ok("mem owners and admins listed without a plan",ids().includes("u_kim")&&ids().includes("u_rav")&&ids().length===8,ids().join(","));
ok("mem finance chip on the admin with the grant only",$$("#mb .kfin").length===1&&/Finance/.test(rt("u_rav"))&&!/Finance/.test(rt("m_093")),$$("#mb .kfin").length+"");
ok("mem admin with no plan shows no plan, not 0",/no plan/i.test(rt("u_rav"))&&!/\b0\s*\/\s*\d/.test(rt("u_rav"))&&/no plan/i.test(rt("u_kim")),rt("u_rav"));
ok("mem admin can also hold a plan",/Admin/.test(rt("m_093"))&&/Glow ×1/.test(rt("m_093")),rt("m_093"));
ok("mem role filter chips",$$("#rchips [data-rf]").map(c=>c.dataset.rf).join(",")===",oa,m",$$("#rchips [data-rf]").map(c=>c.dataset.rf).join(","));
$("#rchips [data-rf=oa]").click();ok("mem filter owners and admins",ids().join(",")==="u_kim,m_093,u_rav",ids().join(","));
$("#rchips [data-rf=m]").click();ok("mem filter members",ids().length===5&&!ids().includes("m_093")&&!ids().includes("u_kim"),ids().join(","));
$("#rchips [data-rf='']").click();ok("mem filter all",ids().length===8,String(ids().length));
$(".f[data-s=att]").click();const attIds=new Set(ids());$(".f[data-s='']").click();
const order=ids(),calm=order.filter(i=>!attIds.has(i)),rank={owner:0,admin:1,member:2},rk=i=>row(i).querySelector(".krole").className.includes("kr-owner")?0:row(i).querySelector(".krole").className.includes("kr-admin")?1:2;
ok("mem sort: attention first",order.slice(0,attIds.size).every(i=>attIds.has(i)),order.join(","));
ok("mem sort: calm rows by role then name",calm.every((i,n)=>n===0||rk(calm[n-1])<rk(i)||(rk(calm[n-1])===rk(i)&&row(calm[n-1]).querySelector("b").textContent.localeCompare(row(i).querySelector("b").textContent)<=0)),calm.join(","));
ok("top bar: View as replaces the static chip; its help keeps that admins see all members",!$("#kview").hidden&&/^View as Owner$/.test(txt("#kview"))&&/You are Owner in Vibes of Light\. Owners and admins own the dashboard and see everyone's data\./.test($("#kview").title),txt("#kview"));
// capability lines and owner-only role actions
let kmn=null;const openRow=id=>{row(id).click();kmn=null},menu=()=>{if(!kmn){$("#dr [data-kmenu]").click();kmn=$$("#kmm [data-role]")}return kmn},mk=k=>menu().find(b=>b.dataset.role===k);
openRow("u_rav");ok("drawer admin capability",/Sees: every member, dashboard, bookings/.test(txt("#dr"))&&/Money: yes/.test(txt("#dr")),txt("#dr").slice(0,200));
openRow("m_093");ok("drawer admin without finance: money no",/Money: no/.test(txt("#dr")));
openRow("m_204");ok("drawer member capability",/Sees: only themselves and their family/.test(txt("#dr"))&&!/Money:/.test(txt("#dr")));
openRow("u_rav");ok("owner can use role actions",menu().length===2&&menu().every(b=>!b.disabled),menu().map(b=>b.dataset.role+(b.disabled?"(off)":"")).join(","));
openRow("u_kim");ok("last owner guard: sole owner cannot be removed",mk("remove")?.disabled===true&&/Last owner/.test(mk("remove").title),mk("remove")?.title);
ok("self-demote guard",(()=>{const{SC:S,people,roleGuard}=win.__t,s=S.vol;s.R.push({id:"u_x",name:"X",role:"owner"});const r=[roleGuard(s,people(s).find(p=>p.id==="u_kim"),"remove"),roleGuard(s,people(s).find(p=>p.id==="u_x"),"remove")];s.R.pop();return r.join("|")})()==="Owners can't demote themselves|");
openRow("u_rav");mk("revoke").click();
ok("role confirm modal explains refresh",$("#bg").classList.contains("on")&&/next sign-in refresh/.test(txt("#md"))&&/5 minutes/.test(txt("#md")),txt("#md").slice(0,160));
$("#rgo").click();ok("revoke finance applied",$$("#mb .kfin").length===0&&/Money: no/.test(txt("#dr")),txt("#dr").slice(0,160));
ok("role change toast and pending ledger event",/5 minutes/.test(txt("#ts")));
openRow("m_204");mk("make").click();$("#rgo").click();ok("make admin applied",/Admin/.test(rt("m_204"))&&/Sparkle ×2/.test(rt("m_204"))&&$$("#mb .kr-admin").length===3,rt("m_204"));
openRow("m_204");mk("remove").click();$("#rgo").click();ok("remove admin applied",$$("#mb .kr-admin").length===2);
openRow("u_rav");mk("remove").click();$("#rgo").click();ok("remove admin on a role-only person drops them from the roster",!ids().includes("u_rav"),ids().join(","));
// B4 Uni: the viewer is an admin, so role actions are owner-only
sc("b4u");tab("mem");
ok("b4u viewer is an admin and sees all",!$("#kview").hidden&&$$("#mb .kr-owner").length===1&&$$("#mb .kr-admin").length===2,$$("#mb .kr-admin").length+"");
openRow("s_22");ok("non-owner: make admin disabled with owner-needed title",mk("make")?.disabled===true&&mk("make").title==="Owner role needed",mk("make")?.title);
openRow("u_tes");ok("non-owner: finance and remove disabled",menu().length===2&&menu().every(b=>b.disabled&&b.title==="Owner role needed"),menu().map(b=>b.title).join("|"));
mk("revoke").click();ok("non-owner click does nothing",!$("#bg").classList.contains("on"));
openRow("u_pri");ok("non-owner: owner row actions disabled",menu().every(b=>b.disabled));
ok("b4u family chip on the Wu family",$$("#mb .kfam").length===3&&/Wu family/.test(rt("s_25")),String($$("#mb .kfam").length));
// Member portal scope: only that member and their family
const portal=id=>{tab("mem");row(id).querySelector("[data-vm]").click()};
portal("s_21");
ok("portal scope banner",/Members see only themselves and their family/.test(txt("#vm .kscope")),txt("#vm .kscope"));
ok("portal adult toggle",$$("#vm [data-vfam]").map(b=>b.textContent).join(",")==="Adult,Teen,Child",$$("#vm [data-vfam]").map(b=>b.textContent).join(","));
$("#vm [data-vtab=fam]").click();ok("portal adult sees the whole family only",$$("#vm [data-fm]").map(c=>c.dataset.fm).join(",")==="s_21,s_25,s_26"&&!/Omar F\.|Pia L\.|Raj S\.|Priya|Tess|Jo A\./.test(txt("#vm")),$$("#vm [data-fm]").map(c=>c.dataset.fm).join(","));
ok("portal family rows carry their own balance and bookings",/Kai W\./.test(txt("#vm"))&&/Tutoring/.test(txt("#vm [data-fm=s_25]"))&&/available/.test(txt("#vm [data-fm=s_26]")));
$("#vm [data-vfam=s_25]").click();ok("portal teen sees only their own row",$$("#vm [data-fm]").length===1&&!/Dana W\.|Lia W\./.test(txt("#vm")),txt("#vm .kscope"));
ok("portal teen scope banner",/Kai W\. only/.test(txt("#vm .kscope")),txt("#vm .kscope"));
$("#vm #vmx").click();
sc("vol");portal("m_204");$("#vm [data-vtab=fam]").click();
ok("portal without family shows only that member",/Mia R\. only/.test(txt("#vm .kscope"))&&/No family/.test(txt("#vm"))&&!/Jon K\.|Ana P\.|Lee T\./.test(txt("#vm")),txt("#vm .kscope"));
$("#vm #vmx").click();
// School books: audiences (public, member, governance, finance, owner), the disclosure file, and View as
const T=win.__t,AUDS=["owner","finance","admin","governance","member","public"];
const va=k=>{$("#kview").click();const b=$(`#kvp [data-bv=${k}]`);b.click();return b},lvl=l=>{va(l);return txt("#dash")},dollars=t=>+t.replace(/[^0-9.]/g,""),gb=()=>$$("#dash .kcard b").map(b=>b.textContent),card=k=>txt(`#dash .kcard[data-k=${k}] b`);
const asYou=(sid,pid)=>{for(const r of T.SC[sid].R)r.you=r.id===pid};
const NAMES=/(Jane|Omar|Priya|Lena|Tom|Ines|Raj|Maya) (Smith|Okafor|Nair|Brandt|Cole|Ruiz|Haddad|Kim)|@/;
sc("b4u");tab("dash");
// the control
ok("view as: the old static chip is now a button with a listbox popup, eye icon, label View as <role>",$("#kview").tagName==="BUTTON"&&$("#kview").getAttribute("aria-haspopup")==="listbox"&&/^View as Finance admin$/.test(txt("#kview"))&&!!$("#kview svg")&&$("#kvp").getAttribute("role")==="listbox",txt("#kview"));
ok("view as: sits in the top bar right after the school switcher and the period control",(()=>{const k=[...$(".top").children];const i=k.indexOf($("#sw").closest(".pw")),j=k.indexOf($("#pb").closest(".pw")),l=k.indexOf($("#kview").closest(".pw"));return i>=0&&j===i+1&&l===j+1})());
ok("view as: the help keeps the old tooltip text and the preview-vs-portal line",/Owners and admins own the dashboard and see everyone's data\. Members see only themselves and their family\./.test(txt("#kvp"))&&/You are Finance admin here/.test(txt("#kvp"))&&/View as member on their row/.test(txt("#kvp")));
ok("view as: options in order Owner, Finance admin, Admin, Governance, Member, Public, each with a sees/can't-see line",$$("#kvp [data-bv]").map(b=>b.dataset.bv).join(",")===AUDS.join(",")&&$$("#kvp [data-bv]").every(b=>/Sees .*Cannot/.test(b.querySelector("small").textContent)),$$("#kvp [data-bv]").map(b=>b.dataset.bv).join(","));
ok("view as: Governance summary says months, plans, spread and no names or rows",/Sees months, plans, spread, exact\. Cannot see names or per-person rows/.test(txt("#kvp [data-bv=governance] small")),txt("#kvp [data-bv=governance] small"));
ok("view as: custom audiences are a disabled later row",$$("#kvp .it[disabled]").some(b=>/Custom audiences: later/.test(b.textContent)));
const en=()=>$$("#kvp [data-bv]").filter(b=>!b.disabled).map(b=>b.dataset.bv).join(",");
ok("view as: a finance admin previews everything but the owner (disabled, You do not hold this audience)",en()==="finance,admin,governance,member,public"&&$("#kvp [data-bv=owner]").disabled&&$("#kvp [data-bv=owner]").title==="You do not hold this audience",en());
sc("vol");$("#kview").click();ok("view as: the owner previews every role",en()===AUDS.join(","),en());closeAll();
sc("har");$("#kview").click();ok("view as: an admin without the grant who holds a membership previews Admin, Member and Public only",en()==="admin,member,public"&&$("#kvp [data-bv=governance]").title==="You do not hold this audience"&&/^View as Admin$/.test(txt("#kview")),en());closeAll();
asYou("map","u_eli");sc("map");$("#kview").click();ok("view as: an admin without the grant and no membership previews Admin and Public only",en()==="admin,public",en());closeAll();asYou("map","u_noo");
ok("view as: Cedar rule, a viewer never previews above what they hold",T.vaAllowed(T.SC.b4u,"owner")===false&&T.vaAllowed(T.SC.har,"governance")===false&&T.vaAllowed(T.SC.vol,"owner")===true);
function closeAll(){d.body.click()}
// banner, writes off, every tab re-rendered
sc("vol");tab("mem");
const tabsTxt=()=>Object.fromEntries(["pl","dash","mem","bk","cod","led","rep"].map(p=>{tab(p);return[p,txt("#"+p)]}));
const own0=tabsTxt();tab("mem");va("governance");
ok("view as: picking an option re-renders the active tab in place",$(".tab[data-p=mem]").getAttribute("aria-selected")==="true"&&!$("#mlock").hidden);
ok("view as: banner says Preview: this is what Governance sees. You are Owner. with an Exit button",!$("#vab").hidden&&/Preview: this is what Governance sees\. You are Owner\./.test(txt("#vab"))&&!!$("#vab #vax")&&/^View as Governance$/.test(txt("#kview")),txt("#vab"));
const gov0=tabsTxt();
ok("view as: every tab re-renders for the previewed role",Object.keys(own0).every(p=>own0[p]!==gov0[p]),Object.keys(own0).filter(p=>own0[p]===gov0[p]).join(","));
ok("view as: governance preview locks Members and Bookings (roster and ManageBookings, not books)",(tab("mem"),/Owners and admins see the roster/.test(txt("#mlock")))&&(tab("bk"),/Owners and admins see bookings/.test(txt("#bklock"))&&/minors' schedules/.test(txt("#bklock"))));
$("#vax").click();ok("view as: Exit returns to yourself and hides the banner",$("#vab").hidden&&/^View as Owner$/.test(txt("#kview")));
tab("mem");va("admin");openRow("m_012");
ok("view as: writes are disabled while previewing, with Exit preview to act",["[data-act=invoice]","[data-act=adjust]"].every(q=>$("#dr "+q).disabled&&$("#dr "+q).title==="Exit preview to act")&&(tab("pl"),$("[data-pnew=tiers]").disabled&&$("[data-pnew=tiers]").title==="Exit preview to act")&&(tab("cod"),$("#newcode").disabled),$("#dr [data-act=invoice]")?.title);
$("#gb").click();ok("view as: settings writes are off in preview too",$("#bsave").disabled&&$$("#set [data-dov]").every(e=>e.disabled));$("#setx").click();
tab("mem");ok("view as: admin preview shows the roster but money is Finance only",$$("#mb tr.row").length>0&&/Finance only/.test(txt("#strip [data-k=income]")));
tab("led");ok("ranked 2: Ledger is a lock panel for an admin without the grant",!$("#lblock").hidden&&/Finance admins and the owner see this/.test(txt("#lblock"))&&$("#lb").closest("table").hidden);
$("#vax").click();
// audience ladder on the Dashboard (B4 Uni: small school)
sc("b4u");tab("dash");
ok("books: viewer defaults to the signed-in audience (finance admin), no local switch on the Dashboard",/^View as Finance admin$/.test(txt("#kview"))&&!$("#dash .kbv")&&!$("#dash [data-bv]")&&!$("#dash .klock"));
const seen=Object.fromEntries(["public","member","governance","finance"].map(l=>[l,lvl(l)]));
ok("books: each audience renders a different dashboard",new Set(Object.values(seen)).size===4);
ok("books: every audience has a caption",["public","member","governance","finance"].every(l=>{lvl(l);return $$("#dash .kcaption").length>=1}));
ok("books: PIN chip only from Governance up",["public","member","governance","finance"].map(l=>{lvl(l);return $$("#dash [data-blk]").length}).join(",")==="0,0,1,1");
// Public
lvl("public");
ok("books public: switching re-snaps the period with a toast",/Period changed to 2024: Public sees years/.test(txt("#ts")),txt("#ts"));
ok("books public: year grain only",$$("#dash .kmonths [data-dpk]").map(b=>b.textContent).join(",")==="2024,2025,2026"&&$$("#dash [data-dm]").length===0,$$("#dash .kmonths button").map(b=>b.textContent).join(","));
ok("books public: small school, money rounded to $100 (not $1,000)",gb().filter(t=>/^\$/.test(t)).length>=1&&gb().filter(t=>/^\$/.test(t)).every(t=>dollars(t)%100===0)&&gb().filter(t=>/^\$/.test(t)).some(t=>dollars(t)%1000!==0)&&T.bkSize(T.SC.b4u,2024)==="small",gb().join(","));
ok("books public: years inside the delay are listed, disabled, Published after",$("#dash [data-dpk='2025']").disabled&&$("#dash [data-dpk='2025']").title==="Published after 7 Jan 2027"&&$("#dash [data-dpk='2026']").title==="Published after 7 Jan 2028",$("#dash [data-dpk='2025']").title);
$("#dash [data-dpk='2026']").click();ok("books public: a disabled year cannot be picked",/2024/.test(txt("#dash .kmonths button.on")));
ok("books public: losses and cash are members_only / governance, with the reason, never 0",$("#dash .kcard[data-k=refunds] [data-hid=members_only]")&&/Members see this/.test(card("refunds"))&&/Governance and up see this/.test(card("payouts"))&&/Members see this/.test(card("net_income")),card("refunds")+"|"+card("payouts"));
ok("books public: categories only, no plan breakdown",!/Gross by plan/.test(txt("#dash"))&&/By plan or fund\s*Governance and up see this/.test(txt("#dash")));
$("#dash [data-dv=members]").click();
ok("books public: people by quarter and activity by month, from the file",/Paying members by quarter/.test(txt("#dash"))&&/used by month/.test(txt("#dash")));
$("#dash [data-dv=money]").click();
// Member
$("#vax").click();$("#pp [data-pk=this]").click();lvl("member");
ok("books member: re-snaps to the latest published quarter with the toast",/Period changed to Q2 2026: Members see quarters/.test(txt("#ts")),txt("#ts"));
ok("books member: quarter grain",$$("#dash .kmonths [data-dpk]").length===8&&/^Q\d 20\d\d$/.test($("#dash [data-dpk]").textContent));
ok("books member: money rounded to $100",gb().filter(t=>/^\$/.test(t)).length>=3&&gb().filter(t=>/^\$/.test(t)).every(t=>dollars(t)%100===0),gb().join(","));
ok("books member: a quarter publishes 6 weeks after it closes (Q3 2026 after 18 Nov 2026)",$("#dash [data-dpk=2026Q3]").disabled&&$("#dash [data-dpk=2026Q3]").title==="Published after 18 Nov 2026"&&!$("#dash [data-dpk=2026Q2]").disabled,$("#dash [data-dpk=2026Q3]").title);
ok("books member: losses as one total, cash Governance and up",/^(\$|under \$)/.test(card("refunds"))&&/Governance and up see this/.test(card("payouts")));
// Governance
lvl("governance");
ok("books gov: month grain, closed months only",$$("#dash .kmonths button[data-dm]:not(.kwait)").length===9&&$$("#dash .kmonths button.kwait[disabled]").length===3&&/Oct: published after 7 Nov 2026/.test(txt("#dash .kcaption")),txt("#dash .kcaption"));
$("#dash [data-dm='8']").click();
ok("books gov: exact figures (cents)",gb().filter(t=>/^\$/.test(t)).every(t=>/\.\d\d$/.test(t)),gb().join(","));
ok("books gov: plan breakdown with cell rules, suppressed cell shows — with the reason",$$("#dash .kcutv").length>=1&&/fewer than 5 payers/.test(txt("#dash .kwhy")),$$("#dash .kcutv").length+" "+txt("#dash .kwhy"));
$("#dash [data-dv=members]").click();const govMem=txt("#dash");
ok("books gov: spread of donors, a failing bucket as <10 and its neighbour rounded to 10, the median, no rows",/62 donors: 40 under \$100, 20 \$100 to \$999, <10 \$1,000 or more; median gift \$45/.test(govMem)&&/rounded so the cell beside it can't be worked out/.test(govMem),govMem.match(/\d+ donors[^.]*\./)+"");
ok("books gov: no personal names, emails or per-person rows",!NAMES.test(govMem)&&$$("#dash table").length===0);
ok("books gov: months not yet closed are not drawn as zeros",$$("#dash svg title").filter(t=>/^(Oct|Nov|Dec)/.test(t.textContent)).every(t=>/not shown yet/.test(t.textContent)));
tab("rep");ok("ranked 1: governance gets the donor spread in Reports, no table, no names",/How donors give/.test(txt("#donors"))&&$$("#donors table").length===0&&!NAMES.test(txt("#donors")));
tab("led");ok("ranked 2: Ledger is a lock panel for governance",!$("#lblock").hidden&&/Finance admins and the owner see this/.test(txt("#lblock"))&&$("#lb").closest("table").hidden);
tab("dash");
// Finance admin
for(const l of["finance","owner"]){if(l==="owner"){asYou("b4u","u_pri");sc("b4u");tab("dash")}lvl(l);const n=l==="finance"?"fin":l;let all="";
 for(const v of["money","members","risk"]){$(`#dash [data-dv=${v}]`).click();all+=txt("#dash")}
 for(const m of[0,5,8,10]){$(`#dash [data-dm='${m}']`).click();$("#dash [data-dv=members]").click();all+=txt("#dash");$("#dash [data-dv=money]").click();all+=txt("#dash")}
 ok(`books ${n}: no suppressed or banded cell in any view or month`,$$("#dash .kcutv,#dash .kcut,#dash .kwhy,#dash .khid,#dash .kapprox").length===0&&!/Hidden:/.test(all));
 ok(`books ${n}: open month is hatched and live, days shown`,$$("#dash .kmonths .kopen").length===1&&$("#dash .kopen").dataset.dm==="10"&&/live/.test(txt("#dash .kmonths")));
 ok(`books ${n}: caption says everything, names included, audited`,/everything/.test(txt("#dash .kcaption"))&&/audited/.test(txt("#dash .kcaption")));
 ok(`books ${n}: no fixture value renders as null or NaN`,!/null|NaN|undefined/.test(all))}
asYou("b4u","u_jo");sc("b4u");tab("dash");
$("#dash [data-dm='10']").click();ok("books fin: daily gross for the open month",$$("#dash svg[aria-label='Gross by day'] rect").length>=28);
$("#dash [data-dm='5']").click();tab("rep");
ok("ranked 1: finance sees Donors and payers with names, amounts and the audit line",$$("#donors table").length===1&&/Ines Kim/.test(txt("#donors"))&&/\$5,000\.00/.test(txt("#donors"))&&/Every identified read is audited/.test(txt("#donors")));
ok("ranked 1: an anonymous donor shows as Anonymous with a stable id to finance, never the name",/Anonymous/.test(txt("#donors [data-anon]"))&&!/Tom Kim/.test(txt("#donors"))&&/d_[0-9a-f]{4}/.test(txt("#donors [data-anon]")),txt("#donors [data-anon]"));
tab("led");ok("ranked 2: finance sees the Ledger with names",/Dana W\./.test(txt("#lb"))&&$("#lblock").hidden,txt("#lb").slice(0,120));
// Owner (B4 Uni signed in as its owner): the anonymous donor's name resolves
asYou("b4u","u_pri");sc("b4u");tab("rep");
ok("ranked 1: the owner sees the anonymous donor's name, marked anonymous to finance",/Tom Kim/.test(txt("#donors [data-anon]"))&&/Anonymous to finance/.test(txt("#donors [data-anon]")));
asYou("b4u","u_jo");sc("b4u");tab("dash");
tab("dash");lvl("member");tab("rep");
ok("ranked 1: member Reports show a lock for Donors and payers, no names",!NAMES.test(txt("#donors"))&&/Finance admins and the owner see this/.test(txt("#donors .klock")));
ok("ranked 6: member Reports show the income statement from the Member document, chevrons disabled",!$("#stmt").closest(".two2").hidden&&/Member document/.test(txt("#stmt"))&&$$("#stmt .kdd").length>=4&&$$("#stmt .kdd").every(b=>b.disabled&&b.title==="Finance admins only"));
tab("dash");
// PIN locked
for(const l of["governance","finance","owner"]){if(l==="owner"){asYou("b4u","u_pri");sc("b4u");tab("dash")}lvl(l);if(!$("#dash [data-blk]").classList.contains("on"))$("#dash [data-blk]").click();
 ok(`books ${{governance:"gov",finance:"fin"}[l]||l} PIN locked: lock state, not zeros`,/Enter your PIN to see books/.test(txt("#dash"))&&$$("#dash .kcard").length===0&&!/\$0(?![\d,.])/.test(txt("#dash"))&&$$("#dash svg.kc").length===0,txt("#dash").slice(0,200))}
tab("rep");ok("books locked: Reports show the lock, not names",/Enter your PIN to see books/.test(txt("#rblock"))&&!NAMES.test(txt("#donors")));
tab("led");ok("books locked: Ledger shows the lock",/Enter your PIN to see books/.test(txt("#lblock")));
tab("dash");$("#dash .bpin").value="1234";$("#dash .bpin").dispatchEvent(new win.Event("input",{bubbles:true}));$("#dash [data-bpgo]").click();
ok("books PIN: entering the PIN unlocks the books",!/Enter your PIN/.test(txt("#dash"))&&$$("#dash .kcard").length===5&&!$("#dash [data-blk]").classList.contains("on"));
asYou("b4u","u_jo");
// rounding by school size: Harbor Arts is large ($1,000 for Public), B4 Uni small ($100)
sc("har");tab("dash");
ok("rounding: Harbor Arts is a large school for 2024 and 2026, B4 Uni small",T.bkSize(T.SC.har,2024)==="large"&&T.bkSize(T.SC.har,2026)==="large"&&T.bkSize(T.SC.b4u,2026)==="small");
lvl("public");ok("rounding: large school, Public money to the nearest $1,000",gb().filter(t=>/^\$/.test(t)).length>=1&&gb().filter(t=>/^\$/.test(t)).every(t=>dollars(t)%1000===0),gb().join(","));
lvl("member");$("#dash [data-dpk=2025Q4]").click();
{const yr=$("#dash .kyear > b"),note=txt("#dash .kyearnote"),sumQ=note.match(/\$[\d,]+/);
 ok("rounding: large school, Member money to $100, and the year total is not the sum of its rounded quarters",dollars(card("gross_collected"))%100===0&&!!yr&&!!sumQ&&dollars(yr.textContent)!==dollars(sumQ[0]),txt("#dash .kyear")+" | "+note)}
// Plans: per-tier members and revenue (breakdown) for an admin without the grant
tab("pl");$("#kview").click();$("#kvp [data-bv=admin]").click();
ok("ranked 7: admin without the grant sees plan structure, revenue and counts Finance or governance only",$$("#pl [data-k=revenue_by_tier]").length>=2&&$$("#pl [data-k=revenue_by_tier]").every(c=>/Finance or governance only/.test(c.textContent))&&/default is the owner's to change/.test(txt("#pl")));
tab("cod");ok("ranked 8: promo redemption counts are Governance and up; Redemptions (names) finance only",/Governance and up see this/.test(txt("#cb [data-k=redemptions]"))&&$("#cb [data-red]").disabled&&$("#cb [data-red]").title==="Finance admins only: lists who redeemed");
tab("mem");openRow("h_32");
ok("ranked 3: drawer for an admin without the grant: payments Finance only, invoice and adjust Finance only, CSV finance admins only",/Finance only/.test(txt("#dr .kpay"))&&$("#dr [data-act=invoice]").disabled&&$("#dr [data-act=invoice]").title==="Finance only"&&$("#dr [data-kx=csv]").disabled&&/\d+\/\d+|available/.test(txt("#dr")),$("#dr [data-act=invoice]")?.title);
$("#dr [data-kmenu]").click();ok("ranked 3: the ⋯ menu gates money items for an admin without the grant",$("#kmm [data-act=invoice]").title==="Finance only"&&$("#kmm [data-act=adjust]").title==="Finance only"&&$("#kmm [data-kx=csv]").title==="Finance admins only"&&$("#kmm [data-role]").disabled);closeAll();
portal("h_32");$("#vm [data-vtab=bill]").click();ok("ranked 3: the portal preview by an admin without the grant shows no amounts and cannot export",/Finance only/.test(txt("#khist"))&&!/\$\d/.test(txt("#khist tbody"))&&$("#kdl").disabled);$("#vm #vmx").click();
// Plans as governance (vol owner previewing)
sc("vol");tab("pl");va("governance");
ok("ranked 7: governance sees per-plan counts with small counts as <10 and revenue hidden under 5 payers",$$("#pl [data-k=tier_members] .kapprox").length>=1&&$$("#pl [data-k=revenue_by_tier] .kcutv").length>=1);
va("public");ok("ranked 7: public preview shows only plans on sale and Governance and up for the breakdown",!/Board/.test(txt("#pl tbody"))&&$$("#pl [data-k=revenue_by_tier]").every(c=>/Governance and up see this/.test(c.textContent)));
tab("cod");ok("ranked 8: public preview of Promos cannot reveal codes",$$("#cb [data-rev]").every(b=>b.disabled));
$("#vax").click();
// tiny school: counts under 5 payers are <10, amounts hidden
ok("counts: tiny school at Public shows a failing count as <10 and hides the amount",(sc("vol"),tab("dash"),lvl("public"),$("#dash [data-dv=members]").click(),/^<10$/.test(card("paying_members"))&&$$("#dash .kcut").length>=1&&/fewer than 5 payers/.test(txt("#dash"))),txt("#dash .kcards"));
ok("counts: failing counts round to the nearest 10 and 1-9 shows <10, never 0",(()=>{const m=T.pMeta(T.perY(2024)),a=T.bkFig(T.SC.vol,"public","payments_count",m,{v:14,n:3}),b=T.bkFig(T.SC.vol,"public","payments_count",m,{v:3,n:3}),c=T.bkFig(T.SC.vol,"public","payments_count",m,{v:26,n:2}),e=T.bkFig(T.SC.vol,"public","payments_count",m,{v:7,n:9});return a.t==="10"&&b.t==="<10"&&c.t==="30"&&e.t==="7"})());
$("#vax").click();
// the disclosure object drives the dashboard
sc("b4u");tab("dash");lvl("member");const cap0=txt("#dash .kcaption");
T.DISCLOSURE.disclose.income.member.every="year";T.render();const cap1=txt("#dash .kcaption");T.DISCLOSURE.disclose.income.member.every="quarter";T.render();
ok("disclosure: changing one rule in the JS object changes the rendered caption",/Income: categories by quarter, 6 weeks after it closes/.test(cap0)&&/Income: categories by year, 6 weeks after it closes/.test(cap1),cap0.slice(0,120)+" || "+cap1.slice(0,120));
$("#vax").click();
// chips and drawer lines
tab("mem");
const bk=id=>(row(id)?.querySelector(".kbk")?.className||"").replace(/.*kbk-/,"").split(" ")[0],bkt=id=>(row(id)?.querySelector(".kbk")?.textContent||"").trim();
ok("audience chip: Owner is Owner · everything",bk("u_pri")==="owner"&&/Audience: Owner · everything/.test(bkt("u_pri")),bkt("u_pri"));
ok("audience chip: admin with the finance grant is Finance admin",bk("u_tes")==="finance"&&bk("u_jo")==="finance");
ok("audience chip: adult with a live Board membership is Governance",bk("s_27")==="governance"&&/Governance/.test(bkt("s_27")));
ok("audience chip: adult with a live membership is Member",bk("s_21")==="member"&&bk("s_22")==="member");
ok("audience chip: a child never holds Member, the guardian does",bk("s_26")==="public"&&bk("s_25")==="public"&&/Dana W\./.test(row("s_26").querySelector(".kbk").title));
win.__t.SC.vol.R.push({id:"u_rav",name:"Ravi S.",role:"admin",fin:true});sc("vol");tab("mem");
ok("audience chip: admin without the finance grant gets audiences like anyone else (Member by plan)",bk("m_093")==="member"&&bk("u_rav")==="finance"&&bk("u_kim")==="owner");
openRow("m_051");ok("audience chip: a canceled membership is Public",bk("m_051")==="public"&&/Audience: Public/.test(txt("#dr")));
openRow("u_rav");mk("revoke").click();$("#rgo").click();ok("audience chip: revoking the grant drops the admin to Public",bk("u_rav")==="public"&&/Audience: Public/.test(txt("#dr")));
// Plans: the tier field is `audience`; changing it moves members at once, with a notice and an audit row
sc("b4u");tab("pl");
ok("tier audience: Board tier is hidden, not for sale, names Governance",/Not for sale/.test(txt("#pl [data-pe='tiers:board']"))&&/Hidden/.test(txt("#pl [data-pe='tiers:board']"))&&/Audience: Governance/.test(txt("#pl [data-pe='tiers:board']")));
$("#pl tr[data-pe='tiers:board']").click();
ok("tier audience: editor has an Audience field, Governance for Board, no finance or owner",!!$("#paud")&&$("#paud").value==="governance"&&[...$("#paud").options].map(o=>o.value).join(",")==="member,governance,public"&&/Audience/.test(txt("#pe")));
$("#pe #pcancel").click();
sc("vol");tab("pl");$("#pl tr[data-pe='tiers:sparkle']").click();ok("tier audience: default is Member",$("#paud").value==="member");
$("#paud").value="governance";$("#paud").dispatchEvent(new win.Event("change",{bubbles:true}));$("#psave").click();
ok("tier audience: the change lands in the draft",/draft/.test(txt("#pl [data-pe='tiers:sparkle']"))&&/Audience: Governance/.test(txt("#pl [data-pe='tiers:sparkle']")));
$("#prev").click();ok("tier audience: review says access moves at once, with a notice",/Audience Member → Governance/.test(txt("#md"))&&/Access moves at once/.test(txt("#md")),txt("#md").slice(0,260));
{const v0=T.SC.vol.pl.version;$("#ppin").value="1234";$("#ppin").dispatchEvent(new win.Event("input",{bubbles:true}));$("#pgo").click();
 ok("tier audience: publishing writes one books.audience_changed audit row",T.SC.vol.E.filter(e=>e.ty==="books.audience_changed").length===1&&/Sparkle: audience Member → Governance; 3 members moved at once/.test(T.SC.vol.E.find(e=>e.ty==="books.audience_changed").tx),T.SC.vol.E[0].tx);
 portal("m_204");ok("tier audience: members on the tier move at once and see the notice",$("#vm [data-books]").dataset.books==="governance"&&/What members can see changed on 5 Nov 2026/.test(txt("#vm [data-audchg]")));$("#vm #vmx").click();
 for(const x of[T.SC.vol.pl.pub,T.SC.vol.pl.draft])delete x.tiers.find(t=>t.id==="sparkle").audience;delete T.SC.vol.audChg;T.SC.vol.pl.version=v0}
// Settings: the six-class disclosure table and the override rules
sc("vol");$("#gb").click();
ok("settings: the six classes with their KPIs and what each audience sees",$$("#set [data-dclass]").map(r=>r.dataset.dclass).join(",")==="income,losses,cash,people,activity,personal"&&/categories · year · 12 months/.test(txt("#set [data-dcell='income.public']"))&&/categories · quarter · 6 weeks/.test(txt("#set [data-dcell='income.member']"))&&/total · quarter · at close/.test(txt("#set [data-dcell='people.public']"))&&/as Public/.test(txt("#set [data-dcell='people.member']"))&&/refund_rate/.test(txt("#set [data-dclass=losses]")),txt("#set [data-dcell='income.public']"));
ok("settings: rounding by size explained and this school's size shown",/vibes of light is small/i.test(txt("#set"))&&/\$1,000 for Public/.test(txt("#set")));
ok("settings: custom audiences are a disabled later row",/Custom audiences: later/.test(txt("#set .kdcust"))&&$("#set .kdcust button").disabled);
ok("settings: the change-permission table",/More open for Public\s*Owner\s*PIN and the mailed-link step-up/.test(txt("#set .kdperm"))&&/Below the floor\s*Nobody\s*Refused/.test(txt("#set .kdperm")));
const setD=(k,v)=>{const e=$(`#set [data-dov=${k}]`);e.value=v;e.dispatchEvent(new win.Event("change",{bubbles:true}))};
setD("kpi","refund_rate");setD("cls","income");
ok("settings: moving refund_rate to a more open class than refunds is refused, more_open_than_input",/400 more_open_than_input: refund_rate \(income\) would be more open than its input refunds \(losses\)/.test(txt("#dval"))&&$("#dsave").disabled,txt("#dval"));
$("#dreset").click();setD("rc","income");setD("ra","public");setD("rd","breakdown");
ok("settings: Public money finer than categories is below the floor",/400 below_floor/.test(txt("#dval"))&&$("#dsave").disabled,txt("#dval"));
$("#dreset").click();setD("rc","losses");setD("ra","member");setD("rl","12 months");
ok("settings: a stricter rule is valid and needs the PIN only",/Valid\. Stricter: your PIN/.test(txt("#dval"))&&!$("#dsave").disabled,txt("#dval"));
$("#dsave").click();$("#dpin").value="1234";$("#dpin").dispatchEvent(new win.Event("input",{bubbles:true}));$("#dpgo").click();
ok("settings: saving writes books.disclosure_changed and the member caption follows",T.SC.vol.E[0].ty==="books.disclosure_changed"&&/applies from the next document build/.test(txt("#ts"))&&(sc("vol"),tab("dash"),lvl("member"),/Losses: total by quarter, 12 months after it closes/.test(txt("#dash .kcaption"))),txt("#dash .kcaption").slice(0,140));
$("#vax").click();delete T.SC.vol.discO;delete T.SC.vol.discD;
$("#gb").click();setD("rc","people");setD("ra","public");setD("rg","month");
ok("settings: more open for Public is valid but needs PIN and the mailed-link step-up",/More open for Public: your PIN and a mailed-link/.test(txt("#dval")),txt("#dval"));
$("#dsave").click();$("#dpin").value="1234";$("#dpin").dispatchEvent(new win.Event("input",{bubbles:true}));$("#dpgo").click();
ok("settings: the step-up modal opens after the PIN",$("#bg").classList.contains("on")&&/A link was mailed to confirm: this publishes your books/.test(txt("#md")));
$("[data-close]").click();ok("settings: cancelling the step-up changes nothing",!T.SC.vol.discO);
delete T.SC.vol.discD;$("#setx").click();
sc("b4u");$("#gb").click();
ok("settings: admins see the disclosure read-only",$$("#set [data-dov]").length>=7&&$$("#set [data-dov]").every(e=>e.disabled)&&!$("#dsave")&&/Owners change the disclosure/.test(txt("#set")));
$("#setx").click();
// Member portal: the person's own audience document; Embed offers only the public document
const pc=id=>{tab("mem");row(id).querySelector("[data-vm]").click();return $("#vm [data-books]")};
let crd=pc("s_21");ok("portal: adult member reads the Member document (quarters, $100)",crd?.dataset.books==="member"&&/Quarters/.test(crd.textContent)&&/\$100/.test(crd.textContent),crd?.textContent);
$("#vm #vemb").click();ok("embed: only the Public document can be embedded, with the warning",/Only the public document may be embedded/.test(txt("#md"))&&[...$("#embaud").options].filter(o=>!o.disabled).map(o=>o.value).join(",")==="public"&&/\/public\/schools\//.test(txt("#md")));$("[data-close]").click();
$("#vm #vmx").click();
crd=pc("s_27");ok("portal: Governance-tier adult sees the governance view link",crd?.dataset.books==="governance"&&/Open the governance view/.test(crd.textContent));$("#vm #vmx").click();
crd=pc("s_26");ok("portal: a child sees that their guardian sees school books",crd?.dataset.books==="public"&&/Your guardian \(Dana W\.\) sees school books/.test(crd.textContent));$("#vm #vmx").click();
sc("vol");crd=pc("m_051");ok("portal: a member without a live membership reads the Public document",crd?.dataset.books==="public"&&/Public document/.test(crd.textContent));$("#vm #vmx").click();
// The period control: one, in the top bar, following the audience
sc("vol");tab("dash");
ok("period: one control in the top bar right of the school switcher",$("#sw").closest(".pw").nextElementSibling===$("#pb").closest(".pw")&&$$("#pb").length===1&&!$("#per"));
ok("period: closed control shows no dates, only an icon and a preset word, with an accessible name",!/\d|Nov/.test(txt("#pb"))&&/^Month$/.test(txt("#pb"))&&$("#pb").getAttribute("aria-label")==="Period: Nov 2026"&&$("#pb").title==="Nov 2026"&&$("#pb").getAttribute("aria-haspopup")==="dialog",txt("#pb"));
$("#pb").click();ok("period: the popover holds the date label, arrows, presets, custom range and compare",$("#pp").classList.contains("on")&&txt("#pplab")==="Nov 2026"&&!!$("#pprev")&&!!$("#pnext")&&["this","last","tq","lq","ty","ly","ytd"].every(k=>!!$(`#pp [data-pk=${k}]`))&&!!$("#cf")&&!!$("#cmpc"));
$("#pp [data-pk=last]").click();
ok("period: one control drives Dashboard, Reports, Ledger and Members",txt("#dash .kmonths button.on")==="Oct"&&(tab("rep"),/Oct 2026/.test(txt("#stmt")))&&(tab("led"),$$("#lb tr.day:not(.wait)").length>0&&$$("#lb tr.day:not(.wait)").every(r=>/Oct/.test(r.textContent)))&&(tab("mem"),/Oct 2026/.test(txt("#strip"))),txt("#dash .kmonths button.on"));
ok("period: a non-default period tints the control",$("#pb").classList.contains("pnd"));
tab("dash");$("#dash [data-dm='4']").click();ok("period: a month picked on the dashboard is the same period everywhere",(tab("rep"),/May 2026/.test(txt("#stmt"))));
tab("dash");va("public");$("#pb").click();
ok("period: Public may pick only years; presets it cannot use are disabled with the reason",$$("#pp .ppgrid [data-pk]").every(b=>/^y:/.test(b.dataset.pk))&&$("#pp [data-pk=this]").disabled&&/Governance and up see this: Public sees years/.test($("#pp [data-pk=this]").title)&&$("#pp [data-pk=lq]").disabled&&/Members see this/.test($("#pp [data-pk=lq]").title)&&!$("#cf"),$("#pp [data-pk=lq]").title);
ok("period: embargoed years are listed but disabled, Published after",$("#pp [data-pk='y:2025']").disabled&&/Published after 7 Jan 2027/.test($("#pp [data-pk='y:2025']").title)&&!$("#pp [data-pk='y:2024']").disabled);
closeAll();$("#vax").click();
const kept=P_label();tab("bk");ok("period: on Bookings the same control offers Today, Tomorrow, This week, Next week",$$("#pp [data-bp]").length===4&&$$("#pp [data-pk]").length===0&&/^Week$/.test(txt("#pb")));
$("#pp [data-bp='day:1']").click();tab("dash");ok("period: leaving Bookings restores the money period",P_label()===kept&&!$$("#pp [data-bp]").length,P_label());
function P_label(){return $("#pb").getAttribute("aria-label")}
// narrow top bar: ? and gear stay on the first row; the other controls are compact
{const css=d.querySelector("style").textContent;
 ok("narrow: ? and gear are pinned (no shrink) and ordered before period and View as when the bar wraps",/\.top \.ib\{flex-shrink:0\}/.test(css)&&/@media \(max-width:440px\)\{\.top \.tsw\{order:1\}\.top \.tsp\{order:2\}\.top \.thb,\.top #gb\{order:3\}\.top \.tbrk\{display:block;order:4;flex-basis:100%;height:0\}\.top \.tper\{order:5\}\.top \.tva\{order:6\}\}/.test(css));
 ok("narrow: compact classes, labels collapse to icon plus short role, school name truncates",/@media \(max-width:640px\)\{[^@]*\.pbw,\.va-l\{display:none\}/.test(css)&&/#sw \.swn\{overflow:hidden;text-overflow:ellipsis/.test(css)&&!!$("#pb .pbw")&&!!$("#kview .va-l")&&!!$("#kview .va-r")&&!!$("#sw .swn")&&$("#hb").closest(".pw").classList.contains("thb"))}
// The audience matrix: every tab x every role on the small and the large school
const EXACT=/\$[\d,]+\.\d\d/,HIDOK=/^(Members see this|Governance and up see this|Finance admins and the owner see this|Finance only|Finance or governance only|Published after \d{1,2} [A-Z][a-z]{2} 20\d\d|Not published yet|Public sees [a-z]+|Members see [a-z]+|Governance sees [a-z]+)$/;
const exp=(sid,aud,k)=>{const s=T.SC[sid],m=T.pMeta(T.pMetaOf()),y=m.y,a=T.bkAggP(s,m),prev=T.bkAgg(T.bkYear(s,y-1),[...Array(12).keys()]).g,size=prev>=T.DISCLOSURE.rounding.largeFrom?"large":"small",u=(T.DISCLOSURE.rounding[size]||{})[aud]||0,v=a[{gross_collected:"g",refunds:"r",stripe_fees:"f",payouts:"po"}[k]];const R=Math.round(v/u)*u;return u?(v>0&&R===0?`under $${(u/100).toLocaleString("en-US")}`:`$${(R/100).toLocaleString("en-US")}`):`$${(v/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`};
for(const[sid,you]of[["vol","u_kim"],["b4u","u_jo"],["har","u_hal"]]){asYou(sid,you);sc(sid);const roles=AUDS.filter(r=>T.vaAllowed(T.SC[sid],r));
 for(const r of roles){va(r);const v=T.VW(T.SC[sid]),low=!v.fin,money=v.aud==="public"||v.aud==="member";let bad=[];
  for(const p of["pl","dash","mem","bk","cod","led","rep"]){tab(p);const el=$("#"+p),t=txt("#"+p);
   if(/null|NaN|undefined/.test(t))bad.push(`${p}: null/NaN`);
   if(low&&["dash","led","rep"].includes(p)&&NAMES.test(t))bad.push(`${p}: a name`);
   if(low&&p==="led"&&$("#lb").closest("table").hidden!==true)bad.push("led: rows shown");
   if(money&&["dash","rep","led"].includes(p)&&EXACT.test(t.replace(/Rules in force.*$/,"")))bad.push(`${p}: exact money ${t.match(EXACT)[0]}`);
   for(const x of el.querySelectorAll(".khid"))if(!HIDOK.test(x.textContent.trim()))bad.push(`${p}: hid "${x.textContent.trim()}"`);
   for(const x of el.querySelectorAll(".kcutv"))if(!/^Hidden: /.test(x.title))bad.push(`${p}: cut without reason`);
   for(const x of el.querySelectorAll("[data-hid]"))if(/^\s*0\s*$/.test(x.textContent))bad.push(`${p}: hidden as 0`);
   for(const x of el.querySelectorAll(".klock"))if(!x.querySelector("h4")?.textContent.trim())bad.push(`${p}: lock without who`)}
  ok(`matrix ${sid} ${r}: no names or exact money where not allowed, every gate carries its reason, never 0 or null`,!bad.length,bad.slice(0,4).join(" | "));
  if(["public","member","governance"].includes(v.aud)&&sid!=="vol"&&r!=="admin"){tab("rep");const got=k=>txt(`#kpis [data-k=${k}] b`);
   ok(`matrix ${sid} ${r}: Reports tiles equal the disclosure-driven values`,["gross_collected","refunds","stripe_fees","payouts"].every(k=>{const x=T.bkFig(T.SC[sid],v.aud,k,T.pMeta(T.pMetaOf()));return x.hid?got(k)===(x.cut?"—":x.hid.text):got(k)===exp(sid,v.aud,k)}),["gross_collected","refunds","stripe_fees","payouts"].map(k=>got(k)+"/"+(T.bkFig(T.SC[sid],v.aud,k,T.pMeta(T.pMetaOf())).hid?"hid":exp(sid,v.aud,k))).join(" "))}}
 $("#vax")?.click()}
asYou("har","h_31");
sc("b4u");tab("rep");const r0=txt("#kpis");$("#kview").click();$("#kvp [data-bv=member]").click();
ok("matrix: switching audience on Reports re-renders without a tab change",$(".tab[data-p=rep]").getAttribute("aria-selected")==="true"&&txt("#kpis")!==r0&&/Member document/.test(txt("#stmt")));
{const csv=T.reportDocCsv(T.SC.b4u,T.VW(T.SC.b4u));ok("matrix: the Reports download for a lower audience is aggregate only",/^\uFEFFline,kpi,value,hidden,audience,period\r\n/.test(csv)&&/,member,/.test(csv)&&!NAMES.test(csv)&&!/Dana|Omar/.test(csv))}
$("#vax").click();
// Legibility: chart axis labels are HTML (not SVG text that the viewBox shrinks), at least 11px; role chips and the three-segment balance bar render with their classes
{const css=d.querySelector("style").textContent,px=sel=>+((css.match(new RegExp(sel.replace(/[.]/g,"\\.")+"[^{]*\\{[^}]*font-size:([\\d.]+)px"))||[])[1]||0);
 sc("b4u");tab("dash");$("#dash [data-dm='5']").click();
 ok("axis: gross vs net has 12 month labels, none are SVG text",$$("#dash .kax").length>=1&&$$("#dash .kax")[0].children.length===12&&$$("#dash svg.kc text").length===0,$$("#dash svg.kc text").length+"");
 ok("axis: gross by day has day labels",$$("#dash .kaxd span").length>=6&&/^1$/.test($("#dash .kaxd span").textContent),$$("#dash .kaxd span").length+"");
 ok("axis: label font is at least 11px",px(".kax span")>=11&&px(".kaxd span")>=11&&px(".kthr")>=11,[px(".kax span"),px(".kaxd span"),px(".kthr")].join(","));
 ok("axis: the selected month label is marked",$$("#dash .kax span.on").length===1&&$("#dash .kax span.on").textContent==="Jun");
 sc("vol");tab("mem");
 ok("chips: role and finance chips carry their styled classes",$$("#mb .krole").length>=1&&/\.krole\{[^}]*border:1px solid/.test(css)&&/\.kfin\{[^}]*border:1px dashed/.test(css));
 ok("balance bar: three segments on every row with a plan",$$("#mb .bar3").length>=1&&$$("#mb .bar3").every(b=>b.querySelectorAll("i.u,i.h,i.a").length===3),$$("#mb .bar3").length+"")}
// Plans as YAML: Code is the third mode of the Plans tab and edits the same draft as Edit and Preview
{const {SC,kEmit,kParse}=win.__t,wait=ms=>new Promise(r=>setTimeout(r,ms)),clone=o=>JSON.parse(JSON.stringify(o)),
 same=(a,b)=>JSON.stringify(a,(k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(x=>[x,v[x]])):v)===JSON.stringify(b,(k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(x=>[x,v[x]])):v),
 setText=async v=>{const ta=$("#kta");ta.value=v;ta.dispatchEvent(new win.Event("input",{bubbles:true}));await wait(400)},
 mode=m=>$(`#pl [data-pmode=${m}]`).click(),code=()=>$("#kta").value,pill=()=>txt("#pl .kpill"),
 reset=id=>{sc(id);tab("pl");SC[id].pl.draft=clone(SC[id].pl.pub);delete SC[id].kYaml;SC[id].plMode="edit";$(`.tab[data-p=pl]`).click();mode("edit")};
 // the segment
 sc("vol");tab("pl");
 ok("yaml: the Plans mode segment is Edit | Preview | Code",$$("#pl [data-pmode]").map(b=>b.dataset.pmode).join(",")==="edit,preview,code"&&/Code/.test($("#pl [data-pmode=code]").textContent),$$("#pl [data-pmode]").map(b=>b.dataset.pmode).join(","));
 // round trip, every school fixture, plus a hostile draft
 const board=SC.b4u.pl.pub.tiers.find(t=>t.id==="board");
 ok("yaml: fixtures include a non-public tier and the Board tier",!!board&&board.pub===false&&SC.b4u.pl.pub.tiers.some(t=>t.audience==="governance"));
 for(const id of Object.keys(SC)){const s=SC[id],r=kParse(kEmit(s),s);
  ok(`yaml: round trip parse(emit(draft)) equals the draft, ${id}`,r.ok&&same(r.draft,s.pl.draft),r.ok?"":`line ${r.line}: ${r.msg}`)}
 {const s=SC.vol,odd=clone(s.pl.draft);odd.tiers[0].name='Say "hi": it\'s #1, café';odd.tiers[0].blurb="";odd.tiers[1].blurb="yes";odd.tiers[1].name="007";odd.tiers[2].audience="governance";odd.tiers[2].year=null;odd.addons[0].name="- not a list";odd.addons[1].name="*star";odd.tiers[0].qty=[3,1];
  const r=kParse(kEmit(s,odd),s);ok("yaml: round trip keeps quotes, colons, # signs, accents, words like yes, numbers as names",r.ok&&same(r.draft,odd),r.ok?JSON.stringify(r.draft.tiers[0]):`line ${r.line}: ${r.msg}`)}
 ok("yaml: Stripe ids are read-only comments on published plans and absent plans say so",(()=>{const s=SC.vol,d=clone(s.pl.draft);d.tiers.push({id:"fresh",name:"Fresh",blurb:"",pub:true,month:9,year:null,qty:null,grants:[{n:1,every:"month",roll:0}]});const t=kEmit(s,d);return(t.match(/# stripe: prod_\w{14} · month price_\w{14}/g)||[]).length===3&&/# stripe: created when you publish\n  - id: fresh/.test(t)&&kParse(t,s).ok})());
 // the view: gutter, toolbar, status, help line, changes list
 reset("vol");mode("code");
 ok("yaml: Code shows a monospace textarea with a line-number gutter that matches the text",!!$("#kta")&&$$("#kgut i").length===code().split("\n").length&&/^1$/.test($("#kgut i").textContent),$$("#kgut i").length+" vs "+code().split("\n").length);
 ok("yaml: toolbar has Format, Copy, Reset to published and a Valid pill",["#kfmt","#kcopy","#kreset"].every(x=>!!$(x))&&/Valid/.test(pill()),pill());
 ok("yaml: the honest-limits line is shown under the toolbar",/Comments are not saved: plans are stored as JSON\. Anchors, aliases and tags are not accepted\./.test(txt("#khelp")));
 ok("yaml: Code has the plans, ids as keys, the read-only header, and Review stays disabled with no changes",/^memberships:$/m.test(code())&&/- id: sparkle/.test(code())&&/^packs:$/m.test(code())&&/^timeZone: America\/Denver$/m.test(code())&&/No changes yet/.test(txt(".kchg"))&&$("#prev").disabled);
 // edits flow through: Code -> Edit -> review
 const ta0=$("#kta");
 await setText(code().replace(/(- id: shine[\s\S]*?month: )30\b/,"$131"));
 ok("yaml: the debounced re-render keeps the same textarea node (caret, undo history and scroll survive)",$("#kta")===ta0);
 ok("yaml: a price typed in Code updates the draft after the debounce",SC.vol.pl.draft.tiers.find(t=>t.id==="shine").month===31,String(SC.vol.pl.draft.tiers.find(t=>t.id==="shine")?.month));
 ok("yaml: the change shows under Changes vs published and Review and publish enables",/Shine/.test(txt(".kchg"))&&/Monthly price \$30\.00 → \$31\.00/.test(txt(".kchg"))&&!$("#prev").disabled&&/Draft · 1 change/.test(txt("#pl .tools")),txt(".kchg"));
 mode("edit");
 ok("yaml: Edit shows the price typed in Code",/\$31\.00/.test(txt("#pl tr[data-pe='tiers:shine']"))&&$("#pl tr.chg[data-pe='tiers:shine']")!==null,txt("#pl tr[data-pe='tiers:shine']"));
 mode("preview");mode("code");
 ok("yaml: switching modes keeps the edit (Code -> Edit -> Preview -> Code)",/month: 31\b/.test(code()));
 $("#prev").click();
 ok("yaml: Review and publish lists the changed tier with the old and new price and the member count",/Shine/.test(txt("#md"))&&/Monthly price \$30\.00 → \$31\.00/.test(txt("#md"))&&/1 current member/.test(txt("#md"))&&!/Sparkle|Glow/.test(txt("#md h5")),txt("#md").slice(0,200));
 $("#md [data-close]").click();
 // edits flow through: Edit (draft) -> Code
 SC.vol.pl.draft.tiers.find(t=>t.id==="glow").blurb="Edited elsewhere";mode("edit");mode("code");
 ok("yaml: an edit made in Edit shows up in Code",/blurb: Edited elsewhere/.test(code()));
 // invalid documents leave the draft alone
 const before=JSON.stringify(SC.vol.pl.draft);
 await setText(code().replace(/month: 31\b/,'month: "oops'));
 ok("yaml: an invalid document shows Parse error at line N and leaves the draft unchanged",/Parse error at line \d+/.test(pill())&&JSON.stringify(SC.vol.pl.draft)===before&&/draft is unchanged/i.test(txt("#kmsg")),pill()+" | "+txt("#kmsg"));
 ok("yaml: the error line is marked in the gutter and has a jump link",$$("#kgut i.bad").length===1&&!!$("#kmsg [data-kline]"),$$("#kgut i.bad").length+"");
 mode("edit");mode("code");
 ok("yaml: the invalid text survives a mode switch",/month: "oops/.test(code())&&/Parse error/.test(pill()));
 // anchors, aliases, tags and friends
 const s0=SC.vol,base=kEmit(s0),bad=(label,from,to,re)=>{const r=kParse(base.replace(from,to),s0);ok(`yaml: ${label} is rejected with a clear error`,!r.ok&&re.test(r.msg),r.ok?"parsed":r.msg)};
 bad("an anchor","name: Sparkle","name: &a Sparkle",/Anchors/);
 bad("an alias","blurb: Regular sessions","blurb: *a",/Aliases/);
 bad("a tag","name: Shine","name: !!str Shine",/Tags/);
 bad("a merge key","    public: true\n    prices:","    <<: *base\n    prices:",/Merge keys/);
 bad("block text","blurb: Regular sessions","blurb: |",/Block text/);
 bad("an inline map","      month: 65","      month: {a: 1}",/Inline/);
 bad("a tab indent","    name: Glow","\tname: Glow",/Tabs/);
 bad("an unknown key","    public: true\n    prices:","    colour: red\n    public: true\n    prices:",/Unknown key "colour"/);
 bad("a second document","timeZone: America/Denver","timeZone: America/Denver\n---\nmemberships: []",/one document/);
 bad("a changed time zone","timeZone: America/Denver","timeZone: Asia/Tokyo",/Settings/);
 bad("a wrong price type","      month: 65","      month: free",/month must be a number/);
 reset("vol");mode("code");
 await setText(code().replace("name: Sparkle","name: &a Sparkle"));
 ok("yaml: an anchor typed in the editor shows the error in the status pill",/Parse error at line \d+/.test(pill())&&/Anchors/.test(txt("#kmsg")),txt("#kmsg"));
 // problems reuse problems(s), with the offending tier's line marked
 reset("vol");mode("code");
 await setText(code().replace(/(- id: glow[\s\S]*?month: )65\b/,"$10"));
 ok("yaml: problems(s) are listed under the editor and the status pill counts them",/1 problem/.test(pill())&&/Glow: monthly price must be above 0\./.test(txt("#kmsg")),pill()+" | "+txt("#kmsg"));
 ok("yaml: the offending tier's line is highlighted in the gutter and Review is disabled",$$("#kgut i.bad").length===1&&+$("#kgut i.bad").textContent===code().split("\n").findIndex(l=>/- id: glow/.test(l))+1&&$("#prev").disabled,$$("#kgut i.bad").map(x=>x.textContent).join(","));
 // removed tiers are not dropped silently
 reset("vol");mode("code");
 await setText(code().replace(/ {2}# stripe:[^\n]*\n {2}- id: glow[\s\S]*?(?=\n\npacks:)/,"").replace(/\n\n\n/,"\n\n"));
 ok("yaml: a published tier missing from the draft shows as Removed in the changes list",SC.vol.pl.draft.tiers.length===2&&/Glow/.test(txt(".kchg"))&&/Removed/.test(txt(".kchg")),txt(".kchg").slice(0,120));
 $("#prev").click();
 ok("yaml: the publish review lists the removed tier and its 1 current member",!$("#prev").disabled&&/Glow/.test(txt("#md"))&&/Removed/.test(txt("#md"))&&/1 current member/.test(txt("#md")),txt("#md").slice(0,200));
 $("#md [data-close]").click();mode("edit");
 ok("yaml: Edit mode says what was removed and keeps the Discard draft button",/Removed in the draft: Glow/.test(txt("#pl .note"))&&!!$("#pdisc"),txt("#pl .note"));
 // Format
 reset("vol");mode("code");
 await setText(code().replace("name: Shine","name:   Shine   # my note").replace(/# stripe:[^\n]*/,"# stripe: tampered")+"\n\n# a trailing comment\n");
 $("#kfmt").click();const once=code();
 ok("yaml: Format re-emits the canonical YAML, drops comments, regenerates the Stripe comments",!/my note|tampered|trailing comment/.test(once)&&once===kEmit(SC.vol)&&/name: Shine\n/.test(once),once.slice(0,160));
 $("#kfmt").click();
 ok("yaml: Format is idempotent",code()===once&&kEmit(SC.vol,kParse(once,SC.vol).draft)===once);
 await setText('name: "broken');const broken=code();$("#kfmt").click();
 ok("yaml: Format on an invalid document changes nothing and says why",code()===broken&&/Fix line/.test(txt("#ts")),txt("#ts"));
 // Reset to published
 reset("vol");mode("code");await setText(code().replace(/(- id: shine[\s\S]*?month: )30\b/,"$140"));
 ok("yaml: Reset to published is enabled with changes",!$("#kreset").disabled);
 $("#kreset").click();
 ok("yaml: Reset to published restores the draft and the text",same(SC.vol.pl.draft,SC.vol.pl.pub)&&/month: 30\b/.test(code())&&$("#kreset").disabled);
 // permissions: owners edit, admins read
 sc("vol");tab("pl");mode("code");
 ok("yaml: owner gets an editable textarea and enabled Format",!$("#kta").hasAttribute("readonly")&&!$("#kfmt").disabled&&!/Owners edit plans/.test(txt("#pl")));
 sc("b4u");tab("pl");mode("code");
 ok("yaml: admin reads Code but the textarea is read-only, Format and Reset are disabled, with the owners note",$("#kta").hasAttribute("readonly")&&$("#kfmt").disabled&&$("#kreset").disabled&&/Owners edit plans/.test(txt("#pl"))&&!$("#kcopy").disabled&&/Board/.test(code())&&/public: false/.test(code())&&/audience: governance/.test(code()),txt("#pl .lock"));
 mode("edit");sc("vol");tab("pl");
 // publish through the review: version bumps and the Code text follows
 sc("map");tab("pl");mode("code");
 await setText(code().replace(/(- id: glow[\s\S]*?month: )85\b/,"$190"));
 $("#prev").click();$("#ppin").value="1234";$("#ppin").dispatchEvent(new win.Event("input",{bubbles:true}));$("#pgo").click();
 ok("yaml: publishing from a Code edit publishes it and the text follows the new version, no stale error",SC.map.pl.version===4&&SC.map.pl.pub.tiers[0].month===90&&/^version: 4$/m.test(code())&&/Valid/.test(pill()),pill()+" "+SC.map.pl.version);
 // layout, css and hygiene
 {const css=d.querySelector("style").textContent;
  ok("yaml: editor css (gutter, monospace, no wrap) and a 600px rule that stacks the panes",/\.kta\{[^}]*white-space:pre/.test(css)&&/\.kgut\{[^}]*font:12px\/18px var\(--font-mono\)/.test(css)&&/@media \(max-width:600px\)\{\.kmain,\.kchg\{flex:1 1 100%/.test(css)&&/\.ktool\{[^}]*flex-wrap:wrap/.test(css));
  ok("yaml: no console.log in the page",!/console\.log/.test(__m[1]))}
}

// ---- History + CSV, and per-member admin actions in the ⋯ menu
{
 const T=win.__t,cap={};
 win.URL.createObjectURL=b=>{cap.blob=b;return "blob:test"};win.URL.revokeObjectURL=u=>{cap.revoked=u};
 win.HTMLAnchorElement.prototype.click=function(){cap.name=this.download;cap.href=this.href};
 const dl=async()=>{cap.blob=null;$("#kdl").click();const buf=new Uint8Array(await cap.blob.arrayBuffer());return{bytes:buf,text:new TextDecoder().decode(buf).replace(/^﻿/,""),name:cap.name}};
 const lines=x=>x.text.split("\r\n").filter(Boolean);
 const bill=(id)=>{sc(cur_sc);tab("mem");row(id).querySelector("[data-vm]").click();$("#vm [data-vtab=bill]").click()};
 let cur_sc="b4u";
 // pure member view
 bill("s_21");
 ok("hist: card is titled Invoices and payments",/Invoices and payments/.test(txt("#khist h4")),txt("#khist h4"));
 ok("hist: portal is the pure member view (no admin block, tags, toggle, buttons)",!$("#vm .mp-admin,#vm .mp-tag,#vm #vad,#vm [data-act]")&&!/Admin tools|Refund/.test(txt("#vm")),txt("#vm").slice(0,100));
 $("#vm [data-vtab=home]").click();
 ok("hist: home tab has no admin tools or switch-plan button",!$("#vm [data-act],#vm [data-vact=switch],#vm .mp-admin")&&!/Admin tools/.test(txt("#vm")));
 $("#vm [data-vtab=bill]").click();
 ok("hist: collapsed shows the latest 5 rows",$$("#khist tr.k-r").length===5,String($$("#khist tr.k-r").length));
 ok("hist: month-year group headings",$$("#khist tr.grp th").length>=1&&/20\d\d/.test(txt("#khist tr.grp th")),txt("#khist tr.grp th"));
 const newest=$$("#khist tr.k-r td.khd").map(x=>x.textContent);
 $("#vm [data-khx]").click();
 const nAll=$$("#khist tr.k-r").length;
 ok("hist: Show all history reveals older rows (12+ over two years)",nAll>=12&&/Show latest 5/.test(txt("#khist")),String(nAll));
 const sel=$("#khf");sel.value="last";sel.dispatchEvent(new win.Event("change",{bubbles:true}));
 const nLast=$$("#khist tr.k-r").length;
 ok("hist: filter Last year changes the row count and only shows that year",nLast>0&&nLast<nAll&&$$("#khist tr.k-r td.khd").every(x=>/2025$/.test(x.textContent)),nLast+"/"+nAll);
 ok("hist: statuses cover Paid, Refunded, Partly refunded, Failed, Open",(()=>{const s=T.SC.b4u,m=s.M.find(x=>x[0]==="s_21"),st=new Set(T.kHist(s,m).map(r=>r.st));return["Paid","Refunded","Partly refunded","Failed","Open"].every(x=>st.has(x))})());
 ok("hist: refunds are negative rows with status Refunded, newest first",(()=>{const s=T.SC.b4u,r=T.kHist(s,s.M.find(x=>x[0]==="s_21"));return r.some(x=>x.amt<0&&x.st==="Refunded")&&r.every((x,i)=>!i||r[i-1].d>=x.d)})());
 ok("hist: card has a Download CSV button with the tooltip",!!$("#kdl")&&/Download CSV/.test(txt("#kdl"))&&$("#kdl").title==="Download this history as CSV"&&!!$("#kdl svg"),$("#kdl")?.title);
 // kCsv format
 {const raw=T.kCsv([{d:"2026-01-02",m:"m_1",tx:'He said "hi", ok',amt:-12.5,cur:"USD",st:"Refunded",inv:"in_1",pay:"pay_1"},{d:"2026-01-03",m:"m_1",tx:"=HYPERLINK(\"x\")",amt:3,cur:"USD",st:"Paid",inv:"",pay:""},{d:"2026-01-04",m:"m_1",tx:"@sum\nline",amt:0.1,cur:"USD",st:"Paid"},{d:"2026-01-05",m:"m_1",tx:"-cmd",amt:5,cur:"USD",st:"Paid"},{d:"2026-01-06",m:"m_1",tx:"+1",amt:5,cur:"USD",st:"Paid"}]);
  ok("csv: BOM, CRLF line ends and the header",raw.charCodeAt(0)===0xFEFF&&raw.slice(1).startsWith("date,description,amount,currency,status,invoice_id,payment_id\r\n")&&!/[^\r]\n/.test(raw.replace(/"[^"]*"/g,"")),JSON.stringify(raw.slice(0,90)));
  ok("csv: RFC 4180 quoting and doubled quotes",raw.includes('"He said ""hi"", ok"'));
  ok("csv: signed two-decimal amounts, never apostrophe-guarded",raw.includes(',-12.50,USD,Refunded,in_1,pay_1')&&raw.includes(',0.10,')&&!raw.includes("'-12.50"));
  ok("csv: formula-injection guard on = + - @",raw.includes("\"'=HYPERLINK(\"\"x\"\")\"")&&raw.includes("\"'@sum\nline\"")&&raw.includes(",'-cmd,")&&raw.includes(",'+1,"),JSON.stringify(raw.slice(100,320)));
  ok("csv: no member column unless asked",!/member/.test(raw.split("\r\n")[0])&&/,member,/.test(T.kCsv([],{member:true})))}
 // real downloads and scope
 {const a=await dl();
  ok("csv dl: adult export is a real file with BOM bytes, CRLF and the family rows",a.bytes[0]===0xEF&&a.bytes[1]===0xBB&&a.bytes[2]===0xBF&&/^date,member,description,amount/.test(lines(a)[0])&&a.text.includes("\r\n")&&lines(a).length-1===nAllFor("s_21","family"),lines(a)[0]);
  function nAllFor(id,k){const s=T.SC.b4u,m=s.M.find(x=>x[0]===id);return T.kScope(s,m).filter(r=>T.kFilter([r],"last").length).length}
  ok("csv dl: file name is invoices-<member>-<from>-<to>.csv and the URL is revoked",/^invoices-s_21-2025-\d\d-\d\d-2025-\d\d-\d\d\.csv$/.test(a.name)&&cap.href==="blob:test",a.name);
  ok("csv dl: toast says how many rows",new RegExp(`Downloaded ${lines(a).length-1} rows`).test(txt("#ts")),txt("#ts"));
  const ids=new Set(lines(a).slice(1).map(l=>l.split(",")[1]));
  ok("csv dl: adult export has only own family ids and no other family",[...ids].sort().join(",")==="s_21,s_25,s_26"&&!/s_22|s_23|s_24|s_27|Omar|Pia|Raj|Marta/.test(a.text),[...ids].join(","));
  $("#khf").value="all";$("#khf").dispatchEvent(new win.Event("change",{bubbles:true}));
  const b=await dl();ok("csv dl: All exports every row",lines(b).length-1>lines(a).length-1,lines(b).length+"");
  $("#vm [data-vfam=s_25]").click();$("#vm [data-vtab=bill]").click();
  const tn=await dl(),tm=T.SC.b4u.M.find(x=>x[0]==="s_25"),own=new Set(T.kHist(T.SC.b4u,tm).map(r=>r.pay));
  ok("csv dl: teen export has only their own rows and no member column",!/member/.test(lines(tn)[0])&&lines(tn).length-1===T.kHist(T.SC.b4u,tm).length&&lines(tn).slice(1).every(l=>own.has(l.split(",").pop())),lines(tn)[0]);
  ok("hist: teen sees no family names in the card",!/Dana W\.|Lia W\./.test(txt("#khist")));
  $("#vm [data-vfam=s_26]").click();$("#vm [data-vtab=bill]").click();
  const ch=await dl();ok("csv dl: child export has only their own rows",lines(ch).length-1===T.kHist(T.SC.b4u,T.SC.b4u.M.find(x=>x[0]==="s_26")).length&&!/member/.test(lines(ch)[0]));
  $("#vm #vmx").click()}
 // portal for a member with no family
 bill("s_22");ok("hist: family-less member sees own rows only, no member column",!/Dana|Lia|Kai/.test(txt("#khist"))&&(await dl()).text.split("\r\n")[0].indexOf("member")<0);$("#vm #vmx").click();
 // download buttons on the admin side
 sc("b4u");tab("led");
 ok("admin csv: Ledger has Download CSV, enabled for a finance admin",!!$("#lcsv")&&/Download CSV/.test(txt("#lcsv"))&&!$("#lcsv").disabled);
 cap.blob=null;$("#lcsv").click();{const x=new TextDecoder("utf-8",{ignoreBOM:true}).decode(new Uint8Array(await cap.blob.arrayBuffer()));
  ok("admin csv: ledger export uses the same helper (BOM, CRLF, header + event columns) and the file name keeps the period",x.charCodeAt(0)===0xFEFF&&/^\uFEFFdate,member,description,amount,currency,status,invoice_id,payment_id,event,credits\r\n/.test(x)&&/^ledger-/.test(cap.name),cap.name)}
 tab("rep");cap.blob=null;$("#rdl").click();{const x=new TextDecoder("utf-8",{ignoreBOM:true}).decode(new Uint8Array(await cap.blob.arrayBuffer()));
  ok("admin csv: Reports download exports the income statement lines",/^\uFEFFline,amount,currency,period_from,period_to\r\nMemberships,/.test(x)&&/\r\nNet,/.test(x)&&/^income-statement-/.test(cap.name),JSON.stringify(x.slice(0,100)))}
 tab("mem");row("s_22").click();
 ok("admin csv: drawer has a Payments section with Download CSV",/Payments/.test(txt("#dr"))&&!!$("#dr [data-kx=csv]")&&!$("#dr [data-kx=csv]").disabled);
 cap.blob=null;$("#dr [data-kx=csv]").click();ok("admin csv: drawer export is the member's history only",(await cap.blob.text()).split("\r\n").length-2===T.kHist(T.SC.b4u,T.SC.b4u.M.find(x=>x[0]==="s_22")).length&&/^invoices-s_22-/.test(cap.name),cap.name);
 // finance gate
 const you=T.SC.b4u.R.find(r=>r.you);you.fin=false;
 tab("led");ok("gate: non-finance admin has Ledger CSV disabled with the title",$("#lcsv").disabled&&$("#lcsv").title==="Finance admins only",$("#lcsv").title);
 tab("mem");row("s_22").click();
 ok("gate: drawer Download CSV disabled with the title",$("#dr [data-kx=csv]").disabled&&$("#dr [data-kx=csv]").title==="Finance admins only");
 $("#dr [data-kmenu]").click();const mcsv=$("#kmm [data-kx=csv]");
 ok("gate: menu Download CSV disabled with the title, refund says owner role",mcsv.disabled&&mcsv.title==="Finance admins only"&&$("#kmm [data-act=refund]").disabled&&$("#kmm [data-act=refund]").title==="Owner role needed",mcsv.title);
 portal("s_22");$("#vm [data-vtab=bill]").click();
 ok("gate: portal preview by a non-finance admin cannot export",$("#kdl").disabled&&$("#kdl").title==="Finance admins only");$("#vm #vmx").click();
 tab("rep");ok("gate: donors CSV disabled for a non-finance admin",!$("#kdon")||$("#kdon").disabled);
 you.fin=true;tab("rep");ok("gate: donors CSV present and enabled with the grant",!!$("#kdon")&&!$("#kdon").disabled&&/Download CSV/.test(txt("#kdon")));
 // ⋯ menu on every Members row
 sc("vol");tab("mem");
 ok("menu: every Members row has a ⋯ button with aria-haspopup",$$("#mb tr.row").length>0&&$$("#mb tr.row").every(r=>{const b=r.querySelector("[data-kmenu]");return b&&b.getAttribute("aria-haspopup")==="menu"&&b.getAttribute("aria-expanded")==="false"}),String($$("#mb [data-kmenu]").length));
 ok("menu: eye button is still next to it",$$("#mb tr.row").filter(r=>r.dataset.id.startsWith("m_")).every(r=>!!r.querySelector("[data-vm]")));
 const items=()=>$$("#kmm [role=menuitem]"),labels=()=>items().map(b=>b.textContent.replace(/\s+/g," ").trim());
 row("m_012").querySelector("[data-kmenu]").click();
 ok("menu: opens a role=menu with the listed items for the owner",$("#kmm").classList.contains("on")&&$("#kmm").getAttribute("role")==="menu"&&["View as member","Send invoice…","Adjust sessions…","Refund a payment…","Release a booking…","Make admin","Download CSV"].every(l=>labels().includes(l)),labels().join("|"));
 ok("menu: groups are separated by rules",$$("#kmm hr").length>=3);
 ok("menu: owner sees every action enabled",items().filter(b=>/Cancel membership|Make admin|Send invoice|Adjust|Refund|Download|View as/.test(b.textContent)).every(b=>!b.disabled),items().filter(b=>b.disabled).map(b=>b.textContent+":"+b.title).join("|"));
 ok("menu: destructive item uses the danger style",!!$("#kmm button.d")&&/Cancel membership/.test($("#kmm button.d").textContent));
 $("#kmm [data-act=invoice]").click();ok("menu: Send invoice opens the invoice modal",$("#bg").classList.contains("on")&&/Send invoice/.test(txt("#md"))&&!$("#kmm").classList.contains("on"),txt("#md").slice(0,60));$("#mc").click();
 row("m_012").querySelector("[data-kmenu]").click();$("#kmm [data-act=adjust]").click();ok("menu: Adjust opens the adjust modal",/Adjust sessions/.test(txt("#md")));$("#mc").click();
 row("m_012").querySelector("[data-kmenu]").click();$("#kmm [data-act=refund]").click();ok("menu: Refund a payment opens the refund modal with the payment picker",/Refund a payment/.test(txt("#md"))&&!!$("#f_pay"),txt("#md").slice(0,60));$("#mc").click();
 row("m_012").querySelector("[data-kmenu]").click();$("#kmm [data-kx=release]").click();ok("menu: Release a booking opens a booking picker",/Release a booking/.test(txt("#md"))&&$$("#md [data-act=release]").length>=1,txt("#md").slice(0,80));$("#md [data-act=release]").click();
 ok("menu: picking a booking reaches the existing release flow",/Release|Sent|ships/.test(txt("#md")+txt("#ts"))||!$("#bg").classList.contains("on"));
 if($('#bg').classList.contains('on'))$('#mc')?.click()||$('#bg').click();
 row("m_012").querySelector("[data-kmenu]").click();$("#kmm [data-kx=csv]").click();ok("menu: Download CSV downloads that member's history",/^invoices-m_012-/.test(cap.name)&&/Downloaded \d+ rows/.test(txt("#ts")),cap.name);
 // keyboard + outside click
 const trig=row("m_204").querySelector("[data-kmenu]");trig.focus();
 trig.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));
 const first=items().find(b=>!b.disabled);
 ok("kbd: ArrowDown on the button opens the menu and focuses the first item",$("#kmm").classList.contains("on")&&d.activeElement===first&&trig.getAttribute("aria-expanded")==="true",d.activeElement?.textContent);
 d.activeElement.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));
 const enabled=items().filter(b=>!b.disabled);
 ok("kbd: ArrowDown moves to the next enabled item, ArrowUp wraps",d.activeElement===enabled[1]&&(d.activeElement.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true})),d.activeElement===enabled[0])&&(d.activeElement.dispatchEvent(new win.KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true})),d.activeElement===enabled[enabled.length-1]));
 d.activeElement.dispatchEvent(new win.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
 ok("kbd: Escape closes the menu and returns focus to the button",!$("#kmm").classList.contains("on")&&d.activeElement===trig&&trig.getAttribute("aria-expanded")==="false");
 trig.click();d.body.click();ok("menu: outside click closes it",!$("#kmm").classList.contains("on"));
 trig.click();trig.click();ok("menu: the button toggles it",!$("#kmm").classList.contains("on"));
 // owner-only and no-plan rows, drawer shares the menu
 openRow("m_093");$("#dr [data-kmenu]").click();ok("menu: drawer header menu is the same builder (same items as the row)",(()=>{const a=labels().join("|");$("#dr [data-kmenu]").click();row("m_093").querySelector("[data-kmenu]").click();return a===labels().join("|")&&/Grant finance/.test(a)})());
 row("u_kim").querySelector("[data-kmenu]").click();
 ok("menu: no-plan admin row has View as member disabled with a title and no money-action group",(()=>{const v=items().find(b=>/View as member/.test(b.textContent));return v.disabled&&/No plan/.test(v.title)&&!labels().some(l=>/Send invoice|Refund/.test(l))})(),labels().join("|"));
 // layout rules
 {const css=d.querySelector("style").textContent;
  ok("layout: the history table stacks at 520px and the menu becomes a bottom sheet at 600px",/@media \(max-width:520px\)\{[^@]*\.mpt\.k tr\.k-r\{display:grid/.test(css)&&/@media \(max-width:600px\)\{\.kmenu\{[^}]*bottom:0/.test(css))}
 sc("vol");
}
ok("no runtime errors",errs.length===0,errs.join(" | "));
console.log(fails.length?`\n${fails.length} FAILED`:"\nall passed");process.exit(fails.length?1:0);
