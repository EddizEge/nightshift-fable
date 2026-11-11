/**
 * backdrop wave-3 check: review stops (like backdrop-review) + a verge close-up in the right lane + a
 * flicker pair (two frames 100 ms apart, car standing still) whose abs-diff image is saved.
 *   node tools/shot.mjs --page "index.html?debug&q=high" --script tools/scripts/backdrop-w3.mjs --prefix backdrop-w3b --label backdrop
 * Options: --stops <s,...> (700,1500,2300,7500,7700)  --verge <s> (7560)  --pair <s> (7620)
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const stops = String(args.stops || '700,1500,2300,7500,7700').split(',').map(Number);
  const prefix = args.prefix || 'backdrop-w3b';
  const sharp = (await import('sharp')).default;
  const P = (f) => path.resolve(root, f);
  const mean = async (f) => {
    const st = await sharp(P(f)).stats();
    return (st.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3).toFixed(1);
  };
  await page.evaluate(() => window.__NS.setQuality('high'));
  await sleep(3000);
  const files = [];
  const menu = await shot(`screenshots/${prefix}-menu.png`);
  log(`menu mean=${await mean(menu)}`);
  files.push(menu);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(() => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 45; NS.game.player.grace = 1e6; });
  for (const s of stops) {
    await page.evaluate(([s]) => { window.__NS.teleport(s, 1.85, 45); }, [s]);
    await sleep(2800);
    const st = await page.evaluate(() => window.__NS.stats());
    const f = await shot(`screenshots/${prefix}-${s}.png`);
    log(`s=${s} zone=${st.zone} calls=${st.calls} tris=${st.triangles} mean=${await mean(f)}`);
    files.push(f);
  }
  // Verge close-up: right lane, slow, no traffic.
  const vs = Number(args.verge ?? 7560);
  await page.evaluate(([s]) => { const NS = window.__NS; NS.game.trafficScale = 0; NS.game.autopilot.cruise = 6; NS.teleport(s, 5.55, 6); }, [vs]);
  await sleep(2500);
  files.push(await shot(`screenshots/${prefix}-verge.png`));
  // Flicker pair: standing still.
  const ps = Number(args.pair ?? 7620);
  await page.evaluate(([s]) => { const NS = window.__NS; NS.autopilot(false); NS.teleport(s, 1.85, 0); }, [ps]);
  await sleep(3000);
  const a = await shot(`screenshots/${prefix}-pairA.png`);
  await sleep(100);
  const b = await shot(`screenshots/${prefix}-pairB.png`);
  const [ra, rb] = await Promise.all([a, b].map((f) => sharp(P(f)).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  const { width, height } = ra.info;
  const d = Buffer.alloc(ra.data.length);
  let big = 0;
  for (let i = 0; i < d.length; i++) { const v = Math.abs(ra.data[i] - rb.data[i]); d[i] = Math.min(255, v * 4); if (v > 40) big++; }
  await sharp(d, { raw: { width, height, channels: 3 } }).png().toFile(P(`screenshots/${prefix}-pairdiff.png`));
  log(`pair diff: channels > 40 = ${big} (${((100 * big) / d.length).toFixed(3)} %)`);
  const W = 800, H = 450, cols = 2;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(P(f)).resize(W, H).toBuffer()));
  await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
    .png().toFile(P(`screenshots/${prefix}-sheet.png`));
  log(`sheet: screenshots/${prefix}-sheet.png`);
};
