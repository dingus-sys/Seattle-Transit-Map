"""Shared settings for the build pipeline.

To change the map area, edit REGION and re-run `python3 pipeline/build_all.py`.
Everything downstream (routes, stops, the bundled network, the bundled base map)
is derived from it.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
CACHE = os.environ.get("TRANSIT_CACHE", os.path.join(ROOT, ".cache"))

# Detailed map area: Everett, Mukilteo and Marysville in the north; Tacoma, Lakewood, Puyallup
# and Spanaway, and on to Olympia, Lacey and Tumwater in the south; Kitsap (Bremerton,
# Bainbridge, Port Orchard, Gig Harbor) in the west; the Eastside out to Monroe and North Bend.
REGION = {
    "name": "Puget Sound",
    "west": -123.00,
    "south": 46.95,
    "east": -121.70,
    "north": 48.08,
}

# The Amtrak Cascades line runs on past the map's edges, so it (and its stations) is kept out to
# here: up to Mount Vernon in the north and Chehalis in the south. Nothing else is, so the buses
# and the rest of the map stop at REGION as before.
RAIL_REGION = {"west": -123.10, "south": 46.62, "east": -121.70, "north": 48.45}

# Wider, low-detail context ring for the zoomed-out view.
CONTEXT = {"west": -123.40, "south": 46.75, "east": -121.20, "north": 48.40}

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
    {"key": "it", "url": "https://its.rideralerts.com/InfoPoint/gtfs-zip.ashx",
     "fallback": "https://gtfs.sound.obaweb.org/prod/19_gtfs.zip",
     "agency": {"0": "19", "19": "19"}, "default": "19"},
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
# Vehicle status (schedule deviation: on time / late / early), polled one agency at a time
OBA_STATUS = "https://api.pugetsound.onebusaway.org/api/where/vehicles-for-agency"
# Real departures from a stop (what the agency now predicts, not the printed timetable),
# fetched for one stop at a time when a rider looks at it.
OBA_DEPARTURES = "https://api.pugetsound.onebusaway.org/api/where/arrivals-and-departures-for-stop"
# Agencies whose live positions aren't on OneBusAway but on their own open feed (no key needed).
# "agency" is the id their routes carry in routes.json ("rt": "19_<route id>").
LIVE_FEEDS = [
    {"agency": "19", "url": "https://its.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=VehiclePosition",  # Intercity Transit
     "alerts": "https://its.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=Alert"},
]
# Service alerts (detours, closed stops, canceled trips) per agency, as GTFS-realtime
OBA_ALERTS = "https://api.pugetsound.onebusaway.org/api/gtfs_realtime/alerts-for-agency"
# Agencies whose vehicles come from OneBusAway's REST feed instead of GTFS-realtime: Washington
# State Ferries' realtime feed leaves out which route a boat is on; the REST feed has it.
OBA_REST_POSITIONS = ["95"]
# Washington State Ferries' own API (vessel names, at dock / left dock, arrival estimates and
# ferry service bulletins). It needs a free WSDOT access code: the WSF_ACCESS_CODE repository
# secret, or "wsf_access_code" in pipeline/local_secrets.json. Without one, ferries still show
# live from OneBusAway, without the WSF bulletins.
WSF_API = "https://www.wsdot.wa.gov/ferries/api"

TILEJSON_URL = "https://tiles.openfreemap.org/planet"
FONTS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"


def wsf_code():
    code = os.environ.get("WSF_ACCESS_CODE", "").strip()
    if code:
        return code
    path = os.path.join(os.path.dirname(__file__), "local_secrets.json")
    if os.path.exists(path):
        import json
        return json.load(open(path)).get("wsf_access_code", "")
    return ""


def oba_key():
    key = os.environ.get("OBA_API_KEY", "").strip()
    if key:
        return key
    path = os.path.join(os.path.dirname(__file__), "local_secrets.json")
    if os.path.exists(path):
        import json
        return json.load(open(path)).get("oba_api_key", "")
    return ""
