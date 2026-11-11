/**
 * In-run HUD. updateHud() is called every frame, so every displayed value is cached and the
 * DOM is only written when the *displayed* value changes (rounded / quantised first). Bars
 * move with transform only; colour bands switch with a data attribute.
 */
import type { HudState } from '../core/types';
import { LiveText, arrowIcon, h, kbd, prefersReducedMotion, setFlag } from './dom';

/** Quantise bar values so sub-pixel noise does not cause style writes every frame. */
const q = (x: number, steps: number): number => Math.round(Math.max(0, Math.min(1, x)) * steps) / steps;

const fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatScore(n: number): string {
  return fmtInt.format(Math.max(0, Math.floor(n)));
}

/** 75.4 s → { main: "01:15", frac: ".4" } */
export function formatTime(sec: number): { main: string; frac: string } {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const t = Math.floor((s * 10) % 10);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  // Past an hour: 1:02:05 (an endless run must never read as "62:05").
  const main = m >= 60 ? `${Math.floor(m / 60)}:${p2(m % 60)}:${p2(ss)}` : `${p2(m)}:${p2(ss)}`;
  return { main, frac: `.${t}` };
}

export function formatKm(m: number): string {
  return (Math.max(0, m) / 1000).toFixed(2);
}

type Band = 'normal' | 'warm' | 'hot';

/** Seconds the key hints stay up after the first driving key, and the fallback without input. */
const HINTS_AFTER_INPUT = 3;
const HINTS_MAX = 9;
/** Hints are shown on the first run of a page session only. */
let hintsSessionDone = false;

export class Hud {
  readonly el: HTMLElement;
  readonly popupHost: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly vignette: HTMLElement;

  // top-left
  private readonly distText = new LiveText('0.00');
  private readonly timeMain = new LiveText('00:00');
  private readonly timeFrac = new LiveText('.0');
  // top-right
  private readonly scoreText = new LiveText('0');
  private readonly comboWrap: HTMLElement;
  private readonly comboValue: HTMLElement;
  private readonly comboText = new LiveText('×1');
  private readonly comboBar: HTMLElement;
  // speedo
  private readonly digits: { el: HTMLElement; t: LiveText }[] = [];
  private readonly gearText = new LiveText('N');
  private readonly rpmFill: HTMLElement;
  private readonly rpmWrap: HTMLElement;
  private readonly nitroWrap: HTMLElement;
  private readonly nitroFill: HTMLElement;
  private readonly integrityWrap: HTMLElement;
  private readonly integrityText = new LiveText('100');
  private readonly integrityFill: HTMLElement;

  // last displayed values (NaN forces the first write)
  private last = { speed: NaN, rpm: NaN, band: '' as Band | '', nitro: NaN, nitroOn: false, combo: NaN, comboT: NaN, dmg: NaN, dmgLevel: -1, vig: NaN, hintsOn: false, score: NaN };
  private hintsEnabled = false;
  /** survivalTime at which the hints ease out (first input pulls it in). */
  private hintsHideAt = HINTS_MAX;
  private lastSurvival = 0;

