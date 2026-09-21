#!/usr/bin/env node
// Adventurer 5M dashboard: projects, review queue, print history.
//
// The printer is only ever read (/detail). Nothing here starts, pauses, cancels
// or uploads a job — the agent does that through the openscad MCP server once
// the user has released a queue entry here.

import http from "node:http";
import {
  readFileSync, existsSync, statSync, readdirSync, watch,
  mkdirSync, copyFileSync, writeFileSync,
} from "node:fs";
import { join, dirname, basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces, homedir } from "node:os";
import { parseGcode, encodeToolpath, gcodeStats } from "./gcode-parse.js";

// node:sqlite landed in Node 22. Say so plainly rather than dying inside the
// module loader with ERR_UNKNOWN_BUILTIN_MODULE.
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(
    `This dashboard needs Node 22 or newer for node:sqlite. Running ${process.version} ` +
    `from ${process.execPath}.\nInstall a newer Node, or point run-dashboard.cmd at one.`,
  );
  process.exit(1);
}
const { openDb, slugify, now } = await import("./db.js");

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT_PRINTER = 8898;

const fileCfg = existsSync(join(ROOT, "config.json"))
  ? JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8").replace(/^﻿/, ""))
  : {};

function loadPrinterFile() {
  const candidates = [
    process.env.PRINTER_CONFIG,
    join(ROOT, "printer.json"),
    join(ROOT, "..", "printer.json"),
    join(homedir(), ".print3d", "printer.json"),
    join(homedir(), "source", "ai-3d-print", "printer.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
      if (j && (j.ip || j.serial || j.checkCode)) return j;
    } catch { /* skip bad json */ }
  }
  return {};
}

const printer = loadPrinterFile();

// Your models are yours and live outside this repo — point `library` in
// config.json at wherever you keep them. With no config at all we fall back to
// a `library/` folder beside the checkout, so a fresh clone runs as-is.
const LIBRARY = resolve(process.env.PRINT_LIBRARY || fileCfg.library || join(ROOT, "..", "library"));

const CFG = {
  ip: process.env.PRINTER_IP || printer.ip || "",
  serial: process.env.PRINTER_SERIAL || printer.serial || "",
  checkCode: process.env.PRINTER_CHECKCODE || printer.checkCode || "",
  port: Number(process.env.DASH_PORT || fileCfg.port || 3470),
  library: LIBRARY,
  projectsRoot: resolve(process.env.PROJECTS_ROOT || fileCfg.projectsRoot || join(LIBRARY, "projects")),
  // The database describes the library, not the code, so it lives with the
  // library. That keeps this repo pure tooling and lets one checkout serve
  // whichever library config.json points at.
  db: resolve(process.env.DASH_DB || fileCfg.db || join(LIBRARY, "dashboard.db")),
  pollMs: Number(process.env.DASH_POLL_MS || fileCfg.pollMs || 2000),
  gcodeDirs: (process.env.GCODE_DIRS
    ? process.env.GCODE_DIRS.split(";").map((s) => s.trim()).filter(Boolean)
    : fileCfg.gcodeDirs) || [LIBRARY],
};

if (!CFG.ip || !CFG.serial || !CFG.checkCode) {
  console.error("Missing printer ip / serial / checkCode. Copy printer.example.json to printer.json in the ai-3d-print repo.");
  process.exit(1);
}

mkdirSync(CFG.projectsRoot, { recursive: true });
const db = openDb(CFG.db);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
  ".stl": "model/stl",
};

// --- printer polling -------------------------------------------------------
//
// Strictly viewer-driven. A client that has auto-refresh off connects with
// live=0 and the server issues no printer requests at all on its behalf.

const clients = new Set();
let lastStatus = { online: false, detail: null, error: "not polled yet", ts: 0, printerIp: CFG.ip };
let pollInFlight = false;
let pollTimer = null;
let printerHits = 0;

const liveViewers = () => [...clients].filter((c) => c.live).length;

