"""Rebuild everything: base map tiles, routes/stops, service areas, bundled network, web page.

    python3 pipeline/build_all.py            # full rebuild
    python3 pipeline/build_all.py --no-tiles # skip the base map (it rarely needs refreshing)

Downloads land in $TRANSIT_CACHE (default <repo>/.cache). Delete the cached GTFS folder
there to force a fresh schedule download.
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from config import CACHE  # noqa: E402

STEPS = ["build_basemap.py", "process_gtfs.py", "build_areas.py", "match_shapes.py", "build_graph.py", "tidy_junctions.py", "repair_network.py", "build_site.py"]


def run(step):
    print(f"\n== {step}", flush=True)
    subprocess.run([sys.executable, os.path.join(HERE, step)], check=True)


def main():
    args = set(sys.argv[1:])
    if "--fresh" in args:
        for d in ("gtfs", "ext"):
            shutil.rmtree(os.path.join(CACHE, d), ignore_errors=True)
    # process_gtfs tells Dial-a-Ride (DART) routes apart using the DART areas that build_areas
    # downloads, and build_areas needs process_gtfs's routes. From a fresh cache (the weekly
    # refresh) the areas don't exist yet on the first pass, so the DART routes would come out as
    # plain buses: run both once more after build_areas has fetched them.
    dart = os.path.join(CACHE, "ext", "dart_areas.geojson")
    had_dart = os.path.exists(dart)
    for step in STEPS:
        if step == "build_basemap.py" and "--no-tiles" in args:
            continue
        run(step)
        if step == "build_areas.py" and not had_dart and os.path.exists(dart):
            run("process_gtfs.py")
            run("build_areas.py")


if __name__ == "__main__":
    main()
