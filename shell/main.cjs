// Slippi AI: a window over vladfi1/slippi-ai.
//
// The page never runs Python itself. Everything heavy is a child process:
//   - the engine install (uv makes a private Python and installs the pinned
//     libraries from engine/requirements.lock),
//   - playing (slippi-ai's scripts/eval_two.py),
//   - preparing replays (engine/prepare_data.py),
//   - training (engine/train_my_bot.py).
// Engine scripts report progress as "@@{json}" lines on stdout.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor", "slippi-ai");
const ENGINE = path.join(ROOT, "engine");
const UV = path.join(ROOT, "vendor", "uv", "uv.exe");

const DATA = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "SlippiAI");
// A development checkout keeps its own runtime next to the source.
const RUNTIME = fs.existsSync(path.join(ROOT, "runtime", "Scripts", "python.exe"))
  ? path.join(ROOT, "runtime")
  : path.join(DATA, "runtime");
const PYTHON = path.join(RUNTIME, "Scripts", "python.exe");
const MODELS = path.join(DATA, "models");
const BOTS = path.join(DATA, "bots");
const DATASETS = path.join(DATA, "datasets");
const SETTINGS = path.join(DATA, "settings.json");

const SLIPPI = path.join(process.env.APPDATA || "", "Slippi Launcher");
const NETPLAY = path.join(SLIPPI, "netplay");

for (const dir of [DATA, MODELS, BOTS, DATASETS]) fs.mkdirSync(dir, { recursive: true });

let win = null;
const jobs = {};   // name -> child process, one of each kind at a time

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- settings and Slippi detection ------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function loadSettings() { return readJson(SETTINGS, {}); }

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2));
  return next;
}

function detectSlippi() {
  const settings = loadSettings();
  const launcher = readJson(path.join(SLIPPI, "Settings"), {});
  const launcherSettings = launcher.settings ?? launcher;
  const user = readJson(path.join(NETPLAY, "User", "Slippi", "user.json"), {});

  let replays = null;
  try {
    const ini = fs.readFileSync(path.join(NETPLAY, "User", "Config", "Dolphin.ini"), "utf8");
    // The file can hold the key more than once; the last one wins.
    const all = [...ini.matchAll(/^SlippiReplayDir\s*=\s*(.+)$/gm)].map((m) => m[1].trim());
    replays = all.reverse().find((p) => fs.existsSync(p)) ?? null;
  } catch {}
  if (!replays) {
    const docs = path.join(app.getPath("documents"), "Slippi");
    if (fs.existsSync(docs)) replays = docs;
  }

  const dolphinDir = settings.dolphinDir ?? NETPLAY;
  return {
    dolphinDir: fs.existsSync(path.join(dolphinDir, "Slippi Dolphin.exe")) ? dolphinDir : null,
    iso: [settings.iso, launcherSettings.isoPath].find((p) => p && fs.existsSync(p)) ?? null,
    replays: settings.replays ?? replays,
    code: settings.code ?? user.connectCode ?? null,
  };
}

function engineReady() {
  return fs.existsSync(PYTHON) && fs.existsSync(path.join(RUNTIME, "phillip-engine.ok"));
}

// --- running Python ------------------------------------------------------------

function pythonEnv() {
  return {
    ...process.env,
    PYTHONPATH: VENDOR,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    TF_CPP_MIN_LOG_LEVEL: "2",
  };
}

// Runs a process, handing each output line to onLine and "@@" lines to onEvent.
function run(kind, exe, args, { onEvent, onLine, env, stdin = "pipe" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: ROOT, env: env ?? pythonEnv(), windowsHide: true, stdio: [stdin, "pipe", "pipe"],
    });
    jobs[kind] = child;
    const tail = [];
    // Output arrives in arbitrary chunks; hold back each stream's unfinished
    // last line until the rest of it arrives.
    const partial = { out: "", err: "" };
    const handleLines = (text) => {
      for (const line of text.split(/[\r\n]+/)) {
        if (!line.trim()) continue;
        if (line.startsWith("@@")) {
          try { onEvent?.(JSON.parse(line.slice(2))); } catch {}
          continue;
        }
        tail.push(line);
        if (tail.length > 60) tail.shift();
        onLine?.(line);
      }
    };
    const handle = (stream) => (buf) => {
      const text = partial[stream] + String(buf);
      const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
      partial[stream] = text.slice(cut + 1);
      if (cut >= 0) handleLines(text.slice(0, cut));
    };
    child.stdout.on("data", handle("out"));
    child.stderr.on("data", handle("err"));
    child.on("close", (code) => {
      handleLines(partial.out + "\n" + partial.err);
      if (jobs[kind] === child) delete jobs[kind];
      resolve({ code, tail });
    });
    child.on("error", (err) => { tail.push(String(err)); resolve({ code: -1, tail }); });
  });
}

