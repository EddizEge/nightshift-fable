/**
 * Is a main-thread freeze caused by audio? Forces a set piece with and without the audio system.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/audio-freeze.mjs --label audio [--noaudio 1] [--id chainReaction]
 */
export default async ({ page, sleep, log, args }) => {
  const id = args.id ?? 'chainReaction';
  const noAudio = !!Number(args.noaudio ?? 0);
  const r0 = await page.evaluate((noAudio) => {
    const NS = window.__NS;
    const c = (window.__fz = { gaps: [], long: [] });
    if (noAudio) NS.ctx.audio = undefined;
    let last = performance.now();
    const mon = (now) => { const g = now - last; last = now; if (g > 200) c.gaps.push(`${(now / 1000).toFixed(1)}s:${g.toFixed(0)}ms`); requestAnimationFrame(mon); };
    requestAnimationFrame(mon);
    new PerformanceObserver((l) => { for (const e of l.getEntries()) c.long.push(`${(e.startTime / 1000).toFixed(1)}s:${e.duration.toFixed(0)}ms`); }).observe({ entryTypes: ['longtask'] });
    NS.start();
    NS.autopilot(true);
    return performance.now();
  }, noAudio);
  await sleep(6000);
  const t = await page.evaluate((id) => { window.__NS.game.player.grace = 30; const ok = window.__NS.trigger(id); return { ok, at: (performance.now() / 1000).toFixed(1), frame: window.__NS.ctx.time.frame }; }, id);
  log(`trigger ${id} ok=${t.ok} at ${t.at}s (audio ${noAudio ? 'OFF' : 'on'})`);
  await sleep(25000);
  const f = await page.evaluate(() => ({ ...window.__fz, frame: window.__NS.ctx.time.frame, h: window.__NS.ctx.audio?.health?.() }));
  log(`frames during 25 s after trigger: ${f.frame - t.frame}`);
  log(`gaps>200ms: ${f.gaps.join(' ')}`);
  log(`long tasks: ${f.long.filter((x) => Number(x.split(':')[1].replace('ms', '')) > 150).join(' ')}`);
  if (f.h) log(`audio: plays ${f.h.plays} merged ${f.h.merged} noBuffer ${f.h.noBuffer} mainThreadRenderMs ${f.h.mainThreadRenderMs} renderJobs ${f.h.renderJobs}`);
};
