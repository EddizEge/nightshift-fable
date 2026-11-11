/**
 * VehicleSim acceptance tests (run: npx vitest run tests/vehicleSim.test.ts).
 * Every scenario runs at the game's normal fixed step (1/120 s) and at a degraded 1/60 s.
 */
import { describe, expect, it } from 'vitest';
import type { DriveControls, PlayerState } from '../src/core/types';
import { VehicleSim, type SimEnv } from '../src/vehicle/vehicleSim';

const KMH = 1 / 3.6;
const DEG = Math.PI / 180;
const ENV: SimEnv = { grip: 1 };

type Ctl = Partial<DriveControls>;

function controls(c: Ctl): DriveControls {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, ...c };
}

/** Body slip angle (rad, + = sliding right). */
function slip(sim: VehicleSim): number {
  const v = Math.hypot(sim.speed, sim.lateralSpeed);
  return v > 1 ? Math.atan2(sim.lateralSpeed, Math.abs(sim.speed)) : 0;
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Runs the sim for `seconds`, calling `ctl(t)` for inputs and `each(t)` after every step. */
function run(sim: VehicleSim, dt: number, seconds: number, ctl: (t: number) => Ctl, each?: (t: number) => void | boolean): number {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    sim.step(dt, controls(ctl(t)), ENV);
    if (each && each(t + dt) === true) return t + dt;
  }
  return seconds;
}

/** Plain-object PlayerState stand-in (Vector3 / Quaternion only need `.set`). */
function vec() {
  return {
    x: 0, y: 0, z: 0, w: 1,
    set(x: number, y: number, z: number, w?: number) {
      this.x = x; this.y = y; this.z = z;
      if (w !== undefined) this.w = w;
      return this;
    },
  };
}

function fakeState(): PlayerState {
  return {
    position: vec(), quaternion: vec(), velocity: vec(),
    heading: 0, yawRate: 0, speed: 0, speedKmh: 0, lateralSpeed: 0, s: 123, d: 4, relHeading: 0.5,
    throttle: 0, brake: 0, steerAngle: 0, handbrake: false, rpm: 0, rpm01: 0, gear: 0, nitro01: 0, nitroActive: false,
    accelLong: 0, accelLat: 0, wheelSkid: [0, 0, 0, 0], wheelSpin: [0, 0, 0, 0], suspension: [0, 0, 0, 0],
    bodyPitch: 0, bodyRoll: 0, wheelContacts: [vec(), vec(), vec(), vec()], damage: 0.3, alive: true, wrecked: false,
    dims: null,
  } as unknown as PlayerState;
}

