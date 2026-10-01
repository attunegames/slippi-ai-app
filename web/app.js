// Slippi AI page. All real work happens in shell/main.cjs; this file
// only keeps the screens in step with it.

const api = window.phillip;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function call(channel, arg) {
  const r = await api.call(channel, arg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

// libmelee character names -> what players call them.
const NAMES = {
  cptfalcon: "Falcon", dk: "DK", fox: "Fox", gameandwatch: "G&W", kirby: "Kirby",
  bowser: "Bowser", link: "Link", luigi: "Luigi", mario: "Mario", marth: "Marth",
  mewtwo: "Mewtwo", ness: "Ness", peach: "Peach", pikachu: "Pikachu", popo: "ICs",
  jigglypuff: "Puff", samus: "Samus", yoshi: "Yoshi", zelda: "Zelda", sheik: "Sheik",
  falco: "Falco", ylink: "Young Link", doc: "Doc", roy: "Roy", pichu: "Pichu", ganondorf: "Ganon",
};
const RANK_NAMES = { bronze: "Bronze", silver: "Silver", gold: "Gold", plat: "Platinum",
  diamond: "Diamond", master: "Master", gm: "Grandmaster", "super-gm": "Super GM" };
const charName = (c) => NAMES[c] ?? c;

// Rank-style names in every model; they aren't people, so they sort last.
const GENERIC = ["Master Player", "Diamond Player", "Platinum Player"];

const state = {
  status: null,
  catalog: [],
  bots: [],
  mode: "clone",
  botChar: null,
  youChar: "",
  rank: "master",
  rankChar: "fox",
  myBot: null,
  profile: null,
  humanPort: 1,
  downloading: null,
  playing: false,
  trainChar: null,
  minutes: 120,
  summary: null,
};

// The last picks on the Play screen, so the app reopens where it left off
// (and the engine preloads the bot you're likely to play).
const PICKS = ["mode", "botChar", "youChar", "rank", "rankChar", "myBot", "profile", "humanPort"];
function savePicks() {
  try { localStorage.setItem("picks", JSON.stringify(Object.fromEntries(PICKS.map((k) => [k, state[k]])))); } catch {}
}
function restorePicks() {
  try { Object.assign(state, JSON.parse(localStorage.getItem("picks") || "{}")); } catch {}
  $$("#playMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
  $$("#humanPort button").forEach((b) => b.classList.toggle("active", Number(b.dataset.port) === state.humanPort));
}

// --- tabs ---------------------------------------------------------------------

function showTab(name) {
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
}
$$("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

function segment(el, onPick) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    [...el.children].forEach((x) => x.classList.toggle("active", x === b));
    onPick(b.dataset);
  });
}

// --- setup ---------------------------------------------------------------------

async function refreshStatus() {
  state.status = await call("status");
  const { slippi, engine } = state.status;

  const setCheck = (id, ok, text) => {
    $(id).classList.toggle("ok", ok);
    $(`${id} .sub`).textContent = text;
  };
  setCheck("#chkDolphin", !!slippi.dolphinDir, slippi.dolphinDir ?? "Not found. Install the Slippi Launcher, or choose the folder.");
  setCheck("#chkIso", !!slippi.iso, slippi.iso ?? "Not found. Choose your Melee 1.02 (NTSC) ISO.");
  setCheck("#chkEngine", engine, engine ? "Installed." : "Not installed yet.");
  $("#installBtn").hidden = engine;

  const ready = slippi.dolphinDir && slippi.iso && engine;
  $("#setupDot").hidden = !!ready;

  if (!$("#replaysDir").value) $("#replaysDir").value = slippi.replays ?? "";
  if (!$("#code").value) $("#code").value = slippi.code ?? "";
  return ready;
}

$$("[data-pick]").forEach((b) => b.addEventListener("click", async () => {
  await call(`pick:${b.dataset.pick}`);
  refreshStatus();
}));

$("#installBtn").addEventListener("click", async () => {
  $("#installBtn").disabled = true;
  $("#engineLog").hidden = false;
  $("#engineLog").textContent = "";
  await call("engine:install");
});

api.on("engine", (e) => {
  const log = $("#engineLog");
  if (e.label && !e.line) log.textContent += `\n== ${e.label}\n`;
  if (e.line) log.textContent += e.line + "\n";
  if (e.error) {
    log.textContent += `\nInstall failed:\n${e.error}\n`;
    $("#installBtn").disabled = false;
  }
  if (e.done) {
    log.textContent += "\nDone.\n";
    refreshStatus().then(() => { setStatus("#playStatus", ""); renderMatch(); });
  }
  log.scrollTop = log.scrollHeight;
});

$("[data-ext]").addEventListener("click", (e) => {
  e.preventDefault();
  call("open", e.target.href);
});

// --- choosing a model ------------------------------------------------------------

function versionKey(m) {
  const [a, b] = m.version ?? [0, 0];
  return a * 1000 + b * 10 + (m.delay ?? 0) / 100;
}

// The model to load for "Phillip plays botChar against youChar".
function pickCloneModel(botChar, youChar) {
  const models = state.catalog;
  const newest = (list) => list.sort((a, b) => versionKey(b) - versionKey(a))[0];
  if (youChar) {
    const exact = newest(models.filter((m) => m.kind === "matchup" && m.character === botChar && m.opponent === youChar));
    if (exact) return exact;
  }
  const general = models.find((m) => m.name === "medium-v2" && m.characters.includes(botChar));
  if (general) return general;
  return newest(models.filter((m) => m.kind === "imitation" && m.character === botChar))
    ?? newest(models.filter((m) => m.character === botChar));
}

function pickRankModel(rank) {
  return state.catalog.find((m) => m.name === rank);
}

function currentChoice() {
  if (state.mode === "mine") {
    const bot = state.bots.find((b) => b.id === state.myBot && b.ready);
    if (!bot) return null;
    // A trained bot is meant to play as its owner, so their profile leads.
    const info = bot.info && { ...bot.info, trained_profiles: [bot.code] };
    return { bot, path: `${bot.dir}\\latest.pkl`, info, character: bot.character, label: bot.name };
  }
  const model = state.mode === "rank" ? pickRankModel(state.rank) : pickCloneModel(state.botChar, state.youChar);
  if (!model) return null;
  return {
    model,
    path: `${state.status.dataDir}\\models\\${model.name}`,
    info: model.info,
    character: state.mode === "rank" ? state.rankChar : state.botChar,
    label: model.name,
  };
}

function botCharacters() {
  const chars = new Set();
  for (const m of state.catalog) {
    if (m.character) chars.add(m.character);
    if (m.kind === "general") m.characters.forEach((c) => chars.add(c));
  }
  return [...chars].sort((a, b) => charName(a).localeCompare(charName(b)));
}

// Short list first: profiles the bot trained hardest, then players known by
// name (bare connect codes are anonymous ranked players), then rank styles.
const SHORT_LIST = 18;

function profileList(info) {
  if (!info) return [];
  const trained = info.trained_profiles.filter((n) => !GENERIC.includes(n));
  const rest = info.profiles.filter((n) => !trained.includes(n) && !GENERIC.includes(n));
  const named = rest.filter((n) => !n.includes("#"));
  const codes = rest.filter((n) => n.includes("#"));
  const generic = GENERIC.filter((n) => info.profiles.includes(n));
  return [
    ...trained.map((name) => ({ name, trained: true })),
    ...named.map((name) => ({ name })),
    ...generic.map((name) => ({ name, generic: true })),
    ...codes.map((name) => ({ name })),
  ];
}

// --- difficulty ----------------------------------------------------------------------

// Easiest to hardest. This is an estimate from how each bot was trained (vladfi
// publishes no strength numbers): imitation-only bots copy humans and skip
// self-play; self-played matchup bots are stronger, the newest (v6) most;
// rank bots are as strong as the rank they're named after.
const TIERS = ["Easy", "Medium", "Hard", "Expert", "Top"];
const RANK_TIER = { bronze: 0, silver: 0, gold: 1, plat: 1, diamond: 2, master: 3, gm: 4, "super-gm": 4 };

function tierOf(m) {
  if (!m) return null;
  if (m.kind === "rank") return RANK_TIER[m.rank] ?? 2;
  if (m.kind === "imitation") return 0;
  if (m.kind === "general") return 1;
  if (m.kind === "matchup") return (m.version?.[0] ?? 0) >= 6 ? 3 : 2;
  return null;
}

function tierBadge(tier) {
  return tier == null ? "" : `<span class="tier t${tier}">${TIERS[tier]}</span>`;
}

// --- play screen -------------------------------------------------------------------

function renderPlayPickers() {
  const chars = botCharacters();
  if (!state.botChar) state.botChar = chars.includes("fox") ? "fox" : chars[0];
  // Each character is tinted by the bot it would load against your character.
  $("#botChars").innerHTML = chars.map((c) => {
    const tier = tierOf(pickCloneModel(c, state.youChar));
    return `<button data-c="${c}" class="${c === state.botChar ? "active" : ""} ${tier == null ? "" : `tinted t${tier}`}">${charName(c)}</button>`;
  }).join("");

  const all = Object.keys(NAMES).sort((a, b) => charName(a).localeCompare(charName(b)));
  $("#youChar").innerHTML = `<option value="">Not sure / anyone</option>` +
    all.map((c) => `<option value="${c}" ${c === state.youChar ? "selected" : ""}>${charName(c)}</option>`).join("");
  $("#rankChar").innerHTML = all.map((c) =>
    `<option value="${c}" ${c === state.rankChar ? "selected" : ""}>${charName(c)}</option>`).join("");

  $("#ranks").innerHTML = Object.entries(RANK_NAMES)
    .filter(([r]) => state.catalog.some((m) => m.name === r))
    .map(([r, label]) => `<button data-r="${r}" class="${r === state.rank ? "active" : ""} tinted t${RANK_TIER[r]}">${label}</button>`).join("");

  const ready = state.bots.filter((b) => b.ready);
  $("#myBotsPick").innerHTML = ready.length
    ? ready.map((b) => `<div class="item pick ${b.id === state.myBot ? "active" : ""}" data-bot="${b.id}">
        <div class="grow"><b>${esc(b.name)}</b><span>${charName(b.character)} · plays like ${esc(b.code)}</span></div></div>`).join("")
    : `<div class="empty">No bots yet. Make one in "Train a bot".</div>`;
}

function renderMatch() {
  for (const m of ["clone", "rank", "mine"]) $(`#mode-${m}`).hidden = state.mode !== m;
  const choice = currentChoice();
  const card = $("#modelCard");

  if (!choice) {
    card.innerHTML = `<div class="what"><b>Pick a bot</b><span>Choose who Phillip should be.</span></div>`;
    $("#profiles").innerHTML = "";
    $("#profilesHint").textContent = "";
    $("#playBtn").disabled = true;
    return;
  }

  const ready = choice.bot ? true : choice.model.downloaded;
  if (!ready && !state.playing) {
    // Whatever was getting ready belongs to the previous pick.
    stopWaiting();
    setStatus("#playStatus", "");
  }
  const dl = state.downloading;
  if (choice.bot) {
    card.innerHTML = `<div class="what"><b>${esc(choice.label)}</b><span>Your bot · ${charName(choice.character)}</span></div>`;
  } else if (dl && dl.name === choice.model.name) {
    const pct = dl.total ? Math.round((dl.done / dl.total) * 100) : 0;
    card.innerHTML = `<div class="what"><b>${esc(choice.label)}</b><span>${dl.describing ? "Reading the model…" : `Downloading… ${pct}%`}</span>
      <div class="progress"><div style="width:${dl.describing ? 100 : pct}%"></div></div></div>`;
  } else {
    const what = describeModel(choice.model);
    card.innerHTML = `${tierBadge(tierOf(choice.model))}<div class="what"><b>${esc(choice.label)}</b><span>${what} · ${Math.round(choice.model.sizeMB)} MB</span></div>
      ${ready ? `<span class="status good">Ready</span>` : `<button id="dlBtn">Download</button>`}`;
    $("#dlBtn")?.addEventListener("click", () => downloadModel(choice.model.name));
  }

  const profiles = profileList(choice.info);
  if (!profiles.length) {
    state.profile = null;
    $("#profiles").innerHTML = "";
    $("#profilesHint").textContent = ready
      ? "This bot plays one style; there are no player profiles to pick."
      : "Download the bot to see which players it can play like.";
  } else {
    if (!profiles.some((p) => p.name === state.profile)) state.profile = profiles[0].name;
    const picked = profiles.findIndex((p) => p.name === state.profile);
    const shown = state.allProfiles ? profiles : profiles.slice(0, Math.max(SHORT_LIST, picked + 1));
    $("#profiles").innerHTML = shown.map((p) =>
      `<button data-p="${esc(p.name)}" class="${p.name === state.profile ? "active" : ""} ${p.generic ? "more" : ""}">${p.trained ? `<span class="star">★</span>` : ""}${esc(p.name)}</button>`).join("")
      + (shown.length < profiles.length ? `<button data-more class="more">Show all ${profiles.length}</button>` : "");
    $("#profilesHint").textContent = profiles.some((p) => p.trained)
      ? "★ = the players this bot was trained hardest to play like. The others come from the replays it learned from."
      : "Names are players whose replays this bot learned from.";
  }
  // Imitation-only bots copy a player's habits but skipped self-play
  // training, so they are far weaker than the player they're named after.
  if (choice.model?.kind === "imitation") {
    $("#profilesHint").textContent += ` This is an imitation-only bot: it copies the style but plays much weaker than the real player. For a strong ${charName(choice.character)}, use Rank bots (Master, GM or Super GM) and pick ${charName(choice.character)}.`;
  }

  $("#playBtn").disabled = !ready || state.playing || !state.status?.engine
    || !state.status?.slippi.dolphinDir || !state.status?.slippi.iso;
  $("#playBtn").textContent = state.playing ? "Playing…" : "Play";
  savePicks();
  preparePicked();
  if (!state.status?.engine) setStatus("#playStatus", "Install the Phillip engine in Setup first.", "warn");
}

function describeModel(m) {
  if (m.kind === "rank") return `Plays like a ${RANK_NAMES[m.rank] ?? m.rank} player`;
  if (m.kind === "general") return "General bot, any matchup";
  if (m.kind === "imitation") return `${charName(m.character)}, imitation only (weaker)`;
  if (m.kind === "matchup") return m.opponent === m.character
    ? `${charName(m.character)} ditto specialist` : `${charName(m.character)}, tuned vs ${charName(m.opponent)}`;
  return "Phillip bot";
}

$("#botChars").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.botChar = b.dataset.c; state.allProfiles = false; renderPlayPickers(); renderMatch();
});
$("#youChar").addEventListener("change", (e) => { state.youChar = e.target.value; renderPlayPickers(); renderMatch(); });
$("#rankChar").addEventListener("change", (e) => { state.rankChar = e.target.value; renderMatch(); });
$("#ranks").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.rank = b.dataset.r; renderPlayPickers(); renderMatch();
});
$("#myBotsPick").addEventListener("click", (e) => {
  const item = e.target.closest("[data-bot]"); if (!item) return;
  state.myBot = item.dataset.bot; renderPlayPickers(); renderMatch();
});
$("#profiles").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if ("more" in b.dataset) state.allProfiles = true;
  else state.profile = b.dataset.p;
  renderMatch();
});
segment($("#playMode"), (d) => { state.mode = d.mode; renderMatch(); });
segment($("#humanPort"), (d) => { state.humanPort = Number(d.port); preparePicked(); });

