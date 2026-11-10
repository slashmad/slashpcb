// Writes THIRD-PARTY-NOTICES.md from what the packages actually bundle: Electron and the npm
// production dependencies of the renderer bundle.
//   node scripts/third-party-notices.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

// npm: production dependencies and their production dependency closure.
const npm = new Map();
const visit = (name) => {
  const e = lock.packages[`node_modules/${name}`];
  if (!e || npm.has(name) || e.dev) return;
  npm.set(name, e);
  for (const d of Object.keys(e.dependencies ?? {})) visit(d);
};
Object.keys(pkg.dependencies ?? {}).forEach(visit);

const lines = [
  "# Third-party notices",
  "",
  `SlashPCB ${pkg.version} is MIT-licensed (see LICENSE). Its installers and archives also contain the third-party`,
  "software below, each under its own licence. Electron and Chromium licence texts ship as `LICENSE.electron.txt` and",
  "`LICENSES.chromium.html` next to the executable.",
  "",
  "## Runtime",
  "",
  "| Component | Licence |",
  "|---|---|",
  `| Electron ${lock.packages["node_modules/electron"]?.version ?? ""} (incl. Chromium and Node.js) | MIT; Chromium: BSD-3-Clause and others (LICENSES.chromium.html) |`,
  "",
  "## JavaScript packages (renderer)",
  "",
  "| Package | Version | Licence |",
  "|---|---|---|",
  ...[...npm.entries()].sort().map(([n, e]) => `| ${n} | ${e.version} | ${e.license ?? "see package"} |`),
  "",
  "KiCad, Claude Code and Codex are not bundled: the app uses the user's own installations.",
  "",
];
writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
console.log(`THIRD-PARTY-NOTICES.md: ${npm.size} npm packages`);
