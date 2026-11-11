/**
 * One-shot sound bank: renders every procedural recipe into AudioBuffers (several seeded variants
 * per sound so repeats never sound identical), finishes them (DC block + click-free fades) and
 * normalises each to its mix peak level. The mix balance between one-shots lives here, in one table.
 */
import type { SfxName } from '../core/types';
import { dbToGain, finish, makeBuffer, normalize, renderRate, rng, type Rng, type Stereo } from './dsp';
import * as ui from './sfxUi';
import * as world from './sfxWorld';

export type BusName = 'engine' | 'road' | 'ambience' | 'sfx' | 'ui';

export interface SfxDef {
  render: (sr: number, r: Rng) => Stereo;
  /** Seeded variants rendered (picked round-robin with a random start). */
  variants: number;
  /** Peak level of the rendered buffer in dBFS (before bus / voice gains). */
  peakDb: number;
  bus: BusName;
  /** Max simultaneous voices of this sound; the oldest is faded out beyond that. */
  poly: number;
  /** Random playback-rate spread (± fraction) for natural repeats. */
  spread: number;
  /** Ducks the ambience / road beds while it plays (explosions, big crashes). */
  duck?: { depth: number; release: number };
}

export const SFX: Record<SfxName, SfxDef> = {
  uiHover: { render: ui.uiHover, variants: 2, peakDb: -20, bus: 'ui', poly: 2, spread: 0.01 },
  uiClick: { render: ui.uiClick, variants: 2, peakDb: -14, bus: 'ui', poly: 2, spread: 0.01 },
  uiStart: { render: ui.uiStart, variants: 1, peakDb: -9, bus: 'ui', poly: 1, spread: 0 },
  uiBack: { render: ui.uiBack, variants: 1, peakDb: -15, bus: 'ui', poly: 2, spread: 0.01 },
  nearMiss: { render: ui.nearMiss, variants: 3, peakDb: -11, bus: 'ui', poly: 3, spread: 0.02 },
  bonus: { render: ui.bonus, variants: 1, peakDb: -12, bus: 'ui', poly: 2, spread: 0 },
  warning: { render: ui.warning, variants: 1, peakDb: -12, bus: 'ui', poly: 1, spread: 0 },
  gameOver: { render: ui.gameOver, variants: 1, peakDb: -7, bus: 'ui', poly: 1, spread: 0 },
  newBest: { render: ui.newBest, variants: 1, peakDb: -9, bus: 'ui', poly: 1, spread: 0 },
  crashLight: { render: world.crashLight, variants: 3, peakDb: -6, bus: 'sfx', poly: 4, spread: 0.05 },
  crashHeavy: {
    render: world.crashHeavy, variants: 3, peakDb: -3, bus: 'sfx', poly: 3, spread: 0.04,
    duck: { depth: 0.55, release: 1.2 },
  },
  scrape: { render: world.scrape, variants: 2, peakDb: -9, bus: 'sfx', poly: 3, spread: 0.06 },
  glass: { render: (sr, r) => world.glass(sr, r, 1), variants: 3, peakDb: -8, bus: 'sfx', poly: 3, spread: 0.05 },
  explosion: {
    render: (sr, r) => world.explosion(sr, r, false), variants: 2, peakDb: -2.5, bus: 'sfx', poly: 3, spread: 0.04,
    duck: { depth: 0.4, release: 2.0 },
  },
  explosionBig: {
    render: (sr, r) => world.explosion(sr, r, true), variants: 2, peakDb: -1.5, bus: 'sfx', poly: 2, spread: 0.03,
    duck: { depth: 0.3, release: 3.2 },
  },
  thunder: { render: world.thunder, variants: 3, peakDb: -6, bus: 'ambience', poly: 2, spread: 0.06 },
  nitroStart: { render: world.nitroStart, variants: 1, peakDb: -8, bus: 'sfx', poly: 1, spread: 0.02 },
  nitroEnd: { render: world.nitroEnd, variants: 1, peakDb: -11, bus: 'sfx', poly: 1, spread: 0.02 },
  horn: { render: world.horn, variants: 2, peakDb: -10, bus: 'sfx', poly: 3, spread: 0.015 },
  passBy: { render: world.passBy, variants: 3, peakDb: -10, bus: 'sfx', poly: 4, spread: 0.07 },
  splash: { render: world.splash, variants: 3, peakDb: -10, bus: 'sfx', poly: 3, spread: 0.06 },
};