async function downloadModel(name) {
  state.downloading = { name, done: 0, total: 0 };
  renderMatch();
  try {
    await call("model:download", name);
  } catch (err) {
    setStatus("#playStatus", err.message, "error");
  }
  state.downloading = null;
  await loadCatalog();
  renderMatch();
}

api.on("download", (e) => {
  if (!state.downloading || state.downloading.name !== e.name) return;
  Object.assign(state.downloading, e);
  renderMatch();
});

// Phillip is built in the background as soon as a bot is picked, so Play
// only has to open Dolphin.
let prepareTimer = null;
let lastPrepared = "";
function preparePicked() {
  clearTimeout(prepareTimer);
  prepareTimer = setTimeout(() => {
    const choice = currentChoice();
    const ready = choice && (choice.bot || choice.model.downloaded);
    if (!ready || !state.status?.engine || state.playing) return;
    const key = `${choice.path}|${state.profile}|${state.humanPort}`;
    if (key === lastPrepared) return;
    lastPrepared = key;
    call("play:prepare", { model: choice.path, profile: state.profile, humanPort: state.humanPort });
  }, 400);
}

$("#playBtn").addEventListener("click", async () => {
  const choice = currentChoice();
  if (!choice) return;
  clearTimeout(prepareTimer);
  state.playing = true;
  renderMatch();
  startWaiting(state.phillipReady ? "Opening Dolphin" : "Loading Phillip");
  lastPrepared = `${choice.path}|${state.profile}|${state.humanPort}`;
  try {
    await call("play", {
      model: choice.path,
      profile: state.profile,
      character: choice.character,
      humanPort: state.humanPort,
    });
  } catch (err) {
    stopWaiting();
    state.playing = false;
    setStatus("#playStatus", err.message, "error");
    renderMatch();
  }
});

