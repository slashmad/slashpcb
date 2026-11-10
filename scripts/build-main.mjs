// Bundles the Electron main process, preload and the MCP stdio server with esbuild.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: true, logLevel: "info" };
await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.js", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/mcp/server.ts"], outfile: "dist/mcp/server.js" }),
]);
