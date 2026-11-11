/**
 * backdrop wave-4 check: rural verge (chase camera at 7500 / 7700 in the right lane, then a crash at --cs
 * with the high crash camera, frames through the explosion) + the city / industrial / bridge stops.
 * Each frame gets the mean RGB of a verge crop (--verge [x,y,w,h]) and is tiled into <prefix>-sheet.png.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/backdrop-w4.mjs --label backdrop --prefix backdrop-w4a
 * --stops 7500,7700 (chase)  --tour 700,1500,2300  --cs 7480 (crash s)  --diag 1 (toggle lighting terms in the crash frame)
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const prefix = args.prefix || 'backdrop-w4a';
  const sharp = (await import('sharp')).default;
  const P = (f) => path.resolve(root, f);
  const ev = (fn, a) => page.evaluate(fn, a);
  const crop = async (f, [left, top, width, height]) => {
    const buf = await sharp(P(f)).extract({ left, top, width, height }).toBuffer();
    const st = await sharp(buf).stats();
    return st.channels.slice(0, 3).map((c) => c.mean.toFixed(1)).join('/');
  };
  const files = [];
  const snap = async (name, cr) => {
    const f = await shot(`screenshots/${prefix}-${name}.png`);
    const st = await ev(() => window.__NS.stats());
    let m = '';
    for (const [k, c] of Object.entries(cr || {})) m += ` ${k}=${await crop(f, c)}`;
    log(`${name}: zone=${st.zone} tris=${st.triangles} calls=${st.calls}${m}`);
    files.push(f);
    return f;
  };
  await ev(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 30000 });
  await ev(() => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 30; NS.game.player.grace = 1e6; });
  const chaseCrop = { verge: [1250, 445, 300, 50], road: [880, 560, 300, 80] };
  for (const s of String(args.stops || '7500,7700').split(',').filter(Boolean).map(Number)) {
    await ev(([s]) => window.__NS.teleport(s, 5.55, 30), [s]);
    await sleep(2800);
    await snap(`chase-${s}`, chaseCrop);
  }
  for (const s of String(args.tour ?? '700,1500,2300').split(',').filter(Boolean).map(Number)) {
    await ev(([s]) => window.__NS.teleport(s, 5.55, 30), [s]);
    await sleep(2800);
    await snap(`tour-${s}`, chaseCrop);
  }
  // Crash in the right lane: high crash camera looks down on the right verge.
  const cs = Number(args.cs ?? 7480);
  let crashed = false;
  for (let a = 0; a < 4 && !crashed; a++) {
    await ev(([s]) => { const NS = window.__NS; NS.autopilot(false); NS.game.player.grace = 0; NS.game.trafficScale = 0; NS.teleport(s, 5.55, 60); }, [cs + a * 250]);
    await page.keyboard.down('KeyW');
    await sleep(400);
    await ev(() => { const NS = window.__NS; const p = NS.ctx.player; return !!NS.traffic.spawn('sedan', p.s + 75, 3, 9, 'scripted'); });
    crashed = await page.waitForFunction(() => ['crashed', 'gameover'].includes(window.__NS.game.state), null, { timeout: 8000 }).then(() => true, () => false);
  }
  await page.keyboard.up('KeyW');
  log(`crashed=${crashed}`);
  const crashCrop = { verge: JSON.parse(args.cverge || '[1150,420,300,120]') };
  const times = String(args.times || '300,900,1600,2600,4000').split(',').map(Number);
  let t0 = Date.now();
  for (let i = 0; i < times.length; i++) {
    const w = times[i] - (Date.now() - t0);
    if (w > 0) await sleep(w);
    await snap(`crash-${i}`, crashCrop);
  }
  const W = 640, H = 360, cols = 3;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(P(f)).resize(W, H).toBuffer()));
  await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
    .png().toFile(P(`screenshots/${prefix}-sheet.png`));
  log(`sheet: screenshots/${prefix}-sheet.png`);
};
