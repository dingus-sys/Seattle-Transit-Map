# Test Infrastructure & Specification Matrix: Seattle Transit Map

**Target System:** Seattle Transit Map (`dingus-sys/Seattle-Transit-Map`)
**Document Version:** 1.0.0
**Status:** Approved & Implemented
**Test Harness:** Python 3 `unittest` (`tools/test_e2e_transit.py`) & Node.js (`tools/test_routing_engine.js`, `tools/geometry_check.js`, `tools/ribbon_check.js`)
**Execution Command:** `.venv/bin/python -m unittest discover -s tools -p 'test_*.py'`

---

## 1. Testing Philosophy & Methodology

### 1.1 Opaque-Box, Requirement-Driven Testing
All tests in this suite are designed strictly from the authoritative specifications defined in `ORIGINAL_REQUEST.md`, `PROJECT.md`, `README.md`, and `CLAUDE.md`. Tests treat the application, routing engine, cartographic pipeline, and deployment tools as opaque systems verified against explicit behavioral contracts:
- **Observable Inputs & Outputs:** Tests supply concrete coordinates, route IDs, stop IDs, times, and network configurations, asserting expected return structures, timing invariants, and visual properties.
- **Independence from Implementation Details:** Tests verify that requirements are satisfied (e.g. alight stop strictly follows board stop in pattern sequence, connection buffers are at least 2 minutes, mode names match the passenger vocabulary) regardless of internal variable naming or code structure.
- **Authoritative Expected Output Derivation:** Every test case documents its explicit source of truth—whether derived from official King County Metro / Sound Transit GTFS timetables (`site/data/schedule.json`), spatial geography of Puget Sound, or documented acceptance criteria.

### 1.2 The 4-Tier Test Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│             Tier 4: Real-World Application Scenarios                  │
│       Realistic multi-leg trips, ferry voyages & full regional map     │
├────────────────────────────────────────────────────────────────────────┤
│             Tier 3: Cross-Feature Combinations                         │
│       Pairwise interactions (walk legs + transfer buffers, etc.)      │
├────────────────────────────────────────────────────────────────────────┤
│             Tier 2: Boundary & Corner Cases (>=5 per feature)          │
│       Limits, empty inputs, midnight boundaries, negative/zero buffers │
├────────────────────────────────────────────────────────────────────────┤
│             Tier 1: Isolated Feature Coverage (>=5 per feature)        │
│       Isolated happy-path verification across all R1, R2, R3 features  │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Tier 1 — Feature Coverage (>= 5 tests per feature across R1, R2, R3):**
   Isolated verification of primary behaviors for every feature under standard operating conditions.
2. **Tier 2 — Boundary & Corner Cases (>= 5 tests per feature across R1, R2, R3):**
   Stress testing limits, empty collections, reverse sequences, zero/negative buffers, excessive walk distances, zoom extremes, and error boundaries.
3. **Tier 3 — Cross-Feature Combinations:**
   Systematic pairwise validation testing interactions between disparate subsystem features (e.g. walking leg departure offsets combined with transfer buffer constraints; through-routes combined with part-time badge styling; GPU shader stacks combined with multiscale zoom transitions).
4. **Tier 4 — Real-World Application Scenarios (>= 5 scenarios):**
   High-fidelity end-to-end transit trips and cartographic workflows modeled on actual rider journeys across Puget Sound (Airport Express, Bainbridge Ferry, West Seattle-to-Bellevue Transfer, Capitol Hill-to-SLU Streetcar, Queen Anne-to-Mount Baker Through-Route, and Full Regional Cartography Compilation).

---

## 2. Feature Inventory & Authoritative Requirements Traceability

| Feature ID | Feature Name | Requirement Source | Authoritative Specification Contract |
|---|---|---|---|
| **F1** | Timetable Pattern Sequence Enforcement | `ORIGINAL_REQUEST §R1` | Alight stop strictly succeeds board stop (`j > i`) in pattern lookups. Reverse-direction trips rejected (`j <= i`). |
| **F2** | Realistic Transfer Connection Buffers | `ORIGINAL_REQUEST §R1` | Proposed transfers enforce buffer $\ge 2$ min between Leg 1 arrival + walk and Leg 2 departure. Unachievable connections ($> 60$ min or $< 0$ min) rejected. |
| **F3** | Walking Leg Distance & Departure Calculation | `ORIGINAL_REQUEST §R1` | Walking calculated at 80 m/min. Access walk added to query time (`earliestBoardSec = nowSecs + walk1Time * 60`) before departure lookup. Transfer walk $\le 360$m. Direct walk $\le 2500$m. |
| **F4** | Consistent Mode Terminology & Icons | `ORIGINAL_REQUEST §R1`, `PROJECT.md §4` | Consistent vocabulary: `"train"` (Link, Sounder, Amtrak, Monorail; 🚆), `"ferry"` (WSF, Water Taxi; ⛴️), `"streetcar"` (🚊), `"bus"` (🚌), `"walk"` (🚶). |
| **F5** | Live GPS vs Timetable Distinction | `ORIGINAL_REQUEST §R1` | Visual distinction between live GPS countdowns (pulsing green dot, "Live GPS") vs static timetable ("Scheduled", clock icon). HUD displays fleet live vs sched breakdown. |
| **F6** | Finite Multiscale Geometry (Zooms 10–18) | `ORIGINAL_REQUEST §R2`, `PROJECT.md §6` | All routes compile with finite coordinates ($0$ NaN/Inf) at zoom tiers 10, 12, 14, 16, 18. Positive finite widths (`wm > 0`). Empty views return empty features. |
| **F7** | WebGL Ribbon Layouts & GPU Shaders | `ORIGINAL_REQUEST §R2`, `PROJECT.md §7` | World-space vertex buffers (stride 10, multiple of 30). Rail stack ($1$) above surface ($0$). Distinct patterns (RapidRide dots, ferry dashes, rail ties). Zero-copy buffer transfer. |
| **F8** | Through-Routes ("Stay on the Bus") | `ORIGINAL_REQUEST §R2`, `PROJECT.md §8` | 6 Metro route pairs (1/14, 2/13, 5/21, 24/33/124, 28/131/132, 27). Interactive continuation, no transfer penalty for through-passengers, restricted to Metro agency. |
| **F9** | Everyday vs Part-Time Badges & Suspended Indicators | `ORIGINAL_REQUEST §R2`, `PROJECT.md §9` | Everyday routes (7-day service) render solid badges; part-time (peak/weekday-only) render hollow badges. Suspended services display diagonal red strike-through (`.badge.suspended`). |
| **F10** | Zero-Crossing Strand Optimization | `ORIGINAL_REQUEST §R2`, `PROJECT.md §10` | Strand swaps at junctions reduced to $\le 8$ (0 current) across Puget Sound network. Selection and hover share identical strand geometry. Turnaround loops preserved. |
| **F11** | Syntax & Baseline Test Suite Integrity | `PROJECT.md §11`, `ORIGINAL_REQUEST §Verification` | Zero JavaScript syntax errors (`node -c`). Python unit tests (`test_build.py`, `test_legend_features.py`) pass cleanly without `NameError`. |
| **F12** | Data Pipeline Feed & Graph Validation | `ORIGINAL_REQUEST §R3`, `PROJECT.md §12` | All 5 key agencies present: King County Metro (`kcm`), Sound Transit (`st`), Community Transit (`ct`), Pierce Transit (`pt`), Washington State Ferries (`wsf`). $\ge 330$ routes, $\ge 10,000$ stops. Zero discrepancies $> 3$ km. |
| **F13** | CI/CD Deployment Guardrails | `ORIGINAL_REQUEST §R3`, `PROJECT.md §13` | `.github/workflows/pages.yml` and `checks.yml` execute validation and unit tests prior to deployment. Site files build with cache-busting content hashes. |
| **F14** | Secret Hygiene & Safe Deployment | `ORIGINAL_REQUEST §R3`, `CLAUDE.md §Rules`, `AGENTS.md` | Zero API keys or secrets in repository history. `build_site.py` safely JSON-encodes credentials with HTML escaping (`\u003c`). Default builds insert placeholders. `local_secrets.json` gitignored. |