describe.each([
  ['1/120', 1 / 120],
  ['1/60', 1 / 60],
])('VehicleSim @ dt=%s', (_label, dt) => {
  it('launch: 0-100 km/h in 3.2-4.2 s, 0-200 km/h in 9-13 s, rear wheelspin at launch', () => {
    const sim = new VehicleSim();
    let t100 = NaN;
    let t200 = NaN;
    let maxRearSkid = 0;
    run(sim, dt, 20, () => ({ throttle: 1 }), (t) => {
      if (t < 1) maxRearSkid = Math.max(maxRearSkid, sim.wheelSkid[2], sim.wheelSkid[3]);
      if (Number.isNaN(t100) && sim.speed >= 100 * KMH) t100 = t;
      if (Number.isNaN(t200) && sim.speed >= 200 * KMH) t200 = t;
      return !Number.isNaN(t200);
    });
    expect(t100).toBeGreaterThanOrEqual(3.2);
    expect(t100).toBeLessThanOrEqual(4.2);
    expect(t200).toBeGreaterThanOrEqual(9);
    expect(t200).toBeLessThanOrEqual(13);
    expect(maxRearSkid).toBeGreaterThan(0.3);
    expect(Math.abs(sim.heading)).toBeLessThan(0.001);
  });

  it('top speed 285-300 km/h without nitro', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 250 * KMH);
    let vMax = 0;
    run(sim, dt, 120, () => ({ throttle: 1 }), () => {
      vMax = Math.max(vMax, sim.speed);
    });
    const kmh = vMax / KMH;
    expect(kmh).toBeGreaterThanOrEqual(285);
    expect(kmh).toBeLessThanOrEqual(300);
    expect(sim.gear).toBeGreaterThanOrEqual(6);
  });

  it('nitro: a full tank from 250 km/h passes 310 km/h; sustained-nitro asymptote 330-345 km/h', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 250 * KMH);
    let vMax = 0;
    let activeTime = 0;
    run(sim, dt, 8, () => ({ throttle: 1, nitro: true }), () => {
      vMax = Math.max(vMax, sim.speed);
      if (sim.nitroActive) activeTime += dt;
    });
    expect(vMax / KMH).toBeGreaterThan(310);
    expect(activeTime).toBeGreaterThan(3.6);
    expect(activeTime).toBeLessThan(4.4);

    const sim2 = new VehicleSim();
    sim2.reset(0, 0, 0, 280 * KMH);
    let v2 = 0;
    run(sim2, dt, 90, () => ({ throttle: 1, nitro: true }), () => {
      sim2.addNitro(1);
      v2 = Math.max(v2, sim2.speed);
    });
    expect(v2 / KMH).toBeGreaterThanOrEqual(330);
    expect(v2 / KMH).toBeLessThanOrEqual(345);
  });

  it('nitro refills slowly (empty → full in ≈ 25 s)', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 150 * KMH);
    sim.nitro01 = 0;
    run(sim, dt, 12.5, () => ({ throttle: 0.5 }));
    expect(sim.nitro01).toBeGreaterThan(0.4);
    expect(sim.nitro01).toBeLessThan(0.55);
  });

  it('braking 200→0 km/h in 4-6 s, straight', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 200 * KMH);
    const tStop = run(sim, dt, 10, () => ({ brake: 1 }), () => sim.speed <= 0.01);
    expect(tStop).toBeGreaterThanOrEqual(4);
    expect(tStop).toBeLessThanOrEqual(6);
    expect(Math.abs(sim.heading)).toBeLessThan(1 * DEG);
    expect(sim.speed).toBeGreaterThanOrEqual(0);
  });

  it('lane change at 250 km/h: full steer 0.4 s then release', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 250 * KMH);
    let maxSlip = 0;
    let latAt2 = 0;
    let headAt = NaN;
    let yawAt = NaN;
    run(sim, dt, 2.4, (t) => ({ throttle: 0.6, steer: t < 0.4 ? 1 : 0 }), (t) => {
      maxSlip = Math.max(maxSlip, Math.abs(slip(sim)));
      if (Math.abs(t - 2) < dt * 0.5) latAt2 = sim.x; // heading 0 → lateral = +x
      if (Math.abs(t - 2.2) < dt * 0.5) {
        headAt = sim.heading;
        yawAt = sim.yawRate;
      }
    });
    expect(latAt2).toBeGreaterThanOrEqual(2.5);
    expect(latAt2).toBeLessThanOrEqual(6);
    expect(Math.abs(headAt)).toBeLessThan(1.5 * DEG);
    expect(Math.abs(yawAt)).toBeLessThan(0.02);
    expect(maxSlip).toBeLessThan(8 * DEG);
  });

  it('full steer at 250 km/h for 3 s: ~1 g, no spin', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 250 * KMH);
    let maxSlip = 0;
    let latLate = 0;
    run(sim, dt, 3, () => ({ throttle: 0.5, steer: 1 }), (t) => {
      maxSlip = Math.max(maxSlip, Math.abs(slip(sim)));
      if (t > 2.5) latLate = Math.max(latLate, Math.abs(sim.accelLat));
    });
    expect(Math.abs(sim.accelLat)).toBeGreaterThanOrEqual(0.85);
    expect(latLate).toBeLessThanOrEqual(1.1);
    expect(maxSlip).toBeLessThan(10 * DEG);
  });

  it('full steer at 120 km/h: steady circle', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 120 * KMH);
    let maxSlip = 0;
    let rMin = Infinity;
    let rMaxV = -Infinity;
    run(sim, dt, 6, () => ({ throttle: 0.35, steer: -1 }), (t) => {
      maxSlip = Math.max(maxSlip, Math.abs(slip(sim)));
      if (t > 4) {
        rMin = Math.min(rMin, sim.yawRate);
        rMaxV = Math.max(rMaxV, sim.yawRate);
      }
    });
    expect(maxSlip).toBeLessThan(12 * DEG);
    expect(rMaxV).toBeLessThan(0); // still turning left
    expect(rMaxV - rMin).toBeLessThan(0.05); // steady
    expect(Math.abs(sim.accelLat)).toBeGreaterThan(0.75);
  });

  it('handbrake + full steer 0.8 s at 140 km/h: controllable slide that recovers', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 140 * KMH);
    let maxSlip = 0;
    let maxRot = 0;
    let recoveredAt = NaN;
    run(sim, dt, 4, (t) => (t < 0.8 ? { steer: 1, handbrake: true } : {}), (t) => {
      const b = Math.abs(slip(sim));
      maxSlip = Math.max(maxSlip, b);
      maxRot = Math.max(maxRot, Math.abs(sim.heading));
      if (t > 0.8 && Number.isNaN(recoveredAt) && b < 5 * DEG && maxSlip > 10 * DEG) recoveredAt = t;
    });
    expect(maxSlip).toBeGreaterThanOrEqual(10 * DEG);
    expect(maxSlip).toBeLessThanOrEqual(45 * DEG);
    expect(recoveredAt - 0.8).toBeLessThanOrEqual(2);
    expect(maxRot).toBeLessThan(100 * DEG);
    expect(Math.abs(slip(sim))).toBeLessThan(5 * DEG);
  });

  it('0.3 s handbrake tap at 220 km/h while steering never spins', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 220 * KMH);
    let maxSlip = 0;
    run(sim, dt, 4, (t) => ({ throttle: 0.4, steer: t < 1 ? 1 : 0, handbrake: t > 0.2 && t < 0.5 }), () => {
      maxSlip = Math.max(maxSlip, Math.abs(slip(sim)));
    });
    expect(maxSlip).toBeLessThan(30 * DEG);
    expect(Math.abs(slip(sim))).toBeLessThan(3 * DEG);
    expect(Math.abs(sim.yawRate)).toBeLessThan(0.05);
  });

  it('standstill without input does not creep', () => {
    const sim = new VehicleSim();
    sim.reset(10, -5, 0.7, 0);
    run(sim, dt, 5, () => ({}));
    expect(Math.hypot(sim.x - 10, sim.z + 5)).toBeLessThan(0.001);
    expect(sim.speed).toBe(0);
    // Coming to rest from a roll also ends at exactly 0.
    sim.reset(0, 0, 0, 3);
    run(sim, dt, 8, () => ({}));
    expect(sim.speed).toBe(0);
    const x0 = sim.x;
    const z0 = sim.z;
    run(sim, dt, 5, () => ({}));
    expect(Math.hypot(sim.x - x0, sim.z - z0)).toBeLessThan(0.001);
  });

  it('reverse when brake held at standstill, capped', () => {
    const sim = new VehicleSim();
    sim.reset(0, 0, 0, 0);
    let minSpeed = 0;
    run(sim, dt, 8, () => ({ brake: 1 }), () => {
      minSpeed = Math.min(minSpeed, sim.speed);
    });
    expect(sim.gear).toBe(-1);
    expect(sim.speed).toBeLessThan(-5);
    expect(-minSpeed).toBeLessThanOrEqual(sim.params.reverseMaxSpeed + 0.3);
    expect(-minSpeed * 3.6).toBeLessThanOrEqual(40);
    expect(sim.z).toBeGreaterThan(10); // backwards = +Z at heading 0
    // Throttle in reverse brakes and then drives forward again.
    run(sim, dt, 6, () => ({ throttle: 1 }));
    expect(sim.gear).toBeGreaterThanOrEqual(1);
    expect(sim.speed).toBeGreaterThan(5);
  });

  it('energy sanity under random abuse: finite, capped, never > 100 m/s', () => {
    const sim = new VehicleSim();
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let c: Ctl = {};
    let maxV = 0;
    run(sim, dt, 90, (t) => {
      if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) {
        c = { throttle: rnd() > 0.3 ? 1 : 0, brake: rnd() > 0.85 ? 1 : 0, steer: rnd() * 2 - 1, handbrake: rnd() > 0.9, nitro: rnd() > 0.6 };
        if (rnd() > 0.97) sim.applyImpulse((rnd() - 0.5) * 20, (rnd() - 0.5) * 20, (rnd() - 0.5) * 2);
      }
      return c;
    }, () => {
      const v = Math.hypot(sim.vx, sim.vz);
      maxV = Math.max(maxV, v);
      for (const k of [sim.x, sim.z, sim.heading, sim.vx, sim.vz, sim.yawRate, sim.rpm, sim.accelLat, sim.bodyPitch, sim.bodyRoll]) {
        if (!Number.isFinite(k)) throw new Error('non-finite state');
      }
    });
    expect(maxV).toBeLessThanOrEqual(100);
  });
});

