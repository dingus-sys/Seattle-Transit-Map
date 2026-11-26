# Live-data proxy (Cloudflare Worker)

`live-proxy.js` keeps the OneBusAway key and the WSDOT access codes off the public page. The
page sends live-data requests to this Worker with `proxy` where a key would be; the Worker adds
the real key (a Worker secret), forwards the request and returns the answer. It forwards only the
API paths the map uses, and only for pages on the allowed sites (`ALLOWED_ORIGINS`, default
`https://dingus-sys.github.io` plus localhost:8765 for testing).

## Set up (Cloudflare dashboard)

1. Workers & Pages > Create > Start with Hello World. Name it `transit-proxy` and Deploy.
2. Edit code. Replace everything with the contents of `live-proxy.js`, then Deploy.
3. Settings > Variables and Secrets > Add, type **Secret**, for each:
   - `OBA_API_KEY`: the OneBusAway key
   - `WSF_KEY`: the WSDOT access code used for ferries (the GitHub secret `WSP_KEY`)
   - `WSDOT_KEY`: the WSDOT access code used for highway alerts
   One code can do both: with only `WSDOT_KEY` set, ferries use it too.
4. Copy the Worker's address (`https://transit-proxy.<your-subdomain>.workers.dev`).

## Point the site at it

Set `LIVE_PROXY` in `pipeline/config.py` (or the GitHub Actions variable `LIVE_PROXY`) to that
address. The next Pages build then writes no keys into the page at all, even with `--with-key`.
Empty `LIVE_PROXY` keeps the old behaviour (keys built into the page).

Check: `node tools/test_live_proxy.mjs` tests the Worker with a stand-in upstream.