---

## 3. Comprehensive 4-Tier Test Case Matrix

### 3.1 Tier 1: Feature Coverage (Isolated Happy Path)
*Minimum 5 test cases per feature across all 14 features (Total: 70+ test cases).*

#### Feature F1: Timetable Pattern Sequence Enforcement
- **T1-F1-01 (ST 1 Line Southbound):** Query trip from Westlake (index 5) to SeaTac/Airport (index 17). Expected: Success, departure $\ge earliestSec$, arrival $>$ departure, ride duration ~38 min.
- **T1-F1-02 (ST 1 Line Northbound):** Query trip from SeaTac/Airport (index 4) to Westlake (index 16). Expected: Success, departure $\ge earliestSec$, arrival $>$ departure, ride duration ~39 min.
- **T1-F1-03 (RapidRide E Line Southbound):** Query trip from Aurora Village Transit Center to Downtown Seattle. Expected: Success, board stop index $i <$ alight stop index $j$, ride duration matches timetable.
- **T1-F1-04 (WSF Bainbridge Crossing):** Query trip from Seattle Colman Dock to Bainbridge Island Terminal. Expected: Success, terminal stop succeeds dock stop in maritime pattern.
- **T1-F1-05 (Station Key Resolution):** Query boarding using station key (`station-westlake`) resolving constituent platform stop IDs. Expected: Correct pattern lookup and stop index matching.

#### Feature F2: Realistic Transfer Connection Buffers
- **T1-F2-01 (2-Minute Buffer Application):** Connect Leg 1 arriving at $T$ to Leg 2. Verify Leg 2 query uses $earliestSec2 \ge T + walkSec + 120$. Expected: Earliest queried departure is at least 2 minutes post-arrival.
- **T1-F2-02 (Transfer Wait Calculation):** Connect Leg 1 arriving at 10:00 AM with Leg 2 departing at 10:07 AM (transfer walk 1 min). Expected: Transfer wait time calculated as $7 - 1 = 6$ min ($\ge 2$ min).
- **T1-F2-03 (Same-Station Platform Transfer):** Transfer within Symphony Station between 1 Line and 2 Line (50m walk). Expected: Transfer walk time 1 min, buffer applied, valid connection formed.
- **T1-F2-04 (Street Platform Transfer):** Transfer between 3rd Ave bus stop and Link tunnel station (160m walk). Expected: Transfer walk time 2 min, total connecting buffer $\ge 4$ min.
- **T1-F2-05 (Timetable Verification Flag):** When both Leg 1 and Leg 2 are resolved in timetable, verify itinerary receives `schedVerified: true`.

#### Feature F3: Walking Leg Distance & Departure Calculation
- **T1-F3-01 (Walking Speed Constant):** Verify pedestrian travel time for 400m walk. Expected: Exactly $400 / 80 = 5$ minutes.
- **T1-F3-02 (Access Walk Query Offset):** Origin is 240m from stop (3 min walk). Now is $T_0$. Expected: Departure lookup queries $earliestBoardSec = T_0 + 180$ seconds.
- **T1-F3-03 (Egress Walk Addition):** Destination is 320m from alight stop (4 min walk). Expected: Egress walk time (4 min) added to total journey duration.
- **T1-F3-04 (Direct Walk Itinerary):** Origin and destination separated by 1200m ($1.2$ km $\le 2.5$ km). Expected: Walk-only itinerary generated with duration $1200 / 80 = 15$ minutes.
- **T1-F3-05 (Inter-Stop Transfer Distance Limit):** Transfer stops separated by 240m. Expected: Allowed as valid transfer ($240 \le 360$m), transfer walk time = 3 min.

