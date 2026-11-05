"""Assemble the web page from web/ into site/.

  site/index.html     the website (GitHub Pages): a small page that links app.js, app.css,
                      geom.js, ribbons.js and logos/ as separate files, so browsers cache each one and a
                      code change only re-downloads what changed. Loads OpenFreeMap tiles
                      live and falls back to the bundled tiles.
  site/artifact.html  one self-contained file for the claude.ai artifact preview (bundled
                      tiles only, since the preview sandbox blocks outside map servers)

Everything this writes is build output and is not committed: the Pages workflow runs this
script on every deploy.
"""
import base64
import hashlib
import json
import os
import shutil
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from config import (CACHE, FEEDS, LIVE_FEEDS, OBA_AGENCIES, OBA_ALERTS, OBA_BASE, OBA_DEPARTURES,  # noqa: E402
                    OBA_REST_POSITIONS, OBA_STATUS, ROOT, SITE, WSF_API, WSDOT_ALERTS, oba_key, wsf_code, wsdot_code)

MAPLIBRE_CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css"
KEY_PLACEHOLDER = "__OBA_API_KEY__"
WSF_PLACEHOLDER = "__WSF_ACCESS_CODE__"
WSDOT_PLACEHOLDER = "__WSDOT_ACCESS_CODE__"
LOGO_TYPES = {".svg": "image/svg+xml", ".png": "image/png"}
# fetched by the page as soon as it starts, so the browser can start downloading them
# while it is still loading the scripts
PRELOAD = ["data/network.json", "data/routes.json", "data/stops.json"]


def maplibre_css():
    path = os.path.join(CACHE, "vendor", "maplibre-gl.css")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(MAPLIBRE_CSS_URL, path)
    return open(path).read()


def version(data):
    """A short content hash, added to file URLs so browsers fetch a file again only when it changes."""
    return hashlib.sha1(data if isinstance(data, bytes) else data.encode()).hexdigest()[:10]


def sub(text, old, new):
    """Replace a placeholder in the page template, and fail loudly if the template lost it."""
    if old not in text:
        raise SystemExit(f"build_site: web/page.html no longer contains {old!r}")
    return text.replace(old, new)


def logo_files(web):
    """Agency and service logos in web/logos: (name, file name, bytes). Without the folder,
    route cards show agency names as text."""
    d = os.path.join(web, "logos")
    out = []
    if not os.path.isdir(d):
        return out
    for f in sorted(os.listdir(d)):
        name, ext = os.path.splitext(f)
        if ext in LOGO_TYPES:
            out.append((name, f, open(os.path.join(d, f), "rb").read()))
    return out


def logos_js(urls):
    return "window.ATLAS_LOGOS = " + json.dumps(urls, separators=(",", ":")) + ";"


def live_js(with_key):
    # The API key never goes into the repository: index.html carries a placeholder that the
    # GitHub Pages builds with --with-key and environment secrets; default builds use
    # placeholders. Local --with-key builds can also read pipeline/local_secrets.json.
    key = oba_key() if with_key else KEY_PLACEHOLDER
    wsf = (wsf_code() or "") if with_key else WSF_PLACEHOLDER
    wsdot = (wsdot_code() or "") if with_key else WSDOT_PLACEHOLDER
    return " window.ATLAS_LIVE = " + json.dumps({"key": key, "base": OBA_BASE, "status": OBA_STATUS, "agencies": OBA_AGENCIES,
                                                 "feeds": LIVE_FEEDS, "alerts": OBA_ALERTS, "rest": OBA_REST_POSITIONS,
                                                 "deps": OBA_DEPARTURES,
                                                 # stop ids read "<feed>-<the agency's own id>"; OneBusAway calls the
                                                 # same stop "<agency number>_<the agency's own id>"
                                                 "stopAgency": {f["key"]: f["default"] for f in FEEDS},
                                                 "wsf": {"base": WSF_API, "code": wsf},
                                                 "wsdot": {"alerts": WSDOT_ALERTS, "code": wsdot}}).replace("<", "\\u003c") + ";"


