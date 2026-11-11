/**
 * Weather review in the real game: rain / spray / lens at several speeds and both cameras.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/weather-speeds.mjs --prefix weather-r6 --label weather
 * Options: --s <arc length> (default 640, city)  --kmh 0,100,180,280  --cams chase,hood
 *          --settle <ms> (default 1800)  --lens 0 (disable lens rain)  --traffic 0  --sheet 0
 *          --hide rainStreaks,rainSplashes,tyreSpray (hide weather meshes by name)
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const prefix = args.prefix || 'weather-r6';
  const s0 = Number(args.s ?? 640);
  const kmhs = String(args.kmh ?? '0,100,180,280').split(',').map(Number);
  const cams = String(args.cams ?? 'chase,hood').split(',');
  const settle = Number(args.settle ?? 1800);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(([lens, tr, hide]) => {
    const NS = window.__NS;
    if (lens === '0') for (const e of NS.ctx.weather.distortionEffects) e.enabled = false;
    if (tr === '0') NS.ctx.traffic?.setDensity(0);
    if (hide) {
      const names = hide.split(',');
      NS.ctx.engine.scene.traverse((o) => { if (names.includes(o.name)) o.material.visible = false; });
    }
  }, [String(args.lens ?? '1'), String(args.traffic ?? '1'), String(args.hide ?? '')]);
  const files = [];
  for (const cam of cams) {
    await page.evaluate((c) => { const r = window.__NS.ctx.cameraRig; if (r && r.mode !== c) r.setMode(c); }, cam);
    for (const kmh of kmhs) {
      const v = kmh / 3.6;
      await page.evaluate(([s, v]) => {
        const NS = window.__NS;
        NS.autopilot(v > 0.5);
        if (v > 0.5) NS.game.autopilot.cruise = v;
        NS.teleport(s, 1.85, v);
      }, [s0, v]);
      await sleep(settle);
      const st = await page.evaluate(() => window.__NS.stats());
      log(`${cam} ${kmh} km/h: s=${st.s?.toFixed?.(0)} zone=${st.zone} state=${st.state} calls=${st.calls} tris=${st.triangles} frameMs=${st.frameMs.toFixed(1)} pr=${st.pixelRatio.toFixed(2)}`);
      files.push(await shot(`screenshots/${prefix}-${cam}-${kmh}.png`));
    }
  }
  if (args.lightning === '1') {
    // the backdrop emits 'lightning' on its own schedule; emit one here to check the rain's response
    await page.evaluate(() => window.__NS.ctx.events.emit('lightning', { intensity: 1 }));
    await sleep(40);
    await shot(`screenshots/${prefix}-lightning.png`);
  }
  if (args.sheet !== '0') {
    const sharp = (await import('sharp')).default;
    const cols = kmhs.length;
    const w = 960, h = 540;
    const rows = Math.ceil(files.length / cols);
    const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
    await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } })
      .composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
      .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
    log(`saved screenshots/${prefix}-sheet.png`);
  }
};
