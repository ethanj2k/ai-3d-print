#!/usr/bin/env node
// OpenSCAD + Flash Studio + Adventurer 5M MCP server.
// Zero dependencies, stdio JSON-RPC 2.0. Covers prompt -> model -> render -> slice -> print -> monitor.
//
// Printer API reference: Parallel-7/flashforge-api-docs (endpoints_5m_3.2.7.yaml).
// HTTP REST on :8898, auth by serialNumber + checkCode (printer Settings -> Network, LAN mode).

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join, resolve, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const SCAD =
  process.env.OPENSCAD_BIN || "C:\\Program Files\\OpenSCAD (Nightly)\\openscad.exe";
const SLICER =
  process.env.FLASHSTUDIO_BIN || "C:\\Program Files\\Flashforge\\Flash Studio Desktop\\flash studio.exe";
const PROFILES =
  process.env.FLASHSTUDIO_PROFILES ||
  "C:\\Program Files\\Flashforge\\Flash Studio Desktop\\resources\\profiles\\Flashforge";

const PORT = 8898;

// Resolved per call, so the server follows the directory each chat was launched from.
const PROJECT = () => process.env.SCAD_PROJECT_DIR || process.cwd();

const VIEWS = {
  iso: "--camera=0,0,0,55,0,25,0 --autocenter --viewall",
  front: "--camera=0,0,0,90,0,0,0 --autocenter --viewall",
  top: "--camera=0,0,0,0,0,0,0 --autocenter --viewall",
  side: "--camera=0,0,0,90,0,90,0 --autocenter --viewall",
  back: "--camera=0,0,0,90,0,180,0 --autocenter --viewall",
};

// OpenSCAD snapshots omit fonts.conf, which makes text() fall back to a zero-width
// stroke font that renders but cannot print. Point fontconfig at the one we ship.
const FONTCONF = join(dirname(fileURLToPath(import.meta.url)), "fonts.conf");

function run(bin, args, timeoutMs = 300000) {
  return new Promise((res) => {
    const env = { ...process.env };
    if (bin === SCAD && !env.FONTCONFIG_FILE && existsSync(FONTCONF)) env.FONTCONFIG_FILE = FONTCONF;
    const p = spawn(bin, args, { windowsHide: true, env });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill(); res({ code: -1, out, err: err + "\n[timed out]" }); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); res({ code: -1, out, err: String(e) }); });
    p.on("close", (code) => { clearTimeout(timer); res({ code, out, err }); });
  });
}

const MESHES = [".stl", ".3mf", ".obj", ".off", ".amf"];

function materialize(a) {
  if (a.path) {
    const p = resolve(PROJECT(), a.path);
    if (!existsSync(p)) throw new Error(`No such file: ${p}`);
    // Meshes downloaded from a model site are not OpenSCAD source, so wrap them in
    // import() to make them renderable the same way.
    if (MESHES.includes(extname(p).toLowerCase())) {
      const f = join(mkdtempSync(join(tmpdir(), "scadimp-")), "view.scad");
      writeFileSync(f, `import("${p.replace(/\\/g, "/")}");\n`, "utf8");
      return f;
    }
    return p;
  }
  if (!a.code) throw new Error("Provide either `code` or `path`.");
  const f = join(mkdtempSync(join(tmpdir(), "scad-")), "model.scad");
  writeFileSync(f, a.code, "utf8");
  return f;
}

// Adventurer 5M build volume. Used to fail a part early rather than after slicing.
const BUILD = { x: 220, y: 220, z: 220 };

// Exact bounds from the STL. OpenSCAD writes ASCII by default but binary turns up
// from other tools, so detect by exact binary length and fall back to ASCII.
function stlBounds(file) {
  const b = readFileSync(file);
  if (b.length < 84) return null;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  const put = (x, y, z) => {
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  };
  const n = b.readUInt32LE(80);
  if (n > 0 && b.length === 84 + n * 50) {
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) put(b.readFloatLE(o + v * 12), b.readFloatLE(o + v * 12 + 4), b.readFloatLE(o + v * 12 + 8));
    }
  } else {
    const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
    const s = b.toString("utf8");
    let m, count = 0;
    while ((m = re.exec(s))) { put(+m[1], +m[2], +m[3]); count++; }
    if (!count) return null;
  }
  return { x: mxx - mnx, y: mxy - mny, z: mxz - mnz };
}