// Phillip takes a while to load (TensorFlow and JAX), so count the seconds
// to show the app hasn't frozen.
let waitTimer = null;
function startWaiting(what, note = "") {
  const started = Date.now();
  stopWaiting();
  const tick = () => setStatus("#playStatus",
    `${what}… ${Math.round((Date.now() - started) / 1000)}s${note ? `\n${note}` : ""}`);
  tick();
  waitTimer = setInterval(tick, 1000);
}
function stopWaiting() {
  clearInterval(waitTimer);
  waitTimer = null;
}

api.on("play", (e) => {
  // Background preparation of a bot that's no longer picked isn't news.
  const current = currentChoice()?.path;
  if ((e.state === "preparing" || e.state === "ready") && !state.playing && e.model && e.model !== current) return;
  if (e.state === "preparing") {
    state.phillipReady = false;
    startWaiting(state.playing ? "Loading Phillip" : "Getting Phillip ready");
  }
  if (e.state === "ready") {
    state.phillipReady = true;
    if (state.playing) startWaiting("Opening Dolphin");
    else { stopWaiting(); setStatus("#playStatus", "Phillip is ready.", "good"); }
  }
  if (e.state === "opening") startWaiting("Opening Dolphin");
  if (e.state === "running") {
    stopWaiting();
    setStatus("#playStatus", e.game ? `Game ${e.game} in progress.` : "Dolphin is open. Pick your character.", "good");
  }
  if (e.warning) setStatus("#playStatus", e.warning, "warn");
  if (e.state === "stopped") {
    stopWaiting();
    state.playing = false;
    if (e.error) lastPrepared = "";   // let the next pick retry
    setStatus("#playStatus", e.error ? e.error : "Session ended.", e.error ? "error" : "");
    renderMatch();
  }
});