#### Feature F4: Consistent Mode Terminology & Icons
- **T1-F4-01 (Train Mode Labeling):** Routes with categories `link`, `sounder`, `amtrak`, `monorail`. Expected: Mode word evaluates to `"train"`, emoji evaluates to `🚆`.
- **T1-F4-02 (Ferry Mode Labeling):** Routes with categories `ferry`, `watertaxi`. Expected: Mode word evaluates to `"ferry"`, emoji evaluates to `⛴️`.
- **T1-F4-03 (Streetcar Mode Labeling):** Route with category `streetcar`. Expected: Mode word evaluates to `"streetcar"`, emoji evaluates to `🚊`.
- **T1-F4-04 (Bus Mode Labeling):** Routes with categories `rapidride`, `swift`, `frequent`, `local`, `peak`, `shuttle`, `dart`. Expected: Mode word evaluates to `"bus"`, emoji evaluates to `🚌`.
- **T1-F4-05 (Walk Mode Labeling):** Pedestrian leg. Expected: Mode word evaluates to `"walk"`, emoji evaluates to `🚶`.

#### Feature F5: Live GPS vs Timetable Distinction
- **T1-F5-01 (Live Departure Card Indicator):** Agency returns departure with `match.live = true`. Expected: Card displays pulsing green dot (`.sc-live`), countdown text ("in X min"), and `(Live GPS · ...)`.
- **T1-F5-02 (Timetable Departure Card Indicator):** Departure sourced from static timetable (`match.live = false`). Expected: Card displays static clock icon without green dot, reading `Scheduled X now` or `Soonest bus in X min`.
- **T1-F5-03 (Live HUD Fleet Breakdown):** Real-time feed active with 450 live vehicles. Expected: Top bar HUD displays `"450 Vehicles Live"`, popover reports schedule deviations (<3m, 3-7m, >7m).
- **T1-F5-04 (Timetable Fleet HUD State):** Live tracking disabled or offline. Expected: HUD displays `"Sched (Timetable)"` without live dot.
- **T1-F5-05 (Vehicle Tooltip GPS Fix):** Live vehicle hovered. Expected: Tooltip displays `"Live GPS fix · Updated X s ago"` vs timetable vehicle `"Estimated position from timetable (not GPS)"`.

#### Feature F6: Finite Multiscale Geometry (Zooms 10–18)
- **T1-F6-01 (Zoom 10 Coordinate Integrity):** Geometry compilation at zoom 10. Expected: All feature coordinates finite, length $\ge 2$, 0 NaN/Inf.
- **T1-F6-02 (Zoom 12 Coordinate Integrity):** Geometry compilation at zoom 12. Expected: All feature coordinates finite, length $\ge 2$, 0 NaN/Inf.
- **T1-F6-03 (Zoom 14 Coordinate Integrity):** Geometry compilation at zoom 14. Expected: All feature coordinates finite, length $\ge 2$, 0 NaN/Inf.
- **T1-F6-04 (Zoom 16 Coordinate Integrity):** Geometry compilation at zoom 16. Expected: All feature coordinates finite, length $\ge 2$, 0 NaN/Inf.
- **T1-F6-05 (Zoom 18 Coordinate Integrity):** Geometry compilation at zoom 18. Expected: All feature coordinates finite, length $\ge 2$, 0 NaN/Inf.

#### Feature F7: WebGL Ribbon Layouts & GPU Shaders
- **T1-F7-01 (Empty View Handling):** Pass empty feature array to ribbon compiler. Expected: Returns empty array `[]` with 0 GPU work.
- **T1-F7-02 (Vertex Buffer Stride):** Compile standard route segment. Expected: Buffer data length is multiple of `STRIDE * 3 = 30`, all values finite.
- **T1-F7-03 (Rail Stack Separation):** Surface route and Link light rail compiled together. Expected: Rail mesh stack ($1$) positioned strictly after surface mesh stack ($0$).
- **T1-F7-04 (Distinct Shader Patterns):** Compile ferry, RapidRide, and rail tie features. Expected: Preserves distinct shader pattern assignments in mesh headers.
- **T1-F7-05 (Zero-Copy Buffer Transfer):** Invoke `structuredClone` with transferable buffers. Expected: Source buffer byte length collapses to 0 while target retains all vertices.

#### Feature F8: Through-Routes ("Stay on the Bus")
- **T1-F8-01 (Six Metro Route Pairs Exist):** Verify presence of 6 pairs: 1/14, 2/13, 5/21, 24/33/124, 28/131/132, 27 in network. Expected: All 12 route IDs exist in `routes.json`.
- **T1-F8-02 (Metro Agency Enforcement):** Evaluate through-route eligibility for King County Metro route vs non-Metro route with matching number (e.g. Pierce Transit 1). Expected: Metro 1 matches through-route; PT 1 returns null.
- **T1-F8-03 (Continuation Guidance UI):** Route card opened for Metro 1. Expected: UI renders continuation button pointing to Metro 14 with "Stay on the bus" tooltip.
- **T1-F8-04 (Through-Route Travel Zero Wait):** Rider traveling through Downtown on paired route. Expected: Zero transfer penalty applied in planner.
- **T1-F8-05 (Through-Route Hover Tooltip):** Hovering through-route corridor in Downtown. Expected: Tooltip displays paired continuation route name.

#### Feature F9: Everyday vs Part-Time Badges & Suspended Indicators
- **T1-F9-01 (Everyday Route Detection):** Route operates 7 days a week (weekday, Saturday, Sunday trips $> 0$). Expected: `isEveryday(r) = true`, solid badge rendered.
- **T1-F9-02 (Part-Time Route Detection):** Peak-only route operates Monday–Friday only. Expected: `isEveryday(r) = false`, hollow badge rendered (`.badge.part-time`).
- **T1-F9-03 (Suspended Route Detection):** Route has 0 scheduled trips across all sample days. Expected: `isRouteSuspended(r) = true`.
- **T1-F9-04 (Suspended CSS Classes):** Check CSS rules for suspended elements. Expected: `.badge.suspended`, `.stop-susp-banner`, `.tt-sched.suspended` defined with red strike-through.
- **T1-F9-05 (Canvas Badge Rendering):** Dynamic canvas badge drawn for everyday vs part-time. Expected: Everyday fills background solid; part-time draws stroked border with transparent fill.