describe('VehicleSim misc', () => {
  it('writeState fills the player state and leaves game-owned fields alone', () => {
    const sim = new VehicleSim();
    sim.reset(3, -7, 0.4, 30);
    sim.step(1 / 120, controls({ throttle: 1, steer: 0.5 }), ENV);
    const st = fakeState();
    sim.writeState(st);
    expect(st.position.x).toBeCloseTo(sim.x);
    expect(st.position.y).toBe(0);
    expect(st.speedKmh).toBeCloseTo(sim.speed * 3.6);
    expect(st.gear).toBe(sim.gear);
    expect(st.dims.wheelBase).toBeCloseTo(2.7);
    // Yaw-only quaternion for rotation.y = -heading.
    const q = st.quaternion as unknown as { y: number; w: number };
    expect(-2 * Math.atan2(q.y, q.w)).toBeCloseTo(sim.heading, 6);
    // Front-left contact is ahead and to the left.
    const fl = st.wheelContacts[0];
    const fx = Math.sin(sim.heading), fz = -Math.cos(sim.heading);
    const rx = Math.cos(sim.heading), rz = Math.sin(sim.heading);
    expect((fl.x - sim.x) * fx + (fl.z - sim.z) * fz).toBeGreaterThan(1);
    expect((fl.x - sim.x) * rx + (fl.z - sim.z) * rz).toBeLessThan(-0.5);
    expect(st.s).toBe(123);
    expect(st.d).toBe(4);
    expect(st.relHeading).toBe(0.5);
    expect(st.damage).toBe(0.3);
    expect(st.alive).toBe(true);
    expect(st.wrecked).toBe(false);
  });

  it('dt=1/60 and dt=1/120 give near-identical launches', () => {
    const a = new VehicleSim();
    const b = new VehicleSim();
    run(a, 1 / 120, 6, () => ({ throttle: 1 }));
    run(b, 1 / 60, 6, () => ({ throttle: 1 }));
    expect(Math.abs(a.speed - b.speed)).toBeLessThan(0.3);
  });

  it('standing water (grip < 1) reduces cornering grip', () => {
    const wet = new VehicleSim();
    wet.reset(0, 0, 0, 150 * KMH);
    for (let i = 0; i < 240; i++) wet.step(1 / 120, controls({ throttle: 0.4, steer: 1 }), { grip: 0.6 });
    const dry = new VehicleSim();
    dry.reset(0, 0, 0, 150 * KMH);
    run(dry, 1 / 120, 2, () => ({ throttle: 0.4, steer: 1 }));
    expect(Math.abs(wet.accelLat)).toBeLessThan(Math.abs(dry.accelLat) * 0.85);
    expect(Math.abs(slip(wet))).toBeLessThan(15 * DEG);
  });

  it('telemetry table (tuning aid)', () => {
    const sim = new VehicleSim();
    const rows: string[] = ['  t(s)  km/h  gear   rpm  aLong(g) rearSkid nitro'];
    let next = 0;
    run(sim, 1 / 120, 40, (t) => ({ throttle: 1, nitro: t > 25 }), (t) => {
      if (t >= next - 1e-9) {
        next += t < 6 ? 0.5 : 2;
        rows.push(
          `${t.toFixed(1).padStart(6)} ${(sim.speed * 3.6).toFixed(1).padStart(5)} ${String(sim.gear).padStart(5)} ${sim.rpm.toFixed(0).padStart(5)} ${sim.accelLong.toFixed(2).padStart(9)} ${sim.wheelSkid[2].toFixed(2).padStart(8)} ${sim.nitro01.toFixed(2).padStart(5)}`,
        );
      }
    });
    console.log('[vehicleSim telemetry]\n' + rows.join('\n'));
    expect(rows.length).toBeGreaterThan(10);
  });
});

