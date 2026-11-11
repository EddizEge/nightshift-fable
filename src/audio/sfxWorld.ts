/**
 * Procedural recipes for world one-shots: impacts, glass, scrapes, explosions, thunder, water,
 * nitro, horn, pass-by. Each recipe renders a stereo buffer from a seeded RNG (variants = seeds).
 * Levels are normalised later by the bank, so recipes only care about internal layer balance.
 */
import {
  applyEnv,
  brown,
  envAD,
  envASR,
  filter,
  filter2,
  mixInto,
  mixPan,
  pink,
  resonate,
  reverb,
  rr,
  softClip,
  stereo,
  sweptSine,
  white,
  widen,
  additive,
  sawPartials,
  type Mode,
  type Rng,
  type Stereo,
} from './dsp';

// ───────────────────────────────────────────── building blocks

/** Pitch-dropping sine thump with a little saturation so it reads on small speakers too. */
function thump(sr: number, dur: number, f0: number, f1: number, sweepTau: number, tau: number, drive = 1.6): Float32Array {
  const x = sweptSine(
    Math.ceil(sr * dur),
    sr,
    (t) => f1 + (f0 - f1) * Math.exp(-t / sweepTau),
    (t) => envAD(t, 0.003, tau),
  );
  return softClip(x, drive);
}

/** Filtered noise with an envelope. */
function burst(sr: number, r: Rng, dur: number, env: (t: number) => number, shape: (x: Float32Array) => void, color: 'white' | 'pink' | 'brown' = 'white'): Float32Array {
  const n = Math.ceil(sr * dur);
  const x = color === 'white' ? white(n, r) : color === 'pink' ? pink(n, r) : brown(n, r);
  shape(x);
  return applyEnv(x, sr, env);
}

const inharmonic = (r: Rng, count: number, lo: number, hi: number, t60: [number, number], ampPow = 1): Mode[] =>
  Array.from({ length: count }, () => ({ f: lo * Math.pow(hi / lo, r()), t60: rr(r, t60[0], t60[1]), amp: Math.pow(rr(r, 0.2, 1), ampPow) }));

/** Struck-metal body: a short noisy excitation through a bank of inharmonic plate modes. */
function metalHit(sr: number, r: Rng, dur: number, modes: Mode[], excLen = 0.002, at = 0): Float32Array {
  const n = Math.ceil(sr * dur);
  const exc = new Float32Array(n);
  const e = Math.ceil(excLen * sr);
  const a = Math.round(at * sr);
  for (let i = 0; i < e && a + i < n; i++) exc[a + i] = (r() * 2 - 1) * (1 - i / e);
  return resonate(exc, sr, modes);
}

/** Sparse crackle: random impulses with time-varying density through a band-pass. */
function crackle(sr: number, r: Rng, dur: number, density: (t: number) => number, band: [number, number], q = 1.2): Float32Array {
  const n = Math.ceil(sr * dur);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (r() < density(i / sr) / sr) {
      const amp = Math.pow(r(), 1.8) * (r() < 0.5 ? -1 : 1);
      const len = Math.ceil(sr * rr(r, 0.0003, 0.002));
      for (let j = 0; j < len && i + j < n; j++) x[i + j] += amp * (1 - j / len) * (r() * 2 - 1);
    }
  }
  const f = Math.sqrt(band[0] * band[1]);
  filter(x, sr, 'bandpass', f, q);
  filter(x, sr, 'highpass', band[0] * 0.7);
  return x;
}

/** Mono → stereo via mid/side: the side channel is a decorrelated copy, so it is wide but mono-safe. */
function toStereo(sr: number, dur: number, x: Float32Array, seed: number, width = 0.5): Stereo {
  const st = stereo(sr, dur);
  const d = widen(x, sr, seed);
  const m = 1 - width * 0.3;
  const sd = width * 0.5;
  const n = Math.min(st.L.length, x.length);
  for (let i = 0; i < n; i++) {
    st.L[i] = x[i] * m + d[i] * sd;
    st.R[i] = x[i] * m - d[i] * sd;
  }
  return st;
}

