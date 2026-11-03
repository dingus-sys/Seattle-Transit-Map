# King County Transit Map

An interactive, zoomable map of Puget Sound public transit from Everett and Marysville to
Tacoma, Lakewood, Puyallup and on to Olympia, Lacey and Tumwater, across to Bremerton,
Bainbridge, Port Orchard, Gig Harbor and Vashon, and east to Monroe and North Bend: Link light rail (1, 2 and T Lines), Sounder,
Amtrak, the streetcars, the Monorail, RapidRide, Swift, every King County Metro, Community
Transit, Pierce Transit, Everett Transit, Kitsap Transit, Intercity Transit and ST Express bus, the Water Taxi,
state and Kitsap ferries, Dial-a-Ride (DART) areas, Metro Flex zones and the Access
paratransit area, plus live vehicle positions.

Lines follow the real streets, in the manner of the printed Seattle Transit Map: a street
carrying one route is one line, a street carrying two is a line twice as wide, and busier
streets wider still. Each route is its own strand of that line, so where a route turns off,
its strand peels away on its own. The 1 and 2 Lines, which share track, are one line, green
on one half and blue on the other. Hover a wide line and the route whose strand is under the
pointer lights up end to end, with its stops and arrows where it runs one way only. Point at a single number on a
route tag (the "62" in "45 | 62 | 75") to see just that route; click it to open it. A tag's
numbers read in the same order as the lines under it, in the same colors. Hover any stop
for a card with its routes and next departures (from the timetable). Click a line for its
frequency, hours, schedule at a glance and stop list; click a stop to see every route that
serves it.

## What's in here

```
pipeline/         Python build steps (run in this order by build_all.py)
  config.py         map area (REGION) and data sources
  build_basemap.py  base map tiles + label fonts from OpenFreeMap, trimmed and packed
  process_gtfs.py   routes, categories, frequencies, hours, stops (Puget Sound GTFS)
  build_areas.py    DART areas, Access area, Metro Flex zones
  match_shapes.py   snaps every bus and streetcar route onto the real street network
  build_graph.py    the shared-corridor network and ribbon order
  build_site.py     assembles web/ into site/index.html (+ artifact.html)
web/              page template, styles, app script and geom.js (the line geometry engine)
site/             the finished static site (this is what gets published)
.github/workflows pages.yml publishes site/; refresh-data.yml rebuilds data weekly
```

## Build

```bash
pip install -r requirements.txt
python3 pipeline/build_all.py
python3 -m http.server -d site 8000   # then open http://localhost:8000
```

## Changing the map area

The map area is one setting: `REGION` in `pipeline/config.py`. Edit it and run
`python3 pipeline/build_all.py`; routes, stops, the network and the bundled base map are
rebuilt for the new area.

## Schedule feeds

Each agency's own GTFS feed is listed in `FEEDS` in `pipeline/config.py` (the consolidated
Puget Sound file stops being published in January 2027). Current feed locations are
listed at https://mobilitydatabase.org.

## Live vehicles

Positions come from OneBusAway Puget Sound's GTFS-realtime feeds (and Intercity Transit's
own open feed, which needs no key; see `LIVE_FEEDS` in `pipeline/config.py`), polled every 20 seconds
while the page is open (about 60 KB per update for the whole region). It needs a free API
key from oba_api_key@soundtransit.org:

- on GitHub, add a repository secret named `OBA_API_KEY` (Settings → Secrets and variables
  → Actions). The Pages workflow puts it into the deployed page; the repository itself only
  holds a placeholder.
- locally, put `{"oba_api_key": "..."}` in `pipeline/local_secrets.json` (git-ignored) and
  build with `python3 pipeline/build_site.py --with-key` to test live data.

Each vehicle sits on its route's line and shows when it last reported and whether it's on
time, early or late (OneBusAway's vehicle status, fetched for one agency per update round).

The key does end up in the deployed page, as it must for a browser to call the API directly.
The claude.ai preview can't reach outside servers, so live vehicles show only on the website.

## How the map is drawn

Like Seattle's printed Transit Network map, streets are drawn as service lines rather
than one line per route: every frequent bus on a street shares one green line, every
all-day bus one blue line, RapidRide is red with white dots, Link is navy with a white
center. The route numbers ride along as stacked tags, one stack per stretch of street.

Agency route shapes are drawn loosely: they cut corners across intersections and wander a
few meters off the street. `match_shapes.py` first snaps every bus and streetcar route onto
OpenStreetMap's streets (from the base-map tiles), the way a GPS trace is matched to roads:
a hidden Markov model scores positions on nearby streets by how close they are to the shape,
and moves between them by whether the street distance agrees with the shape's, and the best
path (Viterbi) follows real streets and turns at real intersections. Routes on the same
street then lie exactly on top of each other, and junctions are pinned to the street
intersections the routes actually use.

`build_graph.py` draws every route as a band about 16 m wide (about 70 m on freeways, so both
carriageways become one line), merges the bands, and thins them to a centerline. That becomes a graph of street segments; junctions are then moved
back onto the agencies' real shapes and each segment is redrawn from the best-matching
route shape. Each segment learns which routes use it, and the routes are ordered so that
for any two, the one that turns left ends up on the left, with the same order carried
along whole corridors. Rail, surface and water services are separate networks, so trains
in tunnels aren't bundled with the buses above them.

Where a route's own shape cuts across a big interchange and the traced streets don't follow
it, the missing stretch is drawn from the route's shape, so no route breaks off mid-way.

In the browser, `web/geom.js` lays out each view: every route is one continuous strand,
corners are rounded, each route keeps its place across the street through junctions (whole
bundles slide sideways to make that possible), and when a strand must change sides it eases
across, all strands at a junction over the same distance so they stay side by side. Line
widths are in line units that the map turns into pixels continuously, so lines don't jump in
thickness while you zoom. That
work runs in a background worker so panning and zooming stay smooth (`web/app.js` only hands
the finished lines to the map); where workers aren't allowed it runs on the page instead. Add
`?noworker` to the address to force that.

## Data and credits

- Routes, stops and schedules: each agency's GTFS feed (King County Metro, Sound Transit,
  Community Transit, Pierce Transit, Everett Transit, Intercity Transit, City of Seattle,
  Washington State Ferries, Kitsap Transit, Seattle Center Monorail, Amtrak).
- Live vehicle positions: OneBusAway Puget Sound. When live data isn't available the map
  shows positions estimated from the timetable.
- DART service areas: King County GIS (ArcGIS Online).
- Metro Flex zones and hours: the service-area map on King County Metro's Metro Flex page.
- Access paratransit area: computed with the ADA ¾-mile rule around Metro's all-day
  routes; approximate.
- Base map: © OpenStreetMap contributors, OpenMapTiles schema, served by OpenFreeMap.
- Map rendering: MapLibre GL JS.

Frequencies are counted from the published schedule for one sample Wednesday,
Saturday and Sunday, in the busier direction, from each trip's first stop.