async function printerPost(path, body = {}) {
  printerHits += 1;
  const r = await fetch(`http://${CFG.ip}:${PORT_PRINTER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serialNumber: CFG.serial, checkCode: CFG.checkCode, ...body }),
    signal: AbortSignal.timeout(8000),
  });
  const t = await r.text();
  let json;
  try { json = JSON.parse(t); }
  catch { throw new Error(`Non-JSON from ${path}`); }
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    throw new Error(json.message || `code ${json.code}`);
  }
  return json;
}

async function poll(force = false) {
  if (pollInFlight) return lastStatus;
  if (!force && !liveViewers()) return lastStatus;
  pollInFlight = true;
  try {
    const j = await printerPost("/detail");
    lastStatus = { online: true, detail: j.detail || {}, error: null, ts: Date.now(), printerIp: CFG.ip };
    try { trackPrint(lastStatus.detail); }
    catch (e) { console.error("history:", e.message); }
  } catch (e) {
    lastStatus = {
      online: false,
      detail: lastStatus.detail,
      error: String(e.message || e),
      ts: Date.now(),
      printerIp: CFG.ip,
    };
  } finally {
    pollInFlight = false;
  }
  broadcast();
  return lastStatus;
}

function syncPolling() {
  const want = liveViewers() > 0;
  if (want && !pollTimer) {
    console.log("live viewer — polling printer");
    pollTimer = setInterval(() => poll(), CFG.pollMs);
    poll();
  } else if (!want && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("no live viewers — printer untouched");
  }
}

// --- print history ---------------------------------------------------------

const DONE_RESULT = {
  completed: "completed",
  ready: "completed",
  cancel: "cancelled",
  cancelled: "cancelled",
  error: "failed",
};

let openPrintId = null;

function itemForGcode(name) {
  const base = basename(String(name || "")).toLowerCase();
  if (!base) return {};
  for (const r of db.all("SELECT id, item_id, gcode_path FROM revisions WHERE gcode_path IS NOT NULL ORDER BY id DESC")) {
    if (basename(r.gcode_path).toLowerCase() === base) return { itemId: r.item_id, revisionId: r.id };
  }
  return {};
}

function trackPrint(d) {
  if (!d) return;
  const status = String(d.status || "").toLowerCase();
  const job = d.printFileName || "";
  const printing = status === "printing" || status === "pause" || status === "paused";

  if (printing && job) {
    let row = openPrintId ? db.get("SELECT * FROM prints WHERE id = ?", openPrintId) : null;
    if (row && (row.gcode_name !== job || row.result !== "running")) row = null;
    if (!row) row = db.openPrint(job);
    if (!row || row.gcode_name !== job) {
      // A different job than the one we were tracking: close the old one blind.
      if (openPrintId) db.endPrint(openPrintId, "unknown");
      const link = itemForGcode(job);
      const local = findGcode(job);
      const st = local ? gcodeStats(local) : null;
      const elapsed = Number(d.printDuration) || 0;
      row = db.startPrint({
        ...link,
        queueId: queueEntryForItem(link.itemId),
        gcodeName: job,
        startedAt: new Date(Date.now() - elapsed * 1000).toISOString(),
        layers: Number(d.targetPrintLayer) || st?.layerCount || null,
        lastLayer: Number(d.printLayer) || 0,
        estSeconds: st?.estSeconds ?? null,
        filamentG: st?.filamentG ?? null,
        filamentType: d.rightFilamentType || d.leftFilamentType || st?.filamentType || null,
      });
      if (row.queue_id) db.setQueueState(row.queue_id, "printing", { startedAt: row.started_at });
      console.log(`print started: ${job}`);
    }
    openPrintId = row.id;
    db.touchPrint(row.id, Number(d.printLayer) || 0);
    return;
  }

  if (openPrintId) {
    const row = db.get("SELECT * FROM prints WHERE id = ?", openPrintId);
    if (row && row.result === "running") {
      const result = DONE_RESULT[status] ||
        (row.layers && row.last_layer >= row.layers - 1 ? "completed" : "unknown");
      db.endPrint(openPrintId, result, Number(d.printDuration) || null);
      console.log(`print ${result}: ${row.gcode_name}`);
    }
    openPrintId = null;
  }
}

function queueEntryForItem(itemId) {
  if (!itemId) return null;
  const q = db.get(
    "SELECT id FROM queue WHERE item_id = ? AND state IN ('ready','waiting') ORDER BY position LIMIT 1",
    itemId,
  );
  return q ? q.id : null;
}

// Adopt a print that was already running before this process started.
(function adoptRunningPrint() {
  const row = db.get("SELECT * FROM prints WHERE result = 'running' ORDER BY started_at DESC LIMIT 1");
  if (row) openPrintId = row.id;
})();

// --- g-code lookup ---------------------------------------------------------

const toolCache = new Map();

function* walk(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth - 1);
    else yield p;
  }
}

function findGcode(name) {
  const base = basename(String(name || ""));
  if (!base || base !== basename(base) || base.includes("\0")) return null;
  const roots = [CFG.projectsRoot, ...CFG.gcodeDirs];
  for (const dir of roots) {
    const direct = join(dir, base);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
  }
  for (const dir of roots) {
    for (const p of walk(dir, 3)) {
      if (basename(p) === base) return p;
    }
  }
  return null;
}

function getToolpath(name) {
  const file = findGcode(name);
  if (!file) return null;
  const st = statSync(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  const hit = toolCache.get(name);
  if (hit && hit.key === key) return hit;
  const parsed = parseGcode(file);
  const rec = { key, file, meta: parsed.meta, buf: encodeToolpath(parsed) };
  toolCache.set(name, rec);
  return rec;
}

// --- helpers ---------------------------------------------------------------

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": extra.cache || "no-store",
    ...extra.headers,
  });
  res.end(body);
}

const json = (res, code, obj) => send(res, code, "application/json", JSON.stringify(obj));

function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readJson(req) {
  return new Promise((ok, bad) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 4e6) { req.destroy(); bad(new Error("body too large")); }
    });
    req.on("end", () => {
      try { ok(b ? JSON.parse(b) : {}); }
      catch { bad(new Error("bad json")); }
    });
    req.on("error", bad);
  });
}

// Every path we hand out or read must sit under the library or the projects
// root — never anywhere else on disk.
function inLibrary(p) {
  const abs = resolve(p);
  for (const root of [CFG.library, CFG.projectsRoot, ...CFG.gcodeDirs]) {
    const r = resolve(root);
    if (abs === r || abs.startsWith(r + sep)) return true;
  }
  return false;
}

function statePayload() {
  return {
    ...lastStatus,
    stale: !lastStatus.ts || Date.now() - lastStatus.ts > CFG.pollMs * 3,
    polling: Boolean(pollTimer),
    viewers: clients.size,
    liveViewers: liveViewers(),
    queue: db.queue(),
    pendingReviews: db.all(`
      SELECT i.id, i.name, i.slug, p.name AS project_name, p.slug AS project_slug,
             r.id AS revision_id, r.rev
      FROM items i
      JOIN projects p ON p.id = i.project_id
      JOIN revisions r ON r.id = (SELECT MAX(id) FROM revisions WHERE item_id = i.id)
      WHERE i.status = 'pending'
      ORDER BY r.created_at
    `),
  };
}

function broadcast() {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(statePayload())}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); }
    catch { clients.delete(c); }
  }
}

// --- routes ----------------------------------------------------------------

const routes = [];
const on = (method, pattern, handler, opts = {}) =>
  routes.push({ method, pattern, handler, local: Boolean(opts.local) });

on("GET", /^\/api\/status$/, (req, res) => json(res, 200, statePayload()));

on("GET", /^\/api\/events$/, (req, res, _m, url) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const client = { res, live: url.searchParams.get("live") !== "0" };
  clients.add(client);
  try { res.write(`data: ${JSON.stringify(statePayload())}\n\n`); }
  catch { clients.delete(client); return; }
  req.on("close", () => { clients.delete(client); syncPolling(); });
  syncPolling();
});

// One printer read on demand, regardless of the auto-refresh toggle.
on("POST", /^\/api\/refresh$/, async (req, res) => {
  await poll(true);
  json(res, 200, statePayload());
});

on("GET", /^\/api\/info$/, (req, res) => json(res, 200, {
  port: CFG.port,
  printerIp: CFG.ip,
  library: CFG.library,
  projectsRoot: CFG.projectsRoot,
  db: CFG.db,
  urls: ["127.0.0.1", ...lanAddrs()].map((a) => `http://${a}:${CFG.port}`),
  viewOnly: true,
  viewers: clients.size,
  liveViewers: liveViewers(),
  polling: Boolean(pollTimer),
  pollMs: CFG.pollMs,
  printerHits,
}));

