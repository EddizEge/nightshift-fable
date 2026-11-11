/**
 * Spray emitters: player tyres, traffic (cars / trucks, optional oncoming), big splash bursts.
 * All emission goes through one reused EmitParams scratch object (no allocations).
 */
import type { Vector3 } from 'three';
import type { GameContext, PlayerState, TrafficVehicleDef } from '../core/types';
import { smoothstep } from '../core/math';
import type { EmitParams, SprayPool } from './spray';
import { MAX_TAILS } from './spray';

const E: EmitParams = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size0: 0.3, size1: 1, life: 1,
  kind: 0, alpha: 0.1, drag: 2, lift: 0, grav: 0, wakeX: 0, wakeZ: 0,
};

let rs = 0x2545f491;
/** Fast inline LCG-ish random [0,1). */
function rnd(): number {
  rs ^= rs << 13;
  rs ^= rs >>> 17;
  rs ^= rs << 5;
  return (rs >>> 0) / 4294967296;
}
const sym = () => rnd() * 2 - 1;

/** Stochastic count for a rate over dt (no per-emitter state needed). */
function countFor(rate: number, dt: number): number {
  const n = rate * dt;
  const f = Math.floor(n);
  return f + (rnd() < n - f ? 1 : 0);
}

export interface SprayContext {
  pool: SprayPool;
  /** Rain coverage at road arc length s (0 in tunnels: dry road, no spray). */
  wetAt(s: number): number;
  camX: number;
  camZ: number;
  /** Overall rain intensity 0..1 (road wetness). */
  intensity: number;
  /** Pool pressure 0..1 multiplier applied to steady emitters. */
  budget: number;
  scale: number;
  windX: number;
  windZ: number;
}

let tailCount = 0;
function pushTail(sc: SprayContext, x: number, y: number, z: number, dx: number, dz: number, intensity: number): void {
  if (tailCount >= MAX_TAILS) return;
  sc.pool.tailPos[tailCount].set(x, y, z, intensity);
  sc.pool.tailDir[tailCount].set(dx, 0, dz, 0);
  tailCount++;
}
export function beginTails(): void {
  tailCount = 0;
}
export function endTails(sc: SprayContext): void {
  for (let i = tailCount; i < MAX_TAILS; i++) sc.pool.tailPos[i].set(0, -1000, 0, 0);
}

// ─────────────────────────────────────────────────────────────── player

