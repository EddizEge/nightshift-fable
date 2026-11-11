/**
 * Deterministic per-chunk furniture layout shared by the furniture features (each feature gets
 * its own b.rand() stream, so anything two features must agree on is decided here, once).
 */
import type { ChunkSpec, IRoadPath } from '../../../core/types';
import { makeRng } from '../../../core/math';
import { LAMP_SPACING } from '../../roadProfile';
import type { SmallSign } from './signAtlas';

export interface VergeSign {
  kind: SmallSign;
  s: number;
  /** Lateral centre of the sign face. */
  d: number;
  /** Centre height of the face. */
  y: number;
  w: number;
  h: number;
  /** Two posts (wide signs) or one. */
  posts: 1 | 2;
  /** Post base positions (d). */
  postD: number[];
  /** Mirror UVs horizontally (left-pointing chevron). */
  flipU?: boolean;
  /** Yaw of the face (rad, relative to the road). */
  yaw: number;
}

export interface FurniturePlan {
  median: boolean;
  rail: boolean;
  /** Guardrail extent [sA, sB] and whether each end is a buried terminal. */
  railA: number;
  railB: number;
  termA: boolean;
  termB: boolean;
  verge: boolean;
  signs: VergeSign[];
  phoneS: number | null;
  /** Traffic-camera pole on the right verge (s), or null. */
  cameraS: number | null;
  hecto: number[];
  delineators: number[];
  grates: number[];
}

const cache = new WeakMap<ChunkSpec, FurniturePlan>();

export const TERMINAL_LEN = 12;
/** Curvature beyond which the outside of the bend gets chevron boards (radius ≈ 1100 m). */
export const CHEVRON_K = 1 / 1100;

export function planFor(spec: ChunkSpec, road: IRoadPath): FurniturePlan {
  let p = cache.get(spec);
  if (p) return p;
  const rnd = makeRng((spec.seed ^ 0x5f3759df) >>> 0);
  const z = spec.zone;
  const railZone = (zz: string) => zz === 'city' || zz === 'industrial' || zz === 'rural';
  const median = z !== 'tunnel';
  const rail = railZone(z);
  const termA = rail && !railZone(spec.prevZone);
  const termB = rail && !railZone(spec.nextZone);
  const railA = spec.s0 + (termA ? 3 : 0);
  const railB = spec.s1 - (termB ? 3 : 0);
  const verge = rail; // verge furniture lives where there is a guardrail (not on bridges / in tunnels)

  // Occupied s positions on the right verge (lamp poles, gantry leg) to keep signs clear.
  const busy: number[] = [];
  for (const l of spec.lamps) if (l.on && l.side === 'right') busy.push(l.s);
  if (spec.gantryS !== null) busy.push(spec.gantryS);
  if (spec.overpassS !== null) busy.push(spec.overpassS - 9, spec.overpassS, spec.overpassS + 9);
  const free = (s: number, gap: number) => busy.every((b) => Math.abs(b - s) > gap) && s > spec.s0 + 2 && s < spec.s1 - 2;

  const delineators: number[] = [];
  const hecto: number[] = [];
  const grates: number[] = [];
  const signs: VergeSign[] = [];
  let phoneS: number | null = null;
  let cameraS: number | null = null;
  if (verge) {
    const step = z === 'rural' ? LAMP_SPACING : LAMP_SPACING * 2;
    for (let s = Math.ceil(spec.s0 / step) * step; s < spec.s1; s += step) {
      if (free(s, 1.5)) delineators.push(s);
    }
    for (let s = Math.ceil((spec.s0 + 0.01) / 100) * 100; s < spec.s1; s += 100) {
      if (free(s, 2)) hecto.push(s);
    }
    // One or two verge signs per chunk.
    const kinds: SmallSign[] = ['speed100', 'exitAdv', 'eArea', 'speed80', 'speed100'];
    const nSigns = rnd() < 0.55 ? 2 : 1;
    for (let i = 0; i < nSigns; i++) {
      for (let tries = 0; tries < 6; tries++) {
        const s = spec.s0 + 20 + rnd() * (spec.s1 - spec.s0 - 40);
        if (!free(s, 9) || signs.some((g) => Math.abs(g.s - s) < 30) || hecto.some((h) => Math.abs(h - s) < 4)) continue;
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        if (kind === 'speed100' || kind === 'speed80') {
          signs.push({ kind, s, d: 12.3, y: 2.1, w: 0.9, h: 0.9, posts: 1, postD: [12.3], yaw: 0 });
        } else {
          signs.push({ kind, s, d: 12.9, y: 2.0, w: 1.8, h: 1.2, posts: 2, postD: [12.3, 13.5], yaw: -0.1 });
        }
        busy.push(s);
        break;
      }
    }
    if (rnd() < 0.4) {
      for (let tries = 0; tries < 6; tries++) {
        const s = spec.s0 + 10 + rnd() * (spec.s1 - spec.s0 - 20);
        if (free(s, 5) && !hecto.some((h) => Math.abs(h - s) < 3) && !delineators.some((h) => Math.abs(h - s) < 2)) {
          phoneS = s;
          busy.push(s);
          break;
        }
      }
    }
    if (z !== 'rural' && rnd() < 0.3) {
      for (let tries = 0; tries < 6; tries++) {
        const s = spec.s0 + 15 + rnd() * (spec.s1 - spec.s0 - 30);
        if (free(s, 6) && !hecto.some((h) => Math.abs(h - s) < 3) && !delineators.some((h) => Math.abs(h - s) < 2)) {
          cameraS = s;
          busy.push(s);
          break;
        }
      }
    }
    // Chevrons on the outside of sharp bends.
    for (let s = Math.ceil(spec.s0 / 33) * 33 + 16; s < spec.s1; s += 33) {
      const k = road.curvatureAt(s);
      if (Math.abs(k) < CHEVRON_K) continue;
      if (k < 0) {
        // Bends left: outside is the right verge.
        if (!free(s, 3)) continue;
        signs.push({ kind: 'chevron', s, d: 11.7, y: 1.55, w: 0.6, h: 0.75, posts: 1, postD: [11.7], flipU: true, yaw: -0.25 });
      } else {
        // Bends right: chevrons on top of the median barrier, pointing right.
        signs.push({ kind: 'chevron', s, d: -9.0, y: 1.75, w: 0.6, h: 0.75, posts: 1, postD: [-9.0], yaw: 0.25 });
      }
    }
  } else if (median) {
    // Bridges keep chevrons on the median for sharp bends.
    for (let s = Math.ceil(spec.s0 / 33) * 33 + 16; s < spec.s1; s += 33) {
      const k = road.curvatureAt(s);
      if (k >= CHEVRON_K) signs.push({ kind: 'chevron', s, d: -9.0, y: 1.75, w: 0.6, h: 0.75, posts: 1, postD: [-9.0], yaw: 0.25 });
    }
  }
  if (rail) for (let s = Math.ceil(spec.s0 / 25) * 25 + 12; s < spec.s1; s += 25) grates.push(s);

  p = { median, rail, railA, railB, termA, termB, verge, signs, phoneS, cameraS, hecto, delineators, grates };
  cache.set(spec, p);
  return p;
}
