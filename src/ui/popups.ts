/**
 * Stacked score popups ("+250 NEAR MISS x3") and the cinematic centre banner.
 *
 * Popups are absolutely positioned and stacked by transform (newest on top), so a new popup
 * slides the others down with interruptible CSS transitions instead of reflowing the column.
 */
import { h, prefersReducedMotion } from './dom';

export type PopupKind = 'nearMiss' | 'bonus' | 'warning' | 'info';

const LIFETIME: Record<PopupKind, number> = { nearMiss: 1700, bonus: 2100, warning: 2600, info: 2000 };
const MAX_VISIBLE = 4;
const EXIT_MS = 220;

interface Live {
  el: HTMLElement;
  timer: number;
  leaving: boolean;
}

/** Split "+250 NEAR MISS x3" into points / label / multiplier for typographic hierarchy. */
export function parsePopup(text: string): { points: string | null; label: string; mult: string | null } {
  let rest = text.trim();
  let points: string | null = null;
  let mult: string | null = null;
  const mm = /\s*[x×]\s?(\d+)$/i.exec(rest);
  if (mm) {
    mult = `×${mm[1]}`;
    rest = rest.slice(0, mm.index);
  }
  // Points lead ("+250 NEAR MISS") or trail ("NEAR MISS  +250", what the game sends).
  const pm = /^([+\-−]\s?[\d,.]+)\s*(.*)$/.exec(rest) ?? /^(.*?)\s*([+\-−]\s?[\d,.]+)$/.exec(rest);
  if (pm) {
    const lead = /^[+\-−]/.test(pm[1]!);
    points = (lead ? pm[1]! : pm[2]!).replace(/\s/g, '');
    rest = lead ? pm[2]! : pm[1]!;
    // Thousands separators for long bonuses ("+12500" → "+12,500").
    const n = Number(points.slice(1).replace(/,/g, ''));
    if (Number.isFinite(n) && Number.isInteger(n)) points = points[0] + n.toLocaleString('en-US');
  }
  return { points, label: rest.trim(), mult };
}

export class Popups {
  private live: Live[] = [];

  constructor(private readonly host: HTMLElement) {}

  push(text: string, kind: PopupKind): void {
    const { points, label, mult } = parsePopup(text);
    const inner = h(
      'div.ns-popup__inner',
      null,
      points ? h('span.ns-popup__pts', null, points) : null,
      label ? h('span.ns-popup__label', null, label) : null,
      mult ? h('span.ns-popup__mult', null, mult) : null,
    );
    const el = h('div.ns-popup', { 'data-kind': kind }, inner);
    this.host.prepend(el);
    const item: Live = { el, leaving: false, timer: window.setTimeout(() => this.remove(item), LIFETIME[kind]) };
    this.live.unshift(item);
    // Overflow: the oldest beyond the cap leave immediately.
    this.live.filter((l) => !l.leaving).slice(MAX_VISIBLE).forEach((l) => this.remove(l));
    this.layout();
    // Enter: start from the "from" state, then let the transition run on the next frame.
    el.setAttribute('data-enter', '');
    requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute('data-enter')));
  }

  clear(): void {
    for (const l of this.live) {
      clearTimeout(l.timer);
      l.el.remove();
    }
    this.live = [];
  }

  private remove(item: Live): void {
    if (item.leaving) return;
    item.leaving = true;
    clearTimeout(item.timer);
    item.el.setAttribute('data-leave', '');
    window.setTimeout(() => {
      item.el.remove();
      this.live = this.live.filter((l) => l !== item);
    }, EXIT_MS);
    this.layout();
  }

  /** Stack slots via transform: newest at slot 0. Leaving items keep their slot while fading. */
  private layout(): void {
    let slot = 0;
    for (const l of this.live) {
      l.el.style.translate = `0 ${slot * 120}%`;
      if (!l.leaving) slot++;
    }
  }
}

export class Banner {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private current: string | null = null;

  constructor() {
    this.text = h('div.ns-banner__text');
    this.eyebrow = h('div.ns-banner__eyebrow');
    this.el = h(
      'div.ns-banner',
      { role: 'status', 'aria-live': 'assertive' },
      h('span.ns-banner__rule.ns-banner__rule--l', { 'aria-hidden': 'true' }),
      h('div.ns-banner__body', null, this.eyebrow, this.text),
      h('span.ns-banner__rule.ns-banner__rule--r', { 'aria-hidden': 'true' }),
    );
  }

  set(text: string | null, kind: 'warning' | 'info' = 'warning'): void {
    if (text === null) {
      this.current = null;
      this.el.removeAttribute('data-open');
      return;
    }
    const changed = text !== this.current || this.el.getAttribute('data-kind') !== kind;
    this.current = text;
    this.el.setAttribute('data-kind', kind);
    this.eyebrow.textContent = kind === 'warning' ? 'Warning' : 'Notice';
    this.text.textContent = text;
    if (!changed && this.el.hasAttribute('data-open')) return;
    if (this.el.hasAttribute('data-open') && !prefersReducedMotion()) {
      // Replacing an open banner: a short blur-crossfade on the text hides the swap.
      this.text.animate([{ opacity: 0.2, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 220, easing: 'ease-out' });
    }
    this.el.setAttribute('data-open', '');
  }
}