function stopJob(kind, { sync = false } = {}) {
  const child = jobs[kind];
  if (!child) return false;
  // Kill the whole tree: training spawns data workers, play spawns Dolphin.
  // On quit this has to finish before we exit, so it runs synchronously.
  const args = ["/pid", String(child.pid), "/T", "/F"];
  if (sync) spawnSync("taskkill", args, { windowsHide: true });
  else spawn("taskkill", args, { windowsHide: true });
  return true;
}

// --- engine install ------------------------------------------------------------

// The Python the engine is built on, from python-build-standalone via uv.
const PYTHON_VERSION = "3.12.14";

async function installEngine() {
  // Keep everything inside our own folder: our own copy of Python (never one
  // already on the PC, which the player might remove), and a download cache
  // we delete afterwards so the libraries aren't stored twice.
  const pythonDir = path.join(DATA, "python");
  const basePython = path.join(pythonDir, `cpython-${PYTHON_VERSION}-windows-x86_64-none`, "python.exe");
  const cache = path.join(DATA, "uv-cache");
  const env = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: pythonDir,
    UV_CACHE_DIR: cache,
    UV_LINK_MODE: "copy",
    UV_NO_CONFIG: "1",
  };
  const steps = [
    // On some PCs uv unpacks Python fine but then fails to make its
    // "cpython-3.12" shortcut link next to it. We don't need the link, so a
    // failure here only counts if python.exe itself is missing.
    ["Getting Python", ["python", "install", PYTHON_VERSION, "--no-bin", "--no-registry"],
      () => fs.existsSync(basePython)],
    ["Setting up Phillip's Python", ["venv", "--python", basePython, "--allow-existing", RUNTIME]],
    ["Installing Phillip's libraries (about 2.5 GB)",
      ["pip", "install", "--python", PYTHON, "-r", path.join(ENGINE, "requirements.lock")]],
  ];
  for (const [label, args, okAnyway] of steps) {
    send("engine", { label });
    const result = await run("engine", UV, args, {
      env, onLine: (line) => send("engine", { label, line }),
    });
    if (result.code !== 0 && !okAnyway?.()) {
      send("engine", { error: result.tail.slice(-8).join("\n") });
      return false;
    }
  }
  fs.rmSync(cache, { recursive: true, force: true });
  fs.writeFileSync(path.join(RUNTIME, "phillip-engine.ok"), new Date().toISOString());
  send("engine", { done: true });
  startServer(loadSettings().lastMode ?? "tf");
  return true;
}

// --- models ----------------------------------------------------------------------

const catalog = readJson(path.join(ROOT, "catalog", "models.json"), { models: [] });

function modelPath(name) { return path.join(MODELS, name); }

function modelInfo(file) { return readJson(file + ".json", null); }

