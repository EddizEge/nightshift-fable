/**
 * Periodic (seamlessly tiling) procedural noise for NIGHTSHIFT texture generation.
 *
 * Everything here is defined on the unit square [0,1)² and is exactly periodic: integer lattice
 * coordinates are wrapped modulo the period before hashing, so a texture sampled at
 * u = x / width tiles with no seam in either axis. Deterministic for a given seed.
 */

/** Small, fast, well-mixed 32-bit integer hash (lowbias32 variant). */
function hash32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(ix, iy, seed) {
  return hash32(ix * 0x1f1f1f1f + hash32(iy + seed * 0x9e3779b9));
}

/** Deterministic PRNG (mulberry32) for anything that needs a stream of randoms. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod = (a, n) => ((a % n) + n) % n;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Periodic 2D gradient (Perlin) noise. `px`,`py` are the lattice periods (cells across the tile);
 * x,y are in lattice units (0..px, 0..py). Returns roughly [-0.7, 0.7].
 */
export function perlin(x, y, px, py, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const grad = (ix, iy, dx, dy) => {
    const h = hash2(mod(ix, px), mod(iy, py), seed);
    const a = (h / 4294967296) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = grad(x0, y0, fx, fy);
  const n10 = grad(x0 + 1, y0, fx - 1, fy);
  const n01 = grad(x0, y0 + 1, fx, fy - 1);
  const n11 = grad(x0 + 1, y0 + 1, fx - 1, fy - 1);
  const u = fade(fx), v = fade(fy);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

/**
 * Periodic fractal Brownian motion on the unit square. `period` is the base lattice period
 * (integer); each octave doubles it so periodicity is preserved. Returns roughly [-1, 1].
 */
export function fbm(u, v, { period = 4, periodY = period, octaves = 5, gain = 0.5, seed = 0 } = {}) {
  let sum = 0, amp = 1, norm = 0, p = period, q = periodY;
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin(u * p, v * q, p, q, seed + o * 1013);
    norm += amp;
    amp *= gain;
    p *= 2;
    q *= 2;
  }
  return (sum / norm) * 1.6;
}

/**
 * Periodic Worley (cellular) noise: distance to the nearest feature point, one jittered point
 * per cell, `period` cells across the tile. Returns F1 in cell units (≈ 0..1.1).
 */
export function worley(u, v, period, seed = 0) {
  const x = u * period, y = v * period;
  const cx = Math.floor(x), cy = Math.floor(y);
  let best = 1e9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const h = hash2(mod(gx, period), mod(gy, period), seed);
      const fx = gx + (h & 0xffff) / 65536;
      const fy = gy + (h >>> 16) / 65536;
      const d = Math.hypot(fx - x, fy - y);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Linearly remap a Float32Array to [0,1] using its own min/max (optionally clipped percentiles). */
export function normalize(arr, lowPct = 0, highPct = 1) {
  let lo, hi;
  if (lowPct > 0 || highPct < 1) {
    const s = Float32Array.from(arr).sort();
    lo = s[Math.floor(lowPct * (s.length - 1))];
    hi = s[Math.floor(highPct * (s.length - 1))];
  } else {
    lo = Infinity; hi = -Infinity;
    for (const a of arr) { if (a < lo) lo = a; if (a > hi) hi = a; }
  }
  const k = 1 / Math.max(hi - lo, 1e-9);
  for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, Math.max(0, (arr[i] - lo) * k));
  return arr;
}

/** Rank-equalise to a uniform histogram (used for the white/blue-noise channel). */
export function equalize(arr) {
  const idx = Array.from(arr.keys()).sort((a, b) => arr[a] - arr[b]);
  const out = new Float32Array(arr.length);
  for (let r = 0; r < idx.length; r++) out[idx[r]] = (r + 0.5) / idx.length;
  return out;
}

/** Separable box blur with wrap-around edges (keeps tiling). Repeated 3× ≈ Gaussian. */
export function blurWrap(src, w, h, radius, passes = 3) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  const n = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += a[y * w + mod(k, w)];
      for (let x = 0; x < w; x++) {
        b[y * w + x] = s / n;
        s += a[y * w + mod(x + radius + 1, w)] - a[y * w + mod(x - radius, w)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += b[mod(k, h) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / n;
        s += b[mod(y + radius + 1, h) * w + x] - b[mod(y - radius, h) * w + x];
      }
    }
  }
  return a;
}

/** Evaluate f(u,v) over a w×h grid (u,v at pixel corners so the tile wraps exactly). */
export function field(w, h, f) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f(x / w, y / h);
  return out;
}
