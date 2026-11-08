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
  const hasCode = (v) => typeof v === "string" && !!v.trim() && !/^__/.test(v);
  const liveConfig = window.ATLAS_LIVE;
  const LIVE = liveConfig && (hasCode(liveConfig.key) || hasCode(liveConfig.wsf?.code) || hasCode(liveConfig.wsdot?.code))
    ? { ...liveConfig, key: hasCode(liveConfig.key) ? liveConfig.key : "" } : null;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("kctm:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("kctm:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
  const EMPTY_FC = { type: "FeatureCollection", features: [] };

  // ---------------------------------------------------------------- service types
  // w = line width in "units"; tier = zoom band it appears in; inner = the line's center
  // treatment (white center for rail, dots for RapidRide, a glassy highlight for buses)
  const CAT = {
    link:      { group: "rail",  w: 3.0,  tier: 0, prio: 0,  inner: "solid" },
    link1:     { group: "rail",  w: 3.2,  tier: 0, prio: 0,  inner: "solid", base: "link" },
    link2:     { group: "rail",  w: 3.2,  tier: 0, prio: 0.1, inner: "solid", base: "link" },
    linkT:     { group: "rail",  w: 3.0,  tier: 0, prio: 0.2, inner: "solid", base: "link" },
    sounder:   { group: "rail",  w: 2.5,  tier: 0, prio: 1,  inner: "ties" },
    streetcar: { group: "rapid", w: 2.2,  tier: 0, prio: 2,  inner: "solid" },
    monorail:  { group: "rapid", w: 2.2,  tier: 0, prio: 3,  inner: "solid" },
    rapidride: { group: "rapid", w: 2.7,  tier: 0, prio: 4,  inner: "dots" },
    swift:     { group: "rapid", w: 2.5,  tier: 0, prio: 5,  inner: "dots" },
    frequent:  { group: "bus",   w: 2.35, tier: 1, prio: 6,  inner: "glass" },
    local:     { group: "bus",   w: 1.9,  tier: 2, prio: 7,  inner: "glass" },
    peak:      { group: "bus",   w: 1.4,  tier: 2, prio: 8,  dash: true },
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
      link: "#173d7a", link1: "#5ead56", link2: "#479ed8", linkT: "#e57a00", sounder: "#4b5563", streetcar: "#e8772e", monorail: "#8a8f98", rapidride: "#c8102e",
      swift: "#1f6fe0", frequent: "#1d4ed8", local: "#3668c2", peak: "#2b6cb0", shuttle: "#3668c2",
      dart: "#b83280", watertaxi: "#1690ad", ferry: "#0d768a",
      soundtransit: "#173d7a",
    },
    dark: {
      link: "#86a8f2", link1: "#6ec565", link2: "#56b4f2", linkT: "#ffa94d", sounder: "#a3acb9", streetcar: "#ff9450", monorail: "#b5bac2", rapidride: "#ff5468",
      swift: "#5b9bff", frequent: "#3b82f6", local: "#93c5fd", peak: "#70a6f2", shuttle: "#93c5fd",
      dart: "#f472b6", watertaxi: "#45c1e3", ferry: "#38bdf8",
      soundtransit: "#86a8f2",
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
    { title: "Trails", items: [
      { key: "trails", cats: [], name: "Bike network & trails", desc: "Seattle bike network, protected bike lanes, greenways & regional trails", on: true, area: "trails" },
    ] },
    { title: "On demand", items: [
      { key: "dart", cats: ["dart"], name: "Dial-a-Ride (DART)", desc: "Can leave its route to pick you up", on: true, area: "dart" },
      { key: "flex", cats: [], name: "Metro Flex zones", desc: "Book a ride inside the zone", on: true, area: "flex" },
      { key: "access", cats: [], name: "Access paratransit", desc: "About ¾ mile around all-day routes", on: false, area: "access" },
    ] },
    { title: "Map", items: [
      { key: "live", cats: [], name: "Vehicles", desc: "Buses, trains and ferries on the move", on: true, area: "live" },
      { key: "stops", cats: [], name: "Bus stops", desc: "Appear as you zoom in", on: true, area: "stops" },
      { key: "pois", cats: [], name: "Points of interest", desc: "Colleges, hospitals, stadiums & sights", on: true, area: "pois" },
    ] },
  ];
  const LAYERS = LAYER_GROUPS.flatMap((g) => g.items);
  // Display settings (bottom of the Layers page), remembered per viewer.
  //   busDetail  when bus lines appear as you zoom out: frequent buses from the 2nd zoom, all-day from the 3rd
  //   tags       how many route-number tags: gap between repeats, spacing along long streets, and the zoom
  //              where bus tags start
  //   thickness  line width multiplier
  const SETTINGS_DEFAULT = { busDetail: "normal", tags: "normal", thickness: "normal" };
  const BUS_TIERS = { less: [0, 10.0, 11.5], normal: [0, 0, 9.2], more: [0, 0, 0] };
  // gap: same tag repeating; every: spacing along long streets; any: between any two tags (px,
  // grows when zoomed out, see tagSpacing); busZ: zoom where bus tags start
  const TAG_DENSITY = { fewer: { gap: 840, every: 1800, any: 140, busZ: 11.5 }, normal: { gap: 560, every: 1200, any: 88, busZ: 9.7 },
    more: { gap: 360, every: 760, any: 52, busZ: 9.2 } };
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
  const savedLayers = store.get("layers4", null) || store.get("layers3", null) || store.get("layers2", null);
  LAYERS.forEach((l) => {
    if (savedLayers ? (savedLayers.includes(l.key) || (l.key === "trails" && !store.get("layers3", null)) || (l.key === "pois" && !store.get("layers4", null))) : l.on) enabled.add(l.key);
  });
  let selected = null;
  let placeMarker = null;

  const enabledCat = (cat) => LAYERS.some((l) => l.cats.includes(cat) && enabled.has(l.key));

  let specialFilter = null; // null | "nightowl" | "snow"
  const NIGHT_OWL_IDS = new Set([
    "sound-transit-1-line", "sound-transit-2-line",
    "metro-a-line", "metro-c-line", "metro-d-line", "metro-e-line", "metro-g-line", "metro-h-line",
    "metro-1", "metro-2", "metro-3", "metro-4", "metro-5", "metro-7", "metro-8", "metro-11",
    "metro-14", "metro-21", "metro-36", "metro-40", "metro-44", "metro-48", "metro-49", "metro-62",
    "metro-70", "metro-120", "metro-124", "metro-160",
    "ct-swift-blue", "ct-swift-green", "ct-swift-orange"
  ]);
  const isNightOwl = (r) => !!(r && (
    NIGHT_OWL_IDS.has(r.id) ||
    (r.sched?.weekday?.late_n >= 3 && r.cat !== "peak") ||
    (r.sched?.weekday?.span_h >= 21.5)
  ));

  const SNOW_IDS = new Set([
    "sound-transit-1-line", "sound-transit-2-line", "sound-transit-t-line",
    "metro-a-line", "metro-b-line", "metro-c-line", "metro-d-line", "metro-e-line", "metro-f-line", "metro-g-line", "metro-h-line",
    "metro-1", "metro-2", "metro-3", "metro-4", "metro-7", "metro-8", "metro-10", "metro-11", "metro-12", "metro-14",
    "metro-21", "metro-24", "metro-27", "metro-28", "metro-31", "metro-32", "metro-33", "metro-36", "metro-40",
    "metro-44", "metro-48", "metro-49", "metro-60", "metro-62", "metro-65", "metro-67", "metro-70",
    "metro-101", "metro-106", "metro-124", "metro-131", "metro-132", "metro-150", "metro-160", "metro-165",
    "metro-181", "metro-182", "metro-187", "metro-255", "metro-271", "metro-345", "metro-348", "metro-372",
    "st-512", "st-522", "st-545", "st-550", "st-554",
    "ct-swift-blue", "ct-swift-green", "ct-swift-orange"
  ]);
  const isSnowRoute = (r) => !!(r && (SNOW_IDS.has(r.id) || r.cat === "link" || r.cat === "rapidride"));
  const routeMatchesFilter = (r) => (!specialFilter ? true
    : specialFilter === "favs" ? isFav("route", r.id)
    : specialFilter === "nightowl" ? isNightOwl(r)
    : specialFilter === "snow" ? isSnowRoute(r)
    : true);
  const isSoundTransit = (r) => !!(r && (r.agency === "Sound Transit" || r.agencyShort === "Sound Transit" || r.agencyShort === "ST" || (r.id && r.id.startsWith("sound-transit-"))));
  const isEveryday = (r) => {
    if (!r || !r.sched) return false;
    if (r.cat === "peak") return false;
    const w = r.sched.weekday, sa = r.sched.saturday, su = r.sched.sunday;
    return !!(w && sa && su && (sa.mid_n > 0 || sa.trips > 5) && (su.mid_n > 0 || su.trips > 5));
  };
  const isRouteSuspended = (r) => {
    if (!r || !alerts || !alerts.byRoute) return false;
    const list = routeAlerts(r.id);
    if (!list.length) return false;
    return list.some((a) => a.level === 2 && /\b(suspended|cancelled|canceled|not operating|no service)\b/i.test(a.title));
  };
  const stopIdsOf = (s) => (s ? [s.id, s.key, ...(s.stops || [])].filter(Boolean) : []);
  const stopIsSuspended = (stopId) => {
    if (!stopId || !alerts || !alerts.byStop) return false;
    const s = typeof stopId === "object" ? stopId : (typeof stopIndex !== "undefined" ? stopIndex[stopId] : null);
    const ids = s ? stopIdsOf(s) : [stopId];
    const list = [];
    for (const id of ids) {
      for (const a of alerts.byStop.get(id) || []) list.push(a);
    }
    if (!list.length) return false;
    return list.some((a) => {
      if (a.level === 2) return true;
      const t = ((a.title || "") + " " + (a.desc || "")).toLowerCase();
      return /\b(closed|closure|suspend|suspended|not served|bypassed|missed|no service|out of service|out of order|relocated)\b/.test(t);
    });
  };
  const keyColor = (key, th = theme) => LINE[th][key] || LINE[th].local;
  const tagColor = (r, th = theme) => {
    if (!r) return LINE[th].local;
    if (r.cat === "link") return r.label === "1" ? LINE[th].link1 : r.label === "T" ? LINE[th].linkT : r.label === "2" ? LINE[th].link2 : LINE[th].link;
    if (r.cat === "sounder") return LINE[th].sounder;
    if (isSoundTransit(r)) return LINE[th].soundtransit || LINE[th].link;
    return LINE[th][dkey(r)] || LINE[th].local;
  };
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
  const badgeHTML = (r, size = "") => {
    const everyday = isEveryday(r);
    const color = tagColor(r);
    const textColor = everyday ? tagText(r) : color;
    const partTimeCls = !everyday ? " part-time" : "";
    const roundCls = isRound(r) ? " round" : "";
    const sizeCls = size ? " " + size : "";
    const suspCls = isRouteSuspended(r) ? " suspended" : "";
    const style = everyday
      ? `background:${color};color:${textColor}`
      : `--badge-c:${color};border-color:${color};color:${color}`;
    return `<span class="badge${roundCls}${sizeCls}${partTimeCls}${suspCls}" style="${style}" aria-hidden="true">${esc(shortLabel(r))}</span>`;
  };
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
      // Tile data contains a few unnamed hydrographic traces across open lake
      // water. They look like broken ship routes, so only draw named waterways.
      { id: "waterway", type: "line", source: "base", "source-layer": "waterway", minzoom: 11, filter: ["has", "name"],
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
  const SOFT = { peak: 0.75, local: 0.95, dart: 0.85 };
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
    }
    // hovered line: drawn again, bolder, on top; nothing else changes. Two of them, so one route
    // can fade out while the next one swells in.
    for (const sl of HOVER_SLOTS) {
      L.push({ id: `${sl}-glow`, type: "line", source: sl, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "c"], "line-width": px("gm", 2.0), "line-opacity": 0, "line-blur": 6 } });
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
    const trailCol = theme === "dark" ? "#2dd4bf" : "#047857";
    const trailGreenway = theme === "dark" ? "#86efac" : "#16a34a";
    const trailLane = theme === "dark" ? "#67e8f9" : "#0284c7";
    const trailSharrow = theme === "dark" ? "#d9f99d" : "#65a30d";
    const trailHalo = theme === "dark" ? "#090d16" : "#ffffff";
    const trailText = theme === "dark" ? "#5eead4" : "#065f46";
    const trailCase = theme === "dark" ? "#041d16" : "#ffffff";
    return [
      { id: "mask", type: "fill", source: "mask", paint: { "fill-color": P.mask, "fill-opacity": 0.55 } },
      { id: "access-fill", type: "fill", source: "access", paint: { "fill-color": acc, "fill-opacity": 0.08 } },
      { id: "access-line", type: "line", source: "access", paint: { "line-color": acc, "line-width": 1.4, "line-dasharray": [3, 2], "line-opacity": 0.8 } },
      { id: "dart-fill", type: "fill", source: "dart", paint: { "fill-color": LINE[theme].dart, "fill-opacity": 0.1 } },
      { id: "dart-line", type: "line", source: "dart", paint: { "line-color": LINE[theme].dart, "line-width": 1.2, "line-dasharray": [2, 2] } },
      { id: "flex-fill", type: "fill", source: "flex", paint: { "fill-color": FLEX[theme], "fill-opacity": theme === "dark" ? 0.12 : 0.09 } },
      { id: "flex-line", type: "line", source: "flex", paint: { "line-color": FLEX[theme], "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2, 16, 2.6] } },
      // Glowing highlight layers for hovered / selected DART service area
      { id: "dart-hl-fill", type: "fill", source: "darthl", paint: { "fill-color": LINE[theme].dart, "fill-opacity": theme === "dark" ? 0.35 : 0.28 } },
      { id: "dart-hl-casing", type: "line", source: "darthl", paint: { "line-color": "#ffffff", "line-width": 5.0, "line-opacity": 0.95 } },
      { id: "dart-hl-line", type: "line", source: "darthl", paint: { "line-color": LINE[theme].dart, "line-width": 3.0, "line-dasharray": [3, 1.5], "line-opacity": 1.0 } },
      // 1. Casing for multi-use trails and protected bike lanes
      { id: "trail-case", type: "line", source: "trails",
        filter: ["in", ["get", "facility"], ["literal", ["trail", "pbl"]]],
        paint: {
          "line-color": trailCase, "line-opacity": theme === "dark" ? 0.95 : 0.9,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3.2, 11, 4.4, 13, 5.8, 15, 7.2, 17, 8.5],
        } },
      // 2. Multi-use trails and Protected Bike Lanes (PBL) - solid emerald line
      { id: "trail-pbl", type: "line", source: "trails",
        filter: ["all", ["in", ["get", "facility"], ["literal", ["trail", "pbl"]]], ["!=", ["get", "surface"], "unpaved"]],
        paint: {
          "line-color": trailCol,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.0, 11, 2.8, 13, 3.8, 15, 5.0, 17, 6.2],
          "line-opacity": 0.95,
        } },
      // 3. Neighborhood Greenways & Healthy Streets - distinct green line with subtle dash (visible from regional view)
      { id: "trail-greenway", type: "line", source: "trails", minzoom: 9,
        filter: ["==", ["get", "facility"], "greenway"],
        paint: {
          "line-color": trailGreenway,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.4, 11, 2.0, 13, 2.8, 15, 3.8, 17, 4.8],
          "line-dasharray": [6, 3],
          "line-opacity": 0.92,
        } },
      // 4. Bicycle Lanes (Buffered, Climbing & Striped Lanes) - clean teal lane stroke
      { id: "trail-lane", type: "line", source: "trails", minzoom: 9.8,
        filter: ["==", ["get", "facility"], "lane"],
        paint: {
          "line-color": trailLane,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9.8, 1.2, 11.5, 1.6, 13, 2.4, 15, 3.2, 17, 4.0],
          "line-opacity": 0.9,
        } },
      // 5. Sharrows & Shared Streets - dotted bike green stroke
      { id: "trail-sharrow", type: "line", source: "trails", minzoom: 11,
        filter: ["==", ["get", "facility"], "sharrow"],
        paint: {
          "line-color": trailSharrow,
          "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.1, 13, 1.5, 15, 2.0, 17, 2.6],
          "line-dasharray": [1.2, 3],
          "line-opacity": 0.85,
        } },
      // 6. Unpaved / gravel trails
      { id: "trail-dash", type: "line", source: "trails",
        filter: ["==", ["get", "surface"], "unpaved"],
        paint: {
          "line-color": theme === "dark" ? "#fbbf24" : "#b45309",
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.8, 11, 2.2, 13, 2.8, 15, 3.6, 17, 4.5],
          "line-dasharray": [3, 2],
          "line-opacity": 0.92,
        } },
      // 7. Labels along major trails and protected bike lanes
      { id: "trail-labels", type: "symbol", source: "trails", minzoom: 11,
        layout: {
          "symbol-placement": "line", "symbol-spacing": 350,
          "text-field": ["get", "name"], "text-font": F_REG,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9.5, 13, 10.5, 16, 12],
          "text-padding": 8, "text-optional": true,
        },
        paint: {
          "text-color": trailText, "text-halo-color": trailHalo, "text-halo-width": 1.8, "text-opacity": 0.95,
        } },
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
    // How soon each kind of place shows as you zoom in: landmarks first, then parks and colleges, then
    // schools, libraries and civic buildings. (A POI's own "rank" is only its order within a tile, so
    // it can't say which are important; every tier is its own layer so a zoom needs no expression.)
    const TIERS = [[13, ["zoo", "museum", "stadium", "hospital", "ferry"]], [14, ["park"]], [15, ["school", "library", "civic", "sight"]]];
    const layer = (z, kinds, i) => ({ id: "poi" + z, type: "symbol", source: "base", "source-layer": "poi", minzoom: z,
      filter: ["all", ["has", "name"], ["in", kind, ["literal", kinds]]],
      layout: { "icon-image": ["concat", "poi:", kind, ":", dark ? "d" : "l"], "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.85, 17, 1],
        "text-field": ["get", "name"], "text-font": F_REG, "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10.5, 17, 12],
        "text-anchor": "left", "text-offset": [0.95, 0], "text-max-width": 8, "text-padding": 4, "icon-padding": 3, "text-optional": true },
      paint: { "text-color": color, "text-halo-color": P.halo, "text-halo-width": 1.5, "text-opacity": 0.92 } });
    return [
      ...TIERS.map(([z, kinds], i) => layer(z, kinds, i)).reverse(), // the most notable are placed first
      // highway numbers: Interstate, US and state routes, sparsely
      { id: "shields", type: "symbol", source: "base", "source-layer": "transportation_name", minzoom: 9,
        filter: ["all", ["in", ["get", "network"], ["literal", ["us-interstate", "us-highway", "us-state"]]], ["has", "ref"],
          ["<=", ["length", ["to-string", ["get", "ref"]]], 4]],
        layout: { "symbol-placement": "line", "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 9, 260, 13, 520, 16, 800],
          "icon-image": ["concat", "shield:", ["get", "network"], ":", ["to-string", ["get", "ref"]]], "icon-rotation-alignment": "viewport",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.72, 13, 0.85, 16, 0.95], "icon-padding": 30, "symbol-avoid-edges": true } },
    ];
  }
  // Place glyphs deliberately have no enclosing disc: the transit map already
  // uses circles for stops and live vehicles, while a standalone symbol reads
  // as a landmark at a glance.
  function drawPoiIcon(id) {
    const [, kind, th] = id.split(":");
    const color = (th === "d" ? POI_COLOR_D : POI_COLOR)[kind] || "#777";
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), S = Math.round(20 * dpr), c = S / 2, R = 8.6 * dpr;
    const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const x = cv.getContext("2d");
    x.save(); x.translate(c, c); x.scale(R * 0.72, R * 0.72); x.fillStyle = color; x.strokeStyle = color; x.lineCap = "round"; x.lineJoin = "round";
    x.shadowColor = th === "d" ? "rgba(0,0,0,.9)" : "rgba(255,255,255,.96)"; x.shadowBlur = 1.8 * dpr;
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

  // POIs use our own small SVG glyph family.  System emoji vary by platform
  // (and read as Apple emoji on macOS), so never use them for destination UI.
  function poiIconSVG(kind, size = 18) {
    const shapes = {
      school: '<path d="M2 9 12 4l10 5-10 5L2 9Zm4 3.1V17c2.3 2 7.7 2 12 0v-4.9l-6 3-6-3ZM21 10v6"/>',
      hospital: '<path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7V2Z"/>',
      stadium: '<path d="M3 7h18l-2 13H5L3 7Zm3-4h12v4H6V3Zm2 8h8v2H8v-2Zm-1 4h10v2H7v-2Z"/>',
      sight: '<path d="m12 2 2.75 5.57L21 8.48l-4.5 4.38 1.06 6.19L12 16.16l-5.56 2.9 1.06-6.19L3 8.48l6.25-.91L12 2Z"/>',
      park: '<path d="M12 2c-4.2 0-7 3.1-7 6.6 0 2.3 1.3 4.1 3.1 5.2L5 18h14l-3.1-4.2c1.8-1.1 3.1-2.9 3.1-5.2C19 5.1 16.2 2 12 2Zm0 3 1.4 2.5 2.8.5-2 2 .4 2.8-2.6-1.3-2.6 1.3.4-2.8-2-2 2.8-.5L12 5Z"/>',
      zoo: '<path d="M7 8.2C4 8.2 2 10.5 2 13.3 2 16 4.3 18 7 18c1.7 0 3.1-.8 4-2.1.9 1.3 2.3 2.1 4 2.1 2.7 0 5-2 5-4.7 0-2.8-2-5.1-5-5.1-1.2 0-2.3.4-3.1 1.1-.8-.7-1.9-1.1-3.1-1.1ZM7 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm10 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/>',
      museum: '<path d="M2 9 12 3l10 6v2H2V9Zm2 4h3v6H4v2h16v-2h-3v-6h3v-2H4v2Zm6 0h4v6h-4v-6Z"/>',
      library: '<path d="M4 3h5v18H4V3Zm6 0h4v18h-4V3Zm5 2h5v16h-5V5Z"/>',
      ferry: '<path d="M3 13h18l-2 6H5l-2-6Zm3-8h12v7H6V5Zm2 2v3h3V7H8Zm5 0v3h3V7h-3ZM4 21c1.3-1 2.7-1 4 0 1.3-1 2.7-1 4 0 1.3-1 2.7-1 4 0"/>',
      civic: '<path d="M3 9 12 4l9 5v2H3V9Zm2 4h3v6H5v2h14v-2h-3v-6h3v-2H5v2Zm6 0h2v6h-2v-6Z"/>',
      place: '<path d="M12 2a7 7 0 0 0-7 7c0 5.1 7 13 7 13s7-7.9 7-13a7 7 0 0 0-7-7Zm0 10.2A3.2 3.2 0 1 1 12 5.8a3.2 3.2 0 0 1 0 6.4Z"/>'
    };
    return `<svg class="poi-glyph" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">${shapes[kind] || shapes.place}</svg>`;
  }

  function poiKindFromBadge(badge) {
    const text = `${badge?.label || ""}`.toLowerCase();
    if (/ferry|marina/.test(text)) return "ferry";
    if (/hospital|medical|pharmacy/.test(text)) return "hospital";
    if (/university|school/.test(text)) return "school";
    if (/stadium|arena/.test(text)) return "stadium";
    if (/park|garden|camp|golf|zoo|aquarium/.test(text)) return /zoo|aquarium/.test(text) ? "zoo" : "park";
    if (/museum|theater|arts|civic|government|library/.test(text)) return /library/.test(text) ? "library" : (/civic|government/.test(text) ? "civic" : "museum");
    if (/landmark|tower|viewpoint|bridge/.test(text)) return "sight";
    return "place";
  }

  const poiKindTitle = (kind) => ({
    school: "College / University", hospital: "Hospital / Medical Center", stadium: "Stadium / Arena", sight: "Major Point of Interest",
    park: "Park / Recreation", zoo: "Zoo / Aquarium", museum: "Museum / Culture", library: "Public Library", ferry: "Ferry Terminal", civic: "Civic Landmark"
  })[kind] || "Point of Interest";

  const poiColor = (kind) => (theme === "dark" ? POI_COLOR_D : POI_COLOR)[kind] || "#3b82f6";

  const KEY_DESTINATIONS = [
    { id: "dest-space-needle", name: "Space Needle & Seattle Center", short: "Space Needle", kind: "sight", desc: "Seattle icon, Seattle Center Monorail terminal, Chihuly Garden and Glass, and Pacific Science Center.", coords: [-122.3493, 47.6205], transit: "Seattle Center Monorail, RapidRide D Line, Routes 1, 2, 3, 4, 13, 24, 33" },
    { id: "dest-pike-place", name: "Pike Place Market", short: "Pike Place Market", kind: "sight", desc: "Historic public market overlooking Elliott Bay, opened in 1907.", coords: [-122.3421, 47.6097], transit: "Westlake Link Station (1 Line, 2 Line), Routes 1, 2, 3, 4, 7, 14, 24, 33, 40, 70, RapidRide C, D, E, H" },
    { id: "dest-aquarium", name: "Seattle Aquarium & Waterfront", short: "Seattle Aquarium", kind: "zoo", desc: "Puget Sound marine exhibits on Pier 59 and the Ocean Pavilion.", coords: [-122.3425, 47.6074], transit: "Colman Dock Ferries, Pier 50 Water Taxi, Routes 1, 2, 3, 4, 24, 33, RapidRide C" },
    { id: "dest-climate-pledge", name: "Climate Pledge Arena", short: "Climate Pledge Arena", kind: "stadium", desc: "Home of Seattle Kraken (NHL) and Seattle Storm (WNBA).", coords: [-122.3539, 47.6221], transit: "Seattle Center Monorail, Routes 1, 2, 3, 4, 13, 24, 33, RapidRide D Line" },
    { id: "dest-tmobile-park", name: "T-Mobile Park", short: "T-Mobile Park", kind: "stadium", desc: "Home of Seattle Mariners (MLB), retractable roof ballpark in SoDo.", coords: [-122.3325, 47.5914], transit: "Stadium & SODO Link Stations (1 Line, 2 Line), Sounder Trains, Routes 21, 101, 131, 132, 150" },
    { id: "dest-lumen-field", name: "Lumen Field & Event Center", short: "Lumen Field", kind: "stadium", desc: "Home of Seattle Seahawks (NFL) and Seattle Sounders FC (MLS).", coords: [-122.3316, 47.5952], transit: "Stadium & Pioneer Square Link Stations, King Street Station (Sounder/Amtrak), Routes 21, 101, 124, 150" },
    { id: "dest-uw", name: "University of Washington", short: "Univ of Washington", kind: "school", desc: "Flagship public university in the U District, campus for 50,000 students.", coords: [-122.3035, 47.6553], transit: "Univ of Washington & U District Link Stations (1 Line), Routes 44, 45, 65, 75, 255, 372" },
    { id: "dest-seattle-u", name: "Seattle University", short: "Seattle University", kind: "school", desc: "Jesuit Catholic university campus on First Hill.", coords: [-122.3175, 47.6104], transit: "First Hill Streetcar, RapidRide G Line, Routes 2, 3, 4, 12, 193" },
    { id: "dest-spu", name: "Seattle Pacific University", short: "Seattle Pacific Univ", kind: "school", desc: "Private Christian university campus in northern Queen Anne.", coords: [-122.3618, 47.6495], transit: "Routes 13, 31, 32" },
    { id: "dest-scc", name: "Seattle Central College", short: "Seattle Central College", kind: "school", desc: "Community college campus on Capitol Hill directly next to light rail.", coords: [-122.3195, 47.6163], transit: "Capitol Hill Link Station (1 Line), First Hill Streetcar, Routes 8, 10, 49" },
    { id: "dest-bellevue-college", name: "Bellevue College", short: "Bellevue College", kind: "school", desc: "Largest open-access higher education institution in Washington State.", coords: [-122.1485, 47.5855], transit: "Routes 226, 245, 271, Sound Transit 554" },
    { id: "dest-harborview", name: "Harborview Medical Center", short: "Harborview Hospital", kind: "hospital", desc: "Only Level 1 adult and pediatric trauma center in WA, AK, MT, and ID.", coords: [-122.3245, 47.6042], transit: "First Hill Streetcar, Routes 3, 4, 193" },
    { id: "dest-swedish-first-hill", name: "Swedish Medical Center - First Hill", short: "Swedish First Hill", kind: "hospital", desc: "Largest hospital campus in Seattle with cardiac and cancer centers.", coords: [-122.3235, 47.6085], transit: "First Hill Streetcar, RapidRide G Line, Routes 2, 3, 4, 12" },
    { id: "dest-virginia-mason", name: "Virginia Mason Medical Center", short: "Virginia Mason", kind: "hospital", desc: "Major multi-specialty medical center on First Hill.", coords: [-122.3298, 47.6095], transit: "RapidRide G Line, Routes 2, 3, 4, 12" },
    { id: "dest-childrens", name: "Seattle Children's Hospital", short: "Children's Hospital", kind: "hospital", desc: "Premier pediatric referral hospital for the Pacific Northwest.", coords: [-122.2825, 47.6625], transit: "Routes 65, 75" },
    { id: "dest-uw-medical", name: "UW Medical Center - Montlake", short: "UW Medical Center", kind: "hospital", desc: "World-renowned academic medical center adjacent to Husky Stadium.", coords: [-122.3090, 47.6495], transit: "Univ of Washington Link Station (1 Line), Routes 44, 45, 65, 75, 255" },
    { id: "dest-colman-dock", name: "Colman Dock (Pier 52 WSF)", short: "Colman Dock (WSF)", kind: "ferry", desc: "Washington State Ferries terminal for Bainbridge Island and Bremerton.", coords: [-122.3385, 47.6015], transit: "WSF Bainbridge & Bremerton Ferries, Pioneer Square Link Station, Routes 1, 2, 3, 4, 24, 33" },
    { id: "dest-pier-50", name: "Pier 50 Passenger Ferry Terminal", short: "Pier 50 Ferry Terminal", kind: "ferry", desc: "Passenger-only fast ferries to West Seattle, Vashon, Bremerton, and Kingston.", coords: [-122.3375, 47.6005], transit: "King County Water Taxi, Kitsap Fast Ferries, Pioneer Square Link Station" },
    { id: "dest-woodland-zoo", name: "Woodland Park Zoo", short: "Woodland Park Zoo", kind: "zoo", desc: "Award-winning 92-acre zoological garden in Phinney Ridge.", coords: [-122.3540, 47.6685], transit: "RapidRide E Line, Route 5" },
    { id: "dest-museum-flight", name: "Museum of Flight", short: "Museum of Flight", kind: "museum", desc: "Largest independent non-profit air and space museum in the world at Boeing Field.", coords: [-122.2980, 47.5185], transit: "Route 124" },
    { id: "dest-mopop", name: "Museum of Pop Culture (MoPOP)", short: "MoPOP", kind: "museum", desc: "Iconic Frank Gehry building dedicated to music, sci-fi, and pop culture.", coords: [-122.3482, 47.6215], transit: "Seattle Center Monorail, Routes 1, 2, 3, 4, 13, 24, 33, RapidRide D" },
    { id: "dest-spl-central", name: "Seattle Central Library", short: "Central Library", kind: "library", desc: "Architecturally celebrated Rem Koolhaas 11-story glass downtown library.", coords: [-122.3330, 47.6067], transit: "Symphony Link Station, Routes 2, 3, 4, 7, 12, 14, 24, 33, 40, RapidRide C, D, E, G, H" },
    { id: "dest-convention-center", name: "Seattle Convention Center", short: "Convention Center", kind: "civic", desc: "Arch and Summit convention buildings in Downtown Seattle.", coords: [-122.3320, 47.6115], transit: "Westlake Link Station, First Hill Streetcar, Routes 7, 10, 11, 49, RapidRide G Line" },
    { id: "dest-discovery-park", name: "Discovery Park", short: "Discovery Park", kind: "park", desc: "Seattle's largest city park (534 acres) on Magnolia overlooking Puget Sound.", coords: [-122.4180, 47.6580], transit: "Route 24, Route 33" },
    { id: "dest-green-lake", name: "Green Lake Park", short: "Green Lake Park", kind: "park", desc: "Beloved freshwater lake with 2.8-mile recreation loop trail.", coords: [-122.3290, 47.6795], transit: "Roosevelt Link Station, Routes 20, 45, 62, RapidRide E Line" },
    { id: "dest-gas-works", name: "Gas Works Park", short: "Gas Works Park", kind: "park", desc: "Iconic former gasification plant park on the north shore of Lake Union.", coords: [-122.3345, 47.6455], transit: "Route 31, Route 32, Route 62" },
    { id: "dest-volunteer-park", name: "Volunteer Park", short: "Volunteer Park", kind: "park", desc: "Capitol Hill Olmsted-designed park with Seattle Asian Art Museum and Conservatory.", coords: [-122.3150, 47.6300], transit: "Route 10, Route 49" },
    { id: "dest-seward-park", name: "Seward Park", short: "Seward Park", kind: "park", desc: "300-acre peninsula on Lake Washington with old-growth forest and beach.", coords: [-122.2530, 47.5500], transit: "Route 50" },
    { id: "dest-alki-beach", name: "Alki Beach Park", short: "Alki Beach", kind: "park", desc: "Famous 2.5-mile beach strip along Puget Sound with skyline views.", coords: [-122.4080, 47.5815], transit: "Route 50, King County Water Taxi (West Seattle Route)" },
    { id: "dest-arboretum", name: "Washington Park Arboretum", short: "Arboretum", kind: "park", desc: "230-acre botanical collection on Lake Washington with Japanese Garden.", coords: [-122.2950, 47.6360], transit: "Route 11, Route 43, Route 48" },
    { id: "dest-tacoma-dome", name: "Tacoma Dome & Station", short: "Tacoma Dome", kind: "stadium", desc: "Major indoor arena and southern Sound Transit / Amtrak rail hub.", coords: [-122.4270, 47.2420], transit: "Sounder S Line, T Line Light Rail, Amtrak Cascades, Pierce Transit" }
  ];
  function destinationsGeoJSON() {
    const dark = theme === "dark";
    const colors = dark ? POI_COLOR_D : POI_COLOR;
    return {
      type: "FeatureCollection",
      features: KEY_DESTINATIONS.map((d) => ({
        type: "Feature",
        properties: {
          id: d.id,
          name: d.name,
          short: d.short,
          kind: d.kind,
          rank: PROMINENT_DESTINATION_IDS.has(d.id) ? 2 : 1,
          color: colors[d.kind] || (dark ? "#fff" : "#1d1d1f"),
          transit: d.transit,
        },
        geometry: { type: "Point", coordinates: d.coords },
      })),
    };
  }

  // These are wayfinding anchors rather than an exhaustive directory. They stay
  // visible from a regional view; the remaining custom destinations appear as
  // the rider zooms closer so Downtown does not turn into a field of labels.
  const PROMINENT_DESTINATION_IDS = new Set([
    "dest-space-needle", "dest-pike-place", "dest-climate-pledge", "dest-tmobile-park", "dest-lumen-field",
    "dest-uw", "dest-childrens", "dest-colman-dock", "dest-pier-50", "dest-woodland-zoo",
    "dest-museum-flight", "dest-green-lake", "dest-alki-beach", "dest-tacoma-dome"
  ]);
  // The transparent circle is an intentionally generous, direct-tap target for
  // every custom POI, including a label or glyph that MapLibre has collided out.
  const DESTINATION_LAYER_IDS = ["destinations-hit", "destinations-major-icon", "destinations-major-label", "destinations-icon", "destinations-label"];

  function destLayers(P) {
    const dark = theme === "dark";
    const major = [">=", ["get", "rank"], 2];
    const detail = ["<", ["get", "rank"], 2];
    return [
      {
        id: "destinations-hit",
        type: "circle",
        source: "destinations",
        minzoom: 9.6,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9.6, 22, 14, 26],
          // Near-transparent rather than fully transparent so MapLibre keeps
          // the feature in its rendered-feature hit-test index.
          "circle-opacity": 0.01,
          "circle-stroke-opacity": 0,
        },
      },
      // A small, curated set of regional anchors: unlike ordinary tile POIs,
      // these icons never disappear in a collision and are visible before the
      // detailed custom destinations below.
      {
        id: "destinations-major-icon",
        type: "symbol",
        source: "destinations",
        minzoom: 9.6,
        filter: major,
        layout: {
          "icon-image": ["concat", "poi:", ["get", "kind"], ":", dark ? "d" : "l"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9.6, 0.92, 13, 1.08],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-padding": 10,
          "symbol-sort-key": ["get", "rank"],
        },
      },
      {
        id: "destinations-major-label",
        type: "symbol",
        source: "destinations",
        minzoom: 10.5,
        filter: major,
        layout: {
          "text-field": ["get", "short"],
          "text-font": F_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 10.5, 9.5, 15, 12],
          "text-anchor": "left",
          "text-offset": [1.05, 0],
          "text-max-width": 8,
          "text-padding": 5,
          "text-optional": true,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: {
          "text-color": ["get", "color"],
          "text-halo-color": P.halo,
          "text-halo-width": 1.8,
        },
      },
      {
        id: "destinations-icon",
        type: "symbol",
        source: "destinations",
        minzoom: 11.2,
        filter: detail,
        layout: {
          "icon-image": ["concat", "poi:", ["get", "kind"], ":", dark ? "d" : "l"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 11.2, 0.82, 14, 1.05],
          "icon-allow-overlap": false,
          "icon-ignore-placement": false,
          "icon-padding": 8,
        },
      },
      {
        id: "destinations-label",
        type: "symbol",
        source: "destinations",
        minzoom: 11.8,
        filter: detail,
        layout: {
          "text-field": ["get", "short"],
          "text-font": F_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11.8, 10, 15, 12],
          "text-anchor": "left",
          "text-offset": [0.95, 0],
          "text-max-width": 8,
          "text-optional": true,
          "text-padding": 4,
        },
        paint: {
          "text-color": ["get", "color"],
          "text-halo-color": P.halo,
          "text-halo-width": 1.6,
        },
      },
    ];
  }

  function showDestination(d) {
    selected = { type: "dest", id: d.id };
    panelView = "dest";
    openSheet("half");
    map.easeTo({ center: d.coords, zoom: Math.max(map.getZoom(), 14.5), duration: 700 });
    let destRoutes = [];
    try {
      const nearbyStopsList = findNearbyStops(d.coords[1], d.coords[0], 450, 900);
      const nearbyRouteIds = new Set();
      for (const item of nearbyStopsList) {
        for (const rid of (item.stop.routes || [])) nearbyRouteIds.add(rid);
      }
      destRoutes = [...nearbyRouteIds].map((id) => RBY[id]).filter((r) => r && LINEIDX[r.id] != null).sort(tagOrder);
    } catch (_) {}
    // A destination behaves like a compact route focus: its nearby transit
    // stays bright, while every unrelated line fades into the background.
    if (destRoutes.length) {
      setNetDim(0.18);
      focusRoutes(destRoutes, true, { glow: true, widthScale: 1.45 });
    } else {
      setNetDim(0.38);
      focusOff();
    }
    const html = `${backBtn}
      <div class="destination-view">
        <div class="hero">
          <span class="poi-icon-badge ${esc(d.kind)}">${poiIconSVG(d.kind, 25)}</span>
          <div>
            <h2>${esc(d.name)}</h2>
            <p>${esc(poiKindTitle(d.kind))}</p>
          </div>
        </div>
        <p class="desc">${esc(d.desc)}</p>
        <div class="card-actions">
          <button type="button" class="action-btn dir-inapp-btn dest press" data-dir-dest-lat="${d.coords[1]}" data-dir-dest-lon="${d.coords[0]}" data-dir-dest-name="${esc(d.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            <span>Plan trip here</span>
          </button>
          <button type="button" class="action-btn dir-inapp-btn orig press" data-dir-orig-lat="${d.coords[1]}" data-dir-orig-lon="${d.coords[0]}" data-dir-orig-name="${esc(d.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>Trip from here</span>
          </button>
        </div>
        <h3 class="section">Transit Connections</h3>
        <div class="dest-transit-card">
          <span class="dest-tr-icon">🚌</span>
          <div class="dest-tr-text">
            <strong>Serving routes & stations</strong>
            <p>${esc(d.transit)}</p>
          </div>
        </div>
        ${destRoutes.length ? `
          <div class="dest-routes-list">
            <h4 class="dest-routes-title">Nearby routes · Tap to follow on map</h4>
            <div class="sc-badges">
              ${destRoutes.map((r) => `<button type="button" class="dest-route-badge-btn press" data-dest-route="${esc(r.id)}" title="${esc(routeTitle(r))}">${badgeHTML(r)}</button>`).join("")}
            </div>
          </div>
        ` : ""}
      </div>`;
    setView(html);
    $("#back").addEventListener("click", () => {
      selected = null;
      panelView = null;
      setNetDim(1);
      focusOff();
      showRouteStops(null);
      showHome();
    });
    body().querySelectorAll("[data-dest-route]").forEach((b) => {
      b.addEventListener("click", () => {
        selectRoute(b.dataset.destRoute, { fit: true });
      });
    });
  }
  function liveLayers(P) {
    return [
      // an upright badge that says what it is: a bus, a train, a streetcar or a boat...
      { id: "veh-icon", type: "symbol", source: "vehicles",
        layout: { "icon-image": ["concat", "veh:", ["get", "c"], ":", ["get", "m"]], "icon-rotation-alignment": "viewport",
          "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": VEH_SIZE, "symbol-sort-key": ["get", "s"] },
        paint: { "icon-opacity": ["case", ["==", ["get", "est"], 1], 0.82, 1] } },
      // ...and which way it's heading: the badge's point, turning with the vehicle
      { id: "veh-dir", type: "symbol", source: "vehicles", filter: [">=", ["get", "b"], 0],
        layout: { "icon-image": ["concat", "vdir:", ["get", "c"]], "icon-rotate": ["get", "b"], "icon-rotation-alignment": "map",
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
    // MapLibre allows exactly one camera (zoom) expression per paint value. Keep
    // the suspension check inside that interpolation rather than putting two
    // zoom expressions in a case branch.
    const suspendedZr = (suspended, regular) => ["interpolate", ["linear"], ["zoom"], ...regular.flatMap(([z, v], i) => [z,
      ["case", ["==", ["get", "suspended"], 1], suspended[i][1] * k, v * k]])];
    return [
      { id: "stops", type: "circle", source: "stops", minzoom: 14.6,
        paint: {
          "circle-radius": suspendedZr([[14.6, 2.8], [16, 4.4], [18, 6.8]], [[14.6, 2], [16, 3.4], [18, 5.5]]),
          "circle-color": ["case", ["==", ["get", "suspended"], 1], "#d0213b", P.stopFill],
          "circle-stroke-color": ["case", ["==", ["get", "suspended"], 1], "#ffffff", P.stopStroke],
          "circle-stroke-width": suspendedZr([[14.6, 1.4], [17, 2.2]], [[14.6, 1], [17, 1.6]]),
        } },
      { id: "stop-name", type: "symbol", source: "stops", minzoom: 17.2,
        layout: { "text-field": ["get", "name"], "text-font": F_REG, "text-size": 11, "text-variable-anchor": ["left", "right"],
          "text-radial-offset": 0.8, "text-max-width": 9, "text-optional": true, "text-padding": 6 },
        paint: { "text-color": ["case", ["==", ["get", "suspended"], 1], "#d0213b", P.label], "text-halo-color": P.halo, "text-halo-width": 1.4 } },
      { id: "stations", type: "circle", source: "stations",
        filter: ["any", ["==", ["get", "major"], 1], [">=", ["zoom"], 14], ["all", ["==", ["get", "late"], 0], [">=", ["zoom"], 12.5]]],
        paint: {
          // sized to the Link line: a little wider than the line it sits on (about 1.4x), so it
          // reads as a station without turning into a blob
          "circle-radius": zr([[9, ["*", ["get", "size"], 1.8]], [12, ["*", ["get", "size"], 2.9]], [14, ["*", ["get", "size"], 3.7]],
            [16, ["*", ["get", "size"], 4.9]], [18, ["*", ["get", "size"], 6.4]]]),
          "circle-color": ["case", ["==", ["get", "suspended"], 1], "#d0213b", P.stationFill],
          "circle-stroke-color": ["case", ["==", ["get", "suspended"], 1], "#ffffff", ["get", "stroke"]],
          "circle-stroke-width": zr([[9, 1.1], [12, 1.5], [14, 1.9], [17, 2.4]]),
        } },
      { id: "station-name", type: "symbol", source: "stations",
        filter: ["any", ["all", ["==", ["get", "major"], 1], [">=", ["zoom"], 11]], [">=", ["zoom"], 14.3]],
        layout: { "text-field": ["get", "name"], "text-font": F_BOLD,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10.5, 15, 13],
          "text-variable-anchor": ["right", "left", "top", "bottom"], "text-radial-offset": 0.9, "text-justify": "auto",
          "text-max-width": 8, "text-padding": 2 },
        paint: { "text-color": ["case", ["==", ["get", "suspended"], 1], "#d0213b", P.place], "text-halo-color": P.halo, "text-halo-width": 2 } },
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

  function tripLayers(P) {
    const walkCase = theme === "dark" ? "#0f172a" : "#ffffff";
    const walkColor = theme === "dark" ? "#38bdf8" : "#0284c7";
    const lineCase = theme === "dark" ? "#0b1120" : "#ffffff";
    return [
      { id: "trip-line-glow", type: "line", source: "tripline",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 14,
          "line-blur": 6,
          "line-opacity": 0.58,
        } },
      { id: "trip-line-case", type: "line", source: "tripline",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": lineCase,
          "line-width": 7.2,
          "line-opacity": 0.98,
        } },
      { id: "trip-line-core", type: "line", source: "tripline",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 4.8,
          "line-opacity": 1.0,
        } },
      { id: "trip-line-rail", type: "line", source: "tripline",
        filter: ["==", ["get", "isRail"], 1],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 1.8,
          "line-opacity": 0.95,
        } },
      { id: "trip-walk-case", type: "line", source: "tripwalk",
        paint: { "line-color": walkCase, "line-width": 5.5, "line-opacity": 0.95 } },
      { id: "trip-walk-line", type: "line", source: "tripwalk",
        paint: {
          "line-color": walkColor,
          "line-width": 3.4,
          "line-dasharray": [1.5, 1.8],
          "line-opacity": 0.98,
        } },
      { id: "trip-pts-case", type: "circle", source: "trippts",
        paint: {
          "circle-radius": ["case", ["in", ["get", "role"], ["literal", ["orig", "dest"]]], 10.5, 8],
          "circle-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "rgba(0,0,0,0.3)",
        } },
      { id: "trip-pts-circle", type: "circle", source: "trippts",
        paint: {
          "circle-radius": ["case", ["in", ["get", "role"], ["literal", ["orig", "dest"]]], 9, 6.5],
          "circle-color": ["get", "color"],
        } },
      { id: "trip-pts-label", type: "symbol", source: "trippts",
        layout: {
          "text-field": ["get", "label"],
          "text-font": F_BOLD,
          "text-size": 11.5,
          "text-variable-anchor": ["top", "bottom", "left", "right"],
          "text-radial-offset": 1.1,
          "text-max-width": 10,
          "text-padding": 3,
        },
        paint: {
          "text-color": P.label,
          "text-halo-color": P.halo,
          "text-halo-width": 2,
        } },
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
  // so it runs in a worker started from the geometry script (geom.js); the page only hands the
  // finished lines to the map. Where workers aren't allowed the same engine runs here instead.
  let lastParams = null, ribbons = null;
  const drawStats = { requested: 0, applied: 0, deferred: 0 };
  let worker = null, engine = null, inFlight = null, queued = null, buildSeq = 0, appliedSeq = 0, lastBuildMs = 0, watchdog = 0;
  const idleWaiters = [];
  function engineInit() {
    return { edges: NET.edges, lines: LINES.map((r) => ({ cat: dkey(r), rank: r._rank })), cat: CAT, gap: GAP };
  }
  function runHere() {
    if (worker) { worker.terminate(); worker = null; }
    clearTimeout(watchdog);
    inFlight = queued = null;
    routeFlight = queuedRoute = null;
    if (!engine) engine = KCTMGeom.createEngine(engineInit());
  }
  function startEngine() {
    if (/[?&]noworker\b/.test(location.search)) { runHere(); return; } // for testing the fallback
    try {
      // the website loads geom.js as a file, which the worker reuses from the browser's cache;
      // the one-file preview has it inline, so the worker starts from that text instead
      const el = document.getElementById("geom-src");
      const ribbonEl = document.getElementById("ribbons-src");
      worker = new Worker(el.src || URL.createObjectURL(new Blob([ribbonEl.textContent, "\n", el.textContent], { type: "text/javascript" })));
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "route") {
          const done = routeFlight; routeFlight = null;
          if (!queuedRoute && done?.id === m.id && !map.isMoving() && m.buildId === appliedSeq) done.cb(m.feats, m.mesh);
          if (queuedRoute) { const next = queuedRoute; queuedRoute = null; if (!map.isMoving()) sendRoute(next); }
          return;
        }
        if (m.type !== "built") return;
        clearTimeout(watchdog);
        inFlight = null;
        if (map.isMoving() && lastFeats.length) { needsRebuild = true; drawStats.deferred++; }
        else if (!queued) applyBuild(m);
        if (queued) { const q = queued; queued = null; if (map.isMoving()) needsRebuild = true; else send(q); }
        settleBuilds();
      };
      worker.onerror = () => { runHere(); rebuild(); };
      worker.postMessage({ type: "init", init: engineInit(), ribbonsURL: ribbonEl.src || null });
    } catch (err) {
      runHere();
    }
  }
  function send(msg) {
    drawStats.requested++;
    inFlight = msg;
    worker.postMessage({ type: "build", ...msg });
    clearTimeout(watchdog);
    // no answer at all (a blocked worker): draw on the page instead
    watchdog = setTimeout(() => { if (inFlight === msg) { runHere(); rebuild(); } }, 15000);
  }
  // one route's path in the current view's lanes (for hover previews), from the engine
  let routeSeq = 0, routeFlight = null, queuedRoute = null;
  function sendRoute(request) {
    routeFlight = request;
    worker.postMessage({ type: "route", id: request.id, idxs: request.idxs });
  }
  function requestRoutePaths(idxs, center, cb) {
    if (!worker) { cb(engine ? engine.routePaths(idxs, center) : []); return; }
    const request = { id: ++routeSeq, idxs, cb };
    if (routeFlight) queuedRoute = request;
    else sendRoute(request);
  }
  function applyBuild(m) {
    if (m.id < appliedSeq || !map || !map.getSource("net")) return;
    appliedSeq = m.id;
    drawStats.applied++;
    lastFeats = m.feats;
    lastSelFeats = m.selFeats;
    vehIx = vehIxSel = hitIx = null;
    lastBuildMs = m.ms || 0;
    if (ribbons) {
      ribbons.update("net", m.mesh || KCTMRibbons.compile(m.feats));
      ribbons.update("sel", m.selMesh || KCTMRibbons.compile(m.selFeats, { selected: true }));
    }
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
    settleBuilds();
  }
  function settleBuilds() { if (!inFlight && !queued && !needsRebuild) idleWaiters.splice(0).forEach((f) => f()); }

  const zStep = (z) => Math.max(9, Math.min(19, Math.round(z * 4) / 4));
  // Zoomed out, all-day and rush-hour buses are slimmer than frequent ones, so the busy
  // coverage map underneath stays readable and the frequent network stands out, while all-day
  // buses remain clearly visible across the region.
  function minorScale(z) {
    const f = z <= 10.0 ? 0.82 : z >= 12.5 ? 1 : 0.82 + 0.18 * (z - 10.0) / 2.5;
    return { local: f, peak: Math.max(0.50, f * 0.68), shuttle: f * 0.88, dart: f * 0.78 };
  }
  function tierFor(z) { const t = BUS_TIERS[settings.busDetail]; return z >= t[2] ? 2 : z >= t[1] ? 1 : 0; }
  let lastZ = -1, labelStep = null, needsRebuild = false, builtView = null, lastFeats = [], lastSelFeats = [];
  // The area last drawn (meters): the view plus a wide margin, so panning stays smooth.
  function viewBox(margin) {
    const b = map.getBounds();
    const [x0, y0] = toM(b.getWest(), b.getSouth()), [x1, y1] = toM(b.getEast(), b.getNorth());
    const mx = (x1 - x0) * margin, my = (y1 - y0) * margin;
    return [x0 - mx, y0 - my, x1 + mx, y1 + my];
  }
  function onMoveEnd() {
    if (!builtView) { rebuild(); return; }
    const v = viewBox(0.05);
    if (needsRebuild || Math.abs(map.getZoom() - lastZ) > 0.005 || v[0] < builtView[0] || v[1] < builtView[1] || v[2] > builtView[2] || v[3] > builtView[3]) rebuild();
    renderLive();
  }

  // Ask for the lines of the current view. Only one request is in the worker at a time; while
  // it works, newer requests replace each other, so a fast zoom only lays out where it stops.
  function rebuild() {
    if (!map || !map.getSource("net") || (!worker && !engine)) return;
    if (map.isMoving() && lastFeats.length) { needsRebuild = true; queued = null; return; }
    needsRebuild = false;
    const zNow = map.getZoom();
    const zs = zStep(zNow);
    // lanes are laid out for (nearly) the zoom on screen, so they follow a pinch closely
    const z = lastZ = Math.max(9, Math.min(19, Math.round(zNow * 50) / 50));
    const u = interp(UNIT, z) * THICK[settings.thickness];
    const tier = tierFor(zNow);
    let routeFilter = null;
    if (specialFilter === "favs") {
      const favSet = new Set(getFavs().routes || []);
      routeFilter = LINES.map((r, i) => (favSet.has(r.id) ? i : -1)).filter((i) => i >= 0);
    } else if (specialFilter === "nightowl") {
      routeFilter = LINES.map((r, i) => (isNightOwl(r) ? i : -1)).filter((i) => i >= 0);
    } else if (specialFilter === "snow") {
      routeFilter = LINES.map((r, i) => (isSnowRoute(r) ? i : -1)).filter((i) => i >= 0);
    }
    const anyCatOn = LAYERS.some((l) => enabled.has(l.key) && KEY_NAME[l.key]);
    const keyOn = {};
    for (const k of Object.keys(CAT)) {
      const catBase = CAT[k].base || k;
      const standardOn = (k === "sounder" ? enabledCat("sounder") || enabledCat("amtrak") : enabledCat(catBase)) && CAT[k].tier <= tier;
      if (specialFilter) {
        const catMatches = (routeFilter || []).some((i) => LINES[i] && (dkey(LINES[i]) === k || LINES[i].cat === k || LINES[i].cat === catBase));
        keyOn[k] = catMatches;
      } else {
        keyOn[k] = standardOn;
      }
    }
    const p = { z, zs, zNow, u, capU: interp(CAP_PX, z) / u, keyOn, routeFilter,
      selIdx: selected && selected.type === "route" ? LINEIDX[selected.id] : -1,
      view: (builtView = viewBox(0.45)), tags: tagSpacing(TAG_DENSITY[settings.tags], zNow), theme: theme[0], colors: netColors(theme),
      wscale: minorScale(zNow) };
    lastParams = p;
    const msg = { id: ++buildSeq, p };
    if (!worker) {
      const t = performance.now();
      const out = engine.build(p); drawStats.requested++;
      applyBuild({ id: msg.id, ms: performance.now() - t, ...out });
    } else if (inFlight) queued = msg;
    else send(msg);
  }
  // The existing GPU mesh follows the camera during a gesture. Retile and lay out only
  // the final view, so the gesture never competes with a stream of obsolete geometry.
  function onZoom() {
    needsRebuild = true;
  }

  // ---------------------------------------------------------------- route tags (canvas)
  // Plain, flat labels in the manner of the printed map: one small solid pill per service
  // type, route numbers side by side with hairline dividers, a thin halo to lift it off the
  // lines. On vertical corridors, the same compact pills stack with the road.
  function drawBadge(id) {
    const [, th, list, orientation = "h"] = id.split(":");
    const dark = th === "d";
    let rs = list.split(".").map((i) => LINES[+i]).filter(Boolean);
    const MAX = 6;
    let extra = 0;
    if (rs.length > MAX) { extra = rs.length - (MAX - 1); rs = rs.slice(0, MAX - 1); }
    const groups = [], all = list.split(".").map(Number);
    for (const r of rs) {
      const c = tagColor(r, dark ? "dark" : "light");
      const everyday = isEveryday(r);
      let g = groups.find((x) => x.c === c && x.everyday === everyday);
      if (!g) groups.push((g = { c, fg: everyday ? tagText(r, dark ? "dark" : "light") : c, everyday, items: [], refs: [] }));
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
    // Route tags remain upright for legibility.  On a north/south road their
    // pills stack in the direction of the road instead of becoming one long
    // horizontal obstruction; four or more use a compact 2-column grid.
    if (orientation === "v") {
      const cells = [];
      for (const g of groups) {
        g.items.forEach((label, index) => cells.push({ label, ref: g.refs[index], color: g.c, fg: g.fg, everyday: g.everyday, width: g.ws[index] }));
      }
      const cols = cells.length <= 3 ? 1 : 2;
      const cellGap = 2 * dpr;
      const cellW = Math.max(h, ...cells.map((cell) => cell.width + pad * 2));
      const rows = Math.ceil(cells.length / cols);
      const W = cols * cellW + (cols - 1) * cellGap + halo * 2;
      const H = rows * h + (rows - 1) * cellGap + halo * 2;
      cv.width = Math.ceil(W); cv.height = Math.ceil(H);
      ctx.font = font;
      ctx.textBaseline = "middle";
      const layout = { w: cv.width / dpr, h: cv.height / dpr, axis: "y", items: [] };
      cells.forEach((cell, index) => {
        const col = index % cols, row = Math.floor(index / cols);
        const x = halo + col * (cellW + cellGap), y = halo + row * (h + cellGap);
        ctx.fillStyle = dark ? "#1c1c1e" : "#ffffff";
        roundRect(ctx, x - halo, y - halo, cellW + halo * 2, h + halo * 2, rad + halo); ctx.fill();
        if (cell.everyday) {
          ctx.fillStyle = cell.color;
          roundRect(ctx, x, y, cellW, h, rad); ctx.fill();
        } else {
          ctx.fillStyle = dark ? "rgba(255,255,255,0.08)" : "#ffffff";
          roundRect(ctx, x, y, cellW, h, rad); ctx.fill();
          ctx.strokeStyle = cell.color;
          ctx.lineWidth = 1.25 * dpr;
          roundRect(ctx, x + 0.6 * dpr, y + 0.6 * dpr, cellW - 1.2 * dpr, h - 1.2 * dpr, rad - 0.5 * dpr); ctx.stroke();
        }
        const tx = x + (cellW - cell.width) / 2;
        ctx.fillStyle = cell.fg;
        ctx.fillText(cell.label, tx, y + h / 2 + 0.5 * dpr);
        const rRef = cell.ref && cell.ref.r != null ? LINES[cell.ref.r] : null;
        if (rRef && isRouteSuspended(rRef)) {
          ctx.strokeStyle = "#d0213b";
          ctx.lineWidth = 1.8 * dpr;
          ctx.beginPath();
          ctx.moveTo(tx - 2 * dpr, y + h - 2 * dpr);
          ctx.lineTo(tx + cell.width + 2 * dpr, y + 2 * dpr);
          ctx.stroke();
        }
        layout.items.push({ ...cell.ref, x0: x / dpr, x1: (x + cellW) / dpr, y0: y / dpr, y1: (y + h) / dpr });
      });
      BADGE_LAYOUT.set(id, layout);
      const data = ctx.getImageData(0, 0, cv.width, cv.height);
      if (!map.hasImage(id)) map.addImage(id, { width: cv.width, height: cv.height, data: data.data }, { pixelRatio: dpr });
      return;
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
      if (g.everyday) {
        ctx.fillStyle = g.c;
        roundRect(ctx, x, halo, g.w, h, rad); ctx.fill();
      } else {
        ctx.fillStyle = dark ? "rgba(255,255,255,0.08)" : "#ffffff";
        roundRect(ctx, x, halo, g.w, h, rad); ctx.fill();
        ctx.strokeStyle = g.c;
        ctx.lineWidth = 1.25 * dpr;
        roundRect(ctx, x + 0.6 * dpr, halo + 0.6 * dpr, g.w - 1.2 * dpr, h - 1.2 * dpr, rad - 0.5 * dpr); ctx.stroke();
      }
      let tx = x + (g.w - (g.ws.reduce((a, b) => a + b, 0) + sep * (g.items.length - 1))) / 2;
      g.items.forEach((t, k) => {
        ctx.fillStyle = g.fg;
        ctx.fillText(t, tx, halo + h / 2 + 0.5 * dpr);
        const ref = g.refs[k];
        const rRef = ref && ref.r != null ? LINES[ref.r] : null;
        if (rRef && isRouteSuspended(rRef)) {
          ctx.strokeStyle = "#d0213b";
          ctx.lineWidth = 1.8 * dpr;
          ctx.beginPath();
          ctx.moveTo(tx - 2 * dpr, halo + h - 2 * dpr);
          ctx.lineTo(tx + g.ws[k] + 2 * dpr, halo + 2 * dpr);
          ctx.stroke();
        }
        tx += g.ws[k];
        if (k < g.items.length - 1) {
          ctx.fillStyle = g.everyday ? (g.fg === "#ffffff" ? "rgba(255,255,255,0.42)" : "rgba(0,0,0,0.28)") : (dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)");
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
    const anyCatOn = LAYERS.some((l) => enabled.has(l.key) && KEY_NAME[l.key]);
    return { type: "FeatureCollection", features: STOPS.stations.filter((s) => s.routes && s.routes.some((id) => {
      const r = RBY[id];
      if (!r) return false;
      if (specialFilter && !routeMatchesFilter(r)) return false;
      return !anyCatOn || enabledCat(r.cat);
    })).map((s) => {
      const rs = s.routes.map((id) => RBY[id]).filter((r) => r && (!specialFilter || routeMatchesFilter(r)));
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
      return { type: "Feature", properties: { id: s.id, name: s.name, major: major ? 1 : 0, late: tOnly ? 1 : 0, size, stroke, snap, suspended: stopIsSuspended(s.id) ? 1 : 0 },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] } };
    }) };
  }
  function stopsGeoJSON() {
    const anyCatOn = LAYERS.some((l) => enabled.has(l.key) && KEY_NAME[l.key]);
    const list = STOPS.stops.filter((s) => {
      if (!s.routes) return true;
      if (!specialFilter && !anyCatOn) return false;
      return s.routes.some((id) => {
        const r = RBY[id];
        if (!r) return false;
        if (specialFilter && !routeMatchesFilter(r)) return false;
        return !anyCatOn || enabledCat(r.cat);
      });
    });
    return { type: "FeatureCollection", features: list.map((s) => ({ type: "Feature", properties: { id: s.id, name: s.name, suspended: stopIsSuspended(s.id) ? 1 : 0 },
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
    for (const set of [baseLayers(P), transitLayers(P), areaLayers(P), poiLayers(P), destLayers(P), stopLayers(P), tripLayers(P), liveLayers(P)]) {
      for (const L of set) {
        if (!map.getLayer(L.id)) continue;
        for (const [k, v] of Object.entries(L.paint || {})) map.setPaintProperty(L.id, k, v);
      }
    }
    for (const L of poiLayers(P)) if (map.getLayer(L.id) && L.layout && L.layout["icon-image"]) map.setLayoutProperty(L.id, "icon-image", L.layout["icon-image"]);
    for (const L of destLayers(P)) if (map.getLayer(L.id) && L.layout && L.layout["icon-image"]) map.setLayoutProperty(L.id, "icon-image", L.layout["icon-image"]);
    if (map.getSource("destinations")) map.getSource("destinations").setData(destinationsGeoJSON());
    refreshStations();
    rebuild();
    applySelectionStyle();
    renderFilterBar();
    if (!selected) showHome(panelView !== "corridor");
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
      let settled = false;
      const done = (f, v) => {
        if (settled) return;
        settled = true; clearTimeout(t); window[cb] = () => {}; el.remove();
        setTimeout(() => { delete window[cb]; }, 60000);
        f(v);
      };
      const t = setTimeout(() => done(fail, new Error("timeout")), ms);
      window[cb] = (data) => done(ok, data);
      el.onerror = () => done(fail, new Error("load"));
      el.src = `${url}${url.includes("?") ? "&" : "?"}callback=${cb}`;
      document.head.appendChild(el);
    });
  }
  const wsfDate = (x) => { const m = /Date\((\d+)/.exec(String(x || "")); return m ? +m[1] : 0; };
  const wsf = { vessels: new Map(), got: 0, attempt: 0, terminals: null, terminalGot: 0, terminalAttempt: 0, terminalLoading: null };
  const wsfState = () => wsf; // for the test scripts
  async function pollWsf() {
    if (!wsfOn() || Date.now() - wsf.attempt < 15000) return;
    wsf.attempt = Date.now();
    try {
      const list = await jsonp(`${LIVE.wsf.base}/vessels/rest/vessellocations?apiaccesscode=${encodeURIComponent(LIVE.wsf.code)}`);
      if (!Array.isArray(list)) throw new Error("vessel data unavailable");
      wsf.vessels = new Map(list.map((v) => [String(v.VesselID), v]));
      wsf.got = Date.now();
    } catch (e) { /* the boats still show from OneBusAway */ }
  }
  function syncWsfVessels(now) {
    if (Date.now() - wsf.got > 90000) return 0;
    let count = 0;
    for (const w of wsf.vessels.values()) {
      const r = RTMAP.get(`95_${w.DepartingTerminalID}${w.ArrivingTerminalID}`);
      const ts = wsfDate(w.TimeStamp) / 1000;
      if (!r || w.InService === false || !Number.isFinite(w.Latitude) || !Number.isFinite(w.Longitude) || !ts || Date.now() / 1000 - ts > 300) continue;
      const id = `95_${w.VesselID}`, to = [w.Longitude, w.Latitude], prev = live.vehicles.get(id);
      let from = to;
      if (prev) {
        const rawFrom = vehPos(prev, now);
        const d = geoDist(rawFrom, to);
        const isStale = (prev.t0 && (now - prev.t0 > 45000)) || prev.snap;
        from = (d > 1100 || isStale) ? to : rawFrom;
      }
      live.vehicles.set(id, { ...prev, id, agency: "95", vid: String(w.VesselID), r, ts,
        from, to, t0: now, b: Number.isFinite(w.Heading) ? w.Heading : -1,
        name: w.VesselName || WSF_VESSELS[w.VesselID] || "Ferry", head: w.ArrivingTerminalName || "", snap: false });
      count++;
    }
    if (count) { live.fresh = live.fresh || {}; live.fresh["95"] = wsf.got; }
    return count;
  }
  // "Left Kingston 2:05 PM · arrives Edmonds about 2:35 PM", "At the dock in Bainbridge Island · leaves 3:10 PM"
  function ferryLine(v) {
    const w = v && v.agency === "95" ? wsf.vessels.get(String(v.vid)) : null;
    if (!w || Date.now() - wsf.got > 90000 || Date.now() - wsfDate(w.TimeStamp) > 300000) return v && v.head ? esc(v.head) : "";
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

  // Fetch terminal conditions only while someone is viewing a WSF route or terminal.
  // Space counts are for vehicles; a full car deck says nothing about walk-on space.
  async function loadFerryTerminals() {
    if (!wsfOn() || document.hidden || Date.now() - wsf.terminalAttempt < 30000) return wsf.terminalLoading;
    wsf.terminalAttempt = Date.now();
    fillFerryInfo();
    const base = `${LIVE.wsf.base}/terminals/rest/`, code = encodeURIComponent(LIVE.wsf.code);
    wsf.terminalLoading = Promise.allSettled([
      jsonp(`${base}terminalwaittimes?apiaccesscode=${code}`),
      jsonp(`${base}terminalsailingspace?apiaccesscode=${code}`),
    ]).then(([notes, spaces]) => {
      const value = (r) => r.status === "fulfilled" && Array.isArray(r.value) ? r.value : [];
      wsf.terminals = { notes: value(notes), spaces: value(spaces) };
      wsf.terminalGot = Date.now();
      fillFerryInfo();
    }).finally(() => { wsf.terminalLoading = null; });
    return wsf.terminalLoading;
  }
  function ferryTerminalIds(s) {
    return [...new Set([s.id, ...(s.stops || []), ...(s.alias || [])].filter((id) => /^wsf-\d+$/.test(id)).map((id) => +id.slice(4)))];
  }
  function fillFerryInfo() {
    const box = $("#ferryInfo");
    if (!box) return;
    const ids = box.dataset.terminals.split(",").map(Number), data = wsf.terminals;
    const openTips = new Set([...box.querySelectorAll(".ferry-notes[open]")].map((el) => +el.dataset.terminal));
    const terminalName = (id) => data?.notes.find((t) => t.TerminalID === id)?.TerminalName || data?.spaces.find((t) => t.TerminalID === id)?.TerminalName || stopIndex[`wsf-${id}`]?.name || WSF_TERMINALS_INFO[id]?.name || "Ferry terminal";
    const routeWord = (s) => String(s || "").toLowerCase().replace(/\bpt\b/g, "point").replace(/\bisland\b/g, "").replace(/[^a-z0-9]/g, "");
    const now = Date.now(), fresh = data && now - wsf.terminalGot < 60000;
    const rows = [];
    for (const id of ids) {
      const notes = fresh && data.notes.find((t) => t.TerminalID === id);
      const spaces = fresh && data.spaces.find((t) => t.TerminalID === id);
      const name = terminalName(id), destinations = ids.filter((other) => other !== id).map(terminalName).map(routeWord);
      const waits = (notes?.WaitTimes || []).filter((w) => w.WaitTimeNotes && (!w.RouteName || ids.length === 1 || destinations.some((dest) => routeWord(w.RouteName).includes(dest))));
      const sailings = (spaces?.DepartingSpaces || []).filter((d) => wsfDate(d.Departure) >= now - 60000 && wsfDate(d.Departure) <= now + 3 * 3600000)
        .sort((a, b) => wsfDate(a.Departure) - wsfDate(b.Departure));
      const departures = sailings.flatMap((d) => (d.SpaceForArrivalTerminals || []).filter((a) => ids.length === 1 || ids.includes(a.TerminalID)).map((a) => {
        const count = a.DisplayDriveUpSpace && Number.isFinite(a.DriveUpSpaceCount) && a.DriveUpSpaceCount >= 0 ? a.DriveUpSpaceCount : null;
        const status = d.IsCancelled ? "Canceled" : count === 0 ? "Car deck full" : count != null ? `${count} drive-up vehicle spaces` : "Vehicle space not reported";
        return `<li><b>${esc(CLOCK.format(new Date(wsfDate(d.Departure))))} to ${esc(a.TerminalName)}</b><span>${esc(status)}</span></li>`;
      })).slice(0, 2);
      if (!waits.length && !departures.length) continue;
      rows.push(`<div class="ferry-terminal"><h4>${esc(name)}</h4>${departures.length ? `<ul class="ferry-sailings">${departures.join("")}</ul>` : ""}${waits.length ? `<details class="ferry-notes" data-terminal="${id}"${openTips.has(id) ? " open" : ""}><summary>WSF arrival tips</summary>${waits.map((w) => `${ids.length === 1 && w.RouteName ? `<p><b>${esc(w.RouteName)}</b></p>` : ""}<p>${esc(stripHTML(w.WaitTimeNotes))}</p>${wsfDate(w.WaitTimeLastUpdated) ? `<p class="foot">WSF note updated ${esc(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(wsfDate(w.WaitTimeLastUpdated))))}</p>` : ""}`).join("")}</details>` : ""}</div>`);
    }
    box.innerHTML = `<h3 class="section">Ferry terminal conditions</h3><div class="group ferry-conditions">${rows.length ? rows.join("") : `<p class="hint">${wsf.terminalAttempt && !wsf.terminalGot ? "Checking WSF terminal conditions…" : "WSF terminal conditions are currently unavailable."}</p>`}</div><p class="foot">${rows.length ? "From WSF, checked " + CLOCK.format(new Date(wsf.terminalGot)) + ". " : ""}Vehicle space changes as loading continues. Walk-on availability is separate.</p>`;
  }
  const WSF_TERMINALS_INFO = {
    1: { name: "Anacortes", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=1" },
    3: { name: "Bainbridge Island", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=3" },
    4: { name: "Bremerton", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=4" },
    5: { name: "Clinton", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=5" },
    7: { name: "Seattle (Colman Dock Pier 52)", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=7" },
    8: { name: "Edmonds", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=8" },
    9: { name: "Fauntleroy (West Seattle)", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=9" },
    11: { name: "Coupeville", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=11" },
    12: { name: "Kingston", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=12" },
    14: { name: "Mukilteo", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=14" },
    16: { name: "Point Defiance (Tacoma)", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=16" },
    20: { name: "Southworth (Port Orchard)", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=20" },
    21: { name: "Tahlequah (Vashon)", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=21" },
    22: { name: "Vashon Island", url: "https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=22" },
  };
  function showFerryInfo(ids) {
    if (!ids.length) return "";
    const termLinks = ids.map((id) => {
      const info = WSF_TERMINALS_INFO[id];
      const url = info?.url || (id ? `https://wsdot.com/ferries/vesselwatch/TerminalDetail.aspx?terminalid=${id}` : "");
      const name = info?.name || stopIndex[`wsf-${id}`]?.name || "Terminal";
      if (!url) return "";
      return `<a class="link-out press" href="${url}" target="_blank" rel="noopener" style="margin-top:4px">⛴️ ${esc(name)} Guide & Loading Webcams<span aria-hidden="true">↗</span></a>`;
    }).filter(Boolean).join("");
    const driveUpLink = `<a class="link-out press" href="https://wsdot.com/ferries/vesselwatch/terminals.aspx" target="_blank" rel="noopener" style="margin-top:4px">🚗 Real-time Drive-Up Space & Terminal Cameras<span aria-hidden="true">↗</span></a>`;
    const liveBox = wsfOn() ? `<div id="ferryInfo" data-terminals="${ids.join(",")}"></div>` : "";
    return `${liveBox}<div class="ferry-terminal-links" style="margin:6px 0 10px">${termLinks}${driveUpLink}</div>`;
  }
  // ---------------------------------------------------------------- service alerts
  // Detours, closed or moved stops, canceled trips and other notices, from each agency's
  // GTFS-realtime alerts (through OneBusAway; Intercity Transit's own feed) and, with an access
  // code, Washington State Ferries' bulletins. Checked every few minutes.
  const ALERT_MS = 4 * 60000;
  const alerts = { list: [], road: [], sources: new Map(), byRoute: new Map(), byStop: new Map(), got: 0, polling: false, failed: 0 };
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
  function roadNotices(list, now) {
    if (!Array.isArray(list)) return [];
    const R = META.region;
    return list.filter((a) => {
      const start = wsfDate(a.StartTime) / 1000, end = wsfDate(a.EndTime) / 1000;
      const inRegion = (p) => p && Number.isFinite(p.Latitude) && Number.isFinite(p.Longitude)
        && p.Longitude >= R.west && p.Longitude <= R.east && p.Latitude >= R.south && p.Latitude <= R.north;
      return a.HeadlineDescription && !/^closed$/i.test(a.EventStatus || "") && (!end || end >= now) && (!start || start <= now + 3600)
        && (inRegion(a.StartRoadwayLocation) || inRegion(a.EndRoadwayLocation));
    }).map((a) => ({ id: `wsdot:${a.AlertID}`, agency: "wsdot", title: stripHTML(a.HeadlineDescription),
      desc: stripHTML(a.ExtendedDescription || ""), url: "https://wsdot.com/Travel/Real-time/Map/",
      level: /^(highest|high)$/i.test(a.Priority) ? 2 : /^medium$/i.test(a.Priority) ? 1 : 0,
      start: wsfDate(a.StartTime) / 1000, end: wsfDate(a.EndTime) / 1000, routes: new Set(), stops: new Set(),
    })).sort((a, b) => b.level - a.level || b.start - a.start);
  }
  async function pollAlerts() {
    if (!LIVE || alerts.polling || document.hidden || Date.now() - alerts.got < ALERT_MS - 5000) return;
    alerts.polling = true;
    const now = Date.now() / 1000, found = [];
    alerts.failed = 0;
    const remember = (key, list) => alerts.sources.set(key, { at: Date.now(), list });
    const sources = (LIVE.key && LIVE.alerts ? LIVE.agencies : []).map((a) => [a, `${LIVE.alerts}/${a}.pb?key=${encodeURIComponent(LIVE.key)}`, true])
      .concat((LIVE.feeds || []).filter((f) => f.alerts).map((f) => [f.agency, f.alerts, false]));
    for (const [a, url, isOba] of sources) {
      if (isOba && Date.now() < live.pauseUntil) { alerts.failed++; continue; }
      try {
        const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (isOba && r.status === 429) live.pauseUntil = Date.now() + 60000;
        if (!r.ok) throw new Error("alerts unavailable");
        remember(a, readAlerts(a, parseAlerts(new Uint8Array(await r.arrayBuffer())), now));
      } catch (e) { alerts.failed++; }
      await new Promise((ok) => setTimeout(ok, 200));
    }
    if (wsfOn()) {
      try {
        const list = await jsonp(`${LIVE.wsf.base}/schedule/rest/alerts?apiaccesscode=${encodeURIComponent(LIVE.wsf.code)}`);
        if (!Array.isArray(list)) throw new Error("bulletins unavailable");
        remember("wsf", wsfAlerts(list, now));
      } catch (e) { alerts.failed++; }
    }
    if (hasCode(LIVE.wsdot?.code)) {
      try {
        const list = await jsonp(`${LIVE.wsdot.alerts}?AccessCode=${encodeURIComponent(LIVE.wsdot.code)}`);
        if (!Array.isArray(list)) throw new Error("road notices unavailable");
        remember("roads", roadNotices(list, now));
      } catch (e) { alerts.failed++; }
    }
    alerts.road = [];
    for (const [key, source] of alerts.sources) {
      if (Date.now() - source.at > 15 * 60000) { alerts.sources.delete(key); continue; }
      const current = source.list.filter((a) => !a.end || a.end >= now);
      if (key === "roads") alerts.road = current; else found.push(...current);
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
    20: "Kitsap Transit", 23: "Seattle Streetcar", 95: "Washington State Ferries", 19: "Intercity Transit", wsdot: "WSDOT" })[a] || "";
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
    if (map && map.getSource("stops")) map.getSource("stops").setData(stopsGeoJSON());
    if (map && map.getSource("stations")) refreshStations();
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
        : alerts.road.length ? "" : `<p class="hint">${!alerts.got ? "Checking for service alerts…" : alerts.failed ? "Some alert feeds are unavailable. Check your agency before traveling." : "No service alerts right now."}</p>`}
      ${alerts.road.length ? `<h2 class="section">Nearby highway conditions <span class="count">${alerts.road.length}</span></h2><p class="hint">WSDOT road reports in this region. Check your transit agency for route changes.</p><ul class="group alerts" role="list">${alerts.road.map((a) => alertHTML(a, { routes: false })).join("")}</ul>` : ""}
      ${alerts.failed && (groups.length || alerts.road.length) ? `<p class="hint">Some feeds are unavailable. Showing the most recently received notices.</p>` : ""}
      <p class="hint">From the agencies' live alert feeds, checked every few minutes${wsfOn() ? ", including Washington State Ferries bulletins" : ""}. Tap a route number to see it on the map.</p></div>`;
    const existing = body().querySelector(".alerts-view");
    const open = existing ? [...existing.querySelectorAll("details[open]")].map((d) => d.closest(".alert").querySelector(".al-title").textContent) : [];
    if (quiet && existing) existing.outerHTML = html; else setView(html);
    for (const d of body().querySelectorAll(".alerts-view details")) if (open.includes(d.querySelector(".al-title").textContent)) d.open = true;
    $("#back").addEventListener("click", () => { panelView = "home"; showHome(); });
    bindAlertList(body());
  }
  setInterval(() => {
    pollAlerts();
    if ($("#ferryInfo") && !document.hidden) { fillFerryInfo(); loadFerryTerminals(); }
  }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollAlerts(); });
  const geoDist = (a, b) => { const [x0, y0] = toM(a[0], a[1]), [x1, y1] = toM(b[0], b[1]); return Math.hypot(x1 - x0, y1 - y0); };
  const geoBearing = (a, b) => { const [x0, y0] = toM(a[0], a[1]), [x1, y1] = toM(b[0], b[1]); return (Math.atan2(x1 - x0, y1 - y0) * 180 / Math.PI + 360) % 360; };
  const angleDiff = (a, b) => (((b - a + 540) % 360) - 180);
  const lerpAngle = (a, b, t) => (a < 0 ? b : b < 0 ? a : ((a + angleDiff(a, b) * t) + 360) % 360);
  function vehPos(v, now) {
    // glide from the last shown spot to the newest report across the polling interval,
    // stopping smoothly at the destination so live vehicles never skate or overshoot
    if (!v.from || !v.to) return v.to || [0, 0];
    if (v.from[0] === v.to[0] && v.from[1] === v.to[1]) return v.to;
    const dur = v.dur || POLL_MS;
    const t = Math.min(1.02, Math.max(0, (now - v.t0) / dur));
    return [v.from[0] + (v.to[0] - v.from[0]) * t, v.from[1] + (v.to[1] - v.from[1]) * t];
  }
  async function pollLive() {
    if (!LIVE || !enabled.has("live") || document.hidden || live.polling) return;
    live.polling = true;
    // One agency at a time, spaced out, so we stay well inside the API's rate limits;
    // if the server says "too many requests", stop and wait a minute.
    const res = [];
    // OneBusAway agencies, then agencies with their own open feed (Intercity Transit)
    // (ferries come from the REST feed, which says which route each boat is on)
    const restPos = new Set(LIVE.rest || []);
    // each round starts one agency further along, so if the API asks us to slow down part-way,
    // it isn't always the same agencies (the ferries, at the end) that miss out
    const ags = LIVE.key ? LIVE.agencies.slice() : [], turn = (live.round = (live.round || 0) + 1) % (ags.length || 1);
    const oba = ags.slice(turn).concat(ags.slice(0, turn));
    const sources = oba.map((a) => [a, restPos.has(a)
      ? `${LIVE.status}/${a}.json?key=${encodeURIComponent(LIVE.key)}&includeReferences=true`
      : `${LIVE.base}/${a}.pb?key=${encodeURIComponent(LIVE.key)}`, true, restPos.has(a)])
      .concat((LIVE.feeds || []).map((f) => [f.agency, f.url, false, false]));
    const ferryPoll = pollWsf();
    let slowed = Date.now() < live.pauseUntil;
    for (const [a, url, isOba, rest] of sources) {
      if (isOba && slowed) continue; // told to slow down: skip the rest of OneBusAway this round
      try {
        const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (r.status === 429 && isOba) { live.pauseUntil = Date.now() + 60000; slowed = true; continue; }
        if (!r.ok) throw new Error(String(r.status));
        let list;
        if (rest) {
          const j = await r.json();
          // OneBusAway's REST answers "too many requests" inside a normal response
          if (j && j.code === 429) { live.pauseUntil = Date.now() + 60000; slowed = true; continue; }
          if (j?.code !== 200 || !Array.isArray(j.data?.list)) throw new Error("positions unavailable");
          list = restVehicles(a, j);
        } else list = parseVehicles(new Uint8Array(await r.arrayBuffer()));
        res.push({ status: "fulfilled", value: [a, list] });
      } catch (e) {
        res.push({ status: "rejected", reason: e });
      }
      await new Promise((ok) => setTimeout(ok, isOba ? 350 : 100));
    }
    // on time or late: one agency's vehicle status per round (King County Metro every other round)
    if (LIVE.key && LIVE.status && Date.now() >= live.pauseUntil) {
      const order = LIVE.agencies.filter((a) => !(LIVE.rest || []).includes(a)).flatMap((a) => (a === "1" ? ["1"] : ["1", a]));
      const a = order[live.statusTurn++ % order.length];
      try {
        const r = await fetch(`${LIVE.status}/${a}.json?key=${encodeURIComponent(LIVE.key)}&includeReferences=false`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (r.status === 429) live.pauseUntil = Date.now() + 60000;
        else if (r.ok) {
          const d = await r.json();
          if (d?.code === 429) live.pauseUntil = Date.now() + 60000;
          for (const x of (d.data && d.data.list) || []) {
            const ts = x.tripStatus;
            if (!ts) continue;
            live.status.set(a + "_" + plainId(x.vehicleId), { dev: ts.scheduleDeviation, predicted: !!ts.predicted, upd: x.lastUpdateTime, got: Date.now(),
              occ: occCode(ts.occupancyStatus), occN: ts.occupancyCount, occCap: ts.occupancyCapacity });
          }
        }
      } catch (e) { /* status is a bonus; positions still work */ }
    }
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
            const rawFrom = vehPos(prev, now);
            const d = geoDist(rawFrom, to);
            const routeChanged = prev.r && r && prev.r.id !== r.id;
            const isStale = (prev.t0 && (now - prev.t0 > 25000)) || (prev.ts && v.ts && (v.ts - prev.ts > 45));
            const maxGlide = a === "95" ? 1100 : 380;
            const snap = routeChanged || isStale || d > maxGlide || prev.snap;
            const from = snap ? to : rawFrom;
            const b = v.bearing != null && v.bearing > 0 ? v.bearing : d > 12 ? geoBearing(from, to) : prev.b;
            const b0 = snap ? b : (prev.curB != null ? prev.curB : (prev.b != null && prev.b >= 0 ? prev.b : b));
            const occ = occCode(v.occ);
            const dur = prev.t0 && !snap ? Math.min(30000, Math.max(5000, now - prev.t0)) : POLL_MS;
            Object.assign(prev, { from, to, t0: now, dur, r, b0, b, ts: v.ts, label: v.label || prev.label, vid: v.id, name, head: v.head || prev.head,
              occ: occ != null ? occ : prev.occ, occPct: v.occPct != null ? v.occPct : prev.occPct, snap: false });
          } else {
            live.vehicles.set(id, { id, agency: a, from: to, to, t0: now, dur: POLL_MS, r, b0: v.bearing > 0 ? v.bearing : -1, b: v.bearing > 0 ? v.bearing : -1, ts: v.ts, label: v.label, vid: v.id, name, head: v.head,
              occ: occCode(v.occ), occPct: v.occPct, snap: false });
          }
        } catch (e) { /* one odd report doesn't stop the rest */ }
      }
      for (const [id, v] of live.vehicles) if (v.agency === a && !seen.has(id)) live.vehicles.delete(id);
    }
    // an agency we haven't heard from in three minutes: its vehicles are out of date, drop them
    for (const [id, v] of live.vehicles) if (live.fresh && Date.now() - (live.fresh[v.agency] || 0) > 180000) live.vehicles.delete(id);
    await ferryPoll;
    if (syncWsfVessels(now)) ok++;
    if ($("#ferryInfo")) { fillFerryInfo(); loadFerryTerminals(); }
    live.error = ok === 0;
    if (ok) live.last = Date.now();
    live.polling = false;
    renderLive(now);
    updateLiveUI();
  }
  // ---- timetable estimates: where each scheduled trip should be right now
  let SCHED = null;
  const PT_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  function pacificAt(date) {
    const at = date instanceof Date ? date : new Date();
    const parts = Object.fromEntries(PT_FMT.formatToParts(at).map((p) => [p.type, p.value]));
    const key = (w) => (w === "Sat" ? "saturday" : w === "Sun" ? "sunday" : "weekday");
    const prev = { Mon: "Sun", Tue: "Mon", Wed: "Tue", Thu: "Wed", Fri: "Thu", Sat: "Fri", Sun: "Sat" }[parts.weekday];
    return { day: key(parts.weekday), prev: key(prev), secs: (+parts.hour % 24) * 3600 + +parts.minute * 60 + +parts.second + at.getMilliseconds() / 1000, date: at };
  }
  function pacificNow() {
    return pacificAt(new Date());
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
    else if (mode === "live") {
      for (const v of live.vehicles.values()) if (Date.now() / 1000 - v.ts <= 300 && Date.now() - (live.fresh?.[v.agency] || 0) < 90000) {
        const dur = v.dur || POLL_MS;
        const t = Math.min(1.02, Math.max(0, (now - v.t0) / dur));
        const pos = vehPos(v, now);
        const b = (v.b0 != null && v.b != null && v.b >= 0 && v.b0 >= 0) ? lerpAngle(v.b0, v.b, Math.min(1, t)) : v.b;
        v.curB = b;
        list.push({ id: v.id, r: v.r, pos, b, name: v.name });
      }
      list.push(...estVehicles().filter((v) => !(v.r.rt || []).some((rt) => Date.now() - (live.fresh?.[rt.split("_")[0]] || 0) < 90000)));
    }
    else if (mode === "est") list = estVehicles();
    live.current = list;
    const sel = selected && selected.type === "route" ? selected.id : null;
    // vehicles thin out as you zoom out, more than the lines do: hundreds of markers would cover
    // the map. Trains, RapidRide and boats always; frequent buses from 11.5; the rest from 12.5.
    const z = map.getZoom();
    const bounds = map.getBounds(), pad = (bounds.getNorth() - bounds.getSouth()) * 0.1;
    const nearView = (p) => p[0] >= bounds.getWest() - pad && p[0] <= bounds.getEast() + pad && p[1] >= bounds.getSouth() - pad && p[1] <= bounds.getNorth() + pad;
    const tier = Math.min(tierFor(z), z >= 12.5 ? 2 : z >= 11.5 ? 1 : 0);
    const feats = [], markerGrid = new Map(), spacing = 38;
    const priority = (v) => v.r ? CAT[dkey(v.r)]?.prio ?? 99 : 99;
    const ordered = sel ? list : list.slice().sort((a, b) => Number(!!a.est) - Number(!!b.est) || priority(a) - priority(b) || a.id.localeCompare(b.id));
    const anyCatOn = LAYERS.some((l) => enabled.has(l.key) && KEY_NAME[l.key]);
    for (const v of ordered) {
      const r = v.r;
      if (!r || LINEIDX[r.id] == null) continue;
      if (specialFilter && !routeMatchesFilter(r)) continue;
      if (sel ? sel !== r.id : ((anyCatOn && !enabledCat(r.cat)) || CAT[dkey(r)].tier > tier)) continue;
      if (CAT[dkey(r)].group !== "water" && !nearView(v.pos)) continue;
      const c = tagColor(r);
      const snapped = onLine(r, v.pos, v.b == null ? -1 : v.b);
      if (!snapped) continue;
      const [pos, b] = snapped;
      if (!nearView(pos)) continue;
      // Keep the overview readable. A chosen route shows every one of its vehicles.
      if (!sel && CAT[dkey(r)].group !== "water") {
        const p = map.project(pos), gx = Math.floor(p.x / spacing), gy = Math.floor(p.y / spacing);
        let crowded = false;
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++)
          if ((markerGrid.get(x + "," + y) || []).some((q) => Math.hypot(p.x - q.x, p.y - q.y) < spacing)) crowded = true;
        if (crowded) continue;
        const key = gx + "," + gy;
        if (!markerGrid.has(key)) markerGrid.set(key, []);
        markerGrid.get(key).push(p);
      }
      feats.push({ type: "Feature", properties: { id: v.id, r: r.id, c, tc: c, lab: v.name || shortLabel(r), b: Math.round(b), m: vehKind(r),
        s: 20 - CAT[dkey(r)].prio, est: v.est ? 1 : 0 }, geometry: { type: "Point", coordinates: pos } });
    }
    let liveCount = 0, estCount = 0;
    for (const f of feats) {
      if (f.properties.est) estCount++;
      else liveCount++;
    }
    live.count = feats.length;
    live.liveCount = liveCount;
    live.estCount = estCount;
    map.getSource("vehicles").setData({ type: "FeatureCollection", features: feats });
    if (typeof updateLiveHud === "function") updateLiveHud();
  }
  const renderLive = renderVehicles;
  // Live positions are GPS fixes on the street; the map draws lines in lanes and simplified, so a
  // vehicle is moved onto its own route's line (the nearest point of that line, if it's close)
  // and turned to follow it.
  let vehIx = null, vehIxSel = null;
  function onLine(r, pos, b) {
    const i = LINEIDX[r.id], key = dkey(r);
    const isWater = CAT[key]?.group === "water";
    const sel = selected && selected.type === "route" && selected.id === r.id;
    const ix = sel ? (vehIxSel = vehIxSel || segIndex(lastSelFeats)) : (vehIx = vehIx || segIndex(lastFeats));
    if (!ix) return isWater ? [pos, b] : null;
    const mpp = MPP0 / 2 ** map.getZoom();
    // a boat only ever sails its own lane, so it goes onto it from any distance (a position report
    // can be a long way off the drawn line, which put boats in open water); on land, only when close
    const reach = isWater ? 8000 : Math.max(50, 26 * mpp);
    const hit = nearestOn(ix, toM(pos[0], pos[1]), reach,
      sel ? null : (pr) => (pr.r >= 0 ? pr.r === i : pr.cat === key && EDGES[pr.e] && EDGES[pr.e].l.includes(i)));
    if (!hit) return isWater ? [pos, b] : null;
    let hb = (Math.atan2(hit.dir[0], hit.dir[1]) * 180 / Math.PI + 360) % 360;
    if (b >= 0) { const diff = Math.abs(((hb - b + 540) % 360) - 180); if (diff > 90) hb = (hb + 180) % 360; }
    return [toLonLat(hit.q), b >= 0 ? hb : b];
  }
  setInterval(() => { if (map && enabled.has("live") && !document.hidden && !map.isMoving()) renderVehicles(); }, 1000);

  // Live vehicle status: early (< -60s), on schedule (< 3m), delayed (3–7m), late (> 7m)
  function vehicleStatus(v) {
    const st = v && live.status.get(v.agency + "_" + plainId(v.vid));
    if (!st || !st.predicted || Date.now() - st.got > 10 * 60000) return null;
    const dev = st.dev;
    if (dev <= -60) {
      const m = Math.round(Math.abs(dev) / 60);
      return { text: `${m} min early`, cls: "early" };
    }
    if (dev < 180) {
      return { text: "On time (< 3m)", cls: "ok" };
    }
    const m = Math.round(dev / 60);
    if (dev < 420) {
      return { text: `${m} min delayed (3–7m)`, cls: "slow" };
    }
    return { text: `${m} min late (> 7m)`, cls: "late" };
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
  // Where a live vehicle is going and what stop it's heading for next, asked of OneBusAway for
  // that one vehicle when its popup opens
  const tripCache = new Map();
  async function vehicleTrip(id) {
    const hit = tripCache.get(id);
    if (hit && Date.now() - hit.at < 20000) return hit.v;
    if (!LIVE?.key || !LIVE.status) return null;
    const url = `${LIVE.status.replace("vehicles-for-agency", "trip-for-vehicle")}/${encodeURIComponent(id)}.json?key=${encodeURIComponent(LIVE.key)}&includeStatus=true&includeTrip=true&includeSchedule=false`;
    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (!r.ok) return null;
      const d = await r.json(), e = d.data && d.data.entry, ref = (d.data && d.data.references) || {};
      if (!e) return null;
      const trip = (ref.trips || []).find((t) => t.id === e.tripId), st = e.status || {};
      const stop = (ref.stops || []).find((x) => x.id === st.nextStop);
      const v = { head: trip && trip.tripHeadsign || "", next: stop ? stop.name : "", eta: st.nextStopTimeOffset };
      tripCache.set(id, { at: Date.now(), v });
      return v;
    } catch (e) { return null; }
  }
  function vehicleTripHTML(v, head, next) {
    const h = head || (v && v.head), n = next || (v && v.next);
    const eta = v && v.eta > 0 && next === undefined ? ` · ${Math.max(1, Math.round(v.eta / 60))} min` : "";
    return `${h ? `<p class="vtrip"><b>To ${esc(tidyHeadsign(h))}</b></p>` : ""}${n ? `<p class="vtrip">Next stop: ${esc(n)}${eta}</p>` : ""}`;
  }
  function fillVehicleTrip(vid, fallbackHead) {
    vehicleTrip(vid).then((t) => {
      const el = popup && popup.getElement() && popup.getElement().querySelector(".vtrip-slot");
      if (el) el.innerHTML = vehicleTripHTML(t, (t && t.head) || fallbackHead);
    });
  }
  function vehicleLines(id, est) {
    if (est) return `<span class="vs-note" style="color:var(--text-sub)">Estimated position from timetable (not GPS)</span>`;
    const v = live.vehicles.get(id), st = vehicleStatus(v);
    // the newest report for this vehicle: its position, or its agency's status report
    const raw = v && live.status.get(v.agency + "_" + plainId(v.vid));
    const ts = Math.max((v && v.ts) || 0, raw && raw.upd ? raw.upd / 1000 : 0);
    const oc = vehicleOccupancy(v);
    return `${st ? `<span class="vs vs-${st.cls}">${st.text}</span>` : ""}`
      + `${oc ? `<span class="vs vo-${oc.cls}">${esc(oc.text)}${oc.detail ? ` · ${esc(oc.detail)}` : ""}</span>` : ""}`
      + `<span class="vs-note">Live GPS fix · ${esc(updatedText(ts))}</span>`;
  }

  function liveStatusText() {
    if (!enabled.has("live")) return "Buses, trains and ferries on the move";
    const mode = vehMode();
    const liveCount = live.liveCount != null ? live.liveCount : 0;
    const estCount = live.estCount != null ? live.estCount : (live.count || 0);
    const total = live.count || 0;
    if (mode === "live") {
      const sec = Math.round((Date.now() - live.last) / 1000);
      if (liveCount > 0 && estCount > 0) {
        return `Live GPS & timetable · ${liveCount} live, ${estCount} scheduled · updated ${sec < 5 ? "just now" : sec + " s ago"}`;
      } else if (liveCount > 0) {
        return `Live GPS · ${liveCount} vehicles on map · updated ${sec < 5 ? "just now" : sec + " s ago"}`;
      } else {
        return `Estimated from timetable · ${estCount} vehicles on map`;
      }
    }
    if (mode === "est") {
      const why = !LIVE ? (MODE === "bundled" ? " (live positions on website)" : " (live feed not configured)") : Date.now() < live.pauseUntil ? " (live feed busy)" : live.error ? " (live feed unreachable)" : "";
      return `Estimated from timetable · ${total} on this map${why}`;
    }
    return "Loading…";
  }
  function updateLiveUI() {
    const d = document.getElementById("liveDesc");
    if (d) d.textContent = liveStatusText();
    const chip = document.getElementById("liveChip");
    if (chip && selected && selected.type === "route") {
      const running = (live.current || []).filter((v) => v.r && v.r.id === selected.id), n = running.length;
      chip.hidden = !enabled.has("live") || !live.mode;
      chip.querySelector("span.n").textContent = (n === 0 ? "None running right now" : `${n} running now`) + (live.mode === "est" || n > 0 && running.every((v) => v.est) ? " (timetable)" : "");
    }
  }
  let liveAnimRaf = 0, lastAnimMs = 0, lastActiveTime = Date.now();
  function animVehicles(now) {
    liveAnimRaf = 0;
    if (!enabled.has("live") || document.hidden || !map || !map.getSource("vehicles")) return;
    lastActiveTime = Date.now();
    if (now - lastAnimMs >= 35) {
      lastAnimMs = now;
      renderVehicles(now);
    }
    liveAnimRaf = requestAnimationFrame(animVehicles);
  }
  function startAnim() {
    if (!liveAnimRaf && enabled.has("live") && !document.hidden) {
      liveAnimRaf = requestAnimationFrame(animVehicles);
    }
  }
  function stopAnim() {
    if (liveAnimRaf) { cancelAnimationFrame(liveAnimRaf); liveAnimRaf = 0; }
  }
  function startLive() {
    if (!LIVE) return;
    if (!live.timer) {
      pollLive();
      pollAlerts();
      live.timer = setInterval(pollLive, POLL_MS);
    }
    startAnim();
  }
  function stopLive() {
    clearInterval(live.timer);
    live.timer = 0;
    stopAnim();
    renderVehicles();
    updateLiveUI();
  }
  // A vehicle: a round badge in its line's color with a white symbol (bus, train, streetcar,
  // boat), and a separate pointer showing which way it's going.
  const VEH_PX = 60, VEH_R = 10;
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
    const S = Math.round(VEH_PX * dpr), cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const ctx = cv.getContext("2d"), c = S / 2, R = VEH_R * dpr;
    if (kind === "vdir") {
      // The point of a pin: drawn over the badge, so the badge's white border runs out into the
      // point and its color fills it, one outline around circle and point together (the layer
      // turns it to the heading). Only the part outside the colored circle is drawn, so the
      // symbol on the badge stays clear.
      const Ro = R + 2 * dpr, T = Ro + 12 * dpr;
      const pin = (ro, t) => {
        const th = Math.acos(ro / t);
        ctx.beginPath(); ctx.moveTo(c, c - t);
        ctx.lineTo(c + ro * Math.sin(th), c - ro * Math.cos(th));
        ctx.arc(c, c, ro, -Math.PI / 2 + th, 3 * Math.PI / 2 - th, false);
        ctx.closePath();
      };
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.arc(c, c, R - 0.5 * dpr, 0, Math.PI * 2, true); ctx.clip();
      ctx.lineJoin = "round";
      // a soft shadow under the point only (the badge casts its own)
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, S, c - Ro * 0.55); ctx.clip();
      ctx.shadowColor = "rgba(0,0,0,.28)"; ctx.shadowBlur = 3 * dpr; ctx.shadowOffsetY = 0.8 * dpr;
      pin(Ro, T); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.restore();
      pin(Ro, T); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4 * dpr; ctx.stroke();
      pin(R, T * R / Ro); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1 * dpr; ctx.stroke();
      ctx.restore();
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
  function onTabResumed() {
    const elapsed = Date.now() - lastActiveTime;
    lastActiveTime = Date.now();
    if (elapsed > 3000) {
      // The tab was inactive or in background:
      // Snap all existing vehicles to their latest known spot immediately so they
      // never skate across water or parks from old positions.
      for (const v of live.vehicles.values()) {
        v.from = v.to;
        v.snap = true;
      }
      for (const [id, v] of live.vehicles) {
        if (v.ts && (Date.now() / 1000 - v.ts > 150)) {
          live.vehicles.delete(id);
        }
      }
    }
    if (live.timer) pollLive();
    startAnim();
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      onTabResumed();
    } else {
      lastActiveTime = Date.now();
      stopAnim();
    }
  });
  window.addEventListener("focus", () => {
    if (!document.hidden) onTabResumed();
  });
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
        paint: { "circle-radius": stopRadius(mult * 2.5),
          "circle-color": ["case", ["==", ["get", "suspended"], 1], "#d0213b", ["get", "c"]],
          "circle-opacity": prefix === "hl" ? 0.3 : 0.2, "circle-blur": 0.85 } },
      { id: `${prefix}-stops`, type: "circle", source: src,
        paint: { "circle-radius": stopRadius(mult),
          "circle-color": ["case", ["==", ["get", "suspended"], 1], "#d0213b", P.stopFill],
          "circle-stroke-color": ["case", ["==", ["get", "suspended"], 1], "#ffffff", ["get", "c"]],
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
        const susp = stopIsSuspended(st.id);
        seen.set(k, { type: "Feature", properties: { id: st.id, name: st.name, c: color, end: withEnds ? st.end : 0, suspended: susp ? 1 : 0 },
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
  // within ~24 px (and at most 38 m) of each other along the line become one dot that stands for both.
  function mergeStops(feats, lineFeats) {
    const mpp = MPP0 / 2 ** map.getZoom(), d = Math.min(38, Math.max(16, 20 * mpp)), out = [];
    for (const f of feats) {
      const p = toM(...f.geometry.coordinates);
      const g = out.find((o) => Math.hypot(o.m[0] - p[0], o.m[1] - p[1]) < d);
      if (!g) { out.push({ m: p, n: 1, f: { ...f, properties: { ...f.properties, ids: f.properties.id } } }); continue; }
      g.m = [(g.m[0] * g.n + p[0]) / (g.n + 1), (g.m[1] * g.n + p[1]) / (g.n + 1)];
      g.n++;
      g.f.properties.ids += "," + f.properties.id;
      g.f.properties.end = Math.max(g.f.properties.end || 0, f.properties.end || 0);
    }
    const ix = lineFeats && lineFeats.length ? segIndex(lineFeats) : null;
    return out.map((g) => {
      const pt = ix ? (nearestOn(ix, g.m, 80)?.q || g.m) : g.m;
      return { ...g.f, geometry: { type: "Point", coordinates: toLonLat(pt) } };
    });
  }
  function setStops(prefix, stopFeats, lineFeats, mode, animate) {
    const src = map && map.getSource(prefix === "sel" ? "selstops" : "hoverstops");
    if (!src) return;
    src.setData(fc(lineFeats ? mergeStops(snapStops(stopFeats, lineFeats, mode), lineFeats) : []));
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
    const susp = stopIsSuspended(id);
    src.setData(fc([{ type: "Feature", properties: { id, c, end: 0, suspended: susp ? 1 : 0 }, geometry: { type: "Point", coordinates: f.geometry.coordinates } }]));
    popIn("hl", 1.8);
  }

  function highlightStopById(id) {
    if (!id) { highlightStop(null); return; }
    const s = stopIndex[id] || (STOPS?.stops && STOPS.stops.find((x) => x.id === id)) || (STOPS?.stations && STOPS.stations.find((x) => x.id === id));
    if (!s) { highlightStop(null); return; }
    const rs = (s.routes || []).map((x) => RBY[x]).filter(Boolean).sort(tagOrder);
    const c = rs[0] ? keyColor(dkey(rs[0])) : BASE[theme].stopStroke;
    highlightStop({
      properties: { id: s.id, c },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] }
    });
  }

  function previewStopOnHover(el) {
    const id = el.dataset.stop;
    if (!id) return;
    const on = () => highlightStopById(id);
    const off = () => highlightStopById(null);
    el.addEventListener("mouseenter", on);
    el.addEventListener("focus", on);
    el.addEventListener("mouseleave", off);
    el.addEventListener("blur", off);
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
        + "&minutesBefore=0&minutesAfter=90", { cache: "no-store", signal: AbortSignal.timeout(12000) });
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
    if (!LIVE?.key || !LIVE.deps || Date.now() < depCache.pause) return;
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
    if (!LIVE?.key || !LIVE.deps) return null;
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
      return `<div class="sc-row press" data-route="${esc(d.r.id)}" role="button" tabindex="0" title="Highlight route ${esc(shortLabel(d.r))}">${badgeHTML(d.r)}<span class="sc-to">${esc(to)}</span>${occ}<span class="sc-t">${dot}${depMinutes(d.t)}</span></div>`;
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
    const susp = stopIsSuspended(s.id);
    let h = `<div class="sc"><div class="sc-name">${esc(s.name)}${susp ? ` <span class="stop-susp-pill">🚫 Closed</span>` : ""}</div><div class="sc-sub">${susp ? `<span style="color:#d0213b;font-weight:600">Service Suspended</span> · ` : ""}${kind} · ${rs.length} route${rs.length === 1 ? "" : "s"}${end === 2 ? " · <b>End of the line</b>" : end === 1 ? " · <b>Trips start here</b>" : ""}</div>`;
    if (susp) h += `<div class="stop-susp-banner" style="margin:4px 0 6px;padding:6px 8px;font-size:11.5px"><span class="susp-icon" style="font-size:14px">🚫</span><span><strong>Stop Closed</strong> · Regular transit service is currently suspended</span></div>`;
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
    const w = Math.round(14 * dpr), h = Math.round(12 * dpr), cv = document.createElement("canvas");
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
    if (ribbons) map.triggerRepaint();
    else for (const L of transitLayers(BASE[theme])) {
      if (L.source !== "net" || L.type !== "line") continue;
      const base = L.paint["line-opacity"] != null ? L.paint["line-opacity"] : 1;
      map.setPaintProperty(L.id, "line-opacity", level === 1 ? base : typeof base === "number" ? base * level : ["*", base, level]);
    }
    map.setPaintProperty("badges", "icon-opacity", level === 1 ? 1 : Math.max(0.12, level * 0.6));
    for (const id of ["trail-lines", "greenway-lines", "bikelane-lines"]) {
      if (map.getLayer(id)) map.setPaintProperty(id, "line-opacity", level === 1 ? 0.85 : 0.22);
    }
  }
  function applySelectionStyle() {
    if (!map || !map.getLayer("line-bus")) return;
    const dim = !!(selected && selected.type === "route");
    if (!ribbons) for (const g of GROUPS) {
      for (const id of [`glass-${g}`, `center-${g}`, `dots-${g}`, `ties-${g}`]) map.setLayoutProperty(id, "visibility", dim ? "none" : "visible");
      for (const id of [`case-${g}`, `shadow-${g}`]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", dim ? "none" : "visible");
    }
    // Keep enough of the surrounding network visible to orient a rider while
    // leaving the selected line unmistakably in front.
    setNetDim(dim ? 0.38 : 1);
    // the selected route shows its own arrows; the faded network's would only be noise
    if (map.getLayer("arrows")) map.setLayoutProperty("arrows", "visibility", dim ? "none" : "visible");
  }
  function setHash(h, push = false) {
    const url = h ? "#" + h : location.pathname + location.search;
    try {
      if (push) history.pushState({ hash: h }, "", url);
      else history.replaceState({ hash: h }, "", url);
    } catch { /* sandboxed */ }
  }
  function selectRoute(id, { fit = true, push = true } = {}) {
    const r = RBY[id];
    if (!r) return;
    selected = { type: "route", id };
    setHash("route-" + id, push);
    rebuild();
    applySelectionStyle();
    showRouteStops(r);
    showRoute(r);
    renderLive();
    if (r.cat === "dart") highlightDartArea(id);
    else highlightDartArea(null);
    if (fit && r.bbox && r.bbox[0] < 180) map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: fitPadding(), maxZoom: 15, duration: 800 });
  }
  function selectStop(id, { fly = true, push = true } = {}) {
    const s = stopIndex[id];
    if (!s) return;
    selected = { type: s.kind === "stop" ? "stop" : "station", id };
    setHash((s.kind === "stop" ? "stop-" : "station-") + id, push);
    rebuild();
    applySelectionStyle();
    showRouteStops(null);
    highlightDartArea(null);
    showStop(s);
    if (fly) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), s.kind === "stop" ? 16 : 14.5), padding: fitPadding(), duration: 800 });
  }
  function clearSelection({ push = false } = {}) {
    selected = null;
    panelView = "home";
    corridorRoutes = [];
    setHash("", push);
    closePopup();
    if (typeof clearPlaceMarker === "function") clearPlaceMarker();
    rebuild();
    applySelectionStyle();
    showRouteStops(null);
    highlightDartArea(null);
    showHome();
    renderLive();
    openSheet("peek");
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

  // ---------------------------------------------------------------- toast, favorites & sharing
  const FAVS_KEY = "stm_favs_v2";
  function getFavs() {
    try {
      const raw = localStorage.getItem(FAVS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        routes: Array.isArray(parsed.routes) ? parsed.routes : [],
        stops: Array.isArray(parsed.stops) ? parsed.stops : [],
        trips: Array.isArray(parsed.trips) ? parsed.trips : [],
      };
    } catch {
      return { routes: [], stops: [], trips: [] };
    }
  }
  function saveFavs(f) {
    try { localStorage.setItem(FAVS_KEY, JSON.stringify(f)); } catch {}
  }
  function isFav(type, id) {
    const f = getFavs();
    return (f[type === "route" ? "routes" : "stops"] || []).includes(id);
  }
  function toggleFav(type, id) {
    const f = getFavs();
    const key = type === "route" ? "routes" : "stops";
    const list = f[key] || [];
    const idx = list.indexOf(id);
    let added = false;
    if (idx >= 0) {
      list.splice(idx, 1);
      showToast("Removed from favorites");
    } else {
      list.push(id);
      added = true;
      showToast("Saved to favorites ★");
    }
    f[key] = list;
    saveFavs(f);
    if (specialFilter === "favs") {
      refreshStations();
      rebuild();
      renderLive();
    }
    return added;
  }
  function isFavTrip(orig, dest) {
    if (!orig || !dest) return false;
    const f = getFavs();
    return (f.trips || []).some((t) =>
      Math.abs(t.orig.lat - orig.lat) < 0.001 &&
      Math.abs(t.orig.lon - orig.lon) < 0.001 &&
      Math.abs(t.dest.lat - dest.lat) < 0.001 &&
      Math.abs(t.dest.lon - dest.lon) < 0.001
    );
  }
  function toggleFavTrip(orig, dest, it) {
    const f = getFavs();
    const trips = f.trips || [];
    const idx = trips.findIndex((t) =>
      Math.abs(t.orig.lat - orig.lat) < 0.001 &&
      Math.abs(t.orig.lon - orig.lon) < 0.001 &&
      Math.abs(t.dest.lat - dest.lat) < 0.001 &&
      Math.abs(t.dest.lon - dest.lon) < 0.001
    );
    let added = false;
    if (idx >= 0) {
      trips.splice(idx, 1);
      showToast("Trip removed from saved");
    } else {
      const origName = orig.isLocation ? "Your location" : orig.name;
      const destName = dest.isLocation ? "Your location" : dest.name;
      const summary = it ? (it.type === "direct" ? it.route.short || it.route.label : it.type === "transfer" ? `${it.r1.short || it.r1.label} ➔ ${it.r2.short || it.r2.label}` : it.type === "multi" ? it.legs.map((leg) => leg.route.short || leg.route.label).join(" ➔ ") : "Walk") : "";
      trips.push({
        id: "trip-" + Date.now(),
        name: `${origName} → ${destName}`,
        orig: { lat: orig.lat, lon: orig.lon, name: origName, isLocation: !!orig.isLocation },
        dest: { lat: dest.lat, lon: dest.lon, name: destName, isLocation: !!dest.isLocation },
        summary,
        duration: it?.totalDuration || null,
        type: it?.type || "direct",
      });
      added = true;
      showToast("Trip saved to favorites ★");
    }
    f.trips = trips;
    saveFavs(f);
    return added;
  }
  function removeFavTrip(id) {
    const f = getFavs();
    f.trips = (f.trips || []).filter((t) => t.id !== id);
    saveFavs(f);
    showToast("Saved trip removed");
  }

  let toastTimer = null;
  function showToast(msg, duration = 2400) {
    const t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    t.classList.remove("toast-out");
    t.classList.add("toast-in");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("toast-in");
      t.classList.add("toast-out");
      setTimeout(() => { t.hidden = true; }, 280);
    }, duration);
  }

  async function shareTarget({ title, text, url }) {
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        showToast("Link copied to clipboard ✓");
      } else {
        const input = document.createElement("input");
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
        showToast("Link copied to clipboard ✓");
      }
    } catch {
      showToast("Could not copy link");
    }
  }

  function directionsHTML(lat, lon, name) {
    const qName = encodeURIComponent(name || "Transit Stop");
    const appleUrl = `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=r&q=${qName}`;
    const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=transit`;
    const transitAppUrl = `https://transitapp.com/r?lat=${lat}&lon=${lon}`;
    return `<div class="dir-actions">
      <span class="dir-label">Trip Directions</span>
      <div class="dir-app-btns">
        <button class="dir-inapp-btn dest press" type="button" data-dir-dest-lat="${lat}" data-dir-dest-lon="${lon}" data-dir-dest-name="${esc(name)}" data-dir-dest="${lat},${lon},${esc(name)}" aria-label="Plan trip to ${esc(name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          <span>Plan Trip Here</span>
        </button>
        <button class="dir-inapp-btn orig press" type="button" data-dir-orig-lat="${lat}" data-dir-orig-lon="${lon}" data-dir-orig-name="${esc(name)}" data-dir-orig="${lat},${lon},${esc(name)}" aria-label="Trip from ${esc(name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
          <span>Trip from Here</span>
        </button>
      </div>
      <span class="dir-label" style="font-size:11px;opacity:0.85">Open in Navigation App</span>
      <div class="dir-btns">
        <a class="dir-btn apple press" href="${appleUrl}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516s1.52.087 2.475-1.258.762-2.391.728-2.43m3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422s1.675-2.789 1.698-2.854-.597-.79-1.254-1.157a3.7 3.7 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56s.625 1.924 1.273 2.796c.576.984 1.34 1.667 1.659 1.899s1.219.386 1.843.067c.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758q.52-1.185.473-1.282"/></svg>
          <span>Apple Maps</span>
        </a>
        <a class="dir-btn google press" href="${googleUrl}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          <span>Google Maps</span>
        </a>
        <a class="dir-btn transit press" href="${transitAppUrl}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>
          <span>Transit App</span>
        </a>
      </div>
    </div>`;
  }

  function routeBadgesHTML(r) {
    const w = r.sched?.weekday;
    if (!w) return "";
    const headwayText = w.mid_n >= 3 ? `Every ${w.mid} min` : (w.am_n || w.pm_n) ? "Rush hour only" : `${w.trips} trips/day`;
    const spanText = w.span_h >= 22 ? "24 Hours · Night Owl" : `Until ${w.last.replace(" ", " ")}`;
    const peakText = (w.am_n && w.am < w.mid) ? `Peak: every ${w.am} min` : "";
    const everyday = isEveryday(r);
    const runsPill = everyday
      ? `<span class="freq-pill everyday" title="Runs 7 days a week">📅 7 Days · Every day</span>`
      : (r.sched?.saturday && (r.sched.saturday.mid_n > 0 || r.sched.saturday.trips > 5))
        ? `<span class="freq-pill parttime" title="Runs Monday through Saturday, no Sunday service">🕒 Mon–Sat · Part-time</span>`
        : `<span class="freq-pill parttime" title="Part-time service (Monday–Friday only)">🕒 Mon–Fri only · Part-time</span>`;
    return `<div class="freq-badge-row">
      <span class="freq-pill headway" title="Typical midday wait time"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 8 8A8 8 0 0 0 8 0zm.5 4.5v3.25l2.5 1.5-.75 1.25-3.25-2V4.5z"/></svg>${esc(headwayText)}</span>
      <span class="freq-pill span" title="Daily hours of service"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/></svg>${esc(spanText)}</span>
      ${runsPill}
      ${peakText ? `<span class="freq-pill peak" title="Morning peak frequency"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.251.068a.5.5 0 0 1 .227.58L9.677 6.5H13a.5.5 0 0 1 .364.843l-8 8.5a.5.5 0 0 1-.842-.49L6.323 9.5H3a.5.5 0 0 1-.364-.843l8-8.5a.5.5 0 0 1 .615-.089z"/></svg>${esc(peakText)}</span>` : ""}
    </div>`;
  }

  // Filter bar: one chip per kind of service + special filters (Night Owl, Snow)
  const FILTERS = [
    { key: "Trains", label: "Trains", color: () => LINE[theme].link },
    { key: "Buses", label: "Buses", color: () => LINE[theme].frequent },
    { key: "On the water", label: "Ferries", color: () => LINE[theme].ferry },
    { key: "Trails", label: "Bike network", color: () => theme === "dark" ? "#2dd4bf" : "#059669" },
    { key: "On demand", label: "On demand", color: () => FLEX[theme] },
  ];
  const SPECIAL_FILTERS = [
    { key: "favs", label: "★ Saved lines", color: () => "#ffcc00" },
    { key: "nightowl", label: "🌙 Night Owl", color: () => "#5e5ce6" },
    { key: "snow", label: "❄️ Snow Routes", color: () => "#00c7be" },
  ];
  const filterMemory = {};
  function renderFilterBar() {
    const bar = $("#filterBar");
    if (!bar) return;
    const chips = FILTERS.map((f) => {
      const grp = LAYER_GROUPS.find((g) => g.title === f.key);
      const on = grp.items.some((l) => enabled.has(l.key));
      return `<button type="button" class="fchip${on ? " on" : ""}" data-f="${esc(f.key)}" aria-pressed="${on}"><span class="dot" style="background:${f.color()}"></span>${esc(f.label)}</button>`;
    });
    const specials = SPECIAL_FILTERS.map((f) => {
      const on = specialFilter === f.key;
      return `<button type="button" class="fchip${on ? " on" : ""}" data-f="${esc(f.key)}" data-special="1" aria-pressed="${on}"><span class="dot" style="background:${f.color()}"></span>${esc(f.label)}</button>`;
    });
    bar.innerHTML = chips.concat(specials).join("");
    for (const b of bar.querySelectorAll(".fchip")) b.addEventListener("click", () => {
      if (b.dataset.special) {
        const k = b.dataset.f;
        specialFilter = specialFilter === k ? null : k;
        renderFilterBar();
        refreshStations();
        rebuild();
        applyLayerToggles();
        renderLive();
        showHome(true);
        return;
      }
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
      renderLive();
      if (!selected) showHome(true);
    });
  }

  // Home is deliberately small: what's moving, what the lines mean, and one way in to the
  // full set of switches ("Layers"). Everything advanced lives on the Layers page.
  let panelView = "home", corridorRoutes = [];
  const KEY_NAME = {
    link: "Link light rail", rail: "Sounder & Amtrak", streetcar: "Streetcar", monorail: "Monorail",
    rapid: "RapidRide & Swift", frequent: "Frequent bus", local: "All-day bus", peak: "Rush-hour bus",
    water: "Ferries & Water Taxi", dart: "Dial-a-Ride area", flex: "Metro Flex zone", access: "Access area",
    trails: "Bike lanes, greenways & trails",
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
  function renderFavTripRow(t) {
    return `<li><div class="row trip-fav-row">
      <span class="icon" style="color:#ffcc00; display:inline-flex; align-items:center; justify-content:center"><svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z"/></svg></span>
      <span class="txt" style="cursor:pointer" data-fav-trip-plan="${esc(t.id)}">
        <span class="name">${esc(t.name)}</span>
        <span class="desc">${t.duration ? `${t.duration} min · ` : ""}${esc(t.summary || "Saved trip")}</span>
      </span>
      <button type="button" class="fav-del-btn press" data-del-trip="${esc(t.id)}" title="Remove saved trip" aria-label="Remove saved trip">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
      </button>
    </div></li>`;
  }
  function bindFavListEvents() {
    for (const b of body().querySelectorAll("[data-route]")) {
      b.addEventListener("click", () => selectRoute(b.dataset.route));
      previewOnHover(b);
    }
    for (const b of body().querySelectorAll("[data-stop]")) {
      b.addEventListener("click", () => selectStop(b.dataset.stop));
    }
    for (const b of body().querySelectorAll("[data-fav-trip-plan]")) {
      b.addEventListener("click", () => {
        const id = b.dataset.favTripPlan;
        const trip = (getFavs().trips || []).find((t) => t.id === id);
        if (trip) openTripPlanner({ orig: trip.orig, dest: trip.dest });
      });
    }
    for (const b of body().querySelectorAll("[data-del-trip]")) {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFavTrip(b.dataset.delTrip);
        showHome(true);
      });
    }
    $("#toggleFavFilter")?.addEventListener("click", () => {
      specialFilter = specialFilter === "favs" ? null : "favs";
      renderFilterBar();
      refreshStations();
      rebuild();
      applyLayerToggles();
      renderLive();
      showHome(true);
    });
    $("#clearFavFilter")?.addEventListener("click", () => {
      specialFilter = null;
      renderFilterBar();
      refreshStations();
      rebuild();
      applyLayerToggles();
      renderLive();
      showHome(true);
    });
  }
  function showHome(quiet) {
    if (panelView === "directions") return renderTripPlanView();
    if (panelView === "layers") return showLayers(quiet);
    if (panelView === "alerts") return showAlerts(quiet);
    if (panelView === "through-routes") return showThroughRoutesGuide(quiet);
    if (panelView === "legend") return showLegendGuide(quiet);
    if (panelView === "corridor") return showCorridor(null, quiet);
    if (panelView === "nearby") return;

    if (specialFilter === "favs") {
      const favs = getFavs();
      const favRoutes = (favs.routes || []).map((id) => RBY[id]).filter(Boolean).sort(tagOrder);
      const favStops = (favs.stops || []).map((id) => stopIndex[id]).filter(Boolean);
      const favTrips = (favs.trips || []);
      const totalSaved = favRoutes.length + favStops.length + favTrips.length;
      const html = `<div class="home-view">
        <div class="hero">
          <span class="icon" style="background:#ffcc00; color:#1a1a1a"><svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg></span>
          <div><h2>★ Saved Lines & Commutes</h2><p>${totalSaved} saved item${totalSaved === 1 ? "" : "s"}</p></div>
        </div>
        <p class="hint">The map and vehicle tracking are currently filtered to <b>only show your saved lines</b>.</p>
        <button type="button" class="fchip on" id="clearFavFilter" style="margin: 0 0 14px 0; background: var(--fill); color: var(--ink);">✕ Show all transit lines on map</button>
        ${favRoutes.length ? `<h3 class="section">${favRoutes.length} saved transit route${favRoutes.length > 1 ? "s" : ""}</h3>${routeRows(favRoutes)}` : `<p class="hint">No transit routes favorited yet. Tap the <b>☆ Favorite</b> button on any route page to display it here.</p>`}
        ${favTrips.length ? `<h3 class="section" style="margin-top:16px">${favTrips.length} saved trip${favTrips.length > 1 ? "s" : ""} & commute${favTrips.length > 1 ? "s" : ""}</h3><ul class="group" role="list">${favTrips.map(renderFavTripRow).join("")}</ul>` : ""}
        ${favStops.length ? `<h3 class="section" style="margin-top:16px">${favStops.length} saved stop${favStops.length > 1 ? "s" : ""}</h3><ul class="group" role="list">${favStops.map((s) => `<li><button type="button" class="row" data-stop="${esc(s.key || s.id)}"><span class="icon"><span class="stop-glyph" aria-hidden="true"></span></span><span class="txt"><span class="name">${esc(s.name)}</span><span class="desc">${s.kind === "stop" ? `Bus stop ${s.code ? "#" + s.code : ""}` : "Station"} · ${(s.routes || []).length} routes</span></span><svg class="chev" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button></li>`).join("")}</ul>` : ""}
      </div>`;
      setView(html);
      bindFavListEvents();
      return;
    }

    if (specialFilter === "nightowl") {
      const owlRoutes = ROUTES.filter((r) => isNightOwl(r) && LINEIDX[r.id] != null).sort(tagOrder);
      const html = `<div class="home-view">
        <div class="hero">
          <span class="icon" style="background:#5e5ce6; color:#fff"><svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/></svg></span>
          <div><h2>🌙 Night Owl Network</h2><p>Service from Midnight to 5:00 AM</p></div>
        </div>
        <p class="hint">All-night & 24-hour service connecting Downtown Seattle, Capitol Hill, Ballard, West Seattle, Sea-Tac Airport, and Federal Way.</p>
        <h3 class="section">${owlRoutes.length} Night Owl routes</h3>
        ${routeRows(owlRoutes)}
      </div>`;
      setView(html);
      for (const b of body().querySelectorAll("[data-route]")) {
        b.addEventListener("click", () => selectRoute(b.dataset.route));
        previewOnHover(b);
      }
      return;
    }

    if (specialFilter === "snow") {
      const snowRoutes = ROUTES.filter((r) => isSnowRoute(r) && LINEIDX[r.id] != null).sort(tagOrder);
      const html = `<div class="home-view">
        <div class="hero">
          <span class="icon" style="background:#00c7be; color:#fff"><svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a.5.5 0 0 1 .5.5v1.293l.707-.707a.5.5 0 1 1 .708.708L8.707 2.5l1.207 1.207.708-.707a.5.5 0 0 1 .707.707l-.707.707H12a.5.5 0 0 1 0 1h-1.293l.707.707a.5.5 0 0 1-.708.708L9.5 6.707 8.293 7.914l.707.708a.5.5 0 0 1-.707.707l-.707-.707V10a.5.5 0 0 1-1 0V8.621l-.707.707a.5.5 0 0 1-.708-.707l.707-.708L5.293 6.707l-.707.708a.5.5 0 0 1-.708-.708L4.586 6H3.293a.5.5 0 0 1 0-1h1.293l-.707-.707a.5.5 0 0 1 .707-.707l.707.707L6.5 5.5l1.207-1.207-.707-.707a.5.5 0 1 1 .708-.708L8.414 3.5V.5A.5.5 0 0 1 8 0z"/></svg></span>
          <div><h2>❄️ Winter Snow Network</h2><p>Emergency Snow Network (ESN)</p></div>
        </div>
        <p class="hint">Designated arterial routes operating during severe winter storms. Avoids steep hill grades and unplowed neighborhood streets.</p>
        <h3 class="section">${snowRoutes.length} Snow Network routes</h3>
        ${routeRows(snowRoutes)}
      </div>`;
      setView(html);
      for (const b of body().querySelectorAll("[data-route]")) {
        b.addEventListener("click", () => selectRoute(b.dataset.route));
        previewOnHover(b);
      }
      return;
    }

    const shown = LAYERS.filter((l) => enabled.has(l.key)).length;
    const nTransit = alerts.list.length, nRoad = alerts.road.length, nAl = nTransit + nRoad;
    const worst = Math.max(alerts.list[0]?.level || 0, alerts.road[0]?.level || 0);
    const nStop = alerts.list.filter((a) => a.level === 2).length, nChg = alerts.list.filter((a) => a.level === 1).length, nNotice = nTransit - nStop - nChg;
    const alertRow = !LIVE ? "" : `<li><button class="row nav-row" id="openAlerts" type="button">
        <span class="icon al-row-ic">${alertIcon(nAl ? worst : 0)}</span>
        <span class="txt"><span class="name">Service alerts${nAl ? `<span class="count">${nAl}</span>` : ""}</span><span class="desc">${!alerts.got ? "Checking…" : !nAl ? alerts.failed ? "Some feeds unavailable" : "None right now"
          : [nStop ? `${nStop} disruption${nStop === 1 ? "" : "s"}` : "", nChg ? `${nChg} service change${nChg === 1 ? "" : "s"}` : "", nNotice ? `${nNotice} notice${nNotice === 1 ? "" : "s"}` : "", nRoad ? `${nRoad} road report${nRoad === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}</span></span>
        <svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button></li>`;
    const keys = LAYERS.filter((l) => KEY_NAME[l.key] && enabled.has(l.key));
    const live = enabled.has("live");

    const favs = getFavs();
    const favRoutes = (favs.routes || []).map((id) => RBY[id]).filter(Boolean);
    const favStops = (favs.stops || []).map((id) => stopIndex[id]).filter(Boolean);
    const favTrips = (favs.trips || []);
    const hasFavs = favRoutes.length > 0 || favStops.length > 0 || favTrips.length > 0;
    const favSectionHTML = hasFavs ? `
      <div class="fav-header-wrap">
        <h3 class="section fav-header">Favorites <span class="fav-sub">${favRoutes.length + favStops.length + favTrips.length} saved</span></h3>
        <button type="button" class="fav-filter-toggle${specialFilter === "favs" ? " active" : ""}" id="toggleFavFilter">
          ${specialFilter === "favs" ? "★ Showing saved only" : "Filter map to saved"}
        </button>
      </div>
      <ul class="group" role="list">
        ${favTrips.map(renderFavTripRow).join("")}
        ${favRoutes.map((r) => `<li><button type="button" class="row route-row" data-route="${esc(r.id)}">
          ${badgeHTML(r)}
          <span class="txt"><span class="name">${esc(routeTitle(r))}</span><span class="desc">${esc(r.name)}</span></span>
          <span class="hw">${esc(freqText(r))}</span>
          <svg class="chev" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button></li>`).join("")}
        ${favStops.map((s) => `<li><button type="button" class="row" data-stop="${esc(s.key || s.id)}">
          <span class="icon"><span class="stop-glyph" aria-hidden="true"></span></span>
          <span class="txt"><span class="name">${esc(s.name)}</span><span class="desc">${s.kind === "stop" ? `Bus stop ${s.code ? "#" + s.code : ""}` : "Station"} · ${(s.routes || []).length} routes</span></span>
          <svg class="chev" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button></li>`).join("")}
      </ul>` : "";

    const throughRoutePreview = [RBY["metro-1"], RBY["metro-14"]].filter(Boolean);
    const throughRoutesHomeHTML = `<button type="button" class="through-routes-home press" id="openThroughRoutes">
      <span class="through-routes-home-icon" aria-hidden="true">🔄</span>
      <span class="txt"><span class="name">Stay on board through Downtown</span><span class="desc">Some buses continue as another route — no curbside transfer or extra fare.</span></span>
      <span class="through-routes-home-badges" aria-hidden="true">${throughRoutePreview.map((r) => badgeHTML(r)).join("<span class=\"through-routes-home-arrow\">➔</span>")}</span>
      <svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;

    const nonTrailKeys = keys.filter((l) => l.key !== "trails");
    const hasTrails = enabled.has("trails");
    const bikeLegendHTML = hasTrails ? `
      <div class="bike-legend-card">
        <div class="bike-legend-head">
          <h4 class="bike-legend-title">Bicycle Network & Trails</h4>
          <span class="muted" style="font-size:11px">SDOT 2025 Legend</span>
        </div>
        <div class="bike-filter-pills" role="group" aria-label="Filter bike facilities">
          <button type="button" class="bike-filter-pill${!bikeFacilityFilter ? " active" : ""}" data-bike-cat="">All types</button>
          <button type="button" class="bike-filter-pill${bikeFacilityFilter === "pbl" ? " active" : ""}" data-bike-cat="pbl">Protected & Trails</button>
          <button type="button" class="bike-filter-pill${bikeFacilityFilter === "greenway" ? " active" : ""}" data-bike-cat="greenway">Greenways</button>
          <button type="button" class="bike-filter-pill${bikeFacilityFilter === "lane" ? " active" : ""}" data-bike-cat="lane">Bike Lanes</button>
          <button type="button" class="bike-filter-pill${bikeFacilityFilter === "sharrow" ? " active" : ""}" data-bike-cat="sharrow">Sharrows</button>
          <button type="button" class="bike-filter-pill${bikeFacilityFilter === "unpaved" ? " active" : ""}" data-bike-cat="unpaved">Regional / Gravel</button>
        </div>
        <ul class="bike-legend-list" role="list">
          <li class="bike-legend-row${bikeFacilityFilter === "pbl" ? " active" : ""}" data-bike-cat="pbl" title="Filter to Protected Bike Lanes & Trails">
            <span class="sw">${bikeSwatch("pbl")}</span>
            <span class="lbl"><span class="lbl-name">Separated Bikeway / Multi-Use Trail</span><span class="lbl-desc">Protected bike lanes & paved paths</span></span>
          </li>
          <li class="bike-legend-row${bikeFacilityFilter === "greenway" ? " active" : ""}" data-bike-cat="greenway" title="Filter to Neighborhood Greenways">
            <span class="sw">${bikeSwatch("greenway")}</span>
            <span class="lbl"><span class="lbl-name">Neighborhood Greenway</span><span class="lbl-desc">Calm residential streets (20 mph, humps)</span></span>
          </li>
          <li class="bike-legend-row${bikeFacilityFilter === "lane" ? " active" : ""}" data-bike-cat="lane" title="Filter to Bicycle Lanes">
            <span class="sw">${bikeSwatch("lane")}</span>
            <span class="lbl"><span class="lbl-name">Bicycle Lane</span><span class="lbl-desc">Buffered, climbing & street lanes</span></span>
          </li>
          <li class="bike-legend-row${bikeFacilityFilter === "sharrow" ? " active" : ""}" data-bike-cat="sharrow" title="Filter to Shared Streets">
            <span class="sw">${bikeSwatch("sharrow")}</span>
            <span class="lbl"><span class="lbl-name">Shared Street / Sharrows</span><span class="lbl-desc">Streets with shared-lane markings</span></span>
          </li>
          <li class="bike-legend-row${bikeFacilityFilter === "unpaved" ? " active" : ""}" data-bike-cat="unpaved" title="Filter to Regional & Gravel Trails">
            <span class="sw">${bikeSwatch("unpaved")}</span>
            <span class="lbl"><span class="lbl-name">Regional & Gravel Trail</span><span class="lbl-desc">Unpaved regional corridors</span></span>
          </li>
        </ul>
      </div>` : "";

    const html = `<div class="home-view">
      <p class="live-line${live ? "" : " off"}"><span class="pulse" aria-hidden="true"></span><span${live ? ' id="liveDesc"' : ""}>${live ? esc(liveStatusText()) : "Vehicles are hidden"}</span></p>
      ${favSectionHTML}
      ${throughRoutesHomeHTML}
      <h3 class="section">Explore</h3>
      <ul class="group" role="list">
        <li><button class="row nav-row" id="openLayers" type="button">
          <span class="icon"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M15 7 25 12 15 17 5 12Z" fill="var(--accent)" opacity=".9"/><path d="M6.5 16.3 15 20.5l8.5-4.2" stroke="var(--accent)" stroke-width="1.8" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity=".55"/></svg></span>
          <span class="txt"><span class="name">Layers</span><span class="desc">${shown} of ${LAYERS.length} shown${isDefaultLayers() ? "" : " · customized"}</span></span>
          <svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button></li>
        <li><button class="row nav-row" id="openLegendGuide" type="button">
          <span class="icon" style="background:#2563eb;color:#fff;font-size:15px;display:flex;align-items:center;justify-content:center;border-radius:8px">📖</span>
          <span class="txt"><span class="name">Transit Map Guide & Legend</span><span class="desc">Service levels, bus runs & symbols</span></span>
          <svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button></li>
        ${alertRow}
      </ul>
      ${nonTrailKeys.length ? `<h2 class="section">On the map</h2><ul class="key-grid" role="list">${nonTrailKeys.map((l) =>
        `<li><span class="sw">${swatch(l)}</span><span>${esc(KEY_NAME[l.key])}</span></li>`).join("")}</ul>` : ""}
      ${bikeLegendHTML}
      ${!keys.length ? `<p class="hint">Every layer is off. Turn some on in Layers.</p>` : `<p class="hint">Tap a colored band or bike route to choose it. Its path, stops, and details will stand out.</p>`}
    </div>`;
    const existing = body().querySelector(".home-view");
    if (quiet && existing) existing.outerHTML = html;
    else setView(html);
    $("#openLayers")?.addEventListener("click", () => { panelView = "layers"; showLayers(); openSheet("half"); });
    $("#openThroughRoutes")?.addEventListener("click", () => { panelView = "through-routes"; showThroughRoutesGuide(); openSheet("half"); });
    $("#openLegendGuide")?.addEventListener("click", () => { panelView = "legend"; showLegendGuide(); openSheet("half"); });
    const oa = $("#openAlerts");
    if (oa) oa.addEventListener("click", () => { panelView = "alerts"; showAlerts(); openSheet("half"); });
    bindFavListEvents();
    body().querySelectorAll(".bike-filter-pill, .bike-legend-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.bikeCat || null;
        bikeFacilityFilter = (bikeFacilityFilter === cat && cat !== null) ? null : cat;
        applyLayerToggles();
        showHome(true);
      });
    });
  }

  function showThroughRoutesGuide(quiet) {
    panelView = "through-routes";
    const pairsHTML = THROUGH_ROUTES.map((tr) => {
      const routes = tr.ids.map((id) => RBY[id]).filter(Boolean);
      return `
        <div class="tr-guide-card" data-tr-preview="${esc(tr.ids.join(","))}" tabindex="0">
          <div class="tr-guide-header">
            <span class="tr-time-tag">${esc(tr.time === "all-day" ? "All Day Service" : tr.time)}</span>
          </div>
          <div class="tr-guide-pair">
            <div class="tr-col">
              ${routes[0] ? badgeHTML(routes[0]) : ""}
              <span class="tr-route-title">${esc(routes[0] ? routeTitle(routes[0]) : "")}</span>
            </div>
            <span class="tr-guide-arrow">➔</span>
            <div class="tr-col">
              ${routes.slice(1).map((r) => `<div class="tr-pair-sub">${badgeHTML(r)} <span class="tr-route-title">${esc(routeTitle(r))}</span></div>`).join("")}
            </div>
          </div>
          <p class="tr-guide-desc">${esc(tr.desc)}</p>
          <p class="tr-guide-preview">Hover to preview every route in this continuation on the map.</p>
          <div class="tr-guide-actions">
            ${routes.map((r) => `<button type="button" class="tr-partner-btn press" data-tr-select="${esc(r.id)}">${badgeHTML(r)} <span>View Line</span></button>`).join("")}
          </div>
        </div>`;
    }).join("");

    const html = `${backBtn}
      <div class="through-routes-view">
        <div class="hero">
          <span class="icon" style="background:#059669;color:#fff;font-size:20px;display:flex;align-items:center;justify-content:center;border-radius:12px">🔄</span>
          <div>
            <h2>Stay on the Bus</h2>
            <p>Direct downtown transfer pairs</p>
          </div>
        </div>
        <p class="hint">Metro pairs these routes through Downtown Seattle. Stay on board to continue your trip across town without paying another fare or transferring at the curb.</p>
        <div class="tr-list">
          ${pairsHTML}
        </div>
      </div>`;
    setView(html);
    $("#back")?.addEventListener("click", () => {
      panelView = "home";
      showHome();
    });
    body().querySelectorAll("[data-tr-select]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.dataset.trSelect;
        if (id && RBY[id]) selectRoute(id, { fit: true });
      });
    });
    let previewTimer = 0;
    body().querySelectorAll("[data-tr-preview]").forEach((card) => {
      const preview = () => {
        clearTimeout(previewTimer);
        const routes = String(card.dataset.trPreview || "").split(",").map((id) => RBY[id]).filter(Boolean);
        if (routes.length) focusRoutes(routes, false, { glow: true, widthScale: 1.58 });
      };
      const revert = () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => { if (panelView === "through-routes") focusOff(); }, 180);
      };
      card.addEventListener("mouseenter", preview);
      card.addEventListener("mouseleave", revert);
      card.addEventListener("focusin", preview);
      card.addEventListener("focusout", (e) => { if (!card.contains(e.relatedTarget)) revert(); });
    });
  }

  function showLegendGuide(quiet) {
    panelView = "legend";
    const busBlue = LINE[theme].local;
    const peakColor = LINE[theme].peak;
    const rapidRed = LINE[theme].rapidride;
    const freqColor = LINE[theme].frequent;

    const html = `${backBtn}
      <div class="legend-guide-view">
        <div class="hero">
          <span class="icon" style="background:#2563eb;color:#fff;font-size:20px;display:flex;align-items:center;justify-content:center;border-radius:12px">📖</span>
          <div>
            <h2>Transit Map Guide & Legend</h2>
            <p>Official service levels, bus runs & symbols</p>
          </div>
        </div>

        <div class="legend-card">
          <div class="legend-section">
            <h3 class="legend-sec-title">Frequent Bus Service</h3>
            <div class="legend-row">
              <span class="legend-swatch" style="background:${freqColor};height:5px"></span>
              <div><strong>Frequent bus route</strong><br><span class="muted">Runs every 10–15 minutes or better, all day every day</span></div>
            </div>
            <div class="legend-row">
              <span class="legend-swatch" style="background:${rapidRed};height:5px"></span>
              <div><strong>RapidRide BRT (Lines A–H)</strong><br><span class="muted">High-frequency arterial bus rapid transit</span></div>
            </div>
          </div>

          <div class="legend-section">
            <h3 class="legend-sec-title">All Day Service (Every 20–60 min)</h3>
            <div class="legend-row">
              <span class="legend-swatch" style="background:${busBlue};height:4px"></span>
              <div><strong>Main route</strong><br><span class="muted">Standard all-day service most of the day</span></div>
            </div>
            <div class="legend-row">
              <span class="legend-swatch dashed" style="color:${peakColor};height:3px"></span>
              <div><strong>Certain trips or peak only</strong><br><span class="muted">Runs during commute rush hours or select scheduled trips</span></div>
            </div>
            <div class="legend-row">
              <span class="legend-swatch" style="background:${freqColor};height:3px"></span>
              <div><strong>Infrequent section of Frequent route</strong><br><span class="muted">Outlying branch with reduced off-peak frequency</span></div>
            </div>
          </div>

          <div class="legend-section">
            <h3 class="legend-sec-title">Special & On-Demand Service</h3>
            <div class="legend-row">
              <span class="legend-swatch dashed" style="color:${peakColor};height:3px"></span>
              <div><strong>Peak-only bus</strong><br><span class="muted">Weekday commute hours only</span></div>
            </div>
            <div class="legend-row">
              <span class="legend-swatch" style="background:repeating-linear-gradient(45deg, #b83280, #b83280 4px, transparent 4px, transparent 8px);height:14px;border-radius:4px"></span>
              <div><strong>DART / Metro Flex service</strong><br><span class="muted">Request pick-up/drop-off anywhere within the service zone</span></div>
            </div>
            <div class="legend-row">
              <span class="legend-swatch dashed" style="color:#0d768a;height:4px"></span>
              <div><strong>Ferries & Water Taxi</strong><br><span class="muted">WSF Bainbridge/Bremerton, King County Water Taxi, Kitsap Fast Ferries</span></div>
            </div>
            <div class="legend-row">
              <span class="legend-swatch" style="background:#e8772e;height:4px"></span>
              <div><strong>Seattle Streetcar</strong><br><span class="muted">First Hill (FH) & South Lake Union (SL) lines</span></div>
            </div>
            <div class="legend-row">
              <span class="legend-swatch" style="background:#8a8f98;height:4px"></span>
              <div><strong>Seattle Center Monorail</strong><br><span class="muted">Westlake Center ↔ Seattle Center</span></div>
            </div>
          </div>

          <div class="legend-section">
            <h3 class="legend-sec-title">Bus Runs & Badge Types</h3>
            <div class="legend-row">
              <div class="legend-badge-sample">
                <span class="badge" style="background:${busBlue};color:#fff">128</span>
                <span class="badge" style="background:${freqColor};color:#fff">372</span>
              </div>
              <div><strong>Every day</strong><br><span class="muted">Solid filled badge indicates 7-day regular service</span></div>
            </div>
            <div class="legend-row">
              <div class="legend-badge-sample">
                <span class="badge part-time" style="--badge-c:${busBlue};border-color:${busBlue};color:${busBlue}">31</span>
                <span class="badge part-time" style="--badge-c:${freqColor};border-color:${freqColor};color:${freqColor}">372</span>
              </div>
              <div><strong>Not every day (Part-time)</strong><br><span class="muted">Lowlighted badge indicates part-time service (e.g. Mon–Fri only)</span></div>
            </div>
            <div class="legend-row">
              <div class="legend-badge-sample">
                <span class="badge suspended" style="background:${busBlue};color:#fff">111</span>
              </div>
              <div><strong>Suspended service</strong><br><span class="muted">Line through badge or red stop circle indicates closed/suspended service</span></div>
            </div>
          </div>

          <div class="legend-section">
            <h3 class="legend-sec-title">Through-Routes (Stay on the Bus)</h3>
            <div class="legend-row">
              <span style="font-size:18px">🔄</span>
              <div><strong>Direct downtown transfers</strong><br><span class="muted">Paired routes that continue through Downtown Seattle without a transfer or second fare</span></div>
            </div>
            <button type="button" class="legend-nav-btn press" id="legendOpenThrough">View all 6 through-route pairs ➔</button>
          </div>

          <div class="legend-section">
            <h3 class="legend-sec-title">Connections & Points of Interest</h3>
            <div class="legend-row"><span style="font-size:18px">★</span> <div><strong>Point of Interest</strong> · Sights, waterfront, Space Needle</div></div>
            <div class="legend-row"><span style="font-size:18px">🎓</span> <div><strong>College / University</strong> · UW, Seattle U, SPU, SCC, Bellevue College</div></div>
            <div class="legend-row"><span style="font-size:18px">🏥</span> <div><strong>Hospital / Medical Center</strong> · Harborview, Swedish, Children's, UWMC</div></div>
            <div class="legend-row"><span style="font-size:18px">🏟️</span> <div><strong>Stadium / Arena</strong> · Lumen Field, T-Mobile Park, Climate Pledge</div></div>
            <div class="legend-row"><span style="font-size:18px">📖</span> <div><strong>Public Library</strong> · Seattle Central Library & regional branches</div></div>
            <div class="legend-row"><span style="font-size:18px">🌳</span> <div><strong>Park / Green Space</strong> · Discovery Park, Green Lake, Seward Park</div></div>
            <div class="legend-row"><span style="font-size:18px">⛴️</span> <div><strong>Ferry Terminal</strong> · Colman Dock Pier 52, Pier 50 Fast Ferry</div></div>
            <div class="legend-row"><span style="font-size:18px">🚆</span> <div><strong>Amtrak & Sounder Train Hub</strong> · King Street Station, Tacoma Dome</div></div>
            <div class="legend-row"><span style="font-size:18px">🅿️</span> <div><strong>Park & Ride</strong> · Major regional transit lots & garages</div></div>
            <div class="legend-row"><span style="font-size:18px">🚲</span> <div><strong>Bicycle Facilities</strong> · Protected bike lanes, greenways & multi-use trails</div></div>
          </div>
        </div>
      </div>`;
    setView(html);
    $("#back")?.addEventListener("click", () => {
      panelView = "home";
      showHome();
    });
    $("#legendOpenThrough")?.addEventListener("click", () => {
      panelView = "through-routes";
      showThroughRoutesGuide();
    });
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
      <p class="credits">Routes and schedules from the agencies' open GTFS feeds (${esc(feedText())}). DART areas and regional trails from King County GIS and regional open data; Seattle bike network from SDOT GIS; Metro Flex zones from King County Metro. Base map © OpenStreetMap contributors via OpenFreeMap.</p>`);
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
  function bikeSwatch(type) {
    const trailCol = theme === "dark" ? "#2dd4bf" : "#047857";
    const trailGreenway = theme === "dark" ? "#86efac" : "#16a34a";
    const trailLane = theme === "dark" ? "#67e8f9" : "#0284c7";
    const trailSharrow = theme === "dark" ? "#d9f99d" : "#65a30d";
    const trailDash = theme === "dark" ? "#fbbf24" : "#b45309";
    const trailCase = theme === "dark" ? "#041d16" : "#ffffff";
    if (type === "pbl") {
      return `<svg viewBox="0 0 46 32" aria-hidden="true"><path d="M4 16 H42" stroke="${trailCase}" stroke-width="9" stroke-linecap="round"/><path d="M4 16 H42" stroke="${trailCol}" stroke-width="5" stroke-linecap="round"/><path d="M7 16 H39" stroke="#fff" stroke-opacity=".34" stroke-width="1.1" stroke-linecap="round"/></svg>`;
    }
    if (type === "greenway") {
      return `<svg viewBox="0 0 46 32" aria-hidden="true"><path d="M4 16 H42" stroke="${trailGreenway}" stroke-width="4.2" stroke-linecap="round" stroke-dasharray="8 4"/></svg>`;
    }
    if (type === "lane") {
      return `<svg viewBox="0 0 46 32" aria-hidden="true"><path d="M4 16 H42" stroke="${trailLane}" stroke-width="4.2" stroke-linecap="round"/></svg>`;
    }
    if (type === "sharrow") {
      return `<svg viewBox="0 0 46 32" aria-hidden="true"><path d="M4 16 H42" stroke="${trailSharrow}" stroke-width="3.8" stroke-linecap="round" stroke-dasharray="1.2 4"/></svg>`;
    }
    if (type === "unpaved") {
      return `<svg viewBox="0 0 46 32" aria-hidden="true"><path d="M4 16 H42" stroke="${trailDash}" stroke-width="4" stroke-linecap="round" stroke-dasharray="5 3"/></svg>`;
    }
    return `<svg viewBox="0 0 46 32"></svg>`;
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
    if (l.key === "trails") {
      const c = theme === "dark" ? "#2dd4bf" : "#059669";
      return `<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="8" cy="19" r="4.2" stroke="${c}" stroke-width="1.8" fill="none"/><circle cx="22" cy="19" r="4.2" stroke="${c}" stroke-width="1.8" fill="none"/><path d="M8 19 L13.5 12.5 L19.5 12.5 L22 19 M13.5 12.5 L11.5 8.5 M19.5 12.5 L15 19 M15 19 L15 11" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
    }
    if (l.key === "access") return `<svg viewBox="0 0 30 30" aria-hidden="true"><rect x="6" y="8" width="18" height="14" rx="4" fill="#7b5cc4" fill-opacity=".18" stroke="#7b5cc4" stroke-width="1.4" stroke-dasharray="3 2"/></svg>`;
    if (l.key === "live") return `<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="9" fill="${P.frequent}" opacity=".18"/><path d="M15 7.5 L20.5 19.5 L15 16.8 L9.5 19.5 Z" fill="${P.frequent}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    if (l.key === "stops") return `<svg viewBox="0 0 30 30" aria-hidden="true">${tube(P.frequent, 4, 15, "glass")}<circle cx="11" cy="15" r="3.2" fill="#fff" stroke="#8e8e93" stroke-width="1.5"/><circle cx="20" cy="15" r="3.2" fill="#fff" stroke="#8e8e93" stroke-width="1.5"/></svg>`;
    return `<svg viewBox="0 0 30 30"></svg>`;
  }

  const fmtH = (h) => { const hh = h % 24; return `${hh % 12 || 12}${hh < 12 ? "a" : "p"}`; };
  function getPugetSoundNow() {
    try {
      const d = new Date();
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23"
      }).formatToParts(d);
      const getP = (type) => parts.find((p) => p.type === type)?.value;
      const weekdayStr = getP("weekday");
      const hour = parseInt(getP("hour") || "0", 10);
      const minute = parseInt(getP("minute") || "0", 10);
      const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const dayOfWeek = dayMap[weekdayStr] ?? d.getDay();
      const decHour = hour + minute / 60;
      return { dayOfWeek, decHour, hour, minute };
    } catch {
      const d = new Date();
      return { dayOfWeek: d.getDay(), decHour: d.getHours() + d.getMinutes() / 60, hour: d.getHours(), minute: d.getMinutes() };
    }
  }

  function getCurrentSchedSlot() {
    const { dayOfWeek, decHour } = getPugetSoundNow();
    let d = dayOfWeek;
    let period = "mid";
    if (decHour < 3) {
      d = (d + 6) % 7;
      period = "late";
    } else if (decHour >= 3 && decHour < 6) {
      period = "early";
    } else if (decHour >= 6 && decHour < 9) {
      period = "am";
    } else if (decHour >= 9 && decHour < 15) {
      period = "mid";
    } else if (decHour >= 15 && decHour < 18) {
      period = "pm";
    } else if (decHour >= 18 && decHour < 22) {
      period = "eve";
    } else {
      period = "late";
    }
    const dayKey = d === 0 ? "sunday" : d === 6 ? "saturday" : "weekday";
    return { dayKey, period, decHour };
  }

  function scheduleTable(r) {
    if (!r.sched) return `<p class="hint">No published schedule table available for this route.</p>`;
    const curSlot = getCurrentSchedSlot();
    const days = [["weekday", "Weekday"], ["saturday", "Sat"], ["sunday", "Sun"]];

    const curSchedDay = r.sched[curSlot.dayKey];
    let statusTitle = "";
    let statusDetail = "";
    let isServiceActive = false;

    const curPeriodMeta = (META.periods || []).find(([k]) => k === curSlot.period);
    const curPeriodLabel = curPeriodMeta ? curPeriodMeta[1] : (curSlot.period === "early" ? "Early morning" : "Current schedule");
    const curPeriodHours = curPeriodMeta ? `${fmtH(curPeriodMeta[2])}–${fmtH(curPeriodMeta[3])}` : "";

    if (!curSchedDay) {
      statusTitle = "No service today";
      statusDetail = `This route does not operate on ${curSlot.dayKey === "sunday" ? "Sundays" : curSlot.dayKey === "saturday" ? "Saturdays" : "weekdays"}.`;
    } else if (curSlot.period === "early") {
      if (curSchedDay.first) {
        statusTitle = `Service begins soon at ${curSchedDay.first}`;
        statusDetail = `Early morning hours (3a–6a). First departure of the day is at ${curSchedDay.first}.`;
        isServiceActive = true;
      } else {
        statusTitle = "No service during early morning hours";
        statusDetail = "Service resumes later today.";
      }
    } else {
      const waitMin = curSchedDay[curSlot.period];
      const numTrips = curSchedDay[curSlot.period + "_n"];
      if (waitMin && numTrips > 2) {
        isServiceActive = true;
        statusTitle = `Running every ${waitMin} min right now`;
        statusDetail = `${curPeriodLabel} (${curPeriodHours}) · Typical wait in busier direction`;
      } else if (numTrips && numTrips > 0) {
        isServiceActive = true;
        statusTitle = `${numTrips} scheduled trip${numTrips > 1 ? "s" : ""} in this period`;
        statusDetail = `${curPeriodLabel} (${curPeriodHours}) · Limited scheduled departures`;
      } else {
        statusTitle = "No service right now";
        if (curSchedDay.first && curSchedDay.last) {
          statusDetail = `Operates today from ${curSchedDay.first} to ${curSchedDay.last}.`;
        } else {
          statusDetail = `No departures scheduled during ${curPeriodLabel.toLowerCase()} (${curPeriodHours}).`;
        }
      }
    }

    const statusBanner = `<div class="sched-now-status${isServiceActive ? " active" : " off"}">
      <div class="sched-now-status-head">
        <span class="sched-now-dot-live"></span>
        <span class="sched-now-status-title">${esc(statusTitle)}</span>
      </div>
      <div class="sched-now-status-sub">${esc(statusDetail)}</div>
    </div>`;

    const cell = (d, k) => {
      const s = r.sched[d];
      const isNow = (d === curSlot.dayKey && k === curSlot.period);
      if (!s) {
        if (isNow) {
          return `<td class="none sched-cell-now"><div class="sched-now-box"><span class="sched-now-tag"><span class="sched-now-pulse-dot"></span>NOW</span><span class="sched-now-val">—</span></div></td>`;
        }
        return `<td class="none">—</td>`;
      }
      const n = s[k + "_n"];
      if (!n) {
        if (isNow) {
          return `<td class="none sched-cell-now"><div class="sched-now-box"><span class="sched-now-tag"><span class="sched-now-pulse-dot"></span>NOW</span><span class="sched-now-val">—</span></div></td>`;
        }
        return `<td class="none">—</td>`;
      }
      const isGood = s[k] <= 15;
      if (n <= 2) {
        const text = `${n} trip${n > 1 ? "s" : ""}`;
        if (isNow) {
          return `<td class="sched-cell-now"><div class="sched-now-box"><span class="sched-now-tag"><span class="sched-now-pulse-dot"></span>NOW</span><span class="sched-now-val">${esc(text)}</span></div></td>`;
        }
        return `<td>${esc(text)}</td>`;
      }
      const text = `${s[k]} min`;
      if (isNow) {
        return `<td class="${isGood ? "good " : ""}sched-cell-now"><div class="sched-now-box${isGood ? " good" : ""}"><span class="sched-now-tag"><span class="sched-now-pulse-dot"></span>NOW</span><span class="sched-now-val">${esc(text)}</span></div></td>`;
      }
      return `<td class="${isGood ? "good" : ""}">${esc(text)}</td>`;
    };

    const rows = META.periods.map(([k, label, h0, h1]) => {
      const isNowRow = (k === curSlot.period);
      return `<tr><th scope="row" class="${isNowRow ? "sched-row-now" : ""}">${isNowRow ? '<span class="sched-row-live-dot" aria-hidden="true"></span>' : ""}${esc(label)}<small>${fmtH(h0)}–${fmtH(h1)}</small></th>${days.map(([d]) => cell(d, k)).join("")}</tr>`;
    }).join("");

    const span = days.map(([d]) => {
      const s = r.sched[d];
      const isNow = (d === curSlot.dayKey && curSlot.period === "first_last");
      if (!s) return `<td class="none">No service</td>`;
      if (s.span_h >= 22) {
        if (isNow) {
          return `<td class="sched-cell-now"><div class="sched-now-box good"><span class="sched-now-tag"><span class="sched-now-pulse-dot"></span>NOW</span><span class="sched-now-val">24 hours</span></div></td>`;
        }
        return `<td>24 hours</td>`;
      }
      if (isNow) {
        return `<td class="sched-cell-now"><div class="sched-now-box"><span class="sched-now-tag"><span class="sched-now-pulse-dot"></span>NOW</span><span class="sched-now-val">${s.first.replace(" ", " ")}</span></div></td>`;
      }
      return `<td>${s.first.replace(" ", " ")}<br>${s.last.replace(" ", " ")}</td>`;
    }).join("");

    const theadCols = days.map(([d, l]) => {
      const isToday = (d === curSlot.dayKey);
      return `<th scope="col" class="${isToday ? "sched-col-today" : ""}">${l}${isToday ? ' <span class="sched-today-pill">Today</span>' : ""}</th>`;
    }).join("");

    return `${statusBanner}<div class="group table-group"><table class="sched"><thead><tr><th></th>${theadCols}</tr></thead>
      <tbody>${rows}<tr><th scope="row"${curSlot.period === "first_last" ? ' class="sched-row-now"' : ""}>${curSlot.period === "first_last" ? '<span class="sched-row-live-dot" aria-hidden="true"></span>' : ""}First / last</th>${span}</tr></tbody></table></div>`;
  }
  const dayLabel = () => {
    const d = META.days;
    const f = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `Wed ${f(d.weekday)}, Sat ${f(d.saturday)} and Sun ${f(d.sunday)}, ${d.weekday.slice(0, 4)}`;
  };
  const backBtn = `<button class="back press" id="back" type="button"><svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2 2 10l8 8" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>All routes</button>`;

  // ---------------------------------------------------------------- agency and service logos
  // The service (RapidRide, Swift, Link, Sounder, ST Express) and the agency behind it, each with its
  // own logo where one is bundled (web/logos); the others fall back to their name.
  const LOGOS = window.ATLAS_LOGOS || {};
  const AGENCY_LOGO = { "Sound Transit": "soundtransit", "Community Transit": "ct", "Pierce Transit": "pierce", "Kitsap Transit": "kitsap", "Intercity Transit": "intercity",
    "King County Metro": "kcmetro", "Everett Transit": "everett", "Washington State Ferries": "wsf" };
  const SERVICE_LOGO = { rapidride: "rapidride", swift: "swift", link: "link", sounder: "sounder", amtrak: "amtrak", streetcar: "streetcar", monorail: "monorail", watertaxi: "watertaxi" };
  function logoKeys(r) {
    const svc = SERVICE_LOGO[r.cat] || (r.agency === "Sound Transit" ? "stexpress" : null);
    return [svc, svc && svc !== "rapidride" && svc !== "swift" ? null : AGENCY_LOGO[r.agency]].filter((k) => k && LOGOS[k]);
  }
  const logoImg = (k, name) => `<img class="logo-img logo-${k}" src="${LOGOS[k]}" alt="${esc(name)}" loading="lazy" decoding="async">`;
  const LOGO_NAME = { soundtransit: "Sound Transit", link: "Link light rail", sounder: "Sounder", stexpress: "ST Express", rapidride: "RapidRide", swift: "Swift",
    kcmetro: "King County Metro", everett: "Everett Transit", wsf: "Washington State Ferries", amtrak: "Amtrak", streetcar: "Seattle Streetcar",
    monorail: "Seattle Center Monorail", watertaxi: "King County Water Taxi", ct: "Community Transit", pierce: "Pierce Transit", kitsap: "Kitsap Transit", intercity: "Intercity Transit" };
  function logoChips(rs) {
    const keys = [...new Set(rs.flatMap(logoKeys))];
    return keys.map((k) => `<span class="chip logo-chip" title="${esc(LOGO_NAME[k])}">${logoImg(k, LOGO_NAME[k])}</span>`).join("");
  }

  const PARK_AND_RIDES = [
    { name: "Northgate Station Garage & P&R", stalls: 1497, bikes: "BikeLink on-demand lockers & cages", agency: "Sound Transit / Metro", lon: -122.3278, lat: 47.7027, transit: "1 Line Light Rail, Route 40, 67, 320, 345, 348" },
    { name: "Lynnwood City Center Station Garage", stalls: 1670, bikes: "BikeLink secure lockers & bike cage", agency: "Sound Transit", lon: -122.2963, lat: 47.8152, transit: "1 Line Light Rail, Swift Orange, Swift Blue, CT 201/202" },
    { name: "Mountlake Terrace Transit Center", stalls: 890, bikes: "BikeLink lockers & racks", agency: "Sound Transit", lon: -122.3135, lat: 47.7885, transit: "1 Line Light Rail, CT 112, 119, 130" },
    { name: "Shoreline North / 185th Station Garage", stalls: 500, bikes: "Secure bike room & lockers", agency: "Sound Transit", lon: -122.3292, lat: 47.7634, transit: "1 Line Light Rail, Route 333, 348" },
    { name: "Shoreline South / 148th Station Garage", stalls: 500, bikes: "Secure bike room & lockers", agency: "Sound Transit", lon: -122.3299, lat: 47.7365, transit: "1 Line Light Rail, Route 333, 345, 348" },
    { name: "Eastgate Park & Ride", stalls: 1614, bikes: "BikeLink lockers & bike shelter", agency: "King County Metro", lon: -122.1456, lat: 47.5768, transit: "Route 212, 218, 226, 240, 241, 245, 271, 554" },
    { name: "South Kirkland Park & Ride", stalls: 830, bikes: "BikeLink lockers & storage", agency: "King County Metro", lon: -122.1932, lat: 47.6439, transit: "Route 249, 250, 255, RapidRide K Line (future)" },
    { name: "Mercer Island Park & Ride", stalls: 447, bikes: "BikeLink lockers", agency: "Sound Transit / Metro", lon: -122.2331, lat: 47.5878, transit: "2 Line Light Rail, Route 204, 216, 550, 554" },
    { name: "Overlake Transit Center", stalls: 320, bikes: "BikeLink lockers", agency: "Sound Transit", lon: -122.1385, lat: 47.6447, transit: "2 Line Light Rail, RapidRide B Line, Route 225, 245, 250, 545" },
    { name: "South Bellevue Station Garage", stalls: 1500, bikes: "BikeLink lockers & bike room", agency: "Sound Transit", lon: -122.1882, lat: 47.5898, transit: "2 Line Light Rail, Route 241, 249" },
    { name: "Redmond Technology Station Garage", stalls: 300, bikes: "BikeLink lockers", agency: "Sound Transit", lon: -122.1287, lat: 47.6416, transit: "2 Line Light Rail, RapidRide B Line, Route 245, 249, 542, 545" },
    { name: "Angle Lake Station Garage", stalls: 1120, bikes: "Secure bike lockers & racks", agency: "Sound Transit", lon: -122.2985, lat: 47.4441, transit: "1 Line Light Rail, RapidRide A Line" },
    { name: "Federal Way Transit Center", stalls: 1190, bikes: "BikeLink lockers", agency: "Sound Transit", lon: -122.3082, lat: 47.3175, transit: "RapidRide A Line, ST 574, 577, 578, PT 402, 500" },
    { name: "Tukwila International Blvd Station", stalls: 600, bikes: "BikeLink lockers", agency: "Sound Transit", lon: -122.2858, lat: 47.4636, transit: "1 Line Light Rail, RapidRide F Line, Route 124, 128" },
    { name: "Kent Station Garage", stalls: 996, bikes: "BikeLink lockers", agency: "Sound Transit", lon: -122.2335, lat: 47.3838, transit: "Sounder S Line, RapidRide I Line, Route 150, 160, 161, 168" },
    { name: "Auburn Station Garage", stalls: 633, bikes: "BikeLink lockers", agency: "Sound Transit", lon: -122.2285, lat: 47.3075, transit: "Sounder S Line, ST 578, Route 180, 181, 184" },
    { name: "Sumner Station Park & Ride", stalls: 602, bikes: "Bike lockers & racks", agency: "Sound Transit", lon: -122.2415, lat: 47.2036, transit: "Sounder S Line, PT 496, ST 596" },
    { name: "Puyallup Station Garage", stalls: 1065, bikes: "Bike lockers & racks", agency: "Sound Transit", lon: -122.2965, lat: 47.1908, transit: "Sounder S Line, PT 400, 402, 409, 425" },
    { name: "Tacoma Dome Station Garage", stalls: 2283, bikes: "BikeLink lockers & bike room", agency: "Pierce Transit / Sound Transit", lon: -122.4225, lat: 47.2405, transit: "Sounder S Line, T Line Light Rail, Amtrak Cascades, ST 574, 590, 594" },
    { name: "Kenmore Park & Ride", stalls: 603, bikes: "Bike lockers & racks", agency: "King County Metro", lon: -122.2474, lat: 47.7562, transit: "Route 372, 522 Express" },
    { name: "Bothell Park & Ride", stalls: 220, bikes: "Bike lockers", agency: "King County Metro", lon: -122.2081, lat: 47.7592, transit: "Route 238, 372, 522 Express" },
    { name: "Kingsgate Park & Ride", stalls: 502, bikes: "Bike lockers", agency: "King County Metro", lon: -122.1793, lat: 47.7121, transit: "Route 239, 252, 257, 930" }
  ];

  const STEEP_HILLS = [
    {
      id: "hill-counterbalance",
      name: "Queen Anne Counterbalance (14% - 18.5% Grade)",
      short: "Counterbalance",
      grade: "14% - 18.5%",
      lon: -122.3564,
      lat: 47.6258,
      location: "Queen Anne Ave N between W Roy St and W Galer St",
      routes: ["2", "13", "29"],
      snowBypass: "Route 2 & 13 bypass Queen Anne Counterbalance via 1st Ave N or 6th Ave W during winter storms.",
      desc: "One of Seattle's steepest transit street corridors, historically operated with an underground cable counterbalance streetcar from 1898 to 1940. Electric trolleybuses use regenerative electric braking to negotiate this hill."
    },
    {
      id: "hill-james",
      name: "James Street Hill (16% Grade)",
      short: "James St Hill",
      grade: "16%",
      lon: -122.3275,
      lat: 47.6045,
      location: "James St between 3rd Ave and 9th Ave (First Hill)",
      routes: ["3", "4"],
      snowBypass: "Route 3 & 4 divert via Yesler Way / Boren Ave during adverse snow weather.",
      desc: "Steep ascent connecting Downtown Seattle and Pioneer Square with First Hill hospitals (Harborview Medical Center). One of the first transit street segments diverted when icy road conditions occur."
    },
    {
      id: "hill-madison",
      name: "Madison Street Corridor (12% - 14% Grade)",
      short: "Madison Incline",
      grade: "12% - 14%",
      lon: -122.3282,
      lat: 47.6095,
      location: "Madison St between 1st Ave and 8th Ave",
      routes: ["G-Line", "G", "12"],
      snowBypass: "RapidRide G Line operates high-traction 60-ft hybrid electric buses. Heavy snow advisory may restrict operation.",
      desc: "Historic cable car corridor connecting Elliott Bay to First Hill and Capitol Hill. Today traversed by the RapidRide G Line with center-running transit priority and median stations."
    },
    {
      id: "hill-denny",
      name: "Denny Way Hill (10% - 12% Grade)",
      short: "Denny Way Hill",
      grade: "10% - 12%",
      lon: -122.3385,
      lat: 47.6186,
      location: "Denny Way between Broad St and Fairview / Bellevue Ave",
      routes: ["8"],
      snowBypass: "Route 8 frequently faces delays and winter diversions at the Denny / Fairview bottleneck.",
      desc: "Traversed by Metro Route 8 ('The L8') across the Denny Regrade edge between Belltown, South Lake Union, and Capitol Hill."
    },
    {
      id: "hill-yesler",
      name: "Yesler Way (11% Grade)",
      short: "Yesler Way",
      grade: "11%",
      lon: -122.3235,
      lat: 47.6018,
      location: "Yesler Way between 3rd Ave and 8th Ave (First Hill / ID)",
      routes: ["27"],
      snowBypass: "Treated as primary winter arterial serving Harborview Hospital and Central District.",
      desc: "Site of Seattle's first cable car line (1888) connecting Pioneer Square to Lake Washington."
    }
  ];

  const THROUGH_ROUTES = [
    {
      ids: ["metro-1", "metro-14"],
      shorts: ["1", "14"],
      time: "all-day",
      desc: "Stay on the bus through Downtown Seattle to travel between Kinnear (Queen Anne) and Mount Baker. No transfer or extra fare required.",
    },
    {
      ids: ["metro-2", "metro-13"],
      shorts: ["2", "13"],
      time: "all-day",
      desc: "Buses from West Queen Anne (Route 2) and Seattle Pacific (Route 13) continue through Downtown Seattle to Madrona Park as Route 2.",
    },
    {
      ids: ["metro-5", "metro-21"],
      shorts: ["5", "21"],
      time: "all-day",
      desc: "Stay on the bus through Downtown Seattle to travel between Shoreline CC / Greenwood and Westwood Village / Arbor Heights without transferring.",
    },
    {
      ids: ["metro-24", "metro-33", "metro-124"],
      shorts: ["24", "33", "124"],
      time: "all-day",
      desc: "Buses from West Magnolia (Route 24) and Discovery Park (Route 33) continue through Downtown Seattle to Tukwila International Blvd Station as Route 124.",
    },
    {
      ids: ["metro-28", "metro-131", "metro-132"],
      shorts: ["28", "131", "132"],
      time: "all-day",
      desc: "Buses from Whittier Heights and Fremont (Route 28) continue through Downtown Seattle to Georgetown, South Park, and Burien as Routes 131 and 132.",
    },
    {
      ids: ["metro-33", "metro-27"],
      shorts: ["33", "27"],
      time: "early AM & weekends",
      desc: "During early morning hours and weekends, Route 33 (Discovery Park) continues through Downtown Seattle as Route 27 to Colman Park / Leschi.",
    },
  ];

  function getThroughRouteInfo(r) {
    if (!r) return null;
    const isMetro = r.agencyShort === "Metro" || r.agency === "Metro" || r.agency === "King County Metro" || (r.id && r.id.startsWith("metro-"));
    if (!isMetro) return null;
    const tr = THROUGH_ROUTES.find((t) => t.ids.includes(r.id) || t.shorts.includes(r.short));
    if (!tr) return null;
    let partnerIds = [];
    if (r.short === "1") partnerIds = ["metro-14"];
    else if (r.short === "14") partnerIds = ["metro-1"];
    else if (r.short === "2") partnerIds = ["metro-13"];
    else if (r.short === "13") partnerIds = ["metro-2"];
    else if (r.short === "5") partnerIds = ["metro-21"];
    else if (r.short === "21") partnerIds = ["metro-5"];
    else if (r.short === "24") partnerIds = ["metro-124"];
    else if (r.short === "33") partnerIds = ["metro-124", "metro-27"];
    else if (r.short === "124") partnerIds = ["metro-24", "metro-33"];
    else if (r.short === "28") partnerIds = ["metro-131", "metro-132"];
    else if (r.short === "131" || r.short === "132") partnerIds = ["metro-28"];
    else if (r.short === "27") partnerIds = ["metro-33"];
    else partnerIds = tr.ids.filter((id) => id !== r.id);
    const partners = partnerIds.map((id) => RBY[id]).filter(Boolean);
    return { ...tr, partners };
  }

  function showRoute(r) {
    const w = r.sched.weekday;
    const freq = w && w.mid_n >= 3 ? `${w.mid}<small> min</small>` : w && (w.am_n || w.pm_n) ? "Rush hour" : w ? `${w.trips}<small> trips</small>` : "Weekends";
    const span = !w ? "—" : w.span_h >= 22 ? "24 hours" : `${w.first.replace(" ", " ")} – ${w.last.replace(" ", " ")}`;
    const pats = (r.patterns || []).filter((p) => p.stops && p.stops.length);
    const color = keyColor(dkey(r));
    const fav = isFav("route", r.id);
    const steepHill = STEEP_HILLS.find((h) => h.routes.includes(r.short) || h.routes.includes(r.label) || h.routes.includes(r.id) || (r.short === "G" && h.id === "hill-madison"));
    const showHillNotice = steepHill && (specialFilter === "snow" || enabled.has("trails"));
    const isSnow = specialFilter === "snow";
    const hillNotice = showHillNotice ? `<div class="hill-note"><span class="hill-icon">${isSnow ? "❄️" : "🚲"}</span><span><strong>${isSnow ? "Winter Snow Bypass" : "Steep Incline Corridor"} (${steepHill.grade}):</strong> ${esc(isSnow ? steepHill.snowBypass : `Traverses ${steepHill.location}. ${steepHill.snowBypass}`)}</span></div>` : "";
    const snowBanner = specialFilter === "snow" ? `<div class="snow-banner"><span class="snow-icon">${isSnowRoute(r) ? "❄️" : "⚠️"}</span><span>${isSnowRoute(r) ? "<strong>Active Winter Snow Route:</strong> Operates on plowed arterials during winter storms. Avoids steep hills and non-essential branches." : "<strong>Suspended during Snow Emergencies:</strong> This route is not part of the Emergency Snow Network and pauses during severe winter conditions."}</span></div>` : "";
    const trInfo = getThroughRouteInfo(r);
    const throughRouteHTML = trInfo && trInfo.partners.length ? `
      <div class="through-route-card">
        <div class="tr-badge-row">
          <div class="tr-header-left">
            <span class="tr-icon">🔄</span>
            <span class="tr-title">Stay on the bus to transfer</span>
          </div>
          <span class="tr-time-tag">${esc(trInfo.time === "all-day" ? "All Day" : trInfo.time)}</span>
        </div>
        <div class="tr-continuation">
          <span class="tr-from">${badgeHTML(r)}</span>
          <span class="tr-arrow">➔</span>
          <div class="tr-targets">
            ${trInfo.partners.map((p) => `<button type="button" class="tr-partner-btn press" data-tr-route="${esc(p.id)}">${badgeHTML(p)} <span>${esc(routeTitle(p))}</span></button>`).join("")}
          </div>
        </div>
        <p class="tr-desc">${esc(trInfo.desc)}</p>
      </div>` : "";
    const isSusp = isRouteSuspended(r);
    const suspBanner = isSusp ? `<div class="route-susp-banner"><span class="susp-icon">🚫</span><span><strong>Route Temporarily Suspended:</strong> Trips on this route are currently not operating due to an active service disruption or seasonal suspension.</span></div>` : "";
    let html = `${backBtn}
      ${suspBanner}
      <div class="hero">${badgeHTML(r, "xl")}<div><h2>${esc(routeTitle(r))}</h2><p>${esc(r.name || "")}</p></div></div>
      <div class="chips"><span class="chip"><span class="dot" style="background:${color}"></span>${esc(CAT_NAME[r.cat])}</span><span class="chip">${esc(r.agency)}</span>${logoChips([r])}<span class="chip live-chip" id="liveChip" hidden><span class="pulse" aria-hidden="true"></span><span class="n"></span></span></div>
      <div class="card-actions">
        <button type="button" class="action-btn fav-btn press${fav ? " is-fav" : ""}" id="routeFavBtn" data-fav-route="${esc(r.id)}" aria-label="${fav ? "Remove from favorites" : "Save to favorites"}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <span>${fav ? "Favorited" : "Favorite"}</span>
        </button>
        <button type="button" class="action-btn share-btn press" id="routeShareBtn" aria-label="Share route link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span>Share</span>
        </button>
      </div>
      ${snowBanner}
      ${routeBadgesHTML(r)}
      ${throughRouteHTML}
      <div id="routeAlerts"></div>${r.id.startsWith("wsf-") ? showFerryInfo([...new Set(pats.flatMap((p) => p.stops).filter((id) => /^wsf-\d+$/.test(id)).map((id) => +id.slice(4)))]) : ""}
      <div class="tiles">
        <div class="tile"><span class="k">Midday on weekdays</span><span class="v">${w && w.mid_n >= 3 ? "Every " : ""}${freq}</span></div>
        <div class="tile"><span class="k">Weekday hours</span><span class="v sm">${esc(span)}</span></div>
      </div>
      <h3 class="section">Schedule at a glance</h3>${scheduleTable(r)}
      <p class="foot">Typical wait in the busier direction, from the published schedule for ${esc(dayLabel())}.</p>
      ${hillNotice}`;
    if (pats.length) {
      html += `<h3 class="section">Stops</h3><div class="segmented" role="tablist">${pats.map((p, i) =>
        `<button role="tab" type="button" aria-selected="${i === 0}" data-i="${i}">To ${esc((p.headsign || "terminal").replace(/^to\s+/i, ""))}</button>`).join("")}<span class="seg-thumb" aria-hidden="true"></span></div>
        <ol class="group stoplist" id="stoplist" style="--line-c:${color}"></ol>`;
    }
    if (r.url) html += `<a class="link-out press" href="${esc(r.url)}" target="_blank" rel="noopener">Official schedule and alerts<span aria-hidden="true">↗</span></a>`;
    setView(html);
    $("#back").addEventListener("click", () => {
      if (history.length > 1 && window.history.state?.hash) {
        history.back();
      } else {
        clearSelection({ push: false });
      }
    });
    $("#routeFavBtn")?.addEventListener("click", () => {
      const isNow = toggleFav("route", r.id);
      const b = $("#routeFavBtn");
      if (b) {
        b.classList.toggle("is-fav", isNow);
        b.querySelector("span").textContent = isNow ? "Favorited" : "Favorite";
      }
    });
    $("#routeShareBtn")?.addEventListener("click", () => {
      shareTarget({
        title: `${routeTitle(r)} - ${r.name}`,
        text: `Seattle Transit Map: ${routeTitle(r)}`,
        url: `${location.origin}${location.pathname}#route-${r.id}`
      });
    });
    body().querySelectorAll("[data-tr-route]").forEach((b) => {
      b.addEventListener("click", () => {
        const p = RBY[b.dataset.trRoute];
        if (p) selectRoute(p.id, { fit: true });
      });
    });
    const renderStops = (i) => {
      const p = pats[i];
      $("#stoplist").innerHTML = p.stops.map((sid) => {
        const s = stopIndex[sid];
        const susp = s && stopIsSuspended(s.id);
        const name = s ? s.name : STOPNAMES[sid] || sid;
        return `<li><button type="button" data-stop="${esc(s ? s.key : "")}" class="stop-row-btn${susp ? " is-suspended" : ""}">
          <span class="stop-name${susp ? " suspended-text" : ""}">${esc(name)}</span>
          ${susp ? `<span class="stop-susp-pill">🚫 Closed</span>` : ""}
        </button></li>`;
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
    if ($("#ferryInfo")) { fillFerryInfo(); loadFerryTerminals(); }
    updateLiveUI();
    openSheet("half");
  }
  function routeRows(rs) {
    return `<ul class="group" role="list">${rs.map((r) => `<li><button type="button" class="row route-row" data-route="${esc(r.id)}">${badgeHTML(r)}<span class="txt"><span class="name">${esc(routeTitle(r))}</span><span class="desc">${esc(r.name)}</span></span><span class="hw">${esc(freqText(r))}</span><svg class="chev" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5l-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button></li>`).join("")}</ul>`;
  }
  function showCorridor(routes = null, quiet = false) {
    if (routes) corridorRoutes = [...new Set(routes.map((r) => r.id))];
    if (quiet && body().querySelector(".corridor-picker")) return;
    panelView = "corridor";
    const query = routes ? "" : $("#corridorQuery")?.value || "";
    const rs = corridorRoutes.map((id) => RBY[id]).filter(Boolean).sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }) || tagOrder(a, b));
    setView(`${backBtn}<div class="corridor-picker"><h2 class="view-title">Choose a route</h2>
      <p class="hint">${rs.length} routes here. Choose a route to follow its full path.</p>
      <label class="corridor-filter"><span class="sr-only">Filter routes here</span><input id="corridorQuery" type="search" placeholder="Route number or destination" autocomplete="off"></label>
      <p class="corridor-count" id="corridorCount" aria-live="polite"></p><div id="corridorList"></div></div>`);
    const input = $("#corridorQuery"); input.value = query;
    const render = () => {
      const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matching = rs.filter((r) => words.every((w) => `${r.label} ${routeTitle(r)} ${r.name} ${r.agency || ""}`.toLowerCase().includes(w)));
      $("#corridorCount").textContent = words.length ? `${matching.length} of ${rs.length} routes` : "All routes here";
      $("#corridorList").innerHTML = matching.length ? routeRows(matching) : '<p class="hint">No matching routes.</p>';
      for (const b of $("#corridorList").querySelectorAll("[data-route]")) {
        b.addEventListener("click", () => { focusOff(); selectRoute(b.dataset.route, { fit: true }); }); previewOnHover(b);
      }
    };
    input.addEventListener("input", () => { focusOff(); render(); }); render();
    $("#back").addEventListener("click", () => { panelView = "home"; corridorRoutes = []; focusOff(); showHome(); openSheet("peek"); });
    if (!quiet) openSheet("half");
  }
  function showStop(s) {
    const rs = s.routes.map((id) => RBY[id]).filter(Boolean).sort(tagOrder);
    const kind = s.kind === "stop" ? (s.code ? `Bus stop #${s.code}` : "Bus stop") : s.kind === "ferry" ? "Ferry terminal" : "Station";
    const fav = isFav("stop", s.id);
    const keys = [...new Set([s.key, ...((s.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))])];
    const stopIds = stopIdsOf(s);
    const bayMatch = s.name.match(/\bBay\s+([A-Z0-9]+)\b/i);
    const bayBadge = bayMatch ? `<span class="bay-pill">Bay ${esc(bayMatch[1])}</span>` : "";
    const cleanName = s.name.replace(/\s*-\s*Bay\s+[A-Z0-9]+/i, "").trim();
    const isRail = s.kind === "station" || rs.some((r) => ["link", "sounder"].includes(r.cat));
    const elevatorHTML = isRail ? `<a class="elevator-link press" href="https://www.soundtransit.org/ride-with-us/service-alerts" target="_blank" rel="noopener">♿ Live Station Elevators & Escalators Status ↗</a>` : "";
    const isSusp = stopIsSuspended(s.id);
    const suspBanner = isSusp ? `
      <div class="stop-susp-banner">
        <span class="susp-icon">🚫</span>
        <div>
          <strong>Service Suspended · Stop Temporarily Closed</strong>
          <p>Buses are currently bypassing or not serving this stop due to an active service disruption or detour.</p>
        </div>
      </div>` : "";
    let html = `${backBtn}<div class="hero stop-hero press" data-stop="${esc(s.id)}" role="button" tabindex="0" title="Highlight stop on map"><span class="stop-glyph${s.kind === "stop" ? "" : " big"}" aria-hidden="true"></span><div><h2>${esc(cleanName)}${bayBadge}</h2><p>${esc(kind)}</p>${elevatorHTML}</div></div>
      ${logoChips(rs) ? `<div class="chips">${logoChips(rs)}</div>` : ""}
      <div class="card-actions">
        <button type="button" class="action-btn fav-btn press${fav ? " is-fav" : ""}" id="stopFavBtn" data-fav-stop="${esc(s.id)}" aria-label="${fav ? "Remove from favorites" : "Save to favorites"}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <span>${fav ? "Favorited" : "Favorite"}</span>
        </button>
        <button type="button" class="action-btn share-btn press" id="stopShareBtn" aria-label="Share stop link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span>Share</span>
        </button>
      </div>
      ${suspBanner}
      <div id="stopAlerts"></div>${showFerryInfo(ferryTerminalIds(s))}
      <h3 class="section">Upcoming departures</h3><div id="stopPanelDeps">${depRowsHTML(keys, stopIds)}</div>
      ${directionsHTML(s.lat, s.lon, s.name)}
      <h3 class="section">${rs.length} route${rs.length === 1 ? "" : "s"} stop here</h3>${routeRows(rs)}`;
    if (s.kind !== "stop") {
      const near = nearbyStops(s, 250);
      const bus = [...new Set(near.flatMap((x) => x.routes))].filter((id) => !s.routes.includes(id)).map((id) => RBY[id]).filter(Boolean).sort(tagOrder);
      if (bus.length) html += `<h3 class="section">Buses within a short walk</h3>${routeRows(bus)}`;
    }
    setView(html);
    $("#back").addEventListener("click", () => {
      if (history.length > 1 && window.history.state?.hash) {
        history.back();
      } else {
        panelView = "home";
        clearSelection({ push: false });
      }
    });
    $("#stopFavBtn")?.addEventListener("click", () => {
      const isNow = toggleFav("stop", s.id);
      const b = $("#stopFavBtn");
      if (b) {
        b.classList.toggle("is-fav", isNow);
        b.querySelector("span").textContent = isNow ? "Favorited" : "Favorite";
      }
    });
    $("#stopShareBtn")?.addEventListener("click", () => {
      shareTarget({
        title: `${s.name} - Transit Stop`,
        text: `Seattle Transit Map: ${s.name}`,
        url: `${location.origin}${location.pathname}#stop-${s.id}`
      });
    });
    const bindStopsAndRoutes = (root = body()) => {
      for (const b of root.querySelectorAll("[data-route]")) {
        b.addEventListener("click", () => selectRoute(b.dataset.route));
        previewOnHover(b);
      }
      for (const b of root.querySelectorAll("[data-stop]")) {
        b.addEventListener("click", () => {
          if (b.dataset.stop === s.id) {
            map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), s.kind === "stop" ? 16 : 14.5), duration: 800 });
          } else {
            selectStop(b.dataset.stop);
          }
        });
        previewStopOnHover(b);
      }
    };
    bindStopsAndRoutes();
    ensureDepartures(stopIds, () => {
      const box = $("#stopPanelDeps");
      if (box) {
        box.innerHTML = depRowsHTML(keys, stopIds);
        bindStopsAndRoutes(box);
      }
    });
    fillStopAlerts(s);
    if ($("#ferryInfo")) { fillFerryInfo(); loadFerryTerminals(); }
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
    if (AREAS && AREAS.trails && AREAS.trails.features) {
      for (const f of AREAS.trails.features) {
        const p = f.properties;
        if (!p || !p.name) continue;
        searchIndex.push({ kind: "trail", id: p.name, key: `${p.name} ${p.street || ""} ${p.cat_name || ""} trail bike bicycle cycling pbl greenway lane sharrow ${p.region || ""}`.toLowerCase(), f });
      }
    }
    for (const pr of PARK_AND_RIDES) {
      searchIndex.push({
        kind: "pr",
        id: pr.name,
        key: `${pr.name} park and ride park-and-ride p&r parking lot garage stalls transit center bikelink bike lockers ${pr.agency}`.toLowerCase(),
        pr
      });
    }
    for (const hill of STEEP_HILLS) {
      searchIndex.push({
        kind: "hill",
        id: hill.id,
        key: `${hill.name} ${hill.short} steep hill incline grade counterbalance slope snow bypass ${hill.location}`.toLowerCase(),
        hill
      });
    }
    for (const d of KEY_DESTINATIONS) {
      searchIndex.push({
        kind: "dest",
        id: d.id,
        key: `${d.name} ${d.short} ${d.desc} ${d.transit} destination sight attraction college university hospital stadium library park poi`.toLowerCase(),
        d
      });
    }
    searchIndex.push({
      kind: "guide",
      id: "guide-legend",
      view: "legend",
      title: "Transit Map Guide & Legend",
      desc: "Service levels, bus runs, infrequent routes, dashed lines & badge symbols",
      icon: "📖",
      key: "transit map guide legend symbols key bus runs everyday not everyday part-time frequent infrequent peak dashed line help explanation".toLowerCase()
    });
    searchIndex.push({
      kind: "guide",
      id: "guide-through-routes",
      view: "through-routes",
      title: "Stay on the Bus · Through Routes",
      desc: "Direct transfers through Downtown Seattle (Routes 1/14, 2/13, 5/21, 24/33/124, 28/131/132)",
      icon: "🔄",
      key: "stay on the bus through routes pairs transfer downtown seattle direct connection continuation 1 14 2 13 5 21 24 33 124 28 131 132".toLowerCase()
    });
  }
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/), scored = [];
    for (const it of searchIndex) {
      if (!words.every((w) => it.key.includes(w))) continue;
      let score = it.kind === "route" ? 0 : it.kind === "guide" ? 4 : it.kind === "dest" ? 6 : it.kind === "station" ? 10 : it.kind === "pr" ? 12 : it.kind === "trail" ? 14 : it.kind === "hill" ? 16 : 20;
      if (it.kind === "route" && (it.label === q || it.r.short.toLowerCase() === q)) score -= 100;
      if (it.kind === "guide" && (q.includes("legend") || q.includes("guide") || q.includes("through") || q.includes("transfer") || q.includes("symbol") || q.includes("run") || q.includes("badge"))) score -= 50;
      if (it.kind === "dest" && (it.d.name.toLowerCase().startsWith(q) || it.d.short.toLowerCase().startsWith(q))) score -= 30;
      if (it.key.startsWith(q)) score -= 5;
      if (it.kind === "trail" && (q.includes("bike") || q.includes("trail") || q.includes("cycle") || q.includes("cycling") || q.includes("greenway") || q.includes("pbl") || q.includes("lane"))) score -= 25;
      if (it.kind === "pr" && (q.includes("park") || q.includes("ride") || q.includes("p&r") || q.includes("garage") || q.includes("locker"))) score -= 25;
      if (it.kind === "hill" && (q.includes("hill") || q.includes("steep") || q.includes("incline") || q.includes("grade") || q.includes("slope"))) score -= 25;
      scored.push([score, it]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const seen = new Set();
    return scored.map((x) => x[1]).filter((it) => {
      const k = it.kind === "stop" ? it.s.name : it.kind === "dest" ? it.d.name : it.kind === "trail" ? it.f.properties.name : it.kind === "pr" ? it.pr.name : it.kind === "hill" ? it.hill.name : it.kind === "guide" ? it.id : it.kind + it.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 9);
  }
  function selectTrail(f) {
    if (!f || !f.geometry) return;
    if (!enabled.has("trails")) {
      enabled.add("trails");
      store.set("layers3", [...enabled]);
      applyLayerToggles();
    }
    const coords = [];
    const getCoords = (c) => {
      if (typeof c[0] === "number") coords.push(c);
      else c.forEach(getCoords);
    };
    getCoords(f.geometry.coordinates);
    if (!coords.length) return;
    const lons = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
    const bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
    map.fitBounds(bounds, { padding: isNarrow() ? { top: 60, bottom: 220, left: 30, right: 30 } : { top: 60, bottom: 60, left: 400, right: 60 }, maxZoom: 14.5 });
    const mid = coords[Math.floor(coords.length / 2)];
    const p = f.properties;
    const isUnpaved = p.surface === "unpaved";
    const catName = p.cat_name || "Bicycle Facility";
    const icon = p.facility === "trail" ? "🚲" : p.facility === "pbl" ? "🛡️" : p.facility === "greenway" ? "🌿" : p.facility === "lane" ? "🚲" : p.facility === "sharrow" ? "🚴" : "🚲";
    const badgeColor = p.facility === "pbl" || p.facility === "trail" ? "#047857" : p.facility === "greenway" ? "#10b981" : p.facility === "lane" ? "#0891b2" : p.facility === "sharrow" ? "#15803d" : "#b45309";
    const statusBadge = p.status === "UNDERCONS" ? ` · <span class="incline-badge" style="background:#fbbf24;color:#78350f">Under Construction</span>` : "";
    const html = `<div class="pop">
      <div style="display:flex;align-items:center;gap:6px;margin:2px 0 6px">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;background:${badgeColor};color:#fff;padding:2px 8px;border-radius:6px">${esc(catName)}</span>
        ${statusBadge}
      </div>
      <h3 style="margin:0 0 4px">${icon} ${esc(p.name)}</h3>
      <p class="trail-meta"><strong>${isUnpaved ? "Gravel / Unpaved Surface" : "Paved Surface"}</strong>${p.length_mi ? ` · ${p.length_mi} miles` : ""}${p.region ? ` · ${esc(p.region)}` : ""}</p>
      <p>${esc(p.desc || "Seattle & Puget Sound bicycle network facility connecting transit hubs, neighborhoods, and commercial centers.")}</p>
      <div style="margin-top:10px">${directionsHTML(mid[1], mid[0], p.name)}</div>
      <p class="foot" style="margin-top:8px;font-size:11px;color:var(--muted)">City of Seattle SDOT & King County GIS Data</p>
    </div>`;
    openPopup({ lng: mid[0], lat: mid[1] }, html, "300px");
  }
  function selectPR(pr) {
    if (!pr) return;
    map.flyTo({ center: [pr.lon, pr.lat], zoom: 16, padding: fitPadding(), duration: 800 });
    const html = `<div class="pop">
      <h3>🅿️ ${esc(pr.name)}</h3>
      <p class="trail-meta"><strong>${pr.stalls} Parking Stalls</strong> · ${esc(pr.agency)}</p>
      <p>🚲 <strong>Bicycle Parking:</strong> ${esc(pr.bikes)}</p>
      <p>🚌 <strong>Transit Connections:</strong> ${esc(pr.transit)}</p>
      <div style="margin-top:10px">${directionsHTML(pr.lat, pr.lon, pr.name)}</div>
      <p class="foot" style="margin-top:6px">Regional commuter park & ride. BikeLink lockers offer secure on-demand bike parking via app or smartcard.</p>
    </div>`;
    openPopup({ lng: pr.lon, lat: pr.lat }, html, "300px");
  }
  function selectHill(h) {
    if (!h) return;
    map.flyTo({ center: [h.lon, h.lat], zoom: 16.2, padding: fitPadding(), duration: 800 });
    const html = `<div class="pop">
      <h3>⚠️ ${esc(h.name)}</h3>
      <p class="trail-meta"><span class="incline-badge">${h.grade} grade</span> · ${esc(h.location)}</p>
      <p>${esc(h.desc)}</p>
      <p>🚌 <strong>Traversing Routes:</strong> ${h.routes.join(", ")}</p>
      <p class="foot" style="color:var(--accent);margin-top:6px">❄️ <strong>Snow Bypass:</strong> ${esc(h.snowBypass)}</p>
    </div>`;
    openPopup({ lng: h.lon, lat: h.lat }, html, "320px");
  }
  function clearPlaceMarker() {
    if (placeMarker) {
      placeMarker.remove();
      placeMarker = null;
    }
  }

  function getPlaceBadge(p) {
    if (!p) return { emoji: "📍", bg: "#007aff", label: "Location" };
    const k = (p.osm_key || p.class || "").toLowerCase();
    const v = (p.osm_value || p.type || "").toLowerCase();
    const str = `${p.name || ""} ${p.desc || ""} ${v} ${k}`.toLowerCase();

    // 1. Airports & Aviation
    if (k === "aeroway" || v === "aerodrome" || v === "airport" || /\b(airport|airfield|aerodrome|heliport|helipad|seatac|sea-tac|boeing field|paine field)\b/i.test(str)) {
      return { emoji: "✈️", bg: "#0284c7", label: "Airport" };
    }
    // 2. Ferry Terminals & Marine Docks
    if (v === "ferry_terminal" || k === "ferry" || /\b(ferry|colman dock|water taxi|pier 50|pier 52|fauntleroy|bainbridge ferry|bremerton ferry|kingston ferry|edmonds ferry|mukilteo ferry)\b/i.test(str)) {
      return { emoji: "⛴️", bg: "#0369a1", label: "Ferry Terminal" };
    }
    // 3. Marinas & Boat Launches
    if (v === "marina" || /\b(marina|boat launch|yacht club|boat ramp)\b/i.test(str)) {
      return { emoji: "⛵", bg: "#0284c7", label: "Marina" };
    }
    // 4. Beaches & Coastline
    if (v === "beach" || /\b(beach|beaches|seashore|shoreline|cove|golden gardens|alki beach|madison park beach)\b/i.test(str)) {
      return { emoji: "🏖️", bg: "#d97706", label: "Beach" };
    }
    // 5. Aquariums
    if (v === "aquarium" || /\b(aquarium|oceanarium)\b/i.test(str)) {
      return { emoji: "🐠", bg: "#0284c7", label: "Aquarium" };
    }
    // 6. Zoos
    if (v === "zoo" || /\b(zoo|zoological|woodland park zoo|safari)\b/i.test(str)) {
      return { emoji: "🦁", bg: "#15803d", label: "Zoo" };
    }
    // 7. Dog Parks
    if (v === "dog_park" || /\b(dog park|off-leash|dog area)\b/i.test(str)) {
      return { emoji: "🐕", bg: "#10b981", label: "Dog Park" };
    }
    // 8. Golf Courses
    if (v === "golf_course" || /\b(golf course|golf club|driving range|golf links)\b/i.test(str)) {
      return { emoji: "⛳", bg: "#15803d", label: "Golf Course" };
    }
    // 9. Lakes, Rivers, Bays & Water Bodies
    if (k === "water" || k === "waterway" || v === "lake" || v === "water" || v === "river" || v === "bay" || /\b(lake|pond|river|canal|creek|sound|bay\b|reservoir|lake washington|lake union|green lake|puget sound|elliott bay)\b/i.test(str)) {
      return { emoji: "🌊", bg: "#0891b2", label: "Lake / Water" };
    }
    // 10. Hospitals & Medical Centers
    if (v === "hospital" || v === "clinic" || v === "doctors" || v === "urgent_care" || /\b(hospital|medical center|medical centre|clinic|urgent care|emergency room|swedish|harborview|virginia mason|kaiser permanente|children\x27s hospital|uw medical|polyclinic)\b/i.test(str)) {
      return { emoji: "🏥", bg: "#e11d48", label: "Hospital / Medical" };
    }
    // 11. Universities & Colleges
    if (v === "university" || v === "college" || /\b(university|college|campus|uw\b|u-district|seattle university|seattle u\b|spu\b|seattle pacific|bellevue college)\b/i.test(str)) {
      return { emoji: "🎓", bg: "#4f46e5", label: "University" };
    }
    // 12. Schools & Academies
    if (v === "school" || v === "kindergarten" || /\b(high school|middle school|elementary|school\b|academy|prep\b|preschool|daycare|kindergarten)\b/i.test(str)) {
      return { emoji: "🏫", bg: "#2563eb", label: "School" };
    }
    // 13. Stadiums & Arenas
    if (v === "stadium" || v === "arena" || v === "sports_centre" || /\b(stadium|arena|ballpark|coliseum|lumen field|t-mobile park|climate pledge|husky stadium)\b/i.test(str)) {
      return { emoji: "🏟️", bg: "#ea580c", label: "Stadium / Arena" };
    }
    // 14. Parks, Gardens & Nature
    if (v === "park" || v === "garden" || v === "nature_reserve" || v === "playground" || /\b(park|parks|garden|gardens|arboretum|preserve|greenbelt|cemetery|shelterhouse|gatehouse|cal anderson|discovery park|volunteer park|seward park|gas works)\b/i.test(str)) {
      return { emoji: "🌳", bg: "#059669", label: "Park" };
    }
    // 15. Campgrounds
    if (v === "camp_site" || /\b(campground|campsite|camping)\b/i.test(str)) {
      return { emoji: "⛺", bg: "#b45309", label: "Campground" };
    }
    // 16. Libraries
    if (v === "library" || /\b(library|libraries|spl\b|kcls\b)\b/i.test(str)) {
      return { emoji: "📚", bg: "#0f766e", label: "Library" };
    }
    // 17. Museums & Science Centers
    if (v === "museum" || v === "gallery" || /\b(museum|art gallery|gallery|mopop|seattle art museum|pacific science center|chihuly|mohai|burke museum)\b/i.test(str)) {
      return { emoji: "🏛️", bg: "#7c3aed", label: "Museum" };
    }
    // 18. Theaters & Performance Arts
    if (v === "theatre" || v === "cinema" || /\b(theater|theatre|cinema|playhouse|opera|symphony|benaroya|paramount|5th avenue|cinerama|siff\b)\b/i.test(str)) {
      return { emoji: "🎭", bg: "#9333ea", label: "Theater / Arts" };
    }
    // 19. Music Venues
    if (v === "nightclub" || /\b(music hall|showbox|neumos|jazz alley|ballroom)\b/i.test(str)) {
      return { emoji: "🎵", bg: "#8b5cf6", label: "Music Venue" };
    }
    // 20. Observation Towers, Bridges & Peaks
    if (/\b(space needle|smith tower|columbia center|tower)\b/i.test(str) || v === "tower") {
      return { emoji: "🗼", bg: "#d97706", label: "Landmark / Tower" };
    }
    if (/\b(bridge|viaduct)\b/i.test(str) || v === "bridge") {
      return { emoji: "🌉", bg: "#0284c7", label: "Bridge" };
    }
    if (v === "viewpoint" || v === "peak" || /\b(viewpoint|lookout|overlook|mountain|summit|peak)\b/i.test(str)) {
      return { emoji: "⛰️", bg: "#b45309", label: "Viewpoint" };
    }
    // 21. Markets & Shopping
    if (k === "shop" || v === "marketplace" || v === "mall" || v === "supermarket" || /\b(market|marketplace|pike place|mall|grocery|safeway|qfc|trader joe|whole foods|costco|target|h mart|uwajimaya)\b/i.test(str)) {
      return { emoji: "🛍️", bg: "#db2777", label: "Market / Shopping" };
    }
    // 22. Hotels & Lodging
    if (v === "hotel" || v === "motel" || v === "hostel" || /\b(hotel|motel|inn\b|hostel|resort|marriott|hilton|hyatt|sheraton|westin)\b/i.test(str)) {
      return { emoji: "🏨", bg: "#3b82f6", label: "Hotel" };
    }
    // 23. Coffee & Bakeries
    if (v === "cafe" || v === "bakery" || /\b(coffee|cafe|café|espresso|roaster|roastery|bakery|bakehouse|starbucks)\b/i.test(str)) {
      return { emoji: "☕", bg: "#b45309", label: "Coffee / Cafe" };
    }
    // 24. Restaurants & Dining
    if (v === "restaurant" || v === "bar" || v === "pub" || /\b(restaurant|grill|bistro|brewery|pub\b|tavern|pizzeria|sushi|diner)\b/i.test(str)) {
      return { emoji: "🍽️", bg: "#c2410c", label: "Restaurant" };
    }
    // 25. Post Office
    if (v === "post_office" || /\b(post office|usps|fedex|ups store)\b/i.test(str)) {
      return { emoji: "📮", bg: "#0284c7", label: "Post Office" };
    }
    // 26. Places of Worship
    if (v === "place_of_worship" || /\b(church|cathedral|temple|mosque|synagogue|chapel|parish)\b/i.test(str)) {
      return { emoji: "⛪", bg: "#7e22ce", label: "Place of Worship" };
    }
    // 27. Civic / Government
    if (v === "townhall" || v === "courthouse" || v === "police" || v === "fire_station" || /\b(city hall|courthouse|justice center|convention center|police|fire station)\b/i.test(str)) {
      return { emoji: "🏛️", bg: "#475569", label: "Civic / Government" };
    }
    // 28. Pharmacy
    if (v === "pharmacy" || /\b(pharmacy|drugstore|walgreens|cvs|bartell)\b/i.test(str)) {
      return { emoji: "💊", bg: "#059669", label: "Pharmacy" };
    }
    // 29. Bank
    if (v === "bank" || /\b(bank|credit union|chase|wells fargo|becu)\b/i.test(str)) {
      return { emoji: "🏦", bg: "#047857", label: "Bank" };
    }
    // 30. Stations & Transit
    if (p.kind === "station" || v === "station" || /\b(station|link light rail|sounder|amtrak)\b/i.test(str)) {
      return { emoji: "🚆", bg: "#059669", label: "Transit Station" };
    }
    if (p.kind === "stop") {
      return { emoji: "🚌", bg: "#2563eb", label: "Bus Stop" };
    }
    if (p.kind === "pr") {
      return { emoji: "🅿️", bg: "#0284c7", label: "Park & Ride" };
    }
    if (p.kind === "trail") {
      return { emoji: "🚲", bg: "#059669", label: "Trail / Bike" };
    }
    // 31. Residential / Street Address
    if (v === "house" || v === "building" || k === "building" || /\b\d+\s+[A-Za-z0-9\s]+(st|ave|blvd|rd|way|dr|ct|pl|lane|street|avenue|boulevard|road|drive)\b/i.test(str)) {
      return { emoji: "🏠", bg: "#2563eb", label: "Address" };
    }
    return { emoji: "📍", bg: "#007aff", label: "Location" };
  }

  function showPlaceCard(place) {
    if (!place || typeof place.lat !== "number" || typeof place.lon !== "number") return;
    selected = null;
    corridorRoutes = [];
    closePopup();
    clearPlaceMarker();
    rebuild();
    applySelectionStyle();
    showRouteStops(null);

    const badge = place.badge || getPlaceBadge(place);

    const el = document.createElement("div");
    el.className = "place-pin-marker";
    const markerIcon = poiIconSVG(badge.iconKind || poiKindFromBadge(badge), 12);
    el.innerHTML = `<svg width="36" height="46" viewBox="0 0 24 32" fill="none"><filter id="pin-shd" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.35"/></filter><path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 20 12 20s12-11 12-20c0-6.627-5.373-12-12-12z" fill="${badge.bg}" filter="url(#pin-shd)"/><circle cx="12" cy="11" r="5.5" fill="#ffffff"/><foreignObject x="6" y="5" width="12" height="12"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;color:${badge.bg};width:12px;height:12px">${markerIcon}</div></foreignObject></svg>`;
    placeMarker = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([place.lon, place.lat])
      .addTo(map);

    el.addEventListener("click", () => showPlaceCard(place));

    map.flyTo({
      center: [place.lon, place.lat],
      zoom: Math.max(map.getZoom(), 16),
      padding: fitPadding(),
      duration: 800
    });

    const nearby = findNearbyStops(place.lat, place.lon, 500);
    const nearbyRouteIds = new Set();
    for (const nb of nearby) {
      for (const rid of (nb.stop.routes || [])) {
        nearbyRouteIds.add(rid);
      }
    }
    const routes = [...nearbyRouteIds].map((rid) => RBY[rid]).filter(Boolean).sort(tagOrder);

    const placeTitle = place.name;
    const placeSubtitle = place.desc ? `${place.desc} · ${badge.label}` : badge.label;

    let html = `${backBtn}
      <div class="hero stop-hero" style="cursor:default">
        <span class="stop-glyph big" style="background:${badge.bg};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:20px" aria-hidden="true">${poiIconSVG(badge.iconKind || poiKindFromBadge(badge), 18)}</span>
        <div>
          <h2>${esc(placeTitle)}</h2>
          <p>${esc(placeSubtitle)}</p>
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="action-btn share-btn press" id="placeShareBtn" aria-label="Share location">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span>Share</span>
        </button>
      </div>
      ${directionsHTML(place.lat, place.lon, place.name)}`;

    if (routes.length) {
      html += `<h3 class="section" style="margin-top:16px">${routes.length} transit route${routes.length === 1 ? "" : "s"} within walking distance</h3>${routeRows(routes)}`;
    } else {
      html += `<div class="empty" style="padding:16px;font-size:13px">No frequent transit stops within 500 meters of this address. Tap “Plan Trip Here” above to find transit connections across Puget Sound.</div>`;
    }

    setView(html);
    openSheet("half");

    $("#back")?.addEventListener("click", () => {
      clearPlaceMarker();
      panelView = "home";
      showHome();
    });

    $("#placeShareBtn")?.addEventListener("click", () => {
      const q = encodeURIComponent(`${place.lat},${place.lon}`);
      shareTarget({
        title: `${place.name} - Seattle Transit Map`,
        text: `Seattle Transit Map location: ${place.name}`,
        url: `https://www.google.com/maps/search/?api=1&query=${q}`
      });
    });

    for (const b of body().querySelectorAll("[data-route]")) {
      b.addEventListener("click", () => selectRoute(b.dataset.route));
      previewOnHover(b);
    }
  }

  let searchDebounceTimer = null;
  let currentSearchResults = [];
  let activeSearchIdx = -1;

  function setupSearch() {
    const input = $("#q"), box = $("#results");

    const renderResults = (transitItems, addressItems = [], isGeocoding = false) => {
      currentSearchResults = [...transitItems, ...addressItems];
      if (!currentSearchResults.length) {
        if (isGeocoding) {
          box.innerHTML = `<div class="empty" style="color:var(--muted)">Searching transit & addresses for “${esc(input.value.trim())}”…</div>`;
        } else {
          box.innerHTML = `<div class="empty">No routes, stops, parking, trails or addresses match “${esc(input.value.trim())}”.</div>`;
        }
        box.hidden = false;
        return;
      }
      activeSearchIdx = Math.max(0, Math.min(activeSearchIdx, currentSearchResults.length - 1));
      box.innerHTML = currentSearchResults.map((it, i) => {
        const isAct = i === activeSearchIdx;
        if (it.kind === "route") return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}">${badgeHTML(it.r)}<span class="txt"><span class="name">${esc(routeTitle(it.r))}</span><span class="desc">${esc(it.r.name)}</span></span></button>`;
        if (it.kind === "trail") {
          const p = it.f.properties;
          const icon = p.facility === "trail" ? "🚲" : p.facility === "pbl" ? "🛡️" : p.facility === "greenway" ? "🌿" : "🚲";
          const cat = p.cat_name || "Bicycle Facility";
          return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}"><span class="trail-glyph" aria-hidden="true">${icon}</span><span class="txt"><span class="name">${esc(p.name)}</span><span class="desc">${esc(cat)}${p.length_mi ? ` · ${p.length_mi} mi` : ""}${p.surface === "unpaved" ? " · Gravel" : ""}${p.region ? ` (${esc(p.region)})` : ""}</span></span></button>`;
        }
        if (it.kind === "guide") {
          return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}"><span class="trail-glyph" aria-hidden="true" style="background:#2563eb;color:#fff">${it.icon}</span><span class="txt"><span class="name">${esc(it.title)}</span><span class="desc">${esc(it.desc)}</span></span></button>`;
        }
        if (it.kind === "dest") {
          const d = it.d;
          return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}"><span class="trail-glyph poi-search-glyph" aria-hidden="true" style="background:${poiColor(d.kind)};color:#fff">${poiIconSVG(d.kind, 17)}</span><span class="txt"><span class="name">${esc(d.name)}</span><span class="desc">${esc(poiKindTitle(d.kind))} · ${esc(d.short)}</span></span></button>`;
        }
        if (it.kind === "pr") {
          const pr = it.pr;
          return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}"><span class="trail-glyph" aria-hidden="true" style="background:#007aff;color:#fff">🅿️</span><span class="txt"><span class="name">${esc(pr.name)}</span><span class="desc">${pr.stalls} stalls · ${esc(pr.bikes)}</span></span></button>`;
        }
        if (it.kind === "hill") {
          const h = it.hill;
          return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}"><span class="trail-glyph" aria-hidden="true" style="background:#f59e0b;color:#fff">⚠️</span><span class="txt"><span class="name">${esc(h.short)} <span class="incline-badge">${h.grade}</span></span><span class="desc">${esc(h.location)}</span></span></button>`;
        }
        if (it.kind === "address") {
          const p = it.place;
          const badge = p.badge || getPlaceBadge(p);
          return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}"><span class="trail-glyph poi-search-glyph" aria-hidden="true" style="background:${badge.bg};color:#fff">${poiIconSVG(badge.iconKind || poiKindFromBadge(badge), 17)}</span><span class="txt"><span class="name">${esc(p.name)}</span><span class="desc">${esc(p.desc)} · ${esc(badge.label)}</span></span></button>`;
        }
        const sub = it.kind === "station" ? "Station" : `Bus stop${it.s.code ? " #" + it.s.code : ""}`;
        return `<button type="button" class="result${isAct ? " active" : ""}" data-i="${i}"><span class="stop-glyph${it.kind === "station" ? " big" : ""}" aria-hidden="true"></span><span class="txt"><span class="name">${esc(it.s.name)}</span><span class="desc">${esc(sub)}</span></span></button>`;
      }).join("");
      box.hidden = false;
    };

    const choose = (i) => {
      const it = currentSearchResults[i];
      if (!it) return;
      box.hidden = true;
      input.value = "";
      input.blur();
      if (it.kind === "route") selectRoute(it.id);
      else if (it.kind === "guide") {
        panelView = it.view;
        if (it.view === "legend") showLegendGuide();
        else if (it.view === "through-routes") showThroughRoutesGuide();
        openSheet("half");
      }
      else if (it.kind === "dest") showDestination(it.d);
      else if (it.kind === "trail") selectTrail(it.f);
      else if (it.kind === "pr") selectPR(it.pr);
      else if (it.kind === "hill") selectHill(it.hill);
      else if (it.kind === "address") showPlaceCard(it.place);
      else selectStop(it.id);
    };

    let lastTransitItems = [];
    const onSearchInput = () => {
      const val = input.value.trim();
      if (!val) {
        box.hidden = true;
        currentSearchResults = [];
        return;
      }
      lastTransitItems = search(val);
      activeSearchIdx = lastTransitItems.length ? 0 : -1;
      const willGeocode = val.length >= 3;
      renderResults(lastTransitItems, [], willGeocode && !lastTransitItems.length);

      if (willGeocode) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(async () => {
          if (input.value.trim() !== val) return;
          const pois = await searchAddressesAndPois(val);
          if (input.value.trim() !== val) return;
          const addressItems = pois.map((p) => ({ kind: "address", place: p }));
          renderResults(lastTransitItems, addressItems, false);
        }, 220);
      }
    };

    input.addEventListener("input", onSearchInput);
    input.addEventListener("focus", () => {
      openSheet("full");
      onSearchInput();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!currentSearchResults.length) return;
        activeSearchIdx = (activeSearchIdx + (e.key === "ArrowDown" ? 1 : currentSearchResults.length - 1)) % currentSearchResults.length;
        box.querySelectorAll(".result").forEach((el, i) => el.classList.toggle("active", i === activeSearchIdx));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (currentSearchResults.length > 0) {
          choose(Math.max(0, activeSearchIdx));
        } else if (input.value.trim().length >= 3) {
          const val = input.value.trim();
          showToast("Locating address…");
          searchAddressesAndPois(val).then((pois) => {
            if (pois.length) {
              box.hidden = true;
              input.value = "";
              input.blur();
              showPlaceCard(pois[0]);
            } else {
              showToast("No matching address found");
            }
          });
        }
      } else if (e.key === "Escape") {
        box.hidden = true;
        input.blur();
      }
    });
    box.addEventListener("click", (e) => {
      const b = e.target.closest(".result");
      if (b) choose(+b.dataset.i);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search")) box.hidden = true;
    });
  }

  // ---------------------------------------------------------------- Dynamic A to B Trip Planner
  let dirOrigin = null;      // { lat, lon, name, isLocation }
  let dirDest = null;        // { lat, lon, name, isLocation }
  let currentItineraries = [];
  let selectedItinerary = null;
  let dirActiveField = null; // "orig" or "dest" or null
  let dirDebounceTimer = null;
  let plannerStopsCache = null;
  let dirTimeMode = "leave-now";
  let dirTimeValue = "";
  const PLANNER_MAX_AHEAD_MS = 48 * 60 * 60 * 1000;

  function localDateTimeValue(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function getDirPlanningTime() {
    const now = new Date();
    if (dirTimeMode === "leave-now") return { ...pacificAt(now), mode: dirTimeMode };
    const selected = new Date(dirTimeValue);
    const max = now.getTime() + PLANNER_MAX_AHEAD_MS;
    const date = Number.isFinite(selected.getTime()) ? new Date(Math.min(Math.max(selected.getTime(), now.getTime()), max)) : new Date(now.getTime() + 15 * 60000);
    return { ...pacificAt(date), mode: dirTimeMode };
  }

  function plannerTimeLabel(context = getDirPlanningTime()) {
    if (context.mode === "leave-now") return "Leaving now";
    const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }).format(context.date);
    return `${context.mode === "arrive-by" ? "Arrive by" : "Depart at"} ${when}`;
  }

  function syncDirTimeControls() {
    const now = new Date();
    const input = $("#dirTimeInput");
    const wrap = $("#dirTimeInputWrap");
    const label = $("#dirTimeLabel");
    if (!dirTimeValue && dirTimeMode !== "leave-now") dirTimeValue = localDateTimeValue(new Date(now.getTime() + 15 * 60000));
    if (input) {
      input.min = localDateTimeValue(now);
      input.max = localDateTimeValue(new Date(now.getTime() + PLANNER_MAX_AHEAD_MS));
      input.value = dirTimeValue || localDateTimeValue(new Date(now.getTime() + 15 * 60000));
    }
    if (wrap) wrap.hidden = dirTimeMode === "leave-now";
    if (label) label.textContent = dirTimeMode === "arrive-by" ? "Arrive by" : "Depart at";
    for (const button of document.querySelectorAll("[data-plan-time]")) {
      button.classList.toggle("is-active", button.dataset.planTime === dirTimeMode);
      button.setAttribute("aria-pressed", button.dataset.planTime === dirTimeMode ? "true" : "false");
    }
  }

  function distMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getPlannerStops() {
    if (plannerStopsCache) return plannerStopsCache;
    plannerStopsCache = [];
    const seen = new Set();
    for (const s of (STOPS?.stations || [])) {
      if (!seen.has(s.id)) { seen.add(s.id); plannerStopsCache.push({ ...s, isStation: true }); }
    }
    for (const s of (STOPS?.stops || [])) {
      if (!seen.has(s.id)) { seen.add(s.id); plannerStopsCache.push(s); }
    }
    return plannerStopsCache;
  }

  let stopToStationCache = null;
  function getStopToStation() {
    if (stopToStationCache) return stopToStationCache;
    stopToStationCache = new Map();
    for (const st of (STOPS?.stations || [])) {
      stopToStationCache.set(st.id, st);
      for (const sid of (st.stops || [])) stopToStationCache.set(sid, st);
    }
    return stopToStationCache;
  }

  let routeEdgesCache = null;
  function getEdgesForRoute(ridx) {
    if (!NET || !NET.edges) return [];
    if (!routeEdgesCache) {
      routeEdgesCache = new Map();
      for (let k = 0; k < NET.edges.length; k++) {
        const e = NET.edges[k];
        for (const r of (e.l || [])) {
          if (!routeEdgesCache.has(r)) routeEdgesCache.set(r, []);
          routeEdgesCache.get(r).push(e);
        }
      }
    }
    return routeEdgesCache.get(ridx) || [];
  }

  function findNearestEdgePt(edges, lon, lat) {
    let bestE = null, bestIdx = 0, bestD = Infinity;
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      for (let i = 0; i < e.c.length; i++) {
        const d = distMeters(lat, lon, e.c[i][1], e.c[i][0]);
        if (d < bestD) {
          bestD = d;
          bestE = e;
          bestIdx = i;
        }
      }
    }
    return { edge: bestE, idx: bestIdx, dist: bestD };
  }

  function getRouteSegmentGeometry(routeIdx, boardStop, alightStop, intermediateStopIds = []) {
    if (routeIdx == null || !boardStop || !alightStop) return [];
    const edges = getEdgesForRoute(routeIdx);
    if (!edges.length) {
      const coords = [[boardStop.lon, boardStop.lat]];
      for (const sid of intermediateStopIds) {
        const s = stopIndex[sid];
        if (s) coords.push([s.lon, s.lat]);
      }
      coords.push([alightStop.lon, alightStop.lat]);
      return coords;
    }

    const bNear = findNearestEdgePt(edges, boardStop.lon, boardStop.lat);
    const aNear = findNearestEdgePt(edges, alightStop.lon, alightStop.lat);
    if (!bNear.edge || !aNear.edge) {
      const coords = [[boardStop.lon, boardStop.lat]];
      for (const sid of intermediateStopIds) {
        const s = stopIndex[sid];
        if (s) coords.push([s.lon, s.lat]);
      }
      coords.push([alightStop.lon, alightStop.lat]);
      return coords;
    }

    const polyLen = (pts) => {
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        len += distMeters(pts[i][1], pts[i][0], pts[i + 1][1], pts[i + 1][0]);
      }
      return len;
    };

    const qk = (c) => Math.round(c[0] * 100000) + "," + Math.round(c[1] * 100000);
    const adj = new Map();
    function addEdge(u, v, cost, pts) {
      if (!adj.has(u)) adj.set(u, []);
      adj.get(u).push({ to: v, cost, pts });
    }

    for (const e of edges) {
      const u = qk(e.c[0]), v = qk(e.c[e.c.length - 1]);
      const cost = polyLen(e.c);
      addEdge(u, v, cost, e.c);
      addEdge(v, u, cost, [...e.c].reverse());
    }

    const sNode = "START", tNode = "END";
    const eB = bNear.edge, iB = bNear.idx;
    const eA = aNear.edge, iA = aNear.idx;

    const ptsTo0 = [...eB.c.slice(0, iB + 1)].reverse();
    const ptsToEnd = eB.c.slice(iB);
    addEdge(sNode, qk(eB.c[0]), polyLen(ptsTo0), ptsTo0);
    addEdge(sNode, qk(eB.c[eB.c.length - 1]), polyLen(ptsToEnd), ptsToEnd);

    const ptsFrom0 = eA.c.slice(0, iA + 1);
    const ptsFromEnd = [...eA.c.slice(iA)].reverse();
    addEdge(qk(eA.c[0]), tNode, polyLen(ptsFrom0), ptsFrom0);
    addEdge(qk(eA.c[eA.c.length - 1]), tNode, polyLen(ptsFromEnd), ptsFromEnd);

    if (eB === eA) {
      const directPts = iB <= iA ? eB.c.slice(iB, iA + 1) : [...eB.c.slice(iA, iB + 1)].reverse();
      addEdge(sNode, tNode, polyLen(directPts), directPts);
      addEdge(tNode, sNode, polyLen(directPts), [...directPts].reverse());
    }

    const dist = new Map(), prev = new Map();
    dist.set(sNode, 0);
    const pq = [[0, sNode]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();
      if (u === tNode) break;
      if (d > dist.get(u)) continue;
      for (const edge of (adj.get(u) || [])) {
        const nd = d + edge.cost;
        if (!dist.has(edge.to) || nd < dist.get(edge.to)) {
          dist.set(edge.to, nd);
          prev.set(edge.to, { from: u, pts: edge.pts });
          pq.push([nd, edge.to]);
        }
      }
    }

    if (prev.has(tNode)) {
      let path = [];
      let cur = tNode;
      while (cur !== sNode) {
        const p = prev.get(cur);
        path = [...p.pts, ...(path.length ? path.slice(1) : [])];
        cur = p.from;
      }
      const raw = [[boardStop.lon, boardStop.lat], ...path, [alightStop.lon, alightStop.lat]];
      const out = [];
      for (let i = 0; i < raw.length; i++) {
        if (!i || Math.hypot(raw[i][0] - out[out.length - 1][0], raw[i][1] - out[out.length - 1][1]) > 1e-7) {
          out.push(raw[i]);
        }
      }
      return out;
    }

    const coords = [[boardStop.lon, boardStop.lat]];
    for (const sid of intermediateStopIds) {
      const s = stopIndex[sid];
      if (s) coords.push([s.lon, s.lat]);
    }
    coords.push([alightStop.lon, alightStop.lat]);
    return coords;
  }

  function findNearbyStops(lat, lon, maxDist = 850, maxRailDist = 1500) {
    const stops = getPlannerStops();
    const res = [];
    for (const s of stops) {
      const isRail = s.isStation || (s.routes || []).some((rid) => {
        const r = RBY[rid];
        return r && (r.cat === "link" || r.cat === "sounder" || r.cat === "streetcar" || r.cat === "ferry");
      });
      const limit = isRail ? maxRailDist : maxDist;
      const d = distMeters(lat, lon, s.lat, s.lon);
      if (d <= limit) res.push({ stop: s, dist: d, isRail });
    }
    res.sort((a, b) => a.dist - b.dist);
    return res;
  }

  // Look up actual timetable departure, arrival, and ride duration for a trip between boardStop and alightStop
  function timetableTripTimes(route, boardStop, alightStop, earliestSec, day, prevDay, planningTime = pacificNow()) {
    if (!SCHED || !DEP || !route || !boardStop || !alightStop) return null;
    const bKeys = [...new Set([boardStop.key, boardStop.id, ...((boardStop.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))])].filter(Boolean);
    const aKeys = new Set([...new Set([alightStop.key, alightStop.id, ...((alightStop.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))])].filter(Boolean));

    let best = null;
    for (const bk of bKeys) {
      for (const [pi, i] of DEP.get(bk) || []) {
        const p = SCHED.patterns[pi];
        if (!p || !p.f || i >= p.f.length - 1) continue;
        const pRoute = ROUTES[p.r];
        if (!pRoute || pRoute.id !== route.id) continue;

        let j = -1;
        for (let k = i + 1; k < p.s.length; k++) {
          const sid = p.s[k];
          const st = stopIndex[sid];
          if (aKeys.has(sid) || (st && aKeys.has(st.key))) {
            j = k;
            break;
          }
        }
        if (j <= i) continue; // Must visit alight stop after board stop!

        for (const [dayName, off] of [[day, 0], [prevDay, 86400]]) {
          for (const [s0, du] of (SCHED.byPat[dayName] && SCHED.byPat[dayName].get(pi)) || []) {
            const depTimeSec = s0 + p.f[i] * du - off;
            if (depTimeSec >= earliestSec - 30) {
              const arrTimeSec = s0 + p.f[j] * du - off;
              const rideSec = Math.max(60, arrTimeSec - depTimeSec);
              if (!best || depTimeSec < best.depSec) {
                best = {
                  pi,
                  pattern: p,
                  depSec: depTimeSec,
                  arrSec: arrTimeSec,
                  rideSec,
                  rideMin: Math.max(1, Math.round(rideSec / 60)),
                  waitMin: Math.max(0, Math.round((depTimeSec - earliestSec) / 60)),
                  clock: CLOCK.format(new Date((planningTime.date instanceof Date ? planningTime.date.getTime() : Date.now()) + (depTimeSec - planningTime.secs) * 1000)),
                };
              }
            }
          }
        }
      }
    }
    return best;
  }

  // The quick direct/one-transfer search below is useful for the common case.
  // Regional trips need more than that, though: a bus to a ferry and a local
  // shuttle on the other shore is two transfers.  Build a small, cached view of
  // the all-mode network so the bounded connection search can use every route
  // category without turning a trip request into an all-pairs scan.
  let plannerNetworkCache = null;
  function getPlannerNetwork() {
    if (plannerNetworkCache) return plannerNetworkCache;
    const stopsById = new Map();
    for (const stop of getPlannerStops()) if (stop && stop.id && !stopsById.has(stop.id)) stopsById.set(stop.id, stop);

    const cellSize = 0.0035; // roughly 390 m north/south in the map's service area
    const cellKey = (lat, lon) => `${Math.floor(lat / cellSize)},${Math.floor(lon / cellSize)}`;
    const cells = new Map();
    for (const stop of stopsById.values()) {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
      const key = cellKey(stop.lat, stop.lon);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(stop);
    }

    const atStop = new Map();
    const addAtStop = (sid, entry) => {
      if (!sid) return;
      if (!atStop.has(sid)) atStop.set(sid, []);
      atStop.get(sid).push(entry);
      const keyed = stopIndex[sid] && stopIndex[sid].key;
      if (keyed && keyed !== sid) {
        if (!atStop.has(keyed)) atStop.set(keyed, []);
        atStop.get(keyed).push(entry);
      }
    };
    for (const route of ROUTES) {
      for (const pattern of (route.patterns || [])) {
        for (let index = 0; index < pattern.stops.length; index++) {
          addAtStop(pattern.stops[index], { route, pattern, index });
        }
      }
    }

    plannerNetworkCache = { stopsById, cellSize, cellKey, cells, atStop, transferCache: new Map(), routeNeighbors: null };
    return plannerNetworkCache;
  }

  function transferBoardsFrom(stop) {
    const net = getPlannerNetwork();
    const source = stop && (stopIndex[stop.id] || net.stopsById.get(stop.id) || stop);
    if (!source || !source.id || !Number.isFinite(source.lat) || !Number.isFinite(source.lon)) return [];
    if (net.transferCache.has(source.id)) return net.transferCache.get(source.id);

    const result = new Map();
    const add = (candidate, dist) => {
      if (!candidate || !candidate.id || !Number.isFinite(dist) || dist > 360) return;
      const old = result.get(candidate.id);
      if (!old || dist < old.dist) result.set(candidate.id, { stop: candidate, dist });
    };
    add(source, 0);

    const station = getStopToStation().get(source.id);
    if (station) {
      for (const sid of (station.stops || [])) add(stopIndex[sid] || net.stopsById.get(sid), sid === source.id ? 0 : 50);
    }

    const cx = Math.floor(source.lat / net.cellSize), cy = Math.floor(source.lon / net.cellSize);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (const candidate of net.cells.get(`${cx + dx},${cy + dy}`) || []) {
          add(candidate, distMeters(source.lat, source.lon, candidate.lat, candidate.lon));
        }
      }
    }
    const out = [...result.values()];
    net.transferCache.set(source.id, out);
    return out;
  }

  function boardEntriesFor(stop) {
    const net = getPlannerNetwork();
    const found = new Map();
    const keys = new Set([stop && stop.id, stop && stop.key, ...((stop && stop.stops) || [])]);
    for (const key of keys) {
      for (const entry of net.atStop.get(key) || []) {
        found.set(`${entry.route.id}|${entry.pattern.dir || ""}|${entry.index}|${entry.pattern.stops[0]}`, entry);
      }
    }
    return [...found.values()];
  }

  function routeConnections() {
    const net = getPlannerNetwork();
    if (net.routeNeighbors) return net.routeNeighbors;
    const links = new Map();
    const link = (from, to) => {
      if (!from || !to || from === to) return;
      if (!links.has(from)) links.set(from, new Set());
      links.get(from).add(to);
    };
    for (const [sid, entries] of net.atStop) {
      const source = stopIndex[sid] || net.stopsById.get(sid);
      if (!source) continue;
      const fromRoutes = new Set(entries.map((entry) => entry.route.id));
      for (const option of transferBoardsFrom(source)) {
        const toEntries = boardEntriesFor(option.stop);
        for (const from of fromRoutes) for (const entry of toEntries) {
          link(from, entry.route.id);
          link(entry.route.id, from);
        }
      }
    }
    net.routeNeighbors = links;
    return links;
  }

  function routeHopsTo(destRoutes, maxTransfers) {
    const links = routeConnections();
    const hops = new Map();
    const queue = [];
    for (const routeId of destRoutes) { hops.set(routeId, 0); queue.push(routeId); }
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const routeId = queue[cursor], distance = hops.get(routeId);
      if (distance >= maxTransfers) continue;
      for (const next of links.get(routeId) || []) {
        if (!hops.has(next)) { hops.set(next, distance + 1); queue.push(next); }
      }
    }
    return hops;
  }

  function estimatedRideMinutes(route, boardStop, alightStop, numStops) {
    const rail = route.cat === "link" || route.cat === "sounder" || route.cat === "amtrak";
    const speed = rail ? 750 : route.cat === "ferry" || route.cat === "watertaxi" ? 500 : 380;
    return Math.max(2, Math.round(distMeters(boardStop.lat, boardStop.lon, alightStop.lat, alightStop.lon) / speed) + Math.round(numStops * (rail ? 0.3 : 0.35)));
  }

  // A time-aware, bounded (four vehicles / three transfers) search.  It is
  // deliberately separate from the fast one-transfer results so short trips
  // keep their familiar compact choices while regional, cross-water trips are
  // still found and rendered as complete itineraries.
  function planMultiLegTrips(origStops, destStops, origStopMap, destStopMap, nowSecs, day, prev, planningTime) {
    const MAX_LEGS = 4;
    const MAX_STATES = 520;
    const destRoutes = new Set();
    for (const item of destStops) for (const routeId of (item.stop.routes || [])) destRoutes.add(routeId);
    if (!destRoutes.size) return [];

    const hops = routeHopsTo(destRoutes, MAX_LEGS - 1);
    const queue = [];
    for (const item of origStops) {
      const stop = item.stop;
      if (!boardEntriesFor(stop).some((entry) => hops.has(entry.route.id))) continue;
      queue.push({ atStop: stop, arrSec: nowSecs + Math.round(item.dist / 80) * 60, totalDuration: Math.round(item.dist / 80), walk1Dist: item.dist, walk1Time: Math.round(item.dist / 80), legs: [], schedVerified: true });
    }

    const bestAt = new Map();
    const found = [];
    let explored = 0;
    while (queue.length && explored++ < MAX_STATES) {
      queue.sort((a, b) => a.arrSec - b.arrSec);
      const state = queue.shift();
      const prior = state.legs[state.legs.length - 1];
      const boardOptions = prior ? transferBoardsFrom(state.atStop) : [{ stop: state.atStop, dist: 0 }];

      for (const boardOption of boardOptions) {
        const boardStop = boardOption.stop;
        const transferWalkTime = prior ? Math.max(1, Math.round(boardOption.dist / 80)) : 0;
        const earliestSec = prior ? state.arrSec + boardOption.dist / 80 * 60 + 120 : state.arrSec;
        for (const entry of boardEntriesFor(boardStop)) {
          const route = entry.route, pattern = entry.pattern, from = entry.index;
          if (prior && prior.route.id === route.id) continue;
          const routeHops = hops.get(route.id);
          const legCount = state.legs.length + 1;
          if (routeHops == null || routeHops > MAX_LEGS - legCount || from >= pattern.stops.length - 1) continue;

          const targets = [];
          for (let to = from + 1; to < pattern.stops.length; to++) {
            const sid = pattern.stops[to], alightStop = stopIndex[sid];
            if (!alightStop) continue;
            const destination = destStopMap.get(sid);
            if (destination) {
              targets.push({ to, alightStop, destination });
              continue;
            }
            if (legCount >= MAX_LEGS || routeHops <= 0) continue;
            const canContinue = transferBoardsFrom(alightStop).some((option) =>
              boardEntriesFor(option.stop).some((next) => next.route.id !== route.id && (hops.get(next.route.id) ?? Infinity) < routeHops)
            );
            if (canContinue) targets.push({ to, alightStop, destination: null });
          }

          // A pattern can pass many equivalent transfer bays.  Keeping the
          // first dozen preserves meaningful alternatives without flooding the
          // bounded search with the same connection over and over.
          for (const target of targets.slice(0, 12)) {
            const numStops = target.to - from;
            const scheduled = timetableTripTimes(route, boardStop, target.alightStop, earliestSec, day, prev, planningTime);
            let waitTime, rideTime, arrSec, schedVerified = state.schedVerified;
            if (scheduled) {
              waitTime = prior ? Math.max(2, Math.round((scheduled.depSec - state.arrSec - boardOption.dist / 80 * 60) / 60)) : scheduled.waitMin;
              if (prior && (waitTime < 2 || waitTime > 60)) continue;
              rideTime = scheduled.rideMin;
              arrSec = scheduled.arrSec;
            } else {
              const hasServiceToday = route.sched && route.sched[day] && route.sched[day].trips > 0;
              if (SCHED && !hasServiceToday) continue;
              const headway = route.midHeadway || route.sched?.[day]?.mid || route.sched?.weekday?.mid || (route.cat === "link" ? 8 : 15);
              waitTime = prior ? Math.max(2, Math.round(Math.min(headway / 2, route.cat === "ferry" ? 45 : 12))) : Math.round(Math.min(headway / 2, route.cat === "ferry" ? 45 : 12));
              rideTime = estimatedRideMinutes(route, boardStop, target.alightStop, numStops);
              arrSec = earliestSec + (waitTime + rideTime) * 60;
              schedVerified = false;
            }

            const leg = {
              route, pattern, boardStop, alightStop: target.alightStop,
              intermediateStopIds: pattern.stops.slice(from + 1, target.to), numStops,
              rideTime, waitTime, schedTrip: scheduled,
              transferWalkDist: prior ? boardOption.dist : 0,
              transferWalkTime,
            };
            const totalDuration = state.totalDuration + (prior ? transferWalkTime : 0) + waitTime + rideTime;
            const legs = [...state.legs, leg];
            if (target.destination) {
              if (legs.length < 3) continue;
              const walk2Time = Math.round(target.destination.dist / 80);
              found.push({
                type: "multi", legs, boardStop: legs[0].boardStop, alightStop: target.alightStop,
                walk1Dist: state.walk1Dist, walk1Time: state.walk1Time,
                walk2Dist: target.destination.dist, walk2Time,
                totalDuration: totalDuration + walk2Time,
                schedTrip: legs[0].schedTrip, schedVerified,
              });
              continue;
            }
            if (legs.length >= MAX_LEGS) continue;
            const key = `${target.alightStop.id}|${route.id}|${legs.length}`;
            if (bestAt.has(key) && bestAt.get(key) <= arrSec) continue;
            bestAt.set(key, arrSec);
            queue.push({ atStop: target.alightStop, arrSec, totalDuration, walk1Dist: state.walk1Dist, walk1Time: state.walk1Time, legs, schedVerified });
          }
        }
      }
    }

    const seen = new Set();
    return found.sort((a, b) => a.totalDuration - b.totalDuration).filter((it) => {
      const key = it.legs.map((leg) => leg.route.id).join(">");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4);
  }

  function planTransitTrip(orig, dest, planningTime = pacificNow()) {
    if (!orig || !dest) return null;
    const directWalkDist = distMeters(orig.lat, orig.lon, dest.lat, dest.lon);
    const directWalkTime = Math.round(directWalkDist / 80);

    let origStops = findNearbyStops(orig.lat, orig.lon, 950, 1500);
    if (origStops.length < 3) origStops = findNearbyStops(orig.lat, orig.lon, 1800, 2200);

    let destStops = findNearbyStops(dest.lat, dest.lon, 950, 1500);
    if (destStops.length < 3) destStops = findNearbyStops(dest.lat, dest.lon, 1800, 2200);

    const origStopMap = new Map();
    for (const o of origStops) {
      if (!origStopMap.has(o.stop.id)) origStopMap.set(o.stop.id, o);
      for (const sid of (o.stop.stops || [])) {
        if (!origStopMap.has(sid)) origStopMap.set(sid, o);
      }
    }

    const destStopMap = new Map();
    for (const d of destStops) {
      if (!destStopMap.has(d.stop.id)) destStopMap.set(d.stop.id, d);
      for (const sid of (d.stop.stops || [])) {
        if (!destStopMap.has(sid)) destStopMap.set(sid, d);
      }
    }

    const { day, prev } = planningTime;
    const nowSecs = planningTime.secs;
    const directItineraries = [];

    for (const r of ROUTES) {
      if (LINEIDX[r.id] == null) continue;
      for (const pat of (r.patterns || [])) {
        const stops = pat.stops;
        let bestPair = null;
        let minTotal = Infinity;

        for (let i = 0; i < stops.length; i++) {
          const sid1 = stops[i];
          const oMatch = origStopMap.get(sid1);
          if (!oMatch) continue;
          for (let j = i + 1; j < stops.length; j++) {
            const sid2 = stops[j];
            const dMatch = destStopMap.get(sid2);
            if (!dMatch) continue;

            const bStop = stopIndex[sid1] || oMatch.stop;
            const aStop = stopIndex[sid2] || dMatch.stop;
            if (!bStop || !aStop) continue;
            const transitDist = distMeters(bStop.lat, bStop.lon, aStop.lat, aStop.lon);
            const isRail = r.cat === "link" || r.cat === "sounder";
            const speedMpm = isRail ? 750 : r.cat === "ferry" ? 500 : 380;
            const numStops = j - i;
            const rideTime = Math.max(2, Math.round(transitDist / speedMpm) + Math.round(numStops * (isRail ? 0.3 : 0.4)));
            const walk1Time = Math.round(oMatch.dist / 80);
            const walk2Time = Math.round(dMatch.dist / 80);
            const total = walk1Time + rideTime + walk2Time - (isRail ? 3 : 0);

            if (total < minTotal) {
              minTotal = total;
              bestPair = {
                firstOrig: i,
                bestDest: j,
                origMatch: oMatch,
                destMatch: dMatch,
                boardStop: bStop,
                alightStop: aStop,
                intermediateStopIds: pat.stops.slice(i + 1, j),
                numStops,
                rideTime,
                walk1Dist: oMatch.dist,
                walk1Time,
                walk2Dist: dMatch.dist,
                walk2Time,
                transitDist,
              };
            }
          }
        }

        if (bestPair) {
          const walk1Time = bestPair.walk1Time;
          const walk2Time = bestPair.walk2Time;
          const earliestBoardSec = nowSecs + walk1Time * 60;
          const schedTrip = timetableTripTimes(r, bestPair.boardStop, bestPair.alightStop, earliestBoardSec, day, prev, planningTime);

          let waitTime, rideTime, totalDuration, schedVerified = false;
          if (schedTrip) {
            waitTime = schedTrip.waitMin;
            rideTime = schedTrip.rideMin;
            totalDuration = walk1Time + waitTime + rideTime + walk2Time;
            schedVerified = true;
          } else {
            const hasServiceToday = r.sched && r.sched[day] && r.sched[day].trips > 0;
            if (!hasServiceToday && SCHED) continue;
            const headway = r.midHeadway || (r.sched?.weekday?.mid) || (r.cat === "link" ? 8 : 15);
            waitTime = Math.round(Math.min(headway / 2, 12));
            rideTime = bestPair.rideTime;
            totalDuration = walk1Time + waitTime + rideTime + walk2Time;
          }

          directItineraries.push({
            type: "direct",
            route: r,
            pattern: pat,
            boardStop: bestPair.boardStop,
            alightStop: bestPair.alightStop,
            intermediateStopIds: bestPair.intermediateStopIds,
            numStops: bestPair.numStops,
            walk1Dist: bestPair.walk1Dist,
            walk1Time,
            rideTime,
            walk2Dist: bestPair.walk2Dist,
            walk2Time,
            waitTime,
            totalDuration,
            schedTrip,
            schedVerified,
            planningTime,
            departSec: schedTrip ? schedTrip.depSec - walk1Time * 60 : nowSecs,
            arrivalSec: schedTrip ? schedTrip.arrSec + walk2Time * 60 : nowSecs + totalDuration * 60,
            transitDist: bestPair.transitDist,
          });
        }
      }
    }

    directItineraries.sort((a, b) => a.totalDuration - b.totalDuration);
    const seenDirect = new Set();
    const topDirect = [];
    for (const it of directItineraries) {
      if (seenDirect.has(it.route.id)) continue;
      seenDirect.add(it.route.id);
      topDirect.push(it);
      if (topDirect.length >= 3) break;
    }

    // 1-transfer routes: support multi-modal transfer hubs
    const stopToSt = getStopToStation();
    const origRoutes = new Set();
    for (const o of origStops) {
      for (const rid of (o.stop.routes || [])) origRoutes.add(rid);
    }
    const destRoutes = new Set();
    for (const d of destStops) {
      for (const rid of (d.stop.routes || [])) destRoutes.add(rid);
    }

    function transferDistance(s1Id, s2Id) {
      if (s1Id === s2Id) return 0;
      const st1 = stopToSt.get(s1Id), st2 = stopToSt.get(s2Id);
      if (st1 && st2 && st1 === st2) return 50;
      const s1 = stopIndex[s1Id], s2 = stopIndex[s2Id];
      if (!s1 || !s2) return Infinity;
      const d = distMeters(s1.lat, s1.lon, s2.lat, s2.lon);
      return d <= 360 ? d : Infinity;
    }

    const transferItineraries = [];
    for (const r1Id of origRoutes) {
      const r1 = RBY[r1Id];
      if (!r1 || LINEIDX[r1.id] == null) continue;
      for (const p1 of (r1.patterns || [])) {
        let firstOrig = -1;
        for (let i = 0; i < p1.stops.length; i++) {
          if (origStopMap.has(p1.stops[i])) { firstOrig = i; break; }
        }
        if (firstOrig === -1) continue;

        for (const r2Id of destRoutes) {
          if (r2Id === r1Id) continue;
          const r2 = RBY[r2Id];
          if (!r2 || LINEIDX[r2.id] == null) continue;
          for (const p2 of (r2.patterns || [])) {
            let lastDest = -1;
            for (let j = p2.stops.length - 1; j >= 0; j--) {
              if (destStopMap.has(p2.stops[j])) { lastDest = j; break; }
            }
            if (lastDest === -1) continue;

            for (let i = firstOrig + 1; i < p1.stops.length; i++) {
              const sid1 = p1.stops[i];
              for (let j = 0; j < lastDest; j++) {
                const sid2 = p2.stops[j];
                const tDist = transferDistance(sid1, sid2);
                if (tDist <= 360) {
                  const s1 = stopIndex[sid1], s2 = stopIndex[sid2];
                  if (!s1 || !s2) continue;
                  const origSid = p1.stops[firstOrig], destSid = p2.stops[lastDest];
                  const boardStop = stopIndex[origSid] || origStopMap.get(origSid)?.stop;
                  const alightStop = stopIndex[destSid] || destStopMap.get(destSid)?.stop;
                  if (!boardStop || !alightStop) continue;
                  const oMatch = origStopMap.get(origSid), dMatch = destStopMap.get(destSid);

                  const numStops1 = i - firstOrig;
                  const numStops2 = lastDest - j;

                  const isR1Rail = r1.cat === "link" || r1.cat === "sounder";
                  const isR2Rail = r2.cat === "link" || r2.cat === "sounder";
                  const speed1 = isR1Rail ? 750 : r1.cat === "ferry" ? 500 : 380;
                  const speed2 = isR2Rail ? 750 : r2.cat === "ferry" ? 500 : 380;

                  const d1 = distMeters(boardStop.lat, boardStop.lon, s1.lat, s1.lon);
                  const d2 = distMeters(s2.lat, s2.lon, alightStop.lat, alightStop.lon);

                  if (numStops1 < 2 && d1 < 500) continue;

                  const ride1 = Math.max(2, Math.round(d1 / speed1) + Math.round(numStops1 * (isR1Rail ? 0.3 : 0.35)));
                  const ride2 = Math.max(2, Math.round(d2 / speed2) + Math.round(numStops2 * (isR2Rail ? 0.3 : 0.35)));

                  const walk1Time = Math.round((oMatch ? oMatch.dist : 0) / 80);
                  const walk2Time = Math.round((dMatch ? dMatch.dist : 0) / 80);
                  const transferWalkTime = Math.max(1, Math.round(tDist / 80));

                  const earliestSec1 = nowSecs + walk1Time * 60;
                  const leg1 = timetableTripTimes(r1, boardStop, s1, earliestSec1, day, prev, planningTime);

                  let leg2 = null;
                  let wait1, wait2, ride1Time = ride1, ride2Time = ride2;
                  let schedVerified = false;

                  if (leg1) {
                    wait1 = leg1.waitMin;
                    ride1Time = leg1.rideMin;
                    const earliestSec2 = leg1.arrSec + transferWalkTime * 60 + 120;
                    leg2 = timetableTripTimes(r2, s2, alightStop, earliestSec2, day, prev, planningTime);
                    if (leg2) {
                      const transferWaitMin = Math.round((leg2.depSec - leg1.arrSec - transferWalkTime * 60) / 60);
                      if (transferWaitMin > 60 || transferWaitMin < 0) continue;
                      wait2 = Math.max(2, transferWaitMin);
                      ride2Time = leg2.rideMin;
                      schedVerified = true;
                    } else if (SCHED) {
                      continue; // No achievable connecting trip in timetable
                    }
                  }

                  if (!leg1 || !leg2) {
                    const hasS1 = r1.sched && r1.sched[day] && r1.sched[day].trips > 0;
                    const hasS2 = r2.sched && r2.sched[day] && r2.sched[day].trips > 0;
                    if ((!hasS1 || !hasS2) && SCHED) continue;
                    const h1 = r1.midHeadway || (r1.sched?.weekday?.mid) || (r1.cat === "link" ? 8 : 15);
                    const h2 = r2.midHeadway || (r2.sched?.weekday?.mid) || (r2.cat === "link" ? 8 : 15);
                    wait1 = Math.round(Math.min(h1 / 2, 7));
                    wait2 = Math.round(Math.min(h2 / 2, 7)) + 2 + transferWalkTime;
                  }

                  const railBonus = (isR1Rail ? 3 : 0) + (isR2Rail ? 3 : 0);
                  const totalDuration = walk1Time + wait1 + ride1Time + transferWalkTime + wait2 + ride2Time + walk2Time;

                  transferItineraries.push({
                    type: "transfer",
                    r1, r2,
                    p1, p2,
                    boardStop,
                    transferStop: s1,
                    transferStop1: s1,
                    transferStop2: s2,
                    transferWalkDist: tDist,
                    transferWalkTime,
                    alightStop,
                    intermediateStops1: p1.stops.slice(firstOrig + 1, i),
                    intermediateStops2: p2.stops.slice(j + 1, lastDest),
                    numStops1, numStops2,
                    ride1: ride1Time,
                    ride2: ride2Time,
                    walk1Time, walk2Time,
                    wait1, wait2,
                    totalDuration,
                    schedTrip1: leg1,
                    schedTrip2: leg2,
                    schedVerified,
                    planningTime,
                    departSec: leg1 ? leg1.depSec - walk1Time * 60 : nowSecs,
                    arrivalSec: leg2 ? leg2.arrSec + walk2Time * 60 : nowSecs + totalDuration * 60,
                    score: totalDuration - railBonus,
                  });
                  break;
                }
              }
            }
          }
        }
      }
    }

    transferItineraries.sort((a, b) => (a.score ?? a.totalDuration) - (b.score ?? b.totalDuration));
    const seenTransfer = new Set();
    const topTransfer = [];
    for (const it of transferItineraries) {
      const pair = it.r1.id + "->" + it.r2.id;
      if (seenTransfer.has(pair)) continue;
      seenTransfer.add(pair);
      topTransfer.push(it);
      if (topTransfer.length >= 4) break;
    }

    // Cross-water and regional trips often need two or three transfers (for
    // example, bus → ferry → Vashon shuttle).  Search those after the lighter
    // direct and one-transfer passes, with the same timetable/buffer rules.
    const multi = planMultiLegTrips(origStops, destStops, origStopMap, destStopMap, nowSecs, day, prev, planningTime);
    for (const it of multi) {
      const first = it.legs[0], last = it.legs[it.legs.length - 1];
      it.planningTime = planningTime;
      it.departSec = first?.schedTrip ? first.schedTrip.depSec - it.walk1Time * 60 : nowSecs;
      it.arrivalSec = last?.schedTrip ? last.schedTrip.arrSec + it.walk2Time * 60 : nowSecs + it.totalDuration * 60;
    }

    let directWalk = null;
    if (directWalkDist <= 2500) {
      directWalk = {
        type: "walk",
        dist: directWalkDist,
        totalDuration: directWalkTime,
        planningTime,
        departSec: nowSecs,
        arrivalSec: nowSecs + directWalkTime * 60,
      };
    }

    return { direct: topDirect, transfer: topTransfer, multi, directWalk };
  }

  function clearTripMap() {
    if (!map) return;
    const empty = { type: "FeatureCollection", features: [] };
    if (map.getSource("tripline")) map.getSource("tripline").setData(empty);
    if (map.getSource("tripwalk")) map.getSource("tripwalk").setData(empty);
    if (map.getSource("trippts")) map.getSource("trippts").setData(empty);
    setNetDim(1);
    focusOff();
    if (!(selected && selected.type === "route" && RBY[selected.id]?.cat === "dart")) {
      highlightDartArea(null);
    }
  }

  function currentVehWord(catOrRoute) {
    const cat = typeof catOrRoute === "string" ? catOrRoute : (catOrRoute && catOrRoute.cat) || "";
    if (cat === "walk") return "walk";
    if (cat === "link" || cat === "sounder" || cat === "amtrak" || cat === "monorail") return "train";
    if (cat === "ferry" || cat === "watertaxi") return "ferry";
    if (cat === "streetcar") return "streetcar";
    return "bus";
  }

  function modeIcon(catOrRoute) {
    const cat = typeof catOrRoute === "string" ? catOrRoute : (catOrRoute && catOrRoute.cat) || "";
    if (cat === "walk") return "🚶";
    if (cat === "link" || cat === "sounder" || cat === "amtrak" || cat === "monorail") return "🚆";
    if (cat === "ferry" || cat === "watertaxi") return "⛴️";
    if (cat === "streetcar") return "🚊";
    return "🚌";
  }

  function getSoonestBus(it) {
    if (!it || it.type === "walk") {
      return {
        type: "walk",
        vehWord: "walk",
        text: "Walk anytime",
        clock: "Now",
        isLive: false,
        desc: "Direct pedestrian path"
      };
    }

    const route = it.type === "direct" ? it.route : it.type === "multi" ? it.legs?.[0]?.route : it.r1;
    const stop = it.boardStop;
    if (!route || !stop) return null;

    const planningTime = it.planningTime || pacificNow();
    const isFuturePlan = planningTime.date && planningTime.date.getTime() > Date.now() + 90 * 1000;
    const sIds = stopIdsOf(stop);
    const vehWord = currentVehWord(route);
    const walk1Min = it.walk1Time || 0;
    const minEarliestSec = planningTime.secs + walk1Min * 60;

    // 1. Live departures check from agency
    const live = isFuturePlan ? [] : liveDepartures(sIds, 30);
    if (live && live.length) {
      const match = live.find((d) => d.r && (d.r.id === route.id || d.r === route) && (d.t >= walk1Min * 60 - 60));
      if (match) {
        const waitMin = Math.max(0, Math.round(match.t / 60));
        const clockTime = new Date(Date.now() + Math.max(0, match.t) * 1000);
        const clockStr = CLOCK.format(clockTime);
        const text = match.t < 60 ? "Due now" : `in ${waitMin} min`;
        const tag = match.live ? "Live GPS" : "Scheduled";
        return {
          type: "live",
          vehWord,
          isLive: !!match.live,
          mins: waitMin,
          text,
          clock: clockStr,
          routeLabel: route.short || route.label,
          desc: match.t < 60 ? `${vehWord.charAt(0).toUpperCase() + vehWord.slice(1)} due now (${tag} · ${clockStr})` : `Soonest ${vehWord} in ${waitMin} min (${tag} · ${clockStr})`
        };
      }
    }

    // 2. Timetable schedule departures check
    const schedTrip = it.schedTrip || (it.type === "transfer" && it.schedTrip1) || (it.type === "multi" && it.legs?.[0]?.schedTrip) || timetableTripTimes(route, it.boardStop, it.type === "direct" ? it.alightStop : (it.transferStop1 || it.transferStop), minEarliestSec, planningTime.day, planningTime.prev, planningTime);
    if (schedTrip) {
      const waitMin = schedTrip.waitMin;
      const clockStr = schedTrip.clock;
      const text = isFuturePlan ? "Departs" : (waitMin === 0 ? "Due now" : `in ${waitMin} min`);
      return {
        type: "sched",
        vehWord,
        isLive: false,
        mins: waitMin,
        text,
        clock: clockStr,
        routeLabel: route.short || route.label,
        desc: isFuturePlan ? `Scheduled ${vehWord} departure at ${clockStr}` : (waitMin === 0 ? `Scheduled ${vehWord} now (${clockStr})` : `Soonest ${vehWord} in ${waitMin} min (${clockStr})`)
      };
    }

    // 3. Fallback based on published route frequency
    const headway = route.midHeadway || (route.sched?.weekday?.mid) || (route.cat === "link" ? 8 : 15);
    const waitMin = Math.round(Math.min(headway / 2, 12));
    const clockTime = new Date(Date.now() + (walk1Min + waitMin) * 60000);
    const clockStr = CLOCK.format(clockTime);
    return {
      type: "approx",
      vehWord,
      isLive: false,
      mins: waitMin,
      text: `~${waitMin} min wait`,
      clock: clockStr,
      routeLabel: route.short || route.label,
      desc: `Every ~${headway} min (estimated next ~${clockStr})`
    };
  }

  function renderTripOnMap(it, { fit = false, isHover = false } = {}) {
    if (!map || !it || !dirOrigin || !dirDest) return;
    const walkFeatures = [];
    const lineFeatures = [];
    const ptFeatures = [];

    const origPt = [dirOrigin.lon, dirOrigin.lat];
    const destPt = [dirDest.lon, dirDest.lat];

    const origBadge = dirOrigin.isLocation ? { bg: "#10b981", label: "Start" } : (dirOrigin.badge || getPlaceBadge(dirOrigin));
    const destBadge = dirDest.badge || getPlaceBadge(dirDest);

    ptFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: origPt },
      properties: { role: "orig", color: origBadge.bg || "#10b981", label: origBadge.label || "Start" }
    });

    ptFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: destPt },
      properties: { role: "dest", color: destBadge.bg || "#ef4444", label: destBadge.label || "Destination" }
    });

    const allCoords = [origPt, destPt];

    if (it.type === "walk") {
      walkFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [origPt, destPt] },
        properties: { type: "walk" }
      });
      focusOff();
    } else if (it.type === "direct") {
      const boardPt = [it.boardStop.lon, it.boardStop.lat];
      const alightPt = [it.alightStop.lon, it.alightStop.lat];
      allCoords.push(boardPt, alightPt);

      walkFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [origPt, boardPt] },
        properties: { type: "walk1" }
      });
      walkFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [alightPt, destPt] },
        properties: { type: "walk2" }
      });

      ptFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: boardPt },
        properties: { role: "board", color: tagColor(it.route), label: it.route.short || it.route.label }
      });
      ptFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: alightPt },
        properties: { role: "alight", color: tagColor(it.route), label: "Exit" }
      });

      // ONLY the used transit segment glows along its actual street path
      const routeIdx = LINEIDX[it.route.id];
      const segCoords = getRouteSegmentGeometry(routeIdx, it.boardStop, it.alightStop, it.intermediateStopIds || []);
      if (segCoords.length >= 2) {
        lineFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: segCoords },
          properties: {
            color: tagColor(it.route),
            isRail: it.route.cat === "link" || it.route.cat === "sounder" ? 1 : 0
          }
        });
        for (const pt of segCoords) allCoords.push(pt);
      }
      focusOff();
    } else if (it.type === "transfer") {
      const boardPt = [it.boardStop.lon, it.boardStop.lat];
      const t1Pt = [it.transferStop1.lon, it.transferStop1.lat];
      const t2Pt = [it.transferStop2.lon, it.transferStop2.lat];
      const alightPt = [it.alightStop.lon, it.alightStop.lat];
      allCoords.push(boardPt, t1Pt, t2Pt, alightPt);

      walkFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [origPt, boardPt] },
        properties: { type: "walk1" }
      });

      if (it.transferWalkDist > 5) {
        walkFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [t1Pt, t2Pt] },
          properties: { type: "transferWalk" }
        });
      }

      walkFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [alightPt, destPt] },
        properties: { type: "walk2" }
      });

      ptFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: boardPt },
        properties: { role: "board", color: tagColor(it.r1), label: it.r1.short || it.r1.label }
      });
      ptFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: t1Pt },
        properties: { role: "transfer", color: "#8b5cf6", label: "Transfer" }
      });
      if (it.transferWalkDist > 5 && (t1Pt[0] !== t2Pt[0] || t1Pt[1] !== t2Pt[1])) {
        ptFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: t2Pt },
          properties: { role: "transfer2", color: tagColor(it.r2), label: it.r2.short || it.r2.label }
        });
      }
      ptFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: alightPt },
        properties: { role: "alight", color: tagColor(it.r2), label: "Exit" }
      });

      // ONLY the used transit segments glow along their actual street paths
      const r1Idx = LINEIDX[it.r1.id];
      const seg1Coords = getRouteSegmentGeometry(r1Idx, it.boardStop, it.transferStop1, it.intermediateStops1 || []);
      if (seg1Coords.length >= 2) {
        lineFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: seg1Coords },
          properties: {
            color: tagColor(it.r1),
            isRail: it.r1.cat === "link" || it.r1.cat === "sounder" ? 1 : 0
          }
        });
        for (const pt of seg1Coords) allCoords.push(pt);
      }

      const r2Idx = LINEIDX[it.r2.id];
      const seg2Coords = getRouteSegmentGeometry(r2Idx, it.transferStop2, it.alightStop, it.intermediateStops2 || []);
      if (seg2Coords.length >= 2) {
        lineFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: seg2Coords },
          properties: {
            color: tagColor(it.r2),
            isRail: it.r2.cat === "link" || it.r2.cat === "sounder" ? 1 : 0
          }
        });
        for (const pt of seg2Coords) allCoords.push(pt);
      }
      focusOff();
    } else if (it.type === "multi") {
      const legs = it.legs || [];
      if (!legs.length) return;
      const firstBoard = [legs[0].boardStop.lon, legs[0].boardStop.lat];
      const finalAlight = [legs[legs.length - 1].alightStop.lon, legs[legs.length - 1].alightStop.lat];
      allCoords.push(firstBoard, finalAlight);
      walkFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [origPt, firstBoard] },
        properties: { type: "walk1" }
      });
      walkFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [finalAlight, destPt] },
        properties: { type: "walk2" }
      });

      legs.forEach((leg, index) => {
        const boardPt = [leg.boardStop.lon, leg.boardStop.lat];
        const alightPt = [leg.alightStop.lon, leg.alightStop.lat];
        allCoords.push(boardPt, alightPt);
        if (index === 0) {
          ptFeatures.push({
            type: "Feature", geometry: { type: "Point", coordinates: boardPt },
            properties: { role: "board", color: tagColor(leg.route), label: leg.route.short || leg.route.label }
          });
        } else {
          const prior = legs[index - 1];
          const priorPt = [prior.alightStop.lon, prior.alightStop.lat];
          if (leg.transferWalkDist > 5) {
            walkFeatures.push({
              type: "Feature", geometry: { type: "LineString", coordinates: [priorPt, boardPt] },
              properties: { type: "transferWalk" }
            });
          }
          ptFeatures.push({
            type: "Feature", geometry: { type: "Point", coordinates: priorPt },
            properties: { role: "transfer", color: "#8b5cf6", label: "Transfer" }
          });
          if (leg.transferWalkDist > 5 && (priorPt[0] !== boardPt[0] || priorPt[1] !== boardPt[1])) {
            ptFeatures.push({
              type: "Feature", geometry: { type: "Point", coordinates: boardPt },
              properties: { role: "transfer2", color: tagColor(leg.route), label: leg.route.short || leg.route.label }
            });
          }
        }
        const routeIdx = LINEIDX[leg.route.id];
        const segment = getRouteSegmentGeometry(routeIdx, leg.boardStop, leg.alightStop, leg.intermediateStopIds || []);
        if (segment.length >= 2) {
          lineFeatures.push({
            type: "Feature", geometry: { type: "LineString", coordinates: segment },
            properties: { color: tagColor(leg.route), isRail: leg.route.cat === "link" || leg.route.cat === "sounder" ? 1 : 0 }
          });
          for (const point of segment) allCoords.push(point);
        }
      });
      ptFeatures.push({
        type: "Feature", geometry: { type: "Point", coordinates: finalAlight },
        properties: { role: "alight", color: tagColor(legs[legs.length - 1].route), label: "Exit" }
      });
      focusOff();
    }

    const dartTripRoute = [it.r, it.r1, it.r2, ...((it.legs || []).map((leg) => leg.route))].find((r) => r && r.cat === "dart");
    if (dartTripRoute) highlightDartArea(dartTripRoute.id);
    else if (!(selected && selected.type === "route" && RBY[selected.id]?.cat === "dart")) highlightDartArea(null);

    if (map.getSource("tripline")) {
      map.getSource("tripline").setData({ type: "FeatureCollection", features: lineFeatures });
    }
    if (map.getSource("tripwalk")) {
      map.getSource("tripwalk").setData({ type: "FeatureCollection", features: walkFeatures });
    }
    if (map.getSource("trippts")) {
      map.getSource("trippts").setData({ type: "FeatureCollection", features: ptFeatures });
    }

    setNetDim(0.24);

    if (fit) {
      const lons = allCoords.map((c) => c[0]), lats = allCoords.map((c) => c[1]);
      const bbox = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
      map.fitBounds(bbox, { padding: fitPadding(), maxZoom: 15.2, duration: 900 });
    }
  }

  function executeTripPlan() {
    if (!dirOrigin || !dirDest) return;
    const sug = $("#dirSuggestions");
    if (sug) sug.hidden = true;
    $("#panelBody") && ($("#panelBody").style.visibility = "");
    dirActiveField = null;
    $("#dirOrig")?.blur();
    $("#dirDest")?.blur();
    const requestedTime = getDirPlanningTime();
    // For arrive-by, search forward from up to three hours before the requested
    // arrival, then keep only schedule-feasible itineraries that meet the time.
    // This preserves the same all-mode planner and its transfer buffers.
    const searchTime = requestedTime.mode === "arrive-by"
      ? { ...pacificAt(new Date(Math.max(Date.now(), requestedTime.date.getTime() - 3 * 60 * 60 * 1000))), mode: "arrive-by" }
      : requestedTime;
    const collect = (plan) => {
      const itins = [];
      if (!plan) return itins;
      if (plan.direct?.length) itins.push(...plan.direct);
      if (plan.transfer?.length) itins.push(...plan.transfer);
      if (plan.multi?.length) itins.push(...plan.multi);
      if (plan.directWalk) itins.push(plan.directWalk);
      return itins;
    };
    let allItins = collect(planTransitTrip(dirOrigin, dirDest, searchTime));
    if (requestedTime.mode === "arrive-by") {
      allItins = allItins.filter((it) => it.arrivalSec == null || it.arrivalSec <= requestedTime.secs + 30);
      for (const it of allItins) {
        it.planningTime = requestedTime;
        it.arriveBy = true;
        it.requestedArrivalSec = requestedTime.secs;
      }
    }
    allItins.sort((a, b) => {
      const aDur = a.totalDuration - (a.type === "direct" ? 3 : 0);
      const bDur = b.totalDuration - (b.type === "direct" ? 3 : 0);
      return aDur - bDur;
    });
    currentItineraries = allItins;
    selectedItinerary = currentItineraries[0] || null;
    panelView = "directions";
    renderTripPlanView();
    if (selectedItinerary) renderTripOnMap(selectedItinerary, { fit: true });
    else clearTripMap();
  }

  function renderTripPlanView() {
    if (dirOrigin && dirDest) {
      hideDirSuggestionsBox();
    }
    if (!dirOrigin || !dirDest) {
      const html = `${backBtn}
      <div class="home-view">
        <div class="planner-summary-card">
          <div class="planner-summary-title">
            <span>🗺️ Dynamic Trip Planner</span>
            <button class="planner-reverse-btn press" id="planExitBtn" type="button">All routes</button>
          </div>
          ${dirOrigin ? `<p class="planner-sub" style="margin-bottom:6px"><strong>Start:</strong> ${esc(dirOrigin.isLocation ? "Your location" : dirOrigin.name)}</p>` : ""}
          ${dirDest ? `<p class="planner-sub" style="margin-bottom:6px"><strong>Destination:</strong> ${esc(dirDest.isLocation ? "Your location" : dirDest.name)}</p>` : ""}
          <p class="planner-sub">${!dirOrigin ? "Enter a starting point above to view transit options." : "Enter a destination above to calculate transit routes across Puget Sound."}</p>
        </div>
      </div>`;
      setView(html);
      $("#back")?.addEventListener("click", closeTripPlanner);
      $("#planExitBtn")?.addEventListener("click", closeTripPlanner);
      return;
    }

    if (!currentItineraries.length) {
      const html = `${backBtn}
      <div class="home-view">
        <div class="planner-summary-card">
          <div class="planner-summary-title">
            <span>No transit routes found</span>
            <div style="display:flex;gap:6px">
              <button class="planner-reverse-btn press" id="planExitBtn" type="button">All routes</button>
              <button class="planner-reverse-btn press" id="planRevBtn" type="button">Reverse ⇄</button>
            </div>
          </div>
          <p class="planner-sub">No direct or 1-transfer transit connection was found between these points. Try selecting a nearby arterial stop or increasing walk distance.</p>
        </div>
      </div>`;
      setView(html);
      $("#back")?.addEventListener("click", closeTripPlanner);
      $("#planExitBtn")?.addEventListener("click", closeTripPlanner);
      $("#planRevBtn")?.addEventListener("click", swapDirections);
      return;
    }

    const cur = selectedItinerary || currentItineraries[0];
    const curSoonest = getSoonestBus(cur);
    const origTitle = dirOrigin.isLocation ? "Your location" : dirOrigin.name;
    const destTitle = dirDest.isLocation ? "Your location" : dirDest.name;

    const cardsHtml = currentItineraries.map((it, idx) => {
      const isAct = it === cur;
      const soonest = getSoonestBus(it);
      let badgeHtml = "";
      let descHtml = "";
      if (it.type === "walk") {
        badgeHtml = `<span class="trip-walk-pill">🚶 Walk only</span>`;
        descHtml = `Direct walk · ${(it.dist / 1609.34).toFixed(1)} miles`;
      } else if (it.type === "direct") {
        badgeHtml = badgeHTML(it.route);
        descHtml = `Board <b>${esc(it.boardStop.name)}</b> → ${it.numStops} stop${it.numStops > 1 ? "s" : ""} → Alight <b>${esc(it.alightStop.name)}</b>`;
      } else if (it.type === "transfer") {
        badgeHtml = `${badgeHTML(it.r1)} <span class="trip-arrow">➔</span> ${badgeHTML(it.r2)}`;
        const t1 = it.transferStop1 || it.transferStop;
        const t2 = it.transferStop2 || it.transferStop;
        const tName = (t1 && t2 && t1.id !== t2.id && t1.name !== t2.name) ? `${esc(t1.name)} / ${esc(t2.name)}` : esc(t1.name);
        descHtml = `Transfer at <b>${tName}</b> · ${it.numStops1 + it.numStops2} total stops`;
      } else if (it.type === "multi") {
        badgeHtml = it.legs.map((leg) => badgeHTML(leg.route)).join(' <span class="trip-arrow">➔</span> ');
        const modes = [...new Set(it.legs.map((leg) => currentVehWord(leg.route)))];
        const stops = it.legs.reduce((total, leg) => total + leg.numStops, 0);
        descHtml = `${it.legs.length - 1} transfer${it.legs.length > 2 ? "s" : ""} · ${stops} total stops · ${modes.join(" + ")}`;
      }

      const soonestPillHtml = soonest ? `<span class="trip-soonest-pill${soonest.isLive ? " is-live" : ""}">
        <span class="soonest-dot"></span>
        <span class="soonest-text">${soonest.text}${soonest.clock ? ` · ${soonest.clock}` : ""}</span>
      </span>` : "";

      const footLabel = it.type === "walk"
        ? "Walking departure:"
        : `Soonest ${soonest.vehWord || "departure"}${(it.type === "transfer" || it.type === "multi") && soonest.routeLabel ? ` (${esc(soonest.routeLabel)})` : ""}:`;
      const footVal = it.type === "walk"
        ? `<b>Walk anytime</b>`
        : `<b>${soonest.text}</b>${soonest.clock ? ` (${soonest.clock})` : ""}`;
      const soonestFootHtml = soonest ? `<div class="trip-soonest-foot">
        <span class="soonest-icon">${soonest.isLive ? "🟢" : soonest.type === "walk" ? "🚶" : "🕒"}</span>
        <span class="soonest-foot-label">${footLabel}</span>
        <span class="soonest-foot-val">${footVal}</span>
      </div>` : "";

      const cardTitle = it.type === "walk" ? "Walk only" : (it.type === "direct" ? it.route.label : it.type === "multi" ? it.legs.map((leg) => leg.route.label).join(" to ") : `${it.r1.label} to ${it.r2.label}`);
      const cardAria = `Option ${idx + 1}: ${cardTitle}, ${it.totalDuration} minutes. ${soonest ? soonest.desc : ""}`;

      return `<button type="button" class="trip-card${isAct ? " active" : ""}" data-plan-idx="${idx}" aria-label="${esc(cardAria)}">
        <div class="trip-card-head">
          <div class="trip-card-headline">
            <span class="trip-time">${it.totalDuration} min</span>
            ${soonestPillHtml}
          </div>
          ${idx === 0 ? '<span class="trip-tag">Fastest</span>' : ""}
        </div>
        <div class="trip-ribbon">${badgeHtml}</div>
        <div class="trip-desc">${descHtml}</div>
        ${soonestFootHtml}
      </button>`;
    }).join("");

    const origBadge = dirOrigin.isLocation ? { bg: "#2563eb", label: "Your location" } : (dirOrigin.badge || getPlaceBadge(dirOrigin));
    const destBadge = dirDest.badge || getPlaceBadge(dirDest);
    const origIconHtml = `<span class="step-icon" style="background:${origBadge.bg};color:#fff;font-size:14px">${poiIconSVG(origBadge.iconKind || poiKindFromBadge(origBadge), 15)}</span>`;
    const destIconHtml = `<span class="step-icon" style="background:${destBadge.bg};color:#fff;font-size:14px">${poiIconSVG(destBadge.iconKind || poiKindFromBadge(destBadge), 15)}</span>`;

    let stepsHtml = "";
    if (cur.type === "walk") {
      stepsHtml = `<div class="trip-steps">
        <div class="step-row">
          <span class="step-line"></span>
          ${origIconHtml}
          <div class="step-content">
            <div class="step-main">Start at ${esc(origTitle)}</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon">🚶</span>
          <div class="step-content">
            <div class="step-main">Walk ${(cur.dist / 1609.34).toFixed(1)} mi to destination</div>
            <div class="step-meta">About ${cur.totalDuration} minutes</div>
          </div>
        </div>
        <div class="step-row">
          ${destIconHtml}
          <div class="step-content">
            <div class="step-main">Arrive at ${esc(destTitle)}</div>
          </div>
        </div>
      </div>`;
    } else if (cur.type === "direct") {
      stepsHtml = `<div class="trip-steps">
        <div class="step-row">
          <span class="step-line"></span>
          ${origIconHtml}
          <div class="step-content">
            <div class="step-main">Start at ${esc(origTitle)}</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon">🚶</span>
          <div class="step-content">
            <div class="step-main">Walk to ${esc(cur.boardStop.name)}</div>
            <div class="step-meta">${cur.walk1Time} min walk · ${Math.round(cur.walk1Dist)} m</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon transit">${modeIcon(cur.route)}</span>
          <div class="step-content">
            <div class="step-main">Board ${badgeHTML(cur.route)} towards ${esc(cur.pattern.headsign || "Destination")}</div>
            <div class="step-meta">${curSoonest ? `<span class="step-soonest${curSoonest.isLive ? " is-live" : ""}">${curSoonest.isLive ? "🟢 Live departure:" : "🕒 Soonest departure:"} <b>${curSoonest.text}</b>${curSoonest.clock ? ` (${curSoonest.clock})` : ""}</span> · ` : ""}${cur.rideTime} min ride · ${cur.numStops} stop${cur.numStops > 1 ? "s" : ""}</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon">🚶</span>
          <div class="step-content">
            <div class="step-main">Alight at ${esc(cur.alightStop.name)}</div>
            <div class="step-meta">Walk ${cur.walk2Time} min · ${Math.round(cur.walk2Dist)} m to destination</div>
          </div>
        </div>
        <div class="step-row">
          ${destIconHtml}
          <div class="step-content">
            <div class="step-main">Arrive at ${esc(destTitle)}</div>
          </div>
        </div>
      </div>`;
    } else if (cur.type === "transfer") {
      stepsHtml = `<div class="trip-steps">
        <div class="step-row">
          <span class="step-line"></span>
          ${origIconHtml}
          <div class="step-content">
            <div class="step-main">Start at ${esc(origTitle)}</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon">🚶</span>
          <div class="step-content">
            <div class="step-main">Walk to ${esc(cur.boardStop.name)}</div>
            <div class="step-meta">${cur.walk1Time} min walk</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon transit">${modeIcon(cur.r1)}</span>
          <div class="step-content">
            <div class="step-main">Board ${badgeHTML(cur.r1)} towards ${esc(cur.p1.headsign || "Transfer")}</div>
            <div class="step-meta">${curSoonest ? `<span class="step-soonest${curSoonest.isLive ? " is-live" : ""}">${curSoonest.isLive ? "🟢 Live departure:" : "🕒 Soonest departure:"} <b>${curSoonest.text}</b>${curSoonest.clock ? ` (${curSoonest.clock})` : ""}</span> · ` : ""}${cur.ride1} min · ${cur.numStops1} stops</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon">🔄</span>
          <div class="step-content">
            <div class="step-main">${cur.transferStop1 && cur.transferStop2 && cur.transferStop1.id !== cur.transferStop2.id && cur.transferStop1.name !== cur.transferStop2.name ? `Transfer: Walk ${cur.transferWalkTime || 1} min from ${esc(cur.transferStop1.name)} to ${esc(cur.transferStop2.name)}` : `Transfer at ${esc((cur.transferStop1 || cur.transferStop).name)}`}</div>
            <div class="step-meta">Connection buffer ~${cur.wait2} min</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon transit">${modeIcon(cur.r2)}</span>
          <div class="step-content">
            <div class="step-main">Board ${badgeHTML(cur.r2)} towards ${esc(cur.p2.headsign || "Destination")}</div>
            <div class="step-meta">${cur.ride2} min · ${cur.numStops2} stops</div>
          </div>
        </div>
        <div class="step-row">
          <span class="step-line"></span>
          <span class="step-icon">🚶</span>
          <div class="step-content">
            <div class="step-main">Alight at ${esc(cur.alightStop.name)}</div>
            <div class="step-meta">Walk ${cur.walk2Time} min to destination</div>
          </div>
        </div>
        <div class="step-row">
          ${destIconHtml}
          <div class="step-content">
            <div class="step-main">Arrive at ${esc(destTitle)}</div>
          </div>
        </div>
      </div>`;
    } else if (cur.type === "multi") {
      const rows = [];
      rows.push(`<div class="step-row"><span class="step-line"></span>${origIconHtml}<div class="step-content"><div class="step-main">Start at ${esc(origTitle)}</div></div></div>`);
      rows.push(`<div class="step-row"><span class="step-line"></span><span class="step-icon">🚶</span><div class="step-content"><div class="step-main">Walk to ${esc(cur.legs[0].boardStop.name)}</div><div class="step-meta">${cur.walk1Time} min walk · ${Math.round(cur.walk1Dist)} m</div></div></div>`);
      cur.legs.forEach((leg, index) => {
        const firstDeparture = index === 0 && curSoonest ? `<span class="step-soonest${curSoonest.isLive ? " is-live" : ""}">${curSoonest.isLive ? "🟢 Live departure:" : "🕒 Soonest departure:"} <b>${curSoonest.text}</b>${curSoonest.clock ? ` (${curSoonest.clock})` : ""}</span> · ` : "";
        rows.push(`<div class="step-row"><span class="step-line"></span><span class="step-icon transit">${modeIcon(leg.route)}</span><div class="step-content"><div class="step-main">Board ${badgeHTML(leg.route)} towards ${esc(leg.pattern.headsign || "Destination")}</div><div class="step-meta">${firstDeparture}${leg.rideTime} min · ${leg.numStops} stop${leg.numStops === 1 ? "" : "s"}</div></div></div>`);
        if (index < cur.legs.length - 1) {
          const next = cur.legs[index + 1];
          const transferName = leg.alightStop.id !== next.boardStop.id && leg.alightStop.name !== next.boardStop.name
            ? `Walk ${next.transferWalkTime} min from ${esc(leg.alightStop.name)} to ${esc(next.boardStop.name)}`
            : `Transfer at ${esc(leg.alightStop.name)}`;
          rows.push(`<div class="step-row"><span class="step-line"></span><span class="step-icon">🔄</span><div class="step-content"><div class="step-main">${transferName}</div><div class="step-meta">Connection buffer ~${next.waitTime} min</div></div></div>`);
        }
      });
      rows.push(`<div class="step-row"><span class="step-line"></span><span class="step-icon">🚶</span><div class="step-content"><div class="step-main">Alight at ${esc(cur.alightStop.name)}</div><div class="step-meta">Walk ${cur.walk2Time} min · ${Math.round(cur.walk2Dist)} m to destination</div></div></div>`);
      rows.push(`<div class="step-row">${destIconHtml}<div class="step-content"><div class="step-main">Arrive at ${esc(destTitle)}</div></div></div>`);
      stepsHtml = `<div class="trip-steps">${rows.join("")}</div>`;
    }

    const appleUrl = `https://maps.apple.com/?saddr=${dirOrigin.lat},${dirOrigin.lon}&daddr=${dirDest.lat},${dirDest.lon}&dirflg=r`;
    const googleUrl = `https://www.google.com/maps/dir/?api=1&origin=${dirOrigin.lat},${dirOrigin.lon}&destination=${dirDest.lat},${dirDest.lon}&travelmode=transit`;

    const isSaved = isFavTrip(dirOrigin, dirDest);
    const html = `${backBtn}
    <div class="home-view">
      <div class="planner-summary-card">
        <div class="planner-summary-title">
          <span>${cur.totalDuration} min · ${currentItineraries.length} route option${currentItineraries.length > 1 ? "s" : ""}</span>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="planner-fav-btn press${isSaved ? " is-fav" : ""}" id="planFavBtn" type="button">${isSaved ? "★ Saved" : "☆ Save trip"}</button>
            <button class="planner-reverse-btn press" id="planRevBtn" type="button">Reverse ⇄</button>
          </div>
        </div>
        <p class="planner-sub">From ${esc(origTitle)} to ${esc(destTitle)} · ${esc(plannerTimeLabel(cur.planningTime))}</p>
      </div>
      <h3 class="section">Trip Options</h3>
      ${cardsHtml}
      <h3 class="section" style="margin-top:16px">Itinerary Breakdown</h3>
      <div class="planner-summary-card">
        ${stepsHtml}
      </div>
      <div class="dir-actions" style="margin-top:14px">
        <span class="dir-label" style="font-size:11px">Voice Turn-by-Turn Navigation</span>
        <div class="dir-btns">
          <a class="dir-btn apple press" href="${appleUrl}" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516s1.52.087 2.475-1.258.762-2.391.728-2.43m3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422s1.675-2.789 1.698-2.854-.597-.79-1.254-1.157a3.7 3.7 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56s.625 1.924 1.273 2.796c.576.984 1.34 1.667 1.659 1.899s1.219.386 1.843.067c.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758q.52-1.185.473-1.282"/></svg>
            <span>Apple Maps</span>
          </a>
          <a class="dir-btn google press" href="${googleUrl}" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
            <span>Google Maps</span>
          </a>
        </div>
      </div>
    </div>`;

    setView(html);
    $("#back")?.addEventListener("click", closeTripPlanner);
    $("#planRevBtn")?.addEventListener("click", swapDirections);
    $("#planFavBtn")?.addEventListener("click", () => {
      toggleFavTrip(dirOrigin, dirDest, cur);
      renderTripPlanView();
    });
    let tripHoverTimer = null;
    for (const b of body().querySelectorAll("[data-plan-idx]")) {
      b.addEventListener("mouseenter", () => {
        clearTimeout(tripHoverTimer);
        const idx = +b.dataset.planIdx;
        const it = currentItineraries[idx];
        if (it) {
          b.classList.add("is-hovered");
          renderTripOnMap(it, { fit: false, isHover: true });
        }
      });
      b.addEventListener("mouseleave", () => {
        b.classList.remove("is-hovered");
        clearTimeout(tripHoverTimer);
        tripHoverTimer = setTimeout(() => {
          if (panelView === "directions" && selectedItinerary) {
            renderTripOnMap(selectedItinerary, { fit: false, isHover: false });
          }
        }, 70);
      });
      b.addEventListener("click", () => {
        clearTimeout(tripHoverTimer);
        const idx = +b.dataset.planIdx;
        if (currentItineraries[idx]) {
          selectedItinerary = currentItineraries[idx];
          renderTripPlanView();
          renderTripOnMap(selectedItinerary, { fit: false });
        }
      });
    }

    // Ensure live departures for all boarding stops in the options list
    const allBoardStops = currentItineraries.flatMap((it) => it.boardStop ? stopIdsOf(it.boardStop) : []);
    if (allBoardStops.length) {
      ensureDepartures(allBoardStops, () => {
        if (panelView === "directions") {
          for (const card of body().querySelectorAll("[data-plan-idx]")) {
            const idx = +card.dataset.planIdx;
            const it = currentItineraries[idx];
            if (!it) continue;
            const updated = getSoonestBus(it);
            if (!updated) continue;
            const pill = card.querySelector(".trip-soonest-pill");
            if (pill) {
              pill.className = `trip-soonest-pill${updated.isLive ? " is-live" : ""}`;
              const textEl = pill.querySelector(".soonest-text");
              if (textEl) textEl.textContent = `${updated.text}${updated.clock ? ` · ${updated.clock}` : ""}`;
            }
            const footVal = card.querySelector(".soonest-foot-val");
            if (footVal) {
              footVal.innerHTML = `<b>${esc(updated.text)}</b>${updated.clock ? ` (${esc(updated.clock)})` : ""}`;
            }
          }
        }
      });
    }
  }

  function updateDirInputs() {
    const oInput = $("#dirOrig"), dInput = $("#dirDest");
    const oClr = $("#dirOrigClear"), dClr = $("#dirDestClear");
    if (oInput) {
      oInput.value = dirOrigin ? (dirOrigin.isLocation ? "Your location" : dirOrigin.name) : "";
      if (oClr) oClr.hidden = !dirOrigin;
    }
    if (dInput) {
      dInput.value = dirDest ? (dirDest.isLocation ? "Your location" : dirDest.name) : "";
      if (dClr) dClr.hidden = !dirDest;
    }
  }

  function swapDirections() {
    hideDirSuggestionsBox();
    dirActiveField = null;
    $("#dirOrig")?.blur();
    $("#dirDest")?.blur();
    const temp = dirOrigin;
    dirOrigin = dirDest;
    dirDest = temp;
    updateDirInputs();
    showToast("Directions reversed ⇄");
    if (dirOrigin && dirDest) {
      executeTripPlan();
    } else {
      renderTripPlanView();
    }
  }

  function openTripPlanner({ orig = null, dest = null }) {
    $("#searchBar").hidden = true;
    $("#filterBar").hidden = true;
    $("#dirPanel").hidden = false;
    if (orig) dirOrigin = orig;
    if (dest) dirDest = dest;
    syncDirTimeControls();
    updateDirInputs();
    panelView = "directions";
    openSheet("half");
    if (dirOrigin && dirDest) {
      executeTripPlan();
    } else if (!dirOrigin) {
      focusDirField("orig");
      renderTripPlanView();
    } else if (!dirDest) {
      focusDirField("dest");
      renderTripPlanView();
    }
  }

  function planTripTo({ lat, lon, name }) {
    const pt = { lat: Number(lat), lon: Number(lon), name: name || "Destination" };
    dirDest = pt;
    if (userCoords) {
      dirOrigin = { lat: userCoords.lat, lon: userCoords.lng, name: "Your location", isLocation: true };
      openTripPlanner({ orig: dirOrigin, dest: dirDest });
      return;
    }
    openTripPlanner({ orig: null, dest: dirDest });
    if (navigator.geolocation) {
      showToast("Acquiring GPS location for trip…");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          dirOrigin = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: "Your location", isLocation: true };
          updateDirInputs();
          executeTripPlan();
        },
        () => {
          showToast("Enter starting location above");
          focusDirField("orig");
        },
        { enableHighAccuracy: true, timeout: 6000 }
      );
    } else {
      focusDirField("orig");
    }
  }

  function planTripFrom({ lat, lon, name }) {
    const pt = { lat: Number(lat), lon: Number(lon), name: name || "Start location" };
    dirOrigin = pt;
    dirDest = null;
    openTripPlanner({ orig: dirOrigin, dest: null });
    focusDirField("dest");
  }

  function closeTripPlanner() {
    $("#searchBar").hidden = false;
    $("#filterBar").hidden = false;
    $("#dirPanel").hidden = true;
    hideDirSuggestionsBox();
    dirOrigin = null;
    dirDest = null;
    currentItineraries = [];
    selectedItinerary = null;
    dirActiveField = null;
    clearTripMap();
    if (typeof clearPlaceMarker === "function") clearPlaceMarker();
    focusOff();
    panelView = "home";
    showHome();
  }

  function setOriginToCurrentLocation() {
    if (userCoords) {
      dirOrigin = {
        lat: userCoords.lat,
        lon: userCoords.lng,
        name: "Your location",
        isLocation: true,
      };
      updateDirInputs();
      if (dirDest) executeTripPlan();
      else focusDirField("dest");
      return;
    }
    if (!navigator.geolocation) {
      showToast("Location services not available");
      return;
    }
    showToast("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        dirOrigin = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          name: "Your location",
          isLocation: true,
        };
        updateDirInputs();
        if (dirDest) executeTripPlan();
        else focusDirField("dest");
      },
      () => {
        showToast("Could not determine location");
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  function focusDirField(field) {
    dirActiveField = field;
    const input = field === "orig" ? $("#dirOrig") : $("#dirDest");
    if (input) {
      input.focus();
      renderDirSuggestions(input.value);
    }
  }

  function handleMapClickForDirections(lngLat) {
    const pt = {
      lat: lngLat.lat,
      lon: lngLat.lng,
      name: `Map location (${lngLat.lat.toFixed(4)}, ${lngLat.lng.toFixed(4)})`,
    };
    if (dirActiveField === "orig" || (!dirOrigin && dirDest)) {
      dirOrigin = pt;
      showToast("Start location set from map 📍");
    } else {
      dirDest = pt;
      showToast("Destination set from map 🏁");
    }
    dirActiveField = null;
    hideDirSuggestionsBox();
    updateDirInputs();
    if (dirOrigin && dirDest) {
      executeTripPlan();
    } else {
      renderTripPlanView();
    }
  }

  const geoCache = new Map();
  let geoAbort = null;

  async function searchAddressesAndPois(query) {
    if (!query || query.trim().length < 3) return [];
    const q = query.trim();
    const cacheKey = q.toLowerCase();
    if (geoCache.has(cacheKey)) return geoCache.get(cacheKey);

    if (geoAbort) {
      try { geoAbort.abort(); } catch {}
    }
    geoAbort = new AbortController();

    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=47.6062&lon=-122.3321&limit=6`;
      const res = await fetch(url, { signal: geoAbort.signal });
      if (res.ok) {
        const json = await res.json();
        const results = [];
        for (const f of (json.features || [])) {
          const p = f.properties;
          const coords = f.geometry?.coordinates;
          if (!coords || coords.length < 2) continue;
          const lon = coords[0], lat = coords[1];
          // Puget Sound metropolitan bounding box
          if (lat < 47.0 || lat > 48.3 || lon < -122.8 || lon > -121.5) continue;

          const addr = [p.housenumber, p.street].filter(Boolean).join(" ");
          let title = p.name || addr || p.city || q;
          if (p.name && addr && !p.name.toLowerCase().includes(addr.toLowerCase())) {
            title = `${p.name} (${addr})`;
          }
          const locality = p.locality || p.district;
          const desc = [locality, p.city, p.state || "WA", p.postcode].filter(Boolean).join(", ");
          results.push({
            kind: "poi",
            name: title,
            desc: desc || "Puget Sound, WA",
            lat, lon,
            osm_key: p.osm_key,
            osm_value: p.osm_value,
            osm_type: p.osm_type,
            type: p.type
          });
        }
        geoCache.set(cacheKey, results);
        return results;
      }
    } catch (e) {
      if (e.name === "AbortError") return [];
    }
    return [];
  }

  function searchLocalStopsAndPois(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const items = search(q);
    const results = [];
    for (const it of items) {
      if (it.kind === "station") {
        results.push({ kind: "station", name: it.s.name, desc: "Light rail / rail station", lat: it.s.lat, lon: it.s.lon });
      } else if (it.kind === "stop") {
        results.push({ kind: "stop", name: it.s.name, desc: `Bus stop ${it.s.code ? "#" + it.s.code : ""}`, lat: it.s.lat, lon: it.s.lon });
      } else if (it.kind === "pr") {
        results.push({ kind: "pr", name: it.pr.name, desc: `Park & Ride (${it.pr.stalls} stalls)`, lat: it.pr.lat, lon: it.pr.lon });
      } else if (it.kind === "dest") {
        results.push({ kind: "poi", name: it.d.name, desc: poiKindTitle(it.d.kind), lat: it.d.coords[1], lon: it.d.coords[0], badge: { iconKind: it.d.kind, bg: poiColor(it.d.kind), label: poiKindTitle(it.d.kind) } });
      } else if (it.kind === "trail") {
        const coords = [];
        const getC = (c) => { if (typeof c[0] === "number") coords.push(c); else c.forEach(getC); };
        getC(it.f.geometry.coordinates);
        if (coords.length) {
          const mid = coords[Math.floor(coords.length / 2)];
          results.push({ kind: "trail", name: it.f.properties.name, desc: "Trail corridor", lat: mid[1], lon: mid[0] });
        }
      }
    }
    return results.slice(0, 5);
  }

  let currentDirSuggestions = [];

  function showDirSuggestionsBox() {
    const box = $("#dirSuggestions");
    if (box) box.hidden = false;
    const body = $("#panelBody");
    if (body) body.style.visibility = "hidden";
  }

  function hideDirSuggestionsBox() {
    const box = $("#dirSuggestions");
    if (box) box.hidden = true;
    const body = $("#panelBody");
    if (body) body.style.visibility = "";
  }

  function paintDirSuggestions(box, items) {
    if (!items.length) {
      box.innerHTML = `<div class="empty" style="padding:10px;font-size:12.5px;color:var(--muted)">Type an address, landmark, or stop name…</div>`;
      return;
    }
    box.innerHTML = items.map((it, idx) => {
      let glyph = "📍";
      let bg = "var(--accent,#007aff)";
      if (it.kind === "favtrip") { glyph = "⭐"; bg = "#f59e0b"; }
      else if (it.kind === "currloc") { glyph = "📍"; bg = "#2563eb"; }
      else if (it.kind === "mapchoice") { glyph = "🗺️"; bg = "#0891b2"; }
      else if (it.kind === "station") { glyph = "🚆"; bg = "#059669"; }
      else if (it.kind === "stop") { glyph = "🚌"; bg = "#2563eb"; }
      else if (it.kind === "pr") { glyph = "🅿️"; bg = "#0284c7"; }
      else if (it.kind === "trail") { glyph = "🚲"; bg = "#059669"; }
      else {
        const badge = it.badge || getPlaceBadge(it);
        glyph = poiIconSVG(badge.iconKind || poiKindFromBadge(badge), 16);
        bg = badge.bg;
      }
      return `<button type="button" class="result" data-sug-idx="${idx}">
        <span class="trail-glyph${it.kind === "poi" ? " poi-search-glyph" : ""}" aria-hidden="true" style="background:${bg};color:#fff">${glyph}</span>
        <span class="txt"><span class="name">${esc(it.name)}</span><span class="desc">${esc(it.desc)}</span></span>
      </button>`;
    }).join("") + `<div class="dir-provider-note" style="padding:6px 12px;font-size:11px;color:var(--text-sub);border-top:1px solid var(--border,#e2e8f0);text-align:center">Address suggestions via Photon · OpenStreetMap data</div>`;
  }

  function renderDirSuggestions(query) {
    const box = $("#dirSuggestions");
    if (!box) return;
    const q = (query || "").trim();

    const items = [];

    if (q.length < 2) {
      items.push({
        kind: "currloc",
        name: "Your current location",
        desc: userCoords ? "GPS location available" : "Acquire GPS fix",
        action: () => {
          setOriginToCurrentLocation();
          hideDirSuggestionsBox();
        }
      });
      items.push({
        kind: "mapchoice",
        name: "Choose on map",
        desc: "Tap anywhere on the map to set point",
        action: () => {
          showToast(`Tap anywhere on the map to set ${dirActiveField === "orig" ? "starting point" : "destination"}`);
          hideDirSuggestionsBox();
        }
      });
      const fTrips = getFavs().trips || [];
      for (const t of fTrips) {
        items.push({
          kind: "favtrip",
          name: t.name,
          desc: `Saved trip · ${t.duration ? `${t.duration} min · ` : ""}${t.summary || ""}`,
          action: () => {
            hideDirSuggestionsBox();
            openTripPlanner({ orig: t.orig, dest: t.dest });
          }
        });
      }
    } else {
      const locals = searchLocalStopsAndPois(q);
      for (const loc of locals) {
        const badge = getPlaceBadge(loc);
        items.push({
          kind: loc.kind,
          name: loc.name,
          desc: `${loc.desc} · ${badge.label}`,
          badge,
          action: () => {
            const pt = { lat: loc.lat, lon: loc.lon, name: loc.name, badge };
            if (dirActiveField === "orig") dirOrigin = pt; else dirDest = pt;
            dirActiveField = null;
            hideDirSuggestionsBox();
            updateDirInputs();
            if (dirOrigin && dirDest) {
              executeTripPlan();
            } else if (!dirOrigin) {
              focusDirField("orig");
              renderTripPlanView();
            } else if (!dirDest) {
              focusDirField("dest");
              renderTripPlanView();
            }
          }
        });
      }
    }

    currentDirSuggestions = items;
    paintDirSuggestions(box, currentDirSuggestions);
    showDirSuggestionsBox();

    if (q.length >= 3) {
      clearTimeout(dirDebounceTimer);
      dirDebounceTimer = setTimeout(async () => {
        const pois = await searchAddressesAndPois(q);
        const currentInputVal = (dirActiveField === "orig" ? $("#dirOrig")?.value : $("#dirDest")?.value) || "";
        if (currentInputVal.trim() !== q || box.hidden) return;

        const poiItems = pois.map((p) => {
          const badge = getPlaceBadge(p);
          return {
            kind: "poi",
            name: p.name,
            desc: `${p.desc} · ${badge.label}`,
            lat: p.lat,
            lon: p.lon,
            osm_key: p.osm_key,
            osm_value: p.osm_value,
            type: p.type,
            class: p.class,
            badge,
            action: () => {
              const pt = { lat: p.lat, lon: p.lon, name: p.name, desc: p.desc, badge };
              if (dirActiveField === "orig") dirOrigin = pt; else dirDest = pt;
              dirActiveField = null;
              hideDirSuggestionsBox();
              updateDirInputs();
              if (dirOrigin && dirDest) {
                executeTripPlan();
              } else if (!dirOrigin) {
                focusDirField("orig");
                renderTripPlanView();
              } else if (!dirDest) {
                focusDirField("dest");
                renderTripPlanView();
              }
            }
          };
        });

        currentDirSuggestions = [...items, ...poiItems];
        if (q.length >= 2 && currentDirSuggestions.length === 0) {
          currentDirSuggestions.push({
            kind: "mapchoice",
            name: "Choose on map",
            desc: "Tap anywhere on the map to set point",
            action: () => {
              showToast(`Tap anywhere on the map to set ${dirActiveField === "orig" ? "starting point" : "destination"}`);
              hideDirSuggestionsBox();
            }
          });
        }
        paintDirSuggestions(box, currentDirSuggestions);
      }, 220);
    }
  }

  function setupTripPlanner() {
    $("#planTripBtn")?.addEventListener("click", () => {
      openTripPlanner({});
    });
    $("#dirClose")?.addEventListener("click", closeTripPlanner);
    $("#dirBackIcon")?.addEventListener("click", closeTripPlanner);
    $("#dirSwap")?.addEventListener("click", swapDirections);
    $("#dirOrigLoc")?.addEventListener("click", setOriginToCurrentLocation);
    for (const button of document.querySelectorAll("[data-plan-time]")) {
      button.addEventListener("click", () => {
        dirTimeMode = button.dataset.planTime;
        if (dirTimeMode !== "leave-now" && !dirTimeValue) {
          dirTimeValue = localDateTimeValue(new Date(Date.now() + 15 * 60 * 1000));
        }
        syncDirTimeControls();
        if (dirOrigin && dirDest) executeTripPlan();
      });
    }
    $("#dirTimeInput")?.addEventListener("change", (event) => {
      dirTimeValue = event.target.value;
      syncDirTimeControls();
      if (dirOrigin && dirDest) executeTripPlan();
    });
    $("#dirOrigClear")?.addEventListener("click", () => {
      dirOrigin = null;
      clearTripMap();
      updateDirInputs();
      focusDirField("orig");
      renderTripPlanView();
    });
    $("#dirDestClear")?.addEventListener("click", () => {
      dirDest = null;
      clearTripMap();
      updateDirInputs();
      focusDirField("dest");
      renderTripPlanView();
    });

    const oInput = $("#dirOrig"), dInput = $("#dirDest");
    if (oInput) {
      oInput.addEventListener("focus", () => {
        dirActiveField = "orig";
        openSheet("full");
        renderDirSuggestions(oInput.value);
      });
      oInput.addEventListener("blur", () => {
        setTimeout(() => {
          if (!document.activeElement?.closest(".dir-field, #dirSuggestions")) {
            hideDirSuggestionsBox();
          }
        }, 180);
      });
      oInput.addEventListener("input", () => {
        if (!oInput.value.trim()) {
          dirOrigin = null;
          $("#dirOrigClear") && ($("#dirOrigClear").hidden = true);
          clearTripMap();
          renderTripPlanView();
        } else {
          $("#dirOrigClear") && ($("#dirOrigClear").hidden = false);
        }
        renderDirSuggestions(oInput.value);
      });
      oInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const first = currentDirSuggestions[0];
          if (first) first.action();
        }
      });
    }
    if (dInput) {
      dInput.addEventListener("focus", () => {
        dirActiveField = "dest";
        openSheet("full");
        renderDirSuggestions(dInput.value);
      });
      dInput.addEventListener("blur", () => {
        setTimeout(() => {
          if (!document.activeElement?.closest(".dir-field, #dirSuggestions")) {
            hideDirSuggestionsBox();
          }
        }, 180);
      });
      dInput.addEventListener("input", () => {
        if (!dInput.value.trim()) {
          dirDest = null;
          $("#dirDestClear") && ($("#dirDestClear").hidden = true);
          clearTripMap();
          renderTripPlanView();
        } else {
          $("#dirDestClear") && ($("#dirDestClear").hidden = false);
        }
        renderDirSuggestions(dInput.value);
      });
      dInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const first = currentDirSuggestions[0];
          if (first) first.action();
        }
      });
    }

    const dirSugBox = $("#dirSuggestions");
    dirSugBox?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sug-idx]");
      if (!b) return;
      const idx = +b.dataset.sugIdx;
      if (currentDirSuggestions[idx]?.action) {
        currentDirSuggestions[idx].action();
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".dir-field") && !e.target.closest(".dir-time") && !e.target.closest("#dirSuggestions") && !e.target.closest("#planTripBtn")) {
        hideDirSuggestionsBox();
      }
    });

    // Delegated click handler for "Plan Trip Here" and "Trip from Here" across all cards & popups
    document.addEventListener("click", (e) => {
      const destBtn = e.target.closest(".dir-inapp-btn.dest, [data-dir-dest-lat]");
      if (destBtn) {
        e.preventDefault();
        e.stopPropagation();
        const lat = parseFloat(destBtn.dataset.dirDestLat || destBtn.dataset.lat);
        const lon = parseFloat(destBtn.dataset.dirDestLon || destBtn.dataset.lon);
        const name = destBtn.dataset.dirDestName || destBtn.dataset.name || "Destination";
        planTripTo({ lat, lon, name });
        return;
      }
      const origBtn = e.target.closest(".dir-inapp-btn.orig, [data-dir-orig-lat]");
      if (origBtn) {
        e.preventDefault();
        e.stopPropagation();
        const lat = parseFloat(origBtn.dataset.dirOrigLat || origBtn.dataset.lat);
        const lon = parseFloat(origBtn.dataset.dirOrigLon || origBtn.dataset.lon);
        const name = origBtn.dataset.dirOrigName || origBtn.dataset.name || "Start location";
        planTripFrom({ lat, lon, name });
        return;
      }
    });
  }

  // ---------------------------------------------------------------- DART area highlighting
  let activeDartHlKey = null;
  function highlightDartArea(slugOrRoute) {
    if (!map || !map.getSource("darthl")) return;
    if (specialFilter === "snow" || !slugOrRoute || !enabled.has("dart")) {
      if (activeDartHlKey !== null) {
        activeDartHlKey = null;
        map.getSource("darthl").setData(EMPTY_FC);
      }
      return;
    }
    const raw = String(slugOrRoute).trim();
    const cleanNum = raw.replace(/^metro-/, "");
    const slug = raw.startsWith("metro-") ? raw : ("metro-" + raw);
    const key = slug;
    if (activeDartHlKey === key) return;
    activeDartHlKey = key;
    const feats = (AREAS && AREAS.dart && AREAS.dart.features) || [];
    const matched = feats.filter((f) => {
      const p = f.properties || {};
      return p.slug === slug || p.route === cleanNum || p.slug === raw || p.route === raw;
    });
    map.getSource("darthl").setData({
      type: "FeatureCollection",
      features: matched
    });
  }

  // ---------------------------------------------------------------- layer toggles
  let bikeFacilityFilter = null;
  function applyLayerToggles() {
    if (!map) return;
    const dartOn = enabled.has("dart") && specialFilter !== "snow";
    ["dart-fill", "dart-line", "dart-hl-fill", "dart-hl-casing", "dart-hl-line"].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", dartOn ? "visible" : "none");
    });
    if (!dartOn) highlightDartArea(null);
    const vis = (key, ids) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", enabled.has(key) ? "visible" : "none"));
    vis("access", ["access-fill", "access-line"]);
    vis("flex", ["flex", "flex-fill", "flex-line"]);
    const trailLayers = ["trail-case", "trail-pbl", "trail-greenway", "trail-lane", "trail-sharrow", "trail-dash", "trail-labels"];
    if (!enabled.has("trails")) {
      trailLayers.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "none"));
    } else if (!bikeFacilityFilter) {
      trailLayers.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "visible"));
    } else {
      const allowed = {
        pbl: ["trail-case", "trail-pbl", "trail-labels"],
        greenway: ["trail-greenway"],
        lane: ["trail-lane"],
        sharrow: ["trail-sharrow"],
        unpaved: ["trail-dash"],
      }[bikeFacilityFilter] || trailLayers;
      trailLayers.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", allowed.includes(id) ? "visible" : "none"));
    }
    vis("stops", ["stops", "stop-name"]);
    vis("pois", DESTINATION_LAYER_IDS);
    vis("live", ["veh-dir", "veh-icon", "veh-label"]);
    if (enabled.has("live")) startLive(); else stopLive();
    if (map.getSource("stations")) refreshStations();
    renderFilterBar();
    rebuild();
  }

  // ---------------------------------------------------------------- interaction
  const LINE_LAYERS = GROUPS.flatMap((g) => [`line-${g}`, `dash-${g}`]).concat(["sel-line", "sel-dash"]);
  let hitIx = null;
  function lineFeaturesAt(point, radius) {
    if (!ribbons) return qrf([[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]], { layers: LINE_LAYERS.filter((l) => map.getLayer(l)) });
    if (!hitIx) {
      const feats = lastFeats.concat(lastSelFeats);
      hitIx = segIndex(feats);
      hitIx.features = new Map(feats.map((f) => [f.properties, f]));
      hitIx.half = Math.max(0, ...feats.map((f) => (f.properties.ws || f.properties.wm * f.properties.zu * MPP0) / 2));
    }
    const ll = map.unproject(point), p = toM(ll.lng, ll.lat), mpp = MPP0 / 2 ** map.getZoom();
    const reach = hitIx.half + radius * mpp, cell = hitIx.cell;
    const found = new Map(), seen = new Set();
    for (let x = Math.floor((p[0] - reach) / cell); x <= Math.floor((p[0] + reach) / cell); x++) {
      for (let y = Math.floor((p[1] - reach) / cell); y <= Math.floor((p[1] + reach) / cell); y++) {
        for (const n of hitIx.grid.get(x + "," + y) || []) {
          if (seen.has(n)) continue; seen.add(n);
          const [a, b, pr] = hitIx.segs[n], dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
          const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
          const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
          const half = (pr.ws || pr.wm * pr.zu * MPP0) / 2;
          if (d > half + radius * mpp || (found.has(pr) && found.get(pr)._distance <= d)) continue;
          found.set(pr, { ...hitIx.features.get(pr), _distance: d });
        }
      }
    }
    return [...found.values()];
  }
  function streetRoutes(f) {
    const p = f.properties, E = EDGES[p.e];
    if (p.r >= 0) return [p.r];
    if (!E) return [];
    return (E.layer === "s" ? E.l : E.byKey.get(p.cat) || []).filter((i) => {
      if (lastParams && !lastParams.keyOn[dkey(LINES[i])]) return false;
      if (lastParams?.routeFilter && !lastParams.routeFilter.includes(i)) return false;
      return true;
    });
  }
  // Include all visible services sharing a street, so a narrow parallel band is easy to find too.
  function routesAt(point, r = 6) {
    const feats = lineFeaturesAt(point, r);
    const sel = selected && selected.type === "route" ? LINEIDX[selected.id] : -1;
    const set = new Set();
    for (const f of feats) {
      const p = f.properties;
      if (p.r >= 0) { set.add(p.r); continue; }
      for (const i of streetRoutes(f)) set.add(i);
    }
    let idx = [...set];
    if (sel >= 0 && idx.includes(sel) && feats.some((f) => f.properties.r === sel)) idx = [sel];
    return idx.map((i) => LINES[i]).sort(tagOrder);
  }
  let popup = null;
  function closePopup() { if (popup) { popup.remove(); popup = null; } }
  // pointing at a route in a list shows it on the map
  function previewOnHover(b) {
    const preview = () => { if (!(selected && selected.type === "route")) focusRoute(RBY[b.dataset.route]); };
    const revert = () => {
      if (panelView === "corridor" && corridorRoutes.length) {
        focusRoutes(corridorRoutes.map((id) => RBY[id]));
      } else {
        setHover(null);
      }
    };
    b.addEventListener("mouseenter", preview); b.addEventListener("focus", preview);
    b.addEventListener("mouseleave", revert); b.addEventListener("blur", revert);
  }
  function openPopup(lngLat, html, maxWidth = "300px") {
    closePopup();
    popup = new maplibregl.Popup({ maxWidth, className: "glass-pop" }).setLngLat(lngLat).setHTML(html).addTo(map);
    popup.getElement().querySelectorAll("[data-route]").forEach((b) => {
      b.addEventListener("click", () => { closePopup(); selectRoute(b.dataset.route, { fit: true }); });
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
      const feats = lineFeaturesAt(pt, rad);
      if (!feats.length) return null;
      const ll = map.unproject(pt), p = toM(ll.lng, ll.lat), mpp = MPP0 / 2 ** map.getZoom();
      const sel = selected && selected.type === "route" ? LINEIDX[selected.id] : -1;
      let best = null, held = null;
      for (const f of feats) {
        const d = f._distance != null ? f._distance : distTo(f, p);
        if (!isFinite(d)) continue;
        const half = (f.properties.ws || f.properties.wm * f.properties.zu * MPP0 || 0) / 2;
        const out = Math.max(0, d - half) / mpp; // pixels outside the strand
        const score = out + (half ? d / half : 1) * 0.01 - (f.properties.r === sel && sel >= 0 ? 2 : 0);
        const h = { f, out, score };
        if (!best || score < best.score) best = h;
        if (cur && cur.kind === "line" && (f.properties.r >= 0 ? f.properties.r === cur.id : f.properties.cat === cur.cat) && (!held || out < held.out)) held = h;
      }
      // the route in focus holds while the pointer is still on (or right at the edge of) its strand
      if (held && held.out <= 1.5) best = held;
      if (!best || best.out > (cur && cur.kind === "line" ? 6 : 4)) return null;
      const f = best.f, pr = f.properties;
      // boats: every route of the crossing (they share one line)
      const all = streetRoutes(f);
      return { f, r: pr.r < 0 ? all[0] : pr.r, routes: all.map((i) => LINES[i]).filter(Boolean).sort(tagOrder), n: pr.n || 1 };
    };
    const ev = (e, dy = 0) => ({ clientX: e.originalEvent.clientX, clientY: e.originalEvent.clientY + dy });
    function routeServiceDesc(r) {
      if (!r) return "";
      if (isRouteSuspended(r)) {
        return `<div class="tt-service-info"><span class="tt-sched suspended">🚫 Service Suspended · Temporarily closed</span></div>`;
      }
      let catText = "";
      const w = r.sched?.weekday;
      const midMin = w && w.mid_n >= 3 ? w.mid : null;
      if (r.cat === "frequent") {
        catText = midMin ? `🟢 Frequent Bus · Every ${midMin} min all day` : "🟢 Frequent Bus · Every 10–15 min all day";
      } else if (r.cat === "rapidride") {
        catText = midMin ? `🔴 RapidRide BRT · Every ${midMin} min all day` : "🔴 RapidRide BRT · Frequent arterial service";
      } else if (r.cat === "swift") {
        catText = midMin ? `🔵 Swift BRT · Every ${midMin} min all day` : "🔵 Swift BRT · Frequent arterial service";
      } else if (r.cat === "peak") {
        catText = "⚡ Peak Commute Only · Weekday rush hours (dashed line)";
      } else if (r.cat === "dart") {
        catText = "🚐 Dial-a-Ride (DART) · Flexible on-demand zone (dashed line)";
      } else if (r.cat === "local") {
        catText = midMin ? `🔷 All-Day Bus · Every ${midMin} min midday` : "🔷 All-Day Bus · Regular 20–60 min service";
      } else if (r.cat === "link") {
        catText = "🚆 Link Light Rail · Frequent rapid transit";
      } else if (r.cat === "sounder") {
        catText = "🚂 Sounder Commuter Train · Peak regional rail";
      } else if (r.cat === "streetcar") {
        catText = "🚋 Seattle Streetcar · Neighborhood connector";
      } else if (r.cat === "monorail") {
        catText = "🚝 Seattle Center Monorail · Direct express";
      } else if (r.cat === "ferry" || r.cat === "watertaxi") {
        catText = "⛴️ Ferry · Cross-sound water connection (dashed line)";
      } else {
        catText = `${CAT_NAME[r.cat] || "Transit route"}`;
      }

      const runText = isEveryday(r)
        ? "Runs every day (7 days/wk)"
        : (r.sched?.saturday && (r.sched.saturday.mid_n > 0 || r.sched.saturday.trips > 5))
          ? "Runs Mon–Sat · No Sunday"
          : "Part-time (Mon–Fri only · No weekends)";

      return `<div class="tt-service-info"><span class="tt-cat">${esc(catText)}</span><span class="tt-run-pill ${isEveryday(r) ? "everyday" : "part-time"}">${esc(runText)}</span></div>`;
    }
    let moveRaf = 0, lastMoveEvent = null;
    map.on("mousemove", (e) => {
      lastMoveEvent = e;
      if (moveRaf || map.isMoving()) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (!lastMoveEvent || map.isMoving()) return;
        const e = lastMoveEvent;
        if (cur && cur.kind === "dart" && !(selected && selected.type === "route" && RBY[selected.id]?.cat === "dart")) {
          const stillDart = map.queryRenderedFeatures(e.point, { layers: ["dart-fill"] });
          if (!stillDart.length) highlightDartArea(null);
        }
        const vh = pickVehicle(e.point);
        if (vh) {
          const r = RBY[vh.properties.r];
          cur = { kind: "veh", id: vh.properties.id };
          showLens(null);
          map.getCanvas().style.cursor = "pointer";
          highlightStop(null);
          tipShow("veh:" + vh.properties.id, `${badgeHTML(r)}<span class="tt"><b>${esc(routeTitle(r))}</b>${vesselLine(vh.properties.id)}<span class="vs-row">${vehicleLines(vh.properties.id, vh.properties.est)}</span></span>`, "", ev(e));
          return;
        }
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
            const schedInfo = routeServiceDesc(r);
            const tr = getThroughRouteInfo(r);
            const trInfo = tr && tr.partners.length
              ? `<span class="tt-tr">🔄 Stay on bus: continues as ${tr.partners.map((p) => routeTitle(p)).join("/")} through Downtown</span>`
              : "";
            tipShow("tag:" + tg.item.r, `${badgeHTML(r)}<span class="tt"><b>${esc(routeTitle(r))}</b><br>${esc(r.name)}${schedInfo}${trInfo}</span>`, "", ev(e, 14));
          } else {
            cur = { kind: "tag", id: "more" };
            if (!(selected && selected.type === "route") && tg.item.more?.length) {
              focusRoutes(tg.item.more.map((i) => LINES[i]));
            } else {
              setHover(null);
            }
            tipShow("more:" + tg.item.more.join("."), `<span class="tip-badges">${tg.item.more.slice(0, 12).map((i) => badgeHTML(LINES[i])).join("")}</span>`, "", ev(e, 14));
          }
          return;
        }
        if (enabled.has("pois")) {
          const destHits = map.queryRenderedFeatures([[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]], {
            layers: DESTINATION_LAYER_IDS.filter((l) => map.getLayer(l))
          });
          if (destHits.length) {
            const dp = destHits[0].properties;
            cur = { kind: "dest", id: dp.id };
            showLens(null);
            map.getCanvas().style.cursor = "pointer";
            highlightStop(null);
            const dObj = KEY_DESTINATIONS.find((k) => k.id === dp.id);
            const icon = poiIconSVG(dObj ? dObj.kind : "place", 15);
            const kindText = dObj ? poiKindTitle(dObj.kind) : "Point of Interest";
            tipShow("dest:" + dp.id, `<div class="tt-dest"><span class="tt-dest-name poi-tooltip-name">${icon} ${esc(dp.name || dp.short)}</span><span class="tt-dest-kind">${esc(kindText)}</span>${dp.transit ? `<span class="tt-dest-tr">🚌 ${esc(dp.transit)}</span>` : ""}<span class="tt-more">Tap for destination details & trip planner</span></div>`, "", ev(e));
            return;
          }
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
          cur = { kind: "line", id: ln.r, cat: ln.f.properties.cat };
          map.getCanvas().style.cursor = "pointer";
          if (!(selected && selected.type === "route")) {
            if (ln.routes && ln.routes.length) focusRoutes(ln.routes);
            else if (ln.f) focusCorridor(ln.f);
          }
          const rs = ln.routes, r = rs[0];
          const nal = rs.length === 1 ? routeAlerts(rs[0].id) : [];
          const more = (ln.n > 1 ? `<span class="tt-more">${ln.n} routes share this street</span>` : "")
            + (nal.length ? `<span class="tt-alert al-${LEVEL[nal[0].level][0]}">${alertIcon(nal[0].level)}${nal.length === 1 ? esc(LEVEL[nal[0].level][1]) : `${nal.length} alerts`}</span>` : "");
          const schedInfo = routeServiceDesc(r);
          const tr = getThroughRouteInfo(r);
          const trInfo = tr && tr.partners.length
            ? `<span class="tt-tr">🔄 Stay on bus: continues as ${tr.partners.map((p) => routeTitle(p)).join("/")} through Downtown</span>`
            : "";
          tipShow("line:" + rs.map((x) => x.id).join(","), rs.length === 1
            ? `${badgeHTML(r)}<span class="tt"><b>${esc(routeTitle(r))}</b><br>${esc(r.name)}${schedInfo}${trInfo}${more}</span>`
            : `<span class="tip-badges">${rs.slice(0, 6).map((x) => badgeHTML(x)).join("")}</span><span class="tt">${rs.length} routes here · Tap to choose</span>`, "", ev(e));
          return;
        }
        const trailHover = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], {
          layers: ["trail-pbl", "trail-greenway", "trail-lane", "trail-sharrow", "trail-dash"].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none")
        });
        if (trailHover.length) {
          const tp = trailHover[0].properties;
          cur = { kind: "trail", name: tp.name };
          map.getCanvas().style.cursor = "pointer";
          const icon = tp.facility === "trail" ? "🚲" : tp.facility === "pbl" ? "🛡️" : tp.facility === "greenway" ? "🌿" : tp.facility === "lane" ? "🚲" : tp.facility === "sharrow" ? "🚴" : "🚲";
          const badgeColor = tp.facility === "pbl" || tp.facility === "trail" ? "#047857" : tp.facility === "greenway" ? "#10b981" : tp.facility === "lane" ? "#0891b2" : tp.facility === "sharrow" ? "#15803d" : "#b45309";
          tipShow("trail:" + tp.name, `<span class="tt-trail">${icon} <b>${esc(tp.name)}</b>${tp.length_mi ? ` · ${tp.length_mi} mi` : ""}<br><span style="color:${badgeColor};font-weight:700">${esc(tp.cat_name || "Bike Facility")}</span>${tp.surface === "unpaved" ? " · Gravel" : " · Paved"} · Tap for details</span>`, "", ev(e));
          return;
        }
        if (enabled.has("dart") && specialFilter !== "snow") {
          const dartHits = map.queryRenderedFeatures(e.point, { layers: ["dart-fill"] });
          if (dartHits.length) {
            const df = dartHits[0];
            const dp = df.properties || {};
            const rSlug = dp.slug || (dp.route ? ("metro-" + dp.route) : null);
            const r = rSlug ? RBY[rSlug] : null;
            cur = { kind: "dart", id: rSlug || dp.route };
            map.getCanvas().style.cursor = "pointer";
            highlightDartArea(rSlug || dp.route);
            if (r && !(selected && selected.type === "route")) {
              focusRoute(r);
            }
            tipShow(
              "dart:" + (rSlug || dp.route),
              (r ? badgeHTML(r) : "") +
              `<span class="tt"><b>Dial-a-Ride (DART) Area · Route ${esc(dp.route)}</b>${r ? `<br>${esc(r.name)}` : ""}<br><span style="color:var(--accent);font-weight:600">Flexible on-demand service area · Tap to explore</span></span>`,
              "",
              ev(e)
            );
            return;
          }
        }
        cur = null;
        map.getCanvas().style.cursor = "";
        tipHide();
        setHover(null);
      });
    });
    map.getCanvas().addEventListener("mouseleave", () => {
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
      cur = null; tipHide(true); setHover(null); highlightStop(null); showLens(null);
      if (!(selected && selected.type === "route" && RBY[selected.id]?.cat === "dart")) {
        highlightDartArea(null);
      }
    });
    map.on("movestart", () => {
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
      cur = null; queuedRoute = null; showLens(null); tipHide(true); if (panelView !== "directions") focusOff(); highlightStop(null);
    });
    map.on("dragstart", () => {
      if (locateMode !== "idle") {
        locateMode = "idle";
        const btn = $("#locateBtn");
        if (btn) {
          btn.classList.remove("active", "compass", "locating");
          btn.setAttribute("aria-label", "Find my location");
          btn.title = "Find my location";
        }
      }
    });
    map.on("click", (e) => {
      tipHide(true);
      closePopup(); showLens(null);
      if (dirActiveField) {
        handleMapClickForDirections(e.lngLat);
        return;
      }
      if (enabled.has("pois")) {
        const destHits = map.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], {
          layers: DESTINATION_LAYER_IDS.filter((l) => map.getLayer(l))
        });
        if (destHits.length) {
          const dObj = KEY_DESTINATIONS.find((k) => k.id === destHits[0].properties.id);
          if (dObj) {
            showDestination(dObj);
            return;
          }
        }
      }
      // a tap right on a station's circle opens the station, even with a train or bus on top of it
      const onStation = map.getLayer("stations") && map.getLayoutProperty("stations", "visibility") !== "none"
        ? map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: ["stations"] }) : [];
      if (onStation.length) { selectStop(onStation[0].properties.id, { fly: false }); return; }
      // A nearby badge must not steal a tap meant for the shared route band.
      const vehicle = nearest(vehAt(e.point, isNarrow() ? 12 : 8), e.point);
      const vehicleRadius = isNarrow() ? (selected?.type === "route" ? 22 : 14) : 10;
      const vh = vehicle && vehicle.d <= vehicleRadius ? [vehicle.f] : [];
      if (vh.length) {
        const v = live.vehicles.get(vh[0].properties.id), r = RBY[vh[0].properties.r];
        if (vh[0].properties.est && r) {
          openPopup(vh[0].geometry.coordinates, `<div class="pop"><h3>${esc(routeTitle(r))}</h3><p>${esc(r.name)}</p><p>Estimated position from the timetable${LIVE ? "" : " (live positions show on the website)"}.</p>${routeRows([r])}</div>`, "280px");
          return;
        }
        if (v && r) {
          const age = v.ts ? Math.max(0, Math.round(Date.now() / 1000 - v.ts)) : null;
          openPopup(vh[0].geometry.coordinates, `<div class="pop"><h3>${esc(routeTitle(r))}</h3><p>${esc(r.name)}</p>${vesselLine(v.id, "p")}<div class="vtrip-slot">${vehicleTripHTML(null, v.head)}</div><p class="vs-row">${vehicleLines(v.id, false)}</p>${v.label && !v.name ? `<p>Vehicle ${esc(v.label)}</p>` : ""}${routeRows([r])}</div>`, "280px");
          fillVehicleTrip(v.id, v.head);
          return;
        }
      }
      // a number on a route tag opens that route; "+3" lists the rest
      const tg = tagAt(e.point);
      if (tg) {
        showLens(null);
        if (tg.item.r != null) selectRoute(LINES[tg.item.r].id, { fit: true });
        else showCorridor(tg.item.more.map((i) => LINES[i]).sort(tagOrder));
        return;
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
        showCorridor(rs);
        focusRoutes(rs);
        return;
      }
      const trailsHit = map.queryRenderedFeatures([[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]], {
        layers: ["trail-pbl", "trail-greenway", "trail-lane", "trail-sharrow", "trail-dash"].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none")
      });
      if (trailsHit.length) {
        const tp = trailsHit[0].properties;
        const isUnpaved = tp.surface === "unpaved";
        const catName = tp.cat_name || "Bicycle Facility";
        const icon = tp.facility === "trail" ? "🚲" : tp.facility === "pbl" ? "🛡️" : tp.facility === "greenway" ? "🌿" : tp.facility === "lane" ? "🚲" : tp.facility === "sharrow" ? "🚴" : "🚲";
        const badgeColor = tp.facility === "pbl" || tp.facility === "trail" ? "#047857" : tp.facility === "greenway" ? "#10b981" : tp.facility === "lane" ? "#0891b2" : tp.facility === "sharrow" ? "#15803d" : "#b45309";
        const statusBadge = tp.status === "UNDERCONS" ? ` · <span class="incline-badge" style="background:#fbbf24;color:#78350f">Under Construction</span>` : "";
        const html = `<div class="pop">
          <div style="display:flex;align-items:center;gap:6px;margin:2px 0 6px">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;background:${badgeColor};color:#fff;padding:2px 8px;border-radius:6px">${esc(catName)}</span>
            ${statusBadge}
          </div>
          <h3 style="margin:0 0 4px">${icon} ${esc(tp.name)}</h3>
          <p class="trail-meta"><strong>${isUnpaved ? "Gravel / Unpaved Surface" : "Paved Surface"}</strong>${tp.length_mi ? ` · ${tp.length_mi} miles` : ""}${tp.region ? ` · ${esc(tp.region)}` : ""}</p>
          <p>${esc(tp.desc || "Seattle & Puget Sound bicycle network facility connecting transit hubs, neighborhoods, and commercial centers.")}</p>
          <p class="foot" style="margin-top:8px;font-size:11px;color:var(--muted)">City of Seattle SDOT & King County GIS Data</p>
        </div>`;
        openPopup(e.lngLat, html, "300px");
        return;
      }
      if (selected) {
        clearSelection();
        return;
      }
      const area = map.queryRenderedFeatures(e.point, { layers: ["flex-fill", "dart-fill", "access-fill"].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none") });
      if (area.length) {
        const f = area.find((a) => a.layer.id === "flex-fill") || area.find((a) => a.layer.id === "dart-fill") || area[0];
        if (f.layer.id === "dart-fill") highlightDartArea(f.properties.slug || f.properties.route);
        const html = f.layer.id === "flex-fill" ? flexHTML(f.properties) : f.layer.id === "dart-fill"
          ? `<div class="pop"><h3>Dial-a-Ride area · route ${esc(f.properties.route)}</h3><p>Inside this area the DART bus can leave its regular path to pick you up or drop you off. Ask King County Metro to arrange an off-route trip.</p>${f.properties.slug && RBY[f.properties.slug] ? routeRows([RBY[f.properties.slug]]) : ""}</div>`
          : `<div class="pop"><h3>Access paratransit (approximate)</h3><p>Access serves riders with disabilities who can't use fixed-route buses, within ¾ mile of Metro's regular routes while they run. Riders apply for eligibility and book trips ahead. This shading uses the ¾-mile rule around all-day routes.</p></div>`;
        openPopup(e.lngLat, html, "290px");
        return;
      }
      if (panelView === "corridor") {
        panelView = "home";
        corridorRoutes = [];
        focusOff();
        showHome();
        return;
      }
      clearSelection();
    });
    map.on("zoom", onZoom);
    map.on("moveend", onMoveEnd);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.target.closest("input")) return;
      if (popup) closePopup();
      else if (selected) clearSelection();
      else if (panelView !== "home") { panelView = "home"; focusOff(); showHome(); }
    });
  }
  // Hover. A line carrying one route: that route's whole path, drawn bold on top, with its stops.
  // A line carrying several: the stretch of street they share, bold, with the stops along it.
  // Nothing else on the map changes. Stops pop in once per line, not on every mouse move.
  let hoverKey = "", hoverTimer = 0, hoverRoutes = [];
  const withColor = (feats) => feats.map((f) => ({
    ...f,
    properties: {
      ...f.properties,
      c: (f.properties.r >= 0 && LINES[f.properties.r]) ? tagColor(LINES[f.properties.r]) : keyColor(f.properties.cat)
    }
  }));
  // each hover slot eases between hidden (0) and shown (1); shown lines are a little bolder
  // than their lines, and swell to that from their own width as they appear
  let hSlot = 0;
  const hAnim = HOVER_SLOTS.map(() => ({ v: 0, from: 0, to: 0, t0: 0, dur: 1, raf: 0 }));
  function hoverPaint(i) {
    if (ribbons) { map.triggerRepaint(); return; }
    const sl = HOVER_SLOTS[i], v = hAnim[i].v;
    if (!map.getLayer(`${sl}-line`)) return;
    if (map.getLayer(`${sl}-glow`)) map.setPaintProperty(`${sl}-glow`, "line-opacity", v * 0.45);
    map.setPaintProperty(`${sl}-case`, "line-opacity", v);
    map.setPaintProperty(`${sl}-line`, "line-opacity", Math.min(1, v * 1.4));
    map.setPaintProperty(`${sl}-arrows`, "icon-opacity", v);
  }
  function hoverFade(i, to, dur) {
    const A = hAnim[i];
    cancelAnimationFrame(A.raf);
    if (calm()) dur = 1;
    if (ribbons) map.setPaintProperty(`${HOVER_SLOTS[i]}-arrows`, "icon-opacity", to);
    Object.assign(A, { from: A.v, to, t0: performance.now(), dur });
    const frame = (now) => {
      const t = Math.max(0, Math.min(1, (now - A.t0) / A.dur));
      A.v = A.from + (A.to - A.from) * (1 - Math.pow(1 - t, 3));
      hoverPaint(i);
      if (t < 1) A.raf = requestAnimationFrame(frame);
      else if (A.to === 0 && map.getSource(HOVER_SLOTS[i])) { map.getSource(HOVER_SLOTS[i]).setData(fc([])); ribbons?.update(HOVER_SLOTS[i], []); }
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
    if (selected && selected.type === "route" && RBY[selected.id]?.cat === "dart") {
      highlightDartArea(selected.id);
    } else {
      highlightDartArea(null);
    }
  }
  // Hovering shows whole routes, never just a piece: the route whose strand is under the
  // pointer (or every boat on a crossing). It's drawn bold in its own lane, right over its line,
  // with its stops when there are only a few routes.
  function focusCorridor(f) {
    const key = `c:${f.properties.cat}:${f.properties.e}`;
    clearTimeout(hoverTimer);
    if (hoverKey === key) return;
    hoverKey = key; hoverRoutes = []; queuedRoute = null; hovStopsKey = "";
    if (!(selected && selected.type === "route" && RBY[selected.id]?.cat === "dart")) {
      highlightDartArea(null);
    }
    const line = { type: "Feature", properties: { ...f.properties, c: keyColor(f.properties.cat) }, geometry: f.geometry };
    const next = 1 - hSlot;
    map.getSource(HOVER_SLOTS[next]).setData(fc([line]));
    if (ribbons) ribbons.update(HOVER_SLOTS[next], KCTMRibbons.compile([line], { hover: true, widthScale: 1.12 }));
    hoverFade(hSlot, 0, 140); hoverFade(next, 1, 180); hSlot = next;
    map.getSource("hoverstops").setData(fc([]));
  }
  function focusRoutes(routes, again = false, { glow = true, widthScale = 1.85 } = {}) {
    routes = (routes || []).filter((r) => r && LINEIDX[r.id] != null);
    if (!routes.length) return;
    const dartR = routes.find((r) => r.cat === "dart");
    if (dartR) {
      highlightDartArea(dartR.id);
    } else if (!(selected && selected.type === "route" && RBY[selected.id]?.cat === "dart")) {
      highlightDartArea(null);
    }
    clearTimeout(hoverTimer);
    const key = "r:" + routes.map((r) => r.id).join(",") + (glow ? ":g" : "");
    if (key === hoverKey && !again) return;
    hoverKey = key;
    hoverRoutes = routes;
    requestRoutePaths(routes.map((r) => LINEIDX[r.id]), false, (feats, mesh) => {
      if (hoverKey !== key) return;
      const lines = withColor(feats);
      const drawing = (ribbons ? KCTMRibbons.compile(lines, { hover: true, glow, widthScale }) : null) || mesh;
      if (again) { map.getSource(HOVER_SLOTS[hSlot]).setData(fc(lines)); if (ribbons) ribbons.update(HOVER_SLOTS[hSlot], drawing); }
      else {
        const next = 1 - hSlot;
        map.getSource(HOVER_SLOTS[next]).setData(fc(lines));
        if (ribbons) ribbons.update(HOVER_SLOTS[next], drawing);
        hoverFade(hSlot, 0, 140);
        hoverFade(next, 1, 200);
        hSlot = next;
      }
      if (routes.length <= 4) {
        // stops of each route snap onto that route's own drawn line
        const all = [];
        for (const r of routes) {
          const own = lines.filter((f) => f.properties.r === LINEIDX[r.id]);
          all.push(...snapStops(stopFeatures([r], routes.length === 1), own, "route"));
        }
        map.getSource("hoverstops").setData(fc(mergeStops(all, lines)));
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
      const c = map.project(f.geometry.coordinates), left = c.x - L.w / 2, top = c.y - L.h / 2, dx = pt.x - left, dy = pt.y - top;
      if (dx < 0 || dx > L.w || dy < 0 || dy > L.h) continue;
      const item = L.axis === "y"
        ? (L.items.find((it) => dx >= it.x0 && dx < it.x1 && dy >= it.y0 && dy < it.y1) || L.items[L.items.length - 1])
        : (L.items.find((it) => dx >= it.x0 && dx < it.x1) || L.items[L.items.length - 1]);
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
    lens.style.top = rect.top + hit.top + (hit.L.axis === "y" ? (hit.item.y0 + hit.item.y1) / 2 : hit.L.h / 2) + "px";
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
  function applyHash(fromPop = false) {
    let h;
    try { h = decodeURIComponent((location.hash || "").slice(1)); } catch { return; }
    if (h.startsWith("route-") && RBY[h.slice(6)]) selectRoute(h.slice(6), { push: false });
    else if (/^(stop|station)-/.test(h) && stopIndex[h.replace(/^(stop|station)-/, "")]) selectStop(h.replace(/^(stop|station)-/, ""), { push: false });
    else if (h.startsWith("loc=")) {
      const parts = h.slice(4).replace("z", "").split(",");
      if (parts.length >= 2) {
        const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]), z = parseFloat(parts[2]) || 14.5;
        if (!isNaN(lat) && !isNaN(lon) && map) map.jumpTo({ center: [lon, lat], zoom: z });
      }
    }
    else if (!h && (selected || panelView !== "home")) clearSelection({ push: false });
  }

  function updateSubtitle() {
    const el = document.getElementById("mapSubtitle");
    if (!el) return;
    const now = new Date();
    const m = now.getMonth();
    const season = m >= 8 && m <= 10 ? "Fall" : m >= 5 && m <= 7 ? "Summer" : m >= 2 && m <= 4 ? "Spring" : "Winter";
    const year = now.getFullYear();
    el.textContent = `Every route and stop · ${season} ${year} service`;
  }

  function setupOfflineNotice() {
    function check() {
      const liveLine = $("#liveDesc");
      if (!navigator.onLine && liveLine) {
        liveLine.textContent = "Offline mode: viewing cached transit map & timetable";
      }
    }
    window.addEventListener("online", () => {
      showToast("Online: live updates resumed 🟢");
      updateLiveUI();
    });
    window.addEventListener("offline", () => {
      showToast("Offline mode: cached map & timetable available 📱");
      check();
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    registerProtocols();
    const getJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
    const [routes, net, stops, areas, manifest, live] = await Promise.all([
      getJSON("data/routes.json"), getJSON("data/network.json"), getJSON("data/stops.json"), getJSON("data/areas.json?v=20261106_sdot"),
      getJSON("tiles/manifest.json").catch(() => null), liveTiles(),
    ]);
    MANIFEST = manifest;
    META = routes.meta; ROUTES = routes.routes; STOPNAMES = routes.stopNames; NET = net; STOPS = stops; AREAS = areas;
    updateSubtitle();
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
          trails: { type: "geojson", data: (AREAS && AREAS.trails) || empty, tolerance: 0.5 },
          dart: { type: "geojson", data: AREAS.dart },
          darthl: { type: "geojson", data: empty },
          access: { type: "geojson", data: AREAS.access },
          flex: { type: "geojson", data: AREAS.flex },
          flexlabels: { type: "geojson", data: AREAS.flexLabels || empty },
          vehicles: { type: "geojson", data: empty },
          tripline: { type: "geojson", data: empty },
          tripwalk: { type: "geojson", data: empty },
          trippts: { type: "geojson", data: empty },
          destinations: { type: "geojson", data: destinationsGeoJSON() },
          mask: { type: "geojson", data: maskGeoJSON() },
        },
        layers: [...baseLayers(P), ...areaLayers(P), ...transitLayers(P), ...poiLayers(P), ...destLayers(P), ...stopLayers(P), ...tripLayers(P), ...liveLayers(P)],
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
      drawStats: () => ({ ...drawStats, renderer: ribbons ? "mesh" : "native", pending: !!(inFlight || queued || needsRebuild), ...(ribbons?.stats() || {}) }), routesAt, lineId: (i) => LINES[i]?.id,
      vehicleLines, vehicleOccupancy, occCode,
      obaStop, readDeparture, liveDepartures, depRowsHTML, depCache: () => depCache, stopCard, ensureDepartures,
      onLine, routeById: (id) => RBY[id],
      planner: { timetableTripTimes, planTransitTrip, currentVehWord, modeIcon, getSoonestBus },
      timetableTripTimes, planTransitTrip, currentVehWord,
      idle: () => new Promise((res) => { if (!inFlight && !queued && !needsRebuild) res(); else idleWaiters.push(res); }),
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
      // Native line layers remain as a fallback for a GPU/driver that rejects the shader.
      // The mesh needs no tile rebuilds for camera motion and uses a handful of draw calls.
      if (typeof KCTMRibbons !== "undefined" && !/[?&]noribbons\b/.test(location.search)) {
        const layer = KCTMRibbons.createLayer(() => ({ ...BASE[theme], dim: netDim, selected: !!(selected && selected.type === "route"), hover: hAnim.map((a) => a.v) }));
        try {
          map.addLayer(layer, transitLayers(BASE[theme])[0].id); ribbons = layer;
          for (const L of transitLayers(BASE[theme])) if (L.type === "line") map.setLayoutProperty(L.id, "visibility", "none");
        } catch (err) { if (map.getLayer(layer.id)) map.removeLayer(layer.id); }
      }
      map.on("webglcontextrestored", () => { ribbons?.restore(); rebuild(); });
      refreshStations();
      map.getSource("stops").setData(stopsGeoJSON());
      if (map.getSource("destinations")) map.getSource("destinations").setData(destinationsGeoJSON());
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
      pollAlerts();
      setupOfflineNotice();
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
  // ---------------------------------------------------------------- nearby departures & live hud
  function showNearbyDepartures(lng, lat) {
    panelView = "nearby";
    if (!STOPS) return;
    const allStops = [...(STOPS.stations || []), ...(STOPS.stops || [])];
    if (!allStops.length) return;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const candidateStops = allStops.map((s) => {
      const dx = (s.lon - lng) * 111320 * cosLat;
      const dy = (s.lat - lat) * 110540;
      const dist = Math.hypot(dx, dy);
      return { s, dist };
    }).filter((x) => x.dist <= 1200).sort((a, b) => a.dist - b.dist);

    const topStops = candidateStops.slice(0, 6);
    if (!topStops.length) {
      setView(`${backBtn}<div class="hero"><span class="stop-glyph big" aria-hidden="true"></span><div><h2>Nearby Departures</h2><p>No stops within 1.2 km</p></div></div>
        <p class="hint">You may be outside the Seattle regional transit network. Pan to Seattle, Bellevue, Tacoma, or Everett to view routes.</p>`);
      $("#back").addEventListener("click", () => { panelView = "home"; showHome(); openSheet("peek"); });
      openSheet("half");
      return;
    }

    const stopIds = topStops.flatMap((x) => stopIdsOf(x.s));
    ensureDepartures(stopIds, () => {
      if (panelView === "nearby") renderNearbyDepartures(topStops);
    });
    renderNearbyDepartures(topStops);
    openSheet("half");
  }

  function renderNearbyDepartures(topStops) {
    const cards = topStops.map(({ s, dist }) => {
      const m = Math.round(dist);
      const walkMin = Math.max(1, Math.round(m / 75));
      const rs = (s.routes || []).map((id) => RBY[id]).filter(Boolean).sort(tagOrder);
      const keys = [s.key, ...((s.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))];
      const sIds = stopIdsOf(s);
      const live = liveDepartures(sIds, 3), sched = nextDepartures(keys, 3);
      const list = (live && live.length) ? live : (sched && sched.length) ? sched : [];

      const bayMatch = s.name.match(/\bBay\s+([A-Z0-9]+)\b/i);
      const bayBadge = bayMatch ? `<span class="bay-pill">Bay ${esc(bayMatch[1])}</span>` : "";
      const cleanName = s.name.replace(/\s*-\s*Bay\s+[A-Z0-9]+/i, "").trim();

      let depsHTML = "";
      if (list.length) {
        depsHTML = `<div class="nearby-deps">${list.map((d) => {
          const to = d.live ? d.toName : placeName(d.to);
          const dot = d.live ? `<span class="sc-live" aria-hidden="true"></span>` : "";
          const tText = d.t < 60 ? "now" : `${Math.round(d.t / 60)} min`;
          return `<div class="nearby-dep-row press" data-route="${esc(d.r.id)}" role="button" tabindex="0" title="Highlight route ${esc(shortLabel(d.r))}">
            ${badgeHTML(d.r)}
            <span class="nearby-headsign">${esc(to)}</span>
            <span class="nearby-time${d.live ? " live" : ""}">${dot}${esc(tText)}</span>
          </div>`;
        }).join("")}</div>`;
      } else {
        depsHTML = `<div class="sc-badges">${rs.slice(0, 6).map((r) => `<span class="press" data-route="${esc(r.id)}" style="cursor:pointer" title="Highlight ${esc(shortLabel(r))}">${badgeHTML(r)}</span>`).join("")}</div>`;
      }

      return `<div class="nearby-card">
        <div class="nearby-card-head">
          <span class="nearby-stop-name press" data-stop="${esc(s.id)}" role="button" tabindex="0" title="Highlight stop on map">${esc(cleanName)}${bayBadge}</span>
          <span class="nearby-dist">🚶 ${walkMin} min · ${m} m</span>
        </div>
        ${depsHTML}
      </div>`;
    }).join("");

    const html = `${backBtn}
      <div class="hero">
        <span class="stop-glyph big" aria-hidden="true"></span>
        <div><h2>Departures Near You</h2><p>Closest transit stops</p></div>
      </div>
      <div class="nearby-list">${cards}</div>
      <p class="foot">Live countdowns update automatically from agency tracking.</p>`;

    setView(html);
    $("#back").addEventListener("click", () => { panelView = "home"; showHome(); openSheet("peek"); });
    for (const el of body().querySelectorAll("[data-stop]")) {
      el.addEventListener("click", () => selectStop(el.dataset.stop));
      previewStopOnHover(el);
    }
    for (const el of body().querySelectorAll("[data-route]")) {
      el.addEventListener("click", () => selectRoute(el.dataset.route));
      previewOnHover(el);
    }
  }

  function setupLiveHud() {
    const hud = $("#liveHud"), pop = $("#liveHudPop"), toggle = $("#hudLiveToggle");
    if (!hud) return;
    hud.addEventListener("click", (e) => {
      if (e.target.closest("#hudLiveToggle") || e.target.closest(".switch")) return;
      pop.hidden = !pop.hidden;
      hud.setAttribute("aria-expanded", String(!pop.hidden));
      updateLiveHudStats();
    });
    if (toggle) {
      toggle.checked = enabled.has("live");
      toggle.addEventListener("change", () => {
        if (toggle.checked) enabled.add("live"); else enabled.delete("live");
        store.set("layers2", [...enabled]);
        applyLayerToggles();
        updateLiveHud();
      });
    }
    document.addEventListener("click", (e) => {
      if (!hud.contains(e.target)) {
        pop.hidden = true;
        hud.setAttribute("aria-expanded", "false");
      }
    });
  }

  function updateLiveHudStats() {
    let onTime = 0, delayed = 0, late = 0;
    if (live && live.status) {
      for (const st of live.status.values()) {
        if (st.dev != null) {
          if (st.dev < 180) onTime++;
          else if (st.dev < 420) delayed++;
          else late++;
        }
      }
    }
    const statOn = $("#statOnTime"), statDl = $("#statDelayed"), statLt = $("#statLate");
    if (statOn) statOn.textContent = onTime ? `${onTime} on schedule (< 3m)` : "Fleet active (< 3m)";
    if (statDl) statDl.textContent = delayed ? `${delayed} delayed (3–7m)` : "0 delayed (3–7m)";
    if (statLt) statLt.textContent = late ? `${late} late (> 7m)` : "0 major delay (> 7m)";
  }

  function updateLiveHud() {
    const txt = $("#liveHudText");
    if (!txt) return;
    if (!enabled.has("live")) {
      txt.textContent = "Vehicles Off";
      $("#liveHud")?.classList.add("off");
      return;
    }
    $("#liveHud")?.classList.remove("off");
    const mode = vehMode();
    const liveCount = live.liveCount || 0;
    const estCount = live.estCount || 0;
    const count = live.count || 0;

    if (mode === "est" || (liveCount === 0 && estCount > 0)) {
      txt.textContent = count ? `${count} Sched (Timetable)` : "Timetable Fleet";
    } else if (liveCount > 0 && estCount > 0) {
      txt.textContent = `${liveCount} Live · ${estCount} Sched`;
    } else if (liveCount > 0) {
      txt.textContent = `${liveCount} Vehicles Live`;
    } else {
      txt.textContent = "Live Fleet";
    }
    updateLiveHudStats();
  }

  let locateMode = "idle"; // "idle" | "follow" | "compass"
  let watchId = null;
  let userCoords = null;
  let userMarker = null;
  let currentHeading = null;
  let orientationListening = false;

  function updateHeadingCone(heading) {
    if (heading == null || isNaN(heading)) return;
    currentHeading = heading;
    if (userMarker) {
      const el = userMarker.getElement();
      el.classList.add("has-heading");
      const cone = el.querySelector(".user-heading-cone");
      if (cone) cone.style.transform = `rotate(${heading}deg)`;
    }
    if (locateMode === "compass" && map) {
      map.setBearing(heading);
    }
  }

  function handleOrientation(e) {
    let heading = null;
    if (e.webkitCompassHeading != null) {
      heading = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha != null) {
      heading = (360 - e.alpha) % 360;
    } else if (e.alpha != null) {
      heading = (360 - e.alpha) % 360;
    }
    updateHeadingCone(heading);
  }

  function startOrientation() {
    if (orientationListening) return;
    orientationListening = true;
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then((res) => {
        if (res === "granted") {
          window.addEventListener("deviceorientation", handleOrientation, true);
        }
      }).catch(() => {});
    } else {
      window.addEventListener("deviceorientationabsolute", handleOrientation, true);
      window.addEventListener("deviceorientation", handleOrientation, true);
    }
  }

  function updateUserPosition(pos, isInitial = false) {
    const { longitude: lng, latitude: lat, heading } = pos.coords;
    userCoords = { lng, lat };
    if (heading != null && !isNaN(heading)) updateHeadingCone(heading);

    if (!userMarker) {
      const el = document.createElement("div");
      el.className = "user-marker";
      el.innerHTML = '<div class="user-heading-cone"></div><div class="user-marker-pulse"></div><div class="user-marker-dot"></div>';
      userMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
    } else {
      userMarker.setLngLat([lng, lat]);
    }

    if (locateMode === "follow" || locateMode === "compass") {
      if (map) {
        if (isInitial) {
          map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15.5), duration: 900, essential: true });
        } else {
          map.easeTo({ center: [lng, lat], duration: 500, essential: true });
        }
      }
    }

    if (isInitial && panelView !== "nearby") {
      showNearbyDepartures(lng, lat);
    }
  }

  function setupLocate() {
    const btn = $("#locateBtn");
    if (!btn) return;
    if (!navigator.geolocation) {
      btn.style.display = "none";
      return;
    }

    btn.addEventListener("click", () => {
      if (locateMode === "idle") {
        locateMode = "follow";
        btn.classList.add("locating");
        btn.classList.add("active");
        btn.classList.remove("compass");
        btn.setAttribute("aria-label", "Location: Following. Tap for compass heading");
        btn.title = "Location: Following";

        startOrientation();

        if (watchId == null) {
          watchId = navigator.geolocation.watchPosition(
            (pos) => {
              btn.classList.remove("locating");
              updateUserPosition(pos, !userCoords);
            },
            (err) => {
              btn.classList.remove("locating", "active", "compass");
              locateMode = "idle";
              if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
              const msg = err.code === 1 ? "Location permission denied" : "Could not determine location";
              showToast(msg);
            },
            { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 }
          );
        } else if (userCoords && map) {
          btn.classList.remove("locating");
          map.flyTo({ center: [userCoords.lng, userCoords.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 800, essential: true });
          showNearbyDepartures(userCoords.lng, userCoords.lat);
        }
      } else if (locateMode === "follow") {
        locateMode = "compass";
        btn.classList.add("compass");
        btn.setAttribute("aria-label", "Location: Compass lock. Tap to stop tracking");
        btn.title = "Location: Compass lock";
        startOrientation();
        if (currentHeading != null && map) {
          map.setBearing(currentHeading);
        }
      } else if (locateMode === "compass") {
        locateMode = "idle";
        btn.classList.remove("active", "compass", "locating");
        btn.setAttribute("aria-label", "Find my location");
        btn.title = "Find my location";
        if (map && map.getBearing() !== 0) {
          map.rotateTo(0, { duration: 400 });
        }
      }
    });
  }

  function setupChrome() {
    setupGlass();
    setupSheet();
    $("#zoomIn").addEventListener("click", () => map && map.zoomIn({ duration: 350 }));
    $("#zoomOut").addEventListener("click", () => map && map.zoomOut({ duration: 350 }));
    setupLocate();
    setupLiveHud();
    setupTripPlanner();
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
    window.addEventListener("popstate", () => applyHash(true));
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch(() => {});
      });
    }
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
