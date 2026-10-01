// Builds dist/Slippi AI-win32-x64 with @electron/packager.
//
// The app ships the engine *recipe* (engine/, the pinned slippi-ai source,
// uv.exe and the lock file), not the 2.5 GB Python install itself: that is
// made on the player's PC by Setup -> Install.

import packager from "@electron/packager";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const IGNORE = [
  /^\/dist($|\/)/,
  /^\/runtime($|\/)/,     // the dev checkout's own Python
  /^\/models($|\/)/,      // dev downloads
  /^\/scratch($|\/)/,
  /^\/tools($|\/)/,
  /^\/vendor\/slippi-ai\/(\.git|notebooks|tests|docker|docs|skypilot)($|\/)/,
  /__pycache__/,
  /\.log$/,
];

const [out] = await packager({
  dir: ROOT,
  name: "Slippi AI",
  executableName: "Slippi AI",
  platform: "win32",
  arch: "x64",
  out: path.join(ROOT, "dist"),
  overwrite: true,
  appCopyright: "ZeroShot",
  ignore: (file) => IGNORE.some((re) => re.test(file.replace(/\\/g, "/"))),
});
console.log("built", out);
