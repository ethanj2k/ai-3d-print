import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";
import { STLLoader } from "/vendor/STLLoader.js";

const $ = (s) => document.querySelector(s);
const fields = {};
for (const el of document.querySelectorAll("[data-field]")) fields[el.dataset.field] = el;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function srgb(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function rgb(r, g, b) { return [srgb(r), srgb(g), srgb(b)]; }

const TYPE_RGB = {
  1: rgb(0.95, 0.46, 0.30), 2: rgb(0.98, 0.64, 0.42), 3: rgb(0.70, 0.32, 0.18),
  4: rgb(0.82, 0.58, 0.38), 5: rgb(0.96, 0.78, 0.62), 6: rgb(0.62, 0.28, 0.16),
  7: rgb(0.48, 0.22, 0.14), 8: rgb(0.72, 0.42, 0.55), 9: rgb(0.85, 0.55, 0.28),
  10: rgb(0.45, 0.52, 0.38), 11: rgb(0.40, 0.36, 0.32),
};

function decodeToolpath(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "FFTP") throw new Error("bad toolpath");
  const n = view.getUint16(6, true);
  const color = [view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)];
  const maxZ = view.getFloat32(20, true);
  const totalVertices = view.getUint32(24, true);
  const layers = [];
  let typeOff = 64 + n * 12 + totalVertices * 12;
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

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
}

