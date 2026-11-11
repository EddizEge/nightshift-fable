/**
 * Player driving physics — "simcade" planar dynamic bicycle model.
 *
 * Pure TypeScript (no three.js / DOM): runs in the browser and under vitest in Node.
 *
 * Model summary
 *  - State: CG position (= car origin, centre of the wheelbase), heading, world velocity, yaw rate.
 *    Integrated in the car frame (u = forward, w = right) with fixed internal substeps of ≤ 1/240 s,
 *    so the result is (nearly) identical whether the game steps at 1/120 or 1/60.
 *  - Tyres: one Pacejka-like lateral curve per axle, axle grip from wheel loads (static + downforce +
 *    longitudinal / lateral load transfer, with load sensitivity), friction circle coupling with the
 *    drive / brake force. Traction control and ABS clip the longitudinal force below the grip.
 *  - Engine torque curve × 7 gears × final drive, automatic box with torque cut on shifts, clutch-slip
 *    launch, engine braking, aero drag + rolling resistance (sets the top speed), downforce.
 *  - Arcade assists: speed-sensitive steering lock (full lock ≈ steerTargetLatG at any speed),
 *    speed-dependent steering slew, yaw-rate stability control (weak while the handbrake is held),
 *    counter-steer assist, a lane-change "heading hold" after short steering taps and a kinematic blend
 *    below ~4 m/s so the car is rock stable near standstill and stops at exactly 0.
 *  - Visual-only outputs: body pitch / roll (damped springs driven by acceleration), suspension travel,
 *    wheel spin angles and per-wheel skid intensity.
 *
 * Conventions (types.ts): heading h → forward = (sin h, 0, −cos h), right = (cos h, 0, sin h).
 * Positive yaw rate turns right; positive steer angle steers right.
 */
import type { DriveControls, PlayerState, VehicleDims } from '../core/types';
import { clamp, clamp01, damp, lerp, moveTowards, smoothstep, wrapAngle, TAU } from '../core/math';
import { DEFAULT_VEHICLE_PARAMS, dimsFromParams, engineTorque, type VehicleParams } from './vehicleParams';

export interface SimEnv {
  /** surface grip multiplier (1 = wet asphalt baseline, <1 in standing water) */
  grip: number;
  /**
   * Optional road tangent heading under the car. When given, the lane-change assist straightens the
   * car to the road (instead of to the heading it had before the steering tap), which follows curves.
   */
  roadHeading?: number;
}

const G = 9.81;
const RPM_PER_RADS = 60 / TAU;
const SUBSTEP = 1 / 240;

/** Lane-change assist state machine. */
const LANE_FREE = 0;
const LANE_TAP = 1;
const LANE_RETURN = 2;

export class VehicleSim {
  readonly params: VehicleParams;
  readonly dims: VehicleDims;

  // ── Public state ────────────────────────────────────────────────────────────────────────────
  x = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  /** Signed forward speed (m/s). */
  speed = 0;
  /** Car-space sideways speed (m/s, + = sliding right). */
  lateralSpeed = 0;
  rpm = 900;
  gear = 1;
  /** Front wheel angle (rad, + right), including assists. */
  steerAngle = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;
  nitro01 = 1;
  nitroActive = false;
  /** Smoothed car-space acceleration (g). */
  accelLong = 0;
  accelLat = 0;
  wheelSkid: [number, number, number, number] = [0, 0, 0, 0];
  wheelSpin: [number, number, number, number] = [0, 0, 0, 0];
  suspension: [number, number, number, number] = [0, 0, 0, 0];
  bodyPitch = 0;
  bodyRoll = 0;
  /** True on the step a gear change happened. */
  shifted = false;

  // ── Derived constants (from dims / params) ─────────────────────────────────────────────────
  private L = 2.7;
  private a = 1.35; // CG → front axle
  private b = 1.35; // CG → rear axle
  private Iz = 3000;
  private fzStaticF = 0; // per axle
  private fzStaticR = 0;
  private alphaPeakF = 0.15;
  private alphaPeakR = 0.13;
  /** Linear understeer gradient (s²/m) for the reference yaw rate. */
  private kUs = 0.001;

