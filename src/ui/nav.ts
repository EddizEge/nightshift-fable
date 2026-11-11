/**
 * Keyboard + mouse navigation for menu screens, and the three setting controls
 * (segmented, slider, switch). One item is always "selected" — game menus show a selection
 * even before the user touches anything, so keyboard players always know where they are.
 *
 * Selection changes are deliberately NOT animated (they are keyboard-driven and repeated
 * constantly); only colour/opacity eases for ~100 ms so it does not flicker.
 */
import { h } from './dom';

export type UiSound = 'uiHover' | 'uiClick' | 'uiStart' | 'uiBack';

export interface NavItem {
  el: HTMLElement;
  /** Enter / Space / click. */
  activate?: () => void;
  /** ← / → (A / D). */
  adjust?: (dir: -1 | 1) => void;
}

const KEY_PREV = new Set(['ArrowUp', 'KeyW']);
const KEY_NEXT = new Set(['ArrowDown', 'KeyS']);
const KEY_LEFT = new Set(['ArrowLeft', 'KeyA']);
const KEY_RIGHT = new Set(['ArrowRight', 'KeyD']);
const KEY_OK = new Set(['Enter', 'NumpadEnter', 'Space']);
const KEY_BACK = new Set(['Escape', 'Backspace']);

export class NavList {
  index = 0;
  /** Escape handler for this list (screen back / resume). */
  onBack: (() => void) | null = null;

