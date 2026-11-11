/** 2D oriented boxes on the road plane. Heading h: forward = (sin h, −cos h), right = (cos h, sin h). */
export interface Obb2 {
  x: number;
  z: number;
  /** Half width (along right) and half length (along forward). */
  hw: number;
  hl: number;
  sin: number;
  cos: number;
}

export interface Contact {
  /** Unit normal from a to b. */
  nx: number;
  nz: number;
  depth: number;
  /** Approximate contact point. */
  px: number;
  pz: number;
}

export function setObb(o: Obb2, x: number, z: number, heading: number, hw: number, hl: number): Obb2 {
  o.x = x;
  o.z = z;
  o.hw = hw;
  o.hl = hl;
  o.sin = Math.sin(heading);
  o.cos = Math.cos(heading);
  return o;
}

export const makeObb = (): Obb2 => ({ x: 0, z: 0, hw: 1, hl: 2, sin: 0, cos: 1 });

/** Separating-axis test. Returns true and fills `out` with the minimum-translation contact when overlapping. */
export function obbOverlap(a: Obb2, b: Obb2, out: Contact): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // Cheap reject.
  const ra = a.hw + a.hl;
  const rb = b.hw + b.hl;
  if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) return false;
  let best = Infinity;
  let bnx = 0;
  let bnz = 0;
  for (let i = 0; i < 4; i++) {
    // Axes: a.right, a.forward, b.right, b.forward
    const src = i < 2 ? a : b;
    const ax = i % 2 === 0 ? src.cos : src.sin;
    const az = i % 2 === 0 ? src.sin : -src.cos;
    const dist = dx * ax + dz * az;
    const pa = a.hw * Math.abs(ax * a.cos + az * a.sin) + a.hl * Math.abs(ax * a.sin - az * a.cos);
    const pb = b.hw * Math.abs(ax * b.cos + az * b.sin) + b.hl * Math.abs(ax * b.sin - az * b.cos);
    const overlap = pa + pb - Math.abs(dist);
    if (overlap <= 0) return false;
    if (overlap < best) {
      best = overlap;
      const sgn = dist >= 0 ? 1 : -1;
      bnx = ax * sgn;
      bnz = az * sgn;
    }
  }
  out.nx = bnx;
  out.nz = bnz;
  out.depth = best;
  // Contact point: on a's surface along the normal, pulled towards b's centre laterally.
  const reach = a.hw * Math.abs(bnx * a.cos + bnz * a.sin) + a.hl * Math.abs(bnx * a.sin - bnz * a.cos);
  const tx = -bnz;
  const tz = bnx;
  const lat = Math.max(-1.2, Math.min(1.2, (dx * tx + dz * tz) * 0.5));
  out.px = a.x + bnx * (reach - best * 0.5) + tx * lat;
  out.pz = a.z + bnz * (reach - best * 0.5) + tz * lat;
  return true;
}
