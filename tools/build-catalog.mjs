// Builds catalog/models.json from tools/dropbox-listing.txt.
//
// The listing is vladfi's shared Dropbox folder "deployed_models", one entry
// per model: "<name> <file id> <size MB>". Each model downloads straight from
//   https://www.dropbox.com/scl/fo/<FOLDER>/<file id>/<name>?rlkey=<KEY>&dl=1
//
// Names follow "<char>_d<delay>_<opponent part>[_v<version>]", e.g.
// fox_d21_vs_marth_v6.2 (Fox, tuned against Marth) or fox_d18_imitation_v3
// (pure imitation of human Fox players). The rank models (bronze ... super-gm)
// play every character and imitate a rank rather than a player.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Model-name spellings -> libmelee character names.
const CHARS = {
  dk: "dk", doc: "doc", falco: "falco", falcon: "cptfalcon", fox: "fox",
  ganon: "ganondorf", ics: "popo", link: "link", luigi: "luigi",
  marth: "marth", peach: "peach", pikachu: "pikachu", puff: "jigglypuff",
  samus: "samus", sheik: "sheik", yoshi: "yoshi",
};

const RANKS = ["bronze", "silver", "gold", "plat", "diamond", "master", "gm", "super-gm"];

// The 12 characters the general "medium" models play.
const MEDIUM_CHARS = ["fox", "falco", "marth", "sheik", "jigglypuff", "cptfalcon",
  "peach", "yoshi", "popo", "luigi", "pikachu", "samus"];

function versionOf(rest) {
  const m = rest.match(/_v(\d+)(?:\.(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}

function parse(name) {
  const base = name.replace(/-v\d+$/, "");
  if (RANKS.includes(base)) {
    return { kind: "rank", rank: base, version: name.endsWith("-v2") ? 2 : name.endsWith("-v1") ? 1 : 3 };
  }
  if (base === "medium") {
    return { kind: "general", characters: MEDIUM_CHARS, version: Number(name.slice(-1)) };
  }

  const m = name.match(/^([a-z]+)_(?:d|delay_)(\d+)_(.+)$/);
  if (!m || !CHARS[m[1]]) return { kind: "other" };
  const [, char, delay, rest] = m;
  const character = CHARS[char];
  const [major, minor] = versionOf(rest);
  const entry = { character, delay: Number(delay), version: [major, minor] };

  if (rest.startsWith("imitation")) return { kind: "imitation", ...entry };
  if (rest.startsWith("ditto")) return { kind: "matchup", opponent: character, ...entry };
  const vs = rest.match(/^vs_([a-z]+)/);
  if (vs && CHARS[vs[1]]) return { kind: "matchup", opponent: CHARS[vs[1]], ...entry };
  return { kind: "other" };
}

const listing = fs.readFileSync(path.join(ROOT, "tools", "dropbox-listing.txt"), "utf8").trim();
const models = listing.split("|").map((row) => {
  const [name, id, size] = row.trim().split(" ");
  return { name, id, sizeMB: Number(size), ...parse(name) };
});

const catalog = {
  source: "https://www.dropbox.com/scl/fo/mg916t9exid4stqmx2bjf/AD2oysY7SbTa6N0u7j75-SA?rlkey=baqxnfxg2uytvcz62w9o8mwzt",
  urlTemplate: "https://www.dropbox.com/scl/fo/mg916t9exid4stqmx2bjf/{id}/{name}?rlkey=baqxnfxg2uytvcz62w9o8mwzt&dl=1",
  models,
};
fs.mkdirSync(path.join(ROOT, "catalog"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "catalog", "models.json"), JSON.stringify(catalog, null, 1));

const kinds = models.reduce((acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] ?? 0) + 1 }), {});
console.log(`${models.length} models`, kinds);
