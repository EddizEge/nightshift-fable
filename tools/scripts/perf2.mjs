// Reflection / probe cost experiments (HIGH, 1080p).
export default async ({ page, sleep, log, args }) => {
  const secs = Number(args.secs ?? 5);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(() => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 45; NS.game.autopilot.risk = 0; NS.setQuality('high'); });
  await sleep(3000);
  const measure = async (label) => {
    const r = await page.evaluate(async (secs) => {
      const NS = window.__NS; let n = 0, gpu = 0, calls = 0, tris = 0, sum = 0; let last = performance.now(); const t0 = last;
      await new Promise((res) => { const tick = () => { const now = performance.now(); const s = NS.stats(); if (s.state === 'gameover') NS.start(); n++; sum += now - last; last = now; gpu += s.gpuMs; calls += s.calls; tris += s.triangles; if (now - t0 < secs * 1000) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
      return { ms: sum / n, gpu: gpu / n, calls: Math.round(calls / n), tris: Math.round(tris / n / 1000) };
    }, secs);
    log(`${label.padEnd(44)} interval ${r.ms.toFixed(2)} ms · gpu ${r.gpu.toFixed(2)} ms · calls ${r.calls} · tris ${r.tris}k`);
  };
  const run = async (label, code) => { await page.evaluate(`(() => { const NS = window.__NS; const E = NS.engine; ${code}; })()`); await sleep(2500); await measure(label); };
  await measure('HIGH reference');
  await run('player car castShadow off', 'NS.ctx.playerVisual.root.traverse(o => { o.castShadow = false; })');
  await run('reflection: no particles', 'E.reflection.mask &= ~(1 << 2)');
  await run('reflection: no player', 'E.reflection.mask &= ~(1 << 3)');
  await run('reflection: no NO_PROBE layer', 'E.reflection.mask &= ~(1 << 4)');
  await run('reflection: nothing (clear only)', 'E.reflection.mask = 1 << 30');
  await run('reflection restored, far 350', 'E.reflection.mask = (1<<0)|(1<<3)|(1<<4)|(1<<2); E.reflection.far = 350');
  await run('probe off', 'E.debug.probe = false');
  await run('reflection off too', 'E.debug.reflection = false');
  await run('bloom off', 'E.bloom.intensity = 0; E.finalPass.enabled = false');
};
