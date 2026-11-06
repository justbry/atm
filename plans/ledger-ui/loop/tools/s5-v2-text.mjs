// The disclosure-v2 mockup's gating texts on Ledger, Reports and Promos, per audience (View as), headless.
// node s5-v2-text.mjs <mockup.html>
import {Window} from "happy-dom";
import {readFileSync} from "node:fs";
const html=readFileSync(process.argv[2],"utf8"),m=html.match(/<script>([\s\S]*)<\/script>/);
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error(){}}});
win.document.write(html.replace(m[0],""));await win.happyDOM.waitUntilComplete();
win.eval(m[1]+"\n;window.__t={setVa(v){va=v;render()},setPin(p){bkPin=p;render()},GR_PL}");
const d=win.document,n=s=>(s||"").replace(/\s+/g," ").trim(),all=s=>[...d.querySelectorAll(s)],$=s=>d.querySelector(s),T=win.__t;
const sc=id=>{$("#sw").click();$(`[data-sc=${id}]`).click()},tab=p=>$(`.tab[data-p=${p}]`).click();
const out={GR_PL:T.GR_PL};
for(const id of["b4u","vol"])for(const a of["public","member","governance","finance","owner","admin"]){sc(id);T.setVa(a);
 tab("led");out[`${id}.${a}.led`]={lock:$("#lblock").hidden?null:{code:$("#lblock .klock")?.dataset.lock,h4:n($("#lblock h4")?.textContent),sub:n($("#lblock .mut")?.textContent)}};
 tab("rep");out[`${id}.${a}.rep`]={block:$("#rblock").hidden?null:n($("#rblock").textContent),rdl:$("#rdl").title,stat:n($("#rstat").textContent),sparkHead:n($("#spark .sphead")?.textContent),sparkRows:all("#spark .krow").map(r=>n(r.textContent)),kpis:all("#kpis .stat").map(b=>`${b.dataset.k??b.dataset.dd}|${b.disabled}|${b.title}|${n(b.textContent)}`),stmt:all("#stmt tr").map(r=>n(r.textContent)),rulesNote:n($("#rules p")?.textContent),donorsHead:n($("#donors h5")?.textContent),donorsLock:$("#donors .klock")?{code:$("#donors .klock").dataset.lock,h4:n($("#donors .klock h4").textContent),sub:n($("#donors .klock .mut").textContent)}:null,donors:n($("#donors").textContent).slice(0,400)};
 tab("cod");out[`${id}.${a}.cod`]={note:n($("#codnote").textContent),newcode:`${$("#newcode").disabled}|${$("#newcode").title}`,rows:all("#cb tr").map(r=>({used:n(r.querySelector("[data-k=redemptions]")?.textContent),usedTitle:r.querySelector("[data-k=redemptions] [title]")?.getAttribute("title")??"",usedHid:r.querySelector("[data-k=redemptions] [data-hid]")?.dataset.hid??"",red:`${r.querySelector("[data-red]")?.disabled}|${r.querySelector("[data-red]")?.title}`,rev:`${r.querySelector("[data-rev]")?.disabled}|${r.querySelector("[data-rev]")?.title}`}))};
}
sc("b4u");T.setVa("governance");T.setPin(true);tab("rep");out["b4u.governance.pin.rep"]=n($("#rblock").textContent);tab("led");out["b4u.governance.pin.led"]=n($("#lblock").textContent);
console.log(JSON.stringify(out,null,1));
