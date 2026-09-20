#!/usr/bin/env node
// One-shot tidy-up: group the loose files in the library root into
// projects/<slug>/ and seed the database so existing work shows up with its
// history. Run with --apply to actually move anything; default is a dry run.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gcodeStats } from "./gcode-parse.js";
import { openDb, slugify } from "./db.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8").replace(/^﻿/, ""));
const LIBRARY = resolve(cfg.library);
const PROJECTS = resolve(cfg.projectsRoot);
const DB = resolve(cfg.db || join(ROOT, "data", "dashboard.db"));

const APPLY = process.argv.includes("--apply");

// Explicit grouping beats guesswork: these are the real projects in the root,
// longest prefix first so "access_tube_big" lands in access_tube, not its own.
const PROJECTS_SPEC = [
  { slug: "flos-v8-cafe", name: "FLOS V8 Cafe", match: /^flos_/, extra: ["FLOS_V8_CAFE.md"], tags: ["diorama", "multi-part"] },
  { slug: "cozy-cone", name: "Cozy Cone", match: /^cozy_cone/, tags: ["diorama"] },
  { slug: "access-tube", name: "Access Tube", match: /^access_tube/, tags: ["air-toobz"] },
  { slug: "ball-stopper", name: "Ball Stopper", match: /^(ball_stopper|Air_Toobz_Ball_Stopper)/, tags: ["air-toobz"] },
  { slug: "airtoobz-measure", name: "Air Toobz Measure", match: /^airtoobz_measure/, tags: ["air-toobz"] },
  { slug: "hw-connector", name: "Hot Wheels Connector", match: /^hw_connector/, tags: ["hot-wheels"] },
  { slug: "roller-coupon", name: "Roller Coupon", match: /^roller_coupon/, tags: ["hot-wheels"] },
  { slug: "print-plate-3up", name: "Print Plate 3-up", match: /^print_plate_3up/, tags: ["hot-wheels"] },
  { slug: "ceramic-alphabet", name: "Ceramic Alphabet", match: /^ceramic_/, tags: ["lettering"] },
  { slug: "calcube", name: "Cal Cube", match: /^calcube/, tags: ["calibration"] },
  { slug: "smoketest", name: "Smoke Test", match: /^smoketest/, tags: ["calibration"] },
];

// Tooling and docs that belong at the root, not in a project.
const KEEP_AT_ROOT = new Set([
  "CLAUDE.md", ".gitignore", "mw.json", "tv.html",
  "_go.mjs", "_watch.mjs", "_watch_big.mjs", "_watch_cool.mjs", "_watch_dash.mjs",
]);
const KEEP_DIRS = new Set(["projects", "dashboard", "downloads", "stl", ".git", ".claude", "node_modules"]);
const ASSET_EXT = new Set([".stl", ".gcode", ".scad", ".3mf", ".png", ".obj", ".step", ".stp", ".md"]);

function classify() {
  const plan = new Map();   // slug -> { spec, files: [] }
  const skipped = [];

  for (const ent of readdirSync(LIBRARY, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!KEEP_DIRS.has(ent.name)) skipped.push(`dir  ${ent.name}`); continue; }
    if (KEEP_AT_ROOT.has(ent.name) || ent.name.startsWith(".")) continue;
    if (!ASSET_EXT.has(extname(ent.name).toLowerCase())) { skipped.push(`file ${ent.name}`); continue; }

    const spec = PROJECTS_SPEC.find((p) =>
      p.match.test(ent.name) || (p.extra || []).includes(ent.name));
    if (!spec) { skipped.push(`file ${ent.name} (no project)`); continue; }
    if (!plan.has(spec.slug)) plan.set(spec.slug, { spec, files: [] });
    plan.get(spec.slug).files.push(ent.name);
  }

  // flos parts live in stl/ as well.
  const stlDir = join(LIBRARY, "stl");
  if (existsSync(stlDir)) {
    for (const f of readdirSync(stlDir)) {
      if (!f.startsWith("flos_")) continue;
      if (!plan.has("flos-v8-cafe")) {
        plan.set("flos-v8-cafe", { spec: PROJECTS_SPEC.find((p) => p.slug === "flos-v8-cafe"), files: [] });
      }
      plan.get("flos-v8-cafe").files.push(join("stl", f));
    }
  }
  return { plan, skipped };
}

