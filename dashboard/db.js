// SQLite store for projects, items, revisions, queue and print history.
// node:sqlite is built into Node 22+, so this has no external dependency.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ITEM_STATUS = ["draft", "pending", "approved", "rejected", "printed", "failed"];
export const QUEUE_STATE = ["waiting", "ready", "printing", "done", "failed", "skipped"];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  dir         TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS revisions (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rev           INTEGER NOT NULL,
  stl_path      TEXT,
  scad_path     TEXT,
  gcode_path    TEXT,
  layer_count   INTEGER,
  est_seconds   INTEGER,
  filament_g    REAL,
  filament_type TEXT,
  note          TEXT NOT NULL DEFAULT '',
  decision      TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT NOT NULL DEFAULT '',
  decided_at    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (item_id, rev)
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES items(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT 'user',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS project_tags (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag_id)
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE IF NOT EXISTS queue (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  revision_id INTEGER REFERENCES revisions(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'waiting',
  note        TEXT NOT NULL DEFAULT '',
  released_at TEXT,
  started_at  TEXT,
  ended_at    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prints (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER REFERENCES items(id) ON DELETE SET NULL,
  revision_id   INTEGER REFERENCES revisions(id) ON DELETE SET NULL,
  queue_id      INTEGER REFERENCES queue(id) ON DELETE SET NULL,
  gcode_name    TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  result        TEXT NOT NULL DEFAULT 'running',
  layers        INTEGER,
  last_layer    INTEGER,
  est_seconds   INTEGER,
  actual_seconds INTEGER,
  filament_g    REAL,
  filament_type TEXT,
  outcome       TEXT,
  outcome_note  TEXT NOT NULL DEFAULT '',
  seen_at       TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_project  ON items(project_id);
CREATE INDEX IF NOT EXISTS idx_rev_item       ON revisions(item_id);
CREATE INDEX IF NOT EXISTS idx_queue_position ON queue(position);
CREATE INDEX IF NOT EXISTS idx_prints_started ON prints(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_item     ON notes(item_id);
`;

export function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

export const now = () => new Date().toISOString();

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
  }

  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args) ?? null; }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // --- settings ----------------------------------------------------------

  setting(key, fallback = null) {
    const r = this.get("SELECT value FROM settings WHERE key = ?", key);
    return r ? r.value : fallback;
  }

  setSetting(key, value) {
    this.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, String(value),
    );
  }

  // --- projects ----------------------------------------------------------

  createProject({ name, dir, slug, notes = "", tags = [] }) {
    const ts = now();
    const s = this.uniqueProjectSlug(slug || slugify(name));
    const r = this.run(
      "INSERT INTO projects (slug, name, dir, notes, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'active', ?, ?)",
      s, name, dir, notes, ts, ts,
    );
    const id = Number(r.lastInsertRowid);
    this.setTags("project", id, tags);
    return this.project(id);
  }

  uniqueProjectSlug(base) {
    let s = base, n = 2;
    while (this.get("SELECT id FROM projects WHERE slug = ?", s)) s = `${base}-${n++}`;
    return s;
  }

  project(idOrSlug) {
    const p = Number.isInteger(idOrSlug) || /^\d+$/.test(String(idOrSlug))
      ? this.get("SELECT * FROM projects WHERE id = ?", Number(idOrSlug))
      : this.get("SELECT * FROM projects WHERE slug = ?", String(idOrSlug));
    if (!p) return null;
    p.tags = this.tagsFor("project", p.id);
    return p;
  }

  projects({ search = "", tag = "", includeArchived = false } = {}) {
    const rows = this.all(`
      SELECT p.*,
             (SELECT COUNT(*) FROM items i WHERE i.project_id = p.id) AS item_count,
             (SELECT COUNT(*) FROM items i WHERE i.project_id = p.id AND i.status = 'pending') AS pending_count,
             (SELECT COUNT(*) FROM items i WHERE i.project_id = p.id AND i.status = 'approved') AS approved_count
      FROM projects p
      ${includeArchived ? "" : "WHERE p.status = 'active'"}
      ORDER BY p.updated_at DESC
    `);
    const q = search.trim().toLowerCase();
    const t = tag.trim().toLowerCase();
    return rows
      .map((p) => ({ ...p, tags: this.tagsFor("project", p.id) }))
      .filter((p) => {
        if (t && !p.tags.some((x) => x.toLowerCase() === t)) return false;
        if (!q) return true;
        if (p.name.toLowerCase().includes(q) || p.notes.toLowerCase().includes(q)) return true;
        if (p.tags.some((x) => x.toLowerCase().includes(q))) return true;
        return this.all(
          "SELECT name FROM items WHERE project_id = ?", p.id,
        ).some((i) => i.name.toLowerCase().includes(q));
      });
  }

  updateProject(id, patch) {
    const fields = [];
    const args = [];
    for (const k of ["name", "notes", "status"]) {
      if (patch[k] !== undefined) { fields.push(`${k} = ?`); args.push(patch[k]); }
    }
    if (fields.length) {
      fields.push("updated_at = ?");
      args.push(now(), id);
      this.run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, ...args);
    }
    if (patch.tags) this.setTags("project", id, patch.tags);
    return this.project(id);
  }

  touchProject(id) {
    this.run("UPDATE projects SET updated_at = ? WHERE id = ?", now(), id);
  }

  // --- items and revisions ----------------------------------------------

  createItem({ projectId, name, slug, status = "draft", tags = [] }) {
    const ts = now();
    const base = slug || slugify(name);
    let s = base, n = 2;
    while (this.get("SELECT id FROM items WHERE project_id = ? AND slug = ?", projectId, s)) {
      s = `${base}-${n++}`;
    }
    const r = this.run(
      "INSERT INTO items (project_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      projectId, s, name, status, ts, ts,
    );
    const id = Number(r.lastInsertRowid);
    this.setTags("item", id, tags);
    this.touchProject(projectId);
    return this.item(id);
  }

  item(id) {
    const it = this.get("SELECT * FROM items WHERE id = ?", Number(id));
    if (!it) return null;
    it.tags = this.tagsFor("item", it.id);
    it.revisions = this.all("SELECT * FROM revisions WHERE item_id = ? ORDER BY rev DESC", it.id);
    it.revision = it.revisions[0] || null;
    it.notes = this.all("SELECT * FROM notes WHERE item_id = ? ORDER BY created_at DESC", it.id);
    const p = this.get("SELECT slug, name FROM projects WHERE id = ?", it.project_id);
    it.projectSlug = p?.slug || "";
    it.projectName = p?.name || "";
    return it;
  }

  itemsOf(projectId) {
    return this.all("SELECT * FROM items WHERE project_id = ? ORDER BY created_at", projectId)
      .map((i) => this.item(i.id));
  }

  addRevision(itemId, data = {}) {
    const ts = now();
    const last = this.get("SELECT MAX(rev) AS m FROM revisions WHERE item_id = ?", itemId);
    const rev = (last?.m || 0) + 1;
    const r = this.run(
      `INSERT INTO revisions
        (item_id, rev, stl_path, scad_path, gcode_path, layer_count, est_seconds,
         filament_g, filament_type, note, decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      itemId, rev,
      data.stlPath || null, data.scadPath || null, data.gcodePath || null,
      data.layerCount ?? null, data.estSeconds ?? null,
      data.filamentG ?? null, data.filamentType || null,
      data.note || "", ts,
    );
    this.run("UPDATE items SET status = 'pending', updated_at = ? WHERE id = ?", ts, itemId);
    const it = this.get("SELECT project_id FROM items WHERE id = ?", itemId);
    if (it) this.touchProject(it.project_id);
    return this.get("SELECT * FROM revisions WHERE id = ?", Number(r.lastInsertRowid));
  }

  updateRevision(id, patch) {
    const fields = [];
    const args = [];
    const map = {
      stlPath: "stl_path", scadPath: "scad_path", gcodePath: "gcode_path",
      layerCount: "layer_count", estSeconds: "est_seconds",
      filamentG: "filament_g", filamentType: "filament_type", note: "note",
    };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { fields.push(`${col} = ?`); args.push(patch[k]); }
    }
    if (!fields.length) return this.get("SELECT * FROM revisions WHERE id = ?", id);
    args.push(id);
    this.run(`UPDATE revisions SET ${fields.join(", ")} WHERE id = ?`, ...args);
    return this.get("SELECT * FROM revisions WHERE id = ?", id);
  }

  decide(revisionId, decision, note = "") {
    const ts = now();
    this.run(
      "UPDATE revisions SET decision = ?, decision_note = ?, decided_at = ? WHERE id = ?",
      decision, note, ts, revisionId,
    );
    const rev = this.get("SELECT * FROM revisions WHERE id = ?", revisionId);
    if (!rev) return null;
    this.run("UPDATE items SET status = ?, updated_at = ? WHERE id = ?", decision, ts, rev.item_id);
    const it = this.get("SELECT project_id FROM items WHERE id = ?", rev.item_id);
    if (it) this.touchProject(it.project_id);
    return rev;
  }

  setItemStatus(itemId, status) {
    this.run("UPDATE items SET status = ?, updated_at = ? WHERE id = ?", status, now(), itemId);
  }

  addNote({ itemId = null, projectId = null, body, author = "user" }) {
    const r = this.run(
      "INSERT INTO notes (project_id, item_id, body, author, created_at) VALUES (?, ?, ?, ?, ?)",
      projectId, itemId, body, author, now(),
    );
    return this.get("SELECT * FROM notes WHERE id = ?", Number(r.lastInsertRowid));
  }

  // --- tags --------------------------------------------------------------

  tagId(name) {
    const n = String(name).trim().toLowerCase();
    if (!n) return null;
    const hit = this.get("SELECT id FROM tags WHERE name = ?", n);
    if (hit) return hit.id;
    return Number(this.run("INSERT INTO tags (name) VALUES (?)", n).lastInsertRowid);
  }

  setTags(kind, id, tags) {
    const table = kind === "project" ? "project_tags" : "item_tags";
    const col = kind === "project" ? "project_id" : "item_id";
    this.run(`DELETE FROM ${table} WHERE ${col} = ?`, id);
    for (const t of tags || []) {
      const tid = this.tagId(t);
      if (tid) this.run(`INSERT OR IGNORE INTO ${table} (${col}, tag_id) VALUES (?, ?)`, id, tid);
    }
  }

  tagsFor(kind, id) {
    const table = kind === "project" ? "project_tags" : "item_tags";
    const col = kind === "project" ? "project_id" : "item_id";
    return this.all(
      `SELECT t.name FROM tags t JOIN ${table} x ON x.tag_id = t.id WHERE x.${col} = ? ORDER BY t.name`,
      id,
    ).map((r) => r.name);
  }

  allTags() {
    return this.all(`
      SELECT t.name,
             (SELECT COUNT(*) FROM project_tags pt WHERE pt.tag_id = t.id) AS projects,
             (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS items
      FROM tags t ORDER BY t.name
    `).filter((t) => t.projects || t.items);
  }

  // --- queue -------------------------------------------------------------

  queue() {
    return this.all(`
      SELECT q.*, i.name AS item_name, i.slug AS item_slug, i.status AS item_status,
             p.name AS project_name, p.slug AS project_slug,
             r.gcode_path, r.stl_path, r.rev, r.est_seconds, r.filament_g, r.layer_count,
             r.decision
      FROM queue q
      JOIN items i ON i.id = q.item_id
      JOIN projects p ON p.id = i.project_id
      LEFT JOIN revisions r ON r.id = q.revision_id
      WHERE q.state NOT IN ('done', 'skipped')
      ORDER BY q.position
    `);
  }

  queueHistory(limit = 50) {
    return this.all(`
      SELECT q.*, i.name AS item_name, p.name AS project_name
      FROM queue q
      JOIN items i ON i.id = q.item_id
      JOIN projects p ON p.id = i.project_id
      WHERE q.state IN ('done', 'skipped')
      ORDER BY q.ended_at DESC LIMIT ?
    `, limit);
  }

  enqueue(itemId, revisionId = null, note = "") {
    const it = this.item(itemId);
    if (!it) throw new Error(`no item ${itemId}`);
    const rid = revisionId || it.revision?.id || null;
    const pos = (this.get("SELECT MAX(position) AS m FROM queue")?.m || 0) + 1;
    const r = this.run(
      "INSERT INTO queue (item_id, revision_id, position, state, note, created_at) " +
      "VALUES (?, ?, ?, 'waiting', ?, ?)",
      itemId, rid, pos, note, now(),
    );
    return Number(r.lastInsertRowid);
  }

  dequeue(entryId) {
    this.run("DELETE FROM queue WHERE id = ?", entryId);
  }

  reorderQueue(ids) {
    this.tx(() => {
      ids.forEach((id, i) => this.run("UPDATE queue SET position = ? WHERE id = ?", i + 1, id));
    });
  }

  queueEntry(id) {
    return this.all("SELECT * FROM queue WHERE id = ?", id)[0] || null;
  }

  // The gate the user asked for: nothing advances until they say the bed is clear.
  releaseNext(entryId = null) {
    const rows = this.queue();
    const busy = rows.find((q) => q.state === "printing" || q.state === "ready");
    if (busy) return { error: `"${busy.item_name}" is already ${busy.state}`, entry: busy };
    const next = entryId
      ? rows.find((q) => q.id === Number(entryId))
      : rows.find((q) => q.state === "waiting");
    if (!next) return { error: "nothing waiting in the queue" };
    if (next.decision !== "approved") {
      return { error: `"${next.item_name}" has not been approved yet`, entry: next };
    }
    this.run("UPDATE queue SET state = 'ready', released_at = ? WHERE id = ?", now(), next.id);
    return { entry: this.queueEntry(next.id) };
  }

  setQueueState(id, state, extra = {}) {
    const fields = ["state = ?"];
    const args = [state];
    if (extra.startedAt !== undefined) { fields.push("started_at = ?"); args.push(extra.startedAt); }
    if (extra.endedAt !== undefined) { fields.push("ended_at = ?"); args.push(extra.endedAt); }
    if (extra.note !== undefined) { fields.push("note = ?"); args.push(extra.note); }
    args.push(id);
    this.run(`UPDATE queue SET ${fields.join(", ")} WHERE id = ?`, ...args);
    return this.queueEntry(id);
  }

  // --- print history -----------------------------------------------------

  openPrint(gcodeName) {
    return this.get(
      "SELECT * FROM prints WHERE gcode_name = ? AND result = 'running' ORDER BY started_at DESC LIMIT 1",
      gcodeName,
    );
  }

  startPrint(data) {
    const r = this.run(
      `INSERT INTO prints
        (item_id, revision_id, queue_id, gcode_name, started_at, result, layers,
         last_layer, est_seconds, filament_g, filament_type, seen_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      data.itemId ?? null, data.revisionId ?? null, data.queueId ?? null,
      data.gcodeName, data.startedAt || now(),
      data.layers ?? null, data.lastLayer ?? 0, data.estSeconds ?? null,
      data.filamentG ?? null, data.filamentType || null, now(),
    );
    return this.get("SELECT * FROM prints WHERE id = ?", Number(r.lastInsertRowid));
  }

  touchPrint(id, lastLayer) {
    this.run("UPDATE prints SET last_layer = ?, seen_at = ? WHERE id = ?", lastLayer, now(), id);
  }

  endPrint(id, result, actualSeconds = null) {
    const p = this.get("SELECT * FROM prints WHERE id = ?", id);
    if (!p) return null;
    const ended = now();
    const secs = actualSeconds ??
      (Math.round((Date.parse(ended) - Date.parse(p.started_at)) / 1000) || null);
    this.run(
      "UPDATE prints SET result = ?, ended_at = ?, actual_seconds = ? WHERE id = ?",
      result, ended, secs, id,
    );
    if (p.item_id) {
      this.setItemStatus(p.item_id, result === "completed" ? "printed" : "failed");
    }
    if (p.queue_id) {
      this.setQueueState(p.queue_id, result === "completed" ? "done" : "failed", { endedAt: ended });
    }
    return this.get("SELECT * FROM prints WHERE id = ?", id);
  }

  setOutcome(id, outcome, note = "") {
    this.run("UPDATE prints SET outcome = ?, outcome_note = ? WHERE id = ?", outcome, note, id);
    return this.get("SELECT * FROM prints WHERE id = ?", id);
  }

  prints({ limit = 100, projectId = null, itemId = null } = {}) {
    const where = [];
    const args = [];
    if (itemId) { where.push("pr.item_id = ?"); args.push(itemId); }
    if (projectId) { where.push("i.project_id = ?"); args.push(projectId); }
    args.push(limit);
    return this.all(`
      SELECT pr.*, i.name AS item_name, i.slug AS item_slug,
             p.name AS project_name, p.slug AS project_slug
      FROM prints pr
      LEFT JOIN items i ON i.id = pr.item_id
      LEFT JOIN projects p ON p.id = i.project_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY pr.started_at DESC LIMIT ?
    `, ...args);
  }

  stats() {
    const totals = this.get(`
      SELECT COUNT(*) AS prints,
             SUM(CASE WHEN result = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN result IN ('failed', 'cancelled') THEN 1 ELSE 0 END) AS failed,
             COALESCE(SUM(filament_g), 0) AS filament_g,
             COALESCE(SUM(actual_seconds), 0) AS seconds
      FROM prints WHERE result != 'running'
    `) || {};
    const perProject = this.all(`
      SELECT p.id, p.slug, p.name,
             COUNT(pr.id) AS prints,
             COALESCE(SUM(pr.filament_g), 0) AS filament_g,
             COALESCE(SUM(pr.actual_seconds), 0) AS seconds
      FROM projects p
      LEFT JOIN items i ON i.project_id = p.id
      LEFT JOIN prints pr ON pr.item_id = i.id AND pr.result != 'running'
      GROUP BY p.id ORDER BY filament_g DESC
    `);
    return { totals, perProject };
  }
}
