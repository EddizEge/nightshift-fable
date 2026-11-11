/**
 * Player car tuning. Pure data (no three.js / DOM) so it runs under vitest in Node.
 *
 * The numbers describe a heavy (~1.65 t), ~650 hp, mostly rear-driven GT on a wet motorway.
 * Several values are deliberately "game physical": the aero drag area is larger than a road car's
 * so the power-limited top speed lands at ~292 km/h while the car still pulls hard to 200 km/h,
 * and the nitro has an extra speed-fading thrust on top of its +45 % drive force (see nitro*).
 */
import type { VehicleDims } from '../core/types';

export interface VehicleParams {
  // ── Body / geometry (also the default VehicleDims) ─────────────────────────────────────────
  mass: number; // kg
  /** Yaw inertia = mass * frontAxle * rearAxle * yawInertiaIndex (≈ 1 for real cars). */
  yawInertiaIndex: number;
  length: number;
  width: number;
  height: number;
  wheelBase: number;
  trackFront: number;
  trackRear: number;
  wheelRadius: number;
  cgHeight: number;

  // ── Engine / drivetrain ────────────────────────────────────────────────────────────────────
  idleRpm: number;
  redlineRpm: number;
  /** Fuel cut. */
  limiterRpm: number;
  /** Full-load torque curve [rpm, N·m], linearly interpolated. */
  torqueCurve: ReadonlyArray<readonly [number, number]>;
  /** Engine-braking torque (N·m) = engineBrake0 + engineBrakePerRpm * rpm, at closed throttle. */
  engineBrake0: number;
  engineBrakePerRpm: number;
  gearRatios: readonly number[]; // 1st .. 7th
  reverseRatio: number;
  finalDrive: number;
  drivetrainEfficiency: number;
  /** Share of the drive force sent to the front axle (0 = RWD). */
  frontDriveShare: number;
  /** Full-throttle upshift rpm (light throttle upshifts earlier). */
  shiftUpRpm: number;
  /** Full throttle stays in the lowest gear whose rpm would be below this. */
  kickdownRpm: number;
  /** Torque cut during a gear change (s). */
  shiftTime: number;
  /** Minimum time between two gear changes (s). */
  shiftInterval: number;
  /** Clutch-slip rpm at full throttle when launching. */
  launchRpm: number;

  // ── Tyres (bicycle model, per axle) ────────────────────────────────────────────────────────
  /** Peak friction coefficient on the wet-asphalt baseline (env.grip = 1). */
  mu: number;
  /** Load sensitivity: mu drops by this fraction per 100 % of extra load on a tyre. */
  loadSensitivity: number;
  /** Pacejka-like lateral curve sin(C·atan(Bα − E(Bα − atan Bα))). Rear stiffer → stable. */
  tyreBFront: number;
  tyreBRear: number;
  tyreC: number;
  tyreE: number;
  /** Fraction of the lateral load transfer carried by the front axle (roll-stiffness split). */
  rollStiffnessFront: number;

  // ── Brakes ─────────────────────────────────────────────────────────────────────────────────
  /** Total service brake force at full pedal (N) before ABS limiting. */
  brakeForce: number;
  brakeBiasFront: number;
  /** ABS keeps each axle's brake force under this fraction of its grip. */
  absLimit: number;
  /** Traction control keeps the drive force under this fraction of the axle's grip. */
  tcLimit: number;
  /** Handbrake: locked-rear longitudinal force as a fraction of rear grip. */
  handbrakeLong: number;
  /** Handbrake: rear lateral grip multiplier (low speed → high speed). */
  handbrakeRearGripLow: number;
  handbrakeRearGripHigh: number;
  /** Handbrake: extra steering lock multiplier (lets you steer the slide). */
  handbrakeSteerBoost: number;

  // ── Aero / resistance ──────────────────────────────────────────────────────────────────────
  airDensity: number;
  /** Cd·A (m²). */
  dragArea: number;
  /** Cl·A downforce (m²). */
  downforceArea: number;
  downforceFront: number;
  rollingResistance: number;

  // ── Steering & assists ─────────────────────────────────────────────────────────────────────
  /** Mechanical wheel lock (rad). */
  maxSteerLock: number;
  /** Full keyboard lock is limited to the angle giving this lateral acceleration (g). */
  steerTargetLatG: number;
  /** Steering input slew (1/s): build-up at low / high speed, return to centre. */
  steerRateLow: number;
  steerRateHigh: number;
  steerReturnRate: number;
  /** Stability control yaw-rate gain (1/s) when oversteering / understeering. */
  escOversteer: number;
  escUndersteer: number;
  /** ESC strength while the handbrake is held (drifts must survive). */
  escHandbrake: number;
  /** Counter-steer assist: added steer angle per rad of body slip. */
  countersteerGain: number;
  /** Slide recovery: the stability-control yaw target turns the nose toward the velocity at this rate per rad of slip (1/s). */
  slipRecoveryGain: number;
  /** Lane-change assist: after a short steering tap the car straightens back (1/s heading gain). */
  headingHoldGain: number;
  /** Steering taps up to this long (s) are treated as lane changes. */
  laneTapMax: number;

