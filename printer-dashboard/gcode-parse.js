// Parse Flash Studio / Orca G-code into per-layer extrusion line segments.
// Absolute XYZ, relative or absolute E. Skips travels, wipes, unretracts.

import { readFileSync } from "node:fs";

export const TYPE_IDS = {
  Custom: 1,
  "Outer wall": 2,
  "Inner wall": 3,
  "Bottom surface": 4,
  "Top surface": 5,
  "Internal solid infill": 6,
  "Sparse infill": 7,
  "Internal infill": 7,
  Infill: 7,
  "Internal Bridge": 8,
  Bridge: 8,
  Overhang: 9,
  "Overhang wall": 9,
  Support: 10,
  "Support interface": 10,
  Skirt: 11,
  Brim: 11,
};

export function parseGcode(filePath) {
  const text = readFileSync(filePath, "utf8");
  const head = text.slice(0, 8000);

  const grab = (re, fallback = "") => {
    const m = head.match(re);
    return m ? m[1].trim() : fallback;
  };

  const colorMatch = head.match(/color="#([0-9A-Fa-f]{6})"/);
  const colorHex = colorMatch ? colorMatch[1] : "E07A45";
  const color = [
    parseInt(colorHex.slice(0, 2), 16) / 255,
    parseInt(colorHex.slice(2, 4), 16) / 255,
    parseInt(colorHex.slice(4, 6), 16) / 255,
  ];

  const meta = {
    layersDeclared: Number(grab(/; total layers count = (\d+)/, "0")) ||
      Number(grab(/; total layer number: (\d+)/, "0")),
    maxZ: Number(grab(/; max_z_height: ([\d.]+)/, "0")),
    filamentType: grab(/right_extruder_material:(\w+)/) ||
      grab(/type="(\w+)"/) ||
      "",
    estimatedTime: grab(/; estimated printing time \(normal mode\) = ([^\n]+)/),
    filamentUsedG: Number(grab(/; total filament used \[g\] = ([\d.]+)/, "0")),
    filamentColor: `#${colorHex}`,
  };

  const layers = [];
  let cur = null;
  const startLayer = (z) => {
    cur = { z, xs: [], ys: [], zs: [], types: [] };
    layers.push(cur);
  };

  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true, absE = false;
  let typeId = 1;
  let wiping = false;
  let seenLayer = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line[0] === ";") {
      if (line === ";LAYER_CHANGE" || line.startsWith(";LAYER_CHANGE")) {
        seenLayer = true;
        const zLine = lines[i + 1] || "";
        const zm = zLine.match(/^;Z:(-?[\d.]+)/);
        startLayer(zm ? Number(zm[1]) : z);
        continue;
      }
      if (line === ";WIPE_START") { wiping = true; continue; }
      if (line === ";WIPE_END") { wiping = false; continue; }
      if (line.startsWith(";TYPE:")) {
        typeId = TYPE_IDS[line.slice(6).trim()] || 1;
        continue;
      }
      continue;
    }

    const cmd = line.split(";")[0].trim();
    if (!cmd) continue;
    const c0 = cmd[0];
    if (c0 === "G" || c0 === "M") {
      if (cmd === "G90") { absXYZ = true; continue; }
      if (cmd === "G91") { absXYZ = false; continue; }
      if (cmd === "M82") { absE = true; continue; }
      if (cmd === "M83") { absE = false; continue; }
      if (cmd.startsWith("G92")) {
        if (/\bE/i.test(cmd)) e = num(cmd, "E", e);
        continue;
      }
    }

    if (!cmd.startsWith("G0") && !cmd.startsWith("G1") && !cmd.startsWith("G2") && !cmd.startsWith("G3")) continue;

    const nx = num(cmd, "X", absXYZ ? x : 0);
    const ny = num(cmd, "Y", absXYZ ? y : 0);
    const nz = num(cmd, "Z", absXYZ ? z : 0);
    const ne = has(cmd, "E") ? num(cmd, "E", absE ? e : 0) : null;

    const px = absXYZ ? nx : x + nx;
    const py = absXYZ ? ny : y + ny;
    const pz = absXYZ ? nz : z + nz;
    const pe = ne == null ? e : absE ? ne : e + ne;
    const de = pe - e;
    const dx = px - x, dy = py - y;
    const dist2 = dx * dx + dy * dy;

    if (
      seenLayer &&
      cur &&
      !wiping &&
      de > 0.00005 &&
      dist2 > 0.0004
    ) {
      cur.xs.push(x, px);
      cur.ys.push(y, py);
      cur.zs.push(z, pz);
      cur.types.push(typeId, typeId);
    }

    x = px; y = py; z = pz; e = pe;
  }

  // Drop empty leading layers (homing before first real extrusion).
  const packed = [];
  let totalVertices = 0;
  let maxZ = meta.maxZ || 0;
  for (const L of layers) {
    const n = L.xs.length;
    if (!n) continue;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = L.xs[i];
      positions[i * 3 + 1] = L.ys[i];
      positions[i * 3 + 2] = L.zs[i];
    }
    packed.push({
      z: L.z,
      vertexCount: n,
      positions,
      types: Uint8Array.from(L.types),
    });
    totalVertices += n;
    if (L.z > maxZ) maxZ = L.z;
  }

  return {
    meta: { ...meta, layerCount: packed.length, maxZ, totalVertices, color },
    layers: packed,
  };
}