  // ── Internal state ─────────────────────────────────────────────────────────────────────────
  private steerState = 0;
  private axLT = 0; // filtered accelerations for load transfer (m/s²)
  private ayLT = 0;
  private shiftTimer = 0;
  private gearTimer = 1;
  private reverseTimer = 0;
  private nitroIdle = 10;
  /** Set when the tank ran dry while the button was held: nitro needs a fresh press (no stutter pulses). */
  private nitroLatch = false;
  private pitchVel = 0;
  private rollVel = 0;
  private hbAmt = 0;
  private hbOff = 10;
  private holdAmt = 0;
  private laneMode = LANE_FREE;
  private laneRef = 0;
  private laneHold = 0;
  private laneRet = 0;
  private prevRoadHeading = NaN;
  private roadRate = 0;
  private rearSpin = 0;
  private frontSpin = 0;
  /** Last slip angles (rad) for the skid output. */
  private alphaF = 0;
  private alphaR = 0;
  private absF = 0;
  private fzW: [number, number, number, number] = [0, 0, 0, 0];

  constructor(params?: Partial<VehicleParams>) {
    this.params = { ...DEFAULT_VEHICLE_PARAMS, ...(params ?? {}) };
    this.dims = dimsFromParams(this.params);
    this.derive();
    this.reset(0, 0, 0, 0);
  }

  /** Use the real model dimensions (CG is assumed at the car origin). */
  setDims(d: VehicleDims): void {
    Object.assign(this.dims, d);
    this.derive();
  }

  private derive(): void {
    const d = this.dims;
    const p = this.params;
    this.a = Math.max(0.5, d.frontAxle);
    this.b = Math.max(0.5, d.rearAxle);
    this.L = this.a + this.b;
    this.Iz = d.mass * this.a * this.b * p.yawInertiaIndex;
    this.fzStaticF = (d.mass * G * this.b) / this.L;
    this.fzStaticR = (d.mass * G * this.a) / this.L;
    this.alphaPeakF = this.findPeak(p.tyreBFront);
    this.alphaPeakR = this.findPeak(p.tyreBRear);
    this.kUs = Math.max(0, (1 / p.tyreBFront - 1 / p.tyreBRear) / (p.tyreC * p.mu * G));
  }

  // ── Tyre helpers ───────────────────────────────────────────────────────────────────────────

  /** Normalised lateral force (−1..1) for slip angle `alpha` (rad). */
  private mf(alpha: number, B: number): number {
    const p = this.params;
    const x = B * alpha;
    return Math.sin(p.tyreC * Math.atan(x - p.tyreE * (x - Math.atan(x))));
  }

  private findPeak(B: number): number {
    let best = 0;
    let bestA = 0.1;
    for (let i = 1; i <= 400; i++) {
      const al = i * 0.001;
      const f = this.mf(al, B);
      if (f > best) {
        best = f;
        bestA = al;
      }
    }
    return bestA;
  }