#### Feature F10: Zero-Crossing Strand Optimization
- **T1-F10-01 (Strand Swap Ceiling):** Run strand order optimizer on network graph. Expected: Total swaps $\le 8$ across Puget Sound network (0 current).
- **T1-F10-02 (Crossings Reduction):** Compare strand swaps before and after optimization. Expected: Swaps reduced from baseline 803 to 0.
- **T1-F10-03 (Selection & Hover Agreement):** Select route at complex junction and inspect hover geometry. Expected: Selection and hover follow identical strand paths.
- **T1-F10-04 (Turnaround Loop Preservation):** Inspect terminal turnarounds in `repair_network.py`. Expected: Turnaround loops preserved without clipping.
- **T1-F10-05 (Selected Route Visibility):** Hide category of selected route. Expected: Selected route remains visible while sibling routes hide.

#### Feature F11: Syntax & Baseline Test Suite Integrity
- **T1-F11-01 (Web App JavaScript Syntax):** Compile `web/app.js` with Node VM compiler. Expected: Exits 0 with 0 syntax errors.
- **T1-F11-02 (Web Geom JavaScript Syntax):** Compile `web/geom.js` with Node VM compiler. Expected: Exits 0 with 0 syntax errors.
- **T1-F11-03 (Web Ribbons JavaScript Syntax):** Compile `web/ribbons.js` with Node VM compiler. Expected: Exits 0 with 0 syntax errors.
- **T1-F11-04 (Network Repair Tests):** Execute `python tools/check_repair.py`. Expected: 9/9 tests pass with exit code 0.
- **T1-F11-05 (Legend Features Tests):** Execute `python -m unittest tools/test_legend_features.py`. Expected: All 5 tests pass with exit code 0 without `NameError`.

#### Feature F12: Data Pipeline Feed & Graph Validation
- **T1-F12-01 (Data Integrity Script):** Execute `python tools/validate_data.py`. Expected: Exits 0 with "ALL DATA INTEGRITY CHECKS PASSED".
- **T1-F12-02 (Five Key Agencies):** Inspect routes dataset for required agencies. Expected: Contains `{"Metro", "Sound Transit", "CT", "PT", "WSF"}`.
- **T1-F12-03 (Route Threshold):** Count routes in `site/data/routes.json`. Expected: $\ge 330$ routes verified.
- **T1-F12-04 (Stop Threshold):** Count stops in `site/data/stops.json`. Expected: $\ge 10,000$ stops verified.
- **T1-F12-05 (Stop-Route Proximity):** Verify stop-to-route distance across all routes. Expected: Zero severe discrepancies $> 3$ km.

#### Feature F13: CI/CD Deployment Guardrails
- **T1-F13-01 (Pages Workflow Guard):** Inspect `.github/workflows/pages.yml`. Expected: Executes site compilation and data validation before deployment.
- **T1-F13-02 (Checks Workflow Guard):** Inspect `.github/workflows/checks.yml`. Expected: Executes Python unit test discovery and Node checks.
- **T1-F13-03 (Site Compiler Execution):** Run `python pipeline/build_site.py`. Expected: Successfully compiles `site/index.html` with cache-busting hashes.
- **T1-F13-04 (Artifact Generator Isolation):** Run `pipeline/build_site.py` for artifact. Expected: Generates self-contained `site/artifact.html`.
- **T1-F13-05 (Service Worker Version Consistency):** Inspect `web/sw.js`. Expected: Cache name matches release version `seattle-transit-v10-2`.

#### Feature F14: Secret Hygiene & Safe Deployment
- **T1-F14-01 (Clean Git History):** Scan repository history for OneBusAway and WSDOT keys. Expected: Zero API keys or secrets found in git commits.
- **T1-F14-02 (Keyless Build Placeholders):** Run `build_site.py` without `--with-key`. Expected: Output contains placeholders `__OBA_API_KEY__`, `__WSF_ACCESS_CODE__`, `__WSDOT_ACCESS_CODE__`.
- **T1-F14-03 (HTML Credential Escaping):** Inject dummy credential with `<script>` tags. Expected: Output safely JSON-encoded with `\u003c` without script break-out.
- **T1-F14-04 (Local Secrets Gitignored):** Inspect `.gitignore`. Expected: `pipeline/local_secrets.json` explicitly ignored.
- **T1-F14-05 (Environment Key Resolution):** Test `config.access_code()`. Expected: Correctly reads environment variables and precedence order.

---

### 3.2 Tier 2: Boundary & Corner Cases
*Minimum 5 test cases per feature across all 14 features (Total: 70+ test cases).*

#### Feature F1: Timetable Pattern Sequence Enforcement
- **T2-F1-01 (Reverse Pattern Order Rejected):** Board stop at index 18, Alight stop at index 4 ($j < i$). Expected: Pattern rejected, returns null, no backwards travel.
- **T2-F1-02 (Identical Board and Alight Stop):** Board stop index equals Alight stop index ($j == i$). Expected: Returns null, zero-stop travel rejected.
- **T2-F1-03 (Terminal Stop Boarding):** Attempt to board at the very last stop of a pattern ($i = length - 1$). Expected: Skipped (`i >= p.f.length - 1`), returns null.
- **T2-F1-04 (First Stop Alighting):** Attempt to alight at the very first stop of a pattern ($j = 0$). Expected: Skipped since $j > i$ cannot be satisfied, returns null.
- **T2-F1-05 (Midnight Boundary Wrap-Around):** Trip departs at 12:45 AM (89,100 sec). Queried at 11:50 PM. Expected: Matches through `prevDay` (+86,400) offset calculation.

