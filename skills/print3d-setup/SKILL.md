---
name: print3d-setup
description: Install everything needed to design and 3D print with an AI agent — OpenSCAD, the BOSL2 library, FlashForge Flash Studio, the openscad MCP server, and the LAN printer dashboard. Use when the print3d skill is present but its tools are missing, when setting up a new machine, or when the user asks to set up 3D printing.
---

# Set up prompt-to-print

Installs the toolchain the `print3d` skill needs. Run once per machine.
Repo: `github.com/ethanj2k/ai-3d-print`. Clone it if it is not already on disk.

Do each step, verify it, then move on. Report what failed rather than
continuing past it.

## The shape of this

Two directories, and they stay separate:

```
<repo>/                  the tool — cloned, public, same for everyone
  skills/                print3d, print3d-setup, the MCP server
  dashboard/             the review dashboard, RUN FROM HERE
  printer.json           this machine's printer login (gitignored)

<library>/               the user's models — private, theirs
  projects/<slug>/       one directory per job: .scad, .stl, .gcode, renders
  dashboard.db           SQLite store, sits with the data it describes
```

The repo is public and gets handed to other people. **Never put the user's
models inside it, and never copy the dashboard into the library.** One copy of
the dashboard, in the repo, pointed at a library by `dashboard/config.json`.
Two copies drift apart within a day.

## 0. Check what is already there

Skip anything already working. Re-running this should be safe.

Then ask the one thing you cannot guess: **where should the library live?**
If they already have a folder of `.scad`/`.stl` files, offer to use it — step 8
tidies it into projects. Otherwise suggest a sibling of the repo.

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

`skills/print3d/scripts/openscad-mcp.mjs`, in the repo. Zero dependencies,
Node 18+.

Leave it in the skill folder — that keeps the bundle portable and means one
file serves every agent.

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

Do **not** put printer IP, serial, or check code in MCP env. They go in
`printer.json` and nowhere else (step 6).

Verify: the agent lists the server as connected and can see `project_create`, `item_add`, `item_await`, `queue_add` and `queue_await`.

Already-running agent sessions keep the **old** tool list until restarted. If
tools are missing after registering, that is why.

## 6. Connect the printer

Needed only for printing and the dashboard. Slicing works without it.

On the printer, enable LAN mode and read off its **IP address, serial number and check code**.

Copy `printer.example.json` to `printer.json` at the **repo root** and fill those three fields. That is the only place they live — the MCP server and the dashboard both read it.

Ask the user for these — they are on the printer's screen and cannot be discovered. The `printer_discover` tool finds the IP, but not the other two.

## 7. Dashboard

The review surface: projects, approvals, the print queue and print history.

**Node 22 or newer**, for `node:sqlite`. Do not assume the Node on PATH is new
enough — a machine can easily have Node 20 in `C:\Program Files\nodejs` and
Node 24 elsewhere, and the one that wins is rarely the one you expect.

`run-dashboard.cmd` handles this: it runs `--version` on each candidate and
takes the first that reports major ≥ 22, rather than trusting a path. If none
qualifies it says so and stops. If Node is installed somewhere unusual on this
machine, add that path to the candidate list at the top of the file.

The server independently refuses to start on anything older, with a message
naming the version and the binary — so a wrong Node shows up as one clear line,
not a module-loader stack trace.

Copy `dashboard/config.example.json` to `dashboard/config.json` and set:

- `library` — the library root from step 0
- `projectsRoot` — `<library>/projects`
- `gcodeDirs` — where local `.gcode` lives (the library root is usually right)
- `pollMs` — how often to read the printer while auto-refresh is on

With no config at all it falls back to a `library/` folder beside the checkout,
so a bare clone still runs.

Start it with `dashboard/run-dashboard.cmd` (or `node server.js` from that
folder). It listens on 3470 **and 80** — port 80 so a phone can reach it
without typing a port. **View only**: it must never send print, pause, cancel
or upload. It reads the printer only while a tab has auto-refresh switched on;
with the toggle off it makes no requests at all except the manual Refresh
button.

To start it at boot, use **one** scheduled task pointing at `run-hidden.vbs`.
Two tasks — or one task with both a startup *and* a logon trigger — start two
supervisor loops that race for ports 3470/80, and the loser restarts forever.

Verify: `http://127.0.0.1:3470` loads, and `/api/info` reports the
`projectsRoot` and `db` you expect.

## 8. Existing models

If the user already had a pile of loose `.scad`/`.stl`/`.gcode`, sort it:

```
node dashboard/migrate.js            # prints the plan, changes nothing
node dashboard/migrate.js --apply    # groups into projects, seeds the database
```

Show them the dry-run output and get agreement before `--apply`. It groups by
filename stem, so variants of one part land in one project.

## 9. Reach it from a phone

This is where setups usually fail, and it is never the dashboard's fault.

- **Windows firewall.** Allow inbound 3470 and 80 on **every** profile,
  including Public. Windows marks most Wi-Fi as Public and silently drops
  inbound connections on it. A rule that only covers Private looks correct and
  blocks the phone.
- **Give them the whole URL**, typed by hand: `http://<lan-ip>` — with the
  `http://`. Phone browsers hide the scheme, try HTTPS first, and autocomplete
  to the wrong thing. An HTTPS attempt hangs on a blank page.
- **Same network.** Guest/IoT SSIDs often have client isolation, which blocks
  phone→PC no matter what the firewall says.

Verify by loading it on the phone, not by assuming. Then tell them the URL.

## 10. Prove it works

End to end, using the MCP tools only:

1. Render a small BOSL2 shape. An image must come back.
2. Export it to STL. Must report manifold and a size that fits.
3. Slice it. Must report a print time.
4. If the printer is configured, read its status.
5. If the dashboard is running: `project_create` a throwaway project,
   `item_add` that STL to it, and confirm it appears under Projects with the
   3D model loading. Do not print. Delete the test project and its directory
   afterwards.

Report which steps passed. Then tell the user to restart their agent so the
server loads, and that `print3d` is ready.

## Notes

- Symlink the skill folders rather than copying, so all agents share one file. Claude, Codex, Grok, and Cursor should point at the same `print3d` and `print3d-setup`.
- The slicer is a GUI-subsystem binary: it writes to a redirected stdout only, so its CLI looks silent when run from a terminal. That is normal.
- The database is SQLite in WAL mode. To move or back up `dashboard.db`, take
  the `-wal` file with it, or run `PRAGMA wal_checkpoint(TRUNCATE)` first.
  Recent writes live in the WAL until checkpointed — copying the `.db` alone
  silently loses them.
