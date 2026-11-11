/**
 * UI sandbox: the full interface over a CSS stand-in for the night-road scene, driven by
 * fake data. `?state=loading|menu|settings|controls|hud|hudbusy|pause|gameover|intro`
 * Extras: `&touch=1` (pretend touch-only device), `&best=<n>` (seed localStorage best),
 * `&newbest=0` (game over without the badge), `&live=1` (keep the HUD animating).
 * Every UI event is echoed to the console with the [ns] prefix (shot.mjs prints those).
 */
import { EventBus } from '../core/events';
import type { CameraMode, GameEvents, GameState, HudState, QualityLevel, RunSummary } from '../core/types';
import { createUi } from '../ui';

declare global {
  interface Window {
    __ready?: boolean;
    __ui?: ReturnType<typeof createUi>;
  }
}

const q = new URLSearchParams(location.search);
const state = q.get('state') ?? 'menu';
if (q.get('touch') === '1') document.documentElement.dataset.nsTouch = '1';
const bestParam = q.get('best');
try {
  if (bestParam !== null) localStorage.setItem('nightshift.best', bestParam);
  else if (!localStorage.getItem('nightshift.best')) localStorage.setItem('nightshift.best', '48210');
} catch {
  /* private mode */
}

const events = new EventBus();
const ui = createUi({ events, root: document.body, onSound: (n) => console.log(`[ns] sound ${n}`) });
window.__ui = ui;

const echo: (keyof GameEvents)[] = ['uiPlay', 'uiResume', 'uiRestart', 'uiQuitToMenu', 'uiPauseToggle', 'uiSetQuality', 'uiSetVolume', 'uiSetMuted'];
for (const k of echo) events.on(k, (e) => console.log(`[ns] event ${k} ${JSON.stringify(e)}`));

// Settings round-trip like the real game would do.
const settings: { quality: QualityLevel; volume: number; muted: boolean; cameraMode: CameraMode } = { quality: 'high', volume: 0.8, muted: false, cameraMode: 'chase' };
events.on('uiSetQuality', (e) => ((settings.quality = e.level), ui.setSettings(settings)));
events.on('uiSetVolume', (e) => ((settings.volume = e.master), ui.setSettings(settings)));
events.on('uiSetMuted', (e) => ((settings.muted = e.muted), ui.setSettings(settings)));
ui.setSettings(settings);

let current: GameState = 'boot';
const go = (s: GameState): void => {
  current = s;
  ui.setState(s);
};
// Minimal state machine so the sandbox is clickable end to end.
events.on('uiPlay', () => go('playing'));
events.on('uiRestart', () => go('playing'));
events.on('uiResume', () => go('playing'));
events.on('uiPauseToggle', () => go(current === 'paused' ? 'playing' : 'paused'));
events.on('uiQuitToMenu', () => go('menu'));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && current === 'playing') go('paused');
});

const hud: HudState = {
  speedKmh: 0,
  gear: 1,
  rpm01: 0.3,
  nitro01: 1,
  nitroActive: false,
  distance: 0,
  score: 0,
  combo: 1,
  comboTimer01: 0,
  damage01: 0,
  survivalTime: 0,
};

const summary: RunSummary = {
  score: 61840,
  distance: 7342,
  topSpeedKmh: 287.4,
  nearMisses: 23,
  survivalTime: 214.6,
  riskBonus: 9450,
  bestCombo: 6,
  bestScore: 48210,
  isNewBest: q.get('newbest') !== '0',
  cause: 'Rear-ended a truck at 241 km/h',
};

const key = (code: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
};
const frames = (n: number): Promise<void> =>
  new Promise((r) => {
    const step = (): void => (n-- <= 0 ? r() : void requestAnimationFrame(step));
    step();
  });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function busyHud(): void {
  Object.assign(hud, {
    speedKmh: 268.6,
    gear: 6,
    rpm01: 0.95,
    nitro01: 0.46,
    nitroActive: true,
    distance: 5874,
    score: 38425,
    combo: 4,
    comboTimer01: 0.62,
    damage01: 0.58,
    survivalTime: 142.3,
  });
  ui.updateHud(hud);
}

async function main(): Promise<void> {
  await document.fonts.ready;
  let settle = 700;
  switch (state) {
    case 'loading':
      ui.setLoading(0.64, 'Compiling shaders');
      settle = 300;
      break;
    case 'menu':
      go('menu');
      break;
    case 'settings':
      go('menu');
      await frames(2);
      key('ArrowDown');
      key('Enter');
      break;
    case 'controls':
      go('menu');
      await frames(2);
      key('ArrowDown');
      key('ArrowDown');
      key('Enter');
      break;
    case 'intro':
      go('intro');
      break;
    case 'hud':
      go('playing');
      Object.assign(hud, { speedKmh: 142, gear: 4, rpm01: 0.62, nitro01: 1, distance: 412, score: 1250, survivalTime: 4.2 });
      ui.updateHud(hud);
      break;
    case 'hudbusy':
      go('playing');
      hud.survivalTime = 130; // past the control hints
      ui.updateHud(hud);
      busyHud();
      await frames(2);
      ui.updateHud({ ...hud, combo: 5 }); // combo increase → pulse
      hud.combo = 5;
      ui.popup('+250 NEAR MISS x3', 'nearMiss');
      await wait(120);
      ui.popup('+1,200 CLOSE CALL x4', 'bonus');
      await wait(120);
      ui.popup('+500 NEAR MISS x5', 'nearMiss');
      ui.banner('Pile-up ahead', 'warning');
      settle = 600;
      break;
    case 'pause':
      go('playing');
      busyHud();
      go('paused');
      break;
    case 'gameover':
      ui.showGameOver(summary);
      go('gameover');
      settle = 2200; // let the count-up land
      break;
  }

  // Optional live HUD motion for manual testing.
  if (q.get('live') === '1') {
    let t0 = performance.now();
    const loop = (now: number): void => {
      const dt = (now - t0) / 1000;
      t0 = now;
      if (current === 'playing') {
        hud.survivalTime += dt;
        hud.speedKmh = 180 + Math.sin(hud.survivalTime * 0.7) * 90;
        hud.rpm01 = 0.55 + Math.sin(hud.survivalTime * 2.1) * 0.42;
        hud.distance += (hud.speedKmh / 3.6) * dt;
        hud.score += dt * 120 * hud.combo;
        hud.comboTimer01 = Math.max(0, hud.comboTimer01 - dt * 0.25);
        ui.updateHud(hud);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  await wait(settle);
  await frames(2);
  window.__ready = true;
  console.log(`[ns] ui sandbox ready: ${state}`);
}

void main();
