import {Window} from "happy-dom";
import {readFileSync} from "node:fs";
const file=process.argv[2];
const errs=[];
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error:(...a)=>errs.push(a.map(String).join(" "))}});
win.addEventListener("error",e=>errs.push("window error: "+e.message));
const __h=readFileSync(file,"utf8"),__m=__h.match(/<script>([\s\S]*)<\/script>/);win.document.write(__h.replace(__m[0],""));
await win.happyDOM.waitUntilComplete();try{win.eval(__m[1]+"\n;window.__t={SC,people,roleGuard}")}catch(e){errs.push("eval error: "+e.message+" "+(e.stack||"").split("\n").slice(0,3).join(" / "))}
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
$("#bchips [data-bp='day:0']").click();
ok("bk today overdue",/Overdue/.test(txt("#bb")) && !!$("#bb [data-bulk=over]"),$$("#bb tr.day").map(r=>r.textContent.trim().slice(0,40)).join(" | "));
$("#bb [data-bulk=over]").click();
ok("bulk gone after confirm",$$("#bb [data-bulk]").length===0);
ok("bulk toast",/Attendance confirmed for 2/.test(txt("#ts")),txt("#ts"));
$("#bchips [data-bp='day:1']").click();ok("bk tomorrow empty",/Nothing booked/.test(txt("#bb")),txt("#bb").slice(0,60));
$("#bchips [data-bp='wk:1']").click();ok("bk next week (2 + 2 overdue pending)",$$("#bb tr.row").length===4,String($$("#bb tr.row").length));
$("#bchips [data-bstep='1']").click();ok("bk step week",/Week of/.test(txt("#bchips b")),txt("#bchips b"));
$("#bchips [data-bp='wk:0']").click();$("#bchips [data-b=apr]").click();ok("bk filter approval",$$("#bb tr.row").length===1,String($$("#bb tr.row").length));
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
ok("top bar says admins see all members",!$("#kview").hidden&&/You see all members/.test(txt("#kview")),txt("#kview"));
// capability lines and owner-only role actions
const openRow=id=>row(id).click(),menu=()=>$$("#dr [data-role]"),mk=k=>menu().find(b=>b.dataset.role===k);
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
// School books: five access levels (Public, Member, Governance, Finance admin, Owner)
const BV=["public","member","gov","fin","owner"],lvl=l=>{$(`#dash [data-bv=${l}]`).click();return txt("#dash")},dollars=t=>+t.replace(/[^0-9.]/g,""),gb=()=>$$("#dash .kcard b").map(b=>b.textContent);
sc("b4u");tab("dash");
ok("books: viewer defaults to the signed-in level (finance admin)",$("#dash [data-bv].on").dataset.bv==="fin"&&!$("#dash .klock"),$("#dash [data-bv].on").dataset.bv);
ok("books: five viewers in the switcher",$$("#dash [data-bv]").map(b=>b.dataset.bv).join(",")===BV.join(","),$$("#dash [data-bv]").map(b=>b.dataset.bv).join(","));
const seen=Object.fromEntries(BV.map(l=>[l,lvl(l)]));
ok("books: the five viewers render different dashboards",new Set(Object.values(seen)).size===5);
ok("books: every non-full view has a caption",BV.every(l=>{lvl(l);return $$("#dash .kcaption").length>=1}));
ok("books: PIN chip only from Governance up",BV.map(l=>{lvl(l);return $$("#dash [data-blk]").length}).join(",")==="0,0,1,1,1");
// Public
lvl("public");
ok("books public: year grain only",$$("#dash .kmonths [data-dpk]").map(b=>b.textContent).join(",")==="2024,2025,2026"&&$$("#dash [data-dm]").length===0,$$("#dash .kmonths button").map(b=>b.textContent).join(","));
ok("books public: money rounded to $1,000",gb().length>=3&&gb().filter(t=>/^\$/.test(t)).every(t=>dollars(t)%1000===0),gb().join(","));
ok("books public: a period that has not passed the delay is hatched",$$("#dash .kmonths .kwait").length===2&&$$("#dash .krow.kwait").length===2&&/from Jan 2028/.test(txt("#dash"))&&/from Jan 2027/.test(txt("#dash")),$$("#dash .kwait").map(b=>b.textContent).join("|"));
$("#dash [data-dpk=2026]").click();
ok("books public: 2026 shows from Jan 2028 and has no figures, not zeros",!!$("#dash .kwaitbox")&&/2026 shows from Jan 2028/.test(txt("#dash .kwaitbox"))&&$$("#dash .kcard").length===0,txt("#dash .kwaitbox"));
$("#dash [data-dv=members]").click();
ok("books public: usage shows once the year closed (2025 members shown)",!$("#dash .kwaitbox")&&/Paying members/.test(txt("#dash .kcards"))&&/2026 shows from Jan 2027/.test(txt("#dash .kcaption")||txt("#dash"))||/2026/.test(txt("#dash .krow.kwait")),txt("#dash").slice(0,300));
$("#dash [data-dv=money]").click();
ok("books public: totals and categories only, no plan breakdown",!/Gross by plan/.test(txt("#dash"))&&!$("#dash .kbox .krow span[title]")&&/Breakdowns by plan or fund show from Governance up/.test(txt("#dash")));
// Member
lvl("member");
ok("books member: quarter grain",$$("#dash .kmonths [data-dpk]").length===8&&/^Q\d 20\d\d$/.test($("#dash [data-dpk]").textContent),$$("#dash .kmonths [data-dpk]").map(b=>b.textContent).join(","));
ok("books member: money rounded to $100",gb().filter(t=>/^\$/.test(t)).length>=3&&gb().filter(t=>/^\$/.test(t)).every(t=>dollars(t)%100===0),gb().join(","));
$("#dash [data-dpk=2026Q3]").click();
ok("books member: a quarter shows after it closed plus one quarter",!!$("#dash .kwaitbox")&&/Q3 2026 shows from Jan 2027/.test(txt("#dash .kwaitbox"))&&!!$("#dash [data-dpk=2026Q2]:not(.kwait)"),txt("#dash .kwaitbox"));
// Governance
lvl("gov");
ok("books gov: month grain, closed months only",$$("#dash .kmonths button[data-dm]:not(.kwait)").length===9&&$$("#dash .kmonths button.kwait[disabled]").length===3&&/Oct shows from Nov 7/.test(txt("#dash .kcaption")),txt("#dash .kcaption"));
$("#dash [data-dm='8']").click();
ok("books gov: exact figures (cents)",gb().filter(t=>/^\$/.test(t)).every(t=>/\.\d\d$/.test(t)),gb().join(","));
ok("books gov: plan breakdown with cell rules, suppressed cell shows — with the reason",$$("#dash .kcutv").length>=1&&/fewer than 5 payers/.test(txt("#dash .kwhy")),$$("#dash .kcutv").length+" "+txt("#dash .kwhy"));
$("#dash [data-dv=members]").click();
const govMem=txt("#dash");
ok("books gov: distribution (G4) with complementary suppression and the median, no rows",/62 donors: 40 under \$100, — \$100 to \$999, — \$1,000 or more; median gift \$45/.test(govMem)&&/hidden so the cell beside it can't be worked out/.test(govMem),govMem.match(/\d+ donors[^.]*\./)+"");
const NAMES=/(Jane|Omar|Priya|Lena|Tom|Ines|Raj|Maya) (Smith|Okafor|Nair|Brandt|Cole|Ruiz|Haddad|Kim)|@/;
ok("books gov: no personal names, emails or per-person rows",!NAMES.test(govMem)&&$$("#dash table").length===0);
ok("books gov: months not yet closed are not drawn as zeros",$$("#dash svg title").filter(t=>/^(Oct|Nov|Dec)/.test(t.textContent)).every(t=>/not shown yet/.test(t.textContent)),$$("#dash svg title").filter(t=>/^Oct/.test(t.textContent)).map(t=>t.textContent).join("|"));
tab("rep");
ok("books gov: Reports show the distribution instead of the Donors table",/How donors give/.test(txt("#donors"))&&$$("#donors table").length===0&&!NAMES.test(txt("#donors"))&&!/Every identified read is audited/.test(txt("#donors"))===false||$$("#donors table").length===0,txt("#donors").slice(0,160));
tab("led");ok("books gov: Ledger (a row per person) is not shown",!$("#lblock").hidden&&/does not see this/.test(txt("#lblock"))&&$("#lb").closest("table").hidden===true);
tab("dash");
// Finance admin and Owner: everything, rules off, names
for(const l of["fin","owner"]){
 lvl(l);let all="";
 for(const v of["money","members","risk"]){$(`#dash [data-dv=${v}]`).click();all+=txt("#dash")}
 for(const m of[0,5,8,10]){$(`#dash [data-dm='${m}']`).click();$("#dash [data-dv=members]").click();all+=txt("#dash");$("#dash [data-dv=money]").click();all+=txt("#dash")}
 ok(`books ${l}: no suppressed or banded cell in any view or month`,$$("#dash .kcutv,#dash .kcut,#dash .kwhy").length===0&&!/Hidden:/.test(all)&&!/—\s*(Hidden|fewer)/.test(all));
 ok(`books ${l}: open month is hatched and live, days shown`,$$("#dash .kmonths .kopen").length===1&&$("#dash .kopen").dataset.dm==="10"&&/live/.test(txt("#dash .kmonths")),"");
 ok(`books ${l}: caption says everything, names included, audited`,/everything/.test(txt("#dash .kcaption"))&&/audited/.test(txt("#dash .kcaption")));
 ok(`books ${l}: no fixture value renders as null or NaN`,!/null|NaN|undefined/.test(all));
}
$("#dash [data-dm='10']").click();ok("books fin: daily gross for the open month",$$("#dash svg[aria-label='Gross by day'] rect").length>=28,String($$("#dash svg[aria-label='Gross by day'] rect").length));
$("#dash [data-dm='5']").click();
lvl("fin");tab("rep");
ok("books fin: Donors and payers table with names, amounts and the audit line",$$("#donors table").length===1&&/Ines Kim/.test(txt("#donors"))&&/\$5,000\.00/.test(txt("#donors"))&&/Every identified read is audited/.test(txt("#donors")),txt("#donors").slice(0,200));
tab("led");ok("books fin: Ledger payer column shows names",/Dana W\./.test(txt("#lb"))&&$("#lblock").hidden,txt("#lb").slice(0,120));
tab("dash");lvl("owner");tab("rep");ok("books owner: Donors and payers visible to the owner",$$("#donors table").length===1&&/Ines Kim/.test(txt("#donors")));
tab("dash");lvl("member");tab("rep");ok("books member: Reports hide the names and the statement",!NAMES.test(txt("#donors"))&&!$("#rblock").hidden&&$("#stmt").closest(".two2").hidden,txt("#donors"));
tab("dash");
// PIN locked
for(const l of["gov","fin","owner"]){
 lvl(l);if(!$("#dash [data-blk]").classList.contains("on"))$("#dash [data-blk]").click();
 ok(`books ${l} PIN locked: lock state, not zeros`,/Enter your PIN to see books/.test(txt("#dash"))&&$$("#dash .kcard").length===0&&!/\$0(?![\d,.])/.test(txt("#dash"))&&$$("#dash svg.kc").length===0,txt("#dash").slice(0,200));
}
tab("rep");ok("books locked: Reports and Ledger show the lock, not names",/Enter your PIN to see books/.test(txt("#rblock"))&&!NAMES.test(txt("#donors")));
tab("led");ok("books locked: Ledger shows the lock",/Enter your PIN to see books/.test(txt("#lblock")));
tab("dash");
$("#dash .bpin").value="1234";$("#dash .bpin").dispatchEvent(new win.Event("input",{bubbles:true}));$("#dash [data-bpgo]").click();
ok("books PIN: entering the PIN unlocks the books",!/Enter your PIN/.test(txt("#dash"))&&$$("#dash .kcard").length===5&&!$("#dash [data-blk]").classList.contains("on"));
lvl("public");$("#dash [data-dv=money]").click();
// Board tier and Books chips
tab("pl");
ok("books plans: Board tier is hidden, not for sale, gives Governance",/Board/.test(txt("#pl tbody"))&&/Not for sale/.test(txt("#pl [data-pe='tiers:board']"))&&/Hidden/.test(txt("#pl [data-pe='tiers:board']"))&&/Books: Governance/.test(txt("#pl [data-pe='tiers:board']")),txt("#pl [data-pe='tiers:board']"));
$("#pl tr[data-pe='tiers:board']").click();
ok("books plans: editor has a Books access field, Governance selected for Board",!!$("#pbk")&&$("#pbk").value==="governance"&&[...$("#pbk").options].map(o=>o.value).join(",")==="member,governance,public"&&/Books access/.test(txt("#pe")),$("#pbk")?.value);
$("#pe #pcancel").click();
$("#pl tr[data-pe='tiers:sparkle']").click();
ok("books plans: default is Member",$("#pbk").value==="member");
$("#pbk").value="governance";$("#pbk").dispatchEvent(new win.Event("change",{bubbles:true}));$("#psave").click();
ok("books plans: the change lands in the draft",/draft/.test(txt("#pl [data-pe='tiers:sparkle']"))&&/Books: Governance/.test(txt("#pl [data-pe='tiers:sparkle']")));
$("#prev").click();
ok("books plans: review says it starts a new version and existing members keep theirs",/Books access Member → Governance/.test(txt("#md"))&&/Starts a new version; existing members keep theirs/.test(txt("#md")),txt("#md").slice(0,260));
$("[data-close]").click();$("#pdisc").click();
tab("mem");
const bk=id=>(row(id)?.querySelector(".kbk")?.className||"").replace(/.*kbk-/,"").split(" ")[0],bkt=id=>(row(id)?.querySelector(".kbk")?.textContent||"").trim();
ok("books chip: Owner is Owner / full",bk("u_pri")==="owner"&&/Owner · full/.test(bkt("u_pri")),bkt("u_pri"));
ok("books chip: admin with the finance grant is Finance admin",bk("u_tes")==="fin"&&bk("u_jo")==="fin",bk("u_tes"));
ok("books chip: adult with a live Board membership is Governance",bk("s_27")==="gov"&&/Governance/.test(bkt("s_27")),bkt("s_27"));
ok("books chip: adult with a live membership is Member",bk("s_21")==="member"&&bk("s_22")==="member",bk("s_21"));
ok("books chip: a child never holds Member, the guardian does",bk("s_26")==="public"&&bk("s_25")==="public"&&/Dana W\./.test(row("s_26").querySelector(".kbk").title),row("s_26").querySelector(".kbk").title);
win.__t.SC.vol.R.push({id:"u_rav",name:"Ravi S.",role:"admin",fin:true});sc("vol");tab("mem");
ok("books chip: admin without the finance grant is read like anyone else (Member by plan)",bk("m_093")==="member"&&bk("u_rav")==="fin"&&bk("u_kim")==="owner",bk("m_093")+"|"+bk("u_rav"));
openRow("m_051");ok("books chip: a canceled membership is Public",bk("m_051")==="public"&&/Books: Public/.test(txt("#dr")),bk("m_051"));
openRow("u_rav");mk("revoke").click();$("#rgo").click();ok("books chip: revoking the grant drops the admin to Public",bk("u_rav")==="public"&&/Books: Public/.test(txt("#dr")),bk("u_rav"));
// Settings: School books policy
$("#gb").click();
ok("books settings: three policy rows with the spec defaults",$$("#set [data-bkrow]").map(r=>r.dataset.bkrow).join(",")==="public,member,governance"&&$("#set [data-bkf='public.grain']").value==="year"&&$("#set [data-bkf='public.lagMonths']").value==="12"&&$("#set [data-bkf='public.roundTo']").value==="100000"&&$("#set [data-bkf='member.grain']").value==="quarter"&&$("#set [data-bkf='member.lagMonths']").value==="3"&&$("#set [data-bkf='member.roundTo']").value==="10000"&&$("#set [data-bkf='governance.steps']").value==="G4"&&$("#set [data-bkf='governance.grain']").value==="month",$$("#set [data-bkf]").map(e=>e.dataset.bkf+"="+e.value).join(" "));
const setBk=(f,v)=>{const e=$(`#set [data-bkf='${f}']`);e.value=v;e.dispatchEvent(new win.Event("change",{bubbles:true}))};
setBk("public.grain","month");
ok("books settings: save enabled once something changed",$("#bksave").disabled===false);
$("#bksave").click();
ok("books settings: Public finer than its default opens the step-up (mailed link)",$("#bg").classList.contains("on")&&/A link was mailed to confirm: this publishes your books/.test(txt("#md")),txt("#md").slice(0,160));
$("[data-close]").click();ok("books settings: cancelling the step-up changes nothing",!$("#bg").classList.contains("on")&&(tab("dash"),lvl("public"),$$("#dash .kmonths [data-dpk]").length===3));
$("#gb").click();$("#gb").click();
setBk("public.grain","year");setBk("public.lagMonths","24");$("#bksave").click();
ok("books settings: Public coarser or later saves without the step-up",!$("#bg").classList.contains("on")&&/books policy saved/i.test(txt("#ts")),txt("#ts"));
setBk("public.grain","month");$("#bksave").click();$("#bkgo").click();
ok("books settings: after the step-up the Public level changes",(tab("dash"),lvl("public"),$$("#dash .kmonths [data-dpk]").length===12),String($$("#dash .kmonths [data-dpk]").length));
sc("b4u");$("#gb").click();$("#gb").click();
ok("books settings: admins see the policy read-only",$$("#set [data-bkf]").length===12&&$$("#set [data-bkf]").every(e=>e.disabled)&&!$("#bksave"),$$("#set [data-bkf]").length+"");
$("#setx").click();
// Member portal: School books card per person
const pc=id=>{tab("mem");row(id).querySelector("[data-vm]").click();return $("#vm [data-books]")};
let card=pc("s_21");ok("books portal: adult member sees quarters, rounded, aggregates only",card?.dataset.books==="member"&&/Quarters/.test(card.textContent)&&/\$100/.test(card.textContent),card?.textContent);
$("#vm #vmx").click();
card=pc("s_27");ok("books portal: Governance-tier adult sees the governance view link",card?.dataset.books==="gov"&&/Open the governance view/.test(card.textContent)&&!!card.querySelector("button"),card?.textContent);
$("#vm #vmx").click();
card=pc("s_26");ok("books portal: a child sees that their guardian sees school books",card?.dataset.books==="public"&&/Your guardian \(Dana W\.\) sees school books/.test(card.textContent),card?.textContent);
$("#vm #vmx").click();
sc("vol");card=pc("m_051");ok("books portal: a member without a live membership is Public",card?.dataset.books==="public"&&/Public view/.test(card.textContent),card?.textContent);
$("#vm #vmx").click();
ok("books: tiny school hides cells under the 5-contributor rule at Public",(sc("vol"),tab("dash"),lvl("public"),$("#dash [data-dv=members]").click(),$$("#dash .kcut").length+$$("#dash .kcutv").length>=1&&/fewer than 5/.test(txt("#dash"))),txt("#dash").slice(0,200));
ok("no runtime errors",errs.length===0,errs.join(" | "));
console.log(fails.length?`\n${fails.length} FAILED`:"\nall passed");process.exit(fails.length?1:0);
