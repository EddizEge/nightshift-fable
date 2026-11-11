/**
 * Player camera rig (implements ICameraRig).
 *
 *  chase     low, wide third-person. The camera's offset from the car (not its world position) is a
 *            critically damped spring, so it never trails metres behind at 300 km/h; its yaw follows a
 *            blend of heading and velocity direction so slides show the car's flank.
 *  hood      at the hood / windscreen anchor with a little inertia and bob.
 *  orbit     slow, low showroom orbit for the menu.
 *  crash     wide orbit that eases outward / upward and keeps the wreck framed.
 *  cinematic the game owns camera.position / quaternion; the rig only layers shake on top.
 *
 * update() is allocation-free (all temporaries are preallocated).
 */
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera } from 'three';
import type { CameraMode, ICameraRig, PlayerState } from '../core/types';
import { clamp, clamp01, damp, lerp, noise1, smoothstep, wrapAngle } from '../core/math';

const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);

/**
 * Bonnet camera: metres forward / up from the hoodCam anchor (windscreen base) and the resting pitch.
 * Measured in the game at 223 km/h (FOV 81°) by ray casting the car: the bonnet fills the bottom 23–24 %
 * of the frame (it was 31 % with 0.62 / 0.10 / −0.035), and the road shows from 3.5 m ahead of the car's
 * centre, 1.2 m ahead of the bumper. The bonnet still hides the brightest patch of the headlight cone,
 * which lands 0.5–0.9 m ahead of the bumper (src/game/headlights.ts). Mostly a pitch change (the eye is
 * 3 cm higher): moving the eye forward or much higher would uncover that patch. The eye stays ahead of
 * the windscreen, outside the cabin.
 */
const HOOD_EYE = { forward: 0.62, up: 0.13, pitch: 0.05 };

/** Critically damped spring on a scalar (velocity kept by the caller). */
function spring(x: number, v: number, target: number, omega: number, dt: number, out: { x: number; v: number }): void {
  // Exact solution of x'' = -ω²(x - t) - 2ωx' over dt.
  const e = Math.exp(-omega * dt);
  const d = x - target;
  const c = v + omega * d;
  out.x = target + (d + c * dt) * e;
  out.v = (c - omega * (d + c * dt)) * e;
}

class Spring3 {
  readonly p = new Vector3();
  readonly v = new Vector3();
  private static tmp = { x: 0, v: 0 };
  step(target: Vector3, omega: number, dt: number): void {
    const t = Spring3.tmp;
    spring(this.p.x, this.v.x, target.x, omega, dt, t);
    this.p.x = t.x;
    this.v.x = t.v;
    spring(this.p.y, this.v.y, target.y, omega, dt, t);
    this.p.y = t.x;
    this.v.y = t.v;
    spring(this.p.z, this.v.z, target.z, omega, dt, t);
    this.p.z = t.x;
    this.v.z = t.v;
  }
  snap(target: Vector3): void {
    this.p.copy(target);
    this.v.set(0, 0, 0);
  }
}

export interface CameraRigOptions {
  /** Driver-eye / hood anchor of the player car visual (world transform is read every frame). */
  hoodAnchor?: Object3D;
}

export class CameraRig implements ICameraRig {
  mode: CameraMode = 'chase';
  /** Bonnet camera eye relative to the car's hoodCam anchor, and its pitch (radians, + = up). */
  readonly hoodEye = { ...HOOD_EYE };

  private readonly camera: PerspectiveCamera;
  private readonly hoodAnchor: Object3D | undefined;

  // Orbit parameters (menu + crash share the evaluator, with their own defaults).
  private orbit = { radius: 6.2, height: 1.05, speed: 0.11, angle: 2.4, fov: 38, targetHeight: 0.62 };

  private snapNext = true;
  private trauma = 0;

  // Chase state.
  private yaw = 0;
  private yawVel = 0;
  private readonly chaseOff = new Spring3(); // camera offset from the car origin
  private readonly lookOff = new Spring3(); // look-target offset from the car origin
  private chaseRoll = 0;
  private nitroFov = 0;
  private speedFov = 0;

  // Hood state.
  private hoodYaw = 0;
  private hoodYawVel = 0;
  private hoodPitch = 0;
  private hoodLagF = 0;
  private hoodLagFv = 0;
  private hoodBob = 0;
  private hoodBobV = 0;

