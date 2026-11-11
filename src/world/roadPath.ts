import type { Vector3 } from 'three';
import type { IRoadPath, RoadFrame } from '../core/types';
import { clamp, makeRng, smoothstep } from '../core/math';

const STEP = 2; // metres between centre-line samples
const S_START = -880; // the road exists (straight) this far behind s = 0
const STRAIGHT_UNTIL = 260; // no curvature before this arc length (clean opening shot)
const MAX_HEADING = 0.85; // keep the highway heading roughly "north" so it never loops back

interface Segment {
  s0: number;
  s1: number;
  k0: number;
  k1: number;
  /** Length of the curvature transition at the start of the segment. */
  ease: number;
}

/**
 * Procedural highway centre line: straights and long sweepers (R 800–2400 m) joined by
 * clothoid-like curvature transitions. Sampled every 2 m; queries interpolate.
 */
export class RoadPath implements IRoadPath {
  private xs: number[] = [];
  private zs: number[] = [];
  private hs: number[] = [];
  private ks: number[] = [];
  private rng: () => number = makeRng(1);
  private seg: Segment = { s0: S_START, s1: STRAIGHT_UNTIL, k0: 0, k1: 0, ease: 1 };
  private readonly tmp: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };

  constructor(seed = 1) {
    this.reset(seed);
  }

  reset(seed: number): void {
    this.rng = makeRng(seed * 7919 + 13);
    this.xs = [0];
    this.zs = [-S_START]; // so that s = 0 sits at the world origin
    this.hs = [0];
    this.ks = [0];
    this.seg = { s0: S_START, s1: STRAIGHT_UNTIL, k0: 0, k1: 0, ease: 1 };
    this.ensure(2400);
  }

  /** Last generated arc length. */
  get sMax(): number {
    return S_START + (this.xs.length - 1) * STEP;
  }

  private nextSegment(sFrom: number, h: number): void {
    const r = this.rng;
    const prevK = this.seg.k1;
    let k1 = 0;
    const straight = r() < 0.3 && prevK !== 0;
    if (!straight) {
      const radius = 800 + r() * r() * 1600;
      let dir = r() < 0.5 ? -1 : 1;
      // Steer the overall heading back towards 0 when it drifts.
      if (h > MAX_HEADING * 0.55) dir = -1;
      else if (h < -MAX_HEADING * 0.55) dir = 1;
      else if (prevK !== 0 && r() < 0.65) dir = -Math.sign(prevK); // S-bends read better than long spirals
      k1 = dir / radius;
    }
    const len = straight ? 180 + r() * 420 : 260 + r() * 520;
    this.seg = { s0: sFrom, s1: sFrom + len, k0: prevK, k1, ease: Math.min(len * 0.45, 140 + r() * 80) };
  }

  ensure(sMax: number): void {
    let s = this.sMax;
    if (s >= sMax) return;
    let i = this.xs.length - 1;
    let x = this.xs[i];
    let z = this.zs[i];
    let h = this.hs[i];
    while (s < sMax + STEP) {
      if (s >= this.seg.s1) this.nextSegment(s, h);
      const g = this.seg;
      const k = g.k0 + (g.k1 - g.k0) * smoothstep(0, g.ease, s - g.s0);
      const hMid = h + k * STEP * 0.5;
      x += Math.sin(hMid) * STEP;
      z -= Math.cos(hMid) * STEP;
      h += k * STEP;
      s += STEP;
      this.xs.push(x);
      this.zs.push(z);
      this.hs.push(h);
      this.ks.push(k);
      i++;
    }
  }

  frameAt(s: number, out: RoadFrame = this.tmp): RoadFrame {
    if (s > this.sMax - STEP) this.ensure(s + 400);
    const f = clamp((s - S_START) / STEP, 0, this.xs.length - 1.001);
    const i = Math.floor(f);
    const t = f - i;
    const h = this.hs[i] + (this.hs[i + 1] - this.hs[i]) * t;
    out.s = s;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t;
    out.h = h;
    out.k = this.ks[i] + (this.ks[i + 1] - this.ks[i]) * t;
    const sn = Math.sin(h);
    const cs = Math.cos(h);
    out.tx = sn;
    out.tz = -cs;
    out.rx = cs;
    out.rz = sn;
    // Before the first sample the road continues straight.
    if (s < S_START) {
      out.x += out.tx * (s - S_START);
      out.z += out.tz * (s - S_START);
    }
    return out;
  }

  toWorld(s: number, d: number, y: number, out: Vector3): Vector3 {
    const f = this.frameAt(s, this.tmp);
    out.x = f.x + f.rx * d;
    out.y = y;
    out.z = f.z + f.rz * d;
    return out;
  }

  headingAt(s: number): number {
    return this.frameAt(s, this.tmp).h;
  }

  curvatureAt(s: number): number {
    return this.frameAt(s, this.tmp).k;
  }

  project(x: number, z: number, hintS: number, out: { s: number; d: number } = { s: 0, d: 0 }): { s: number; d: number } {
    const f = this.tmp;
    let s = hintS;
    // Coarse recovery when the hint is far off.
    this.frameAt(s, f);
    let along = (x - f.x) * f.tx + (z - f.z) * f.tz;
    if (Math.abs(along) > 60) {
      let best = Infinity;
      let bestS = s;
      for (let ds = -600; ds <= 600; ds += 20) {
        this.frameAt(hintS + ds, f);
        const dx = x - f.x;
        const dz = z - f.z;
        const dist = dx * dx + dz * dz;
        if (dist < best) {
          best = dist;
          bestS = hintS + ds;
        }
      }
      s = bestS;
    }
    for (let i = 0; i < 5; i++) {
      this.frameAt(s, f);
      along = (x - f.x) * f.tx + (z - f.z) * f.tz;
      // Account for curvature: points on the inside of a bend advance faster.
      const lateral = (x - f.x) * f.rx + (z - f.z) * f.rz;
      const scale = 1 / Math.max(0.2, 1 - f.k * lateral);
      s += along * scale;
      if (Math.abs(along) < 1e-4) break;
    }
    this.frameAt(s, f);
    out.s = s;
    out.d = (x - f.x) * f.rx + (z - f.z) * f.rz;
    return out;
  }
}
