// The mockup's Ledger, Reports and Promos, headless (the smoke.mjs pattern), for test/golden/S5.json.
// Run from a directory with happy-dom installed: node s5-text.mjs <mockup.html>
import {Window} from "happy-dom";
import {readFileSync} from "node:fs";
const html=readFileSync(process.argv[2],"utf8"),m=html.match(/<script>([\s\S]*)<\/script>/);
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error(){}}});
win.document.write(html.replace(m[0],""));await win.happyDOM.waitUntilComplete();
win.eval(m[1]+"\n;window.__t={SC,get P(){return P},setP(v){P=v;render()},setLv(l,lock){va={gov:'governance',fin:'finance'}[l]||l;bkPin=!!lock;render()},kCsv,mask,cname}");
const d=win.document,n=s=>(s||"").replace(/\s+/g," ").trim(),all=s=>[...d.querySelectorAll(s)],$=s=>d.querySelector(s),T=win.__t;
const sc=id=>{$("#sw").click();$(`[data-sc=${id}]`).click();if(id==="b4u")T.setP({from:"2026-11-01",to:"2026-11-30",k:"this"})},tab=p=>$(`.tab[data-p=${p}]`).click();
const cap={};win.URL.createObjectURL=b=>{cap.blob=b;return"blob:test"};win.URL.revokeObjectURL=()=>{};
win.HTMLAnchorElement.prototype.click=function(){cap.name=this.download};
const grab=async sel=>{cap.blob=null;$(sel).click();if(!cap.blob)return null;const raw=new TextDecoder("utf-8",{ignoreBOM:true}).decode(new Uint8Array(await cap.blob.arrayBuffer()));return{name:cap.name,raw,toast:n($("#ts").textContent)}};
const ledgerDump=()=>({block:n($("#lblock").hidden?"":$("#lblock").textContent),chips:all("#lchips .chip").map(c=>`${c.dataset.t??c.id}=${n(c.textContent)}${c.classList.contains("on")?"*":""}`),cf:n($("#cfchip").textContent),count:n($("#lcnt").textContent),csv:{disabled:$("#lcsv").disabled,title:$("#lcsv").title,text:n($("#lcsv").textContent)},head:all("#led thead th").map(x=>n(x.textContent)),empty:$("#lempty").hidden?null:n($("#lempty").textContent),
 rows:all("#lb tr").map(r=>r.classList.contains("day")?{day:all.call(null,"x")&&[...r.children].map(c=>n(c.textContent)),cls:r.className}:r.classList.contains("dt")?{dt:n(r.textContent),hidden:r.hidden}:{row:[...r.children].map(c=>n(c.textContent)),cls:r.className})});
const repDump=()=>({block:$("#rblock").hidden?"":n($("#rblock").textContent),hidden:["#rstat","#spark","#kpis","#rep .two2","#rdl"].map(q=>q+":"+$(q).hidden),rdl:{text:n($("#rdl").textContent),title:$("#rdl").title},stat:n($("#rstat").textContent),spark:{head:n($("#spark .sphead")?.textContent),ax:all("#spark .spax span").map(x=>n(x.textContent)),aria:$("#spark svg")?.getAttribute("aria-label"),titles:all("#spark svg title").map(x=>x.textContent),text:n($("#spark").textContent)},
 kpis:all("#kpis .stat").map(b=>({dd:b.dataset.dd,go:b.dataset.go,title:b.title,label:n(b.querySelector("small").textContent),value:n(b.querySelector("b").textContent),sub:n(b.querySelector("i")?.textContent)})),stmt:all("#stmt tr").map(r=>({dd:r.dataset.dd,cells:[...r.children].map(c=>n(c.textContent))})),rules:n($("#rules").textContent),rulesRows:all("#rules tr").map(r=>[...r.children].map(c=>n(c.textContent))),
 donors:{text:n($("#donors").textContent),head:n($("#donors h5")?.textContent),kdon:$("#kdon")?{dis:$("#kdon").disabled,title:$("#kdon").title,text:n($("#kdon").textContent)}:null,th:all("#donors th").map(x=>n(x.textContent)),rows:all("#donors tbody tr").map(r=>[...r.children].map(c=>n(c.textContent))),ps:all("#donors p").map(x=>n(x.textContent))}});