// ───────────────────────────────────────────── glass

export function glass(sr: number, r: Rng, size = 1): Stereo {
  const dur = 1.2 + 0.3 * size;
  const st = stereo(sr, dur);
  // Initial fracture crack.
  const crack = burst(sr, r, 0.03, (t) => envAD(t, 0.0003, 0.004), (x) => filter(x, sr, 'highpass', 2500));
  mixPan(st, crack, 0, 0.9, 0);
  // Shards: bright two-partial pings, dense at first, then the falling bits tinkling.
  const shards = Math.round(90 * size);
  for (let k = 0; k < shards; k++) {
    const early = k < shards * 0.7;
    const t0 = early ? -Math.log(1 - r() * 0.98) * 0.07 : rr(r, 0.15, dur - 0.25);
    const f = rr(r, 2600, 10500);
    const len = rr(r, 0.012, early ? 0.07 : 0.11);
    const n = Math.ceil(sr * len * 4);
    const s = new Float32Array(n);
    let p1 = r(), p2 = r();
    const ratio = rr(r, 1.47, 2.3);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      p1 += f / sr;
      p2 += (f * ratio) / sr;
      s[i] = (Math.sin(p1 * 6.2832) + 0.45 * Math.sin(p2 * 6.2832) + (r() * 2 - 1) * 0.6 * Math.exp(-t / 0.0007)) * Math.exp(-t / len);
    }
    const amp = (early ? 0.5 : 0.28) * Math.pow(r(), 1.4) * Math.exp(-t0 / 0.6);
    mixPan(st, s, t0 * sr, amp, rr(r, -0.85, 0.85));
  }
  // Grainy shatter noise bed.
  const bed = burst(sr, r, 0.5, (t) => envAD(t, 0.001, 0.08), (x) => {
    filter(x, sr, 'highpass', 3500);
    filter(x, sr, 'peak', 7000, 1, 4);
  });
  mixPan(st, bed, 0, 0.35, -0.2);
  mixPan(st, widen(bed, sr, 3), 0, 0.35, 0.2);
  return reverb(st, { room: 0.35, damp: 0.5, wet: 0.12 });
}

// ───────────────────────────────────────────── crashes

export function crashLight(sr: number, r: Rng): Stereo {
  const dur = 1.0;
  const st = stereo(sr, dur);
  const body = thump(sr, 0.5, 150, 85, 0.03, 0.07, 1.4);
  mixPan(st, body, 0, 0.9, 0);
  const panel = metalHit(sr, r, dur, inharmonic(r, 12, 260, 4200, [0.05, 0.3]), 0.003);
  mixPan(st, panel, 0, 0.55, -0.15);
  mixPan(st, widen(panel, sr, 5), 0, 0.45, 0.15);
  // Plastic bumper crack + tiny rattles.
  mixPan(st, burst(sr, r, 0.05, (t) => envAD(t, 0.0004, 0.006), (x) => filter(x, sr, 'bandpass', 2600, 0.8)), 0, 0.8, 0.1);
  for (let k = 0; k < 6; k++) {
    const at = rr(r, 0.04, 0.35);
    const hit = metalHit(sr, r, 0.25, inharmonic(r, 5, 900, 5000, [0.02, 0.08]), 0.001);
    mixPan(st, hit, at * sr, 0.25 * Math.exp(-at / 0.2), rr(r, -0.7, 0.7));
  }
  return reverb(st, { room: 0.3, wet: 0.1 });
}

