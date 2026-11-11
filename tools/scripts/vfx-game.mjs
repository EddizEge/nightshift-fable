/**
 * VFX checks in the REAL game (agent "vfx").
 *   node tools/shot.mjs --label vfx --page "index.html?debug" --script tools/scripts/vfx-game.mjs --mode smoke --prefix vfx-g-smoke
 * --mode smoke | wisps | fire | nitro | explosion | chain | sparks
 * --s <arc length> (default 600)  --at <m ahead> (explosion default 60, fire 14, smoke 0)  --scale <n>
 * --times <s,s,...> seconds after the trigger to screenshot   --traffic 0   --cam hood   --orbit 1 (crash cam)
 * Writes screenshots/<prefix>-<i>.png and screenshots/<prefix>-sheet.png (3 columns).
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const mode = String(args.mode || 'smoke');
  const prefix = String(args.prefix || `vfx-g-${mode}`);
  const s = Number(args.s ?? 600);
  const times = String(args.times || (mode === 'explosion' ? '0.12,0.5,1.2,3,6,11' : mode === 'nitro' ? '0.05,0.4,1.5' : '0.4,1.2,3')).split(',').map(Number);
  const scale = Number(args.scale ?? (mode === 'explosion' ? 1.1 : mode === 'fire' ? 1.0 : 1.4));
  const at = Number(args.at ?? (mode === 'explosion' ? 60 : mode === 'fire' ? 14 : mode === 'smoke' ? 2 : 0));
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  if (mode === 'perf') {
    // GPU cost of a tanker explosion + two wreck fires, parked, per quality level
    for (const q of String(args.levels || 'high,low').split(',')) {
      await page.evaluate((q) => { const NS = window.__NS; NS.setQuality(q); NS.autopilot(false); NS.teleport(600, 1.85, 0); NS.ctx.traffic?.setDensity(0); }, q);
      await sleep(4000);
      const sample = async (ms) => page.evaluate(async (ms) => {
        const out = []; const t0 = performance.now();
        while (performance.now() - t0 < ms) { await new Promise((r) => requestAnimationFrame(r)); const s = window.__NS.stats(); out.push([s.gpuMs ?? 0, s.calls, s.frameMs, s.pixelRatio]); }
        const g = out.map((o) => o[0]).sort((a, b) => a - b);
        return { series: out.slice(0, 40).map((o) => o[0].toFixed(1) + '/' + o[2].toFixed(0)).join(' '), avg: g.reduce((a, b) => a + b, 0) / g.length, p95: g[Math.floor(g.length * 0.95)], max: g[g.length - 1], calls: Math.max(...out.map((o) => o[1])), pr: out[out.length - 1][3], n: g.length, vfx: window.__NS.ctx.vfx.stats?.() };
      }, ms);
      const idle = await sample(1500);
      await page.evaluate(() => {
        const { ctx } = window.__NS; const pl = ctx.player; const h = pl.heading;
        const P = pl.position.clone(); P.x += Math.sin(h) * 60; P.z -= Math.cos(h) * 60; P.y = 0.7;
        ctx.vfx.explosion(P, { scale: 2.5, smoke: 14, debris: true });
        const A = P.clone(); A.x += 4; A.y = 0.5; const B = P.clone(); B.x -= 4; B.z += 6; B.y = 0.5;
        window.__pf = [ctx.vfx.attachFire({ position: A }, 1.0, 30), ctx.vfx.attachFire({ position: B }, 2.1, 30)];
      });
      const fx = await sample(3500);
      const tail = await sample(3000);
      if (args.series) log(`[${q}] fx series gpu/frame ms: ${fx.series}`);
      log(`[${q}] idle gpu avg ${idle.avg.toFixed(2)} max ${idle.max.toFixed(2)} calls ${idle.calls} pr ${idle.pr.toFixed(2)} | fx 0-3.5s gpu avg ${fx.avg.toFixed(2)} p95 ${fx.p95.toFixed(2)} max ${fx.max.toFixed(2)} calls ${fx.calls} peakPuffs ${fx.vfx?.peakPuffs} peakSparks ${fx.vfx?.peakSparks} cpu ${fx.vfx?.cpuMs.toFixed(2)} | 3.5-6.5s gpu avg ${tail.avg.toFixed(2)} max ${tail.max.toFixed(2)} calls ${tail.calls}`);
      if (args.shot) await shot(`screenshots/${prefix}-${q}.png`);
      await page.evaluate(() => { for (const f of window.__pf) f.stop(); window.__NS.ctx.vfx.reset(); });
    }
    return;
  }
  if (mode === 'crash') {
    // real crash: flat out with nitro, no steering, until we hit something; then the crash sequence
    await page.evaluate(() => window.__NS.autopilot(false));
    await sleep(1500);
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(() => ['crashed', 'gameover'].includes(window.__NS.game.state), null, { timeout: 90000 });
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    const files = [];
    const ct = String(args.times || '0.3,0.9,1.6,2.6,4,6.5').split(',').map(Number);
    let last = 0;
    for (const t of ct) {
      await sleep(Math.max(0, (t - last) * 1000));
      last = t;
      const st = await page.evaluate(() => ({ ...window.__NS.stats(), vfx: window.__NS.ctx.vfx.stats?.() }));
      log(`t=${t} state=${st.state} calls=${st.calls} ms=${st.frameMs.toFixed(1)} pr=${st.pixelRatio.toFixed(2)} puffs=${st.vfx?.puffs} sparks=${st.vfx?.sparks} fires=${st.vfx?.fires}`);
      files.push(await shot(`screenshots/${prefix}-${files.length + 1}.png`));
    }
    const sharp = (await import('sharp')).default;
    const w = 960, h = 540, cols = 3, rows = Math.ceil(files.length / cols);
    const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
    await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } })
      .composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
      .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
    log(`saved screenshots/${prefix}-sheet.png`);
    return;
  }
  const moving = mode === 'nitro' || mode === 'wisps' || mode === 'sparks' || mode === 'chain';
  const speed = Number(args.speed ?? (moving ? 42 : 0));
  await page.evaluate(([s, sp, tr, mv, d]) => {
    const NS = window.__NS;
    NS.autopilot(mv);
    if (mv) NS.game.autopilot.cruise = sp;
    NS.teleport(s, d, sp);
    if (tr === '0') NS.ctx.traffic?.setDensity(0);
  }, [s, speed, String(args.traffic ?? (mode === 'chain' ? '1' : '0')), moving, Number(args.d ?? (mode === 'sparks' ? 5.0 : 1.85))]);
  if (args.cam === 'hood') await page.keyboard.press('KeyC');
  await sleep(Number(args.settle ?? 2500));
  if (args.q) {
    await page.evaluate((q) => window.__NS.setQuality(q), String(args.q));
    await sleep(1500);
  }
  if (mode === 'explosion' && args.parkfar) {
    // nothing
  }
  // trigger
  const slow = Number(args.slow ?? 1);
  const t0 = await page.evaluate(([mode, scale, at, lat, slow]) => {
    const NS = window.__NS;
    const { ctx } = NS;
    const pl = ctx.player;
    const h = pl.heading;
    const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const P = pl.position.clone();
    P.x += fx * at + rx * lat;
    P.z += fz * at + rz * lat;
    const V = P.clone().set(0, 0, 0);
    window.__vfxT = performance.now();
    window.__slow = slow;
    if (slow < 1 && !ctx.vfx.__patched) { const o = ctx.vfx.update.bind(ctx.vfx); ctx.vfx.update = (dt, tt) => o(dt * window.__slow, tt); ctx.vfx.__patched = true; }
    if (mode === 'smoke') {
      P.y = 0.6;
      ctx.vfx.smokePuff(P, V.set(fx * 13, 0, fz * 13), scale);
    } else if (mode === 'fire') {
      P.y = 0.5;
      window.__fires = [ctx.vfx.attachFire({ position: P }, scale, 60)];
      const P2 = P.clone();
      P2.x += fx * 9 + rx * -5;
      P2.z += fz * 9 + rz * -5;
      window.__fires.push(ctx.vfx.attachFire({ position: P2 }, Number(new URLSearchParams(location.search).get('s2') || 2.1), 60));
    } else if (mode === 'explosion') {
      P.y = 0.7;
      ctx.vfx.explosion(P, { scale, smoke: 14, debris: true });
    } else if (mode === 'chain') {
      return NS.trigger('chainReaction');
    } else if (mode === 'nitro') {
      ctx.vfx.setNitro(true, 1);
    } else if (mode === 'wisps') {
      window.__wisp = setInterval(() => {
        const q = pl.position.clone();
        q.x += fx * 1.6;
        q.z += fz * 1.6;
        q.y = 0.75;
        ctx.vfx.smokePuff(q, q.clone().set(fx * pl.speed * 0.6, 0, fz * pl.speed * 0.6), 0.35 + 0.4 * 1.2 * Number(window.__wispK ?? 1));
      }, 90);
    } else if (mode === 'sparks') {
      window.__spk = setInterval(() => {
        const q = pl.position.clone();
        q.x += rx * 1.0 + fx * 0.5;
        q.z += rz * 1.0 + fz * 0.5;
        q.y = 0.45;
        const n = q.clone().set(-rx, 0.35, -rz);
        ctx.vfx.sparks(q, n, Math.round(18 + 70 * 0.5), 7 + 42 * 0.7);
      }, 70);
    }
    return 0;
  }, [mode, scale, at, Number(args.lat ?? 0), slow]);
  log('trigger result', t0);
  const files = [];
  let last = 0;
  for (const t of times) {
    const el0 = await page.evaluate(() => (performance.now() - window.__vfxT) / 1000 * window.__slow);
    await sleep(Math.max(0, (t - el0) * 1000 / slow));
    last = t;
    if (mode === 'nitro' && args.off && t >= Number(args.off)) await page.evaluate(() => window.__NS.ctx.vfx.setNitro(false, 0));
    const st = await page.evaluate(() => ({ ...window.__NS.stats(), vfx: window.__NS.ctx.vfx.stats?.(), el: (performance.now() - window.__vfxT) / 1000 * window.__slow }));
    log(`t=${t} el=${st.el.toFixed(2)} state=${st.state} calls=${st.calls} tris=${st.triangles} ms=${st.frameMs.toFixed(1)} pr=${st.pixelRatio.toFixed(2)} vfx=${JSON.stringify(st.vfx)}`);
    files.push(await shot(`screenshots/${prefix}-${files.length + 1}.png`));
  }
  await page.evaluate(() => { clearInterval(window.__wisp); clearInterval(window.__spk); });
  const sharp = (await import('sharp')).default;
  const cols = Math.min(3, files.length);
  const w = Number(args.tw ?? 960), h = Math.round(w * 9 / 16);
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
  await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  log(`saved screenshots/${prefix}-sheet.png`);
};