const codesDump=()=>({note:n($("#codnote").textContent),newcode:{dis:$("#newcode").disabled,title:$("#newcode").title,text:n($("#newcode").textContent)},head:all("#cod thead th").map(x=>n(x.textContent)),empty:$("#cempty").hidden?null:n($("#cempty").textContent),rows:all("#cb tr").map(r=>({cells:[...r.children].map(c=>n(c.textContent)),btns:[...r.querySelectorAll("button")].map(b=>`${Object.keys(b.dataset).join("+")}=${b.dataset.rev??b.dataset.red??b.dataset.dis??""}|${n(b.textContent)}|${b.getAttribute("aria-label")??""}|${b.title}`)}))});
const out={};
// Ledger, every school at the default period (Nov 2026)
for(const id of["vol","b4u","map","nw"]){sc(id);tab("led");out[`led.${id}`]=ledgerDump();
 for(const t of["payment","credit","booking","code","payout","admin"]){$(`#lchips [data-t=${t}]`).click();out[`led.${id}.${t}`]={count:n($("#lcnt").textContent),rows:all("#lb tr.row").length,days:all("#lb tr.day").map(r=>n(r.textContent)),empty:$("#lempty").hidden?null:n($("#lempty").textContent)}}
 $("#lchips [data-t='']").click()}