// --- train screen ------------------------------------------------------------------

$("#pickReplays").addEventListener("click", async () => {
  const dir = await call("pick:replays");
  if (dir) $("#replaysDir").value = dir;
});

$("#prepareBtn").addEventListener("click", async () => {
  const replays = $("#replaysDir").value.trim();
  const code = $("#code").value.trim().toUpperCase();
  if (!replays) return setStatus("#prepareStatus", "Choose your replay folder first.", "error");
  if (!/^[A-Z0-9]{1,7}#\d{1,4}$/.test(code)) return setStatus("#prepareStatus", "Enter your connect code, like ABCD#123.", "error");
  if (!state.status.engine) return setStatus("#prepareStatus", "Install the Phillip engine in Setup first.", "error");

  $("#prepareBtn").disabled = true;
  $("#prepareProgress").hidden = false;
  setStatus("#prepareStatus", "Looking for your games…");
  try {
    state.summary = await call("prepare", { replays, code });
    renderSummary();
  } catch (err) {
    setStatus("#prepareStatus", err.message, "error");
  }
  $("#prepareBtn").disabled = false;
  $("#prepareProgress").hidden = true;
});

const STAGES = { scan: "Looking for your games", pack: "Collecting them", parse: "Reading games", index: "Building the training set" };
api.on("prepare", (e) => {
  if (e.stage === "done") return;
  const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
  $("#prepareProgress > div").style.width = `${pct}%`;
  const found = e.stage === "scan" ? ` · ${e.found} of yours` : "";
  setStatus("#prepareStatus", `${STAGES[e.stage] ?? e.stage}… ${e.done ?? ""}${e.total ? ` / ${e.total}` : ""}${found}`);
});

function trainableCharacters() {
  return new Set(state.catalog.filter((m) => m.kind === "imitation").map((m) => m.character));
}

function renderSummary() {
  const s = state.summary;
  if (!s || !s.games) {
    setStatus("#prepareStatus", "No usable games found for that connect code. Check the code and the folder.", "error");
    $("#trainSetup").hidden = true;
    return;
  }
  setStatus("#prepareStatus", `Found ${s.games} usable games${s.new ? ` (${s.new} new)` : ""}.`, "good");
  const ok = trainableCharacters();
  const chars = Object.entries(s.characters);
  // Under this many games there's too little of you to learn from.
  const MIN_GAMES = 10;
  const can = chars.filter(([c, n]) => ok.has(c) && n >= MIN_GAMES);
  const few = chars.filter(([c, n]) => ok.has(c) && n < MIN_GAMES);
  const cannot = chars.filter(([c]) => !ok.has(c));
  if (!state.trainChar || !ok.has(state.trainChar)) state.trainChar = can[0]?.[0] ?? null;
  $("#trainChars").innerHTML = can.map(([c, n]) =>
    `<div class="item pick ${c === state.trainChar ? "active" : ""}" data-c="${c}">
      <div class="grow"><b>${charName(c)}</b><span>${n} games${n < 50 ? " · few games, the bot will be rough" : ""}</span></div></div>`).join("")
    + (few.length ? `<p class="hint">Too few games to train (under ${MIN_GAMES}): ${few.map(([c, n]) => `${charName(c)} (${n})`).join(", ")}.</p>` : "")
    + (cannot.length ? `<p class="hint">Phillip has no starting bot yet for: ${cannot.map(([c, n]) => `${charName(c)} (${n})`).join(", ")}.</p>` : "");
  $("#trainSetup").hidden = false;
  $("#trainBtn").disabled = !state.trainChar;
}

$("#trainChars").addEventListener("click", (e) => {
  const item = e.target.closest(".item.pick"); if (!item) return;
  state.trainChar = item.dataset.c; renderSummary();
});
segment($("#duration"), (d) => { state.minutes = Number(d.min); });

$("#trainBtn").addEventListener("click", async () => {
  const code = $("#code").value.trim().toUpperCase();
  const name = $("#botName").value.trim() || `${code.split("#")[0]} ${charName(state.trainChar)}`;
  lossPoints = [];
  $("#trainIdle").hidden = true;
  $("#trainLive").hidden = false;
  $("#trainTitle").textContent = name;
  $("#trainBtn").disabled = true;
  setStatus("#trainStatus", "Getting ready…");
  await call("train", { name, code, character: state.trainChar, minutes: state.minutes });
});

$("#stopTrain").addEventListener("click", () => call("train:stop"));

let lossPoints = [];
function drawLoss() {
  const svg = $("#lossChart");
  if (lossPoints.length < 2) { svg.innerHTML = ""; return; }
  const max = Math.max(...lossPoints), min = Math.min(...lossPoints);
  const span = max - min || 1;
  const pts = lossPoints.map((v, i) =>
    `${(i / (lossPoints.length - 1)) * 300},${8 + (1 - (v - min) / span) * 74}`).join(" ");
  svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="#e8453c" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
}

const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };

