#!/usr/bin/env node
/**
 * NIGHTSHIFT browser harness: starts an in-process Vite dev server (or uses --url / --dist),
 * opens a page in headless system Chrome (real GPU through ANGLE/D3D11), optionally drives it,
 * captures screenshots and reports console errors.
 *
 * Usage:
 *   node tools/shot.mjs --page "sandbox/car.html?paint=1" --out screenshots/car.png
 *   node tools/shot.mjs --page "index.html?autostart=1" --script tools/scripts/run.mjs
 *
 * Options:
 *   --page <path?query>   Page relative to the project root (default index.html)
 *   --url <url>           Use an already running server instead of starting Vite
 *   --dist                Serve ./dist with `vite preview` instead of the dev server
 *   --out <file.png>      Screenshot path (default screenshots/shot.png). With --shots N: file-01.png ...
 *   --size <WxH>          Viewport (default 1600x900)
 *   --wait <js-expr>      Wait until the expression is truthy (default "window.__ready === true"); "none" to skip
 *   --delay <ms>          Extra wait before the first screenshot (default 500)
 *   --shots <n>           Number of screenshots (default 1)  --interval <ms> between them (default 1000)
 *   --eval <js>           JS evaluated in the page before the screenshots (may be async / return a value, printed)
 *   --script <file.mjs>   Module exporting default async ({ page, shot, sleep, log, baseUrl }) => {...} for full control
 *   --label <name>        Separate Vite cache dir per caller (use your agent name when running concurrently)
 *   --timeout <ms>        Overall wait timeout (default 60000)
 *   --headed              Show the browser window (default headless)
 *   --keep-open <ms>      Keep the page open this long after the last screenshot
 *   --allow-errors        Exit 0 even if the page logged errors
 *
 * Exit code 1 if the page threw / logged console errors (unless --allow-errors).
 */
import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true;
    else {
      o[key] = next;
      i++;
    }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const pagePath = args.page || 'index.html';
const out = path.resolve(root, args.out || 'screenshots/shot.png');
const [vw, vh] = String(args.size || '1600x900').split('x').map(Number);
const waitExpr = args.wait === undefined ? 'window.__ready === true' : args.wait;
const delay = Number(args.delay ?? 500);
const shots = Number(args.shots ?? 1);
const interval = Number(args.interval ?? 1000);
const timeout = Number(args.timeout ?? 60000);
const label = String(args.label || 'main').replace(/[^a-z0-9_-]/gi, '');

try {
  os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  /* best effort */
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[shot]', ...a);

let server = null;
let baseUrl = args.url;
if (!baseUrl) {
  if (args.dist) {
    server = await preview({ root, preview: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'warn' });
    baseUrl = server.resolvedUrls.local[0];
  } else {
    server = await createServer({
      root,
      cacheDir: path.join(root, 'node_modules', `.vite-${label}`),
      server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
      logLevel: 'warn',
    });
    await server.listen();
    baseUrl = server.resolvedUrls.local[0];
  }
}
if (!baseUrl.endsWith('/')) baseUrl += '/';

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || 'chrome',
  headless: !args.headed,
  args: [
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(args['no-vsync'] ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  ],
});

const errors = [];
let exitCode = 0;
try {
  const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error' && /Failed to load resource/.test(text)) {
      /* reported with its URL by the response handler */
    } else if (t === 'error') {
      errors.push(text);
      console.log('[page:error]', text);
    } else if (t === 'warning') {
      if (!/GL Driver Message|GPU stall|WEBGL_debug_renderer_info is deprecated/.test(text)) console.log('[page:warn]', text.slice(0, 500));
    } else if (args.verbose || /^\[ns\]/.test(text)) {
      console.log('[page]', text.slice(0, 800));
    }
  });
  page.on('pageerror', (e) => {
    errors.push(String(e));
    console.log('[page:exception]', String(e), e.stack ? '\n' + e.stack.split('\n').slice(0, 6).join('\n') : '');
  });
  page.on('requestfailed', (r) => {
    const f = r.failure();
    if (f && !/ERR_ABORTED/.test(f.errorText)) console.log('[page:requestfailed]', r.url(), f.errorText);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) {
      errors.push(`HTTP ${r.status()} ${r.url()}`);
      console.log('[page:http]', r.status(), r.url());
    }
  });

  const url = baseUrl + pagePath.replace(/^\//, '');
  log('open', url);
  await page.goto(url, { waitUntil: 'load', timeout });

  let n = 0;
  const shot = async (file) => {
    const f = path.resolve(root, file || out);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    await page.screenshot({ path: f, type: f.endsWith('.jpg') ? 'jpeg' : 'png' });
    n++;
    log('saved', path.relative(root, f));
    return f;
  };

  if (waitExpr && waitExpr !== 'none') {
    await page.waitForFunction(waitExpr, null, { timeout, polling: 100 });
  }

  if (args.script) {
    const mod = await import(pathToFileURL(path.resolve(root, args.script)).href);
    await mod.default({ page, shot, sleep, log, baseUrl, args, root });
  } else {
    if (args.eval) {
      const r = await page.evaluate(`(async () => { ${args.eval} })()`);
      if (r !== undefined) log('eval →', typeof r === 'string' ? r : JSON.stringify(r));
    }
    await sleep(delay);
    for (let i = 0; i < shots; i++) {
      const f = shots > 1 ? out.replace(/(\.\w+)$/, `-${String(i + 1).padStart(2, '0')}$1`) : out;
      await shot(f);
      if (i < shots - 1) await sleep(interval);
    }
  }
  if (args['keep-open']) await sleep(Number(args['keep-open']));
  if (errors.length && !args['allow-errors']) {
    log(`${errors.length} page error(s)`);
    exitCode = 1;
  } else {
    log(`done, ${n} screenshot(s), ${errors.length} page error(s)`);
  }
} catch (e) {
  console.error('[shot] FAILED:', e && e.message ? e.message : e);
  exitCode = 2;
} finally {
  await browser.close().catch(() => {});
  if (server) await (server.close ? server.close() : server.httpServer?.close());
}
process.exit(exitCode);