export function crashHeavy(sr: number, r: Rng): Stereo {
  const dur = 2.4;
  const st = stereo(sr, dur);
  // Low body thump: two tonnes stopping.
  mixPan(st, thump(sr, 1.0, 95, 48, 0.06, 0.2, 2.2), 0, 1.0, 0);
  mixPan(st, burst(sr, r, 0.6, (t) => envAD(t, 0.002, 0.09), (x) => filter2(x, sr, 'lowpass', 420), 'pink'), 0, 0.8, 0);
  // Metal crunch: a cascade of micro-impacts through crumpling sheet modes, density falling off.
  const crunchModes = inharmonic(r, 18, 180, 5200, [0.04, 0.22]);
  const exc = new Float32Array(Math.ceil(sr * dur));
  const impacts = 55;
  for (let k = 0; k < impacts; k++) {
    const t0 = -Math.log(1 - r() * 0.97) * 0.11;
    const i0 = Math.round(t0 * sr);
    const len = Math.ceil(sr * rr(r, 0.0008, 0.004));
    const a = Math.pow(r(), 0.8) * Math.exp(-t0 / 0.35);
    for (let j = 0; j < len && i0 + j < exc.length; j++) exc[i0 + j] += (r() * 2 - 1) * a;
  }
  const crunch = resonate(exc, sr, crunchModes);
  const grit = filter(exc.slice(), sr, 'highpass', 1800);
  for (let i = 0; i < crunch.length; i++) crunch[i] = crunch[i] * 0.8 + grit[i] * 1.4;
  mixPan(st, crunch, 0, 0.6, -0.2);
  mixPan(st, widen(crunch, sr, 9), 0, 0.6, 0.2);
  // Glass layer.
  const g = glass(sr, r, 0.8);
  mixInto(st.L, g.L, 0.012 * sr, 0.5);
  mixInto(st.R, g.R, 0.012 * sr, 0.5);
  // Debris tail: bits of trim and glass skittering.
  const tail = crackle(sr, r, dur, (t) => (t < 0.25 ? 0 : 160 * Math.exp(-(t - 0.25) / 0.5)), [1500, 7000], 0.9);
  mixPan(st, tail, 0, 0.6, -0.3);
  mixPan(st, widen(tail, sr, 13), 0, 0.6, 0.3);
  return reverb(st, { room: 0.55, damp: 0.45, wet: 0.14 });
}

/** One-shot metal scrape (a sideswipe): grinding with stick-slip, sparks hiss, ~1 s. */
export function scrape(sr: number, r: Rng): Stereo {
  const dur = 1.1;
  const n = Math.ceil(sr * dur);
  const exc = new Float32Array(n);
  for (let i = 0; i < n; i++) if (r() < 0.018) exc[i] = (r() * 2 - 1) * (0.3 + r());
  const ring = resonate(exc, sr, inharmonic(r, 16, 600, 6800, [0.03, 0.15]));
  const sparks = white(n, r);
  filter(sparks, sr, 'highpass', 3500);
  let env = 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if ((i & 127) === 0) env = 0.4 + 0.6 * r();
    const t = i / sr;
    x[i] = (ring[i] * 0.7 + sparks[i] * 0.25 * env) * envASR(t, 0.02, 0.55, 0.45);
  }
  // A small initial contact clunk.
  mixInto(x, thump(sr, 0.3, 140, 90, 0.03, 0.05), 0, 0.5);
  return reverb(toStereo(sr, dur, x, 17, 0.6), { room: 0.3, wet: 0.08 });
}

// ───────────────────────────────────────────── explosions