// --- projects --------------------------------------------------------------

on("GET", /^\/api\/projects$/, (req, res, _m, url) => json(res, 200, {
  projects: db.projects({
    search: url.searchParams.get("q") || "",
    tag: url.searchParams.get("tag") || "",
    includeArchived: url.searchParams.get("archived") === "1",
  }),
  tags: db.allTags(),
}));

on("POST", /^\/api\/projects$/, async (req, res) => {
  const b = await readJson(req);
  const name = String(b.name || "").trim();
  if (!name) return json(res, 400, { error: "name required" });
  const slug = slugify(b.slug || name);
  const dir = join(CFG.projectsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const p = db.createProject({ name, slug, dir, notes: String(b.notes || ""), tags: b.tags || [] });
  console.log(`project created: ${p.slug}`);
  broadcast();
  json(res, 200, p);
}, { local: true });

on("GET", /^\/api\/projects\/([^/]+)$/, (req, res, m) => {
  const p = db.project(decodeURIComponent(m[1]));
  if (!p) return json(res, 404, { error: "no such project" });
  json(res, 200, {
    ...p,
    items: db.itemsOf(p.id),
    prints: db.prints({ projectId: p.id, limit: 30 }),
    notes: db.all("SELECT * FROM notes WHERE project_id = ? ORDER BY created_at DESC", p.id),
  });
});

on("PATCH", /^\/api\/projects\/(\d+)$/, async (req, res, m) => {
  const b = await readJson(req);
  const p = db.updateProject(Number(m[1]), b);
  broadcast();
  json(res, 200, p);
});

// --- items -----------------------------------------------------------------

on("POST", /^\/api\/items$/, async (req, res) => {
  const b = await readJson(req);
  const project = db.project(b.project);
  if (!project) return json(res, 400, { error: `no project "${b.project}"` });

  const name = String(b.name || "").trim();
  if (!name) return json(res, 400, { error: "name required" });

  // Copy the sources into the project directory so a project is self-contained.
  const stored = {};
  for (const [key, col] of [["stl", "stlPath"], ["scad", "scadPath"], ["gcode", "gcodePath"]]) {
    const src = b[key] ? resolve(String(b[key])) : "";
    if (!src) continue;
    if (!existsSync(src) || !statSync(src).isFile()) {
      return json(res, 400, { error: `no ${key} file at ${src}` });
    }
    const dest = join(project.dir, basename(src));
    if (resolve(dest) !== src) {
      mkdirSync(project.dir, { recursive: true });
      copyFileSync(src, dest);
    }
    stored[col] = dest;
  }
  if (!stored.stlPath && !stored.gcodePath) {
    return json(res, 400, { error: "an stl or gcode path is required" });
  }

  const slug = slugify(b.slug || name);
  let item = db.get("SELECT * FROM items WHERE project_id = ? AND slug = ?", project.id, slug);
  if (!item) item = db.createItem({ projectId: project.id, name, slug, tags: b.tags || [] });
  else if (b.tags) db.setTags("item", item.id, b.tags);

  const st = stored.gcodePath ? gcodeStats(stored.gcodePath) : null;
  const rev = db.addRevision(item.id, {
    ...stored,
    layerCount: st?.layerCount ?? null,
    estSeconds: st?.estSeconds ?? null,
    filamentG: st?.filamentG ?? null,
    filamentType: st?.filamentType ?? null,
    note: String(b.note || ""),
  });
  console.log(`item revision: ${project.slug}/${slug} v${rev.rev}`);
  broadcast();
  json(res, 200, { item: db.item(item.id), revision: rev });
}, { local: true });

on("GET", /^\/api\/items\/(\d+)$/, (req, res, m) => {
  const it = db.item(Number(m[1]));
  if (!it) return json(res, 404, { error: "no such item" });
  json(res, 200, { ...it, prints: db.prints({ itemId: it.id, limit: 20 }) });
});

on("POST", /^\/api\/items\/(\d+)\/decide$/, async (req, res, m) => {
  const b = await readJson(req);
  const decision = b.action === "approve" ? "approved" : b.action === "reject" ? "rejected" : "";
  if (!decision) return json(res, 400, { error: "action must be approve or reject" });
  const it = db.item(Number(m[1]));
  if (!it || !it.revision) return json(res, 404, { error: "no revision to decide on" });
  if (b.revisionId && Number(b.revisionId) !== it.revision.id) {
    return json(res, 409, { error: "that revision has been superseded", item: it });
  }
  db.decide(it.revision.id, decision, String(b.note || ""));
  if (b.note) db.addNote({ itemId: it.id, body: String(b.note), author: "user" });
  console.log(`${decision}: ${it.projectSlug}/${it.slug} v${it.revision.rev}`);
  broadcast();
  json(res, 200, db.item(it.id));
});

on("POST", /^\/api\/items\/(\d+)\/notes$/, async (req, res, m) => {
  const b = await readJson(req);
  const body = String(b.body || "").trim();
  if (!body) return json(res, 400, { error: "body required" });
  db.addNote({ itemId: Number(m[1]), body, author: b.author || "user" });
  broadcast();
  json(res, 200, db.item(Number(m[1])));
});

on("PATCH", /^\/api\/items\/(\d+)$/, async (req, res, m) => {
  const b = await readJson(req);
  const id = Number(m[1]);
  if (b.tags) db.setTags("item", id, b.tags);
  if (b.name) db.run("UPDATE items SET name = ?, updated_at = ? WHERE id = ?", b.name, now(), id);
  if (b.status) db.setItemStatus(id, b.status);
  broadcast();
  json(res, 200, db.item(id));
});

on("GET", /^\/api\/revisions\/(\d+)\/stl$/, (req, res, m) => {
  const rev = db.get("SELECT * FROM revisions WHERE id = ?", Number(m[1]));
  if (!rev?.stl_path || !existsSync(rev.stl_path)) return json(res, 404, { error: "no stl" });
  if (!inLibrary(rev.stl_path)) return json(res, 403, { error: "outside the library" });
  send(res, 200, "model/stl", readFileSync(rev.stl_path), { cache: "private, max-age=300" });
});

// --- queue -----------------------------------------------------------------

on("GET", /^\/api\/queue$/, (req, res) => json(res, 200, {
  queue: db.queue(),
  history: db.queueHistory(20),
}));

on("POST", /^\/api\/queue$/, async (req, res) => {
  const b = await readJson(req);
  const ids = Array.isArray(b.items) ? b.items : [b.item].filter(Boolean);
  if (!ids.length) return json(res, 400, { error: "items required" });
  const added = ids.map((id) => db.enqueue(Number(id), b.revisionId || null, String(b.note || "")));
  broadcast();
  json(res, 200, { added, queue: db.queue() });
});

on("DELETE", /^\/api\/queue\/(\d+)$/, (req, res, m) => {
  db.dequeue(Number(m[1]));
  broadcast();
  json(res, 200, { queue: db.queue() });
});

on("POST", /^\/api\/queue\/reorder$/, async (req, res) => {
  const b = await readJson(req);
  if (!Array.isArray(b.ids)) return json(res, 400, { error: "ids required" });
  db.reorderQueue(b.ids.map(Number));
  broadcast();
  json(res, 200, { queue: db.queue() });
});

// The peel-off gate. Nothing moves to the next item until this is called.
on("POST", /^\/api\/queue\/release$/, async (req, res) => {
  const b = await readJson(req);

  // The machine may be busy with a job that never came from this queue, so take
  // one fresh reading on this explicit action rather than trusting the cache.
  const s = await poll(true);
  const st = String(s.detail?.status || "").toLowerCase();
  if (s.online && ["printing", "pause", "paused", "busy"].includes(st)) {
    return json(res, 409, {
      error: `the printer is ${st} "${s.detail?.printFileName || "a job"}" — wait for it to finish`,
    });
  }

  const out = db.releaseNext(b.id || null);
  if (out.error) return json(res, 409, out);
  console.log(`queue released: entry ${out.entry.id}`);
  broadcast();
  json(res, 200, { ...out, queue: db.queue() });
});

on("POST", /^\/api\/queue\/(\d+)\/state$/, async (req, res, m) => {
  const b = await readJson(req);
  const state = String(b.state || "");
  if (!["waiting", "ready", "printing", "done", "failed", "skipped"].includes(state)) {
    return json(res, 400, { error: "bad state" });
  }
  const entry = db.setQueueState(Number(m[1]), state, {
    startedAt: state === "printing" ? now() : undefined,
    endedAt: ["done", "failed", "skipped"].includes(state) ? now() : undefined,
    note: b.note,
  });
  broadcast();
  json(res, 200, { entry, queue: db.queue() });
});

// --- history and stats -----------------------------------------------------

on("GET", /^\/api\/prints$/, (req, res, _m, url) => json(res, 200, {
  prints: db.prints({ limit: Number(url.searchParams.get("limit")) || 100 }),
  stats: db.stats(),
}));

on("POST", /^\/api\/prints\/(\d+)\/outcome$/, async (req, res, m) => {
  const b = await readJson(req);
  const p = db.setOutcome(Number(m[1]), String(b.outcome || ""), String(b.note || ""));
  broadcast();
  json(res, 200, p);
});

// --- model rendering -------------------------------------------------------

on("GET", /^\/api\/model$/, (req, res, _m, url) => {
  const name = url.searchParams.get("name") || lastStatus.detail?.printFileName;
  if (!name) return json(res, 404, { error: "no job" });
  const rec = getToolpath(name);
  if (!rec) return json(res, 404, { error: "gcode not found locally", name });
  send(res, 200, "application/octet-stream", rec.buf, {
    headers: {
      "X-Model-Name": encodeURIComponent(basename(rec.file)),
      "X-Layer-Count": String(rec.meta.layerCount),
    },
  });
});

on("GET", /^\/api\/model-meta$/, (req, res, _m, url) => {
  const name = url.searchParams.get("name") || lastStatus.detail?.printFileName;
  if (!name) return json(res, 404, { error: "no job" });
  const rec = getToolpath(name);
  if (!rec) return json(res, 404, { error: "gcode not found locally", name });
  json(res, 200, { name: basename(rec.file), ...rec.meta });
});

// --- static ----------------------------------------------------------------

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  rel = rel.replace(/^\/+/, "").replace(/\\/g, "/");
  const abs = resolve(PUBLIC, rel);
  const root = resolve(PUBLIC) + sep;
  if (abs !== resolve(PUBLIC) && !abs.startsWith(root)) return send(res, 403, "text/plain", "forbidden");
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    // Client-side routes fall back to the app shell.
    if (!rel.includes(".")) return send(res, 200, MIME[".html"], readFileSync(join(PUBLIC, "index.html")));
    return send(res, 404, "text/plain", "not found");
  }
  const ext = extname(abs).toLowerCase();
  send(res, 200, MIME[ext] || "application/octet-stream", readFileSync(abs), {
    cache: rel.startsWith("vendor/") ? "public, max-age=86400" : "no-store",
  });
}