function fitReport(file) {
  const d = stlBounds(file);
  if (!d) return "";
  const over = ["x", "y", "z"].filter((k) => d[k] > BUILD[k]);
  const size = `${d.x.toFixed(1)} x ${d.y.toFixed(1)} x ${d.z.toFixed(1)} mm`;
  return over.length
    ? `Size: ${size}\nDOES NOT FIT the 220x220x220mm build volume (over on ${over.join(", ")}). Scale it down or split it.`
    : `Size: ${size}  (fits the 220x220x220mm build volume)`;
}

// OpenSCAD reports geometry problems on stderr while still exiting 0.
function diagnostics(err) {
  const lines = err.split(/\r?\n/).filter((l) =>
    /WARNING|ERROR|UNSUPPORTED|not manifold|Status:|Vertices:|Facets:|Genus:/i.test(l));
  return lines.length ? lines.join("\n") : "";
}

// --- slicing -------------------------------------------------------------

// Process profiles are not uniformly named across nozzles (0.4 has Fine/Standard/Draft,
// 0.8 only Standard), so resolve against what is on disk rather than guessing a
// filename and failing opaquely.
function resolveProfiles({ printer = "Adventurer 5M", nozzle = "0.4", quality = "standard" }) {
  const machineDir = join(PROFILES, "machine");
  const processDir = join(PROFILES, "process");
  const machine = `Flashforge ${printer} ${nozzle} Nozzle.json`;
  const machinePath = join(machineDir, machine);
  if (!existsSync(machinePath)) {
    const avail = readdirSync(machineDir).filter((f) => /Adventurer 5M/.test(f));
    throw new Error(`No machine profile "${machine}".\nAvailable:\n${avail.join("\n")}`);
  }
  const model = /Pro/.test(printer) ? "AD5M Pro" : "AD5M";
  const want = { fine: "Fine", standard: "Standard", draft: "Draft" }[String(quality).toLowerCase()];
  if (!want) throw new Error(`quality must be fine|standard|draft, got "${quality}"`);
  const candidates = readdirSync(processDir).filter(
    (f) => f.includes(`@Flashforge ${model} ${nozzle} Nozzle`) && f.includes(want));
  if (!candidates.length) {
    const forNozzle = readdirSync(processDir).filter((f) => f.includes(`@Flashforge ${model} ${nozzle} Nozzle`));
    throw new Error(
      `No "${want}" process profile for ${model} ${nozzle}mm.\nAvailable for this nozzle:\n${forNozzle.join("\n")}`);
  }
  return { machinePath, processPath: join(processDir, candidates[0]) };
}

function resolveFilament(name = "Flashforge Generic PLA") {
  const dir = join(PROFILES, "filament");
  const exact = join(dir, name.endsWith(".json") ? name : `${name}.json`);
  if (existsSync(exact)) return exact;
  const near = readdirSync(dir).filter((f) => f.toLowerCase().includes(String(name).toLowerCase()));
  throw new Error(`No filament profile "${name}".${near.length ? `\nClose matches:\n${near.slice(0, 15).join("\n")}` : ""}`);
}

// --- printer -------------------------------------------------------------

function creds(a = {}) {
  const ip = a.ip || process.env.PRINTER_IP || "";
  const serialNumber = a.serial || process.env.PRINTER_SERIAL || "";
  const checkCode = a.checkCode || process.env.PRINTER_CHECKCODE || "";
  const missing = [];
  if (!ip) missing.push("PRINTER_IP");
  if (!serialNumber) missing.push("PRINTER_SERIAL");
  if (!checkCode) missing.push("PRINTER_CHECKCODE");
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(", ")}. Set as env vars on the MCP server, or pass ip/serial/checkCode per call. ` +
      `Serial number and check code are on the printer under Settings -> Network (LAN mode). ` +
      `Use printer_discover to find the IP.`);
  }
  return { ip, serialNumber, checkCode };
}

// Raw fetch errors ("fetch failed") tell a downstream agent nothing, so name the
// likely cause and the next action instead.
function netError(e, ip) {
  const m = String(e?.cause?.code || e?.message || e);
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `Cannot resolve "${ip}". Check PRINTER_IP.`;
  if (/ECONNREFUSED/.test(m)) return `${ip} refused port ${PORT}. That host is not an Adventurer 5M, or LAN mode is off.`;
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return `${ip} is unreachable. Different network or printer powered off.`;
  if (/timeout|TimeoutError|ETIMEDOUT|aborted/i.test(m)) return `${ip} did not respond within the timeout. Printer asleep or wrong IP.`;
  return `Could not reach ${ip}:${PORT} (${m}). Run printer_discover to find the printer.`;
}

async function api(path, body, { ip, serialNumber, checkCode }) {
  let r;
  try {
    r = await fetch(`http://${ip}:${PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialNumber, checkCode, ...body }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new Error(netError(e, ip)); }
  const t = await r.text();
  let json; try { json = JSON.parse(t); } catch { throw new Error(`Non-JSON from ${path}: ${t.slice(0, 300)}`); }
  if (json.code !== undefined && json.code !== 0 && json.code !== 200) {
    throw new Error(`${path} returned code ${json.code}: ${json.message || "(no message)"}`);
  }
  return json;
}