  // ── Nitro ──────────────────────────────────────────────────────────────────────────────────
  /** Extra drive force multiplier while active (0.45 = +45 %). */
  nitroForceBoost: number;
  /** Additional arcade thrust (m/s²): full below nitroBoostFadeStart, fading linearly to 0 at nitroBoostFadeSpeed. */
  nitroBoostAccel: number;
  nitroBoostFadeStart: number; // m/s
  nitroBoostFadeSpeed: number; // m/s
  /** Full tank lasts this long (s). */
  nitroDuration: number;
  /** Empty → full refill time (s). */
  nitroRefillTime: number;
  /** Refill starts this long after the last use (s). */
  nitroRefillDelay: number;

  // ── Misc ───────────────────────────────────────────────────────────────────────────────────
  reverseMaxSpeed: number; // m/s
  /** Hard safety cap for the solver (m/s). */
  maxSpeed: number;

  // ── Visual suspension / attitude ───────────────────────────────────────────────────────────
  /** Body pitch / roll per g (rad). */
  pitchPerG: number;
  rollPerG: number;
  attitudeFreq: number; // Hz
  attitudeDamping: number; // ζ
  /** Heave per kN of downforce (m). */
  heavePerKN: number;
}

export const DEFAULT_VEHICLE_PARAMS: VehicleParams = {
  mass: 1650,
  yawInertiaIndex: 1.05,
  length: 4.6,
  width: 1.95,
  height: 1.25,
  wheelBase: 2.7,
  trackFront: 1.64,
  trackRear: 1.62,
  wheelRadius: 0.345,
  cgHeight: 0.48,

  idleRpm: 900,
  redlineRpm: 8200,
  limiterRpm: 8400,
  torqueCurve: [
    [0, 380],
    [1000, 430],
    [2000, 590],
    [3000, 700],
    [4500, 740],
    [6000, 715],
    [7200, 650],
    [8200, 560],
    [8600, 420],
  ],
  engineBrake0: 45,
  engineBrakePerRpm: 0.016,
  gearRatios: [3.3, 2.25, 1.72, 1.4, 1.17, 0.99, 0.86],
  reverseRatio: 3.1,
  finalDrive: 3.45,
  drivetrainEfficiency: 0.9,
  frontDriveShare: 0.22,
  shiftUpRpm: 8000,
  kickdownRpm: 7300,
  shiftTime: 0.12,
  shiftInterval: 0.32,
  launchRpm: 4200,

  mu: 1.15,
  loadSensitivity: 0.12,
  tyreBFront: 12,
  tyreBRear: 14.5,
  tyreC: 1.45,
  tyreE: 0.3,
  rollStiffnessFront: 0.56,

  brakeForce: 23000,
  brakeBiasFront: 0.62,
  absLimit: 0.96,
  tcLimit: 0.86,
  handbrakeLong: 0.3,
  handbrakeRearGripLow: 0.55,
  handbrakeRearGripHigh: 0.65,
  handbrakeSteerBoost: 2,

  airDensity: 1.225,
  dragArea: 1.25,
  downforceArea: 0.5,
  downforceFront: 0.45,
  rollingResistance: 0.013,

  maxSteerLock: 0.6,
  steerTargetLatG: 0.97,
  steerRateLow: 5,
  steerRateHigh: 3.4,
  steerReturnRate: 7,
  escOversteer: 3.0,
  escUndersteer: 0.6,
  escHandbrake: 1,
  countersteerGain: 0.75,
  slipRecoveryGain: 1.6,
  headingHoldGain: 1.6,
  laneTapMax: 0.65,

  nitroForceBoost: 0.45,
  nitroBoostAccel: 6,
  nitroBoostFadeStart: 70,
  nitroBoostFadeSpeed: 95,
  nitroDuration: 4,
  nitroRefillTime: 25,
  nitroRefillDelay: 0.8,

  reverseMaxSpeed: 9.5,
  maxSpeed: 99,

  pitchPerG: 0.032,
  rollPerG: 0.048,
  attitudeFreq: 1.5,
  attitudeDamping: 0.55,
  heavePerKN: 0.006,
};

/** Default dims derived from the params (origin = centre of the wheelbase on the ground). */
export function dimsFromParams(p: VehicleParams): VehicleDims {
  return {
    length: p.length,
    width: p.width,
    height: p.height,
    wheelBase: p.wheelBase,
    trackFront: p.trackFront,
    trackRear: p.trackRear,
    wheelRadius: p.wheelRadius,
    frontAxle: p.wheelBase / 2,
    rearAxle: p.wheelBase / 2,
    cgHeight: p.cgHeight,
    mass: p.mass,
  };
}

/** Interpolate the full-load torque curve. */
export function engineTorque(p: VehicleParams, rpm: number): number {
  const c = p.torqueCurve;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const [r0, t0] = c[i - 1];
      const [r1, t1] = c[i];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return c[c.length - 1][1];
}
