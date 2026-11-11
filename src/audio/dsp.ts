/**
 * Tiny offline DSP toolkit used to synthesise every one-shot and loop buffer at load time.
 *
 * Everything here works on plain Float32Arrays at the AudioContext sample rate, so the result is
 * deterministic (seeded RNG), costs nothing at runtime beyond a BufferSource, and needs no
 * third-party samples. Filters are RBJ-cookbook biquads (transposed direct form II).
 */

export type Rng = () => number;

/** Seeded mulberry32 — same algorithm as core/math makeRng, kept local so the audio module stays standalone. */
export function rng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rr = (r: Rng, a: number, b: number): number => a + (b - a) * r();
/** Approx. gaussian (sum of 3 uniforms), mean 0, sd ≈ 1. */
export const gauss = (r: Rng): number => (r() + r() + r() - 1.5) * 2;
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-9, g));
const TAU = Math.PI * 2;

export interface Stereo {
  sr: number;
  L: Float32Array;
  R: Float32Array;
}

export function stereo(sr: number, seconds: number): Stereo {
  const n = Math.max(1, Math.ceil(sr * seconds));
  return { sr, L: new Float32Array(n), R: new Float32Array(n) };
}
export const mono = (sr: number, seconds: number): Float32Array => new Float32Array(Math.max(1, Math.ceil(sr * seconds)));

// ───────────────────────────────────────────── noise

export function white(n: number, r: Rng): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = r() * 2 - 1;
  return o;
}

/** Paul Kellet's refined pink filter (≈ -3 dB/oct), roughly unit peak. */
export function pink(n: number, r: Rng): Float32Array {
  const o = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return o;
}

/** Leaky-integrated white noise (≈ -6 dB/oct), roughly unit RMS·3. */
export function brown(n: number, r: Rng): Float32Array {
  const o = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    y = (y + 0.02 * (r() * 2 - 1)) * 0.997;
    o[i] = y * 3.5;
  }
  return o;
}

// ───────────────────────────────────────────── filters

export type FilterType = 'lowpass' | 'highpass' | 'bandpass' | 'peak' | 'lowshelf' | 'highshelf' | 'notch';

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;
  constructor(
    private readonly sr: number,
    public type: FilterType = 'lowpass',
    f = 1000,
    q = 0.707,
    gainDb = 0,
  ) {
    this.set(f, q, gainDb);
  }
  set(f: number, q = 0.707, gainDb = 0): this {
    const sr = this.sr;
    f = Math.min(Math.max(f, 5), sr * 0.49);
    q = Math.max(q, 0.05);
    const w = (TAU * f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (this.type) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass': // constant 0 dB peak gain
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peak':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/**
 * Filter `x` in place. `f` may be a function of normalised time 0..1 (sweeps); coefficients are then
 * refreshed every 32 samples, which is smooth enough for any sweep we do.
 */
export function filter(
  x: Float32Array,
  sr: number,
  type: FilterType,
  f: number | ((t: number) => number),
  q = 0.707,
  gainDb = 0,
): Float32Array {
  const n = x.length;
  const fn = typeof f === 'function' ? f : null;
  const bq = new Biquad(sr, type, fn ? fn(0) : (f as number), q, gainDb);
  for (let i = 0; i < n; i++) {
    if (fn && (i & 31) === 0) bq.set(fn(i / n), q, gainDb);
    x[i] = bq.tick(x[i]);
  }
  return x;
}

/** Cascade the same filter twice (24 dB/oct-ish slopes). */
export function filter2(x: Float32Array, sr: number, type: FilterType, f: number | ((t: number) => number), q = 0.707): Float32Array {
  return filter(filter(x, sr, type, f, q), sr, type, f, q);
}

/** One-pole DC blocker; every rendered buffer goes through it so nothing carries an offset. */
export function dcBlock(x: Float32Array, sr: number, hz = 18): Float32Array {
  const R = Math.exp((-TAU * hz) / sr);
  let x1 = 0, y1 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] - x1 + R * y1;
    x1 = x[i];
    y1 = y;
    x[i] = y;
  }
  return x;
}

/** Bank of two-pole resonators driven by `input` (modal synthesis of struck metal / glass / bodies). */
export interface Mode {
  f: number;
  /** 60 dB decay time-ish (s) — actually the amplitude time-constant × 6.9. */
  t60: number;
  amp: number;
}
export function resonate(input: Float32Array, sr: number, modes: Mode[], out?: Float32Array): Float32Array {
  const n = input.length;
  const o = out ?? new Float32Array(n);
  for (const m of modes) {
    if (m.f >= sr * 0.47) continue;
    const r = Math.exp(-6.9 / (m.t60 * sr));
    const w = (TAU * m.f) / sr;
    const c1 = 2 * r * Math.cos(w);
    const c2 = -r * r;
    // Impulse response is r^n·sin((n+1)w)/sin(w): scaling by sin(w) gives ≈ unit peak per unit impulse.
    const gn = m.amp * Math.sin(w);
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = input[i] * gn + c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
      o[i] += y;
    }
  }
  return o;
}

