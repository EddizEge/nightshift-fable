import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ICrashWorld, IRoadPath, WreckBody } from '../core/types';
import { BARRIER_LEFT_D, BARRIER_RIGHT_D } from '../world/roadProfile';

interface Body extends WreckBody {
  rb: RAPIER_NS.RigidBody;
  /** Object origin sits this far below the body centre (vehicles have their origin on the ground). */
  yOffset: number;
  angvel: Vector3;
  /** Pose before the last physics step; the object is drawn between this and position/quaternion. */
  p0: Vector3;
  q0: Quaternion;
}

const SEG_LEN = 24;
const SEG_COUNT = 14; // per side → ±168 m around the player
const GRAVITY = -9.81 * 1.35; // slightly heavy: wrecks settle quickly and read better at speed
const MAX_BODIES = 40;
const WALL_HALF_H = 20;
/** Horizontal speed limit of the crash world (m/s): never below this, see CrashWorld.ceil. */
const SPEED_FLOOR = 8;
/** Head room over the fastest body: what a collision may add to the body it hits. */
const SPEED_SLACK = 5;
/** Nothing in the game is faster than this (the player on nitro does about 85 m/s): no hand-over, hit or blast may ask for more. */
const SPEED_MAX = 110;
const MAX_FALL = 45; // vertical speed limit, m/s
const MAX_SPIN = 14; // rad/s

/** The physics engine (2 MB with its WebAssembly) is its own chunk, fetched while the rest of the game boots. */
let RAPIER: typeof RAPIER_NS;

const _q = new Quaternion();
const _v = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * Small Rapier world for everything that tumbles: wrecked vehicles (boxes) and big debris.
 * Driving itself is NOT simulated here (see VehicleSim); vehicles are handed over when they crash.
 * Static world = a ground slab that follows the player + barrier walls laid along the road.
 */
export class CrashWorld implements ICrashWorld {
  readonly bodies: Body[] = [];
  ready = false;
  private world!: RAPIER_NS.World;
  private ground!: RAPIER_NS.RigidBody;
  private walls: RAPIER_NS.RigidBody[] = [];
  private wallsAtS = Infinity;
  private nextId = 1;
  private acc = 0;
  /**
   * Speed limiter. Bodies handed over while they overlap (the set pieces do that on purpose) get
   * depenetration kicks from the solver step after step; unchecked, that launches a 30 t tanker
   * down the road at 250 m/s. No body may move faster horizontally than this ceiling, and only
   * momentum that comes from outside raises it: a hand-over, a blast, a hit by the player. It
   * follows the fastest body down as the wreckage slows, and never exceeds SPEED_MAX. (An earlier
   * per-body limit was raised a little by every impulse, and the director's steady steering pushes
   * ratcheted it up.)
   */
  private ceil = SPEED_FLOOR;

  private raise(speed: number): void {
    if (speed > this.ceil) this.ceil = Math.min(SPEED_MAX, speed);
  }

  constructor(private road: IRoadPath) {}

