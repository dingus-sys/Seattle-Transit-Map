"""Turn the agencies' GTFS feeds into the map's route and stop data.

Outputs
  site/data/routes.json   route catalog: names, category, colors, frequency, span,
                          schedule-at-a-glance table, stop sequences
  site/data/stops.json    stops and stations with the routes serving them
  CACHE/route_shapes.json representative geometry per route (input to build_graph.py)
"""
import datetime as dt
import io
import json
import math
import os
import re
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict

import numpy as np
import pandas as pd
from shapely.geometry import LineString, box

sys.path.insert(0, os.path.dirname(__file__))
from config import CACHE, FEEDS, REGION, SITE  # noqa: E402

FEED_DIR = os.path.join(CACHE, "gtfs", "feeds")
EXT = os.path.join(CACHE, "ext")
DATA = os.path.join(SITE, "data")

AGENCY = {
    "1": ("King County Metro", "Metro"),
    "40": ("Sound Transit", "Sound Transit"),
    "23": ("Seattle Streetcar", "Streetcar"),
    "96": ("Seattle Center Monorail", "Monorail"),
    "95": ("Washington State Ferries", "WSF"),
    "29": ("Community Transit", "CT"),
    "97": ("Everett Transit", "Everett"),
    "3": ("Pierce Transit", "PT"),
    "19": ("Intercity Transit", "IT"),
    "20": ("Kitsap Transit", "KT"),
    "51": ("Amtrak", "Amtrak"),
    "6289": ("Solid Ground", "Solid Ground"),
}

# Map categories, in drawing priority order (first = most important).
CATEGORIES = [
    ("link", "Link light rail"),
    ("sounder", "Sounder commuter rail"),
    ("amtrak", "Amtrak Cascades"),
    ("streetcar", "Seattle Streetcar"),
    ("monorail", "Monorail"),
    ("rapidride", "RapidRide"),
    ("swift", "Swift BRT"),
    ("frequent", "Frequent bus"),
    ("local", "All-day bus"),
    ("peak", "Rush-hour & limited bus"),
    ("shuttle", "Link shuttle bus"),
    ("dart", "Dial-a-Ride (DART)"),
    ("watertaxi", "Water Taxi"),
    ("ferry", "Ferry"),
]
CAT_RANK = {c: i for i, (c, _) in enumerate(CATEGORIES)}

NAME_FIX = {
    ("Seattle", "rail"): "King Street Station",
    ("Seattle", "ferry"): "Colman Dock ferry terminal",
    ("Pier 50 Seattle Ferry Dock", "ferry"): "Pier 50 passenger ferries",
    ("West Seattle Water Taxi & Colman Dock", "ferry"): "Pier 50 passenger ferries",
    ("Vashon Island Water Taxi & Colman Dock", "ferry"): "Pier 50 passenger ferries",
    ("Water Taxi Route & Harbor Ave SW", "ferry"): "Seacrest Park water taxi dock",
    ("Vashon Passenger Ferry & Vashon Ferry Dock", "ferry"): "Vashon passenger ferry dock",
    ("Vashon Island", "ferry"): "Vashon Island ferry terminal",
    ("Fauntleroy", "ferry"): "Fauntleroy ferry terminal",
    ("Westlake Center", "rail"): "Westlake Center (Monorail)",
    ("Seattle Center", "rail"): "Seattle Center (Monorail)",
    ("Westlake Hub", "rail"): "Westlake Hub (Streetcar)",
}

def sample_days(today=None):
    """Next Wednesday, Saturday and Sunday (today counts), used as typical service days."""
    today = today or dt.date.today()
    nxt = lambda wd: today + dt.timedelta(days=(wd - today.weekday()) % 7)
    return {"weekday": nxt(2).strftime("%Y%m%d"), "saturday": nxt(5).strftime("%Y%m%d"), "sunday": nxt(6).strftime("%Y%m%d")}


DAYS = sample_days()
PERIODS = [  # (key, label, start hour, end hour)
    ("am", "Morning rush", 6, 9),
    ("mid", "Midday", 9, 15),
    ("pm", "Afternoon rush", 15, 18),
    ("eve", "Evening", 18, 22),
    ("late", "Late night", 22, 26),
]


