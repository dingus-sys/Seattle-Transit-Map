"""Release check for site/data/schedule.json: known failure modes, run against the built file.

    python3 tools/check_schedule_release.py            # the data alone (what CI can do)
    python3 tools/check_schedule_release.py --feeds    # also compare trips with the agencies' feeds in .cache/gtfs/feeds

Each check is a mistake the published timetable has made (audit of November 25, 2026):
  * pickup / drop-off restrictions never made it into the file (the exporter was fixed but the data
    was not rebuilt, so a bus was offered at a stop where it won't pick up);
  * Amtrak Cascades times in New York time (a train leaving Seattle at 11:55 instead of 8:55) and a
    feed's one-day slip inside a trip (Seattle to Portland taking 27 hours);
  * routes whose trips were filed under another route that shares their path and stops (Jefferson 11);
  * routes missing because none of the three sample days runs them;
  * no stay-aboard links, no dwell times, no headsigns on the patterns that need one.
With --feeds, a sample of real trips is read from the feeds and their stop times compared with what
the file will say (departure share * duration); the share more than 90 s off must stay small.
"""
import json
import os
import random
import sys
import zipfile
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("SCHEDULE_DATA_DIR") or os.path.join(ROOT, "site", "data")
FEEDS = os.path.join(ROOT, ".cache", "gtfs", "feeds")
errors, notes = [], []


def check(ok, msg):
    if not ok:
        errors.append(msg)


def hm(sec):
    return f"{int(sec // 3600) % 24}:{int(sec % 3600 // 60):02d}"


def main():
    sch = json.load(open(os.path.join(DATA, "schedule.json")))
    routes = json.load(open(os.path.join(DATA, "routes.json")))["routes"]
    pats = sch["patterns"]
    n_nb = sum("nb" in p for p in pats)
    n_na = sum("na" in p for p in pats)
    check(n_nb > 50 and n_na > 50, f"pickup/drop-off restrictions are missing from the timetable (nb {n_nb}, na {n_na})")
    check(sum("w" in p for p in pats) > 50, "no stop dwell times (w) in the timetable: getting off a waiting bus will use its departure time")
    check(len(sch.get("through", [])) > 100, "no stay-aboard trip links (through) in the timetable")
    check(sum("h" in p for p in pats) > 100, "patterns carry no headsigns (h)")

    # longest trip anywhere
    longest = max((du, k) for k, v in sch["days"].items() if k in ("weekday", "saturday", "sunday") for _, _, du in v)
    check(longest[0] <= 16 * 3600, f"a trip lasts {longest[0] / 3600:.1f} h on {longest[1]}")

    ri = {r["id"]: i for i, r in enumerate(routes)}
    # Amtrak Cascades: Seattle times, no day-long trips
    a = ri.get("amtrak-amtrak-cascades")
    if a is not None:
        starts, long_trips = [], []
        for pi, s0, du in sch["days"]["weekday"]:
            p = pats[pi]
            if p["r"] != a:
                continue
            base = pats[p["b"]] if "b" in p else p
            if base["s"][0] == "amtrak-SEA":
                starts.append(s0)
            if base["s"][0] in ("amtrak-SEA", "amtrak-PDX") and base["s"][-1] in ("amtrak-SEA", "amtrak-PDX") and du > 4.5 * 3600:
                long_trips.append((hm(s0), du / 3600))
        check(starts and all(4 * 3600 <= s <= 23 * 3600 + 1800 for s in starts), f"Cascades leave Seattle at {[hm(s) for s in starts]}: wrong time zone?")
        check(not long_trips, f"Seattle-Portland Cascades trips over 4.5 h: {long_trips}")
        notes.append(f"Cascades from Seattle (weekday): {sorted(hm(s) for s in starts)}")

    # every route that runs on a sample day has its own trips, with its own identity
    trips_by_route = defaultdict(Counter)
    for k in ("weekday", "saturday", "sunday"):
        for pi, _, _ in sch["days"][k]:
            trips_by_route[pats[pi]["r"]][k] += 1
    missing = []
    for r in routes:
        i = ri[r["id"]]
        for k in ("weekday", "saturday", "sunday"):
            published = (r["sched"].get(k) or {}).get("trips", 0)
            if published and not trips_by_route[i][k]:
                missing.append((r["id"], k, published))
    check(not missing, f"routes advertise trips the timetable doesn't have under their id: {missing[:8]}")
    j11 = ri.get("jefferson-11")
    if j11 is not None:
        check(trips_by_route[j11]["weekday"] >= 30, f"Jefferson route 11 has {trips_by_route[j11]['weekday']} weekday trips in the timetable (40 advertised)")

    # routes that don't run on a sample day are still on the map and in the planner
    for slug in ("metro-982", "wta-98", "wta-14s"):
        check(slug in ri, f"{slug} (no service on the sample days, trips on other dates) is missing from the catalog")

    if "--feeds" in sys.argv:
        compare_with_feeds(sch, routes)

    for n in notes:
        print("  " + n)
    if errors:
        print("FAIL:")
        for e in errors:
            print("  - " + e)
        sys.exit(1)
    print("PASS: schedule release checks")


