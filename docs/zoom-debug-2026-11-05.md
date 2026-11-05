# Rapid zoom and downtown rendering

The reported failure was a fast zoom that spread the route strands across downtown before
they rejoined. The supplied recording also showed uneven interaction around busy routes.
The follow-up request was to make shared routes cohesive and easy to choose: individual
strands had become too thin to understand or select reliably.

## Cause and change

Route positions were geographic coordinates, but widths were composite MapLibre expressions
evaluated inside each tile. MapLibre 4.7.1's
[CompositeExpressionBinder](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/data/program_configuration.ts)
clamps interpolation to a tile's zoom range. When a fast zoom temporarily draws a parent
tile, positions can expand farther than its widths. Repeated layouts and source replacements
during the gesture also compete with tile work.

`web/ribbons.js` draws the same route geometry as a world-space mesh through MapLibre's
custom-layer interface. Its positions, lane offsets and widths share the camera transform.
The geometry worker compiles and transfers typed buffers; the page uploads them and uses
separate surface/rail, casing, body and pattern passes. Geographic coordinates are relative
to a local origin to preserve precision. Vertex state belongs to a dedicated VAO. Replaced
buffers and removed layers release their resources.

The current mesh follows a gesture. `moveend` requests one final layout; newer pending
requests replace older ones, and stale results cannot interrupt movement. A smaller padded
view and subpixel simplification remove excess geometry. Hit testing indexes the displayed
paths, independently of tiled line widths. Hover fades change opacity, and a pending hover
queue retains only the newest target instead of rebuilding width styles every frame.

The overview now draws each service type once per street as a solid band, growing gently
with route count, capped at 2.6 single-route widths. Individual route paths remain available
for selection and preview. Shared-band hover highlights the street rather than every route.
Tapping opens a side-panel chooser with all visible routes, a number/destination filter,
large buttons, and no 16-route cutoff. Back from a chosen route returns to the list. Local
and peak buses have stronger base widths and contrast, and selected paths are bolder.
Overview land vehicles stay 38 pixels apart; selected routes retain all their vehicles.
Vehicle taps use the badge's actual center distance rather than its expanded query box.
The visible badge also takes priority over a route-number tag underneath it; nearby band
taps remain available for the route chooser.

Native line layers remain as a startup fallback (`?noribbons`); `?noworker` keeps the mesh but
runs layout on the page. The offline, single-file preview includes the same renderer.
No transit data or API credentials changed.

## Verification

- Geometry: 11/11 checks, including every drawn route at five zoom levels and matching
  selected/hover geometry. Strand-order score remains 42.
- Renderer: 8/8 checks for large zoom jumps, bounded joins, outward caps, duplicate points,
  rail ordering, transit patterns, selection/hover and transferable buffers.
- Build and credential handling: 5/5 checks, including the new file and inline preview.
- Desktop browser: 28/28 checks for search, layers, route/stop cards, zooms and themes.
- Phone layout at 390 × 844: 8/8 checks.
- Phone zoom/pan at 390 × 844: 8/8 checks, with no route source changes during either gesture.
- Rapid zoom/pan: the desktop regression passed 9/9. The previous release requested six
  layouts for the tested zoom and replaced the route source four times while moving; the
  new code requested one final layout and made no replacements while moving.
- Hovering a downtown strand displayed its route and highlight with zero network rebuilds.
- Corridor chooser: 14/14 on desktop and 14/14 at phone width. A 27-route corridor listed
  every route, filtered and selected a route beyond the old cutoff, preserved the chooser
  through a theme refresh, and returned to the complete list. Rows are at least 48 px tall.
  An isolated badge fixture also checks direct badge taps and adjacent band taps separately.
- WSF/WSDOT fixture: 12/12, including fresh/stale positions, terminal notes, cancellations,
  car-space counts, and road-alert failure handling.
- Bellevue and university-area bands were inspected alongside downtown. In a matched
  downtown layout with every service enabled, the base drawing fell from 260 to 166
  features and from 2,944 to 1,265 points; three-build median layout time was 16 to 10 ms
  on this machine. These are geometry measurements, separate from browser frame timing.
- Native fallback loaded 2,140 route features. The mesh also restored visible route geometry
  after a deliberately lost/restored graphics context.
- Worker fallback selected Route 49 with 29 path pieces and 19 snapped stops; the mesh was
  active and the graphics context reported no error.

Frame timings varied with host load and tile readiness; they are recorded locally for
diagnosis, not used as a fixed FPS claim. A synthetic graphics reset also produces native
MapLibre GL errors in the forced-native fallback; this predates the mesh renderer. Physical
phone battery use and the user's exact Zen session were not measured.

The repeatable browser harness is `tools/zoom_check.js`; sanitized local reports and
screenshots are ignored by Git. Node renderer checks run in both CI and the Pages workflow.
