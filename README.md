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
[BOSL2](https://github.com/BelfrySCAD/BOSL2), shows you the result from four angles, slices,
and prints.

**`print3d-setup`** — hand this to an agent on a fresh machine and it installs OpenSCAD,
BOSL2, Flash Studio, and registers the MCP server across every agent you have.

**`skills/print3d/scripts/openscad-mcp.mjs`** — the server. Node 18+, zero dependencies,
~600 lines.

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

All optional except the printer credentials, which are only needed to print.

| Variable | Meaning |
| --- | --- |
| `OPENSCAD_BIN` | OpenSCAD binary, if not at the default path |
| `FLASHSTUDIO_BIN` | Flash Studio executable |
| `FLASHSTUDIO_PROFILES` | Its bundled `profiles/Flashforge` folder |
| `PRINTER_IP` | Printer address — `printer_discover` finds it |
| `PRINTER_SERIAL` | From the printer screen, Settings → Network |
| `PRINTER_CHECKCODE` | Same screen |

Serial and check code cannot be discovered over the network. Read them off the printer.

Paths default to the standard Windows install locations. On macOS and Linux, set the three
path variables.

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