api.on("train", (e) => {
  if (e.state === "downloading") setStatus("#trainStatus", `Downloading the starting bot (${e.base})…`);
  if (e.state === "starting") setStatus("#trainStatus", "Loading your games… the first numbers take a few minutes.");
  if (e.state === "training") {
    if (e.test != null) {
      lossPoints.push(e.test);
      drawLoss();
      $("#trainBar").style.width = `${Math.min(100, (e.elapsed / e.total) * 100)}%`;
      $("#trainTime").textContent = `${fmt(e.total - e.elapsed)} left`;
      setStatus("#trainStatus", `Difference from you: ${e.test.toFixed(3)}`);
    }
    if (e.saved != null) setStatus("#trainStatus", `Improved and saved (${e.saved.toFixed(3)}).`, "good");
  }
  if (e.state === "done" || e.state === "failed") {
    $("#trainBtn").disabled = false;
    $("#trainLive").hidden = true;
    $("#trainIdle").hidden = false;
    $("#trainIdle").textContent = e.state === "done"
      ? "Training finished. Your bot is under My bots, and in Play → My bots."
      : `Training stopped before anything was saved.\n${e.error ?? ""}`;
    $("#trainIdle").className = e.state === "done" ? "status good" : "status error";
    loadBots();
  }
});