const PIDS = { 35: "Adventurer 5M", 36: "Adventurer 5M Pro", 38: "AD5X" };

function fmtDuration(sec) {
  if (!sec || sec <= 0) return "0s";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return [h && `${h}h`, m && `${m}m`, !h && `${s}s`].filter(Boolean).join(" ");
}

function summarizeDetail(d) {
  // pid arrives as a hex string ("0023"); parse base-16 for a rename-proof model id.
  const pid = parseInt(d.pid, 16);
  const pct = d.printProgress != null ? (d.printProgress <= 1 ? d.printProgress * 100 : d.printProgress) : null;
  const L = [];
  L.push(`Printer:   ${d.name || "(unnamed)"} - ${PIDS[pid] || `pid ${d.pid}`} - fw ${d.firmwareVersion || "?"}`);
  L.push(`Status:    ${d.status}${d.errorCode && d.errorCode !== "0" ? `   ERROR ${d.errorCode}` : ""}`);
  L.push(`Nozzle:    ${d.rightTemp ?? d.leftTemp}C -> ${d.rightTargetTemp ?? d.leftTargetTemp}C  (${d.nozzleModel || "?"})`);
  L.push(`Bed:       ${d.platTemp}C -> ${d.platTargetTemp}C`);
  if (d.chamberTemp != null) L.push(`Chamber:   ${d.chamberTemp}C -> ${d.chamberTargetTemp}C`);
  if (d.printFileName) {
    L.push(`Job:       ${d.printFileName}`);
    L.push(`Progress:  ${pct != null ? pct.toFixed(1) + "%" : "?"}  layer ${d.printLayer}/${d.targetPrintLayer}`);
    L.push(`Elapsed:   ${fmtDuration(d.printDuration)}   Remaining: ${fmtDuration(d.estimatedTime)}`);
    if (d.currentPrintSpeed) L.push(`Speed:     ${d.currentPrintSpeed} mm/s (adjust ${d.printSpeedAdjust}%)`);
  }
  if (d.leftFilamentType) L.push(`Filament:  ${d.leftFilamentType}`);
  // Firmware reports a bare float with no unit. GB is the only reading consistent with
  // a working printer that still has files on it.
  if (d.remainingDiskSpace != null) L.push(`Disk free: ${Number(d.remainingDiskSpace).toFixed(2)} GB`);
  if (d.cameraStreamUrl) L.push(`Camera:    ${d.cameraStreamUrl}`);
  return L.join("\n");
}

// The UDP discovery packet format is not in the published spec, so probe TCP/8898
// across the local /24 instead - same result, nothing guessed.
function probe(ip, ms = 400) {
  return new Promise((res) => {
    const s = createConnection({ host: ip, port: PORT });
    const done = (v) => { s.destroy(); res(v); };
    s.setTimeout(ms);
    s.on("connect", () => done(ip));
    s.on("timeout", () => done(null));
    s.on("error", () => done(null));
  });
}

async function discover() {
  const bases = new Set();
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) bases.add(n.address.split(".").slice(0, 3).join("."));
    }
  }
  const hits = [];
  for (const base of bases) {
    const targets = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    for (let i = 0; i < targets.length; i += 64) {
      const found = await Promise.all(targets.slice(i, i + 64).map((t) => probe(t)));
      hits.push(...found.filter(Boolean));
    }
  }
  return { hits, scanned: [...bases].map((b) => `${b}.0/24`) };
}

// --- tools ---------------------------------------------------------------

