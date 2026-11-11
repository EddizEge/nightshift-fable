/**
 * NIGHTSHIFT traffic simulation (our carriageway, 4 lanes) + decorative oncoming traffic.
 *
 *  - Vehicles live in road space (s, d). Longitudinal: IDM car following against every item ahead
 *    whose lateral corridor overlaps (AI vehicles, scripted vehicles, wrecks / crash bodies, the player).
 *  - Lane changes: MOBIL-like incentive, indicator ≥ 0.8 s first, quintic 2.2–3.5 s lateral move with a
 *    small relYaw, only into verified gaps; abort back if the target becomes dangerous before 40 %.
 *  - Fairness rules (see TRAFFIC_RULES): spawn window, player TTC for lane changes, rolling-roadblock
 *    control (one lane always passable inside any 45 m window), reserved zones.
 *  - Fixed-step `step(dt)`; `syncVisuals` writes Object3D poses + lights. No allocation in either
 *    (except rare crash events). Vehicles and visuals are pooled.
 */
import { Quaternion, Vector3 } from 'three';
import type {
  GameContext,
  ITrafficSystem,
  ITrafficVehicleFactory,
  RoadFrame,
  TrafficType,
  TrafficVehicle,
  WreckBody,
} from '../core/types';
import { clamp, clamp01, damp, lerp, makeRng } from '../core/math';
import { BARRIER_LEFT_D, BARRIER_RIGHT_D, LANE_CENTERS, LANE_COUNT, LANE_WIDTH } from '../world/roadProfile';
import { idmAccel, idmFree, smoother, smootherD, type IdmParams } from './ai/idm';
import { isHeavy, pickType } from './ai/defs';
import { OncomingTraffic, type OncomingVehicle } from './oncoming';

export type { OncomingVehicle } from './oncoming';

export const TRAFFIC_RULES = {
  /** Rule 1: never spawn closer than this ahead of the player. */
  spawnMinAhead: 320,
  /** Normal ambient spawn band (beyond the fog). */
  spawnAheadMin: 420,
  spawnAheadMax: 700,
  despawnBehind: 140,
  despawnAhead: 950,
  /** Behind-spawn band, only used while the player is slower than traffic (out of view, behind the camera). */
  spawnBehindMin: 150,
  spawnBehindMax: 230,
  slowPlayerSpeed: 18,
  /** Rule 2. */
  laneChangeTtc: 3.5,
  abortTtc: 1.5,
  abortProgress: 0.4,
  /** Rule 3. */
  roadblockWindow: 45,
  /** Controller acts on windows shorter than this (prevention margin). */
  roadblockControl: 72,
  signalMin: 0.8,
  moveMin: 2.2,
  moveMax: 3.5,
  /** Density is measured / targeted over [player.s - despawnBehind, player.s + spawnAheadMax]. */
  densitySpanM: 840,
} as const;

const K_DRIVE = 0;
const K_SCRIPT = 1;
const K_OBST = 2;
const K_PLAYER = 3;
const ALL_LANES = (1 << LANE_COUNT) - 1;
const HALF_LANE = LANE_WIDTH / 2;

/** Lanes whose interval overlaps [lo, hi] by more than 0.25 m. */
export function laneMask(lo: number, hi: number): number {
  let m = 0;
  for (let k = 0; k < LANE_COUNT; k++) {
    const c = LANE_CENTERS[k];
    if (lo < c + HALF_LANE - 0.25 && hi > c - HALF_LANE + 0.25) m |= 1 << k;
  }
  return m;
}

interface Item {
  s: number;
  /** Corridor (what followers must respect). */
  lo: number;
  hi: number;
  /** Physical footprint. */
  plo: number;
  phi: number;
  hl: number;
  speed: number;
  kind: number;
  veh: Veh | null;
  body: WreckBody | null;
  mask: number;
}

interface Veh extends TrafficVehicle {
  readonly __traffic: true;
  ambient: boolean;
  r1: number;
  r2: number;
  idm: IdmParams;
  baseV0: number;
  keepRight: number;
  accel: number;
  /** 0 = none, 1 = signalling, 2 = moving. */
  lc: 0 | 1 | 2;
  lcTimer: number;
  lcSignal: number;
  lcDur: number;
  lcFrom: number;
  lcTo: number;
  lcOrigin: number;
  lcUrgent: boolean;
  aborting: boolean;
  decide: number;
  cap: number;
  capHold: number;
  capHard: boolean;
  latVel: number;
  hazard: boolean;
  body: WreckBody | null;
  wvs: number;
  wvd: number;
  spin: number;
  halfExt: Vector3;
  quat: Quaternion;
  item: Item | null;
  k: number;
}

export interface TrafficStats {
  spawns: number;
  despawns: number;
  laneChanges: number;
  aborts: number;
  roadblockFixes: number;
  clamps: number;
  crashes: number;
  evictions: number;
  /** Lane-change candidates rejected: gap acceptance / player rule / roadblock rule. */
  rejectGap: number;
  rejectPlayer: number;
  rejectRoadblock: number;
}

export interface TrafficDebugHooks {
  /** A lateral move starts (after the indicator phase). */
  laneChangeStart?: (v: TrafficVehicle, from: number, to: number) => void;
  laneChangeAbort?: (v: TrafficVehicle, progress: number) => void;
  /** Ambient spawn (not scripted spawn()). */
  spawned?: (v: TrafficVehicle) => void;
}

export type TrafficSystemApi = ITrafficSystem & {
  readonly oncoming: readonly OncomingVehicle[];
  debugInfo(): string;
  readonly stats: Readonly<TrafficStats>;
  readonly hooks: TrafficDebugHooks;
  readonly density: number;
  readonly aggression: number;
};

export function createTraffic(ctx: GameContext, factory: ITrafficVehicleFactory): TrafficSystemApi {
  return new TrafficSystem(ctx, factory);
}

/** Speed (m/s) at which traffic passes a crash site once the run is over. */
const CAUTION_SPEED = 7;