def build_artifact(page, css, js, geom, ribbons, logos):
    """One self-contained file: styles, scripts and logos inline (data: URIs)."""
    inline = {name: f"data:{LOGO_TYPES[os.path.splitext(f)[1]]};base64," + base64.b64encode(data).decode()
              for name, f, data in logos}
    body = sub(page, "/*MAPLIBRE_CSS*/", maplibre_css())
    body = sub(body, "/*APP_CSS*/", css)
    body = sub(body, "/*LOGOS*/", logos_js(inline))
    body = sub(body, "/*GEOM_JS*/", geom)
    body = sub(body, "/*RIBBONS_JS*/", ribbons)
    body = sub(body, "/*APP_JS*/", js)
    # The claude.ai preview can't reach outside servers, so only the website gets live data.
    return sub(sub(body, "/*MODE*/", "bundled"), "/*LIVE*/", "")


def build_website(page, css, js, geom, ribbons, logos, with_key):
    """index.html plus app.css, app.js, geom.js and logos/ beside it."""
    for name, text in (("app.css", css), ("app.js", js), ("geom.js", geom), ("ribbons.js", ribbons)):
        with open(os.path.join(SITE, name), "w") as output:
            output.write(text)
    logo_dir = os.path.join(SITE, "logos")
    shutil.rmtree(logo_dir, ignore_errors=True)
    os.makedirs(logo_dir)
    urls = {}
    for name, f, data in logos:
        open(os.path.join(logo_dir, f), "wb").write(data)
        urls[name] = f"logos/{f}?v={version(data)}"

    preload = "".join(f'<link rel="preload" href="{u}" as="fetch" crossorigin>\n' for u in PRELOAD)
    body = sub(page, "<style>/*MAPLIBRE_CSS*/</style>", f'{preload}<link rel="stylesheet" href="{MAPLIBRE_CSS_URL}">')
    body = sub(body, "<style>/*APP_CSS*/</style>", f'<link rel="stylesheet" href="app.css?v={version(css)}">')
    body = sub(body, "<script>/*LOGOS*/</script>", f"<script>{logos_js(urls)}</script>")
    # the geometry engine runs on the page and, from the same file, as a background worker
    body = sub(body, '<script id="geom-src">/*GEOM_JS*/</script>', f'<script id="geom-src" src="geom.js?v={version(geom)}"></script>')
    body = sub(body, '<script id="ribbons-src">/*RIBBONS_JS*/</script>', f'<script id="ribbons-src" src="ribbons.js?v={version(ribbons)}"></script>')
    body = sub(body, "<script>/*APP_JS*/</script>", f'<script src="app.js?v={version(js)}"></script>')
    body = sub(sub(body, "/*MODE*/", "auto"), "/*LIVE*/", live_js(with_key))
    body = sub(body, '\n<div id="map"', '\n</head>\n<body>\n<div id="map"')
    return ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
            + body + "</body>\n</html>\n")


def main():
    web = os.path.join(ROOT, "web")
    read = lambda f: open(os.path.join(web, f)).read()  # noqa: E731
    page, css, js, geom, ribbons = read("page.html"), read("app.css"), read("app.js"), read("geom.js"), read("ribbons.js")
    logos = logo_files(web)

    artifact = build_artifact(page, css, js, geom, ribbons, logos)
    full = build_website(page, css, js, geom, ribbons, logos, "--with-key" in sys.argv)
    open(os.path.join(SITE, "artifact.html"), "w").write(artifact)
    open(os.path.join(SITE, "index.html"), "w").write(full)
    print(f"site/index.html {len(full)/1e3:.0f} KB (+ app.js {len(js)/1e3:.0f} KB, app.css {len(css)/1e3:.0f} KB, "
          f"geom.js {len(geom)/1e3:.0f} KB, {len(logos)} logos), site/artifact.html {len(artifact)/1e3:.0f} KB")


if __name__ == "__main__":
    main()
