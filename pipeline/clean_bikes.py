"""Bike network geometry: snapped onto OpenStreetMap, one line per street, joined into routes.

Sources. Inside Seattle: SDOT's own bike network, exactly as its bike map has it
(sdot_bikes.json.gz, from tools/extract_sdot_bikes.py): every piece of its "Existing Bike
Facilities" layer in its own eight kinds (Neighborhood Greenways, Protected, Buffered and Painted
Bike Lanes, Climbing Lanes, Sharrows, Off-Street Bicycle Facilities and Unidentified) and its
Multi-use Trails, at full resolution. (trails_saved.json had a simplified copy: points 50-300 m
apart, buffered and climbing lanes folded into painted ones, no off-street or unidentified pieces
and a third of the multi-use trails missing.) Outside Seattle: the King, Pierce and Snohomish
County regional trails in trails_saved.json. SDOT cuts its network at every block: the blocks of one
street, one kind and one state are first merged into one line (`sdot_lines`). Then three problems
are fixed for every route at once:

  shape    points 50-300 m apart, so a curving trail is a row of straight pieces with sharp
           angles. Each line is resampled every few metres and matched onto OpenStreetMap's own
           street or path (pipeline/bike_osm.json.gz, from tools/extract_bike_osm.py) with a hidden
           Markov model, the way match_shapes.py matches bus routes, so it follows every curve.
           Where no OSM line is close, the line is rounded through its own points instead.
  doubles  the same trail is in two datasets (the Burke-Gilman is both a King County regional
           trail and an SDOT multi-use trail), so it was drawn twice, side by side. A line that runs
           on top of one already kept (within DUP_M, the same way) is dropped there.
  routes   SDOT cuts a route at every street-name change, so hovering a greenway lit one street and
           stopped at the corner. Pieces of the same kind that meet end to end are joined into
           routes: through every two-way meeting point, and through a junction along the
           straightest pair (or the same name).

Output: pipeline/bikes_clean.json (a FeatureCollection of pieces; properties keep the source's and
add `b`, the route id, and `bn`, the route's name; `stats.sdot_miles` holds the miles of each kind in
SDOT's own network, for the key's shares). build_bikes.py places it beside the transit lines.
"""
import gzip
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, shape
from shapely.ops import linemerge, nearest_points
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))
TRAILS = os.path.join(HERE, "trails_saved.json")
SDOT = os.path.join(HERE, "sdot_bikes.json.gz")
OSM = os.path.join(HERE, "bike_osm.json.gz")
OUT = os.path.join(HERE, "bikes_clean.json")
fwd = Transformer.from_crs(4326, 32610, always_xy=True)
inv = Transformer.from_crs(32610, 4326, always_xy=True)

STEP = 5.0          # resample every 5 m
SIGMA = 7.0         # how far the saved lines sit off OSM's
DUP_M = 9.0         # a line within 9 m of a kept one, the same way, is a double
DUP_NAMED = 22.0    # ...or within 22 m when it has the same name (two surveys of one trail)
DUP_SDOT = 30.0     # ...and a county line within 30 m of one of SDOT's own trails is that trail (two surveys
                    # under two names: "520 Trail" and "SR 520 Trail")
DUP_STREET = 15.0   # ...or within 15 m of one of SDOT's street facilities: the county's survey of that street's
                    # sidewalk or cycle track (the Interurban along Phinney, Greenwood and Dexter, the Elliott Bay
                    # Trail on Alaskan Way). A path further off is a path of its own: the Green Lake loop runs
                    # 20-30 m inside the protected lanes on the lake's streets, and was cut out where they came close
ON_STREET_M = 8.0   # ...but a county line that itself runs down a street (within 8 m of its middle) is that
                    # street's out to DUP_SDOT