const TOOLS = [
  {
    name: "scad_render",
    description:
      "Render OpenSCAD source to PNG images and return them, so you can visually verify the geometry " +
      "and show the user what the part looks like. Use after every edit, before exporting. Pass `views` " +
      "to get several labelled angles in one call - do that whenever the user should review the design. " +
      "Also renders an existing mesh (.stl/.3mf/.obj/.off/.amf) by path, so use it to preview a model " +
      "downloaded from a model site. BOSL2 is installed: `include <BOSL2/std.scad>`.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Inline OpenSCAD source." },
        path: { type: "string", description: "Path to a .scad file or an existing mesh, relative to the project dir." },
        view: { type: "string", enum: Object.keys(VIEWS), default: "iso", description: "Single angle." },
        views: { type: "array", items: { type: "string", enum: Object.keys(VIEWS) },
          description: 'Several angles in one call, each returned as a labelled image, e.g. ["iso","front","side","top"].' },
        size: { type: "string", default: "900,700", description: "WIDTH,HEIGHT" },
      },
    },
  },
  {
    name: "scad_check",
    description: "Fast syntax and geometry validation with no output file. Returns errors, warnings and manifold status.",
    inputSchema: { type: "object", properties: { code: { type: "string" }, path: { type: "string" } } },
  },
  {
    name: "scad_export",
    description:
      "Export OpenSCAD source to a mesh (STL/3MF/OFF) or 2D format and report whether the result is a " +
      "closed manifold solid. Non-manifold meshes will not slice correctly.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" }, path: { type: "string" },
        out: { type: "string", description: "Output filename, relative to the project dir." },
        format: { type: "string", enum: ["stl", "3mf", "off", "svg", "dxf"], default: "stl" },
      },
      required: ["out"],
    },
  },
  {
    name: "scad_slice",
    description:
      "Slice an STL/3MF into printable G-code with Flash Studio's CLI using the bundled Adventurer 5M " +
      "profiles (Klipper flavor, relative E, center origin - all correct by default). Returns estimated " +
      "print time and filament usage. Lists valid options if a requested profile does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        stl: { type: "string", description: "Path to the mesh, relative to the project dir." },
        out: { type: "string", description: "Output .gcode path. Defaults to <stl basename>.gcode" },
        printer: { type: "string", enum: ["Adventurer 5M", "Adventurer 5M Pro"], default: "Adventurer 5M" },
        nozzle: { type: "string", enum: ["0.25", "0.4", "0.6", "0.8"], default: "0.4" },
        quality: { type: "string", enum: ["fine", "standard", "draft"], default: "standard",
          description: "On a 0.4 nozzle: fine=0.12mm, standard=0.20mm, draft=0.24mm." },
        filament: { type: "string", default: "Flashforge Generic PLA",
          description: "Filament profile name. A partial name returns close matches." },
      },
      required: ["stl"],
    },
  },
  {
    name: "printer_discover",
    description:
      "Find Adventurer 5M printers by probing TCP port 8898 across the local /24 subnet(s). " +
      "Returns candidate IP addresses to use as PRINTER_IP.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "printer_status",
    description:
      "Live printer status: state, nozzle/bed temperatures, current job, layer, percent complete, elapsed " +
      "and remaining time, filament type, disk space and camera URL. Use to monitor a running print.",
    inputSchema: {
      type: "object",
      properties: {
        ip: { type: "string" }, serial: { type: "string" }, checkCode: { type: "string" },
        raw: { type: "boolean", default: false, description: "Return full JSON instead of a summary." },
      },
    },
  },
  {
    name: "printer_files",
    description: "List G-code files already stored on the printer.",
    inputSchema: { type: "object", properties: { ip: { type: "string" }, serial: { type: "string" }, checkCode: { type: "string" } } },
  },
  {
    name: "printer_print",
    description:
      "Upload a local G-code file to the printer and optionally start it. This moves a physical machine - " +
      "confirm with the user before calling with startNow=true. Leave levelBeforePrint on unless the bed " +
      "was levelled recently.",
    inputSchema: {
      type: "object",
      properties: {
        gcode: { type: "string", description: "Local .gcode path, relative to the project dir." },
        startNow: { type: "boolean", default: false, description: "Begin printing immediately after upload." },
        levelBeforePrint: { type: "boolean", default: true },
        ip: { type: "string" }, serial: { type: "string" }, checkCode: { type: "string" },
      },
      required: ["gcode"],
    },
  },
  {
    name: "printer_job",
    description:
      "Pause, resume or cancel the running print. Cancelling discards the job and cannot be undone - " +
      "confirm with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pause", "continue", "cancel"] },
        jobId: { type: "string", default: "0", description: "Job identifier; the current job is usually 0." },
        ip: { type: "string" }, serial: { type: "string" }, checkCode: { type: "string" },
      },
      required: ["action"],
    },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function call(name, a = {}) {
  if (name === "scad_render") {
    const src = materialize(a);
    const wanted = (Array.isArray(a.views) && a.views.length ? a.views : [a.view || "iso"])
      .filter((v) => VIEWS[v]);
    if (!wanted.length) return text(`views must be any of: ${Object.keys(VIEWS).join(", ")}`, true);
    const dir = mkdtempSync(join(tmpdir(), "scadpng-"));
    const content = [];
    let diag = "";
    for (const v of wanted) {
      const png = join(dir, `${v}.png`);
      const r = await run(SCAD, [...VIEWS[v].split(" "), `--imgsize=${a.size || "900,700"}`,
        "--colorscheme=Tomorrow", "-o", png, src]);
      if (!existsSync(png)) return text(`Render failed on "${v}" (exit ${r.code}):\n${r.err.slice(-4000)}`, true);
      // Label each image so the model and the user can tell the angles apart.
      content.push({ type: "text", text: `View: ${v}` });
      content.push({ type: "image", data: readFileSync(png).toString("base64"), mimeType: "image/png" });
      diag ||= diagnostics(r.err);
    }
    if (diag) content.push({ type: "text", text: `Diagnostics:\n${diag}` });
    return { content };
  }

  if (name === "scad_check") {
    const src = materialize(a);
    const r = await run(SCAD, ["-o", join(mkdtempSync(join(tmpdir(), "scadchk-")), "c.stl"), src]);
    const diag = diagnostics(r.err);
    return text(r.code === 0 ? `OK.\n${diag || "No warnings."}` : `Errors (exit ${r.code}):\n${r.err.slice(-4000)}`, r.code !== 0);
  }

  if (name === "scad_export") {
    const src = materialize(a);
    const out = resolve(PROJECT(), a.out);
    const r = await run(SCAD, ["-o", out, src]);
    const ok = existsSync(out);
    const manifold = /manifold/i.test(r.err) && !/not manifold/i.test(r.err);
    if (!ok) return text(`Export failed (exit ${r.code}):\n${r.err.slice(-4000)}`, true);
    const fit = out.toLowerCase().endsWith(".stl") ? fitReport(out) : "";
    const tooBig = fit.includes("DOES NOT FIT");
    return text([
      `Exported ${out}`,
      `Manifold (printable): ${manifold ? "yes" : "UNCONFIRMED - check diagnostics"}`,
      fit,
      diagnostics(r.err),
    ].filter(Boolean).join("\n"), tooBig);
  }

  if (name === "scad_slice") {
    const stl = resolve(PROJECT(), a.stl);
    if (!existsSync(stl)) return text(`No such mesh: ${stl}`, true);
    if (!existsSync(SLICER)) return text(`Flash Studio not found at ${SLICER}. Set FLASHSTUDIO_BIN.`, true);
    // Catch oversize meshes here too - a downloaded model never went through scad_export.
    if (extname(stl).toLowerCase() === ".stl") {
      const fit = fitReport(stl);
      if (fit.includes("DOES NOT FIT")) return text(fit, true);
    }
    const { machinePath, processPath } = resolveProfiles(a);
    const filamentPath = resolveFilament(a.filament);
    const dir = mkdtempSync(join(tmpdir(), "slice-"));
    const r = await run(SLICER, [
      "--load-settings", `${machinePath};${processPath}`,
      "--load-filaments", filamentPath,
      "--slice", "0", "--outputdir", dir, stl,
    ], 600000);
    const produced = readdirSync(dir).filter((f) => f.endsWith(".gcode") || f.endsWith(".gx"));
    if (!produced.length) {
      return text(`Slicing produced no G-code (exit ${r.code}).\n${(r.err || r.out).slice(-4000)}`, true);
    }
    const out = resolve(PROJECT(), a.out || basename(stl, extname(stl)) + ".gcode");
    renameSync(join(dir, produced[0]), out);
    const head = readFileSync(out, "utf8").slice(0, 4000).split(/\r?\n/);
    const grab = (re) => (head.find((l) => re.test(l)) || "").replace(/^;\s*/, "").trim();
    return text([
      `Sliced -> ${out}  (${(statSync(out).size / 1024).toFixed(0)} KB)`,
      `Machine:  ${basename(machinePath, ".json")}`,
      `Process:  ${basename(processPath, ".json")}`,
      `Filament: ${basename(filamentPath, ".json")}`,
      grab(/estimated printing time/i),
      grab(/total layer number/i),
      grab(/filament used \[mm\]/i),
    ].filter(Boolean).join("\n"));
  }

  if (name === "printer_discover") {
    const { hits, scanned } = await discover();
    return text(hits.length
      ? `Found ${hits.length} device(s) listening on :${PORT}:\n${hits.join("\n")}\n\nSet PRINTER_IP to the right one.`
      : `No devices answering on port ${PORT}. Scanned: ${scanned.join(", ") || "(no external IPv4 interface)"}\n` +
        `Check the printer is powered on, on the same network, and has LAN mode enabled.`);
  }

  if (name === "printer_status") {
    const c = creds(a);
    const j = await api("/detail", {}, c);
    return text(a.raw ? JSON.stringify(j, null, 2) : summarizeDetail(j.detail || {}));
  }

  if (name === "printer_files") {
    const c = creds(a);
    const j = await api("/gcodeList", {}, c);
    const list = j.gcodeList || [];
    return text(list.length ? `${list.length} file(s) on printer:\n${list.join("\n")}` : "No G-code files on the printer.");
  }

  if (name === "printer_print") {
    const c = creds(a);
    const g = resolve(PROJECT(), a.gcode);
    if (!existsSync(g)) return text(`No such G-code: ${g}`, true);
    const buf = readFileSync(g);
    const startNow = a.startNow === true;
    const leveling = a.levelBeforePrint !== false;
    const fd = new FormData();
    fd.append("gcodeFile", new Blob([buf], { type: "application/octet-stream" }), basename(g));
    let r;
    try {
      r = await fetch(`http://${c.ip}:${PORT}/uploadGcode`, {
        method: "POST",
        headers: {
          serialNumber: c.serialNumber,
          checkCode: c.checkCode,
          fileSize: String(buf.length),
          printNow: startNow ? "true" : "false",
          levelingBeforePrint: leveling ? "true" : "false",
        },
        body: fd,
        signal: AbortSignal.timeout(300000),
      });
    } catch (e) { return text(netError(e, c.ip), true); }
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { return text(`Upload returned non-JSON: ${t.slice(0, 300)}`, true); }
    if (j.code !== undefined && j.code !== 0 && j.code !== 200) {
      return text(`Upload failed, code ${j.code}: ${j.message || ""}\n` +
        `Note: uploads over ~12 MB are known to fail on this API; use USB for large jobs.`, true);
    }
    return text([
      `Uploaded ${basename(g)} (${(buf.length / 1024 / 1024).toFixed(1)} MB) to ${c.ip}`,
      startNow
        ? `Print STARTED (leveling: ${leveling ? "yes" : "no"}).`
        : `Not started. Re-run with startNow=true, or start it from the printer.`,
      `Use printer_status to monitor.`,
    ].join("\n"));
  }

  if (name === "printer_job") {
    const c = creds(a);
    await api("/control", { payload: { cmd: "jobCtl_cmd", args: { jobID: String(a.jobId ?? "0"), action: a.action } } }, c);
    return text(`Sent "${a.action}" to the current job.`);
  }

  throw new Error(`Unknown tool: ${name}`);
}

// --- stdio JSON-RPC ------------------------------------------------------
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notification

    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    const fail = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }) + "\n");

    try {
      if (msg.method === "initialize") {
        reply({
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "openscad", version: "2.0.0" },
        });
      } else if (msg.method === "tools/list") reply({ tools: TOOLS });
      else if (msg.method === "tools/call") reply(await call(msg.params?.name, msg.params?.arguments));
      else if (msg.method === "ping") reply({});
      else fail(-32601, `Method not found: ${msg.method}`);
    } catch (e) {
      // Surface tool errors as results so the model can read and recover from them.
      if (msg.method === "tools/call") reply(text(String(e?.message || e), true));
      else fail(-32603, String(e?.message || e));
    }
  }
});
