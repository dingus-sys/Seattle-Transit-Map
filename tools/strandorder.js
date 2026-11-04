// Runs the geometry engine in node on the real network and prints how many strand swaps there are at junctions.
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/strandorder.js)
const ROOT = require('path').resolve(__dirname, '..');
const fs = require('fs');
const src = fs.readFileSync(ROOT + '/web/geom.js', 'utf8');
const KCTMGeom = new Function(src + '; return KCTMGeom;')();
const net = JSON.parse(fs.readFileSync(ROOT + '/site/data/network.json'));
let R = JSON.parse(fs.readFileSync(ROOT + '/site/data/routes.json')); R = R.routes || R;
const by = new Map(R.map((r) => [r.id, r]));
const app = fs.readFileSync(ROOT + '/web/app.js', 'utf8');
const CAT = new Function(app.slice(app.indexOf('  const CAT = {'), app.indexOf('  const VKEY')) + '; return CAT;')();
const dk = (r) => (r.cat === 'link' ? (r.label === '1' ? 'link1' : r.label === 'T' ? 'linkT' : 'link2') : r.cat);
const lines = net.lines.map((id, i) => ({ cat: dk(by.get(id) || { cat: 'local' }), rank: i }));
const t = Date.now();
const eng = KCTMGeom.createEngine({ edges: net.edges, lines, cat: CAT, gap: 0 });
console.log('strand swaps at junctions', JSON.stringify(eng.strandStats), 'init ms', Date.now() - t);