const fmtG = (g) => (g == null ? "—" : `${Number(g).toFixed(Number(g) < 10 ? 2 : 0)} g`);
const fmtBytes = (n) => (n > 1e6 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

// A 27 MB toolpath takes real seconds to arrive, so report progress instead of
// leaving the stage blank.
async function fetchBuffer(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  if (!r.body || !onProgress) return r.arrayBuffer();
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}
const pctOf = (v) => {
  if (v == null || Number.isNaN(Number(v))) return 0;
  const n = Number(v);
  return n <= 1.5 ? n * 100 : n;
};

/* --- 3D stage ---------------------------------------------------------- */

class PrintScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.shown = 0;
    this.target = 0;
    this.loadedJob = "";
    this.model = null;
    this.ghostAmount = 0;
    this.mode = "print";

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

    this.scene.add(this.#bed(), this.#grid(), this.#volume());

    this.print = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true }));
    this.ghost = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false }));
    this.ghost.visible = false;
    this.hot = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true }));
    this.print.renderOrder = 2;
    this.hot.renderOrder = 3;
    this.ghost.renderOrder = 1;
    this.scene.add(this.print, this.ghost, this.hot);

    this.reviewMesh = new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xe07a45, roughness: 0.48, metalness: 0.12 }));
    this.reviewMesh.visible = false;
    this.scene.add(this.reviewMesh);

    this.ro = new ResizeObserver(() => this.#resize());
    this.ro.observe(canvas.parentElement);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  #bed() {
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(220, 220, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x1b1612, roughness: 0.72, metalness: 0.18 }));
    plate.position.z = -0.85;
    g.add(plate);
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(220, 220, 1.6)),
      new THREE.LineBasicMaterial({ color: 0x4a3a30 }));
    rim.position.z = -0.85;
    g.add(rim);
    return g;
  }

  #grid() {
    const pts = [];
    for (let i = -100; i <= 100; i += 10) {
      if (Math.abs(i) === 100) continue;
      pts.push(-100, i, 0.05, 100, i, 0.05);
      pts.push(i, -100, 0.05, i, 100, 0.05);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a241c }));
  }

  #volume() {
    const m = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(220, 220, 220)),
      new THREE.LineBasicMaterial({ color: 0x1c2228 }));
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
    let buf;
    try {
      buf = await fetchBuffer(
        `/api/model?name=${encodeURIComponent(name)}`,
        (got, total) => showLoading("slicing preview", total
          ? `${fmtBytes(got)} of ${fmtBytes(total)}`
          : fmtBytes(got)),
      );
    } catch {
      hideLoading();
      this.model = null;
      this.loadedJob = "";
      this.print.geometry = new THREE.BufferGeometry();
      this.ghost.geometry = new THREE.BufferGeometry();
      this.hot.geometry = new THREE.BufferGeometry();
      throw new Error("no local gcode");
    }
    showLoading("building toolpath", name);
    // Let the overlay paint before the synchronous decode locks the thread.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    this.model = decodeToolpath(new Uint8Array(buf));
    this.loadedJob = name;
    this.#buildGeometry();
    this.shown = 0;
    this.#frameModel();
    hideLoading();
  }

  #frameModel() {
    const pos = this.print.geometry.getAttribute("position");
    if (!pos || !pos.count) return;
    this.#frameBox(new THREE.Box3().setFromBufferAttribute(pos));
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

  #buildGeometry() {
    const { layers, prefix, meta } = this.model;
    const pos = new Float32Array(meta.totalVertices * 3);
    const col = new Float32Array(meta.totalVertices * 3);
    let o = 0;
    for (const L of layers) {
      pos.set(L.positions, o * 3);
      for (let i = 0; i < L.vertexCount; i++) {
        const c = TYPE_RGB[L.types[i]] || TYPE_RGB[1];
        col[(o + i) * 3] = c[0];
        col[(o + i) * 3 + 1] = c[1];
        col[(o + i) * 3 + 2] = c[2];
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

  setGhost(pct) {
    this.ghostAmount = Math.max(0, Math.min(1, Number(pct) / 100));
    this.ghost.material.opacity = this.ghostAmount;
    if (this.model) this.#applyShown(this.shown);
  }

  setMode(mode) {
    this.mode = mode === "review" ? "review" : "print";
    this.#applyMode();
  }

  async loadStl(url, label = "") {
    const buf = await fetchBuffer(url, (got, total) => showLoading("loading model", total
      ? `${fmtBytes(got)} of ${fmtBytes(total)}`
      : fmtBytes(got)));
    showLoading("building mesh", label);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const geo = new STLLoader().parse(buf);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
    geo.computeBoundingBox();
    this.reviewMesh.geometry.dispose();
    this.reviewMesh.geometry = geo;
    this.#frameBox(geo.boundingBox);
    this.#applyMode();
    hideLoading();
    const s = geo.boundingBox.getSize(new THREE.Vector3());
    return { x: s.x, y: s.y, z: s.z };
  }

  clearStl() {
    this.reviewMesh.geometry.dispose();
    this.reviewMesh.geometry = new THREE.BufferGeometry();
    this.reviewMesh.visible = false;
  }

  frameCurrent() {
    if (this.mode === "review") {
      const pos = this.reviewMesh.geometry.getAttribute("position");
      if (!pos?.count) return;
      this.reviewMesh.geometry.computeBoundingBox();
      this.#frameBox(this.reviewMesh.geometry.boundingBox);
      return;
    }
    this.#frameModel();
  }

  #applyMode() {
    const review = this.mode === "review";
    this.print.visible = !review;
    this.ghost.visible = !review && this.ghost.visible;
    this.hot.visible = !review && this.hot.visible;
    this.reviewMesh.visible = review && Boolean(this.reviewMesh.geometry.getAttribute("position")?.count);
  }

  setTargetLayer(layer) {
    if (!this.model) return;
    this.target = Math.max(0, Math.min(Number(layer) || 0, this.model.meta.layerCount));
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
    this.#applyMode();
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

    let rest = prefix[maxL] - verts;
    if (rest < 0) rest = 0;
    rest &= ~1;
    this.ghost.geometry.setDrawRange(verts, rest);
    this.ghost.visible = this.ghostAmount > 0.004 && rest > 0;
    this.ghost.material.opacity = this.ghostAmount;

    const hotIndex = Math.max(0, Math.min(Math.ceil(this.target) - 1, maxL - 1));
    this.#paintHot(hotIndex, this.target >= 1 && Math.abs(this.shown - this.target) < 0.8);
  }

  #paintHot(index, on) {
    if (!on || !this.model || index < 0) { this.hot.visible = false; return; }
    const L = this.model.layers[index];
    if (!L) { this.hot.visible = false; return; }
    if (this.hot.userData.index === index) { this.hot.visible = true; return; }
    const col = new Float32Array(L.vertexCount * 3);
    const c = rgb(1, 0.93, 0.78);
    for (let i = 0; i < L.vertexCount; i++) {
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
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

/* --- state ------------------------------------------------------------- */

const loadingEl = $("#loading");
const loadingText = $("#loading-text");
const loadingSub = $("#loading-sub");

function showLoading(text = "loading model", sub = "") {
  loadingText.textContent = text;
  loadingSub.textContent = sub;
  loadingEl.hidden = false;
}

function hideLoading() {
  loadingEl.hidden = true;
}

const scene = new PrintScene($("#view"));
const note = $("#stage-note");
const rail = $("#progress-rail");
const stateEl = $(".state");
const modesEl = $("#modes");

const state = {
  view: "print",
  status: { online: false, detail: null },
  queue: [],
  pendingReviews: [],
  project: null,     // open project detail
  item: null,        // item under review
  search: "",
  tag: "",
  live: localStorage.getItem("autoRefresh") !== "0",
  pollMs: 2000,
};

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

/* --- prompt sheet ------------------------------------------------------ */

const sheet = $("#sheet");
let sheetResolve = null;

function ask(title, placeholder = "", initial = "") {
  $("#sheet-title").textContent = title;
  const input = $("#sheet-input");
  input.placeholder = placeholder;
  input.value = initial;
  sheet.hidden = false;
  input.focus();
  return new Promise((res) => { sheetResolve = res; });
}

function closeSheet(value) {
  sheet.hidden = true;
  const r = sheetResolve;
  sheetResolve = null;
  if (r) r(value);
}

$("#sheet-cancel").addEventListener("click", () => closeSheet(null));
$("#sheet-ok").addEventListener("click", () => closeSheet($("#sheet-input").value.trim()));
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(null); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sheet.hidden) closeSheet(null);
});

