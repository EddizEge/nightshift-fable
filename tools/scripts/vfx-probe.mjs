/**
 * Probe (agent "vfx"): lastSecondEscape on a given quality, burst of frames right after the tanker
 * detonates, logging what VFX elements sit near the camera / project into a screen box.
 *   node tools/shot.mjs --label vfx --page "index.html?debug" --script tools/scripts/vfx-probe.mjs --q low --prefix vfx-probe --timeout 120000
 * --box x0,y0,x1,y1 (CSS px of the 1600x900 viewport, default 950,550,1350,800)  --n frames (12)  --hide puffs|sparks|debris|glow|nitro
 */
export default async ({ page, sleep, log, args, root }) => {
  const sharp = (await import('sharp')).default;
  const path = await import('node:path');
  const prefix = String(args.prefix || 'vfx-probe');
  const N = Number(args.n ?? 12);
  const box = String(args.box || '950,550,1350,800').split(',').map(Number);
  const ev = (fn, a) => page.evaluate(fn, a);
  await ev(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 45000 });
  if (args.q) {
    await ev((q) => window.__NS.setQuality(q), String(args.q));
    await sleep(1200);
  }
  if (args.noflash) await ev(() => { window.__NS.ctx.lighting.flash = () => {}; });
  await ev(() => { const NS = window.__NS; NS.game.trafficScale = 0; NS.teleport(380, 1.85, 30); NS.autopilot(true); NS.game.autopilot.cruise = 30; });
  await sleep(1500);
  log('trigger', await ev(() => { const NS = window.__NS; NS.game.player.grace = 60; return NS.trigger('lastSecondEscape'); }));
  await page.waitForFunction(() => window.__NS.game.director.bExploded === true, null, { timeout: 40000, polling: 16 });
  const frames = [];
  for (let i = 0; i < N; i++) {
    const info = await ev(([box, hide]) => {
      const NS = window.__NS;
      const v = NS.vfx;
      const cam = NS.engine.camera;
      const V = cam.position.constructor;
      const q = new V();
      const W = innerWidth, H = innerHeight;
      const inBox = (x, y, z) => {
        q.set(x, y, z).project(cam);
        if (q.z > 1) return null;
        const sx = (q.x * 0.5 + 0.5) * W, sy = (0.5 - q.y * 0.5) * H;
        return sx >= box[0] && sx <= box[2] && sy >= box[1] && sy <= box[3] ? [sx | 0, sy | 0] : null;
      };
      const out = [];
      const P = v.puffs;
      for (let k = 0; k < P.count; k++) {
        const s = inBox(P.px[k], P.py[k], P.pz[k]);
        const d = Math.hypot(P.px[k] - cam.position.x, P.py[k] - cam.position.y, P.pz[k] - cam.position.z);
        if (s && (d < 25 || P.kind[k] === 2)) out.push(`puff k${P.kind[k]} d${d.toFixed(1)} r${P.size[k].toFixed(2)} h${P.heat[k].toFixed(2)} a${(P.age[k] / P.life[k]).toFixed(2)} y${P.py[k].toFixed(1)} @${s}`);
      }
      const S = v.sparkSys;
      let ns = 0;
      for (let k = 0; k < S.count; k++) if (inBox(S.px[k], S.py[k], S.pz[k])) ns++;
      const D = v.debrisSys;
      const dn = [];
      if (D.px) for (let k = 0; k < D.count; k++) { const s = inBox(D.px[k], D.py[k], D.pz[k]); if (s) dn.push(`deb d${Math.hypot(D.px[k] - cam.position.x, D.py[k] - cam.position.y, D.pz[k] - cam.position.z).toFixed(1)} @${s}`); }
      const L = NS.ctx.lighting.uniforms;
      const fl = L.uFlashColor.value.map((c, k) => `${c.r.toFixed(0)}@${L.uFlashPos.value[k].toArray().map((x) => x.toFixed(0))}`).join(' ');
      const bodies = { puffs: v.puffs.mesh, sparks: v.sparkSys.mesh, glow: v.glow.mesh, nitro: v.nitro.mesh };
      if (hide && bodies[hide]) bodies[hide].material.visible = false;
      if (hide === 'debris') for (const m of v.debrisSys.meshes) m.material.visible = false;
      return `sparks ${ns} flash ${fl} nitro ${v.nitro.level ?? ''} ${out.slice(0, 8).join(' | ')} ${dn.slice(0, 4).join(' | ')}`;
    }, [box, args.hide ? String(args.hide) : '']);
    const buf = await page.screenshot({ type: 'jpeg', quality: 85 });
    frames.push(buf);
    log(`#${i + 1} ${info}`);
  }
  const tw = 400, th = 225, cols = 4;
  const tiles = await Promise.all(frames.map((b, i) => sharp(b).resize(tw, th).composite([{ input: Buffer.from(`<svg width="${tw}" height="16"><text x="4" y="13" font-size="12" fill="yellow" font-family="monospace">${i + 1}</text></svg>`), left: 0, top: 0 }]).toBuffer()));
  await sharp({ create: { width: cols * tw, height: Math.ceil(frames.length / cols) * th, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
    .png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
  log(`saved screenshots/${prefix}-sheet.png`);
};
