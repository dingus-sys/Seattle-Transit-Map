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
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar
from shapely.geometry import LineString, box

sys.path.insert(0, os.path.dirname(__file__))
from config import CACHE, FEEDS, RAIL_REGION, REGION, SITE  # noqa: E402

FEED_DIR = os.path.join(CACHE, "gtfs", "feeds")
EXT = os.path.join(CACHE, "ext")
DATA = os.path.join(SITE, "data")

# small-town and rural agencies, whose all-day routes can run only every few hours
RURAL_AGENCIES = {"skagit", "island", "clallam", "mason", "jefferson", "wta"}

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
    "skagit": ("Skagit Transit", "Skagit"),
    "island": ("Island Transit", "Island"),
    "clallam": ("Clallam Transit", "Clallam"),
    "mason": ("Mason Transit", "Mason"),
    "jefferson": ("Jefferson Transit", "Jefferson"),
    "wta": ("Whatcom Transportation Authority", "WTA"),
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

def is_holiday(day):
    return len(USFederalHolidayCalendar().holidays(pd.Timestamp(day), pd.Timestamp(day))) > 0


def sample_days(today=None):
    """Next Wednesday, Saturday and Sunday (today counts) that aren't a federal holiday, used as
    typical service days. Holiday timetables drop weekday-only routes (Kitsap's commuter and school
    runs, Metro's peak-only routes), so a holiday sample day would take them off the map: on
    Veterans Day 2026 that dropped 47 Kitsap and 6 Metro routes."""
    today = today or dt.date.today()

    def nxt(wd):
        d = today + dt.timedelta(days=(wd - today.weekday()) % 7)
        while is_holiday(d):
            d += dt.timedelta(days=7)
        return d.strftime("%Y%m%d")

    return {"weekday": nxt(2), "saturday": nxt(5), "sunday": nxt(6)}


# TRANSIT_SAMPLE_DAYS=weekday,saturday,sunday (YYYYMMDD) rebuilds with a previous build's sample
# days, so a timetable-only change doesn't also shift which routes are on the map
DAYS = (dict(zip(("weekday", "saturday", "sunday"), os.environ["TRANSIT_SAMPLE_DAYS"].split(",")))
        if os.environ.get("TRANSIT_SAMPLE_DAYS") else sample_days())
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


MAP_TZ = "America/Los_Angeles"
# a gap this long between two consecutive stops is a feed error, not a timetable: no vehicle on
# this map takes more than eight hours between two stops
MAX_SEGMENT_SEC = 8 * 3600


def tz_shift_sec(feed_tz, when=None):
    """Seconds to add to a feed's service-day times (kept in the agency's own time zone, as GTFS
    requires) to read them as Seattle wall-clock times. Amtrak publishes America/New_York, so its
    Cascades trains leave three hours "late" until this is applied. Both zones change clocks on the
    same dates, so one offset serves every day of the year."""
    if not feed_tz or feed_tz == MAP_TZ:
        return 0
    when = when or dt.datetime.combine(dt.date.today(), dt.time(12))
    off = lambda z: ZoneInfo(z).utcoffset(when.replace(tzinfo=None)).total_seconds()  # noqa: E731
    return int(off(MAP_TZ) - off(feed_tz))


def parse_times(col):
    """'7:52:00' -> 28320.0 (NaN when blank). Vectorised over a string column."""
    parts = col.str.extract(r"^\s*(\d+):(\d+):(\d+)\s*$").astype(float)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


SLIP_CANDIDATES = (86400, 82800, 90000)  # a day, or a day less/more an hour (a clock-change slip)


