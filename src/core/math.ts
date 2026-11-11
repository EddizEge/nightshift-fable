export const TAU = Math.PI * 2;
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number): number => (x - a) / (b - a);
export const remap = (x: number, a: number, b: number, c: number, d: number): number =>
  c + ((x - a) / (b - a)) * (d - c);
export const remapClamped = (x: number, a: number, b: number, c: number, d: number): number =>
  c + clamp01((x - a) / (b - a)) * (d - c);
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. `lambda` ≈ 1 / time-constant. */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  target + (current - target) * Math.exp(-lambda * dt);
export const wrapAngle = (a: number): number => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const moveTowards = (current: number, target: number, maxDelta: number): number =>
  Math.abs(target - current) <= maxDelta ? target : current + Math.sign(target - current) * maxDelta;

/** Small fast deterministic PRNG (mulberry32). Returns [0,1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Integer hash → [0,1). */
export function hash01(n: number): number {
  let x = (n | 0) ^ 0x5bd1e995;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
export function hash2(a: number, b: number): number {
  return hash01((Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) | 0);
}
/** 1D value noise, range 0..1. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash2(i, seed), hash2(i + 1, seed), u);
}
