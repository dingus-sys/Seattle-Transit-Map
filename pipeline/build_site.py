"""Assemble the web page from web/ into site/.

  site/index.html     full HTML document for GitHub Pages / Cloudflare Pages
                      (loads OpenFreeMap tiles live, falls back to bundled tiles)
  site/artifact.html  page body for the claude.ai artifact preview (bundled tiles only,
                      since the preview sandbox blocks outside map servers)
"""
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import json  # noqa: E402

from config import (CACHE, FEEDS, LIVE_FEEDS, OBA_AGENCIES, OBA_ALERTS, OBA_BASE, OBA_DEPARTURES,  # noqa: E402
                    OBA_REST_POSITIONS, OBA_STATUS, ROOT, SITE, WSF_API, oba_key, wsf_code)

MAPLIBRE_CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css"
KEY_PLACEHOLDER = "__OBA_API_KEY__"
WSF_PLACEHOLDER = "__WSF_ACCESS_CODE__"


def maplibre_css():
    path = os.path.join(CACHE, "vendor", "maplibre-gl.css")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(MAPLIBRE_CSS_URL, path)
    return open(path).read()


def main():
    web = os.path.join(ROOT, "web")
    page = open(os.path.join(web, "page.html")).read()
    css = open(os.path.join(web, "app.css")).read()
    js = open(os.path.join(web, "app.js")).read()
    # the geometry engine is its own script so the page can also start it as a background worker
    geom = open(os.path.join(web, "geom.js")).read()
    body = (page.replace("/*MAPLIBRE_CSS*/", maplibre_css())
                .replace("/*APP_CSS*/", css)
                .replace("/*GEOM_JS*/", geom)
                .replace("/*APP_JS*/", js))
    # The claude.ai preview can't reach outside servers, so only the website gets live data.
    artifact = body.replace("/*MODE*/", "bundled").replace("/*LIVE*/", "")
    # The API key never goes into the repository: index.html carries a placeholder that the
    # GitHub Pages workflow replaces with the OBA_API_KEY secret at deploy time. For local
    # testing, `build_site.py --with-key` writes the key from pipeline/local_secrets.json.
    key = oba_key() if "--with-key" in sys.argv else KEY_PLACEHOLDER
    wsf = (wsf_code() or "") if "--with-key" in sys.argv else WSF_PLACEHOLDER
    live = " window.ATLAS_LIVE = " + json.dumps({"key": key, "base": OBA_BASE, "status": OBA_STATUS, "agencies": OBA_AGENCIES,
                                                 "feeds": LIVE_FEEDS, "alerts": OBA_ALERTS, "rest": OBA_REST_POSITIONS,
                                                 "deps": OBA_DEPARTURES,
                                                 # stop ids read "<feed>-<the agency's own id>"; OneBusAway calls the
                                                 # same stop "<agency number>_<the agency's own id>"
                                                 "stopAgency": {f["key"]: f["default"] for f in FEEDS},
                                                 "wsf": {"base": WSF_API, "code": wsf}}) + ";"
    body = body.replace("/*LIVE*/", live)
    full = ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
            + body.replace("/*MODE*/", "auto").replace("\n<div id=\"map\"", "\n</head>\n<body>\n<div id=\"map\"", 1)
            + "</body>\n</html>\n")
    open(os.path.join(SITE, "artifact.html"), "w").write(artifact)
    open(os.path.join(SITE, "index.html"), "w").write(full)
    print(f"site/index.html {len(full)/1e3:.0f} KB, site/artifact.html {len(artifact)/1e3:.0f} KB")


if __name__ == "__main__":
    main()
