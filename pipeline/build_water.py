"""Where the water is, as a small picture the trip planner can look things up in.

The planner walks people between stops, and from where they start and end to stops. A walk that
crosses a bay or a lake is not a walk (Sinclair Inlet is 2 km wide between Annapolis and Bremerton;
only the ferry crosses it), so it needs to know where the water is. The map's own base-map tiles
(site/tiles/base.txt, zoom 11) have the water polygons; this draws them into a grey-scale PNG of
about 50 m per pixel and writes it, with the numbers needed to find a point in it, to
site/data/water.json. Narrow crossings (a canal, a ship channel) are bridges a person can walk, so
the page only refuses a walk whose line runs over water for hundreds of metres.

    python3 pipeline/build_water.py
"""
import base64
import gzip
import io
import json
import math
import os
import struct
import sys
import zlib

import mapbox_vector_tile
import numpy as np
from skimage.draw import polygon as fill_polygon

sys.path.insert(0, os.path.dirname(__file__))
from config import REGION, SITE  # noqa: E402

Z = 11          # tile zoom the water is read from (about 104 m a pixel at 128 pixels a tile)
PX = 128        # pixels a tile gets in the picture (about 104 m each: small enough to decode on a phone)
OUT = os.path.join(SITE, "data", "water.json")


def lon2x(lon):
    return int((lon + 180) / 360 * 2 ** Z)


def lat2y(lat):
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z)


def read_archive(path):
    raw = base64.b64decode(open(path).read())
    n = struct.unpack("<I", raw[:4])[0]
    index = json.loads(raw[4:4 + n])
    return index, raw[4 + n:]


def png_gray(img):
    """An 8-bit grey-scale PNG of a uint8 array (no outside imaging library needed)."""
    h, w = img.shape

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + img[y].tobytes() for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def main():
    index, blob = read_archive(os.path.join(SITE, "tiles", "base.txt"))
    x0, x1 = lon2x(REGION["west"]), lon2x(REGION["east"])
    y0, y1 = lat2y(REGION["north"]), lat2y(REGION["south"])
    w, h = (x1 - x0 + 1) * PX, (y1 - y0 + 1) * PX
    img = np.zeros((h, w), np.uint8)
    found = 0
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            ent = index.get(f"{Z}/{tx}/{ty}")
            if not ent:
                continue
            found += 1
            tile = mapbox_vector_tile.decode(gzip.decompress(blob[ent[0]:ent[0] + ent[1]]), default_options={"y_coord_down": True})
            layer = tile.get("water")
            if not layer:
                continue
            k = PX / layer.get("extent", 4096)
            ox, oy = (tx - x0) * PX, (ty - y0) * PX
            for f in layer["features"]:
                g = f["geometry"]
                polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]] if g["type"] == "Polygon" else []
                for rings in polys:
                    for i, ring in enumerate(rings):
                        a = np.array(ring, dtype=float) * k
                        rr, cc = fill_polygon(a[:, 1] + oy, a[:, 0] + ox, img.shape)
                        img[rr, cc] = 255 if i == 0 else 0  # the outline is water; a ring inside it is an island
    if not found:
        raise SystemExit(f"no zoom-{Z} tiles in site/tiles/base.txt for the map area")
    frac = (img > 0).mean()
    print(f"water: {found} tiles, {w}x{h}px, {frac * 100:.1f}% water")
    if not 0.01 < frac < 0.5:
        raise SystemExit("water picture looks wrong")
    png = png_gray(img)
    json.dump({"z": Z, "x0": x0, "y0": y0, "px": PX, "w": w, "h": h,
               "png": base64.b64encode(png).decode()}, open(OUT, "w"), separators=(",", ":"))
    print(f"water.json {os.path.getsize(OUT) / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
