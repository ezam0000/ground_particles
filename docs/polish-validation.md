# Dunes polish validation

Implemented October 11, 2026. Desktop/WebGPU support, world locations, portfolio JSON, collectible storage, movement speeds, jump behavior, bow timing, and hit rules remain compatible.

## Delivered

- Shared charcoal/parchment/gold interface; contextual controls; complete Help; destination selection with distance and circular bearing marker.
- One interaction-mode owner isolates gameplay from inspection, book, reward, death, menus, and focus pauses. Inspection still orbits. Resume requires a click. Hidden tabs stop rendering and reset timing on return.
- Collection count, unnamed undiscovered slots, optional session-aware hints, clickable navigation, and separate persisted sound/sensitivity/reduced-motion preferences.
- Stable pedestal selection with hysteresis and a target-switch delay; reusable proximity/objective/health records and cached DOM updates.
- Warmer character fill, calmer fine sand detail, adjusted opening framing and initial facing, and bounded visual slope tilt. Existing rig and foot offset remain in use.
- Concurrent independent warm-up work, phase timing, and explicit frame submission during startup warm-up. This resolved the destroyed swapchain texture warning.

## Assets

| Asset | Original triangles | Final triangles | Original bytes | Final bytes |
| --- | ---: | ---: | ---: | ---: |
| Arrow | 46,062 | 2,000 | 1,713,364 | 83,808 |
| Bow | 30,734 | 6,000 | 844,512 | 221,848 |
| Six HUD portraits | — | — | 7,265,966 | 701,158 |

Changed asset bytes fell from 9,823,842 to 1,006,814 (89.8%). Portraits are 256 px RGBA PNGs; full card artwork is separate and untouched. Weapon node transforms and UVs are retained. The bowstring is protected during simplification. Asset checks verify hashes, counts, bounds, finite attributes, indices, and portrait dimensions/transparency. See `asset-optimization.json` for receipts and reproducible scripts under `scripts/`.

## Browser and build checks

`npm run smoke`, `npm run smoke:polish`, `npm run check:assets`, `npm run check`, and `npm run build` passed. The expanded browser suite passed 33 checks: movement, destinations, inspection/orbit, project opening, bow acquisition, real bow projectile release, discoveries, combat, all six cards, death/respawn, persistence, reduced motion, Escape, focus loss, explicit resume, hidden rendering, and modal input isolation. Combat damage fixtures and teleportation make the route reproducible; the bow release and sacred-NPC projectile impact use the real runtime.

Final Chrome WebGPU runs reported zero console errors and warnings, including at both requested viewport sizes. Command-line WGSL validation could not acquire an adapter and skipped compilation; browser WebGPU validation exercised the renderer. Vite retains its existing large-bundle advisory.

Screenshots reviewed at 1280×720 and 1920×1080 cover spawn, pillars, menus/card book, reward reading, and inspection. Additional 1080p captures cover bright dunes and the character facing away from the sun. Original collectible illustrations are preserved.

## Measured performance

Fresh temporary Chrome profiles, local Vite server, sequential runs, 239 measured frames per fixture. Routes use spawn, a school pillar, and ten released arrows. Opening framing changed slightly, so this is a route comparison rather than an identical-pixel GPU benchmark. Times include the display's approximately 60 Hz scheduling cap.

| Resolution/scene | Baseline median / p95 ms | Candidate median / p95 ms |
| --- | ---: | ---: |
| 720p spawn | 16.7 / 17.1 | 16.9 / 18.3 |
| 720p pillars | 16.7 / 17.5 | 16.7 / 17.7 |
| 720p combat | 16.6 / 17.7 | 16.6 / 17.6 |
| 1080p spawn | 16.6 / 17.5 | 16.7 / 17.6 |
| 1080p pillars | 16.6 / 17.7 | 16.6 / 17.8 |
| 1080p combat | 16.6 / 17.6 | 16.7 / 17.6 |

The higher first 720p spawn tail prompted a repeat: spawn 16.7 / 17.4, pillars 16.7 / 17.7, combat 16.7 / 17.5. These runs sustain roughly 60 fps; minor sub-millisecond tail differences do not establish an improvement or a repeatable regression. No frame-rate uplift is claimed.

Startup to available interaction changed from 1,546 ms to 1,289 ms at 720p and from 1,546 ms to 1,331 ms at 1080p. Completed same-origin startup requests changed from 242 to 247. Actual transferred bytes changed from 34,917,485 to 32,860,634; decoded bytes changed from 36,529,025 to 34,470,674. These are development-server requests, not production payload estimates. Shipped asset savings are larger than startup savings because assets not requested at startup are excluded from downloaded bytes.

Raw baseline/candidate metrics and the browser-flow results are saved under `docs/validation/`. Reproduce with `npm run benchmark`, `BENCH_WIDTH=1920 BENCH_HEIGHT=1080 npm run benchmark`, and `npm run smoke:polish` while the local server is running.
