import { Object3D, Quaternion, Vector3 } from 'three';
import type { DriveControls, GameContext, PlayerState, TrafficVehicle, WreckBody } from '../core/types';
import { clamp, wrapAngle } from '../core/math';
import { VehicleSim } from '../vehicle/vehicleSim';
import { BARRIER_LEFT_D, BARRIER_RIGHT_D } from '../world/roadProfile';
import { makeObb, obbOverlap, setObb } from './collide';
import type { Contact } from './collide';

/** Closing speed (m/s along the contact normal) above which a hit wrecks the car outright. */
const FATAL_VEHICLE = 11.5;
const FATAL_WRECK = 9.5;
const FATAL_BARRIER = 15;
/** Contacts slower than this (m/s along the normal) are resting contacts. */
const REST_SPEED = 1.2;

const _pos = new Vector3();
const _nrm = new Vector3();
const _vel = new Vector3();
const _ang = new Vector3();
const _half = new Vector3();
const _q = new Quaternion();
const _fwd = new Vector3();
const _ax = new Vector3();
const _ay = new Vector3();
const _foot = { heading: 0, hw: 0, hl: 0 };

/**
 * Road footprint of a rotated box: the two most horizontal local axes with their half extents
 * (a wreck on its flank or standing on its nose covers a different patch than an upright one).
 * Heading follows the longer of the two. Writes into and returns `out`.
 */
export function wreckFootprint(q: Quaternion, half: Vector3, out = _foot): { heading: number; hw: number; hl: number } {
  _ax.set(1, 0, 0).applyQuaternion(q);
  _ay.set(0, 1, 0).applyQuaternion(q);
  _fwd.set(0, 0, -1).applyQuaternion(q);
  const ux = Math.abs(_ax.y);
  const uy = Math.abs(_ay.y);
  const uz = Math.abs(_fwd.y);
  let a = _fwd; // first horizontal axis
  let ha = half.z;
  let b = _ax; // second horizontal axis
  let hb = half.x;
  if (uz >= ux && uz >= uy) {
    a = _ay; // on its nose or tail: local Z is up
    ha = half.y;
  } else if (ux > uy) {
    b = _ay; // on its flank: local X is up
    hb = half.y;
  }
  const lon = ha >= hb ? a : b;
  out.heading = Math.atan2(lon.x, -lon.z);
  out.hl = Math.max(ha, hb);
  out.hw = Math.min(ha, hb);
  return out;
}

export interface CrashInfo {
  cause: string;
  /** Speed at the moment of the crash, m/s. */
  speed: number;
  other: TrafficVehicle | WreckBody | null;
  position: Vector3;
}

/**
 * The player's car in the world: runs the driving sim, projects it onto the road, resolves
 * barrier / traffic / wreck contacts, tracks damage, and hands the car to the crash world when
 * it is wrecked.
 */
export class Player {
  readonly sim = new VehicleSim();
  readonly state: PlayerState;
  /** 0..1 metal-on-barrier scraping right now (audio / sparks). */
  scrape = 0;
  /** Set when the car is wrecked. */
  crashInfo: CrashInfo | null = null;
  onCrash: ((info: CrashInfo) => void) | null = null;
  private body: WreckBody | null = null;
  private dummy = new Object3D();
  private obb = makeObb();
  private other = makeObb();
  private contact: Contact = { nx: 0, nz: 0, depth: 0, px: 0, pz: 0 };
  private hitCooldown = 0;
  private sparkTimer = 0;
  private lastNitro = false;
  /** Invulnerability (seconds) — used right after a restart. */
  grace = 0;

  constructor(private ctx: GameContext) {
    this.state = ctx.player;
    this.sim.setDims(this.state.dims);
  }