function listCatalog() {
  return catalog.models.map((m) => {
    const file = modelPath(m.name);
    const have = fs.existsSync(file) && !fs.existsSync(file + ".part");
    return { ...m, downloaded: have, info: have ? modelInfo(file) : null };
  });
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "SlippiAI" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (HTTP ${res.statusCode}).`));
      }
      const total = Number(res.headers["content-length"] || 0);
      let done = 0, last = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (chunk) => {
        done += chunk.length;
        if (Date.now() - last > 200) { last = Date.now(); onProgress(done, total); }
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      res.on("error", reject);
      out.on("error", reject);
    }).on("error", reject);
  });
}

async function describeModel(file) {
  let info = null;
  const result = await run("describe", PYTHON, [path.join(ENGINE, "model_info.py"), file], {
    onEvent: (e) => { info = e; },
  });
  if (!info) throw new Error("Couldn't read the model:\n" + result.tail.slice(-5).join("\n"));
  return info;
}

async function downloadModel(name) {
  const entry = catalog.models.find((m) => m.name === name);
  if (!entry) throw new Error(`Unknown model ${name}`);
  const file = modelPath(name);
  if (fs.existsSync(file) && !fs.existsSync(file + ".part") && modelInfo(file)) return modelInfo(file);

  const url = catalog.urlTemplate.replace("{id}", entry.id).replace("{name}", encodeURIComponent(name));
  fs.writeFileSync(file + ".part", "");
  try {
    await download(url, file, (done, total) => send("download", { name, done, total }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  fs.rmSync(file + ".part", { force: true });
  send("download", { name, describing: true });
  const info = await describeModel(file);
  send("download", { name, finished: true });
  return info;
}

// --- my bots -----------------------------------------------------------------

function listBots() {
  return fs.readdirSync(BOTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(BOTS, d.name);
      const meta = readJson(path.join(dir, "bot.json"), {});
      const model = path.join(dir, "latest.pkl");
      return { id: d.name, dir, ...meta, ready: fs.existsSync(model), info: modelInfo(model) };
    });
}

// --- play ------------------------------------------------------------------------

// Phillip stays loaded in engine/play_server.py between games; see that file.
// "tf" mode can play every bot; "jax" mode only JAX bots, but starts much
// faster because it never loads TensorFlow. We start in the mode the selected
// bot needs and only restart when a TensorFlow bot comes up in a "jax" server.
let server = null;   // { child, mode, loaded, socket, pending }

function explainPlayFailure(message) {
  if (/failed to connect|connect to the console/i.test(message))
    return "Dolphin started but Phillip couldn't connect to it. Close every other Dolphin window and try again.";
  if (/\.(iso|gcm|ciso|rvz)\b/i.test(message) && /not found|No such file|FileNotFound/i.test(message))
    return "Phillip couldn't open your Melee ISO. Pick it again in Setup.";
  return message;
}

function onServerEvent(e) {
  switch (e.event) {
    case "loaded": if (server) connectServer(server, e.port); break;
    case "preparing": send("play", { state: "preparing", model: e.model }); break;
    case "ready": send("play", { state: "ready", model: e.model, profile: e.profile }); break;
    case "opening": send("play", { state: "opening" }); break;
    case "running": send("play", { state: "running" }); break;
    case "game": send("play", { state: "running", game: e.number }); break;
    case "slow": send("play", { warning: "Your PC is struggling to keep up with the bot." }); break;
    case "stopped": send("play", { state: "stopped", error: e.error ? explainPlayFailure(e.error) : null }); break;
    case "error": send("play", { state: "stopped", error: explainPlayFailure(e.message) }); break;
  }
}

function startServer(mode) {
  if (!engineReady()) return null;
  if (server && (server.mode === mode || server.mode === "tf")) return server;
  if (server) stopServer();

  const mine = { mode, loaded: false, child: null, socket: null, pending: [] };
  server = mine;
  run("server", PYTHON, [path.join(ENGINE, "play_server.py"), `--mode=${mode}`], {
    onEvent: onServerEvent,
    // The server takes commands over a socket; see engine/play_server.py.
    stdin: "ignore",
  }).then((result) => {
    if (server !== mine) return;   // replaced on purpose
    server = null;
    send("play", { state: "stopped", error: "Phillip stopped unexpectedly:\n" + result.tail.slice(-6).join("\n") });
  });
  mine.child = jobs.server;
  return mine;
}

function stopServer() {
  const old = server;
  server = null;
  if (old) stopJob("server");
}

// Commands sent before the server finishes loading wait in `pending`.
function connectServer(srv, port) {
  const socket = net.connect(port, "127.0.0.1", () => {
    srv.socket = socket;
    srv.loaded = true;
    for (const line of srv.pending.splice(0)) socket.write(line);
  });
  socket.on("error", () => {});
}

function tell(cmd) {
  if (!server?.child) throw new Error("Phillip isn't running. Check Setup.");
  const line = JSON.stringify(cmd) + "\n";
  if (server.socket) server.socket.write(line);
  else server.pending.push(line);
}

function modeFor(model) {
  return modelInfo(model)?.platform === "jax" ? "jax" : "tf";
}

// Builds the bot in the background as soon as it's picked.
function preparePlay({ model, profile, humanPort }) {
  if (!fs.existsSync(model)) return false;
  if (!startServer(modeFor(model))) return false;
  saveSettings({ lastMode: modeFor(model) });
  tell({ cmd: "prepare", model, profile, humanPort: humanPort === 2 ? 2 : 1 });
  return true;
}

function play({ model, profile, character, humanPort }) {
  const s = detectSlippi();
  if (!s.dolphinDir || !s.iso) throw new Error("Finish Setup first: Phillip needs Slippi Dolphin and your Melee ISO.");
  if (!startServer(modeFor(model))) throw new Error("Install the Phillip engine in Setup first.");
  send("play", { state: "starting", loaded: server.loaded });
  tell({
    cmd: "play", model, profile, character,
    humanPort: humanPort === 2 ? 2 : 1, dolphin: s.dolphinDir, iso: s.iso,
  });
}

// --- prepare + train ----------------------------------------------------------

function datasetDir(code) {
  return path.join(DATASETS, code.replace(/[^A-Za-z0-9]/g, "_"));
}

async function prepare({ replays, code }) {
  if (jobs.prepare) throw new Error("Already reading replays.");
  saveSettings({ replays, code });
  let summary = null;
  const result = await run("prepare", PYTHON, [
    path.join(ENGINE, "prepare_data.py"), `--replays=${replays}`, `--code=${code}`, `--work=${datasetDir(code)}`,
  ], {
    onEvent: (e) => {
      if (e.stage === "done") summary = e;
      send("prepare", e);
    },
  });
  if (!summary) throw new Error("Reading replays failed:\n" + result.tail.slice(-6).join("\n"));
  return summary;
}

function botId(name) {
  const base = (name || "my-bot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-bot";
  let id = base, n = 2;
  while (fs.existsSync(path.join(BOTS, id))) id = `${base}-${n++}`;
  return id;
}

async function train({ name, code, character, minutes }) {
  if (jobs.train) throw new Error("A bot is already training.");
  const base = catalog.models.find((m) => m.kind === "imitation" && m.character === character);
  if (!base) throw new Error(`There's no starting model for ${character} yet.`);

  send("train", { state: "downloading", base: base.name });
  await downloadModel(base.name);

  const id = botId(name);
  const out = path.join(BOTS, id);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "bot.json"), JSON.stringify({
    name: name || "My bot", code, character, base: base.name, startedAt: new Date().toISOString(), minutes,
  }, null, 2));

  send("train", { state: "starting", id });
  const started = Date.now();
  const result = await run("train", PYTHON, [
    path.join(ENGINE, "train_my_bot.py"),
    `--base=${modelPath(base.name)}`, `--data=${datasetDir(code)}`, `--code=${code}`,
    `--characters=${character}`, `--out=${out}`, `--minutes=${minutes}`,
  ], {
    onLine: (line) => {
      const loss = line.match(/losses: train=([\d.]+) test=([\d.]+)/);
      if (loss) send("train", {
        state: "training", id, train: Number(loss[1]), test: Number(loss[2]),
        elapsed: (Date.now() - started) / 1000, total: minutes * 60,
      });
      const best = line.match(/New best eval loss: ([\d.]+)/);
      if (best) send("train", { state: "training", id, saved: Number(best[1]) });
    },
  });

  const model = path.join(out, "latest.pkl");
  const meta = readJson(path.join(out, "bot.json"), {});
  // The starting copy of the base model is only needed during the run.
  fs.rmSync(path.join(out, "start.pkl"), { force: true });
  if (fs.existsSync(model)) {
    await describeModel(model).catch(() => null);
    meta.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, "bot.json"), JSON.stringify(meta, null, 2));
    send("train", { state: "done", id });
  } else {
    send("train", { state: "failed", id, error: result.tail.slice(-8).join("\n") });
  }
}

