// Finds Playwright: a normal install (NODE_PATH or node_modules) first, then any npx cache on
// this machine (`npx playwright` keeps one under ~/.npm/_npx/<hash>/node_modules), so the tests
// don't depend on one computer's cache folder name.
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  const root = path.join(process.env.HOME || '', '.npm/_npx');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (e) { /* no npx cache */ }
  for (const d of dirs) {
    const p = path.join(root, d, 'node_modules/playwright');
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('Playwright not found: npm install playwright, or set NODE_PATH (see CLAUDE.md)');
}

module.exports = { loadPlaywright };