  reset(s: number, d: number, speed: number): void {
    const st = this.state;
    const f = this.ctx.road.frameAt(s);
    this.sim.setDims(st.dims);
    this.sim.reset(f.x + f.rx * d, f.z + f.rz * d, f.h, speed);
    st.s = s;
    st.d = d;
    st.relHeading = 0;
    st.damage = 0;
    st.alive = true;
    st.wrecked = false;
    this.body = null;
    this.crashInfo = null;
    this.scrape = 0;
    this.hitCooldown = 0;
    this.grace = 1.5;
    this.sim.writeState(st);
  }

  /** Fixed-step update while alive. */
  step(dt: number, controls: DriveControls): void {
    const st = this.state;
    if (!st.alive) return;
    const ctx = this.ctx;
    const sim = this.sim;
    const road = ctx.road;
    const roadH = road.headingAt(st.s);
    sim.step(dt, controls, { grip: 1, roadHeading: roadH });
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    this.grace = Math.max(0, this.grace - dt);
    this.scrape = Math.max(0, this.scrape - dt * 4);

    // Road projection.
    const pr = road.project(sim.x, sim.z, st.s);
    st.s = pr.s;
    st.d = pr.d;
    const f = road.frameAt(pr.s);
    st.relHeading = wrapAngle(sim.heading - f.h);

    this.collideBarriers(dt, f.rx, f.rz, f.tx, f.tz);
    if (st.alive) this.collideVehicles();
    if (st.alive && st.damage >= 1) this.crash('TOTALLED', null, _pos.set(sim.x, 0.5, sim.z), _nrm.set(0, 0, 0), null);

    if (sim.nitroActive !== this.lastNitro) {
      this.lastNitro = sim.nitroActive;
      ctx.events.emit('nitro', { active: sim.nitroActive });
    }
    sim.writeState(st);
  }

  private collideBarriers(dt: number, rx: number, rz: number, tx: number, tz: number): void {
    const st = this.state;
    const sim = this.sim;
    const hw = st.dims.width * 0.5;
    const hl = st.dims.length * 0.5;
    const ext = hw * Math.abs(Math.cos(st.relHeading)) + hl * Math.abs(Math.sin(st.relHeading));
    let side = 0;
    let pen = 0;
    if (st.d + ext > BARRIER_RIGHT_D) {
      side = 1;
      pen = st.d + ext - BARRIER_RIGHT_D;
    } else if (st.d - ext < BARRIER_LEFT_D) {
      side = -1;
      pen = BARRIER_LEFT_D - (st.d - ext);
    }
    if (side === 0) return;
    sim.x -= side * rx * pen;
    sim.z -= side * rz * pen;
    st.d -= side * pen;
    const vlat = sim.vx * rx + sim.vz * rz;
    const vt = sim.vx * tx + sim.vz * tz;
    const vn = vlat * side;
    // Contact point on the barrier next to the car's leading corner.
    _pos.set(sim.x + rx * side * ext + tx * hl * 0.6 * Math.sign(vt || 1), 0.45, sim.z + rz * side * ext + tz * hl * 0.6 * Math.sign(vt || 1));
    _nrm.set(-rx * side, 0, -rz * side);
    if (vn > 0) {
      if (vn > FATAL_BARRIER && this.grace <= 0) {
        this.crash('SLAMMED INTO THE BARRIER', null, _pos, _nrm, null);
        return;
      }
      // Bounce off with little restitution, lose some forward speed, get straightened by the wall.
      const dv = -(1 + 0.18) * vn * side;
      const scrub = Math.min(Math.abs(vt), vn * 0.55) * Math.sign(vt);
      sim.applyImpulse(rx * dv - tx * scrub, rz * dv - tz * scrub, clamp(-st.relHeading * 6, -2.5, 2.5));
      if (vn > 1.6 && this.hitCooldown <= 0) {
        this.hitCooldown = 0.3;
        const intensity = clamp(vn / 12, 0.15, 1);
        if (this.grace <= 0) st.damage = Math.min(1, st.damage + 0.03 + Math.pow(vn / FATAL_BARRIER, 2) * 0.75);
        this.ctx.events.emit('collision', { kind: 'barrier', position: _pos.clone(), normal: _nrm.clone(), relSpeed: vn, intensity, fatal: false, player: true });
      }
    }
    // Sliding along the barrier.
    const slide = Math.abs(vt);
    if (slide > 3) {
      this.scrape = Math.max(this.scrape, clamp(slide / 45, 0.25, 1));
      if (this.grace <= 0) st.damage = Math.min(1, st.damage + dt * 0.035 * clamp(slide / 40, 0.2, 1.5));
      // Friction of the scrape.
      const drag = Math.min(slide, dt * 5.5) * Math.sign(vt);
      sim.applyImpulse(-tx * drag, -tz * drag, clamp(-st.relHeading * 2.5, -1, 1) * dt * 20);
      this.sparkTimer -= dt;
      if (this.sparkTimer <= 0) {
        this.sparkTimer = 0.035;
        _vel.set(-tx * Math.sign(vt), 0.25, -tz * Math.sign(vt)).addScaledVector(_nrm, 0.35).normalize();
        this.ctx.vfx?.sparks(_pos, _vel, 5 + Math.round(slide / 9), slide * 0.45 + 4);
      }
    }
  }

