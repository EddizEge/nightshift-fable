#!/usr/bin/env node
/**
 * Static-hosting check: serves ./dist with a plain file server (no Vite, no rewrites) under a
 * sub-path, the way Cloudflare Pages / any static host would, opens it in headless Chrome and
 * verifies that the game boots, every request succeeds and nothing leaves the origin.
 *
 *   npm run build && node tools/static-check.mjs [--base /games/nightshift/] [--shot screenshots/final/static.png]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
let base = arg('base', '/games/nightshift/');
if (!base.startsWith('/')) base = `/${base}`;
if (!base.endsWith('/')) base += '/';
const shotPath = arg('shot', null);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first');
  process.exit(2);
}

const served = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (!p.startsWith(base)) {
    res.writeHead(404).end('outside the base path');
    served.push([404, p]);
    return;
  }
  p = p.slice(base.length) || 'index.html';
  const file = path.join(dist, p);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    served.push([404, p]);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  served.push([200, p]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${origin}${base}index.html`;

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const problems = [];
const external = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => problems.push(`exception: ${e}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({ state: window.__NS.game.state, title: document.title, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120) }));
  if (info.state !== 'menu') problems.push(`state after boot is "${info.state}", expected "menu"`);
  // No diagnostics in normal play: the debug line must stay hidden without ?debug.
  const debugLine = () =>
    page.evaluate(() => {
      const el = document.querySelector('.ns-debug');
      if (!el) return 'absent';
      const cs = getComputedStyle(el);
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || el.getBoundingClientRect().height === 0 || !el.textContent.trim();
      return hidden ? 'hidden' : `VISIBLE: "${el.textContent.trim().slice(0, 60)}"`;
    });
  const dbgMenu = await debugLine();
  if (dbgMenu.startsWith('VISIBLE')) problems.push(`debug line in the menu without ?debug: ${dbgMenu}`);
  await page.getByRole('button', { name: /^play$/i }).first().click();
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  const st = await page.evaluate(() => window.__NS.stats());
  if (!(st.speedKmh > 60)) problems.push(`car did not accelerate (${st.speedKmh.toFixed(0)} km/h)`);
  const dbgDrive = await debugLine();
  if (dbgDrive.startsWith('VISIBLE')) problems.push(`debug line while driving without ?debug: ${dbgDrive}`);
  console.log(`[static] debug line without ?debug: menu ${dbgMenu}, driving ${dbgDrive}`);
  if (shotPath) await page.screenshot({ path: path.resolve(root, shotPath) });
  console.log(`[static] ${pageUrl}`);
  console.log(`[static] title "${info.title}" · menu text "${info.text}"`);
  console.log(`[static] after PLAY + W: ${st.speedKmh.toFixed(0)} km/h, ${st.calls} draw calls, quality ${st.quality}`);
} catch (e) {
  problems.push(`check failed: ${e}`);
} finally {
  await browser.close();
  server.close();
}
const ok = served.filter(([c]) => c === 200);
const bytes = ok.reduce((n, [, p]) => n + fs.statSync(path.join(dist, p)).size, 0);
console.log(`[static] ${ok.length} files served (${(bytes / 1e6).toFixed(1)} MB), ${served.length - ok.length} not found, ${external.length} external request(s)`);
for (const u of external) console.log(`[static] EXTERNAL ${u}`);
for (const p of problems) console.log(`[static] PROBLEM ${p}`);
console.log(problems.length || external.length ? '[static] FAIL' : '[static] PASS');
process.exit(problems.length || external.length ? 1 : 0);
