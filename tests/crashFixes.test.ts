/**
 * Review fixes: pooled vehicle invalidation, yawed player footprint, crash-world interpolation / ground offset / eviction.
 */
import { describe, expect, it } from 'vitest';
import { Object3D, Quaternion, Scene, Vector3 } from 'three';
import type { GameContext, QualitySettings } from '../src/core/types';
import { EventBus } from '../src/core/events';
import { RoadPath } from '../src/world/roadPath';
import { createPlayerState } from '../src/game/playerState';
import { LANE_CENTERS } from '../src/world/roadProfile';
import { createTraffic } from '../src/traffic/trafficSystem';
import { createStubFactory } from '../src/traffic/ai/stubFactory';
import { CrashWorld } from '../src/physics/crashWorld';
import { Director } from '../src/game/director';
import type { ScoreSystem } from '../src/game/score';

const DT = 1 / 120;
const zero3 = new Vector3();

function makeCtx() {
  const road = new RoadPath(1);
  const player = createPlayerState();
  const ctx = {
    engine: { scene: new Scene() },
    events: new EventBus(),
    quality: { settings: { trafficMax: 26, oncomingMax: 20 } as QualitySettings, level: 'ultra', set() {}, pixelRatio: 1 },
    road,
    world: { tunnelAt: () => 0 },
    player,
    time: { now: 0, real: 0, dt: DT, rawDt: DT, scale: 1, frame: 0 },
    state: 'playing',
  } as unknown as GameContext;
  player.s = 100;
  player.d = LANE_CENTERS[1];
  road.toWorld(player.s, player.d, 0, player.position);
  player.heading = road.headingAt(player.s);
  return { ctx, road, player };
}

describe('traffic pool and player footprint', () => {
  it('a released vehicle is invalidated and gets a fresh id when reused', () => {
    const env = makeCtx();
    const tr = createTraffic(env.ctx, createStubFactory());
    tr.step(DT);
    let v = null;
    for (let k = 0; k < 20 && !v; k++) v = tr.spawn('sedan', 460 + k * 30, 2, 20, 'scripted');
    if (!v) throw new Error('no free spot');
    const id = v.id;
    expect(id).toBeGreaterThan(0);
    tr.remove(v);
    expect(v.id).toBe(-1);
    const w = tr.spawn('sedan', v.s, 2, 20, 'scripted');
    expect(w).toBe(v); // the pooled object is reused
    expect(w!.id).toBeGreaterThan(id);
  });

  it('the AI sees a sideways player across its yawed footprint', () => {
    const env = makeCtx();
    const tr = createTraffic(env.ctx, createStubFactory());
    env.player.relHeading = Math.PI / 2;
    tr.step(DT);
    const items = (tr as unknown as { items: { kind: number; veh: unknown; body: unknown; lo: number; hi: number; s: number }[]; nItems: number });
    const it = items.items.slice(0, items.nItems).find((i) => i.veh === null && i.body === null && i.s === env.player.s)!;
    expect(it.hi - it.lo).toBeCloseTo(env.player.dims.length, 3);
  });
});

describe('crash world', async () => {
  const cw = new CrashWorld(new RoadPath(1));
  await cw.init();
  const zero = new Vector3();

  it('vehicle objects rest on the road and move smoothly in slow motion', () => {
    cw.reset();
    const o = new Object3D();
    const half = new Vector3(0.9, 1.25, 2.4);
    const b = cw.addBox(o, half, 1500, new Vector3(0, 1.25, 0), new Quaternion(), new Vector3(0, 0, -10), zero, null, 1.25);
    let still = 0;
    let last = o.position.z;
    for (let i = 0; i < 300; i++) {
      cw.step(1 / 300, 0); // 0.2x slow motion at 60 fps
      if (i >= 5 && o.position.z === last) still++; // the first physics step has no previous pose to blend from
      last = o.position.z;
    }
    expect(still).toBe(0);
    for (let i = 0; i < 300; i++) cw.step(1 / 60, 0);
    expect(Math.abs(b.position.y - 1.25)).toBeLessThan(0.1);
    expect(Math.abs(o.position.y)).toBeLessThan(0.1);
  });

  it('the body cap evicts traffic bodies before director bodies', () => {
    cw.reset();
    const p = new Vector3();
    const half = new Vector3(1, 1, 2);
    const dir = cw.addBox(new Object3D(), half, 1000, p.set(0, 1, 0), new Quaternion(), zero, zero, 'director');
    for (let i = 0; i < 45; i++) cw.addBox(new Object3D(), half, 1000, p.set(0, 1, -6 * (i + 1)), new Quaternion(), zero, zero, { traffic: i });
    expect(cw.bodies.includes(dir as (typeof cw.bodies)[number])).toBe(true);
    expect(cw.bodies.length).toBe(40);
  });
});

