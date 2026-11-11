/**
 * backdrop wave-4 diagnosis: rural verge brightness. Chase camera at --s (7500), then the same frame with
 * single lighting terms switched off (terrain env reflection, engine sky fill, backdrop night fill, spill),
 * and the mean of a verge crop vs a road crop for each.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/backdrop-w4diag.mjs --label backdrop
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const s0 = Number(args.s ?? 7500);
  const prefix = args.prefix || 'backdrop-w4diag';
  const sharp = (await import('sharp')).default;
  const P = (f) => path.resolve(root, f);
  // Crops in 1600x900 px: verge right of the rail, road (lanes ahead).
  const crops = { verge: JSON.parse(args.verge || '[1250,600,300,200]'), road: JSON.parse(args.road || '[700,700,200,150]') };
  const meas = async (f) => {
    const out = {};
    for (const [k, [left, top, width, height]] of Object.entries(crops)) {
      const st = await sharp(await sharp(P(f)).extract({ left, top, width, height }).toBuffer()).stats();
      out[k] = st.channels.slice(0, 3).map((c) => c.mean.toFixed(1)).join('/');
    }
    return JSON.stringify(out);
  };
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  let crashed = false;
  for (let a = 0; a < 4 && !crashed; a++) {
    await page.evaluate(([s]) => { const NS = window.__NS; NS.autopilot(false); NS.game.trafficScale = 0; NS.teleport(s, 5.55, 60); }, [s0 + a * 250]);
    await page.keyboard.down('KeyW');
    await sleep(400);
    await page.evaluate(() => { const NS = window.__NS; const p = NS.ctx.player; return !!NS.traffic.spawn('sedan', p.s + 75, 3, 9, 'scripted'); });
    crashed = await page.waitForFunction(() => ['crashed', 'gameover'].includes(window.__NS.game.state), null, { timeout: 8000 }).then(() => true, () => false);
  }
  await page.keyboard.up('KeyW');
  await sleep(4500);
  const setup = async (what) =>
    page.evaluate(async ([what]) => {
      const NS = window.__NS;
      const sh = (await import('/src/world/backdrop/shared.ts')).shared;
      const mats = [];
      NS.engine.scene.traverse((o) => { if (o.name === 'bdTerrainNear' && o.material) mats.push(o.material); });
      const m = mats[0];
      window.__bdSave ??= { rough: m.roughness, env: m.envMapIntensity, fill: sh.uFill.value.clone(), spill: sh.uSpill.value, sky: NS.engine.skyFill.intensity, envI: NS.engine.scene.environmentIntensity };
      const S = window.__bdSave;
      m.envMapIntensity = S.env; m.roughness = S.rough; NS.engine.scene.environmentIntensity = S.envI; sh.uFill.value.copy(S.fill); sh.uSpill.value = S.spill;
      if (what === 'noEnv') m.envMapIntensity = 0;
      if (what === 'noSceneEnv') NS.engine.scene.environmentIntensity = 0;
      if (what === 'rough1') m.roughness = 1;
      if (what === 'noFill') sh.uFill.value.setScalar(0);
      if (what === 'noSpill') sh.uSpill.value = 0;
      if (what === 'noSky') NS.engine.skyFill.intensity = 0;
      return `${what}: mats=${mats.length} env=${m.envMapIntensity} envMap=${!!m.envMap} sceneEnvI=${NS.engine.scene.environmentIntensity.toFixed(2)} sky=${NS.engine.skyFill.intensity.toFixed(2)} rough=${m.roughness}`;
    }, [what]);
  for (const what of String(args.modes || 'base,noEnv,noSceneEnv,rough1,noFill,noSpill,noSky').split(',')) {
    log(await setup(what));
    await sleep(400);
    const f = await shot(`screenshots/${prefix}-${what}.png`);
    log(`${what} ${await meas(f)}`);
  }
};