export function explosion(sr: number, r: Rng, big = false): Stereo {
  const dur = big ? 6.5 : 3.8;
  const st = stereo(sr, dur);
  // 1. Sharp crack transient (supersonic front): very short, full band.
  const crack = burst(sr, r, 0.05, (t) => envAD(t, 0.0002, big ? 0.009 : 0.006), (x) => {
    filter(x, sr, 'highpass', 600);
    filter(x, sr, 'peak', 3500, 0.8, 4);
  });
  softClip(crack, 2);
  mixPan(st, crack, 0, 1.0, -0.05);
  mixPan(st, widen(crack, sr, 23), 0, 0.8, 0.05);
  // 2. Sub-bass thump 60 → 35 Hz (big: 52 → 30 Hz, longer).
  const sub = thump(sr, big ? 2.2 : 1.4, big ? 54 : 62, big ? 30 : 36, big ? 0.35 : 0.25, big ? 0.55 : 0.36, 2.0);
  mixPan(st, sub, 0, 1.25, 0);
  // Body of the blast: low-passed noise slam whose cutoff falls.
  const slam = burst(sr, r, 1.6, (t) => envAD(t, 0.002, big ? 0.35 : 0.22), (x) => {
    filter2(x, sr, 'lowpass', (t) => 2200 * Math.exp(-t * 4) + 250, 0.7);
  }, 'pink');
  softClip(slam, 1.8);
  mixPan(st, slam, 0, 0.9, -0.1);
  mixPan(st, widen(slam, sr, 29), 0, 0.9, 0.1);
  // 3. Roaring fire tail: turbulent low-mid roar with slow random swells.
  const fireDur = dur;
  const fire = burst(sr, r, fireDur, (t) => envAD(t, 0.06, big ? 1.8 : 0.9) * (t < 0.04 ? 0 : 1), (x) => {
    filter2(x, sr, 'lowpass', 750, 0.6);
    filter(x, sr, 'highpass', 60);
  }, 'brown');
  {
    // Turbulence: multiply by smoothed random envelope (2–9 Hz flicker).
    let a = 1, target = 1;
    for (let i = 0; i < fire.length; i++) {
      if (i % Math.round(sr * 0.06) === 0) target = 0.55 + 0.9 * r();
      a += (target - a) * 0.0012;
      fire[i] *= a;
    }
  }
  mixPan(st, fire, 0, 0.9, -0.35);
  mixPan(st, widen(fire, sr, 31), 0, 0.9, 0.35);
  // Big: secondary rolling rumble (pressure wave echoing off buildings / overpasses).
  if (big) {
    for (let k = 0; k < 7; k++) {
      const at = rr(r, 0.4, 3.2);
      const rum = burst(sr, r, 2.2, (t) => envASR(t, rr(r, 0.1, 0.35), 0.1, rr(r, 0.8, 1.6)), (x) => filter2(x, sr, 'lowpass', rr(r, 140, 320)), 'brown');
      mixPan(st, rum, at * sr, rr(r, 0.35, 0.7) * Math.exp(-at / 2.5), rr(r, -0.7, 0.7));
    }
  }
  // 4. Debris crackle: metal and glass raining down.
  const deb = crackle(sr, r, dur, (t) => (t < 0.15 ? 0 : (big ? 260 : 170) * Math.exp(-(t - 0.15) / (big ? 1.6 : 0.9))), [1200, 6500], 0.8);
  mixPan(st, deb, 0, 0.8, -0.4);
  mixPan(st, widen(deb, sr, 37), 0, 0.8, 0.4);
  for (let k = 0; k < (big ? 22 : 12); k++) {
    const at = rr(r, 0.3, dur * 0.7);
    const hit = metalHit(sr, r, 0.35, inharmonic(r, 6, 500, 4800, [0.03, 0.12]), 0.001);
    mixPan(st, hit, at * sr, 0.3 * Math.exp(-at / 1.5), rr(r, -0.8, 0.8));
  }
  return reverb(st, { room: big ? 0.85 : 0.75, damp: 0.55, wet: 0.22, predelay: 0.03 });
}

// ───────────────────────────────────────────── weather

