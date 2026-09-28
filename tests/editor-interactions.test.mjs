/** Component interactions in jsdom. Geometry is stubbed; this is not a native visual test. */
import assert from "node:assert/strict";
import { build, transform } from "esbuild";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const require=createRequire(import.meta.url);
const pluginRequire=createRequire(require.resolve("vite-plugin-solid"));
const babel=pluginRequire("@babel/core");const solidPreset=pluginRequire("babel-preset-solid");
const outfile=root+"tests/.build/editor-interactions.mjs";
const harness=`
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import Block from "./src/components/Block";
import TableReorder from "./src/components/TableReorder";
export function mountBlock(host, initial) {
 const [text,setText] = createSignal(initial), [active,setActive] = createSignal(false);
 let changes=0;
 const dispose=render(() => <Block id={90000} text={text()} active={active()} onActivate={() => setActive(true)} onChange={value=>{changes++;setText(value)}} onDeactivate={()=>setActive(false)} onNavigate={()=>{}} onMergePrev={()=>{}} onSplit={()=>{throw new Error("Unexpected split")}} onToggleTask={()=>{}} setHeading={()=>{}} />,host);
 return {text,setText,active,setActive,changes:()=>changes,dispose};
}
export function mountTable(host, initial) {
 const [text,setText]=createSignal(initial);let changes=0;
 const dispose=render(()=><TableReorder text={text()} onMove={value=>{changes++;setText(value)}} />,host);
 return {text,setText,changes:()=>changes,dispose};
}
`;
const compiled=await babel.transformAsync((await transform(harness,{loader:"tsx",jsx:"preserve"})).code,{presets:[[solidPreset,{generate:"dom",hydratable:false}]],babelrc:false,configFile:false});
await build({stdin:{contents:compiled.code,resolveDir:root,sourcefile:"editor-interactions-harness.js",loader:"js"},loader:{".png":"dataurl"},bundle:true,format:"esm",outfile,conditions:["browser","development"],external:["mermaid","@terrastruct/d2","shiki"],plugins:[{name:"solid",setup(b){b.onLoad({filter:/\.tsx$/},async args=>{const source=await readFile(args.path,"utf8");const plain=await transform(source,{loader:"tsx",jsx:"preserve"});const result=await babel.transformAsync(plain.code,{filename:args.path,presets:[[solidPreset,{generate:"dom",hydratable:false}]],babelrc:false,configFile:false});return {contents:result.code,loader:"js"};});b.onResolve({filter:/^editor-interactions-harness/},()=>null);}}],jsx:"automatic",jsxImportSource:"solid-js"});

const dom=new JSDOM("<!doctype html><body></body>",{url:"https://sarala.test",pretendToBeVisual:true});
for(const name of ["window","document","navigator","localStorage","HTMLElement","HTMLInputElement","Node","NodeFilter","Text","Element","MutationObserver","getComputedStyle"])
 Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
HTMLElement.prototype.scrollIntoView=function(){};
HTMLElement.prototype.setPointerCapture=function(){};
let frames=[],observers=[];
globalThis.requestAnimationFrame=fn=>(frames.push(fn),frames.length);
globalThis.cancelAnimationFrame=()=>{};
globalThis.ResizeObserver=class {constructor(fn){observers.push(fn)} observe(){} disconnect(){}};
const flush=async()=>{await Promise.resolve();for(let i=0;frames.length&&i<10;i++){const run=frames;frames=[];for(const fn of run)fn(0);await Promise.resolve()}};
const {mountBlock,mountTable}=await import("./.build/editor-interactions.mjs");
let count=0;const check=(value,message)=>{assert.ok(value,message);count++};
const host=document.createElement("div");host.className="page";document.body.append(host);
const block=mountBlock(host,"$$\nx^2\n$$");await flush();
block.setActive(true);await flush();
check(host.querySelector(".block-source-panel"),"equation gets floating source panel");
check(host.querySelector(".rendered .katex"),"preview remains rendered while active");
check(host.querySelector(".source").textContent===block.text(),"panel preserves exact source");
check(block.changes()===0,"activation does not mutate source");
const editor=host.querySelector(".source");
const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);
window.getSelection().removeAllRanges();window.getSelection().addRange(range);
editor.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));await flush();
check(block.text()==="$$\nx^2\n$$\n","Enter inserts a newline without splitting the equation");
block.setText("$$\nx^2\n$");await flush();
check(host.querySelector(".block-source-panel"),"transient delimiter edits keep panel open");
host.querySelector(".source").dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));await flush();
check(!block.active()&&!host.querySelector(".block-source-panel"),"Escape closes source panel");
block.dispose();host.remove();
const ordinary=document.createElement("div");document.body.append(ordinary);
const paragraph=mountBlock(ordinary,"A **bold** paragraph");paragraph.setActive(true);await flush();
check(!ordinary.querySelector(".block-source-panel"),"ordinary text keeps inline editing");
check(ordinary.querySelector(".source").textContent===paragraph.text(),"inline editing preserves source");
paragraph.dispose();ordinary.remove();
const tableHost=document.createElement("div");document.body.append(tableHost);
const table=mountTable(tableHost,"| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
const source=document.createElement("div");source.className="source";source.innerHTML='<div class="md-table">'+[0,1,2].map(()=>'<div class="md-trow"><span class="md-tcell">A</span><span class="md-tcell">B</span></div>').join("")+"</div>";tableHost.append(source);
const rect=(left,top,width=100,height=30)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON(){}});
tableHost.getBoundingClientRect=()=>rect(0,0);
[...source.querySelectorAll(".md-trow")].forEach((row,i)=>{row.getBoundingClientRect=()=>rect(20,40+i*30,200);[...row.children].forEach((cell,j)=>cell.getBoundingClientRect=()=>rect(20+j*100,40+i*30))});
await flush();
const first=tableHost.querySelector('[data-handle="column:0"]');check(first,"column handle exists");
for(const fn of observers)fn();await flush();
check(first===tableHost.querySelector('[data-handle="column:0"]'),"resize preserves handle identity and pointer capture");
first.dispatchEvent(new window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));await flush();
check(table.text().startsWith("| B | A |"),"keyboard reorder moves column content");
check(document.activeElement===tableHost.querySelector('[data-handle="column:1"]'),"keyboard focus follows moved column");
const pointer=(type,x)=>new window.MouseEvent(type,{bubbles:true,button:0,clientX:x});
const handle=tableHost.querySelector('[data-handle="column:1"]');
handle.dispatchEvent(pointer("pointerdown",170));handle.dispatchEvent(pointer("pointermove",70));handle.dispatchEvent(pointer("lostpointercapture",70));handle.dispatchEvent(pointer("pointerup",70));
check(table.changes()===1,"lost pointer capture cancels drag");
handle.dispatchEvent(pointer("pointerdown",170));handle.dispatchEvent(pointer("pointermove",70));table.setText(table.text()+"\n");handle.dispatchEvent(pointer("pointerup",70));
check(table.changes()===1,"stale drag cannot overwrite newer source");
table.dispose();tableHost.remove();dom.window.close();
console.log(`${count} editor interaction checks passed`);