// ───────────────────────────────────────────── shaping & envelopes

/** Exponential decay envelope with a short linear attack. */
export function envAD(t: number, attack: number, tau: number): number {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / tau);
}
/** Smooth bump: rises over `a`, holds, releases over `r` (raised cosine edges). */
export function envASR(t: number, a: number, hold: number, r: number): number {
  if (t < 0) return 0;
  if (t < a) return 0.5 - 0.5 * Math.cos((Math.PI * t) / a);
  if (t < a + hold) return 1;
  const u = (t - a - hold) / r;
  return u >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * u);
}

export function applyEnv(x: Float32Array, sr: number, env: (t: number) => number, offset = 0): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] *= env(i / sr - offset);
  return x;
}

export function softClip(x: Float32Array, drive = 1): Float32Array {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / k;
  return x;
}

export function scale(x: Float32Array, g: number): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Mix `src` into `dst` starting at sample `at` (clipped to dst length). */
export function mixInto(dst: Float32Array, src: Float32Array, at = 0, gain = 1): void {
  at = Math.round(at);
  const n = Math.min(src.length, dst.length - at);
  for (let i = Math.max(0, -at); i < n; i++) dst[at + i] += src[i] * gain;
}

/** Equal-power pan a mono source into a stereo buffer. */
export function mixPan(dst: Stereo, src: Float32Array, at: number, gain: number, pan: number): void {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  mixInto(dst.L, src, at, gain * Math.cos(a));
  mixInto(dst.R, src, at, gain * Math.sin(a));
}

/** Copy of `x` with independent-ish second channel via a short decorrelating allpass chain. */
export function widen(x: Float32Array, sr: number, seed: number): Float32Array {
  const y = x.slice();
  const r = rng(seed);
  for (let k = 0; k < 4; k++) {
    const d = Math.round(sr * rr(r, 0.0011, 0.0063));
    const g = 0.55;
    const buf = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < y.length; i++) {
      const bd = buf[p];
      const v = y[i] + g * bd;
      y[i] = bd - g * v;
      buf[p] = v;
      p = (p + 1) % d;
    }
  }
  return y;
}

// ───────────────────────────────────────────── oscillators

/** Band-limited additive tone. `freq` may vary over normalised time; partials above 0.45·sr are dropped. */
export function additive(
  n: number,
  sr: number,
  freq: number | ((t: number) => number),
  partials: { ratio: number; amp: number; decay?: number }[],
): Float32Array {
  const o = new Float32Array(n);
  const fn = typeof freq === 'function' ? freq : null;
  const phases = new Float64Array(partials.length);
  for (let i = 0; i < n; i++) {
    const f0 = fn ? fn(i / n) : (freq as number);
    const t = i / sr;
    let s = 0;
    for (let k = 0; k < partials.length; k++) {
      const p = partials[k];
      const f = f0 * p.ratio;
      if (f >= sr * 0.45) continue;
      phases[k] += f / sr;
      const d = p.decay ? Math.exp(-t / p.decay) : 1;
      s += Math.sin(TAU * phases[k]) * p.amp * d;
    }
    o[i] = s;
  }
  return o;
}

/** Soft band-limited sawtooth-ish partial set (1/n with gentle roll-off) — warm, never buzzy. */
export const sawPartials = (count: number, rolloff = 1.15): { ratio: number; amp: number }[] =>
  Array.from({ length: count }, (_, i) => ({ ratio: i + 1, amp: 1 / Math.pow(i + 1, rolloff) }));

/** Sine with exponential pitch glide f(t) and amplitude envelope. Used for thumps and bubbles. */
export function sweptSine(n: number, sr: number, f: (t: number) => number, env: (t: number) => number): Float32Array {
  const o = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += f(t) / sr;
    o[i] = Math.sin(TAU * ph) * env(t);
  }
  return o;
}

// ───────────────────────────────────────────── reverb (Freeverb-style) for baked tails

