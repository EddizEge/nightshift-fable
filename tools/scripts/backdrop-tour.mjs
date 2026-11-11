/**
 * backdrop review driver: zone stops (+ the first rural stretch found with world.zoneAt), stats per stop,
 * then a crash into the right guardrail for the crash / game-over camera. Writes <prefix>-sheet.png.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/backdrop-tour.mjs --prefix backdrop-g1 --label backdrop
 * Options: --stops <s,...> (default 700,1500,2300,3000,4400)  --speed <m/s> (45)  --settle <ms> (2600)
 *          --traffic 0  --crash 0 (skip)  --crashS <s> (default 640)
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const stops = String(args.stops || '700,1500,2300,3000,4400').split(',').map(Number);
  const prefix = args.prefix || 'backdrop-tour';
  const settle = Number(args.settle ?? 2600);
  const speed = Number(args.speed ?? 45);
  const rural = await page.evaluate(() => {
    const w = window.__NS.world;
    for (let s = 5000; s <= 12000; s += 55) if (w.zoneAt(s) === 'rural' && w.zoneAt(s + 300) === 'rural') return s + 150;
    return null;
  });
  log(`rural stretch at s=${rural}`);
  if (rural !== null && !args.stops) stops.push(rural);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate((sp) => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = sp; }, speed);
  const files = [];
  for (const s of stops) {
    await page.evaluate(([s, sp, tr]) => { const NS = window.__NS; NS.teleport(s, 1.85, sp); if (tr === '0') NS.ctx.traffic?.setDensity(0); }, [s, speed, String(args.traffic ?? '1')]);
    await sleep(settle);
    const st = await page.evaluate(() => window.__NS.stats());
    log(`s=${s} zone=${st.zone} calls=${st.calls} tris=${st.triangles} frameMs=${st.frameMs.toFixed(1)} pr=${st.pixelRatio.toFixed(2)}`);
    files.push(await shot(`screenshots/${prefix}-${s}.png`));
  }
  if (args.crash !== '0') {
    const cs = Number(args.crashS ?? 640);
    await page.evaluate(([s]) => { const NS = window.__NS; NS.teleport(s, 5.5, 55); NS.autopilot(false); }, [cs]);
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ArrowRight');
    await sleep(2500);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowUp');
    await sleep(3500);
    const st = await page.evaluate(() => window.__NS.stats());
    log(`crash: state=${st.state} s=${st.s ?? '?'} zone=${st.zone}`);
    files.push(await shot(`screenshots/${prefix}-crash.png`));
  }
  if (files.length) {
    const sharp = (await import('sharp')).default;
    const W = 800, H = 450, cols = 2;
    const rows = Math.ceil(files.length / cols);
    const tiles = await Promise.all(files.map((f) => sharp(path.resolve(root, f)).resize(W, H).toBuffer()));
    await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: '#000' } })
      .composite(tiles.map((input, i) => ({ input, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
      .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
    log(`sheet: screenshots/${prefix}-sheet.png`);
  }
};
