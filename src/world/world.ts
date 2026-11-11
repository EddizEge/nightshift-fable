import { Group } from 'three';
import type { Scene } from 'three';
import type { ChunkSpec, IChunkBuilder, IQuality, IRoadPath, IWorld, LampSlot, ZoneType } from '../core/types';
import { hash2, makeRng } from '../core/math';
import { Chunk, ChunkBuilder } from './chunkBuilder';
import type { LightField } from './lightField';
import type { WorldMaterials } from './materials';
import {
  CHUNK_LENGTH,
  LAMP_HEIGHT,
  LAMP_MEDIAN_D,
  LAMP_RIGHT_D,
  LAMP_RIGHT_POLE_D,
  LAMP_SPACING,
  MEDIAN_D,
} from './roadProfile';

export type FeatureFn = (b: IChunkBuilder) => void;

interface ZoneRun {
  zone: ZoneType;
  /** First chunk index and one-past-last. */
  start: number;
  end: number;
}

/** The first kilometres are authored so every run opens with the same strong sequence. */
const OPENING: Array<[ZoneType, number]> = [
  ['city', 10], // chunks -4 .. 5   (s −880 .. 1320)
  ['industrial', 3], // 6 .. 8       (1320 .. 1980)
  ['bridge', 4], // 9 .. 12          (1980 .. 2860)
  ['city', 2], // 13 .. 14           (2860 .. 3300)
  ['tunnel', 4], // 15 .. 18         (3300 .. 4180)
  ['city', 3], // 19 .. 21
];
const FIRST_CHUNK = -4;
/** Authored overpasses / gantries in the opening (chunk index → present). */
const OPENING_OVERPASS = new Set([3, 20]); // s = 770 and 4510 (chunks next to the bridge / tunnel never get one)
const OPENING_GANTRY = new Set([1, 5, 8, 14, 19]);

export class World implements IWorld {
  readonly group = new Group();
  private runs: ZoneRun[] = [];
  private specs = new Map<number, ChunkSpec>();
  private chunks = new Map<number, Chunk>();
  private features: Array<{ name: string; fn: FeatureFn; seed: number }> = [];
  private rng: () => number = makeRng(1);
  private seed = 1;
  private lastIndex = 0;
  /** Milliseconds of chunk building allowed per frame. */
  buildBudgetMs = 3.5;

  constructor(
    scene: Scene,
    private road: IRoadPath,
    private lighting: LightField,
    private quality: IQuality,
    private materials: WorldMaterials,
  ) {
    this.group.name = 'world';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
    this.reset(1);
  }

  /** Register a chunk feature (runs once per chunk, time-sliced). Order of registration = build order. */
  addFeature(name: string, fn: FeatureFn): void {
    this.features.push({ name, fn, seed: 101 + this.features.length * 977 });
  }

  reset(seed: number): void {
    for (const c of this.chunks.values()) c.dispose();
    this.chunks.clear();
    this.specs.clear();
    this.runs = [];
    this.seed = seed;
    this.rng = makeRng(seed * 2654435761 + 17);
    let at = FIRST_CHUNK;
    for (const [zone, len] of OPENING) {
      this.runs.push({ zone, start: at, end: at + len });
      at += len;
    }
    this.syncTunnels();
  }

  // ── planning ────────────────────────────────────────────────────────────

  private syncTunnels(): void {
    const ranges: Array<[number, number]> = [];
    for (const r of this.runs) if (r.zone === 'tunnel') ranges.push([r.start * CHUNK_LENGTH, r.end * CHUNK_LENGTH]);
    this.lighting.setTunnels(ranges);
  }

