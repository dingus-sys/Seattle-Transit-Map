"""Download OpenFreeMap (OpenMapTiles schema) vector tiles for the map area,
keep only the layers and attributes this map draws, and pack them into a few
archive files the web page can load without any outside tile server.

Archive format (".tar"-like, but simpler), stored base64-encoded in a .txt file so any
static host (including the claude.ai artifact viewer, which serves only web file types)
can serve it:
    4 bytes  little-endian uint32: length N of the JSON index
    N bytes  UTF-8 JSON: {"z/x/y": [offset, length], ...}  (offsets relative to data start)
    ...      concatenated gzip-compressed tiles
Label fonts go in fonts/glyphs.json: {"regular/0-255": "<base64 pbf>", ...}.
"""
import base64
import gzip
import io
import json
import math
import os
import struct
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(__file__))
from config import CACHE, CONTEXT, CONTEXT_MAXZOOM, DETAIL_MAXZOOM, FONTS_URL, REGION, SITE, TILEJSON_URL  # noqa: E402
from mapbox_vector_tile.Mapbox import vector_tile_pb2  # noqa: E402

RAW = os.path.join(CACHE, "tiles_raw")
OUT = os.path.join(SITE, "tiles")
FONT_OUT = os.path.join(SITE, "fonts")

# Layer -> attributes kept. Everything else (buildings, house numbers,
# translations) is dropped; POIs are cut down to the kinds in POI_KEEP below: the transit lines are the subject here.
KEEP = {
    "water": {"class", "brunnel"},
    "waterway": {"class", "brunnel"},
    "water_name": {"name", "class"},
    "park": {"class", "name"},
    "landuse": {"class"},
    "landcover": {"class", "subclass"},
    "transportation": {"class", "subclass", "brunnel", "ramp", "service"},
    "transportation_name": {"name", "class", "ref", "network", "brunnel"},
    "place": {"name", "class", "rank", "capital"},
    "poi": {"name", "class", "subclass", "rank"},
    "aeroway": {"class"},
    "boundary": {"admin_level", "maritime", "disputed"},
}
LANDUSE_KEEP = {"university", "college", "hospital", "cemetery", "stadium", "industrial",
                "railway", "school", "pitch", "zoo", "military"}
LANDCOVER_KEEP = {"wood", "grass", "wetland", "sand", "ice"}
# Places worth a symbol (the web page's POI_KIND): matched on the POI's subclass or class
POI_KEEP = {"zoo", "aquarium", "museum", "art_gallery", "stadium", "sports_centre", "college", "university", "school",
            "kindergarten", "library", "hospital", "park", "garden", "nature_reserve", "attraction", "viewpoint",
            "theatre", "castle", "monument", "town_hall", "courthouse", "ferry_terminal"}
TRANSPORT_DROP = {"path", "track", "busway", "bus_guideway", "pier"}


def lon2x(lon, z):
    return int((lon + 180) / 360 * 2 ** z)


def lat2y(lat, z):
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)


def tile_list():
    out = []
    for z in range(0, DETAIL_MAXZOOM + 1):
        b = CONTEXT if z <= CONTEXT_MAXZOOM else REGION
        for x in range(lon2x(b["west"], z), lon2x(b["east"], z) + 1):
            for y in range(lat2y(b["north"], z), lat2y(b["south"], z) + 1):
                out.append((z, x, y))
    return out


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "seattle-transit-map build (personal, non-commercial)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            with open(dest, "wb") as f:
                f.write(data)
            return
        except Exception as e:  # network hiccup: retry
            if attempt == 3:
                raise RuntimeError(f"{url}: {e}")


def strip_tile(raw: bytes, z: int) -> bytes:
    tile = vector_tile_pb2.tile()
    tile.ParseFromString(raw)
    out = vector_tile_pb2.tile()
    for layer in tile.layers:
        keep_attrs = KEEP.get(layer.name)
        if keep_attrs is None:
            continue
        nl = out.layers.add()
        nl.name, nl.version, nl.extent = layer.name, layer.version, layer.extent
        key_map, val_map = {}, {}
        for f in layer.features:
            props = {}
            for i in range(0, len(f.tags), 2):
                k = layer.keys[f.tags[i]]
                if k in keep_attrs:
                    props[k] = (f.tags[i + 1], layer.values[f.tags[i + 1]])
            cls = props.get("class", (None, None))[1]
            cls = cls.string_value if cls is not None else None
            if layer.name == "landuse" and cls not in LANDUSE_KEEP:
                continue
            if layer.name == "landcover" and cls not in LANDCOVER_KEEP:
                continue
            if layer.name in ("transportation", "transportation_name") and cls in TRANSPORT_DROP:
                continue
            if layer.name == "poi":
                sub = props.get("subclass", (None, None))[1]
                sub = sub.string_value if sub is not None else None
                if "name" not in props or (sub not in POI_KEEP and cls not in POI_KEEP):
                    continue
            if layer.name == "boundary":
                lvl = props.get("admin_level", (None, None))[1]
                if lvl is None or lvl.int_value not in (2, 4, 8) and lvl.uint_value not in (2, 4, 8):
                    continue
            nf = nl.features.add()
            if f.HasField("id"):
                nf.id = f.id
            nf.type = f.type
            nf.geometry.extend(f.geometry)
            for k, (vi, v) in props.items():
                if k not in key_map:
                    key_map[k] = len(nl.keys)
                    nl.keys.append(k)
                vkey = v.SerializeToString()
                if vkey not in val_map:
                    val_map[vkey] = len(nl.values)
                    nl.values.add().CopyFrom(v)
                nf.tags.extend([key_map[k], val_map[vkey]])
        if not nl.features:
            del out.layers[-1]
    return out.SerializeToString()


