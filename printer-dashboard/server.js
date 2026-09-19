#!/usr/bin/env node
// View-only Adventurer 5M dashboard. Polls /detail. Never sends control, print, or upload.

import http from "node:http";
import { readFileSync, existsSync, statSync, readdirSync, watch, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces, homedir } from "node:os";
import { parseGcode, encodeToolpath } from "./gcode-parse.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PREVIEW_DIR = join(ROOT, "preview");
const PREVIEW_STL = join(PREVIEW_DIR, "model.stl");
const PREVIEW_STATE = join(PREVIEW_DIR, "state.json");
const PORT_PRINTER = 8898;

const fileCfg = existsSync(join(ROOT, "config.json"))
  ? JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"))
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
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && (j.ip || j.serial || j.checkCode)) return j;
    } catch { /* skip bad json */ }
  }
  return {};
}

const printer = loadPrinterFile();

const CFG = {
  ip: process.env.PRINTER_IP || printer.ip || "",
  serial: process.env.PRINTER_SERIAL || printer.serial || "",
  checkCode: process.env.PRINTER_CHECKCODE || printer.checkCode || "",
  port: Number(process.env.DASH_PORT || fileCfg.port || 3470),
  gcodeDirs: (process.env.GCODE_DIRS
    ? process.env.GCODE_DIRS.split(";").map((s) => s.trim()).filter(Boolean)
    : fileCfg.gcodeDirs) || [join(ROOT, "..", "..", "source", "3dprint")],
};

