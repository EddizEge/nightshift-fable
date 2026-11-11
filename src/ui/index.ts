/**
 * NIGHTSHIFT game interface: a DOM/CSS overlay above the WebGL canvas (no framework).
 *
 *   const ui = createUi({ events, root: document.body, onSound: (n) => audio.play(n) });
 *
 * Keyboard ownership: while a menu-type screen is visible (states 'menu', 'paused',
 * 'gameover') the UI handles keys itself in a window *capture* listener and stops the
 * consumed events, so the game's Input never sees the same Esc / Enter / R twice. During
 * 'intro' / 'playing' / 'crashed' the UI ignores the keyboard completely and blurs its
 * buttons, so driving keys (Space!) can never activate a hidden control.
 */
import type { CameraMode, GameState, HudState, IEventBus, IUi, QualityLevel, RunSummary, SfxName } from '../core/types';
import './ui.css';
import { LiveText, h, setFlag, setOpen, wordmark } from './dom';
import { loadUiFonts } from './fonts';
import { GameOver } from './gameover';
import { Hud } from './hud';
import { Menus } from './menu';
import type { UiSound } from './nav';
import { Banner, Popups, type PopupKind } from './popups';

export interface UiDeps {
  events: IEventBus;
  root: HTMLElement;
  onSound?: (name: SfxName) => void;
}

const MENU_STATES: ReadonlySet<GameState> = new Set(['menu', 'paused', 'gameover']);
/** States in which the car is on screen and the pointer cursor is hidden. */
const PLAY_STATES: ReadonlySet<GameState> = new Set(['intro', 'playing', 'crashed']);
/** Driving keys: the first one pressed in a run starts the key-hint fade-out. */
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);
/** Game action keys that must not reach the game while a menu owns the keyboard. */
const GAME_ACTION_KEYS = new Set(['KeyP', 'KeyR', 'KeyC', 'ShiftLeft', 'ShiftRight', 'Tab']);