/* --- view routing ------------------------------------------------------ */

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  const navView = view === "review" ? "projects" : view;
  for (const b of modesEl.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.view === navView);
  }
  scene.setMode(view === "review" ? "review" : "print");
  scene.frameCurrent();
  render();
}

for (const b of modesEl.querySelectorAll("button")) {
  b.addEventListener("click", () => {
    if (b.dataset.view === "projects") { state.project = null; state.item = null; }
    setView(b.dataset.view);
    if (b.dataset.view === "history") loadHistory();
  });
}

/* --- auto refresh ------------------------------------------------------ */

const liveToggle = $("#live-toggle");
const refreshNote = $("#refresh-note");

function paintRefresh() {
  liveToggle.setAttribute("aria-checked", state.live ? "true" : "false");
  refreshNote.textContent = state.live
    ? `polling every ${Math.round(state.pollMs / 1000)}s`
    : `paused — ${state.status.ts ? `read ${fmtWhen(new Date(state.status.ts).toISOString())}` : "no reading yet"}`;
}

liveToggle.addEventListener("click", () => {
  state.live = !state.live;
  localStorage.setItem("autoRefresh", state.live ? "1" : "0");
  paintRefresh();
  connectLive();          // reconnect so the server learns this viewer's choice
  if (state.live) refreshNow();
});

async function refreshNow() {
  const btn = $("#refresh-now");
  btn.disabled = true;
  btn.textContent = "…";
  try { applyState(await api("/api/refresh", { method: "POST" })); }
  catch (e) { setNote(String(e.message)); }
  finally { btn.disabled = false; btn.textContent = "Refresh"; }
}
$("#refresh-now").addEventListener("click", refreshNow);

/* --- status ------------------------------------------------------------ */

function setNote(text) {
  if (!text) { note.hidden = true; return; }
  note.hidden = false;
  note.textContent = text;
}

const setField = (k, v) => { if (fields[k]) fields[k].textContent = v; };

