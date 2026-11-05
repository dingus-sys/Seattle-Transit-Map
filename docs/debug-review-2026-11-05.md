# Map debug review, November 5, 2026

Published to the existing GitHub Pages site on November 5, 2026. The initial release was
`1294d18`; its Check map and Pages workflows succeeded. The agent handles saving finished
updates to GitHub and publishing, without making the user perform a push.

The map keeps its shared corridors and service colors. Route ordering now minimizes actual
strand inversions, including pairs that travel together for several blocks. Corners use a
simpler centerline, and small folds caused by offsetting a strand around a tight turn are
clipped without moving its endpoints. Real crossings and rail/surface separation remain.

| Check | Previous version | Prepared version |
| --- | ---: | ---: |
| Strand swaps detected at junctions | 287 | 42 |
| Raw network JSON size | 5,311,368 bytes | 956,447 bytes |
| Network edges | 3,526 | 3,606 |
| Routes retained | 345 | 345 |
| Vehicle marker redraw interval | 125 ms | 1,000 ms |

The network file is 82.0% smaller. Surface traces are simplified within 2 m while junction
endpoints, rail and ferry geometry are retained. The final continuity pass filled four
gaps, reconnected 20 loose ends, and restored 35 omitted source spans; these are operation
counts, not counts of independent locations. They include the missing I-5 section shared
by 201, 202 and 513 in South Everett. The repair is idempotent on the resulting network.

The source audit found no remaining continuous omissions longer than 300 m that are more
than 160 m from the drawing, using the current clipped, matched route shapes. These bounds
allow the simplified junctions and one-way street pairs; they do not certify exact road
alignment or every low-frequency trip variant.

WSF vessels now work independently of the OneBusAway key. Opening a WSF route or terminal
loads terminal notes, reported upcoming sailings, cancellations and drive-up vehicle spaces.
Missing capacity remains unknown, a full vehicle deck is distinct from walk-on availability,
and stale counts are hidden. WSDOT highway reports appear separately in the alerts panel;
they do not claim a confirmed bus detour. Failed refreshes retain recent notices and show
an availability message. Stale live positions give way to timetable estimates without
duplicating vehicles. API callbacks are cleaned up and requests have timeouts.

The Pages build accepts the existing `WSP_KEY` and `WSDOT_KEY` secret names. Credential
values are JSON encoded during the build. Default local builds contain placeholders, and
the test fixtures contain only dummy values. The Pages workflow now checks route geometry
before publishing; pull requests have a separate source/build/geometry check workflow.

Validation completed locally:

- 10/10 geometry checks across zooms 10–18, including selection/hover agreement.
- 5/5 source-repair regression tests, including terminal branches and direction preservation.
- 4/4 credential/build regression tests.
- 28/28 desktop interaction checks, including search, layers, direction tabs and malformed links.
- All 345 route cards opened with the matching route content and no missing cards.
- 8/8 phone checks at 390 × 844, including sheet states and horizontal overflow.
- 12/12 WSF/WSDOT fixture checks, including route-specific folded tips, unavailable feeds,
  stale data and cancellations.
- The no-worker fallback loaded Route 49, with its line, selected path and stops.
- Fractional display scaling no longer produces mismatched icon-image sizes.
- Workflow YAML parses, JavaScript/Python source checks pass, and the keyless site builds.

Before/after views were inspected at Denny/I-5 and South Everett. Local screenshots are in
the ignored `shots/` directory; they are not included in the deployed website.

Live publication checks confirmed valid HTTP 200 responses for WSF vessel locations,
service bulletins, terminal notes, vehicle-space reports and WSDOT highway alerts. The
published app/geometry versions and network content matched the tested release. Browser
verification confirmed live vehicles, terminal conditions and road notices without exposing
credential values. A follow-up makes arrival tips specific to the selected crossing and
folded by default, with sailing times and vehicle spaces shown first.

The full GTFS download and street-matching
pipeline was not rerun; the new repair step regenerated the network using the existing matched
shapes. Rare trip variants below the existing 15% drawing threshold can still have stops listed
outside the drawn path. Battery use and performance on a physical older phone were not measured.