export function reverb(
  st: Stereo,
  opts: { room?: number; damp?: number; wet?: number; dry?: number; predelay?: number; seed?: number } = {},
): Stereo {
  const { room = 0.8, damp = 0.4, wet = 0.3, dry = 1, predelay = 0.01 } = opts;
  const sr = st.sr;
  const k = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const aps = [556, 441, 341, 225];
  const fb = 0.7 + 0.28 * room;
  const pd = Math.round(predelay * sr);
  const run = (x: Float32Array, spread: number): Float32Array => {
    const n = x.length;
    const out = new Float32Array(n);
    const inp = new Float32Array(n);
    for (let i = pd; i < n; i++) inp[i] = x[i - pd] * 0.015;
    for (const c of combs) {
      const len = Math.round((c + spread) * k);
      const buf = new Float32Array(len);
      let p = 0, lp = 0;
      for (let i = 0; i < n; i++) {
        const y = buf[p];
        lp = y * (1 - damp) + lp * damp;
        buf[p] = inp[i] + lp * fb;
        out[i] += y;
        p = p + 1 === len ? 0 : p + 1;
      }
    }
    for (const a of aps) {
      const len = Math.round((a + spread) * k);
      const buf = new Float32Array(len);
      let p = 0;
      for (let i = 0; i < n; i++) {
        const b = buf[p];
        const v = out[i];
        out[i] = b - v;
        buf[p] = v + b * 0.5;
        p = p + 1 === len ? 0 : p + 1;
      }
    }
    return out;
  };
  const wl = run(st.L, 0);
  const wr = run(st.R, 23);
  for (let i = 0; i < st.L.length; i++) {
    st.L[i] = st.L[i] * dry + wl[i] * wet;
    st.R[i] = st.R[i] * dry + wr[i] * wet;
  }
  return st;
}

// ───────────────────────────────────────────── utilities

export function peakOf(st: Stereo): number {
  let p = 0;
  for (let i = 0; i < st.L.length; i++) {
    const a = Math.abs(st.L[i]);
    const b = Math.abs(st.R[i]);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

export function normalize(st: Stereo, target = 0.9): Stereo {
  const p = peakOf(st);
  if (p > 1e-9) {
    const g = target / p;
    scale(st.L, g);
    scale(st.R, g);
  }
  return st;
}

export function rmsOf(st: Stereo): number {
  let e = 0;
  for (let i = 0; i < st.L.length; i++) e += st.L[i] * st.L[i] + st.R[i] * st.R[i];
  return Math.sqrt(e / (2 * st.L.length));
}

/** Scale to a target RMS (loops: makes layer gains mean the same thing for every texture). */
export function normalizeRms(st: Stereo, target = 0.25): Stereo {
  const r = rmsOf(st);
  if (r > 1e-9) {
    scale(st.L, target / r);
    scale(st.R, target / r);
  }
  return st;
}

/** Short raised-cosine fades so no buffer starts/ends with a click; then DC-block both channels. */
export function finish(st: Stereo, fadeIn = 0.001, fadeOut = 0.03): Stereo {
  dcBlock(st.L, st.sr);
  dcBlock(st.R, st.sr);
  const n = st.L.length;
  const fi = Math.max(1, Math.round(fadeIn * st.sr));
  const fo = Math.max(1, Math.round(fadeOut * st.sr));
  for (let i = 0; i < fi && i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    st.L[i] *= g;
    st.R[i] *= g;
  }
  for (let i = 0; i < fo && i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
    st.L[n - 1 - i] *= g;
    st.R[n - 1 - i] *= g;
  }
  return st;
}

/**
 * Make a seamless loop: render `seconds + xfade`, then equal-power crossfade the tail over the head.
 * The render callback receives the total length to produce.
 */
export function makeLoop(sr: number, seconds: number, xfade: number, render: (st: Stereo) => void): Stereo {
  const full = stereo(sr, seconds + xfade);
  render(full);
  const n = Math.round(seconds * sr);
  const x = Math.round(xfade * sr);
  const out = stereo(sr, seconds);
  for (const ch of ['L', 'R'] as const) {
    const src = full[ch];
    dcBlock(src, sr);
    const dst = out[ch];
    dst.set(src.subarray(0, n));
    for (let i = 0; i < x; i++) {
      const t = i / x;
      const a = Math.sin((t * Math.PI) / 2); // fade-in of the head
      const b = Math.cos((t * Math.PI) / 2); // fade-out of the tail continuing past the end
      dst[i] = src[i] * a + src[n + i] * b;
    }
  }
  return out;
}

export function toAudioBuffer(ctx: BaseAudioContext, st: Stereo): AudioBuffer {
  const b = ctx.createBuffer(2, st.L.length, st.sr);
  b.copyToChannel(st.L as Float32Array<ArrayBuffer>, 0);
  b.copyToChannel(st.R as Float32Array<ArrayBuffer>, 1);
  return b;
}

/** Highest rate procedural buffers are rendered at (source nodes resample to the context rate). */
export const MAX_RENDER_SR = 48000;
export const renderRate = (ctxSr: number): number => Math.min(ctxSr, MAX_RENDER_SR);

/** Context-free AudioBuffer (usable by any AudioContext; survives a context rebuild). */
export function makeBuffer(st: Stereo, ctx?: BaseAudioContext): AudioBuffer {
  let b: AudioBuffer;
  try {
    b = new AudioBuffer({ numberOfChannels: 2, length: st.L.length, sampleRate: st.sr });
  } catch (e) {
    if (!ctx) throw e;
    b = ctx.createBuffer(2, st.L.length, st.sr);
  }
  b.copyToChannel(st.L as Float32Array<ArrayBuffer>, 0);
  b.copyToChannel(st.R as Float32Array<ArrayBuffer>, 1);
  return b;
}
