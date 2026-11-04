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

STEPS = ["build_basemap.py", "process_gtfs.py", "build_areas.py", "match_shapes.py", "build_graph.py", "tidy_junctions.py", "build_site.py"]


def main():
    args = set(sys.argv[1:])
    if "--fresh" in args:
        for d in ("gtfs", "ext"):
            shutil.rmtree(os.path.join(CACHE, d), ignore_errors=True)
    for step in STEPS:
        if step == "build_basemap.py" and "--no-tiles" in args:
            continue
        print(f"\n== {step}", flush=True)
        subprocess.run([sys.executable, os.path.join(HERE, step)], check=True)


if __name__ == "__main__":
    main()
