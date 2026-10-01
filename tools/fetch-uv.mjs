// Downloads uv.exe (the engine installer) into vendor/uv before packaging.
// Pinned to the version the engine was tested with.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.12.21";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "vendor", "uv", "uv.exe");

if (fs.existsSync(DEST)) {
  const have = execFileSync(DEST, ["--version"], { encoding: "utf8" });
  if (have.includes(VERSION)) process.exit(0);
}

const url = `https://github.com/astral-sh/uv/releases/download/${VERSION}/uv-x86_64-pc-windows-msvc.zip`;
console.log(`fetching uv ${VERSION}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`uv download failed: HTTP ${res.status}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uv-"));
const zip = path.join(tmp, "uv.zip");
fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
// Windows' own bsdtar reads zip files.
execFileSync(path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", tmp]);
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(path.join(tmp, "uv.exe"), DEST);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(execFileSync(DEST, ["--version"], { encoding: "utf8" }).trim());
