/**
 * Charred-wreck look in the REAL game (agent "wrecks").
 *   node tools/shot.mjs --label wrecks --page "index.html?debug" --script tools/scripts/wrecks-charred.mjs --mode rural --prefix wrecks-a-rural --timeout 150000
 * --mode rural   unlit rural stretch (s≈7500): player parked, a charred sedan (lane 1), an untouched sedan (lane 3, reference)
 *                and a charred tanker ahead; frames 1 / 5 / 20 / 45 s after charring
 *        escape  lastSecondEscape (grace 60): burst while the tanker falls / explodes, then park 6 m beside the burning
 *                wreck, frames 5 / 20 / 45 s after the explosion
 *        chain   chainReaction wrecks: burst after the first explosion, one frame 20 s later
 * Writes screenshots/<prefix>-NN.png and screenshots/<prefix>-sheet.png.
 */
import path from 'node:path';

export default async ({ page, sleep, log, args, root }) => {
  const sharp = (await import('sharp')).default;
  const mode = String(args.mode || 'rural');
  const prefix = String(args.prefix || `wrecks-${mode}`);
  const frames = []; // { buf, tag }
  const ev = (fn, a) => page.evaluate(fn, a);
  const grab = async (tag) => {
    frames.push({ buf: await page.screenshot({ type: 'png' }), tag });
    log('frame', frames.length, tag);
  };
  const waitUntil = async (t0, sec) => {
    const el = (Date.now() - t0) / 1000;
    if (el < sec) await sleep((sec - el) * 1000);
  };

  await ev(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 45000 });

  if (mode === 'rural') {
    const s = Number(args.s ?? 7500);
    await ev((s) => { const NS = window.__NS; NS.autopilot(false); NS.game.trafficScale = 0; NS.game.player.grace = 600; NS.teleport(s, 1.85, 0); }, s);
    await sleep(2500);
    const info = await ev(() => {
      const NS = window.__NS; const p = NS.ctx.player; const V = p.velocity.constructor;
      const a = NS.traffic.spawn('sedan', p.s + 11, 1, 0, 'scripted');
      const b = NS.traffic.spawn('sedan', p.s + 11, 3, 0, 'scripted');
      const t = NS.traffic.spawn('tanker', p.s + 30, 0, 0, 'scripted');
      if (a) NS.traffic.wreck(a, new V(0, 0, 0), new V(0, 0, 0));
      if (t) NS.traffic.wreck(t, new V(0, 0, 0), new V(0, 0, 0));
      window.__wr = { a, b, t };
      return `zone ${NS.world.zoneAt(p.s)} a ${!!a} b ${!!b} t ${!!t}`;
    });
    log('setup', info);
    await sleep(2000);
    await grab('uncharred');
    await ev(() => { const w = window.__wr; w.a?.visual.setCharred(1); w.t?.visual.setCharred(1); });
    const t0 = Date.now();
    for (const sec of [1, 5, 20, 45]) {
      await waitUntil(t0, sec);
      await grab(`charred +${sec}s`);
    }
  } else if (mode === 'escape') {
    await ev(() => { const NS = window.__NS; NS.game.trafficScale = 0; NS.teleport(400, 1.85, 22); NS.autopilot(true); NS.game.autopilot.cruise = 22; });
    await sleep(1500);
    log('trigger', await ev(() => { const NS = window.__NS; NS.game.player.grace = 60; return NS.trigger('lastSecondEscape'); }));
    await page.waitForFunction(() => !!window.__NS.game.director.bBody, null, { timeout: 40000, polling: 30 });
    for (let i = 0; i < 10; i++) {
      await grab(await ev(() => { const d = window.__NS.game.director; const b = d.bBody; const p = window.__NS.ctx.player.position; return `${d.bExploded ? 'exploded' : 'falling'} ${b ? Math.hypot(b.position.x - p.x, b.position.z - p.z).toFixed(0) : '?'}m`; }));
      await sleep(60);
    }
    await page.waitForFunction(() => window.__NS.game.director.bExploded === true, null, { timeout: 20000 });
    const t0 = Date.now();
    const park = () => ev(() => {
      const NS = window.__NS; const g = NS.game; const b = g.director.bBody;
      if (!b) return 'no body';
      const pr = NS.ctx.road.project(b.position.x, b.position.z, NS.ctx.player.s);
      g.autopilot.cruise = 0; NS.autopilot(false); g.player.grace = 60;
      // behind the wreck, 6 m gap between bumper and wreck, slightly offset so the camera sees its end and side
      // beside the wreck on the road side, ~6 m gap; orbit camera on the far side of the car, looking past it at the wreck
      const side = pr.d > 0 ? -1 : 1;
      const d = Math.max(-5.4, Math.min(5.4, pr.d + side * (Math.min(b.halfExtents.x, b.halfExtents.z) + 6 + 1)));
      g.placePlayer(pr.s - 3, d, 0);
      const p = NS.ctx.player.position;
      const a = Math.atan2(p.x - b.position.x, p.z - b.position.z) + 0.35;
      g.d.rig.setOrbit({ radius: 5.5, height: 1.9, speed: 0, angle: a, fov: 50, targetHeight: 1.2 });
      g.d.rig.setMode('orbit');
      g.d.rig.snap();
      return `wreck s ${pr.s.toFixed(1)} d ${pr.d.toFixed(2)} player d ${d.toFixed(2)} gap ${Math.hypot(p.x - b.position.x, p.z - b.position.z).toFixed(1)}m`;
    });
    await waitUntil(t0, 3.5);
    log('park', await park());
    for (const sec of [5, 20, 45]) {
      await waitUntil(t0, sec);
      await ev(() => { window.__NS.game.player.grace = 60; });
      await grab(`parked +${sec}s`);
    }
  } else if (mode === 'chain') {
    await ev(() => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 55; NS.game.autopilot.risk = 0.3; NS.teleport(1400, 1.85, 45); });
    await sleep(4000);
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      ok = await ev(() => { const NS = window.__NS; NS.game.player.grace = 60; return NS.trigger('chainReaction'); });
      if (!ok) await sleep(800);
    }
    log('trigger', ok);
    await page.waitForFunction(() => window.__NS.game.director.fires.length > 0, null, { timeout: 60000, polling: 50 });
    const t0 = Date.now();
    await grab('chain explosion');
    await sleep(1200);
    // park beside the first charred wreck (wrecks live in the crash world), orbit camera looking past the car at it
    const where = await ev(() => {
      const NS = window.__NS; const g = NS.game;
      const b = NS.crash.bodies.find((x) => x.owner?.visual?.u?.uLamps2.value.z > 0);
      if (!b) return 'none';
      const pos = b.position;
      const pr = NS.ctx.road.project(pos.x, pos.z, NS.ctx.player.s);
      g.autopilot.cruise = 0; NS.autopilot(false); g.player.grace = 60;
      g.placePlayer(pr.s - 2, Math.max(-5.4, Math.min(5.4, pr.d > 0 ? pr.d - 6 : pr.d + 6)), 0);
      const p = NS.ctx.player.position;
      g.d.rig.setOrbit({ radius: 5, height: 1.7, speed: 0, angle: Math.atan2(p.x - pos.x, p.z - pos.z) + 0.3, fov: 50, targetHeight: 0.9 });
      g.d.rig.setMode('orbit');
      g.d.rig.snap();
      return `${b.owner.type} s ${pr.s.toFixed(1)} d ${pr.d.toFixed(2)}`;
    });
    log('park', where);
    for (const sec of [3, 8, 20]) {
      await waitUntil(t0, sec);
      await grab(`chain parked +${sec}s`);
    }
  }

  const tw = 400, th = 225, cols = Math.min(5, frames.length);
  for (let i = 0; i < frames.length; i++) await sharp(frames[i].buf).toFile(path.resolve(root, `screenshots/${prefix}-${String(i + 1).padStart(2, '0')}.png`));
  const tiles = await Promise.all(frames.map((fr, i) => sharp(fr.buf).resize(tw, th).composite([{ input: Buffer.from(`<svg width="${tw}" height="18"><rect width="${tw}" height="18" fill="black" opacity="0.6"/><text x="4" y="13" font-size="12" fill="white" font-family="monospace">${i + 1} ${fr.tag}</text></svg>`), left: 0, top: 0 }]).toBuffer()));
  const rows = Math.ceil(frames.length / cols);
  await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  log(`saved screenshots/${prefix}-sheet.png`);
};