/** Distant rolling thunder, 4.5–6 s: muffled onset, several overlapping low rumbles drifting across. */
export function thunder(sr: number, r: Rng): Stereo {
  const dur = rr(r, 4.8, 6.2);
  const st = stereo(sr, dur);
  // Muffled initial crack (distance has eaten the highs).
  const crack = burst(sr, r, 0.6, (t) => envASR(t, 0.02, 0.05, 0.4), (x) => filter2(x, sr, 'lowpass', 1100), 'pink');
  mixPan(st, crack, rr(r, 0, 0.1) * sr, 0.45, rr(r, -0.4, 0.4));
  // Rolling rumbles with a drifting pan.
  const rolls = 16;
  for (let k = 0; k < rolls; k++) {
    const at = Math.pow(r(), 1.5) * (dur - 1.8);
    const len = rr(r, 1.0, 2.4);
    const rum = burst(sr, r, len, (t) => envASR(t, rr(r, 0.08, 0.5), rr(r, 0, 0.3), len * 0.6), (x) => {
      filter2(x, sr, 'lowpass', rr(r, 110, 380), 0.7);
      filter(x, sr, 'highpass', 28);
    }, 'brown');
    mixPan(st, rum, at * sr, rr(r, 0.4, 1) * Math.exp(-at / 2.6), Math.sin(k * 0.9 + r() * 2) * 0.7);
  }
  // Long low sigh at the end.
  const tail = burst(sr, r, dur, (t) => envASR(t, 0.6, 1.0, dur - 1.6), (x) => filter2(x, sr, 'lowpass', 120), 'brown');
  mixPan(st, tail, 0, 0.35, 0);
  return reverb(st, { room: 0.92, damp: 0.7, wet: 0.35, predelay: 0.05 });
}

/** Heavy splash: impact slap, water body, droplets and bubbles. */
export function splash(sr: number, r: Rng): Stereo {
  const dur = 1.2;
  const st = stereo(sr, dur);
  const slap = burst(sr, r, 0.4, (t) => envAD(t, 0.002, 0.06), (x) => {
    filter(x, sr, 'lowpass', 3200);
    filter(x, sr, 'highpass', 200);
  }, 'pink');
  mixPan(st, slap, 0, 0.9, -0.1);
  mixPan(st, widen(slap, sr, 41), 0, 0.9, 0.1);
  const body = burst(sr, r, 0.9, (t) => envASR(t, 0.02, 0.05, 0.6), (x) => filter(x, sr, 'bandpass', (t) => 700 - 350 * t, 0.9), 'white');
  mixPan(st, body, 0.01 * sr, 0.6, 0);
  // Falling droplets: "plips" (bubble resonance = rising sine chirp).
  for (let k = 0; k < 34; k++) {
    const at = rr(r, 0.06, 1.0);
    const f0 = rr(r, 700, 2200);
    const len = rr(r, 0.01, 0.03);
    const b = sweptSine(Math.ceil(sr * len * 3), sr, (t) => f0 * (1 + 25 * t), (t) => envAD(t, 0.0008, len));
    mixPan(st, b, at * sr, 0.25 * Math.pow(r(), 1.2) * Math.exp(-at / 0.5), rr(r, -0.8, 0.8));
  }
  mixPan(st, crackle(sr, r, dur, (t) => 400 * Math.exp(-t / 0.25), [2000, 8000]), 0, 0.5, 0.3);
  return st;
}

// ───────────────────────────────────────────── nitro

export function nitroStart(sr: number, r: Rng): Stereo {
  const dur = 1.1;
  const st = stereo(sr, dur);
  // Solenoid click.
  mixPan(st, metalHit(sr, r, 0.08, [{ f: 3100, t60: 0.03, amp: 1 }, { f: 5200, t60: 0.02, amp: 0.6 }], 0.0006), 0, 0.5, 0);
  // Pressurised gas "pssht".
  const gas = burst(sr, r, 0.7, (t) => envAD(t - 0.012, 0.008, 0.18), (x) => {
    filter(x, sr, 'highpass', 1800);
    filter(x, sr, 'peak', 5200, 1.2, 5);
  });
  mixPan(st, gas, 0, 0.6, -0.15);
  mixPan(st, widen(gas, sr, 43), 0, 0.6, 0.15);
  // Rising whoosh as the charge hits.
  const whoosh = burst(sr, r, dur, (t) => envASR(t - 0.02, 0.35, 0.1, 0.55), (x) => filter(x, sr, 'bandpass', (t) => 350 * Math.pow(9, t), 1.4), 'pink');
  mixPan(st, whoosh, 0, 0.9, 0);
  // Low thump of the surge.
  mixPan(st, thump(sr, 0.6, 95, 55, 0.05, 0.12, 1.5), 0.03 * sr, 0.6, 0);
  return reverb(st, { room: 0.3, wet: 0.08 });
}