function applyState(msg) {
  if (!msg) return;
  state.status = msg;
  state.queue = msg.queue || [];
  state.pendingReviews = msg.pendingReviews || [];
  if (msg.pollMs) state.pollMs = msg.pollMs;

  const d = msg.detail || {};
  const online = Boolean(msg.online);
  const status = online ? (d.status || "unknown") : (msg.ts ? "offline" : "not polled");
  stateEl.dataset.state = status;
  stateEl.dataset.stale = msg.stale && !state.live ? "1" : "";
  setField("status", status);

  setField("identity", online
    ? `${d.ipAddr || ""} · fw ${d.firmwareVersion || "?"}`
    : (msg.error || "printer not read yet"));

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
  setField("noz", noz != null ? `${Number(noz).toFixed(1)}°` : "—");
  setField("nozTarget", nozT != null ? `${Number(nozT).toFixed(0)}°` : "—");
  setField("bed", d.platTemp != null ? `${Number(d.platTemp).toFixed(1)}°` : "—");
  setField("bedTarget", d.platTargetTemp != null ? `${Number(d.platTargetTemp).toFixed(0)}°` : "—");
  $("#noz-bar").style.width = `${Math.min(100, (Number(noz) || 0) / 280 * 100)}%`;
  $("#bed-bar").style.width = `${Math.min(100, (Number(d.platTemp) || 0) / 110 * 100)}%`;

  setField("filament", d.rightFilamentType || d.leftFilamentType || "—");
  setField("speed", d.currentPrintSpeed ? `${d.currentPrintSpeed} mm/s (${d.printSpeedAdjust}%)` : "—");
  setField("fan", d.coolingFanSpeed != null ? `${d.coolingFanSpeed}%` : "—");
  setField("zoff", d.zAxisCompensation != null ? `${Number(d.zAxisCompensation).toFixed(3)} mm` : "—");
  setField("nozzleModel", d.nozzleModel || "—");
  setField("fw", d.firmwareVersion || "—");
  setField("disk", d.remainingDiskSpace != null ? `${Number(d.remainingDiskSpace).toFixed(1)} GB` : "—");

  const printing = ["printing", "pause", "paused"].includes(status);

  if (state.view === "print") {
    if (!online && msg.ts) setNote("printer offline");
    else if (!msg.ts) setNote("auto refresh is off — tap Refresh for a reading");
    else if (printing && layer === 0) setNote("levelling / heating — plastic has not started");
    else setNote("");

    if (job) {
      if (job !== scene.loadedJob && !scene.model) showLoading("slicing preview", job);
      scene.loadJob(job)
        .then(() => scene.setTargetLayer(printing ? layer : scene.model?.meta.layerCount || 0))
        .catch(() => {
          hideLoading();
          setNote("no local g-code for this job — status only");
        });
    }
  }

  const badge = state.pendingReviews.length;
  modesEl.querySelector("[data-view='projects']").dataset.badge = badge ? String(badge) : "";
  const ready = state.queue.filter((q) => q.state === "waiting" || q.state === "ready").length;
  modesEl.querySelector("[data-view='queue']").dataset.badge = ready ? String(ready) : "";

  paintRefresh();
  paintUpNext();
  render();
}

function paintUpNext() {
  const el = $("#up-next");
  const next = state.queue.find((q) => q.state === "ready") ||
    state.queue.find((q) => q.state === "waiting");
  if (!next || state.view !== "print") { el.hidden = true; return; }
  const d = state.status.detail || {};
  const busy = state.status.online && ["printing", "pause", "paused"].includes(String(d.status || "").toLowerCase());
  el.hidden = false;
  el.innerHTML = `
    <div class="k">up next</div>
    <div class="next-name">${esc(next.item_name)}</div>
    <div class="tiny mono">${esc(next.project_name)} · ${next.state}</div>
    ${next.state !== "waiting"
      ? `<div class="tiny">released — waiting for the agent to slice and send it</div>`
      : busy
        ? `<div class="tiny">waiting for the current print to finish</div>`
        : `<button type="button" class="ghost-btn" data-release="${next.id}">Bed clear — release</button>`}
  `;
}

