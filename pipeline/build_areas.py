"""On-demand and paratransit service areas.

  dart    King County Metro Dial-a-Ride (DART) service areas — official polygons from
          King County GIS (layer DART_AREA_720).
  access  Approximate Access Transportation (ADA paratransit) area: 3/4 mile around
          Metro's all-day bus routes, the federal ADA rule (49 CFR 37.131). Approximate:
          Access also follows each route's hours.
  flex    Metro Flex zone label points (King County's system-map click areas). The
          zone boundaries themselves are not published as open data.
"""
import json
import os
import sys
import urllib.request

import shapely

from pyproj import Transformer
from shapely.geometry import LineString, box, mapping, shape
from shapely.ops import unary_union


def transform(fn, g):
    return shapely.transform(g, lambda xy: __import__('numpy').column_stack(fn(xy[:, 0], xy[:, 1])))

sys.path.insert(0, os.path.dirname(__file__))
from config import CACHE, REGION, SITE  # noqa: E402

KC = "https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services"
SOURCES = {
    "dart_areas.geojson": f"{KC}/DART_AREA_720/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
    "flex_areas.geojson": f"{KC}/MetroSystemWebMap_ClickAreas_2026Sept_DRAFT2/FeatureServer/16/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
}
EXT = os.path.join(CACHE, "ext")
fwd = Transformer.from_crs(4326, 32610, always_xy=True).transform
inv = Transformer.from_crs(32610, 4326, always_xy=True).transform


def get(name):
    path = os.path.join(EXT, name)
    if not os.path.exists(path):
        os.makedirs(EXT, exist_ok=True)
        urllib.request.urlretrieve(SOURCES[name], path)
    return json.load(open(path))


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

    flex = []
    seen = set()
    for f in get("flex_areas.geojson")["features"]:
        name = f["properties"]["ROUTE"]
        c = shape(f["geometry"]).centroid
        if name in seen or not box(REGION["west"] - 0.01, REGION["south"] - 0.01, REGION["east"] + 0.01, REGION["north"] + 0.01).contains(c):
            continue
        seen.add(name)
        flex.append({"type": "Feature", "properties": {"name": name},
                     "geometry": {"type": "Point", "coordinates": [round(c.x, 5), round(c.y, 5)]}})

    out = {
        "dart": {"type": "FeatureCollection", "features": dart},
        "access": {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {}, "geometry": rounded(access)}]},
        "flex": {"type": "FeatureCollection", "features": flex},
    }
    path = os.path.join(SITE, "data", "areas.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(f"areas: {len(dart)} DART, {len(flex)} Flex pins, access polygon; {os.path.getsize(path)/1e3:.0f} KB")


if __name__ == "__main__":
    main()
