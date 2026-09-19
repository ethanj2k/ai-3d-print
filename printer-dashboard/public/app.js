import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";
import { STLLoader } from "/vendor/STLLoader.js";

const $ = (sel) => document.querySelector(sel);
const fields = {};
for (const el of document.querySelectorAll("[data-field]")) fields[el.dataset.field] = el;

function srgb(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function rgb(r, g, b) { return [srgb(r), srgb(g), srgb(b)]; }

const TYPE_RGB = {
  1: rgb(0.95, 0.46, 0.30),
  2: rgb(0.98, 0.64, 0.42),
  3: rgb(0.70, 0.32, 0.18),
  4: rgb(0.82, 0.58, 0.38),
  5: rgb(0.96, 0.78, 0.62),
  6: rgb(0.62, 0.28, 0.16),
  7: rgb(0.48, 0.22, 0.14),
  8: rgb(0.72, 0.42, 0.55),
  9: rgb(0.85, 0.55, 0.28),
  10: rgb(0.45, 0.52, 0.38),
  11: rgb(0.40, 0.36, 0.32),
};

function decodeToolpath(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "FFTP") throw new Error("bad toolpath");
  const n = view.getUint16(6, true);
  const color = [view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)];
  const maxZ = view.getFloat32(20, true);
  const totalVertices = view.getUint32(24, true);
  const header = 64;
  const table = n * 12;
  const posBytes = totalVertices * 12;
  const layers = [];
  let typeOff = header + table + posBytes;
  const prefix = [0];
  for (let i = 0; i < n; i++) {
    const off = 64 + i * 12;
    const z = view.getFloat32(off, true);
    const vertexCount = view.getUint32(off + 4, true);
    const posOff = view.getUint32(off + 8, true);
    const positions = new Float32Array(u8.buffer, u8.byteOffset + posOff, vertexCount * 3);
    const types = u8.subarray(typeOff, typeOff + vertexCount);
    typeOff += vertexCount;
    layers.push({ z, vertexCount, positions, types });
    prefix.push(prefix[i] + vertexCount);
  }
  return { meta: { layerCount: n, maxZ, totalVertices, color }, layers, prefix };
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function pctOf(v) {
  if (v == null || Number.isNaN(Number(v))) return 0;
  const n = Number(v);
  return n <= 1.5 ? n * 100 : n;
}

class PrintScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.shown = 0;
    this.target = 0;
    this.job = "";
    this.loadedJob = "";
    this.model = null;
    this.preview = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x090a0c, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(90, -170, 120);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 0, 8);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.minPolarAngle = 0.06;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 420;
    this.clock = new THREE.Clock();

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.DirectionalLight(0xffe0c0, 1.1);
    key.position.set(80, -40, 160);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x6ea3c8, 0.25);
    fill.position.set(-120, 80, 40);
    this.scene.add(fill);

    this.scene.add(this.#bed());
    this.scene.add(this.#grid());
    this.scene.add(this.#volume());

    this.print = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    this.ghost = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.ghost.visible = false;
    this.hot = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    this.print.renderOrder = 2;
    this.hot.renderOrder = 3;
    this.ghost.renderOrder = 1;
    this.scene.add(this.print, this.ghost, this.hot);
    this.reviewMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xe07a45, roughness: 0.48, metalness: 0.12 }),
    );
    this.reviewMesh.visible = false;
    this.scene.add(this.reviewMesh);
    this.viewMode = "print";

    this.ro = new ResizeObserver(() => this.#resize());
    this.ro.observe(canvas.parentElement);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  #bed() {
    const g = new THREE.Group();
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(220, 220, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x1b1612, roughness: 0.72, metalness: 0.18 }),
    );
    plate.position.z = -0.85;
    g.add(plate);
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(220, 220, 1.6)),
      new THREE.LineBasicMaterial({ color: 0x4a3a30 }),
    );
    rim.position.z = -0.85;
    g.add(rim);
    return g;
  }

  #grid() {
    const pts = [];
    for (let i = -100; i <= 100; i += 10) {
      const edge = Math.abs(i) === 100;
      if (edge) continue;
      pts.push(-100, i, 0.05, 100, i, 0.05);
      pts.push(i, -100, 0.05, i, 100, 0.05);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a241c }));
  }

  #volume() {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(220, 220, 220));
    const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x1c2228 }));
    m.position.z = 110;
    return m;
  }

  #resize() {
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth || 1;
    const h = wrap.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  async loadJob(name) {
    if (!name) return;
    if (name === this.loadedJob && this.model) return;
    if (this._inflight === name) return this._loadP;
    this._inflight = name;
    this._loadP = this.#fetchJob(name);
    try { await this._loadP; }
    finally { if (this._inflight === name) this._inflight = ""; }
  }

  async #fetchJob(name) {
    this.job = name;
    const r = await fetch(`/api/model?name=${encodeURIComponent(name)}`);
    if (!r.ok) {
      this.model = null;
      this.print.geometry = new THREE.BufferGeometry();
      this.ghost.geometry = new THREE.BufferGeometry();
      this.hot.geometry = new THREE.BufferGeometry();
      throw new Error("no local gcode");
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    this.model = decodeToolpath(buf);
    this.loadedJob = name;
    this.#buildGeometry();
    this.shown = 0;
    this.#frameModel();
  }

  #frameModel() {
    const pos = this.print.geometry.getAttribute("position");
    if (!pos || !pos.count) return;
    const box = new THREE.Box3().setFromBufferAttribute(pos);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 20);
    this.controls.target.copy(center);
    this.camera.position.set(
      center.x + radius * 0.85,
      center.y - radius * 1.7,
      center.z + radius * 1.2,
    );
    this.controls.update();
  }

  #buildGeometry() {
    const { layers, prefix, meta } = this.model;
    const n = meta.totalVertices;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let o = 0;
    for (const L of layers) {
      pos.set(L.positions, o * 3);
      for (let i = 0; i < L.vertexCount; i++) {
        const rgb = TYPE_RGB[L.types[i]] || TYPE_RGB[1];
        col[(o + i) * 3] = rgb[0];
        col[(o + i) * 3 + 1] = rgb[1];
        col[(o + i) * 3 + 2] = rgb[2];
      }
      o += L.vertexCount;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.print.geometry.dispose();
    this.ghost.geometry.dispose();
    this.print.geometry = geo;
    const ghostGeo = new THREE.BufferGeometry();
    ghostGeo.setAttribute("position", geo.getAttribute("position"));
    ghostGeo.setAttribute("color", geo.getAttribute("color"));
    this.ghost.geometry = ghostGeo;
    this.print.userData.prefix = prefix;
  }

  setPreview(pct) {
    this.preview = Math.max(0, Math.min(1, Number(pct) / 100));
    this.ghost.material.opacity = this.preview;
    if (this.model) this.#applyShown(this.shown);
  }

  setViewMode(mode) {
    this.viewMode = mode === "preview" ? "preview" : "print";
    this.#applyViewMode();
  }

  async loadReviewStl() {
    const r = await fetch(`/api/preview/stl?t=${Date.now()}`);
    if (!r.ok) throw new Error("no preview stl");
    const geo = new STLLoader().parse(await r.arrayBuffer());
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
    this.reviewMesh.geometry.dispose();
    this.reviewMesh.geometry = geo;
    this.#frameBox(geo.boundingBox);
    this.#applyViewMode();
  }

  clearReview() {
    this.reviewMesh.geometry.dispose();
    this.reviewMesh.geometry = new THREE.BufferGeometry();
    this.reviewMesh.visible = false;
  }

  #frameBox(box) {
    if (!box) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 20);
    this.controls.target.copy(center);
    this.camera.position.set(
      center.x + radius * 0.85,
      center.y - radius * 1.7,
      center.z + radius * 1.2,
    );
    this.controls.update();
  }

  frameCurrent() {
    if (this.viewMode === "preview") {
      const pos = this.reviewMesh.geometry.getAttribute("position");
      if (!pos || !pos.count) return;
      this.reviewMesh.geometry.computeBoundingBox();
      this.#frameBox(this.reviewMesh.geometry.boundingBox);
      return;
    }
    this.#frameModel();
  }

  #applyViewMode() {
    const preview = this.viewMode === "preview";
    this.print.visible = !preview;
    this.ghost.visible = !preview && this.preview > 0.004 && this.ghost.visible;
    this.hot.visible = !preview && this.hot.visible;
    const hasMesh = !!this.reviewMesh.geometry.getAttribute("position")?.count;
    this.reviewMesh.visible = preview && hasMesh;
  }

  setTargetLayer(layer, total) {
    if (!this.model) return;
    const max = this.model.meta.layerCount;
    const live = Math.max(0, Math.min(Number(layer) || 0, max));
    this.target = live;
    this.total = total || max;
  }

  #tick() {
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.model) {
      const gap = this.target - this.shown;
      if (Math.abs(gap) < 0.01) this.shown = this.target;
      else {
        const speed = Math.abs(gap) > 2 ? Math.abs(gap) / 3.2 : 1.4;
        this.shown += Math.sign(gap) * Math.min(Math.abs(gap), speed * dt);
      }
      this.#applyShown(this.shown);
    }
    this.controls.update();
    this.#applyViewMode();
    this.renderer.render(this.scene, this.camera);
  }

  #applyShown(layerFloat) {
    const prefix = this.print.userData.prefix;
    if (!prefix) return;
    const maxL = prefix.length - 1;
    const L = Math.max(0, Math.min(layerFloat, maxL));
    const i = Math.floor(L);
    const frac = L - i;
    const next = prefix[Math.min(i + 1, maxL)] ?? prefix[i];
    let verts = prefix[i] + Math.floor(frac * (next - prefix[i]));
    verts &= ~1;
    this.print.geometry.setDrawRange(0, verts);

    const total = prefix[maxL];
    let rest = total - verts;
    if (rest < 0) rest = 0;
    rest &= ~1;
    this.ghost.geometry.setDrawRange(verts, rest);
    this.ghost.visible = this.preview > 0.004 && rest > 0;
    this.ghost.material.opacity = this.preview;

    // Hot current layer: last whole layer while catching up, or the live one.
    const hotIndex = Math.max(0, Math.min(Math.ceil(this.target) - 1, maxL - 1));
    this.#paintHot(hotIndex, this.target >= 1 && Math.abs(this.shown - this.target) < 0.8);
  }

  #paintHot(index, on) {
    if (!on || !this.model || index < 0) {
      this.hot.visible = false;
      return;
    }
    const L = this.model.layers[index];
    if (!L) { this.hot.visible = false; return; }
    if (this.hot.userData.index === index) { this.hot.visible = true; return; }
    const col = new Float32Array(L.vertexCount * 3);
    const hot = rgb(1, 0.93, 0.78);
    for (let i = 0; i < L.vertexCount; i++) {
      col[i * 3] = hot[0];
      col[i * 3 + 1] = hot[1];
      col[i * 3 + 2] = hot[2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(L.positions), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.hot.geometry.dispose();
    this.hot.geometry = geo;
    this.hot.userData.index = index;
    this.hot.visible = true;
  }
}