def fetch(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "king-county-transit-map build"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    zipfile.ZipFile(io.BytesIO(data))  # must be a valid zip
    with open(dest, "wb") as f:
        f.write(data)


def safe_id(key, raw):
    """Feed-prefixed id using only letters, digits and hyphens (safe in links)."""
    return f"{key}-" + re.sub(r"[^A-Za-z0-9]+", "-", str(raw)).strip("-")


def load_feeds():
    """Read every feed in config.FEEDS into combined tables with feed-prefixed ids."""
    os.makedirs(FEED_DIR, exist_ok=True)
    parts = defaultdict(list)
    versions = {}
    for f in FEEDS:
        key = f["key"]
        path = os.path.join(FEED_DIR, f"{key}.zip")
        if not os.path.exists(path) or os.environ.get("FRESH_FEEDS"):
            for url in [f["url"], f.get("fallback")]:
                if not url:
                    continue
                try:
                    fetch(url, path)
                    break
                except Exception as e:  # keep going: one missing agency shouldn't stop the build
                    print(f"  ! {key}: {url} failed ({e})")
        if not os.path.exists(path):
            print(f"  ! skipping {key}: no feed")
            continue
        z = zipfile.ZipFile(path)
        names = set(z.namelist())

        def rd(name, **kw):
            if name not in names:
                return None
            return pd.read_csv(z.open(name), dtype=str, keep_default_na=False, encoding="utf-8-sig", **kw)

        p = lambda col: (lambda v: f"{key}|{v}") if col else None  # noqa: E731
        routes = rd("routes.txt")
        if "agency_id" not in routes:
            routes["agency_id"] = ""
        for col in ["route_short_name", "route_long_name", "route_desc", "route_url", "route_color", "route_text_color"]:
            if col not in routes:
                routes[col] = ""
        if f.get("only"):
            routes = routes[routes.route_long_name.str.contains(f["only"], case=False)]
        routes["agency_id"] = routes.agency_id.map(lambda a: f["agency"].get(a, f["default"]) if a else f["default"])
        routes["raw_route_id"] = routes.route_id
        routes["route_id"] = routes.route_id.map(p(1))
        trips = rd("trips.txt")
        for col in ["direction_id", "shape_id", "trip_headsign"]:
            if col not in trips:
                trips[col] = ""
        trips = trips[["route_id", "trip_id", "service_id", "direction_id", "shape_id", "trip_headsign"]].copy()
        for col in ["route_id", "trip_id", "service_id", "shape_id"]:
            trips[col] = trips[col].map(p(1))
        trips = trips[trips.route_id.isin(set(routes.route_id))]
        cal = rd("calendar.txt")
        cal_dates = rd("calendar_dates.txt")
        if cal is not None:
            cal["service_id"] = cal.service_id.map(p(1))
            parts["cal"].append(cal)
        if cal_dates is not None:
            cal_dates["service_id"] = cal_dates.service_id.map(p(1))
            parts["cal_dates"].append(cal_dates)
        stops = rd("stops.txt")
        for col in ["stop_code", "parent_station", "location_type"]:
            if col not in stops:
                stops[col] = ""
        stops["stop_id"] = stops.stop_id.map(lambda v: safe_id(key, v))
        stops["parent_station"] = stops.parent_station.map(lambda v: safe_id(key, v) if v else "")
        st = pd.read_csv(z.open("stop_times.txt"), usecols=["trip_id", "stop_id", "departure_time", "stop_sequence"],
                         dtype={"trip_id": str, "stop_id": str, "departure_time": str, "stop_sequence": int},
                         keep_default_na=False, encoding="utf-8-sig")
        st["trip_id"] = st.trip_id.map(p(1))
        st = st[st.trip_id.isin(set(trips.trip_id))]
        st["stop_id"] = st.stop_id.map(lambda v: safe_id(key, v))
        if "shapes.txt" in names:
            shp = pd.read_csv(z.open("shapes.txt"), usecols=["shape_id", "shape_pt_sequence", "shape_pt_lat", "shape_pt_lon"],
                              dtype={"shape_id": str, "shape_pt_sequence": int, "shape_pt_lat": float, "shape_pt_lon": float},
                              encoding="utf-8-sig")
            shp["shape_id"] = shp.shape_id.map(p(1))
            parts["shapes"].append(shp)
        fi = rd("feed_info.txt")
        agencies = rd("agency.txt")
        name = agencies.agency_name.iloc[0] if agencies is not None and len(agencies) else key
        versions[name] = (fi.feed_version.iloc[0] if fi is not None and "feed_version" in fi and len(fi) else "")
        parts["routes"].append(routes)
        parts["trips"].append(trips)
        parts["stops"].append(stops)
        parts["st"].append(st)
        print(f"  {key}: {len(routes)} routes, {len(trips)} trips")
    out = {k: pd.concat(v, ignore_index=True) for k, v in parts.items()}
    return out, versions


def to_sec(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def fmt_time(sec):
    h, m = divmod(sec // 60, 60)
    h24 = h % 24
    ap = "AM" if h24 < 12 else "PM"
    h12 = h24 % 12 or 12
    return f"{h12}:{m:02d} {ap}"


def active_services(cal, cal_dates, ymd):
    d = dt.date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:]))
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d.weekday()]
    on = set(cal[(cal[wd] == "1") & (cal.start_date <= ymd) & (cal.end_date >= ymd)].service_id)
    cd = cal_dates[cal_dates.date == ymd]
    on |= set(cd[cd.exception_type == "1"].service_id)
    on -= set(cd[cd.exception_type == "2"].service_id)
    return on


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    print("reading feeds ...")
    T, versions = load_feeds()
    routes, trips, cal, cal_dates, stops, st = T["routes"], T["trips"], T["cal"], T["cal_dates"], T["stops"], T["st"]
    st = st.sort_values(["trip_id", "stop_sequence"])
    first = st.groupby("trip_id", sort=False).first()
    trips = trips.merge(first[["departure_time"]].rename(columns={"departure_time": "dep"}),
                        left_on="trip_id", right_index=True, how="inner")
    trips["dep_s"] = trips.dep.map(lambda t: to_sec(t) if t else -1)

    day_services = {k: active_services(cal, cal_dates, v) for k, v in DAYS.items()}

    dart_ids = set()
    dart_path = os.path.join(EXT, "dart_areas.geojson")
    if os.path.exists(dart_path):
        for f in json.load(open(dart_path))["features"]:
            dart_ids.add(str(f["properties"]["ROUTE_ID"]))

    shp = T["shapes"].sort_values(["shape_id", "shape_pt_sequence"])
    shapes = {sid: list(zip(g.shape_pt_lon.round(6), g.shape_pt_lat.round(6))) for sid, g in shp.groupby("shape_id", sort=False)}

    region = box(REGION["west"], REGION["south"], REGION["east"], REGION["north"])
    stops = stops.drop_duplicates("stop_id")
    stops_idx = stops.set_index("stop_id")

    out_routes, route_shapes, used_slugs = [], {}, set()
    route_stops = defaultdict(set)
    trips_by_route = dict(tuple(trips.groupby("route_id")))
    trip_len = st.groupby("trip_id").size()

    groups = {}
    for _, r in routes.iterrows():
        key = r.route_id
        if r.route_type == "4" and r.agency_id in ("95", "20"):
            ends = re.split(r" - | to ", re.sub(r" Fast Ferry$", "", r.route_long_name.strip()))
            key = "ferry:" + r.agency_id + ":" + "|".join(sorted(e.strip() for e in ends))
        groups.setdefault(key, []).append(r)

    for gkey, members in groups.items():
        r = members[0]
        rid, aid = r.route_id, r.agency_id
        raw = r.raw_route_id
        parts = []
        for i, m in enumerate(members):
            t = trips_by_route.get(m.route_id)
            if t is not None:
                t = t.copy()
                if len(members) > 1:
                    t["direction_id"] = str(i)
                parts.append(t)
        tr = pd.concat(parts) if parts else None
        if tr is None or aid not in AGENCY:
            continue
        # Which days does it run?
        per_day = {d: tr[tr.service_id.isin(s)] for d, s in day_services.items()}
        if all(len(v) == 0 for v in per_day.values()):
            continue
        wk = per_day["weekday"] if len(per_day["weekday"]) else max(per_day.values(), key=len)

        # Representative shapes: busiest shape per direction, plus variants carrying
        # at least 15% of the route's trips (covers branches and one-way couplets).
        sc = Counter(zip(wk.shape_id, wk.direction_id))
        total = sum(sc.values())
        chosen, best_dir = [], {}
        for (sid, d), n in sc.most_common():
            if sid not in shapes:
                continue
            if d not in best_dir:
                best_dir[d] = sid
                chosen.append((sid, n))
            elif n >= 0.15 * total and sid not in [c[0] for c in chosen]:
                chosen.append((sid, n))
        geoms = [shapes[s] for s, _ in chosen if len(shapes[s]) > 1]
        if not geoms or not any(LineString(g).intersects(region) for g in geoms):
            continue

        short = r.route_short_name or r.route_long_name
        long_name = r.route_long_name if r.route_short_name else ""
        desc = (r.route_desc or long_name) if aid == "1" else (long_name or r.route_desc)
        rtype = r.route_type

        # Frequency: departures per period in the busiest direction
        sched = {}
        for d, t in per_day.items():
            if len(t) == 0:
                sched[d] = None
                continue
            row = {}
            for key, _, h0, h1 in PERIODS:
                m = t[(t.dep_s >= h0 * 3600) & (t.dep_s < h1 * 3600)]
                c = m.groupby("direction_id").size().max() if len(m) else 0
                row[key] = round((h1 - h0) * 60 / c) if c else None
                row[key + "_n"] = int(c)
            row["first"] = fmt_time(int(t.dep_s.min()))
            row["last"] = fmt_time(int(t.dep_s.max()))
            row["span_h"] = round((int(t.dep_s.max()) - int(t.dep_s.min())) / 3600, 1)
            row["trips"] = int(len(t))
            sched[d] = row
        wsched = sched["weekday"] or {}
        mid_hw = wsched.get("mid")
        mid_n = wsched.get("mid_n", 0)
        runs_midday = mid_n >= 3  # at least every two hours through the middle of the day

        # Category
        name_l = short.lower()
        if aid == "40" and rtype == "0":
            cat = "link"
        elif aid == "40" and rtype == "2":
            cat = "sounder"
        elif aid == "51":
            cat = "amtrak"
        elif aid == "96":
            cat = "monorail"
        elif aid == "23":
            cat = "streetcar"
        elif rtype == "4" and aid == "1":
            cat = "watertaxi"
        elif rtype == "4":
            cat = "ferry"
        elif aid == "1" and name_l.endswith(" line"):
            cat = "rapidride"
        elif name_l.startswith("swift"):
            cat = "swift"
        elif "shuttle" in raw.lower() and aid == "40":
            cat = "shuttle"
        elif aid == "1" and short in dart_ids:
            cat = "dart"
        elif aid == "1" and short.startswith("98"):
            cat = "peak"  # school-day trips
        elif not runs_midday:
            cat = "peak"
        elif mid_hw is not None and mid_hw <= 15:
            cat = "frequent"
        else:
            cat = "local"

        agency_full, agency_short = AGENCY[aid]
        if cat == "rapidride":
            label = short.replace(" Line", "")
        elif cat == "link":
            label = short.replace(" Line", "")
        elif cat == "sounder":
            label = short.replace(" Line", "")
        elif cat == "streetcar":
            label = "SLU" if "South Lake" in short else "FHS"
        elif cat == "monorail":
            label = "M"
        elif cat == "swift":
            label = short.replace("Swift ", "")
        elif cat == "shuttle":
            label = short.replace(" Shuttle Bus", "")
        elif cat == "ferry":
            label = "Ferry" if aid == "95" else "Fast ferry"
        else:
            label = short
        if cat == "ferry":
            ends = gkey.split(":")[-1].split("|") if gkey.startswith("ferry:") else [r.route_long_name]
            ends.sort(key=lambda e: (e != "Seattle", e))
            short = " – ".join(ends)
            desc = ("Washington State Ferries" if aid == "95" else "Kitsap Transit fast ferry") + ": " + short
        if cat in ("watertaxi",):
            label = short

        color = (r.route_color or "").upper()
        text_color = (r.route_text_color or "").upper()
        slug_base = slugify(f"{agency_short}-{short}")
        slug = slug_base
        i = 2
        while slug in used_slugs:
            slug = f"{slug_base}-{i}"
            i += 1
        used_slugs.add(slug)

        # Stop sequence for the main pattern in each direction
        patterns = []
        for d, sid in sorted(best_dir.items()):
            cand = wk[(wk.shape_id == sid) & (wk.direction_id == d)]
            if not len(cand):
                continue
            tid = trip_len.reindex(cand.trip_id).idxmax()
            patterns.append({"dir": d, "trip": tid, "headsign": cand.trip_headsign.mode().iloc[0] if len(cand.trip_headsign.mode()) else ""})

        out_routes.append({
            "id": slug, "gtfs": [m.route_id for m in members], "rt": [f"{m.agency_id}_{m.raw_route_id}" for m in members],
            "agency": agency_full, "agencyShort": agency_short,
            "short": short, "label": label, "name": desc, "cat": cat, "type": rtype,
            "color": color, "textColor": text_color, "url": r.route_url,
            "sched": sched, "midHeadway": mid_hw, "patterns": patterns,
        })
        route_shapes[slug] = {"cat": cat, "weights": [n for s, n in chosen if len(shapes[s]) > 1], "lines": geoms}

    # Stop sequences + stops served (all three day types)
    pattern_trips = {p["trip"]: (r["id"], p) for r in out_routes for p in r["patterns"]}
    pst = st[st.trip_id.isin(pattern_trips)]
    for tid, g in pst.groupby("trip_id"):
        slug, p = pattern_trips[tid]
        p["stops"] = g.stop_id.tolist()
        del p["trip"]
    for r in out_routes:
        for p in r["patterns"]:
            p.pop("trip", None)

    all_services = set().union(*day_services.values())
    gtfs_to_slug = {g: r["id"] for r in out_routes for g in r["gtfs"]}
    day_trips = trips[trips.service_id.isin(all_services) & trips.route_id.isin(gtfs_to_slug)]
    served = st[st.trip_id.isin(day_trips.trip_id)][["trip_id", "stop_id"]].drop_duplicates()
    served = served.merge(day_trips[["trip_id", "route_id"]], on="trip_id")[["stop_id", "route_id"]].drop_duplicates()
    for sid, rid in served.itertuples(index=False):
        route_stops[sid].add(gtfs_to_slug[rid])

    cat_of = {r["id"]: r["cat"] for r in out_routes}
    rank_of = {r["id"]: (CAT_RANK[r["cat"]], natural_key(r["short"])) for r in out_routes}
    rail_cats = {"link", "sounder", "amtrak", "streetcar", "monorail"}
    pad = 0.01
    out_stops, stations = [], {}
    for sid, rset in route_stops.items():
        if sid not in stops_idx.index:
            continue
        s = stops_idx.loc[sid]
        lon, lat = float(s.stop_lon), float(s.stop_lat)
        if not (REGION["west"] - pad <= lon <= REGION["east"] + pad and REGION["south"] - pad <= lat <= REGION["north"] + pad):
            continue
        rl = sorted(rset, key=lambda x: rank_of[x])
        cats = {cat_of[x] for x in rl}
        parent = s.parent_station
        if cats & rail_cats or cats & {"ferry", "watertaxi"}:
            kind = "rail" if cats & rail_cats else "ferry"
            key = parent if parent else sid
            if key in stops_idx.index:
                ps = stops_idx.loc[key]
                name, plon, plat = ps.stop_name, float(ps.stop_lon), float(ps.stop_lat)
            else:
                name, plon, plat = s.stop_name, lon, lat
            if kind == "rail" and cats & {"link"}:
                name = re.sub(r"\s+Station$", "", name)
            stn = stations.setdefault(key, {"id": slugify(f"{name}-{key}"), "name": name, "lon": plon, "lat": plat,
                                            "kind": kind, "routes": set(), "stops": []})
            stn["routes"] |= {x for x in rl if cat_of[x] in rail_cats | {"ferry", "watertaxi"}}
            stn["stops"].append(sid)
            bus = [x for x in rl if cat_of[x] not in rail_cats | {"ferry", "watertaxi"}]
            if not bus:
                continue
            rl = bus
        out_stops.append({"id": sid, "name": s.stop_name, "lon": round(lon, 6), "lat": round(lat, 6),
                          "code": s.stop_code, "routes": rl})

    # The same physical stop can appear in two agencies' feeds: merge stops with the same
    # name within ~30 m, keeping the other ids as aliases so links still resolve.
    by_name = defaultdict(list)
    for s_ in out_stops:
        by_name[s_["name"].strip().lower()].append(s_)
    kept = []
    for group in by_name.values():
        merged_here = []
        for s_ in group:
            hit = next((m for m in merged_here if abs(m["lat"] - s_["lat"]) * 111e3 < 30 and abs(m["lon"] - s_["lon"]) * 75e3 < 30), None)
            if hit:
                hit["routes"] = sorted(set(hit["routes"]) | set(s_["routes"]), key=lambda x: rank_of[x])
                hit.setdefault("alias", []).append(s_["id"])
            else:
                merged_here.append(s_)
        kept += merged_here
    out_stops = kept

    # Clearer names for terminals whose GTFS names are ambiguous ("Seattle" x2 ...)
    for st_ in stations.values():
        fix = NAME_FIX.get((st_["name"], st_["kind"]))
        if fix:
            st_["name"] = fix
    # Merge stations of one kind that share a name (platforms, Amtrak + Sounder, ...)
    merged = {}
    for st_ in sorted(stations.values(), key=lambda x: -len(x["routes"])):
        k = (st_["name"], st_["kind"])
        if k in merged:
            merged[k]["routes"] |= st_["routes"]
            merged[k]["stops"] += st_["stops"]
        else:
            merged[k] = st_
    out_stations = []
    for s in merged.values():
        s["routes"] = sorted(s["routes"], key=lambda x: rank_of[x])
        s["lon"], s["lat"] = round(s["lon"], 6), round(s["lat"], 6)
        out_stations.append(s)

    # Stop names used by route stop sequences (for the route card)
    names = {}
    for r in out_routes:
        for p in r["patterns"]:
            for sid in p.get("stops", []):
                if sid in stops_idx.index:
                    names[sid] = stops_idx.loc[sid].stop_name

    out_routes.sort(key=lambda r: rank_of[r["id"]])
    slug_index = {r["id"]: i for i, r in enumerate(out_routes)}
    export_schedule(trips, st, stops_idx, shapes, day_services, gtfs_to_slug, slug_index,
                    os.path.join(DATA, "schedule.json"))
    os.makedirs(DATA, exist_ok=True)
    meta = {
        "built": dt.date.today().isoformat(),
        "days": DAYS,
        "periods": [[k, label, h0, h1] for k, label, h0, h1 in PERIODS],
        "categories": CATEGORIES,
        "feeds": versions,
        "region": REGION,
    }
    json.dump({"meta": meta, "routes": out_routes, "stopNames": names},
              open(os.path.join(DATA, "routes.json"), "w"), separators=(",", ":"))
    json.dump({"stops": out_stops, "stations": out_stations},
              open(os.path.join(DATA, "stops.json"), "w"), separators=(",", ":"))
    json.dump(route_shapes, open(os.path.join(CACHE, "route_shapes.json"), "w"))
    c = Counter(r["cat"] for r in out_routes)
    print(f"{len(out_routes)} routes in region:", dict(c))
    print(f"{len(out_stops)} stops, {len(out_stations)} stations")


