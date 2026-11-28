"""OpenStreetMap streets and paths near the bike network, for straightening its geometry.

The county regional trails (pipeline/trails_saved.json) have points 50-200 m apart, so a trail
that curves is drawn as a row of straight pieces with sharp angles, and SDOT's own lines
(pipeline/sdot_bikes.json.gz) run down the street's centre line. OpenStreetMap's own lines (from
the same z14 OpenFreeMap tiles the street matching uses) follow every curve and every path. This
keeps the streets, cycleways and paths within 40 m of a bike line of either source and writes them
to pipeline/bike_osm.json.gz, which pipeline/clean_bikes.py snaps the bike network onto.

Needs the network (it downloads the z14 tiles if they are not cached):
    python3 tools/extract_bike_osm.py
"""
import gzip
import json
import math
import os
import sys

import numpy as np
import shapely
from shapely.geometry import LineString, shape
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "pipeline"))
import match_shapes as ms  # noqa: E402

OUT = os.path.join(HERE, "..", "pipeline", "bike_osm.json.gz")
TRAILS = os.path.join(HERE, "..", "pipeline", "trails_saved.json")
SDOT = os.path.join(HERE, "..", "pipeline", "sdot_bikes.json.gz")
KEEP = ms.ROAD_CLASSES | {"path", "track", "cycleway"}
NEAR = 40.0


def main():
    if not ms.tile_dir():
        ms.download_tiles()
    feats = json.load(open(TRAILS))["features"]
    if os.path.exists(SDOT):
        sd = json.load(gzip.open(SDOT, "rt"))
        feats = feats + [f for lay in sd["layers"].values() for f in lay["features"]]
    bikes = []
    for f in feats:
        g = shape(f["geometry"])
        for part in getattr(g, "geoms", [g]):
            xs, ys = ms.fwd.transform(*np.asarray(part.coords).T)
            bikes.append(LineString(list(zip(xs, ys))))
    near = STRtree(bikes)
    base, n = ms.tile_dir(), 2 ** ms.Z
    import mapbox_vector_tile
    out = []
    for tx, ty in ms.tile_range():
        f = os.path.join(base, str(tx), f"{ty}.pbf")
        if not os.path.exists(f):
            continue
        d = mapbox_vector_tile.decode(open(f, "rb").read(), default_options={"y_coord_down": True})
        tr = d.get("transportation")
        if not tr:
            continue
        ext = tr["extent"]
        cand = []
        for ft in tr["features"]:
            p = ft["properties"]
            cls, sub = p.get("class"), p.get("subclass") or ""
            if cls not in KEEP or sub in ("steps", "pedestrian", "platform", "corridor"):
                continue
            g = ft["geometry"]
            parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"] if g["type"] == "MultiLineString" else []
            for part in parts:
                if len(part) < 2:
                    continue
                ls = shapely.clip_by_rect(LineString(part), 0, 0, ext, ext)
                for seg in getattr(ls, "geoms", [ls]):
                    if seg.is_empty or seg.geom_type != "LineString" or seg.length == 0:
                        continue
                    c = np.asarray(seg.coords)
                    lon = (tx + c[:, 0] / ext) / n * 360 - 180
                    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (ty + c[:, 1] / ext) / n))))
                    xs, ys = ms.fwd.transform(lon, lat)
                    cand.append((LineString(list(zip(xs, ys))), lon, lat, cls, sub, p.get("brunnel") or "", p.get("oneway") or 0))
        if not cand:
            continue
        hit = set(near.query([c[0] for c in cand], predicate="dwithin", distance=NEAR)[0].tolist())
        for i in sorted(hit):
            _, lon, lat, cls, sub, br, ow = cand[i]
            out.append([cls, sub, br, [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)]])
    with gzip.open(OUT, "wt") as fh:
        json.dump({"source": "OpenFreeMap z14 transportation", "ways": out}, fh, separators=(",", ":"))
    print(f"{len(out)} OSM pieces near the bike network -> {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
