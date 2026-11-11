/**
 * Reliable high-speed player crash for VFX checks (agent "vfx"): the target is spawned close ahead
 * in the player's lane right after a teleport at --kmh (default 205), so the impact speed stays
 * near the set speed; burst of frames through impact → detonation → fire.
 *   node tools/shot.mjs --label vfx --page "index.html?debug" --script tools/scripts/vfx-crash.mjs --s 7500 --prefix vfx-r4-rural --timeout 120000
 * --n frames (32) --every ms (90) --skip frames to drop before the burst is kept (0) --q quality --noflash (mute lighting flashes)
 */
import path from 'node:path';

export default async ({ page, sleep, log, args, root }) => {
  const sharp = (await import('sharp')).default;
  const prefix = String(args.prefix || 'vfx-crash');
  const N = Number(args.n ?? 32);
  const every = Number(args.every ?? 90);
  const ev = (fn, a) => page.evaluate(fn, a);
  await ev(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 45000 });
  if (args.q) {
    await ev((q) => window.__NS.setQuality(q), String(args.q));
    await sleep(1200);
  }
  if (args.noflash) await ev(() => { window.__NS.ctx.lighting.flash = () => {}; });
  const s = Number(args.s ?? 7500);
  const v = Number(args.kmh ?? 205) / 3.6;
  await ev(([s, v]) => {
    const NS = window.__NS;
    NS.autopilot(false);
    NS.game.trafficScale = 0;
    NS.teleport(s, 1.85, v);
    NS.game.player.grace = 0; // the teleport's spawn protection would let the car pass through
    NS.traffic.spawn('sedan', s + 50, 1.85, 6, 'scripted');
    // hold the speed until the impact (the gearbox would otherwise brake the teleported car)
    const sim = NS.game.player.sim;
    const hold = () => {
      if (NS.game.state !== 'playing') return;
      sim.vx = Math.sin(sim.heading) * v;
      sim.vz = -Math.cos(sim.heading) * v;
      requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  }, [s, v]);
  await page.keyboard.down('KeyW');
  const ok = await page.waitForFunction(() => ['crashed', 'gameover'].includes(window.__NS.game.state), null, { timeout: 6000, polling: 16 }).then(() => true, () => false);
  await page.keyboard.up('KeyW');
  // --slow k: stretch the detonation window (crash clock 0.36–0.62 s) to k× time so the burst catches its first frames
  if (args.slow) await ev((k) => {
    const g = window.__NS.game;
    const f = () => {
      if (g.state !== 'crashed') return;
      if (g.crashClock > 0.4 && g.crashClock < 0.6) g.timeScale = k;
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }, Number(args.slow));
  log('crashed', ok, JSON.stringify(await ev(() => { const i = window.__NS.game.crashInfo; return i ? { speed: +(i.speed * 3.6).toFixed(0), zone: window.__NS.world.zoneAt(window.__NS.ctx.player.s) } : null; })));
  const frames = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const tag = await ev(() => { const g = window.__NS.game; return `t${(g.crashClock ?? 0).toFixed(2)} ${g.crashExploded ? 'X' : ''}`; });
    frames.push({ buf: await page.screenshot({ type: 'jpeg', quality: 88 }), tag });
    const el = Date.now() - t0;
    if (el < every) await sleep(every - el);
  }
  const tw = 320, th = 180, cols = 6;
  for (let i = 0; i < frames.length; i++) await sharp(frames[i].buf).png().toFile(path.resolve(root, `screenshots/${prefix}-${String(i + 1).padStart(2, '0')}.png`));
  const tiles = await Promise.all(frames.map((f, i) => sharp(f.buf).resize(tw, th).composite([{ input: Buffer.from(`<svg width="${tw}" height="16"><rect width="${tw}" height="16" opacity="0.5"/><text x="4" y="12" font-size="12" fill="yellow" font-family="monospace">${i + 1} ${f.tag}</text></svg>`), left: 0, top: 0 }]).toBuffer()));
  await sharp({ create: { width: cols * tw, height: Math.ceil(frames.length / cols) * th, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  log(`saved screenshots/${prefix}-sheet.png`);
  // --track: attached fire vs the wreck over 90 frames of the slow-motion shot: per-frame motion of the
  // physics pose (steps), the drawn pose and the flame base (should follow the drawn pose every frame)
  if (args.track) {
    await page.waitForFunction(() => window.__NS.game.crashExploded === true, null, { timeout: 10000, polling: 16 });
    await sleep(100);
    const r = await ev(() => new Promise((res) => {
      const NS = window.__NS;
      const v = NS.vfx;
      const body = NS.game.player.wreckBody;
      const fire = v.fires.find((f) => f.active && f.target === body);
      if (!body || !fire) return res('no fire / body');
      const rows = [];
      let prev = null;
      let k = 0;
      const tick = () => {
        const o = body.object;
        const cur = { p: body.position.clone(), o: o.position.clone(), b: fire.base.clone() };
        if (prev) rows.push([cur.p.distanceTo(prev.p), cur.o.distanceTo(prev.o), cur.b.distanceTo(prev.b), Math.hypot(cur.b.x - cur.o.x, cur.b.z - cur.o.z)]);
        prev = cur;
        if (++k < 90) requestAnimationFrame(tick);
        else res(rows);
      };
      requestAnimationFrame(tick);
    }));
    if (typeof r === 'string') log('track', r);
    else {
      const still = (i) => r.filter((x) => x[i] < 1e-5).length;
      const moving = r.filter((x) => x[1] > 1e-3);
      const mis = moving.filter((x) => x[2] < 1e-5).length;
      log(`track ${r.length} frames: physics pose static in ${still(0)}, drawn pose static in ${still(1)}, flame base static in ${still(2)}; frames where the wreck is drawn moving but the flame base stands still: ${mis}/${moving.length}; max horizontal base↔object offset ${Math.max(...r.map((x) => x[3])).toFixed(2)} m`);
    }
  }
};
