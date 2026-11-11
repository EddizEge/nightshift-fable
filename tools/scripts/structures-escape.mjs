/**
 * "Last-Second Escape" check at each authored overpass (real game).
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/structures-escape.mjs --label structures
 * Options: --ops 770,2970,4510  --times 1.8,3.0,3.7,4.3 (s after trigger)  --d 1.85  --prefix structures-esc
 *          --cam hood  --traffic 0
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const ops = String(args.ops || '770,2970,4510').split(',').map(Number);
  const times = String(args.times || '1.8,3.0,3.7,4.3').split(',').map(Number);
  const prefix = args.prefix || 'structures-esc';
  const d = Number(args.d ?? 1.85);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(() => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 45; });
  if (args.cam === 'hood') await page.keyboard.press('KeyC');
  // Stand-in for the requested director hook: tear the railing when the tanker breaks through.
  await page.evaluate(async () => {
    const st = await import('/src/world/features/structures/index.ts');
    const NS = window.__NS;
    NS.ctx.events.on('cinematic', (e) => {
      if (e.id === 'lastSecondEscape' && e.phase === 'start') {
        const dir = NS.game.director ?? NS.ctx.director;
        const side = dir?.bSide ?? (NS.ctx.player.d > 0 ? 1 : -1);
        const s = dir?.overpassS ?? NS.ctx.world.nextOverpass(NS.ctx.player.s);
        console.log('[ns] break railing', s, side, st.breakOverpassRailing(s, side));
      }
    });
  });
  const files = [];
  for (const s of ops) {
    if ((await page.evaluate(() => window.__NS.game.state)) !== 'playing') {
      await page.waitForFunction(() => window.__NS.game.state === 'gameover', null, { timeout: 15000 }).catch(() => {});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
      await page.evaluate(() => window.__NS.autopilot(true));
    }
    await page.evaluate(([s, d, tr]) => { const NS = window.__NS; NS.teleport(s - 260, d, 45); if (tr === '0') NS.ctx.traffic?.setDensity(0); }, [s, d, String(args.traffic ?? '1')]);
    await sleep(1200);
    const ok = await page.evaluate(() => window.__NS.trigger('lastSecondEscape'));
    const nx = await page.evaluate((s) => [window.__NS.ctx.world.nextOverpass(s - 300), window.__NS.ctx.world.nextOverpass(s - 30), window.__NS.ctx.player.s.toFixed(0)], s);
    log(`op=${s} trigger=${ok} next=${nx}`);
    const t0 = Date.now();
    for (const t of times) {
      const wait = t * 1000 - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      const st = await page.evaluate(() => window.__NS.stats());
      log(`op=${s} t=${t} s=${st.s?.toFixed?.(0)} calls=${st.calls} tris=${st.triangles} pr=${st.pixelRatio?.toFixed?.(2)}`);
      files.push(await shot(`screenshots/${prefix}-${s}-${t}.png`));
    }
    await page.waitForFunction(() => { const d = window.__NS.game.director; return !d || d.phase === 'idle' || window.__NS.game.state !== 'playing'; }, null, { timeout: 20000 }).catch(() => log('director still busy'));
  }
  const sharp = (await import('sharp')).default;
  const cols = times.length;
  const w = 720, h = 405;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
  await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  log(`saved screenshots/${prefix}-sheet.png`);
};
