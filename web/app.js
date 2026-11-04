/* King County Transit Map — interactive map of Seattle-area transit.
 * Data: site/data/*.json (built by pipeline/). Base map: OpenFreeMap (live) or the bundled
 * tile archives in site/tiles/ where outside tile servers are blocked.
 *
 * Drawing model (after Seattle's printed Transit Network map): streets are drawn as service
 * corridors, not as one line per route. Every route of the same service type on a street
 * shares one line — green for frequent buses, blue for all-day buses, red for RapidRide,
 * navy for Link — and the route numbers ride along as stacked tags. A corridor line splits
 * only where its routes split. Each corridor is one continuous path with rounded corners;
 * where corridors share a street they sit side by side, keep their lanes through junctions,
 * and ease across when they must change sides. */
(() => {
  "use strict";

  const MODE = window.ATLAS_MODE || "auto"; // "auto": try live tiles first; "bundled": local only
  // live vehicle feed settings; a missing key (or the unfilled build placeholder) means timetable estimates only
  const LIVE = window.ATLAS_LIVE && window.ATLAS_LIVE.key && !/^__/.test(window.ATLAS_LIVE.key) ? window.ATLAS_LIVE : null;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("kctm:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("kctm:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

  // ---------------------------------------------------------------- service types
  // w = line width in "units"; tier = zoom band it appears in; inner = the line's center
  // treatment (white center for rail, dots for RapidRide, a glassy highlight for buses)
  const CAT = {
    link:      { group: "rail",  w: 3.0,  tier: 0, prio: 0,  inner: "solid" },
    link1:     { group: "rail",  w: 3.0,  tier: 0, prio: 0,  base: "link" },
    link2:     { group: "rail",  w: 3.0,  tier: 0, prio: 0.1, base: "link" },
    linkT:     { group: "rail",  w: 3.0,  tier: 0, prio: 0.2, base: "link" },
    sounder:   { group: "rail",  w: 2.5,  tier: 0, prio: 1,  inner: "ties" },
    streetcar: { group: "rapid", w: 2.2,  tier: 0, prio: 2,  inner: "solid" },
    monorail:  { group: "rapid", w: 2.2,  tier: 0, prio: 3,  inner: "solid" },
    rapidride: { group: "rapid", w: 2.7,  tier: 0, prio: 4,  inner: "dots" },
    swift:     { group: "rapid", w: 2.5,  tier: 0, prio: 5,  inner: "dots" },
    frequent:  { group: "bus",   w: 2.35, tier: 1, prio: 6,  inner: "glass" },
    local:     { group: "bus",   w: 1.75, tier: 2, prio: 7,  inner: "glass" },
    peak:      { group: "bus",   w: 1.05, tier: 2, prio: 8 },
    shuttle:   { group: "bus",   w: 1.7,  tier: 2, prio: 9,  inner: "glass" },
    dart:      { group: "bus",   w: 1.35, tier: 2, prio: 10, dash: true },
    watertaxi: { group: "water", w: 1.9,  tier: 0, prio: 11, dash: true },
    ferry:     { group: "water", w: 1.9,  tier: 0, prio: 12, dash: true },
  };
  const VKEY = (cat) => (cat === "amtrak" ? "sounder" : cat); // Amtrak shares Sounder's tracks and line
  // a route's line on the map: its service type, except that each Link line has its own color
  const dkey = (r) => (r.cat === "link" ? (r.label === "1" ? "link1" : r.label === "T" ? "linkT" : "link2") : VKEY(r.cat));
  const CAT_NAME = {
    link: "Link light rail", sounder: "Sounder train", amtrak: "Amtrak Cascades", streetcar: "Streetcar",
    monorail: "Monorail", rapidride: "RapidRide", swift: "Swift BRT", frequent: "Frequent bus",
    local: "All-day bus", peak: "Rush hour & limited", shuttle: "Link shuttle bus",
    dart: "Dial-a-Ride (DART)", watertaxi: "Water Taxi", ferry: "Ferry",
  };
  const LINE = {
    light: {
      link: "#1d3f86", link1: "#28813f", link2: "#0072a8", linkT: "#e57a00", sounder: "#4b5563", streetcar: "#e8772e", monorail: "#8a8f98", rapidride: "#d0213b",
      swift: "#1f6fe0", frequent: "#0a9b7b", local: "#3f8ee0", peak: "#6f9a0c", shuttle: "#e3a118",
      dart: "#c0508a", watertaxi: "#1690ad", ferry: "#3d6fa8",
    },
    dark: {
      link: "#86a8f2", link1: "#4cc46a", link2: "#4ab3e8", linkT: "#ffa94d", sounder: "#a3acb9", streetcar: "#ff9450", monorail: "#b5bac2", rapidride: "#ff5468",
      swift: "#5b9bff", frequent: "#2fd3a6", local: "#6eaef5", peak: "#b8e04a", shuttle: "#ffc44d",
      dart: "#ea7ab5", watertaxi: "#45c1e3", ferry: "#7aa6dc",
    },
  };
  const FLEX = { light: "#8a3cc0", dark: "#c47ef0" }; // Metro Flex zones

  const LAYER_GROUPS = [
    { title: "Trains", items: [
      { key: "link", cats: ["link"], name: "Link light rail", desc: "1 Line, 2 Line and Tacoma's T Line", on: true },
      { key: "rail", cats: ["sounder", "amtrak"], name: "Sounder & Amtrak", desc: "From King Street Station", on: true },
      { key: "streetcar", cats: ["streetcar"], name: "Streetcar", desc: "South Lake Union and First Hill", on: true },
      { key: "monorail", cats: ["monorail"], name: "Monorail", desc: "Westlake Center to Seattle Center", on: true },
    ] },
    { title: "Buses", items: [
      { key: "rapid", cats: ["rapidride", "swift"], name: "RapidRide & Swift", desc: "Limited stops, every 10 min or better", on: true },
      { key: "frequent", cats: ["frequent"], name: "Frequent", desc: "Every 15 min or better, midday", on: true },
      { key: "local", cats: ["local"], name: "All day", desc: "Every 20 to 60 min", on: true },
      { key: "peak", cats: ["peak", "shuttle"], name: "Rush hour & limited", desc: "Commute, school and part-day trips", on: false },
    ] },
    { title: "On the water", items: [
      { key: "water", cats: ["watertaxi", "ferry"], name: "Water Taxi & ferries", desc: "King County, WSF and Kitsap", on: true },
    ] },
    { title: "On demand", items: [
      { key: "dart", cats: ["dart"], name: "Dial-a-Ride (DART)", desc: "Can leave its route to pick you up", on: true, area: "dart" },
      { key: "flex", cats: [], name: "Metro Flex zones", desc: "Book a ride inside the zone", on: true, area: "flex" },
      { key: "access", cats: [], name: "Access paratransit", desc: "About ¾ mile around all-day routes", on: false, area: "access" },
    ] },
    { title: "Map", items: [
      { key: "live", cats: [], name: "Vehicles", desc: "Buses, trains and ferries on the move", on: true, area: "live" },
      { key: "stops", cats: [], name: "Bus stops", desc: "Appear as you zoom in", on: true, area: "stops" },
    ] },
  ];
  const LAYERS = LAYER_GROUPS.flatMap((g) => g.items);
  // Display settings (bottom of the Layers page), remembered per viewer.
  //   busDetail  when bus lines appear as you zoom out: frequent buses from the 2nd zoom, all-day from the 3rd
  //   tags       how many route-number tags: gap between repeats, spacing along long streets, and the zoom
  //              where bus tags start
  //   thickness  line width multiplier
  const SETTINGS_DEFAULT = { busDetail: "more", tags: "normal", thickness: "normal" };
  const BUS_TIERS = { less: [0, 10.2, 12.0], normal: [0, 0, 10.0], more: [0, 0, 0] };
  // gap: same tag repeating; every: spacing along long streets; any: between any two tags (px,
  // grows when zoomed out, see tagSpacing); busZ: zoom where bus tags start
  const TAG_DENSITY = { fewer: { gap: 840, every: 1800, any: 140, busZ: 11.5 }, normal: { gap: 560, every: 1200, any: 88, busZ: 10.0 },
    more: { gap: 360, every: 760, any: 52, busZ: 9.4 } };
  const tagSpacing = (td, z) => ({ ...td, any: td.any * (z < 11 ? 1.25 : 1) });
  const THICK = { thin: 0.8, normal: 1, bold: 1.25 };
  const settings = { ...SETTINGS_DEFAULT };
  {
    const saved = store.get("settings", {}) || {};
    if (BUS_TIERS[saved.busDetail]) settings.busDetail = saved.busDetail;
    if (TAG_DENSITY[saved.tags]) settings.tags = saved.tags;
    if (THICK[saved.thickness]) settings.thickness = saved.thickness;
  }
  const GAP = 0; // lines sharing a street touch, as one ribbon (the white outline goes around the bundle)

  // Line unit (px) by zoom, and the widest a set of side-by-side corridors may get (px).
  const UNIT = [[9, 0.8], [10, 0.92], [11, 1.08], [12, 1.3], [13, 1.6], [14, 2.0], [15, 2.4], [16, 2.8], [17, 3.2], [18, 3.6], [19, 4.0]];
  const CAP_PX = [[9, 8], [10, 9], [11, 12], [12, 15], [13, 19], [14, 25], [15, 32], [16, 42], [17, 54], [18, 70], [19, 90]];
  const interp = (tbl, z) => {
    if (z <= tbl[0][0]) return tbl[0][1];
    for (let i = 1; i < tbl.length; i++) {
      if (z <= tbl[i][0]) { const [z0, v0] = tbl[i - 1], [z1, v1] = tbl[i]; return v0 + (v1 - v0) * (z - z0) / (z1 - z0); }
    }
    return tbl[tbl.length - 1][1];
  };

  // Local flat coordinates in meters around Seattle, shared with the geometry engine (web/geom.js)
  const { LAT0, LON0, KX, KY, MPP0, toM, cumLen } = KCTMGeom;
  // line units (feature property) -> pixels (times k). Each feature carries zu, the pixels per
  // unit at zoom 0 of the layout it came from, so its width grows and shrinks exactly with its
  // lanes' spacing until the next layout (which follows the zoom closely) replaces it: lines
  // that touch keep touching while you zoom.
  const px = (prop, k = 1) => ["interpolate", ["exponential", 2], ["zoom"],
    0, ["*", ["get", prop], ["get", "zu"], k], 24, ["*", ["get", prop], ["get", "zu"], k * 2 ** 24]];
  // A route's strand, a hair narrower than its lane once you're zoomed in, so a fine line of the
  // background shows between routes sharing a street (about a pixel; never more than a third of
  // a thin strand). Zoomed out the strands touch.
  const pxStrand = (prop) => ["interpolate", ["exponential", 2], ["zoom"],
    ...[0, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24].flatMap((z) => {
      const b = ["*", ["get", prop], ["get", "zu"], 2 ** z];
      const g = z <= 12 || z >= 24 ? 0 : (z === 13 ? 0.55 : 1) * (0.85 + 0.14 * interp(UNIT, z));
      return [z, g ? ["max", ["*", b, 0.7], ["-", b, g]] : b];
    })];

  // ---------------------------------------------------------------- base map palette
  const BASE = {
    light: {
      land: "#f2f2ef", water: "#a9d3f2", waterLine: "#8fc3ea", waterLabel: "#3c78b4", park: "#d6ebc6", wood: "#dcedcf",
      civic: "#ece7f1", industrial: "#ebe9e6", minor: "#ffffff", minorCase: "#e1e0dc", major: "#ffffff",
      majorCase: "#d5d3cf", motorway: "#f7f7f5", motorwayCase: "#c9c8c4", rail: "#cfcfcb", runway: "#e1e1dd",
      label: "#6e6e73", halo: "#f2f2ef", place: "#3a3a3c", mask: "#f2f2ef",
      stationFill: "#ffffff", stationStroke: "#3a3a3c", stopFill: "#ffffff", stopStroke: "#8e8e93",
      casing: "#f8f8f6", shadow: "rgba(20, 28, 48, 0.24)", shine: "#ffffff",
    },
    dark: {
      land: "#1c1c1e", water: "#0f2a44", waterLine: "#16395a", waterLabel: "#7aa7d1", park: "#1c3122", wood: "#1d2f22",
      civic: "#24232a", industrial: "#222224", minor: "#2c2c2e", minorCase: "#232325", major: "#3a3a3c",
      majorCase: "#2a2a2c", motorway: "#48484a", motorwayCase: "#2e2e30", rail: "#3a3a3c", runway: "#2a2a2c",
      label: "#98989d", halo: "#1c1c1e", place: "#e5e5ea", mask: "#1c1c1e",
      stationFill: "#1c1c1e", stationStroke: "#e5e5ea", stopFill: "#1c1c1e", stopStroke: "#98989d",
      casing: "#1c1c1e", shadow: "rgba(0, 0, 0, 0.55)", shine: "#ffffff",
    },
  };

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const themeName = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return t ? (t === "dark" ? "dark" : "light") : (mq.matches ? "dark" : "light");
  };

  // ---------------------------------------------------------------- state
  let ROUTES = [], RBY = {}, NET = null, STOPS = null, AREAS = null, META = null, STOPNAMES = {};
  let LINES = [], LINEIDX = {};
  let stopIndex = {};
  let map, theme = themeName();
  const enabled = new Set();
  const savedLayers = store.get("layers2", null);
  LAYERS.forEach((l) => { if (savedLayers ? savedLayers.includes(l.key) : l.on) enabled.add(l.key); });
  let selected = null;

  const enabledCat = (cat) => LAYERS.some((l) => l.cats.includes(cat) && enabled.has(l.key));
  const keyColor = (key, th = theme) => LINE[th][key] || LINE[th].local;
  const tagColor = (r, th = theme) => LINE[th][dkey(r)] || LINE[th].local;
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const tagText = (r, th = theme) => (lum(tagColor(r, th)) > 0.36 ? "#1d1d1f" : "#ffffff");
  const isRound = (r) => r.cat === "link";
  const shortLabel = (r) => {
    if (r.cat === "watertaxi") return /Vashon/.test(r.short) ? "Vashon Water Taxi" : "Water Taxi";
    if (r.cat === "ferry") {
      const ends = r.short.split(" – ").filter((e) => !/^(Seattle|Fauntleroy)$/.test(e)).map((e) => e.replace(" Island", ""));
      return ends.join("–") + (r.agencyShort === "WSF" ? "" : " fast ferry");
    }
    if (r.cat === "swift") return "Swift";
    if (r.cat === "amtrak") return "Amtrak";
    if (r.cat === "sounder") return `Sounder ${r.label}`;
    if (r.cat === "shuttle") return "Shuttle";
    if (r.cat === "monorail") return "Monorail";
    if (r.label === "Easy Loop") return "Loop";
    return r.label;
  };
  const badgeHTML = (r, size = "") => `<span class="badge${isRound(r) ? " round" : ""}${size ? " " + size : ""}" style="background:${tagColor(r)};color:${tagText(r)}" aria-hidden="true">${esc(shortLabel(r))}</span>`;
  const freqText = (r) => {
    const w = r.sched.weekday;
    if (!w) return "Weekends";
    if (w.mid_n >= 3) return `${w.mid} min`;
    if (w.am_n || w.pm_n) return "Rush hour";
    return `${w.trips} trips`;
  };
  const routeTitle = (r) => {
    if (r.cat === "rapidride") return `RapidRide ${r.label} Line`;
    if (r.cat === "link") return `${r.label} Line`;
    if (r.cat === "sounder") return `Sounder ${r.label} Line`;
    if (r.cat === "ferry" || r.cat === "watertaxi") return r.short.replace(/^Water Taxi: /, "");
    if (/^\d/.test(r.short)) return `Route ${r.short}`;
    return r.short;
  };
  const tagOrder = (a, b) => (CAT[dkey(a)].prio - CAT[dkey(b)].prio) || (a._rank - b._rank);

  // ---------------------------------------------------------------- bundled tile archives
  let MANIFEST = null;
  const archives = {};
  function b64ToBytes(s) {
    s = s.trim();
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function loadArchive(name) {
    if (!archives[name]) {
      archives[name] = fetch(`tiles/${name}.txt`).then((r) => {
        if (!r.ok) throw new Error(`tiles/${name}.txt: ${r.status}`);
        return r.text();
      }).then((txt) => {
        const buf = b64ToBytes(txt).buffer;
        const n = new DataView(buf).getUint32(0, true);
        const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
        return { index, buf, base: 4 + n };
      });
    }
    return archives[name];
  }
  async function gunzip(bytes) {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(ds).arrayBuffer();
  }
  function registerProtocols() {
    maplibregl.addProtocol("atlas", async (params) => {
      const m = params.url.match(/atlas:\/\/(\d+)\/(\d+)\/(\d+)/);
      if (!m || !MANIFEST) return { data: new ArrayBuffer(0) };
      const [z, x, y] = m.slice(1).map(Number);
      const B = MANIFEST.blocks;
      const name = !B || z < B.fromZoom ? "base" : `d-${(x << (14 - z)) >> B.shift}-${(y << (14 - z)) >> B.shift}`;
      if (!MANIFEST.archives[name]) return { data: new ArrayBuffer(0) };
      const a = await loadArchive(name);
      const ent = a.index[`${z}/${x}/${y}`];
      if (!ent) return { data: new ArrayBuffer(0) };
      return { data: await gunzip(new Uint8Array(a.buf, a.base + ent[0], ent[1])) };
    });
    const FONTS = { "Noto Sans Regular": "regular", "Noto Sans Bold": "bold", "Noto Sans Italic": "italic" };
    let glyphs = null;
    maplibregl.addProtocol("atlasfont", async (params) => {
      const m = params.url.match(/atlasfont:\/\/([^/]+)\/(\d+-\d+)/);
      const stack = m ? decodeURIComponent(m[1]).split(",")[0].trim() : "";
      const slug = FONTS[stack] || "regular";
      try {
        glyphs = glyphs || fetch("fonts/glyphs.json").then((r) => r.json());
        const b64 = (await glyphs)[`${slug}/${m[2]}`];
        if (!b64) return { data: new ArrayBuffer(0) };
        const bytes = b64ToBytes(b64);
        return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      } catch { return { data: new ArrayBuffer(0) }; }
    });
  }
  async function liveTiles() {
    if (MODE === "bundled") return null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3500);
      const r = await fetch("https://tiles.openfreemap.org/planet", { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const tj = await r.json();
      return tj.tiles && tj.tiles.length ? tj : null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- base style
  const F_REG = ["Noto Sans Regular"], F_BOLD = ["Noto Sans Bold"], F_IT = ["Noto Sans Italic"];
  function baseLayers(P) {
    const road = (id, classes, minzoom, widths, color, extra) => ({
      id, type: "line", source: "base", "source-layer": "transportation", minzoom,
      filter: ["all", ["in", ["get", "class"], ["literal", classes]], ["!=", ["get", "brunnel"], "tunnel"], ...(extra ? [extra] : [])],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], ...widths] },
    });
    const svc = ["any", ["!=", ["get", "class"], "service"], [">=", ["zoom"], 15]];
    return [
      { id: "land", type: "background", paint: { "background-color": P.land } },
      { id: "wood", type: "fill", source: "base", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "grass"]]],
        paint: { "fill-color": P.wood, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 13, 0.85] } },
      { id: "civic", type: "fill", source: "base", "source-layer": "landuse", minzoom: 11,
        filter: ["in", ["get", "class"], ["literal", ["university", "college", "hospital", "school", "stadium", "zoo"]]],
        paint: { "fill-color": P.civic } },
      { id: "industrial", type: "fill", source: "base", "source-layer": "landuse", minzoom: 11,
        filter: ["in", ["get", "class"], ["literal", ["industrial", "railway", "military"]]], paint: { "fill-color": P.industrial } },
      { id: "park", type: "fill", source: "base", "source-layer": "park", paint: { "fill-color": P.park } },
      { id: "cemetery", type: "fill", source: "base", "source-layer": "landuse", filter: ["==", ["get", "class"], "cemetery"], paint: { "fill-color": P.park } },
      { id: "water", type: "fill", source: "base", "source-layer": "water", filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "fill-color": P.water } },
      { id: "waterway", type: "line", source: "base", "source-layer": "waterway", minzoom: 11,
        paint: { "line-color": P.waterLine, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 16, 2.5] } },
      { id: "runway", type: "line", source: "base", "source-layer": "aeroway", filter: ["==", ["get", "class"], "runway"],
        paint: { "line-color": P.runway, "line-width": ["interpolate", ["exponential", 1.8], ["zoom"], 10, 2, 16, 40] } },
      road("road-minor-case", ["minor", "service"], 13.5, [13.5, 1.6, 16, 7, 18, 20], P.minorCase, svc),
      road("road-major-case", ["primary", "secondary", "tertiary", "trunk"], 10, [10, 1.2, 13, 2.6, 16, 11, 18, 28], P.majorCase),
      road("road-motorway-case", ["motorway"], 8, [8, 1, 12, 2.4, 16, 12, 18, 30], P.motorwayCase),
      road("road-minor", ["minor", "service"], 13.5, [13.5, 0.8, 16, 5.2, 18, 17], P.minor, svc),
      road("road-major", ["primary", "secondary", "tertiary", "trunk"], 10, [10, 0.6, 13, 1.6, 16, 8.5, 18, 24], P.major),
      road("road-motorway", ["motorway"], 8, [8, 0.6, 12, 1.4, 16, 9, 18, 25], P.motorway),
      { id: "railway", type: "line", source: "base", "source-layer": "transportation", minzoom: 12,
        filter: ["all", ["==", ["get", "class"], "rail"], ["!=", ["get", "brunnel"], "tunnel"]],
        paint: { "line-color": P.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 16, 1.6], "line-dasharray": [3, 2] } },
      { id: "water-name", type: "symbol", source: "base", "source-layer": "water_name",
        layout: { "text-field": ["get", "name"], "text-font": F_IT, "text-size": ["interpolate", ["linear"], ["zoom"], 9, 11, 14, 14],
          "text-letter-spacing": 0.06, "text-max-width": 7 },
        paint: { "text-color": P.waterLabel, "text-halo-color": P.water, "text-halo-width": 1 } },
      { id: "street-name", type: "symbol", source: "base", "source-layer": "transportation_name", minzoom: 13,
        filter: ["any", ["in", ["get", "class"], ["literal", ["primary", "secondary", "trunk"]]], [">=", ["zoom"], 15]],
        layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-font": F_REG,
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 12.5], "symbol-spacing": 420, "text-padding": 6 },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.4 } },
      { id: "place-hood", type: "symbol", source: "base", "source-layer": "place", minzoom: 11.5,
        filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter"]]],
        layout: { "text-field": ["get", "name"], "text-font": F_BOLD, "text-transform": "uppercase", "text-letter-spacing": 0.1,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 9.5, 16, 12], "text-max-width": 8, "text-padding": 8 },
        paint: { "text-color": P.label, "text-opacity": 0.7, "text-halo-color": P.halo, "text-halo-width": 1.4 } },
    ];
  }

  // ---------------------------------------------------------------- transit layers
  // Each service group draws, bottom to top: a soft drop shadow, a casing that separates
  // neighboring lines, the colored body, and the center treatment (glass highlight,
  // white rail center, RapidRide dots or railroad ties).
  // Visual hierarchy: rush-hour lines recede, all-day lines are a touch softer, so the frequent
  // network, RapidRide and trains read first in busy places like downtown.
  const LINE_OP = 1;
  const SOFT = { peak: 0.6, local: 0.88, dart: 0.85 };
  const mixHex = (a, b, t) => { // a toward b by (1 - t)
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return "#" + pa.map((v, i) => Math.round(v * t + pb[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
  };
  const netColors = (th) => Object.fromEntries(Object.entries(LINE[th]).map(([k, c]) =>
    [k, SOFT[k] && /^#[0-9a-f]{6}$/i.test(c) ? mixHex(c, BASE[th].land, SOFT[k]) : c]));
  const HOVER_SLOTS = ["hover", "hover2"];
  function transitLayers(P) {
    const L = [];
    const inner = (id, src, filter, paint, layout = {}) => L.push({ id, type: "line", source: src, filter,
      layout: { "line-join": "round", ...layout }, paint });
    // Street lines (buses, RapidRide, streetcars) are one stack and trains another on top of it,
    // each with its own casing, so a train line running over a street line (Link under 3rd
    // Avenue) stays a clean line of its own.
    for (const stack of [["water", "bus", "rapid"], ["rail"]]) {
      for (const g of stack) {
        if (g === "water") continue;
        L.push({ id: `shadow-${g}`, type: "line", source: "net", filter: ["all", ["==", ["get", "g"], g], [">", ["get", "sh"], 0]], minzoom: 11,
          layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "s"] },
          paint: { "line-color": P.shadow, "line-width": px("sh"), "line-blur": 3, "line-translate": [0, 1.6] } });
      }
      for (const g of stack) {
        if (g === "water") continue;
        L.push({ id: `case-${g}`, type: "line", source: "net", filter: ["==", ["get", "g"], g],
          layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "s"] },
          paint: { "line-color": P.casing, "line-width": px("cm") } });
      }
      for (const g of stack) {
        const f = ["==", ["get", "g"], g];
        L.push({ id: `line-${g}`, type: "line", source: "net", filter: ["all", f, ["==", ["get", "d"], 0]],
          layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "s"] },
          paint: { "line-color": ["get", "c"], "line-width": pxStrand("wm"), "line-opacity": LINE_OP } });
        L.push({ id: `dash-${g}`, type: "line", source: "net", filter: ["all", f, ["==", ["get", "d"], 1]],
          layout: { "line-join": "round" },
          paint: { "line-color": ["get", "c"], "line-width": px("wm"), "line-dasharray": [2.2, 1.3], "line-opacity": LINE_OP } });
        inner(`glass-${g}`, "net", ["all", f, ["==", ["get", "h"], 1]],
          { "line-color": P.shine, "line-opacity": 0.38, "line-width": px("hm"), "line-blur": 0.6 }, { "line-cap": "round" });
        inner(`center-${g}`, "net", ["all", f, ["==", ["get", "h"], 2]],
          { "line-color": P.shine, "line-opacity": 0.92, "line-width": px("hm") }, { "line-cap": "round" });
        inner(`dots-${g}`, "net", ["all", f, ["==", ["get", "h"], 3]],
          { "line-color": P.shine, "line-opacity": 0.95, "line-width": px("hm"), "line-dasharray": [0.2, 2.4] }, { "line-cap": "round" });
        inner(`ties-${g}`, "net", ["all", f, ["==", ["get", "h"], 4]],
          { "line-color": P.casing, "line-width": px("hm"), "line-dasharray": [1.2, 1.6] });
      }
    }
    // hovered line: drawn again, bolder, on top; nothing else changes. Two of them, so one route
    // can fade out while the next one swells in.
    for (const sl of HOVER_SLOTS) {
      L.push({ id: `${sl}-case`, type: "line", source: sl, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.casing, "line-width": px("cm", 1.6), "line-opacity": 0 } });
      L.push({ id: `${sl}-line`, type: "line", source: sl, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "c"], "line-width": px("wm", 1.65), "line-opacity": 0 } });
    }
    // selected route, drawn again on top
    L.push({ id: "sel-glow", type: "line", source: "sel", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-opacity": 0.28, "line-blur": 4, "line-width": px("gm") } });
    L.push({ id: "sel-case", type: "line", source: "sel", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.casing, "line-width": px("cm") } });
    L.push({ id: "sel-line", type: "line", source: "sel", filter: ["==", ["get", "d"], 0], layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-width": px("wm") } });
    L.push({ id: "sel-dash", type: "line", source: "sel", filter: ["==", ["get", "d"], 1], layout: { "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-width": px("wm"), "line-dasharray": [2.2, 1.3] } });
    inner("sel-shine", "sel", ["==", ["get", "d"], 0], { "line-color": P.shine, "line-opacity": 0.45, "line-width": px("hm"), "line-blur": 0.6 }, { "line-cap": "round" });
    // one-way arrows: on every one-way stretch when zoomed in, and along the selected route
    const arrowLayer = (id, src, minzoom, spacing, size) => L.push({ id, type: "symbol", source: src, minzoom, filter: ["!=", ["get", "ar"], 0],
      layout: { "symbol-placement": "line", "symbol-spacing": spacing, "icon-image": ["concat", "arr:", ["get", "c"]],
        "icon-rotate": ["case", ["<", ["get", "ar"], 0], 180, 0], "icon-rotation-alignment": "map", "icon-keep-upright": false,
        "icon-allow-overlap": true, "icon-ignore-placement": true,
        "icon-size": size || ["interpolate", ["linear"], ["zoom"], 11, 0.6, 14, 0.8, 17, 1.05] } });
    // One-way stretches (a route that runs on different streets in each direction) always show
    // which way they go once you're zoomed in; the line in focus shows them from further out.
    arrowLayer("arrows", "net", 13.2, ["interpolate", ["linear"], ["zoom"], 13.2, 150, 15, 190, 17, 240],
      ["interpolate", ["linear"], ["zoom"], 13.2, 0.55, 15, 0.72, 17, 0.95]);
    for (const sl of HOVER_SLOTS) arrowLayer(`${sl}-arrows`, sl, 11, ["interpolate", ["linear"], ["zoom"], 11, 90, 15, 120, 17, 170]);
    arrowLayer("sel-arrows", "sel", 10.5, ["interpolate", ["linear"], ["zoom"], 11, 90, 15, 120, 17, 170]);
    // network lines fade smoothly when another line is in focus
    for (const l of L) if (l.source === "net" && l.type === "line") l.paint["line-opacity-transition"] = { duration: 260 };
    return L;
  }
  function areaLayers(P) {
    const acc = theme === "dark" ? "#bf9cf5" : "#7b5cc4";
    return [
      { id: "mask", type: "fill", source: "mask", paint: { "fill-color": P.mask, "fill-opacity": 0.55 } },
      { id: "access-fill", type: "fill", source: "access", paint: { "fill-color": acc, "fill-opacity": 0.08 } },
      { id: "access-line", type: "line", source: "access", paint: { "line-color": acc, "line-width": 1.4, "line-dasharray": [3, 2], "line-opacity": 0.8 } },
      { id: "dart-fill", type: "fill", source: "dart", paint: { "fill-color": LINE[theme].dart, "fill-opacity": 0.1 } },
      { id: "dart-line", type: "line", source: "dart", paint: { "line-color": LINE[theme].dart, "line-width": 1.2, "line-dasharray": [2, 2] } },
      { id: "flex-fill", type: "fill", source: "flex", paint: { "fill-color": FLEX[theme], "fill-opacity": theme === "dark" ? 0.12 : 0.09 } },
      { id: "flex-line", type: "line", source: "flex", paint: { "line-color": FLEX[theme], "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 2.6] } },
    ];
  }
  const VEH_SIZE = ["interpolate", ["linear"], ["zoom"], 9, 0.34, 11, 0.44, 12.5, 0.58, 14, 0.78, 15.5, 0.95, 18, 1.08];
  // what a vehicle is, for its badge
  const vehKind = (r) => (["link", "sounder", "amtrak"].includes(r.cat) ? "rail" : ["streetcar", "monorail"].includes(r.cat) ? "tram"
    : ["ferry", "watertaxi"].includes(r.cat) ? "boat" : "bus");
  // ---------------------------------------------------------------- places and highway signs
  // So you can find your way: parks, schools and colleges, museums, the zoo, hospitals, stadiums
  // and sights, each with a small symbol, more of them as you zoom in (the most notable first);
  // and the highway numbers, now and then along each freeway, for anyone who isn't from here.
  const POI_KIND = {
    zoo: "zoo", aquarium: "zoo", museum: "museum", art_gallery: "museum", stadium: "stadium", sports_centre: "stadium",
    college: "school", university: "school", school: "school", kindergarten: "school", library: "library",
    hospital: "hospital", park: "park", garden: "park", nature_reserve: "park", attraction: "sight", viewpoint: "sight",
    theatre: "sight", castle: "sight", monument: "sight", town_hall: "civic", courthouse: "civic", ferry_terminal: "ferry",
  };
  const POI_COLOR = { park: "#3f8f43", school: "#a5672a", museum: "#8a4fb5", zoo: "#2f8f6b", hospital: "#d0213b", stadium: "#3c6fb5",
    library: "#7a5a2f", sight: "#c2571a", civic: "#5b6475", ferry: "#3c78b4" };
  const POI_COLOR_D = { park: "#7fcf7f", school: "#e0a462", museum: "#c89af0", zoo: "#68d3a6", hospital: "#ff6b7f", stadium: "#7fa9ef",
    library: "#d0ac74", sight: "#f39a5c", civic: "#aab3c4", ferry: "#7aa7d1" };
  function poiLayers(P) {
    const dark = theme === "dark", col = dark ? POI_COLOR_D : POI_COLOR;
    const kind = ["match", ["get", "subclass"], ...Object.entries(POI_KIND).flat(), ["match", ["get", "class"], ...Object.entries(POI_KIND).flat(), ""]];
    const color = ["match", kind, ...Object.entries(col).flat(), P.label];
    const rank = ["coalesce", ["get", "rank"], 30];
    return [
      { id: "poi", type: "symbol", source: "base", "source-layer": "poi", minzoom: 13,
        // the busier it is around, the fewer: notable places from 13, the rest as you zoom in
        filter: ["all", ["!=", kind, ""], ["has", "name"],
          ["any", [">=", ["zoom"], 16], ["all", [">=", ["zoom"], 15], ["<=", rank, 14]], ["all", [">=", ["zoom"], 14], ["<=", rank, 6]], ["<=", rank, 3]]],
        layout: { "icon-image": ["concat", "poi:", kind, ":", dark ? "d" : "l"], "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.85, 17, 1],
          "text-field": ["get", "name"], "text-font": F_REG, "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10.5, 17, 12],
          "text-anchor": "left", "text-offset": [0.95, 0], "text-max-width": 8, "symbol-sort-key": rank, "text-padding": 4, "icon-padding": 3 },
        paint: { "text-color": color, "text-halo-color": P.halo, "text-halo-width": 1.5, "text-opacity": 0.92 } },
      // highway numbers: Interstate, US and state routes, sparsely
      { id: "shields", type: "symbol", source: "base", "source-layer": "transportation_name", minzoom: 9,
        filter: ["all", ["in", ["get", "network"], ["literal", ["us-interstate", "us-highway", "us-state"]]], ["has", "ref"],
          ["<=", ["length", ["to-string", ["get", "ref"]]], 4]],
        layout: { "symbol-placement": "line", "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 9, 260, 13, 520, 16, 800],
          "icon-image": ["concat", "shield:", ["get", "network"], ":", ["to-string", ["get", "ref"]]], "icon-rotation-alignment": "viewport",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.72, 13, 0.85, 16, 0.95], "icon-padding": 30, "symbol-avoid-edges": true } },
    ];
  }
  // a small round symbol for a place: white figure on its color
  function drawPoiIcon(id) {
    const [, kind, th] = id.split(":");
    const color = (th === "d" ? POI_COLOR_D : POI_COLOR)[kind] || "#777";
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), S = 18 * dpr, c = S / 2, R = 7.4 * dpr;
    const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const x = cv.getContext("2d");
    x.beginPath(); x.arc(c, c, R + 1.3 * dpr, 0, Math.PI * 2); x.fillStyle = th === "d" ? "#1c1c1e" : "#fff"; x.fill();
    x.beginPath(); x.arc(c, c, R, 0, Math.PI * 2); x.fillStyle = color; x.fill();
    x.save(); x.translate(c, c); x.scale(R * 0.62, R * 0.62); x.fillStyle = "#fff"; x.strokeStyle = "#fff"; x.lineCap = "round"; x.lineJoin = "round";
    const P = (pts) => { x.beginPath(); x.moveTo(pts[0][0], pts[0][1]); for (const q of pts.slice(1)) x.lineTo(q[0], q[1]); x.closePath(); x.fill(); };
    const dot = (a, b, r) => { x.beginPath(); x.arc(a, b, r, 0, Math.PI * 2); x.fill(); };
    if (kind === "park") { P([[0, -0.95], [0.75, 0.25], [-0.75, 0.25]]); x.fillRect(-0.13, 0.2, 0.26, 0.7); }
    else if (kind === "school") { P([[0, -0.75], [1, -0.25], [0, 0.25], [-1, -0.25]]); x.fillRect(-0.55, -0.05, 1.1, 0.55); x.fillRect(0.82, -0.25, 0.14, 0.75); }
    else if (kind === "museum") { P([[0, -0.95], [0.95, -0.4], [-0.95, -0.4]]); for (const a of [-0.65, -0.2, 0.25]) x.fillRect(a, -0.3, 0.38, 0.9); x.fillRect(-0.95, 0.65, 1.9, 0.25); }
    else if (kind === "zoo") { dot(0, 0.35, 0.45); dot(-0.62, -0.2, 0.22); dot(-0.22, -0.62, 0.22); dot(0.22, -0.62, 0.22); dot(0.62, -0.2, 0.22); }
    else if (kind === "hospital") { x.fillRect(-0.22, -0.8, 0.44, 1.6); x.fillRect(-0.8, -0.22, 1.6, 0.44); }
    else if (kind === "stadium") { x.lineWidth = 0.28; x.beginPath(); x.ellipse(0, 0, 0.85, 0.55, 0, 0, Math.PI * 2); x.stroke(); dot(0, 0, 0.22); }
    else if (kind === "library") { x.fillRect(-0.85, -0.65, 0.75, 1.3); x.fillRect(0.1, -0.65, 0.75, 1.3); }
    else if (kind === "ferry") { P([[-0.9, 0.05], [0.9, 0.05], [0.6, 0.55], [-0.6, 0.55]]); x.fillRect(-0.45, -0.45, 0.8, 0.45); }
    else if (kind === "civic") { P([[0, -0.9], [0.9, -0.35], [-0.9, -0.35]]); x.fillRect(-0.7, -0.25, 1.4, 0.9); }
    else { // a sight: a star
      x.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.42 : 1, a = -Math.PI / 2 + i * Math.PI / 5; x.lineTo(r * Math.cos(a), r * Math.sin(a)); } x.closePath(); x.fill();
    }
    x.restore();
    if (!map.hasImage(id)) map.addImage(id, { width: S, height: S, data: x.getImageData(0, 0, S, S).data }, { pixelRatio: dpr });
  }
  // a highway number: Interstate (blue and red shield), US route (white shield), state route (white oval)
  function drawShield(id) {
    const [, net, ref] = id.split(":");
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const font = (px) => `700 ${px * dpr}px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = font(11);
    const tw = probe.measureText(ref).width / dpr;
    const w = Math.max(net === "us-state" ? 26 : 22, tw + (net === "us-state" ? 12 : 9)), h = net === "us-state" ? 17 : 21;
    const W = Math.ceil((w + 4) * dpr), H = Math.ceil((h + 4) * dpr);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const x = cv.getContext("2d");
    x.scale(dpr, dpr); x.translate(2, 2);
    const shield = () => { x.beginPath(); x.moveTo(0, 2); x.quadraticCurveTo(w / 2, -1.5, w, 2); x.lineTo(w, h * 0.5); x.quadraticCurveTo(w, h * 0.85, w / 2, h); x.quadraticCurveTo(0, h * 0.85, 0, h * 0.5); x.closePath(); };
    x.shadowColor = "rgba(0,0,0,.25)"; x.shadowBlur = 2; x.shadowOffsetY = 0.5;
    if (net === "us-interstate") {
      shield(); x.fillStyle = "#fff"; x.fill(); x.shadowColor = "transparent";
      x.save(); x.translate(w / 2, h / 2); x.scale((w - 2.4) / w, (h - 2.4) / h); x.translate(-w / 2, -h / 2); shield(); x.clip();
      x.fillStyle = "#1d4ea3"; x.fillRect(0, 0, w, h); x.fillStyle = "#c8252c"; x.fillRect(0, 0, w, h * 0.26); x.restore();
      x.fillStyle = "#fff";
    } else if (net === "us-highway") {
      shield(); x.fillStyle = "#fff"; x.fill(); x.shadowColor = "transparent"; x.lineWidth = 1.3; x.strokeStyle = "#222"; x.stroke();
      x.fillStyle = "#111";
    } else {
      x.beginPath(); x.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); x.fillStyle = "#fff"; x.fill(); x.shadowColor = "transparent";
      x.lineWidth = 1.2; x.strokeStyle = "#2b6b3a"; x.stroke(); x.fillStyle = "#1f4f2b";
    }
    x.font = font(11).replace(/\d+(\.\d+)?px/, `${11}px`); x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(ref, w / 2, h / 2 + (net === "us-state" ? 0.5 : 1.5));
    if (!map.hasImage(id)) map.addImage(id, { width: W, height: H, data: x.getImageData(0, 0, W, H).data }, { pixelRatio: dpr });
  }
  function liveLayers(P) {
    return [
      // which way it's heading: a small pointer that turns with the vehicle...
      { id: "veh-dir", type: "symbol", source: "vehicles", filter: [">=", ["get", "b"], 0],
        layout: { "icon-image": ["concat", "vdir:", ["get", "c"]], "icon-rotate": ["get", "b"], "icon-rotation-alignment": "map",
          "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": VEH_SIZE, "symbol-sort-key": ["get", "s"] } },
      // ...under an upright badge that says what it is: a bus, a train, a streetcar or a boat
      { id: "veh-icon", type: "symbol", source: "vehicles",
        layout: { "icon-image": ["concat", "veh:", ["get", "c"], ":", ["get", "m"]], "icon-rotation-alignment": "viewport",
          "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": VEH_SIZE, "symbol-sort-key": ["get", "s"] },
        paint: { "icon-opacity": ["case", ["==", ["get", "est"], 1], 0.82, 1] } },
      { id: "veh-label", type: "symbol", source: "vehicles", minzoom: 14.5,
        layout: { "text-field": ["get", "lab"], "text-font": F_BOLD, "text-size": 11.5, "text-anchor": "left", "text-offset": [1.05, 0],
          "text-optional": true, "text-padding": 1 },
        paint: { "text-color": ["get", "tc"], "text-halo-color": P.halo, "text-halo-width": 2 } },
    ];
  }
  function stopLayers(P) {
    const k = THICK[settings.thickness]; // stops grow and shrink with the lines
    const zr = (stops) => ["interpolate", ["linear"], ["zoom"], ...stops.flatMap(([z, v]) => [z, typeof v === "number" ? v * k : ["*", v, k]])];
    return [
      { id: "stops", type: "circle", source: "stops", minzoom: 14.6,
        paint: {
          "circle-radius": zr([[14.6, 2], [16, 3.4], [18, 5.5]]),
          "circle-color": P.stopFill, "circle-stroke-color": P.stopStroke,
          "circle-stroke-width": zr([[14.6, 1], [17, 1.6]]),
        } },
      { id: "stop-name", type: "symbol", source: "stops", minzoom: 17.2,
        layout: { "text-field": ["get", "name"], "text-font": F_REG, "text-size": 11, "text-variable-anchor": ["left", "right"],
          "text-radial-offset": 0.8, "text-max-width": 9, "text-optional": true, "text-padding": 6 },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.4 } },
      { id: "stations", type: "circle", source: "stations",
        filter: ["any", ["==", ["get", "major"], 1], [">=", ["zoom"], 14], ["all", ["==", ["get", "late"], 0], [">=", ["zoom"], 12.5]]],
        paint: {
          // sized to the Link line: a little wider than the line it sits on (about 1.4x), so it
          // reads as a station without turning into a blob
          "circle-radius": zr([[9, ["*", ["get", "size"], 1.8]], [12, ["*", ["get", "size"], 2.9]], [14, ["*", ["get", "size"], 3.7]],
            [16, ["*", ["get", "size"], 4.9]], [18, ["*", ["get", "size"], 6.4]]]),
          "circle-color": P.stationFill, "circle-stroke-color": ["get", "stroke"],
          "circle-stroke-width": zr([[9, 1.1], [12, 1.5], [14, 1.9], [17, 2.4]]),
        } },
      { id: "station-name", type: "symbol", source: "stations",
        filter: ["any", ["all", ["==", ["get", "major"], 1], [">=", ["zoom"], 11]], [">=", ["zoom"], 14.3]],
        layout: { "text-field": ["get", "name"], "text-font": F_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10.5, 15, 13],
          "text-variable-anchor": ["right", "left", "top", "bottom"], "text-radial-offset": 0.9, "text-justify": "auto",
          "text-max-width": 8, "text-padding": 2 },
        paint: { "text-color": P.place, "text-halo-color": P.halo, "text-halo-width": 2 } },
      { id: "flex", type: "symbol", source: "flexlabels", minzoom: 10,
        layout: { "text-field": ["concat", "Metro Flex\n", ["get", "name"]], "text-font": F_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10.5, 14, 12.5], "text-max-width": 10, "text-padding": 4 },
        paint: { "text-color": theme === "dark" ? "#e3b4ff" : "#6a2593", "text-halo-color": P.halo, "text-halo-width": 1.8 } },
      ...stopGroup("hov", "hoverstops", P), ...stopGroup("sel", "selstops", P), ...stopGroup("hl", "stophl", P, 1.8),
      { id: "badges", type: "symbol", source: "netlabels", minzoom: 9,
        layout: { "icon-image": ["concat", "b:", ["get", "k"]], "icon-padding": 4, "symbol-sort-key": ["get", "p"] } },
      { id: "sel-badges", type: "symbol", source: "sellabels",
        layout: { "icon-image": ["concat", "b:", ["get", "k"]], "icon-padding": 2 } },
      { id: "sel-ends", type: "symbol", source: "selstops", minzoom: 10.5, filter: [">", ["get", "end"], 0],
        layout: { "text-field": ["format", ["case", ["==", ["get", "end"], 2], "End of the line", "Starts here"], { "font-scale": 0.82 },
            "\n", {}, ["get", "name"], {}],
          "text-font": F_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 15, 12.5], "text-max-width": 11,
          "text-variable-anchor": ["left", "right", "top", "bottom"], "text-radial-offset": 1.1, "text-justify": "auto", "text-padding": 2 },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 2 } },
      { id: "place-city", type: "symbol", source: "base", "source-layer": "place", maxzoom: 13,
        filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
        layout: { "text-field": ["get", "name"], "text-font": F_BOLD, "text-size": ["interpolate", ["linear"], ["zoom"], 8, 12, 12, 16], "text-max-width": 8 },
        paint: { "text-color": P.place, "text-halo-color": P.halo, "text-halo-width": 2.4 } },
    ];
  }

  // ---------------------------------------------------------------- network
  // EDGES: street segments with their routes and service types, for hit tests and hover. The
  // drawing itself is done by the geometry engine (web/geom.js) in a background worker.
  let EDGES = [];
  function prepNetwork() {
    EDGES = KCTMGeom.prepEdges(NET.edges, LINES.map((r) => ({ cat: dkey(r), group: CAT[dkey(r)].group })));
    const bb = LINES.map(() => [180, 90, -180, -90]);
    for (const e of NET.edges) {
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      for (const [x, y] of e.c) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      for (const i of e.l) {
        const b = bb[i];
        b[0] = Math.min(b[0], x0); b[1] = Math.min(b[1], y0); b[2] = Math.max(b[2], x1); b[3] = Math.max(b[3], y1);
      }
    }
    LINES.forEach((r, i) => { r.bbox = bb[i]; });
  }

  // ---------------------------------------------------------------- line geometry (background worker)
  // Laying out a view (lanes, bundle shifts, rounded paths, tags) takes 100-250 ms on a phone,
  // so it runs in a worker made from the geometry script on this page; the page only hands the
  // finished lines to the map. Where workers aren't allowed the same engine runs here instead.
  let lastParams = null;
  let worker = null, engine = null, inFlight = null, queued = null, buildSeq = 0, appliedSeq = 0, lastBuildMs = 0, watchdog = 0;
  const idleWaiters = [];
  function engineInit() {
    return { edges: NET.edges, lines: LINES.map((r) => ({ cat: dkey(r), rank: r._rank })), cat: CAT, gap: GAP };
  }
  function runHere() {
    if (worker) { worker.terminate(); worker = null; }
    clearTimeout(watchdog);
    inFlight = null;
    if (!engine) engine = KCTMGeom.createEngine(engineInit());
  }
  function startEngine() {
    if (/[?&]noworker\b/.test(location.search)) { runHere(); return; } // for testing the fallback
    try {
      const src = document.getElementById("geom-src").textContent;
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "route") { const cb = routeCbs.get(m.id); routeCbs.delete(m.id); if (cb) cb(m.feats); return; }
        if (m.type !== "built") return;
        clearTimeout(watchdog);
        inFlight = null;
        applyBuild(m);
        if (queued) { const q = queued; queued = null; send(q); }
      };
      worker.onerror = () => { runHere(); rebuild(); };
      worker.postMessage({ type: "init", init: engineInit() });
    } catch (err) {
      runHere();
    }
  }
  function send(msg) {
    inFlight = msg;
    worker.postMessage({ type: "build", ...msg });
    clearTimeout(watchdog);
    // no answer at all (a blocked worker): draw on the page instead
    watchdog = setTimeout(() => { if (inFlight === msg) { runHere(); rebuild(); } }, 15000);
  }
  // one route's path in the current view's lanes (for hover previews), from the engine
  let routeSeq = 0;
  const routeCbs = new Map();
  function requestRoutePaths(idxs, center, cb) {
    if (!worker) { cb(engine ? engine.routePaths(idxs, center) : []); return; }
    const id = ++routeSeq;
    routeCbs.set(id, cb);
    worker.postMessage({ type: "route", id, idxs, center });
  }
  function applyBuild(m) {
    if (m.id < appliedSeq || !map || !map.getSource("net")) return;
    appliedSeq = m.id;
    lastFeats = m.feats;
    lastSelFeats = m.selFeats;
    vehIx = vehIxSel = null;
    lastBuildMs = m.ms || 0;
    map.getSource("net").setData({ type: "FeatureCollection", features: m.feats });
    if (hoverKey) focusRoutes(hoverRoutes, true);
    map.getSource("sel").setData({ type: "FeatureCollection", features: m.selFeats });
    const still = !map.isZooming();
    if (still || m.zs !== labelStep || m.zs == null) {
      labelStep = m.zs;
      map.getSource("netlabels").setData({ type: "FeatureCollection", features: m.labels });
      map.getSource("sellabels").setData({ type: "FeatureCollection", features: m.selLabels });
      refreshStations();
    }
    // the selected route's stops sit on its drawn line (which moves with the lanes as you zoom)
    if (selected && selected.type === "route" && m.selIdx === LINEIDX[selected.id]) {
      const r = RBY[selected.id];
      setStops("sel", stopFeatures([r], true), m.selFeats, "route", selStopsFor !== r.id);
      selStopsFor = r.id;
    }
    if (!inFlight && !queued) idleWaiters.splice(0).forEach((f) => f());
  }

  const zStep = (z) => Math.max(9, Math.min(19, Math.round(z * 4) / 4));
  // Zoomed out, all-day and rush-hour buses are slimmer than frequent ones, so the busy
  // coverage map underneath stays readable and the frequent network stands out.
  function minorScale(z) {
    const f = z <= 10.5 ? 0.5 : z >= 12.5 ? 1 : 0.5 + 0.5 * (z - 10.5) / 2;
    return { local: f, peak: Math.max(0.5, Math.min(1, f + 0.15) * 0.8), shuttle: f, dart: f };
  }
  function tierFor(z) { const t = BUS_TIERS[settings.busDetail]; return z >= t[2] ? 2 : z >= t[1] ? 1 : 0; }
  let curStep = null, lastZ = -1, labelStep = null, lastBuild = 0, buildTimer = null, builtView = null, lastFeats = [], lastSelFeats = [];
  // The area last drawn (meters): the view plus a wide margin, so panning stays smooth.
  function viewBox(margin) {
    const b = map.getBounds();
    const [x0, y0] = toM(b.getWest(), b.getSouth()), [x1, y1] = toM(b.getEast(), b.getNorth());
    const mx = (x1 - x0) * margin, my = (y1 - y0) * margin;
    return [x0 - mx, y0 - my, x1 + mx, y1 + my];
  }
  function onMoveEnd() {
    if (!builtView) return;
    const v = viewBox(0.05);
    if (v[0] < builtView[0] || v[1] < builtView[1] || v[2] > builtView[2] || v[3] > builtView[3]) rebuild();
  }

  // Ask for the lines of the current view. Only one request is in the worker at a time; while
  // it works, newer requests replace each other, so a fast zoom only lays out where it stops.
  function rebuild() {
    if (!map || !map.getSource("net") || (!worker && !engine)) return;
    const zNow = map.getZoom();
    const zs = curStep = zStep(zNow);
    // lanes are laid out for (nearly) the zoom on screen, so they follow a pinch closely
    const z = lastZ = Math.max(9, Math.min(19, Math.round(zNow * 50) / 50));
    lastBuild = performance.now();
    const u = interp(UNIT, z) * THICK[settings.thickness];
    const tier = tierFor(zNow);
    const keyOn = {};
    for (const k of Object.keys(CAT)) keyOn[k] = (k === "sounder" ? enabledCat("sounder") || enabledCat("amtrak") : enabledCat(CAT[k].base || k)) && CAT[k].tier <= tier;
    const p = { z, zs, zNow, u, capU: interp(CAP_PX, z) / u, keyOn,
      selIdx: selected && selected.type === "route" ? LINEIDX[selected.id] : -1,
      view: (builtView = viewBox(0.75)), tags: tagSpacing(TAG_DENSITY[settings.tags], zNow), theme: theme[0], colors: netColors(theme),
      wscale: minorScale(zNow) };
    lastParams = p;
    const msg = { id: ++buildSeq, p };
    if (!worker) {
      const t = performance.now();
      applyBuild({ id: msg.id, ms: performance.now() - t, ...engine.build(p) });
    } else if (inFlight) queued = msg;
    else send(msg);
  }
  // While zooming, ask for a new layout as soon as the zoom has moved a little: the worker takes
  // one request at a time and newer ones replace waiting ones, so it keeps up as best it can.
  function onZoom() {
    const zNow = map.getZoom();
    if (Math.abs(zNow - lastZ) < 0.04 && zStep(zNow) === curStep) return;
    if (worker) { clearTimeout(buildTimer); rebuild(); return; }
    const wait = 140 - (performance.now() - lastBuild); // laying out on the page: not every frame
    clearTimeout(buildTimer);
    if (wait <= 0) rebuild(); else buildTimer = setTimeout(rebuild, wait);
  }

  // ---------------------------------------------------------------- route tags (canvas)
  // Plain, flat labels in the manner of the printed map: one small solid pill per service
  // type, route numbers side by side with hairline dividers, a thin halo to lift it off the
  // lines. No gloss, no cards, no stacks.
  function drawBadge(id) {
    const [, th, list] = id.split(":");
    const dark = th === "d";
    let rs = list.split(".").map((i) => LINES[+i]).filter(Boolean);
    const MAX = 6;
    let extra = 0;
    if (rs.length > MAX) { extra = rs.length - (MAX - 1); rs = rs.slice(0, MAX - 1); }
    const groups = [], all = list.split(".").map(Number);
    for (const r of rs) {
      const c = tagColor(r, dark ? "dark" : "light");
      let g = groups.find((x) => x.c === c);
      if (!g) groups.push((g = { c, fg: tagText(r, dark ? "dark" : "light"), items: [], refs: [] }));
      g.items.push(shortLabel(r));
      g.refs.push({ r: LINEIDX[r.id] });
    }
    if (extra) { groups[groups.length - 1].items.push(`+${extra}`); groups[groups.length - 1].refs.push({ more: all.slice(MAX - 1) }); }
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const h = 15 * dpr, pad = 4.5 * dpr, sep = 7 * dpr, gap = 2 * dpr, halo = 1.5 * dpr, rad = 3.5 * dpr;
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d");
    const font = `650 ${10.5 * dpr}px ${FONT}`;
    ctx.font = font;
    for (const g of groups) {
      g.ws = g.items.map((t) => ctx.measureText(t).width);
      g.w = Math.max(h, g.ws.reduce((a, b) => a + b, 0) + sep * (g.items.length - 1) + pad * 2);
    }
    const W = groups.reduce((a, g) => a + g.w, 0) + gap * (groups.length - 1) + halo * 2;
    const H = h + halo * 2;
    cv.width = Math.ceil(W); cv.height = Math.ceil(H);
    ctx.font = font;
    ctx.textBaseline = "middle";
    let x = halo;
    const layout = { w: cv.width / dpr, h: cv.height / dpr, items: [] };
    for (const g of groups) {
      // hit areas for each number (CSS px from the tag's left edge)
      let bx = x + (g.w - (g.ws.reduce((a, b) => a + b, 0) + sep * (g.items.length - 1))) / 2, from = x;
      g.items.forEach((t, k) => {
        const to = k === g.items.length - 1 ? x + g.w + gap / 2 : bx + g.ws[k] + sep / 2;
        layout.items.push({ ...g.refs[k], x0: (k === 0 && x === halo ? 0 : from) / dpr, x1: to / dpr });
        from = to;
        bx += g.ws[k] + sep;
      });
      ctx.fillStyle = dark ? "#1c1c1e" : "#ffffff";
      roundRect(ctx, x - halo, 0, g.w + halo * 2, H, rad + halo); ctx.fill();
      ctx.fillStyle = g.c;
      roundRect(ctx, x, halo, g.w, h, rad); ctx.fill();
      let tx = x + (g.w - (g.ws.reduce((a, b) => a + b, 0) + sep * (g.items.length - 1))) / 2;
      g.items.forEach((t, k) => {
        ctx.fillStyle = g.fg;
        ctx.fillText(t, tx, halo + h / 2 + 0.5 * dpr);
        tx += g.ws[k];
        if (k < g.items.length - 1) {
          ctx.fillStyle = g.fg === "#ffffff" ? "rgba(255,255,255,0.42)" : "rgba(0,0,0,0.28)";
          ctx.fillRect(tx + sep / 2 - 0.5 * dpr, halo + h * 0.24, 1 * dpr, h * 0.52);
          tx += sep;
        }
      });
      x += g.w + gap;
    }
    layout.items[layout.items.length - 1].x1 = layout.w;
    BADGE_LAYOUT.set(id, layout);
    const data = ctx.getImageData(0, 0, cv.width, cv.height);
    if (!map.hasImage(id)) map.addImage(id, { width: cv.width, height: cv.height, data: data.data }, { pixelRatio: dpr });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function flexHTML(p) {
    const row = (d, t) => `<tr><th>${d}</th><td>${t ? esc(t) : "No service"}</td></tr>`;
    return `<div class="pop"><h3>Metro Flex · ${esc(p.name)}</h3><p>On-demand rides anywhere inside this zone, booked in the Metro Flex app or by phone, for the price of a bus fare.</p>`
      + `<table class="hours">${row("Weekdays", p.weekdays)}${row("Saturday", p.saturday)}${row("Sunday", p.sunday)}</table></div>`;
  }


  // ---------------------------------------------------------------- data → GeoJSON
  function stationsGeoJSON() {
    const majorCats = new Set(["link", "sounder", "amtrak", "monorail"]);
    return { type: "FeatureCollection", features: STOPS.stations.filter((s) => s.routes.some((id) => RBY[id] && enabledCat(RBY[id].cat))).map((s) => {
      const rs = s.routes.map((id) => RBY[id]).filter(Boolean);
      const cats = new Set(rs.map((r) => r.cat));
      // the T Line in Tacoma is short and its stations close together: zoomed out they'd be a
      // cluster of dots and names on a tiny line, so its stations only show once you're close
      const tOnly = cats.has("link") && rs.filter((r) => r.cat === "link").every((r) => r.label === "T")
        && ![...cats].some((c) => c !== "link" && (majorCats.has(c) || c === "ferry" || c === "watertaxi"));
      const major = !tOnly && ([...cats].some((c) => majorCats.has(c)) || cats.has("ferry") || cats.has("watertaxi"));
      let stroke = BASE[theme].stationStroke;
      if (!major && cats.has("streetcar")) stroke = LINE[theme].streetcar;
      if (!cats.has("link") && (cats.has("ferry") || cats.has("watertaxi"))) stroke = LINE[theme].ferry;
      if (!cats.has("link") && (cats.has("sounder") || cats.has("amtrak"))) stroke = LINE[theme].sounder;
      // Link stations take their line's color; stations of more than one Link line stay neutral
      const linkLines = new Set(rs.filter((r) => r.cat === "link").map(dkey));
      if (linkLines.size === 1) stroke = LINE[theme][[...linkLines][0]];
      const size = tOnly ? 0.8 : cats.has("link") ? (rs.filter((r) => r.cat === "link").length > 1 ? 1.15 : 1) : major ? 0.95 : 0.7;
      const snap = rs.length && rs.every((r) => r.cat === "streetcar") ? "streetcar" : "";
      return { type: "Feature", properties: { id: s.id, name: s.name, major: major ? 1 : 0, late: tOnly ? 1 : 0, size, stroke, snap },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] } };
    }) };
  }
  function stopsGeoJSON() {
    return { type: "FeatureCollection", features: STOPS.stops.map((s) => ({ type: "Feature", properties: { id: s.id, name: s.name },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) };
  }
  function maskGeoJSON() {
    const R = META.region;
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
      [[R.west, R.south], [R.west, R.north], [R.east, R.north], [R.east, R.south], [R.west, R.south]],
    ] } };
  }

  // ---------------------------------------------------------------- theme
  function applyTheme() {
    theme = themeName();
    document.documentElement.setAttribute("data-dark", theme === "dark" ? "1" : "0");
    if (!map || !map.isStyleLoaded()) return;
    const P = BASE[theme];
    netDim = 1; // the loop below resets every layer to its normal look
    for (const set of [baseLayers(P), transitLayers(P), areaLayers(P), poiLayers(P), stopLayers(P), liveLayers(P)]) {
      for (const L of set) {
        if (!map.getLayer(L.id)) continue;
        for (const [k, v] of Object.entries(L.paint || {})) map.setPaintProperty(L.id, k, v);
      }
    }
    for (const L of poiLayers(P)) if (map.getLayer(L.id) && L.layout && L.layout["icon-image"]) map.setLayoutProperty(L.id, "icon-image", L.layout["icon-image"]);
    refreshStations();
    rebuild();
    applySelectionStyle();
    renderFilterBar();
    if (!selected) showHome(true);
  }

  // ---------------------------------------------------------------- live vehicles
  // OneBusAway publishes each agency's vehicle positions as GTFS-realtime (a few KB to
  // ~30 KB of protobuf). We poll every 15 s while the page is visible, match each vehicle
  // to its route, and glide markers to their new positions.
  const POLL_MS = 20000;
  const live = { vehicles: new Map(), timer: 0, last: 0, error: false, polling: false, anim: 0, count: 0, pauseUntil: 0,
    status: new Map(), statusTurn: 0 };
  const plainId = (x) => String(x || "").replace(/^\d+_/, "");
  const liveState = () => live; // for the test scripts
  // How busy a vehicle is. GTFS-realtime calls this occupancy_status (0-8); OneBusAway's REST
  // feed gives the same thing as the enum's name. NO_DATA_AVAILABLE (7) and NOT_BOARDABLE (8)
  // tell a rider nothing, so they read as no answer at all.
  const OCC_CODE = { EMPTY: 0, MANY_SEATS_AVAILABLE: 1, FEW_SEATS_AVAILABLE: 2, STANDING_ROOM_ONLY: 3,
    CRUSHED_STANDING_ROOM_ONLY: 4, FULL: 5, NOT_ACCEPTING_PASSENGERS: 6, NO_DATA_AVAILABLE: 7, NOT_BOARDABLE: 8 };
  const OCC_TEXT = ["Empty", "Plenty of seats", "A few seats left", "Standing room only", "Packed", "Full", "Not picking up"];
  const OCC_CLS = ["ok", "ok", "some", "busy", "busy", "full", "full"];
  // the same as three small figures, narrow enough to sit beside a destination in a stop
  // card's row: one for seats, two once riders are standing, three when it's packed or full
  function occMeter(code) {
    const n = code <= 2 ? 1 : code <= 3 ? 2 : 3;
    const person = (i) => `<g transform="translate(${i * 6} 0)" opacity="${i < n ? 1 : 0.28}"><circle cx="2.5" cy="2" r="1.8"/>`
      + `<path d="M0 10V7.6C0 6.1 1.1 5 2.5 5S5 6.1 5 7.6V10z"/></g>`;
    return `<svg class="sc-meter" width="17" height="10" viewBox="0 0 17 10" fill="currentColor" aria-hidden="true">${[0, 1, 2].map(person).join("")}</svg>`;
  }
  // the enum name, a number, or nothing -> 0-6, or null when there's no useful answer
  function occCode(x) {
    if (x == null || x === "") return null;
    const n = typeof x === "number" ? x : OCC_CODE[String(x).toUpperCase()];
    return n >= 0 && n <= 6 ? n : null;
  }
  let RTMAP = new Map();
  function varint(r) { let x = 0, m = 1, b; do { b = r.b[r.p++]; x += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return x; }
  function skipField(r, wt) { if (wt === 0) varint(r); else if (wt === 1) r.p += 8; else if (wt === 2) { const n = varint(r); r.p += n; } else if (wt === 5) r.p += 4; else throw new Error("bad wire type"); }
  function parseVehicles(u8) {
    const r = { b: u8, p: 0 }, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), td = new TextDecoder(), out = [];
    const str = () => { const n = varint(r), t = td.decode(u8.subarray(r.p, r.p + n)); r.p += n; return t; };
    const msg = (end, fn) => { while (r.p < end) { const tag = varint(r), f = Math.floor(tag / 8), wt = tag & 7; if (!fn(f, wt)) skipField(r, wt); } };
    const sub = (fn) => { const n = varint(r), end = r.p + n; msg(end, fn); r.p = end; return true; };
    msg(u8.length, (f, wt) => {
      if (f !== 2 || wt !== 2) return false;            // FeedMessage.entity
      const v = {};
      sub((f2, wt2) => {
        if (f2 !== 4 || wt2 !== 2) return false;        // FeedEntity.vehicle
        return sub((f3, wt3) => {
          if (f3 === 1 && wt3 === 2) return sub((f4, wt4) => {   // trip
            if (wt4 === 2 && f4 === 1) { v.trip = str(); return true; }
            if (wt4 === 2 && f4 === 5) { v.route = str(); return true; }
            return false;
          });
          if (f3 === 2 && wt3 === 2) return sub((f4, wt4) => {   // position
            if (wt4 === 5 && f4 <= 3) { const x = dv.getFloat32(r.p, true); r.p += 4; if (f4 === 1) v.lat = x; else if (f4 === 2) v.lon = x; else v.bearing = x; return true; }
            return false;
          });
          if (f3 === 5 && wt3 === 0) { v.ts = varint(r); return true; } // timestamp
          if (f3 === 9 && wt3 === 0) { v.occ = varint(r); return true; }     // occupancy_status
          if (f3 === 10 && wt3 === 0) { v.occPct = varint(r); return true; } // occupancy_percentage
          if (f3 === 8 && wt3 === 2) return sub((f4, wt4) => {   // vehicle descriptor
            if (wt4 === 2 && f4 === 1) { v.id = str(); return true; }
            if (wt4 === 2 && f4 === 2) { v.label = str(); return true; }
            return false;
          });
          return false;
        });
      });
      if (v.lat && v.lon) out.push(v);
      return true;
    });
    return out;
  }
  // OneBusAway's REST vehicles (with trip references) in the same shape as parseVehicles gives;
  // their on-time status comes along too
  function restVehicles(a, d) {
    const data = d && d.data, out = [];
    if (!data) return out;
    const trips = new Map(((data.references && data.references.trips) || []).map((t) => [t.id, t]));
    for (const x of data.list || []) {
      const t = trips.get(x.tripId), ts = x.tripStatus || {}, loc = x.location || ts.position;
      if (!t || !loc) continue;
      const o = ts.orientation; // degrees counterclockwise from east
      out.push({ route: plainId(t.routeId), trip: plainId(x.tripId), lat: loc.lat, lon: loc.lon, id: plainId(x.vehicleId), head: t.tripHeadsign || "",
        bearing: o != null && isFinite(o) ? ((90 - o) % 360 + 360) % 360 || 0.01 : undefined, ts: x.lastUpdateTime ? Math.round(x.lastUpdateTime / 1000) : 0,
        occ: occCode(x.occupancyStatus != null ? x.occupancyStatus : ts.occupancyStatus) });
      live.status.set(a + "_" + plainId(x.vehicleId), { dev: ts.scheduleDeviation, predicted: !!ts.predicted, upd: x.lastUpdateTime, got: Date.now(),
        occ: occCode(ts.occupancyStatus), occN: ts.occupancyCount, occCap: ts.occupancyCapacity });
    }
    return out;
  }
  // Washington State Ferries' fleet, by WSF vessel id
  const WSF_VESSELS = { 1: "Cathlamet", 2: "Chelan", 15: "Issaquah", 17: "Kaleetan", 18: "Kitsap", 19: "Kittitas", 25: "Puyallup",
    28: "Sealth", 30: "Spokane", 32: "Tacoma", 33: "Tillikum", 36: "Walla Walla", 37: "Wenatchee", 38: "Yakima", 52: "Kennewick",
    65: "Chetzemoka", 66: "Salish", 68: "Tokitae", 69: "Samish", 74: "Chimacum", 75: "Suquamish" };
  // WSF's own API (needs an access code): where each boat is in its crossing, and bulletins.
  // It answers JSONP, which works from any page.
  const wsfOn = () => !!(LIVE && LIVE.wsf && LIVE.wsf.code && !/^__/.test(LIVE.wsf.code));
  let jsonpSeq = 0;
  function jsonp(url, ms = 12000) {
    return new Promise((ok, fail) => {
      const cb = `__kctm_jp${++jsonpSeq}`, el = document.createElement("script");
      // a reply that comes after we've given up still finds a (do-nothing) callback
      const done = (f, v) => { clearTimeout(t); window[cb] = () => {}; el.remove(); f(v); };
      const t = setTimeout(() => done(fail, new Error("timeout")), ms);
      window[cb] = (data) => done(ok, data);
      el.onerror = () => done(fail, new Error("load"));
      el.src = `${url}${url.includes("?") ? "&" : "?"}callback=${cb}`;
      document.head.appendChild(el);
    });
  }
  const wsfDate = (x) => { const m = /Date\((\d+)/.exec(String(x || "")); return m ? +m[1] : 0; };
  const wsf = { vessels: new Map(), got: 0 };
  const wsfState = () => wsf; // for the test scripts
  async function pollWsf() {
    if (Date.now() - wsf.got < 15000) return;
    wsf.got = Date.now();
    try {
      const list = await jsonp(`${LIVE.wsf.base}/vessels/rest/vessellocations?apiaccesscode=${encodeURIComponent(LIVE.wsf.code)}`);
      wsf.vessels = new Map((list || []).map((v) => [String(v.VesselID), v]));
    } catch (e) { /* the boats still show from OneBusAway */ }
  }
  // "Left Kingston 2:05 PM · arrives Edmonds about 2:35 PM", "At the dock in Bainbridge Island · leaves 3:10 PM"
  function ferryLine(v) {
    const w = v && v.agency === "95" ? wsf.vessels.get(String(v.vid)) : null;
    if (!w) return v && v.head ? esc(v.head) : "";
    const t = (x) => (wsfDate(x) ? CLOCK.format(new Date(wsfDate(x))) : "");
    if (w.AtDock) return esc(`At the dock in ${w.DepartingTerminalName}${t(w.ScheduledDeparture) ? ` · leaves ${t(w.ScheduledDeparture)}` : ""}`);
    return esc(`${w.DepartingTerminalName ? `Left ${w.DepartingTerminalName}${t(w.LeftDock) ? " " + t(w.LeftDock) : ""}` : ""}${w.ArrivingTerminalName ? ` · arrives ${w.ArrivingTerminalName}${t(w.Eta) ? " about " + t(w.Eta) : ""}` : ""}`);
  }
  // a boat's name and where it is in its crossing
  function vesselLine(id, tag = "span") {
    const v = live.vehicles.get(id);
    if (!v || !(v.name || v.head)) return "";
    const where = ferryLine(v);
    return `<${tag} class="vs-sub">${v.name ? `<b>${esc(v.name)}</b>` : ""}${v.name && where ? " · " : ""}${where}</${tag}>`;
  }
  // ---------------------------------------------------------------- service alerts
  // Detours, closed or moved stops, canceled trips and other notices, from each agency's
  // GTFS-realtime alerts (through OneBusAway; Intercity Transit's own feed) and, with an access
  // code, Washington State Ferries' bulletins. Checked every few minutes.
  const ALERT_MS = 4 * 60000;
  const alerts = { list: [], byRoute: new Map(), byStop: new Map(), got: 0, polling: false };
  const STOP_PREFIX = { 1: "kcm", 23: "kcm", 40: "st", 29: "ct", 3: "pt", 97: "et", 20: "kt", 95: "wsf", 19: "it" };
  function parseAlerts(u8) {
    const r = { b: u8, p: 0 }, td = new TextDecoder(), out = [];
    const vi = () => varint(r);
    const str = () => { const n = vi(), t = td.decode(u8.subarray(r.p, r.p + n)); r.p += n; return t; };
    const msg = (end, fn) => { while (r.p < end) { const tag = vi(), f = Math.floor(tag / 8), wt = tag & 7; if (!fn(f, wt)) skipField(r, wt); } };
    const sub = (fn) => { const n = vi(), end = r.p + n; msg(end, fn); r.p = end; return true; };
    // a translated text: the English one when there's a choice
    const tstr = () => {
      let first = "", en = "";
      sub((f, wt) => {
        if (f !== 1 || wt !== 2) return false;
        let text = "", lang = "";
        sub((g, w) => { if (g === 1 && w === 2) { text = str(); return true; } if (g === 2 && w === 2) { lang = str(); return true; } return false; });
        if (!first) first = text;
        if (!en && (!lang || /^en/i.test(lang))) en = text;
        return true;
      });
      return en || first;
    };
    msg(u8.length, (f, wt) => {
      if (f !== 2 || wt !== 2) return false; // FeedMessage.entity
      const a = { id: "", periods: [], ents: [], effect: 0, url: "", header: "", desc: "" };
      let isAlert = false;
      sub((f2, wt2) => {
        if (f2 === 1 && wt2 === 2) { a.id = str(); return true; }
        if (f2 !== 5 || wt2 !== 2) return false; // FeedEntity.alert
        isAlert = true;
        return sub((f3, wt3) => {
          if (f3 === 1 && wt3 === 2) { const q = { s: 0, e: 0 }; sub((g, w) => { if (w === 0 && (g === 1 || g === 2)) { const v = vi(); if (g === 1) q.s = v; else q.e = v; return true; } return false; }); a.periods.push(q); return true; }
          if (f3 === 5 && wt3 === 2) {
            const e = {};
            sub((g, w) => {
              if (g === 1 && w === 2) { e.agency = str(); return true; }
              if (g === 2 && w === 2) { e.route = str(); return true; }
              if (g === 4 && w === 2) return sub((h, x) => { if (h === 5 && x === 2) { e.route = e.route || str(); return true; } return false; });
              if (g === 5 && w === 2) { e.stop = str(); return true; }
              return false;
            });
            a.ents.push(e);
            return true;
          }
          if (f3 === 7 && wt3 === 0) { a.effect = vi(); return true; }
          if (f3 === 8 && wt3 === 2) { a.url = tstr().trim(); return true; }
          if (f3 === 10 && wt3 === 2) { a.header = tstr(); return true; }
          if (f3 === 11 && wt3 === 2) { a.desc = tstr(); return true; }
          return false;
        });
      });
      if (isAlert) out.push(a);
      return true;
    });
    return out;
  }
  // how much it matters: a trip or service that isn't running, a change to how it runs, or a notice
  function alertLevel(text, effect) {
    if ([1, 2, 3].includes(effect) || /\b(cancel+ed|cancel+ations?|suspended|no service|not (be )?(running|operating|serving)|out of service|significant delays?|major delays?|disrupt|tie[- ]?up|tied up)/i.test(text)) return 2;
    if ([4, 6, 9].includes(effect) || /\b(detour|re-?rout|relocat|closed|closure|moved|temporar|skip|bypass|delay|reduced|shuttle|unavailable)/i.test(text)) return 1;
    return 0;
  }
  // Agency feed alerts -> { id, agency, title, desc, url, level, start, end, routes, stops }
  function readAlerts(feedAgency, raw, now) {
    const out = [];
    for (const a of raw) {
      const live = !a.periods.length || a.periods.some((q) => (!q.s || q.s <= now + 3600) && (!q.e || q.e >= now));
      if (!live) continue;
      const routes = new Set(), stops = new Set();
      for (const e of a.ents) {
        const ag = e.agency && e.agency !== "0" ? e.agency : feedAgency;
        if (e.route) { const r = RTMAP.get(`${ag}_${e.route}`); if (r) routes.add(r.id); }
        if (e.stop) stops.add(`${STOP_PREFIX[ag] || ag}-${e.stop}`);
      }
      // some feeds put the whole notice in the title: its first line is the title
      let title = (a.header || "").trim(), desc = (a.desc || "").trim();
      const nl = title.indexOf("\n");
      if (nl > 0) { desc = (title.slice(nl + 1).trim() + (desc ? "\n\n" + desc : "")).trim(); title = title.slice(0, nl).trim(); }
      if (!title) continue;
      const start = Math.min(...a.periods.map((q) => q.s || Infinity), Infinity), end = Math.max(...a.periods.map((q) => q.e || 0), 0);
      out.push({ id: `${feedAgency}:${a.id || title}`, agency: feedAgency, title, desc, url: /^https?:/i.test(a.url) ? a.url : "",
        level: alertLevel(title + " " + desc, a.effect), start: isFinite(start) ? start : 0, end, routes, stops });
    }
    return out;
  }
  // WSF bulletins name their routes by terminal ("Faunt/Va/SW", "Sea/Bi", "Ed/King")
  const WSF_ROUTE_WORDS = [
    [/\bfaunt|\bva(shon)?\b|\bsw\b|southworth/i, ["wsf-fauntleroy-southworth", "wsf-fauntleroy-vashon-island", "wsf-southworth-vashon-island"]],
    [/sea(ttle)?\s*\/\s*bi|bainbridge/i, ["wsf-seattle-bainbridge-island"]],
    [/sea(ttle)?\s*\/\s*br|bremerton/i, ["wsf-seattle-bremerton"]],
    [/\bed(m|monds)?\s*\/\s*king|kingston/i, ["wsf-edmonds-kingston"]],
    [/muk(ilteo)?\s*\/\s*clin|clinton/i, ["wsf-clinton-mukilteo"]],
    [/\bpd\s*\/\s*tah|point defiance|tahlequah/i, ["wsf-point-defiance-tahlequah"]],
  ];
  const stripHTML = (h) => { const d = document.createElement("div"); d.innerHTML = String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n"); return (d.textContent || "").replace(/\n{3,}/g, "\n\n").trim(); };
  function wsfAlerts(list, now) {
    const out = [];
    for (const b of list || []) {
      const title = (b.AlertFullTitle || b.RouteAlertText || "").trim();
      if (!title) continue;
      const head = title.split(/ - |: /)[0];
      let ids = [];
      if (b.AllRoutesFlag) ids = ROUTES.filter((r) => r.id.startsWith("wsf-")).map((r) => r.id);
      else for (const [re, rs] of WSF_ROUTE_WORDS) if (re.test(head)) ids.push(...rs);
      ids = ids.filter((id) => RBY[id] && LINEIDX[id] != null);
      if (!ids.length) continue; // a route outside this map (the San Juans, Port Townsend)
      const desc = stripHTML(b.BulletinText || b.HomepageAlertText || "");
      out.push({ id: `95:${b.BulletinID}`, agency: "95", title, desc, url: "https://wsdot.wa.gov/travel/washington-state-ferries",
        level: alertLevel(title + " " + desc, 0), start: Math.round(wsfDate(b.PublishDate) / 1000), end: 0, routes: new Set(ids), stops: new Set() });
    }
    return out;
  }
  async function pollAlerts() {
    if (!LIVE || alerts.polling || document.hidden || Date.now() - alerts.got < ALERT_MS - 5000) return;
    alerts.polling = true;
    const now = Date.now() / 1000, found = [];
    const sources = LIVE.agencies.map((a) => [a, `${LIVE.alerts}/${a}.pb?key=${encodeURIComponent(LIVE.key)}`])
      .concat((LIVE.feeds || []).filter((f) => f.alerts).map((f) => [f.agency, f.alerts]));
    for (const [a, url] of LIVE.alerts ? sources : []) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.status === 429) break;
        if (r.ok) found.push(...readAlerts(a, parseAlerts(new Uint8Array(await r.arrayBuffer())), now));
      } catch (e) { /* an agency's alerts are missing this round; the rest still show */ }
      await new Promise((ok) => setTimeout(ok, 200));
    }
    if (wsfOn()) {
      try { found.push(...wsfAlerts(await jsonp(`${LIVE.wsf.base}/schedule/rest/alerts?apiaccesscode=${encodeURIComponent(LIVE.wsf.code)}`), now)); } catch (e) { /* bulletins later */ }
    }
    // the same notice can come through two agencies' feeds: keep it once, with every route it names
    const byText = new Map();
    for (const a of found) {
      if (!a.routes.size && ![...a.stops].some((sid) => stopIndex[sid])) continue; // nothing on this map
      const k = a.title.toLowerCase().replace(/\s+/g, " ");
      const prev = byText.get(k);
      if (prev) { a.routes.forEach((x) => prev.routes.add(x)); a.stops.forEach((x) => prev.stops.add(x)); prev.level = Math.max(prev.level, a.level); }
      else byText.set(k, a);
    }
    alerts.list = [...byText.values()].sort((x, y) => (y.level - x.level) || (y.start - x.start));
    alerts.byRoute = new Map(); alerts.byStop = new Map();
    for (const a of alerts.list) {
      for (const id of a.routes) { if (!alerts.byRoute.has(id)) alerts.byRoute.set(id, []); alerts.byRoute.get(id).push(a); }
      for (const id of a.stops) { if (!alerts.byStop.has(id)) alerts.byStop.set(id, []); alerts.byStop.get(id).push(a); }
    }
    alerts.got = Date.now();
    alerts.polling = false;
    onAlerts();
  }
  const routeAlerts = (id) => alerts.byRoute.get(id) || [];
  function stopAlerts(ids) {
    const seen = new Set(), out = [];
    for (const id of ids) for (const a of alerts.byStop.get(id) || []) if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
    return out.sort((x, y) => y.level - x.level);
  }
  const LEVEL = [["notice", "Notice"], ["change", "Service change"], ["stop", "Disruption"]];
  const agencyName = (a) => ({ 1: "King County Metro", 40: "Sound Transit", 29: "Community Transit", 3: "Pierce Transit", 97: "Everett Transit",
    20: "Kitsap Transit", 23: "Seattle Streetcar", 95: "Washington State Ferries", 19: "Intercity Transit" })[a] || "";
  const alertIcon = (lvl) => `<span class="al-ic al-${LEVEL[lvl][0]}" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 1.6 15 14H1Z" fill="currentColor"/><path d="M8 6v3.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".95" fill="#fff"/></svg></span>`;
  const alertWhen = (a) => {
    const d = (t) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }).format(new Date(t * 1000));
    if (a.end && a.end < Date.now() / 1000 + 86400 * 400) {
      if (a.start && d(a.start) === d(a.end)) return d(a.end);
      return `${a.start ? d(a.start) + " – " : "Until "}${d(a.end)}`;
    }
    return a.start ? `Since ${d(a.start)}` : "";
  };
  // one alert, folded: its title; open: the details and a link
  function alertHTML(a, { routes = true } = {}) {
    const rs = routes ? [...a.routes].map((id) => RBY[id]).filter(Boolean).sort(tagOrder) : [];
    const meta = [agencyName(a.agency), alertWhen(a)].filter(Boolean).join(" · ");
    return `<li class="alert al-${LEVEL[a.level][0]}"><details><summary>${alertIcon(a.level)}<span class="al-body"><span class="al-kind">${LEVEL[a.level][1]}</span>
      <span class="al-title">${esc(a.title)}</span>${rs.length ? `<span class="al-routes">${rs.slice(0, 8).map((r) => `<button type="button" class="al-r" data-route="${esc(r.id)}">${badgeHTML(r)}</button>`).join("")}${rs.length > 8 ? `<span class="sc-more">+${rs.length - 8}</span>` : ""}</span>` : ""}</span>
      <svg class="al-chev" width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"><path d="m1.5 1.5 4.5 4.5 4.5-4.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
      <div class="al-more">${a.desc ? `<p>${esc(a.desc).replace(/\n/g, "<br>")}</p>` : ""}${meta ? `<p class="al-meta">${esc(meta)}</p>` : ""}${a.url ? `<a class="al-link" href="${esc(a.url)}" target="_blank" rel="noopener">More from ${esc(agencyName(a.agency) || "the agency")}<span aria-hidden="true">↗</span></a>` : ""}</div></details></li>`;
  }
  function bindAlertList(root) {
    for (const b of root.querySelectorAll(".al-r[data-route]")) {
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); selectRoute(b.dataset.route); });
      previewOnHover(b);
    }
  }
  // a short line for cards: "⚠ Detour: Route 24 ..." (the most serious one) and how many more
  function alertTeaser(list) {
    if (!list.length) return "";
    const a = list[0];
    return `<div class="sc-alert al-${LEVEL[a.level][0]}">${alertIcon(a.level)}<span>${esc(a.title.length > 110 ? a.title.slice(0, 108) + "…" : a.title)}${list.length > 1 ? ` <b>+${list.length - 1} more</b>` : ""}</span></div>`;
  }
  // new alerts: refresh what's on screen
  function onAlerts() {
    if (panelView === "alerts") showAlerts(true);
    else if (!selected) showHome(true);
    else if (selected.type === "route" && RBY[selected.id]) fillRouteAlerts(RBY[selected.id]);
    else if (stopIndex[selected.id]) fillStopAlerts(stopIndex[selected.id]);
  }
  function fillRouteAlerts(r) {
    const box = $("#routeAlerts");
    if (!box) return;
    const list = routeAlerts(r.id);
    box.innerHTML = list.length ? `<h3 class="section">Service alerts</h3><ul class="group alerts" role="list">${list.map((a) => alertHTML(a, { routes: a.routes.size > 1 })).join("")}</ul>` : "";
    bindAlertList(box);
  }
  const stopIdsOf = (s) => [s.id, s.key, ...(s.stops || [])].filter(Boolean);
  function fillStopAlerts(s) {
    const box = $("#stopAlerts");
    if (!box) return;
    const list = stopAlerts(stopIdsOf(s));
    box.innerHTML = list.length ? `<h3 class="section">Service alerts</h3><ul class="group alerts" role="list">${list.map((a) => alertHTML(a)).join("")}</ul>` : "";
    bindAlertList(box);
  }
  function showAlerts(quiet) {
    const groups = [2, 1, 0].map((lvl) => [lvl, alerts.list.filter((a) => a.level === lvl)]).filter(([, l]) => l.length);
    const html = `<div class="alerts-view"><button class="back press" id="back" type="button"><svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2 2 10l8 8" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>Map</button>
      <div class="view-head"><h2 class="view-title">Service alerts</h2></div>
      ${groups.length ? groups.map(([lvl, l]) => `<h2 class="section">${["Notices", "Service changes", "Disruptions"][lvl]} <span class="count">${l.length}</span></h2><ul class="group alerts" role="list">${l.map((a) => alertHTML(a)).join("")}</ul>`).join("")
        : `<p class="hint">${alerts.got ? "No service alerts right now." : "Checking for service alerts…"}</p>`}
      <p class="hint">From the agencies' live alert feeds, checked every few minutes${wsfOn() ? ", including Washington State Ferries bulletins" : ""}. Tap a route number to see it on the map.</p></div>`;
    const existing = body().querySelector(".alerts-view");
    const open = existing ? [...existing.querySelectorAll("details[open]")].map((d) => d.closest(".alert").querySelector(".al-title").textContent) : [];
    if (quiet && existing) existing.outerHTML = html; else setView(html);
    for (const d of body().querySelectorAll(".alerts-view details")) if (open.includes(d.querySelector(".al-title").textContent)) d.open = true;
    $("#back").addEventListener("click", () => { panelView = "home"; showHome(); });
    bindAlertList(body());
  }
  setInterval(() => { if (enabled.has("live")) pollAlerts(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollAlerts(); });
  const geoDist = (a, b) => { const [x0, y0] = toM(a[0], a[1]), [x1, y1] = toM(b[0], b[1]); return Math.hypot(x1 - x0, y1 - y0); };
  const geoBearing = (a, b) => { const [x0, y0] = toM(a[0], a[1]), [x1, y1] = toM(b[0], b[1]); return (Math.atan2(x1 - x0, y1 - y0) * 180 / Math.PI + 360) % 360; };
  function vehPos(v, now) {
    // glide from the last shown spot to the newest report across one polling interval,
    // so live vehicles keep moving between updates instead of jumping
    const t = Math.min(1, (now - v.t0) / POLL_MS);
    return [v.from[0] + (v.to[0] - v.from[0]) * t, v.from[1] + (v.to[1] - v.from[1]) * t];
  }
  async function pollLive() {
    if (!LIVE || !enabled.has("live") || document.hidden || live.polling || Date.now() < live.pauseUntil) return;
    live.polling = true;
    // One agency at a time, spaced out, so we stay well inside the API's rate limits;
    // if the server says "too many requests", stop and wait a minute.
    const res = [];
    // OneBusAway agencies, then agencies with their own open feed (Intercity Transit)
    // (ferries come from the REST feed, which says which route each boat is on)
    const restPos = new Set(LIVE.rest || []);
    // each round starts one agency further along, so if the API asks us to slow down part-way,
    // it isn't always the same agencies (the ferries, at the end) that miss out
    const ags = LIVE.agencies.slice(), turn = (live.round = (live.round || 0) + 1) % ags.length;
    const oba = ags.slice(turn).concat(ags.slice(0, turn));
    const sources = oba.map((a) => [a, restPos.has(a)
      ? `${LIVE.status}/${a}.json?key=${encodeURIComponent(LIVE.key)}&includeReferences=true`
      : `${LIVE.base}/${a}.pb?key=${encodeURIComponent(LIVE.key)}`, true, restPos.has(a)])
      .concat((LIVE.feeds || []).map((f) => [f.agency, f.url, false, false]));
    if (LIVE.wsf && wsfOn()) pollWsf(); // vessel details from WSF itself, when we have its access code
    let slowed = false;
    for (const [a, url, isOba, rest] of sources) {
      if (isOba && slowed) continue; // told to slow down: skip the rest of OneBusAway this round
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.status === 429 && isOba) { live.pauseUntil = Date.now() + 60000; slowed = true; continue; }
        if (!r.ok) throw new Error(String(r.status));
        let list;
        if (rest) {
          const j = await r.json();
          // OneBusAway's REST answers "too many requests" inside a normal response
          if (j && j.code === 429) { live.pauseUntil = Date.now() + 60000; slowed = true; continue; }
          list = restVehicles(a, j);
        } else list = parseVehicles(new Uint8Array(await r.arrayBuffer()));
        res.push({ status: "fulfilled", value: [a, list] });
      } catch (e) {
        res.push({ status: "rejected", reason: e });
      }
      await new Promise((ok) => setTimeout(ok, isOba ? 350 : 100));
    }
    // on time or late: one agency's vehicle status per round (King County Metro every other round)
    if (LIVE.status && Date.now() >= live.pauseUntil) {
      const order = LIVE.agencies.filter((a) => !(LIVE.rest || []).includes(a)).flatMap((a) => (a === "1" ? ["1"] : ["1", a]));
      const a = order[live.statusTurn++ % order.length];
      try {
        const r = await fetch(`${LIVE.status}/${a}.json?key=${encodeURIComponent(LIVE.key)}&includeReferences=false`, { cache: "no-store" });
        if (r.status === 429) live.pauseUntil = Date.now() + 60000;
        else if (r.ok) {
          const d = await r.json();
          for (const x of (d.data && d.data.list) || []) {
            const ts = x.tripStatus;
            if (!ts) continue;
            live.status.set(a + "_" + plainId(x.vehicleId), { dev: ts.scheduleDeviation, predicted: !!ts.predicted, upd: x.lastUpdateTime, got: Date.now(),
              occ: occCode(ts.occupancyStatus), occN: ts.occupancyCount, occCap: ts.occupancyCapacity });
          }
        }
      } catch (e) { /* status is a bonus; positions still work */ }
    }
    live.polling = false;
    const now = performance.now(), wall = Date.now() / 1000;
    let ok = 0;
    for (const x of res) {
      if (x.status !== "fulfilled") continue;
      ok++;
      const [a, list] = x.value, seen = new Set();
      live.fresh = live.fresh || {};
      live.fresh[a] = Date.now();
      for (const v of list) {
        try {
          if (!v.route || (v.ts && wall - v.ts > 300)) continue;
          const r = RTMAP.get(`${a}_${v.route}`);
          if (!r || LINEIDX[r.id] == null) continue;
          const id = `${a}_${v.id || v.trip}`, to = [v.lon, v.lat];
          seen.add(id);
          const prev = live.vehicles.get(id);
          // Washington State Ferries' boats go by name (OneBusAway's vehicle number is WSF's vessel id)
          const name = a === "95" && WSF_VESSELS[v.id] ? WSF_VESSELS[v.id] : "";
          if (prev) {
            const from = vehPos(prev, now), d = geoDist(from, to);
            const b = v.bearing != null && v.bearing > 0 ? v.bearing : d > 12 ? geoBearing(from, to) : prev.b;
            const occ = occCode(v.occ);
            Object.assign(prev, { from, to, t0: now, r, b, ts: v.ts, label: v.label || prev.label, vid: v.id, name, head: v.head || prev.head,
              occ: occ != null ? occ : prev.occ, occPct: v.occPct != null ? v.occPct : prev.occPct });
          } else {
            live.vehicles.set(id, { id, agency: a, from: to, to, t0: now, r, b: v.bearing > 0 ? v.bearing : -1, ts: v.ts, label: v.label, vid: v.id, name, head: v.head,
              occ: occCode(v.occ), occPct: v.occPct });
          }
        } catch (e) { /* one odd report doesn't stop the rest */ }
      }
      for (const [id, v] of live.vehicles) if (v.agency === a && !seen.has(id)) live.vehicles.delete(id);
    }
    // an agency we haven't heard from in three minutes: its vehicles are out of date, drop them
    for (const [id, v] of live.vehicles) if (live.fresh && Date.now() - (live.fresh[v.agency] || 0) > 180000) live.vehicles.delete(id);
    live.error = ok === 0;
    if (ok) live.last = Date.now();
    renderLive(now);
    animateLive();
    updateLiveUI();
  }
  // ---- timetable estimates: where each scheduled trip should be right now
  let SCHED = null;
  const PT_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  function pacificNow() {
    const now = new Date();
    const parts = Object.fromEntries(PT_FMT.formatToParts(now).map((p) => [p.type, p.value]));
    const key = (w) => (w === "Sat" ? "saturday" : w === "Sun" ? "sunday" : "weekday");
    const prev = { Mon: "Sun", Tue: "Mon", Wed: "Tue", Thu: "Wed", Fri: "Thu", Sat: "Fri", Sun: "Sat" }[parts.weekday];
    return { day: key(parts.weekday), prev: key(prev), secs: (+parts.hour % 24) * 3600 + +parts.minute * 60 + +parts.second + now.getMilliseconds() / 1000 };
  }
  async function loadSchedule() {
    try {
      const d = await fetch("data/schedule.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
      for (const p of d.patterns) { p.pts = p.c.map(([x, y]) => toM(x, y)); p.cum = cumLen(p.pts); p.route = ROUTES[p.r]; }
      SCHED = d;
      buildDepIndex();
      renderVehicles();
      updateLiveUI();
    } catch (e) { console.warn("timetable estimates unavailable", e); }
  }
  function estPos(p, frac) {
    const f = p.f, d = p.d;
    let k = 0;
    while (k < f.length - 2 && f[k + 1] <= frac) k++;
    const span = f[k + 1] - f[k], u = span > 0 ? Math.min(1, Math.max(0, (frac - f[k]) / span)) : 0;
    const dist = d[k] + (d[k + 1] - d[k]) * u;
    const c = p.cum, P = p.pts;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= dist) lo = mid; else hi = mid; }
    const t = Math.min(1, Math.max(0, (dist - c[lo]) / ((c[hi] - c[lo]) || 1)));
    const x = P[lo][0] + (P[hi][0] - P[lo][0]) * t, y = P[lo][1] + (P[hi][1] - P[lo][1]) * t;
    return { pos: [LON0 + x / KX, LAT0 + y / KY], b: (Math.atan2(P[hi][0] - P[lo][0], P[hi][1] - P[lo][1]) * 180 / Math.PI + 360) % 360 };
  }
  function estVehicles() {
    if (!SCHED) return [];
    const { day, prev, secs } = pacificNow(), out = [];
    const add = (list, t, tag) => {
      if (!list) return;
      for (let j = 0; j < list.length; j++) {
        const [pi, s0, du] = list[j];
        if (s0 > t) break;
        if (t > s0 + du) continue;
        const p = SCHED.patterns[pi], e = estPos(p, (t - s0) / du);
        out.push({ id: tag + j, r: p.route, pos: e.pos, b: e.b, est: true });
      }
    };
    add(SCHED.days[day], secs, "e");
    add(SCHED.days[prev], secs + 86400, "p"); // trips that started before midnight
    return out;
  }

  // ---- one renderer for both sources: live positions when the feed is working,
  //      timetable estimates otherwise (and always in the claude.ai preview)
  function vehMode() {
    if (LIVE && live.last && !live.error && Date.now() - live.last < 90000) return "live";
    return SCHED ? "est" : null;
  }
  function renderVehicles(now = performance.now()) {
    if (!map || !map.getSource("vehicles")) return;
    const mode = live.mode = vehMode();
    let list = [];
    if (!enabled.has("live")) list = [];
    else if (mode === "live") for (const v of live.vehicles.values()) list.push({ id: v.id, r: v.r, pos: vehPos(v, now), b: v.b, name: v.name });
    else if (mode === "est") list = estVehicles();
    live.current = list;
    const sel = selected && selected.type === "route" ? selected.id : null;
    // vehicles thin out as you zoom out, more than the lines do: hundreds of markers would cover
    // the map. Trains, RapidRide and boats always; frequent buses from 11.5; the rest from 12.5.
    const z = map.getZoom();
    const tier = Math.min(tierFor(z), z >= 12.5 ? 2 : z >= 11.5 ? 1 : 0);
    const feats = [];
    for (const v of list) {
      const r = v.r;
      if (!r || LINEIDX[r.id] == null) continue;
      if (sel ? sel !== r.id : (!enabledCat(r.cat) || CAT[dkey(r)].tier > tier)) continue;
      const c = tagColor(r);
      const [pos, b] = onLine(r, v.pos, v.b == null ? -1 : v.b);
      feats.push({ type: "Feature", properties: { id: v.id, r: r.id, c, tc: c, lab: v.name || shortLabel(r), b: Math.round(b), m: vehKind(r),
        s: 20 - CAT[dkey(r)].prio, est: v.est ? 1 : 0 }, geometry: { type: "Point", coordinates: pos } });
    }
    live.count = feats.length;
    map.getSource("vehicles").setData({ type: "FeatureCollection", features: feats });
  }
  const renderLive = renderVehicles;
  // Live positions are GPS fixes on the street; the map draws lines in lanes and simplified, so a
  // vehicle is moved onto its own route's line (the nearest point of that line, if it's close)
  // and turned to follow it.
  let vehIx = null, vehIxSel = null;
  function onLine(r, pos, b) {
    const i = LINEIDX[r.id], key = dkey(r);
    const sel = selected && selected.type === "route" && selected.id === r.id;
    const ix = sel ? (vehIxSel = vehIxSel || segIndex(lastSelFeats)) : (vehIx = vehIx || segIndex(lastFeats));
    const mpp = MPP0 / 2 ** map.getZoom();
    // a boat only ever sails its own lane, so it goes onto it from any distance (a position report
    // can be a long way off the drawn line, which put boats in open water); on land, only when close
    const reach = CAT[key].group === "water" ? 8000 : Math.max(40, 26 * mpp);
    const hit = nearestOn(ix, toM(pos[0], pos[1]), reach,
      sel ? null : (pr) => (pr.r >= 0 ? pr.r === i : pr.cat === key && EDGES[pr.e] && EDGES[pr.e].l.includes(i)));
    if (!hit) return [pos, b];
    let hb = (Math.atan2(hit.dir[0], hit.dir[1]) * 180 / Math.PI + 360) % 360;
    if (b >= 0) { const diff = Math.abs(((hb - b + 540) % 360) - 180); if (diff > 90) hb = (hb + 180) % 360; }
    return [toLonLat(hit.q), b >= 0 ? hb : b];
  }
  function animateLive() { /* the steady ticker below keeps vehicles moving */ }
  setInterval(() => { if (map && enabled.has("live") && !document.hidden && !map.isMoving()) renderVehicles(); }, 125);

  // "3 min late" / "On time" / "2 min early" for a live vehicle, when its agency predicts it
  function vehicleStatus(v) {
    const st = v && live.status.get(v.agency + "_" + plainId(v.vid));
    if (!st || !st.predicted || Date.now() - st.got > 10 * 60000) return null;
    const m = Math.round(Math.abs(st.dev) / 60);
    if (m === 0) return { text: "On time", cls: "ok" };
    return st.dev > 0 ? { text: `${m} min late`, cls: m >= 5 ? "late" : "slow" } : { text: `${m} min early`, cls: "early" };
  }
  // "Standing room only · 48 of 60" — how busy a vehicle is, from its own report if it carries
  // one, otherwise from its agency's status report. Riders' counts come only from the REST feed.
  function vehicleOccupancy(v) {
    if (!v) return null;
    const st = live.status.get(v.agency + "_" + plainId(v.vid));
    const fresh = st && Date.now() - st.got <= 10 * 60000 ? st : null;
    // through occCode again: whatever the caller hands us, only 0-6 can reach OCC_TEXT
    const code = occCode(v.occ != null ? v.occ : fresh && fresh.occ != null ? fresh.occ : null);
    if (code == null) return null;
    const n = fresh && fresh.occN, cap = fresh && fresh.occCap;
    const detail = n > 0 && cap > 0 ? `${n} of ${cap}` : v.occPct > 0 ? `${v.occPct}% full` : "";
    return { text: OCC_TEXT[code], cls: OCC_CLS[code], detail };
  }
  const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
  function updatedText(ts) {
    if (!ts) return "Live position";
    const age = Math.max(0, Math.round(Date.now() / 1000 - ts));
    return `Updated ${age < 60 ? age + " s" : Math.round(age / 60) + " min"} ago · ${CLOCK.format(new Date(ts * 1000))}`;
  }
  function vehicleLines(id, est) {
    if (est) return `<span class="vs-note">Estimated from the timetable</span>`;
    const v = live.vehicles.get(id), st = vehicleStatus(v);
    // the newest report for this vehicle: its position, or its agency's status report
    const raw = v && live.status.get(v.agency + "_" + plainId(v.vid));
    const ts = Math.max((v && v.ts) || 0, raw && raw.upd ? raw.upd / 1000 : 0);
    const oc = vehicleOccupancy(v);
    return `${st ? `<span class="vs vs-${st.cls}">${st.text}</span>` : ""}`
      + `${oc ? `<span class="vs vo-${oc.cls}">${esc(oc.text)}${oc.detail ? ` · ${esc(oc.detail)}` : ""}</span>` : ""}`
      + `<span class="vs-note">${esc(updatedText(ts))}</span>`;
  }

  function liveStatusText() {
    if (!enabled.has("live")) return "Buses, trains and ferries on the move";
    const mode = vehMode();
    if (mode === "live") {
      const sec = Math.round((Date.now() - live.last) / 1000);
      return `Live · ${live.count} running now · updated ${sec < 5 ? "just now" : sec + " s ago"}`;
    }
    if (mode === "est") {
      const why = !LIVE ? (MODE === "bundled" ? " (live positions on the website)" : " (live feed not set up)") : Date.now() < live.pauseUntil ? " (live feed busy)" : live.error ? " (live feed unreachable)" : "";
      return `Estimated from the timetable · ${live.count} running now${why}`;
    }
    return "Loading…";
  }
  function updateLiveUI() {
    const d = document.getElementById("liveDesc");
    if (d) d.textContent = liveStatusText();
    const chip = document.getElementById("liveChip");
    if (chip && selected && selected.type === "route") {
      const n = (live.current || []).filter((v) => v.r && v.r.id === selected.id).length;
      chip.hidden = !enabled.has("live") || !live.mode;
      chip.querySelector("span.n").textContent = (n === 0 ? "None running right now" : `${n} running now`) + (live.mode === "est" ? " (timetable)" : "");
    }
  }
  function startLive() {
    if (!LIVE || live.timer) return;
    pollLive();
    pollAlerts();
    live.timer = setInterval(pollLive, POLL_MS);
  }
  function stopLive() {
    clearInterval(live.timer);
    live.timer = 0;
    renderVehicles();
    updateLiveUI();
  }
  // A vehicle: a round badge in its line's color with a white symbol (bus, train, streetcar,
  // boat), and a separate pointer showing which way it's going.
  const VEH_PX = 36, VEH_R = 10;
  function vehGlyph(ctx, mode, color) {
    const fillW = () => { ctx.fillStyle = "#fff"; ctx.fill(); };
    const fillC = () => { ctx.fillStyle = color; ctx.fill(); };
    const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
    const dot = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); };
    const line = (pts, w) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const q of pts.slice(1)) ctx.lineTo(q[0], q[1]);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(); };
    if (mode === "bus") {
      rr(-0.62, -0.8, 1.24, 1.38, 0.24); fillW();
      rr(-0.46, -0.62, 0.92, 0.5, 0.08); fillC();
      dot(-0.31, 0.3, 0.09); fillC(); dot(0.31, 0.3, 0.09); fillC();
      rr(-0.52, 0.5, 0.26, 0.3, 0.06); fillW(); rr(0.26, 0.5, 0.26, 0.3, 0.06); fillW();
    } else if (mode === "rail" || mode === "tram") {
      const top = mode === "rail" ? -0.84 : -0.6;
      rr(-0.58, top, 1.16, 0.5 - top, mode === "rail" ? 0.36 : 0.22); fillW();
      rr(-0.42, top + 0.2, 0.84, 0.46, 0.1); fillC();
      dot(-0.27, 0.24, 0.085); fillC(); dot(0.27, 0.24, 0.085); fillC();
      line([[-0.3, 0.5], [-0.52, 0.88]], 0.13); line([[0.3, 0.5], [0.52, 0.88]], 0.13);
      if (mode === "tram") { line([[-0.28, -0.62], [0, -0.94], [0.28, -0.62]], 0.11); line([[-0.2, -0.94], [0.2, -0.94]], 0.11); }
    } else { // boat
      ctx.beginPath(); ctx.moveTo(-0.9, 0.02); ctx.lineTo(0.9, 0.02); ctx.lineTo(0.62, 0.5); ctx.lineTo(-0.62, 0.5); ctx.closePath(); fillW();
      rr(-0.52, -0.4, 0.94, 0.46, 0.08); fillW();
      for (const x of [-0.4, -0.13, 0.14]) { rr(x, -0.28, 0.19, 0.16, 0.04); fillC(); }
      rr(0.12, -0.74, 0.22, 0.4, 0.05); fillW();
      ctx.beginPath(); ctx.moveTo(-0.84, 0.74);
      for (let i = 0; i < 4; i++) { const x0 = -0.84 + i * 0.42; ctx.quadraticCurveTo(x0 + 0.105, 0.62, x0 + 0.21, 0.74); ctx.quadraticCurveTo(x0 + 0.315, 0.86, x0 + 0.42, 0.74); }
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 0.11; ctx.lineCap = "round"; ctx.stroke();
    }
  }
  function drawVehicle(id) {
    const [kind, color, mode] = id.split(":");
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const S = VEH_PX * dpr, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const ctx = cv.getContext("2d"), c = S / 2, R = VEH_R * dpr;
    if (kind === "vdir") {
      // a pointer just outside the badge's ring, at the top (the layer turns it to the heading)
      const tip = c - R - 6.5 * dpr, base = c - R + 1.5 * dpr, hw = 5.2 * dpr;
      ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 2.5 * dpr; ctx.shadowOffsetY = 0.8 * dpr;
      ctx.beginPath(); ctx.moveTo(c, tip - 1.6 * dpr); ctx.lineTo(c + hw + 1.6 * dpr, base); ctx.lineTo(c - hw - 1.6 * dpr, base); ctx.closePath();
      ctx.fillStyle = "#fff"; ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.beginPath(); ctx.moveTo(c, tip); ctx.lineTo(c + hw, base); ctx.lineTo(c - hw, base); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    } else {
      ctx.shadowColor = "rgba(0,0,0,.3)"; ctx.shadowBlur = 3.5 * dpr; ctx.shadowOffsetY = 1 * dpr;
      ctx.beginPath(); ctx.arc(c, c, R + 2 * dpr, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      ctx.save(); ctx.translate(c, c); ctx.scale(R * 0.6, R * 0.6);
      vehGlyph(ctx, mode || "bus", color);
      ctx.restore();
    }
    const d = ctx.getImageData(0, 0, S, S);
    if (!map.hasImage(id)) map.addImage(id, { width: S, height: S, data: d.data }, { pixelRatio: dpr });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && live.timer) pollLive(); });
  setInterval(updateLiveUI, 3000);

  // ---------------------------------------------------------------- selection
  const GROUPS = ["water", "bus", "rapid", "rail"];
  // ---------------------------------------------------------------- route stops on hover / selection
  // Stops of the route in focus: a soft glow (halo) and a white dot ringed in the route's color.
  // They appear together with a fade and a gentle spring (no sequence): see popIn.
  const END = ["case", [">", ["coalesce", ["get", "end"], 0], 0], 1.55, 1];
  const stopRadius = (mult, sc = 1) => { const k = THICK[settings.thickness] * mult * sc;
    return ["interpolate", ["linear"], ["zoom"], 9, ["*", 1.6 * k, END], 12, ["*", 3 * k, END], 15, ["*", 4.6 * k, END], 18, ["*", 7 * k, END]]; };
  const stopStroke = (mult, sc = 1) => { const k = THICK[settings.thickness] * Math.sqrt(mult) * sc;
    return ["interpolate", ["linear"], ["zoom"], 9, 1.2 * k, 14, 2.2 * k, 18, 3 * k]; };
  function stopGroup(prefix, src, P, mult = 1) {
    return [
      { id: `${prefix}-stops-halo`, type: "circle", source: src,
        paint: { "circle-radius": stopRadius(mult * 2.5), "circle-color": ["get", "c"], "circle-opacity": prefix === "hl" ? 0.3 : 0.2, "circle-blur": 0.85 } },
      { id: `${prefix}-stops`, type: "circle", source: src,
        paint: { "circle-radius": stopRadius(mult), "circle-color": P.stopFill, "circle-stroke-color": ["get", "c"],
          "circle-stroke-width": stopStroke(mult), "circle-pitch-alignment": "map" } },
    ];
  }
  const anims = {};
  function popIn(prefix, mult = 1) {
    cancelAnimationFrame(anims[prefix]);
    const halo = prefix === "hl" ? 0.3 : 0.2;
    const set = (sc, op) => {
      map.setPaintProperty(`${prefix}-stops`, "circle-radius", stopRadius(mult, sc));
      map.setPaintProperty(`${prefix}-stops`, "circle-stroke-width", stopStroke(mult, sc));
      map.setPaintProperty(`${prefix}-stops`, "circle-opacity", op);
      map.setPaintProperty(`${prefix}-stops`, "circle-stroke-opacity", op);
      map.setPaintProperty(`${prefix}-stops-halo`, "circle-radius", stopRadius(mult * 2.5, 0.6 + 0.4 * sc));
      map.setPaintProperty(`${prefix}-stops-halo`, "circle-opacity", halo * op);
    };
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) { set(1, 1); return; }
    const t0 = performance.now(), DUR = prefix === "hl" ? 420 : 560;
    const frame = (now) => {
      const t = Math.max(0, Math.min(1, (now - t0) / DUR)); // a frame can start just before t0
      // damped spring from 38% size: a slight overshoot (about 7%) and a soft settle
      const sc = t >= 1 ? 1 : 1 - 0.62 * Math.exp(-6.5 * t) * Math.cos(9.5 * t);
      const op = t >= 1 ? 1 : 1 - Math.pow(1 - Math.min(1, t / 0.55), 3);
      set(sc, op);
      if (t < 1) anims[prefix] = requestAnimationFrame(frame);
    };
    set(0.38, 0);
    anims[prefix] = requestAnimationFrame(frame);
  }
  function popOut(prefix, done) {
    cancelAnimationFrame(anims[prefix]);
    if (!map.getLayer(`${prefix}-stops`)) { done(); return; }
    const halo = prefix === "hl" ? 0.3 : 0.2, t0 = performance.now(), DUR = 160;
    const frame = (now) => {
      const t = Math.max(0, Math.min(1, (now - t0) / DUR)), op = 1 - t * t;
      map.setPaintProperty(`${prefix}-stops`, "circle-opacity", op);
      map.setPaintProperty(`${prefix}-stops`, "circle-stroke-opacity", op);
      map.setPaintProperty(`${prefix}-stops-halo`, "circle-opacity", halo * op);
      if (t < 1) anims[prefix] = requestAnimationFrame(frame);
      else done();
    };
    anims[prefix] = requestAnimationFrame(frame);
  }
  // stops of a route, each once: { id, name, lon, lat, end } (end: 2 last stop, 1 first stop)
  const stopCache = new Map();
  function routeStops(r) {
    if (stopCache.has(r.id)) return stopCache.get(r.id);
    const seen = new Map();
    for (const p of r.patterns || []) {
      const n = (p.stops || []).length;
      (p.stops || []).forEach((sid, i) => {
        const st = stopIndex[sid];
        if (!st) return;
        const key = st.key + "|" + st.lon, end = i === n - 1 ? 2 : i === 0 ? 1 : 0;
        const f = seen.get(key);
        if (f) { f.end = Math.max(f.end, end); return; }
        seen.set(key, { id: sid, name: st.name, lon: st.lon, lat: st.lat, end });
      });
    }
    const list = [...seen.values()];
    stopCache.set(r.id, list);
    return list;
  }
  function stopFeatures(routes, withEnds) {
    const color = keyColor(dkey(routes[0])), seen = new Map();
    for (const r of routes) {
      for (const st of routeStops(r)) {
        const k = st.lon + "," + st.lat;
        if (seen.has(k)) continue;
        seen.set(k, { type: "Feature", properties: { id: st.id, name: st.name, c: color, end: withEnds ? st.end : 0 },
          geometry: { type: "Point", coordinates: [st.lon, st.lat] } });
      }
    }
    return [...seen.values()];
  }
  const fc = (features) => ({ type: "FeatureCollection", features });
  const toLonLat = (q) => [LON0 + q[0] / KX, LAT0 + q[1] / KY];
  // The drawn lines (lon/lat) as segments in meters, in a grid for quick nearest-point lookups.
  // Loose ends: line ends that no other piece continues from (where the drawing stops).
  // how far point p (meters) is from line feature f's center (meters)
  function distTo(f, p) {
    const g = f.geometry, parts = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
    let best = Infinity;
    for (const cs of parts) {
      for (let k = 0; k + 1 < cs.length; k++) {
        const a = toM(cs[k][0], cs[k][1]), b = toM(cs[k + 1][0], cs[k + 1][1]);
        const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
        if (!L2) continue;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2));
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy));
      }
    }
    return best;
  }
  function segIndex(feats) {
    const cell = 160, grid = new Map(), segs = [], endCount = new Map();
    const ek = (c) => c[0].toFixed(6) + "," + c[1].toFixed(6);
    for (const f of feats) {
      const cs = f.geometry.coordinates;
      for (const c of [cs[0], cs[cs.length - 1]]) endCount.set(ek(c), (endCount.get(ek(c)) || 0) + 1);
      const P = cs.map(([x, y]) => toM(x, y));
      for (let i = 0; i < P.length - 1; i++) {
        const a = P[i], b = P[i + 1], n = segs.push([a, b, f.properties]) - 1;
        for (let gx = Math.floor(Math.min(a[0], b[0]) / cell); gx <= Math.floor(Math.max(a[0], b[0]) / cell); gx++)
          for (let gy = Math.floor(Math.min(a[1], b[1]) / cell); gy <= Math.floor(Math.max(a[1], b[1]) / cell); gy++) {
            const key = gx + "," + gy;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(n);
          }
      }
    }
    const loose = [];
    for (const f of feats) {
      const cs = f.geometry.coordinates;
      for (const c of [cs[0], cs[cs.length - 1]]) if (endCount.get(ek(c)) === 1) loose.push(toM(c[0], c[1]));
    }
    return { cell, grid, segs, loose };
  }
  function nearestOn(ix, p, maxD, accept) {
    let best = null, bd = maxD, dir = null, bp = null;
    const r = Math.ceil(maxD / ix.cell), gx = Math.floor(p[0] / ix.cell), gy = Math.floor(p[1] / ix.cell), seen = new Set();
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      for (const n of ix.grid.get((gx + dx) + "," + (gy + dy)) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        const [a, b, props] = ix.segs[n];
        if (accept && !accept(props)) continue;
        const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2));
        const q = [a[0] + t * vx, a[1] + t * vy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bd) { bd = d; best = q; dir = [vx, vy]; bp = props; }
      }
    }
    return best ? { q: best, d: bd, dir, props: bp } : null;
  }
  // Put stops onto the line drawn for their route, and leave out stops the drawn line doesn't
  // reach (beyond a loose end, or away from a highlighted stretch).
  function snapStops(stopFeats, lineFeats, mode) {
    if (!lineFeats || !lineFeats.length) return [];
    const ix = segIndex(lineFeats), mpp = MPP0 / 2 ** map.getZoom();
    // a selected route's own stops reach out further: where a one-way pair is drawn as one bundle,
    // the stops of the street that was folded into it sit a block away from the line
    const maxD = mode === "route" ? Math.max(140, 24 * mpp) : Math.max(30, 13 * mpp);
    const endTol = Math.max(20, 10 * mpp);
    const out = [];
    for (const f of stopFeats) {
      const p = toM(...f.geometry.coordinates);
      const hit = nearestOn(ix, p, maxD);
      if (!hit) continue;
      // snapped onto a loose end from well beyond it: the drawing doesn't get to this stop
      if (hit.d > endTol && ix.loose.some((e) => Math.hypot(e[0] - hit.q[0], e[1] - hit.q[1]) < 1)) continue;
      out.push({ ...f, geometry: { type: "Point", coordinates: toLonLat(hit.q) } });
    }
    return out;
  }
  let selStopsFor = null, hovStopsKey = "";
  // A stop usually comes as a pair, one on each side of the street (one per direction). On the
  // single line the map draws they land close together and read as double dots, so stops
  // within ~24 px (and 40 m) of each other along the line become one dot that stands for both.
  function mergeStops(feats) {
    const mpp = MPP0 / 2 ** map.getZoom(), d = Math.max(40, 24 * mpp), out = [];
    for (const f of feats) {
      const p = toM(...f.geometry.coordinates);
      const g = out.find((o) => Math.hypot(o.m[0] - p[0], o.m[1] - p[1]) < d);
      if (!g) { out.push({ m: p, n: 1, f: { ...f, properties: { ...f.properties, ids: f.properties.id } } }); continue; }
      g.m = [(g.m[0] * g.n + p[0]) / (g.n + 1), (g.m[1] * g.n + p[1]) / (g.n + 1)];
      g.n++;
      g.f.properties.ids += "," + f.properties.id;
      g.f.properties.end = Math.max(g.f.properties.end || 0, f.properties.end || 0);
    }
    return out.map((g) => ({ ...g.f, geometry: { type: "Point", coordinates: toLonLat(g.m) } }));
  }
  function setStops(prefix, stopFeats, lineFeats, mode, animate) {
    const src = map && map.getSource(prefix === "sel" ? "selstops" : "hoverstops");
    if (!src) return;
    src.setData(fc(lineFeats ? mergeStops(snapStops(stopFeats, lineFeats, mode)) : []));
    if (animate) popIn(prefix);
  }
  function showRouteStops(r) {
    cancelAnimationFrame(anims.sel);
    selStopsFor = null; // the next build (with this route's line) pops its stops in
    if (!r && map && map.getSource("selstops")) map.getSource("selstops").setData(fc([]));
  }
  // streetcar stations sit on the streetcar's drawn line (it runs in a lane beside the buses)
  function refreshStations() {
    const src = map && map.getSource("stations");
    if (!src) return;
    const data = stationsGeoJSON();
    // a selected streetcar is drawn down the middle of its street: its stations go there
    const selCar = selected && selected.type === "route" && RBY[selected.id] && RBY[selected.id].cat === "streetcar";
    const lines = (selCar ? lastSelFeats : lastFeats).filter((f) => f.properties.cat === "streetcar");
    if (lines.length) {
      const ix = segIndex(lines), maxD = Math.max(45, 24 * MPP0 / 2 ** map.getZoom());
      for (const f of data.features) {
        if (f.properties.snap !== "streetcar") continue;
        const hit = nearestOn(ix, toM(...f.geometry.coordinates), maxD);
        if (hit) f.geometry = { type: "Point", coordinates: toLonLat(hit.q) };
      }
    }
    src.setData(data);
  }
  // the stop under the pointer, drawn bigger on top
  let hlId = "";
  function highlightStop(f) {
    const src = map && map.getSource("stophl");
    if (!src) return;
    const id = f ? f.properties.id : "";
    if (id === hlId) return;
    hlId = id;
    if (!f) { cancelAnimationFrame(anims.hl); src.setData(fc([])); return; }
    const s = stopIndex[id], rs = s ? (s.routes || []).map((x) => RBY[x]).filter(Boolean).sort(tagOrder) : [];
    const c = f.properties.c || f.properties.stroke || (rs[0] ? keyColor(dkey(rs[0])) : BASE[theme].stopStroke);
    src.setData(fc([{ type: "Feature", properties: { id, c, end: 0 }, geometry: { type: "Point", coordinates: f.geometry.coordinates } }]));
    popIn("hl", 1.8);
  }

  // ---------------------------------------------------------------- next departures at a stop
  // From the timetable: each pattern lists its stops (s) and when along the trip each is reached
  // (f, a share of the trip's duration), so a stop's departures are start + f * duration.
  let DEP = null;
  function buildDepIndex() {
    DEP = new Map();
    SCHED.patterns.forEach((p, pi) => (p.s || []).forEach((sid, i) => {
      const st = stopIndex[sid], k = st ? st.key : sid;
      if (!DEP.has(k)) DEP.set(k, []);
      DEP.get(k).push([pi, i]);
    }));
    SCHED.byPat = {};
    for (const [day, trips] of Object.entries(SCHED.days)) {
      const m = new Map();
      for (const [pi, s0, du] of trips) { if (!m.has(pi)) m.set(pi, []); m.get(pi).push([s0, du]); }
      SCHED.byPat[day] = m;
    }
  }
  function nextDepartures(keys, limit = 4, windowS = 5400) {
    if (!SCHED || !DEP) return null;
    const now = pacificNow(), out = [];
    for (const k of keys) {
      for (const [pi, i] of DEP.get(k) || []) {
        const p = SCHED.patterns[pi];
        if (!p.f || i >= p.f.length - 1) continue; // the end of the line: buses arrive, they don't leave
        for (const [day, off] of [[now.day, 0], [now.prev, 86400]]) {
          for (const [s0, du] of (SCHED.byPat[day] && SCHED.byPat[day].get(pi)) || []) {
            const t = s0 + p.f[i] * du - off - now.secs;
            if (t < -20 || t > windowS) continue;
            const r = ROUTES[p.r], to = p.s[p.s.length - 1];
            out.push({ t, r, to, key: r.id + "|" + placeName(to) });
          }
        }
      }
    }
    // the same bus listed twice (overlapping service calendars, twin patterns): keep one
    out.sort((a, b) => a.t - b.t);
    const last = new Map(), res = [];
    for (const d of out) {
      if (last.has(d.key) && d.t - last.get(d.key) < 150) continue;
      last.set(d.key, d.t);
      res.push(d);
      if (res.length >= limit) break;
    }
    return res;
  }
  const placeName = (sid) => ((stopIndex[sid] && stopIndex[sid].name) || "").replace(/\s*[-–]\s*Bay\s*\w+$/i, "").replace(/\s+Bay\s+\w+$/i, "");

  // ---------------------------------------------------------------- real departures
  // The timetable above answers the moment a rider points at a stop and is always there.
  // This asks OneBusAway what the agency actually predicts for that stop and, when an answer
  // comes back, puts those times in its place. It keeps its own rate-limit pause, so a busy
  // departures call never stops the buses on the map from moving.
  const depCache = { byStop: new Map(), pause: 0, inflight: new Set(), timer: 0 };
  const DEP_FRESH = 30000;    // a stop's predictions are worth reusing for half a minute
  const DEP_MAX_STOPS = 4;    // a station gathers many platforms; ask about the first few
  const DEP_WAIT = 220;       // let the pointer settle before asking about a stop
  // "kcm-75403" is OneBusAway's "1_75403": the same stop, the agency named a different way
  function obaStop(id) {
    const i = String(id || "").indexOf("-");
    if (i < 0) return null;
    const a = LIVE && LIVE.stopAgency && LIVE.stopAgency[id.slice(0, i)];
    return a ? `${a}_${id.slice(i + 1)}` : null;
  }
  const obaStopsFor = (ids) => [...new Set(ids.map(obaStop).filter(Boolean))].slice(0, DEP_MAX_STOPS);
  const tidyHeadsign = (s) => String(s || "").replace(/\s+/g, " ").trim();
  function readDeparture(x) {
    if (x.departureEnabled === false) return null;  // the end of the line: buses arrive, they don't leave
    const at = x.predictedDepartureTime > 0 ? x.predictedDepartureTime : x.scheduledDepartureTime;
    const r = RTMAP.get(x.routeId);
    if (!at || !r || LINEIDX[r.id] == null) return null;
    return { at, r, toName: tidyHeadsign(x.tripHeadsign), live: !!(x.predicted && x.predictedDepartureTime > 0),
      occ: occCode(x.occupancyStatus != null ? x.occupancyStatus : x.predictedOccupancy) };
  }
  async function loadStopDepartures(obaId) {
    try {
      // no includeReferences=false here: on this server it makes the answer a bare "null"
      const r = await fetch(`${LIVE.deps}/${encodeURIComponent(obaId)}.json?key=${encodeURIComponent(LIVE.key)}`
        + "&minutesBefore=0&minutesAfter=90", { cache: "no-store" });
      if (r.status === 429) { depCache.pause = Date.now() + 60000; return; }
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (j && j.code === 429) { depCache.pause = Date.now() + 60000; return; }
      // anything that isn't a proper answer is "no answer" (the timetable stays), never "no departures"
      if (!j || j.code !== 200 || !j.data || !j.data.entry || !Array.isArray(j.data.entry.arrivalsAndDepartures)) throw new Error("no answer");
      depCache.byStop.set(obaId, { got: Date.now(), list: j.data.entry.arrivalsAndDepartures.map(readDeparture).filter(Boolean) });
    } catch (e) {
      // the timetable still answers; don't ask again for this stop straight away
      depCache.byStop.set(obaId, { got: Date.now(), list: null });
    } finally {
      depCache.inflight.delete(obaId);
    }
  }
  // ask about the stop under the pointer, once it has settled there
  function ensureDepartures(stopIds, onReady) {
    clearTimeout(depCache.timer);
    if (!LIVE || !LIVE.deps || Date.now() < depCache.pause) return;
    const ids = obaStopsFor(stopIds);
    const stale = ids.filter((id) => !depCache.inflight.has(id)
      && (!depCache.byStop.has(id) || Date.now() - depCache.byStop.get(id).got > DEP_FRESH));
    if (!stale.length) return;
    depCache.timer = setTimeout(() => {
      for (const id of stale) depCache.inflight.add(id);
      Promise.all(stale.map(loadStopDepartures)).then(() => onReady && onReady());
    }, DEP_WAIT);
  }
  // what we've been told about this stop, or null if we haven't been told anything yet
  function liveDepartures(stopIds, limit = 4) {
    if (!LIVE || !LIVE.deps) return null;
    const now = Date.now();
    let told = false, all = [];
    for (const id of obaStopsFor(stopIds)) {
      const e = depCache.byStop.get(id);
      if (!e || !e.list) continue;
      told = true;
      all = all.concat(e.list);
    }
    if (!told) return null;
    all = all.filter((d) => d.at - now > -30000).sort((a, b) => a.at - b.at);
    // one bus listed at two platforms of the same station: keep one
    const last = new Map(), res = [];
    for (const d of all) {
      const k = d.r.id + "|" + d.toName;
      if (last.has(k) && d.at - last.get(k) < 150000) continue;
      last.set(k, d.at);
      res.push({ t: (d.at - now) / 1000, r: d.r, toName: d.toName, live: d.live, occ: d.occ });
      if (res.length >= limit) break;
    }
    return res;
  }
  const depMinutes = (t) => (t < 60 ? "now" : Math.round(t / 60) + " min");
  function depRowsHTML(keys, stopIds) {
    const live = liveDepartures(stopIds), sched = nextDepartures(keys);
    // the agency's own answer wins, but an empty one never hides a timetable that has something
    const useLive = !!(live && live.length), list = useLive ? live : sched;
    if (!list) return "";
    if (!list.length) return `<div class="sc-foot">No departures in the next 90 minutes</div>`;
    const rows = list.map((d) => {
      const to = useLive ? d.toName : placeName(d.to);
      const dot = useLive && d.live ? `<span class="sc-live" aria-hidden="true"></span>` : "";
      const occ = useLive && d.occ != null
        ? `<span class="sc-occ vo-${OCC_CLS[d.occ]}" role="img" aria-label="${esc(OCC_TEXT[d.occ])}" title="${esc(OCC_TEXT[d.occ])}">${occMeter(d.occ)}</span>` : "<span></span>";
      return `<div class="sc-row">${badgeHTML(d.r)}<span class="sc-to">${esc(to)}</span>${occ}<span class="sc-t">${dot}${depMinutes(d.t)}</span></div>`;
    }).join("");
    const foot = useLive ? (list.some((d) => d.live) ? "Next departures, live from the agency" : "Next departures, from the agency's schedule")
      : "Next departures, from the timetable";
    return `<div class="sc-next">${rows}</div><div class="sc-foot">${foot}</div>`;
  }
  // the answer arrived while the card is still up: put the real times in place
  function repaintStopDeps(key, keys, stopIds) {
    if (tipKey !== key) return;
    const box = document.getElementById("scDeps");
    if (box) box.innerHTML = depRowsHTML(keys, stopIds);
  }
  function stopCard(id, end, ids) {
    const all = (ids ? String(ids).split(",") : [id]).map((x) => stopIndex[x]).filter(Boolean);
    const s = all[0];
    if (!s) return "";
    const rs = [...new Set(all.flatMap((x) => x.routes || []))].map((x) => RBY[x]).filter((r) => r && LINEIDX[r.id] != null).sort(tagOrder);
    const keys = [...new Set(all.flatMap((x) => [x.key, ...((x.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))]))];
    const stopIds = [...new Set(all.flatMap(stopIdsOf))];
    const codes = [...new Set(all.map((x) => x.code).filter(Boolean))];
    const kind = s.kind === "stop" ? (codes.length > 1 ? `Stops ${esc(codes.join(" & "))}` : codes.length ? `Stop ${esc(codes[0])}` : "Bus stop") : "Station";
    let h = `<div class="sc"><div class="sc-name">${esc(s.name)}</div><div class="sc-sub">${kind} · ${rs.length} route${rs.length === 1 ? "" : "s"}${end === 2 ? " · <b>End of the line</b>" : end === 1 ? " · <b>Trips start here</b>" : ""}</div>`;
    if (rs.length) h += `<div class="sc-badges">${rs.slice(0, 10).map((r) => badgeHTML(r)).join("")}${rs.length > 10 ? `<span class="sc-more">+${rs.length - 10}</span>` : ""}</div>`;
    h += alertTeaser(stopAlerts(stopIds));
    h += `<div id="scDeps">${depRowsHTML(keys, stopIds)}</div>`;
    // the timetable is on screen already; ask the agency what it actually predicts
    ensureDepartures(stopIds, () => repaintStopDeps(`stop:${id}:${end}`, keys, stopIds));
    return h + "</div>";
  }

  // one-way arrow: a small chevron in the line's color with a white edge
  function drawArrow(id) {
    const color = id.slice(4);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const w = 14 * dpr, h = 12 * dpr, cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const path = () => { ctx.beginPath(); ctx.moveTo(3 * dpr, 2.5 * dpr); ctx.lineTo(10.5 * dpr, 6 * dpr); ctx.lineTo(3 * dpr, 9.5 * dpr); };
    path(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 4.2 * dpr; ctx.stroke();
    path(); ctx.strokeStyle = color; ctx.lineWidth = 2.2 * dpr; ctx.stroke();
    const d = ctx.getImageData(0, 0, w, h);
    if (!map.hasImage(id)) map.addImage(id, { width: w, height: h, data: d.data }, { pixelRatio: dpr });
  }

  // after a display setting changes: stops and stations follow the line thickness too
  function restyleStops() {
    if (!map) return;
    for (const L of transitLayers(BASE[theme])) {
      if (L.type !== "line" || !map.getLayer(L.id) || !L.paint["line-width"]) continue;
      map.setPaintProperty(L.id, "line-width", L.paint["line-width"]);
    }
    for (const L of stopLayers(BASE[theme])) {
      if (!map.getLayer(L.id) || L.type !== "circle") continue;
      for (const [k, v] of Object.entries(L.paint || {})) map.setPaintProperty(L.id, k, v);
    }
  }

  // Fade the network back (level < 1) so one route stands out; 1 restores it.
  let netDim = 1;
  function setNetDim(level) {
    if (!map || !map.getLayer("line-bus") || level === netDim) return;
    netDim = level;
    for (const L of transitLayers(BASE[theme])) {
      if (L.source !== "net" || L.type !== "line") continue;
      const base = L.paint["line-opacity"] != null ? L.paint["line-opacity"] : 1;
      map.setPaintProperty(L.id, "line-opacity", level === 1 ? base : typeof base === "number" ? base * level : ["*", base, level]);
    }
    map.setPaintProperty("badges", "icon-opacity", level === 1 ? 1 : Math.max(0.12, level * 0.6));
  }
  function applySelectionStyle() {
    if (!map || !map.getLayer("line-bus")) return;
    const dim = !!(selected && selected.type === "route");
    for (const g of GROUPS) {
      for (const id of [`glass-${g}`, `center-${g}`, `dots-${g}`, `ties-${g}`]) map.setLayoutProperty(id, "visibility", dim ? "none" : "visible");
      for (const id of [`case-${g}`, `shadow-${g}`]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", dim ? "none" : "visible");
    }
    setNetDim(dim ? 0.2 : 1);
    // the selected route shows its own arrows; the faded network's would only be noise
    if (map.getLayer("arrows")) map.setLayoutProperty("arrows", "visibility", dim ? "none" : "visible");
  }
  function setHash(h) {
    try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch { /* sandboxed */ }
  }
  function selectRoute(id, { fit = true } = {}) {
    const r = RBY[id];
    if (!r) return;
    selected = { type: "route", id };
    setHash("route-" + id);
    rebuild();
    applySelectionStyle();
    showRouteStops(r);
    showRoute(r);
    renderLive();
    if (fit && r.bbox && r.bbox[0] < 180) map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: fitPadding(), maxZoom: 15, duration: 800 });
  }
  function selectStop(id, { fly = true } = {}) {
    const s = stopIndex[id];
    if (!s) return;
    selected = { type: s.kind === "stop" ? "stop" : "station", id };
    setHash((s.kind === "stop" ? "stop-" : "station-") + id);
    rebuild();
    applySelectionStyle();
    showRouteStops(null);
    showStop(s);
    if (fly) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), s.kind === "stop" ? 16 : 14.5), padding: fitPadding(), duration: 800 });
  }
  function clearSelection() {
    selected = null;
    setHash("");
    closePopup();
    rebuild();
    applySelectionStyle();
    showRouteStops(null);
    showHome();
    renderLive();
  }
  function fitPadding() {
    return isNarrow() ? { top: 70, bottom: Math.round(window.innerHeight * 0.52), left: 30, right: 70 }
      : { top: 50, bottom: 50, left: 384 + 70, right: 80 };
  }

  // ---------------------------------------------------------------- panel views
  const body = () => $("#panelBody");
  function setView(html) {
    const b = body();
    b.innerHTML = `<div class="view">${html}</div>`;
    b.scrollTop = 0;
  }
  const feedText = () => Object.keys(META.feeds).join(", ");
  // Filter bar (under search, on every panel page): one chip per kind of service. A chip turns
  // its whole group off, and back on to how it was (or to the defaults).
  const FILTERS = [
    { key: "Trains", label: "Trains", color: () => LINE[theme].link },
    { key: "Buses", label: "Buses", color: () => LINE[theme].frequent },
    { key: "On the water", label: "Ferries", color: () => LINE[theme].ferry },
    { key: "On demand", label: "On demand", color: () => FLEX[theme] },
  ];
  const filterMemory = {};
  function renderFilterBar() {
    const bar = $("#filterBar");
    if (!bar) return;
    bar.innerHTML = FILTERS.map((f) => {
      const grp = LAYER_GROUPS.find((g) => g.title === f.key);
      const on = grp.items.some((l) => enabled.has(l.key));
      return `<button type="button" class="fchip${on ? " on" : ""}" data-f="${esc(f.key)}" aria-pressed="${on}"><span class="dot" style="background:${f.color()}"></span>${esc(f.label)}</button>`;
    }).join("");
    for (const b of bar.querySelectorAll(".fchip")) b.addEventListener("click", () => {
      const grp = LAYER_GROUPS.find((g) => g.title === b.dataset.f);
      const onNow = grp.items.filter((l) => enabled.has(l.key)).map((l) => l.key);
      if (onNow.length) {
        filterMemory[grp.title] = onNow;
        onNow.forEach((k) => enabled.delete(k));
      } else {
        const back = filterMemory[grp.title] || grp.items.filter((l) => l.on).map((l) => l.key);
        (back.length ? back : grp.items.map((l) => l.key)).forEach((k) => enabled.add(k));
      }
      store.set("layers2", [...enabled]);
      applyLayerToggles();
      if (!selected) showHome(true);
    });
  }

  // Home is deliberately small: what's moving, what the lines mean, and one way in to the
  // full set of switches ("Layers"). Everything advanced lives on the Layers page.
  let panelView = "home";
  const KEY_NAME = {
    link: "Link light rail", rail: "Sounder & Amtrak", streetcar: "Streetcar", monorail: "Monorail",
    rapid: "RapidRide & Swift", frequent: "Frequent bus", local: "All-day bus", peak: "Rush-hour bus",
    water: "Ferries & Water Taxi", dart: "Dial-a-Ride area", flex: "Metro Flex zone", access: "Access area",
  };
  const isDefaultLayers = () => LAYERS.every((l) => enabled.has(l.key) === l.on)
    && Object.keys(SETTINGS_DEFAULT).every((k) => settings[k] === SETTINGS_DEFAULT[k]);
  const SETTING_ROWS = [
    { key: "busDetail", name: "Bus lines when zoomed out", opts: [["less", "Fewer"], ["normal", "Some"], ["more", "All"]] },
    { key: "tags", name: "Route numbers", opts: [["fewer", "Fewer"], ["normal", "Normal"], ["more", "More"]] },
    { key: "thickness", name: "Line thickness", opts: [["thin", "Thin"], ["normal", "Normal"], ["bold", "Bold"]] },
    { key: "theme", name: "Appearance", opts: [["", "Auto"], ["light", "Light"], ["dark", "Dark"]] },
  ];
  const settingValue = (key) => (key === "theme" ? document.documentElement.getAttribute("data-theme") || "" : settings[key]);
  function placeThumb(seg, i, animate) {
    const thumb = seg.querySelector(".seg-thumb");
    const n = seg.querySelectorAll("button").length;
    thumb.style.width = `calc(${100 / n}% - 4px)`;
    if (animate && thumb.style.transform !== `translateX(${i * 100}%)`) {
      thumb.classList.remove("moving"); void thumb.offsetWidth; thumb.classList.add("moving");
    }
    thumb.style.transform = `translateX(${i * 100}%)`;
  }
  function showHome(quiet) {
    if (panelView === "layers") return showLayers(quiet);
    if (panelView === "alerts") return showAlerts(quiet);
    const shown = LAYERS.filter((l) => enabled.has(l.key)).length;
    const nAl = alerts.list.length, worst = nAl ? alerts.list[0].level : 0;
    const nStop = alerts.list.filter((a) => a.level === 2).length, nChg = alerts.list.filter((a) => a.level === 1).length;
    const alertRow = !LIVE ? "" : `<li><button class="row nav-row" id="openAlerts" type="button">
        <span class="icon al-row-ic">${alertIcon(nAl ? worst : 0)}</span>
        <span class="txt"><span class="name">Service alerts${nAl ? `<span class="count">${nAl}</span>` : ""}</span><span class="desc">${!alerts.got ? "Checking…" : !nAl ? "None right now"
          : [nStop ? `${nStop} disruption${nStop === 1 ? "" : "s"}` : "", nChg ? `${nChg} service change${nChg === 1 ? "" : "s"}` : "", nAl - nStop - nChg ? `${nAl - nStop - nChg} notice${nAl - nStop - nChg === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}</span></span>
        <svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button></li>`;
    const keys = LAYERS.filter((l) => KEY_NAME[l.key] && enabled.has(l.key));
    const live = enabled.has("live");
    const html = `<div class="home-view">
      <p class="live-line${live ? "" : " off"}"><span class="pulse" aria-hidden="true"></span><span${live ? ' id="liveDesc"' : ""}>${live ? esc(liveStatusText()) : "Vehicles are hidden"}</span></p>
      <ul class="group" role="list"><li><button class="row nav-row" id="openLayers" type="button">
        <span class="icon"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M15 7 25 12 15 17 5 12Z" fill="var(--accent)" opacity=".9"/><path d="M6.5 16.3 15 20.5l8.5-4.2" stroke="var(--accent)" stroke-width="1.8" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity=".55"/></svg></span>
        <span class="txt"><span class="name">Layers</span><span class="desc">${shown} of ${LAYERS.length} shown${isDefaultLayers() ? "" : " · customized"}</span></span>
        <svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button></li>${alertRow}</ul>
      ${keys.length ? `<h2 class="section">On the map</h2><ul class="key-grid" role="list">${keys.map((l) =>
        `<li><span class="sw">${swatch(l)}</span><span>${esc(KEY_NAME[l.key])}</span></li>`).join("")}</ul>`
        : `<p class="hint">Every layer is off. Turn some on in Layers.</p>`}
      <p class="hint">Tap a line to see its routes, or a stop to see what serves it.</p>
    </div>`;
    const existing = body().querySelector(".home-view");
    if (quiet && existing) existing.outerHTML = html;
    else setView(html);
    $("#openLayers").addEventListener("click", () => { panelView = "layers"; showLayers(); openSheet("half"); });
    const oa = $("#openAlerts");
    if (oa) oa.addEventListener("click", () => { panelView = "alerts"; showAlerts(); openSheet("half"); });
  }
  const layersHead = () => `<h2 class="view-title">Layers</h2>${isDefaultLayers() ? "" : `<button class="text-btn" id="resetLayers" type="button">Reset</button>`}`;
  function bindReset() {
    const b = $("#resetLayers");
    if (!b) return;
    b.addEventListener("click", () => {
      enabled.clear();
      for (const l of LAYERS) if (l.on) enabled.add(l.key);
      Object.assign(settings, SETTINGS_DEFAULT);
      restyleStops();
      store.set("layers2", [...enabled]);
      store.set("settings", settings);
      applyLayerToggles();
      renderLive();
      showLayers(true);
    });
  }
  function showLayers(quiet) {
    const parts = [`<button class="back press" id="back" type="button"><svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2 2 10l8 8" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>Map</button>
      <div class="view-head">${layersHead()}</div>`];
    for (const grp of LAYER_GROUPS) {
      parts.push(`<h2 class="section">${esc(grp.title)}</h2><ul class="group" role="list">`);
      for (const l of grp.items) {
        const count = l.cats.length ? ROUTES.filter((r) => l.cats.includes(r.cat) && LINEIDX[r.id] != null).length : null;
        const on = enabled.has(l.key);
        parts.push(`<li class="row layer${on ? "" : " off"}" data-key="${l.key}">
          <span class="icon">${swatch(l)}</span>
          <span class="txt"><span class="name">${esc(l.name)}${count ? `<span class="count">${count}</span>` : ""}</span><span class="desc"${l.key === "live" ? ' id="liveDesc"' : ""}>${esc(l.key === "live" ? liveStatusText() : l.desc)}</span></span>
          <label class="switch"><input type="checkbox" id="lyr-${l.key}" ${on ? "checked" : ""} aria-label="Show ${esc(l.name)}"><span class="track"><span class="knob"></span></span></label>
        </li>`);
      }
      parts.push(`</ul>`);
    }
    parts.push(`<h2 class="section">Display</h2><ul class="group settings" role="list">${SETTING_ROWS.map((r) => {
      const cur = settingValue(r.key);
      return `<li data-s="${r.key}"><span class="sname" id="s-${r.key}">${esc(r.name)}</span><div class="segmented" role="radiogroup" aria-labelledby="s-${r.key}">${r.opts.map(([v, t]) =>
        `<button type="button" role="radio" data-v="${v}" aria-checked="${v === cur}" aria-selected="${v === cur}">${esc(t)}</button>`).join("")}<span class="seg-thumb" aria-hidden="true"></span></div></li>`;
    }).join("")}</ul>`);
    parts.push(`<p class="hint">Streets are drawn as service lines: one green line for all the frequent buses on a street, one blue line for the all-day buses, and so on, with the route numbers on tags.</p>
      <p class="credits">Routes and schedules from the agencies' open GTFS feeds (${esc(feedText())}). DART areas from King County GIS; Metro Flex zones from King County Metro. Base map © OpenStreetMap contributors via OpenFreeMap.</p>`);
    const existing = body().querySelector(".layers-view");
    if (quiet && existing) existing.innerHTML = parts.join("");
    else setView(`<div class="layers-view">${parts.join("")}</div>`);
    $("#back").addEventListener("click", () => { panelView = "home"; showHome(); });
    bindReset();
    for (const li of body().querySelectorAll(".settings > li")) {
      const seg = li.querySelector(".segmented"), key = li.dataset.s;
      const buttons = [...seg.querySelectorAll("button")];
      placeThumb(seg, Math.max(0, buttons.findIndex((b) => b.dataset.v === settingValue(key))), false);
      buttons.forEach((b, i) => b.addEventListener("click", () => {
        buttons.forEach((x) => { x.setAttribute("aria-checked", String(x === b)); x.setAttribute("aria-selected", String(x === b)); });
        placeThumb(seg, i, true);
        if (key === "theme") {
          if (b.dataset.v) document.documentElement.setAttribute("data-theme", b.dataset.v);
          else document.documentElement.removeAttribute("data-theme");
          store.set("theme", b.dataset.v);
          return;
        }
        settings[key] = b.dataset.v;
        store.set("settings", settings);
        rebuild();
        restyleStops();
        renderLive();
        body().querySelector(".view-head").innerHTML = layersHead();
        bindReset();
      }));
    }
    for (const li of body().querySelectorAll(".layer")) {
      const input = li.querySelector("input");
      const toggle = (v) => {
        const key = li.dataset.key;
        if (v) enabled.add(key); else enabled.delete(key);
        li.classList.toggle("off", !v);
        input.checked = v;
        store.set("layers2", [...enabled]);
        applyLayerToggles();
        body().querySelector(".view-head").innerHTML = layersHead();
        bindReset();
      };
      input.addEventListener("change", () => toggle(input.checked));
      li.addEventListener("click", (e) => { if (!e.target.closest(".switch")) toggle(!input.checked); });
    }
  }
  function swatch(l) {
    const P = LINE[theme];
    const tube = (c, w, y, kind) => {
      const d = `M6 ${y} H24`;
      let s = `<path d="${d}" stroke="${c}" stroke-width="${w}" stroke-linecap="round" fill="none"${kind === "dash" ? ' stroke-dasharray="3.5 2.5"' : ""}/>`;
      if (kind === "glass") s += `<path d="${d}" stroke="#fff" stroke-opacity=".45" stroke-width="${(w * 0.34).toFixed(2)}" stroke-linecap="round" fill="none"/>`;
      if (kind === "solid") s += `<path d="${d}" stroke="#fff" stroke-width="${(w * 0.3).toFixed(2)}" stroke-linecap="round" fill="none"/>`;
      if (kind === "dots") s += `<path d="${d}" stroke="#fff" stroke-width="${(w * 0.34).toFixed(2)}" stroke-linecap="round" stroke-dasharray="0.1 3.4" fill="none"/>`;
      if (kind === "ties") s += `<path d="${d}" stroke="#fff" stroke-width="${(w * 0.6).toFixed(2)}" stroke-dasharray="2 2.5" fill="none"/>`;
      return s;
    };
    const one = {
      link: [P.link1, 6, "solid"], rail: [P.sounder, 5, "ties"], streetcar: [P.streetcar, 4.6, "solid"], monorail: [P.monorail, 4.6, "solid"],
      rapid: [P.rapidride, 5.4, "dots"], frequent: [P.frequent, 5, "glass"], local: [P.local, 3.8, "glass"], peak: [P.peak, 2.4, ""],
      water: [P.ferry, 3.2, "dash"], dart: [P.dart, 3, "dash"],
    }[l.key];
    if (one) return `<svg viewBox="0 0 30 30" aria-hidden="true">${tube(one[0], one[1], 15, one[2])}</svg>`;
    if (l.key === "flex") return `<svg viewBox="0 0 30 30" aria-hidden="true"><rect x="5" y="7" width="20" height="16" rx="4" fill="${FLEX[theme]}" fill-opacity="0.18" stroke="${FLEX[theme]}" stroke-width="2"/></svg>`;
    if (l.key === "access") return `<svg viewBox="0 0 30 30" aria-hidden="true"><rect x="6" y="8" width="18" height="14" rx="4" fill="#7b5cc4" fill-opacity=".18" stroke="#7b5cc4" stroke-width="1.4" stroke-dasharray="3 2"/></svg>`;
    if (l.key === "live") return `<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="9" fill="${P.frequent}" opacity=".18"/><path d="M15 7.5 L20.5 19.5 L15 16.8 L9.5 19.5 Z" fill="${P.frequent}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    if (l.key === "stops") return `<svg viewBox="0 0 30 30" aria-hidden="true">${tube(P.frequent, 4, 15, "glass")}<circle cx="11" cy="15" r="3.2" fill="#fff" stroke="#8e8e93" stroke-width="1.5"/><circle cx="20" cy="15" r="3.2" fill="#fff" stroke="#8e8e93" stroke-width="1.5"/></svg>`;
    return `<svg viewBox="0 0 30 30"></svg>`;
  }

  const fmtH = (h) => { const hh = h % 24; return `${hh % 12 || 12}${hh < 12 ? "a" : "p"}`; };
  function scheduleTable(r) {
    const days = [["weekday", "Weekday"], ["saturday", "Sat"], ["sunday", "Sun"]];
    const cell = (d, k) => {
      const s = r.sched[d];
      if (!s) return `<td class="none">—</td>`;
      const n = s[k + "_n"];
      if (!n) return `<td class="none">—</td>`;
      if (n <= 2) return `<td>${n} trip${n > 1 ? "s" : ""}</td>`;
      return `<td class="${s[k] <= 15 ? "good" : ""}">${s[k]} min</td>`;
    };
    const rows = META.periods.map(([k, label, h0, h1]) =>
      `<tr><th scope="row">${esc(label)}<small>${fmtH(h0)}–${fmtH(h1)}</small></th>${days.map(([d]) => cell(d, k)).join("")}</tr>`).join("");
    const span = days.map(([d]) => {
      const s = r.sched[d];
      if (!s) return `<td class="none">No service</td>`;
      if (s.span_h >= 22) return `<td>24 hours</td>`;
      return `<td>${s.first.replace(" ", " ")}<br>${s.last.replace(" ", " ")}</td>`;
    }).join("");
    return `<div class="group table-group"><table class="sched"><thead><tr><th></th>${days.map(([, l]) => `<th scope="col">${l}</th>`).join("")}</tr></thead>
      <tbody>${rows}<tr><th scope="row">First / last</th>${span}</tr></tbody></table></div>`;
  }
  const dayLabel = () => {
    const d = META.days;
    const f = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `Wed ${f(d.weekday)}, Sat ${f(d.saturday)} and Sun ${f(d.sunday)}, ${d.weekday.slice(0, 4)}`;
  };
  const backBtn = `<button class="back press" id="back" type="button"><svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2 2 10l8 8" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>All routes</button>`;

  function showRoute(r) {
    const w = r.sched.weekday;
    const freq = w && w.mid_n >= 3 ? `${w.mid}<small> min</small>` : w && (w.am_n || w.pm_n) ? "Rush hour" : w ? `${w.trips}<small> trips</small>` : "Weekends";
    const span = !w ? "—" : w.span_h >= 22 ? "24 hours" : `${w.first.replace(" ", " ")} – ${w.last.replace(" ", " ")}`;
    const pats = (r.patterns || []).filter((p) => p.stops && p.stops.length);
    const color = keyColor(dkey(r));
    let html = `${backBtn}
      <div class="hero">${badgeHTML(r, "xl")}<div><h2>${esc(routeTitle(r))}</h2><p>${esc(r.name || "")}</p></div></div>
      <div class="chips"><span class="chip"><span class="dot" style="background:${color}"></span>${esc(CAT_NAME[r.cat])}</span><span class="chip">${esc(r.agency)}</span><span class="chip live-chip" id="liveChip" hidden><span class="pulse" aria-hidden="true"></span><span class="n"></span></span></div>
      <div id="routeAlerts"></div>
      <div class="tiles">
        <div class="tile"><span class="k">Midday on weekdays</span><span class="v">${w && w.mid_n >= 3 ? "Every " : ""}${freq}</span></div>
        <div class="tile"><span class="k">Weekday hours</span><span class="v sm">${esc(span)}</span></div>
      </div>
      <h3 class="section">Schedule at a glance</h3>${scheduleTable(r)}
      <p class="foot">Typical wait in the busier direction, from the published schedule for ${esc(dayLabel())}.</p>`;
    if (pats.length) {
      html += `<h3 class="section">Stops</h3><div class="segmented" role="tablist">${pats.map((p, i) =>
        `<button role="tab" type="button" aria-selected="${i === 0}" data-i="${i}">To ${esc(p.headsign || "terminal")}</button>`).join("")}<span class="seg-thumb" aria-hidden="true"></span></div>
        <ol class="group stoplist" id="stoplist" style="--line-c:${color}"></ol>`;
    }
    if (r.url) html += `<a class="link-out press" href="${esc(r.url)}" target="_blank" rel="noopener">Official schedule and alerts<span aria-hidden="true">↗</span></a>`;
    setView(html);
    $("#back").addEventListener("click", clearSelection);
    const renderStops = (i) => {
      const p = pats[i];
      $("#stoplist").innerHTML = p.stops.map((sid) => {
        const s = stopIndex[sid];
        return `<li><button type="button" data-stop="${esc(s ? s.key : "")}">${esc(s ? s.name : STOPNAMES[sid] || sid)}</button></li>`;
      }).join("");
      for (const b of $("#stoplist").querySelectorAll("button")) b.addEventListener("click", () => { if (b.dataset.stop) selectStop(b.dataset.stop); });
      const tabs = [...body().querySelectorAll(".segmented button")];
      tabs.forEach((t) => t.setAttribute("aria-selected", String(+t.dataset.i === i)));
      const thumb = body().querySelector(".seg-thumb");
      if (thumb) {
        thumb.style.width = `calc(${100 / tabs.length}% - 4px)`;
        if (thumb.style.transform && thumb.style.transform !== `translateX(${i * 100}%)`) {
          thumb.classList.remove("moving"); void thumb.offsetWidth; thumb.classList.add("moving");
        }
        thumb.style.transform = `translateX(${i * 100}%)`;
      }
    };
    if (pats.length) {
      renderStops(0);
      for (const t of body().querySelectorAll(".segmented button")) t.addEventListener("click", () => renderStops(+t.dataset.i));
    }
    fillRouteAlerts(r);
    updateLiveUI();
    openSheet("half");
  }
  function routeRows(rs) {
    return `<ul class="group" role="list">${rs.map((r) => `<li><button type="button" class="row route-row" data-route="${esc(r.id)}">${badgeHTML(r)}<span class="txt"><span class="name">${esc(routeTitle(r))}</span><span class="desc">${esc(r.name)}</span></span><span class="hw">${esc(freqText(r))}</span><svg class="chev" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button></li>`).join("")}</ul>`;
  }
  function showStop(s) {
    const rs = s.routes.map((id) => RBY[id]).filter(Boolean).sort(tagOrder);
    const kind = s.kind === "stop" ? (s.code ? `Bus stop #${s.code}` : "Bus stop") : s.kind === "ferry" ? "Ferry terminal" : "Station";
    let html = `${backBtn}<div class="hero"><span class="stop-glyph${s.kind === "stop" ? "" : " big"}" aria-hidden="true"></span><div><h2>${esc(s.name)}</h2><p>${esc(kind)}</p></div></div>
      <div id="stopAlerts"></div>
      <h3 class="section">${rs.length} route${rs.length === 1 ? "" : "s"} stop here</h3>${routeRows(rs)}`;
    if (s.kind !== "stop") {
      const near = nearbyStops(s, 250);
      const bus = [...new Set(near.flatMap((x) => x.routes))].filter((id) => !s.routes.includes(id)).map((id) => RBY[id]).filter(Boolean).sort(tagOrder);
      if (bus.length) html += `<h3 class="section">Buses within a short walk</h3>${routeRows(bus)}`;
    }
    setView(html);
    $("#back").addEventListener("click", clearSelection);
    for (const b of body().querySelectorAll("[data-route]")) { b.addEventListener("click", () => selectRoute(b.dataset.route)); previewOnHover(b); }
    fillStopAlerts(s);
    openSheet("half");
  }
  function nearbyStops(s, meters) {
    const dLat = meters / 111000, dLon = meters / (111000 * Math.cos(s.lat * Math.PI / 180));
    return STOPS.stops.filter((x) => Math.abs(x.lat - s.lat) < dLat && Math.abs(x.lon - s.lon) < dLon);
  }

  // ---------------------------------------------------------------- search
  const searchIndex = [];
  function buildSearch() {
    for (const r of ROUTES) {
      if (LINEIDX[r.id] == null) continue;
      searchIndex.push({ kind: "route", id: r.id, key: [r.label, r.short, routeTitle(r), r.name].join(" ").toLowerCase(), label: r.label.toLowerCase(), r });
    }
    for (const s of STOPS.stations) searchIndex.push({ kind: "station", id: s.id, key: s.name.toLowerCase(), s });
    for (const s of STOPS.stops) searchIndex.push({ kind: "stop", id: s.id, key: (s.name + " " + (s.code || "")).toLowerCase(), s });
  }
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/), scored = [];
    for (const it of searchIndex) {
      if (!words.every((w) => it.key.includes(w))) continue;
      let score = it.kind === "route" ? 0 : it.kind === "station" ? 10 : 20;
      if (it.kind === "route" && (it.label === q || it.r.short.toLowerCase() === q)) score -= 100;
      if (it.key.startsWith(q)) score -= 5;
      scored.push([score, it]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const seen = new Set();
    return scored.map((x) => x[1]).filter((it) => {
      const k = it.kind === "stop" ? it.s.name : it.kind + it.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 9);
  }
  function setupSearch() {
    const input = $("#q"), box = $("#results");
    let items = [], active = -1;
    const render = () => {
      if (!input.value.trim()) { box.hidden = true; return; }
      items = search(input.value);
      active = items.length ? 0 : -1;
      box.innerHTML = items.length ? items.map((it, i) => {
        if (it.kind === "route") return `<button type="button" class="result${i === active ? " active" : ""}" data-i="${i}">${badgeHTML(it.r)}<span class="txt"><span class="name">${esc(routeTitle(it.r))}</span><span class="desc">${esc(it.r.name)}</span></span></button>`;
        const sub = it.kind === "station" ? "Station" : `Bus stop${it.s.code ? " #" + it.s.code : ""}`;
        return `<button type="button" class="result${i === active ? " active" : ""}" data-i="${i}"><span class="stop-glyph${it.kind === "station" ? " big" : ""}" aria-hidden="true"></span><span class="txt"><span class="name">${esc(it.s.name)}</span><span class="desc">${esc(sub)}</span></span></button>`;
      }).join("") : `<div class="empty">No routes or stops match “${esc(input.value.trim())}”.</div>`;
      box.hidden = false;
    };
    const choose = (i) => {
      const it = items[i];
      if (!it) return;
      box.hidden = true;
      input.value = "";
      input.blur();
      if (it.kind === "route") selectRoute(it.id); else selectStop(it.id);
    };
    input.addEventListener("input", render);
    input.addEventListener("focus", () => { openSheet("full"); render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!items.length) return;
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        box.querySelectorAll(".result").forEach((el, i) => el.classList.toggle("active", i === active));
      } else if (e.key === "Enter") { e.preventDefault(); choose(Math.max(0, active)); }
      else if (e.key === "Escape") { box.hidden = true; input.blur(); }
    });
    box.addEventListener("click", (e) => { const b = e.target.closest(".result"); if (b) choose(+b.dataset.i); });
    document.addEventListener("click", (e) => { if (!e.target.closest(".search")) box.hidden = true; });
  }

  // ---------------------------------------------------------------- layer toggles
  function applyLayerToggles() {
    if (!map) return;
    const vis = (key, ids) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", enabled.has(key) ? "visible" : "none"));
    vis("dart", ["dart-fill", "dart-line"]);
    vis("access", ["access-fill", "access-line"]);
    vis("flex", ["flex", "flex-fill", "flex-line"]);
    vis("stops", ["stops", "stop-name"]);
    vis("live", ["veh-dir", "veh-icon", "veh-label"]);
    if (enabled.has("live")) startLive(); else stopLive();
    if (map.getSource("stations")) refreshStations();
    renderFilterBar();
    rebuild();
  }

  // ---------------------------------------------------------------- interaction
  const LINE_LAYERS = GROUPS.flatMap((g) => [`line-${g}`, `dash-${g}`]).concat(["sel-line", "sel-dash"]);
  // Routes under the pointer: a corridor line stands for every visible route of its type on that street.
  function routesAt(point, r = 6) {
    const feats = qrf([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: LINE_LAYERS.filter((l) => map.getLayer(l)) });
    const sel = selected && selected.type === "route" ? LINEIDX[selected.id] : -1;
    const set = new Set();
    for (const f of feats) {
      const p = f.properties;
      if (p.r >= 0) { set.add(p.r); continue; }
      const E = EDGES[p.e];
      if (E && E.byKey.has(p.cat)) for (const i of E.byKey.get(p.cat)) set.add(i);
    }
    let idx = [...set];
    if (sel >= 0 && idx.includes(sel) && feats.some((f) => f.properties.r === sel)) idx = [sel];
    return idx.map((i) => LINES[i]).sort(tagOrder);
  }
  let popup = null;
  function closePopup() { if (popup) { popup.remove(); popup = null; } }
  // pointing at a route in a list shows it on the map
  function previewOnHover(b) {
    b.addEventListener("mouseenter", () => { if (!(selected && selected.type === "route")) focusRoute(RBY[b.dataset.route]); });
    b.addEventListener("mouseleave", () => setHover(null));
  }
  function openPopup(lngLat, html, maxWidth = "300px") {
    closePopup();
    popup = new maplibregl.Popup({ maxWidth, className: "glass-pop" }).setLngLat(lngLat).setHTML(html).addTo(map);
    popup.getElement().querySelectorAll("[data-route]").forEach((b) => {
      b.addEventListener("click", () => { closePopup(); selectRoute(b.dataset.route, { fit: false }); });
      previewOnHover(b);
    });
  }
  function setupInteraction() {
    const hitLayers = () => ["sel-stops", "hov-stops", "stations", "stops", "flex"].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none");
    const vehAt = (pt, rad) => (map.getLayer("veh-icon") && map.getLayoutProperty("veh-icon", "visibility") !== "none"
      ? qrf([[pt.x - rad, pt.y - rad], [pt.x + rad, pt.y + rad]], { layers: ["veh-icon"] }) : []);
    // What the pointer is on: one target at a time, and a little sticky, so a pointer resting
    // near a stop, a bus and a line doesn't flicker between them. A new target takes over only
    // when the pointer is well onto it; the current one holds until the pointer is well off it.
    let cur = null; // { kind, id }
    const nearest = (feats, pt) => {
      let best = null;
      for (const f of feats) {
        const c = map.project(f.geometry.coordinates), d = Math.hypot(c.x - pt.x, c.y - pt.y);
        if (!best || d < best.d) best = { f, d };
      }
      return best;
    };
    const pickVehicle = (pt) => {
      const h = nearest(vehAt(pt, 12), pt);
      if (!h) return null;
      const held = cur && cur.kind === "veh" && cur.id === h.f.properties.id;
      return h.d <= (held ? 12 : 7) ? h.f : null;
    };
    const pickStop = (pt) => {
      const h = nearest(qrf([[pt.x - 11, pt.y - 11], [pt.x + 11, pt.y + 11]], { layers: hitLayers() }), pt);
      if (!h) return null;
      const held = cur && cur.kind === "stop" && cur.id === h.f.properties.id;
      // a stop that popped out along the line in focus needs a deliberate move onto it
      const enter = h.f.layer.id === "hov-stops" && cur && cur.kind === "line" ? 3.5 : 5.5;
      return h.d <= (held ? 8 : enter) ? h.f : null;
    };
    // the route strand under the pointer: every route is its own strand of the street line, so
    // the strand the pointer is most inside of is the route
    const pickLine = (pt) => {
      const rad = 5;
      const feats = qrf([[pt.x - rad, pt.y - rad], [pt.x + rad, pt.y + rad]], { layers: LINE_LAYERS.filter((l) => map.getLayer(l)) });
      if (!feats.length) return null;
      const ll = map.unproject(pt), p = toM(ll.lng, ll.lat), mpp = MPP0 / 2 ** map.getZoom();
      const sel = selected && selected.type === "route" ? LINEIDX[selected.id] : -1;
      let best = null, held = null;
      for (const f of feats) {
        const d = distTo(f, p);
        if (!isFinite(d)) continue;
        const half = (f.properties.ws || 0) / 2;
        const out = Math.max(0, d - half) / mpp; // pixels outside the strand
        const score = out + (half ? d / half : 1) * 0.01 - (f.properties.r === sel && sel >= 0 ? 2 : 0);
        const h = { f, out, score };
        if (!best || score < best.score) best = h;
        if (cur && cur.kind === "line" && f.properties.r === cur.id && (!held || out < held.out)) held = h;
      }
      // the route in focus holds while the pointer is still on (or right at the edge of) its strand
      if (held && held.out <= 1.5) best = held;
      if (!best || best.out > (cur && cur.kind === "line" ? 6 : 4)) return null;
      const f = best.f, pr = f.properties;
      // boats: every route of the crossing (they share one line)
      const E0 = EDGES[pr.e];
      const all = pr.r < 0 && E0 && E0.byKey.get(pr.cat) ? E0.byKey.get(pr.cat) : [pr.r];
      return { f, r: pr.r < 0 ? all[0] : pr.r, routes: all.map((i) => LINES[i]).filter(Boolean).sort(tagOrder), n: pr.n || 1 };
    };
    const ev = (e, dy = 0) => ({ clientX: e.originalEvent.clientX, clientY: e.originalEvent.clientY + dy });
    map.on("mousemove", (e) => {
      // a number on a route tag
      const tg = tagAt(e.point);
      showLens(tg);
      if (tg) {
        map.getCanvas().style.cursor = "pointer";
        highlightStop(null);
        if (tg.item.r != null) {
          const r = LINES[tg.item.r];
          cur = { kind: "tag", id: tg.item.r };
          if (!(selected && selected.type === "route")) focusRoute(r);
          tipShow("tag:" + tg.item.r, `<span class="tt"><b>${esc(routeTitle(r))}</b><br>${esc(r.name)}</span>`, "", ev(e, 14));
        } else {
          cur = { kind: "tag", id: "more" };
          setHover(null);
          tipShow("more:" + tg.item.more.join("."), `<span class="tip-badges">${tg.item.more.slice(0, 12).map((i) => badgeHTML(LINES[i])).join("")}</span>`, "", ev(e, 14));
        }
        return;
      }
      const vh = pickVehicle(e.point);
      if (vh) {
        const r = RBY[vh.properties.r];
        cur = { kind: "veh", id: vh.properties.id };
        map.getCanvas().style.cursor = "pointer";
        highlightStop(null);
        tipShow("veh:" + vh.properties.id, `${badgeHTML(r)}<span class="tt"><b>${esc(routeTitle(r))}</b>${vesselLine(vh.properties.id)}<span class="vs-row">${vehicleLines(vh.properties.id, vh.properties.est)}</span></span>`, "", ev(e));
        return;
      }
      const st = pickStop(e.point);
      if (st) {
        const p = st.properties, lid = st.layer.id;
        cur = { kind: "stop", id: p.id };
        map.getCanvas().style.cursor = "pointer";
        if (lid === "flex") {
          highlightStop(null);
          tipShow("flex:" + p.name, `<span class="tt">${esc("Metro Flex · " + p.name)}</span>`, "", ev(e));
        } else {
          highlightStop(st);
          const end = lid === "sel-stops" || lid === "hov-stops" ? p.end : 0;
          tipShow(`stop:${p.id}:${end}`, stopCard(p.id, end, p.ids), "tip-card", ev(e));
        }
        return;
      }
      highlightStop(null);
      const ln = pickLine(e.point);
      if (ln) {
        cur = { kind: "line", id: ln.r };
        map.getCanvas().style.cursor = "pointer";
        if (!(selected && selected.type === "route")) focusRoutes(ln.routes);
        const rs = ln.routes, r = rs[0];
        const nal = rs.length === 1 ? routeAlerts(rs[0].id) : [];
        const more = (ln.n > 1 ? `<span class="tt-more">${ln.n} routes share this street</span>` : "")
          + (nal.length ? `<span class="tt-alert al-${LEVEL[nal[0].level][0]}">${alertIcon(nal[0].level)}${nal.length === 1 ? esc(LEVEL[nal[0].level][1]) : `${nal.length} alerts`}</span>` : "");
        tipShow("line:" + rs.map((x) => x.id).join(","), rs.length === 1
          ? `${badgeHTML(r)}<span class="tt"><b>${esc(routeTitle(r))}</b><br>${esc(r.name)}${more}</span>`
          : `<span class="tip-badges">${rs.slice(0, 8).map((x) => badgeHTML(x)).join("")}</span>${rs.length > 8 ? `<span class="tt">+${rs.length - 8}</span>` : ""}`, "", ev(e));
        return;
      }
      cur = null;
      map.getCanvas().style.cursor = "";
      tipHide();
      setHover(null);
    });
    map.getCanvas().addEventListener("mouseleave", () => { cur = null; tipHide(true); setHover(null); highlightStop(null); showLens(null); });
    map.on("movestart", () => { showLens(null); });
    map.on("click", (e) => {
      tipHide(true);
      closePopup();
      // a number on a route tag opens that route; "+3" lists the rest
      const tg = tagAt(e.point);
      if (tg) {
        showLens(null);
        if (tg.item.r != null) selectRoute(LINES[tg.item.r].id, { fit: false });
        else openPopup(tg.coords, `<div class="pop"><h3>${tg.item.more.length} more routes</h3>${routeRows(tg.item.more.map((i) => LINES[i]).sort(tagOrder))}</div>`);
        return;
      }
      // a tap right on a station's circle opens the station, even with a train or bus on top of it
      const onStation = map.getLayer("stations") && map.getLayoutProperty("stations", "visibility") !== "none"
        ? map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: ["stations"] }) : [];
      if (onStation.length) { selectStop(onStation[0].properties.id, { fly: false }); return; }
      const vh = vehAt(e.point, isNarrow() ? 12 : 8);
      if (vh.length) {
        const v = live.vehicles.get(vh[0].properties.id), r = RBY[vh[0].properties.r];
        if (vh[0].properties.est && r) {
          openPopup(vh[0].geometry.coordinates, `<div class="pop"><h3>${esc(routeTitle(r))}</h3><p>${esc(r.name)}</p><p>Estimated position from the timetable${LIVE ? "" : " (live positions show on the website)"}.</p>${routeRows([r])}</div>`, "280px");
          return;
        }
        if (v && r) {
          const age = v.ts ? Math.max(0, Math.round(Date.now() / 1000 - v.ts)) : null;
          openPopup(vh[0].geometry.coordinates, `<div class="pop"><h3>${esc(routeTitle(r))}</h3><p>${esc(r.name)}</p>${vesselLine(v.id, "p")}<p class="vs-row">${vehicleLines(v.id, false)}</p>${v.label && !v.name ? `<p>Vehicle ${esc(v.label)}</p>` : ""}${routeRows([r])}</div>`, "280px");
          return;
        }
      }
      const hit = map.queryRenderedFeatures([[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]], { layers: hitLayers() });
      if (hit.length) {
        const f = hit.find((h) => h.layer.id === "stations") || hit[0];
        if (f.layer.id === "flex") {
          openPopup(f.geometry.coordinates, flexHTML(f.properties), "290px");
          return;
        }
        selectStop(f.properties.id, { fly: false });
        return;
      }
      const ln = !isNarrow() && pickLine(e.point);
      if (ln && ln.routes.length === 1) { selectRoute(ln.routes[0].id, { fit: false }); return; }
      const rs = routesAt(e.point, isNarrow() ? 10 : 6);
      if (rs.length === 1) { selectRoute(rs[0].id, { fit: false }); return; }
      if (rs.length > 1) {
        openPopup(e.lngLat, `<div class="pop"><h3>${rs.length} routes on this street</h3>${routeRows(rs.slice(0, 16))}</div>`);
        return;
      }
      const area = map.queryRenderedFeatures(e.point, { layers: ["flex-fill", "dart-fill", "access-fill"].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none") });
      if (area.length) {
        const f = area.find((a) => a.layer.id === "flex-fill") || area.find((a) => a.layer.id === "dart-fill") || area[0];
        const html = f.layer.id === "flex-fill" ? flexHTML(f.properties) : f.layer.id === "dart-fill"
          ? `<div class="pop"><h3>Dial-a-Ride area · route ${esc(f.properties.route)}</h3><p>Inside this area the DART bus can leave its regular path to pick you up or drop you off. Ask King County Metro to arrange an off-route trip.</p>${f.properties.slug && RBY[f.properties.slug] ? routeRows([RBY[f.properties.slug]]) : ""}</div>`
          : `<div class="pop"><h3>Access paratransit (approximate)</h3><p>Access serves riders with disabilities who can't use fixed-route buses, within ¾ mile of Metro's regular routes while they run. Riders apply for eligibility and book trips ahead. This shading uses the ¾-mile rule around all-day routes.</p></div>`;
        openPopup(e.lngLat, html, "290px");
        return;
      }
      if (selected) clearSelection();
    });
    map.on("zoom", onZoom);
    map.on("moveend", onMoveEnd);
    map.on("zoomend", () => { if (Math.abs(map.getZoom() - lastZ) > 0.005 || labelStep !== curStep) rebuild(); renderLive(); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.target.closest("input")) return;
      if (popup) closePopup();
      else if (selected) clearSelection();
      else if (panelView === "layers" || panelView === "alerts") { panelView = "home"; showHome(); }
    });
  }
  // Hover. A line carrying one route: that route's whole path, drawn bold on top, with its stops.
  // A line carrying several: the stretch of street they share, bold, with the stops along it.
  // Nothing else on the map changes. Stops pop in once per line, not on every mouse move.
  let hoverKey = "", hoverTimer = 0, hoverRoutes = [];
  const withColor = (feats) => feats.map((f) => ({ ...f, properties: { ...f.properties, c: keyColor(f.properties.cat) } }));
  // each hover slot eases between hidden (0) and shown (1); shown lines are a little bolder
  // than their lines, and swell to that from their own width as they appear
  let hSlot = 0;
  const hAnim = HOVER_SLOTS.map(() => ({ v: 0, from: 0, to: 0, t0: 0, dur: 1, raf: 0 }));
  function hoverPaint(i) {
    const sl = HOVER_SLOTS[i], v = hAnim[i].v, k = 1.2 + 0.45 * v;
    if (!map.getLayer(`${sl}-line`)) return;
    map.setPaintProperty(`${sl}-case`, "line-opacity", v);
    map.setPaintProperty(`${sl}-line`, "line-opacity", Math.min(1, v * 1.4));
    map.setPaintProperty(`${sl}-case`, "line-width", px("cm", k * 0.97));
    map.setPaintProperty(`${sl}-line`, "line-width", px("wm", k));
    map.setPaintProperty(`${sl}-arrows`, "icon-opacity", v);
  }
  function hoverFade(i, to, dur) {
    const A = hAnim[i];
    cancelAnimationFrame(A.raf);
    if (calm()) dur = 1;
    Object.assign(A, { from: A.v, to, t0: performance.now(), dur });
    const frame = (now) => {
      const t = Math.max(0, Math.min(1, (now - A.t0) / A.dur));
      A.v = A.from + (A.to - A.from) * (1 - Math.pow(1 - t, 3));
      hoverPaint(i);
      if (t < 1) A.raf = requestAnimationFrame(frame);
      else if (A.to === 0 && map.getSource(HOVER_SLOTS[i])) map.getSource(HOVER_SLOTS[i]).setData(fc([]));
    };
    A.raf = requestAnimationFrame(frame);
  }
  function focusOff() {
    clearTimeout(hoverTimer);
    hoverKey = "";
    hoverRoutes = [];
    hovStopsKey = "";
    if (!map || !map.getSource("hover")) return;
    hoverFade(hSlot, 0, 190);
    popOut("hov", () => { if (!hoverKey) map.getSource("hoverstops").setData(fc([])); });
  }
  // Hovering shows whole routes, never just a piece: the route whose strand is under the
  // pointer (or every boat on a crossing). It's drawn bold in its own lane, right over its line,
  // with its stops when there are only a few routes.
  function focusRoutes(routes, again = false) {
    routes = (routes || []).filter((r) => r && LINEIDX[r.id] != null);
    if (!routes.length) return;
    clearTimeout(hoverTimer);
    const key = "r:" + routes.map((r) => r.id).join(",");
    if (key === hoverKey && !again) return;
    hoverKey = key;
    hoverRoutes = routes;
    requestRoutePaths(routes.map((r) => LINEIDX[r.id]), false, (feats) => {
      if (hoverKey !== key) return;
      const lines = withColor(feats);
      if (again) map.getSource(HOVER_SLOTS[hSlot]).setData(fc(lines)); // the same route, relaid for a new view
      else {
        const next = 1 - hSlot;
        map.getSource(HOVER_SLOTS[next]).setData(fc(lines));
        hoverFade(hSlot, 0, 170);
        hoverFade(next, 1, 240);
        hSlot = next;
      }
      if (routes.length <= 4) {
        // stops of each route snap onto that route's own drawn line
        const all = [];
        for (const r of routes) {
          const own = lines.filter((f) => f.properties.r === LINEIDX[r.id]);
          all.push(...snapStops(stopFeatures([r], routes.length === 1), own, "route"));
        }
        map.getSource("hoverstops").setData(fc(mergeStops(all)));
        if (hovStopsKey !== key) popIn("hov");
      } else map.getSource("hoverstops").setData(fc([]));
      hovStopsKey = key;
    });
  }
  const focusRoute = (r) => focusRoutes([r]);
  // pointer off every line: let go after a moment (crossing a gap between lines doesn't blink)
  function setHover(feat) {
    if (feat) return;
    clearTimeout(hoverTimer);
    if (hoverKey) hoverTimer = setTimeout(focusOff, 200);
  }

  // ---------------------------------------------------------------- route tags you can point at
  // Each number on a tag is its own target: hovering it lifts that number (the lens) and shows
  // that route's whole line and stops; clicking it opens the route.
  const BADGE_LAYOUT = new Map();
  // map lookups during pointer moves can briefly fail while a source is being replaced
  const qrf = (geom, opts) => { try { return map.queryRenderedFeatures(geom, opts); } catch (e) { return []; } };
  function tagAt(pt) {
    if (!map.getLayer("badges") || map.getLayoutProperty("badges", "visibility") === "none") return null;
    if (selected && selected.type === "route") return null; // other routes' tags are faded out then
    const hits = qrf([[pt.x - 1, pt.y - 1], [pt.x + 1, pt.y + 1]], { layers: ["badges"] });
    for (const f of hits) {
      const L = BADGE_LAYOUT.get("b:" + f.properties.k);
      if (!L) continue;
      const c = map.project(f.geometry.coordinates), left = c.x - L.w / 2, top = c.y - L.h / 2, dx = pt.x - left;
      if (dx < 0 || dx > L.w || pt.y < top || pt.y > top + L.h) continue;
      const item = L.items.find((it) => dx >= it.x0 && dx < it.x1) || L.items[L.items.length - 1];
      return { item, left, top, L, coords: f.geometry.coordinates };
    }
    return null;
  }
  let lensKey = "";
  function showLens(hit) {
    const lens = $("#lens");
    if (!hit) { if (lensKey) { lens.hidden = true; lensKey = ""; } return; }
    const key = hit.left.toFixed(0) + "," + hit.top.toFixed(0) + "," + hit.item.x0;
    const rect = map.getCanvas().getBoundingClientRect();
    lens.style.left = rect.left + hit.left + (hit.item.x0 + hit.item.x1) / 2 + "px";
    lens.style.top = rect.top + hit.top + hit.L.h / 2 + "px";
    if (key === lensKey) return;
    lensKey = key;
    const it = hit.item;
    lens.innerHTML = it.r != null ? `<span class="lens-in">${badgeHTML(LINES[it.r])}</span>`
      : `<span class="lens-in"><span class="badge lens-more">+${it.more.length}</span></span>`;
    lens.hidden = false;
  }

  // The pointer's tooltip. It glides after the pointer, changes shape smoothly from one card to
  // the next (a route, a stop's departures, a bus), and fades in and out instead of popping.
  let tipKey = "", tipOut = 0, tipRAF = 0, tipMorph = 0;
  const tipPos = { x: 0, y: 0, tx: 0, ty: 0, on: false };
  const calm = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function tipAim(ev) {
    const tip = $("#tip");
    tipPos.tx = Math.max(8, Math.min(ev.clientX + 16, window.innerWidth - tip.offsetWidth - 8));
    tipPos.ty = Math.max(8, Math.min(ev.clientY + 16, window.innerHeight - tip.offsetHeight - 8));
    if (!tipPos.on || calm()) { tipPos.x = tipPos.tx; tipPos.y = tipPos.ty; }
    tipPos.on = true;
    if (!tipRAF) tipRAF = requestAnimationFrame(tipStep);
  }
  function tipStep() {
    const tip = $("#tip");
    tipPos.x += (tipPos.tx - tipPos.x) * 0.38;
    tipPos.y += (tipPos.ty - tipPos.y) * 0.38;
    tip.style.transform = `translate3d(${tipPos.x.toFixed(1)}px, ${tipPos.y.toFixed(1)}px, 0)`;
    tipRAF = Math.abs(tipPos.tx - tipPos.x) + Math.abs(tipPos.ty - tipPos.y) > 0.3 ? requestAnimationFrame(tipStep) : 0;
  }
  function tipShow(key, html, cls, ev) {
    const tip = $("#tip");
    clearTimeout(tipOut);
    tip.classList.remove("tip-leaving");
    if (key === tipKey && !tip.hidden) { tipAim(ev); return; }
    const was = !tip.hidden && tipKey;
    tipKey = key;
    if (!was) {
      tip.className = "tip glass" + (cls ? " " + cls : "");
      tip.innerHTML = `<div class="tip-in">${html}</div>`;
      tip.hidden = false;
      tipPos.on = false;
      tipAim(ev);
      tip.classList.remove("tip-enter"); void tip.offsetWidth; tip.classList.add("tip-enter");
      return;
    }
    // one card to the next: keep the old size, swap the contents in with a soft fade, and let
    // the glass grow or shrink to the new size
    const r0 = tip.getBoundingClientRect();
    tip.style.width = tip.style.height = "";
    tip.className = "tip glass" + (cls ? " " + cls : "");
    tip.innerHTML = `<div class="tip-in tip-swap">${html}</div>`;
    const r1 = tip.getBoundingClientRect();
    tipAim(ev);
    if (calm() || (Math.abs(r1.width - r0.width) < 2 && Math.abs(r1.height - r0.height) < 2)) return;
    clearTimeout(tipMorph);
    tip.classList.add("tip-morph");
    tip.style.width = r0.width + "px"; tip.style.height = r0.height + "px";
    void tip.offsetWidth;
    tip.style.width = r1.width + "px"; tip.style.height = r1.height + "px";
    tipMorph = setTimeout(() => { tip.classList.remove("tip-morph"); tip.style.width = tip.style.height = ""; }, 280);
  }
  function tipHide(now) {
    const tip = $("#tip");
    clearTimeout(tipOut);
    if (tip.hidden) return;
    const gone = () => { tip.hidden = true; tipKey = ""; tip.classList.remove("tip-leaving"); };
    if (now) { gone(); return; }
    // a short grace, so crossing the gap between two lines doesn't blink the card
    tipOut = setTimeout(() => {
      tip.classList.add("tip-leaving");
      tipOut = setTimeout(gone, 170);
    }, 160);
  }

  // ---------------------------------------------------------------- phone sheet (peek / half / full)
  const isNarrow = () => window.innerWidth <= 720;
  const DETENTS = ["peek", "half", "full"];
  let sheetState = "peek";
  function setSheet(state) {
    sheetState = state;
    const p = $("#panel");
    DETENTS.forEach((d) => p.classList.toggle(`at-${d}`, d === state));
    const g = $("#grabber");
    g.setAttribute("aria-expanded", String(state !== "peek"));
    g.setAttribute("aria-label", state === "full" ? "Shrink panel" : "Expand panel");
  }
  function openSheet(state = "full") {
    if (!isNarrow()) return;
    if (DETENTS.indexOf(state) > DETENTS.indexOf(sheetState) || state === "half") setSheet(state);
  }
  function setupSheet() {
    setSheet(isNarrow() ? "peek" : "full");
    $("#grabber").addEventListener("click", () => setSheet(sheetState === "full" ? "peek" : DETENTS[DETENTS.indexOf(sheetState) + 1]));
    let y0 = null, t0 = 0;
    $("#sheetHead").addEventListener("pointerdown", (e) => { if (!isNarrow() || e.target.closest("input,button:not(.grabber)")) return; y0 = e.clientY; t0 = performance.now(); });
    window.addEventListener("pointerup", (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0, fast = performance.now() - t0 < 400, i = DETENTS.indexOf(sheetState);
      if ((dy < -30 || (fast && dy < -10)) && i < 2) setSheet(DETENTS[i + 1]);
      else if ((dy > 30 || (fast && dy > 10)) && i > 0) setSheet(DETENTS[i - 1]);
      y0 = null;
    });
    window.addEventListener("resize", () => { if (!isNarrow()) setSheet("full"); });
  }

  // ---------------------------------------------------------------- hash routing
  function applyHash() {
    const h = decodeURIComponent((location.hash || "").slice(1));
    if (h.startsWith("route-") && RBY[h.slice(6)]) selectRoute(h.slice(6));
    else if (/^(stop|station)-/.test(h) && stopIndex[h.replace(/^(stop|station)-/, "")]) selectStop(h.replace(/^(stop|station)-/, ""));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    registerProtocols();
    const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
    const [routes, net, stops, areas, manifest, live] = await Promise.all([
      getJSON("data/routes.json"), getJSON("data/network.json"), getJSON("data/stops.json"), getJSON("data/areas.json"),
      getJSON("tiles/manifest.json").catch(() => null), liveTiles(),
    ]);
    MANIFEST = manifest;
    META = routes.meta; ROUTES = routes.routes; STOPNAMES = routes.stopNames; NET = net; STOPS = stops; AREAS = areas;
    ROUTES.forEach((r, i) => { r._rank = i; RBY[r.id] = r; });
    LINES = NET.lines.map((id) => RBY[id]);
    LINES.forEach((r, i) => { LINEIDX[r.id] = i; });
    RTMAP = new Map(ROUTES.flatMap((r) => (r.rt || []).map((k) => [k, r])));
    prepNetwork();
    startEngine(); // lays out the network in the background while the map loads
    for (const s of STOPS.stops) {
      stopIndex[s.id] = { ...s, kind: "stop", key: s.id };
      for (const a of s.alias || []) stopIndex[a] = stopIndex[s.id];
    }
    for (const s of STOPS.stations) {
      stopIndex[s.id] = { ...s, key: s.id };
      for (const sid of s.stops) if (!stopIndex[sid]) stopIndex[sid] = { ...s, key: s.id };
    }

    const P = BASE[theme];
    const baseSource = live
      ? { type: "vector", tiles: live.tiles, minzoom: 0, maxzoom: 14, attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }
      : { type: "vector", tiles: ["atlas://{z}/{x}/{y}"], minzoom: 0, maxzoom: manifest ? manifest.maxzoom : 14, attribution: "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" };
    const R = META.region;
    const narrow = isNarrow();
    const empty = { type: "FeatureCollection", features: [] };
    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        glyphs: live ? "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf" : "atlasfont://{fontstack}/{range}",
        sources: {
          base: baseSource,
          net: { type: "geojson", data: empty, tolerance: 0.2, buffer: 96, attribution: "Transit data: Puget Sound GTFS, King County GIS" },
          sel: { type: "geojson", data: empty, tolerance: 0.2 },
          selstops: { type: "geojson", data: empty },
          hoverstops: { type: "geojson", data: empty },
          stophl: { type: "geojson", data: empty },
          hover: { type: "geojson", data: empty, tolerance: 0.2 },
          hover2: { type: "geojson", data: empty, tolerance: 0.2 },
          netlabels: { type: "geojson", data: empty, tolerance: 0.5 },
          sellabels: { type: "geojson", data: empty, tolerance: 0.5 },
          stations: { type: "geojson", data: empty },
          stops: { type: "geojson", data: empty },
          dart: { type: "geojson", data: AREAS.dart },
          access: { type: "geojson", data: AREAS.access },
          flex: { type: "geojson", data: AREAS.flex },
          flexlabels: { type: "geojson", data: AREAS.flexLabels || empty },
          vehicles: { type: "geojson", data: empty },
          mask: { type: "geojson", data: maskGeoJSON() },
        },
        layers: [...baseLayers(P), ...areaLayers(P), ...transitLayers(P), ...poiLayers(P), ...stopLayers(P), ...liveLayers(P)],
      },
      bounds: narrow ? [[-122.42, 47.54], [-122.17, 47.72]] : [[-122.44, 47.50], [-122.10, 47.77]],
      fitBoundsOptions: { padding: narrow ? { top: 20, bottom: 150, left: 10, right: 10 } : { top: 30, bottom: 30, left: 420, right: 80 } },
      maxBounds: [[R.west - 0.4, R.south - 0.3], [R.east + 0.4, R.north + 0.3]],
      minZoom: 9, maxZoom: 18.5, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      attributionControl: false,
    });
    window.__map = map; // handy for debugging from the console
    window.__atlas = {
      rebuild, timeRebuild: () => { const t = performance.now(); rebuild(); return performance.now() - t; },
      inWorker: () => !!worker, lastBuildMs: () => lastBuildMs, engineInit, lastParams: () => lastParams, lastFeats: () => lastFeats, liveState: () => liveState(), alerts: () => alerts, wsfState: () => wsfState(),
      vehicleLines, vehicleOccupancy, occCode,
      obaStop, readDeparture, liveDepartures, depRowsHTML, depCache: () => depCache, stopCard, ensureDepartures,
      onLine, routeById: (id) => RBY[id],
      idle: () => new Promise((res) => { if (!inFlight && !queued) res(); else idleWaiters.push(res); }),
    };
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("styleimagemissing", (e) => {
      if (e.id.startsWith("veh:") || e.id.startsWith("vdir:")) drawVehicle(e.id);
      else if (e.id.startsWith("poi:")) drawPoiIcon(e.id);
      else if (e.id.startsWith("shield:")) drawShield(e.id);
      else if (e.id.startsWith("b:")) drawBadge(e.id);
      else if (e.id.startsWith("arr:")) drawArrow(e.id);
    });
    map.on("load", () => {
      refreshStations();
      map.getSource("stops").setData(stopsGeoJSON());
      applyLayerToggles();
      applyTheme();
      const attrib = document.querySelector(".maplibregl-ctrl-attrib");
      if (attrib) attrib.classList.remove("maplibregl-compact-show");
      $("#loading").classList.add("done");
      setTimeout(() => { $("#loading").hidden = true; }, 450);
      buildSearch();
      setupSearch();
      setupInteraction();
      showHome();
      applyHash();
      loadSchedule();
    });
  }

  // ---------------------------------------------------------------- liquid glass behavior
  // A soft highlight follows the pointer across glass surfaces, and tapped controls
  // squash and spring back like jelly.
  function setupGlass() {
    let raf = 0, last = null;
    document.addEventListener("pointermove", (e) => {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = last.target.closest && last.target.closest(".glass");
        if (!el) return;
        const b = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${((last.clientX - b.left) / b.width * 100).toFixed(1)}%`);
        el.style.setProperty("--my", `${((last.clientY - b.top) / b.height * 100).toFixed(1)}%`);
      });
    }, { passive: true });
    document.addEventListener("pointerdown", (e) => {
      const el = e.target.closest && e.target.closest(".ctl, .back, .link-out, .chip, .result, .route-row, .grabber");
      if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      el.classList.remove("squish"); void el.offsetWidth; el.classList.add("squish");
    }, { passive: true });
    document.addEventListener("animationend", (e) => { if (e.animationName === "squish") e.target.classList.remove("squish"); });
  }

  // ---------------------------------------------------------------- page chrome
  function setupChrome() {
    setupGlass();
    setupSheet();
    $("#zoomIn").addEventListener("click", () => map && map.zoomIn({ duration: 350 }));
    $("#zoomOut").addEventListener("click", () => map && map.zoomOut({ duration: 350 }));
    const tb = $("#themeBtn");
    const cycle = { "": "dark", dark: "light", light: "" };
    const label = () => {
      const t = document.documentElement.getAttribute("data-theme") || "";
      tb.setAttribute("aria-label", t ? `Appearance: ${t}. Change appearance` : "Appearance: automatic. Change appearance");
      tb.title = t ? `Appearance: ${t}` : "Appearance: automatic";
    };
    const saved = store.get("theme", "");
    if (saved && !document.documentElement.getAttribute("data-theme")) document.documentElement.setAttribute("data-theme", saved);
    label();
    tb.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "";
      const next = cycle[cur];
      if (next) document.documentElement.setAttribute("data-theme", next); else document.documentElement.removeAttribute("data-theme");
      store.set("theme", next);
      label();
    });
    mq.addEventListener("change", applyTheme);
    new MutationObserver(() => { if (themeName() !== theme) applyTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("hashchange", applyHash);
    document.documentElement.setAttribute("data-dark", theme === "dark" ? "1" : "0");
  }

  setupChrome();
  boot().catch((err) => {
    console.error(err);
    const l = $("#loading");
    l.hidden = false;
    l.classList.remove("done");
    l.querySelector(".pill").textContent = "The map data didn't load. Reload the page to try again.";
  });
})();