/* --- rendering --------------------------------------------------------- */

function render() {
  if (state.view === "projects") renderProjects();
  if (state.view === "queue") renderQueue();
  if (state.view === "review") renderReviewBar();
}

let projectCache = { projects: [], tags: [] };

async function loadProjects() {
  const q = new URLSearchParams();
  if (state.search) q.set("q", state.search);
  if (state.tag) q.set("tag", state.tag);
  projectCache = await api(`/api/projects?${q}`);
  renderProjects();
}

async function renderProjects() {
  const body = $("#projects-body");

  if (state.project) return renderProjectDetail(body);

  $("#tag-row").innerHTML = projectCache.tags
    .map((t) => `<button type="button" class="tag ${state.tag === t.name ? "on" : ""}" data-tag="${esc(t.name)}">${esc(t.name)}</button>`)
    .join("");

  if (!projectCache.projects.length) {
    body.innerHTML = `<p class="empty">${state.search || state.tag
      ? "Nothing matches." : "No projects yet. The agent creates one when it starts a design."}</p>`;
    return;
  }

  body.innerHTML = `<div class="cards">${projectCache.projects.map((p) => `
    <article class="card" data-project="${esc(p.slug)}">
      <div class="card-head">
        <span class="card-name">${esc(p.name)}</span>
        ${p.pending_count ? `<span class="pill" data-status="pending">${p.pending_count} to review</span>` : ""}
      </div>
      <div class="card-sub">${p.item_count} item${p.item_count === 1 ? "" : "s"} · ${p.approved_count} approved · ${fmtWhen(p.updated_at)}</div>
      ${p.notes ? `<div class="card-notes">${esc(p.notes)}</div>` : ""}
      ${p.tags.length ? `<div class="tag-row">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    </article>`).join("")}</div>`;
}

async function openProject(slug) {
  state.project = await api(`/api/projects/${encodeURIComponent(slug)}`);
  state.item = null;
  setView("projects");
}

function renderProjectDetail(body) {
  const p = state.project;
  const queuedIds = new Set(state.queue.map((q) => q.item_id));
  body.innerHTML = `
    <button type="button" class="back-link" data-back="projects">← all projects</button>
    <div class="detail-head" style="margin-top:14px">
      <div>
        <div class="detail-title">${esc(p.name)}</div>
        <div class="detail-dir">${esc(p.dir)}</div>
      </div>
      ${p.tags.length ? `<div class="tag-row">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    ${p.notes ? `<p class="card-notes" style="margin-top:10px">${esc(p.notes)}</p>` : ""}

    <div class="section-title"><span class="k">items</span></div>
    ${p.items.length ? `<div class="rows">${p.items.map((it) => {
      const r = it.revision;
      const bits = [
        r ? `v${r.rev}` : "no file",
        r?.layer_count ? `${r.layer_count} layers` : "",
        r?.est_seconds ? fmtDuration(r.est_seconds) : "",
        r?.filament_g ? fmtG(r.filament_g) : "",
      ].filter(Boolean);
      return `
      <div class="row" data-item="${it.id}">
        <div class="row-main">
          <div class="row-name">${esc(it.name)}</div>
          <div class="row-sub">${bits.join(" · ")}</div>
        </div>
        <span class="pill" data-status="${esc(it.status)}">${esc(it.status)}</span>
        <div class="row-actions">
          ${r?.stl_path ? `<button type="button" data-review="${it.id}">Review</button>` : ""}
          ${it.status === "approved" && !queuedIds.has(it.id)
            ? `<button type="button" data-enqueue="${it.id}">Queue</button>` : ""}
        </div>
      </div>`;
    }).join("")}</div>` : `<p class="empty">No items yet.</p>`}

    <div class="section-title"><span class="k">recent prints</span></div>
    ${p.prints.length ? `<div class="rows">${p.prints.map((pr) => `
      <div class="row">
        <div class="row-main">
          <div class="row-name">${esc(pr.item_name || pr.gcode_name)}</div>
          <div class="row-sub">${fmtWhen(pr.started_at)} · ${fmtDuration(pr.actual_seconds || 0)} · ${fmtG(pr.filament_g)}</div>
        </div>
        <span class="pill" data-status="${esc(pr.result)}">${esc(pr.result)}</span>
        <div class="row-actions"></div>
      </div>`).join("")}</div>` : `<p class="empty">Nothing printed yet.</p>`}
  `;
}

