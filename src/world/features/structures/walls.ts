/**
 * City noise barriers / retaining walls just beyond the right guardrail (mirrored on the far
 * side): concrete absorber panels between steel H-posts, transparent acrylic panels on a
 * concrete plinth, or tall battered retaining walls with a fence. Runs start / end inside the
 * chunk with sloped ends; they skip gantry positions and chunks next to overpasses, portals
 * and bridges.
 */
import type { IChunkBuilder, Placement } from '../../../core/types';
import { smoothstep } from '../../../core/math';
import { BARRIER_RIGHT_D, MEDIAN_D, mirrorD } from '../../roadProfile';
import { Geo, addGeo, addPosts } from './geom';
import type { GeoStats, Vec3 } from './geom';
import { structureMaterials } from './materials';

/** Road-side face of the walls. */
export const NOISE_WALL_D = BARRIER_RIGHT_D + 2.4; // 12.8
const POST_PITCH = 4;
const END_RAMP = 8;

type WallType = 'concrete' | 'glass' | 'retaining';

export function buildCityWalls(b: IChunkBuilder, stats?: GeoStats): void {
  const sp = b.spec;
  if (sp.zone !== 'city' || sp.overpassS !== null) return;
  const busy = (z: string) => z === 'tunnel' || z === 'bridge';
  if (busy(sp.prevZone) || busy(sp.nextZone)) return;
  const M = structureMaterials(b.materials);
  const panel = new Geo(0.25, 4);
  const steel = new Geo(0.5, 4);
  const glass = new Geo(0.25, 4);
  const posts: Placement[] = [];
  const typeRoll = b.rand();
  const type: WallType = typeRoll < 0.42 ? 'concrete' : typeRoll < 0.74 ? 'glass' : 'retaining';
  const L = sp.s1 - sp.s0;

  for (const opp of [false, true]) {
    if (b.rand() < 0.3) continue;
    // Run extent (local arc length within the chunk), snapped to the post pitch.
    let a = b.rand() < 0.5 ? 0 : Math.round((b.rand() * 60) / POST_PITCH) * POST_PITCH;
    let e = b.rand() < 0.5 ? L : L - Math.round((b.rand() * 60) / POST_PITCH) * POST_PITCH;
    if (e - a < 60) continue;
    const H =
      type === 'retaining' ? 6 + b.rand() * 2.5 : type === 'glass' ? 3.4 + b.rand() * 0.8 : 3.6 + b.rand() * 1.4;
    // Split around a gantry (its legs stand on the verges).
    const cuts: Array<[number, number]> = [];
    if (sp.gantryS !== null) {
      const g = sp.gantryS - sp.s0;
      const ga = Math.floor((g - 14) / POST_PITCH) * POST_PITCH;
      const gb = Math.ceil((g + 14) / POST_PITCH) * POST_PITCH;
      if (ga - a >= 24) cuts.push([a, ga]);
      if (e - gb >= 24) cuts.push([gb, e]);
    } else cuts.push([a, e]);
    for (const g of [panel, steel, glass]) g.transform(opp ? -1 : 1, opp ? 2 * MEDIAN_D : 0);
    for (const [ra, re] of cuts) {
      a = ra;
      e = re;
      const ramp = (t: number) => Math.min(smoothstep(a, a + END_RAMP, t), 1 - smoothstep(e - END_RAMP, e, t));
      const hOf = (t: number) => 1.0 + (H - 1.0) * ramp(t);
      buildRun(type, a, e, hOf, panel, steel, glass, posts, opp, sp.s0, () => b.rand());
    }
  }
  addGeo(b, panel, M.panel, { name: 'walls-concrete' }, stats);
  addGeo(b, steel, M.steel, { name: 'walls-steel', noProbe: true }, stats);
  addGeo(b, glass, M.glass, { name: 'walls-glass' }, stats);
  addPosts(b, M.steel, posts, stats);
}

