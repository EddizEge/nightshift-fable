/**
 * backdrop review round: main menu (near city facade) + zone stops at a fixed quality, one contact sheet.
 *   node tools/shot.mjs --page "index.html?debug&q=high" --script tools/scripts/backdrop-review.mjs --prefix backdrop-v1 --label backdrop
 * Options: --stops <s,...> (700,1500,2300,7500,7700)  --settle <ms> (2800)  --speed (45)  --q high
 * Logs mean brightness (0..255) of every frame.
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const stops = String(args.stops || '700,1500,2300,7500,7700').split(',').map(Number);
  const prefix = args.prefix || 'backdrop-v';
  const settle = Number(args.settle ?? 2800);
  const speed = Number(args.speed ?? 45);
  const sharp = (await import('sharp')).default;
  const mean = async (f) => {
    const st = await sharp(path.resolve(root, f)).stats();
    return (st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3).toFixed(1);
  };
  const q = args.q || 'high';
  await page.evaluate((q) => window.__NS.setQuality(q), q);
  await sleep(3000);
  const files = [];
  const menu = await shot(`screenshots/${prefix}-menu.png`);
  log(`menu mean=${await mean(menu)}`);
  files.push(menu);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate((sp) => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = sp; NS.game.player.grace = 1e6; }, speed);
  for (const s of stops) {
    await page.evaluate(([s, sp, q]) => { const NS = window.__NS; NS.setQuality(q); NS.teleport(s, 1.85, sp); }, [s, speed, q]);
    await sleep(settle);
    const st = await page.evaluate(() => window.__NS.stats());
    const f = await shot(`screenshots/${prefix}-${s}.png`);
    log(`s=${s} zone=${st.zone} q=${st.quality ?? '?'} calls=${st.calls} tris=${st.triangles} frameMs=${st.frameMs.toFixed(1)} mean=${await mean(f)}`);
    files.push(f);
  }
  const W = 800, H = 450, cols = 2;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(path.resolve(root, f)).resize(W, H).toBuffer()));
  await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  log(`sheet: screenshots/${prefix}-sheet.png`);
};