def export_schedule(trips, st, stops_idx, shapes, day_services, gtfs_to_slug, slug_index, path):
    """Timetable for estimated vehicle positions.

    patterns: one per (shape, stop list): a simplified path, each stop's distance along it
              (meters), and the typical share of the trip's running time at each stop.
    days:     per sample day, every trip as [pattern, start second, duration seconds].
    The page places each running trip along its pattern by the time of day.
    """
    LAT0, LON0 = 47.61, -122.33  # same flat projection as the page uses
    KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574
    all_sv = set().union(*day_services.values())
    act = trips[trips.service_id.isin(all_sv) & trips.route_id.isin(gtfs_to_slug.keys()) & trips.shape_id.isin(shapes.keys())]
    sub = st[st.trip_id.isin(set(act.trip_id))].copy()
    sub["t"] = sub.departure_time.map(lambda t: to_sec(t) if t else np.nan)
    g = sub.groupby("trip_id", sort=False)
    stop_lists, time_lists = g.stop_id.agg(tuple).to_dict(), g.t.agg(list).to_dict()
    coord = {sid: ((float(r.stop_lon) - LON0) * KX, (float(r.stop_lat) - LAT0) * KY) for sid, r in stops_idx.iterrows()}

    pat_index, pat_out, pat_d, pat_fracs, recs = {}, [], [], defaultdict(list), []
    for tr in act.itertuples(index=False):
        stops_t, times = stop_lists.get(tr.trip_id), time_lists.get(tr.trip_id)
        if not stops_t or len(stops_t) < 2 or any(sid not in coord for sid in stops_t):
            continue
        key = (tr.shape_id, stops_t)
        if key not in pat_index:
            xy = np.array([((lon - LON0) * KX, (lat - LAT0) * KY) for lon, lat in shapes[tr.shape_id]])
            pts = np.array(LineString(xy).simplify(5).coords)
            if len(pts) < 2:
                pat_index[key] = None
                continue
            a, b = pts[:-1], pts[1:]
            ab = b - a
            L = np.hypot(ab[:, 0], ab[:, 1])
            cum = np.concatenate([[0], np.cumsum(L)])
            d, last = [], 0.0
            for sid in stops_t:
                p = np.array(coord[sid])
                t = np.clip(((p - a) * ab).sum(1) / np.maximum(L ** 2, 1e-9), 0, 1)
                proj = a + ab * t[:, None]
                dist = np.hypot(*(proj - p).T)
                along = cum[:-1] + t * L
                okm = along >= last - 1
                if not okm.any():
                    d.append(last)
                    continue
                best = dist[okm].min()
                cand = np.where(okm & (dist <= best + 20))[0]  # earliest good match, so loops don't skip ahead
                i = cand[0]
                last = max(last, float(along[i]))
                d.append(last)
            lonlat = [[round(x / KX + LON0, 5), round(y / KY + LAT0, 5)] for x, y in pts]
            pat_index[key] = len(pat_out)
            pat_out.append({"r": slug_index[gtfs_to_slug[tr.route_id]], "c": lonlat, "d": [round(v, 1) for v in d]})
            pat_d.append(np.array(d))
        pi = pat_index[key]
        if pi is None:
            continue
        tt = np.array(times, dtype=float)
        ok = ~np.isnan(tt)
        if ok.sum() < 2:
            continue
        dd = pat_d[pi]
        tt = np.interp(np.arange(len(tt)), np.where(ok)[0], tt[ok])  # fill skipped (non-timepoint) times
        start, dur = tt[0], tt[-1] - tt[0]
        if dur <= 0 or dd[-1] <= 0:
            continue
        pat_fracs[pi].append((tt - start) / dur)
        recs.append((pi, int(start), int(dur), tr.service_id))
    for pi, fr in pat_fracs.items():
        f = np.maximum.accumulate(np.clip(np.median(np.vstack(fr), axis=0), 0, 1))
        f[0], f[-1] = 0, 1
        pat_out[pi]["f"] = [round(float(v), 4) for v in f]
    for p in pat_out:
        p.setdefault("f", [round(i / (len(p["d"]) - 1), 4) for i in range(len(p["d"]))])
    days = {}
    for k, sv in day_services.items():
        days[k] = sorted([[pi, s0, du] for pi, s0, du, sid in recs if sid in sv], key=lambda x: x[1])
    json.dump({"dates": DAYS, "patterns": pat_out, "days": days}, open(path, "w"), separators=(",", ":"))
    print(f"schedule: {len(pat_out)} patterns, trips " + ", ".join(f"{k} {len(v)}" for k, v in days.items())
          + f"; {os.path.getsize(path)/1e6:.2f} MB")


def natural_key(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


if __name__ == "__main__":
    main()
