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
  const CAT_NAME = {
    link: "Link light rail", sounder: "Sounder train", amtrak: "Amtrak Cascades", streetcar: "Streetcar",
    monorail: "Monorail", rapidride: "RapidRide", swift: "Swift BRT", frequent: "Frequent bus",
    local: "All-day bus", peak: "Rush hour & limited", shuttle: "Link shuttle bus",
    dart: "Dial-a-Ride (DART)", watertaxi: "Water Taxi", ferry: "Ferry",
  };
  const LINE = {
    light: {
      link: "#1d3f86", sounder: "#4b5563", streetcar: "#e8772e", monorail: "#8a8f98", rapidride: "#d0213b",
      swift: "#1f6fe0", frequent: "#0a9b7b", local: "#3f8ee0", peak: "#a9824b", shuttle: "#e3a118",
      dart: "#c0508a", watertaxi: "#1690ad", ferry: "#3d6fa8",
    },
    dark: {
      link: "#86a8f2", sounder: "#a3acb9", streetcar: "#ff9450", monorail: "#b5bac2", rapidride: "#ff5468",
      swift: "#5b9bff", frequent: "#2fd3a6", local: "#6eaef5", peak: "#d1a86c", shuttle: "#ffc44d",
      dart: "#ea7ab5", watertaxi: "#45c1e3", ferry: "#7aa6dc",
    },
  };
  // Route-number tags carry their own background, so one palette reads in both themes.
  const FLEX = { light: "#8a3cc0", dark: "#c47ef0" }; // Metro Flex zones
  const TAG = {
    link1: "#2e8540", link2: "#0a7cb8", linkT: "#e07b00", sounder: "#4b5563", amtrak: "#4b5563", streetcar: "#e0692a",
    monorail: "#6b7280", rapidride: "#d0213b", swift: "#1f6fe0", frequent: "#08876b", local: "#2f7fd3",
    peak: "#94703c", shuttle: "#e3a118", dart: "#b2467c", watertaxi: "#13809b", ferry: "#35639a",
  };

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
  const TAG_DENSITY = { fewer: { gap: 420, every: 900, any: 70, busZ: 11.5 }, normal: { gap: 280, every: 600, any: 44, busZ: 10.0 },
    more: { gap: 180, every: 380, any: 26, busZ: 9.4 } };
  const tagSpacing = (td, z) => ({ ...td, any: td.any * (z < 11 ? 1.25 : 1) });
  const THICK = { thin: 0.8, normal: 1, bold: 1.25 };
  const settings = { ...SETTINGS_DEFAULT };
  {
    const saved = store.get("settings", {}) || {};
    if (BUS_TIERS[saved.busDetail]) settings.busDetail = saved.busDetail;
    if (TAG_DENSITY[saved.tags]) settings.tags = saved.tags;
    if (THICK[saved.thickness]) settings.thickness = saved.thickness;
  }
  const GAP = 0.5; // space between corridor lines, in units

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
  // meters (feature property) -> pixels at the current zoom, exactly (times k)
  const px = (prop, k = 1) => ["interpolate", ["exponential", 2], ["zoom"],
    9, ["*", ["get", prop], k * 2 ** 9 / MPP0], 20, ["*", ["get", prop], k * 2 ** 20 / MPP0]];

  // ---------------------------------------------------------------- base map palette
  const BASE = {
    light: {
      land: "#f2f2ef", water: "#a9d3f2", waterLine: "#8fc3ea", waterLabel: "#3c78b4", park: "#d6ebc6", wood: "#dcedcf",
      civic: "#ece7f1", industrial: "#ebe9e6", minor: "#ffffff", minorCase: "#e1e0dc", major: "#ffffff",
      majorCase: "#d5d3cf", motorway: "#f7f7f5", motorwayCase: "#c9c8c4", rail: "#cfcfcb", runway: "#e1e1dd",
      label: "#6e6e73", halo: "#f2f2ef", place: "#3a3a3c", mask: "#f2f2ef",
      stationFill: "#ffffff", stationStroke: "#1d3f86", stopFill: "#ffffff", stopStroke: "#8e8e93",
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
  const tagColor = (r) => (r.cat === "link" ? (r.label === "1" ? TAG.link1 : r.label === "T" ? TAG.linkT : TAG.link2) : TAG[r.cat] || TAG.local);
  const tagText = (r) => (r.cat === "shuttle" ? "#1d1d1f" : "#ffffff");
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
  const tagOrder = (a, b) => (CAT[VKEY(a.cat)].prio - CAT[VKEY(b.cat)].prio) || (a._rank - b._rank);

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
  const LINE_OP = ["match", ["get", "cat"], "peak", 0.6, "local", 0.88, "dart", 0.85, 1];
  function transitLayers(P) {
    const L = [];
    const inner = (id, src, filter, paint, layout = {}) => L.push({ id, type: "line", source: src, filter,
      layout: { "line-join": "round", ...layout }, paint });
    for (const g of ["water", "bus", "rapid", "rail"]) {
      const f = ["==", ["get", "g"], g];
      if (g !== "water") {
        L.push({ id: `shadow-${g}`, type: "line", source: "net", filter: f, minzoom: 11,
          layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "s"] },
          paint: { "line-color": P.shadow, "line-width": px("cm"), "line-blur": 3, "line-translate": [0, 1.6] } });
        L.push({ id: `case-${g}`, type: "line", source: "net", filter: f,
          layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "s"] },
          paint: { "line-color": P.casing, "line-width": px("cm") } });
      }
      L.push({ id: `line-${g}`, type: "line", source: "net", filter: ["all", f, ["==", ["get", "d"], 0]],
        layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "s"] },
        paint: { "line-color": ["get", "c"], "line-width": px("wm"), "line-opacity": LINE_OP } });
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
    // hovered line: drawn again, thicker, on top (width springs up when it appears)
    L.push({ id: "hover-case", type: "line", source: "hover", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": P.casing, "line-width": px("cm", 1), "line-width-transition": { duration: 220 } } });
    L.push({ id: "hover-line", type: "line", source: "hover", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-width": px("wm", 1), "line-width-transition": { duration: 220 } } });
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
    const arrowLayer = (id, src, minzoom, spacing) => L.push({ id, type: "symbol", source: src, minzoom, filter: ["!=", ["get", "ar"], 0],
      layout: { "symbol-placement": "line", "symbol-spacing": spacing, "icon-image": ["concat", "arr:", ["get", "c"]],
        "icon-rotate": ["case", ["<", ["get", "ar"], 0], 180, 0], "icon-rotation-alignment": "map", "icon-keep-upright": false,
        "icon-allow-overlap": true, "icon-ignore-placement": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 14, 0.8, 17, 1.05] } });
    // arrows only on the line in focus (hovered or selected): on every line they were noise
    arrowLayer("hover-arrows", "hover", 11, ["interpolate", ["linear"], ["zoom"], 11, 90, 15, 120, 17, 170]);
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
  function liveLayers(P) {
    return [
      { id: "veh-icon", type: "symbol", source: "vehicles",
        layout: { "icon-image": ["concat", "veh:", ["get", "c"], ":", ["case", [">=", ["get", "b"], 0], "a", "o"]],
          "icon-rotate": ["max", ["get", "b"], 0], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.32, 11, 0.42, 12.5, 0.58, 14, 0.8, 15.5, 1, 18, 1.15], "symbol-sort-key": ["get", "s"] } },
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
        filter: ["any", ["==", ["get", "major"], 1], [">=", ["zoom"], 12.5]],
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
    EDGES = KCTMGeom.prepEdges(NET.edges, LINES.map((r) => ({ cat: r.cat, group: CAT[VKEY(r.cat)].group })));
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
  let worker = null, engine = null, inFlight = null, queued = null, buildSeq = 0, appliedSeq = 0, lastBuildMs = 0, watchdog = 0;
  const idleWaiters = [];
  function engineInit() {
    return { edges: NET.edges, lines: LINES.map((r) => ({ cat: r.cat, rank: r._rank })), cat: CAT, gap: GAP };
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
  function applyBuild(m) {
    if (m.id < appliedSeq || !map || !map.getSource("net")) return;
    appliedSeq = m.id;
    lastFeats = m.feats;
    lastBuildMs = m.ms || 0;
    map.getSource("net").setData({ type: "FeatureCollection", features: m.feats });
    if (hoverKey) { hoverKey = ""; map.getSource("hover").setData({ type: "FeatureCollection", features: [] }); }
    map.getSource("sel").setData({ type: "FeatureCollection", features: m.selFeats });
    map.getSource("netlabels").setData({ type: "FeatureCollection", features: m.labels });
    map.getSource("sellabels").setData({ type: "FeatureCollection", features: m.selLabels });
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
  let curStep = null, lastBuild = 0, buildTimer = null, builtView = null, lastFeats = [];
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
    const z = curStep = zStep(zNow);
    lastBuild = performance.now();
    const u = interp(UNIT, z) * THICK[settings.thickness];
    const tier = tierFor(zNow);
    const keyOn = {};
    for (const k of Object.keys(CAT)) keyOn[k] = (k === "sounder" ? enabledCat("sounder") || enabledCat("amtrak") : enabledCat(k)) && CAT[k].tier <= tier;
    const p = { z, zNow, u, capU: interp(CAP_PX, z) / u, keyOn,
      selIdx: selected && selected.type === "route" ? LINEIDX[selected.id] : -1,
      view: (builtView = viewBox(0.75)), tags: tagSpacing(TAG_DENSITY[settings.tags], zNow), theme: theme[0], colors: LINE[theme],
      wscale: minorScale(zNow) };
    const msg = { id: ++buildSeq, p };
    if (!worker) {
      const t = performance.now();
      applyBuild({ id: msg.id, ms: performance.now() - t, ...engine.build(p) });
    } else if (inFlight) queued = msg;
    else send(msg);
  }
  function onZoom() {
    if (zStep(map.getZoom()) === curStep) return;
    const wait = 140 - (performance.now() - lastBuild);
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
    const groups = [];
    for (const r of rs) {
      const c = tagColor(r);
      let g = groups.find((x) => x.c === c);
      if (!g) groups.push((g = { c, fg: tagText(r), items: [] }));
      g.items.push(shortLabel(r));
    }
    if (extra) groups[groups.length - 1].items.push(`+${extra}`);
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
    for (const g of groups) {
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
          ctx.fillStyle = g.fg === "#ffffff" ? "rgba(255,255,255,0.42)" : "rgba(0,0,0,0.3)";
          ctx.fillRect(tx + sep / 2 - 0.5 * dpr, halo + h * 0.24, 1 * dpr, h * 0.52);
          tx += sep;
        }
      });
      x += g.w + gap;
    }
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
      const major = [...cats].some((c) => majorCats.has(c)) || cats.has("ferry") || cats.has("watertaxi");
      let stroke = BASE[theme].stationStroke;
      if (!major && cats.has("streetcar")) stroke = LINE[theme].streetcar;
      if (!cats.has("link") && (cats.has("ferry") || cats.has("watertaxi"))) stroke = LINE[theme].ferry;
      if (!cats.has("link") && (cats.has("sounder") || cats.has("amtrak"))) stroke = LINE[theme].sounder;
      const size = cats.has("link") ? (rs.filter((r) => r.cat === "link").length > 1 ? 1.15 : 1) : major ? 0.95 : 0.7;
      return { type: "Feature", properties: { id: s.id, name: s.name, major: major ? 1 : 0, size, stroke },
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
    for (const set of [baseLayers(P), transitLayers(P), areaLayers(P), stopLayers(P), liveLayers(P)]) {
      for (const L of set) {
        if (!map.getLayer(L.id)) continue;
        for (const [k, v] of Object.entries(L.paint || {})) map.setPaintProperty(L.id, k, v);
      }
    }
    map.getSource("stations").setData(stationsGeoJSON());
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
  const live = { vehicles: new Map(), timer: 0, last: 0, error: false, polling: false, anim: 0, count: 0, pauseUntil: 0 };
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
    const sources = LIVE.agencies.map((a) => [a, `${LIVE.base}/${a}.pb?key=${encodeURIComponent(LIVE.key)}`, true])
      .concat((LIVE.feeds || []).map((f) => [f.agency, f.url, false]));
    for (const [a, url, oba] of sources) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.status === 429 && oba) { live.pauseUntil = Date.now() + 60000; break; }
        if (!r.ok) throw new Error(String(r.status));
        res.push({ status: "fulfilled", value: [a, parseVehicles(new Uint8Array(await r.arrayBuffer()))] });
      } catch (e) {
        res.push({ status: "rejected", reason: e });
      }
      await new Promise((ok) => setTimeout(ok, 250));
    }
    live.polling = false;
    const now = performance.now(), wall = Date.now() / 1000;
    let ok = 0;
    for (const x of res) {
      if (x.status !== "fulfilled") continue;
      ok++;
      const [a, list] = x.value, seen = new Set();
      for (const v of list) {
        if (!v.route || (v.ts && wall - v.ts > 300)) continue;
        const r = RTMAP.get(`${a}_${v.route}`);
        if (!r || LINEIDX[r.id] == null) continue;
        const id = `${a}_${v.id || v.trip}`, to = [v.lon, v.lat];
        seen.add(id);
        const prev = live.vehicles.get(id);
        if (prev) {
          const from = vehPos(prev, now), d = geoDist(from, to);
          const b = v.bearing != null && v.bearing > 0 ? v.bearing : d > 12 ? geoBearing(from, to) : prev.b;
          Object.assign(prev, { from, to, t0: now, r, b, ts: v.ts, label: v.label || prev.label });
        } else {
          live.vehicles.set(id, { id, agency: a, from: to, to, t0: now, r, b: v.bearing > 0 ? v.bearing : -1, ts: v.ts, label: v.label });
        }
      }
      for (const [id, v] of live.vehicles) if (v.agency === a && !seen.has(id)) live.vehicles.delete(id);
    }
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
    else if (mode === "live") for (const v of live.vehicles.values()) list.push({ id: v.id, r: v.r, pos: vehPos(v, now), b: v.b });
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
      if (sel ? sel !== r.id : (!enabledCat(r.cat) || CAT[VKEY(r.cat)].tier > tier)) continue;
      const c = tagColor(r);
      feats.push({ type: "Feature", properties: { id: v.id, r: r.id, c, tc: c, lab: shortLabel(r), b: v.b == null ? -1 : Math.round(v.b),
        s: 20 - CAT[VKEY(r.cat)].prio, est: v.est ? 1 : 0 }, geometry: { type: "Point", coordinates: v.pos } });
    }
    live.count = feats.length;
    map.getSource("vehicles").setData({ type: "FeatureCollection", features: feats });
  }
  const renderLive = renderVehicles;
  function animateLive() { /* the steady ticker below keeps vehicles moving */ }
  setInterval(() => { if (map && enabled.has("live") && !document.hidden && !map.isMoving()) renderVehicles(); }, 125);

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
    live.timer = setInterval(pollLive, POLL_MS);
  }
  function stopLive() {
    clearInterval(live.timer);
    live.timer = 0;
    renderVehicles();
    updateLiveUI();
  }
  function drawVehicle(id) {
    const [, color, kind] = id.split(":");
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const S = 30 * dpr, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const ctx = cv.getContext("2d"), c = S / 2, R = 7.5 * dpr;
    ctx.shadowColor = "rgba(0,0,0,.28)"; ctx.shadowBlur = 3 * dpr; ctx.shadowOffsetY = 1 * dpr;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    if (kind === "a") { // teardrop pointing along the direction of travel
      ctx.moveTo(c, c - R - 6 * dpr);
      ctx.arc(c, c, R + 2 * dpr, -Math.PI / 2 + 0.62, -Math.PI / 2 - 0.62 + Math.PI * 2);
      ctx.closePath();
    } else ctx.arc(c, c, R + 2 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = color;
    ctx.beginPath();
    if (kind === "a") {
      ctx.moveTo(c, c - R - 3.4 * dpr);
      ctx.arc(c, c, R, -Math.PI / 2 + 0.55, -Math.PI / 2 - 0.55 + Math.PI * 2);
      ctx.closePath();
    } else ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(c, c, 2.6 * dpr, 0, Math.PI * 2); ctx.fill();
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
  function stopFeatures(routes, withEnds, bounds) {
    const color = keyColor(VKEY(routes[0].cat)), seen = new Map();
    for (const r of routes) {
      for (const st of routeStops(r)) {
        const k = st.lon + "," + st.lat;
        if (seen.has(k) || (bounds && !bounds.contains([st.lon, st.lat]))) continue;
        seen.set(k, { type: "Feature", properties: { id: st.id, name: st.name, c: color, end: withEnds ? st.end : 0 },
          geometry: { type: "Point", coordinates: [st.lon, st.lat] } });
      }
    }
    return [...seen.values()];
  }
  const fc = (features) => ({ type: "FeatureCollection", features });
  function showRouteStops(r) {
    const src = map && map.getSource("selstops");
    if (!src) return;
    cancelAnimationFrame(anims.sel);
    src.setData(fc(r ? stopFeatures([r], true) : []));
    if (r) popIn("sel");
  }
  let hoverStopsKey = "";
  function showHoverStops(routes) {
    const src = map && map.getSource("hoverstops");
    if (!src) return;
    const key = routes ? routes.map((r) => r.id).join(",") : "";
    if (key === hoverStopsKey) return;
    hoverStopsKey = key;
    if (!routes || !routes.length) { cancelAnimationFrame(anims.hov); src.setData(fc([])); return; }
    const b = map.getBounds(), pad = 0.3;
    const dx = (b.getEast() - b.getWest()) * pad, dy = (b.getNorth() - b.getSouth()) * pad;
    const box = new maplibregl.LngLatBounds([b.getWest() - dx, b.getSouth() - dy], [b.getEast() + dx, b.getNorth() + dy]);
    src.setData(fc(stopFeatures(routes, routes.length === 1, box)));
    popIn("hov");
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
    const c = f.properties.c || f.properties.stroke || (rs[0] ? keyColor(VKEY(rs[0].cat)) : BASE[theme].stopStroke);
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
  function stopCard(id, end) {
    const s = stopIndex[id];
    if (!s) return "";
    const rs = (s.routes || []).map((x) => RBY[x]).filter((r) => r && LINEIDX[r.id] != null).sort(tagOrder);
    const keys = [...new Set([s.key, ...((s.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))])];
    const deps = nextDepartures(keys);
    const kind = s.kind === "stop" ? (s.code ? `Stop ${esc(s.code)}` : "Bus stop") : "Station";
    let h = `<div class="sc"><div class="sc-name">${esc(s.name)}</div><div class="sc-sub">${kind} · ${rs.length} route${rs.length === 1 ? "" : "s"}${end === 2 ? " · <b>End of the line</b>" : end === 1 ? " · <b>Trips start here</b>" : ""}</div>`;
    if (rs.length) h += `<div class="sc-badges">${rs.slice(0, 10).map((r) => badgeHTML(r)).join("")}${rs.length > 10 ? `<span class="sc-more">+${rs.length - 10}</span>` : ""}</div>`;
    if (deps && deps.length) {
      h += `<div class="sc-next">${deps.map((d) => `<div class="sc-row">${badgeHTML(d.r)}<span class="sc-to">${esc(placeName(d.to))}</span><span class="sc-t">${d.t < 60 ? "now" : Math.round(d.t / 60) + " min"}</span></div>`).join("")}</div>`
        + `<div class="sc-foot">Next departures, from the timetable</div>`;
    } else if (deps) h += `<div class="sc-foot">No departures in the next 90 minutes</div>`;
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
    const shown = LAYERS.filter((l) => enabled.has(l.key)).length;
    const keys = LAYERS.filter((l) => KEY_NAME[l.key] && enabled.has(l.key));
    const live = enabled.has("live");
    const html = `<div class="home-view">
      <p class="live-line${live ? "" : " off"}"><span class="pulse" aria-hidden="true"></span><span${live ? ' id="liveDesc"' : ""}>${live ? esc(liveStatusText()) : "Vehicles are hidden"}</span></p>
      <ul class="group" role="list"><li><button class="row nav-row" id="openLayers" type="button">
        <span class="icon"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M15 7 25 12 15 17 5 12Z" fill="var(--accent)" opacity=".9"/><path d="M6.5 16.3 15 20.5l8.5-4.2" stroke="var(--accent)" stroke-width="1.8" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity=".55"/></svg></span>
        <span class="txt"><span class="name">Layers</span><span class="desc">${shown} of ${LAYERS.length} shown${isDefaultLayers() ? "" : " · customized"}</span></span>
        <svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button></li></ul>
      ${keys.length ? `<h2 class="section">On the map</h2><ul class="key-grid" role="list">${keys.map((l) =>
        `<li><span class="sw">${swatch(l)}</span><span>${esc(KEY_NAME[l.key])}</span></li>`).join("")}</ul>`
        : `<p class="hint">Every layer is off. Turn some on in Layers.</p>`}
      <p class="hint">Tap a line to see its routes, or a stop to see what serves it.</p>
    </div>`;
    const existing = body().querySelector(".home-view");
    if (quiet && existing) existing.outerHTML = html;
    else setView(html);
    $("#openLayers").addEventListener("click", () => { panelView = "layers"; showLayers(); openSheet("half"); });
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
      link: [P.link, 6, "solid"], rail: [P.sounder, 5, "ties"], streetcar: [P.streetcar, 4.6, "solid"], monorail: [P.monorail, 4.6, "solid"],
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
    const color = keyColor(VKEY(r.cat));
    let html = `${backBtn}
      <div class="hero">${badgeHTML(r, "xl")}<div><h2>${esc(routeTitle(r))}</h2><p>${esc(r.name || "")}</p></div></div>
      <div class="chips"><span class="chip"><span class="dot" style="background:${color}"></span>${esc(CAT_NAME[r.cat])}</span><span class="chip">${esc(r.agency)}</span><span class="chip live-chip" id="liveChip" hidden><span class="pulse" aria-hidden="true"></span><span class="n"></span></span></div>
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
      <h3 class="section">${rs.length} route${rs.length === 1 ? "" : "s"} stop here</h3>${routeRows(rs)}`;
    if (s.kind !== "stop") {
      const near = nearbyStops(s, 250);
      const bus = [...new Set(near.flatMap((x) => x.routes))].filter((id) => !s.routes.includes(id)).map((id) => RBY[id]).filter(Boolean).sort(tagOrder);
      if (bus.length) html += `<h3 class="section">Buses within a short walk</h3>${routeRows(bus)}`;
    }
    setView(html);
    $("#back").addEventListener("click", clearSelection);
    for (const b of body().querySelectorAll("[data-route]")) b.addEventListener("click", () => selectRoute(b.dataset.route));
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
    vis("live", ["veh-icon", "veh-label"]);
    if (enabled.has("live")) startLive(); else stopLive();
    if (map.getSource("stations")) map.getSource("stations").setData(stationsGeoJSON());
    renderFilterBar();
    rebuild();
  }

  // ---------------------------------------------------------------- interaction
  const LINE_LAYERS = GROUPS.flatMap((g) => [`line-${g}`, `dash-${g}`]).concat(["sel-line", "sel-dash"]);
  // Routes under the pointer: a corridor line stands for every visible route of its type on that street.
  function routesAt(point, r = 6) {
    const feats = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: LINE_LAYERS.filter((l) => map.getLayer(l)) });
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
  function openPopup(lngLat, html, maxWidth = "300px") {
    closePopup();
    popup = new maplibregl.Popup({ maxWidth, className: "glass-pop" }).setLngLat(lngLat).setHTML(html).addTo(map);
    popup.getElement().querySelectorAll("[data-route]").forEach((b) => b.addEventListener("click", () => { closePopup(); selectRoute(b.dataset.route, { fit: false }); }));
  }
  function setupInteraction() {
    const tip = $("#tip");
    const hitLayers = () => ["sel-stops", "hov-stops", "stations", "stops", "flex"].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none");
    const vehAt = (pt, rad) => (map.getLayer("veh-icon") && map.getLayoutProperty("veh-icon", "visibility") !== "none"
      ? map.queryRenderedFeatures([[pt.x - rad, pt.y - rad], [pt.x + rad, pt.y + rad]], { layers: ["veh-icon"] }) : []);
    map.on("mousemove", (e) => {
      const vh = vehAt(e.point, 6);
      if (vh.length) {
        const r = RBY[vh[0].properties.r];
        map.getCanvas().style.cursor = "pointer";
        highlightStop(null);
        tip.classList.remove("tip-card");
        tip.innerHTML = `${badgeHTML(r)}<span class="tt"><b>${esc(routeTitle(r))}</b><br>${vh[0].properties.est ? "Estimated from the timetable" : "Live position"}</span>`;
        placeTip(e.originalEvent);
        return;
      }
      const stopHit = map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: hitLayers() });
      if (stopHit.length) {
        const p = stopHit[0].properties;
        map.getCanvas().style.cursor = "pointer";
        const lid = stopHit[0].layer.id;
        if (lid === "flex") {
          highlightStop(null);
          tip.classList.remove("tip-card");
          tip.innerHTML = `<span class="tt">${esc("Metro Flex · " + p.name)}</span>`;
        } else {
          highlightStop(stopHit[0]);
          tip.classList.add("tip-card");
          tip.innerHTML = stopCard(p.id, lid === "sel-stops" ? p.end : 0);
        }
        placeTip(e.originalEvent);
        return;
      }
      highlightStop(null);
      tip.classList.remove("tip-card");
      const rs = routesAt(e.point, 4);
      if (rs.length) {
        map.getCanvas().style.cursor = "pointer";
        if (!(selected && selected.type === "route")) {
          const top = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]],
            { layers: LINE_LAYERS.filter((l) => !l.startsWith("sel") && map.getLayer(l)) })[0];
          setHover(top && top.properties.r === -1 ? top : null, rs);
        }
        const r = rs[0];
        tip.innerHTML = rs.length === 1 ? `${badgeHTML(r)}<span class="tt"><b>${esc(routeTitle(r))}</b><br>${esc(r.name)}</span>`
          : `<span class="tip-badges">${rs.slice(0, 8).map((x) => badgeHTML(x)).join("")}</span>${rs.length > 8 ? `<span class="tt">+${rs.length - 8}</span>` : ""}`;
        placeTip(e.originalEvent);
      } else {
        map.getCanvas().style.cursor = "";
        tip.hidden = true;
        setHover(null);
      }
    });
    map.getCanvas().addEventListener("mouseleave", () => { tip.hidden = true; setHover(null); highlightStop(null); });
    map.on("movestart", () => setHover(null));
    map.on("click", (e) => {
      tip.hidden = true;
      closePopup();
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
          openPopup(vehPos(v, performance.now()), `<div class="pop"><h3>${esc(routeTitle(r))}</h3><p>${esc(r.name)}</p><p>${v.label ? `Vehicle ${esc(v.label)} · ` : ""}${age == null ? "Live position" : age < 60 ? `Position from ${age} s ago` : `Position from ${Math.round(age / 60)} min ago`}</p>${routeRows([r])}</div>`, "280px");
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
    map.on("zoomend", () => { if (zStep(map.getZoom()) !== curStep) rebuild(); renderLive(); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.target.closest("input")) return;
      if (popup) closePopup();
      else if (selected) clearSelection();
      else if (panelView === "layers") { panelView = "home"; showHome(); }
    });
  }
  // Hover: a single route thickens along its whole path; a shared corridor line thickens
  // along the stretch of street where it carries that same set of routes.
  let hoverKey = "", spotTimer = 0;
  function setHover(feat, routes) {
    const key = feat ? `${feat.properties.cat}|${feat.properties.e}|${routes.length}` : "";
    if (key === hoverKey) return;
    hoverKey = key;
    const src = map.getSource("hover");
    if (!src) return;
    clearTimeout(spotTimer);
    if (!feat) {
      src.setData({ type: "FeatureCollection", features: [] });
      // let go after a moment, so sliding from one line to the next doesn't flicker
      spotTimer = setTimeout(() => { if (!hoverKey) { showHoverStops(null); if (!(selected && selected.type === "route")) setNetDim(1); } }, 160);
      return;
    }
    spotTimer = setTimeout(() => { if (hoverKey === key && !(selected && selected.type === "route")) setNetDim(0.32); }, 90);
    // stops of the line actually under the pointer (its service type on this street), not of
    // every line nearby
    const E = EDGES[feat.properties.e];
    const own = routes.length === 1 ? routes : E && E.byKey.get(feat.properties.cat) ? E.byKey.get(feat.properties.cat).map((i) => LINES[i]).sort(tagOrder) : routes;
    showHoverStops(own);
    const cat = feat.properties.cat, e0 = feat.properties.e;
    const edges = new Set();
    if (routes.length === 1) {
      const i = LINEIDX[routes[0].id];
      for (const E of EDGES) if (E.l.includes(i)) edges.add(E.k);
    } else {
      const sig = (E) => (E.byKey.get(cat) || []).join(".");
      const want = sig(EDGES[e0]);
      const byNode = new Map();
      for (const E of EDGES) if (sig(E) === want) for (const n of [E.a, E.b]) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(E); }
      const stack = [EDGES[e0]];
      while (stack.length) {
        const E = stack.pop();
        if (edges.has(E.k)) continue;
        edges.add(E.k);
        for (const n of [E.a, E.b]) for (const E2 of byNode.get(n) || []) if (!edges.has(E2.k)) stack.push(E2);
      }
    }
    const feats = lastFeats.filter((f) => f.properties.cat === cat && edges.has(f.properties.e));
    map.setPaintProperty("hover-line", "line-width", px("wm", 1), { validate: false });
    map.setPaintProperty("hover-case", "line-width", px("cm", 1), { validate: false });
    src.setData({ type: "FeatureCollection", features: feats });
    requestAnimationFrame(() => {
      map.setPaintProperty("hover-line", "line-width", px("wm", 1.7));
      map.setPaintProperty("hover-case", "line-width", px("cm", 1.55));
    });
  }
  function placeTip(ev) {
    const tip = $("#tip");
    tip.hidden = false;
    const x = Math.min(ev.clientX + 16, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 16, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = x + "px"; tip.style.top = y + "px";
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
        layers: [...baseLayers(P), ...areaLayers(P), ...transitLayers(P), ...stopLayers(P), ...liveLayers(P)],
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
      inWorker: () => !!worker, lastBuildMs: () => lastBuildMs,
      idle: () => new Promise((res) => { if (!inFlight && !queued) res(); else idleWaiters.push(res); }),
    };
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("styleimagemissing", (e) => {
      if (e.id.startsWith("veh:")) drawVehicle(e.id);
      else if (e.id.startsWith("b:")) drawBadge(e.id);
      else if (e.id.startsWith("arr:")) drawArrow(e.id);
    });
    map.on("load", () => {
      map.getSource("stations").setData(stationsGeoJSON());
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
