/** Physics notation translated to ordinary TeX before KaTeX parses it.
 * Groups are scanned with balanced delimiters; no regex rewrites nested math.
 * Standard TeX and text arguments remain untouched unless a physics macro owns them.
 */
const aliases: Record<string, string> = {
  quantity: "qty", absolutevalue: "abs", evaluated: "eval", ev: "eval",
  commutator: "comm", anticommutator: "acomm", poissonbracket: "pb",
  vectorbold: "vb", vectorarrow: "va", vectorunit: "vu", dotproduct: "vdot",
  crossproduct: "cross", cp: "cross", gradient: "grad", divergence: "div", gradientnabla: "vnabla",
  differential: "dd", diffd: "dd", variation: "var", derivative: "dv",
  partialderivative: "pdv", pderivative: "pdv", functionalderivative: "fdv", fderivative: "fdv",
  innerproduct: "ip", braket: "ip", outerproduct: "op", dyad: "op", ketbra: "op",
  expectationvalue: "expval", matrixelement: "mel", matrixel: "mel",
  matrixquantity: "mqty", smallmatrixquantity: "smqty", matrixdeterminant: "mdet",
  identitymatrix: "imat", zeromatrix: "zmat", xmatrix: "xmat", diagonalmatrix: "dmat",
  antidiagonalmatrix: "admat", paulimatrix: "pmat", qqtext: "qq", qcomma: "qc", qcc: "qc",
  sine: "sin", cosine: "cos", tangent: "tan", cosecant: "csc", secant: "sec", cotangent: "cot",
  arcsine: "arcsin", arccosine: "arccos", arctangent: "arctan", arccosecant: "arccsc", arcsecant: "arcsec", arccotangent: "arccot",
  asine: "arcsin", acosine: "arccos", atangent: "arctan", acosecant: "arccsc", asecant: "arcsec", acotangent: "arccot",
  asin: "arcsin", acos: "arccos", atan: "arctan", acsc: "arccsc", asec: "arcsec", acot: "arccot",
  hypsine: "sinh", hypcosine: "cosh", hyptangent: "tanh", hypcosecant: "csch", hypsecant: "sech", hypcotangent: "coth",
  exponential: "exp", logarithm: "log", naturallogarithm: "ln", determinant: "det",
  trace: "tr", Trace: "Tr", real: "Re", imaginary: "Im", Probability: "Pr", Residue: "Res", residue: "Res",
  principalvalue: "pv", PV: "pv", divisionsymbol: "divsymbol",
};
const operators = new Set(["sin", "cos", "tan", "csc", "sec", "cot", "arcsin", "arccos", "arctan", "arccsc", "arcsec", "arccot", "sinh", "cosh", "tanh", "csch", "sech", "coth", "exp", "log", "ln", "det", "tr", "Tr", "rank", "erf", "Res", "Pr", "Re", "Im"]);
const quick = new Set(["if", "then", "else", "otherwise", "unless", "given", "using", "assume", "since", "let", "for", "all", "even", "odd", "integer", "and", "or", "as", "in"]);
const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]", "|": "|" };
const opaque = new Set(["text", "texttt", "textrm", "textsf", "textnormal", "textbf", "textit", "operatorname", "url", "href", "label", "ref", "eqref", "tag"]);

