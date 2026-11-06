// The mockup's Dashboard on b4u, headless (the smoke.mjs pattern), for test/golden/S1.json. Run from a directory
// with happy-dom installed: node s1-text.mjs <mockup.html> [months, e.g. 5,0]
import {Window} from "happy-dom";
import {readFileSync} from "node:fs";
const html=readFileSync(process.argv[2],"utf8"),m=html.match(/<script>([\s\S]*)<\/script>/);
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error(){}}});
win.document.write(html.replace(m[0],""));await win.happyDOM.waitUntilComplete();win.eval(m[1]);
const d=win.document,n=s=>(s||"").replace(/\s+/g," ").trim(),all=s=>[...d.querySelectorAll(s)],$=s=>d.querySelector(s);
const sc=id=>{$("#sw").click();$(`[data-sc=${id}]`).click()};
const dump=()=>({kview:[n($("#kview")?.textContent),$("#kview")?.title,$("#kview")?.hidden],kt:all("#dash .kt .badge").map(b=>n(b.textContent)+" | "+(b.title||"")),seg:all("#dash [data-dv]").map(b=>n(b.textContent)+(b.classList.contains("on")?"*":"")),presets:all("#dash [data-dsc]").map(b=>b.dataset.dsc+"="+n(b.textContent)+(b.classList.contains("on")?"*":"")),months:all("#dash .kmonths button").map(b=>n(b.textContent)+(b.classList.contains("on")?"*":"")),note:all("#dash .note").map(x=>n(x.textContent)),cards:all("#dash .kcard").map(c=>({l:n(c.querySelector("small").textContent),v:n(c.querySelector("b").textContent),s:n(c.querySelector("i").textContent),t:c.className})),h6:all("#dash h6").map(h=>n(h.textContent)),krow:all("#dash .krow").map(r=>n(r.textContent)),flags:all("#dash .kflag").map(f=>n(f.textContent)),mut:all("#dash .mut").map(f=>n(f.textContent)),empty:all("#dash .kempty").map(f=>n(f.textContent))});
const out={};
sc("b4u");$(".tab[data-p=dash]").click();
for(const p of ["monthly-members","annual-prepay","disputes","heavy-refunds"]){
 $(`#dash [data-dsc=${p}]`).click();
 for(const v of ["money","members","risk"]){$(`#dash [data-dv=${v}]`).click();for(const mo of (process.argv[3]||"5").split(",")){$(`#dash .kmonths [data-dm="${mo}"]`).click();out[`${p}.${v}.${mo}`]=dump()}}
}
for(const id of ["nw","map","vol","b4u"]){sc(id);$(".tab[data-p=dash]").click();out[id]={...dump(),top:all(".stale, .note, .banner, [role=status]").map(x=>n(x.textContent)).filter(Boolean)}}
console.log(JSON.stringify(out,null,1));