export function encodeToolpath(parsed) {
  const { meta, layers } = parsed;
  const n = layers.length;
  const header = 64;
  const table = n * 12;
  const posBytes = meta.totalVertices * 12;
  const typeBytes = (meta.totalVertices + 3) & ~3;
  const buf = Buffer.alloc(header + table + posBytes + typeBytes);
  buf.write("FFTP", 0, "ascii");
  buf.writeUInt16LE(1, 4);
  buf.writeUInt16LE(n, 6);
  buf.writeFloatLE(meta.color[0], 8);
  buf.writeFloatLE(meta.color[1], 12);
  buf.writeFloatLE(meta.color[2], 16);
  buf.writeFloatLE(meta.maxZ, 20);
  buf.writeUInt32LE(meta.totalVertices, 24);

  let tableOff = 64;
  let posOff = header + table;
  let typeOff = posOff + posBytes;
  for (const L of layers) {
    buf.writeFloatLE(L.z, tableOff);
    buf.writeUInt32LE(L.vertexCount, tableOff + 4);
    buf.writeUInt32LE(posOff, tableOff + 8);
    tableOff += 12;
    Buffer.from(L.positions.buffer, L.positions.byteOffset, L.positions.byteLength)
      .copy(buf, posOff);
    Buffer.from(L.types.buffer, L.types.byteOffset, L.types.byteLength)
      .copy(buf, typeOff);
    posOff += L.vertexCount * 12;
    typeOff += L.vertexCount;
  }
  return buf;
}

export function decodeToolpath(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "FFTP") throw new Error("Not a toolpath buffer");
  const n = view.getUint16(6, true);
  const color = [view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)];
  const maxZ = view.getFloat32(20, true);
  const totalVertices = view.getUint32(24, true);
  const header = 64;
  const table = n * 12;
  const posBytes = totalVertices * 12;
  const layers = [];
  let typeOff = header + table + posBytes;
  for (let i = 0; i < n; i++) {
    const off = 64 + i * 12;
    const z = view.getFloat32(off, true);
    const vertexCount = view.getUint32(off + 4, true);
    const posOff = view.getUint32(off + 8, true);
    const positions = new Float32Array(vertexCount * 3);
    const src = new Float32Array(u8.buffer, u8.byteOffset + posOff, vertexCount * 3);
    positions.set(src);
    const types = u8.slice(typeOff, typeOff + vertexCount);
    typeOff += vertexCount;
    layers.push({ z, vertexCount, positions, types });
  }
  return { meta: { layerCount: n, maxZ, totalVertices, color }, layers };
}

function has(cmd, key) {
  return cmd.toUpperCase().includes(key);
}

function num(cmd, key, fallback) {
  const m = cmd.match(new RegExp(`(?:^|\\s)${key}(-?[\\d.]+)`, "i"));
  return m ? Number(m[1]) : fallback;
}

if (process.argv[1] && process.argv[1].endsWith("gcode-parse.js") && process.argv[2]) {
  const t0 = Date.now();
  const p = parseGcode(process.argv[2]);
  console.log(JSON.stringify({
    ms: Date.now() - t0,
    layers: p.meta.layerCount,
    vertices: p.meta.totalVertices,
    maxZ: p.meta.maxZ,
    color: p.meta.filamentColor,
    time: p.meta.estimatedTime,
    bytes: encodeToolpath(p).length,
  }, null, 2));
}