function lanAddrs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) if (n.family === "IPv4" && !n.internal) out.push(n.address);
  }
  return out;
}

async function onRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    if (r.local && !isLoopback(req)) return json(res, 403, { error: "this endpoint is local only" });
    try { return await r.handler(req, res, m, url); }
    catch (e) {
      console.error(`${req.method} ${path}:`, e.message);
      if (!res.headersSent) return json(res, 500, { error: String(e.message || e) });
      return res.end();
    }
  }

  if (req.method === "GET") return serveStatic(path, res);
  send(res, 405, "text/plain", "method not allowed");
}

for (const dir of [CFG.projectsRoot, ...CFG.gcodeDirs]) {
  if (!existsSync(dir)) continue;
  try { watch(dir, { persistent: false }, () => toolCache.clear()); }
  catch { /* watch is optional */ }
}

function listenOn(port) {
  const s = http.createServer(onRequest);
  s.on("error", (e) => console.error(`Could not listen on ${port}: ${e.code || e.message}`));
  s.listen(port, "0.0.0.0", () => {
    for (const a of ["127.0.0.1", ...lanAddrs()]) {
      console.log(`  ${port === 80 ? `http://${a}` : `http://${a}:${port}`}`);
    }
  });
  return s;
}

console.log("Adventurer 5M dashboard — projects, queue, history (printer is read-only)");
console.log(`  library  ${CFG.library}`);
console.log(`  projects ${CFG.projectsRoot}`);
console.log(`  db       ${CFG.db}`);
listenOn(CFG.port);
listenOn(80);
console.log(`Printer ${CFG.ip}:${PORT_PRINTER} is read only while a tab has auto-refresh on.`);