export function expandPhysics(source: string, depth = 0, extended = false): string {
  if (depth > 64 || source.length > 200000) throw new Error("Math expression is too complex.");
  let i = 0;
  const skip = () => { while (/\s/.test(source[i] ?? "") && i < source.length) i++; };
  const group = (open = "{", close = pairs[open]): string => {
    skip();
    if (source[i] !== open) throw new Error(`Expected '${open}' in physics expression.`);
    const start = ++i;
    let level = 1, braces = 0;
    while (i < source.length) {
      if (source[i] === "%") { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end + 1; continue; }
      if (source[i] === "\\") { i += 2; continue; }
      const ch = source[i++];
      if (open !== "{") {
        if (ch === "{") braces++;
        if (ch === "}") braces--;
        if (braces !== 0 || ch === "}") continue;
      }
      if ((ch === close || level > 1 && close !== pairs[open] && ch === pairs[open]) && --level === 0) return source.slice(start, i - 1);
      if (open !== close && ch === open) level++;
    }
    throw new Error(`Unclosed '${open}' in physics expression.`);
  };
  const arg = (): string => {
    skip();
    if (source[i] === "{") return group();
    if (i >= source.length) throw new Error("Missing physics argument.");
    if (source[i] === "\\") {
      const command = /^\\(?:[a-zA-Z]+|.)/.exec(source.slice(i))![0]; i += command.length; return command;
    }
    return source[i++];
  };
  const optional = () => { skip(); return source[i] === "[" ? group("[") : null; };
  const sub = (text: string) => expandPhysics(text, depth + 1, extended);
  const count = (text: string) => {
    if (!/^\d+$/.test(text.trim()) || Number(text) < 1 || Number(text) > 32) throw new Error("Matrix dimensions must be between 1 and 32.");
    return Number(text);
  };
  let out = "";
  while (i < source.length) {
    if (source[i] === "%") { const end = source.indexOf("\n", i); if (end < 0) { out += source.slice(i); break; } out += source.slice(i, end + 1); i = end + 1; continue; }
    const command = /^\\([a-zA-Z]+)/.exec(source.slice(i));
    if (!command) { const length = source[i] === "\\" ? 2 : 1; out += source.slice(i, i + length); i += length; continue; }
    i += command[0].length;
    const original = command[1], name = Object.hasOwn(aliases,original) ? aliases[original] : original;
    if (!extended && (operators.has(original) || ["div", "Re", "Im", "Pr"].includes(original))) { out += command[0]; continue; }
    if (opaque.has(name)) {
      out += command[0];
      const saved = i; skip();
      if (source[i] === "*") { out += "*"; i++; skip(); }
      if (source[i] === "{") { out += "{" + group() + "}"; if (name === "href") { skip(); if (source[i] === "{") out += "{" + group() + "}"; } }
      else i = saved;
      continue;
    }
    const owned = ["qty", "pqty", "bqty", "Bqty", "vqty", "abs", "norm", "order", "eval", "comm", "acomm", "pb", "vb", "va", "vu", "grad", "div", "curl", "laplacian", "dd", "var", "dv", "pdv", "fdv", "bra", "ket", "ip", "op", "expval", "mel", "mqty", "pmqty", "Pmqty", "bmqty", "vmqty", "smqty", "spmqty", "sPmqty", "sbmqty", "svmqty", "mdet", "smdet", "imat", "zmat", "xmat", "dmat", "admat", "pmat", "qq", "qc", "flatfrac", "pv"].includes(name);
    if (!owned && !operators.has(name) && !(name.startsWith("q") && quick.has(name.slice(1)))) {
      const symbols: Record<string, string> = { vdot: "\\boldsymbol{\\cdot}", cross: "\\boldsymbol{\\times}", vnabla: "\\nabla", divsymbol: "\\div" };
      out += Object.hasOwn(symbols,name) ? symbols[name] : command[0]; continue;
    }
    skip(); const star = source[i] === "*"; if (star) { i++; skip(); }
    const size = /^\\(big|Big|bigg|Bigg)(?![a-zA-Z])/.exec(source.slice(i));
    if (size && owned) { i += size[0].length; skip(); }
    const fence = (body: string, left: string, right: string) => star ? `${left}{${body}}${right}` : size ? `\\${size[1]}l${left}{${body}}\\${size[1]}r${right}` : `\\left${left}{${body}}\\right${right}`;
    if (operators.has(name)) {
      const power = optional();
      const op = `\\operatorname{${name}}`;
      out += op + (power == null ? "" : `^{${sub(power)}}`);
      skip(); if (source[i] === "(") out += fence(sub(group("(")), "(", ")");
    } else if (["qty", "pqty", "bqty", "Bqty", "vqty", "abs", "norm", "order", "eval", "pv"].includes(name)) {
      const fixed: Record<string, [string, string]> = { pqty: ["(", ")"], bqty: ["[", "]"], Bqty: ["\\{", "\\}"], vqty: ["|", "|"], abs: ["|", "|"], norm: ["\\lVert", "\\rVert"], order: ["(", ")"], eval: [".", "|"], pv: ["(", ")"] };
      const opening = source[i];
      const body = pairs[opening] ? group(opening, name === "eval" && opening !== "{" ? "|" : pairs[opening]) : arg();
      const [left, right] = name === "qty" ? [opening === "{" ? "\\{" : opening, opening === "{" ? "\\}" : pairs[opening]] : fixed[name];
      if (!left || !right) throw new Error("Quantity requires paired delimiters.");
      out += (name === "order" ? "\\mathcal{O}" : name === "pv" ? "\\operatorname{p.v.}" : "") + fence(sub(body), left, right);
    } else if (["comm", "acomm", "pb"].includes(name)) {
      const a = sub(arg()), b = sub(arg()); out += fence(`${a},${b}`, name === "comm" ? "[" : "\\{", name === "comm" ? "]" : "\\}");
    } else if (["vb", "va", "vu"].includes(name)) {
      const value = sub(arg()); const bold = `\\${star ? "boldsymbol" : "mathbf"}{${value}}`;
      out += name === "va" ? `\\vec{${bold}}` : name === "vu" ? `\\hat{${bold}}` : bold;
    } else if (["grad", "div", "curl", "laplacian"].includes(name)) {
      out += "\\nabla" + (name === "div" ? "\\cdot " : name === "curl" ? "\\times " : name === "laplacian" ? "^2 " : " ");
      if (source[i] === "(") out += fence(sub(group("(")), "(", ")");
    } else if (["dd", "var"].includes(name)) {
      const order = optional(); out += (name === "dd" ? "\\mathrm{d}" : "\\delta") + (order == null ? " " : `^{${sub(order)}}`);
      skip(); if (source[i] === "(") out += fence(sub(group("(")), "(", ")"); else if (i < source.length && !"}])_^&".includes(source[i])) out += `{${sub(arg())}}`;
    } else if (["dv", "pdv", "fdv"].includes(name)) {
      const order = optional(), args = [sub(arg())]; skip();
      while (source[i] === "{" && args.length < (name === "pdv" ? 8 : 2)) { args.push(sub(arg())); skip(); }
      const variables = args.length === 1 ? args : args.slice(1);
      const power = variables.length > 1 ? String(variables.length) : order;
      const op = name === "dv" ? "\\mathrm{d}" : name === "pdv" ? "\\partial" : "\\delta";
      const num = op + (power ? `^{${sub(power)}}` : "") + (args.length > 1 ? `{${args[0]}}` : "");
      const den = variables.map(v => `${op}{${v}}${variables.length === 1 && power ? `^{${sub(power)}}` : ""}`).join(" ");
      out += star ? `{${num}}/{${den}}` : `\\frac{${num}}{${den}}`;
      if (source[i] === "(") out += fence(sub(group("(")), "(", ")");
    } else if (["bra", "ket", "ip", "op", "expval", "mel"].includes(name)) {
      const a = sub(arg()); skip();
      if (name === "bra") out += fence(a, "\\langle", "|");
      if (name === "ket") out += fence(a, "|", "\\rangle");
      if (name === "ip" || name === "op") {
        const b = source[i] === "{" ? sub(arg()) : a;
        out += name === "ip" ? fence(`${a}\\vert ${b}`, "\\langle", "\\rangle") : fence(a, "|", "\\rangle") + fence(b, "\\langle", "|");
      }
      if (name === "expval") {
        const b = source[i] === "{" ? sub(arg()) : null;
        out += fence(b == null ? a : `${b}\\vert ${a}\\vert ${b}`, "\\langle", "\\rangle");
      }
      if (name === "mel") out += fence(`${a}\\vert ${sub(arg())}\\vert ${sub(arg())}`, "\\langle", "\\rangle");
    } else if (/^(?:s?[pPbv]?mqty|s?mdet)$/.test(name)) {
      const opening = source[i]; const body = sub(pairs[opening] ? group(opening) : arg());
      const matrix = `\\begin{${name.startsWith("s") ? "smallmatrix" : "matrix"}}${body}\\end{${name.startsWith("s") ? "smallmatrix" : "matrix"}}`;
      const type = name.replace(/^s/, "");
      const [left, right] = type === "mdet" || type === "vmqty" ? ["|", "|"] : type === "bmqty" ? ["[", "]"] : type === "Pmqty" ? ["\\lgroup", "\\rgroup"] : type === "pmqty" ? ["(", ")"] : opening === "(" ? ["(", ")"] : opening === "[" ? ["[", "]"] : opening === "|" ? ["|", "|"] : ["", ""];
      out += left ? fence(matrix, left, right) : matrix;
    } else if (["imat", "zmat", "xmat", "dmat", "admat", "pmat"].includes(name)) {
      let cells: string[][];
      if (name === "pmat") {
        const n = arg().trim(); const matrices: Record<string, string[][]> = { "0": [["1","0"],["0","1"]], "1": [["0","1"],["1","0"]], "2": [["0","-i"],["i","0"]], "3": [["1","0"],["0","-1"]], x: [["0","1"],["1","0"]], y: [["0","-i"],["i","0"]], z: [["1","0"],["0","-1"]] };
        if (!matrices[n]) throw new Error("Pauli matrix must be 0, 1, 2, 3, x, y, or z."); cells = matrices[n];
      } else if (name === "dmat" || name === "admat") {
        const body = arg(); let nesting = 0; const items: string[] = []; let start = 0;
        for (let j = 0; j <= body.length; j++) { if (body[j] === "\\") { j++; continue; } if (body[j] === "{") nesting++; if (body[j] === "}") nesting--; if (j === body.length || body[j] === "," && nesting === 0) { items.push(sub(body.slice(start,j))); start = j + 1; } }
        if (items.length > 32) throw new Error("Matrix dimensions must be between 1 and 32.");
        cells = items.map((_, r) => items.map((_, c) => c === (name === "admat" ? items.length - r - 1 : r) ? items[r] : (star ? "0" : "")));
      } else {
        const value = name === "xmat" ? sub(arg()) : "0";
        const rows = count(arg()); skip(); const cols = name !== "imat" && source[i] === "{" ? count(arg()) : rows;
        cells = Array.from({length:rows}, (_,r) => Array.from({length:cols}, (_,c) => name === "imat" ? r === c ? "1" : "0" : name === "xmat" && star ? `${value}_{${r+1}${c+1}}` : value));
      }
      out += `\\begin{matrix}${cells.map(row => row.join("&")).join("\\\\")}\\end{matrix}`;
    } else if (name === "flatfrac") out += `{${sub(arg())}}/{${sub(arg())}}`;
    else if (name === "qq" || name === "qc" || quick.has(name.slice(1))) {
      const text = name === "qq" ? arg() : name === "qc" ? "," : name.slice(1);
      out += `${star ? "" : "\\quad"}\\text{${text}}\\quad `;
    }
  }
  return out;
}