export function createUi(deps: UiDeps): IUi {
  void loadUiFonts();
  const { events } = deps;

  // ── sound (hover ticks are rate-limited so holding an arrow key does not machine-gun)
  let lastHover = 0;
  const sound = (n: UiSound): void => {
    if (n === 'uiHover') {
      const now = performance.now();
      if (now - lastHover < 45) return;
      lastHover = now;
    }
    deps.onSound?.(n);
  };

  const isTouchOnly =
    document.documentElement.dataset.nsTouch === '1' ||
    // Coarse primary pointer and no fine pointer at all (a touch laptop with a trackpad is not touch-only).
    (typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);

  // ── loading
  const loadFill = h('span.ns-progress__fill');
  const loadPct = new LiveText('0%');
  const loadLabel = new LiveText('Loading');
  const loading = h(
    'section.ns-layer.ns-loading',
    { role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h(
      'div.ns-loading__inner',
      null,
      wordmark('div', 'ns-wordmark--loading'),
      h('div.ns-progress', null, h('span.ns-progress__track', null, loadFill)),
      h('div.ns-loading__meta', null, h('span.ns-loading__label', null, loadLabel.node), h('span.ns-loading__pct', null, loadPct.node)),
    ),
  );

  // ── one-shot action guard: a menu action is sent once until the game changes state
  let pending = false;
  let pendingTimer = 0;
  const once = (fn: () => void) => () => {
    if (pending) return;
    pending = true;
    // Safety valve: if the game ignores the request (still loading...), allow a retry.
    clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => (pending = false), 1500);
    blurInside();
    fn();
  };

  const menus = new Menus(sound, {
    play: once(() => events.emit('uiPlay', {})),
    resume: once(() => events.emit('uiResume', {})),
    pauseToggle: once(() => events.emit('uiPauseToggle', {})),
    restart: once(() => events.emit('uiRestart', {})),
    quit: once(() => events.emit('uiQuitToMenu', {})),
    setQuality: (level: QualityLevel) => events.emit('uiSetQuality', { level }),
    setVolume: (master: number) => events.emit('uiSetVolume', { master }),
    setMuted: (muted: boolean) => events.emit('uiSetMuted', { muted }),
  });

  const gameOver = new GameOver(sound, {
    again: once(() => (sound('uiStart'), events.emit('uiRestart', {}))),
    menu: once(() => (sound('uiBack'), events.emit('uiQuitToMenu', {}))),
  });

  const hud = new Hud();
  const popups = new Popups(hud.popupHost);
  const banner = new Banner();

  const intro = h(
    'section.ns-layer.ns-intro',
    { 'aria-live': 'polite' },
    h('div.ns-intro__inner', null, h('div.ns-intro__text', null, 'Get ready'), h('span.ns-intro__line', { 'aria-hidden': 'true' })),
  );

  // Diagnostics exist only with ?debug in the URL, whatever the game sends.
  const debugAllowed = (() => {
    try {
      return new URLSearchParams(location.search).has('debug');
    } catch {
      return false;
    }
  })();
  const debugText = new LiveText('');
  const debug = debugAllowed ? h('div.ns-debug', { 'aria-hidden': 'true' }, debugText.node) : null;

  const root = h(
    'div.ns',
    { 'data-state': 'boot' },
    hud.el,
    banner.el,
    intro,
    menus.el,
    gameOver.el,
    loading,
    debug,
  );
  // Touch-only device: the main menu shows a "needs a keyboard" notice instead of PLAY. A real
  // key press (tablet with a keyboard, touch laptop) dismisses it for the session.
  setFlag(root, 'data-touch', isTouchOnly);
  deps.root.append(root);

  for (const l of [menus.el, gameOver.el, intro, hud.el]) setOpen(l, false);
  setOpen(loading, true);

  function blurInside(): void {
    const a = document.activeElement;
    if (a instanceof HTMLElement && root.contains(a)) a.blur();
  }

  // ── state machine
  let state: GameState = 'boot';

  function setState(next: GameState): void {
    const prev = state;
    state = next;
    pending = false;
    root.setAttribute('data-state', next);
    if (next !== 'boot') setOpen(loading, false);

    // 'intro' always starts a run (also restart from pause / crash); 'playing' straight from a
    // menu is a run without intro.
    const freshRun = next === 'intro' || (next === 'playing' && (prev === 'menu' || prev === 'gameover' || prev === 'boot'));
    if (freshRun) {
      hud.resetRun();
      popups.clear();
      banner.set(null);
    }

    // Menu shell
    if (next === 'menu') {
      setOpen(menus.el, true);
      menus.open('main');
    } else if (next === 'paused') {
      setOpen(menus.el, true);
      menus.open('pause');
    } else {
      menus.close();
      setOpen(menus.el, false);
    }

    // Game over
    if (next === 'gameover') {
      setOpen(gameOver.el, true);
      gameOver.play();
      banner.set(null);
    } else {
      gameOver.stop();
      setOpen(gameOver.el, false);
    }

    setOpen(intro, next === 'intro');
    setOpen(hud.el, next === 'playing' || next === 'paused' || next === 'crashed');
    if (next === 'crashed') hud.el.setAttribute('data-dim', 'crash');
    else if (next === 'paused') hud.el.setAttribute('data-dim', 'pause');
    else hud.el.removeAttribute('data-dim');
    // A burning wreck fills the frame with fire: keep the glare scrim up while crashed.
    setGlare(next === 'crashed' ? Infinity : 0);
    document.documentElement.toggleAttribute('data-ns-play', PLAY_STATES.has(next));
    hud.setHintsAllowed(next === 'intro' || next === 'playing');
    if (next === 'menu' || next === 'gameover') popups.clear();

    if (!MENU_STATES.has(next)) blurInside();
  }

  // ── glare: explosions blow the frame out to white / orange behind the HUD corners
  let glareTimer = 0;
  function setGlare(ms: number): void {
    clearTimeout(glareTimer);
    if (ms <= 0) {
      if (state !== 'crashed') setFlag(hud.el, 'data-glare', false);
      return;
    }
    setFlag(hud.el, 'data-glare', true);
    if (Number.isFinite(ms)) glareTimer = window.setTimeout(() => state !== 'crashed' && setFlag(hud.el, 'data-glare', false), ms);
  }
  events.on('explosion', (e) => {
    if (state === 'playing' || state === 'intro') setGlare(1300 + 500 * Math.min(2.5, e.scale));
  });

  // ── keyboard (capture phase: runs before the game's Input listener on window)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!MENU_STATES.has(state)) {
        // Driving: the UI never consumes keys, it only watches for the first driving input
        // and stops Tab from walking focus out of the game into the browser chrome.
        if (state === 'intro' || state === 'playing') {
          if (DRIVE_KEYS.has(e.code)) hud.noteDriveInput();
          if (e.code === 'Tab') e.preventDefault();
        }
        return;
      }
      if (isTouchOnly && !root.hasAttribute('data-kb') && state === 'menu') {
        // First key on a "touch-only" device: there is a keyboard after all.
        if (/^(Shift|Control|Alt|Meta)/.test(e.code) || e.code === '') return;
        root.setAttribute('data-kb', '');
        menus.nav?.refresh(0);
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      let consumed = false;
      if (state === 'gameover') {
        if (!gameOver.el.hasAttribute('data-open')) return;
        if (performance.now() < gameOver.guardUntil) consumed = /^(Enter|NumpadEnter|Space|KeyR|Escape)$/.test(e.code);
        else if (e.code === 'KeyR' && !e.repeat) {
          gameOver.nav.items[0]!.activate?.();
          consumed = true;
        } else consumed = gameOver.nav.handleKey(e);
      } else {
        const nav = menus.nav;
        if (!nav) return;
        if (state === 'paused' && menus.screen === 'pause' && e.code === 'KeyR' && !e.repeat) {
          nav.items[1]!.activate?.();
          consumed = true;
        } else if (state === 'paused' && menus.screen === 'pause' && e.code === 'KeyP' && !e.repeat) {
          // P paused the game, so P resumes it (Esc does too, through the nav's back action).
          nav.onBack?.();
          consumed = true;
        } else consumed = nav.handleKey(e);
      }
      // Game keys never leak through an open menu (P would unpause under SETTINGS, C would
      // flip the camera behind the pause screen...).
      if (!consumed && GAME_ACTION_KEYS.has(e.code)) consumed = true;
      if (consumed) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );

  return {
    setLoading(progress: number, label?: string): void {
      const p = Math.max(0, Math.min(1, progress));
      loadFill.style.transform = `scaleX(${p})`;
      const pct = Math.round(p * 100);
      loadPct.set(`${pct}%`);
      loading.setAttribute('aria-valuenow', String(pct));
      if (label !== undefined) loadLabel.set(label);
    },
    setState,
    updateHud(s: HudState): void {
      hud.update(s);
    },
    popup(text: string, kind: PopupKind): void {
      if (state === 'menu' || state === 'gameover') return;
      popups.push(text, kind);
    },
    banner(text: string | null, kind?: 'warning' | 'info'): void {
      banner.set(text, kind);
    },
    showGameOver(s: RunSummary): void {
      gameOver.setSummary(s);
      if (state === 'gameover') gameOver.play();
    },
    setSettings(s: { quality: QualityLevel; volume: number; muted: boolean; cameraMode: CameraMode }): void {
      menus.setSettings(s);
    },
    setDebug(text: string): void {
      if (!debug) return;
      debugText.set(text);
      const on = text.length > 0;
      setFlag(debug, 'data-on', on);
      setFlag(root, 'data-debug', on);
    },
  };
}
