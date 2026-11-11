/**
 * Autopilot soak run: plays for --secs seconds (default 120), restarts after every crash, and
 * reports each crash with what was hit. Use to tune traffic / autopilot / collisions and to look
 * for errors over a long session.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/soak.mjs --secs 180 [--risk 0.3] [--cruise 55] [--shots 1] [--dark 1]
 * --dark 1 samples a screenshot every 2 s and reports black / blown-out frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export default async ({ page, shot, sleep, log, args, root }) => {
  const secs = Number(args.secs ?? 120);
  let dark = 0;
  let frames = 0;
  await page.evaluate(([risk, cruise]) => {
    const NS = window.__NS;
    const c = (window.__soak = { crashes: [], explosions: 0, nearMiss: 0, collisions: 0, bonuses: [], cinematics: [], runs: 0, maxScore: 0, maxDist: 0, errors: [] });
    const ev = NS.ctx.events;
    window.addEventListener('error', (e) => c.errors.push(String(e.message)));
    ev.on('explosion', () => c.explosions++);
    ev.on('nearMiss', () => c.nearMiss++);
    ev.on('collision', (e) => { c.collisions++; if (e.fatal) c.lastFatal = { kind: e.kind, rel: +e.relSpeed.toFixed(1) }; });
    ev.on('bonus', (e) => c.bonuses.push(e.label));
    ev.on('cinematic', (e) => c.cinematics.push(`${e.id}:${e.phase}`));
    ev.on('runStart', () => c.runs++);
    ev.on('runEnd', (s) => {
      const p = NS.ctx.player;
      c.maxScore = Math.max(c.maxScore, s.score); c.maxDist = Math.max(c.maxDist, s.distance);
      c.crashes.push(`${s.cause} · t=${s.survivalTime.toFixed(1)}s dist=${s.distance.toFixed(0)}m score=${s.score} nm=${s.nearMisses} top=${s.topSpeedKmh.toFixed(0)} · d=${p.d.toFixed(2)} zone=${NS.world.zoneAt(p.s)} event=${NS.game.director.current ?? '-'} hit=${JSON.stringify(c.lastFatal ?? null)}`);
    });
    NS.start();
    NS.autopilot(true);
    if (risk !== null) NS.game.autopilot.risk = risk;
    if (cruise !== null) NS.game.autopilot.cruise = cruise;
  }, [args.risk !== undefined ? Number(args.risk) : null, args.cruise !== undefined ? Number(args.cruise) : null]);
  const t0 = Date.now();
  let n = 0;
  let lastCrashes = 0;
  while (Date.now() - t0 < secs * 1000) {
    await sleep(1000);
    n++;
    const r = await page.evaluate(() => { const NS = window.__NS; const s = NS.stats(); if (s.state === 'gameover') NS.start(); return { s, soak: window.__soak }; });
    if (r.soak.crashes.length > lastCrashes) { log('CRASH', r.soak.crashes[r.soak.crashes.length - 1]); lastCrashes = r.soak.crashes.length; }
    if (args.dark && n % 2 === 0) {
      // Catch black / blown-out frames: mean luminance of a downscaled screenshot.
      const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
      const st = await sharp(buf).resize(160, 90).greyscale().stats();
      const mean = st.channels[0].mean;
      if (mean < 6 || mean > 215) {
        dark++;
        const f = path.resolve(root, `screenshots/soak-odd-${String(n).padStart(4, '0')}.jpg`);
        fs.writeFileSync(f, buf);
        log(`ODD FRAME mean=${mean.toFixed(1)} at t=${n}s state=${r.s.state} s=${r.s.s.toFixed(0)} zone=${r.s.zone} pr=${r.s.pixelRatio.toFixed(2)} → ${path.basename(f)}`);
      }
      frames++;
    }
    if (n % 15 === 0) {
      const s = r.s;
      log(`t=${n}s state=${s.state} v=${s.speedKmh.toFixed(0)} s=${s.s.toFixed(0)} score=${s.score} nm=${s.nearMisses} traffic=${s.traffic} wrecks=${s.wrecks} zone=${s.zone} ev=${s.event} gpu=${s.gpuMs.toFixed(1)}ms frame=${s.frameMs.toFixed(1)}ms calls=${s.calls} tris=${(s.triangles / 1000).toFixed(0)}k pr=${s.pixelRatio.toFixed(2)} geo=${s.geometries} tex=${s.textures}`);
      if (args.shots) await shot(`screenshots/soak-${String(n).padStart(4, '0')}.png`);
    }
  }
  const f = await page.evaluate(() => window.__soak);
  if (args.dark) log(`brightness check: ${dark} odd frame(s) out of ${frames} sampled`);
  log(`SOAK ${secs}s: runs ${f.runs} · crashes ${f.crashes.length} · best score ${f.maxScore} · longest ${f.maxDist.toFixed(0)} m · near misses ${f.nearMiss} · collisions ${f.collisions} · explosions ${f.explosions} · cinematics ${[...new Set(f.cinematics)].join(' ')} · bonuses ${[...new Set(f.bonuses)].join(', ')} · window errors ${f.errors.length}`);
};
