/**
 * Weather review: tyre spray behind a truck / van in the real game (drive into its cloud, pass it),
 * plus a tunnel check (no spray when rainAt(s) = 0).
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/weather-truck.mjs --prefix weather-r7t --label weather
 * Options: --s <arc length> (default 900)  --type semi|boxtruck|van  --tunnel 3700  --cam hood
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const prefix = args.prefix || 'weather-truck';
  const s0 = Number(args.s ?? 900);
  const type = args.type || 'semi';
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  if (args.cam === 'hood') await page.keyboard.press('KeyC');
  const files = [];
  const scene = async (name, s, playerD, truckLane, gap, vp, vt, times) => {
    if ((await page.evaluate(() => window.__NS.game.state)) !== 'playing') {
      await page.waitForFunction(() => window.__NS.game.state === 'gameover', null, { timeout: 15000 }).catch(() => {});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
    }
    await page.evaluate(([s, d, lane, gap, vp, vt, type]) => {
      const NS = window.__NS;
      NS.autopilot(false);
      NS.ctx.traffic.setDensity(0);
      for (const v of [...NS.ctx.traffic.vehicles]) NS.ctx.traffic.remove(v);
      NS.teleport(s, d, vp);
      NS.ctx.traffic.spawn(type, s + gap, lane, vt, 'drive');
    }, [s, playerD, truckLane, gap, vp, vt, type]);
    let t = 0;
    for (const at of times) {
      await sleep(Math.max(0, at - t));
      t = at;
      const st = await page.evaluate(() => window.__NS.stats());
      log(`${name} t=${at} zone=${st.zone} state=${st.state} calls=${st.calls} frameMs=${st.frameMs.toFixed(1)}`);
      files.push(await shot(`screenshots/${prefix}-${name}-${at}.png`));
    }
  };
  // A: same lane, closing on the truck from 30 m (drive into its cloud)
  await scene('behind', s0, 1.85, 2, 26, 27, 25, [700, 2000, 3300]);
  // B: adjacent lane, passing it
  await scene('pass', s0 + 400, -1.85, 2, 10, 31, 24, [600, 1500, 2600]);
  // C: tunnel — dry road, no spray
  await scene('tunnel', Number(args.tunnel ?? 3700), 1.85, 2, 20, 29, 25, [1500]);
  const sharp = (await import('sharp')).default;
  const cols = 3, w = 960, h = 540;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
  await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  log(`saved screenshots/${prefix}-sheet.png`);
};