#### Feature F2: Realistic Transfer Connection Buffers
- **T2-F2-01 (Exact 2-Minute Buffer Boundary):** Connecting vehicle departs exactly 120 seconds after Leg 1 arrival + walk. Expected: Accepted as valid transfer.
- **T2-F2-02 (1-Minute 59-Second Buffer Boundary):** Connecting vehicle departs 119 seconds after arrival + walk. Expected: Rejected, buffer $< 2$ min.
- **T2-F2-03 (Exact 60-Minute Layover Boundary):** Connecting vehicle departs exactly 60 minutes after arrival + walk. Expected: Accepted as maximum viable transfer.
- **T2-F2-04 (60-Minute 1-Second Layover Boundary):** Connecting vehicle departs 61 minutes after arrival + walk. Expected: Rejected ($> 60$ min layover unachievable).
- **T2-F2-05 (Negative Layover Boundary):** Connecting vehicle departs before Leg 1 arrival ($wait < 0$). Expected: Strictly rejected.

#### Feature F3: Walking Leg Distance & Departure Calculation
- **T2-F3-01 (Zero-Meter Walk):** Rider location identical to stop coordinates ($dist = 0$). Expected: $walkTime = 0$, query departure immediately.
- **T2-F3-02 (Direct Walk Upper Boundary 2500m):** Direct origin to destination distance is exactly 2500m. Expected: Walk itinerary generated (duration $2500 / 80 = 31$ min).
- **T2-F3-03 (Direct Walk Exceeded 2501m):** Direct origin to destination distance is 2501m. Expected: Walk-only itinerary suppressed (exceeds 2.5 km).
- **T2-F3-04 (Transfer Walk Upper Boundary 360m):** Transfer between stops separated by exactly 360m. Expected: Accepted with $transferWalkTime = 5$ min.
- **T2-F3-05 (Transfer Walk Exceeded 361m):** Transfer between stops separated by 361m. Expected: `transferDistance()` returns `Infinity`, transfer pair rejected.

#### Feature F4: Consistent Mode Terminology & Icons
- **T2-F4-01 (Null/Undefined Route Object):** Pass `null` or `undefined` to mode helper. Expected: Gracefully returns default `"transit"` / `"bus"`, no uncaught exception.
- **T2-F4-02 (Empty Category String):** Route with `cat: ""` or missing category property. Expected: Defaults to `"bus"` and `🚌`.
- **T2-F4-03 (Case Insensitivity / Normalization):** Route category with mixed casing `LiNk` or `FeRrY`. Expected: Correctly normalizes to `"train"` and `"ferry"`.
- **T2-F4-04 (Monorail Special Case):** Seattle Center Monorail has single line. Expected: Strictly categorizes as `"train"` (not `"bus"` or `"monorail"` string).
- **T2-F4-05 (Water Taxi Special Case):** King County Water Taxi (`watertaxi`). Expected: Strictly categorizes as `"ferry"` (not `"bus"`).

#### Feature F5: Live GPS vs Timetable Distinction
- **T2-F5-01 (0-Second Departure):** Departure time diff is 0 seconds. Expected: Formats as `"Due now"`.
- **T2-F5-02 (59-Second Departure):** Departure time diff is 59 seconds. Expected: Formats as `"Due now"` ($< 60$s threshold).
- **T2-F5-03 (60-Second Departure):** Departure time diff is 60 seconds. Expected: Transitions to `"in 1 min"`.
- **T2-F5-04 (Imminent Missed Departure -25 Seconds):** Departure was 25 seconds ago. Expected: Filtered out ($< -20$s threshold).
- **T2-F5-05 (Distant Future Departure > 5400 Seconds):** Departure is 95 minutes in future. Expected: Filtered out ($> 5400$s window).

#### Feature F6: Finite Multiscale Geometry (Zooms 10–18)
- **T2-F6-01 (Empty Viewport Bounding Box):** Viewport outside Puget Sound `[-100, -100, -99, -99]`. Expected: Returns empty features array with 0 errors.
- **T2-F6-02 (Regional Bounding Box Limits):** Coordinates at exact edges of `REGION` (`[-123.50, 46.80]`). Expected: Compiles finite geometry without coordinate overflow.
- **T2-F6-03 (Degenerate Single-Point Line):** Edge feature with single coordinate pair. Expected: Handled gracefully or filtered, no NaN generated.
- **T2-F6-04 (Sub-Pixel Zoom Level 9.99):** Zoom below regional threshold. Expected: Clamped cleanly without projection divide-by-zero.
- **T2-F6-05 (Super-Zoom Level 18.5):** Zoom exceeding level 18. Expected: Lane spacing remains invariant, no visual explosion.

#### Feature F7: WebGL Ribbon Layouts & GPU Shaders
- **T2-F7-01 (Duplicate Consecutive Vertices):** Line contains repeated identical coordinates `[[x, y], [x, y]]`. Expected: Normal vector calculation handles zero distance without NaN.
- **T2-F7-02 (Collinear 180-Degree Reversal):** Line reverses immediately upon itself. Expected: Generates bounded ribbon cap without infinite miter flare.
- **T2-F7-03 (Zero-Width Ribbon):** Line feature with `wm = 0`. Expected: Bounded to minimum floor, no zero-area triangle corruption.
- **T2-F7-04 (Maximum Bundle Width Cap):** 40 routes bundled on single street. Expected: Bundle width capped at `capU` (14 px) via logarithmic scaling.
- **T2-F7-05 (Extreme Aspect Ratio Segment):** Segment length 10 km vs width 2 px. Expected: Triangular tessellation preserves correct winding order.

#### Feature F8: Through-Routes ("Stay on the Bus")
- **T2-F8-01 (Non-Paired Metro Route):** Metro 7 (not in through-route table). Expected: Returns `null` for through-route info.
- **T2-F8-02 (Matching Route Number, Non-Metro Agency):** Pierce Transit Route 1. Expected: Returns `null`, strictly rejecting false through-pairing.
- **T2-F8-03 (Multi-Leg Through Chain):** Metro 24/33/124 complex pairing. Expected: Correctly identifies paired branch based on trip direction.
- **T2-F8-04 (Through-Route Destination Query):** Destination lies on paired continuation route. Expected: Planner identifies single-seat ride without transfer step.
- **T2-F8-05 (Missing Reverse Through-Route):** Unidirectional through-route definition. Expected: Handled gracefully without null-reference crash.