  private extendRuns(toIndex: number): void {
    let last = this.runs[this.runs.length - 1];
    let changed = false;
    while (last.end <= toIndex) {
      const r = this.rng();
      const prev = last.zone;
      const prev2 = this.runs.length > 1 ? this.runs[this.runs.length - 2].zone : 'city';
      let zone: ZoneType;
      // Weighted pick, never repeating the previous zone, and special zones need a breather in between.
      const special = (z: ZoneType) => z === 'tunnel' || z === 'bridge';
      const options: Array<[ZoneType, number]> = [
        ['city', 3],
        ['industrial', 2.2],
        ['rural', 1.3],
        ['bridge', special(prev) || special(prev2) ? 0.3 : 1.8],
        ['tunnel', special(prev) || special(prev2) ? 0.3 : 1.8],
      ];
      const pool = options.filter(([z]) => z !== prev);
      const total = pool.reduce((a, [, w]) => a + w, 0);
      let pick = r * total;
      zone = pool[0][0];
      for (const [z, w] of pool) {
        pick -= w;
        if (pick <= 0) {
          zone = z;
          break;
        }
      }
      const len =
        zone === 'tunnel' ? 3 + Math.floor(this.rng() * 3) : zone === 'bridge' ? 3 + Math.floor(this.rng() * 3) : zone === 'rural' ? 2 + Math.floor(this.rng() * 2) : 2 + Math.floor(this.rng() * 3);
      last = { zone, start: last.end, end: last.end + len };
      this.runs.push(last);
      changed = true;
    }
    if (changed) this.syncTunnels();
  }

