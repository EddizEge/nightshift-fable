/**
 * Game-over screen. Laid out in the left column (like the menu) so the wreck stays visible
 * centre-right. The final score counts up once per run; everything else is static text.
 */
import type { RunSummary } from '../core/types';
import { h, prefersReducedMotion } from './dom';
import { formatKm, formatScore, formatTime } from './hud';
import { NavList, menuButton, type UiSound } from './nav';

export class GameOver {
  readonly el: HTMLElement;
  readonly nav: NavList;
  private readonly cause: HTMLElement;
  private readonly score: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly best: HTMLElement;
  private readonly stats: Record<'distance' | 'top' | 'near' | 'time' | 'combo' | 'risk', HTMLElement>;
  private summary: RunSummary | null = null;
  private raf = 0;
  /** Count-up in flight: stop() lands it on the final value so a fading screen never freezes mid-count. */
  private counting = false;
  /** Timestamp until which activation keys are ignored (a held key must not insta-skip the screen). */
  guardUntil = 0;

  constructor(
    sound: (n: UiSound) => void,
    actions: { again: () => void; menu: () => void },
  ) {
    const stat = (label: string, unit?: string): [HTMLElement, HTMLElement] => {
      const v = h('span.ns-go__stat-value');
      const wrap = h('div.ns-go__stat', null, h('span.ns-label', null, label), h('span.ns-go__stat-line', null, v, unit ? h('span.ns-unit', null, unit) : null));
      return [wrap, v];
    };
    const [sd, vd] = stat('Distance', 'km');
    const [st, vt] = stat('Top speed', 'km/h');
    const [sn, vn] = stat('Near misses');
    const [ss, vs] = stat('Survival time');
    const [sc, vc] = stat('Best combo');
    const [sr, vr] = stat('Risk bonus');
    this.stats = { distance: vd, top: vt, near: vn, time: vs, combo: vc, risk: vr };

    this.cause = h('div.ns-go__cause');
    this.score = h('div.ns-go__score', null, '0');
    this.badge = h('span.ns-badge', null, 'New best');
    this.best = h('div.ns-go__best');

    const again = menuButton('Play again', { primary: true, hint: 'Enter' });
    const menu = menuButton('Main menu', { hint: 'Esc' });
    this.nav = new NavList(
      [
        { el: again, activate: actions.again },
        { el: menu, activate: actions.menu },
      ],
      sound,
    );
    this.nav.onBack = actions.menu;

    const panel = h(
      'div.ns-go__panel.ns-stagger',
      null,
      h('div.ns-eyebrow', null, 'Run over'),
      this.cause,
      h('div.ns-go__scorehead', null, h('span.ns-label', null, 'Final score'), this.badge),
      this.score,
      h('div.ns-go__grid', null, sd, st, sn, ss, sc, sr),
      this.best,
      h('div.ns-go__actions', { role: 'menu' }, again, menu),
    );
    this.el = h('section.ns-layer.ns-go', { 'aria-label': 'Run summary' }, h('div.ns-scrim.ns-scrim--go'), panel);
  }

  setSummary(s: RunSummary): void {
    this.summary = s;
    this.cause.textContent = s.cause || 'Wrecked';
    this.stats.distance.textContent = formatKm(s.distance);
    this.stats.top.textContent = String(Math.round(s.topSpeedKmh));
    this.stats.near.textContent = String(s.nearMisses);
    const t = formatTime(s.survivalTime);
    this.stats.time.textContent = t.main + t.frac;
    this.stats.combo.textContent = s.bestCombo > 1 ? `×${Math.floor(s.bestCombo)}` : '—';
    this.stats.risk.textContent = s.riskBonus > 0 ? `+${formatScore(s.riskBonus)}` : '0';
    this.best.replaceChildren(
      h('span.ns-label', null, 'Best score'),
      h('span.ns-go__best-value', null, formatScore(Math.max(s.bestScore, s.isNewBest ? s.score : 0))),
    );
    this.el.toggleAttribute('data-newbest', s.isNewBest);
    this.score.textContent = '0';
    this.badge.removeAttribute('data-on');
  }

  /** Called when the screen becomes visible. */
  play(): void {
    cancelAnimationFrame(this.raf);
    this.counting = false;
    this.guardUntil = performance.now() + 350;
    this.nav.refresh(0);
    const s = this.summary;
    if (!s) return;
    const target = Math.max(0, Math.floor(s.score));
    const finish = (): void => {
      this.counting = false;
      this.score.textContent = formatScore(target);
      if (s.isNewBest) this.badge.setAttribute('data-on', '');
    };
    if (prefersReducedMotion() || target === 0) return finish();
    // Count-up: duration grows gently with the score so small runs do not feel padded.
    const dur = Math.min(1400, 650 + Math.log10(target + 1) * 120);
    const t0 = performance.now() + 180; // wait for the panel to settle
    this.counting = true;
    const tick = (now: number): void => {
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      const e = 1 - Math.pow(1 - k, 4); // strong ease-out: big numbers land softly
      this.score.textContent = formatScore(target * e);
      if (k < 1) this.raf = requestAnimationFrame(tick);
      else finish();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    if (this.counting && this.summary) {
      this.counting = false;
      this.score.textContent = formatScore(Math.max(0, Math.floor(this.summary.score)));
      if (this.summary.isNewBest) this.badge.setAttribute('data-on', '');
    }
  }
}

export function readBest(): number | null {
  try {
    const raw = localStorage.getItem('nightshift.best');
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