GAP_M = 30.0        # an end left this short of a line it meets in the source is carried on to it
MEET_SDOT = 2.0     # SDOT's blocks meet at the street corner (within 2 m); the counties' coarse lines within 15 m
MEET_COUNTY = 15.0
CROSS_M = 40.0      # one street's bike route is carried across a crossing this wide
MIN_PIECE = 25.0    # leftovers shorter than this are dropped
NODE_M = 8.0        # ends within 8 m meet
TRAIL_GAP_M = 800.0 # two pieces of one named trail this close are one route (a gap where streets carry it)
ROAD = {"motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "busway"}
PATHS = {"path", "track", "cycleway"}
# SDOT's kinds (its CATEGORY codes; no code is "Unidentified"), with its own names
SDOT_KIND = {"BKF-NGW": "greenway", "BKF-PBL": "pbl", "BKF-BBL": "buffered", "BKF-BL": "lane",
             "BKF-CLMB": "climb", "BKF-SHW": "sharrow", "BKF-OFFST": "offst", None: "unknown"}
CAT_NAME = {"trail": "Multi-Use Trail", "pbl": "Protected Bike Lane", "offst": "Off-Street Bicycle Facility",
            "buffered": "Buffered Bike Lane", "lane": "Painted Bike Lane", "climb": "Climbing Lane",
            "greenway": "Neighborhood Greenway", "sharrow": "Sharrow", "unknown": "Unidentified"}
DESC = {
    "trail": "A paved path of its own, away from traffic, shared by people walking, rolling and biking.",
    "pbl": "A bike lane kept apart from moving traffic by something solid: posts, curbs, planters, "
           "concrete barriers or a row of parked cars.",
    "offst": "A bike path off the roadway that is not one of the named trails: a path at sidewalk level "
             "beside the street, on a bridge, or a short connector.",
    "buffered": "A painted bike lane with a striped buffer between it and traffic or parked cars. Paint only.",
    "lane": "A lane for bikes marked with a painted line and bike symbols beside traffic. Paint only.",
    "climb": "A painted bike lane on the uphill side only, where bikes climb slowly; downhill, bikes share "
             "the lane with traffic.",
    "greenway": "A calm residential street made for walking and biking: 20 mph, speed humps, stop signs "
                "that favor the route and help crossing busy streets.",
    "sharrow": "Shared-lane markings (a bike under two chevrons) painted in the traffic lane: bikes and cars "
               "share the lane.",
    "unknown": "A piece of SDOT's network with no facility type recorded.",
}
# drawing order of kinds, best first: where two kinds share a street the better one is kept
RANK = {"trail": 0, "pbl": 1, "offst": 2, "buffered": 3, "lane": 4, "climb": 5, "greenway": 6, "sharrow": 7,
        "unknown": 8}
KINDS = set(RANK)
# kinds on a path of their own (a cycleway or path is their best match, a street only fair)
OFF_ROAD = {"trail", "pbl", "offst", "unpaved"}
# SDOT's street kinds: a route is all of one kind that connects (a greenway network, the protected
# lanes downtown, the sharrows round Discovery Park), through every corner and T-junction, so hovering
# or tapping any street of it lights all of it. Trails keep their own names (the regional trails all
# connect into one network of hundreds of kilometres).
NETWORK_KINDS = KINDS - {"trail"}
# Inside Seattle SDOT's own data comes first: the counties' regional trails include on-street links
# (the Interurban Trail along Fremont, Linden and Phinney Ave N, the Magnolia Connector along Gilman
# Ave W, the Elliott Bay Trail along Alaskan Way), which outranked the greenway, lanes or sharrows
# SDOT's map shows on those streets and drew them as multi-use trails. A county line is kept only
# where SDOT has nothing (and beyond the city).
SRC_RANK = {"Seattle": 0, "King County": 1, "Pierce County": 1, "Snohomish County": 1}


def kind(p):
    """The drawn kind (one per map layer): SDOT's eight, multi-use trails, and unpaved trails."""
    if p.get("surface") == "unpaved":
        return "unpaved"
    f = p.get("facility")
    return f if f in KINDS else "trail"


def norm_name(n):
    n = (n or "").lower()
    n = re.sub(r"\(.*?\)", "", n).replace("-", " ").replace("trail", "").replace("connector", "")
    return re.sub(r"\s+", " ", n).strip()


TIDY = {"Ne": "NE", "Nw": "NW", "Se": "SE", "Sw": "SW", "Bv": "Blvd", "Py": "Pkwy", "Av": "Ave", "Wy": "Way",
        "Br": "Bridge", "Rp": "Ramp", "Vi": "Viaduct", "Et": "Extension", "Pt": "Point", "Uw": "UW", "To": "to",
        "On": "on",
        # which roadway of a divided street, or which way a one-way one runs: not part of its name
        "Er": "", "Wr": "", "Nr": "", "Sr": "", "Eb": "", "Wb": "", "Nb": "", "Sb": ""}


def tidy(n):
    """Seattle's names come title-cased word by word, in its street database's short forms ("Ne
    45Th St", "Beacon Er Ave S"): directions in capitals, ordinals in lower case, the short forms
    spelled out and the roadway left out ("NE 45th St", "Beacon Ave S")."""
    if not n:
        return n
    n = re.sub(r"\b(\d+)(St|Nd|Rd|Th)\b", lambda m: m.group(1) + m.group(2).lower(), n)
    n = re.sub(r"\b[A-Z][a-z]\b", lambda m: TIDY.get(m.group(0), m.group(0)), n)
    n = re.sub(r"^(\w)", lambda m: m.group(1).upper(), n)  # ("to" and "on" only inside a name)
    return re.sub(r"\s+", " ", n).strip()


# SDOT's street database spells names in capitals with its own short forms
SDOT_WORDS = {"TRL": "Trail", "CONNCTR": "Connector", "CONNCT": "Connector", "CONN": "Connector",
              "MTS": "Mountains to Sound", "BR": "Bridge", "BV": "Blvd", "PY": "Pkwy", "RP": "Ramp",
              "AV": "Ave", "WY": "Way", "UW": "UW", "SR520": "SR 520", "I5": "I-5", "I90": "I-90",
              "MLK": "MLK", "PED": "Pedestrian", "SODO": "SODO"}
TRAIL_END = ("Trail", "Bridge", "Overpass", "Connector", "Path")


def sdot_name(s):
    """'NE RAVENNA SR BV' -> 'NE Ravenna Blvd'; 'MTS DEARBORN CONNCTR TRL' -> 'Mountains to Sound
    Dearborn Connector Trail'."""
    if not s:
        return ""
    words = []
    for w in s.split():
        words.append(SDOT_WORDS[w] if w in SDOT_WORDS else w.title())
    return tidy(" ".join(words)).replace("Burke Gilman", "Burke-Gilman")


def sdot_lines():
    """SDOT's network as lines: the blocks of one street, one kind and one state (built, or under
    construction) merged end to end. Returns (features, {sdot_miles: miles of each kind in SDOT's
    own data, fetched: the download's date})."""
    if not os.path.exists(SDOT):
        return [], {}
    d = json.load(gzip.open(SDOT, "rt"))
    groups, miles = defaultdict(list), Counter()
    for key, lay in d["layers"].items():
        for f in lay["features"]:
            p, g = f["properties"], f["geometry"]
            parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
            if key == "existing":
                k = SDOT_KIND.get(p.get("CATEGORY"), "unknown")
                street = sdot_name((p.get("UNITDESC") or "").split(" BETWEEN ")[0])
                state = "UNDERCONS" if p.get("CURRENT_STATUS") == "UNDERCONS" else "INSVC"
            else:
                k, street, state = "trail", sdot_name(p.get("ORD_STNAME_CONCAT") or ""), "INSVC"
            for c in parts:
                if len(c) >= 2:
                    groups[(k, street, state)].append(c)
                    miles[k] += LineString(to_m(c)).length / 1609.344
    # SDOT's blocks meet end to end, but not always to the last decimal (-122.352782 / -122.352784),
    # and a few blocks are in twice (one survey line under two block names): ends within a metre are
    # one point, and a block drawn twice is drawn once
    nodes = {}

    def node(c):
        gx, gy = round(c[0] * 1e5), round(c[1] * 1e5)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in nodes.get((gx + dx, gy + dy), ()):
                    if abs(q[0] - c[0]) * 75000 < 1 and abs(q[1] - c[1]) * 111000 < 1:
                        return q
        nodes.setdefault((gx, gy), []).append(tuple(c))
        return tuple(c)
    out = []
    for (k, street, state), parts in groups.items():
        seen, uniq = set(), []
        for c in parts:
            c = [node(c[0])] + [tuple(x) for x in c[1:-1]] + [node(c[-1])]
            key = min(tuple(c), tuple(c[::-1]))
            if key not in seen:
                seen.add(key)
                uniq.append(c)
        # ...and a block lying on top of a longer one of the same street (Broad St "between 4th Ave N
        # and John St", 22 m over the end of the next block) is that block: merged, it made the line
        # fold back on itself at the corner, so the line ended 22 m short of 4th Ave N
        uniq.sort(key=lambda c: -LineString(to_m(c)).length)
        keep = []
        for c in uniq:
            m = to_m(c)
            pts = shapely.points(resample(m, 2.0))
            if keep and all(shapely.distance(shapely.MultiLineString([to_m(k) for k in keep]), pts) < 3.0):
                continue
            keep.append(c)
        merged = linemerge(MultiLineString(keep))
        for line in getattr(merged, "geoms", [merged]):
            mi = LineString(to_m(line.coords)).length / 1609.344
            # (a trail named for the street it runs beside says it is a trail)
            name = (f"{street} ({CAT_NAME[k]})" if street and not (k == "trail" and street.endswith(TRAIL_END))
                    else street or CAT_NAME[k])
            p = {"name": name, "street": street, "facility": k, "cat_name": CAT_NAME[k], "surface": "paved",
                 "region": "Seattle", "length_mi": round(mi, 2), "desc": DESC[k]}
            if state != "INSVC":
                p["status"] = state
            out.append({"type": "Feature", "properties": p,
                        "geometry": {"type": "LineString", "coordinates": [list(x) for x in line.coords]}})
    return out, {"sdot_miles": {k: round(v, 2) for k, v in miles.items()}, "fetched": d.get("fetched", "")}


def to_m(coords):
    a = np.asarray(coords, float)
    x, y = fwd.transform(a[:, 0], a[:, 1])
    return np.column_stack([x, y])


def to_ll(pts):
    lon, lat = inv.transform(pts[:, 0], pts[:, 1])
    return [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)]


