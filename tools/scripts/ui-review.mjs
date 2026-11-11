/**
 * UI review driver (agent "ui"): walks every screen of the real game and screenshots it.
 *   node tools/shot.mjs --page "index.html" --script tools/scripts/ui-review.mjs --label ui --size 1600x900 --timeout 120000 [--prefix ui-r1-1600] [--parts menu,hud,bright,banner,pause,over,long]
 * Logs a few DOM facts (overlay counts, debug visibility, focus) with "[ui]" so the run is checkable.
 */
export default async ({ page, shot, sleep, log, args, baseUrl }) => {
  const prefix = args.prefix || 'ui-r1';
  const parts = new Set(String(args.parts || 'menu,hud,bright,banner,pause,over,long').split(','));
  const P = (n) => `screenshots/${prefix}-${n}.png`;
  const ns = (fn, a) => page.evaluate(fn, a);
  const state = () => ns(() => window.__NS.game.state);
  const waitState = async (s, ms = 15000) => {
    const want = Array.isArray(s) ? s : [s];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const st = await state();
      if (want.includes(st)) return st;
      await sleep(100);
    }
    return state();
  };
  const facts = () =>
    ns(() => {
      const open = [...document.querySelectorAll('.ns [data-open]')].filter((e) => getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.01);
      const dbg = document.querySelector('.ns-debug');
      const a = document.activeElement;
      return {
        state: window.__NS.game.state,
        overlays: open.map((e) => e.className.split(' ').pop()).join(','),
        debug: dbg ? getComputedStyle(dbg).display : 'none',
        focus: a ? (a.textContent || a.tagName).trim().slice(0, 24) : null,
        cursor: getComputedStyle(document.body).cursor + '/' + getComputedStyle(document.querySelector('canvas')).cursor,
        hints: document.querySelector('.ns-hints')?.hasAttribute('data-on'),
      };
    });
  const fact = async (tag) => log('[ui]', tag, JSON.stringify(await facts()));

  await sleep(600);
  if (parts.has('menu')) {
    await fact('menu');
    await shot(P('01-menu'));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(500);
    await fact('settings');
    await shot(P('02-settings'));
    await page.keyboard.press('Escape');
    await sleep(150);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(500);
    await fact('controls');
    await shot(P('03-controls'));
    await page.keyboard.press('Escape');
    await sleep(300);
    await fact('back-from-controls');
    // A stray mouse click on the canvas must not strand keyboard focus.
    await page.mouse.click(1200, 500);
    await sleep(100);
    await fact('after-canvas-click');
    await page.keyboard.press('ArrowDown');
    await sleep(100);
    await fact('arrow-after-click');
    // Back onto CONTROLS so the run start below (ArrowUp ×2 → PLAY) stays valid.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
  }

  // ── run (the machine may be loaded: wait on game time, not wall time)
  const surv = () => ns(() => window.__NS.game.score.survivalTime);
  const waitGame = async (sec, ms = 30000) => {
    const t0 = await surv();
    const w0 = Date.now();
    while ((await surv()) < t0 + sec && Date.now() - w0 < ms) await sleep(80);
  };
  if (args.clearbest) await ns(() => localStorage.removeItem('nightshift.best'));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await waitState('playing', 15000);
  await ns(() => (window.__NS.game.player.grace = 9999));
  if (parts.has('hud')) {
    await fact('playing-before-input');
    await shot(P('05-hud-hints'));
  }
  await page.keyboard.down('KeyW');
  await waitGame(1);
  await page.keyboard.up('KeyW');
  await fact('hints-after-input');
  await ns(() => window.__NS.autopilot(true));
  if (parts.has('hud')) {
    await ns(() => {
      const ui = window.__NS.ctx.ui;
      const sc = window.__NS.game.score;
      sc.combo = 4;
      sc.comboTimer = 3;
      ui.popup('NEAR MISS  +250', 'nearMiss');
      ui.popup('NEAR MISS  +300', 'nearMiss');
      ui.popup('CLOSE CALL  +1,000', 'bonus');
    });
    await sleep(300);
    await fact('popups');
    await shot(P('06-popups'));
  }
  await waitGame(3);
  await fact('hints-3s-after-input');
  if (parts.has('hud')) await shot(P('07-hud-later'));

  if (parts.has('banner')) {
    await ns(() => window.__NS.ctx.ui.banner('PILE-UP AHEAD — KEEP LEFT', 'warning'));
    await sleep(600);
    await shot(P('08-banner-a'));
    await ns(() => window.__NS.ctx.ui.banner('INCOMING — KEEP RIGHT', 'warning'));
    await sleep(600);
    await shot(P('09-banner-b'));
    await ns(() => window.__NS.ctx.ui.banner(null));
  }

  if (parts.has('bright')) {
    // Explosion straight ahead of the camera: the frame behind the HUD goes white / orange.
    await ns(() => {
      const NS = window.__NS;
      const cam = NS.engine.camera;
      const p = cam.position.clone();
      const dir = cam.getWorldDirection(p.clone()).setY(0).normalize();
      p.addScaledVector(dir, 9);
      p.y = 1.2;
      NS.vfx.explosion(p, { scale: 1.6 });
    });
    await sleep(140);
    await shot(P('10-bright-explosion'));
    await sleep(1600);
    await ns(() => window.__NS.teleport(3700, 1.85, 40));
    await sleep(1500);
    await shot(P('11-tunnel'));
  }

  if (parts.has('long')) {
    await ns(() => {
      const sc = window.__NS.game.score;
      sc.score = 1234567;
      sc.distance = 123450;
      sc.survivalTime = 3725.4;
      sc.combo = 12;
      sc.comboTimer = 3;
    });
    await sleep(300);
    await shot(P('12-long-numbers'));
  }

  if (parts.has('pause')) {
    await page.keyboard.press('Escape');
    await sleep(500);
    await fact('pause');
    await shot(P('13-pause'));
    // Settings from pause, then back: focus should land on SETTINGS.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(300);
    await page.keyboard.press('Escape');
    await sleep(200);
    await fact('pause-after-settings');
    await page.keyboard.press('Escape');
    await waitState('playing', 3000);
  }

  if (parts.has('over')) {
    await ns(() => {
      const NS = window.__NS;
      NS.autopilot(false);
      const p = NS.ctx.player.position.clone();
      NS.game.player.grace = 0;
      NS.game.player.crash('Rear-ended traffic', null, p, p.clone().set(0, 0, -1), null);
    });
    await sleep(300);
    await fact('crashed');
    await shot(P('14-crashed'));
    await waitState('gameover', 12000);
    await sleep(300);
    await shot(P('15-gameover-countup'));
    await sleep(2200);
    await fact('gameover');
    await shot(P('16-gameover'));
  }
  if (parts.has('over2')) {
    // Restart at once (count-up still running), then a short run that is NOT a new best.
    await page.keyboard.press('Enter');
    await waitState(['intro', 'playing'], 5000);
    await waitState('playing', 5000);
    await ns(() => (window.__NS.game.player.grace = 9999));
    await sleep(800);
    await fact('second-run');
    await shot(P('17-second-run'));
    // Esc mashing: must end in exactly one overlay.
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Escape');
      await sleep(25 + i * 7);
    }
    await sleep(400);
    await fact('after-esc-mash');
    await shot(P('18-esc-mash'));
    if ((await state()) === 'paused') await page.keyboard.press('Escape');
    await waitState('playing', 3000);
    await ns(() => {
      const NS = window.__NS;
      const p = NS.ctx.player.position.clone();
      NS.game.player.grace = 0;
      NS.game.player.crash('Hit the barrier', null, p, p.clone().set(0, 0, -1), null);
    });
    await waitState('gameover', 12000);
    // Enter mashing right as the screen appears (guarded for 350 ms).
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Enter');
      await sleep(60);
    }
    await sleep(1800);
    await fact('gameover-2');
    await shot(P('19-gameover-nobest'));
  }

  if (parts.has('resize')) {
    const vp = page.viewportSize();
    for (const [w, hh] of [[1024, 600], [2560, 1080]]) {
      await page.setViewportSize({ width: w, height: hh });
      await sleep(500);
      await shot(P(`20-resize-${w}x${hh}`));
    }
    await page.setViewportSize(vp);
  }

  if (parts.has('reduced')) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Enter');
    await waitState('playing', 6000);
    await ns(() => {
      const ui = window.__NS.ctx.ui;
      window.__NS.game.player.grace = 9999;
      ui.popup('NEAR MISS  +250', 'nearMiss');
      ui.popup('NEAR MISS  +300', 'nearMiss');
      ui.popup('SLIPSTREAM  +12500', 'bonus');
    });
    await sleep(400);
    await shot(P('21-reduced-popups'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }

  if (parts.has('touch')) {
    const browser = page.context().browser();
    const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const p2 = await ctx2.newPage();
    await p2.goto(baseUrl + 'index.html', { waitUntil: 'load' });
    await p2.waitForFunction('window.__ready === true', null, { timeout: 120000, polling: 200 });
    await sleep(800);
    log('[ui] touch', JSON.stringify(await p2.evaluate(() => ({ touch: document.querySelector('.ns').hasAttribute('data-touch'), note: getComputedStyle(document.querySelector('.ns-kbnote')).display }))));
    await p2.screenshot({ path: P('22-touch-notice') });
    await p2.keyboard.press('KeyK');
    await sleep(500);
    log('[ui] touch-after-key', JSON.stringify(await p2.evaluate(() => ({ state: window.__NS.game.state, note: getComputedStyle(document.querySelector('.ns-kbnote')).display }))));
    await p2.screenshot({ path: P('23-touch-after-key') });
    await ctx2.close();
  }

  if (parts.has('boot')) {
    await page.reload({ waitUntil: 'commit' });
    await sleep(1500);
    await shot(P('24-boot'));
  }
  log('[ui] done');
};