export class TrafficSystem implements TrafficSystemApi {
  private readonly list: Veh[] = [];
  private readonly pool: Veh[] = [];
  private readonly items: Item[] = [];
  private nItems = 0;
  private readonly sorted: Item[] = [];
  private nSorted = 0;
  private readonly reserves: { s0: number; s1: number }[] = [];
  private readonly rng = makeRng(0x7a11c);
  private readonly f: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };
  private readonly hints = new Map<WreckBody, number>();
  private readonly coverS = new Float64Array(256);
  private readonly coverM = new Int32Array(256);
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly wreckPos = new Vector3();
  private readonly onc: OncomingTraffic;
  private nextId = 1;
  private prefill = true;
  private cautionS: number | null = null;
  private spawnTimer = 0;
  private time = 0;
  private qBlockGap = Infinity;
  density = 8;
  aggression = 0.5;
  readonly stats: TrafficStats = { spawns: 0, despawns: 0, laneChanges: 0, aborts: 0, roadblockFixes: 0, clamps: 0, crashes: 0, evictions: 0, rejectGap: 0, rejectPlayer: 0, rejectRoadblock: 0 };
  readonly hooks: TrafficDebugHooks = {};

  constructor(
    private readonly ctx: GameContext,
    private readonly factory: ITrafficVehicleFactory,
  ) {
    this.onc = new OncomingTraffic(ctx, factory, makeRng(0x0cc0));
  }

  get vehicles(): readonly TrafficVehicle[] {
    return this.list;
  }
  get oncoming(): readonly OncomingVehicle[] {
    return this.onc.list;
  }

  // ───────────────────────────────────────────── public API

  setDensity(perKmPerLane: number): void {
    this.density = clamp(perKmPerLane, 0, 30);
  }

  setAggression(a: number): void {
    this.aggression = clamp01(a);
    for (const v of this.list) this.params(v);
  }

  setCruise(tv: TrafficVehicle, speed: number): void {
    (tv as Veh).baseV0 = speed;
  }

  /** Vehicles approaching arc length `s` slow to a crawl (null clears it). Used once the run is over. */
  setCaution(s: number | null): void {
    this.cautionS = s;
  }

  reset(): void {
    this.cautionS = null;
    while (this.list.length) this.release(this.list.length - 1, true);
    this.reserves.length = 0;
    this.hints.clear();
    this.onc.reset();
    this.prefill = true;
    this.spawnTimer = 0;
    this.nItems = 0;
    this.nSorted = 0;
  }

  reserve(s0: number, s1: number): () => void {
    const r = { s0: Math.min(s0, s1), s1: Math.max(s0, s1) };
    this.reserves.push(r);
    return () => {
      const i = this.reserves.indexOf(r);
      if (i >= 0) this.reserves.splice(i, 1);
    };
  }

  spawn(type: TrafficType, s: number, lane: number, speed: number, mode: 'drive' | 'scripted' = 'drive'): TrafficVehicle | null {
    const def = this.factory.defs[type];
    lane = clamp(Math.round(lane), 0, LANE_COUNT - 1);
    const c = LANE_CENTERS[lane];
    const hw = def.width / 2;
    const hl = def.length / 2;
    for (const o of this.list) {
      if (Math.abs(o.d - c) < o.halfWidth + hw + 0.2 && Math.abs(o.s - s) < o.halfLength + hl + 2) return null;
    }
    const p = this.ctx.player;
    if (Math.abs(p.d - c) < p.dims.width / 2 + hw + 0.2 && Math.abs(p.s - s) < p.dims.length / 2 + hl + 2) return null;
    // An AI vehicle right behind that could not stop in time also blocks the spot.
    for (const o of this.list) {
      if (o.mode !== 'drive' || o.s >= s || Math.abs(o.d - c) >= o.halfWidth + hw + 0.2) continue;
      const closing = o.speed - speed;
      const gap = s - hl - o.s - o.halfLength;
      if (closing > 0 && gap < (closing * closing) / (2 * 6) + 3) return null;
    }
    if (this.list.length >= this.ctx.quality.settings.trafficMax) this.evict(-Infinity);
    const v = this.create(type, s, lane, speed, false);
    v.mode = mode;
    return v;
  }

  remove(v: TrafficVehicle): void {
    const i = this.list.indexOf(v as Veh);
    if (i >= 0) this.release(i, true);
  }

  wreck(tv: TrafficVehicle, linVel: Vector3, angVel: Vector3): void {
    const v = tv as Veh;
    if (v.mode === 'wreck') return;
    v.mode = 'wreck';
    v.braking = 0;
    v.indicator = 0;
    v.lc = 0;
    v.hazard = true;
    const crash = this.ctx.crash;
    const def = v.def;
    if (crash && crash.ready) {
      v.halfExt.set(def.width / 2, def.height / 2, def.length / 2);
      // Its own vector: crashInto() passes tmpA / tmpB as the velocities. (Writing the position into
      // tmpA here once handed vehicles over with "velocity = world position": thousands of m/s.)
      this.wreckPos.set(v.position.x, def.height / 2, v.position.z);
      v.quat.set(0, Math.sin(-v.heading * 0.5), 0, Math.cos(-v.heading * 0.5));
      v.body = crash.addBox(v.visual.object, v.halfExt, def.mass, this.wreckPos, v.quat, linVel, angVel, v, def.height / 2);
    } else {
      const f = this.ctx.road.frameAt(v.s, this.f);
      v.wvs = linVel.x * f.tx + linVel.z * f.tz;
      v.wvd = linVel.x * f.rx + linVel.z * f.rz;
      v.spin = -angVel.y;
      v.speed = Math.hypot(v.wvs, v.wvd);
    }
  }

  debugInfo(): string {
    let drive = 0;
    let scripted = 0;
    let wreck = 0;
    let sp = 0;
    let changing = 0;
    for (const v of this.list) {
      if (v.mode === 'drive') {
        drive++;
        sp += v.speed;
        if (v.lc === 2) changing++;
      } else if (v.mode === 'scripted') scripted++;
      else wreck++;
    }
    const st = this.stats;
    return (
      `traffic ${drive}d/${scripted}s/${wreck}w onc ${this.onc.list.length} avg ${(drive ? (sp / drive) * 3.6 : 0).toFixed(0)}km/h ` +
      `lc ${changing} (tot ${st.laneChanges} ab ${st.aborts}) rb ${st.roadblockFixes} clamp ${st.clamps} crash ${st.crashes} dens ${this.density.toFixed(1)} agg ${this.aggression.toFixed(2)}`
    );
  }

  // ───────────────────────────────────────────── simulation

  step(dt: number): void {
    if (!(dt > 0)) return;
    this.time += dt;
    this.buildItems();
    this.roadblockControl(dt);
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      if (v.mode === 'drive') this.think(v, dt);
    }
    for (let i = 0; i < this.list.length; i++) this.integrate(this.list[i], dt);
    this.resolve();
    this.despawn();
    this.spawnAmbient(dt);
    this.onc.step(dt, this.density);
  }

  syncVisuals(_dt: number, time: number): void {
    for (const v of this.list) {
      const o = v.visual.object;
      if (!v.body) {
        o.position.copy(v.position);
        o.rotation.set(0, -v.heading, 0);
      }
      v.visual.setLights(v.braking, v.indicator, time, v.hazard);
    }
    this.onc.sync(time);
  }

  // ───────────────────────────────────────────── internals: pool

  private create(type: TrafficType, s: number, lane: number, speed: number, ambient: boolean): Veh {
    const def = this.factory.defs[type];
    const id = this.nextId++;
    const visual = this.factory.acquire(type, (Math.imul(id, 2654435761) >>> 9) ^ id);
    this.ctx.engine.scene.add(visual.object);
    let v = this.pool.pop();
    if (!v) {
      v = {
        __traffic: true,
        id: 0, type, def, visual, s: 0, d: 0, speed: 0, lane: 0, targetLane: 0, relYaw: 0,
        position: new Vector3(), heading: 0, halfLength: 0, halfWidth: 0, mode: 'drive', braking: 0, indicator: 0,
        nearMissDone: false, userData: {},
        ambient, r1: 0, r2: 0, idm: { v0: 30, T: 1.2, a: 1.5, b: 2.5, s0: 4 }, baseV0: 30, keepRight: 0, accel: 0,
        lc: 0, lcTimer: 0, lcSignal: 0, lcDur: 3, lcFrom: 0, lcTo: 0, lcOrigin: 0, lcUrgent: false, aborting: false,
        decide: 0, cap: Infinity, capHold: 0, capHard: false, latVel: 0, hazard: false,
        body: null, wvs: 0, wvd: 0, spin: 0, halfExt: new Vector3(), quat: new Quaternion(), item: null, k: 0,
      };
    }
    v.id = id;
    v.type = type;
    v.def = def;
    v.visual = visual;
    v.s = s;
    v.lane = lane;
    v.targetLane = lane;
    v.d = LANE_CENTERS[lane];
    v.speed = Math.max(0, speed);
    v.relYaw = 0;
    v.halfLength = def.length / 2;
    v.halfWidth = def.width / 2;
    v.mode = 'drive';
    v.braking = 0;
    v.indicator = 0;
    v.nearMissDone = false;
    for (const k in v.userData) delete v.userData[k];
    v.ambient = ambient;
    v.r1 = this.rng();
    v.r2 = this.rng();
    v.accel = 0;
    v.lc = 0;
    v.lcTimer = 0;
    v.aborting = false;
    v.decide = 1 + this.rng() * 3;
    v.cap = Infinity;
    v.capHold = 0;
    v.capHard = false;
    v.latVel = 0;
    v.hazard = false;
    v.body = null;
    v.wvs = v.wvd = v.spin = 0;
    v.item = null;
    this.params(v);
    this.pose(v);
    this.list.push(v);
    return v;
  }

  private params(v: Veh): void {
    const ag = this.aggression;
    const def = v.def;
    v.baseV0 = lerp(def.speedMin, def.speedMax, v.r1) * (1 + (v.r2 - 0.5) * 0.24 * ag);
    const p = v.idm;
    if (isHeavy(v.type)) {
      p.a = 0.8; p.b = 2.2; p.T = lerp(1.7, 1.35, ag); p.s0 = 5; v.keepRight = 0.6;
    } else if (v.type === 'van') {
      p.a = 1.3; p.b = 2.5; p.T = lerp(1.5, 1.1, ag); p.s0 = 4; v.keepRight = 0.4;
    } else if (v.type === 'sports') {
      p.a = 2.6; p.b = 3.0; p.T = lerp(1.2, 0.85, ag); p.s0 = 3; v.keepRight = 0;
    } else {
      p.a = 1.8; p.b = 2.8; p.T = lerp(1.35, 0.95, ag); p.s0 = 3.5;
      v.keepRight = v.baseV0 > 31 ? 0.05 : lerp(0.3, 0.12, ag);
    }
    p.v0 = v.baseV0;
  }

  private release(i: number, removeBody: boolean): void {
    const v = this.list[i];
    if (v.body) {
      const crash = this.ctx.crash;
      if (removeBody && crash && crash.bodies.indexOf(v.body) >= 0) crash.remove(v.body);
      this.hints.delete(v.body);
      v.body = null;
    }
    v.visual.object.removeFromParent();
    this.factory.release(v.visual);
    const last = this.list.pop()!;
    if (i < this.list.length) this.list[i] = last;
    v.item = null;
    v.id = -1; // stale references held elsewhere can detect the release (create() assigns a fresh id)
    this.pool.push(v);
    this.stats.despawns++;
  }

  /** Remove the ambient vehicle furthest behind the player, if it is behind `maxDs`. */
  private evict(maxDs: number): boolean {
    const ps = this.ctx.player.s;
    let best = -1;
    let bestDs = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      if (!v.ambient || v.mode === 'scripted') continue;
      const ds = v.s - ps;
      if (ds < bestDs) {
        bestDs = ds;
        best = i;
      }
    }
    if (best < 0 || (maxDs !== -Infinity && bestDs > maxDs)) {
      // Fall back to the furthest-ahead ambient vehicle beyond the fog (invisible).
      if (maxDs !== -Infinity) return false;
      let far = -1;
      let farDs = -Infinity;
      for (let i = 0; i < this.list.length; i++) {
        const v = this.list[i];
        if (!v.ambient || v.mode === 'scripted') continue;
        if (v.s - ps > farDs) {
          farDs = v.s - ps;
          far = i;
        }
      }
      if (far < 0) return false;
      best = far;
    }
    this.release(best, true);
    this.stats.evictions++;
    return true;
  }

  // ───────────────────────────────────────────── internals: items

  private item(): Item {
    let it = this.items[this.nItems];
    if (!it) {
      it = { s: 0, lo: 0, hi: 0, plo: 0, phi: 0, hl: 0, speed: 0, kind: 0, veh: null, body: null, mask: 0 };
      this.items.push(it);
    }
    this.nItems++;
    return it;
  }

  private buildItems(): void {
    this.nItems = 0;
    const road = this.ctx.road;
    const f = this.f;
    const p = this.ctx.player;
    // Wrecks owned by the crash world: copy the body pose back.
    for (const v of this.list) {
      if (!v.body) continue;
      const b = v.body;
      v.position.copy(b.position);
      v.heading = quatHeading(b.quaternion);
      road.project(b.position.x, b.position.z, v.s, this.tmpProj);
      v.s = this.tmpProj.s;
      v.d = this.tmpProj.d;
      v.relYaw = v.heading - road.headingAt(v.s);
      road.frameAt(v.s, f);
      v.speed = b.linvel.x * f.tx + b.linvel.z * f.tz;
    }
    for (const v of this.list) {
      if (v.body) {
        v.item = null;
        continue;
      }
      const it = this.item();
      it.veh = v;
      it.body = null;
      it.s = v.s;
      it.speed = v.mode === 'wreck' ? v.wvs : v.speed;
      it.kind = v.mode === 'drive' ? K_DRIVE : v.mode === 'scripted' ? K_SCRIPT : K_OBST;
      if (v.mode === 'drive' && v.relYaw * v.relYaw < 0.01) {
        it.hl = v.halfLength;
        it.plo = v.d - v.halfWidth;
        it.phi = v.d + v.halfWidth;
      } else {
        footprint(v.relYaw, v.halfWidth, v.halfLength, this.ext);
        it.hl = this.ext.lon;
        it.plo = v.d - this.ext.lat;
        it.phi = v.d + this.ext.lat;
      }
      if (v.mode === 'drive' && v.lc === 2) {
        it.lo = Math.min(it.plo, v.lcTo - v.halfWidth);
        it.hi = Math.max(it.phi, v.lcTo + v.halfWidth);
      } else {
        it.lo = it.plo;
        it.hi = it.phi;
      }
      it.mask = laneMask(it.lo, it.hi);
      v.item = it;
    }
    const crash = this.ctx.crash;
    if (crash) {
      const ps = p.s;
      for (const b of crash.bodies) {
        const owner = b.owner as Veh | null;
        let s: number;
        let d: number;
        if (owner && (owner as { __traffic?: boolean }).__traffic && owner.body === b) {
          s = owner.s;
          d = owner.d;
        } else {
          const dx = b.position.x - p.position.x;
          const dz = b.position.z - p.position.z;
          if (dx * dx + dz * dz > 1100 * 1100) continue;
          const hint = this.hints.get(b) ?? ps;
          road.project(b.position.x, b.position.z, hint, this.tmpProj);
          s = this.tmpProj.s;
          d = this.tmpProj.d;
          if (this.hints.has(b) || this.hints.size < 512) this.hints.set(b, s);
        }
        if (s < ps - 400 || s > ps + 1100 || d < BARRIER_LEFT_D - 3 || d > BARRIER_RIGHT_D + 2) continue;
        // Still high in the air (the tanker coming off the bridge): nothing to run into down here
        // yet. (Vehicles passing underneath used to "crash" into it six metres below.)
        if (b.position.y - Math.max(b.halfExtents.x, b.halfExtents.y) > 3) continue;
        road.frameAt(s, f);
        const rel = quatHeading(b.quaternion) - f.h;
        footprint(rel, Math.max(b.halfExtents.x, b.halfExtents.y), b.halfExtents.z, this.ext);
        const it = this.item();
        it.veh = owner && (owner as { __traffic?: boolean }).__traffic ? owner : null;
        it.body = b;
        it.s = s;
        it.hl = this.ext.lon;
        it.plo = it.lo = d - this.ext.lat;
        it.phi = it.hi = d + this.ext.lat;
        it.speed = b.linvel.x * f.tx + b.linvel.z * f.tz;
        it.kind = K_OBST;
        it.mask = laneMask(it.lo, it.hi);
      }
    }
    if (p.alive && !p.wrecked) {
      const it = this.item();
      it.veh = null;
      it.body = null;
      it.s = p.s;
      // Yawed footprint: a spun-out player's tail reaches into the next lane.
      footprint(p.relHeading, p.dims.width / 2, p.dims.length / 2, this.ext);
      it.hl = this.ext.lon;
      it.plo = it.lo = p.d - this.ext.lat;
      it.phi = it.hi = p.d + this.ext.lat;
      it.speed = p.speed;
      it.kind = K_PLAYER;
      it.mask = 0;
    }
    // Sorted view (insertion sort; n is small).
    const srt = this.sorted;
    const n = this.nItems;
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      let j = i - 1;
      while (j >= 0 && srt[j].s > it.s) {
        srt[j + 1] = srt[j];
        j--;
      }
      srt[j + 1] = it;
    }
    this.nSorted = n;
  }
  private readonly tmpProj = { s: 0, d: 0 };
  private readonly ext = { lon: 0, lat: 0 };

  // ───────────────────────────────────────────── internals: rule 3 (rolling roadblock)

  private roadblockControl(dt: number): void {
    for (const v of this.list) {
      if (v.capHold > 0) v.capHold -= dt;
      else {
        v.cap = Infinity;
        v.capHard = false;
      }
    }
    const srt = this.sorted;
    const n = this.nSorted;
    const W = TRAFFIC_RULES.roadblockControl;
    for (let i = 0; i < n; i++) {
      const a = srt[i];
      if (a.kind === K_PLAYER || a.mask === 0) continue;
      let m = a.mask;
      let L = -1;
      let j = i + 1;
      for (; j < n; j++) {
        const b = srt[j];
        if (b.kind === K_PLAYER || b.mask === 0) continue;
        if (b.s - a.s > W) break;
        m |= b.mask;
        if (m === ALL_LANES) {
          L = b.s - a.s;
          break;
        }
      }
      if (m !== ALL_LANES && !(a.mask === ALL_LANES)) continue;
      if (L < 0) L = 0;
      // Pick the rear-most AI vehicle of the window and slow it below the others.
      let target: Veh | null = null;
      for (let k = i; k <= Math.min(j, n - 1); k++) {
        const it = srt[k];
        if (it.kind === K_DRIVE && it.veh) {
          target = it.veh;
          break;
        }
      }
      if (!target) continue;
      let minSp = Infinity;
      for (let k = i; k <= Math.min(j, n - 1); k++) {
        const it = srt[k];
        if (it.kind === K_PLAYER || it.mask === 0 || it.veh === target) continue;
        if (it.speed < minSp) minSp = it.speed;
      }
      if (minSp === Infinity) continue;
      const hard = L < TRAFFIC_RULES.roadblockWindow + 8;
      if (target.speed < minSp - 0.8 && !hard) continue; // already opening
      target.cap = Math.min(target.cap, Math.max(2, minSp - (hard ? 3.5 : 1.5)));
      target.capHold = 0.6;
      target.capHard = target.capHard || hard;
      this.stats.roadblockFixes++;
    }
  }

  /**
   * Shortest window length covering all lanes that contains a probe at `ps` with lane mask `pmask`
   * (other items within ±range, `exclude` skipped). Infinity if none.
   */
  private coverWith(ps: number, pmask: number, exclude: Item | null, range = 110): number {
    const S = this.coverS;
    const M = this.coverM;
    let n = 0;
    let p = -1;
    const srt = this.sorted;
    for (let i = 0; i < this.nSorted && n < 250; i++) {
      const it = srt[i];
      if (it === exclude || it.kind === K_PLAYER || it.mask === 0) continue;
      if (it.s < ps - range) continue;
      if (it.s > ps + range) break;
      if (p < 0 && it.s >= ps) {
        p = n;
        S[n] = ps;
        M[n] = pmask;
        n++;
      }
      S[n] = it.s;
      M[n] = it.mask;
      n++;
    }
    if (p < 0) {
      p = n;
      S[n] = ps;
      M[n] = pmask;
      n++;
    }
    let best = Infinity;
    for (let i = 0; i <= p; i++) {
      let m = 0;
      for (let j = i; j < n; j++) {
        m |= M[j];
        if (m === ALL_LANES && j >= p) {
          const L = S[j] - S[i];
          if (L < best) best = L;
          break;
        }
        if (S[j] - S[i] > best) break;
      }
    }
    return best;
  }

  // ───────────────────────────────────────────── internals: AI

  /** Min IDM acceleration against every item ahead overlapping [lo, hi]. Sets qBlockGap. */
  private accelIn(v: Veh, lo: number, hi: number): number {
    let a = idmFree(v.speed, v.idm.v0, v.idm.a);
    this.qBlockGap = Infinity;
    const items = this.items;
    for (let k = 0; k < this.nItems; k++) {
      const it = items[k];
      if (it.veh === v) continue;
      if (!(it.lo < hi && it.hi > lo)) continue;
      const ds = it.s - v.s;
      if (ds < 0 || (ds === 0 && it.veh !== null && it.veh.id < v.id)) continue;
      const gap = ds - it.hl - v.halfLength;
      if (gap > 230) continue;
      if (it.kind === K_PLAYER && gap <= 0) continue;
      const acc = idmAccel(v.speed, v.idm, gap, Math.max(0, it.speed));
      if (acc < a) a = acc;
      const blocking = it.kind === K_OBST || it.speed < 4 || (it.kind === K_SCRIPT && it.speed < v.speed - 6);
      if (blocking && gap < this.qBlockGap) this.qBlockGap = gap;
    }
    return a;
  }

  private think(v: Veh, dt: number): void {
    const ag = this.aggression;
    v.idm.v0 = Math.min(v.baseV0, v.cap);
    const hw = v.halfWidth;
    // Own lane (physical) — decides urgency.
    const aOwn = this.accelIn(v, v.d - hw, v.d + hw);
    const ownBlock = this.qBlockGap;
    let a = aOwn;
    if (v.lc === 2 && v.item) a = Math.min(a, this.accelIn(v, v.item.lo, v.item.hi));
    const urgent = ownBlock < Math.max(35, v.speed * 4.5);

    if (v.lc === 0) {
      v.decide -= dt;
      if (urgent && v.decide > 0.25) v.decide = 0.25;
      if (v.decide <= 0) {
        v.decide = urgent ? 0.25 : lerp(4.5, 1.5, ag) * (0.6 + this.rng() * 0.8);
        const heavy = isHeavy(v.type);
        const minLane = heavy ? (urgent ? 1 : 2) : v.type === 'van' ? (urgent ? 0 : 1) : 0;
        const threshold = lerp(0.4, 0.08, ag);
        let best = -1;
        let bestGain = urgent ? -Infinity : threshold;
        for (let dir = -1; dir <= 1; dir += 2) {
          const t = v.lane + dir;
          if (t < minLane || t >= LANE_COUNT) continue;
          const c = LANE_CENTERS[t];
          const aT = this.accelIn(v, c - hw - 0.3, c + hw + 0.3);
          const tBlock = this.qBlockGap;
          if (urgent && tBlock < ownBlock + 15) continue;
          let gain = aT - aOwn + (dir > 0 ? v.keepRight : -v.keepRight * 0.3);
          if (!urgent && heavy && dir < 0) gain -= 0.4;
          if (urgent) gain += 5 + (tBlock === Infinity ? 1 : 0);
          if (gain > bestGain && this.laneChangeSafe(v, t, urgent)) {
            bestGain = gain;
            best = t;
          }
        }
        if (best < 0 && !urgent && this.rng() < 0.05 + ag * 0.5) {
          const t = v.lane + (this.rng() < 0.5 ? -1 : 1);
          if (t >= minLane && t < LANE_COUNT) {
            const c = LANE_CENTERS[t];
            if (this.accelIn(v, c - hw - 0.3, c + hw + 0.3) > aOwn - 0.3 && this.laneChangeSafe(v, t, false)) best = t;
          }
        }
        if (best >= 0) {
          v.lc = 1;
          v.lcTimer = 0;
          v.lcSignal = TRAFFIC_RULES.signalMin + (urgent ? 0.05 : this.rng() * 0.6);
          v.lcUrgent = urgent;
          v.lcOrigin = v.lane;
          v.targetLane = best;
          v.indicator = best > v.lane ? 1 : -1;
        }
      }
    } else if (v.lc === 1) {
      v.lcTimer += dt;
      if (v.lcTimer >= v.lcSignal) {
        if (this.laneChangeSafe(v, v.targetLane, v.lcUrgent || urgent)) {
          v.lc = 2;
          v.lcTimer = 0;
          v.lcFrom = v.d;
          v.lcTo = LANE_CENTERS[v.targetLane];
          v.aborting = false;
          const base = v.lcUrgent ? 2.2 + this.rng() * 0.4 : lerp(TRAFFIC_RULES.moveMax, TRAFFIC_RULES.moveMin, clamp01(ag * 0.7 + this.rng() * 0.3));
          v.lcDur = Math.min(TRAFFIC_RULES.moveMax, base + (isHeavy(v.type) ? 0.35 : 0));
          this.stats.laneChanges++;
          this.hooks.laneChangeStart?.(v, v.lane, v.targetLane);
        } else if (v.lcTimer > v.lcSignal + 3) {
          v.lc = 0;
          v.targetLane = v.lane;
          v.indicator = 0;
          v.decide = 0.5 + this.rng();
        }
      }
    }
    if (v.lc === 2) {
      v.lcTimer += dt;
      let p = v.lcTimer / v.lcDur;
      if (!v.aborting && p < TRAFFIC_RULES.abortProgress && this.dangerInTarget(v)) {
        this.hooks.laneChangeAbort?.(v, p);
        this.stats.aborts++;
        v.aborting = true;
        v.lcFrom = v.d;
        v.lcTo = LANE_CENTERS[v.lcOrigin];
        v.lcDur = clamp(p * v.lcDur * 1.4, 1.0, 2.4);
        v.lcTimer = 0;
        v.targetLane = v.lcOrigin;
        v.lane = v.lcOrigin;
        v.indicator = 0;
        p = 0;
      }
      v.d = v.lcFrom + (v.lcTo - v.lcFrom) * smoother(p);
      v.latVel = ((v.lcTo - v.lcFrom) * smootherD(p)) / v.lcDur;
      if (!v.aborting && p >= 0.5) v.lane = v.targetLane;
      if (p >= 1) {
        v.d = v.lcTo;
        v.lc = 0;
        v.lane = v.targetLane;
        v.indicator = 0;
        v.latVel = 0;
        v.aborting = false;
        v.decide = (v.lcUrgent ? 1 : 3) + this.rng() * 3;
      }
    } else {
      v.latVel = 0;
      const c = LANE_CENTERS[v.lane];
      if (v.d !== c) v.d = damp(v.d, c, 2, dt);
    }

    // Roadblock speed cap.
    if (v.speed > v.cap + 0.3) a = Math.min(a, -clamp((v.speed - v.cap) * 0.8, 0.6, v.capHard ? 5 : 2.5));
    // Caution zone (the player's crash site): slow right down on the approach, crawl past.
    if (this.cautionS !== null) {
      const ds = this.cautionS - v.s;
      if (ds > -30 && ds < 260) {
        const lim = ds < 70 ? CAUTION_SPEED : CAUTION_SPEED + ((v.baseV0 - CAUTION_SPEED) * (ds - 70)) / 190;
        if (v.speed > lim + 0.3) a = Math.min(a, -clamp((v.speed - lim) * 0.7, 0.6, 4));
        else if (a > 0 && v.speed > lim - 0.5) a = 0;
      }
    }
    v.accel = a;
    if (a < -1.2 || v.speed < 0.5) v.braking = 1;
    else if (a > -0.5) v.braking = 0;
    v.hazard = ownBlock < 40 && v.speed < 4;
  }

  /** Rule 2 + gap acceptance for starting (or committing to) a lane change into `target`. */
  private laneChangeSafe(v: Veh, target: number, urgent: boolean): boolean {
    const c = LANE_CENTERS[target];
    const hw = v.halfWidth;
    const hl = v.halfLength;
    const tlo = c - hw - 0.35;
    const thi = c + hw + 0.35;
    const swLo = Math.min(v.d, c) - hw - 0.3;
    const swHi = Math.max(v.d, c) + hw + 0.3;
    const bSafe = urgent ? 4.5 : lerp(2.2, 3.2, this.aggression);
    const items = this.items;
    for (let k = 0; k < this.nItems; k++) {
      const it = items[k];
      if (it.veh === v) continue;
      let lo = it.plo;
      let hi = it.phi;
      const o = it.veh;
      if (o && o.mode === 'drive' && o.lc > 0) {
        const oc = LANE_CENTERS[o.targetLane];
        lo = Math.min(lo, oc - o.halfWidth);
        hi = Math.max(hi, oc + o.halfWidth);
      }
      const ds = it.s - v.s;
      if (it.kind === K_PLAYER) {
        // Predict the player's lateral motion over the next second.
        const pd = this.playerLatRate();
        if (pd < 0) lo += pd;
        else hi += pd;
        if (lo < swHi && hi > swLo && Math.abs(ds) < it.hl + hl + 4) return this.rej(1); // alongside
        if (lo < c + HALF_LANE && hi > c - HALF_LANE) {
          if (ds < 0) {
            const gap = -ds - it.hl - hl;
            const closing = it.speed - v.speed;
            if (gap < 10) return this.rej(1);
            if (closing > 0 && gap / closing < TRAFFIC_RULES.laneChangeTtc) return this.rej(1);
          } else {
            const gap = ds - it.hl - hl;
            if (gap < 6 || idmAccel(v.speed, v.idm, gap, it.speed) < -bSafe) return this.rej(1);
          }
        }
        continue;
      }
      if (!(lo < thi && hi > tlo)) continue;
      if (Math.abs(ds) < it.hl + hl + 1.5) return this.rej(0);
      if (ds > 0) {
        const gap = ds - it.hl - hl;
        if (gap < 3 + v.speed * 0.3) return this.rej(0);
        if (idmAccel(v.speed, v.idm, gap, Math.max(0, it.speed)) < -bSafe) return this.rej(0);
      } else {
        const gap = -ds - it.hl - hl;
        if (gap < 3 + it.speed * 0.3) return this.rej(0);
        if (o && it.kind === K_DRIVE) {
          if (idmAccel(it.speed, o.idm, gap, v.speed) < -bSafe) return this.rej(0);
        } else if (it.speed > v.speed + 2 && gap / (it.speed - v.speed) < 4) return this.rej(0);
      }
    }
    const mask = laneMask(Math.min(v.d, c) - hw, Math.max(v.d, c) + hw);
    const L = this.coverWith(v.s, mask, v.item);
    if (L < (urgent ? TRAFFIC_RULES.roadblockWindow + 3 : TRAFFIC_RULES.roadblockWindow + 18)) return this.rej(2);
    return true;
  }

  private rej(kind: 0 | 1 | 2): false {
    if (kind === 0) this.stats.rejectGap++;
    else if (kind === 1) this.stats.rejectPlayer++;
    else this.stats.rejectRoadblock++;
    return false;
  }

  /** Player lateral speed relative to the road (m/s, + = right). */
  private playerLatRate(): number {
    const p = this.ctx.player;
    const f = this.ctx.road.frameAt(p.s, this.f);
    return p.velocity.x * f.rx + p.velocity.z * f.rz;
  }

  /** Abort test while the move is < 40 % done. */
  private dangerInTarget(v: Veh): boolean {
    const c = LANE_CENTERS[v.targetLane];
    const hw = v.halfWidth;
    const hl = v.halfLength;
    const tlo = c - hw - 0.2;
    const thi = c + hw + 0.2;
    const items = this.items;
    for (let k = 0; k < this.nItems; k++) {
      const it = items[k];
      if (it.veh === v) continue;
      if (it.kind === K_PLAYER ? !(it.plo < c + HALF_LANE && it.phi > c - HALF_LANE) : !(it.plo < thi && it.phi > tlo)) continue;
      const ds = it.s - v.s;
      if (ds < 0) {
        const gap = -ds - it.hl - hl;
        if (it.kind === K_PLAYER) {
          const closing = it.speed - v.speed;
          if (gap < 3 || (closing > 0 && gap / closing < TRAFFIC_RULES.abortTtc)) return true;
        } else if (it.kind === K_DRIVE && it.veh) {
          if (gap < 1.5 || idmAccel(it.speed, it.veh.idm, gap, v.speed) < -6.5) return true;
        } else if (gap < 1.5) return true;
      } else if (ds - it.hl - hl < 1.5) return true;
    }
    return false;
  }

  private integrate(v: Veh, dt: number): void {
    if (v.mode === 'drive') {
      v.speed = Math.max(0, v.speed + v.accel * dt);
      const yawT = Math.atan2(v.latVel, Math.max(4, v.speed));
      v.relYaw = damp(v.relYaw, yawT, 12, dt);
      v.s += ((v.speed * Math.cos(v.relYaw)) / Math.max(0.5, 1 - v.k * v.d)) * dt;
    } else if (v.mode === 'wreck' && !v.body) {
      const sp = Math.hypot(v.wvs, v.wvd);
      if (sp > 1e-3) {
        const k = Math.max(0, sp - 6.5 * dt) / sp;
        v.wvs *= k;
        v.wvd *= k;
      }
      v.s += v.wvs * dt;
      v.d += v.wvd * dt;
      const lim0 = BARRIER_LEFT_D + v.halfWidth;
      const lim1 = BARRIER_RIGHT_D - v.halfWidth;
      if (v.d < lim0) {
        v.d = lim0;
        v.wvd = Math.abs(v.wvd) * 0.3;
      } else if (v.d > lim1) {
        v.d = lim1;
        v.wvd = -Math.abs(v.wvd) * 0.3;
      }
      v.relYaw += v.spin * dt;
      v.spin = damp(v.spin, 0, 1.6, dt);
      v.speed = Math.hypot(v.wvs, v.wvd);
    }
    // scripted: the event writes s / d / relYaw / speed; we only sync the pose.
    if (!v.body) this.pose(v);
  }

  private pose(v: Veh): void {
    const f = this.ctx.road.frameAt(v.s, this.f);
    v.position.set(f.x + f.rx * v.d, 0, f.z + f.rz * v.d);
    v.heading = f.h + v.relYaw;
    v.k = f.k;
  }

  /** Post-integration: AI vs obstacles (crash) and the AI-vs-AI safety net. */
  private resolve(): void {
    const items = this.items;
    for (let i = 0; i < this.list.length; i++) {
      const v = this.list[i];
      if (v.mode !== 'drive') continue;
      const lo = v.d - v.halfWidth;
      const hi = v.d + v.halfWidth;
      for (let k = 0; k < this.nItems; k++) {
        const it = items[k];
        if (it.veh === v || it.kind === K_PLAYER) continue;
        const o = it.veh;
        const os = o && !it.body ? o.s : it.s;
        let olo = it.plo;
        let ohi = it.phi;
        if (o && o.mode === 'drive') {
          olo = o.d - o.halfWidth;
          ohi = o.d + o.halfWidth;
        }
        if (!(olo < hi - 0.05 && ohi > lo + 0.05)) continue;
        const ds = os - v.s;
        if (Math.abs(ds) >= it.hl + v.halfLength) continue;
        if (ds < 0 || (ds === 0 && o !== null && o.id < v.id)) continue; // the other one is the rear
        if (it.kind === K_DRIVE && o) {
          v.s = os - it.hl - v.halfLength - 0.05;
          if (v.speed > o.speed) v.speed = o.speed;
          this.stats.clamps++;
          this.pose(v);
        } else {
          const closing = v.speed - Math.max(0, it.speed);
          if (closing > 4) {
            this.crashInto(v, it, closing);
            break;
          }
          v.s = os - it.hl - v.halfLength - 0.05;
          v.speed = Math.max(0, Math.min(v.speed, it.speed));
          this.pose(v);
        }
      }
    }
  }

  private crashInto(v: Veh, it: Item, closing: number): void {
    const f = this.ctx.road.frameAt(v.s, this.f);
    const r = this.rng;
    const keep = v.speed * 0.55 + Math.max(0, it.speed) * 0.45;
    const lat = (r() - 0.5) * 4;
    const lin = this.tmpA.set(f.tx * keep + f.rx * lat, 0.5 + r() * 1.5, f.tz * keep + f.rz * lat);
    const ang = this.tmpB.set((r() - 0.5) * 1.2, (r() < 0.5 ? -1 : 1) * (1 + r() * 2.5), (r() - 0.5) * 1.2);
    const crash = this.ctx.crash;
    if (it.body && crash && crash.ready) {
      const imp = new Vector3(f.tx, 0, f.tz).multiplyScalar(v.def.mass * closing * 0.35);
      crash.applyImpulse(it.body, imp, v.position);
    }
    this.stats.crashes++;
    const pos = v.position.clone();
    pos.y = v.def.height * 0.5;
    this.wreck(v, lin, ang);
    this.ctx.events.emit('collision', {
      kind: 'traffic',
      position: pos,
      normal: new Vector3(-f.tx, 0, -f.tz),
      relSpeed: closing,
      intensity: clamp01(closing / 30),
      fatal: false,
    });
  }

  // ───────────────────────────────────────────── internals: spawning (rules 1, 3, 4)

  private despawn(): void {
    const ps = this.ctx.player.s;
    const crash = this.ctx.crash;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i];
      const ds = v.s - ps;
      if (v.mode === 'scripted') {
        if (ds < -600) this.release(i, true);
        continue;
      }
      if (v.body && crash && crash.bodies.indexOf(v.body) < 0) {
        v.body = null; // the crash world dropped it
        this.release(i, false);
        continue;
      }
      if (ds < -TRAFFIC_RULES.despawnBehind || ds > TRAFFIC_RULES.despawnAhead) this.release(i, true);
    }
  }

  private heavyShare(): number {
    return 0.22 + 0.1 * clamp01(this.ctx.player.s / 15000);
  }

  private ambientTarget(): number {
    return Math.round(this.density * LANE_COUNT * (TRAFFIC_RULES.densitySpanM / 1000));
  }

  private spawnAmbient(dt: number): void {
    const p = this.ctx.player;
    const cap = this.ctx.quality.settings.trafficMax;
    const target = this.ambientTarget();
    let ambient = 0;
    for (const v of this.list) if (v.ambient && v.mode === 'drive') ambient++;
    if (this.prefill) {
      this.prefill = false;
      this.buildItems();
      const want = Math.min(target, cap);
      const span = TRAFFIC_RULES.spawnAheadMax - TRAFFIC_RULES.spawnMinAhead;
      for (let tries = 0; tries < want * 6 && ambient < want; tries++) {
        const s = p.s + TRAFFIC_RULES.spawnMinAhead + 5 + this.rng() * (span - 5);
        if (this.trySpawn(s)) {
          ambient++;
          this.buildItems();
        }
      }
      return;
    }
    if (ambient >= target) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.05;
    if (this.list.length >= cap) {
      // Prefer keeping vehicles ahead: drop the furthest one well behind the player.
      if (!this.evict(-40)) return;
      this.buildItems();
    }
    const behind = p.speed < TRAFFIC_RULES.slowPlayerSpeed && this.rng() < 0.5;
    for (let tries = 0; tries < 3; tries++) {
      const s = behind
        ? p.s - lerp(TRAFFIC_RULES.spawnBehindMin, TRAFFIC_RULES.spawnBehindMax, this.rng())
        : p.s + lerp(TRAFFIC_RULES.spawnAheadMax - 140, TRAFFIC_RULES.spawnAheadMax, this.rng());
      if (this.trySpawn(s)) return;
    }
  }

  private trySpawn(s: number): boolean {
    const r = this.rng;
    const p = this.ctx.player;
    const ds = s - p.s;
    // Rule 1 (hard guard).
    if (ds > -TRAFFIC_RULES.spawnBehindMin + 1 && ds < TRAFFIC_RULES.spawnMinAhead) return false;
    const type = pickType(r(), r(), this.heavyShare());
    const def = this.factory.defs[type];
    const hl = def.length / 2;
    // Rule 4.
    for (const z of this.reserves) if (s + hl > z.s0 && s - hl < z.s1) return false;
    let lane: number;
    if (isHeavy(type)) lane = r() < 0.7 ? 3 : 2;
    else if (type === 'van') lane = 1 + Math.floor(r() * 3);
    else if (type === 'sports') lane = r() < 0.7 ? 0 : 1;
    else {
      const x = (lerp(def.speedMin, def.speedMax, r()) - 26) / 8;
      lane = clamp(Math.round(3 - x * 3 + (r() - 0.5) * 1.8), 0, 3);
    }
    const c = LANE_CENTERS[lane];
    const hw = def.width / 2;
    const lo = c - hw - 0.4;
    const hi = c + hw + 0.4;
    const v0 = lerp(def.speedMin, def.speedMax, 0.5);
    let speed = v0;
    // Leader / follower gap acceptance.
    const items = this.items;
    for (let k = 0; k < this.nItems; k++) {
      const it = items[k];
      if (!(it.lo < hi && it.hi > lo)) continue;
      const d = it.s - s;
      if (d >= 0) {
        const gap = d - it.hl - hl;
        if (gap < 8) return false;
        speed = Math.min(speed, Math.max(0, it.speed) + Math.max(0, gap - 25) * 0.12);
      }
    }
    for (let k = 0; k < this.nItems; k++) {
      const it = items[k];
      if (!(it.lo < hi && it.hi > lo)) continue;
      const d = it.s - s;
      const sp = Math.max(0, it.speed);
      if (d >= 0) {
        const gap = d - it.hl - hl;
        if (gap < 4 + speed * 1.3 + Math.max(0, speed - sp) * 2.5) return false;
      } else {
        const gap = -d - it.hl - hl;
        if (gap < 5 + sp * 1.5 + Math.max(0, sp - speed) * 3) return false;
      }
    }
    if (speed < 8) return false;
    // Rule 3 (with margin).
    if (this.coverWith(s, 1 << lane, null) < TRAFFIC_RULES.roadblockControl + 18) return false;
    const v = this.create(type, s, lane, speed, true);
    this.stats.spawns++;
    this.hooks.spawned?.(v);
    return true;
  }
}

/** Heading of a quaternion's local -Z axis (see conventions). */
function quatHeading(q: Quaternion): number {
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return Math.atan2(fx, -fz);
}

/** Road-aligned half extents of a box with half width hw / half length hl, yawed by `rel`. */
function footprint(rel: number, hw: number, hl: number, out: { lon: number; lat: number }): void {
  const c = Math.abs(Math.cos(rel));
  const s = Math.abs(Math.sin(rel));
  out.lon = c * hl + s * hw;
  out.lat = s * hl + c * hw;
}
