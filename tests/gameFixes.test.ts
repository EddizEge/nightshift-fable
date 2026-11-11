/**
 * Small game-logic regressions (run: npx vitest run tests/gameFixes.test.ts).
 * Node has no localStorage, which is exactly the "storage blocked" case for the best score.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { GameContext } from '../src/core/types';
import { EventBus } from '../src/core/events';
import { Autopilot } from '../src/game/autopilot';
import { ScoreSystem } from '../src/game/score';
import { wreckFootprint } from '../src/game/player';

describe('best score without storage', () => {
  it('only the first run beats the session best', () => {
    const a = new ScoreSystem(new EventBus());
    a.score = 1200;
    expect(a.finish('X').isNewBest).toBe(true);
    const b = new ScoreSystem(new EventBus());
    b.score = 800;
    const s = b.finish('X');
    expect(s.isNewBest).toBe(false);
    expect(s.bestScore).toBe(1200);
  });
});

describe('wreck footprint', () => {
  const half = new Vector3(1.25, 1.8, 6);
  const q = new Quaternion();
  it('upright: width x, length z', () => {
    const f = wreckFootprint(q.identity(), half, { heading: 0, hw: 0, hl: 0 });
    expect(f.hw).toBeCloseTo(1.25);
    expect(f.hl).toBeCloseTo(6);
    expect(Math.abs(Math.sin(f.heading))).toBeLessThan(1e-6);
  });
  it('on its flank: width is the height half extent', () => {
    q.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const f = wreckFootprint(q, half, { heading: 0, hw: 0, hl: 0 });
    expect(f.hw).toBeCloseTo(1.8);
    expect(f.hl).toBeCloseTo(6);
  });
  it('standing on its nose: no long box along the road', () => {
    q.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 - 0.02);
    const f = wreckFootprint(q, half, { heading: 0, hw: 0, hl: 0 });
    expect(f.hl).toBeCloseTo(1.8);
    expect(f.hw).toBeCloseTo(1.25);
  });
});

describe('test driver: the warning banner', () => {
  // Straight road, the car at 190 km/h, a slower car 54 m ahead in the leftmost lane, and the
  // announced zone ("PILE-UP AHEAD — KEEP LEFT") over the three lanes to the right, 133 m ahead.
  const make = (d: number) => {
    const player = { s: 1000, d, speed: 53, relHeading: 0, yawRate: 0, nitro01: 0, dims: { length: 4.6, width: 1.9 } };
    const sedan = { mode: 'drive', s: 1000 + 2.3 + 54 + 2.2, d: -5.55, speed: 32, braking: 0, halfLength: 2.2, halfWidth: 0.9, lane: 0, targetLane: 0 };
    const ctx = { player, road: { curvatureAt: () => 0 }, traffic: { vehicles: [sedan] } } as unknown as GameContext;
    const ap = new Autopilot(ctx);
    ap.reset();
    ap.hazard = { s: 1000 + 2.3 + 133 + 70, d: 3.55, halfS: 70, halfD: 6.85, speed: 23 };
    return ap;
  };

  it('stays in the open lane behind a slower car instead of pulling out into the zone', () => {
    const ap = make(-5.55);
    for (let i = 0; i < 120; i++) ap.update(1 / 120);
    expect(ap.targetLane).toBe(0);
  });

  it('leaves a lane inside the zone at once, however far ahead the zone is', () => {
    const ap = make(1.85);
    ap.hazard!.s += 250;
    ap.update(1 / 120);
    expect(ap.targetLane).toBe(1);
  });
});

describe('test driver: what it brakes for', () => {
  it('a standing zone beyond a slower car, not just the car', () => {
    // 223 km/h in lane 1, cars alongside on the right, a car doing 94 km/h 105 m ahead (no need to
    // brake for that one yet) and the drop zone of the second set piece 129 m ahead.
    const player = { s: 1000, d: -1.85, speed: 62, relHeading: 0, yawRate: 0, nitro01: 0, dims: { length: 4.6, width: 1.9 } };
    const car = (s: number, d: number, speed: number, lane: number) => ({ mode: 'drive', s, d, speed, braking: 0, halfLength: 2.2, halfWidth: 0.9, lane, targetLane: lane });
    const vehicles = [car(1000 + 2.3 + 105 + 2.2, -1.85, 26, 1), car(1000, 1.85, 62, 2), car(1000, 5.55, 62, 3)];
    const ctx = { player, road: { curvatureAt: () => 0 }, traffic: { vehicles } } as unknown as GameContext;
    const ap = new Autopilot(ctx);
    ap.reset();
    ap.hazard = { s: 1000 + 2.3 + 129 + 15, d: -3.7, halfS: 15, halfD: 3.9, speed: 0 };
    const c = ap.update(1 / 120);
    expect(ap.targetLane).toBe(1);
    expect(c.brake).toBe(1);
  });
});

describe('test driver: crossing a lane on the way to the open one', () => {
  // 190 km/h in lane 2 behind slow trucks in lanes 2 and 3, lane 0 empty, one car doing 97 km/h in lane 1.
  const make = (gap: number) => {
    const player = { s: 1000, d: 1.85, speed: 53, relHeading: 0, yawRate: 0, nitro01: 0, dims: { length: 4.6, width: 1.9 } };
    const car = (s: number, d: number, speed: number, lane: number) => ({ mode: 'drive', s, d, speed, braking: 0, halfLength: 2.2, halfWidth: 0.9, lane, targetLane: lane });
    const vehicles = [car(1000 + 2.3 + gap + 2.2, -1.85, 27, 1), car(1150, 1.85, 23, 2), car(1150, 5.55, 23, 3)];
    const ctx = { player, road: { curvatureAt: () => 0 }, traffic: { vehicles } } as unknown as GameContext;
    const ap = new Autopilot(ctx);
    ap.reset();
    return ap;
  };

  it('does not step into a lane it could only stop in with an emergency brake', () => {
    const ap = make(45);
    for (let i = 0; i < 120; i++) ap.update(1 / 120);
    expect(ap.targetLane).toBe(2);
  });

  it('does not step on to the open lane before it can get across the lane in between', () => {
    const ap = make(55); // room to sit behind that car (54.6 m), not to cross in front of it (55.7 m)
    for (let i = 0; i < 120; i++) ap.update(1 / 120);
    expect(ap.targetLane).toBe(1);
  });

  it('brakes for the lane in between while it moves across', () => {
    const ap = make(30);
    ap.targetLane = 0;
    const c = ap.update(1 / 120);
    expect(ap.targetLane).toBe(0);
    expect(c.brake).toBe(1);
    expect(c.throttle).toBe(0);
  });
});

describe('test driver: wrecks in road space', () => {
  type Clip = { clip(s: number, d: number, ax: number, ay: number, hl: number, hw: number, lo: number, hi: number): boolean; clipMin: number; clipMax: number };
  const ap = new Autopilot({} as GameContext) as unknown as Clip;

  it('a wreck lying along the road blocks its own lane over its whole length and no other', () => {
    expect(ap.clip(100, 1.85, 1, 0, 9, 1.8, 0.45, 3.25)).toBe(true);
    expect(ap.clipMin).toBeCloseTo(91);
    expect(ap.clipMax).toBeCloseTo(109);
    expect(ap.clip(100, 1.85, 1, 0, 9, 1.8, -6.95, -4.15)).toBe(false);
    expect(ap.clip(100, 1.85, 1, 0, 9, 1.8, 4.15, 6.95)).toBe(false);
  });

  it('a diagonal wreck blocks a lane only where it really reaches into it', () => {
    const c = Math.SQRT1_2;
    // 45°: reaches from d = 1.7 − 7.71 to 1.7 + 7.71; its bounding box would span s 92.3 … 107.7 in every lane.
    expect(ap.clip(100, 1.7, c, c, 9.1, 1.8, -6.95, -4.15)).toBe(true); // the tail corner pokes into lane 0…
    expect(ap.clipMin).toBeGreaterThan(92.2);
    expect(ap.clipMax).toBeLessThan(98.6); // …behind the middle of the wreck only
    expect(ap.clip(100, 1.7, c, c, 9.1, 1.8, -8.6, -6.1)).toBe(false); // …and not as far as the barrier side
    expect(ap.clip(100, 1.7, c, c, 9.1, 1.8, 0.45, 3.25)).toBe(true);
    expect(ap.clipMin).toBeGreaterThan(95.5);
    expect(ap.clipMax).toBeLessThan(104.5);
  });
});
