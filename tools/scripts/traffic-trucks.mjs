/**
 * Traffic module check in the real game (agent "traffic"):
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/traffic-trucks.mjs --label traffic
 * 1. reloads with a console listener and reports any "[traffic] missing model" warnings,
 * 2. per truck type: spawns it next to / ahead of the player (chase camera) and screenshots it,
 * 3. measures draw calls / triangles with 0 vs N vehicles of each type,
 * 4. spawns a tanker, chars it and screenshots the wreck; then triggers 'chainReaction' and screenshots it.
 * Options: --at <s> (default 700)  --speed <m/s> (default 30)
 */
export default async ({ page, shot, sleep, log, args }) => {
  const warns = [];
  page.on('console', (m) => { if (m.text().includes('[traffic]')) warns.push(m.text()); });
  await page.reload();
  await page.waitForFunction(() => !!window.__NS, null, { timeout: 30000 });
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 20000 });
  log(`traffic warnings: ${warns.length ? warns.join(' | ') : 'none'}`);
  const at = Number(args.at ?? 700);
  const sp = Number(args.speed ?? 30);
  const reset = async (s) => {
    await page.evaluate(([s, sp]) => {
      const NS = window.__NS;
      NS.autopilot(true);
      NS.game.autopilot.cruise = sp;
      NS.ctx.traffic.setDensity(0);
      NS.teleport(s, 1.85, sp);
    }, [s, sp]);
    await sleep(1500);
  };
  const stats = () => page.evaluate(() => { const st = window.__NS.stats(); return { calls: st.calls, tris: st.triangles, ms: st.frameMs, zone: st.zone }; });
  const spawn = (type, ds, lane, dv = 0, n = 1, gap = 0) => page.evaluate(([type, ds, lane, dv, n, gap, sp]) => {
    const NS = window.__NS;
    const ps = NS.game.player.state.s;
    let ok = 0;
    for (let i = 0; i < n; i++) if (NS.ctx.traffic.spawn(type, ps + ds + i * gap, lane, sp + dv)) ok++;
    return ok;
  }, [type, ds, lane, dv, n, gap, sp]);

  // cost per type (vehicles ahead in view, < 120 m so LOD0)
  for (const type of ['sedan', 'boxtruck', 'semi', 'tanker']) {
    await reset(at);
    const a = await stats();
    const n = await spawn(type, 30, 2, 0, 4, 22);
    await sleep(1200);
    const b = await stats();
    log(`cost ${type}: n=${n} dCalls=${b.calls - a.calls} dTris=${b.tris - a.tris} per vehicle calls=${((b.calls - a.calls) / Math.max(1, n)).toFixed(1)} tris=${Math.round((b.tris - a.tris) / Math.max(1, n))} frameMs ${a.ms.toFixed(1)}->${b.ms.toFixed(1)}`);
  }
  // chase-camera shots: truck one lane over, slightly ahead
  for (const type of ['boxtruck', 'semi', 'tanker']) {
    await reset(at);
    await spawn(type, type === 'boxtruck' ? 12 : 16, 2, 0);
    await sleep(1800);
    await shot(`screenshots/traffic-game-${type}.png`);
  }
  // tail lamps from 150 m and headlamps of oncoming-direction view are covered by the tour; here: far tanker
  await reset(at);
  await spawn('tanker', 150, 1, 0);
  await sleep(1500);
  await shot('screenshots/traffic-game-far150.png');
  // charred wreck
  await reset(at);
  await page.evaluate(() => {
    const NS = window.__NS;
    const ps = NS.game.player.state.s;
    const v = NS.ctx.traffic.spawn('tanker', ps + 18, 2, 30);
    v?.visual.setCharred(1);
    const c = NS.ctx.traffic.spawn('sedan', ps + 40, 0, 30);
    c?.visual.setCharred(1);
  });
  await sleep(1500);
  await shot('screenshots/traffic-game-charred.png');
  // scripted set piece
  await reset(at);
  await page.evaluate(() => { window.__NS.ctx.traffic.setDensity(8); window.__NS.trigger('chainReaction'); });
  for (const t of [3500, 3000, 3000]) {
    await sleep(t);
    const st = await stats();
    log(`chain zone=${st.zone} calls=${st.calls} tris=${st.tris}`);
    await shot(`screenshots/traffic-game-chain-${t}.png`);
  }
  log(`traffic warnings (final): ${warns.length}`);
};
