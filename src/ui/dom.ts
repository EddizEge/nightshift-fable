/**
 * Minimal DOM helpers for the UI layer (no framework). Everything is built once at start-up;
 * per-frame code only writes text/transforms through the cached setters in hud.ts.
 */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/** `h('div.ns-a.ns-b', { role: 'x' }, child...)` → element. Tag defaults to div. */
export function h<K extends keyof HTMLElementTagNameMap = 'div'>(
  sel: string,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div') as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** SVG element helper (namespaced). */
export function svg(tag: string, attrs: Attrs, ...children: Element[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/**
 * Text node whose content is only written when it actually changes (updateHud runs every
 * frame; writing identical text still invalidates layout in some engines).
 */
export class LiveText {
  readonly node: Text;
  private value = '';
  constructor(initial = '') {
    this.node = document.createTextNode(initial);
    this.value = initial;
  }
  set(v: string): boolean {
    if (v === this.value) return false;
    this.value = v;
    this.node.data = v;
    return true;
  }
  get(): string {
    return this.value;
  }
}

/** Toggle an attribute flag only when it changes. */
export function setFlag(el: Element, name: string, on: boolean): void {
  if (el.hasAttribute(name) !== on) el.toggleAttribute(name, on);
}

/** Show / hide a layer: `data-open` drives the CSS transition, `inert` keeps hidden controls out of focus. */
export function setOpen(el: HTMLElement, open: boolean): void {
  setFlag(el, 'data-open', open);
  el.inert = !open;
  el.setAttribute('aria-hidden', open ? 'false' : 'true');
}

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Thin chevron arrow used in key caps (the latin font subsets lack ← →). */
export function arrowIcon(dir: 'up' | 'down' | 'left' | 'right'): SVGElement {
  const rot = { up: 0, right: 90, down: 180, left: 270 }[dir];
  return svg(
    'svg',
    { viewBox: '0 0 12 12', class: 'ns-arrow', 'aria-hidden': 'true', style: `transform: rotate(${rot}deg)` },
    svg('path', { d: 'M6 2.2v7.6M2.8 5.2 6 2.2l3.2 3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  );
}

/** Key cap: `kbd('W')`, `kbd(arrowIcon('up'))`. */
export function kbd(...content: Array<string | Node>): HTMLElement {
  const k = h('kbd.ns-key');
  k.append(...content);
  return k;
}

/** Two-weight wordmark: heavy NIGHT + light SHIFT (reads as one word, hints at the shift change). */
export function wordmark(tag: 'h1' | 'div', extraClass = ''): HTMLElement {
  const el = h(`${tag}.ns-wordmark${extraClass ? '.' + extraClass : ''}`, { 'aria-label': 'Nightshift' });
  el.append(h('span.ns-wm-a', { 'aria-hidden': 'true' }, 'NIGHT'), h('span.ns-wm-b', { 'aria-hidden': 'true' }, 'SHIFT'));
  return el;
}
