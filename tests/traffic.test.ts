/**
 * Traffic AI acceptance tests (run: npx vitest run tests/traffic.test.ts).
 * Pure logic: fake GameContext (real RoadPath + EventBus), stub factory, no renderer.
 */
import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import type { GameContext, QualitySettings, TrafficVehicle } from '../src/core/types';
import { EventBus } from '../src/core/events';
import { RoadPath } from '../src/world/roadPath';
import { createPlayerState } from '../src/game/playerState';
import { LANE_CENTERS, LANE_WIDTH } from '../src/world/roadProfile';
import { createTraffic, laneMask, TRAFFIC_RULES, type TrafficSystemApi } from '../src/traffic/trafficSystem';
import { createStubFactory } from '../src/traffic/ai/stubFactory';

const DT = 1 / 120;

function makeCtx(trafficMax = 26, oncomingMax = 20) {
  const road = new RoadPath(1);
  const player = createPlayerState();
  const settings = { trafficMax, oncomingMax } as QualitySettings;
  const ctx = {
    engine: { scene: new Scene() },
    events: new EventBus(),
    quality: { settings, level: 'ultra', set() {}, pixelRatio: 1 },
    road,
    world: { tunnelAt: () => 0 },
    player,
    time: { now: 0, real: 0, dt: DT, rawDt: DT, scale: 1, frame: 0 },
    state: 'playing',
  } as unknown as GameContext;
  return { ctx, road, player };
}

type Env = ReturnType<typeof makeCtx>;

function placePlayer(env: Env, s: number, d: number, speed: number): void {
  const p = env.player;
  p.s = s;
  p.d = d;
  p.speed = speed;
  env.road.toWorld(s, d, 0, p.position);
  p.heading = env.road.headingAt(s);
}

/** Player at constant speed weaving lanes (lateral 4 m/s, new lane every 1.5–4 s). */
function weaver(seed = 7) {
  let r = seed;
  const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
  let d = LANE_CENTERS[1];
  let target = d;
  let timer = 0;
  return (dt: number): number => {
    timer -= dt;
    if (timer <= 0) {
      timer = 1.5 + rnd() * 2.5;
      target = LANE_CENTERS[Math.floor(rnd() * 4)];
    }
    const step = 4 * dt;
    d = Math.abs(target - d) <= step ? target : d + Math.sign(target - d) * step;
    return d;
  };
}

function overlaps(a: TrafficVehicle, b: TrafficVehicle): boolean {
  return Math.abs(a.s - b.s) < a.halfLength + b.halfLength - 0.02 && Math.abs(a.d - b.d) < a.halfWidth + b.halfWidth - 0.02;
}

/** Rule 3 check (independent of the system): is there a 45 m window where all 4 lanes hold a vehicle? */
function rollingRoadblock(vs: readonly TrafficVehicle[], buf: { s: number; m: number }[]): boolean {
  buf.length = 0;
  for (const v of vs) {
    const m = laneMask(v.d - v.halfWidth, v.d + v.halfWidth);
    if (m) buf.push({ s: v.s, m });
  }
  buf.sort((a, b) => a.s - b.s);
  for (let i = 0; i < buf.length; i++) {
    let m = 0;
    for (let j = i; j < buf.length && buf[j].s - buf[i].s <= TRAFFIC_RULES.roadblockWindow; j++) m |= buf[j].m;
    if (m === 15) return true;
  }
  return false;
}

