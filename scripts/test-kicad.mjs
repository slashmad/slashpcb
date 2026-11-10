// Bundles test/kicad.test.ts with esbuild and runs it with Node.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";

await build({ entryPoints: ["test/kicad.test.ts"], outfile: "out/test/kicad.test.js", bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "warning" });
const r = spawnSync(process.execPath, ["out/test/kicad.test.js"], { stdio: "inherit" });
process.exit(r.status ?? 1);