async function loadBots() {
  state.bots = await call("bots");
  $("#myBots").innerHTML = state.bots.length ? state.bots.map((b) => `
    <div class="item" data-bot="${b.id}">
      <div class="grow"><b>${esc(b.name ?? b.id)}</b>
        <span>${charName(b.character)} · ${esc(b.code ?? "")} · ${b.ready ? (b.finishedAt ? "ready" : "ready (partly trained)") : "not ready"}</span></div>
      ${b.ready ? `<button data-act="play">Play</button>` : ""}
      <button data-act="folder">Folder</button>
      <button data-act="delete">Delete</button>
    </div>`).join("") : `<div class="empty">No bots yet.</div>`;
  renderPlayPickers();
  renderMatch();
}

$("#myBots").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const bot = state.bots.find((x) => x.id === b.closest("[data-bot]").dataset.bot);
  if (b.dataset.act === "play") {
    state.mode = "mine"; state.myBot = bot.id;
    $$("#playMode button").forEach((x) => x.classList.toggle("active", x.dataset.mode === "mine"));
    showTab("play"); renderPlayPickers(); renderMatch();
  }
  if (b.dataset.act === "folder") call("open", bot.dir);
  if (b.dataset.act === "delete" && confirm(`Delete "${bot.name}"? This can't be undone.`)) {
    try { await call("bot:delete", bot.id); } catch (err) { alert(err.message); }
    loadBots();
  }
});

// --- helpers -------------------------------------------------------------------------

function setStatus(sel, text, kind = "") {
  const el = $(sel);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function loadCatalog() {
  state.catalog = await call("catalog");
}

(async function start() {
  const ready = await refreshStatus();
  await loadCatalog();
  restorePicks();
  await loadBots();
  renderPlayPickers();
  renderMatch();
  if (!ready) showTab("setup");
})();