  async init(): Promise<void> {
    RAPIER = (await import('@dimforge/rapier3d-compat')).default;
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = 1 / 60;
    this.ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(1500, 5, 1500).setFriction(0.75).setRestitution(0.1), this.ground);
    for (let i = 0; i < SEG_COUNT * 2; i++) {
      const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -100, 0));
      // Far taller than the real barriers: a wreck must never come to rest on top of one or leave
      // the carriageway (the far side is not simulated).
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.35, WALL_HALF_H, SEG_LEN * 0.5 + 0.4).setFriction(0.4).setRestitution(0.2), rb);
      this.walls.push(rb);
    }
    this.ready = true;
  }

  private layWalls(playerS: number): void {
    const s0 = Math.round(playerS / SEG_LEN) * SEG_LEN;
    if (Math.abs(s0 - this.wallsAtS) < SEG_LEN * 2) return;
    this.wallsAtS = s0;
    for (let i = 0; i < SEG_COUNT; i++) {
      const s = s0 + (i - SEG_COUNT / 2 + 2) * SEG_LEN + SEG_LEN * 0.5;
      const f = this.road.frameAt(s);
      _q.setFromAxisAngle(_up, -f.h);
      for (let side = 0; side < 2; side++) {
        const d = side === 0 ? BARRIER_LEFT_D - 0.35 : BARRIER_RIGHT_D + 0.35;
        const rb = this.walls[i * 2 + side];
        rb.setTranslation({ x: f.x + f.rx * d, y: WALL_HALF_H, z: f.z + f.rz * d }, false);
        rb.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, false);
      }
    }
    const g = this.road.frameAt(playerS);
    this.ground.setTranslation({ x: g.x, y: -5, z: g.z }, false);
  }

  addBox(
    object: Object3D,
    halfExtents: Vector3,
    mass: number,
    position: Vector3,
    quaternion: Quaternion,
    linVel: Vector3,
    angVel: Vector3,
    owner: unknown = null,
    yOffset = 0,
  ): WreckBody {
    if (this.bodies.length >= MAX_BODIES) {
      // Drop the oldest traffic body (its owner releases the visual); director bodies only as a last resort.
      const victim = this.bodies.find((b) => b.owner !== 'player' && b.owner !== 'director') ?? this.bodies.find((b) => b.owner !== 'player');
      if (victim) this.remove(victim);
    }
    // A hand-over faster than anything can drive is a caller's bug: keep the direction, not the speed.
    const speed = Math.hypot(linVel.x, linVel.z);
    const vk = speed > SPEED_MAX ? SPEED_MAX / speed : 1;
    const vx = linVel.x * vk;
    const vy = Math.max(-MAX_FALL, Math.min(MAX_FALL, linVel.y));
    const vz = linVel.z * vk;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
      .setLinvel(vx, vy, vz)
      .setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z })
      .setLinearDamping(0.04)
      .setAngularDamping(0.25)
      .setCcdEnabled(true);
    const rb = this.world.createRigidBody(desc);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setMass(mass).setFriction(0.62).setRestitution(0.18),
      rb,
    );
    const body: Body = {
      id: this.nextId++,
      object,
      halfExtents: halfExtents.clone(),
      position: position.clone(),
      quaternion: quaternion.clone(),
      linvel: new Vector3(vx, vy, vz),
      angvel: angVel.clone(),
      mass,
      awake: true,
      owner,
      burning: false,
      rb,
      yOffset,
      p0: position.clone(),
      q0: quaternion.clone(),
    };
    this.bodies.push(body);
    this.raise(speed * vk + SPEED_SLACK);
    this.syncObject(body, 0);
    return body;
  }

  /** Object pose = render interpolation between the last two physics steps (a = 0 … 1). */
  private syncObject(b: Body, a: number): void {
    const o = b.object;
    o.quaternion.slerpQuaternions(b.q0, b.quaternion, a);
    _v.set(0, -b.yOffset, 0).applyQuaternion(o.quaternion);
    o.position.lerpVectors(b.p0, b.position, a).add(_v);
  }

  remove(b: WreckBody): void {
    const i = this.bodies.indexOf(b as Body);
    if (i < 0) return;
    this.world.removeRigidBody((b as Body).rb);
    this.bodies.splice(i, 1);
  }

  applyImpulse(b: WreckBody, impulse: Vector3, point?: Vector3): void {
    const rb = (b as Body).rb;
    // A real hit raises the ceiling by what it adds; gentle steering pushes (a fraction of a m/s
    // per call, every step) do not, or they would add up.
    const dv = impulse.length() / Math.max(1, b.mass);
    if (dv > 0.5) this.raise(Math.hypot(b.linvel.x, b.linvel.z) + dv);
    if (point) rb.applyImpulseAtPoint({ x: impulse.x, y: impulse.y, z: impulse.z }, { x: point.x, y: point.y, z: point.z }, true);
    else rb.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  applyBlast(center: Vector3, strength: number, radius: number): void {
    for (const b of this.bodies) {
      _v.copy(b.position).sub(center);
      const dist = _v.length();
      if (dist > radius) continue;
      // Heavy bodies are thrown less: a car is flung, a 30 t tanker only hops.
      const heavy = Math.min(1.2, Math.max(0.3, Math.sqrt(1500 / Math.max(200, b.mass))));
      const k = (1 - dist / radius) * strength * heavy;
      this.raise(Math.hypot(b.linvel.x, b.linvel.z) + k);
      _v.normalize();
      _v.y = b.position.y > 5 ? 0.1 : Math.abs(_v.y) * 0.5 + 0.55; // blasts lift things
      _v.normalize().multiplyScalar(k * b.mass);
      // Off-centre so things tumble.
      const p = { x: b.position.x + (Math.random() - 0.5) * b.halfExtents.x, y: b.position.y - b.halfExtents.y * 0.6, z: b.position.z + (Math.random() - 0.5) * b.halfExtents.z };
      b.rb.applyImpulseAtPoint({ x: _v.x, y: _v.y, z: _v.z }, p, true);
    }
  }

  /** Advance by dt (scaled time). Internally steps at 60 Hz. */
  step(dt: number, playerS: number): void {
    if (!this.ready) return;
    this.layWalls(playerS);
    if (this.bodies.length === 0) {
      this.acc = 0;
      this.ceil = SPEED_FLOOR;
      return;
    }
    this.acc += dt;
    let steps = 0;
    while (this.acc >= 1 / 60 && steps < 3) {
      for (const b of this.bodies) {
        b.p0.copy(b.position);
        b.q0.copy(b.quaternion);
      }
      this.world.step();
      this.acc -= 1 / 60;
      steps++;
      this.readBack();
    }
    if (steps === 3) this.acc = 0;
    // Every frame, also without a step: slow motion and high refresh rates would otherwise judder.
    const a = Math.min(1, this.acc * 60);
    for (const b of this.bodies) this.syncObject(b, a);
  }

  /** Copy the physics state of every body after a world step, with the speed limiter and safety net. */
  private readBack(): void {
    const ceil = this.ceil;
    let fastest = 0;
    for (const b of this.bodies) {
      const t = b.rb.translation();
      const r = b.rb.rotation();
      const lv = b.rb.linvel();
      const av = b.rb.angvel();
      b.position.set(t.x, t.y, t.z);
      b.quaternion.set(r.x, r.y, r.z, r.w);
      b.linvel.set(lv.x, lv.y, lv.z);
      b.angvel.set(av.x, av.y, av.z);
      // Speed limiter (see `ceil`).
      let sp = Math.hypot(b.linvel.x, b.linvel.z);
      const vy = b.linvel.y < -MAX_FALL ? -MAX_FALL : b.linvel.y > MAX_FALL ? MAX_FALL : b.linvel.y;
      if (sp > ceil || vy !== b.linvel.y) {
        const k = sp > ceil ? ceil / sp : 1;
        b.linvel.set(b.linvel.x * k, vy, b.linvel.z * k);
        b.rb.setLinvel({ x: b.linvel.x, y: b.linvel.y, z: b.linvel.z }, true);
        sp *= k;
      }
      if (sp > fastest) fastest = sp;
      const spin = b.angvel.length();
      if (spin > MAX_SPIN) {
        b.angvel.multiplyScalar(MAX_SPIN / spin);
        b.rb.setAngvel({ x: b.angvel.x, y: b.angvel.y, z: b.angvel.z }, true);
      }
      b.awake = !b.rb.isSleeping() && b.linvel.lengthSq() + b.angvel.lengthSq() > 0.05;
      // Safety net: anything that fell through or flew away comes back to rest on the road.
      if (t.y < -3 || !Number.isFinite(t.y)) {
        b.rb.setTranslation({ x: t.x, y: b.halfExtents.y + 0.2, z: t.z }, true);
        b.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.position.y = b.halfExtents.y + 0.2;
        b.p0.copy(b.position); // no interpolation across the teleport
      }
    }
    this.ceil = Math.max(SPEED_FLOOR, Math.min(ceil, fastest + SPEED_SLACK));
  }

  reset(): void {
    if (!this.ready) return;
    for (const b of this.bodies) this.world.removeRigidBody(b.rb);
    this.bodies.length = 0;
    this.wallsAtS = Infinity;
    this.acc = 0;
    this.ceil = SPEED_FLOOR;
  }
}