def compare_with_feeds(sch, routes):
    """A sample of trips read from the agency feeds against what the timetable file gives for them."""
    import pandas as pd
    z = os.path.join(FEEDS, "kcm.zip")
    if not os.path.exists(z):
        notes.append("no cached Metro feed: feed comparison skipped")
        return
    zf = zipfile.ZipFile(z)
    trips = pd.read_csv(zf.open("trips.txt"), dtype=str)
    st = pd.read_csv(zf.open("stop_times.txt"), dtype=str, usecols=["trip_id", "stop_id", "departure_time", "stop_sequence", "pickup_type"])
    cal = pd.read_csv(zf.open("calendar.txt"), dtype=str)
    day = sch["dates"]["weekday"]
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    import datetime as dt
    d = dt.date(int(day[:4]), int(day[4:6]), int(day[6:]))
    on = set(cal[(cal[wd[d.weekday()]] == "1") & (cal.start_date <= day) & (cal.end_date >= day)].service_id)
    rid_slug = {r["rt"][0]: r["id"] for r in routes if r["id"].startswith("metro-")}
    ri = {r["id"]: i for i, r in enumerate(routes)}
    by_start = defaultdict(list)
    pats = sch["patterns"]
    for pi, s0, du in sch["days"]["weekday"]:
        by_start[s0].append((pi, du))
    tr = trips[trips.service_id.isin(on)].sample(n=min(600, len(trips)), random_state=7)
    sec = lambda t: int(t.split(":")[0]) * 3600 + int(t.split(":")[1]) * 60 + int(t.split(":")[2])  # noqa: E731
    bad = tot = matched = 0
    worst = []
    st = st[st.trip_id.isin(set(tr.trip_id))].copy()
    st["seq"] = st.stop_sequence.astype(int)
    st = st.sort_values(["trip_id", "seq"])
    for tid, g in st.groupby("trip_id"):
        g = g[g.departure_time != ""]
        if len(g) < 3:
            continue
        t = [sec(x) for x in g.departure_time]
        ids = ["kcm-" + "".join(c if c.isalnum() else "-" for c in str(s)).strip("-") for s in g.stop_id]
        found = None
        for pi, du in by_start.get(t[0], ()):
            p = pats[pi]
            base = pats[p["b"]] if "b" in p else p
            if abs(du - (t[-1] - t[0])) <= 60 and set(ids) <= set(base["s"]):
                found = (pi, base)
                break
        if not found:
            continue
        matched += 1
        pi, base = found
        p = pats[pi]
        idx = {s: i for i, s in enumerate(base["s"])}
        du = t[-1] - t[0]
        for sid, ts in zip(ids, t):
            pred = t[0] + p["f"][idx[sid]] * du
            tot += 1
            if abs(pred - ts) > 90:
                bad += 1
                worst.append((round(abs(pred - ts)), tid, sid))
    notes.append(f"feed comparison: {matched} Metro trips matched, {tot} stop times compared, {bad} more than 90 s off")
    check(matched >= 100, f"only {matched} of the sampled Metro trips were found in the timetable file")
    check(tot and bad / tot <= 0.02, f"{bad} of {tot} stop times differ from Metro's feed by more than 90 s; worst {sorted(worst, reverse=True)[:3]}")


if __name__ == "__main__":
    main()
