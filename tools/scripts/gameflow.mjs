/**
 * End-to-end game flow test, run through the browser harness with real keyboard input:
 *
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/gameflow.mjs --timeout 120000
 *
 * Options (after the harness options): --prefix <name> (screenshot prefix, default "flow"),
 * --soak <seconds> (autopilot run length, default 40), --skip-events, --skip-crash.
 * Prints PASS / FAIL per check and a JSON summary; throws (exit code 2) if any check failed.
 */
export default async ({ page, shot, sleep, log, args }) => {
  const prefix = `screenshots/${args.prefix || 'flow'}`;
  const soak = Number(args.soak ?? 40);
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail: String(detail) });
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ' — ' + detail : ''}`);
  };
  const ns = (expr) => page.evaluate(`(() => { const NS = window.__NS; return ${expr}; })()`);
  const stats = () => ns('NS.stats()');
  const waitState = async (states, ms = 15000) => {
    const list = Array.isArray(states) ? states : [states];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await ns('NS.game.state');
      if (list.includes(s)) return s;
      await sleep(100);
    }
    return ns('NS.game.state');
  };
  const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const fmt = (s) => `state=${s.state} v=${s.speedKmh.toFixed(0)}km/h s=${s.s.toFixed(0)} d=${s.d.toFixed(2)} score=${s.score} nm=${s.nearMisses} traffic=${s.traffic} wrecks=${s.wrecks} zone=${s.zone} ev=${s.event} | ${s.frameMs.toFixed(1)}ms calls=${s.calls} tris=${s.triangles} pr=${s.pixelRatio.toFixed(2)}`;

  // Event counters.
  await page.evaluate(() => {
    const NS = window.__NS;
    const c = (window.__counts = { explosion: 0, collision: 0, nearMiss: 0, bonus: [], cinematic: [], states: [], lightning: 0, nitro: 0, fatal: [] });
    const ev = NS.ctx.events;
    ev.on('explosion', () => c.explosion++);
    ev.on('collision', (e) => {
      c.collision++;
      if (!e.fatal) return;
      // What killed the player (diagnostics for flaky runs).
      const p = NS.ctx.player;
      const ap = NS.game.autopilot;
      const near = NS.ctx.traffic.vehicles
        .filter((v) => Math.abs(v.s - p.s) < 30)
        .map((v) => `${v.type}[${v.mode} ds=${(v.s - p.s).toFixed(1)} d=${v.d.toFixed(2)} v=${v.speed.toFixed(0)} lane=${v.lane}>${v.targetLane}]`);
      c.fatal.push(`${e.kind} t=${NS.game.score.survivalTime.toFixed(1)} p(s=${p.s.toFixed(0)} d=${p.d.toFixed(2)} v=${p.speed.toFixed(0)}) autopilot=${NS.game.autopilotOn} lane=${ap.targetLane} steer=${ap.controls.steer.toFixed(2)} brake=${ap.controls.brake} zone=${NS.ctx.world.zoneAt(p.s)} ev=${NS.game.director.current} near: ${near.join(' ')}`);
    });
    ev.on('nearMiss', () => c.nearMiss++);
    ev.on('lightning', () => c.lightning++);
    ev.on('nitro', (e) => e.active && c.nitro++);
    ev.on('bonus', (e) => c.bonus.push(e.label));
    ev.on('cinematic', (e) => c.cinematic.push(`${e.id}:${e.phase}`));
    ev.on('state', (e) => c.states.push(`${e.from}>${e.to}`));
  });
  const counts = () => page.evaluate(() => window.__counts);

  // ── 1. main menu ─────────────────────────────────────────────────────────
  await sleep(1200);
  check('menu state after load', (await ns('NS.game.state')) === 'menu');
  let t = await text();
  for (const word of ['NIGHTSHIFT', 'Survive the Midnight', 'PLAY', 'SETTINGS', 'CONTROLS']) check(`menu shows "${word}"`, t.toUpperCase().includes(word.toUpperCase()));
  await shot(`${prefix}-01-menu.png`);
  log('menu', fmt(await stats()));

  // ── 2. start ─────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^play$/i }).first().click();
  const st0 = await waitState(['intro', 'playing'], 5000);
  check('PLAY starts a run', st0 === 'intro' || st0 === 'playing', st0);
  await waitState('playing', 6000);
  let hud = false;
  for (let i = 0; i < 20 && !hud; i++) {
    hud = /KM\/H|km\/h/.test(await text());
    if (!hud) await sleep(150);
  }
  check('HUD visible', hud);

  // ── 3. driving controls (on an empty road: this part drives blind) ──────
  // Density first, then the reset one frame later: a reset traffic system refills the road on its
  // next step, and that step still ran with the old density (the "empty" road then had a dozen
  // vehicles 300 to 900 m ahead, and the blind car drove into the middle of them).
  await ns('(NS.game.trafficScale = 0, true)');
  await sleep(120);
  await ns('(NS.ctx.traffic.reset(), true)');
  await sleep(120);
  check('road is empty for the control checks', (await stats()).traffic === 0, `${(await stats()).traffic} vehicles`);
  const a0 = await stats();
  await page.keyboard.down('KeyW');
  await sleep(3500);
  const a1 = await stats();
  check('W accelerates', a1.speedKmh > a0.speedKmh + 25, `${a0.speedKmh.toFixed(0)} → ${a1.speedKmh.toFixed(0)} km/h`);
  check('distance increases', a1.s > a0.s + 80, `${a0.s.toFixed(0)} → ${a1.s.toFixed(0)} m`);
  await shot(`${prefix}-02-drive.png`);
  await page.keyboard.down('KeyD');
  await sleep(450);
  await page.keyboard.up('KeyD');
  await sleep(500);
  const a2 = await stats();
  check('D steers right', a2.d > a1.d + 0.5, `d ${a1.d.toFixed(2)} → ${a2.d.toFixed(2)}`);
  await sleep(600);
  const a2b = await stats();
  await page.keyboard.down('KeyA');
  await sleep(700);
  await page.keyboard.up('KeyA');
  await sleep(600);
  const a3 = await stats();
  check('A steers left', a3.d < a2b.d - 0.5, `d ${a2b.d.toFixed(2)} → ${a3.d.toFixed(2)}`);
  await page.keyboard.up('KeyW');
  // Nobody straightens the car after the steering checks: it drifts on towards a barrier while the
  // remaining input checks run blind. Put it back in its lane first (and once more before the
  // test driver takes over).
  const recentre = () => ns('(NS.game.placePlayer(NS.ctx.player.s, 1.85, NS.ctx.player.speed), NS.game.player.sim.addNitro(1), true)');
  await recentre();
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await sleep(1200);
  const nitroOn = await ns('NS.ctx.player.nitroActive');
  await shot(`${prefix}-03-nitro.png`);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  check('Shift fires nitro', nitroOn && (await counts()).nitro > 0);
  const b0 = await stats();
  await page.keyboard.down('KeyS');
  await sleep(900);
  await page.keyboard.up('KeyS');
  const b1 = await stats();
  check('S brakes', b1.speedKmh < b0.speedKmh - 15, `${b0.speedKmh.toFixed(0)} → ${b1.speedKmh.toFixed(0)} km/h`);
  await page.keyboard.down('Space');
  await sleep(250);
  const hb = await ns('NS.ctx.input.controls.handbrake');
  await page.keyboard.up('Space');
  check('Space = handbrake input', hb === true);

  // ── 4. camera + pause ────────────────────────────────────────────────────
  await recentre();
  // Traffic comes back the way it arrives during a run: beyond the fog. (A traffic system that has
  // just been reset fills the road around the player, which is meant for the standing start, not
  // for a car doing 250 km/h.)
  await ns('(NS.ctx.traffic.prefill = false, NS.autopilot(true), NS.game.trafficScale = 1, true)');
  await page.keyboard.press('KeyC');
  await sleep(700);
  check('C switches camera', (await ns('NS.ctx.cameraRig.mode')) === 'hood', await ns('NS.ctx.cameraRig.mode'));
  // The camera flies from behind the car to the bonnet in 0.6 s of game time; on a busy machine that is
  // not over after 700 ms and the picture shows the cabin it passes through. Take it once it has arrived.
  await sleep(900);
  await shot(`${prefix}-04-hoodcam.png`);
  await page.keyboard.press('KeyC');
  await sleep(300);
  check('C switches back to chase', (await ns('NS.ctx.cameraRig.mode')) === 'chase');
  await page.keyboard.press('Escape');
  check('Esc pauses', (await waitState('paused', 2000)) === 'paused');
  const p0 = await stats();
  await sleep(600);
  const p1 = await stats();
  check('world frozen while paused', Math.abs(p1.s - p0.s) < 0.01);
  await shot(`${prefix}-05-pause.png`);
  await page.keyboard.press('Escape');
  check('Esc resumes', (await waitState('playing', 2000)) === 'playing');

  // ── 5. autopilot soak: traffic, near misses, score, zones ───────────────
  let maxTraffic = 0;
  let maxScore = 0;
  const zones = new Set();
  let frameMsSum = 0;
  let frameN = 0;
  let died = false;
  for (let i = 0; i < soak; i++) {
    await sleep(1000);
    const s = await stats();
    maxTraffic = Math.max(maxTraffic, s.traffic);
    maxScore = Math.max(maxScore, s.score);
    zones.add(s.zone);
    frameMsSum += s.frameMs;
    frameN++;
    if (i % 5 === 4) log('soak', fmt(s));
    if (i === 7) await shot(`${prefix}-06-traffic.png`);
    if (i === 22) await shot(`${prefix}-07-run.png`);
    if (s.state !== 'playing') {
      died = true;
      log('autopilot crashed during the soak:', fmt(s));
      await waitState('gameover', 12000);
      await sleep(700); // the game-over screen ignores keys for its first 350 ms
      await page.keyboard.press('Enter');
      await waitState('playing', 8000);
      await ns('NS.autopilot(true)');
    }
  }
  const c1 = await counts();
  const s1 = await stats();
  check('traffic present', maxTraffic >= 3, `max ${maxTraffic} vehicles`);
  check('score increases', maxScore > 200, `score ${maxScore}`);
  log(`soak: zones ${[...zones].join(',')} · avg frame ${(frameMsSum / Math.max(1, frameN)).toFixed(1)} ms · autopilot ${died ? 'CRASHED' : 'survived'}`);
  // From here on the set pieces are started by the test (the director's own scheduling ran during
  // the soak above and runs in tools/scripts/soak.mjs): its timer is parked so that a self-started
  // event cannot occupy the director while the test asks for a specific one.
  await ns('(NS.autopilot(true), NS.game.autopilot.risk = 0.3, NS.game.autopilot.cruise = 56, NS.game.director.cooldown = 1e6, true)');

  // What stands around the car (diagnostics for a test driver that does not get through).
  const around = () =>
    page.evaluate(() => {
      const NS = window.__NS;
      const p = NS.ctx.player;
      const a = NS.game.autopilot;
      const out = [`lanes=${a.lanes.map((l) => Math.round(l.dist)).join('/')} target=${a.targetLane} escape=${a.escape} backedUp=${a.backedUp.toFixed(1)}`];
      for (const v of NS.ctx.traffic.vehicles) if (Math.abs(v.s - p.s) < 60) out.push(`${v.type}:${v.mode} ds=${(v.s - p.s).toFixed(0)} d=${v.d.toFixed(1)} v=${v.speed.toFixed(0)}`);
      for (const b of NS.ctx.crash.bodies) {
        if (b.owner === 'player') continue;
        const pr = NS.ctx.road.project(b.position.x, b.position.z, p.s);
        if (Math.abs(pr.s - p.s) < 80) out.push(`wreck ds=${(pr.s - p.s).toFixed(0)} d=${pr.d.toFixed(1)} len=${(b.halfExtents.z * 2).toFixed(0)}`);
      }
      return out.join(' ; ');
    });

  // ── 6. cinematic events ──────────────────────────────────────────────────
  let boxedIn = 0;
  if (!args['skip-events']) {
    for (const [id, tag, wait] of [
      ['chainReaction', 'A', 62],
      ['lastSecondEscape', 'B', 30],
    ]) {
      if ((await ns('NS.game.state')) !== 'playing') {
        await waitState('gameover', 12000);
        await sleep(700); // the game-over screen ignores keys for its first 350 ms
        await page.keyboard.press('Enter');
        await waitState('playing', 8000);
        await ns('(NS.autopilot(true), NS.game.autopilot.risk = 0.3, NS.game.autopilot.cruise = 56, NS.game.director.cooldown = 1e6, true)');
        await sleep(2500);
      }
      // The director may have started an event by itself: let it finish first.
      for (let i = 0; i < 90 && (await stats()).event; i++) await sleep(500);
      const n = (c, what) => c.cinematic.filter((x) => x === `${id}:${what}`).length;
      const before = await counts();
      let shots = 0;
      // An event needs a suitable stretch ahead (open road for A, an overpass for B): keep asking.
      // Event A may also be called off before its warning (the pack was not caught up with where
      // the road is open): to the player nothing has happened then, and the test asks again.
      let ok = false;
      let attempts = 0;
      let calledOff = '';
      let standing = 0;
      for (; attempts < 3; ) {
        attempts++;
        ok = false;
        for (let i = 0; i < 150 && !ok; i++) {
          if ((await ns('NS.game.state')) !== 'playing') {
            // The test driver is not perfect: start over and keep going.
            await waitState('gameover', 12000);
            await sleep(700); // the game-over screen ignores keys for its first 350 ms
            await page.keyboard.press('Enter');
            await waitState('playing', 8000);
            await ns('(NS.autopilot(true), NS.game.autopilot.risk = 0.3, NS.game.autopilot.cruise = 56, NS.game.director.cooldown = 1e6, true)');
            await sleep(2500);
          }
          // Something is still running (an event that started before the timer was parked): wait it out.
          for (let k = 0; k < 120 && (await stats()).event; k++) await sleep(500);
          ok = await ns(`(NS.game.director.cooldown = 1e6, NS.trigger('${id}'))`);
          if (!ok) {
            await sleep(1000);
            // The test driver is no parking artist: boxed in between wrecks and stopped traffic it
            // may stand for minutes. That is the driver, not the event: put it back on open road.
            const st = await stats();
            standing = st.state === 'playing' && Math.abs(st.speedKmh) < 4 ? standing + 1 : 0;
            if (standing >= 20) {
              standing = 0;
              boxedIn++;
              log(`test driver boxed in (${fmt(st)}): moved on to open road`);
              await ns(`(NS.teleport(${Math.round(st.s + 80)}), NS.autopilot(true), NS.game.autopilot.risk = 0.3, NS.game.autopilot.cruise = 56, NS.game.director.cooldown = 1e6, true)`);
              await sleep(2500);
            }
          }
        }
        if (!ok) break;
        // The event itself is under test here, not the test driver: keep the car alive through it
        // (the soak above and tools/scripts/soak.mjs run without this).
        await ns('(NS.game.player.grace = 45, true)');
        let warnAt = -1;
        let sawClimax = false;
        let ended = false;
        for (let i = 0; i < wait * 2; i++) {
          await sleep(500);
          const c = await counts();
          if (warnAt < 0 && n(c, 'warn') > n(before, 'warn')) warnAt = i;
          const climax = n(c, 'climax') > n(before, 'climax');
          if (climax && !sawClimax) sawClimax = true;
          // Screenshots: one at the warning, a burst around the climax.
          if ((warnAt >= 0 && i >= warnAt + 2 && shots === 0) || (sawClimax && shots < 6)) {
            shots++;
            await shot(`${prefix}-ev${tag}-${String(shots).padStart(2, '0')}.png`);
          }
          ended = n(c, 'end') > n(before, 'end') + attempts - 1;
          if (ended || (await ns('NS.game.state')) !== 'playing') break;
        }
        await ns('(NS.game.player.grace = 0, true)');
        if (ended && warnAt < 0 && !sawClimax) {
          calledOff = await ns('NS.game.director.lastEnd');
          log(`event ${tag}: called off before its warning (${calledOff}), asking again`);
          await ns('(NS.game.director.cooldown = 1e6, true)');
          continue;
        }
        break;
      }
      check(`event ${tag} triggers`, ok === true, ok ? (attempts > 1 ? `attempt ${attempts} (earlier one called off before its warning: ${calledOff})` : '') : fmt(await stats()));
      const after = await counts();
      check(`event ${tag} reaches its climax`, n(after, 'climax') > n(before, 'climax'), after.cinematic.filter((x) => x.startsWith(id)).join(' '));
      check(`event ${tag} produces explosions`, after.explosion > before.explosion, `${after.explosion - before.explosion} explosion(s)`);
      log(`event ${tag}:`, fmt(await stats()), 'bonuses:', after.bonus.join(', '), '· ended:', await ns('NS.game.director.lastEnd'));
      if (Math.abs((await stats()).speedKmh) < 5) log(`event ${tag}: the car is standing ·`, await around());
      await sleep(1500);
    }
  }

  if (boxedIn > 0) log(`events: the test driver was boxed in ${boxedIn} time(s) and put back on open road`);

  // Near miss, staged: whether the test driver happens to pass close to somebody during the minute
  // above is luck (it did in most runs, which is not a check). One slow vehicle on an otherwise
  // empty road, passed at speed with a body gap of about one metre.
  {
    if ((await ns('NS.game.state')) !== 'playing') {
      await waitState('gameover', 12000);
      await sleep(700); // the game-over screen ignores keys for its first 350 ms
      await page.keyboard.press('Enter');
      await waitState('playing', 8000);
    }
    const before = (await counts()).nearMiss;
    await ns('(NS.autopilot(false), NS.game.director.cooldown = 1e6, NS.game.trafficScale = 0, true)');
    await sleep(120);
    // A straight stretch (the car drives blind here) on a clean road: teleport = no traffic, no
    // wrecks, and density 0 keeps it empty.
    await page.evaluate(() => {
      const NS = window.__NS;
      const road = NS.ctx.road;
      const p = NS.ctx.player;
      let best = p.s + 300;
      let bestK = 1;
      for (let s = p.s + 300; s < p.s + 4000; s += 40) {
        road.ensure(s + 200);
        let k = 0;
        for (let x = 0; x <= 120; x += 20) k = Math.max(k, Math.abs(road.curvatureAt(s + x)));
        if (k < bestK) {
          bestK = k;
          best = s;
        }
        if (k < 0.00008) break;
      }
      NS.teleport(best, -0.95, 50);
    });
    await sleep(250);
    const placed = await ns(`!!NS.ctx.traffic.spawn('sedan', NS.ctx.player.s + 26, 2, 20, 'scripted')`);
    await page.keyboard.down('KeyW');
    let seen = false;
    for (let i = 0; i < 30 && !seen; i++) {
      await sleep(200);
      seen = (await counts()).nearMiss > before;
    }
    await page.keyboard.up('KeyW');
    check('near miss detected', seen, `vehicle placed: ${placed} · ${before} near miss(es) before it, ${(await counts()).nearMiss} after`);
    await ns('(NS.game.trafficScale = 1, true)');
  }

  // ── 7. crash → game over → restart ───────────────────────────────────────
  if (!args['skip-crash']) {
    if ((await ns('NS.game.state')) !== 'playing') {
      await waitState('gameover', 12000);
      await sleep(700); // the game-over screen ignores keys for its first 350 ms
      await page.keyboard.press('Enter');
      await waitState('playing', 8000);
    }
    await ns('NS.autopilot(false)');
    // Start from open road (the last event may have left the car standing next to its wreckage).
    await ns('(NS.teleport(NS.ctx.player.s + 600, 1.85, 55), true)');
    await sleep(500);
    // Flat out with nitro, no steering: we will meet a truck soon enough.
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    const st = await waitState(['crashed', 'gameover'], 90000);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    check('collision ends the run', st === 'crashed' || st === 'gameover', st);
    for (let i = 1; i <= 4; i++) {
      await shot(`${prefix}-08-crash-${i}.png`);
      await sleep(650);
    }
    check('game over state', (await waitState('gameover', 12000)) === 'gameover');
    await sleep(1600);
    t = (await text()).toUpperCase();
    for (const word of ['FINAL SCORE', 'DISTANCE', 'TOP SPEED', 'NEAR MISSES', 'BEST', 'PLAY AGAIN']) check(`game over shows "${word}"`, t.includes(word));
    const best = await page.evaluate(() => localStorage.getItem('nightshift.best'));
    check('best score stored in localStorage', Number(best) > 0, `nightshift.best=${best}`);
    await shot(`${prefix}-09-gameover.png`);
    const cc = await counts();
    check('collision events fired', cc.collision > 0, `${cc.collision}`);
    await sleep(700);
    await page.getByRole('button', { name: /play again/i }).first().click();
    const st2 = await waitState(['intro', 'playing'], 6000);
    check('PLAY AGAIN restarts', st2 === 'intro' || st2 === 'playing', st2);
    await waitState('playing', 6000);
    await sleep(1500);
    const r = await stats();
    check('restart resets the run', r.score < 400 && r.s < 400 && r.damage === 0, fmt(r));
    await shot(`${prefix}-10-restart.png`);
  }

  // ── 8. quality presets ───────────────────────────────────────────────────
  await ns('(NS.autopilot(true), NS.game.autopilot.risk = 0.3, NS.game.autopilot.cruise = 56, NS.game.director.cooldown = 1e6, true)');
  for (const q of ['low', 'medium', 'high', 'ultra']) {
    await ns(`NS.setQuality('${q}')`);
    await sleep(2600);
    const s = await stats();
    check(`quality ${q} renders`, s.quality === q && s.calls > 0, fmt(s));
    await shot(`${prefix}-q-${q}.png`);
  }
  await ns(`NS.setQuality('high')`);

  const failed = results.filter((r) => !r.ok);
  log(`SUMMARY ${results.length - failed.length}/${results.length} checks passed`);
  log('states:', (await counts()).states.join(' '));
  for (const f of (await counts()).fatal) log('fatal:', f);
  if (failed.length) throw new Error(`${failed.length} check(s) failed: ${failed.map((f) => f.name).join('; ')}`);
};