export function emitPlayer(sc: SprayContext, p: PlayerState, dt: number): void {
  if (!p.alive && !p.wrecked) return;
  const v = Math.hypot(p.velocity.x, p.velocity.z);
  const h = p.heading;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  // tail lamps light the spray red right behind the car
  const tailI = 0.25 + 0.75 * p.brake;
  const tb = p.dims.length * 0.5 - 0.1;
  pushTail(sc, p.position.x - fx * tb + rx * 0.7, 0.85, p.position.z - fz * tb + rz * 0.7, -fx, -fz, tailI);
  pushTail(sc, p.position.x - fx * tb - rx * 0.7, 0.85, p.position.z - fz * tb - rz * 0.7, -fx, -fz, tailI);

  const wet = sc.wetAt(p.s) * sc.intensity;
  const f = smoothstep(10, 32, v) * wet;
  if (f <= 0.001) return;
  const sp = Math.min(1, v / 65);
  const k = sc.scale * sc.budget;
  const vx = p.velocity.x;
  const vz = p.velocity.z;

  for (let w = 2; w < 4; w++) {
    const c = p.wheelContacts[w];
    const side = w === 2 ? -1 : 1;
    const skid = p.wheelSkid[w];
    // mist rooster tail
    // ≈ constant particles per metre travelled (so the plume density holds at any speed)
    let n = countFor((70 + 3.8 * v) * f * (1 + 1.5 * skid) * k, dt);
    for (let i = 0; i < n; i++) {
      const back = 0.35 + rnd() * 0.3;
      E.x = c.x - fx * back + rx * side * 0.06 + sym() * 0.12;
      E.z = c.z - fz * back + rz * side * 0.06 + sym() * 0.12;
      E.y = 0.18 + rnd() * 0.2;
      // the car's wake drags the plume along: more inheritance at speed
      const inh = 0.25 + 0.25 * sp + rnd() * 0.3;
      const up = (1.3 + rnd() * 2.0) * (0.55 + 0.45 * f) * (0.8 + 0.4 * sp);
      const out = 0.3 + rnd() * 1.4;
      E.vx = vx * inh + rx * side * out + sym() * 0.7;
      E.vz = vz * inh + rz * side * out + sym() * 0.7;
      E.vy = up;
      E.size0 = 0.18 + rnd() * 0.08;
      E.size1 = 0.75 + rnd() * 0.7 + sp * 0.45;
      E.life = (0.8 + rnd() * 0.8) * (1 - 0.35 * sp);
      E.kind = 0;
      E.alpha = 0.11 * (0.6 + 0.4 * f);
      E.drag = 2.2;
      E.lift = 0.5;
      E.grav = 0;
      E.wakeX = vx * (0.35 + 0.3 * sp);
      E.wakeZ = vz * (0.35 + 0.3 * sp);
      sc.pool.emit(E);
    }
    // droplets
    n = countFor(70 * f * k * (1 + skid), dt);
    for (let i = 0; i < n; i++) {
      E.x = c.x - fx * 0.4 + sym() * 0.1;
      E.z = c.z - fz * 0.4 + sym() * 0.1;
      E.y = 0.25 + rnd() * 0.15;
      const inh = 0.45 + rnd() * 0.3;
      E.vx = vx * inh + rx * side * (0.5 + rnd()) + sym() * 0.8;
      E.vz = vz * inh + rz * side * (0.5 + rnd()) + sym() * 0.8;
      E.vy = 2 + rnd() * 2.5;
      E.size0 = E.size1 = 0.018 + rnd() * 0.02;
      E.life = 0.35 + rnd() * 0.3;
      E.kind = 1;
      E.alpha = 0.55;
      E.drag = 0.8;
      E.lift = 0;
      E.grav = 9.8;
      E.wakeX = vx * 0.3;
      E.wakeZ = vz * 0.3;
      sc.pool.emit(E);
    }
  }
  // front wheels: sideways sheets when steering
  const steer = p.steerAngle;
  const st = smoothstep(0.025, 0.18, Math.abs(steer));
  if (st > 0) {
    const sgn = steer > 0 ? -1 : 1; // the outer front wheel throws water outward of the turn
    for (let w = 0; w < 2; w++) {
      const c = p.wheelContacts[w];
      const n = countFor(110 * f * st * k, dt);
      for (let i = 0; i < n; i++) {
        E.x = c.x + sym() * 0.15;
        E.z = c.z + sym() * 0.15;
        E.y = 0.15 + rnd() * 0.15;
        const inh = 0.4 + rnd() * 0.3;
        const out = 2 + rnd() * 3.5;
        E.vx = vx * inh + rx * sgn * out;
        E.vz = vz * inh + rz * sgn * out;
        E.vy = 1 + rnd() * 1.8;
        E.size0 = 0.18;
        E.size1 = 0.9 + rnd() * 0.6;
        E.life = 0.5 + rnd() * 0.5;
        E.kind = 0;
        E.alpha = 0.12;
        E.drag = 2.6;
        E.lift = 0.2;
        E.grav = 0;
        E.wakeX = vx * 0.3;
        E.wakeZ = vz * 0.3;
        sc.pool.emit(E);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────── traffic

export function emitVehicle(
  sc: SprayContext,
  pos: Vector3,
  heading: number,
  speed: number,
  def: TrafficVehicleDef,
  s: number,
  braking: number,
  dt: number,
): void {
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  const dx = pos.x - sc.camX;
  const dz = pos.z - sc.camZ;
  const dist = Math.hypot(dx, dz);
  if (dist > 160) return;
  const hl = def.length * 0.5;
  // tail lamps (only the closest few vehicles get a slot)
  if (dist < 70) {
    const ti = 0.22 + 0.7 * braking;
    pushTail(sc, pos.x - fx * hl + rx * def.tailX, def.tailY, pos.z - fz * hl + rz * def.tailX, -fx, -fz, ti);
    pushTail(sc, pos.x - fx * hl - rx * def.tailX, def.tailY, pos.z - fz * hl - rz * def.tailX, -fx, -fz, ti);
  }
  const v = Math.abs(speed);
  const f = smoothstep(9, 30, v) * sc.wetAt(s) * sc.intensity;
  if (f <= 0.002) return;
  const truck = def.height > 2.4;
  // distance LOD: fewer, bigger particles far away
  const lod = dist < 55 ? 1 : dist < 100 ? 0.5 : 0.25;
  const grow = lod === 1 ? 1 : lod === 0.5 ? 1.3 : 1.6;
  const k = sc.scale * sc.budget * lod;
  const vx = fx * speed;
  const vz = fz * speed;
  const halfW = def.width * 0.5 - 0.25;
  const sp = Math.min(1, v / 35);

  for (let side = -1; side <= 1; side += 2) {
    const n = countFor((truck ? 120 : 60) * f * (0.5 + 0.5 * sp) * k, dt);
    for (let i = 0; i < n; i++) {
      // trucks: spray off every axle along the rear half + the tail; cars: rear wheels
      const along = truck ? (rnd() < 0.35 ? -hl * (0.1 + rnd() * 0.8) : -hl - rnd() * 0.5) : -hl * 0.55 - rnd() * 0.6;
      E.x = pos.x + fx * along + rx * side * halfW + sym() * 0.2;
      E.z = pos.z + fz * along + rz * side * halfW + sym() * 0.2;
      E.y = truck ? 0.3 + rnd() * 0.9 : 0.2 + rnd() * 0.25;
      const inh = (truck ? 0.4 : 0.25) + rnd() * 0.3;
      const out = 0.2 + rnd() * (truck ? 1.6 : 1.1);
      E.vx = vx * inh + rx * side * out + sym() * 0.8;
      E.vz = vz * inh + rz * side * out + sym() * 0.8;
      E.vy = truck ? 0.9 + rnd() * 1.6 : 1.0 + rnd() * 1.6;
      E.size0 = (truck ? 0.6 : 0.28) * grow;
      E.size1 = (truck ? 2.8 + rnd() * 1.8 : 1.2 + rnd() * 0.8) * grow;
      E.life = truck ? 1.9 + rnd() * 1.3 : 1.0 + rnd() * 0.7;
      E.kind = 0;
      E.alpha = (truck ? 0.1 : 0.12) * (0.6 + 0.4 * f) * (lod === 1 ? 1 : 1.15);
      E.drag = truck ? 1.5 : 2.1;
      E.lift = truck ? 0.35 : 0.35;
      E.grav = 0;
      E.wakeX = vx * (truck ? 0.5 : 0.35);
      E.wakeZ = vz * (truck ? 0.5 : 0.35);
      sc.pool.emit(E);
    }
  }
  if (truck) {
    // the wall: turbulent wake filling the space behind the box
    const n = countFor(70 * f * sp * k, dt);
    for (let i = 0; i < n; i++) {
      const lat = sym() * halfW;
      E.x = pos.x - fx * (hl + 0.5 + rnd() * 1.5) + rx * lat;
      E.z = pos.z - fz * (hl + 0.5 + rnd() * 1.5) + rz * lat;
      E.y = 0.8 + rnd() * Math.max(0.5, def.height - 1.4);
      E.vx = vx * (0.55 + rnd() * 0.25) + sym() * 0.8;
      E.vz = vz * (0.55 + rnd() * 0.25) + sym() * 0.8;
      E.vy = sym() * 0.4;
      E.size0 = 1.4 * grow;
      E.size1 = (3.5 + rnd() * 2) * grow;
      E.life = 2.2 + rnd() * 1.2;
      E.kind = 0;
      E.alpha = 0.06 * (0.6 + 0.4 * f);
      E.drag = 1.1;
      E.lift = 0.1;
      E.grav = 0;
      E.wakeX = vx * 0.55;
      E.wakeZ = vz * 0.55;
      sc.pool.emit(E);
    }
  }
}

// ─────────────────────────────────────────────────────────────── burst

export function emitBurst(sc: SprayContext, pos: Vector3, scale: number, ctxVel?: Vector3): void {
  const s = Math.max(0.2, scale);
  const bvx = ctxVel ? ctxVel.x * 0.3 : 0;
  const bvz = ctxVel ? ctxVel.z * 0.3 : 0;
  // sheet droplets: a crown thrown outward and up
  const nd = Math.round(90 * s * Math.min(1.5, sc.scale + 0.3));
  for (let i = 0; i < nd; i++) {
    const a = rnd() * Math.PI * 2;
    const sp = (3 + rnd() * 5) * Math.sqrt(s);
    E.x = pos.x + Math.cos(a) * 0.3 * s;
    E.z = pos.z + Math.sin(a) * 0.3 * s;
    E.y = Math.max(0.05, pos.y) + rnd() * 0.2;
    E.vx = Math.cos(a) * sp + bvx;
    E.vz = Math.sin(a) * sp + bvz;
    E.vy = (2.5 + rnd() * 4.5) * Math.sqrt(s);
    E.size0 = E.size1 = 0.025 + rnd() * 0.035;
    E.life = 0.6 + rnd() * 0.7;
    E.kind = 1;
    E.alpha = 0.7;
    E.drag = 0.5;
    E.lift = 0;
    E.grav = 9.8;
    E.wakeX = 0;
    E.wakeZ = 0;
    sc.pool.emit(E);
  }
  // sheet / mist
  const nm = Math.round(36 * s * Math.min(1.5, sc.scale + 0.3));
  for (let i = 0; i < nm; i++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd();
    const sp = (1 + r * 4) * Math.sqrt(s);
    E.x = pos.x + Math.cos(a) * 0.5 * s * r;
    E.z = pos.z + Math.sin(a) * 0.5 * s * r;
    E.y = Math.max(0.1, pos.y) + rnd() * 0.4 * s;
    E.vx = Math.cos(a) * sp + bvx;
    E.vz = Math.sin(a) * sp + bvz;
    E.vy = (1 + rnd() * 3) * Math.sqrt(s);
    E.size0 = 0.4 * s;
    E.size1 = (2 + rnd() * 2) * s;
    E.life = 1.2 + rnd() * 1.4;
    E.kind = 0;
    E.alpha = 0.16;
    E.drag = 1.8;
    E.lift = 0.3;
    E.grav = 0;
    E.wakeX = sc.windX;
    E.wakeZ = sc.windZ;
    sc.pool.emit(E);
  }
}

/** Shared reference used by the weather to iterate optional oncoming traffic. */
export type OncomingLike = { position: Vector3; heading: number; def: TrafficVehicleDef; speed?: number; s?: number };

export function emitTraffic(sc: SprayContext, ctx: GameContext, dt: number): void {
  const tr = ctx.traffic;
  if (!tr) return;
  const list = tr.vehicles;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.mode === 'wreck') continue;
    emitVehicle(sc, v.position, v.heading, v.speed, v.def, v.s, v.braking, dt);
  }
  const onc = (tr as unknown as { oncoming?: readonly OncomingLike[] }).oncoming;
  if (onc) {
    for (let i = 0; i < onc.length; i++) {
      const o = onc[i];
      const sp = o.speed ?? 26;
      const s = o.s ?? ctx.player.s;
      emitVehicle(sc, o.position, o.heading, sp, o.def, s, 0, dt);
    }
  }
}
