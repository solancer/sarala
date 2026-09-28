export interface EquationPlan {
  source: string;
  tex: string;
  nextNumber: number;
  labels: Map<string, string>;
}

/** Split only outer rows; matrix/aligned subexpressions own their row breaks. */
function rows(source: string): string[] {
  const out: string[] = [];
  let braces = 0, environments = 0, start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "%") { const end = source.indexOf("\n", i); if (end < 0) break; i = end; continue; }
    if (source[i] === "\\") {
      const env = /^\\(begin|end)\{[^}]+\}/.exec(source.slice(i));
      if (env) { environments += env[1] === "begin" ? 1 : -1; i += env[0].length - 1; continue; }
      if (source[i + 1] === "\\" && braces === 0 && environments === 0) { out.push(source.slice(start,i)); start = i + 2; }
      i++; continue;
    }
    if (source[i] === "{") braces++;
    if (source[i] === "}") braces--;
  }
  out.push(source.slice(start));
  return out;
}

/** Remove labels without interpreting commands written in comments or text. */
function metadata(source: string, keepTag = true) {
  const labels: string[] = [];
  let tag: string | undefined, notag = false, body = "";
  for (let i = 0; i < source.length;) {
    if (source[i] === "%") { const end = source.indexOf("\n", i); if (end < 0) { body += source.slice(i); break; } body += source.slice(i,end + 1); i = end + 1; continue; }
    const command = /^\\(label|tag\*?|notag|nonumber|text[a-z]*|operatorname)(?![a-zA-Z])/.exec(source.slice(i));
    if (command) {
      let j = i + command[0].length;
      if (command[1] === "notag" || command[1] === "nonumber") { notag = true; i = j; continue; }
      while (/\s/.test(source[j] ?? "") && j < source.length) j++;
      if (source[j] === "{") {
        const start = ++j; let depth = 1;
        while (j < source.length && depth) { if (source[j] === "\\") { j += 2; continue; } if (source[j] === "{") depth++; if (source[j] === "}") depth--; j++; }
        if (depth === 0) {
          const value = source.slice(start,j - 1);
          if (command[1] === "label") labels.push(value);
          else { if (keepTag || !command[1].startsWith("tag")) body += source.slice(i,j); if (command[1].startsWith("tag")) tag = value; }
          i = j; continue;
        }
      }
    }
    const length = source[i] === "\\" && i + 1 < source.length ? 2 : 1;
    body += source.slice(i,i + length); i += length;
  }
  return { body, labels, tag, notag };
}

/** Number equation rows consistently for full-document and individual-block rendering. */
export function planEquation(source: string, startNumber: number, automatic: boolean): EquationPlan {
  const outer = /^\s*\\begin\{(align|alignat|gather|equation|multline)(\*?)\}([\s\S]*)\\end\{\1\2\}\s*$/.exec(source);
  const environment = outer?.[1], starred = outer?.[2] === "*";
  const numberedEnvironment = !!outer && !starred;
  const body = outer?.[3] ?? source;
  const rowBodies = environment === "align" || environment === "alignat" || environment === "gather" ? rows(body) : [body];
  let nextNumber = startNumber;
  const labels = new Map<string, string>();
  const texRows = rowBodies.map((raw, index) => {
    const row = metadata(raw);
    if (!raw.trim() && index === rowBodies.length - 1) return raw;
    const numbered = !row.notag && (row.tag != null || row.labels.length > 0 || !starred && (automatic || numberedEnvironment));
    const number = numbered ? row.tag ?? String(++nextNumber) : undefined;
    for (const name of row.labels) if (!labels.has(name)) labels.set(name, number ?? "??");
    let result = row.body;
    if (number != null && row.tag == null) result += `\\tag{${number}}`;
    // KaTeX's own implicit counter must not introduce numbering of its own.
    if (outer && !numbered) result += "\\notag";
    return result;
  });
  let tex: string;
  if (environment === "multline") {
    const row = metadata(texRows[0], false);
    tex = `\\begin{gathered}${row.body}\\end{gathered}${row.tag != null ? `\\tag{${row.tag}}` : ""}`;
  } else tex = outer ? `\\begin{${environment}${outer[2]}}${texRows.join("\\\\")}\\end{${environment}${outer[2]}}` : texRows[0];
  return { source, tex, nextNumber, labels };
}
