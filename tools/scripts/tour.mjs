/**
 * Zone tour in the real game: start a run with the autopilot, teleport to each stop, wait, screenshot.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/tour.mjs --stops 700,1500,2300,3200,3600 --prefix tour
 * Options: --stops <s,s,...>  --prefix <name>  --settle <ms> (default 2600)  --speed <m/s> (default 45)
 *          --traffic 0 (no traffic)  --cam hood  --sheet 1 (also write screenshots/<prefix>-sheet.png)
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const stops = String(args.stops || '700,1500,2300,3200,3600').split(',').map(Number);
  const prefix = args.prefix || 'tour';
  const settle = Number(args.settle ?? 2600);
  const speed = Number(args.speed ?? 45);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate((sp) => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = sp; }, speed);
  if (args.cam === 'hood') await page.keyboard.press('KeyC');
  const files = [];
  for (const s of stops) {
    await page.evaluate(([s, sp, tr]) => { const NS = window.__NS; if (tr === '0') NS.game.trafficScale = 0; NS.teleport(s, 1.85, sp); }, [s, speed, String(args.traffic ?? '1')]);
    await sleep(settle);
    const st = await page.evaluate(() => window.__NS.stats());
    log(`s=${s} zone=${st.zone} state=${st.state} calls=${st.calls} tris=${st.triangles} frameMs=${st.frameMs.toFixed(1)} pr=${st.pixelRatio.toFixed(2)}`);
    files.push(await shot(`screenshots/${prefix}-${s}.png`));
    if (st.state !== 'playing') {
      await page.waitForFunction(() => window.__NS.game.state === 'gameover', null, { timeout: 15000 }).catch(() => {});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
      await page.evaluate(() => window.__NS.autopilot(true));
    }
  }
  if (args.sheet) {
    const sharp = (await import('sharp')).default;
    const cols = files.length > 4 ? 3 : 2;
    const w = 960, h = 540;
    const rows = Math.ceil(files.length / cols);
    const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
    await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } })
      .composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
      .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
    log(`saved screenshots/${prefix}-sheet.png`);
  }
};