  constructor() {
    // ── top-left: distance + time
    const tl = h(
      'div.ns-hud__tl.ns-corner',
      null,
      h('div.ns-stat', null, h('span.ns-label', null, 'Distance'), h('span.ns-stat__value', null, this.distText.node, h('span.ns-unit', null, 'km'))),
      h('span.ns-vrule', { 'aria-hidden': 'true' }),
      h('div.ns-stat', null, h('span.ns-label', null, 'Time'), h('span.ns-stat__value', null, this.timeMain.node, h('span.ns-frac', null, this.timeFrac.node))),
    );

    // ── top-right: score + combo + popups
    this.comboBar = h('span.ns-combo__fill');
    this.comboValue = h('span.ns-combo__value', null, this.comboText.node);
    this.comboWrap = h(
      'div.ns-combo',
      null,
      h('div.ns-combo__head', null, h('span.ns-label.ns-label--amber', null, 'Combo'), this.comboValue),
      h('span.ns-combo__track', null, this.comboBar),
    );
    this.popupHost = h('div.ns-popups', { 'aria-live': 'polite' });
    const tr = h(
      'div.ns-hud__tr.ns-corner',
      null,
      h('div.ns-score', null, h('span.ns-label', null, 'Score'), h('span.ns-score__value', null, this.scoreText.node)),
      this.comboWrap,
      this.popupHost,
    );

    // ── bottom-right: speedometer cluster
    const speedNum = h('span.ns-speed__num', { 'aria-hidden': 'true' });
    for (let i = 0; i < 3; i++) {
      const t = new LiveText('0');
      const el = h('span.ns-digit', null, t.node);
      speedNum.append(el);
      this.digits.push({ el, t });
    }
    this.rpmFill = h('span.ns-rpm__fill');
    this.rpmWrap = h('div.ns-rpm', { 'aria-hidden': 'true' }, h('span.ns-rpm__track', null, this.rpmFill, h('span.ns-rpm__red')));
    this.nitroFill = h('span.ns-meter__fill');
    this.nitroWrap = h(
      'div.ns-meter.ns-meter--nitro',
      null,
      h('span.ns-label', null, 'Nitro'),
      h('span.ns-meter__track', null, this.nitroFill, h('span.ns-meter__glow')),
    );
    this.integrityFill = h('span.ns-meter__fill');
    this.integrityWrap = h(
      'div.ns-meter.ns-meter--integrity',
      null,
      h('span.ns-label', null, 'Integrity'),
      h('span.ns-meter__track', null, this.integrityFill),
      h('span.ns-meter__value', null, this.integrityText.node, '%'),
    );
    const br = h(
      'div.ns-hud__br.ns-corner',
      null,
      h(
        'div.ns-speed',
        null,
        h('div.ns-gear', null, h('span.ns-label', null, 'Gear'), h('span.ns-gear__value', null, this.gearText.node)),
        h('div.ns-speed__main', null, speedNum, h('span.ns-speed__unit', null, 'km/h')),
      ),
      this.rpmWrap,
      this.nitroWrap,
      this.integrityWrap,
    );

    // ── bottom-centre: first-seconds control hints
    const hint = (keys: Array<string | Node>[], label: string): HTMLElement =>
      h('div.ns-hint', null, h('span.ns-hint__keys', null, ...keys.map((k) => kbd(...k))), h('span.ns-hint__label', null, label));
    // Two groups (driving / the rest): one line when there is room, a balanced 4 + 3 otherwise.
    this.hints = h(
      'div.ns-hints',
      { 'aria-hidden': 'true' },
      h(
        'div.ns-hints__group',
        null,
        hint([['W'], [arrowIcon('up')]], 'Accelerate'),
        hint([['S'], [arrowIcon('down')]], 'Brake'),
        hint([['A'], ['D']], 'Steer'),
        hint([['Shift']], 'Nitro'),
      ),
      h('div.ns-hints__group', null, hint([['Space']], 'Handbrake'), hint([['C']], 'Camera'), hint([['Esc']], 'Pause')),
    );

    this.vignette = h('div.ns-vignette', { 'aria-hidden': 'true' });
    this.el = h('div.ns-layer.ns-hud', { 'aria-hidden': 'true' }, this.vignette, tl, tr, br, this.hints);
  }

  /** New run: clear transient state; the control hints come back only if never dismissed. */
  resetRun(): void {
    this.hintsEnabled = !hintsSessionDone;
    this.hintsHideAt = HINTS_MAX;
    this.lastSurvival = 0;
    for (const p of Array.from(this.popupHost.children)) p.remove();
  }

  /** The player pressed a driving key: the hints have done their job, ease them out soon. */
  noteDriveInput(): void {
    if (this.hintsEnabled) this.hintsHideAt = Math.min(this.hintsHideAt, this.lastSurvival + HINTS_AFTER_INPUT);
  }

  /** Hints are allowed only during the first seconds of a run and never while crashed. */
  setHintsAllowed(allowed: boolean): void {
    if (!allowed) this.disableHints();
    this.applyHints(this.hintsEnabled && allowed);
  }

  private disableHints(): void {
    if (this.hintsEnabled) hintsSessionDone = true;
    this.hintsEnabled = false;
  }

  private applyHints(on: boolean): void {
    if (on === this.last.hintsOn) return;
    this.last.hintsOn = on;
    setFlag(this.hints, 'data-on', on);
  }