def repair_time_jumps(st):
    """Fix a one-day slip inside one trip. Amtrak's feed (November 2026) has Seattle-Portland trips
    that run Kelso 14:15 then Vancouver 37:54, and Portland-Seattle trips Portland 9:45 then
    Vancouver 33:01: from there on every time is 23 hours too late (the agency publishes 14:54 and
    10:01). A time that long after the last one is not a timetable, it is a day added by mistake.
    Taking a day (or a day less an hour) off that stop and the ones after it restores the 39-minute
    leg. Trips that really cross midnight don't have a gap this long between two stops and are left
    alone. A gap that no slip explains is left as it is and counted here.
    Expects columns trip_id, stop_sequence, arr, dep (seconds); returns the table sorted by trip."""
    fixed, unexplained = 0, 0
    st = st.sort_values(["trip_id", "stop_sequence"], kind="stable").reset_index(drop=True)
    t = st.dep.where(st.dep.notna(), st.arr)
    last = t.groupby(st.trip_id, sort=False).ffill().shift(1)
    same = (st.trip_id.shift(1) == st.trip_id)
    bad = set(st.trip_id[same & ((t - last) > MAX_SEGMENT_SEC)])
    if not bad:
        return st
    arr, dep = st.arr.to_numpy(copy=True), st.dep.to_numpy(copy=True)
    for _, g in st[st.trip_id.isin(bad)].groupby("trip_id", sort=False):
        prev = None
        for k in g.index:
            a, d = arr[k], dep[k]
            tt = d if not np.isnan(d) else a
            c = 0
            if prev is not None and not np.isnan(tt):
                # each stop takes the slip (none, a day, a day less or plus an hour) that leaves the
                # shortest sensible leg: the feed's own slips are not all the same size (Kelso 14:15,
                # Vancouver 37:54 = +23 h, Portland 39:20 = +24 h)
                fits = [(tt - s_ - prev, s_) for s_ in (0,) + SLIP_CANDIDATES if 0 <= tt - s_ - prev <= MAX_SEGMENT_SEC]
                if fits:
                    c = min(fits)[1]
                    fixed += c != 0
                else:
                    unexplained += 1
            arr[k], dep[k] = a - c, d - c
            if not np.isnan(tt):
                prev = tt - c
    st["arr"], st["dep"] = arr, dep
    print(f"  time repair: {fixed} day-slips removed, {unexplained} implausible gaps left")
    return st


def safe_id(key, raw):
    """Feed-prefixed id using only letters, digits and hyphens (safe in links)."""
    return f"{key}-" + re.sub(r"[^A-Za-z0-9]+", "-", str(raw)).strip("-")


