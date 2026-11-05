# Rapid zoom and downtown rendering

The reported failure was a fast zoom that spread the route strands across downtown before
they rejoined. The supplied recording also showed uneven interaction around busy routes.

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

Native line layers remain as a startup fallback (`?noribbons`); `?noworker` keeps the mesh but
runs layout on the page. The offline, single-file preview includes the same renderer.
No transit data or API credentials changed.

## Verification

- Geometry: 10/10 checks, including every drawn route at five zoom levels and matching
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