  /** Slip angle giving normalised force n (0..1) on the rising part of the curve. */
  private invMf(n: number, B: number, peak: number): number {
    if (n <= 0) return 0;
    if (n >= 0.999) return peak;
    let lo = 0;
    let hi = peak;
    for (let i = 0; i < 24; i++) {
      const mid = 0.5 * (lo + hi);
      if (this.mf(mid, B) < n) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** Grip of one axle (N) for an axle load and a lateral load shift (N, + = to the left wheel). */
  private axleGrip(fzAxle: number, dLat: number, fzStaticAxle: number): number {
    const p = this.params;
    const nom = fzStaticAxle * 0.5;
    const fl = Math.max(0, fzAxle * 0.5 + dLat);
    const fr = Math.max(0, fzAxle * 0.5 - dLat);
    const ml = clamp(1 - p.loadSensitivity * (fl / nom - 1), 0.55, 1.25);
    const mr = clamp(1 - p.loadSensitivity * (fr / nom - 1), 0.55, 1.25);
    return p.mu * (ml * fl + mr * fr);
  }

  /**
   * Speed-sensitive steering lock: the wheel angle that produces `steerTargetLatG` in a steady turn
   * (geometric L/R + front slip − rear slip, slips found by inverting the tyre curve).
   */
  private maxSteerFor(uAbs: number, grip: number): number {
    const p = this.params;
    const m = this.dims.mass;
    const v = Math.max(uAbs, 0.5);
    const aT = p.steerTargetLatG * G * Math.min(1, grip);
    const geo = (this.L * aT) / (v * v);
    if (geo >= p.maxSteerLock) return p.maxSteerLock;
    const fd = 0.5 * p.airDensity * p.downforceArea * v * v;
    const h = this.dims.cgHeight;
    const dF = ((m * aT * h) / this.dims.trackFront) * p.rollStiffnessFront;
    const dR = ((m * aT * h) / this.dims.trackRear) * (1 - p.rollStiffnessFront);
    const capF = this.axleGrip(this.fzStaticF + fd * p.downforceFront, dF, this.fzStaticF) * grip;
    const capR = this.axleGrip(this.fzStaticR + fd * (1 - p.downforceFront), dR, this.fzStaticR) * grip;
    const nf = (m * (this.b / this.L) * aT) / capF;
    const nr = (m * (this.a / this.L) * aT) / capR;
    const af = this.invMf(nf, p.tyreBFront, this.alphaPeakF);
    const ar = this.invMf(nr, p.tyreBRear, this.alphaPeakR);
    return Math.min(p.maxSteerLock, Math.max(0.002, geo + af - ar));
  }

  private wheelRpmFor(g: number, uAbs: number): number {
    const p = this.params;
    const ratio = g > 0 ? p.gearRatios[g - 1] : g < 0 ? p.reverseRatio : 0;
    return (uAbs / this.dims.wheelRadius) * ratio * p.finalDrive * RPM_PER_RADS;
  }

  // ── Public API ─────────────────────────────────────────────────────────────────────────────

  reset(x: number, z: number, heading: number, speed: number): void {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.vx = Math.sin(heading) * speed;
    this.vz = -Math.cos(heading) * speed;
    this.yawRate = 0;
    this.speed = speed;
    this.lateralSpeed = 0;
    this.steerState = 0;
    this.steerAngle = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;
    this.nitro01 = 1;
    this.nitroActive = false;
    this.nitroIdle = 10;
    this.nitroLatch = false;
    this.accelLong = 0;
    this.accelLat = 0;
    this.axLT = 0;
    this.ayLT = 0;
    this.bodyPitch = 0;
    this.bodyRoll = 0;
    this.pitchVel = 0;
    this.rollVel = 0;
    this.hbAmt = 0;
    this.hbOff = 10;
    this.holdAmt = 0;
    this.laneMode = LANE_FREE;
    this.laneRef = heading;
    this.prevRoadHeading = NaN;
    this.roadRate = 0;
    this.rearSpin = 0;
    this.frontSpin = 0;
    this.shiftTimer = 0;
    this.gearTimer = 1;
    this.reverseTimer = 0;
    this.shifted = false;
    for (let i = 0; i < 4; i++) {
      this.wheelSkid[i] = 0;
      this.suspension[i] = 0;
    }
    // Pick the gear an automatic box would be in at this speed.
    const uAbs = Math.abs(speed);
    let g = 1;
    while (g < this.params.gearRatios.length && this.wheelRpmFor(g, uAbs) > 6500) g++;
    this.gear = speed < -0.5 ? -1 : g;
    this.rpm = Math.max(this.params.idleRpm, this.wheelRpmFor(this.gear, uAbs));
  }

  applyImpulse(dvx: number, dvz: number, dYawRate: number): void {
    this.vx += dvx;
    this.vz += dvz;
    this.yawRate += dYawRate;
    // A hit cancels any lane-change straightening (the car should be knocked off line).
    this.laneMode = LANE_FREE;
    this.holdAmt = 0;
    this.updateCarFrame();
  }

  addNitro(amount01: number): void {
    this.nitro01 = clamp01(this.nitro01 + amount01);
  }

  step(dt: number, controls: DriveControls, env: SimEnv): void {
    this.shifted = false;
    if (!(dt > 0)) return;
    // Road heading rate for the curve-following heading hold (feed-forward).
    if (env.roadHeading !== undefined) {
      if (Number.isFinite(this.prevRoadHeading)) {
        const dh = wrapAngle(env.roadHeading - this.prevRoadHeading);
        this.roadRate = Math.abs(dh) < 0.3 ? dh / dt : 0;
      }
      this.prevRoadHeading = env.roadHeading;
    } else {
      this.prevRoadHeading = NaN;
      this.roadRate = 0;
    }
    const n = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h, controls, env);
  }

  writeState(out: PlayerState): void {
    const d = this.dims;
    out.position.set(this.x, 0, this.z);
    // Model faces −Z, rotation.y = −h → quaternion about +Y by −h.
    out.quaternion.set(0, Math.sin(-this.heading * 0.5), 0, Math.cos(-this.heading * 0.5));
    out.velocity.set(this.vx, 0, this.vz);
    out.heading = this.heading;
    out.yawRate = this.yawRate;
    out.speed = this.speed;
    out.speedKmh = this.speed * 3.6;
    out.lateralSpeed = this.lateralSpeed;
    out.throttle = this.throttle;
    out.brake = this.brake;
    out.steerAngle = this.steerAngle;
    out.handbrake = this.handbrake;
    out.rpm = this.rpm;
    out.rpm01 = clamp01(this.rpm / this.params.redlineRpm);
    out.gear = this.gear;
    out.nitro01 = this.nitro01;
    out.nitroActive = this.nitroActive;
    out.accelLong = this.accelLong;
    out.accelLat = this.accelLat;
    out.bodyPitch = this.bodyPitch;
    out.bodyRoll = this.bodyRoll;
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    for (let i = 0; i < 4; i++) {
      out.wheelSkid[i] = this.wheelSkid[i];
      out.wheelSpin[i] = this.wheelSpin[i];
      out.suspension[i] = this.suspension[i];
      const lf = i < 2 ? d.frontAxle : -d.rearAxle;
      const half = (i < 2 ? d.trackFront : d.trackRear) * 0.5;
      const ls = i % 2 === 0 ? -half : half;
      // world = origin + forward * lf + right * ls
      out.wheelContacts[i].set(this.x + sh * lf + ch * ls, 0, this.z - ch * lf + sh * ls);
    }
    out.dims = this.dims;
  }

  // ── Simulation ─────────────────────────────────────────────────────────────────────────────

  private updateCarFrame(): void {
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    this.speed = this.vx * sh - this.vz * ch;
    this.lateralSpeed = this.vx * ch + this.vz * sh;
  }

  private substep(h: number, c: DriveControls, env: SimEnv): void {
    const p = this.params;
    const d = this.dims;
    const m = d.mass;
    const R = d.wheelRadius;
    const grip = clamp(Number.isFinite(env.grip) ? env.grip : 1, 0.05, 2);

    this.updateCarFrame();
    let u = this.speed;
    let w = this.lateralSpeed;
    let r = this.yawRate;
    const uAbs = Math.abs(u);
    const vAbs = Math.hypot(u, w);

    // ── Pedals, direction ──────────────────────────────────────────────────────────────────
    const thrIn = clamp01(c.throttle || 0);
    const brkIn = clamp01(c.brake || 0);
    const hb = !!c.handbrake;
    let drive: number;
    let brakeCmd: number;
    if (this.gear === -1) {
      // In reverse the brake pedal drives backwards and the throttle brakes.
      drive = brkIn;
      brakeCmd = thrIn;
      if (thrIn > 0.05 && u > -0.6) this.setGear(1, 0);
    } else {
      drive = thrIn;
      brakeCmd = brkIn;
      if (brkIn > 0.1 && thrIn < 0.05 && uAbs < 0.6) this.reverseTimer += h;
      else this.reverseTimer = 0;
      if (this.reverseTimer > 0.2) {
        this.reverseTimer = 0;
        this.setGear(-1, 0);
        drive = brkIn;
        brakeCmd = 0;
      }
    }
    this.throttle = drive;
    this.brake = brakeCmd;
    this.handbrake = hb;
    this.hbAmt = moveTowards(this.hbAmt, hb ? 1 : 0, h * (hb ? 10 : 3));
    this.hbOff = hb ? 0 : this.hbOff + h;
    const hbAmt = this.hbAmt;

    // ── Steering ────────────────────────────────────────────────────────────────────────────
    const sIn = clamp(c.steer || 0, -1, 1);
    const kmh = uAbs * 3.6;
    const attack = lerp(p.steerRateLow, p.steerRateHigh, smoothstep(20, 220, kmh));
    const returning = Math.abs(sIn) < Math.abs(this.steerState) || sIn * this.steerState < 0;
    this.steerState = moveTowards(this.steerState, sIn, (returning ? p.steerReturnRate : attack) * h);
    const lock = Math.min(p.maxSteerLock, this.maxSteerFor(uAbs, grip) * lerp(1, p.handbrakeSteerBoost, hbAmt));
    const deltaDriver = this.steerState * lock;

    // Body slip angle (rad): + = travelling to the right of where the nose points.
    const beta = vAbs > 1 && u > 0 ? Math.atan2(w, u) : 0;
    const fwdFade = smoothstep(3, 8, u);

    // Counter-steer assist: point the front wheels into the slide (weaker during handbrake turns).
    const deltaCs =
      p.countersteerGain * beta * smoothstep(0.035, 0.12, Math.abs(beta)) * (1 - 0.75 * hbAmt) * fwdFade;

    // Lane-change heading hold.
    const steering = Math.abs(sIn) > 0.05;
    const canHold = u > 14 && !hb && this.hbOff > 1.2 && Math.abs(beta) < 0.12;
    let rHold = 0;
    let holdWanted = false;
    if (env.roadHeading !== undefined) {
      this.laneMode = LANE_FREE;
      const err = wrapAngle(env.roadHeading - this.heading);
      if (!steering && canHold && Math.abs(err) < 0.21) {
        holdWanted = true;
        rHold = this.roadRate + p.headingHoldGain * err;
      }
    } else {
      switch (this.laneMode) {
        case LANE_FREE:
          if (steering && canHold) {
            this.laneMode = LANE_TAP;
            this.laneRef = this.heading;
            this.laneHold = 0;
          }
          break;
        case LANE_TAP:
          if (steering) {
            this.laneHold += h;
            if (this.laneHold > p.laneTapMax || !canHold) this.laneMode = LANE_FREE;
          } else {
            this.laneMode = LANE_RETURN;
            this.laneRet = 0;
          }
          break;
        case LANE_RETURN: {
          this.laneRet += h;
          const err = wrapAngle(this.laneRef - this.heading);
          if (steering) {
            this.laneMode = LANE_TAP;
          } else if (!canHold || this.laneRet > 3 || Math.abs(err) > 0.35 || (Math.abs(err) < 0.002 && Math.abs(r) < 0.004)) {
            this.laneMode = LANE_FREE;
          } else {
            holdWanted = true;
            rHold = p.headingHoldGain * err;
          }
          break;
        }
      }
    }
    this.holdAmt = moveTowards(this.holdAmt, holdWanted ? 1 : 0, h * (holdWanted ? 4 : 8));
    const uSafe = Math.max(uAbs, 1);
    const steerGain = this.L + this.kUs * u * u; // δ = r·(L + K·u²)/u in a steady turn
    const deltaHold = this.holdAmt * clamp((rHold * steerGain) / uSafe, -lock, lock);

    const delta = clamp(deltaDriver + deltaCs + deltaHold, -p.maxSteerLock, p.maxSteerLock);
    this.steerAngle = delta;

    // ── Wheel loads & grip ──────────────────────────────────────────────────────────────────
    const q = 0.5 * p.airDensity * vAbs * vAbs;
    const fDown = q * p.downforceArea;
    const hcg = d.cgHeight;
    const dLong = (m * this.axLT * hcg) / this.L;
    const fzF = Math.max(0.1 * this.fzStaticF, this.fzStaticF + fDown * p.downforceFront - dLong);
    const fzR = Math.max(0.1 * this.fzStaticR, this.fzStaticR + fDown * (1 - p.downforceFront) + dLong);
    const dLatF = ((m * this.ayLT * hcg) / d.trackFront) * p.rollStiffnessFront;
    const dLatR = ((m * this.ayLT * hcg) / d.trackRear) * (1 - p.rollStiffnessFront);
    const capF = this.axleGrip(fzF, dLatF, this.fzStaticF) * grip;
    const capR = this.axleGrip(fzR, dLatR, this.fzStaticR) * grip;
    this.fzW[0] = Math.max(0, fzF * 0.5 + dLatF);
    this.fzW[1] = Math.max(0, fzF * 0.5 - dLatF);
    this.fzW[2] = Math.max(0, fzR * 0.5 + dLatR);
    this.fzW[3] = Math.max(0, fzR * 0.5 - dLatR);

    // ── Gearbox ─────────────────────────────────────────────────────────────────────────────
    this.gearTimer += h;
    if (this.shiftTimer > 0) this.shiftTimer -= h;
    const nGears = p.gearRatios.length;
    if (this.gear >= 1 && this.gearTimer > p.shiftInterval) {
      const up = lerp(3800, p.shiftUpRpm, drive);
      const downLimit = drive > 0.05 ? lerp(2600, p.kickdownRpm, drive * drive) : brakeCmd > 0.1 ? 3200 : 1900;
      if (this.gear < nGears && this.wheelRpmFor(this.gear, uAbs) > up && !hb) {
        this.setGear(this.gear + 1, p.shiftTime);
      } else if (this.gear > 1 && this.wheelRpmFor(this.gear - 1, uAbs) < downLimit) {
        this.setGear(this.gear - 1, p.shiftTime * 0.6);
      }
    }

    // ── Engine & drive force ────────────────────────────────────────────────────────────────
    const g = this.gear;
    const ratio = (g > 0 ? p.gearRatios[g - 1] : g < 0 ? p.reverseRatio : 0) * p.finalDrive;
    const wheelRpm = (uAbs / R) * ratio * RPM_PER_RADS;
    const clutchRpm = g === 1 || g === -1 ? lerp(p.idleRpm, p.launchRpm, drive) : p.idleRpm;
    const engRpm = Math.min(p.limiterRpm + 60, Math.max(wheelRpm, clutchRpm, p.idleRpm));
    let torque = 0;
    if (drive > 0.001 && g !== 0) {
      torque = engineTorque(p, engRpm) * drive;
      if (wheelRpm >= p.limiterRpm) torque = 0;
      if (this.shiftTimer > 0) torque *= 0.15;
      if (g === -1) torque *= clamp01((p.reverseMaxSpeed + u) / 1.5); // u < 0 when reversing
    }
    let fDrive = (torque * ratio * p.drivetrainEfficiency) / R;

    // Nitro.
    // Nitro: +nitroForceBoost through the tyres (traction-limited) plus an arcade "push" applied at the
    // body, so it still pulls hard at 250+ km/h where the rear tyres are already at their TC limit.
    if (!c.nitro) this.nitroLatch = false;
    const wantNitro = !!c.nitro && !this.nitroLatch && g > 0 && drive > 0.1;
    this.nitroActive = wantNitro && (this.nitroActive ? this.nitro01 > 0 : this.nitro01 > 0.05);
    let fNitroPush = 0;
    if (this.nitroActive) {
      const boostFade = clamp01((p.nitroBoostFadeSpeed - uAbs) / (p.nitroBoostFadeSpeed - p.nitroBoostFadeStart));
      fDrive *= 1 + p.nitroForceBoost;
      fNitroPush = m * p.nitroBoostAccel * boostFade * drive * (this.shiftTimer > 0 ? 0.5 : 1);
      if (this.nitro01 - h / p.nitroDuration <= 0) this.nitroLatch = true;
      this.nitro01 = Math.max(0, this.nitro01 - h / p.nitroDuration);
      this.nitroIdle = 0;
    } else {
      this.nitroIdle += h;
      if (this.nitroIdle > p.nitroRefillDelay) this.nitro01 = Math.min(1, this.nitro01 + h / p.nitroRefillTime);
    }
    const dirSign = g < 0 ? -1 : 1;

    // Engine braking (closed throttle, clutch engaged above idle).
    let fEngBrake = 0;
    if (g !== 0 && wheelRpm > p.idleRpm * 1.2 && drive < 0.3) {
      fEngBrake = (((p.engineBrake0 + p.engineBrakePerRpm * engRpm) * ratio) / R) * (1 - drive / 0.3);
      if (this.shiftTimer > 0) fEngBrake *= 0.3;
    }

    // ── Longitudinal per axle (drive along +dirSign, resist opposes motion) ─────────────────
    const fs = p.frontDriveShare;
    const demF = fDrive * fs;
    const demR = fDrive * (1 - fs) * (1 - hbAmt); // handbrake = clutch in for the rear
    const tcF = p.tcLimit * capF;
    const tcR = p.tcLimit * capR;
    const driveF = Math.min(demF, tcF);
    const driveR = Math.min(demR, tcR);
    this.frontSpin = demF > tcF ? clamp01((demF - tcF) / (0.5 * capF)) : 0;
    this.rearSpin = demR > tcR ? clamp01((demR - tcR) / (0.5 * capR)) : 0;

    const brakeTotal = brakeCmd * p.brakeForce;
    const bF = brakeTotal * p.brakeBiasFront;
    const bR = brakeTotal * (1 - p.brakeBiasFront);
    const lowSpeedHold = drive < 0.02 && uAbs < 2.5 ? m * 0.9 : 0; // gentle auto-hold so it settles
    const roll = p.rollingResistance * (fzF + fzR);
    const absCapF = p.absLimit * capF;
    const absCapR = p.absLimit * capR;
    this.absF = bF > 1 ? clamp01(bF / absCapF) : 0;
    let resF = Math.min(bF, absCapF) + fEngBrake * fs + roll * 0.5 + lowSpeedHold * 0.5;
    let resR = Math.min(bR + p.handbrakeLong * capR * hbAmt, hbAmt > 0.5 ? capR : absCapR) + fEngBrake * (1 - fs) + roll * 0.5 + lowSpeedHold * 0.5;
    resF = Math.min(resF, capF);
    resR = Math.min(resR, capR);
    const su = u > 0 ? 1 : u < 0 ? -1 : 0;
    const fxF = clamp(dirSign * driveF - su * resF, -capF, capF);
    const fxR = clamp(dirSign * driveR - su * resR, -capR, capR);
    const latAvailF = Math.sqrt(Math.max(0, 1 - (fxF / capF) ** 2));
    const latAvailR = Math.sqrt(Math.max(0, 1 - (fxR / capR) ** 2));

    // ── Lateral tyre forces ─────────────────────────────────────────────────────────────────
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);
    const vyF = w + this.a * r;
    const vLongWheel = u * cd + vyF * sd;
    const vLatWheel = -u * sd + vyF * cd;
    const alphaF = Math.atan2(vLatWheel, Math.max(Math.abs(vLongWheel), 1.5));
    const vyR = w - this.b * r;
    const alphaR = Math.atan2(vyR, Math.max(uAbs, 1.5));
    this.alphaF = alphaF;
    this.alphaR = alphaR;
    const hbGrip = lerp(1, lerp(p.handbrakeRearGripLow, p.handbrakeRearGripHigh, smoothstep(60, 220, kmh)), hbAmt);
    const fyFw = -this.mf(alphaF, p.tyreBFront) * capF * latAvailF;
    const fyR = -this.mf(alphaR, p.tyreBRear) * capR * latAvailR * hbGrip;

    // Front wheel forces → car frame.
    const fxFc = fxF * cd - fyFw * sd;
    const fyFc = fxF * sd + fyFw * cd;

    // Aero drag along the velocity.
    const kd = 0.5 * p.airDensity * p.dragArea * vAbs;
    const fx = fxFc + fxR - kd * u + fNitroPush;
    const fy = fyFc + fyR - kd * w;

    // ── Stability control (virtual yaw moment) ─────────────────────────────────────────────
    let rRef = (u * (deltaDriver + deltaHold)) / steerGain;
    const rMax = (p.steerTargetLatG * G * 1.1) / uSafe;
    rRef = clamp(rRef, -rMax, rMax);
    if (this.holdAmt > 0) rRef = lerp(rRef, rHold, this.holdAmt);
    // Slide recovery: once the handbrake is released, ask for yaw that swings the nose back toward the
    // direction of travel (beta < 0 = moving to the left of the nose → yaw left). Small slips are left alone.
    rRef += p.slipRecoveryGain * beta * smoothstep(0.05, 0.15, Math.abs(beta)) * (1 - hbAmt) * fwdFade;
    const over = r * rRef < 0 || Math.abs(r) > Math.abs(rRef);
    const kEsc = (over ? p.escOversteer : p.escUndersteer) * lerp(1, p.escHandbrake, hbAmt) * smoothstep(2, 8, uAbs);
    const mEsc = -kEsc * this.Iz * (r - rRef);
    const mz = this.a * fyFc - this.b * fyR + mEsc;

    // ── Integrate (car frame, semi-implicit) ────────────────────────────────────────────────
    const axRaw = fx / m;
    const ayRaw = fy / m;
    let uN = u + (axRaw + w * r) * h;
    let wN = w + (ayRaw - u * r) * h;
    let rN = r + (mz / this.Iz) * h;
    // Resistive forces must stop the car, never push it backwards.
    if (u !== 0 && uN * u < 0) {
      const driveWins = dirSign * Math.sign(uN) > 0 && driveF + driveR > resF + resR;
      if (!driveWins) uN = 0;
    }

    // Low-speed blend to a kinematic bicycle (rear axle has no lateral velocity).
    const wk = 1 - smoothstep(0.8, 4.5, Math.abs(uN));
    if (wk > 0) {
      const rKin = (uN * Math.tan(delta)) / this.L;
      rN = lerp(rN, rKin, wk);
      wN = lerp(wN, this.b * rKin, wk);
    }
    if (Math.abs(uN) < 0.05 && Math.abs(wN) < 0.05 && drive < 0.01) {
      uN = 0;
      wN = 0;
      rN = 0;
    }

    // Safety caps.
    const sp = Math.hypot(uN, wN);
    if (sp > p.maxSpeed) {
      const k = p.maxSpeed / sp;
      uN *= k;
      wN *= k;
    }
    if (!Number.isFinite(uN) || !Number.isFinite(wN) || !Number.isFinite(rN)) {
      uN = 0;
      wN = 0;
      rN = 0;
    }

    // Back to world.
    this.yawRate = rN;
    this.heading = wrapAngle(this.heading + rN * h);
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    this.vx = uN * sh + wN * ch;
    this.vz = -uN * ch + wN * sh;
    this.x += this.vx * h;
    this.z += this.vz * h;
    this.speed = uN;
    this.lateralSpeed = wN;

    // ── Outputs ─────────────────────────────────────────────────────────────────────────────
    const blendOK = 1 - wk; // kinematic regime has no tyre forces: fade accelerations out
    this.axLT = damp(this.axLT, axRaw * blendOK, 14, h);
    this.ayLT = damp(this.ayLT, ayRaw * blendOK, 14, h);
    this.accelLong = damp(this.accelLong, (axRaw * blendOK) / G, 9, h);
    this.accelLat = damp(this.accelLat, (ayRaw * blendOK) / G, 9, h);

    const flare = this.rearSpin * 1600 * (g === 1 || g === 2 ? 1 : 0.4);
    const rpmTarget = Math.min(p.limiterRpm + 60, engRpm + flare);
    this.rpm = damp(this.rpm, rpmTarget, 28, h);

    this.updateAttitude(h, fDown);
    this.updateWheels(h, uN, vAbs, hbAmt, capF, capR);
  }

