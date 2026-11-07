# Project: Seattle Transit Map

## Architecture
The Seattle Transit Map (`dingus-sys/Seattle-Transit-Map`) is an interactive, high-fidelity transit cartography and routing platform for Puget Sound. It comprises:
1. **Data Pipeline (`pipeline/`)**: Python build toolchain ingesting 16 agency GTFS feeds (King County Metro, Sound Transit, Community Transit, Pierce Transit, WSF, etc.), snapping route shapes to OpenStreetMap via Hidden Markov Models, constructing corridor graphs (`network.json`), tidying complex junctions, and repairing gaps/turnarounds.
2. **Web Client Engine (`web/`)**:
   - `web/geom.js`: Web Worker line engine computing continuous route ribbons, 3-pass junction strand ordering, service category corridor bundling, and turnaround loops.
   - `web/ribbons.js`: Custom MapLibre WebGL layer generating world-space GPU meshes (casing, body, dashes, glows, RapidRide dots, rail ties) with zero-copy buffer transfer.
   - `web/app.js`: Interactive UI shell with real-time timetable trip planning (`timetableTripTimes`, `planTransitTrip`), OneBusAway GTFS-realtime integration, WSF ferry vessel tracking, through-route ("stay on the bus") navigation, service alerts, and dynamic canvas/HTML everyday vs part-time badges.
3. **Automated Verification & Tooling (`tools/`)**:
   - Python test suites: `tools/test_e2e_transit.py` (161 tests), `tools/validate_data.py`, `tools/check_repair.py`, `tools/test_build.py`, `tools/test_legend_features.py`. Total discoverable unittests: 174.
   - Node geometry & routing test suites: `tools/test_routing_engine.js` (16 tests), `tools/geometry_check.js` (11 tests), `tools/ribbon_check.js` (8/8 tests), `tools/strandorder.js`.