// --- IPC ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, arg) => {
    try { return { ok: true, value: await fn(arg) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  });
}

handle("status", () => ({
  slippi: detectSlippi(), engine: engineReady(), running: Object.keys(jobs), dataDir: DATA,
}));
handle("settings:set", (patch) => saveSettings(patch));
handle("pick:iso", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose your Melee 1.02 ISO",
    filters: [{ name: "Melee disc image", extensions: ["iso", "gcm", "ciso", "rvz"] }],
    properties: ["openFile"],
  });
  return r.canceled ? null : saveSettings({ iso: r.filePaths[0] }).iso;
});
handle("pick:dolphin", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Choose the folder with Slippi Dolphin.exe", properties: ["openDirectory"] });
  return r.canceled ? null : saveSettings({ dolphinDir: r.filePaths[0] }).dolphinDir;
});
handle("pick:replays", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Choose your Slippi replay folder", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
handle("engine:install", () => installEngine());
handle("catalog", () => listCatalog());
handle("model:download", (name) => downloadModel(name));
handle("model:delete", (name) => {
  for (const f of [modelPath(name), modelPath(name) + ".json", modelPath(name) + ".part"]) fs.rmSync(f, { force: true });
  return true;
});
handle("bots", () => listBots());
handle("bot:delete", (id) => {
  if (jobs.train) throw new Error("Stop training first.");
  fs.rmSync(path.join(BOTS, path.basename(id)), { recursive: true, force: true });
  return true;
});
handle("play:prepare", (opts) => preparePlay(opts));
handle("play", (opts) => play(opts));
handle("play:stop", () => { tell({ cmd: "stop" }); return true; });
handle("prepare", (opts) => prepare(opts));
handle("train", (opts) => { train(opts).catch((e) => send("train", { state: "failed", error: e.message })); return true; });
handle("train:stop", () => stopJob("train"));
handle("open", (target) => shell.openPath(target));

// --- window --------------------------------------------------------------------

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 860, minHeight: 600,
    backgroundColor: "#101114",
    title: "Slippi AI",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true },
  });
  win.loadFile(path.join(ROOT, "web", "index.html"));
  // Start loading Phillip right away, while the player looks around.
  startServer(loadSettings().lastMode ?? "tf");
});

app.on("window-all-closed", () => {
  for (const kind of Object.keys(jobs)) stopJob(kind, { sync: true });
  app.quit();
});
