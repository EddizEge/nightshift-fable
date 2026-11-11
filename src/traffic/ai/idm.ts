/**
 * Intelligent Driver Model (Treiber et al.) with bounded braking. Pure functions, no allocation.
 */
export interface IdmParams {
  /** Desired speed m/s. */
  v0: number;
  /** Desired time headway s. */
  T: number;
  /** Max acceleration m/s². */
  a: number;
  /** Comfortable deceleration m/s² (positive). */
  b: number;
  /** Jam distance m (bumper to bumper). */
  s0: number;
}

/** Hardest deceleration any AI vehicle uses (wet road, ABS). */
export const IDM_MAX_DECEL = 9;

/** Free-road term only. */
export function idmFree(v: number, v0: number, a: number): number {
  const r = v / Math.max(0.5, v0);
  const r2 = r * r;
  return Math.max(-4, a * (1 - r2 * r2));
}

/**
 * Acceleration behind a leader. `gap` = bumper-to-bumper distance (m), `vLead` = leader speed.
 */
export function idmAccel(v: number, p: IdmParams, gap: number, vLead: number): number {
  const free = idmFree(v, p.v0, p.a);
  const dv = v - vLead;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const q = sStar / Math.max(0.05, gap);
  const acc = free - p.a * q * q;
  return acc < -IDM_MAX_DECEL ? -IDM_MAX_DECEL : acc;
}

/** Quintic smootherstep and its derivative (lane-change lateral profile). */
export function smoother(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}
export function smootherD(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return 30 * x * x * (1 - x) * (1 - x);
}
