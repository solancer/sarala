import { build } from "esbuild";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import katex from "katex";
const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = root + "tests/.build/compatibility";
await build({ entryPoints:["markdown","livesource","physics","equations","emoji","emojicompletion","legacydiagrams","complexblocks","tabletools"].map(n=>root+`src/${n}.ts`), bundle:true,format:"esm",splitting:true,outdir });
const dom=new JSDOM("<!doctype html><body></body>",{url:"https://sarala.test"});
for(const name of ["window","document","Node","NodeFilter","HTMLElement","Text","DOMParser"]) globalThis[name]=name==="window"?dom.window:dom.window[name];
const md=await import(outdir+"/markdown.js");
const live=await import(outdir+"/livesource.js");
const physics=await import(outdir+"/physics.js");
const equations=await import(outdir+"/equations.js");
const emoji=await import(outdir+"/emoji.js");
const completion=await import(outdir+"/emojicompletion.js");
const legacy=await import(outdir+"/legacydiagrams.js");
const tables=await import(outdir+"/tabletools.js");
const complex=await import(outdir+"/complexblocks.js");
const host=html=>{const el=document.createElement("div");el.innerHTML=html;return el;};
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const equal=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
equal(tables.moveTablePart("| A | B |\n| --- | --- |\n| one | two | KEEP |", "column",0,1),null,"Ragged table moves cannot silently discard cells");
check(Object.keys(emoji.EMOJI).length>=3608,"Full bundled emoji catalog is present");
for(const [name,glyph] of Object.entries(emoji.EMOJI)) {
  equal(emoji.emojiFor(name),glyph,`Catalog alias ${name}`);
  check(emoji.emojiShortcode().exec(`:${name}:`)?.[1]===name,`Tokenizer accepts ${name}`);
}
for(const name of ["melting_face","pink_heart","orca","woman_astronaut","flag_for_india","thumbs_up_medium_skin_tone","1st_place_medal","ab_button_(blood_type)"]) {
  check(emoji.emojiFor(name),`Required alias ${name} exists`);
  check(host(md.renderMarkdown(`:${name}:`)).textContent.includes(emoji.emojiFor(name)),"Extended aliases render");
  equal(host(live.styleSource(`:${name}:`)).textContent,`:${name}:`,"Extended alias preserves source");
}
equal(emoji.emojiFor("constructor"),undefined,"Inherited properties are not emoji");
equal(emoji.emojiMatches("smile",0),[],"Completion limit zero is respected");
for(const text of ["Hello :woman_","(:ab_button_(blood_",":côte"]) check(completion.emojiTriggerAt(text,text.length),"Unicode and punctuation completion prefixes work");
for(const text of ["`literal :sm","```md\n:sm","- ```\n  :sm","    :sm","https://example.com",":smile:"]) equal(completion.emojiTriggerAt(text,text.length),null,"No completion in literal/code/URL contexts");

const formulas=[
  String.raw`\qty(1+\qty[\frac{x}{\qty{y}}])`,String.raw`\qty\Big(x+\qty(y))`,
  String.raw`\pqty*{x}+\bqty{x}+\Bqty{x}+\vqty{x}+\norm{\vb{x}}`,
  String.raw`\dv[2]{f}{x}+\dv{x}(x^2)+\dv*{f}{x}`,String.raw`\pdv[3]{f}{x}+\pdv{f}{x}{y}+\fdv{S}{\phi}`,
  String.raw`\dd[3]{x}+\var{F}+\grad(f)+\div\vb{v}+\curl\vb{v}+\laplacian f`,
  String.raw`\comm{A}{B}+\acomm*{A}{B}+\pb\Big{A}{B}`,
  String.raw`\bra{a}\ket{b}+\braket{a}{b}+\op{a}{b}+\mel{a}{H}{b}+\expval{H}{a}`,
  String.raw`\mqty(1&2\\3&4)+\bmqty{1&2\\3&4}+\vmqty{1&0\\0&1}`,
  String.raw`\smqty(a&b\\c&d)+\pmqty{\imat{3}}+\mqty{\zmat{2}{3}}`,
  String.raw`\mqty[\dmat{1,{x,y},3}]+\mqty[\admat*{1,2,3}]+\mqty[\pmat{2}]+\mqty{\xmat*{a}{2}{3}}`,
  String.raw`\eval(x^2|_0^1+\eval{x^2}_0^1+\order{x^2}+\flatfrac{a}{b}`,
  String.raw`\sin[2](x)+\arccosecant(x)+\tr A+\rank A+\Re(z)+\erf(x)`,
  String.raw`x\qq{where}\vb*{x}=0\qif x=1\qotherwise 0`,
  String.raw`\text{literal qty(x)}+\qty{\text{a) b}}`,
];
md.setPhysicsEnabled(true);
for(const formula of formulas) {
  const expanded=physics.expandPhysics(formula,0,true);
  katex.renderToString(expanded,{displayMode:true,throwOnError:true});checks++;
  const result=host(md.renderMarkdown(`$$${formula}$$`));
  check(result.querySelector(".katex")&&!result.querySelector(".math-error"),`Physics renders: ${formula}`);
}
md.setPhysicsEnabled(false);
equal(physics.expandPhysics(String.raw`a\div b+\Re z+\sin(x)`),String.raw`a\div b+\Re z+\sin(x)`,"Ordinary math operators are unchanged by default");
equal(physics.expandPhysics(String.raw`\\qty`),String.raw`\\qty`,"Escaped command is not rewritten");
assert.throws(()=>physics.expandPhysics(String.raw`\imat{999999}`));checks++;
assert.throws(()=>physics.expandPhysics(String.raw`\qty(unclosed`));checks++;

