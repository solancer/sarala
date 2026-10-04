/**
 * Voice typing benchmark with real speech models (macOS: uses `say` voices).
 *
 *   node tests/voice-bench.mjs /path/model-a.gguf /path/model-b.gguf …
 *   (no arguments: the models downloaded by the app)
 *
 * 1. Builds a spoken test set with macOS voices: six English accents (US, UK,
 *    Australia, India, Ireland, South Africa), dictated commands, robustness
 *    cases (silence, noise, hum, loud, quiet, fast, slow, long, noisy, a long
 *    pause) and French for multilingual models.
 * 2. Runs every clip through the real engine pipeline for each model (the
 *    ignored Rust test `live_bench`: voice detection, trimming, model, final
 *    pass).
 * 3. Scores accuracy (word error rate), speed (real-time factor), robustness
 *    (silence and noise must produce no text) and commands: each command's
 *    real transcript goes through the app's own parser (src/voice/text.ts) to
 *    check the right thing would happen.
 *
 * Writes tests/.build/voice-bench/report.json. Needs CMake and a Rust build
 * (and, on a Mac with stale Command Line Tools, the CXXFLAGS workaround).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const out = path.join(here, ".build", "voice-bench");
const corpus = path.join(out, "corpus");
mkdirSync(corpus, { recursive: true });
if (process.platform !== "darwin") {
  console.log("skip: the spoken test set is generated with macOS `say` voices");
  process.exit(0);
}

/* ---------- the app's own command parser ---------- */
await build({ entryPoints: [path.join(root, "src/voice/text.ts")], bundle: true, format: "esm", platform: "node", outdir: out, logLevel: "error" });
const { voiceAction, applyVoiceCommands, fitDictation } = await import(path.join(out, "text.js"));

/* ---------- WAV ---------- */
const RATE = 16000;
function readWav(file) {
  const b = readFileSync(file);
  let p = 12;
  while (p < b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "data") {
      const s = new Float32Array(size / 2);
      for (let i = 0; i < s.length; i++) s[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
      return s;
    }
    p += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}
function writeWav(file, s) {
  const b = Buffer.alloc(44 + s.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + s.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(s.length * 2, 40);
  for (let i = 0; i < s.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s[i])) * 32767), 44 + i * 2);
  writeFileSync(file, b);
}
function speak(voice, text, rate = 175) {
  const aiff = path.join(out, "tmp.aiff");
  const wav = path.join(out, "tmp.wav");
  execFileSync("say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", aiff, wav]);
  return readWav(wav);
}
const silence = (sec) => new Float32Array(Math.round(sec * RATE));
const concat = (...parts) => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const noise = (sec, amp) => Float32Array.from({ length: Math.round(sec * RATE) }, () => rand() * amp);
const gain = (s, g) => s.map((x) => Math.max(-1, Math.min(1, x * g)));
const rms = (s) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);
const withNoise = (s, snrDb) => { const n = rms(s) / 10 ** (snrDb / 20); return s.map((x) => x + rand() * n * Math.sqrt(3)); };

/* ---------- the test set ---------- */
const SENTENCES = [
  "The quarterly report shows revenue grew steadily while costs stayed flat.",
  "Please review the draft and send your comments before Friday afternoon.",
  "Markdown makes it easy to write headings, lists and links without leaving the keyboard.",
];
const VOICES = [["Samantha", "US"], ["Daniel", "UK"], ["Karen", "Australia"], ["Rishi", "India"], ["Moira", "Ireland"], ["Tessa", "South Africa"]];
const clips = [];
const add = (id, category, samples, extra) => { writeWav(path.join(corpus, `${id}.wav`), samples); clips.push({ id, category, file: `${id}.wav`, ...extra }); };

