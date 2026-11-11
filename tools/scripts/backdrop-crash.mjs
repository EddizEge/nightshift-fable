/**
 * backdrop: provoke a run-ending crash (chain reaction ahead, autopilot off, full throttle) and shoot the
 * crash / game-over cameras, to judge the roadside band.  --s <start s> (default 560)  --prefix <name>
 */
export default async ({ page, shot, sleep, log, args }) => {
  const s0 = Number(args.s ?? 560);
  const prefix = args.prefix || 'backdrop-crash';
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(([s]) => { const NS = window.__NS; NS.autopilot(false); NS.teleport(s, 5.55, 50); }, [s0]);
  await sleep(600);
  await page.evaluate(() => window.__NS.trigger('chainReaction'));
  await page.keyboard.down('ArrowUp');
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < 14000) {
    await sleep(500);
    st = await page.evaluate(() => window.__NS.game.state);
    if (st !== 'playing') break;
  }
  await page.keyboard.up('ArrowUp');
  log(`state after drive: ${st}`);
  await sleep(1200);
  await shot(`screenshots/${prefix}-1.png`);
  await sleep(3500);
  await shot(`screenshots/${prefix}-2.png`);
};
