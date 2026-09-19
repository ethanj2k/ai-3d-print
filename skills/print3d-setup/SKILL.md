---
name: print3d-setup
description: Install everything needed to design and 3D print with an AI agent — OpenSCAD, the BOSL2 library, FlashForge Flash Studio, the openscad MCP server, and the LAN printer dashboard. Use when the print3d skill is present but its tools are missing, when setting up a new machine, or when the user asks to set up 3D printing.
---

# Set up prompt-to-print

Installs the toolchain the `print3d` skill needs. Run once per machine. Repo: `github.com/ethanj2k/ai-3d-print`. Clone it if it is not already on disk.

Do each step, verify it, then move on. Report what failed rather than continuing past it.

## 0. Check what is already there

Skip anything already working. Re-running this should be safe.

## 1. OpenSCAD

Install it. Prefer a package manager (`winget` on Windows, `brew` on macOS, the distro package or AppImage on Linux).
Use a **recent snapshot/nightly**, not the 2021.01 stable — BOSL2 needs it.

Snapshot URLs rotate and go 404. Read the index at `files.openscad.org/snapshots/` and pick the newest, rather than guessing a filename. Nightlies are unsigned; that is expected.

Verify: the binary answers `--version`. Note its full path.

## 2. BOSL2

Clone `github.com/BelfrySCAD/BOSL2` into OpenSCAD's user library folder:

- Windows `~/Documents/OpenSCAD/libraries/BOSL2`
- macOS `~/Documents/OpenSCAD/libraries/BOSL2`
- Linux `~/.local/share/OpenSCAD/libraries/BOSL2`

Verify: `std.scad` exists.

If the folder is inside OneDrive or iCloud, warn the user — cloud sync can dehydrate the files and includes then fail.

## 3. Flash Studio

FlashForge's slicer, from `flashforge.com/pages/flash-studio-desktop`. Formerly Orca-Flashforge; package managers usually carry the stale old name, so download from the vendor.

It is a GUI installer with no silent flag — launch it and let the user click through. Note the install path and the bundled profile folder.

Skip if the user has no FlashForge printer, and tell them slicing and printing will not work.

## 4. The MCP server

Needs Node 18+. `skills/print3d/scripts/openscad-mcp.mjs` ships beside the `print3d` skill. Zero dependencies.

Put it somewhere stable. Leaving it in the skill folder is fine and keeps the bundle portable.

## 5. Register it

Register as a **stdio** server named `openscad`, command `node`, argument the script path, for every agent the user has:

- Claude — `claude mcp add`, user scope
- Grok — `grok mcp add`, user scope
- Codex — an `[mcp_servers.openscad]` table in its `config.toml`
- Cursor / others — that agent's own MCP config

If a tool runs several agents from separate home directories, each one needs its own entry. Back up a config before editing it.

Pass paths that differ from the defaults as environment variables on the MCP server:

- `OPENSCAD_BIN` — OpenSCAD binary
- `FLASHSTUDIO_BIN` — Flash Studio executable
- `FLASHSTUDIO_PROFILES` — its bundled `profiles/Flashforge` folder

Do **not** put printer IP, serial, or check code in MCP env.

Verify: the agent lists the server as connected and can see `dash_preview` and `dash_await`.

## 6. Connect the printer

Needed only for printing and the dashboard. Slicing works without it.

On the printer, enable LAN mode and read off its **IP address, serial number and check code**.

Copy `printer.example.json` to `printer.json` at the **repo root** and fill those three fields. That is the only place they live — the MCP server and the dashboard both read it.

Ask the user for these — they are on the printer's screen and cannot be discovered. The `printer_discover` tool finds the IP, but not the other two.

## 7. Dashboard

Copy `printer-dashboard/config.example.json` to `printer-dashboard/config.json` and set `gcodeDirs` to the folder that holds local `.gcode` files.

Start it with `printer-dashboard/run-dashboard.cmd` (or `node server.js` from that folder). It should listen on port 3470 and port 80, view-only. It must never send print, pause, cancel, or upload to the printer. It queries the printer only while a dashboard tab is open.

Verify: `http://127.0.0.1:3470` loads. Tell the user the LAN URL (`http://<this-pc>`).

## 8. Prove it works

End to end, using the MCP tools only:

1. Render a small BOSL2 shape. An image must come back.
2. Export it to STL. Must report manifold and a size that fits.
3. Slice it. Must report a print time.
4. If the printer is configured, read its status.
5. If the dashboard is running, `dash_preview` that STL. Confirm the dashboard Preview tab can show it. Do not print.

Report which steps passed. Then tell the user to restart their agent so the server loads, and that `print3d` is ready.

## Notes

- Symlink the skill folders rather than copying, so all agents share one file. Claude, Codex, Grok, and Cursor should point at the same `print3d` and `print3d-setup`.
- The slicer is a GUI-subsystem binary: it writes to a redirected stdout only, so its CLI looks silent when run from a terminal. That is normal.
