// Starts the app with a clean environment.
// - ELECTRON_RUN_AS_NODE (set by VS Code for its children) would make Electron run as plain Node.
// - On Linux with Wayland we start natively on Wayland; SLASHPCB_DISPLAY=x11 forces XWayland/X11.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = ["."];
if (process.platform === "linux") {
  const want = env.SLASHPCB_DISPLAY || (env.WAYLAND_DISPLAY ? "wayland" : "x11");
  args.unshift(`--ozone-platform=${want}`);
}
args.push(...process.argv.slice(2));
const child = spawn(electron, args, { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
