---
name: print3d
description: Design and 3D print physical objects on a FlashForge Adventurer 5M. Use whenever the user asks to design, model, make, or print an object — "3d print me a flower", "design a bracket", "make a phone stand".
---

# Prompt to print

All tools come from the `openscad` MCP server. Use only those tools.

Work is organised into **projects**. A project is a directory under the library's
`projects/` folder plus a record on the dashboard — `project_create` returns the
exact path, so never guess it. Every model, STL and g-code for a job lives in its
project directory. The user reviews and approves each item there, and releases
each print from the queue.

## Flow

**1. Ask:** "Design only, or design and print?"

**2. Ask:** "Search online for an existing design first, or model it from scratch?"

**3. If print, ask:** "Review the design before printing?"

One question at a time. Never assume an answer.

**4. Make the project**
`project_list` first — if a fitting project already exists, use it.
Otherwise `project_create` with a clear name and the user's request as the note.
It returns a directory. Write every file for this job there.

**5a. Find online** — if they chose search
Search Printables, MakerWorld and Thingiverse. Offer a few options with names,
links and why each fits. Let them pick. Download into the project directory.
`scad_render` it by path and post the image so they see the real thing, not the
listing photo. If nothing suits, say so and offer to model it instead.

**5b. Design** — if they chose from scratch
Write OpenSCAD using BOSL2, saved in the project directory.
`scad_check` until clean. `scad_render` and look at the image.
Fix what is wrong. Repeat until it matches the request.

**6. Show** — design-only, or review = yes
`scad_export` to STL in the project directory, then put it in front of them.
Do not post review photos in chat — the dashboard is where they review.

```
item_add    project="cable-clip"  name="Clip body"  stl="...\clip_body.stl"  scad="...\clip_body.scad"
item_await  item=<id from item_add>
```

Tell them to open the dashboard → Projects → the project. Then stop and wait.

- `APPROVED` → carry on.
- `REVISE` → read their note, fix the model, `item_add` again with the **same
  project and name**. That creates revision 2 and keeps the old one. Repeat.

Design-only ends here: give the project directory, done.

Review = no: skip to 7 without pausing.

**7. Ask:** "What filament is loaded — PLA or PETG?"
Ask once per session, then remember it. Never guess.
PETG: pass it to `scad_slice` and remind them to glue-stick the plate.

**8. Slice**
`scad_slice` into the project directory. Report print time and filament used.
Then `item_add` again with the same name plus `gcode=` so the dashboard records
layers, time and grams against that item.

**9. Print**

*One part:* `printer_print` with startNow.

*More than one part:* build a queue. This is the important bit — the user has to
peel each part off, clean and glue the plate between prints.

```
queue_add    items=[12, 13, 14]        # approved items, in print order
queue_await                            # blocks until they release the next one
printer_print gcode="<path from queue_await>"  startNow=true
queue_done   entry=<entry id>
queue_await                            # blocks again for the next one
```

Never skip `queue_await`. Never start the next print because the previous one
finished — wait for the release. The dashboard refuses to release while the
printer is busy, and refuses to release an item that was never approved.

**10. Monitor**
`printer_status` on request. Report progress and time remaining.
`print_history` answers "what have I printed" and "how did that part go last time".

## Never

- Print anything the user did not ask for. Choosing print, then declining review,
  is consent — do not ask again.
- Start the next queued print without `queue_await` returning first.
- Pause or cancel a running print without asking.
- Continue past a non-manifold or oversized part.
- Scatter files in the library root — everything goes in a project directory.

## This printer

FlashForge Adventurer 5M. 220 x 220 x 220 mm. 0.4 mm nozzle.

Usually PLA, sometimes PETG. Slicing defaults to PLA — always ask, never assume.
PETG runs 255 C against PLA's 220 C, so slicing one as the other ruins the print.

PETG welds itself to the PEI plate and can tear the coating off. Remind them to
glue-stick the bed first, every time.

## Design rules

- Millimetres. Named parameters at the top, no magic numbers.
- Round edges. Sharp internal corners crack, sharp external corners lift.
- 0.2 mm clearance on holes that take a bolt or pin.
- Overhangs under 45 degrees. Design them out rather than supporting them.
- Maximise flat bed contact.
- Budget PLA under-extrudes at high speed. Slow down before blaming the model.