async function openItem(id) {
  showLoading("loading model", "");
  let it;
  try { it = await api(`/api/items/${id}`); }
  catch (e) { hideLoading(); throw e; }
  state.item = it;
  setView("review");
  scene.clearStl();
  const rev = it.revision;
  if (rev?.stl_path) {
    try {
      state.item.size = await scene.loadStl(`/api/revisions/${rev.id}/stl`, it.name);
    } catch {
      hideLoading();
      setNote("could not load that STL");
    }
  } else {
    hideLoading();
    setNote("this item has no STL to show");
  }
  renderReviewBar();
}

function renderReviewBar() {
  const it = state.item;
  const bar = $("#review-bar");
  const back = $("#review-back");
  if (!it) { bar.hidden = true; back.hidden = true; return; }
  bar.hidden = false;
  back.hidden = false;
  $("#review-where").textContent = it.projectName || "project";
  $("#review-name").textContent = it.name;
  const r = it.revision;
  const s = state.item.size;
  $("#review-meta").textContent = [
    r ? `v${r.rev}` : "",
    s ? `${s.x.toFixed(0)} × ${s.y.toFixed(0)} × ${s.z.toFixed(0)} mm` : "",
    r?.est_seconds ? fmtDuration(r.est_seconds) : "",
    r?.filament_g ? fmtG(r.filament_g) : "",
    it.status,
  ].filter(Boolean).join("  ·  ");
  const decided = it.status === "approved" || it.status === "rejected";
  $("#review-approve").textContent = it.status === "approved" ? "Approved" : "Approve";
  $("#review-approve").disabled = it.status === "approved";
  $("#review-reject").disabled = decided && it.status === "rejected";
}

async function decide(action) {
  const it = state.item;
  if (!it?.revision) return;
  let note = "";
  if (action === "reject") {
    note = await ask("What should change?", "too tall, wall too thin, …");
    if (note === null) return;
  }
  const updated = await api(`/api/items/${it.id}/decide`, {
    method: "POST",
    body: { action, revisionId: it.revision.id, note },
  });
  state.item = { ...updated, size: state.item.size };
  renderReviewBar();
  if (action === "approve") {
    setNote("approved — the agent can slice and queue it");
    setTimeout(() => { if (state.view === "review") setNote(""); }, 3000);
  }
}

$("#review-approve").addEventListener("click", () => decide("approve"));
$("#review-reject").addEventListener("click", () => decide("reject"));
$("#review-note-btn").addEventListener("click", async () => {
  const body = await ask("Note", "anything worth remembering about this part");
  if (!body) return;
  state.item = { ...await api(`/api/items/${state.item.id}/notes`, { method: "POST", body: { body } }), size: state.item.size };
  renderReviewBar();
});
$("#review-back").addEventListener("click", () => {
  state.item = null;
  scene.clearStl();
  setNote("");
  setView("projects");
});

/* --- queue ------------------------------------------------------------- */