4. **CI/CD & Deployment (`.github/workflows/`)**:
   - GitHub Pages publishing workflow (`pages.yml`) and pull-request validation (`checks.yml`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Timetable Pattern Sequence Enforcement | Alight stop strictly succeeds board stop (`j > i`) in trip planning pattern lookups | M2 (DONE) | ORIGINAL_REQUEST §R1 |
| 2 | Realistic Transfer Connection Buffers | Transfers enforce >= 2 min connection buffer and reject unachievable waits (> 60 min) | M2 (DONE) | ORIGINAL_REQUEST §R1 |
| 3 | Walking Leg Distance & Departure Calculation | Walking times calculated at walking speed (80 m/min) before querying departures | M2 (DONE) | ORIGINAL_REQUEST §R1 |
| 4 | Consistent Mode Terminology & Icons | Consistent categorization of "train" (Link, Sounder, Amtrak, Monorail), "ferry" (WSF, Water Taxi), "streetcar", "bus", "walk" and icons | M2 (DONE) | ORIGINAL_REQUEST §R1 |
| 5 | Live GPS vs Timetable Distinction | Distinct badges, dots, and text distinguishing live GPS vehicle reports from timetable estimates in HUD and cards (fix getSoonestBus) | M2 (DONE) | ORIGINAL_REQUEST §R1 |
| 6 | Finite Multiscale Geometry (Zooms 10-18) | Finite, usable geometry across zooms 10, 12, 14, 16, 18 with 0 NaN/Inf coordinates | M1 (DONE) | ORIGINAL_REQUEST §R2 |
| 7 | WebGL Ribbon Layouts & GPU Shaders | Zero-copy ArrayBuffer GPU meshes, dual rail/surface stack, shader patterns | M1 (DONE) | ORIGINAL_REQUEST §R2 |
| 8 | Through-Routes ("Stay on the Bus") | Interactive navigation, guide cards, and tooltips for 6 Metro through-route pairs | M1 (DONE) | ORIGINAL_REQUEST §R2 |
| 9 | Badges & Suspended Service Indicators | Solid (everyday) vs hollow (part-time) canvas & HTML badges with diagonal red strike-through for suspended services | M1 (DONE) | ORIGINAL_REQUEST §R2 |
| 10 | Zero-Crossing Strand Optimization | Strand ordering at junctions minimizing crossings (40 junction swaps) | M1 (DONE) | ORIGINAL_REQUEST §R2 |
| 11 | Syntax & Baseline Test Suite Integrity | Resolve syntax error at `web/app.js:1870` and verify baseline test suites pass | M1 (DONE) | Survey Findings |
| 12 | Data Pipeline Feed & Graph Validation | `tools/validate_data.py` passes all 8 checks with 0 severe discrepancies (> 3 km) | M3 (DONE) | ORIGINAL_REQUEST §R3 |
| 13 | CI/CD Deployment Guardrails | Validate data and run full test suites before publishing in `pages.yml` and `checks.yml` | M3 (DONE) | ORIGINAL_REQUEST §R3 |
| 14 | Secret Hygiene & Clean Deployment | Zero secrets/API keys committed, clean git history, verified GitHub Pages publication | M4 (DONE) | ORIGINAL_REQUEST §R3 & AGENTS.md |
| 15 | E2E Test Suite (Tiers 1-4) | Comprehensive opaque-box test suite verifying all features independently (`TEST_READY.md`) | M4 (DONE) | E2E Track |
| 16 | Adversarial Coverage Hardening (Tier 5) | White-box adversarial testing for edge cases and unhandled exceptions | M4 (DONE) | E2E Track Phase 2 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Syntax, Geometry & Baseline Test Fixes | Fix syntax error in `web/app.js:1870`, verify `geometry_check.js` (11/11), `ribbon_check.js` (8/8), and python unit tests pass | none | DONE |
| M2 | R1 Trip Planning & Mode Labeling Engine | Fix mode labels (amtrak/monorail -> train, watertaxi -> ferry, streetcar icon), fix `getSoonestBus` live GPS false claim, expose planner test hooks | M1 | DONE |
| M3 | R3 Data Pipeline & CI Deployment Guards | Both CI workflows install pipeline dependencies and run the data, repair, routing, geometry and ribbon checks; feed fallbacks are guarded in `process_gtfs.py` | M1, M2 | DONE |
| M4 | Final Milestone: 100% E2E Test Pass & Hardening | 174-test suite, routing stress test and local map load verification; Git commit, GitHub Actions push and live Pages verification | M2, M3, E2E-Track | DONE |

## Interface Contracts
### Routing Engine ↔ UI & Test Harness (`web/app.js`)
- `timetableTripTimes(route, boardStopId, alightStopId, earliestSec, day, prev)`: Returns `{ depSec, arrSec, rideMin, tripId }` or `null`. Strict invariant: board stop sequence index `i` < alight stop sequence index `j`.
- `planTransitTrip(origCoord, destCoord, nowSecs, day)`: Returns `{ legs, totalMin, departureSec, arrivalSec }` or `null`.
- `currentVehWord(route)`: Returns `"train" | "ferry" | "streetcar" | "bus"`.
  - Link, Sounder, Amtrak, Monorail -> `"train"`
  - Washington State Ferries, King County Water Taxi -> `"ferry"`
  - Streetcar -> `"streetcar"`
  - Bus routes -> `"bus"`
- `modeIcon(route)`: Returns `"🚆" | "⛴️" | "🚊" | "🚌" | "🚶"`.
- `window.__atlas.planner`: Exposed helper object for headless / browser testing of routing functions.

### Network Geometry & Shaders (`web/geom.js` ↔ `web/ribbons.js`)
- `buildGraph(network, options)`: Returns layout with finite coordinates across zoom tiers 10, 12, 14, 16, 18.
- `compileRibbonMeshes(layout)`: Generates typed ArrayBuffers for MapLibre custom layer.

## Code Layout
- `web/app.js`: Application UI, MapLibre layers, real-time feeds, trip planner, modal cards, through-routes.
- `web/geom.js`: Route ribbon layout, corridor bundling, strand ordering, Web Worker.
- `web/ribbons.js`: WebGL custom shader layer, GPU mesh compiler.
- `pipeline/config.py`: Feed URLs, regional bounding box, pipeline configuration. (Owned by M3 worker)
- `.github/workflows/`: GitHub Actions workflows (`pages.yml`, `checks.yml`, `refresh-data.yml`). (Owned by M3 worker)
- `tools/`: Automated verification scripts, test suites, and E2E test runners.
- `site/`: Committed datasets (`data/`, `tiles/`, `fonts/`). Page files are generated by `pipeline/build_site.py`.