  constructor(
    readonly items: NavItem[],
    private readonly sound: (n: UiSound) => void,
  ) {
    items.forEach((it, i) => {
      it.el.setAttribute('data-nav', '');
      if (!it.el.hasAttribute('tabindex') && !(it.el instanceof HTMLButtonElement)) it.el.tabIndex = -1;
      // Mouse hover moves the selection (like every console/PC game menu). Touch taps do not
      // need hover feedback, so only fine pointers participate.
      it.el.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse' && this.index !== i) this.select(i, true);
      });
      it.el.addEventListener('click', (e) => {
        // Clicks inside sub-controls (segments, slider) are handled by those controls.
        if ((e.target as HTMLElement).closest('[data-subcontrol]')) return;
        if (this.index !== i) this.select(i, false);
        it.activate?.();
      });
    });
    this.select(0, false, false);
  }

  /** Mark `i` selected; optionally play the hover tick and move DOM focus (for screen readers). */
  select(i: number, withSound: boolean, focus = true): void {
    const n = this.items.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    const prev = this.items[this.index];
    if (prev) prev.el.removeAttribute('data-selected');
    this.index = i;
    const cur = this.items[i]!;
    cur.el.setAttribute('data-selected', '');
    if (focus && !cur.el.closest('[inert]')) cur.el.focus({ preventScroll: true });
    if (withSound) this.sound('uiHover');
  }

  /** Re-apply the selection (after the screen became visible) without sound. */
  refresh(index = this.index): void {
    this.select(index, false, true);
  }

  /** Returns true when the key was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    const code = e.code || e.key;
    if (KEY_PREV.has(code) || (code === 'Tab' && e.shiftKey)) {
      this.select(this.index - 1, true);
      return true;
    }
    if (KEY_NEXT.has(code) || code === 'Tab') {
      this.select(this.index + 1, true);
      return true;
    }
    const item = this.items[this.index];
    if (KEY_LEFT.has(code) || KEY_RIGHT.has(code)) {
      if (item?.adjust) item.adjust(KEY_LEFT.has(code) ? -1 : 1);
      return true;
    }
    if (KEY_OK.has(code)) {
      if (!e.repeat) item?.activate?.();
      return true;
    }
    if (KEY_BACK.has(code)) {
      if (!e.repeat && this.onBack) this.onBack();
      return true;
    }
    return false;
  }
}

// ───────────────────────────────────────────────────────────── buttons

export function menuButton(label: string, opts: { hint?: string; primary?: boolean; sub?: string } = {}): HTMLButtonElement {
  const b = h<'button'>('button.ns-btn', { type: 'button' });
  if (opts.primary) b.classList.add('ns-btn--primary');
  const text = h('span.ns-btn__label', null, label);
  b.append(h('span.ns-btn__bar', { 'aria-hidden': 'true' }), text);
  if (opts.sub) b.append(h('span.ns-btn__sub', null, opts.sub));
  if (opts.hint) b.append(h('span.ns-btn__hint', { 'aria-hidden': 'true' }, opts.hint));
  return b;
}

// ───────────────────────────────────────────────────────────── settings rows

function row(label: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
  const r = h('div.ns-row');
  r.append(h('span.ns-row__label', null, label), control);
  if (value) r.append(value);
  return r;
}

export interface SegmentedControl extends NavItem {
  set(index: number): void;
}

export function segmented(label: string, options: readonly string[], onChange: (i: number) => void, sound: (n: UiSound) => void): SegmentedControl {
  const group = h('div.ns-seg', { role: 'radiogroup', 'aria-label': label, 'data-subcontrol': '' });
  group.style.setProperty('--n', String(options.length));
  const thumb = h('span.ns-seg__thumb', { 'aria-hidden': 'true' });
  group.append(thumb);
  let current = -1;
  const buttons = options.map((o, i) => {
    const b = h<'button'>('button.ns-seg__opt', { type: 'button', role: 'radio', tabindex: -1 }, o);
    b.addEventListener('click', () => choose(i));
    group.append(b);
    return b;
  });
  const el = row(label, group);
  el.classList.add('ns-row--seg');

  function set(i: number): void {
    if (i === current) return;
    current = i;
    buttons.forEach((b, j) => b.setAttribute('aria-checked', j === i ? 'true' : 'false'));
    thumb.style.transform = `translateX(${i * 100}%)`;
  }
  function choose(i: number): void {
    i = Math.max(0, Math.min(options.length - 1, i));
    if (i === current) return;
    set(i);
    sound('uiClick');
    onChange(i);
  }
  return {
    el,
    set,
    adjust: (d) => choose(current + d),
    // Enter cycles, which is what people expect from a focused option row.
    activate: () => choose((current + 1) % options.length),
  };
}

export interface SliderControl extends NavItem {
  set(v01: number): void;
}

export function slider(label: string, onChange: (v01: number) => void, sound: (n: UiSound) => void, step = 0.05): SliderControl {
  const fill = h('span.ns-slider__fill');
  const rail = h('span.ns-slider__rail', null, h('span.ns-slider__thumb'));
  const track = h('span.ns-slider__track', null, fill);
  const s = h('div.ns-slider', { 'data-subcontrol': '' }, track, rail);
  const value = h('span.ns-row__value');
  const el = row(label, s, value);
  el.classList.add('ns-row--slider');
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  let v = -1;

  function set(x: number): void {
    x = Math.max(0, Math.min(1, x));
    if (x === v) return;
    v = x;
    // Fill scales and the thumb rides a full-width rail translated by its own width:
    // transform-only, so dragging never triggers layout.
    fill.style.transform = `scaleX(${x})`;
    rail.style.transform = `translateX(${(x - 1) * 100}%)`;
    const pct = String(Math.round(x * 100));
    value.textContent = pct;
    el.setAttribute('aria-valuenow', pct);
  }
  function change(x: number, withSound: boolean): void {
    x = Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
    if (x === v) return;
    set(x);
    if (withSound) sound('uiClick');
    onChange(x);
  }

  // Pointer drag with capture so the drag keeps tracking outside the thin track.
  let dragging = -1;
  const fromEvent = (e: PointerEvent): number => {
    const r = s.getBoundingClientRect();
    return (e.clientX - r.left) / Math.max(1, r.width);
  };
  s.addEventListener('pointerdown', (e) => {
    if (dragging !== -1 || e.button !== 0) return; // ignore second fingers / other buttons
    dragging = e.pointerId;
    s.setPointerCapture(e.pointerId);
    el.setAttribute('data-dragging', '');
    change(fromEvent(e), false);
  });
  s.addEventListener('pointermove', (e) => {
    if (e.pointerId === dragging) change(fromEvent(e), false);
  });
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== dragging) return;
    dragging = -1;
    el.removeAttribute('data-dragging');
    sound('uiClick');
  };
  s.addEventListener('pointerup', end);
  s.addEventListener('pointercancel', end);

  return { el, set, adjust: (d) => change(v + d * step, true) };
}

export interface ToggleControl extends NavItem {
  set(on: boolean): void;
}

export function toggle(label: string, onChange: (on: boolean) => void, sound: (n: UiSound) => void): ToggleControl {
  const state = h('span.ns-switch__state');
  const sw = h('span.ns-switch', { 'aria-hidden': 'true' }, h('span.ns-switch__knob'));
  const ctl = h('span.ns-switch-wrap', null, state, sw);
  const el = row(label, ctl);
  el.classList.add('ns-row--toggle');
  el.setAttribute('role', 'switch');
  el.setAttribute('aria-label', label);
  let on: boolean | null = null;
  function set(x: boolean): void {
    if (x === on) return;
    on = x;
    el.setAttribute('aria-checked', x ? 'true' : 'false');
    el.toggleAttribute('data-on', x);
    state.textContent = x ? 'On' : 'Off';
  }
  function flip(x: boolean): void {
    if (x === on) return;
    set(x);
    sound('uiClick');
    onChange(x);
  }
  return {
    el,
    set,
    activate: () => flip(!on),
    adjust: (d) => flip(d > 0),
  };
}