const scene = new PrintScene($("#view"));
const note = $("#stage-note");
const rail = $("#progress-rail");
const stateEl = $(".state");
const reviewEl = $("#review");
const modesEl = $("#modes");
const previewBtn = modesEl.querySelector("[data-mode='preview']");

let viewMode = "print";
let modePinned = false;
let previewInfo = { status: "none" };
let loadedPreviewId = "";

function printingOf(status) {
  return status === "printing" || status === "pause" || status === "paused";
}

function autoMode(printing, preview) {
  if (printing) return "print";
  if (preview?.status === "pending") return "preview";
  return "print";
}

function setMode(mode, fromUser) {
  if (fromUser) modePinned = true;
  const next = mode === "preview" ? "preview" : "print";
  const switched = next !== viewMode;
  viewMode = next;
  document.body.dataset.mode = viewMode;
  scene.setViewMode(viewMode);
  if (switched) scene.frameCurrent();
  for (const b of modesEl.querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === viewMode);
  const pending = previewInfo.status === "pending";
  reviewEl.hidden = !(viewMode === "preview" && pending);
  previewBtn.dataset.pending = pending ? "1" : "";
  if (viewMode === "preview" && previewInfo.hasStl && loadedPreviewId !== previewInfo.id) {
    loadedPreviewId = previewInfo.id || "";
    scene.loadReviewStl().catch(() => { loadedPreviewId = ""; });
  }
}

function applyPreview(preview, printing) {
  const prev = preview || { status: "none" };
  const idChanged = Boolean(prev.id && prev.id !== previewInfo.id);
  if (idChanged) {
    loadedPreviewId = "";
    scene.clearReview();
    modePinned = false;
  }
  previewInfo = prev;
  $("#review-name").textContent = prev.name || "design";
  if (!modePinned || idChanged) {
    setMode(autoMode(printing, prev), false);
  } else {
    setMode(viewMode, false);
  }
}

for (const b of modesEl.querySelectorAll("button")) {
  b.addEventListener("click", () => setMode(b.dataset.mode, true));
}

async function decide(action) {
  modePinned = false;
  await fetch("/api/preview/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, id: previewInfo.id }),
  });
}
$("#review-approve").addEventListener("click", () => decide("approve"));
$("#review-reject").addEventListener("click", () => decide("reject"));

function setNote(text) {
  if (!text) { note.hidden = true; return; }
  note.hidden = false;
  note.textContent = text;
}