function renderQueue() {
  const body = $("#queue-body");
  const q = state.queue;
  const printing = q.find((e) => e.state === "printing");
  const ready = q.find((e) => e.state === "ready");
  const nextWaiting = q.find((e) => e.state === "waiting");

  // The machine can be busy with a job that never came from this queue.
  const d = state.status.detail || {};
  const busy = state.status.online && ["printing", "pause", "paused"].includes(String(d.status || "").toLowerCase());

  let gate = "";
  if (printing || (busy && !ready)) {
    const what = printing ? printing.item_name : (d.printFileName || "a job");
    gate = `<div class="gate">
      <div class="gate-copy">
        <div class="gate-title">${esc(what)} is printing</div>
        <div class="gate-sub">The queue stays put until this finishes and you clear the plate.${
          printing ? "" : " This job was not started from the queue."}</div>
      </div>
    </div>`;
  } else if (ready) {
    gate = `<div class="gate">
      <div class="gate-copy">
        <div class="gate-title">${esc(ready.item_name)} is released</div>
        <div class="gate-sub">Waiting for the agent to slice and send it to the printer.</div>
      </div>
    </div>`;
  } else if (nextWaiting) {
    const blocked = nextWaiting.decision !== "approved";
    gate = `<div class="gate">
      <div class="gate-copy">
        <div class="gate-title">Next up: ${esc(nextWaiting.item_name)}</div>
        <div class="gate-sub">${blocked
          ? "This item has not been approved yet. Review it first."
          : "Peel the last part off, clean the plate and glue it. Then release."}</div>
      </div>
      <button type="button" class="go" data-release="${nextWaiting.id}" ${blocked ? "disabled" : ""}>
        Bed clear — release
      </button>
    </div>`;
  }

  body.innerHTML = gate + (q.length ? `<div class="rows">${q.map((e, i) => `
    <div class="row queue-row" data-state="${esc(e.state)}">
      <div class="queue-pos">${i + 1}</div>
      <div class="row-main">
        <div class="row-name">${esc(e.item_name)}</div>
        <div class="row-sub">${esc(e.project_name)}${e.rev ? ` · v${e.rev}` : ""}${
          e.est_seconds ? ` · ${fmtDuration(e.est_seconds)}` : ""}${
          e.filament_g ? ` · ${fmtG(e.filament_g)}` : ""}${
          e.decision !== "approved" ? " · not approved" : ""}</div>
      </div>
      <span class="pill" data-status="${esc(e.state)}">${esc(e.state)}</span>
      <div class="row-actions">
        ${i > 0 ? `<button type="button" data-up="${e.id}">↑</button>` : ""}
        <button type="button" data-remove="${e.id}">Remove</button>
      </div>
    </div>`).join("")}</div>`
    : `<p class="empty">Queue is empty. Approve an item and add it from its project.</p>`);
}

async function releaseNext(id) {
  try {
    const out = await api("/api/queue/release", { method: "POST", body: { id: Number(id) } });
    state.queue = out.queue;
    render();
    paintUpNext();
  } catch (e) {
    alert(e.message);
  }
}

/* --- history ----------------------------------------------------------- */

async function loadHistory() {
  const { prints, stats } = await api("/api/prints?limit=200");
  const t = stats.totals || {};
  $("#stat-row").innerHTML = `
    <div class="stat"><div class="k">prints</div><div class="v">${t.prints || 0}</div></div>
    <div class="stat"><div class="k">completed</div><div class="v">${t.completed || 0}</div></div>
    <div class="stat"><div class="k">failed</div><div class="v">${t.failed || 0}</div></div>
    <div class="stat"><div class="k">filament</div><div class="v">${
      t.filament_g ? `${(t.filament_g / 1000).toFixed(2)} kg` : "—"}</div></div>
    <div class="stat"><div class="k">machine time</div><div class="v">${
      t.seconds ? `${(t.seconds / 3600).toFixed(1)} h` : "—"}</div></div>`;

  $("#history-body").innerHTML = prints.length ? `<div class="rows">${prints.map((p) => `
    <div class="row">
      <div class="row-main">
        <div class="row-name">${esc(p.item_name || p.gcode_name)}</div>
        <div class="row-sub">${esc(p.project_name || "unfiled")} · ${fmtWhen(p.started_at)}${
          p.actual_seconds ? ` · ${fmtDuration(p.actual_seconds)}` : ""}${
          p.filament_g ? ` · ${fmtG(p.filament_g)}` : ""}${
          p.last_layer && p.layers ? ` · layer ${p.last_layer}/${p.layers}` : ""}${
          p.outcome ? ` · ${esc(p.outcome)}` : ""}</div>
      </div>
      <span class="pill" data-status="${esc(p.result)}">${esc(p.result)}</span>
      <div class="row-actions">
        ${p.result !== "running" && !p.outcome
          ? `<button type="button" data-outcome="${p.id}">How did it go?</button>` : ""}
      </div>
    </div>`).join("")}</div>` : `<p class="empty">No prints recorded yet.</p>`;
}