  /** 0 = chase, 1 = hood; eased between the two over ≈ 0.6 s. */
  private hoodBlend = 0;

  // Orbit / crash state.
  private orbitAngle = 0;
  private crashRadius = 0;
  private crashHeight = 0;
  private crashTime = 0;
  private readonly orbitTarget = new Spring3();
  private readonly orbitPos = new Spring3();
  private orbitFov = 40;

  // Cinematic: base pose set by the game (shake is layered on top of it).
  private readonly cineBasePos = new Vector3();
  private readonly cineBaseQuat = new Quaternion();
  private readonly lastPos = new Vector3();
  private readonly lastQuat = new Quaternion();
  private cineValid = false;

  // Temporaries.
  private readonly tA = new Vector3();
  private readonly tB = new Vector3();
  private readonly tC = new Vector3();
  private readonly carPos = new Vector3();
  private readonly chasePos = new Vector3();
  private readonly chaseQuat = new Quaternion();
  private readonly hoodPos = new Vector3();
  private readonly hoodQuat = new Quaternion();
  private readonly qTmp = new Quaternion();
  private readonly mTmp = new Matrix4();
  private readonly shakeQ = new Quaternion();
  private readonly fwdAxis = new Vector3(0, 0, -1);

  constructor(camera: PerspectiveCamera, opts?: CameraRigOptions) {
    this.camera = camera;
    this.hoodAnchor = opts?.hoodAnchor;
  }

  nextMode(): CameraMode {
    this.setMode(this.mode === 'hood' ? 'chase' : 'hood');
    return this.mode;
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    const prev = this.mode;
    this.mode = m;
    if (m === 'crash') {
      // Start the crash orbit from where the camera is now (no cut).
      this.crashTime = 0;
      this.crashRadius = -1; // initialised on the next update from the current camera offset
    }
    if (m === 'orbit') this.orbitAngle = this.orbit.angle;
    if (m === 'cinematic') this.cineValid = false;
    // Chase ↔ hood blends; any other transition into chase / hood is a cut.
    const pair = (prev === 'chase' || prev === 'hood') && (m === 'chase' || m === 'hood');
    if (!pair && (m === 'chase' || m === 'hood')) {
      this.hoodBlend = m === 'hood' ? 1 : 0;
      this.snapNext = true;
    }
    if (m === 'orbit' || (m === 'crash' && prev !== 'chase' && prev !== 'hood')) this.snapNext = true;
  }

  addShake(trauma: number): void {
    if (trauma > 0) this.trauma = Math.min(1, this.trauma + trauma);
  }

  setOrbit(o: { radius?: number; height?: number; speed?: number; angle?: number; fov?: number; targetHeight?: number }): void {
    const t = this.orbit;
    if (o.radius !== undefined) t.radius = o.radius;
    if (o.height !== undefined) t.height = o.height;
    if (o.speed !== undefined) t.speed = o.speed;
    if (o.fov !== undefined) t.fov = o.fov;
    if (o.targetHeight !== undefined) t.targetHeight = o.targetHeight;
    if (o.angle !== undefined) {
      t.angle = o.angle;
      this.orbitAngle = o.angle;
    }
  }

  snap(): void {
    this.snapNext = true;
  }

