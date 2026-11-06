"""On-demand and paratransit service areas.

  dart    King County Metro Dial-a-Ride (DART) service areas — official polygons from
          King County GIS (layer DART_AREA_720).
  access  Approximate Access Transportation (ADA paratransit) area: 3/4 mile around
          Metro's all-day bus routes, the federal ADA rule (49 CFR 37.131). Approximate:
          Access also follows each route's hours.
  flex    Metro Flex zones and their hours, from the service-area map on Metro's Metro Flex
          page (metrotransit.net/metro-flex/service-map). A copy is kept in
          pipeline/flex_zones.json in case that map moves.
"""
import json
import os
import re
import sys
import urllib.request

import shapely

from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, box, mapping, shape
from shapely.ops import linemerge, polylabel, unary_union


def transform(fn, g):
    return shapely.transform(g, lambda xy: __import__('numpy').column_stack(fn(xy[:, 0], xy[:, 1])))

sys.path.insert(0, os.path.dirname(__file__))
from config import CACHE, REGION, SITE  # noqa: E402

KC = "https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services"
SOURCES = {
    "dart_areas.geojson": f"{KC}/DART_AREA_720/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
}
FLEX_PAGE = "https://kingcounty.gov/en/dept/metro/travel-options/metro-flex"
FLEX_MAP = "https://metrotransit.net/metro-flex/service-map/_release/v3-2-5-4/"
FLEX_SAVED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "flex_zones.json")
TRAILS_SAVED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trails_saved.json")
EXT = os.path.join(CACHE, "ext")
fwd = Transformer.from_crs(4326, 32610, always_xy=True).transform
inv = Transformer.from_crs(32610, 4326, always_xy=True).transform


def get(name):
    path = os.path.join(EXT, name)
    if not os.path.exists(path):
        os.makedirs(EXT, exist_ok=True)
        urllib.request.urlretrieve(SOURCES[name], path)
    return json.load(open(path))


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "king-county-transit-map (build script)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def flex_zones():
    """Metro Flex zones and hours from the service map embedded on Metro's Metro Flex page.
    The page names the map's current release; the saved copy is the fallback."""
    try:
        base = FLEX_MAP
        m = re.search(r'data-src="(https://metrotransit\.net/metro-flex/service-map/[^"?]*/)', fetch(FLEX_PAGE))
        if m:
            base = m.group(1)
        areas = json.loads(fetch(base + "data/service-areas.json"))
        hours = json.loads(fetch(base + "data/service-area-hours.json"))
        if not areas.get("features"):
            raise ValueError("no zones in the service map")
        json.dump({"source": base, "areas": areas, "hours": hours}, open(FLEX_SAVED, "w"), separators=(",", ":"))
        return areas, hours
    except Exception as e:  # network trouble or a changed page: keep the last good copy
        print(f"Metro Flex service map unavailable ({e}); using the saved copy")
        saved = json.load(open(FLEX_SAVED))
        return saved["areas"], saved["hours"]


def regional_trails(view):
    """Major regional multi-use bike trails across Seattle, the Eastside, and Puget Sound."""
    if os.path.exists(TRAILS_SAVED):
        try:
            saved = json.load(open(TRAILS_SAVED))
            feats = []
            for f in saved.get("features", []):
                g = shape(f["geometry"])
                if g.intersects(view):
                    feats.append(f)
            return feats
        except Exception as e:
            print(f"Error reading saved trails ({e})")
    return []


def rounded(geom, nd=5):
    def rnd(o):
        if isinstance(o, (list, tuple)):
            if o and isinstance(o[0], (int, float)):
                return [round(o[0], nd), round(o[1], nd)]
            return [rnd(x) for x in o]
        return o
    m = mapping(geom)
    return {"type": m["type"], "coordinates": rnd(m["coordinates"])}


def main():
    pad = 0.08
    view = box(REGION["west"] - pad, REGION["south"] - pad, REGION["east"] + pad, REGION["north"] + pad)
    routes = {r["id"]: r for r in json.load(open(os.path.join(SITE, "data", "routes.json")))["routes"]}

    dart = []
    by_route = {}
    for f in get("dart_areas.geojson")["features"]:
        g = shape(f["geometry"]).buffer(0)
        rid = str(f["properties"]["ROUTE_ID"])
        by_route.setdefault(rid, []).append(g)
    for rid, gs in by_route.items():
        g = unary_union(gs)
        if not g.intersects(view):
            continue
        slug = f"metro-{rid}"
        dart.append({"type": "Feature", "properties": {"route": rid, "slug": slug if slug in routes else None},
                     "geometry": rounded(g.simplify(0.00005))})

    shapes = json.load(open(os.path.join(CACHE, "route_shapes.json")))
    lines = []
    for slug, s in shapes.items():
        r = routes.get(slug)
        if not r or r["agencyShort"] != "Metro" or r["cat"] not in ("frequent", "local", "rapidride"):
            continue
        for line in s["lines"]:
            lines.append(transform(fwd, LineString(line)))
    region_m = transform(fwd, box(REGION["west"], REGION["south"], REGION["east"], REGION["north"]))
    access = unary_union([l.buffer(1207, quad_segs=6) for l in lines]).intersection(region_m.buffer(1500))
    access = transform(inv, access.simplify(25))

    flex, flex_labels = [], []
    areas, hours = flex_zones()
    for f in sorted(areas["features"], key=lambda f: f["properties"].get("sort_order", 0)):
        p = f["properties"]
        if not p.get("in_service", True):
            continue
        g = shape(f["geometry"]).buffer(0)
        if not g.intersects(view):
            continue
        h = hours.get(p.get("slug"), {})
        when = {k: (h.get(k) or {}).get("en", "") for k in ("weekdays", "saturday", "sunday")}
        props = {"name": p["name"], **when}
        flex.append({"type": "Feature", "properties": props, "geometry": rounded(g.simplify(0.00003))})
        pt = polylabel(g, tolerance=0.0005) if g.geom_type == "Polygon" else g.representative_point()
        flex_labels.append({"type": "Feature", "properties": props,
                            "geometry": {"type": "Point", "coordinates": [round(pt.x, 5), round(pt.y, 5)]}})

    trails = regional_trails(view)

    out = {
        "dart": {"type": "FeatureCollection", "features": dart},
        "access": {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {}, "geometry": rounded(access)}]},
        "flex": {"type": "FeatureCollection", "features": flex},
        "flexLabels": {"type": "FeatureCollection", "features": flex_labels},
        "trails": {"type": "FeatureCollection", "features": trails},
    }
    path = os.path.join(SITE, "data", "areas.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(f"areas: {len(dart)} DART, {len(flex)} Metro Flex zones, {len(trails)} bike trails, access polygon; {os.path.getsize(path)/1e3:.0f} KB")


if __name__ == "__main__":
    main()