def pack(tiles, path):
    index, blob = {}, io.BytesIO()
    for (z, x, y), data in tiles:
        gz = gzip.compress(data, compresslevel=9, mtime=0)
        index[f"{z}/{x}/{y}"] = [blob.tell(), len(gz)]
        blob.write(gz)
    head = json.dumps(index, separators=(",", ":")).encode()
    raw = struct.pack("<I", len(head)) + head + blob.getvalue()
    with open(path, "w") as f:
        f.write(base64.b64encode(raw).decode())
    return os.path.getsize(path)


def main():
    req = urllib.request.Request(TILEJSON_URL, headers={"User-Agent": "seattle-transit-map build (personal, non-commercial)"})
    tj = json.load(urllib.request.urlopen(req, timeout=30))
    tmpl = tj["tiles"][0]
    version = tmpl.split("/planet/")[1].split("/")[0]
    tiles = tile_list()
    print(f"{len(tiles)} tiles from OpenFreeMap build {version}")
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda t: fetch(tmpl.format(z=t[0], x=t[1], y=t[2]),
                                    os.path.join(RAW, version, f"{t[0]}/{t[1]}/{t[2]}.pbf")), tiles))

    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        os.remove(os.path.join(OUT, old))
    # z0-12 in one archive; z13-14 in blocks of 16x16 zoom-14 tiles (~26 km square), so
    # the page only downloads the blocks you look at.
    SHIFT = 4
    groups = {"base": []}
    raw_total = kept_total = 0
    for z, x, y in tiles:
        raw = open(os.path.join(RAW, version, f"{z}/{x}/{y}.pbf"), "rb").read()
        data = strip_tile(raw, z)
        raw_total += len(raw)
        kept_total += len(data)
        if z <= 12:
            groups["base"].append(((z, x, y), data))
        else:
            bx, by = (x << (14 - z)) >> SHIFT, (y << (14 - z)) >> SHIFT
            groups.setdefault(f"d-{bx}-{by}", []).append(((z, x, y), data))
    manifest = {"version": version, "maxzoom": DETAIL_MAXZOOM, "archives": {},
                "detail_bounds": [REGION["west"], REGION["south"], REGION["east"], REGION["north"]],
                "blocks": {"fromZoom": 13, "shift": SHIFT}}
    for name, items in groups.items():
        size = pack(items, os.path.join(OUT, f"{name}.txt"))
        manifest["archives"][name] = {"tiles": len(items), "bytes": size}
        print(f"  {name}.txt  {len(items)} tiles  {size/1e6:.2f} MB")
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    print(f"raw {raw_total/1e6:.1f} MB -> stripped {kept_total/1e6:.1f} MB (before gzip)")

    # Label fonts (signed-distance-field glyphs used by MapLibre), packed into one file
    glyphs = {}
    for stack, slug in [("Noto Sans Regular", "regular"), ("Noto Sans Bold", "bold"), ("Noto Sans Italic", "italic")]:
        for rng in ["0-255", "256-511", "8192-8447"]:
            dest = os.path.join(CACHE, "fonts", slug, f"{rng}.pbf")
            fetch(FONTS_URL.format(fontstack=stack.replace(" ", "%20"), range=rng), dest)
            glyphs[f"{slug}/{rng}"] = base64.b64encode(open(dest, "rb").read()).decode()
    os.makedirs(FONT_OUT, exist_ok=True)
    for old in os.listdir(FONT_OUT):
        full = os.path.join(FONT_OUT, old)
        if os.path.isdir(full):
            import shutil
            shutil.rmtree(full)
    json.dump(glyphs, open(os.path.join(FONT_OUT, "glyphs.json"), "w"))
    print(f"fonts ok ({os.path.getsize(os.path.join(FONT_OUT, 'glyphs.json'))/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
