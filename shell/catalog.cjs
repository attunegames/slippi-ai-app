// vladfi1's released Phillip models: where they live and what each one is.
//
// Since 2026-10-05 they are in a public Google Drive folder (they were in
// Dropbox before, and those links are now dead). The app reads the folder's
// listing at startup, so models he adds or moves show up without an update;
// catalog/models.json is the copy shipped with the app, used when offline.
//
// Names follow "<char>_d<delay>_<opponent part>[_v<version>]", e.g.
// fox_d21_vs_marth_v6.2 (Fox, tuned against Marth) or fox_d18_imitation_v3
// (pure imitation of human Fox players). The rank models (bronze ... super-gm)
// play every character and imitate a rank rather than a player.

const FOLDER_ID = "1etYN_IgVoUPleAsh76s_9443e4XzGKWo";
const LISTING_URL = `https://drive.google.com/embeddedfolderview?id=${FOLDER_ID}`;
// confirm=t skips Drive's "can't scan this file for viruses" page on big files.
const URL_TEMPLATE = "https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t";
const SOURCE = `https://drive.google.com/drive/folders/${FOLDER_ID}`;

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

// [{ id, name }] from the HTML of Drive's embedded folder view.
function parseListing(html) {
  const entries = [];
  const re = /id="entry-([A-Za-z0-9_-]+)"[\s\S]*?flip-entry-title">([^<]*)</g;
  for (let m; (m = re.exec(html)); ) entries.push({ id: m[1], name: m[2].trim() });
  return entries;
}

// sizes: known sizes in MB by name. Drive's listing has none, so models new
// to the folder show their size once a download starts.
function buildCatalog(entries, sizes = {}) {
  return {
    source: SOURCE,
    urlTemplate: URL_TEMPLATE,
    models: entries
      .map(({ id, name }) => ({ name, id, sizeMB: sizes[name] ?? null, ...parse(name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

module.exports = { LISTING_URL, URL_TEMPLATE, parseListing, buildCatalog };