if (!CFG.ip || !CFG.serial || !CFG.checkCode) {
  console.error("Missing printer ip / serial / checkCode. Copy printer.example.json to printer.json in the ai-3d-print repo.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

const clients = new Set();
const POLL_MS = 1500;
const FRESH_MS = 4000;
let lastStatus = { online: false, detail: null, error: "waiting for a viewer", ts: 0 };
let pollInFlight = false;
let pollTimer = null;
let printerHits = 0;

const toolCache = new Map();

function findGcode(name) {
  const base = basename(String(name || ""));
  if (!base || base !== basename(base) || base.includes("\0")) return null;
  for (const dir of CFG.gcodeDirs) {
    if (!existsSync(dir)) continue;
    const direct = join(dir, base);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const nested = join(dir, ent.name, base);
        if (existsSync(nested) && statSync(nested).isFile()) return nested;
      }
    } catch { /* ignore unreadable dirs */ }
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
  const buf = encodeToolpath(parsed);
  const rec = { key, file, meta: parsed.meta, buf };
  toolCache.set(name, rec);
  return rec;
}

async function printerPost(path, body = {}) {
  printerHits += 1;
  const r = await fetch(`http://${CFG.ip}:${PORT_PRINTER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serialNumber: CFG.serial,
      checkCode: CFG.checkCode,
      ...body,
    }),
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

function statusFresh() {
  return lastStatus.ts > 0 && Date.now() - lastStatus.ts < FRESH_MS;
}

function broadcast() {
  if (!clients.size) return;
  const payload = ssePayload();
  for (const res of clients) {
    try { res.write(payload); }
    catch { clients.delete(res); }
  }
}

async function poll() {
  if (pollInFlight || !clients.size) return;
  pollInFlight = true;
  try {
    const j = await printerPost("/detail");
    lastStatus = {
      online: true,
      detail: j.detail || {},
      error: null,
      ts: Date.now(),
      printerIp: CFG.ip,
    };
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
  if (clients.size) broadcast();
  else stopPolling();
}

function startPolling() {
  if (pollTimer) return;
  console.log("viewer present — polling printer");
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  console.log("no viewers — printer idle");
}

mkdirSync(PREVIEW_DIR, { recursive: true });
let previewState = { status: "none" };
try {
  if (existsSync(PREVIEW_STATE)) previewState = JSON.parse(readFileSync(PREVIEW_STATE, "utf8"));
} catch { previewState = { status: "none" }; }

function savePreview() {
  writeFileSync(PREVIEW_STATE, JSON.stringify(previewState, null, 2));
}

function publicPreview() {
  if (!previewState || previewState.status === "none") return { status: "none" };
  return {
    id: previewState.id,
    status: previewState.status,
    name: previewState.name || "",
    hasStl: existsSync(PREVIEW_STL),
  };
}

function ssePayload() {
  return `data: ${JSON.stringify({ ...lastStatus, preview: publicPreview() })}\n\n`;
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1e6) { req.destroy(); reject(new Error("too large")); }
    });
    req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : {}); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function addViewer(res) {
  clients.add(res);
  try { res.write(ssePayload()); }
  catch { clients.delete(res); return; }
  startPolling();
}

function removeViewer(res) {
  clients.delete(res);
  if (!clients.size) stopPolling();
}

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": extra.cache || "no-store", ...extra.headers });
  res.end(body);
}

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  rel = rel.replace(/^\/+/, "").replace(/\\/g, "/");
  const abs = resolve(PUBLIC, rel);
  const root = resolve(PUBLIC) + sep;
  if (abs !== resolve(PUBLIC) && !abs.startsWith(root)) {
    send(res, 403, "text/plain", "forbidden");
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    send(res, 404, "text/plain", "not found");
    return;
  }
  const ext = extname(abs).toLowerCase();
  const cache = rel.startsWith("vendor/") ? "public, max-age=86400" : "no-store";
  send(res, 200, MIME[ext] || "application/octet-stream", readFileSync(abs), { cache });
}

function lanAddrs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

async function onRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/api/status") {
    send(res, 200, "application/json", JSON.stringify({ ...lastStatus, preview: publicPreview() }));
    return;
  }

  if (path === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    addViewer(res);
    req.on("close", () => removeViewer(res));
    return;
  }

  if (path === "/api/model") {
    const name = url.searchParams.get("name") || lastStatus.detail?.printFileName;
    if (!name) { send(res, 404, "application/json", JSON.stringify({ error: "no job" })); return; }
    try {
      const rec = getToolpath(name);
      if (!rec) {
        send(res, 404, "application/json", JSON.stringify({ error: "gcode not found locally", name }));
        return;
      }
      send(res, 200, "application/octet-stream", rec.buf, {
        headers: {
          "X-Model-Name": encodeURIComponent(basename(rec.file)),
          "X-Layer-Count": String(rec.meta.layerCount),
        },
      });
    } catch (e) {
      send(res, 500, "application/json", JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (path === "/api/model-meta") {
    const name = url.searchParams.get("name") || lastStatus.detail?.printFileName;
    if (!name) { send(res, 404, "application/json", JSON.stringify({ error: "no job" })); return; }
    const rec = getToolpath(name);
    if (!rec) { send(res, 404, "application/json", JSON.stringify({ error: "gcode not found locally", name })); return; }
    send(res, 200, "application/json", JSON.stringify({ name: basename(rec.file), ...rec.meta }));
    return;
  }

  if (path === "/api/preview" && req.method === "GET") {
    send(res, 200, "application/json", JSON.stringify(publicPreview()));
    return;
  }

  if (path === "/api/preview/stl" && req.method === "GET") {
    if (!existsSync(PREVIEW_STL)) { send(res, 404, "text/plain", "no preview"); return; }
    send(res, 200, "model/stl", readFileSync(PREVIEW_STL));
    return;
  }

  if (path === "/api/preview" && req.method === "POST") {
    if (!isLoopback(req)) { send(res, 403, "text/plain", "preview upload is local only"); return; }
    let body;
    try { body = await readJson(req); }
    catch (e) { send(res, 400, "application/json", JSON.stringify({ error: String(e.message || e) })); return; }
    const stl = resolve(String(body.stl || ""));
    if (!stl || !existsSync(stl) || extname(stl).toLowerCase() !== ".stl") {
      send(res, 400, "application/json", JSON.stringify({ error: "stl path required" }));
      return;
    }
    if (resolve(stl) !== resolve(PREVIEW_STL)) copyFileSync(stl, PREVIEW_STL);
    previewState = {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      status: "pending",
      name: String(body.name || basename(stl, ".stl")),
      src: stl,
      setAt: new Date().toISOString(),
      decidedAt: null,
    };
    savePreview();
    console.log(`preview pending: ${previewState.name}`);
    broadcast();
    send(res, 200, "application/json", JSON.stringify(publicPreview()));
    return;
  }

  if (path === "/api/preview/decide" && req.method === "POST") {
    let body;
    try { body = await readJson(req); }
    catch (e) { send(res, 400, "application/json", JSON.stringify({ error: String(e.message || e) })); return; }
    const action = body.action === "approve" ? "approved" : body.action === "reject" ? "rejected" : "";
    if (!action) { send(res, 400, "application/json", JSON.stringify({ error: "action must be approve or reject" })); return; }
    if (previewState.status !== "pending" || (body.id && body.id !== previewState.id)) {
      send(res, 409, "application/json", JSON.stringify({ error: "no pending preview", ...publicPreview() }));
      return;
    }
    previewState = { ...previewState, status: action, decidedAt: new Date().toISOString() };
    savePreview();
    console.log(`preview ${action}: ${previewState.name}`);
    broadcast();
    send(res, 200, "application/json", JSON.stringify(publicPreview()));
    return;
  }

  if (path === "/api/info") {
    send(res, 200, "application/json", JSON.stringify({
      port: CFG.port,
      printerIp: CFG.ip,
      urls: ["127.0.0.1", ...lanAddrs()].map((a) => `http://${a}:${CFG.port}`),
      viewOnly: true,
      viewers: clients.size,
      polling: Boolean(pollTimer),
      printerHits,
      preview: publicPreview(),
    }));
    return;
  }

  if (req.method === "GET") {
    serveStatic(path, res);
    return;
  }

  send(res, 405, "text/plain", "method not allowed");
}

for (const dir of CFG.gcodeDirs) {
  if (!existsSync(dir)) continue;
  try {
    watch(dir, { persistent: false }, () => toolCache.clear());
  } catch { /* watch is optional */ }
}

function listenOn(port) {
  const s = http.createServer(onRequest);
  s.on("error", (e) => {
    console.error(`Could not listen on ${port}: ${e.code || e.message}`);
  });
  s.listen(port, "0.0.0.0", () => {
    const hosts = ["127.0.0.1", ...lanAddrs()];
    for (const a of hosts) {
      const shown = port === 80 ? `http://${a}` : `http://${a}:${port}`;
      console.log(`  ${shown}`);
    }
  });
  return s;
}

console.log("Adventurer 5M dashboard (view only)");
listenOn(CFG.port);
listenOn(80);
console.log(`Printer ${CFG.ip}:${PORT_PRINTER} is queried only while a dashboard tab is open.`);