  private runAt(index: number): ZoneRun {
    if (index < FIRST_CHUNK) return { zone: 'city', start: index, end: FIRST_CHUNK };
    this.extendRuns(index + 1);
    // Runs are few; linear scan from the end is fine.
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i];
      if (index >= r.start && index < r.end) return r;
    }
    return this.runs[0];
  }

  private specAt(index: number): ChunkSpec {
    let spec = this.specs.get(index);
    if (spec) return spec;
    const run = this.runAt(index);
    const zone = run.zone;
    const prevZone = this.runAt(index - 1).zone;
    const nextZone = this.runAt(index + 1).zone;
    const s0 = index * CHUNK_LENGTH;
    const s1 = s0 + CHUNK_LENGTH;
    const seed = (Math.imul(index + 7919, 2654435761) ^ Math.imul(this.seed, 40503)) >>> 0;
    const h = hash2(index, this.seed * 13 + 5);

    // Overpass: only on open-air non-bridge chunks whose neighbours are not tunnels.
    let overpassS: number | null = null;
    const openAir = zone === 'city' || zone === 'industrial' || zone === 'rural';
    const nearPortal = prevZone === 'tunnel' || nextZone === 'tunnel' || prevZone === 'bridge' || nextZone === 'bridge';
    if (index >= 0 && openAir && !nearPortal) {
      const authored = index <= 21;
      const want = authored ? OPENING_OVERPASS.has(index) : h < (zone === 'city' ? 0.42 : zone === 'rural' ? 0.3 : 0.22);
      if (want) overpassS = s0 + CHUNK_LENGTH * 0.5;
    }
    let gantryS: number | null = null;
    if (index >= 0 && zone !== 'tunnel' && zone !== 'rural') {
      const authored = index <= 21;
      const want = authored ? OPENING_GANTRY.has(index) : hash2(index, this.seed * 29 + 11) < 0.36;
      if (want && overpassS === null) gantryS = s0 + 66 + 11; // between two lamp slots
    }

    const lampsOn = zone === 'city' || zone === 'industrial' || zone === 'bridge';
    const lamps: LampSlot[] = [];
    const k0 = Math.ceil(s0 / LAMP_SPACING - 1e-6);
    const k1 = Math.ceil(s1 / LAMP_SPACING - 1e-6);
    for (let k = k0; k < k1; k++) {
      const s = k * LAMP_SPACING;
      const median = (k & 1) === 0;
      let on = lampsOn;
      if (on && overpassS !== null && Math.abs(s - overpassS) < 17) on = false;
      // The last slots before a tunnel portal stay dark so the portal reads.
      if (on && nextZone === 'tunnel' && s > s1 - 30) on = false;
      lamps.push({
        s,
        d: median ? LAMP_MEDIAN_D : LAMP_RIGHT_D,
        poleD: median ? MEDIAN_D : LAMP_RIGHT_POLE_D,
        h: LAMP_HEIGHT,
        side: median ? 'median' : 'right',
        on,
      });
      this.lighting.setLamp(k, on);
    }

    spec = {
      index,
      s0,
      s1,
      zone,
      prevZone,
      nextZone,
      seed,
      lamps,
      overpassS,
      gantryS,
      zoneIndex: index - run.start,
      zoneLength: run.end - run.start,
    };
    this.specs.set(index, spec);
    return spec;
  }

  // ── queries ─────────────────────────────────────────────────────────────

  chunkAt(s: number): ChunkSpec {
    return this.specAt(Math.floor(s / CHUNK_LENGTH));
  }

  zoneAt(s: number): ZoneType {
    return this.runAt(Math.floor(s / CHUNK_LENGTH)).zone;
  }

  tunnelAt(s: number): number {
    return this.lighting.tunnelAt(s, 12);
  }

  rainAt(s: number): number {
    return 1 - this.lighting.tunnelAt(s, 10);
  }

  nextOverpass(s: number): number | null {
    const i0 = Math.floor(s / CHUNK_LENGTH);
    for (let i = i0; i < i0 + 12; i++) {
      const sp = this.specAt(i);
      if (sp.overpassS !== null && sp.overpassS >= s) return sp.overpassS;
    }
    return null;
  }

  // ── streaming ───────────────────────────────────────────────────────────

  private createChunk(index: number): Chunk {
    // Neighbours first so their lamps are registered before this chunk bakes its lighting.
    this.specAt(index - 1);
    this.specAt(index + 1);
    const spec = this.specAt(index);
    const chunk = new Chunk(spec);
    const q = this.quality.settings;
    for (const f of this.features) {
      chunk.jobs.push(() => {
        try {
          f.fn(new ChunkBuilder(chunk, this.road, q, this.lighting, this.materials, f.seed));
        } catch (e) {
          console.error(`[ns] feature "${f.name}" failed on chunk ${index}`, e);
        }
      });
    }
    this.group.add(chunk.group);
    this.chunks.set(index, chunk);
    return chunk;
  }

  /** Build every pending job right now (loading screen / restarts / tests). */
  buildAll(): void {
    for (const c of this.chunks.values()) {
      while (c.jobs.length) c.jobs.shift()!();
      c.built = true;
    }
  }

  /** True when no chunk in range has pending build jobs. */
  get settled(): boolean {
    for (const c of this.chunks.values()) if (c.jobs.length) return false;
    return true;
  }

  update(playerS: number, dt: number, time: number): void {
    const ahead = this.quality.settings.chunksAhead;
    const idx = Math.floor(playerS / CHUNK_LENGTH);
    this.lastIndex = idx;
    this.road.ensure((idx + ahead + 3) * CHUNK_LENGTH);
    const lo = idx - 1;
    const hi = idx + ahead;
    for (let i = lo; i <= hi; i++) if (!this.chunks.has(i)) this.createChunk(i);
    for (const [i, c] of this.chunks) {
      if (i < lo || i > hi + 1) {
        c.dispose();
        this.chunks.delete(i);
      }
    }
    // Old specs are tiny, but drop the far-behind ones to keep the map small on long runs.
    if (this.specs.size > 96) {
      for (const k of this.specs.keys()) if (k < lo - 4) this.specs.delete(k);
    }

    // Time-sliced building, nearest chunk first.
    const t0 = performance.now();
    outer: for (let i = lo; i <= hi; i++) {
      const c = this.chunks.get(i);
      if (!c) continue;
      while (c.jobs.length) {
        c.jobs.shift()!();
        if (performance.now() - t0 > this.buildBudgetMs) break outer;
      }
      c.built = true;
    }

    for (const c of this.chunks.values()) {
      for (const u of c.updaters) u(time, dt);
    }
  }
}