export const SFX_NAMES = Object.keys(SFX) as SfxName[];

/** Hashes the name into a stable seed so every sound has its own deterministic variants. */
function seedOf(name: string, v: number): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return (h ^ Math.imul(v + 1, 0x9e3779b1)) >>> 0;
}

/** Render all variants of one sound (pure: used by the render worker and the main-thread fallback). */
export function renderSfx(name: SfxName, sr: number): Stereo[] {
  const def = SFX[name];
  const list: Stereo[] = [];
  for (let v = 0; v < def.variants; v++) {
    const st = def.render(sr, rng(seedOf(name, v)));
    const len = st.L.length / sr;
    // Long baked reverb tails get a proportionally long release so the buffer end is inaudible.
    finish(st, 0.0008, Math.min(0.35, Math.max(0.03, len * 0.12)));
    normalize(st, dbToGain(def.peakDb));
    list.push(st);
  }
  return list;
}

/** Warm-up order: what the menu needs first, then what a run needs, the end-of-run stingers last. */
export const WARM_ORDER: readonly SfxName[] = [
  'uiHover', 'uiClick', 'uiBack', 'warning', 'crashLight', 'crashHeavy', 'glass', 'nearMiss', 'passBy', 'nitroStart',
  'nitroEnd', 'explosion', 'explosionBig', 'scrape', 'bonus', 'horn', 'splash', 'thunder', 'uiStart', 'gameOver', 'newBest',
];

/** Requests a render; implemented by Renderer (render.ts). Kept as a type so the worker bundle never imports it. */
export interface RenderService {
  request(job: { kind: 'sfx'; name: SfxName; sr: number }): Promise<Stereo[]>;
}

/** Page-lifetime cache of context-free buffers, keyed by render rate + name (survives context rebuilds). */
const cache = new Map<string, AudioBuffer[]>();
const inflight = new Map<string, Promise<AudioBuffer[] | null>>();

export class SfxBank {
  /** Rate the buffers are rendered at. */
  readonly sr: number;
  private readonly cursor = new Map<SfxName, number>();
  /** play() calls that found their sound not rendered yet (skipped, render requested). */
  missed = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly renderer: RenderService | null = null,
  ) {
    this.sr = renderRate(ctx.sampleRate);
  }

  private key(name: SfxName): string {
    return this.sr + ':' + name;
  }

  has(name: SfxName): boolean {
    return cache.has(this.key(name));
  }

  /** Synchronous render on the calling thread (sandbox statistics; never used by play()). */
  render(name: SfxName): AudioBuffer[] {
    const k = this.key(name);
    let list = cache.get(k);
    if (!list) {
      list = renderSfx(name, this.sr).map((st) => makeBuffer(st, this.ctx));
      cache.set(k, list);
    }
    return list;
  }

  /** Asynchronous render (worker); resolves null if it failed. */
  load(name: SfxName): Promise<AudioBuffer[] | null> {
    const k = this.key(name);
    const have = cache.get(k);
    if (have) return Promise.resolve(have);
    let p = inflight.get(k);
    if (!p) {
      const job = { kind: 'sfx' as const, name, sr: this.sr };
      const src = this.renderer
        ? this.renderer.request(job)
        : new Promise<Stereo[]>((res) => setTimeout(() => res(renderSfx(name, this.sr)), 0));
      p = src.then(
        (sts) => {
          const list = cache.get(k) ?? sts.map((st) => makeBuffer(st, this.ctx));
          cache.set(k, list);
          inflight.delete(k);
          return list;
        },
        (e) => {
          console.warn('[audio] render failed', name, e);
          inflight.delete(k);
          return null;
        },
      );
      inflight.set(k, p);
    }
    return p;
  }

  /** Next variant (round-robin, so the same variant never plays twice in a row); null while still rendering. */
  next(name: SfxName): AudioBuffer | null {
    const list = cache.get(this.key(name));
    if (!list) {
      this.missed++;
      void this.load(name);
      return null;
    }
    let c = this.cursor.get(name);
    if (c === undefined) c = (Math.random() * list.length) | 0;
    this.cursor.set(name, (c + 1) % list.length);
    return list[c % list.length];
  }

  /** Render everything (in the worker, one sound at a time so urgent requests are not stuck behind it). */
  async warm(order: readonly SfxName[] = WARM_ORDER): Promise<void> {
    for (const name of order) await this.load(name);
    for (const name of SFX_NAMES) await this.load(name);
  }
}