#### Feature F9: Everyday vs Part-Time Badges & Suspended Indicators
- **T2-F9-01 (Sunday-Only Service):** Route operates Sunday but not Saturday. Expected: Evaluates to `isEveryday = false` (requires both weekend days).
- **T2-F9-02 (Saturday-Only Service):** Route operates Saturday but not Sunday. Expected: Evaluates to `isEveryday = false`.
- **T2-F9-03 (Minimal Service Route 1 Trip/Day):** Route operates 1 trip daily. Expected: Evaluates to `isEveryday = true` (trips $> 0$ on all 3 sample days).
- **T2-F9-04 (Special Event Route 0 Regular Trips):** Route exists in `routes.json` with empty schedule. Expected: Flagged as suspended (`isRouteSuspended = true`).
- **T2-F9-05 (HTML Badge Escaping):** Route label with special characters `1 Line & Shuttle`. Expected: Label HTML-escaped cleanly inside `.badge`.

#### Feature F10: Zero-Crossing Strand Optimization
- **T2-F10-01 (Isolated Single-Route Loop):** Network edge carrying single route in circular loop. Expected: 0 swaps, orientation preserved.
- **T2-F10-02 (Dead-End Route Stub):** Route terminating in 50m dead-end spur. Expected: Cleanly pruned or collapsed without orphan node.
- **T2-F10-03 (Complex 5-Way Freeway Knot):** Interchange with 5 diverging branches. Expected: 3-pass optimization prevents knotting.
- **T2-F10-04 (Parallel One-Way Couplet):** Routes split across 2nd Ave and 4th Ave one-way pairs. Expected: Correct directional strand assignment.
- **T2-F10-05 (Junction Optimization Idempotence):** Re-running `order_lines` on optimized graph. Expected: Produces identical strand ordering with 0 additional swaps.

#### Feature F11: Syntax & Baseline Test Suite Integrity
- **T2-F11-01 (Strict Mode Parsing):** Execute `node --use-strict -c web/app.js`. Expected: Clean syntax pass under strict mode semantics.
- **T2-F11-02 (Large JSON Parsing Limits):** Parse `schedule.json` (20+ MB). Expected: Successfully parses without memory or recursion errors.
- **T2-F11-03 (Missing Optional Property in GeoJSON):** Feature missing properties object. Expected: Handled safely with fallback defaults.
- **T2-F11-04 (Unicode Destination Names):** Stops with non-ASCII or hyphen characters (`International District/Chinatown`). Expected: Parsed without encoding mangling.
- **T2-F11-05 (Empty Network Edge Collection):** Graph with 0 edges. Expected: Optimizer returns empty layout without division-by-zero.

#### Feature F12: Data Pipeline Feed & Graph Validation
- **T2-F12-01 (Boundary Stop Distance 2999m):** Stop located 2999m from route shape. Expected: Accepted by validator ($< 3000$m threshold).
- **T2-F12-02 (Discrepant Stop Distance 3001m):** Stop located 3001m from route shape. Expected: Flagged as severe discrepancy ($> 3$ km).
- **T2-F12-03 (Missing Schedule Day Entry):** Feed missing Sunday schedule table. Expected: Detected and caught by pipeline calendar builder.
- **T2-F12-04 (Minimum Feed Threshold Boundary):** Exactly 330 routes in output. Expected: Validator passes ($len \ge 330$).
- **T2-F12-05 (Feed Missing Sound Transit Rail):** Sounder or Link missing from routes. Expected: Agency validation check fails.

#### Feature F13: CI/CD Deployment Guardrails
- **T2-F13-01 (Dry-Run Site Compilation):** Run `build_site.py` with missing destination directory. Expected: Automatically creates directory structure.
- **T2-F13-02 (Invalid Cache Directory Handling):** Run build script with non-existent cache path. Expected: Raises descriptive configuration error.
- **T2-F13-03 (Content Hash Modification Detection):** Modify 1 byte in `web/app.js`. Expected: Content hash in `site/index.html` changes.
- **T2-F13-04 (Git Cleanliness Assertion):** Build site locally. Expected: `git status --porcelain` leaves no uncommitted tracked modifications.
- **T2-F13-05 (Workflow File YAML Validation):** Validate YAML syntax of `.github/workflows/*.yml`. Expected: Valid YAML 1.2 with 0 syntax errors.

#### Feature F14: Secret Hygiene & Safe Deployment
- **T2-F14-01 (Credential Containing Quotes):** Secret with double quotes `secret"quote`. Expected: Safely JSON-encoded as `\"`.
- **T2-F14-02 (Credential Containing Script Closer):** Secret with `</script>`. Expected: Escaped as `\u003c/script\u003e`.
- **T2-F14-03 (Empty Environment Secrets):** All secret environment variables set to `""`. Expected: Gracefully falls back to keyless placeholders.
- **T2-F14-04 (Whitespace in Access Code):** Access code with leading/trailing spaces. Expected: Trimmed and safely injected.
- **T2-F14-05 (Multiple Competing Secret Variables):** Both `WSF_ACCESS_CODE` and `WSP_KEY` set. Expected: Follows precedence rules cleanly.

---

### 3.3 Tier 3: Cross-Feature Combinations (Pairwise Interactions)
*15 comprehensive interaction tests across subsystem boundaries.*