  private setGear(gear: number, cut: number): void {
    if (gear === this.gear) return;
    this.gear = gear;
    this.shiftTimer = cut;
    this.gearTimer = 0;
    this.shifted = true;
  }

  private updateAttitude(h: number, fDown: number): void {
    const p = this.params;
    const om = TAU * p.attitudeFreq;
    const z2 = 2 * p.attitudeDamping * om;
    const pitchT = (this.axLT / G) * p.pitchPerG; // accelerating → nose up
    const rollT = -(this.ayLT / G) * p.rollPerG; // right turn → leans left (outward)
    this.pitchVel += (om * om * (pitchT - this.bodyPitch) - z2 * this.pitchVel) * h;
    this.bodyPitch += this.pitchVel * h;
    this.rollVel += (om * om * (rollT - this.bodyRoll) - z2 * this.rollVel) * h;
    this.bodyRoll += this.rollVel * h;

    const heave = (fDown / 1000) * p.heavePerKN;
    const d = this.dims;
    for (let i = 0; i < 4; i++) {
      const lx = i < 2 ? d.frontAxle : -d.rearAxle;
      const half = (i < 2 ? d.trackFront : d.trackRear) * 0.5;
      const ly = i % 2 === 0 ? -half : half;
      this.suspension[i] = heave - this.bodyPitch * lx + this.bodyRoll * ly;
    }
  }