describe('wreck hand-over speed', async () => {
  const env = makeCtx();
  const cw = new CrashWorld(env.road);
  await cw.init();
  (env.ctx as unknown as { crash: CrashWorld }).crash = cw;
  const tr = createTraffic(env.ctx, createStubFactory());
  tr.step(DT);

  it('an AI vehicle that runs into an obstacle keeps its driving speed (not its world position as velocity)', () => {
    let v = null;
    for (let k = 0; k < 20 && !v; k++) v = tr.spawn('sedan', 600 + k * 30, 2, 30, 'drive');
    if (!v) throw new Error('no free spot');
    // Far from the origin, as everywhere on the road: the old code handed over |velocity| = |position|.
    expect(Math.hypot(v.position.x, v.position.z)).toBeGreaterThan(300);
    const before = v.position.clone();
    (tr as unknown as { crashInto(v: unknown, it: unknown, closing: number): void }).crashInto(v, { body: null, speed: 0 }, 30);
    const b = cw.bodies.find((x) => x.owner === v)!;
    expect(b).toBeTruthy();
    const speed = Math.hypot(b.linvel.x, b.linvel.z);
    expect(speed).toBeGreaterThan(10); // 55 % of 30 m/s, plus a little sideways
    expect(speed).toBeLessThan(20);
    expect(Math.hypot(b.position.x - before.x, b.position.z - before.z)).toBeLessThan(0.01);
  });

  it('no hand-over, hit or solver kick makes a wreck faster than anything can drive', () => {
    cw.reset();
    const half = new Vector3(1.25, 1.6, 6);
    const p = new Vector3();
    // An absurd hand-over is cut down to the hard limit…
    const a = cw.addBox(new Object3D(), half, 30000, p.set(0, 1.6, 0), new Quaternion(), new Vector3(0, 0, -5000), zero3, null, 1.6);
    expect(Math.hypot(a.linvel.x, a.linvel.z)).toBeLessThanOrEqual(110.001);
    cw.reset();
    // …and two bodies handed over inside each other, steered by small pushes every step (the
    // director's keep-left shove), never gain speed from the solver pushing them apart.
    const t1 = cw.addBox(new Object3D(), half, 30000, p.set(0, 1.6, 0), new Quaternion(), new Vector3(0, 0, -20), zero3, null, 1.6);
    const t2 = cw.addBox(new Object3D(), half, 9000, p.set(0.8, 1.6, -3), new Quaternion(), new Vector3(0, 0, -17), zero3, null, 1.6);
    const push = new Vector3();
    let fastest = 0;
    for (let i = 0; i < 360; i++) {
      for (const b of [t1, t2]) cw.applyImpulse(b, push.set(9 * (1 / 120) * b.mass, 0, 0));
      cw.step(1 / 120, 0);
      for (const b of [t1, t2]) fastest = Math.max(fastest, Math.hypot(b.linvel.x, b.linvel.z));
    }
    expect(fastest).toBeLessThan(26);
  });
});

describe('a way through the wreckage', async () => {
  const env = makeCtx();
  const cw = new CrashWorld(env.road);
  await cw.init();
  (env.ctx as unknown as { crash: CrashWorld }).crash = cw;
  type Guard = { keepLaneOpen(dt: number): void; pile: Array<{ lo: number; hi: number }> };
  const guard = new Director(env.ctx, {} as ScoreSystem, null) as unknown as Guard;
  const s0 = 460;

  /** Worst intrusion of the pile into the leftmost / the rightmost lane after the last guard step. */
  const intrusion = (n: number) => {
    let inL = 0;
    let inR = 0;
    for (const it of guard.pile.slice(0, n)) {
      inL = Math.max(inL, -3.3 - it.lo);
      inR = Math.max(inR, Math.min(it.hi, 7.6) - Math.max(it.lo, 3.3));
    }
    return { inL, inR };
  };
  const place = (d: number, yaw: number, half: Vector3, mass: number) => {
    const pos = env.road.toWorld(s0, d, half.y, new Vector3());
    const h = env.road.headingAt(s0) + yaw;
    return cw.addBox(new Object3D(), half, mass, pos, new Quaternion(0, Math.sin(-h / 2), 0, Math.cos(-h / 2)), zero3, zero3, null, half.y);
  };

  it('a tanker lying across the whole carriageway, one end against the barrier, is swung out of an outer lane', () => {
    cw.reset();
    env.player.s = s0 - 70;
    // 16 m long, 72° across the road, centre in lane 2: reaches from the right barrier well into lane 0.
    place(2.2, 1.26, new Vector3(1.3, 1.3, 8.1), 30000);
    for (let i = 0; i < 60; i++) cw.step(1 / 120, env.player.s);
    guard.keepLaneOpen(1 / 120);
    const before = intrusion(1);
    expect(before.inL).toBeGreaterThan(1);
    expect(before.inR).toBeGreaterThan(1);
    for (let i = 0; i < 120 * 10; i++) {
      guard.keepLaneOpen(1 / 120);
      cw.step(1 / 120, env.player.s);
    }
    const after = intrusion(1);
    expect(Math.min(after.inL, after.inR)).toBeLessThan(0.1);
  });

  it('wrecks that leave an outer lane open are left alone', () => {
    cw.reset();
    const b = place(1.85, 0.1, new Vector3(1.3, 1.3, 8.1), 30000);
    for (let i = 0; i < 120; i++) cw.step(1 / 120, env.player.s);
    const x = b.position.x;
    const z = b.position.z;
    for (let i = 0; i < 240; i++) {
      guard.keepLaneOpen(1 / 120);
      cw.step(1 / 120, env.player.s);
    }
    expect(Math.hypot(b.position.x - x, b.position.z - z)).toBeLessThan(0.05);
  });
});