| Test ID | Feature Pair | Interaction Description | Expected System Behavior |
|---|---|---|---|
| **T3-01** | F2 (Buffer) + F3 (Walk Leg) | Leg 1 arrival $\rightarrow$ Transfer walk ($2$ min) $\rightarrow$ Leg 2 departure query offset. | Earliest query for Leg 2 enforces $T_{query} = T_{arr1} + walkTime \times 60 + 120$ sec. Ensures walking time and connection buffer are additive. |
| **T3-02** | F8 (Through-Route) + F9 (Badges) | Metro 1 (Everyday) paired with Metro 14 (Part-Time/Everyday). | Individual route cards preserve accurate everyday/part-time badge styling while through-route UI presents unified "stay on the bus" continuation. |
| **T3-03** | F6 (Multiscale Geom) + F7 (GPU Shaders) | Multiscale zoom jump ($z = 10 \rightarrow 16$) with WebGL ribbon compilation. | World-space ribbon half-width and lane offset remain invariant under zoom jumps; GPU vertex buffers compile with 0 NaN and maintain rail-above-surface stack order. |
| **T3-04** | F1 (Timetable) + F5 (Live vs Sched) | Timetable schedule departure lookup when live GPS feed is offline. | Planner falls back seamlessly to timetable schedule, setting `isLive = false`, omitting the pulsing green dot, and displaying scheduled departure time. |
| **T3-05** | F12 (Data Pipeline) + F14 (Secret Hygiene) | Data validation executing in keyless CI environment. | `validate_data.py` passes 100% of data integrity checks without requiring access to live API credentials. |
| **T3-06** | F3 (Walk Limit) + F1 (Direct Itinerary) | Origin-to-destination distance $\le 2500$m where transit route is available. | Engine returns both a direct transit itinerary and an independent walk-only itinerary, allowing user comparison of transit vs pedestrian options. |
| **T3-07** | F1 (Pattern Order) + F10 (Strand Optimization) | Boarding and alighting along complex multi-route corridor. | Itinerary follows forward pattern sequence ($j > i$) while ribbon renderer draws strand through junction without crossing swaps. |
| **T3-08** | F4 (Mode Label) + F5 (Live Countdown) | Live departure countdown for Link light rail train. | Card header reads `"Train due now"` or `"Soonest train in X min"` with pulsing green dot and `🚆` icon, never `"bus"`. |
| **T3-09** | F4 (Mode Label) + F1 (Timetable Query) | Timetable query for Washington State Ferries. | Itinerary displays mode `"ferry"`, emoji `⛴️`, and timetable departure from Colman Dock. |
| **T3-10** | F9 (Suspended Badge) + F1 (Schedule Patterns) | Route marked with suspended badge (`.badge.suspended`). | Timetable pattern queries for this route return null trips, confirming suspension in both cartography and timetable. |
| **T3-11** | F3 (Transfer Walk) + F2 (Station Transfer Hub) | Transferring between routes at Westlake or International District Station. | Both routes share station complex; transfer walk defaults to 50m (1 min), and connection buffer $\ge 2$ min is enforced. |
| **T3-12** | F5 (Live HUD) + F13 (Deployment Checks) | Live HUD fleet count adherence under CI test runner. | Test runner validates HUD status pill transitions cleanly between Live, Sched, and Off states. |
| **T3-13** | F8 (Through-Route) + F1 (Timetable Query) | Trip lookup from Queen Anne to Mount Baker traversing Downtown Seattle. | Timetable engine routes rider onto single vehicle (Route 1 $\rightarrow$ 14) without disembarking, applying 0 min transfer wait. |
| **T3-14** | F6 (Geometry) + F10 (Strand Optimization) | High-density corridor (3rd Ave Downtown) across zooms 12 through 16. | Corridors collapse into unified service bands with logarithmic width scaling ($GROW(n)$), maintaining $\le 8$ strand swaps (0 current). |
| **T3-15** | F1 (Midnight Boundary) + F2 (Transfer Buffer) | Late-night transfer at 12:45 AM linking to 1:15 AM departure. | Midnight calendar wrap-around (+86,400s) resolves correctly on both legs, producing valid 30-min connection buffer ($\ge 2$ min, $\le 60$ min). |

---

### 3.4 Tier 4: Real-World Application Scenarios
*High-fidelity regional transit journeys and cartography workflows.*

#### Scenario 1: Sound Transit 1 Line Airport Express (Westlake $\rightarrow$ SeaTac/Airport)
- **Origin:** Westlake Station (`[-122.3365, 47.6115]`)
- **Destination:** SeaTac/Airport Station (`[-122.2985, 47.4445]`)
- **Verification Flow:**
  1. Access walk to Westlake Station platform calculated (0 min if at station).
  2. Timetable query resolves Sound Transit 1 Line Southbound pattern.
  3. Directional pattern sequence strictly enforces SeaTac index ($17$) $>$ Westlake index ($5$).
  4. Scheduled ride duration verifies at ~38 minutes.
  5. Mode label strictly verifies as `"train"` with `🚆` icon.
  6. Zero transfers required; direct transit itinerary returned with highest score.

#### Scenario 2: Washington State Ferries Cross-Sound Voyage (Seattle $\rightarrow$ Bainbridge Island)
- **Origin:** Seattle Colman Dock (`[-122.3385, 47.6025]`)
- **Destination:** Bainbridge Island Ferry Terminal (`[-122.5115, 47.6235]`)
- **Verification Flow:**
  1. Terminal coordinates resolve to WSF water network edge.
  2. Maritime pattern confirms sailing schedule across Puget Sound.
  3. Ride duration calculated at ~35 minutes (maritime speed 500 m/min).
  4. Mode label strictly verifies as `"ferry"` with `⛴️` icon.
  5. Water ribbon renders without surface road bundling.

#### Scenario 3: Cross-Lake Multi-Modal Transfer (West Seattle $\rightarrow$ Bellevue Downtown)
- **Origin:** Alaska Junction (`SW Alaska St & California Ave SW`, `[-122.3865, 47.5610]`)
- **Destination:** Bellevue Downtown Station (`[-122.1935, 47.6150]`)
- **Verification Flow:**
  1. Leg 1: RapidRide C Line board at Alaska Junction, alight at 3rd Ave & Seneca St (~20 min ride).
  2. Transfer: Walk 1 min (80m) to Symphony Station tunnel platform.
  3. Buffer: Transfer wait strictly enforces $\ge 2$ minutes (e.g. 10 min connection).
  4. Leg 2: 2 Line East Link board at Symphony, alight at Bellevue Downtown (~27 min ride).
  5. Total duration: Verified sum of $walk1 + wait1 + ride1 + transferWalk + wait2 + ride2 + walk2$.
  6. Verified timetable status: `schedVerified: true`.

