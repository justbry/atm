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
ok("no runtime errors",errs.length===0,errs.join(" | "));
console.log(fails.length?`\n${fails.length} FAILED`:"\nall passed");process.exit(fails.length?1:0);