export function nitroEnd(sr: number, r: Rng): Stereo {
  const dur = 0.9;
  const st = stereo(sr, dur);
  // Blow-off: falling hiss with a short flutter.
  const bo = burst(sr, r, dur, (t) => envAD(t, 0.006, 0.22) * (1 - 0.35 * Math.max(0, Math.sin(t * 2 * Math.PI * 26)) * Math.exp(-t / 0.15)), (x) => {
    filter(x, sr, 'bandpass', (t) => 3200 * Math.pow(0.3, t), 1.1);
  });
  mixPan(st, bo, 0, 0.9, -0.1);
  mixPan(st, widen(bo, sr, 47), 0, 0.9, 0.1);
  // Small exhaust pop.
  const pop = burst(sr, r, 0.12, (t) => envAD(t - 0.05, 0.0005, 0.012), (x) => filter(x, sr, 'bandpass', 1500, 1));
  mixPan(st, pop, 0, 0.8, 0);
  return st;
}

// ───────────────────────────────────────────── traffic

/** Two-tone car horn: buzzy diaphragm tone through horn formants, slight pitch sag at onset. */
export function horn(sr: number, r: Rng): Stereo {
  const dur = rr(r, 0.65, 0.95);
  const n = Math.ceil(sr * dur);
  const x = new Float32Array(n);
  const f1 = rr(r, 405, 425);
  const f2 = f1 * 1.26; // ≈ a major third
  for (const [f, a] of [[f1, 1], [f2, 0.85]] as const) {
    const tone = additive(n, sr, (t) => f * (1 - 0.02 * Math.exp(-t * dur / 0.04)), sawPartials(18, 0.9));
    mixInto(x, tone, 0, a);
  }
  filter(x, sr, 'peak', 1700, 1.2, 7);
  filter(x, sr, 'peak', 3100, 1.5, 5);
  filter(x, sr, 'lowpass', 6500);
  filter(x, sr, 'highpass', 300);
  softClip(x, 1.6);
  applyEnv(x, sr, (t) => envASR(t, 0.012, dur - 0.08, 0.06));
  const st = toStereo(sr, dur + 0.3, x, 53, 0.3);
  return reverb(st, { room: 0.55, wet: 0.18, predelay: 0.02 });
}

/** Overtaking swish: tyre/wind noise with a Doppler pitch fall and a short loud peak. */
export function passBy(sr: number, r: Rng): Stereo {
  const dur = 1.3;
  const n = Math.ceil(sr * dur);
  const peak = rr(r, 0.38, 0.48);
  const env = (t: number) => Math.exp(-Math.pow((t - peak) / (t < peak ? 0.2 : 0.3), 2));
  const air = pink(n, r);
  filter(air, sr, 'bandpass', (t) => {
    const tt = t * dur;
    return 700 + 1300 / (1 + Math.exp((tt - peak) * 10));
  }, 0.9);
  applyEnv(air, sr, env);
  const roar = brown(n, r);
  filter2(roar, sr, 'lowpass', (t) => 260 + 260 / (1 + Math.exp((t * dur - peak) * 10)), 0.8);
  applyEnv(roar, sr, env);
  const hum = additive(n, sr, (t) => 95 + 40 / (1 + Math.exp((t * dur - peak) * 9)), sawPartials(6, 1.6));
  applyEnv(hum, sr, env);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = air[i] * 1.0 + roar[i] * 0.6 + hum[i] * 0.06;
  return toStereo(sr, dur, x, 59, 0.4);
}