for (const [voice, accent] of VOICES) {
  SENTENCES.forEach((text, k) => add(`acc_${voice}_${k}`, "accuracy", speak(voice, text), { ref: text, accent }));
}
const COMMANDS = [
  ["cmd_scratch", "Scratch that.", { action: "scratch" }],
  ["cmd_stop", "Stop listening.", { action: "stop" }],
  ["cmd_select", "Select that.", { action: "select" }],
  ["cmd_bold", "Bold that.", { action: "bold" }],
  ["cmd_italic", "Italicize that.", { action: "italic" }],
  ["cmd_make_bold", "Make that bold.", { action: "bold" }],
  ["cmd_make_italic", "Make that italic.", { action: "italic" }],
  ["cmd_make_heading", "Make that a heading.", { action: "heading" }],
  ["cmd_make_bullet", "Make that a bullet.", { action: "bullet" }],
  ["cmd_help", "What can I say?", { action: "help" }],
  ["cmd_bullets", "New bullet, buy milk. New bullet, call mom.", { lines: ["- Buy milk", "- Call mom"] }],
  ["cmd_task", "New task, finish the report.", { lines: ["- [ ] Finish the report"] }],
  ["cmd_heading", "New heading, project goals.", { lines: ["## Project goals"] }],
  ["cmd_paragraph", "First idea. New paragraph. Second idea.", { blocks: 2 }],
  ["cmd_newline", "Dear team, new line, thanks for the update.", { newline: true }],
  ["cmd_punct", "Hello comma world period", { punctuation: true, equals: "Hello, world." }],
  ["cmd_punct_q", "Is it ready question mark", { punctuation: true, endsWith: "?" }],
  ["cmd_prose", "We should add a new task to the board.", { plain: true }],
];
for (const [id, text, expect] of COMMANDS) {
  add(`${id}_Samantha`, "commands", speak("Samantha", text), { said: text, expect });
  add(`${id}_Rishi`, "commands", speak("Rishi", text), { said: text, expect });
}
const base = speak("Samantha", SENTENCES[0]);
add("rob_silence", "robustness", silence(3), { expectEmpty: true });
add("rob_noise", "robustness", noise(3, 0.05), { expectEmpty: true });
add("rob_hum", "robustness", Float32Array.from({ length: 3 * RATE }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 60 * i) / RATE)), { expectEmpty: true });
add("rob_short", "robustness", speak("Samantha", "Yes."), { ref: "Yes." });
add("rob_fast", "robustness", speak("Samantha", SENTENCES[0], 280), { ref: SENTENCES[0] });
add("rob_slow", "robustness", speak("Samantha", SENTENCES[0], 110), { ref: SENTENCES[0] });
add("rob_loud", "robustness", gain(base, 6), { ref: SENTENCES[0] });
add("rob_quiet", "robustness", gain(base, 0.05), { ref: SENTENCES[0] });
add("rob_noisy", "robustness", withNoise(base, 10), { ref: SENTENCES[0] });
add("rob_pause", "robustness", concat(speak("Samantha", "First part of the thought."), silence(3), speak("Samantha", "Second part arrives later.")), { ref: "First part of the thought. Second part arrives later." });
const LONG = [...SENTENCES, "Voice typing should keep up with a long dictation without losing words.", "Every sentence here is checked against what was actually said."];
add("rob_long", "robustness", concat(...LONG.flatMap((t) => [speak("Daniel", t), silence(0.6)])), { ref: LONG.join(" ") });
const FR = "Bonjour, je voudrais réserver une table pour deux personnes ce soir.";
add("fr_hint", "french", speak("Thomas", FR), { ref: FR, language: "fr" });
add("fr_auto", "french", speak("Thomas", FR), { ref: FR });
writeFileSync(path.join(corpus, "manifest.json"), JSON.stringify(clips, null, 1));
console.log(`test set: ${clips.length} clips in ${path.relative(root, corpus)}`);