  update(dt: number, player: PlayerState, time: number): void {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const cam = this.camera;
    const snap = this.snapNext;
    this.snapNext = false;
    this.carPos.set(player.position.x, player.position.y, player.position.z);
    this.trauma = Math.max(0, this.trauma - 1.4 * dt);

    let fov = cam.fov;
    switch (this.mode) {
      case 'chase':
      case 'hood': {
        const target = this.mode === 'hood' ? 1 : 0;
        if (snap) this.hoodBlend = target;
        // Keep both poses alive so the blend (and later switches) never jump.
        const fovC = this.updateChase(dt, player, time, snap);
        const fovH = this.updateHood(dt, player, snap);
        this.hoodBlend = clamp01(this.hoodBlend + Math.sign(target - this.hoodBlend) * (dt / 0.6));
        const k = smoothstep(0, 1, this.hoodBlend);
        cam.position.lerpVectors(this.chasePos, this.hoodPos, k);
        cam.quaternion.slerpQuaternions(this.chaseQuat, this.hoodQuat, k);
        fov = lerp(fovC, fovH, k);
        break;
      }
      case 'orbit':
        fov = this.updateOrbit(dt, player, snap);
        break;
      case 'crash':
        fov = this.updateCrash(dt, player, snap);
        break;
      case 'cinematic':
        // If the game moved the camera since our last write, that is the new base pose.
        if (!this.cineValid || !cam.position.equals(this.lastPos) || !cam.quaternion.equals(this.lastQuat)) {
          this.cineBasePos.copy(cam.position);
          this.cineBaseQuat.copy(cam.quaternion);
          this.cineValid = true;
        }
        cam.position.copy(this.cineBasePos);
        cam.quaternion.copy(this.cineBaseQuat);
        break;
    }

    this.applyShake(time);
    if (this.mode !== 'cinematic' && cam.position.y < 0.4) cam.position.y = 0.4;
    if (Math.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.lastPos.copy(cam.position);
    this.lastQuat.copy(cam.quaternion);
  }

  // ── Chase ────────────────────────────────────────────────────────────────────────────────────

  private updateChase(dt: number, pl: PlayerState, time: number, snap: boolean): number {
    const kmh = Math.abs(pl.speedKmh);
    const sp01 = clamp01(kmh / 300);
    const vx = pl.velocity.x;
    const vz = pl.velocity.z;
    const vAbs = Math.hypot(vx, vz);

    // Yaw: heading blended toward the velocity direction (shows the flank when sliding).
    let yawT = pl.heading;
    if (vAbs > 2 && pl.speed > 0) {
      const velYaw = Math.atan2(vx, -vz);
      yawT = pl.heading + 0.55 * wrapAngle(velYaw - pl.heading) * smoothstep(2, 8, vAbs);
    }
    if (snap) {
      this.yaw = yawT;
      this.yawVel = 0;
    } else {
      // Spring on the wrapped error so ±π crossings are seamless.
      const t = Spring3Tmp;
      const err = wrapAngle(this.yaw - yawT);
      spring(err, this.yawVel, 0, lerp(5.5, 7.5, sp01), dt, t);
      this.yaw = wrapAngle(yawT + t.x);
      this.yawVel = t.v;
    }

    const sh = Math.sin(this.yaw);
    const ch = Math.cos(this.yaw);
    const brake = clamp01(-pl.accelLong - 0.25) * clamp01(pl.speed / 10);
    const accel = clamp01(pl.accelLong);
    // Distance / height: pulls back with speed and under acceleration, dips closer under braking.
    const dist = 6.0 + 0.85 * sp01 * sp01 + 0.35 * accel - 0.55 * brake + (pl.nitroActive ? 0.3 : 0);
    const height = 1.65 + 0.1 * sp01 - 0.18 * brake;
    // Slide slightly outward in corners (accelLat > 0 = turning right → camera drifts left).
    const side = clamp(-pl.accelLat * 0.42, -0.5, 0.5);

    // Desired offset from the car (world axes, yaw-rotated): behind = −forward.
    this.tA.set(-sh * dist + ch * side, height, ch * dist + sh * side);
    const look = 12 + 4 * sp01;
    this.tB.set(sh * look, 0.8, -ch * look);
    if (snap) {
      this.chaseOff.snap(this.tA);
      this.lookOff.snap(this.tB);
    } else {
      this.chaseOff.step(this.tA, 7.5, dt);
      this.lookOff.step(this.tB, 10, dt);
    }

    this.chasePos.copy(this.carPos).add(this.chaseOff.p);
    this.tC.copy(this.carPos).add(this.lookOff.p);

    // High-speed micro vibration (road texture / aero buffeting).
    const vib = smoothstep(240, 330, kmh) * 0.014;
    if (vib > 0) {
      this.chasePos.y += (noise1(time * 31, 11) - 0.5) * 2 * vib;
      this.chasePos.x += (noise1(time * 27, 12) - 0.5) * 2 * vib * ch;
      this.chasePos.z += (noise1(time * 27, 12) - 0.5) * 2 * vib * sh;
    }
    if (this.chasePos.y < 0.4) this.chasePos.y = 0.4;

    this.lookAt(this.chasePos, this.tC, this.chaseQuat);
    // Roll ≤ 2° with the corner.
    const rollT = clamp(pl.accelLat * 1.8, -2, 2) * DEG;
    this.chaseRoll = snap ? rollT : damp(this.chaseRoll, rollT, 4, dt);
    this.qTmp.setFromAxisAngle(this.fwdAxis, -this.chaseRoll);
    this.chaseQuat.multiply(this.qTmp);

    // FOV: 55° → 72° at 300 km/h, + 6° nitro (quick in, slow out).
    const fovT = 55 + 17 * smoothstep(0, 1, sp01);
    this.speedFov = snap ? fovT : damp(this.speedFov, fovT, 3, dt);
    const nT = pl.nitroActive ? 1 : 0;
    this.nitroFov = snap ? nT : damp(this.nitroFov, nT, nT > this.nitroFov ? 7 : 1.1, dt);
    return this.speedFov + 6 * this.nitroFov;
  }

  // ── Hood ─────────────────────────────────────────────────────────────────────────────────────

  private updateHood(dt: number, pl: PlayerState, snap: boolean): number {
    const sp01 = clamp01(Math.abs(pl.speedKmh) / 300);
    // Slight yaw inertia.
    if (snap) {
      this.hoodYaw = pl.heading;
      this.hoodYawVel = 0;
    } else {
      const t = Spring3Tmp;
      spring(wrapAngle(this.hoodYaw - pl.heading), this.hoodYawVel, 0, 16, dt, t);
      this.hoodYaw = wrapAngle(pl.heading + t.x);
      this.hoodYawVel = t.v;
    }
    // Inertia lag: the head moves back under acceleration, forward under braking; bob from load changes.
    const t = Spring3Tmp;
    spring(this.hoodLagF, this.hoodLagFv, -clamp(pl.accelLong, -1.2, 1.2) * 0.06, 9, dt, t);
    this.hoodLagF = snap ? 0 : t.x;
    this.hoodLagFv = snap ? 0 : t.v;
    const susp = (pl.suspension[0] + pl.suspension[1] + pl.suspension[2] + pl.suspension[3]) * 0.25;
    spring(this.hoodBob, this.hoodBobV, -susp * 0.5, 11, dt, t);
    this.hoodBob = snap ? 0 : t.x;
    this.hoodBobV = snap ? 0 : t.v;

    const sh = Math.sin(this.hoodYaw);
    const ch = Math.cos(this.hoodYaw);
    if (this.hoodAnchor) {
      // The anchor sits at the windscreen base; the bonnet camera sits ahead of it over the bonnet (outside
      // the cabin and the windscreen), see HOOD_EYE.
      const e = this.hoodEye;
      this.hoodAnchor.getWorldPosition(this.hoodPos);
      this.hoodPos.x += Math.sin(pl.heading) * e.forward;
      this.hoodPos.z -= Math.cos(pl.heading) * e.forward;
      this.hoodPos.y += e.up;
    } else {
      const fh = Math.sin(pl.heading);
      const chh = Math.cos(pl.heading);
      // Default eye point for a ~1.25 m tall GT: just behind the windscreen top, slightly above the bonnet.
      this.hoodPos.set(pl.position.x + fh * 0.35, 1.12, pl.position.z - chh * 0.35);
    }
    this.hoodPos.x += sh * this.hoodLagF;
    this.hoodPos.z -= ch * this.hoodLagF;
    this.hoodPos.y += this.hoodBob;

    // Orientation: yaw (lagged), pitch follows body pitch a little (and dips under braking), roll with the body.
    const pitchT = pl.bodyPitch * 0.6 + this.hoodEye.pitch;
    this.hoodPitch = snap ? pitchT : damp(this.hoodPitch, pitchT, 10, dt);
    this.tB.set(this.hoodPos.x + sh * 20, this.hoodPos.y + Math.tan(this.hoodPitch) * 20, this.hoodPos.z - ch * 20);
    this.lookAt(this.hoodPos, this.tB, this.hoodQuat);
    this.qTmp.setFromAxisAngle(this.fwdAxis, -pl.bodyRoll * 0.6);
    this.hoodQuat.multiply(this.qTmp);
    return 68 + 16 * smoothstep(0, 1, sp01) + 4 * this.nitroFov;
  }

  // ── Orbit / crash ────────────────────────────────────────────────────────────────────────────

  private updateOrbit(dt: number, pl: PlayerState, snap: boolean): number {
    const o = this.orbit;
    this.orbitAngle += o.speed * dt;
    // A gentle vertical breathing keeps the hero shot alive.
    const bob = Math.sin(this.orbitAngle * 0.7) * 0.12;
    this.tA.set(
      this.carPos.x + Math.sin(this.orbitAngle) * o.radius,
      Math.max(0.4, o.height + bob),
      this.carPos.z + Math.cos(this.orbitAngle) * o.radius,
    );
    this.tB.set(this.carPos.x, o.targetHeight, this.carPos.z);
    if (snap) {
      this.orbitPos.snap(this.tA);
      this.orbitTarget.snap(this.tB);
      this.orbitFov = o.fov;
    } else {
      this.orbitPos.step(this.tA, 3, dt);
      this.orbitTarget.step(this.tB, 4, dt);
      this.orbitFov = damp(this.orbitFov, o.fov, 2, dt);
    }
    this.camera.position.copy(this.orbitPos.p);
    this.lookAt(this.orbitPos.p, this.orbitTarget.p, this.camera.quaternion);
    void pl;
    return this.orbitFov;
  }

  private updateCrash(dt: number, pl: PlayerState, snap: boolean): number {
    const cam = this.camera;
    this.crashTime += dt;
    if (this.crashRadius < 0 || snap) {
      // Continue from the current camera placement.
      const dx = cam.position.x - this.carPos.x;
      const dz = cam.position.z - this.carPos.z;
      this.crashRadius = clamp(Math.hypot(dx, dz), 4, 30);
      this.crashHeight = clamp(cam.position.y - this.carPos.y, 0.8, 20);
      this.orbitAngle = Math.atan2(dx, dz);
      this.orbitPos.snap(cam.position);
      this.tB.copy(this.carPos).y += 0.6;
      this.orbitTarget.snap(this.tB);
      this.orbitFov = cam.fov;
    }
    // Ease outward / upward, orbit slowly (slower as it widens).
    // Ends as a crane shot: high enough that a truck passing between camera and wreck never hides it.
    this.crashRadius = damp(this.crashRadius, 14.5, 1.1, dt);
    this.crashHeight = damp(this.crashHeight, 7.6, 0.75, dt);
    this.orbitAngle += 0.16 * dt * smoothstep(0, 1.5, this.crashTime);
    this.tA.set(
      this.carPos.x + Math.sin(this.orbitAngle) * this.crashRadius,
      Math.max(0.6, this.carPos.y + this.crashHeight),
      this.carPos.z + Math.cos(this.orbitAngle) * this.crashRadius,
    );
    this.tB.set(this.carPos.x, Math.max(0.3, this.carPos.y + 0.6), this.carPos.z);
    this.orbitPos.step(this.tA, 2.2, dt);
    this.orbitTarget.step(this.tB, 5, dt); // the wreck may still be tumbling: track it tightly
    this.orbitFov = damp(this.orbitFov, 50, 1.2, dt);
    cam.position.copy(this.orbitPos.p);
    this.lookAt(this.orbitPos.p, this.orbitTarget.p, cam.quaternion);
    void pl;
    return this.orbitFov;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  private lookAt(eye: Vector3, target: Vector3, out: Quaternion): void {
    // Matrix4.lookAt for cameras: −Z looks from eye to target.
    this.mTmp.lookAt(eye, target, UP);
    out.setFromRotationMatrix(this.mTmp);
  }

  private applyShake(time: number): void {
    const s = this.trauma * this.trauma;
    if (s <= 1e-5) return;
    const cam = this.camera;
    const tt = time * 18;
    const n = shakeNoise;
    const rot = 2.5 * DEG * s;
    this.tA.set(n(tt, 1) * rot, n(tt, 2) * rot, n(tt, 3) * rot * 0.7);
    this.shakeQ.setFromEuler(EulerTmp.set(this.tA.x, this.tA.y, this.tA.z));
    cam.quaternion.multiply(this.shakeQ);
    const pos = 0.25 * s;
    this.tA.set(n(tt, 4) * pos, n(tt, 5) * pos * 0.7, n(tt, 6) * pos * 0.5).applyQuaternion(cam.quaternion);
    cam.position.add(this.tA);
  }
}

/** Shared scratch objects (module-level so update() never allocates). */
const Spring3Tmp = { x: 0, v: 0 };
const EulerTmp = new Euler();
/** Smooth noise in −1..1. */
function shakeNoise(t: number, seed: number): number {
  return (noise1(t, seed) - 0.5) * 2;
}