def resample(pts, step=STEP):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    if d[-1] < 1e-6:
        return pts[:1]
    n = max(2, int(math.ceil(d[-1] / step)) + 1)
    s = np.linspace(0, d[-1], n)
    return np.column_stack([np.interp(s, d, pts[:, 0]), np.interp(s, d, pts[:, 1])])


def headings(pts):
    g = np.gradient(pts, axis=0)
    return np.arctan2(g[:, 1], g[:, 0])


def angdiff(a, b):
    """Angle between two undirected headings, 0..pi/2."""
    d = np.abs((a - b + np.pi) % (2 * np.pi) - np.pi)
    return np.minimum(d, np.pi - d)


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    return np.asarray(LineString(pts).simplify(tol, preserve_topology=False).coords)


def catmull(pts, per=STEP):
    """Centripetal Catmull-Rom through the points: corners of a saved line become curves.
    Corners sharper than 70 degrees are real turns (a trail leaving a street) and stay."""
    if len(pts) < 3:
        return pts
    out = [pts[0]]
    P = np.vstack([2 * pts[0] - pts[1], pts, 2 * pts[-1] - pts[-2]])
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        a1 = math.atan2(*(p1 - p0)[::-1]) if i > 1 else None
        seg = np.linalg.norm(p2 - p1)
        n = max(1, int(seg / per))

        def sharp(a, b, c):
            u, v = b - a, c - b
            nu, nv = np.linalg.norm(u), np.linalg.norm(v)
            return nu < 1e-6 or nv < 1e-6 or np.dot(u, v) / (nu * nv) < math.cos(math.radians(70))
        if sharp(p0, p1, p2) or sharp(p1, p2, p3):
            out.extend(p1 + (p2 - p1) * (k / n) for k in range(1, n + 1))
            continue
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5 + 1e-9
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5 + 1e-9
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5 + 1e-9
        for k in range(1, n + 1):
            t = t1 + (t2 - t1) * k / n
            A1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            A2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            A3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2
            B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3
            out.append((t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2)
        del a1
    return np.asarray(out)


def fillet(pts, per=3.0):
    """Round every corner with a circular arc, so the line has no angles at any zoom. A gentle bend
    is a curve the source drew as straight chords: it gets a wide radius (up to ~half of each
    neighbouring chord, so the arcs meet and the curve is smooth all the way round). A sharp one is
    a real turn at a corner: it gets a street corner's radius."""
    if len(pts) < 3:
        return pts
    out = [pts[0]]
    for v in range(1, len(pts) - 1):
        A, P, B = pts[v - 1], pts[v], pts[v + 1]
        la, lb = np.hypot(*(P - A)), np.hypot(*(B - P))
        if la < 1e-6 or lb < 1e-6:
            continue
        dIn, dOut = (P - A) / la, (B - P) / lb
        turn = math.acos(max(-1.0, min(1.0, float(dIn @ dOut))))
        if turn < 0.002:
            out.append(P)
            continue
        deg = math.degrees(turn)
        # 300 m for a bend under 15 degrees, down to 12 m for a turn of 60 or more
        rmax = 300.0 if deg <= 15 else 12.0 if deg >= 60 else 300.0 * (12.0 / 300.0) ** ((deg - 15) / 45)
        half = math.tan(turn / 2)
        t = min(rmax * half, 0.49 * min(la, lb))
        R = t / half
        p0 = P - dIn * t
        nrm = np.array([-dIn[1], dIn[0]]) * (1 if dIn[0] * dOut[1] - dIn[1] * dOut[0] > 0 else -1)
        ctr = p0 + nrm * R
        a0 = math.atan2(*(p0 - ctr)[::-1])
        sgn = 1 if dIn[0] * dOut[1] - dIn[1] * dOut[0] > 0 else -1
        m = max(1, int(math.ceil(R * turn / per)))
        for q in range(m + 1):
            a = a0 + sgn * turn * q / m
            out.append(ctr + R * np.array([math.cos(a), math.sin(a)]))
    out.append(pts[-1])
    return np.asarray(out)


# ---------------------------------------------------------------- snapping onto OSM
class Ways:
    def __init__(self, path):
        data = json.load(gzip.open(path, "rt")) if os.path.exists(path) else {"ways": []}
        self.geoms, self.cls, self.sub = [], [], []
        for cls, sub, _br, coords in data["ways"]:
            if len(coords) < 2:
                continue
            self.geoms.append(LineString(to_m(coords)))
            self.cls.append(cls)
            self.sub.append(sub)
        self.tree = STRtree(self.geoms) if self.geoms else None
        self.geoms = np.asarray(self.geoms, dtype=object)
        self.ends = [(np.asarray(g.coords[0]), np.asarray(g.coords[-1])) for g in self.geoms]
        print(f"{len(self.geoms)} OSM pieces ({Counter(self.cls).most_common(6)})")

    def penalty(self, j, k):
        """Extra cost for matching a bike line of kind k onto OSM piece j."""
        cls, sub = self.cls[j], self.sub[j]
        on_path = cls in PATHS
        if k in OFF_ROAD:
            # a trail, protected lane or off-street path: a cycleway is best, a path good, a street fair
            if k in ("trail", "unpaved") and not on_path:
                return None  # a trail follows its own path, never the street beside it
            return 0.0 if sub == "cycleway" or cls == "cycleway" else 0.6 if on_path else 2.0
        # on-street kinds (greenway, lanes, sharrow): a street, not the path beside it
        return 0.0 if cls in ROAD else 3.0


def snap(pts, k, ways):
    """Match a resampled line onto OSM pieces (Viterbi). Returns the matched points and, per point,
    whether it is on OSM."""
    n = len(pts)
    if ways.tree is None or n < 2:
        return pts, np.zeros(n, bool)
    hd = headings(pts)
    R = 30.0 if k in OFF_ROAD else 24.0
    pi, wi = ways.tree.query(shapely.points(pts), predicate="dwithin", distance=R)
    cands = defaultdict(list)
    if len(pi):
        G = ways.geoms[wi]
        P = shapely.points(pts[pi])
        loc = shapely.line_locate_point(G, P)
        q = shapely.get_coordinates(shapely.line_interpolate_point(G, loc))
        L = shapely.length(G)
        qa = shapely.get_coordinates(shapely.line_interpolate_point(G, np.maximum(0, loc - 1.5)))
        qb = shapely.get_coordinates(shapely.line_interpolate_point(G, np.minimum(L, loc + 1.5)))
        wh = np.arctan2(qb[:, 1] - qa[:, 1], qb[:, 0] - qa[:, 0])
        d = np.hypot(q[:, 0] - pts[pi, 0], q[:, 1] - pts[pi, 1])
        ang = angdiff(wh, hd[pi])
        for t in range(len(pi)):
            if ang[t] > math.radians(35):
                continue
            pen = ways.penalty(wi[t], k)
            if pen is None:
                continue
            e = (d[t] / SIGMA) ** 2 + (ang[t] / math.radians(12)) ** 2 + pen
            cands[pi[t]].append((e, wi[t], q[t], loc[t]))
    NULL = 7.0  # cost of leaving a point where it is (no OSM line fits)
    states = []
    for i in range(n):
        c = sorted(cands.get(i, []), key=lambda s: s[0])[:6]
        states.append([(NULL, -1, pts[i], 0.0)] + c)
    cost = [np.array([s[0] for s in states[0]])]
    back = []
    for i in range(1, n):
        prev, cur = states[i - 1], states[i]
        step = np.hypot(*(pts[i] - pts[i - 1]))
        M = np.zeros((len(prev), len(cur)))
        for a, (_, wa, qa_, la) in enumerate(prev):
            for b, (_, wb, qb_, lb) in enumerate(cur):
                if wa < 0 and wb < 0:
                    t = 0.0
                elif wa < 0 or wb < 0:
                    t = 3.0
                elif wa == wb:
                    t = ((abs(lb - la) - step) / 3.0) ** 2
                    if lb < la - 2 and abs(lb - la) > step * 0.5:  # (direction is free: two-way)
                        t += 0.0
                else:
                    jump = np.hypot(*(qb_ - qa_))
                    ea, eb = ways.ends[wa], ways.ends[wb]
                    touch = min(np.hypot(*(x - y)) for x in ea for y in eb) < 2.0
                    t = ((jump - step) / 3.0) ** 2 + (0.3 if touch else 2.5)
                M[a, b] = t
        tot = cost[-1][:, None] + M
        arg = tot.argmin(axis=0)
        back.append(arg)
        cost.append(tot[arg, np.arange(len(cur))] + np.array([s[0] for s in cur]))
    j = int(cost[-1].argmin())
    path = [j]
    for i in range(n - 2, -1, -1):
        j = int(back[i][j])
        path.append(j)
    path.reverse()
    out = np.array([states[i][path[i]][2] for i in range(n)], float)
    on = np.array([states[i][path[i]][1] >= 0 for i in range(n)])
    return out, on


def finish(out, on, raw):
    """Round the stretches left off OSM through the source's own points, and ease the joins."""
    res, i, n = [], 0, len(out)
    while i < n:
        j = i
        while j < n and on[j] == on[i]:
            j += 1
        if on[i]:
            res.append(out[i:j])
        else:
            a, b = out[max(0, i - 1)], out[min(n - 1, j)]
            # the source's own corners between these two points
            line = LineString(raw)
            la, lb = line.project(shapely.Point(a)), line.project(shapely.Point(b))
            inner = [np.asarray(c) for c in raw if la < line.project(shapely.Point(c)) < lb]
            seq = np.array([a] + inner + [b]) if inner else np.array([a, b])
            sm = catmull(seq)
            res.append(sm[1:-1] if len(sm) > 2 else np.empty((0, 2)))
            if not inner:
                res[-1] = out[i:j]
        i = j
    pts = np.vstack([r for r in res if len(r)])
    keep = np.r_[True, np.hypot(*np.diff(pts, axis=0).T) > 0.3]
    # the corners left (OSM's own chords round a curve, a turn at a street corner) become arcs
    return simplify(fillet(simplify(pts[keep], 0.6)), 0.15)


# ---------------------------------------------------------------- doubles
class Kept:
    def __init__(self):
        self.lines, self.names, self.sdot, self.kinds, self.tree = [], [], [], [], None

    def add(self, pts, name="", sdot=False, k=""):
        self.lines.append(LineString(pts))
        self.names.append(name)
        self.sdot.append(sdot)
        self.kinds.append(k)
        self.tree = None

    def covered(self, pts, name="", county=False, street=None):
        """Per point: is it a double of a kept line? `street` marks the points of a county line whose
        own survey runs down a street."""
        if not self.lines:
            return np.zeros(len(pts), bool)
        if self.tree is None:
            self.tree = STRtree(self.lines)
            self.arr = np.asarray(self.lines, dtype=object)
        hd = headings(pts)
        pi, li = self.tree.query(shapely.points(pts), predicate="dwithin", distance=max(DUP_NAMED, DUP_SDOT))
        cov = np.zeros(len(pts), bool)
        if len(pi):
            near = shapely.distance(self.arr[li], shapely.points(pts[pi]))
            sd = np.array([county and self.sdot[j] for j in li], bool)
            tr = np.array([self.kinds[j] == "trail" for j in li], bool)
            st = street[pi] if street is not None else np.zeros(len(pi), bool)
            nm = np.array([bool(name) and self.names[j] == name for j in li], bool)
            lim = np.where(sd, np.where(tr | st, DUP_SDOT, DUP_STREET), np.where(nm, DUP_NAMED, DUP_M))
            pi, li = pi[near <= lim], li[near <= lim]
        if len(pi):
            G = self.arr[li]
            loc = shapely.line_locate_point(G, shapely.points(pts[pi]))
            L = shapely.length(G)
            # only beside the line, not past its end: a point within reach of a kept line's end
            # but beyond it is that line's continuation (a trail cut in two), not a double of it
            inside = (loc > 0.5) & (loc < L - 0.5)
            pi, li, loc, L, G = pi[inside], li[inside], loc[inside], L[inside], G[inside]
            qa = shapely.get_coordinates(shapely.line_interpolate_point(G, np.maximum(0, loc - 2)))
            qb = shapely.get_coordinates(shapely.line_interpolate_point(G, np.minimum(L, loc + 2)))
            ok = angdiff(np.arctan2(qb[:, 1] - qa[:, 1], qb[:, 0] - qa[:, 0]), hd[pi]) < math.radians(25)
            cov[pi[ok]] = True
        return cov


def runs(mask):
    out, i = [], 0
    while i < len(mask):
        j = i
        while j < len(mask) and mask[j] == mask[i]:
            j += 1
        out.append((bool(mask[i]), i, j))
        i = j
    return out


# ---------------------------------------------------------------- routes
def on_street(s, raw, ways):
    """Per point of a county line (as matched): does the county's own survey run down a street here?"""
    rl = LineString(raw)
    r = shapely.line_interpolate_point(rl, shapely.line_locate_point(rl, shapely.points(s)))
    out = np.zeros(len(s), bool)
    if ways.tree is None:
        return out
    pi, wi = ways.tree.query(r, predicate="dwithin", distance=ON_STREET_M)
    road = np.array([ways.cls[w] in ROAD for w in wi], bool)
    out[pi[road]] = True
    return out


def close_gaps(pieces):
    """Where two lines meet in the source, they meet on the map. SDOT's blocks meet at the street
    corner, but a line's last metres can match onto the cross street's OSM way, or be cut off as a
    double of it or as a leftover too short to keep, leaving its end short of the line it meets:
    43rd Ave W stopped 11 m short of Discovery Park Blvd, 4th Ave N and Broad St both stopped 25 m
    short of their corner. Such an end is carried on to the corner: onto the other line where it
    passes the corner, or to the corner itself, where the other line is carried too. And one street's
    two pieces of bike route facing each other across a crossing (S Willow St and S Alaska St across
    the two roadways and the tracks of Martin Luther King Jr Way, where SDOT's own lines stop at each
    kerb) are carried across it, up to CROSS_M."""
    lines = [LineString(p["pts"]) for p in pieces]
    raws = [LineString(p["raw"]) for p in pieces]
    streets = [norm_name(p["p"].get("street") or p["p"].get("name")) for p in pieces]
    tree = STRtree(lines)
    n = 0

    def heading_ok(c, end, t, d):
        a, b = c[end], c[1 if end == 0 else -2]
        out, to = a - b, t - a
        ang = math.acos(max(-1.0, min(1.0, float(out @ to) / (np.hypot(*out) * np.hypot(*to) + 1e-9))))
        return d <= 10 or ang <= math.radians(60)  # (a corner within 10 m is reached whichever way the end turns)

    for i, p in [(i, p) for _ in range(2) for i, p in enumerate(pieces)]:  # twice: a corner reached by one line
        for end in (0, -1):                                                # is then there for the next
            c = p["pts"]
            E = shapely.Point(c[end])
            # (a line this end already touches needs nothing; another it meets at the same corner may)
            near = [int(j) for j in tree.query(E, predicate="dwithin", distance=max(GAP_M, CROSS_M))
                    if j != i and lines[j].distance(E) >= 0.5]
            if not near:
                continue
            # the source's own line here: its last GAP_M metres where it ends near (a block can run a
            # few metres past the corner and back), else the point beside this end (a double cut it)
            if min(E.distance(shapely.Point(raws[i].coords[k])) for k in (0, -1)) < GAP_M:
                src = raws[i].intersection(E.buffer(GAP_M))
            else:
                src = raws[i].interpolate(raws[i].project(E))
            best = None
            for j in near:
                lim = MEET_SDOT if p["sdot"] and pieces[j]["sdot"] else MEET_COUNTY
                md = src.distance(raws[j]) if not src.is_empty else 1e9
                if md <= lim:
                    # the corner, on the source: carried onto line j where it passes the corner (within
                    # 6 m), else to the corner itself
                    Q = nearest_points(src, raws[j])[1]
                    t = np.asarray(lines[j].interpolate(lines[j].project(Q)).coords[0])
                    if lines[j].distance(Q) > 6:
                        t = np.asarray(Q.coords[0])
                elif streets[i] and streets[i] == streets[j]:
                    # the same street across a crossing: end to end, facing each other
                    cj = pieces[j]["pts"]
                    ej = min((0, -1), key=lambda k: E.distance(shapely.Point(cj[k])))
                    t = cj[ej]
                    if E.distance(shapely.Point(t)) > CROSS_M or not heading_ok(cj, ej, c[end], 99):
                        continue
                else:
                    continue
                d = float(np.hypot(*(t - c[end])))
                if d <= GAP_M + (CROSS_M if md > lim else 0) and heading_ok(c, end, t, d) and (best is None or d < best[0]):
                    best = (d, t)
            if best is None or best[0] < 0.3:
                continue
            t = best[1]
            p["pts"] = np.vstack([t[None], c]) if end == 0 else np.vstack([c, t[None]])
            lines[i] = LineString(p["pts"])
            n += 1
    return n


def join_routes(pieces):
    """Union pieces that meet end to end into routes. At a meeting point of two pieces they join
    when they are the same kind or the same street or trail (a trail that runs on the street for
    a few blocks is still that trail); where three or more meet, the same name first, then the
    two of one kind when no other of that kind meets there (a greenway turning a corner where a
    trail ends), then the straightest pair of one kind (under 50 degrees) joins, and the rest end
    there; all the ends of one street or trail there are one route. SDOT's street kinds are then
    joined into networks: every piece of one kind that touches another of that kind, end to end or
    at a T-junction (NETWORK_KINDS). Last, the pieces of one named trail with a short gap between
    them (the Burke-Gilman's missing link in Ballard, where SDOT's map has the streets' own lanes)
    are one route too."""
    ends = []  # (piece, which end, point, heading pointing away from the piece)
    for i, p in enumerate(pieces):
        c = p["pts"]
        h0 = math.atan2(*(c[0] - c[min(3, len(c) - 1)])[::-1])
        h1 = math.atan2(*(c[-1] - c[max(-4, -len(c))])[::-1])
        ends.append((i, 0, c[0], h0))
        ends.append((i, 1, c[-1], h1))
    parent = list(range(len(pieces)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def join(A, B):
        # one route, and one point where the two pieces meet, so the line has no gap or step there;
        # two of SDOT's street kinds meet but stay two routes (each is its own kind's network: a
        # street whose painted lane becomes sharrows lights the lanes, then the sharrows; chained,
        # the networks of every kind made one route of 76 km)
        if not (pieces[A[0]]["k"] != pieces[B[0]]["k"] and pieces[A[0]]["k"] in NETWORK_KINDS
                and pieces[B[0]]["k"] in NETWORK_KINDS):
            parent[find(A[0])] = find(B[0])
        m = (np.asarray(A[2]) + np.asarray(B[2])) / 2
        for e in (A, B):
            pieces[e[0]]["pts"][0 if e[1] == 0 else -1] = m
    names = [norm_name(p["p"].get("name")) for p in pieces]
    for es in [ends]:
        pts = np.array([e[2] for e in es])
        tree = STRtree(shapely.points(pts))
        a, b = tree.query(shapely.points(pts), predicate="dwithin", distance=NODE_M)
        # meeting points: groups of ends close together
        g = list(range(len(es)))

        def gf(x):
            while g[x] != x:
                g[x] = g[g[x]]
                x = g[x]
            return x
        for x, y in zip(a.tolist(), b.tolist()):
            if es[x][0] != es[y][0]:
                g[gf(x)] = gf(y)
        nodes = defaultdict(list)
        for x in range(len(es)):
            nodes[gf(x)].append(es[x])
        for node in nodes.values():
            if len(node) < 2:
                continue
            if len(node) == 2:
                A, B = node
                if pieces[A[0]]["k"] == pieces[B[0]]["k"] or (names[A[0]] and names[A[0]] == names[B[0]]):
                    join(A, B)
                continue
            pairs = []
            nk = Counter(pieces[e[0]]["k"] for e in node)
            for x in range(len(node)):
                for y in range(x + 1, len(node)):
                    A, B = node[x], node[y]
                    if A[0] == B[0]:
                        continue
                    # continuing straight: the two away-headings point opposite ways
                    dev = abs(abs((A[3] - B[3] + math.pi) % (2 * math.pi) - math.pi) - math.pi)
                    same = bool(names[A[0]]) and names[A[0]] == names[B[0]]
                    kA = pieces[A[0]]["k"]
                    only = kA == pieces[B[0]]["k"] and nk[kA] == 2
                    if same or only or (kA == pieces[B[0]]["k"] and dev < math.radians(50)):
                        pairs.append((0 if same else 1 if only else 2, dev, x, y))
            used = set()
            for _, _, x, y in sorted(pairs):
                if x in used or y in used:
                    continue
                used |= {x, y}
                join(node[x], node[y])
            # one street or trail through its own junction (a loop and its stem) is one route
            for x in range(len(node)):
                for y in range(x + 1, len(node)):
                    A, B = node[x], node[y]
                    if names[A[0]] and names[A[0]] == names[B[0]] and pieces[A[0]]["k"] == pieces[B[0]]["k"]:
                        parent[find(A[0])] = find(B[0])
    # SDOT's street kinds: everything of one kind that touches, at its ends or at a T-junction
    lines = [LineString(p["pts"]) for p in pieces]
    lt = STRtree(lines)
    for i, p in enumerate(pieces):
        if p["k"] not in NETWORK_KINDS:
            continue
        for e in (p["pts"][0], p["pts"][-1]):
            for j in lt.query(shapely.Point(e), predicate="dwithin", distance=NODE_M):
                if j != i and pieces[j]["k"] == p["k"]:
                    parent[find(i)] = find(int(j))
    # one named trail across a short gap
    tr = [e for e in ends if pieces[e[0]]["k"] in OFF_ROAD and names[e[0]]]
    if tr:
        pts = np.array([e[2] for e in tr])
        a, b = STRtree(shapely.points(pts)).query(shapely.points(pts), predicate="dwithin", distance=TRAIL_GAP_M)
        for x, y in zip(a.tolist(), b.tolist()):
            A, B = tr[x], tr[y]
            if names[A[0]] == names[B[0]] and find(A[0]) != find(B[0]):
                parent[find(A[0])] = find(B[0])
    groups = defaultdict(list)
    for i in range(len(pieces)):
        groups[find(i)].append(i)
    return list(groups.values())


def main():
    ways = Ways(OSM)
    sdot, stats = sdot_lines()
    feats = json.load(open(TRAILS))["features"]
    if sdot:
        # Seattle from SDOT's own data; the regional trails beyond it from the counties'
        feats = [f for f in feats if f["properties"].get("region") != "Seattle"] + sdot
        print(f"SDOT: {len(sdot)} lines ({', '.join(f'{k} {v:.1f} mi' for k, v in sorted(stats['sdot_miles'].items(), key=lambda x: -x[1]))})")
    parts = []
    for f in feats:
        p = dict(f["properties"])
        for key in ("name", "street"):
            if p.get(key):
                p[key] = tidy(p[key])
        g = shape(f["geometry"])
        for part in getattr(g, "geoms", [g]):
            raw = to_m(part.coords)
            if len(raw) >= 2 and LineString(raw).length >= 5:
                parts.append({"p": p, "k": kind(p), "raw": raw})
    print(f"{len(feats)} saved bike lines, {len(parts)} pieces")
    snapped_m = total_m = 0.0
    for q in parts:
        s = resample(q["raw"])
        out, on = snap(s, q["k"], ways)
        q["pts"] = finish(out, on, q["raw"])
        total_m += len(s) * STEP
        snapped_m += on.sum() * STEP
    print(f"snapped onto OpenStreetMap: {snapped_m / max(total_m, 1):.0%} of {total_m / 1000:.0f} km")
    # doubles: SDOT first, then the best kind, then longer lines
    parts.sort(key=lambda q: (SRC_RANK.get(q["p"].get("region"), 2), RANK.get(q["k"], 5), -LineString(q["pts"]).length))
    kept, pieces, dropped = Kept(), [], 0.0
    for q in parts:
        s = resample(q["pts"], 2.5)
        nm = norm_name(q["p"].get("name")) if q["k"] in OFF_ROAD else ""
        sdot = q["p"].get("region") == "Seattle"
        cov = kept.covered(s, nm, county=not sdot, street=None if sdot else on_street(s, q["raw"], ways))
        # a covered stretch shorter than 20 m is a crossing, not a double
        for c, i, j in runs(cov):
            if c and (j - i) * 2.5 < 20:
                cov[i:j] = False
        # ...and a short stretch between two doubled ones is where the second survey strays from
        # the first for a moment (cutting a curve, the other side of a junction), not a new line
        rr = runs(cov)
        for t, (c, i, j) in enumerate(rr):
            if not c and 0 < t < len(rr) - 1 and (j - i) * 2.5 < 80:
                cov[i:j] = True
        for c, i, j in runs(cov):
            seg = s[max(0, i - 1):j + 1] if not c else None
            if c:
                dropped += (j - i) * 2.5
                continue
            if len(seg) < 2 or (j - i) * 2.5 < MIN_PIECE:
                continue
            pts = simplify(seg, 0.15)
            pieces.append({"p": q["p"], "k": q["k"], "pts": pts, "raw": q["raw"], "sdot": sdot})
        for c, i, j in runs(cov):
            if not c and (j - i) * 2.5 >= MIN_PIECE:
                kept.add(s[i:j], nm, sdot, q["k"])
    print(f"doubles removed: {dropped / 1000:.1f} km; {len(pieces)} pieces kept")
    print(f"ends carried on to the line they meet: {close_gaps(pieces)}")
    groups = join_routes(pieces)
    out = []
    for b, grp in enumerate(sorted(groups, key=lambda g: -sum(LineString(pieces[i]["pts"]).length for i in g))):
        names, kinds = Counter(), Counter()
        for i in grp:
            names[pieces[i]["p"].get("name") or ""] += LineString(pieces[i]["pts"]).length
            kinds[pieces[i]["k"]] += LineString(pieces[i]["pts"]).length
        bn, bk = names.most_common(1)[0][0], kinds.most_common(1)[0][0]
        km = sum(names.values()) / 1000
        for i in grp:
            pr = dict(pieces[i]["p"])
            # k: this piece's kind (how it is drawn); bk: the route's own (most of its length)
            pr.update({"b": b, "bn": bn, "bkm": round(km, 2), "k": pieces[i]["k"], "bk": bk})
            out.append({"type": "Feature", "properties": pr, "geometry": {"type": "LineString", "coordinates": to_ll(pieces[i]["pts"])}})
    json.dump({"type": "FeatureCollection", "stats": stats, "features": out}, open(OUT, "w"), separators=(",", ":"))
    print(f"{len(groups)} bike routes from {len(out)} pieces -> {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