  update(s: HudState): void {
    const L = this.last;

    // ── speed (3 ghost digits: leading zeros are dimmed, width never changes)
    const speed = Math.min(999, Math.round(Math.abs(s.speedKmh)));
    if (speed !== L.speed) {
      L.speed = speed;
      const str = String(speed).padStart(3, '0');
      const firstSig = speed === 0 ? 2 : 3 - String(speed).length;
      for (let i = 0; i < 3; i++) {
        const d = this.digits[i]!;
        d.t.set(str[i]!);
        setFlag(d.el, 'data-ghost', i < firstSig);
      }
    }
    this.gearText.set(s.gear < 0 ? 'R' : s.gear === 0 ? 'N' : String(s.gear));

    // ── rpm
    const rpm = q(s.rpm01, 200);
    if (rpm !== L.rpm) {
      L.rpm = rpm;
      this.rpmFill.style.transform = `scaleX(${rpm})`;
    }
    const band: Band = s.rpm01 > 0.93 ? 'hot' : s.rpm01 > 0.8 ? 'warm' : 'normal';
    if (band !== L.band) {
      L.band = band;
      this.rpmWrap.setAttribute('data-band', band);
    }

    // ── nitro
    const nitro = q(s.nitro01, 200);
    if (nitro !== L.nitro) {
      L.nitro = nitro;
      this.nitroFill.style.transform = `scaleX(${nitro})`;
      setFlag(this.nitroWrap, 'data-full', nitro >= 0.999);
    }
    if (s.nitroActive !== L.nitroOn) {
      L.nitroOn = s.nitroActive;
      setFlag(this.nitroWrap, 'data-active', s.nitroActive);
    }

    // ── distance / time / score
    this.distText.set(formatKm(s.distance));
    const t = formatTime(s.survivalTime);
    this.timeMain.set(t.main);
    this.timeFrac.set(t.frac);
    const score = Math.floor(s.score);
    if (score !== L.score) {
      L.score = score;
      this.scoreText.set(formatScore(score));
    }

    // ── combo
    const combo = Math.max(1, Math.floor(s.combo));
    if (combo !== L.combo) {
      const increased = Number.isFinite(L.combo) && combo > L.combo;
      L.combo = combo;
      setFlag(this.comboWrap, 'data-on', combo > 1);
      if (combo > 1) this.comboText.set(`×${combo}`);
      if (increased && combo > 1) this.pulse(this.comboValue);
    }
    const ct = q(s.comboTimer01, 300);
    if (ct !== L.comboT) {
      L.comboT = ct;
      this.comboBar.style.transform = `scaleX(${ct})`;
    }

    // ── damage: invisible while healthy, then subtle → amber → red (+ edge vignette)
    const dmg = Math.max(0, Math.min(1, s.damage01));
    const integ = Math.round((1 - dmg) * 100);
    if (integ !== L.dmg) {
      L.dmg = integ;
      this.integrityText.set(String(integ));
      this.integrityFill.style.transform = `scaleX(${integ / 100})`;
    }
    const level = dmg < 0.06 ? 0 : dmg < 0.4 ? 1 : dmg < 0.7 ? 2 : 3;
    if (level !== L.dmgLevel) {
      L.dmgLevel = level;
      this.integrityWrap.setAttribute('data-level', String(level));
    }
    const vig = q(Math.max(0, (dmg - 0.45) / 0.55), 40);
    if (vig !== L.vig) {
      L.vig = vig;
      this.vignette.style.opacity = String(vig * 0.85);
    }

    // ── hints ease out a few seconds after the first input (or ~9 s into the run)
    this.lastSurvival = s.survivalTime;
    if (this.hintsEnabled && s.survivalTime >= this.hintsHideAt) this.disableHints();
    this.applyHints(this.hintsEnabled);
  }

  /** Short scale pulse (WAAPI → compositor; interrupting just restarts it). */
  private pulse(el: HTMLElement): void {
    if (prefersReducedMotion()) return;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(
      [
        { transform: 'scale(1)', textShadow: '0 0 0 rgba(246,166,60,0)' },
        { transform: 'scale(1.22)', textShadow: '0 0 18px rgba(246,166,60,0.65)', offset: 0.3 },
        { transform: 'scale(1)', textShadow: '0 0 0 rgba(246,166,60,0)' },
      ],
      { duration: 320, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    );
  }
}