REQUIRED_FEEDS = {"kcm", "st", "ct", "pt", "wsf"}


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
                except Exception as e:
                    print(f"  ! {key}: {url} failed ({e})")
        if not os.path.exists(path):
            if key in REQUIRED_FEEDS:
                raise RuntimeError(f"Required agency feed '{key}' failed to download: aborting to protect dataset integrity.")
            print(f"  ! skipping optional {key}: no feed")
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
        # the time zone the feed's times are in: that of the agencies that run the routes kept
        ag = rd("agency.txt")
        feed_tz = MAP_TZ
        if ag is not None and "agency_timezone" in ag and len(ag):
            mine = ag[ag.agency_id.isin(set(routes.agency_id))] if "agency_id" in ag and routes.agency_id.ne("").any() else ag
            feed_tz = (mine if len(mine) else ag).agency_timezone.mode().iloc[0] or MAP_TZ
        routes["agency_id"] = routes.agency_id.map(lambda a: f["agency"].get(a, f["default"]) if a else f["default"])
        routes["raw_route_id"] = routes.route_id
        routes["route_id"] = routes.route_id.map(p(1))
        trips = rd("trips.txt")
        for col in ["direction_id", "shape_id", "trip_headsign", "block_id"]:
            if col not in trips:
                trips[col] = ""
        trips = trips[["route_id", "trip_id", "service_id", "direction_id", "shape_id", "trip_headsign", "block_id"]].copy()
        for col in ["route_id", "trip_id", "service_id", "shape_id"]:
            trips[col] = trips[col].map(p(1))
        trips["block_id"] = trips.block_id.map(lambda v: f"{key}|{v}" if v else "")
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
        st_cols = ["trip_id", "stop_id", "arrival_time", "departure_time", "stop_sequence", "pickup_type", "drop_off_type"]
        have = set(pd.read_csv(z.open("stop_times.txt"), nrows=0, encoding="utf-8-sig").columns)
        st = pd.read_csv(z.open("stop_times.txt"), usecols=[c for c in st_cols if c in have],
                         dtype={"trip_id": str, "stop_id": str, "arrival_time": str, "departure_time": str,
                                "stop_sequence": int, "pickup_type": str, "drop_off_type": str},
                         keep_default_na=False, encoding="utf-8-sig")
        for col in ("pickup_type", "drop_off_type"):
            if col not in st:
                st[col] = ""
        st["trip_id"] = st.trip_id.map(p(1))
        st = st[st.trip_id.isin(set(trips.trip_id))].copy()
        st["stop_id"] = st.stop_id.map(lambda v: safe_id(key, v))
        # times become seconds in Seattle wall-clock time: the feed's own time zone applied once
        # (Amtrak's are New York time), then a trip's +24 h slips taken out
        if "arrival_time" not in st:
            st["arrival_time"] = ""
        shift = tz_shift_sec(feed_tz)
        st["dep"] = parse_times(st.departure_time.where(st.departure_time != "", st.arrival_time))
        st["arr"] = parse_times(st.arrival_time.where(st.arrival_time != "", st.departure_time))
        st = st.drop(columns=["departure_time", "arrival_time"])
        if shift:
            st["dep"] += shift
            st["arr"] += shift
            print(f"  {key}: times shifted {shift / 3600:+.0f} h to Seattle time")
        st = repair_time_jumps(st)
        tx = rd("transfers.txt")
        if tx is not None and "min_transfer_time" in tx:
            tx = tx[tx.min_transfer_time.str.strip() != ""].copy()
            for c in ("from_stop_id", "to_stop_id"):
                if c not in tx:
                    tx[c] = ""
            for c in ("from_route_id", "to_route_id"):
                tx[c] = tx[c].map(p(1)) if c in tx else ""
            tx["from_stop_id"] = tx.from_stop_id.map(lambda v: safe_id(key, v) if v else "")
            tx["to_stop_id"] = tx.to_stop_id.map(lambda v: safe_id(key, v) if v else "")
            tx["sec"] = tx.min_transfer_time.astype(float).astype(int)
            parts["transfers"].append(tx[["from_stop_id", "to_stop_id", "from_route_id", "to_route_id", "sec"]])
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
    trips = trips.merge(first[["dep"]].rename(columns={"dep": "dep_s"}), left_on="trip_id", right_index=True, how="inner")
    trips["dep_s"] = trips.dep_s.fillna(-1).astype(int)

    day_services = {k: active_services(cal, cal_dates, v) for k, v in DAYS.items()}
    # Every date the planner can look at (a route that runs only on some dates, like Metro's
    # 98x school trips or WTA's 14S, still has to be on the map and in the planner)
    horizon = horizon_services(cal, cal_dates)
    horizon_svc = set().union(*(sv for _, _, sv in horizon)) if horizon else set()

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
        any_date = tr[tr.service_id.isin(horizon_svc)]
        if all(len(v) == 0 for v in per_day.values()) and not len(any_date):
            continue
        # the busiest sample day stands for the route; a route none of the three sample days
        # runs on is drawn from its trips on the other dates
        sample_days_with_trips = [v for v in per_day.values() if len(v)]
        wk = (per_day["weekday"] if len(per_day["weekday"])
              else max(sample_days_with_trips, key=len) if sample_days_with_trips else any_date)

        # Representative shapes: busiest shape per direction, plus variants carrying
        # at least 15% of the route's trips (covers branches and one-way couplets). Amtrak
        # keeps every shape that runs: the Cascades line has a few long-distance variants (to
        # Vancouver, to Eugene) of two or three trips each, and each one reaches track the
        # others don't.
        sc = Counter(zip(wk.shape_id, wk.direction_id))
        total = sum(sc.values())
        chosen, best_dir = [], {}
        for (sid, d), n in sc.most_common():
            if sid not in shapes:
                continue
            if d not in best_dir:
                best_dir[d] = sid
                chosen.append((sid, n))
            elif (n >= 0.15 * total or aid == "51") and sid not in [c[0] for c in chosen]:
                chosen.append((sid, n))
        geoms = [shapes[s] for s, _ in chosen if len(shapes[s]) > 1]
        if r.route_type == "3":
            # a bus "shape" with a straight jump of kilometers isn't a path, just two stops joined
            # by a ruler (Kitsap's TA "task" trips); such a route can't be drawn on the streets
            seg = lambda a, b: math.hypot((b[0] - a[0]) * 75000, (b[1] - a[1]) * 111000)  # noqa: E731
            geoms = [g for g in geoms if all(seg(a, b) < 2500 for a, b in zip(g, g[1:]))
                     and sum(seg(a, b) for a, b in zip(g, g[1:])) > 50]  # and not a single point
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
        if aid in RURAL_AGENCIES and not sched["weekday"]:
            # Skagit's feed had no trips at all on the sample weekday, so every Skagit route
            # was filed as rush-hour (hidden by default); judge such a route by its busiest day
            wsched = max((sched[d] for d in ("saturday", "sunday") if sched[d]),
                         key=lambda row: row.get("mid_n", 0), default={})
        mid_hw = wsched.get("mid")
        mid_n = wsched.get("mid_n", 0)
        runs_midday = mid_n >= 3  # at least every two hours through the middle of the day
        if aid in RURAL_AGENCIES and not runs_midday:
            # a rural route every 3-6 hours from morning to evening is its town's all-day
            # service, not a commute route (Jefferson 1, Clallam 10, Island 411C)
            runs_midday = (mid_n >= 1 and wsched.get("am_n", 0) >= 1 and wsched.get("pm_n", 0) >= 1
                           and wsched.get("span_h", 0) >= 8)

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
            label = "SLU" if "South Lake" in short else "FH"
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

    all_services = set().union(*day_services.values()) | horizon_svc
    gtfs_to_slug = {g: r["id"] for r in out_routes for g in r["gtfs"]}
    day_trips = trips[trips.service_id.isin(all_services) & trips.route_id.isin(gtfs_to_slug)]
    served = st[st.trip_id.isin(day_trips.trip_id)][["trip_id", "stop_id"]].drop_duplicates()
    served = served.merge(day_trips[["trip_id", "route_id"]], on="trip_id")[["stop_id", "route_id"]].drop_duplicates()

    pat_stops_by_slug = {r["id"]: set(sid for p in r.get("patterns", []) for sid in p.get("stops", [])) for r in out_routes}
    pts_by_slug = {slug: [pt for line in route_shapes.get(slug, {}).get("lines", []) for pt in line] for slug in gtfs_to_slug.values()}

    for sid, rid in served.itertuples(index=False):
        slug = gtfs_to_slug[rid]
        if sid in pat_stops_by_slug.get(slug, set()):
            route_stops[sid].add(slug)
        elif sid in stops_idx.index:
            pts = pts_by_slug.get(slug)
            if pts:
                s_lat, s_lon = float(stops_idx.loc[sid].stop_lat), float(stops_idx.loc[sid].stop_lon)
                min_d = min(math.hypot((px - s_lon) * 75000, (py - s_lat) * 111000) for px, py in pts)
                if min_d <= 2000:
                    route_stops[sid].add(slug)
            else:
                route_stops[sid].add(slug)

    cat_of = {r["id"]: r["cat"] for r in out_routes}
    rank_of = {r["id"]: (CAT_RANK[r["cat"]], natural_key(r["short"])) for r in out_routes}
    rail_cats = {"link", "sounder", "amtrak", "streetcar", "monorail"}
    # a stop outside the map area has no line to sit on (the network is clipped at REGION), so none is
    # kept: with a margin, WTA's 26, 27 and 71X had stops 450-835 m past the end of their drawn line
    pad = 0.0
    out_stops, stations = [], {}
    for sid, rset in route_stops.items():
        if sid not in stops_idx.index:
            continue
        s = stops_idx.loc[sid]
        lon, lat = float(s.stop_lon), float(s.stop_lat)
        rl = sorted(rset, key=lambda x: rank_of[x])
        cats = {cat_of[x] for x in rl}
        inside = REGION["west"] - pad <= lon <= REGION["east"] + pad and REGION["south"] - pad <= lat <= REGION["north"] + pad
        # the Cascades line's stations carry on past the map's edge (to Mount Vernon and Chehalis)
        if not inside and "amtrak" in cats:
            inside = RAIL_REGION["west"] <= lon <= RAIL_REGION["east"] and RAIL_REGION["south"] <= lat <= RAIL_REGION["north"]
        if not inside:
            continue
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

    # every stop id the page can look up, so a pattern ending somewhere it can't (Portland, for
    # the Cascades) carries its destination's name itself
    known_stops = ({s_["id"] for s_ in out_stops} | {a for s_ in out_stops for a in s_.get("alias", [])}
                   | {sid for st_ in out_stations for sid in st_["stops"]})
    out_routes.sort(key=lambda r: rank_of[r["id"]])
    slug_index = {r["id"]: i for i, r in enumerate(out_routes)}
    export_schedule(trips, st, stops_idx, shapes, day_services, gtfs_to_slug, slug_index,
                    os.path.join(DATA, "schedule.json"), horizon=horizon, transfers=T.get("transfers"), known_stops=known_stops)
    os.makedirs(DATA, exist_ok=True)
    meta = {
        "built": dt.date.today().isoformat(),
        "days": DAYS,
        "periods": [[k, label, h0, h1] for k, label, h0, h1 in PERIODS],
        "categories": CATEGORIES,
        "feeds": versions,
        "region": REGION,
        "rail_region": RAIL_REGION,
    }
    # Validation checks to protect against partial/degraded builds
    if len(out_routes) < 330:
        raise ValueError(f"Build failed validation: only {len(out_routes)} routes found (expected >= 330)")
    if len(out_stops) < 10000:
        raise ValueError(f"Build failed validation: only {len(out_stops)} stops found (expected >= 10000)")

    json.dump({"meta": meta, "routes": out_routes, "stopNames": names},
              open(os.path.join(DATA, "routes.json"), "w"), separators=(",", ":"))
    json.dump({"stops": out_stops, "stations": out_stations},
              open(os.path.join(DATA, "stops.json"), "w"), separators=(",", ":"))
    json.dump(route_shapes, open(os.path.join(CACHE, "route_shapes.json"), "w"))
    c = Counter(r["cat"] for r in out_routes)
    print(f"{len(out_routes)} routes in region:", dict(c))
    print(f"{len(out_stops)} stops, {len(out_stations)} stations")


