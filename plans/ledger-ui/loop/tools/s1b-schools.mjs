// The mockup's own Dashboard data for the schools whose figures come from their events (Vibes of Light, Maple
// Pilates, Lotus Lane Yoga), headless (the smoke.mjs pattern), for gates/mockup-schools.json: kpiSeries(s) for 2026,
// the plan names, the income kinds, the donors (amount, date, fund; no names) and the daily gross (bkDays). The oracle
// builds those schools' KPI documents from it, as it builds B4 Uni's and Harbor Arts Academy's from the mart; `donors`
// holds the fixture gifts of those two (bkMakeDonors, times 20 at Harbor Arts Academy).
// Run from a directory with happy-dom installed: node s1b-schools.mjs <mockup.html> > packages/ledger-ui/gates/mockup-schools.json
import {Window} from "happy-dom";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const html=readFileSync(process.argv[2],"utf8"),m=html.match(/<script>([\s\S]*)<\/script>/);
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error(){}}});
win.document.write(html.replace(m[0],""));await win.happyDOM.waitUntilComplete();
win.eval(`${m[1]}\n;window.__x={SC,kpiSeries,bkDays,BK_SCALE,TODAY}`);
const {SC,kpiSeries,bkDays,BK_SCALE,TODAY}=win.__x;
const keys=["g","r","f","n","po","pm","np","cg","cc","ce","dn","dl","df","pc","rc"];
const schools={};
for(const id of ["vol","map","nw"]){const s=SC[id],d=kpiSeries(s);
 schools[id]={name:s.name,currency:s.cur,series:Object.fromEntries(keys.map(k=>[k,[...d[k]]])),tiers:Object.fromEntries(Object.entries(d.t).map(([k,a])=>[k,[...a]])),kinds:Object.fromEntries(Object.entries(d.kd).map(([k,a])=>[k,[...a]])),
  donors:(s.don||[]).map(x=>({amount:Math.round(x.amt*100),date:x.date,fund:x.fund})),
  days:[...Array(12).keys()].map(mi=>[...bkDays(s,d,mi).a])}}
const donorsOf=Object.fromEntries(["b4u","har"].map(id=>[id,(SC[id].don||[]).map(x=>({amount:Math.round(x.amt*100),date:x.date,fund:x.fund}))]));
const out={source:"plans/ledger-ui/loop/tools/s1b-schools.mjs on plans/ledger-ui/design/mockup.html (atm dev 742105b64, disclosure v2): the mockup's kpiSeries, plan names, income kinds, donors and bkDays for the schools without fixture data; money in minor units, counts as numbers, 12 months of 2026",
 mockupSha256:createHash("sha256").update(html).digest("hex"),today:TODAY,yearScale:{...BK_SCALE},schools,donors:donorsOf};
console.log(JSON.stringify(out,null,"\t"));