function setField(key, value) {
  if (fields[key]) fields[key].textContent = value;
}

function applyStatus(msg) {
  const d = msg.detail || {};
  const online = !!msg.online;
  const status = online ? (d.status || "unknown") : "offline";
  stateEl.dataset.state = status;
  setField("status", status);

  setField("identity", online
    ? `${d.ipAddr || ""} · fw ${d.firmwareVersion || "?"}`
    : (msg.error || "printer unreachable"));

  const job = d.printFileName || "";
  setField("job", job || "no job");

  const layer = Number(d.printLayer) || 0;
  const layers = Number(d.targetPrintLayer) || 0;
  setField("layer", layer || "—");
  setField("layers", layers || "—");

  const pct = pctOf(d.printProgress);
  setField("pct", job ? `${pct.toFixed(1)}%` : "—");
  rail.style.width = job ? `${Math.min(100, pct)}%` : "0";

  setField("elapsed", job ? fmtDuration(d.printDuration) : "—");
  setField("remaining", job ? fmtDuration(d.estimatedTime) : "—");

  const noz = d.rightTemp ?? d.leftTemp;
  const nozT = d.rightTargetTemp ?? d.leftTargetTemp;
  const bed = d.platTemp;
  const bedT = d.platTargetTemp;
  setField("noz", noz != null ? `${Number(noz).toFixed(1)}°` : "—");
  setField("nozTarget", nozT != null ? `${Number(nozT).toFixed(0)}°` : "—");
  setField("bed", bed != null ? `${Number(bed).toFixed(1)}°` : "—");
  setField("bedTarget", bedT != null ? `${Number(bedT).toFixed(0)}°` : "—");
  $("#noz-bar").style.width = `${Math.min(100, (Number(noz) || 0) / 280 * 100)}%`;
  $("#bed-bar").style.width = `${Math.min(100, (Number(bed) || 0) / 110 * 100)}%`;

  setField("filament", d.rightFilamentType || d.leftFilamentType || "—");
  setField("speed", d.currentPrintSpeed
    ? `${d.currentPrintSpeed} mm/s  (${d.printSpeedAdjust}%)`
    : "—");
  setField("fan", d.coolingFanSpeed != null ? `${d.coolingFanSpeed}%` : "—");
  setField("chamberFan", d.chamberFanSpeed != null ? `${d.chamberFanSpeed}%` : "—");
  setField("zoff", d.zAxisCompensation != null ? `${Number(d.zAxisCompensation).toFixed(3)} mm` : "—");
  setField("nozzleModel", d.nozzleModel || "—");
  setField("fw", d.firmwareVersion || "—");
  setField("disk", d.remainingDiskSpace != null ? `${Number(d.remainingDiskSpace).toFixed(1)} GB` : "—");

  const printing = status === "printing" || status === "pause" || status === "paused";
  if (!online) setNote("printer offline");
  else if (printing && layer === 0) setNote("levelling / heating — plastic has not started");
  else setNote("");

  if (job) {
    scene.loadJob(job).then(() => {
      scene.setTargetLayer(printing ? layer : scene.model?.meta.layerCount || 0, layers);
    }).catch(() => {
      if (viewMode === "print") setNote("no local g-code for this job — status only");
    });
  } else if (scene.model) {
    scene.setTargetLayer(scene.model.meta.layerCount);
  }

  applyPreview(msg.preview, printing);
}

let es = null;

function connectLive() {
  if (es || document.hidden) return;
  es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try { applyStatus(JSON.parse(e.data)); }
    catch { /* ignore malformed */ }
  };
  es.onerror = () => {
    stateEl.dataset.state = "offline";
    setField("status", "dashboard reconnecting");
  };
}

function disconnectLive() {
  if (!es) return;
  es.close();
  es = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    disconnectLive();
    setField("status", "paused");
    stateEl.dataset.state = "ready";
  } else {
    connectLive();
  }
});
window.addEventListener("pagehide", disconnectLive);
document.addEventListener("freeze", disconnectLive);

connectLive();

const preview = $("#preview");
const previewVal = $("#preview-val");
function onPreview() {
  previewVal.textContent = `${preview.value}%`;
  scene.setPreview(preview.value);
}
preview.addEventListener("input", () => {
  scene.controls.enabled = false;
  onPreview();
});
preview.addEventListener("pointerdown", () => { scene.controls.enabled = false; });
preview.addEventListener("pointerup", () => { scene.controls.enabled = true; });
preview.addEventListener("pointercancel", () => { scene.controls.enabled = true; });
preview.addEventListener("change", () => {
  scene.controls.enabled = true;
  onPreview();
});