#### Scenario 4: Urban Neighborhood Connector (Capitol Hill $\rightarrow$ South Lake Union)
- **Origin:** Capitol Hill Station (`Broadway & E John St`, `[-122.3210, 47.6198]`)
- **Destination:** SLU Discovery Center (`Westlake Ave N & Denny Way`, `[-122.3380, 47.6185]`)
- **Verification Flow:**
  1. Access walk from Capitol Hill platform.
  2. Route 8 or First Hill / SLU Streetcar connection.
  3. Streetcar segments strictly labeled `"streetcar"` with `🚊` icon.
  4. Short-distance pedestrian alternative (1.4 km) evaluated and offered as direct walk option.

#### Scenario 5: Metro Downtown Through-Route (Queen Anne $\rightarrow$ Mount Baker)
- **Origin:** Queen Anne (`6th Ave W & W McGraw St`, `[-122.3645, 47.6390]`)
- **Destination:** Mount Baker Station (`[-122.2975, 47.5795]`)
- **Verification Flow:**
  1. Board Route 1 in Queen Anne traveling Southbound to Downtown.
  2. In Downtown Seattle, Route 1 automatically transitions into Route 14 Southbound.
  3. Engine identifies through-route pairing: displays "Stay on the bus" continuation.
  4. Zero transfer walk and zero layover wait penalty applied.
  5. Rider arrives at Mount Baker with continuous single-seat journey.

#### Scenario 6: Regional Multiscale Cartography Compilation Workflow
- **Scope:** Complete 345-route, 11,082-stop Puget Sound network.
- **Verification Flow:**
  1. Engine loads `site/data/network.json`, `routes.json`, and `stops.json`.
  2. Compiles ribbon geometry across zoom levels 10, 12, 14, 16, and 18.
  3. Invariant: 100% of feature coordinates finite (0 NaN, 0 Infinity).
  4. Invariant: Ribbon half-widths finite and strictly positive (`wm > 0`).
  5. Invariant: Junction strand swaps $\le 8$ (100% reduction from baseline 803 to 0).
  6. Invariant: Dual GPU stack orders rail layer ($1$) strictly above surface layer ($0$).

---

## 4. Adversarial Edge Case Matrix

| Adversarial Attack / Stressor | Failure Mode Risk | Test Strategy & Defense |
|---|---|---|
| **Special Characters in Route Labels** (`<script>`, `"`, `&`, `\0`, `\n`) | XSS injection in modal cards or broken JSON strings in `ATLAS_LIVE`. | Test inputs containing HTML meta-characters; verify proper entity escaping in `app.js` and `build_site.py`. |
| **Missing Transit Agency Feed** (e.g. King County Metro 503 error) | Partial map build missing primary urban corridors. | Verify pipeline guardrail raises `RuntimeError` if any of 5 required feeds fail. |
| **Discrepant Stop Coordinates** ($> 3000$m from route shape) | Stray line segments distorting corridor geometry across Puget Sound. | Verify `tools/validate_data.py` rejects network builds with stops $> 3$ km from route centerline. |
| **Reverse Stop Sequence Query** ($j < i$ on one-way corridor) | Routing rider backwards against physical transit travel direction. | Verify `timetableTripTimes` returns `null` and rejects backwards lookups. |
| **Zero Layover / Sub-2-Minute Connection** ($wait < 120$s) | Unrealistic connection causing rider to miss connecting bus. | Verify planner rejects candidate transfers where connection window is $< 2$ minutes. |
| **Layover $> 60$ Minutes** | Proposing impractical multi-hour layovers at transit centers. | Verify planner rejects candidate transfers where wait exceeds 60 minutes. |
| **Walking Sprint $> 360$m Between Platforms** | Recommending hazardous or impossible pedestrian sprints between distant routes. | Verify `transferDistance()` returns `Infinity` for stops separated by $> 360$m. |
| **Extreme Viewport Coordinates** ($[-180, 85]$ or NaN) | Divide-by-zero or infinite coordinate explosion in projection matrix. | Verify geometry compiler returns bounded coordinates or empty array. |
| **Live Vehicle Feed Rate-Limit / 429 Response** | UI lockup or lost vehicle positions during traffic spikes. | Verify live vehicle parser skips to next agency round without clearing existing fleet. |
| **Unpublished / Suspended Service Queried** | Recommending canceled or phantom buses. | Verify routes with 0 scheduled trips are excluded from timetable lookups. |

---

## 5. Test Suite Architecture & File Layout

```
seattle-transit-map/
├── TEST_INFRA.md                   # This document: Comprehensive 4-tier test infrastructure
├── TEST_READY.md                   # Published test readiness summary & execution log
├── tools/
│   ├── test_e2e_transit.py         # Primary E2E test runner (discovered by python -m unittest)
│   ├── test_routing_engine.js      # Companion Node.js test runner for routing & timetable contracts
│   ├── geometry_check.js           # Pure Node multiscale geometry & strand order test
│   ├── ribbon_check.js             # Pure Node WebGL GPU mesh & shader test
│   ├── validate_data.py            # Data pipeline & agency feed integrity validator
│   ├── check_repair.py             # Network graph repair & continuity test
│   ├── test_build.py               # Site compilation & credential safety unit tests
│   └── test_legend_features.py     # Legend features, POIs, and through-route unit tests
```

---

## 6. Execution Instructions

### 6.1 Complete Test Suite Execution
Execute the entire test suite via Python `unittest` discovery:
```bash
.venv/bin/python -m unittest discover -s tools -p 'test_*.py'
```

### 6.2 Standalone Component Verification
Individual verification scripts may be executed directly:
```bash
# Data integrity validation
.venv/bin/python tools/validate_data.py

# Graph repair validation
.venv/bin/python tools/check_repair.py

# Multiscale geometry check
node tools/geometry_check.js

# WebGL GPU ribbon shader check
node tools/ribbon_check.js

# Routing engine Node check
node tools/test_routing_engine.js
```