  private updateWheels(h: number, u: number, vAbs: number, hbAmt: number, capF: number, capR: number): void {
    const p = this.params;
    const R = this.dims.wheelRadius;
    const omF = u / R;
    const locked = hbAmt > 0.5 && Math.abs(u) > 0.5;
    const omR = locked ? 0 : (u / R) * (1 + this.rearSpin * 2.5) + (u >= 0 ? 1 : -1) * this.rearSpin * 25;
    const omFront = omF * (1 + this.frontSpin * 1.5);
    for (let i = 0; i < 4; i++) {
      const om = i < 2 ? omFront : omR;
      this.wheelSpin[i] = (this.wheelSpin[i] + om * h) % TAU;
    }

    // Skid intensity: lateral saturation (needs some speed), wheelspin, locked rears, ABS braking.
    const speedFade = smoothstep(1, 5, vAbs);
    const latF = smoothstep(0.75, 1.25, Math.abs(this.alphaF) / this.alphaPeakF) * speedFade;
    const latR = smoothstep(0.75, 1.25, Math.abs(this.alphaR) / this.alphaPeakR) * speedFade;
    const lockR = hbAmt * smoothstep(1, 6, Math.abs(u));
    const absF = smoothstep(0.85, 1.0, this.absF) * 0.45 * speedFade;
    const skidF = clamp01(Math.max(latF, this.frontSpin, absF));
    const skidR = clamp01(Math.max(latR, this.rearSpin, lockR, absF * 0.8));
    const nomF = Math.max(1, capF / p.mu / 2);
    const nomR = Math.max(1, capR / p.mu / 2);
    for (let i = 0; i < 4; i++) {
      const base = i < 2 ? skidF : skidR;
      const loadK = this.fzW[i] / (i < 2 ? nomF : nomR);
      const target = clamp01(base * (0.75 + 0.25 * loadK));
      this.wheelSkid[i] = damp(this.wheelSkid[i], target, 20, h);
    }
  }
}