SPECIAL_HORIZON_DAYS = 120  # the trip planner looks up to 90 days ahead


def horizon_services(cal, cal_dates):
    """[(yyyymmdd, day type, services running)] for every date the planner can look at."""
    if cal is None:
        return []
    today = dt.date.today()
    out = []
    for i in range(SPECIAL_HORIZON_DAYS):
        d = today + dt.timedelta(days=i)
        ymd = d.strftime("%Y%m%d")
        out.append((ymd, day_type(d), active_services(cal, cal_dates, ymd)))
    return out


def day_type(d):
    return "saturday" if d.weekday() == 5 else "sunday" if d.weekday() == 6 else "weekday"


def special_days(recs, pat_route, day_services, horizon_services):
    """Dates whose service is not their sample day's: holidays (Thanksgiving runs a Sunday
    timetable, Sounder doesn't run), a feed's next service change, or a feed that has run out.

    Each date gets a variant: the sample day it is closest to ("base"), the routes whose trips
    differ from that day ("drop"), and those routes' real trips that date ("add"). The page builds
    the date's timetable from it, so the planner never offers a trip that doesn't run that day.
    Returns ({yyyymmdd: variant index}, [variants])."""
    by_sid = defaultdict(list)
    for pi, s0, du, sid in recs:
        by_sid[sid].append((pi, s0, du))

    def per_route(sids):
        out = defaultdict(set)
        for sid in sids:
            for t in by_sid.get(sid, ()):
                out[pat_route[t[0]]].add(t)
        return out

    base = {k: per_route(sv) for k, sv in day_services.items()}
    dates, variants, seen = {}, [], {}
    for ymd, wkey, sv in horizon_services:
        if sv == day_services[wkey]:
            continue
        key = frozenset(sv)
        if key not in seen:
            tr = per_route(sv)
            best = None
            for k, b in base.items():
                drop = sorted(r for r in b if tr.get(r) != b[r])
                add = sorted((t for r in tr if tr[r] != b.get(r) for t in tr[r]), key=lambda x: (x[1], x[0]))
                cost = len(add) + sum(len(b[r]) for r in drop)
                if best is None or cost < best[0] or (cost == best[0] and k == wkey):
                    best = (cost, k, drop, add)
            if best[0] == 0 and best[1] == wkey:
                seen[key] = None
            else:
                seen[key] = len(variants)
                variants.append({"base": best[1], "drop": best[2], "add": [list(t) for t in best[3]]})
        if seen[key] is not None:
            dates[ymd] = seen[key]
    return dates, variants


