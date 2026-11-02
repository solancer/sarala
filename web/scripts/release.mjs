/** Bump the web version, commit it and tag it: `pnpm release:web 0.2.0`. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: pnpm release:web X.Y.Z");
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--", ":!web/CHANGELOG.md")) {
  console.error("Commit your changes first. Only web/CHANGELOG.md may have edits.");
  process.exit(1);
}
const changelog = new URL("../CHANGELOG.md", import.meta.url);
if (!readFileSync(changelog, "utf8").includes(`\n## ${version}\n`)) {
  console.error(`Add a "## ${version}" section to web/CHANGELOG.md first.`);
  process.exit(1);
}
const manifest = new URL("../package.json", import.meta.url);
writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/"version": "[^"]+"/, `"version": "${version}"`));
git("add", "web/package.json", "web/CHANGELOG.md");
git("commit", "-m", `Release web ${version}`);
git("tag", `web-v${version}`);
console.log(`Tagged web-v${version}. Publish it with:\n  git push origin HEAD web-v${version}`);