/* --- delegated clicks -------------------------------------------------- */

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-project],[data-back],[data-item],[data-review],[data-enqueue],[data-release],[data-remove],[data-up],[data-tag],[data-outcome]");
  if (!t) return;

  try {
    if (t.dataset.tag !== undefined) {
      state.tag = state.tag === t.dataset.tag ? "" : t.dataset.tag;
      return loadProjects();
    }
    if (t.dataset.back) { state.project = null; return renderProjects(); }
    if (t.dataset.review) return openItem(Number(t.dataset.review));
    if (t.dataset.enqueue) {
      await api("/api/queue", { method: "POST", body: { item: Number(t.dataset.enqueue) } });
      state.project = await api(`/api/projects/${encodeURIComponent(state.project.slug)}`);
      return renderProjects();
    }
    if (t.dataset.release) return releaseNext(t.dataset.release);
    if (t.dataset.remove) {
      const out = await api(`/api/queue/${t.dataset.remove}`, { method: "DELETE" });
      state.queue = out.queue;
      return render();
    }
    if (t.dataset.up) {
      const ids = state.queue.map((q) => q.id);
      const i = ids.indexOf(Number(t.dataset.up));
      if (i > 0) {
        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
        const out = await api("/api/queue/reorder", { method: "POST", body: { ids } });
        state.queue = out.queue;
      }
      return render();
    }
    if (t.dataset.outcome) {
      const how = await ask("How did it go?", "good / stringing / warped / failed — plus anything useful");
      if (!how) return;
      await api(`/api/prints/${t.dataset.outcome}/outcome`, {
        method: "POST",
        body: { outcome: how.split(/[\s,]/)[0].toLowerCase(), note: how },
      });
      return loadHistory();
    }
    if (t.dataset.project) return openProject(t.dataset.project);
    if (t.dataset.item) return openItem(Number(t.dataset.item));
  } catch (err) {
    alert(err.message);
  }
});

let searchTimer = null;
$("#project-search").addEventListener("input", (e) => {
  state.search = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadProjects, 180);
});

/* --- live connection --------------------------------------------------- */

let es = null;

function connectLive() {
  if (es) { es.close(); es = null; }
  if (document.hidden) return;
  es = new EventSource(`/api/events?live=${state.live ? 1 : 0}`);
  es.onmessage = (ev) => {
    try { applyState(JSON.parse(ev.data)); }
    catch { /* ignore malformed */ }
  };
  es.onerror = () => { setField("status", "dashboard reconnecting"); };
}

function disconnectLive() {
  if (!es) return;
  es.close();
  es = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) disconnectLive();
  else connectLive();
});
window.addEventListener("pagehide", disconnectLive);

/* --- ghost slider ------------------------------------------------------ */

const ghost = $("#ghost");
const ghostVal = $("#ghost-val");
function onGhost() {
  ghostVal.textContent = `${ghost.value}%`;
  scene.setGhost(ghost.value);
}
ghost.addEventListener("input", () => { scene.controls.enabled = false; onGhost(); });
ghost.addEventListener("pointerdown", () => { scene.controls.enabled = false; });
ghost.addEventListener("pointerup", () => { scene.controls.enabled = true; });
ghost.addEventListener("pointercancel", () => { scene.controls.enabled = true; });
ghost.addEventListener("change", () => { scene.controls.enabled = true; onGhost(); });

/* --- boot -------------------------------------------------------------- */

paintRefresh();
setView("print");
connectLive();
loadProjects();
api("/api/status").then(applyState).catch(() => {});
