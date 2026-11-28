"""SDOT's own bike network, exactly as its bike map shows it: pipeline/sdot_bikes.json.gz.

The bike network the map used (pipeline/trails_saved.json) was a simplified copy: points 50-300 m
apart, painted and buffered lanes folded into one kind, no climbing lanes or "unidentified"
pieces, and planned facilities mixed in with built ones. This downloads SDOT's "Existing Bike
Facilities" layer (the one SDOT's bike web map draws, with its eight kinds: Neighborhood
Greenways, Protected, Buffered and Painted Bike Lanes, Climbing Lanes, Sharrows, Off-Street
Bicycle Facilities and Unidentified) and its Multi-use Trails layer, at full resolution, from
the City of Seattle's ArcGIS service, and keeps the fields the map uses.

The sandbox can't reach the City's servers, so the sdot-bikes.yml workflow runs this on GitHub
and commits the result back to the working branch:
    python3 tools/extract_sdot_bikes.py
"""
import datetime
import gzip
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "pipeline", "sdot_bikes.json.gz")
BASE = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Bike_Facilities/FeatureServer"
LAYERS = {"existing": "Existing Bike Facilities", "trails": "Multi-use Trails"}
# fields of the existing-facilities layer the map uses (the rest are asset-management records)
KEEP = ["OBJECTID", "CATEGORY", "UNITID", "UNITDESC", "UNITTYPE", "CURRENT_STATUS", "INSTALL_DATE", "ASSET_WIDTH",
        "STYLE", "MATERIAL", "COMPKEY", "SEGKEY", "Shape__Length"]
PAGE = 1000


def get(url, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "transit-map-data/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise
            print(f"  retry {k + 1}: {e}")
            time.sleep(3 * (k + 1))


def rnd(c):
    if isinstance(c, (list, tuple)):
        return [rnd(x) for x in c]
    return round(c, 6)


def fetch(layer_id, keep=None):
    meta = get(f"{BASE}/{layer_id}?f=json")
    fields = [f["name"] for f in meta.get("fields", [])]
    out_fields = [f for f in (keep or fields) if f in fields and not f.startswith("ATTACHMENT")]
    feats, off = [], 0
    while True:
        q = urllib.parse.urlencode({"where": "1=1", "outFields": ",".join(out_fields), "outSR": 4326, "f": "geojson",
                                    "orderByFields": "OBJECTID", "resultOffset": off, "resultRecordCount": PAGE})
        d = get(f"{BASE}/{layer_id}/query?{q}")
        fs = d.get("features") or []
        for f in fs:
            g = f.get("geometry")
            if not g:
                continue
            g["coordinates"] = rnd(g["coordinates"])
            p = {k: v for k, v in (f.get("properties") or {}).items() if v not in (None, "", " ")}
            feats.append({"type": "Feature", "properties": p, "geometry": g})
        more = d.get("exceededTransferLimit") or (d.get("properties") or {}).get("exceededTransferLimit")
        if not fs or (not more and len(fs) < PAGE):
            break
        off += len(fs)
    return meta, fields, feats


def main():
    root = get(f"{BASE}?f=json")
    layers = {l["name"]: l["id"] for l in root.get("layers", [])}
    print("layers:", layers)
    out = {"source": BASE, "fetched": datetime.date.today().isoformat(), "layers": {}}
    for key, want in LAYERS.items():
        lid = next((i for n, i in layers.items() if n.lower().startswith(want.lower())), None)
        if lid is None:
            sys.exit(f"no layer named like {want!r} in {BASE}")
        meta, fields, feats = fetch(lid, KEEP if key == "existing" else None)
        r = (meta.get("drawingInfo") or {}).get("renderer") or {}
        labels = {str(u.get("value")): u.get("label") for u in r.get("uniqueValueInfos", [])}
        print(f"\n{want} (layer {lid}): {len(feats)} features; fields: {fields}")
        print(f"  renderer field: {r.get('field1')}; labels: {labels}")
        if key == "existing":
            miles, n = defaultdict(float), Counter()
            for f in feats:
                c = f["properties"].get("CATEGORY") or "<Null>"
                n[c] += 1
                miles[c] += (f["properties"].get("Shape__Length") or 0) / 5280.0
            for c, k in n.most_common():
                print(f"  {c:10s} {labels.get(c, '?'):45s} {k:5d} pieces {miles[c]:7.1f} mi")
            print("  status:", Counter(f["properties"].get("CURRENT_STATUS") for f in feats).most_common())
        else:
            print("  sample:", feats[0]["properties"] if feats else None)
        out["layers"][key] = {"id": lid, "name": next(n for n, i in layers.items() if i == lid), "labels": labels,
                              "type": "FeatureCollection", "features": feats}
    with gzip.open(OUT, "wt") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"\nwrote {OUT} ({os.path.getsize(OUT) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
