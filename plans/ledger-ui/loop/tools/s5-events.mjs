// The mockup's events per school, with their index in SC.<school>.E (the fixture's event id is `<school>-e<index>`).
import {Window} from "happy-dom";
import {readFileSync} from "node:fs";
const html=readFileSync(process.argv[2],"utf8"),m=html.match(/<script>([\s\S]*)<\/script>/);
const win=new Window({url:"https://localhost/",console:{log(){},warn(){},info(){},debug(){},error(){}}});
win.document.write(html.replace(m[0],""));await win.happyDOM.waitUntilComplete();
win.eval(m[1]+"\n;window.__t={SC}");
const SC=win.__t.SC;
for(const id of["vol","b4u","map"])SC[id].E.forEach((e,i)=>console.log([id,i,e.d,e.ty,e.m,e.tx,e.cr,e.usd,e.src,e.k??"",e.bk??"",e.code??"",e.pid??"",e.disc??""].join(" | ")));
