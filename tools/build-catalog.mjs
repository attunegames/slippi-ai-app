// Rebuilds catalog/models.json (the model list shipped with the app) from
// vladfi1's Google Drive folder. The app also refreshes it live at startup;
// this copy is what it uses offline. See shell/catalog.cjs.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { LISTING_URL, parseListing, buildCatalog } = require("../shell/catalog.cjs");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "catalog", "models.json");

const res = await fetch(LISTING_URL);
if (!res.ok) throw new Error(`Drive listing: HTTP ${res.status}`);
const entries = parseListing(await res.text());
if (!entries.length) throw new Error("Drive listing parsed to nothing; did the page format change?");

// Keep sizes we already know (the listing doesn't include them).
const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")).models : [];
const sizes = Object.fromEntries(previous.filter((m) => m.sizeMB).map((m) => [m.name, m.sizeMB]));

const catalog = buildCatalog(entries, sizes);
fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1));
const kinds = catalog.models.reduce((acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] ?? 0) + 1 }), {});
console.log(`${catalog.models.length} models`, kinds);
