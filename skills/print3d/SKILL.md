---
name: print3d
description: Design and 3D print physical objects on a FlashForge Adventurer 5M. Use whenever the user asks to design, model, make, or print an object — "3d print me a flower", "design a bracket", "make a phone stand".
---

# Prompt to print

All tools come from the `openscad` MCP server. Use only those tools.

## Flow

**1. Ask:** "Design only, or design and print?"

**2. Ask:** "Search online for an existing design first, or model it from scratch?"

**3. If print, ask:** "Review the design before printing?"

One question at a time. Never assume an answer.

**4a. Find online** — if they chose search
Search Printables, MakerWorld and Thingiverse. Offer a few options with names, links and why each fits.
Let them pick. Download the model file.
`scad_render` it by path and post the image so they see the real thing, not the listing photo.
If nothing suits, say so and offer to model it instead.
Then go to 5.

**4b. Design** — if they chose from scratch
Write OpenSCAD using BOSL2.
`scad_check` until clean. `scad_render` and look at the image.
Fix what is wrong. Repeat until it matches the request.

**5. Show** — design-only, or review = yes
Send the design to the preview dashboard and monitor the approval. Do not post review photos in chat.
Modelled from scratch: `scad_export` to STL first. Downloaded: use that file.
Example:

```
dash_preview  stl="C:\Users\ethan\source\3dprint\part.stl"  name="part"
dash_await    id="<id from dash_preview>"
```

Tell them to open the dashboard and use Preview. Stop. Wait.
Revise and send again until they tap Approve print.
Design-only ends here: give the file path, done.

Review = no: skip to 6 without pausing.

**6. Ask:** "What filament is loaded — PLA or PETG?"
Ask once per session, then remember it. Never guess.
PETG: pass it to `scad_slice` and remind them to glue-stick the plate.

**7. Print**
Modelled from scratch: `scad_export` to STL. Must report manifold yes and fit the build volume. If not, return to 4b.
Downloaded: use the file as-is.
`scad_slice`. Report print time and filament used.
`printer_print` with startNow.

**8. Monitor**
`printer_status` on request. Report progress and time remaining.

## Never

- Print anything the user did not ask for. Choosing print, then declining review, is consent — do not ask again.
- Pause or cancel a running print without asking.
- Continue past a non-manifold or oversized part.

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
