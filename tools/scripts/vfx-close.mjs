/**
 * Close-range VFX checks in the REAL game (agent "vfx"): camera close to / inside explosions, fires.
 *   node tools/shot.mjs --label vfx --page "index.html?debug" --script tools/scripts/vfx-close.mjs --mode crash --prefix vfx-c-crash --timeout 120000
 * --mode crash   200 km/h into a car (rural, s≈7400), burst of frames through the crash camera sequence
 *        escape  lastSecondEscape with grace 60, pass the tanker close, then park ~4 m from the burning wreck
 *        chain   chainReaction, drive through the gap
 * --every <ms> burst interval (real time, default 150)  --n <frames> (default 36)  --tw <tile width> (default 320)
 * --s <arc length>  --q <low|medium|high|ultra>
 * Every frame gets a "flatness" metric (luminance std-dev and mean local gradient on a 160×90 copy,
 * HUD margins cropped); the flattest frames are listed and the sheet + frames are written to
 * screenshots/<prefix>-sheet.png / <prefix>-NN.png.
 */
import fs from 'node:fs';
import path from 'node:path';

export default async ({ page, sleep, log, args, root }) => {
  const sharp = (await import('sharp')).default;
  const mode = String(args.mode || 'crash');
  const prefix = String(args.prefix || `vfx-c-${mode}`);
  const every = Number(args.every ?? 150);
  const N = Number(args.n ?? 36);
  const tw = Number(args.tw ?? 320);
  const frames = []; // { buf, tag }
  const ev = (fn, a) => page.evaluate(fn, a);

  const grab = async (tag) => {
    const buf = await page.screenshot({ type: 'jpeg', quality: 88 });
    frames.push({ buf, tag });
  };
  const burst = async (n, tagf) => {
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const tag = await ev(tagf || (() => window.__NS.game.state));
      await grab(tag);
      const el = Date.now() - t0;
      if (el < every) await sleep(every - el);
    }
  };

  await ev(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 45000 });
  if (args.q) {
    await ev((q) => window.__NS.setQuality(q), String(args.q));
    await sleep(1200);
  }

  if (mode === 'crash') {
    const s = Number(args.s ?? 7400);
    let crashed = false;
    for (let attempt = 0; attempt < 4 && !crashed; attempt++) {
      await ev((s) => { const NS = window.__NS; NS.autopilot(false); NS.game.trafficScale = 0; NS.teleport(s, 1.85, 57); }, s + attempt * 300);
      await page.keyboard.down('KeyW');
      await sleep(400);
      const ok = await ev(() => { const NS = window.__NS; const p = NS.ctx.player; return !!NS.traffic.spawn('sedan', p.s + 75, 2, 9, 'scripted'); });
      log('spawned target', ok);
      crashed = await page.waitForFunction(() => ['crashed', 'gameover'].includes(window.__NS.game.state), null, { timeout: 8000 }).then(() => true, () => false);
    }
    await page.keyboard.up('KeyW');
    log('crash at', JSON.stringify(await ev(() => ({ kmh: window.__NS.stats().speedKmh, s: window.__NS.stats().s }))));
    await burst(N, () => { const NS = window.__NS; const c = NS.engine.camera.position; const p = NS.ctx.player.position; return `${NS.game.state} cam-car ${Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z).toFixed(1)}m pr ${NS.stats().pixelRatio.toFixed(2)}`; });
  } else if (mode === 'escape') {
    const s = Number(args.s ?? 380);
    await ev((s) => { const NS = window.__NS; NS.game.trafficScale = 0; NS.teleport(s, 1.85, 30); NS.autopilot(true); NS.game.autopilot.cruise = 30; }, s);
    await sleep(1500);
    const ok = await ev(() => { const NS = window.__NS; NS.game.player.grace = 60; return NS.trigger('lastSecondEscape'); });
    log('trigger', ok);
    await page.waitForFunction(() => window.__NS.game.director.bExploded === true, null, { timeout: 40000 });
    // pass as close as the road allows: hug the wreck's side
    await burst(Math.round(N * 0.45), () => { const NS = window.__NS; const b = NS.game.director.bBody; const p = NS.ctx.player.position; const c = NS.engine.camera.position; return b ? `pass car-wreck ${Math.hypot(b.position.x - p.x, b.position.z - p.z).toFixed(1)}m cam-wreck ${Math.hypot(b.position.x - c.x, b.position.z - c.z).toFixed(1)}m` : 'pass'; });
    // park ~4 m from the burning wreck: behind it, then beside it
    for (const [k, where] of [[0, 'behind'], [1, 'beside']]) {
      const info = await ev(([k]) => {
        const NS = window.__NS; const g = NS.game; const b = g.director.bBody;
        if (!b) return 'no body';
        const pr = NS.ctx.road.project(b.position.x, b.position.z, NS.ctx.player.s);
        const half = Math.max(b.halfExtents.x, b.halfExtents.z);
        g.autopilot.cruise = 0; NS.autopilot(false);
        if (k === 0) g.placePlayer(pr.s - half - 4 - 2.3, pr.d, 0);
        else g.placePlayer(pr.s, pr.d + (pr.d > 0 ? -1 : 1) * (Math.min(b.halfExtents.x, b.halfExtents.z) + 4 + 1), 0);
        g.d.rig.snap();
        return `wreck s ${pr.s.toFixed(1)} d ${pr.d.toFixed(2)} half ${half.toFixed(1)}`;
      }, [k]);
      log(where, info);
      await sleep(1200);
      await burst(Math.round(N * 0.275), () => { const NS = window.__NS; const b = NS.game.director.bBody; const c = NS.engine.camera.position; return b ? `park cam-wreck ${Math.hypot(b.position.x - c.x, b.position.z - c.z).toFixed(1)}m` : 'park'; });
    }
  } else if (mode === 'chain') {
    const s = Number(args.s ?? 1400);
    await ev((s) => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 55; NS.game.autopilot.risk = 0.3; NS.teleport(s, 1.85, 45); }, s);
    await sleep(4000);
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      ok = await ev(() => { const NS = window.__NS; NS.game.player.grace = 60; return NS.trigger('chainReaction'); });
      if (!ok) await sleep(800);
    }
    log('trigger', ok);
    let hit = false;
    for (let i = 0; i < 30 && !hit; i++) {
      hit = await page.waitForFunction(() => window.__NS.ctx.vfx.stats().explosions > 0 || window.__NS.game.director.fires.length > 0, null, { timeout: 3000, polling: 50 }).then(() => true, () => false);
      if (!hit) log('waiting', JSON.stringify(await ev(() => { const NS = window.__NS; const d = NS.game.director; return { ph: d.phase, act: d.active, s: NS.stats().s | 0, kmh: NS.stats().speedKmh | 0, tk: d.tanker ? (d.tanker.s - NS.ctx.player.s) | 0 : null }; })));
    }
    await burst(N, () => { const NS = window.__NS; return `${NS.game.state} ${NS.stats().speedKmh.toFixed(0)}kmh`; });
  }

  // ── analysis + sheet ──
  const res = [];
  for (let i = 0; i < frames.length; i++) {
    const { data, info } = await sharp(frames[i].buf).extract({ left: 160, top: 120, width: 1280, height: 640 }).resize(160, 80).raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, C = info.channels;
    const L = new Float32Array(W * H);
    let m = 0, rg = 0;
    for (let k = 0; k < W * H; k++) {
      const r = data[k * C], g = data[k * C + 1], b = data[k * C + 2];
      L[k] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      m += L[k];
      rg += r - g;
    }
    m /= W * H;
    rg /= W * H;
    let v = 0, grad = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x;
      v += (L[k] - m) ** 2;
      if (x + 1 < W && y + 1 < H) grad += Math.abs(L[k + 1] - L[k]) + Math.abs(L[k + W] - L[k]);
    }
    res.push({ i, std: Math.sqrt(v / (W * H)), grad: grad / ((W - 1) * (H - 1)), mean: m, rg, tag: frames[i].tag });
  }
  const files = [];
  for (let i = 0; i < frames.length; i++) {
    const f = path.resolve(root, `screenshots/${prefix}-${String(i + 1).padStart(2, '0')}.png`);
    if (!args.nosave) await sharp(frames[i].buf).png().toFile(f);
    files.push(f);
  }
  const cols = Number(args.cols ?? 6);
  const th = Math.round((tw * 9) / 16);
  const rows = Math.ceil(frames.length / cols);
  const tiles = await Promise.all(frames.map((fr, i) => sharp(fr.buf).resize(tw, th).composite([{ input: Buffer.from(`<svg width="${tw}" height="18"><rect width="${tw}" height="18" fill="black" opacity="0.6"/><text x="4" y="13" font-size="12" fill="white" font-family="monospace">${i + 1} std ${res[i].std.toFixed(0)} g ${res[i].grad.toFixed(1)}</text></svg>`), left: 0, top: 0 }]).toBuffer()));
  await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  for (const r of res) log(`#${r.i + 1} std ${r.std.toFixed(1)} grad ${r.grad.toFixed(2)} mean ${r.mean.toFixed(0)} r-g ${r.rg.toFixed(0)} | ${r.tag}`);
  const worst = [...res].sort((a, b) => a.std + a.grad * 4 - (b.std + b.grad * 4))[0];
  log(`flattest frame #${worst.i + 1} (std ${worst.std.toFixed(1)} grad ${worst.grad.toFixed(2)}) → ${path.relative(root, files[worst.i])}`);
  log(`saved screenshots/${prefix}-sheet.png`);
  void fs;
};
