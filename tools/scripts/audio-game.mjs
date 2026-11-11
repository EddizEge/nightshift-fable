/**
 * Audio robustness / leak run in the REAL game (autopilot driving).
 *
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/audio-game.mjs --label audio --timeout 900000 [--secs 300] [--fail 30] [--events 1] [--restart 45]
 *
 * --fail N     every N s simulate an audio failure (rotating error / close / worklet / suspend / stall) and
 *              check the game keeps running, nothing reaches the page and sound comes back (analyser level).
 * --events 1   force the two set pieces alternately every 60 s.
 * --restart N  force a fresh run every N s (besides the restart after every game over).
 * Every 15 s: JS heap (after a forced GC), Web Audio handler count (CDP AudioHandlers), JS listeners,
 * the audio object's own live-voice / live-node / play counters.
 */
export default async ({ page, sleep, log, args }) => {
  const secs = Number(args.secs ?? 300);
  const failEvery = Number(args.fail ?? 0);
  const restartEvery = Number(args.restart ?? 0);
  const events = Number(args.events ?? 0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  await page.evaluate(() => {
    const NS = window.__NS;
    const c = (window.__aud = { errors: [], rejections: [], runs: 0, explosions: 0, collisions: 0, cinematics: [], gaps: [], longTasks: 0, longMs: 0, raf: 0 });
    // Independent frame monitor: every main-thread / rAF gap > 250 ms, with the game state at the time.
    let last = performance.now();
    const mon = (now) => { const g = now - last; last = now; c.raf++; if (g > 250) c.gaps.push(`${(now / 1000).toFixed(1)}s:${g.toFixed(0)}ms:${NS.stats().state}:${NS.ctx.audio.health().state}`); requestAnimationFrame(mon); };
    requestAnimationFrame(mon);
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { c.longTasks++; c.longMs = Math.max(c.longMs, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch {}
    window.addEventListener('error', (e) => c.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => c.rejections.push(String(e.reason)));
    NS.ctx.events.on('runStart', () => c.runs++);
    NS.ctx.events.on('explosion', () => c.explosions++);
    NS.ctx.events.on('collision', () => c.collisions++);
    NS.ctx.events.on('cinematic', (e) => c.cinematics.push(`${e.id}:${e.phase}`));
    NS.start();
    NS.autopilot(true);
  });
  const A = '__NS.ctx.audio';
  const until = async (expr, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (await page.evaluate(expr)) return Date.now() - t;
      await sleep(100);
    }
    return -1;
  };
  const up = await until(`${A}.health().state === 'running' && ${A}.level() > -60`, 15000);
  log(`audio up after ${up} ms: ${JSON.stringify(await page.evaluate(`${A}.health()`))}`);

  const sample = async (t) => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const r = await page.evaluate(`(() => { const h = ${A}.health(); const s = __NS.stats(); return { h, lvl: ${A}.level(), st: s.state, frame: __NS.ctx.time.frame, fps: s.frameMs, heap: performance.memory ? performance.memory.usedJSHeapSize : 0, raf: window.__aud.raf, wall: performance.now(), longMs: window.__aud.longMs }; })()`);
    const row = {
      t, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), audioHandlers: m.AudioHandlers, listeners: m.JSEventListeners, domNodes: m.Nodes,
      voices: r.h.liveVoices, nodesLive: r.h.nodesLive, plays: r.h.plays, merged: r.h.merged, stolen: r.h.stolen, noBuf: r.h.noBuffer,
      gen: r.h.generation, state: r.h.state, lvl: +r.lvl.toFixed(1), game: r.st, frame: r.frame, raf: r.raf, wall: +(r.wall / 1000).toFixed(1), longMs: Math.round(r.longMs),
    };
    log('SAMPLE ' + Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' '));
    return row;
  };

  const kinds = ['error', 'close', 'worklet', 'error', 'suspend', 'stall', 'error', 'close'];
  const fails = [];
  const series = [await sample(0)];
  const t0 = Date.now();
  let nextSample = 15, nextFail = failEvery || Infinity, nextEvent = events ? 20 : Infinity, nextRestart = restartEvery || Infinity;
  let k = 0, ev = 0;
  while ((Date.now() - t0) / 1000 < secs) {
    await sleep(500);
    const el = (Date.now() - t0) / 1000;
    await page.evaluate(() => { const NS = window.__NS; if (NS.stats().state === 'gameover') NS.start(); });
    if (el >= nextRestart) {
      nextRestart += restartEvery;
      await page.evaluate(() => { const NS = window.__NS; NS.start(); NS.autopilot(true); });
    }
    if (el >= nextEvent) {
      nextEvent += 60;
      const id = ev++ % 2 === 0 ? 'chainReaction' : 'lastSecondEscape';
      const ok = await page.evaluate((id) => { try { window.__NS.game.player.grace = 8; return window.__NS.trigger(id); } catch (e) { return String(e); } }, id);
      log(`forced ${id}: ${ok}`);
    }
    if (el >= nextFail) {
      nextFail += failEvery;
      const kind = kinds[k++ % kinds.length];
      const before = await page.evaluate(`({ f: __NS.ctx.time.frame, h: ${A}.health() })`);
      const res = await page.evaluate(`${A}.debugFail(${JSON.stringify(kind)})`);
      await sleep(150);
      const during = await page.evaluate(`({ lvl: ${A}.level(), state: ${A}.health().state })`);
      const back = await until(`${A}.health().state === 'running' && ${A}.health().generation ${['error', 'close', 'stall'].includes(kind) ? '>' : '>='} ${before.h.generation} && ${A}.level() > -60 && (${JSON.stringify(kind)} !== 'worklet' || ${A}.health().worklet)`, 20000);
      const after = await page.evaluate(`({ f: __NS.ctx.time.frame, h: ${A}.health(), lvl: ${A}.level(), errs: window.__aud.errors.length + window.__aud.rejections.length })`);
      const row = { kind, res, during: `${during.state}/${during.lvl.toFixed(0)}dB`, backMs: back, lvl: +after.lvl.toFixed(1), frames: after.f - before.f, gen: `${before.h.generation}->${after.h.generation}`, restarts: after.h.engineRestarts, volume: after.h.masterGain.toFixed(2), pageErrors: after.errs };
      fails.push(row);
      log('FAIL-TEST ' + Object.entries(row).map(([a, b]) => `${a}=${b}`).join(' '));
    }
    if (el >= nextSample) {
      nextSample += 15;
      series.push(await sample(Math.round(el)));
    }
  }
  const f = await page.evaluate(() => window.__aud);
  const h = await page.evaluate(`${A}.health()`);
  log(`SUMMARY ${secs}s: runs ${f.runs} · collisions ${f.collisions} · explosions ${f.explosions} · cinematics ${[...new Set(f.cinematics)].join(' ')} · page errors ${f.errors.length} · rejections ${f.rejections.length}`);
  log(`AUDIO ${JSON.stringify(h)}`);
  if (fails.length) log(`FAIL-TESTS ${fails.filter((r) => r.backMs >= 0 && r.frames > 0).length}/${fails.length} recovered with the game running`);
  const a = series[1] ?? series[0], b = series[series.length - 1];
  log(`TREND heap ${a.heapMB} → ${b.heapMB} MB · AudioHandlers ${a.audioHandlers} → ${b.audioHandlers} · listeners ${a.listeners} → ${b.listeners} · live nodes ${a.nodesLive} → ${b.nodesLive}`);
  if (f.errors.length) log('ERRORS ' + f.errors.slice(0, 5).join(' | '));
  log(`FRAME GAPS > 250 ms: ${f.gaps.length} ${f.gaps.slice(0, 12).join(' ')} · long tasks ${f.longTasks}, longest ${f.longMs.toFixed(0)} ms`);
};