  private collideVehicles(): void {
    const st = this.state;
    const sim = this.sim;
    const ctx = this.ctx;
    const a = setObb(this.obb, sim.x, sim.z, sim.heading, st.dims.width * 0.5 - 0.04, st.dims.length * 0.5 - 0.05);
    const c = this.contact;

    const traffic = ctx.traffic?.vehicles;
    if (traffic) {
      for (let i = 0; i < traffic.length; i++) {
        const v = traffic[i];
        if (v.mode === 'wreck') continue; // handled through the crash world below
        if (Math.abs(v.s - st.s) > v.halfLength + st.dims.length) continue;
        const b = setObb(this.other, v.position.x, v.position.z, v.heading, v.halfWidth, v.halfLength);
        if (!obbOverlap(a, b, c)) continue;
        const ovx = Math.sin(v.heading) * v.speed;
        const ovz = -Math.cos(v.heading) * v.speed;
        const vn = (sim.vx - ovx) * c.nx + (sim.vz - ovz) * c.nz;
        sim.x -= c.nx * c.depth;
        sim.z -= c.nz * c.depth;
        a.x = sim.x;
        a.z = sim.z;
        if (vn <= 0) continue;
        _pos.set(c.px, 0.55, c.pz);
        _nrm.set(-c.nx, 0, -c.nz);
        if (vn > FATAL_VEHICLE && this.grace <= 0) {
          // Normal (player → other) along our forward axis: the other car is ahead (we ran into it) or behind (it ran into us).
          const along = c.nx * a.sin - c.nz * a.cos;
          const what = v.type === 'semi' || v.type === 'tanker' || v.type === 'boxtruck' ? 'A TRUCK' : v.type === 'van' ? 'A VAN' : 'TRAFFIC';
          this.crash(along > 0.7 ? `REAR-ENDED ${what}` : along < -0.7 ? 'HIT FROM BEHIND' : `COLLIDED WITH ${what}`, v, _pos, _nrm, v);
          return;
        }
        // Glancing contact: we bounce off the (much heavier-feeling) kinematic vehicle.
        const share = v.def.mass / (v.def.mass + st.dims.mass);
        const dv = -(1 + 0.2) * vn * Math.max(0.55, share);
        // Torque from the off-centre hit.
        const rx = c.px - sim.x;
        const rz = c.pz - sim.z;
        const yawKick = clamp((rx * -c.nz - rz * -c.nx) * vn * 0.06, -1.6, 1.6);
        sim.applyImpulse(c.nx * dv, c.nz * dv, yawKick);
        // Leaning on something is not a hit: no damage, no sparks below walking pace.
        if (this.hitCooldown <= 0 && vn > REST_SPEED) {
          this.hitCooldown = 0.25;
          if (this.grace <= 0) st.damage = Math.min(1, st.damage + 0.05 + Math.pow(vn / FATAL_VEHICLE, 2) * 0.5);
          ctx.events.emit('collision', { kind: 'traffic', position: _pos.clone(), normal: _nrm.clone(), relSpeed: vn, intensity: clamp(vn / 10, 0.2, 1), fatal: false, player: true });
        }
        // A hard shove wrecks the other car (it spins out); a light touch just makes it brake.
        if (vn > 6.5 && ctx.traffic) {
          _vel.set(ovx + c.nx * vn * 0.5, 0.6, ovz + c.nz * vn * 0.5);
          _ang.set(0, (Math.random() - 0.5) * 3, 0);
          ctx.traffic.wreck(v, _vel, _ang);
        } else {
          v.braking = 1;
          v.speed = Math.max(0, v.speed - vn * 0.3);
        }
      }
    }

    const bodies = ctx.crash?.bodies;
    if (bodies) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b.owner === 'player') continue;
        const bottom = b.position.y - Math.max(b.halfExtents.y, 0.3);
        if (bottom > 1.5) continue; // still in the air above us
        const dx = b.position.x - sim.x;
        const dz = b.position.z - sim.z;
        const reach = Math.max(b.halfExtents.x, b.halfExtents.y, b.halfExtents.z) + st.dims.length;
        if (dx * dx + dz * dz > reach * reach) continue;
        const fp = wreckFootprint(b.quaternion, b.halfExtents);
        const ob = setObb(this.other, b.position.x, b.position.z, fp.heading, fp.hw, fp.hl);
        if (!obbOverlap(a, ob, c)) continue;
        const vn = (sim.vx - b.linvel.x) * c.nx + (sim.vz - b.linvel.z) * c.nz;
        sim.x -= c.nx * c.depth;
        sim.z -= c.nz * c.depth;
        a.x = sim.x;
        a.z = sim.z;
        if (vn <= 0) continue;
        _pos.set(c.px, 0.55, c.pz);
        _nrm.set(-c.nx, 0, -c.nz);
        const heavy = b.mass > 600;
        if (heavy && vn > FATAL_WRECK && this.grace <= 0) {
          this.crash(b.burning ? 'DROVE INTO THE FIRE' : 'HIT A WRECK', b, _pos, _nrm, null);
          return;
        }
        const share = b.mass / (b.mass + st.dims.mass);
        const dv = -(1 + 0.15) * vn * share;
        sim.applyImpulse(c.nx * dv, c.nz * dv, clamp(((c.px - sim.x) * -c.nz - (c.pz - sim.z) * -c.nx) * vn * 0.05, -1.4, 1.4));
        _vel.set(c.nx, 0.15, c.nz).multiplyScalar(vn * st.dims.mass * (1 - share) * 1.1);
        ctx.crash!.applyImpulse(b, _vel, _pos);
        if (this.hitCooldown <= 0 && vn > REST_SPEED) {
          this.hitCooldown = 0.25;
          if (this.grace <= 0) st.damage = Math.min(1, st.damage + (heavy ? 0.06 + Math.pow(vn / FATAL_WRECK, 2) * 0.5 : 0.03));
          ctx.events.emit('collision', { kind: heavy ? 'wreck' : 'debris', position: _pos.clone(), normal: _nrm.clone(), relSpeed: vn, intensity: clamp(vn / 10, 0.2, 1), fatal: false, player: true });
        }
      }
    }
  }

  /** Wreck the car: hand it to the crash world and notify the game. */
  crash(cause: string, other: TrafficVehicle | WreckBody | null, position: Vector3, normal: Vector3, hitVehicle: TrafficVehicle | null): void {
    const st = this.state;
    if (!st.alive) return;
    const sim = this.sim;
    const ctx = this.ctx;
    st.alive = false;
    st.wrecked = true;
    st.damage = 1;
    sim.writeState(st);
    const speed = Math.hypot(sim.vx, sim.vz);
    const relSpeed = speed;

    // Plastic collision: share momentum with what we hit, then add some chaos.
    let ovx = 0;
    let ovz = 0;
    let om = 0;
    if (hitVehicle) {
      ovx = Math.sin(hitVehicle.heading) * hitVehicle.speed;
      ovz = -Math.cos(hitVehicle.heading) * hitVehicle.speed;
      om = hitVehicle.def.mass;
    } else if (other && 'linvel' in other) {
      ovx = other.linvel.x;
      ovz = other.linvel.z;
      om = other.mass;
    } else if (other === null && normal.lengthSq() > 0) {
      om = 1e6; // the barrier: immovable
    }
    const m = st.dims.mass;
    const k = om > 0 ? m / (m + om) : 1;
    // Keep more of our own speed than physics says — a wreck that tumbles on reads better.
    const keep = om > 0 ? Math.max(k, 0.45) : 0.9;
    const cvx = sim.vx * keep + ovx * (1 - keep) + normal.x * 3;
    const cvz = sim.vz * keep + ovz * (1 - keep) + normal.z * 3;

    if (ctx.crash?.ready) {
      const h = st.dims.height * 0.5;
      _half.set(st.dims.width * 0.5, h * 0.92, st.dims.length * 0.5);
      _pos.set(sim.x, h + 0.08, sim.z);
      _q.copy(st.quaternion);
      _vel.set(cvx, 2.2 + Math.min(4, speed * 0.05), cvz);
      // Spin: yaw from the off-centre hit, roll/pitch for drama, stronger at speed.
      const sgn = Math.random() < 0.5 ? -1 : 1;
      const spin = clamp(speed / 45, 0.35, 1.6);
      _ang.set((Math.random() - 0.3) * 3 * spin, sgn * (1.5 + Math.random() * 2.5) * spin, sgn * (1 + Math.random() * 3) * spin);
      this.dummy.position.copy(st.position);
      this.dummy.quaternion.copy(st.quaternion);
      this.body = ctx.crash.addBox(this.dummy, _half, m, _pos, _q, _vel, _ang, 'player', h + 0.08);
    }
    if (hitVehicle && ctx.traffic && hitVehicle.mode !== 'wreck') {
      const share = m / (m + om);
      _vel.set(ovx + (sim.vx - ovx) * share * 1.4, 1.2, ovz + (sim.vz - ovz) * share * 1.4);
      _ang.set(0, (Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 0.8);
      ctx.traffic.wreck(hitVehicle, _vel, _ang);
    }
    this.crashInfo = { cause, speed, other, position: position.clone() };
    ctx.events.emit('collision', { kind: other && 'linvel' in other ? 'wreck' : hitVehicle ? 'traffic' : 'barrier', position: position.clone(), normal: normal.clone(), relSpeed, intensity: 1, fatal: true, player: true });
    this.onCrash?.(this.crashInfo);
  }

  /** Per-frame update while wrecked: the crash world drives the pose. */
  updateWrecked(dt: number): void {
    const st = this.state;
    if (this.body) {
      st.position.copy(this.dummy.position);
      st.quaternion.copy(this.dummy.quaternion);
      st.velocity.copy(this.body.linvel);
      const sp = this.body.linvel.length();
      st.speed = sp;
      st.speedKmh = sp * 3.6;
      const pr = this.ctx.road.project(st.position.x, st.position.z, st.s);
      st.s = pr.s;
      st.d = pr.d;
      for (let i = 0; i < 4; i++) st.wheelSkid[i] = 0;
    } else {
      // No physics available: slide to a stop.
      const k = Math.exp(-dt * 1.5);
      st.velocity.multiplyScalar(k);
      st.position.addScaledVector(st.velocity, dt);
      st.speed *= k;
      st.speedKmh = st.speed * 3.6;
    }
    st.throttle = 0;
    st.brake = 0;
    st.nitroActive = false;
    st.rpm01 = Math.max(0.08, st.rpm01 - dt * 0.8);
  }

  get wreckBody(): WreckBody | null {
    return this.body;
  }
}