const align=String.raw`\begin{align}a&=b\label{a}\\c&=d\notag\\e&=f\label{b}\end{align}`;
const planned=equations.planEquation(align,0,true);
equal([...planned.labels],[['a','1'],['b','2']],"Aligned labels resolve to row numbers");
equal(planned.nextNumber,2,"Unnumbered rows do not consume a number");
katex.renderToString(planned.tex,{displayMode:true,throwOnError:true});checks++;
const nested=String.raw`\begin{align}A&=\begin{matrix}1&2\\3&4\end{matrix}\label{m}\\x&=2\label{x}\end{align}`;
equal([...equations.planEquation(nested,0,true).labels],[['m','1'],['x','2']],"Matrix row breaks do not become equation row breaks");
for(const tex of [String.raw`\begin{multline}a+b\\=c\label{long}\end{multline}`,String.raw`\begin{multline}a+b\\=c\tag{A}\end{multline}`,String.raw`\begin{gather}a=b\\c=d\end{gather}`,String.raw`\begin{equation*}x=y\end{equation*}`]) {katex.renderToString(equations.planEquation(tex,0,true).tex,{displayMode:true,throwOnError:true});checks++;}
const doc=`$$${align}$$\n\n$\\ref{b}$\n\n$$z=3\\label{z}$$`;
const blocks=md.splitBlocks(doc).map((text,id)=>({text,id}));md.setMarkdownDocumentProvider(()=>blocks);md.setMathAutoNumber(true);
const whole=host(md.renderMarkdown(doc));
const pieces=host(blocks.map(b=>md.renderMarkdown(b.text,String(b.id))).join(""));
check(!whole.querySelector(".math-error")&&!pieces.querySelector(".math-error"),"Multi-row equations work in document and block rendering");
equal([...whole.querySelectorAll('.tag')].map(n=>n.textContent),[...pieces.querySelectorAll('.tag')].map(n=>n.textContent),"Equation numbering matches editor and export");
check(pieces.querySelector('a[href="#eq-b"]'),"Equation references link to their labels");
md.setMarkdownDocumentProvider(()=>[]);md.setMathAutoNumber(false);

const {default:mermaid}=await import("mermaid");mermaid.initialize({startOnLoad:false,securityLevel:"strict"});
const sequence=legacy.parseLegacyDiagram('Title: Demo\nparticipant "Alice A" as Alice\nparticipant Bob\nAlice A->Bob: Solid\nBob-->Alice A: Dashed\nAlice A->>Bob: Open\nBob-->>Alice A: Dashed open\nNote over Alice A,Bob: Two\\nlines',"sequence");
check(sequence.source.includes('p0->>p1: Solid')&&sequence.source.includes('p0->p1: Open'),"Legacy arrowhead types stay distinct");
await mermaid.parse(sequence.source);checks++;
const flow=legacy.parseLegacyDiagram('st=>start: Start|past:>https://example.com[blank]\ne=>end: End|future\nop=>operation: Work|current\ncond=>condition: Ready?|approved\npara=>parallel: Tasks\nin=>input: Data\nout=>output: Result\nsub=>subroutine: Sub\nst->op(right)->cond\ncond(yes)->para\ncond(no)->sub->op\npara(path1, bottom)->in->out->e\npara(path2, top)->e',"flow");
await mermaid.parse(flow.source);checks++;
check(flow.source.startsWith("flowchart LR")&&flow.source.includes('classDef'),"Flow orientation and state styling survive");
equal(flow.links,[{id:'n0',url:'https://example.com/'}],"Flow link travels outside diagram grammar");
assert.throws(()=>legacy.parseLegacyDiagram('a=>start: A:>javascript:alert(1)\na->a','flow'));checks++;
assert.throws(()=>legacy.parseLegacyDiagram('a=>start: A\na->missing','flow'));checks++;
const svg=host('<svg><g id="flowchart-n0-0"><text>Start</text></g></svg>');legacy.applyLegacyLinks(svg,flow.links);
equal(svg.querySelector('a').getAttribute('href'),'https://example.com/',"Safe SVG link restored");
equal(svg.querySelector('a').getAttribute('rel'),'noopener noreferrer',"Diagram link isolates opened page");

for(const [text,kind] of [['$$x$$','Equation'],['```mermaid\ngraph TD; A-->B\n```','Diagram'],['[^n]: note','Footnote'],['<details>Text</details>','HTML'],['[toc]','Table of contents']]) equal(complex.complexBlockKind(text),kind,"Complex block uses stable preview editor");
for(const text of ['# Heading','A **bold** paragraph','- One\n- Two','```js\nx()\n```','<u>underline</u>']) equal(complex.complexBlockKind(text),null,"Ordinary block keeps inline editing");
console.log(`${checks} compatibility checks passed`);