// Details row toggle
sc("vol");tab("led");$("#lb tr.row").click();out["led.vol.details"]=all("#lb tr.dt").filter(r=>!r.hidden).map(r=>n(r.textContent));
// Period: last month on vol and b4u
for(const id of["vol","b4u"]){sc(id);tab("led");T.setP({from:"2026-10-01",to:"2026-10-31",k:"last"});out[`led.${id}.oct`]=ledgerDump();T.setP({from:"2026-11-01",to:"2026-11-30",k:"this"})}
// CSV on b4u (finance admin) at Nov and Oct
sc("b4u");tab("led");out["csv.led.b4u.nov"]=await grab("#lcsv");T.setP({from:"2026-10-01",to:"2026-10-31",k:"last"});out["csv.led.b4u.oct"]=await grab("#lcsv");T.setP({from:"2026-11-01",to:"2026-11-30",k:"this"});
sc("vol");tab("led");out["csv.led.vol.nov"]=await grab("#lcsv");
// Reports
for(const id of["vol","b4u","map","nw"]){sc(id);tab("rep");out[`rep.${id}`]=repDump()}
sc("vol");tab("rep");T.setP({from:"2026-10-01",to:"2026-10-31",k:"last"});out["rep.vol.oct"]=repDump();T.setP({from:"2026-01-01",to:"2026-11-05",k:"ytd"});out["rep.vol.ytd"]=repDump();T.setP({from:"2026-11-01",to:"2026-11-30",k:"this"});
sc("b4u");tab("rep");out["csv.rep.b4u.nov"]=await grab("#rdl");out["csv.don.b4u"]=await grab("#kdon");
sc("vol");tab("rep");out["csv.rep.vol.nov"]=await grab("#rdl");out["csv.don.vol"]=await grab("#kdon");
// Drill-downs from Reports
for(const k of["income","refund","fees","payout"]){sc("vol");tab("rep");$(`#kpis [data-dd=${k}]`).click();out[`drill.${k}`]={tab:$(".tab[aria-selected=true]")?.dataset.p,cf:n($("#cfchip").textContent),count:n($("#lcnt").textContent),rows:all("#lb tr.row").map(r=>n(r.textContent))}}
sc("vol");tab("rep");$("#stmt [data-dd=gift]").click();out["drill.gift"]={cf:n($("#cfchip").textContent),count:n($("#lcnt").textContent)};$("#cfx").click();out["drill.clear"]={cf:n($("#cfchip").textContent),count:n($("#lcnt").textContent)};
// Reports per books level on b4u
for(const lv of["public","member","gov","fin","owner"]){sc("b4u");tab("rep");T.setLv(lv);out[`rep.b4u.${lv}`]={block:n($("#rblock").hidden?"":$("#rblock").textContent),donors:n($("#donors").textContent)};tab("led");out[`led.b4u.${lv}`]={block:n($("#lblock").hidden?"":$("#lblock").textContent)};tab("cod");out[`cod.b4u.${lv}`]=codesDump().note}
for(const lv of["gov","fin","owner"]){sc("b4u");T.setLv(lv,true);tab("rep");out[`rep.b4u.${lv}.locked`]={block:n($("#rblock").textContent),donors:n($("#donors").textContent)};tab("led");out[`led.b4u.${lv}.locked`]=n($("#lblock").textContent)}
// Promos
for(const id of["vol","b4u","map","nw"]){sc(id);tab("cod");out[`cod.${id}`]=codesDump();out[`badge.${id}`]=n($("#pbadge").hidden?"":$("#pbadge").textContent)}
sc("vol");tab("cod");$("#cb [data-rev=c_01]").click();out["cod.vol.reveal"]=codesDump().rows[0];$("#cb [data-rev=c_01]").click();out["cod.vol.hide"]=codesDump().rows[0];
$("#cb [data-red=c_01]").click();out["cod.vol.redemptions"]={tab:$(".tab[aria-selected=true]")?.dataset.p,period:n($("#pb").textContent),cf:n($("#cfchip").textContent),count:n($("#lcnt").textContent),rows:all("#lb tr.row").map(r=>n(r.textContent))};
sc("vol");tab("cod");$("#cb [data-dis=c_04]").click();out["cod.vol.disable"]={toast:n($("#ts").textContent),row:codesDump().rows[3],badge:n($("#pbadge").hidden?"":$("#pbadge").textContent)};
sc("vol");tab("cod");$("#newcode").click();out["cod.vol.new"]={md:n($("#md").textContent),fields:all("#md input,#md select,#md textarea").map(x=>`${x.id}:${x.type||x.tagName}=${x.value}`),options:all("#md select option").map(o=>n(o.textContent)),pv:n($("#pv").textContent),mo:{dis:$("#mo").disabled,text:n($("#mo").textContent)}};
$("#f_val").value="0";$("#f_val").dispatchEvent(new win.Event("input",{bubbles:true}));out["cod.vol.new.zero"]={pv:n($("#pv").textContent),dis:$("#mo").disabled};
$("#f_val").value="150";$("#f_val").dispatchEvent(new win.Event("input",{bubbles:true}));out["cod.vol.new.150"]={pv:n($("#pv").textContent),dis:$("#mo").disabled};
$("#f_type").value=$$o("#f_type option")[1];function $$o(s){return all(s).map(o=>o.value)}$("#f_type").dispatchEvent(new win.Event("change",{bubbles:true}));$("#f_val").value="50";$("#f_val").dispatchEvent(new win.Event("input",{bubbles:true}));out["cod.vol.new.dollar"]={pv:n($("#pv").textContent),dis:$("#mo").disabled};
$("#f_type").value=$$o("#f_type option")[2];$("#f_type").dispatchEvent(new win.Event("change",{bubbles:true}));$("#f_val").value="4";$("#f_val").dispatchEvent(new win.Event("input",{bubbles:true}));out["cod.vol.new.session"]={pv:n($("#pv").textContent),dis:$("#mo").disabled};
$("#f_type").value=$$o("#f_type option")[0];$("#f_type").dispatchEvent(new win.Event("change",{bubbles:true}));$("#f_val").value="10";$("#f_val").dispatchEvent(new win.Event("input",{bubbles:true}));
$("#f_note").value="Autumn offer";$("#f_note").dispatchEvent(new win.Event("input",{bubbles:true}));out["cod.vol.new.noted"]={dis:$("#mo").disabled};$("#mo").click();out["cod.vol.created"]={md:n($("#md").textContent),code:n($("#cd")?.textContent),rows:codesDump().rows.length,first:codesDump().rows[0]};
out["cod.vol.created.after"]=(()=>{$("#pdone")?.click();return{bg:$("#bg").classList.contains("on"),rows:codesDump().rows.length,first:codesDump().rows[0],badge:n($("#pbadge").hidden?"":$("#pbadge").textContent)}})();
console.log(JSON.stringify(out,null,1));
