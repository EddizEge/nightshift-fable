/**
 * Performance probe in the real game (autopilot driving).
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/perf.mjs --size 1920x1080 [--no-vsync]
 * Options: --levels low,medium,high,ultra  --secs <n per level, default 8>  --s <start arc length, default 300>
 *          --breakdown 1 (also measure HIGH with reflection / probe switched off)  --traffic 0
 * Prints one line per measurement: avg/max frame interval, avg GPU ms (timer query), draw calls, triangles, pixel ratio.
 */
export default async ({ page, sleep, log, args }) => {
  const levels = String(args.levels || 'low,medium,high,ultra').split(',');
  const secs = Number(args.secs ?? 8);
  const startS = Number(args.s ?? 300);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(() => { const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = 50; NS.game.autopilot.risk = 0.1; });
  const measure = async (label) => {
    const r = await page.evaluate(async (secs) => {
      const NS = window.__NS;
      const out = { n: 0, sum: 0, max: 0, gpu: 0, calls: 0, tris: 0, pr: 0, over20: 0, restarts: 0 };
      let last = performance.now();
      const t0 = last;
      await new Promise((res) => {
        const tick = () => {
          const now = performance.now();
          const dt = now - last;
          last = now;
          const s = NS.stats();
          if (s.state !== 'playing') { if (s.state === 'gameover') { NS.start(); out.restarts++; } }
          else {
            out.n++; out.sum += dt; out.max = Math.max(out.max, dt); if (dt > 20) out.over20++;
            out.gpu += s.gpuMs; out.calls += s.calls; out.tris += s.triangles; out.pr += s.pixelRatio;
          }
          if (now - t0 < secs * 1000) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
      const n = Math.max(1, out.n);
      return { frames: out.n, avgMs: out.sum / n, fps: 1000 / (out.sum / n), maxMs: out.max, over20: out.over20, gpuMs: out.gpu / n, calls: Math.round(out.calls / n), tris: Math.round(out.tris / n), pr: out.pr / n, restarts: out.restarts, traffic: NS.stats().traffic, zone: NS.stats().zone };
    }, secs);
    log(`${label.padEnd(28)} fps ${r.fps.toFixed(1).padStart(6)} · interval avg ${r.avgMs.toFixed(2)} max ${r.maxMs.toFixed(1)} ms (>20ms: ${r.over20}/${r.frames}) · gpu ${r.gpuMs.toFixed(2)} ms · calls ${r.calls} · tris ${(r.tris / 1000).toFixed(0)}k · pixelRatio ${r.pr.toFixed(2)} · traffic ${r.traffic} · ${r.zone}${r.restarts ? ' · restarts ' + r.restarts : ''}`);
    return r;
  };
  const reset = async () => {
    await page.evaluate(([s, tr]) => { const NS = window.__NS; if (NS.game.state !== 'playing') NS.start(); NS.teleport(s, 1.85, 45); if (tr === '0') NS.ctx.traffic?.setDensity(0); }, [startS, String(args.traffic ?? '1')]);
    await sleep(4000);
  };
  const vp = page.viewportSize();
  log(`viewport ${vp.width}x${vp.height} · ${args['no-vsync'] ? 'vsync OFF' : 'vsync on'} · ${await page.evaluate(() => { const gl = window.__NS.engine.renderer.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown GPU'; })}`);
  for (const q of levels) {
    await page.evaluate((q) => window.__NS.setQuality(q), q);
    await reset();
    await measure(q.toUpperCase());
  }
  if (args.breakdown) {
    await page.evaluate(() => window.__NS.setQuality('high'));
    await reset();
    await measure('HIGH (reference)');
    for (const [name, code] of [
      ['HIGH − reflection', 'NS.engine.debug.reflection = false'],
      ['HIGH − reflection − probe', 'NS.engine.debug.probe = false'],
      ['HIGH − refl − probe − shadow', 'NS.engine.renderer.shadowMap.enabled = false; NS.engine.scene.traverse(o => { if (o.isLight) o.castShadow = false; })'],
      ['… − player car', 'NS.ctx.playerVisual.setVisible(false)'],
      ['… − traffic', 'NS.ctx.traffic.setDensity(0); NS.ctx.traffic.reset()'],
      ['… − weather+vfx', 'NS.ctx.weather = undefined; NS.ctx.vfx = undefined; NS.engine.scene.traverse(o => { if (o.layers.mask === 4) o.visible = false; })'],
    ]) {
      await page.evaluate(`(() => { const NS = window.__NS; ${code}; })()`);
      await sleep(2500);
      await measure(name);
    }
  }
};
