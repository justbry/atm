// The mockup's Dashboard on b4u, headless (the smoke.mjs pattern), for test/golden/S1.json: every books level, each
// view, a few periods. Run from a directory with happy-dom installed: node s1-text.mjs <mockup.html> [preset]
import {Window} from "happy-dom";
import {readFileSync} from "node:fs";
const html=readFileSync(process.argv[2],"utf8"),m=html.match(/<script>([\s\S]*)<\/script>/);
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error(){}}});
win.document.write(html.replace(m[0],""));await win.happyDOM.waitUntilComplete();win.eval(m[1]);
const d=win.document,n=s=>(s||"").replace(/\s+/g," ").trim(),all=s=>[...d.querySelectorAll(s)],$=s=>d.querySelector(s);
const sc=id=>{$("#sw").click();$(`[data-sc=${id}]`).click()};
const dump=()=>({switcher:all("#dash [data-bv]").map(b=>b.dataset.bv+"="+n(b.textContent)+(b.classList.contains("on")?"*":"")),lock:all("#dash [data-blk]").map(b=>n(b.textContent)+"|"+b.title+"|"+b.getAttribute("aria-pressed")),note:n($("#dash .kbvnote")?.textContent),kt:all("#dash .kt .badge").map(b=>n(b.textContent)),periods:all("#dash .kmonths button").map(b=>(b.dataset.dpk??b.dataset.dm??b.dataset.dstep)+"="+n(b.textContent)+(b.classList.contains("on")?"*":"")+(b.classList.contains("kwait")?"~wait":"")+(b.classList.contains("kopen")?"~open":"")+(b.title?"|"+b.title:"")),keys:all("#dash .kopenkey").map(x=>n(x.textContent)),caption:all("#dash .kcaption").map(x=>n(x.textContent)),notes:all("#dash .note").map(x=>n(x.textContent)),wait:all("#dash .kwaitbox").map(x=>n(x.textContent)),klock:all("#dash .klock").map(x=>n(x.textContent)),cards:all("#dash .kcard").map(c=>[n(c.querySelector("small").textContent),n(c.querySelector("b").textContent),n(c.querySelector("i").textContent)].join(" | ")),boxes:all("#dash .kbox").map(b=>n(b.querySelector("h6")?.textContent)+" :: "+[...b.querySelectorAll(".krow")].map(r=>n(r.textContent)).join(" / ")+" :: "+[...b.querySelectorAll(".kdistline,.kwhy,.mut,.kempty")].map(r=>n(r.textContent)).join(" / ")),flags:all("#dash .kflag").map(f=>n(f.textContent))});
const out={};
sc("b4u");$(".tab[data-p=dash]").click();
out.initial=dump();
const preset=process.argv[3]||"monthly-members";
for(const lv of ["public","member","gov","fin","owner"]){
 $(`#dash [data-bv=${lv}]`).click();
 const ps=all("#dash .kmonths [data-dpk]").map(b=>b.dataset.dpk);
 $(`#dash [data-dsc=${preset}]`)?.click();
 for(const v of ["money","members","risk"]){$(`#dash [data-dv=${v}]`).click();
  if(ps.length)for(const k of ps){$(`#dash [data-dpk="${k}"]`).click();out[`${lv}.${v}.${k}`]=dump()}
  else for(const mo of ["5","8","10"]){$(`#dash .kmonths [data-dm="${mo}"]`)?.click();out[`${lv}.${v}.${mo}`]=dump()}}
 if($("#dash [data-blk]")){$("#dash [data-blk]").click();out[`${lv}.locked`]=dump();$("#dash [data-blk]").click()}
}
console.log(JSON.stringify(out,null,1));