PROFILE_TOL_SEC = 45  # trips whose stop times stay within this of a pattern's profile share it
MAX_TRIP_SEC = 16 * 3600  # longest trip we believe (Cascades to Vancouver BC is under ten hours)
THROUGH_MAX_GAP_SEC = 15 * 60  # a bus waiting this long at the end of a trip still "stays on"
THROUGH_MAX_WALK_M = 150  # ...if the next trip starts at (or right beside) the stop the last ended at


def stay_aboard_links(meta, coord):
    """[[pattern, start, next pattern, next start], ...]: trips of one vehicle block that go on as a
    different route from where the first one ended (Metro's 5 -> 21 through Downtown, say). The
    agency's own block_id says it is the same bus, so a rider can stay on; two routes that merely
    meet at a stop (different blocks) are an ordinary transfer however the routes are paired."""
    by_block = defaultdict(list)
    for blk, svc, rix, pi, t0, t1, s0, s1 in meta:
        by_block[(blk, svc)].append((t0, t1, rix, pi, s0, s1))
    links = set()
    for trips in by_block.values():
        trips.sort()
        for (a0, a1, ar, api, _, alast), (b0, b1, br, bpi, bfirst, _) in zip(trips, trips[1:]):
            if ar == br or not (-60 <= b0 - a1 <= THROUGH_MAX_GAP_SEC):
                continue
            if alast != bfirst:
                ca, cb = coord.get(alast), coord.get(bfirst)
                if not ca or not cb or math.hypot(ca[0] - cb[0], ca[1] - cb[1]) > THROUGH_MAX_WALK_M:
                    continue
            links.add((api, a0, bpi, b0))
    return [list(x) for x in sorted(links)]