/* ---------- scoring ---------- */
const words = (t) => t.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = words(ref);
  const h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  }
  return r.length ? d[r.length][h.length] / r.length : h.length ? 1 : 0;
}
const loose = (t) => t.replace(/[.,!?]+(?=\n|$)/g, "").replace(/[ \t]+/g, " ").trim().toLowerCase();
function commandOk(clip, text) {
  const e = clip.expect;
  if (e.action) return voiceAction(text) === e.action;
  if (voiceAction(text)) return false;
  const typed = fitDictation("", "", applyVoiceCommands(text, { punctuation: !!e.punctuation }));
  // Structure, not exact words: a homophone ("by milk") is a recognition
  // slip, which the accuracy score already counts.
  if (e.lines) {
    const got = typed.split("\n").filter((l) => l.trim());
    return got.length === e.lines.length && got.every((l, k) => l.startsWith(e.lines[k].match(/^(- \[ \] |- |## )/)[0]));
  }
  if (e.blocks) return typed.split(/\n{2,}/).filter((x) => x.trim()).length === e.blocks;
  if (e.newline) return /\S\n\S/.test(typed);
  if (e.equals) return loose(typed) === loose(e.equals);
  if (e.endsWith) return typed.trim().endsWith(e.endsWith);
  if (e.plain) return !/^\s*(-|#)/m.test(typed) && /new task/i.test(typed);
  return false;
}

/* ---------- models ---------- */
let models = process.argv.slice(2);
if (!models.length) {
  const dir = path.join(homedir(), "Library/Application Support/com.srinivasgowda.sarala/voice/models");
  models = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".gguf")).map((f) => path.join(dir, f)) : [];
}
if (!models.length) {
  console.log("no models: pass .gguf paths, or download one in the app");
  process.exit(0);
}

/** French is only expected from multilingual models. */
const multilingual = (name) => /whisper|canary|voxtral|qwen|nemotron/i.test(name);
const report = [];
for (const model of models) {
  const name = path.basename(model).replace(/\.gguf$/, "");
  process.stdout.write(`\n== ${name}: running ${clips.length} clips… `);
  const run = spawnSync("cargo", ["test", "--release", "--", "--ignored", "live_bench", "--nocapture"], {
    cwd: path.join(root, "src-tauri"),
    env: { ...process.env, VOICE_TEST_MODEL: model, VOICE_BENCH_DIR: corpus },
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  const rows = run.stdout.split("\n").filter((l) => l.startsWith("BENCH ")).map((l) => JSON.parse(l.slice(6)));
  const load = rows.find((r) => r.load_ms !== undefined)?.load_ms;
  const byId = new Map(rows.filter((r) => r.id).map((r) => [r.id, r]));
  if (!byId.size) {
    console.log("failed\n", run.stderr.split("\n").slice(-15).join("\n"));
    continue;
  }
  console.log(`done (model load ${load} ms)`);
  const res = clips.map((c) => {
    const r = byId.get(c.id) ?? { text: "", error: "missing", ms: 0, audio_ms: 1 };
    const row = { id: c.id, category: c.category, text: r.text, error: r.error, ms: r.ms, rtf: r.ms / Math.max(1, r.audio_ms) };
    if (c.ref) row.wer = wer(c.ref, r.text);
    if (c.expectEmpty) row.ok = !r.text.trim();
    if (c.expect) row.ok = commandOk(c, r.text);
    if (c.accent) row.accent = c.accent;
    return row;
  });
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const pct = (x) => (Number.isNaN(x) ? "  -  " : `${(x * 100).toFixed(1).padStart(5)}%`);
  const acc = res.filter((r) => r.category === "accuracy");
  console.log(`  accuracy  WER ${pct(avg(acc.map((r) => r.wer)))}  speed ${avg(res.filter((r) => r.wer !== undefined).map((r) => r.rtf)).toFixed(3)}× real time`);
  for (const [, accent] of VOICES) {
    console.log(`    ${accent.padEnd(13)} WER ${pct(avg(acc.filter((r) => r.accent === accent).map((r) => r.wer)))}`);
  }
  const cmds = res.filter((r) => r.category === "commands");
  console.log(`  commands  ${cmds.filter((r) => r.ok).length}/${cmds.length} understood`);
  for (const r of cmds.filter((x) => !x.ok)) console.log(`    MISS ${r.id.padEnd(26)} heard: ${JSON.stringify(r.text)}`);
  console.log("  robustness");
  if (!multilingual(name)) console.log("    n/a   French       (English-only model)");
  for (const r of res.filter((x) => x.category === "robustness" || (x.category === "french" && multilingual(name)))) {
    const verdict = r.ok !== undefined ? (r.ok ? "PASS" : "FAIL") : r.wer <= 0.2 ? "PASS" : r.wer <= 0.4 ? "WEAK" : "FAIL";
    const detail = r.ok !== undefined ? (r.text ? `heard ${JSON.stringify(r.text)}` : "no text") : `WER ${pct(r.wer)}`;
    console.log(`    ${verdict}  ${r.id.padEnd(12)} ${detail}${r.error ? `  error: ${r.error}` : ""}`);
  }
  report.push({ model: name, load_ms: load, results: res });
}
writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
console.log(`\nreport: ${path.relative(root, path.join(out, "report.json"))}`);
