"""Shared settings for the build pipeline.

To change the map area, edit REGION and re-run `python3 pipeline/build_all.py`.
Everything downstream (routes, stops, the bundled network, the bundled base map)
is derived from it.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
CACHE = os.environ.get("TRANSIT_CACHE", "/root/build")

# Detailed map area: Lynnwood, Mill Creek and Monroe in the north; Federal Way in the south;
# the Eastside out to Issaquah, Sammamish and the Snoqualmie Valley (North Bend); Vashon.
REGION = {
    "name": "Seattle and King County",
    "west": -122.53,
    "south": 47.28,
    "east": -121.74,
    "north": 47.93,
}

# Wider, low-detail context ring for the zoomed-out view (Everett to Tacoma).
CONTEXT = {"west": -123.05, "south": 47.05, "east": -121.40, "north": 48.15}

# Base-map zoom levels: context ring up to CONTEXT_MAXZOOM, detail area up to DETAIL_MAXZOOM.
CONTEXT_MAXZOOM = 10
DETAIL_MAXZOOM = 14

# Schedule feeds, one per agency (the consolidated Puget Sound file ends in January 2027).
#   key     short id used to keep ids from different feeds apart
#   url     the agency's own published feed where one exists (see mobilitydatabase.org)
#   agency  maps the feed's agency_id to the OneBusAway agency id used for live data
#   default agency for routes without an agency_id
#   only    optional filter on route_long_name (Amtrak's feed is national)
FEEDS = [
    {"key": "kcm", "url": "https://metro.kingcounty.gov/GTFS/google_transit.zip",
     "agency": {"1": "1", "23": "23", "40": "40", "6289": "6289"}, "default": "1"},
    {"key": "st", "url": "https://www.soundtransit.org/GTFS-rail/40_gtfs.zip",
     "agency": {"40": "40"}, "default": "40"},
    {"key": "ct", "url": "https://www.communitytransit.org/docs/default-source/open-data/gtfs/current.zip",
     "agency": {"29": "29", "40": "40"}, "default": "29"},
    {"key": "pt", "url": "https://gtfs.sound.obaweb.org/prod/3_gtfs.zip",
     "agency": {"3": "3", "40": "40"}, "default": "3"},
    {"key": "et", "url": "https://everett.prod.mapstrat.com/current/google_transit.zip",
     "agency": {"1": "97"}, "default": "97"},
    {"key": "wsf", "url": "https://business.wsdot.wa.gov/Transit/csv_files/wsf/google_transit.zip",
     "agency": {"WSF": "95"}, "default": "95"},
    {"key": "kt", "url": "https://pride.kitsaptransit.com/gtfs/google_transit.zip",
     "fallback": "https://gtfs.sound.obaweb.org/prod/20_gtfs.zip",
     "agency": {"20": "20"}, "default": "20"},
    {"key": "mono", "url": "https://gtfs.sound.obaweb.org/prod/96_gtfs.zip",
     "agency": {"96": "96"}, "default": "96"},
    {"key": "amtrak", "url": "https://content.amtrak.com/content/gtfs/GTFS.zip",
     "agency": {"51": "51"}, "default": "51", "only": "Cascades"},
]

# Live vehicle positions (OneBusAway Puget Sound, GTFS-realtime). The key is read from
# the OBA_API_KEY environment variable or pipeline/local_secrets.json at build time and
# ends up in the published page, as it must for a browser to call the API directly.
OBA_BASE = "https://api.pugetsound.onebusaway.org/api/gtfs_realtime/vehicle-positions-for-agency"
OBA_AGENCIES = ["1", "40", "29", "23", "3", "97", "95", "20"]  # the Monorail publishes no positions

TILEJSON_URL = "https://tiles.openfreemap.org/planet"
FONTS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"


def oba_key():
    key = os.environ.get("OBA_API_KEY", "").strip()
    if key:
        return key
    path = os.path.join(os.path.dirname(__file__), "local_secrets.json")
    if os.path.exists(path):
        import json
        return json.load(open(path)).get("oba_api_key", "")
    return ""