def transfer_rules(tx, gtfs_to_slug, slug_index):
    """The agencies' minimum transfer times (transfers.txt, type 2): [from stop, to stop, from route,
    to route, seconds]; a stop or route left blank in the feed is "" / -1 (any)."""
    if tx is None or not len(tx):
        return []
    out = set()
    for r in tx.itertuples(index=False):
        if r.sec <= 0:
            continue
        ra = slug_index.get(gtfs_to_slug.get(r.from_route_id)) if r.from_route_id else -1
        rb = slug_index.get(gtfs_to_slug.get(r.to_route_id)) if r.to_route_id else -1
        if ra is None or rb is None:
            continue
        out.add((r.from_stop_id, r.to_stop_id, ra, rb, int(r.sec)))
    return [list(x) for x in sorted(out)]


def export_schedule(trips, st, stops_idx, shapes, day_services, gtfs_to_slug, slug_index, path, horizon=(), transfers=None, known_stops=None):
    """Timetable for estimated vehicle positions.

    patterns: one per (shape, stop list): a simplified path, its stops, each stop's distance along it
              (meters), and the typical share of the trip's running time at each stop.
    days:     per sample day, every trip as [pattern, start second, duration seconds].
    The page places each running trip along its pattern by the time of day.
    """
    LAT0, LON0 = 47.61, -122.33  # same flat projection as the page uses
    KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574
    all_sv = set().union(*day_services.values(), *(sv for _, _, sv in horizon))
    act = trips[trips.service_id.isin(all_sv) & trips.route_id.isin(gtfs_to_slug.keys()) & trips.shape_id.isin(shapes.keys())]
    sub = st[st.trip_id.isin(set(act.trip_id))].copy()
    sub = sub.sort_values(["trip_id", "stop_sequence"], kind="stable")
    sub["t"], sub["ta"] = sub.dep, sub.arr
    g = sub.groupby("trip_id", sort=False)
    stop_lists, time_lists, arr_lists = g.stop_id.agg(tuple).to_dict(), g.t.agg(list).to_dict(), g.ta.agg(list).to_dict()
    # pickup_type / drop_off_type 1 = none, so the planner never boards or leaves there
    nb_lists = g.pickup_type.agg(lambda v: tuple(i for i, x in enumerate(v) if str(x).strip() == "1")).to_dict()
    na_lists = g.drop_off_type.agg(lambda v: tuple(i for i, x in enumerate(v) if str(x).strip() == "1")).to_dict()
    coord = {sid: ((float(r.stop_lon) - LON0) * KX, (float(r.stop_lat) - LAT0) * KY) for sid, r in stops_idx.iterrows()}

    pat_index, pat_out, pat_d, pat_fracs, recs = {}, [], [], defaultdict(list), []
    pat_dwell = defaultdict(list)
    pat_head, pat_last = defaultdict(Counter), {}
    trip_meta = []  # (block, service, route, pattern, start, end, first stop, last stop) for stay-aboard links
    n_long = 0
    prof_reps = defaultdict(list)
    geo_base = {}
    for tr in act.itertuples(index=False):
        stops_t, times = stop_lists.get(tr.trip_id), time_lists.get(tr.trip_id)
        if not stops_t or len(stops_t) < 2 or any(sid not in coord for sid in stops_t):
            continue
        nb_t, na_t = nb_lists.get(tr.trip_id, ()), na_lists.get(tr.trip_id, ())
        rix = slug_index[gtfs_to_slug[tr.route_id]]
        # trips that share stops but run on materially different timings (an express run, a
        # pad at a terminal) get their own pattern: one median profile would put a timed stop
        # many minutes off its real departure
        tarr = np.array(times, dtype=float)
        tok = ~np.isnan(tarr)
        offs = None
        if tok.sum() >= 2:
            tarr = np.interp(np.arange(len(tarr)), np.where(tok)[0], tarr[tok])
            offs = tarr - tarr[0]
        prof = 0
        if offs is not None and offs[-1] > 0:
            reps = prof_reps[(rix, tr.shape_id, stops_t, nb_t, na_t)]
            for ci, rep in enumerate(reps):
                if np.abs(rep * offs[-1] - offs).max() <= PROFILE_TOL_SEC:
                    prof = ci
                    break
            else:
                prof = len(reps)
                reps.append(offs / offs[-1])
        # a route's trips keep that route's identity even when another route shares their path
        # and stops (Jefferson's shuttle 11 and route 7 do): only the geometry is shared
        key = (rix, tr.shape_id, stops_t, nb_t, na_t, prof)
        gkey = (tr.shape_id, stops_t)
        if key not in pat_index and gkey in geo_base:
            # same path and stops, different timing: only its own timing profile is stored; the
            # path, distances and stop list come from the first pattern ("b")
            bi = geo_base[gkey]
            if bi is None:
                pat_index[key] = None
            else:
                pat_index[key] = len(pat_out)
                entry = {"r": rix, "b": bi}
                if nb_t:
                    entry["nb"] = list(nb_t)
                if na_t:
                    entry["na"] = list(na_t)
                pat_out.append(entry)
                pat_d.append(pat_d[bi])
        elif key not in pat_index:
            xy = np.array([((lon - LON0) * KX, (lat - LAT0) * KY) for lon, lat in shapes[tr.shape_id]])
            pts = np.array(LineString(xy).simplify(5).coords)
            if len(pts) < 2:
                pat_index[key] = None
                geo_base[gkey] = None
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
            geo_base[gkey] = len(pat_out)
            # s: the stops themselves, so the page can list a stop's next departures
            entry = {"r": rix, "c": lonlat, "d": [round(v, 1) for v in d], "s": list(stops_t)}
            if nb_t:
                entry["nb"] = list(nb_t)
            if na_t:
                entry["na"] = list(na_t)
            pat_out.append(entry)
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
        if dur > MAX_TRIP_SEC:  # a day-long "trip" is a feed error; never plan on it
            n_long += 1
            continue
        pat_fracs[pi].append((tt - start) / dur)
        # time waiting at each stop (arrival to departure), for getting off before the bus leaves
        ta = np.array(arr_lists.get(tr.trip_id, times), dtype=float)
        raw = np.array(times, dtype=float)
        dw = np.where(np.isnan(ta) | np.isnan(raw), 0.0, np.maximum(raw - ta, 0.0))
        pat_dwell[pi].append(dw)
        pat_head[pi][str(getattr(tr, "trip_headsign", "") or "").strip()] += 1
        pat_last[pi] = stops_t[-1]
        recs.append((pi, int(start), int(dur), tr.service_id))
        blk = getattr(tr, "block_id", "")
        if blk:
            trip_meta.append((blk, tr.service_id, rix, pi, int(start), int(start + dur), stops_t[0], stops_t[-1]))
    for pi, fr in pat_fracs.items():
        f = np.maximum.accumulate(np.clip(np.median(np.vstack(fr), axis=0), 0, 1))
        f[0], f[-1] = 0, 1
        pat_out[pi]["f"] = [round(float(v), 4) for v in f]
    for pi, ws in pat_dwell.items():
        w = np.median(np.vstack(ws), axis=0)
        w = np.where(w >= 30, np.round(w / 15) * 15, 0).astype(int)
        if w.max() >= 60:
            pat_out[pi]["w"] = w.tolist()
    # what the vehicle's sign says: the trip headsign (mode), kept only where it says more than the
    # last stop's own name, or where the page has no such stop (a pattern running past the map)
    norm = lambda x: re.sub(r"[^a-z0-9]", "", str(x).lower())  # noqa: E731
    for pi, last in pat_last.items():
        head = next((h for h, _ in pat_head[pi].most_common() if h), "")
        last_name = stops_idx.loc[last].stop_name if last in stops_idx.index else ""
        known = known_stops is None or last in known_stops
        base = re.sub(r"\s*[-–]\s*Bay\s*\w+$|\s+Bay\s+\w+$", "", last_name, flags=re.I)
        if head and norm(head) != norm(base):
            pat_out[pi]["h"] = head
        elif not known and last_name:
            pat_out[pi]["h"] = last_name
    for p in pat_out:
        n_stops = len(p["d"] if "d" in p else pat_out[p["b"]]["d"])
        p.setdefault("f", [round(i / (n_stops - 1), 4) for i in range(n_stops)])
    days = {}
    for k, sv in day_services.items():
        days[k] = sorted([[pi, s0, du] for pi, s0, du, sid in recs if sid in sv], key=lambda x: x[1])
    special, variants = special_days(recs, [p["r"] for p in pat_out], day_services, horizon)
    through = stay_aboard_links(trip_meta, coord)
    xfer = transfer_rules(transfers, gtfs_to_slug, slug_index)
    out = {"dates": DAYS, "patterns": pat_out, "days": days, "special": special, "variants": variants}
    if through:
        out["through"] = through
    if xfer:
        out["xfer"] = xfer
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(f"schedule: {len(through)} stay-aboard trip pairs, {len(xfer)} minimum-transfer rules, "
          f"{n_long} trips over {MAX_TRIP_SEC // 3600} h dropped")
    print(f"schedule: {len(special)} dates differ from their sample day ({len(variants)} variants, "
          f"{sum(len(v['add']) for v in variants)} extra trips)")
    print(f"schedule: {len(pat_out)} patterns, trips " + ", ".join(f"{k} {len(v)}" for k, v in days.items())
          + f"; {os.path.getsize(path)/1e6:.2f} MB")


def natural_key(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


if __name__ == "__main__":
    main()