function buildRun(
  type: WallType,
  a: number,
  e: number,
  hOf: (t: number) => number,
  panel: Geo,
  steel: Geo,
  glass: Geo,
  posts: Placement[],
  opp: boolean,
  s0: number,
  rand: () => number,
): void {
  const x0 = NOISE_WALL_D;
  const dOf = (x: number) => (opp ? mirrorD(x) : x);
  // z = -t (local arc length t inside the chunk).
  const hexa = (g: Geo, xa: number, xb: number, xc: number, xd: number, botA: number, botB: number, tA: number, tB: number, topA: number, topB: number, skip: number) => {
    // Bottom xa..xb, top xc..xd (battered faces); heights at both ends of the segment.
    g.hexa(
      [
        [xa, botB, -tB],
        [xb, botB, -tB],
        [xb, botA, -tA],
        [xa, botA, -tA],
        [xc, topB, -tB],
        [xd, topB, -tB],
        [xd, topA, -tA],
        [xc, topA, -tA],
      ],
      skip,
    );
  };
  const n = Math.round((e - a) / POST_PITCH);
  const dirt = (y: number) => 0.5 + 0.45 * smoothstep(0, 1.6, y);
  for (let i = 0; i < n; i++) {
    const tA = a + i * POST_PITCH;
    const tB = tA + POST_PITCH;
    const ha = hOf(tA);
    const hb = hOf(tB);
    const k = 0.86 + rand() * 0.18; // per-panel weathering
    panel.shade = (_x, y) => k * dirt(y);
    if (type === 'concrete') {
      // Absorber panels up to ~2.6 m, a transparent acrylic band above on the taller runs
      // (keeps the city visible), steel cap rail on top; drip staining under the panel tops.
      const sk = 4 | (i > 0 ? 32 : 0) | (i < n - 1 ? 16 : 0);
      const ca = ha > 3.2 ? 2.6 : ha;
      const cb = hb > 3.2 ? 2.6 : hb;
      hexa(panel, x0 - 0.05, x0 + 0.25, x0 - 0.05, x0 + 0.25, 0, 0, tA, tB, 0.6, 0.6, sk);
      const hm = (ca + cb) / 2;
      panel.shade = (_x, y) => k * dirt(y) * (1 - 0.28 * smoothstep(hm - 0.9, hm, y));
      hexa(panel, x0, x0 + 0.18, x0, x0 + 0.18, 0.6, 0.6, tA, tB, ca, cb, sk);
      panel.shade = () => 0.75;
      hexa(panel, x0 - 0.06, x0 + 0.24, x0 - 0.06, x0 + 0.24, ca, cb, tA, tB, ca + 0.12, cb + 0.12, sk);
      if (ha > ca + 0.3 || hb > cb + 0.3) {
        const xg = x0 + 0.09;
        glass.patch([xg, ca + 0.12, -tA - 0.06], [xg, cb + 0.12, -tB + 0.06], [xg, ha - 0.05, -tA - 0.06], [xg, hb - 0.05, -tB + 0.06], [-1, 0, 0]);
        steel.tint(0.32, 0.34, 0.36);
        hexa(steel, x0 + 0.01, x0 + 0.17, x0 + 0.01, x0 + 0.17, ha - 0.08, hb - 0.08, tA, tB, ha + 0.04, hb + 0.04, 0);
      }
    } else if (type === 'glass') {
      hexa(panel, x0 - 0.05, x0 + 0.3, x0 - 0.05, x0 + 0.3, 0, 0, tA, tB, 1.0, 1.0, 4 | (i > 0 ? 32 : 0) | (i < n - 1 ? 16 : 0));
      if ((ha + hb) / 2 > 1.6) {
        const xg = x0 + 0.12;
        glass.patch([xg, 1.05, -tA - 0.06], [xg, 1.05, -tB + 0.06], [xg, ha - 0.05, -tA - 0.06], [xg, hb - 0.05, -tB + 0.06], [-1, 0, 0]);
      }
      steel.tint(0.32, 0.34, 0.36);
      hexa(steel, x0 + 0.04, x0 + 0.2, x0 + 0.04, x0 + 0.2, ha - 0.08, hb - 0.08, tA, tB, ha + 0.04, hb + 0.04, 0);
      hexa(steel, x0 + 0.04, x0 + 0.2, x0 + 0.04, x0 + 0.2, 1.0, 1.0, tA, tB, 1.1, 1.1, 4);
      // Mid transom: makes the acrylic read as panels and breaks the reflections.
      if ((ha + hb) / 2 > 2.6) hexa(steel, x0 + 0.07, x0 + 0.17, x0 + 0.07, x0 + 0.17, 2.3, 2.3, tA, tB, 2.37, 2.37, 0);
    } else {
      // Retaining wall: battered face, coping, earth ledge behind, fence on top.
      const bat = 0.3 * (ha / 8);
      const bbt = 0.3 * (hb / 8);
      hexa(panel, x0, x0 + 0.7, x0 + (bat + bbt) / 2, x0 + 0.7, 0, 0, tA, tB, ha, hb, 4 | (i > 0 ? 32 : 0) | (i < n - 1 ? 16 : 0));
      panel.shade = () => 0.7;
      const xc = x0 + (bat + bbt) / 2 - 0.12;
      hexa(panel, xc, x0 + 0.85, xc, x0 + 0.85, ha, hb, tA, tB, ha + 0.25, hb + 0.25, 4 | (i > 0 ? 32 : 0) | (i < n - 1 ? 16 : 0));
      panel.shade = () => 0.18;
      hexa(panel, x0 + 0.85, x0 + 4.5, x0 + 0.85, x0 + 4.5, ha + 0.05, hb + 0.05, tA, tB, ha + 0.2, hb + 0.2, 4 | 1 | (i > 0 ? 32 : 0) | (i < n - 1 ? 16 : 0));
    }
    // Posts (concrete: H-posts between panels; glass: frame posts; retaining: fence posts).
    const postT = tA;
    const s = s0 + postT;
    if (type === 'concrete') posts.push({ s, d: dOf(x0 + 0.09), y: 0.55, scale: [0.26, ha - 0.4, 0.26] });
    else if (type === 'glass') posts.push({ s, d: dOf(x0 + 0.12), y: 1.0, scale: [0.16, ha - 0.9, 0.12] });
    else posts.push({ s, d: dOf(x0 + 0.45), y: ha + 0.25, scale: [0.07, 1.4, 0.07] });
  }
  const sEnd = s0 + e;
  const hEnd = hOf(e);
  if (type === 'concrete') posts.push({ s: sEnd, d: dOf(x0 + 0.09), y: 0.55, scale: [0.26, hEnd - 0.4, 0.26] });
  else if (type === 'glass') posts.push({ s: sEnd, d: dOf(x0 + 0.12), y: 1.0, scale: [0.16, hEnd - 0.9, 0.12] });
  else {
    posts.push({ s: sEnd, d: dOf(x0 + 0.45), y: hEnd + 0.25, scale: [0.07, 1.4, 0.07] });
    steel.tint(0.4, 0.42, 0.44);
    const rail: Vec3[] = [];
    for (let t = a; t <= e + 0.01; t += POST_PITCH) rail.push([x0 + 0.45, hOf(t) + 1.6, -t]);
    steel.tube(rail, 0.035, 5);
    steel.tube(
      rail.map((p) => [p[0], p[1] - 0.7, p[2]] as Vec3),
      0.025,
      5,
    );
  }
  panel.shade = null;
}
