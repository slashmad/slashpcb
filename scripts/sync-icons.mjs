// Renders every app icon from build/icon-source.png (the approved SlashPCB artwork) with ImageMagick:
// build/icon.png (1024), build/icons/<n>x<n>.png (Linux), build/icon.ico (Windows) and the window/top-bar
// icons in src/renderer/public/.   node scripts/sync-icons.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const src = "build/icon-source.png";
const magick = (...a) => execFileSync("magick", a, { stdio: "inherit" });
mkdirSync("build/icons", { recursive: true });
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  magick(src, "-background", "none", "-filter", "Lanczos", "-resize", `${s}x${s}`, "-gravity", "center", "-extent", `${s}x${s}`, `build/icons/${s}x${s}.png`);
}
copyFileSync("build/icons/1024x1024.png", "build/icon.png");
magick(...[16, 24, 32, 48, 64, 128, 256].map((s) => `build/icons/${s}x${s}.png`), "build/icon.ico");
copyFileSync("build/icons/64x64.png", "src/renderer/public/icon-64.png");
copyFileSync("build/icons/256x256.png", "src/renderer/public/icon-256.png");
console.log("icons written from", src);