describe('traffic: 5-minute max density / aggression run, player 80 m/s weaving', () => {
  const env = makeCtx(26);
  const tr = createTraffic(env.ctx, createStubFactory());
  tr.setDensity(14);
  tr.setAggression(1);
  const weave = weaver();
  let s = 100;
  const res = {
    steps: 0,
    collisions: 0,
    spawnTooClose: 0,
    outOfRange: 0,
    laneChangeIntoPlayer: 0,
    laneChanges: 0,
    roadblockSteps: 0,
    maxCount: 0,
    sumCount: 0,
    heavy: 0,
    total: 0,
    crashEvents: 0,
  };
  tr.hooks.spawned = (v) => {
    const ds = v.s - env.player.s;
    if (ds < TRAFFIC_RULES.spawnMinAhead && ds > -TRAFFIC_RULES.despawnBehind) res.spawnTooClose++;
    res.total++;
    if (v.type === 'van' || v.type === 'boxtruck' || v.type === 'semi' || v.type === 'tanker') res.heavy++;
  };
  tr.hooks.laneChangeStart = (v, _from, to) => {
    res.laneChanges++;
    const p = env.player;
    const c = LANE_CENTERS[to];
    const phw = p.dims.width / 2;
    const phl = p.dims.length / 2;
    const inTarget = Math.abs(p.d - c) < LANE_WIDTH / 2 + phw;
    const rel = v.s - p.s;
    const swLo = Math.min(v.d, c) - v.halfWidth;
    const swHi = Math.max(v.d, c) + v.halfWidth;
    const alongside = Math.abs(rel) < v.halfLength + phl && p.d - phw < swHi && p.d + phw > swLo;
    let ttcBad = false;
    if (inTarget && rel > 0) {
      const gap = rel - v.halfLength - phl;
      const closing = p.speed - v.speed;
      ttcBad = closing > 0 && gap / closing < TRAFFIC_RULES.laneChangeTtc;
    }
    if (alongside || ttcBad) res.laneChangeIntoPlayer++;
  };
  env.ctx.events.on('collision', () => res.crashEvents++);
  const buf: { s: number; m: number }[] = [];
  const steps = Math.round(300 / DT);
  for (let i = 0; i < steps; i++) {
    s += 80 * DT;
    placePlayer(env, s, weave(DT), 80);
    tr.step(DT);
    const vs = tr.vehicles;
    res.steps++;
    res.maxCount = Math.max(res.maxCount, vs.length);
    res.sumCount += vs.length;
    for (let a = 0; a < vs.length; a++) {
      const ds = vs[a].s - s;
      if (ds < -TRAFFIC_RULES.despawnBehind - 1 || ds > TRAFFIC_RULES.despawnAhead + 1) res.outOfRange++;
      for (let b = a + 1; b < vs.length; b++) if (overlaps(vs[a], vs[b])) res.collisions++;
    }
    if (rollingRoadblock(vs, buf)) res.roadblockSteps++;
  }
  console.log('[traffic] 5-min run', JSON.stringify({ ...res, avg: +(res.sumCount / res.steps).toFixed(1) }), tr.debugInfo(), JSON.stringify(tr.stats));

  it('no AI-vs-AI collisions and the safety net is never needed', () => {
    expect(res.collisions).toBe(0);
    expect(res.crashEvents).toBe(0);
    expect(tr.stats.clamps).toBe(0);
  });
  it('rule 1: spawns never inside 320 m ahead; despawn range respected', () => {
    expect(res.total).toBeGreaterThan(100);
    expect(res.spawnTooClose).toBe(0);
    expect(res.outOfRange).toBe(0);
  });
  it('rule 2: lane changes never start into the player (TTC < 3.5 s or alongside)', () => {
    expect(res.laneChanges).toBeGreaterThan(100);
    expect(res.laneChangeIntoPlayer).toBe(0);
  });
  it('rule 3: never a rolling roadblock (all 4 lanes within 45 m)', () => {
    expect(res.roadblockSteps).toBe(0);
  });
  it('respects trafficMax and keeps a realistic heavy-vehicle mix', () => {
    expect(res.maxCount).toBeLessThanOrEqual(26);
    expect(res.sumCount / res.steps).toBeGreaterThan(18);
    const share = res.heavy / res.total;
    expect(share).toBeGreaterThan(0.14);
    expect(share).toBeLessThan(0.34);
  });
  it('oncoming traffic stays within its cap, on the opposite carriageway, heading towards -s', () => {
    expect(tr.oncoming.length).toBeGreaterThan(4);
    expect(tr.oncoming.length).toBeLessThanOrEqual(20);
    for (const o of tr.oncoming) {
      expect(o.d).toBeLessThan(-10);
      const dh = Math.abs(((o.heading - env.road.headingAt(o.s) - Math.PI + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(dh).toBeLessThan(1e-6);
    }
  });
});

describe('traffic: density', () => {
  for (const dens of [4, 9]) {
    it(`density ${dens}/km/lane is roughly matched`, () => {
      const env = makeCtx(400);
      const tr = createTraffic(env.ctx, createStubFactory());
      tr.setDensity(dens);
      tr.setAggression(0.5);
      let s = 100;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 150 / DT; i++) {
        s += 60 * DT;
        placePlayer(env, s, LANE_CENTERS[1], 60);
        tr.step(DT);
        if (i * DT > 30 && i % 60 === 0) {
          let c = 0;
          for (const v of tr.vehicles) if (v.s > s - TRAFFIC_RULES.despawnBehind && v.s < s + TRAFFIC_RULES.spawnAheadMax) c++;
          sum += c;
          n++;
        }
      }
      const measured = sum / n / ((TRAFFIC_RULES.densitySpanM / 1000) * 4);
      console.log(`[traffic] density set ${dens} measured ${measured.toFixed(2)}`);
      expect(measured).toBeGreaterThan(dens * 0.75);
      expect(measured).toBeLessThan(dens * 1.25);
    });
  }
});

describe('traffic: scripted vehicles, reserve, abort, obstacles', () => {
  it('scripted vehicles are untouched by the AI (only pose sync)', () => {
    const env = makeCtx(26);
    const tr = createTraffic(env.ctx, createStubFactory());
    tr.setDensity(10);
    let s = 100;
    placePlayer(env, s, LANE_CENTERS[0], 40);
    tr.step(DT);
    let sv: TrafficVehicle | null = null;
    for (let k = 0; k < 20 && !sv; k++) sv = tr.spawn('semi', s + 360 + k * 30, 2, 12, 'scripted');
    if (!sv) throw new Error('no free spot');
    let ss = sv.s;
    for (let i = 0; i < 25 / DT; i++) {
      s += 40 * DT;
      placePlayer(env, s, LANE_CENTERS[0], 40);
      ss += 12 * DT;
      sv.s = ss; // the "event" drives it
      tr.step(DT);
      expect(sv.mode).toBe('scripted');
      expect(sv.speed).toBe(12);
      expect(sv.d).toBe(LANE_CENTERS[2]);
      expect(sv.lane).toBe(2);
      expect(sv.indicator).toBe(0);
      for (const v of tr.vehicles) if (v !== sv) expect(overlaps(v, sv)).toBe(false);
    }
    const w = env.road.toWorld(sv.s, sv.d, 0, sv.position.clone());
    expect(sv.position.distanceTo(w)).toBeLessThan(1e-6);
    expect(tr.vehicles.includes(sv)).toBe(true);
  });

  it('rule 4: reserved zones get no ambient spawns', () => {
    const env = makeCtx(60);
    const tr = createTraffic(env.ctx, createStubFactory());
    tr.setDensity(12);
    let bad = 0;
    let s = 100;
    const z0 = 1500;
    const z1 = 4000;
    const release = tr.reserve(z0, z1);
    tr.hooks.spawned = (v) => {
      if (v.s + v.halfLength > z0 && v.s - v.halfLength < z1) bad++;
    };
    for (let i = 0; i < 30 / DT; i++) {
      s += 70 * DT;
      placePlayer(env, s, LANE_CENTERS[1], 70);
      tr.step(DT);
    }
    expect(bad).toBe(0);
    release();
    let after = 0;
    tr.hooks.spawned = (v) => {
      if (v.s > z0 && v.s < z1) after++;
    };
    for (let i = 0; i < 10 / DT; i++) {
      s += 70 * DT;
      placePlayer(env, s, LANE_CENTERS[1], 70);
      tr.step(DT);
    }
    expect(after).toBeGreaterThan(0);
  });

  it('rule 2: a lane change aborts when the player appears in the target lane (TTC < 1.5 s, < 40 % done)', () => {
    let aborted = 0;
    let started = 0;
    for (let trial = 0; trial < 8; trial++) {
      const env = makeCtx(26);
      const tr = createTraffic(env.ctx, createStubFactory());
      tr.setDensity(0);
      tr.setAggression(0.8);
      placePlayer(env, 0, LANE_CENTERS[3], 30);
      tr.step(DT);
      const base = 200 + trial * 13;
      const v = tr.spawn('sedan', base, 1, 30)!;
      const slow = tr.spawn('hatch', base + 45, 1, 14, 'scripted')!;
      let ps = 0;
      let teleported = false;
      let abortedHere = false;
      tr.hooks.laneChangeStart = (veh, _f, to) => {
        if (veh !== v || teleported) return;
        teleported = true;
        started++;
        // The player appears 25 m behind in the target lane at +40 m/s closing (TTC ≈ 0.6 s).
        ps = veh.s - 25 - veh.halfLength - 2.2;
        placePlayer(env, ps, LANE_CENTERS[to], v.speed + 40);
      };
      tr.hooks.laneChangeAbort = (veh, p) => {
        if (veh === v) {
          abortedHere = true;
          expect(p).toBeLessThan(0.4);
        }
      };
      for (let i = 0; i < 12 / DT && !abortedHere; i++) {
        slow.s += 14 * DT;
        if (!teleported) placePlayer(env, 0, LANE_CENTERS[3], 30);
        else {
          ps += env.player.speed * DT;
          placePlayer(env, ps, env.player.d, env.player.speed);
        }
        tr.step(DT);
      }
      if (abortedHere) {
        aborted++;
        // It returns to its origin lane.
        for (let i = 0; i < 3 / DT; i++) {
          slow.s += 14 * DT;
          tr.step(DT);
        }
        expect(Math.abs(v.d - LANE_CENTERS[1])).toBeLessThan(0.05);
      }
    }
    expect(started).toBeGreaterThan(5);
    expect(aborted).toBe(started);
  });

  it('a stationary obstacle in lane 2 is avoided by >= 90 % of approaching vehicles', () => {
    const env = makeCtx(60);
    const tr = createTraffic(env.ctx, createStubFactory());
    tr.setDensity(0);
    tr.setAggression(0.5);
    let ps = 60;
    placePlayer(env, ps, LANE_CENTERS[0], 27);
    tr.step(DT);
    const obstS = 1000;
    const obst = tr.spawn('boxtruck', obstS, 2, 0, 'scripted')!;
    const approaching: TrafficVehicle[] = [];
    const types = ['sedan', 'suv', 'hatch', 'van', 'semi', 'sports', 'sedan', 'boxtruck', 'suv', 'hatch', 'sedan', 'tanker'] as const;
    for (let k = 0; k < types.length; k++) {
      const v = tr.spawn(types[k], 660 - k * 46, 2, 26);
      if (v) approaching.push(v);
    }
    const ids = approaching.map((v) => v.id);
    const passed = new Set<number>();
    const crashed = new Set<number>();
    for (let i = 0; i < 70 / DT; i++) {
      ps += 27 * DT;
      placePlayer(env, ps, LANE_CENTERS[0], 27);
      tr.step(DT);
      for (const v of approaching) {
        if (!tr.vehicles.includes(v) || v.id !== ids[approaching.indexOf(v)]) continue;
        if (v.mode === 'wreck') crashed.add(v.id);
        if (v.mode === 'drive' && v.s - v.halfLength > obst.s + obst.halfLength + 2) passed.add(v.id);
      }
    }
    const share = passed.size / approaching.length;
    console.log(`[traffic] obstacle: ${passed.size}/${approaching.length} passed, ${crashed.size} crashed`, tr.debugInfo());
    expect(approaching.length).toBeGreaterThanOrEqual(10);
    expect(crashed.size).toBe(0);
    expect(share).toBeGreaterThanOrEqual(0.9);
  });

  it('wreck() without a crash world: kinematic slide that stops; collision event on a crash', () => {
    const env = makeCtx(26);
    const tr = createTraffic(env.ctx, createStubFactory());
    tr.setDensity(0);
    placePlayer(env, 0, LANE_CENTERS[3], 0);
    tr.step(DT);
    const v = tr.spawn('sedan', 300, 1, 30)!;
    let events = 0;
    env.ctx.events.on('collision', (e) => {
      events++;
      expect(e.kind).toBe('traffic');
      expect(e.fatal).toBe(false);
    });
    // A wreck dropped right in front: too close to stop -> crash.
    const w = tr.spawn('suv', 700, 1, 0, 'scripted')!;
    w.s = 312;
    tr.wreck(w, w.position.clone().set(0, 0, 0), w.position.clone().set(0, 0, 0));
    for (let i = 0; i < 8 / DT; i++) tr.step(DT);
    expect(v.mode).toBe('wreck');
    expect(events).toBe(1);
    expect(v.speed).toBeLessThan(0.01);
  });
});
