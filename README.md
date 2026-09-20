# ai-3d-print

Design and 3D print physical objects by asking for them.

> "3d print me a flower"
>
> — Design only, or design and print?
> — Search online for an existing design first, or model it from scratch?
> — Review the design before printing?

Two agent skills plus a dependency-free MCP server that takes a prompt all the way to a
running print on a **FlashForge Adventurer 5M**. Works with Claude, Codex, Grok, Cursor —
anything that speaks MCP.

## Why OpenSCAD

The model is a text file, so an LLM writes it natively — no GUI to drive, no API to bridge.
The server renders each attempt back to a PNG, so the agent *sees* what it built and fixes
its own mistakes before anything reaches the printer.

## What you get

**`print3d`** — the design-to-print flow. Asks what you want, then either searches
Printables/MakerWorld/Thingiverse or models it from scratch with
[BOSL2](https://github.com/BelfrySCAD/BOSL2), files the result in a project, waits for
your approval on the dashboard, slices, and prints.

**`print3d-setup`** — hand this to an agent on a fresh machine and it installs OpenSCAD,
BOSL2, Flash Studio, and registers the MCP server across every agent you have.

**`skills/print3d/scripts/openscad-mcp.mjs`** — the server. Node 18+, zero dependencies.

| Tool | Does |
| --- | --- |
| `scad_render` | Render to PNG and return the image. Multiple labelled angles per call. Also previews an existing `.stl`/`.3mf`/`.obj`. |
| `scad_check` | Fast syntax and geometry validation, no output file. |
| `scad_export` | Export a mesh; reports manifold status and whether it fits the build volume. |
| `scad_slice` | Slice to G-code via Flash Studio's CLI. Reports print time and filament used. |
| `printer_discover` | Find the printer by probing port 8898 across the local subnet. |
| `printer_status` | State, temperatures, layer, percent, time remaining. |
| `printer_files` | List G-code already on the printer. |
| `printer_print` | Upload and optionally start. |
| `printer_job` | Pause, resume, cancel. |
| `project_create` / `project_list` / `project_get` | A project is a directory plus a record. Everything for one job lives in it. |
| `item_add` | Add a printable part, or a new revision of one, and put it up for review. |
| `item_await` | Block until they approve it or send it back with a note. |
| `queue_add` | Queue approved items in print order. |
| `queue_await` | Block until they release the next one. |
| `queue_done` | Close out a queue entry. |
| `print_history` | Past prints, durations, filament used, lifetime totals. |

**`dashboard/`** — the LAN page you review from. **View only**: it never starts, pauses,
cancels or uploads.

- **Print** — live status and the layer-by-layer toolpath of the running job, with an
  auto-refresh toggle. Switch it off and the server makes *no* printer requests at all
  until you tap Refresh.
- **Projects** — every project and part, searchable and taggable, with revision history
  and notes. Approve or send back a part from your phone, rotating the real STL in 3D.
- **Queue** — parts queued in print order. Nothing advances on its own: you peel the last
  part off, clean and glue the plate, then release the next one. It refuses to release
  while the printer is busy, or to release a part you never approved.
- **History** — what printed, how long it took, how much filament it ate, and how it went.

State lives in SQLite (`node:sqlite`), so the dashboard needs **Node 22+**.

## Install

Point an agent at `print3d-setup` and let it do the work. Or by hand:

1. **OpenSCAD** — a recent [snapshot](https://files.openscad.org/snapshots/), not the 2021.01
   stable. BOSL2 needs it. Snapshot filenames rotate, so read the index rather than guessing.
2. **BOSL2** — clone into OpenSCAD's library folder
   (`~/Documents/OpenSCAD/libraries/BOSL2` on Windows and macOS,
   `~/.local/share/OpenSCAD/libraries/BOSL2` on Linux).
3. **Flash Studio** — from [flashforge.com](https://www.flashforge.com/pages/flash-studio-desktop).
   Only needed for slicing and printing.
4. **Skills** — copy `skills/print3d` and `skills/print3d-setup` into `~/.claude/skills/`.
   Symlink from `~/.codex/skills/` and `~/.grok/skills/` so all agents share one copy.
5. **Server** — register `node <path>/openscad-mcp.mjs` as a stdio MCP server named `openscad`.

   ```
   claude mcp add openscad --scope user -- node <path>/skills/print3d/scripts/openscad-mcp.mjs
   grok   mcp add openscad --scope user -- node <path>/skills/print3d/scripts/openscad-mcp.mjs
   ```

   Codex takes an `[mcp_servers.openscad]` table in its `config.toml`.

## Configuration

Printer **IP, serial, and check code live in one file**: copy `printer.example.json` to
`printer.json` at the repo root and fill it in. The MCP server and the dashboard both read
that file. Do not duplicate the values in agent MCP env.

| Variable | Meaning |
| --- | --- |
| `OPENSCAD_BIN` | OpenSCAD binary, if not at the default path |
| `FLASHSTUDIO_BIN` | Flash Studio executable |
| `FLASHSTUDIO_PROFILES` | Its bundled `profiles/Flashforge` folder |
| `PRINTER_CONFIG` | Optional override path to `printer.json` |

Serial and check code cannot be discovered over the network. Read them off the printer under Settings → Network (LAN mode). `printer_discover` finds the IP.

Paths default to the standard Windows install locations. On macOS and Linux, set the three path variables.

### Dashboard

Pick a **library** directory for all your 3D work and put the dashboard inside it:

```
<library>/dashboard/     copy this repo's dashboard/ here
<library>/projects/      one directory per project, created for you
```

Copy `dashboard/config.example.json` to `dashboard/config.json` and set `library`,
`projectsRoot` and `gcodeDirs`. That file is not the printer login.

Run it with `dashboard/run-dashboard.cmd` (or `start.cmd`). It listens on port 3470 and
port 80. It reads the printer only while a tab has auto-refresh on; with the toggle off
it makes no requests at all except the manual Refresh button.

Already have a pile of loose `.scad`/`.stl`/`.gcode` in the library root?
`node dashboard/migrate.js` groups them into projects and seeds the database — it prints
the plan and changes nothing until you add `--apply`.

If you start it at boot, use **one** scheduled task. Two tasks — or one task with both a
startup and a logon trigger — will race for ports 3470/80 and the loser restarts forever.

## Notes for the Adventurer 5M

The bundled profiles already get the things that silently ruin AD5M prints right — Klipper
flavor, relative E (`M83`), center origin. Absolute E with Marlin flavor deadlocks the
printer's SD parser: it stalls while still reporting `BUILDING_FROM_SD`.

- Build volume 220 × 220 × 220 mm. `scad_export` and `scad_slice` both refuse oversized parts.
- Wi-Fi uploads over ~12 MB are known to fail on this API. Use USB for large jobs.
- "600 mm/s" is travel speed. Real ceiling is ~300 mm/s, capped by 32 mm³/s nozzle flow —
  budget PLA cannot melt that fast. Slow down before blaming the model.

Printer API behaviour is derived from the community
[flashforge-api-docs](https://github.com/Parallel-7/flashforge-api-docs)
(`endpoints_5m_3.2.7.yaml`). Unofficial, and endpoints shift between firmware versions.

## Status

The design and slicing path is tested end to end: render, multi-angle review, manifold and
build-volume checks, and real G-code from the bundled 5M profiles.

The `printer_*` tools are written against the published API spec but have **not** been
exercised against hardware yet. Reports welcome.

Other FlashForge models (5M Pro, AD5X) use the same API and mostly the same profiles, but
only the 5M has been tried.

## License

MIT