// Items are the printable units: one per distinct file stem, with the .scad,
// .stl and .gcode of that stem collapsed into a single item.
function itemsFor(files) {
  const stems = new Map();
  for (const rel of files) {
    const base = basename(rel);
    const ext = extname(base).toLowerCase();
    const stem = base.slice(0, base.length - ext.length);
    if (!stems.has(stem)) stems.set(stem, { stem, files: {} , others: [] });
    const rec = stems.get(stem);
    if (ext === ".stl") rec.files.stl = rel;
    else if (ext === ".gcode") rec.files.gcode = rel;
    else if (ext === ".scad") rec.files.scad = rel;
    else rec.others.push(rel);
  }
  // Variant gcode (calcube-petg for calcube.stl) keeps its own item; anything
  // with neither an stl nor a gcode is a source-only helper, not a print.
  return [...stems.values()].filter((s) => s.files.stl || s.files.gcode);
}

const { plan, skipped } = classify();

console.log(`library  ${LIBRARY}`);
console.log(`projects ${PROJECTS}`);
console.log(`mode     ${APPLY ? "APPLY" : "dry run (pass --apply to move files)"}`);
console.log("");

let totalFiles = 0;
let totalItems = 0;
for (const [slug, { spec, files }] of plan) {
  const items = itemsFor(files);
  totalFiles += files.length;
  totalItems += items.length;
  console.log(`${slug}  (${spec.name})  ${files.length} files -> ${items.length} items`);
  for (const it of items) {
    const kinds = Object.keys(it.files).join("+");
    console.log(`    ${it.stem.padEnd(34)} ${kinds}`);
  }
  const loose = files.filter((f) => !items.some((i) => Object.values(i.files).includes(f)));
  if (loose.length) console.log(`    (also moving: ${loose.map((f) => basename(f)).join(", ")})`);
}
console.log("");
console.log(`${plan.size} projects, ${totalItems} items, ${totalFiles} files`);
if (skipped.length) {
  console.log("\nleft where they are:");
  for (const s of skipped) console.log(`  ${s}`);
}

if (!APPLY) process.exit(0);

// --- apply -----------------------------------------------------------------

const db = openDb(DB);

function move(relFrom, destDir) {
  const from = join(LIBRARY, relFrom);
  const to = join(destDir, basename(relFrom));
  if (!existsSync(from)) return null;
  if (resolve(from) === resolve(to)) return to;
  mkdirSync(destDir, { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    // Different volume or a locked handle: fall back to copy + delete.
    copyFileSync(from, to);
    try { unlinkSync(from); } catch { /* leave the original if it is held open */ }
  }
  return to;
}

let movedFiles = 0;
for (const [slug, { spec, files }] of plan) {
  const dir = join(PROJECTS, slug);
  mkdirSync(dir, { recursive: true });

  let project = db.project(slug);
  if (!project) {
    project = db.createProject({ name: spec.name, slug, dir, tags: spec.tags || [] });
  }

  const items = itemsFor(files);
  const claimed = new Set();

  for (const it of items) {
    const moved = {};
    for (const [kind, rel] of Object.entries(it.files)) {
      const to = move(rel, dir);
      if (to) { moved[kind] = to; movedFiles += 1; claimed.add(rel); }
    }
    const itemSlug = slugify(it.stem);
    let item = db.get("SELECT * FROM items WHERE project_id = ? AND slug = ?", project.id, itemSlug);
    if (!item) {
      item = db.createItem({
        projectId: project.id,
        name: it.stem.replace(/[_-]+/g, " "),
        slug: itemSlug,
        tags: spec.tags || [],
      });
    }
    if (db.get("SELECT id FROM revisions WHERE item_id = ?", item.id)) continue;

    const st = moved.gcode ? gcodeStats(moved.gcode) : null;
    const rev = db.addRevision(item.id, {
      stlPath: moved.stl || null,
      scadPath: moved.scad || null,
      gcodePath: moved.gcode || null,
      layerCount: st?.layerCount ?? null,
      estSeconds: st?.estSeconds ?? null,
      filamentG: st?.filamentG ?? null,
      filamentType: st?.filamentType ?? null,
      note: "Imported from the library root.",
    });
    // These were all printed or shelved before the dashboard existed; treat a
    // sliced gcode as evidence it was approved at the time.
    db.decide(rev.id, moved.gcode ? "approved" : "pending", moved.gcode ? "Imported: already sliced." : "");
  }

  // Renders, docs and anything else that belongs with the project.
  for (const rel of files) {
    if (claimed.has(rel)) continue;
    if (move(rel, dir)) movedFiles += 1;
  }
}

console.log(`\nmoved ${movedFiles} files into ${PROJECTS}`);
console.log(`seeded ${db.all("SELECT id FROM projects").length} projects, ` +
  `${db.all("SELECT id FROM items").length} items, ` +
  `${db.all("SELECT id FROM revisions").length} revisions`);