/**
 * Tuning probe (skipped unless NS_PROBE is set): prints a scenario trace.
 *   NS_PROBE=hb NS_PARAMS='{"handbrakeSteerBoost":2}' npx vitest run tests/vehicleSim.test.ts -t probe
 */
describe.runIf(!!process.env.NS_PROBE)('probe', () => {
  it('probe', () => {
    const which = process.env.NS_PROBE;
    const sim = new VehicleSim(JSON.parse(process.env.NS_PARAMS || '{}'));
    const scen: Record<string, [number, number, (t: number) => Ctl]> = {
      hb: [140, 4, (t) => (t < 0.8 ? { steer: 1, handbrake: true } : {})],
      tap: [220, 4, (t) => ({ throttle: 0.4, steer: t < 1 ? 1 : 0, handbrake: t > 0.2 && t < 0.5 })],
      lane: [250, 2.4, (t) => ({ throttle: 0.6, steer: t < 0.4 ? 1 : 0 })],
      nitro: [250, 8, () => ({ throttle: 1, nitro: true })],
    };
    const [v0, T, f] = scen[which!];
    sim.reset(0, 0, 0, v0 * KMH);
    const rows: string[] = [];
    let next = 0;
    run(sim, 1 / 120, T, f, (t) => {
      if (t >= next - 1e-9) {
        next += 0.1;
        rows.push(`${t.toFixed(2)} kmh=${(sim.speed * 3.6).toFixed(0)} slip=${(slip(sim) / DEG).toFixed(1)} head=${(sim.heading / DEG).toFixed(1)} r=${sim.yawRate.toFixed(3)} x=${sim.x.toFixed(2)} steer=${(sim.steerAngle / DEG).toFixed(2)} aLat=${sim.accelLat.toFixed(2)}`);
      }
    });
    console.log(rows.join('\n'));
  });
});
