/**
 * Seamless loop textures for the continuous layers (rain, tyre spray, skid, scrape, noise beds).
 * Rendered once per sample rate (≈ 0.5 s of CPU at 48 kHz) in the render worker (render.ts) and cached
 * as AudioBuffers for the page lifetime (they survive an AudioContext rebuild).
 */
import {
  brown,
  filter,
  makeLoop,
  mixPan,
  normalizeRms,
  pink,
  resonate,
  rng,
  rr,
  white,
  type Mode,
  type Stereo,
} from './dsp';

export interface LoopSet {
  white: Stereo;
  brown: Stereo;
  rainShower: Stereo;
  rainPatter: Stereo;
  tyreSpray: Stereo;
  skid: Stereo;
  scrape: Stereo;
}

export const LOOP_NAMES = ['white', 'brown', 'rainShower', 'rainPatter', 'tyreSpray', 'skid', 'scrape'] as const;

const cache = new Map<number, LoopSet>();

/** Cached render (main-thread fallback / sandbox). */
export function getLoops(sr: number): LoopSet {
  let s = cache.get(sr);
  if (!s) {
    s = renderLoops(sr);
    cache.set(sr, s);
  }
  return s;
}

/** Uncached render (the render worker transfers the result, so it must not keep it). */
export function renderLoops(sr: number): LoopSet {
  {
    const s: LoopSet = {
      white: makeLoop(sr, 4, 0.05, (st) => {
        st.L.set(white(st.L.length, rng(11)));
        st.R.set(white(st.R.length, rng(12)));
      }),
      brown: makeLoop(sr, 4, 0.4, (st) => {
        st.L.set(brown(st.L.length, rng(21)));
        st.R.set(brown(st.R.length, rng(22)));
      }),
      rainShower: rainShower(sr),
      rainPatter: rainPatter(sr),
      tyreSpray: tyreSpray(sr),
      skid: skidLoop(sr),
      scrape: scrapeLoop(sr),
    };
    for (const st of Object.values(s)) normalizeRms(st, 0.25);
    return s;
  }
}

/** Steady shower: wide, decorrelated hiss with a soft low "body" and a dense micro-droplet texture. */
function rainShower(sr: number): Stereo {
  return makeLoop(sr, 7.3, 0.6, (st) => {
    const n = st.L.length;
    for (const [ch, seed] of [[st.L, 31], [st.R, 32]] as const) {
      const r = rng(seed);
      const bed = pink(n, r);
      filter(bed, sr, 'highpass', 380, 0.6);
      filter(bed, sr, 'peak', 4800, 0.7, 4);
      filter(bed, sr, 'lowpass', 11000, 0.6);
      const body = brown(n, r);
      filter(body, sr, 'lowpass', 260);
      // Micro droplets: thousands of tiny clicks per second, slowly fluctuating density.
      const drops = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const dens = 0.035 * (0.75 + 0.25 * Math.sin((i / sr) * 0.9 + seed));
        if (r() < dens) drops[i] = (r() * 2 - 1) * Math.pow(r(), 2.5);
      }
      filter(drops, sr, 'highpass', 2500, 0.7);
      filter(drops, sr, 'lowpass', 9000, 0.7);
      for (let i = 0; i < n; i++) ch[i] = bed[i] * 0.55 + body[i] * 0.12 + drops[i] * 0.9;
    }
  });
}

/** Length of the patter loop in seconds. */
export const PATTER_LOOP_S = 11.7;
/** Drops per second before the density curve thins them out (about 20 a second remain, most of them faint). */
export const PATTER_RATE = 30;
/** The loudest drops are held at this many times the loop's RMS (12 dB): a drop must never stick out as a "ping". */
export const PATTER_CREST = 4;

/**
 * Close patter on the car body. Every drop is a short burst of filtered NOISE: a dull pat on a panel, a lighter
 * tick on glass, now and then a soft thud on the roof. No ringing tones: the first version rang every drop as a
 * sine between 0.9 and 5.6 kHz, 95 times a second, as loud as the rain itself, and that played like a thin tuned
 * percussion instrument that never stopped. Drops are sparse, mostly faint, come in waves like real rain, and the
 * loop is long (11.7 s, not a multiple of the shower's 7.3 s) so the pattern is not heard coming round.
 */
function rainPatter(sr: number): Stereo {
  const st = makeLoop(sr, PATTER_LOOP_S, 0.5, (st) => {
    const n = st.L.length;
    const r = rng(41);
    const dur = n / sr;
    const drop = (f: number, q: number, decay: number, attack: number): Float32Array => {
      const len = Math.ceil(sr * (attack + decay * 6));
      const o = white(len, r);
      filter(o, sr, 'bandpass', f, q);
      filter(o, sr, 'lowpass', Math.min(f * 2.2, 6000), 0.6);
      let peak = 1e-9;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        o[i] *= t < attack ? t / attack : Math.exp(-(t - attack) / decay); // soft onset: a pat, not a click
        peak = Math.max(peak, Math.abs(o[i]));
      }
      for (let i = 0; i < len; i++) o[i] /= peak;
      return o;
    };
    const count = Math.round(dur * PATTER_RATE);
    for (let k = 0; k < count; k++) {
      const t = r() * dur;
      const kind = r();
      const amp = 0.06 + Math.pow(r(), 4) * 0.94;
      const pan = rr(r, -0.9, 0.9);
      // Rain comes in waves: where the slow density curve is low, most drops are left out.
      const dens = 0.62 + 0.38 * Math.sin(t * 0.83 + 1.1) * Math.sin(t * 0.29 + 0.4);
      if (r() > dens) continue;
      const at = Math.floor(t * sr);
      if (kind < 0.66) mixPan(st, drop(rr(r, 320, 1300), rr(r, 0.8, 1.5), rr(r, 0.006, 0.016), 0.0012), at, amp, pan); // body panel
      else if (kind < 0.93) mixPan(st, drop(rr(r, 1400, 3000), rr(r, 0.9, 1.6), rr(r, 0.0025, 0.006), 0.0006), at, amp * 0.6, pan); // glass
      else mixPan(st, drop(rr(r, 110, 240), 0.9, rr(r, 0.018, 0.03), 0.003), at, amp * 1.2, pan * 0.5); // roof thud
    }
    filter(st.L, sr, 'highpass', 120);
    filter(st.R, sr, 'highpass', 120);
  });
  // Hold the few loud drops down (smoothly, so nothing is squared off). A few passes, because taking the
  // loud drops down also lowers the RMS the limit is measured against.
  for (let pass = 0; pass < 4; pass++) {
    const k = PATTER_CREST * Math.max(1e-9, Math.sqrt((sumSq(st.L) + sumSq(st.R)) / (st.L.length + st.R.length)));
    for (const ch of [st.L, st.R]) for (let i = 0; i < ch.length; i++) ch[i] = k * Math.tanh(ch[i] / k);
  }
  return st;
}

function sumSq(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s;
}

/** Wet tyre spray: fizzy broadband "shhh" with fine water crackle; speed moves it via playbackRate. */
function tyreSpray(sr: number): Stereo {
  return makeLoop(sr, 4.1, 0.3, (st) => {
    const n = st.L.length;
    for (const [ch, seed] of [[st.L, 51], [st.R, 52]] as const) {
      const r = rng(seed);
      const bed = pink(n, r);
      filter(bed, sr, 'highpass', 500, 0.6);
      filter(bed, sr, 'peak', 2600, 0.8, 5);
      const crackle = new Float32Array(n);
      for (let i = 0; i < n; i++) if (r() < 0.02) crackle[i] = (r() * 2 - 1) * Math.pow(r(), 2);
      filter(crackle, sr, 'bandpass', 4200, 0.8);
      for (let i = 0; i < n; i++) ch[i] = bed[i] * 0.6 + crackle[i] * 2.2;
    }
  });
}

/** Wet-road slide: mostly hiss with a soft, wandering, stick-slip squeal component (wet tyres don't scream). */
function skidLoop(sr: number): Stereo {
  return makeLoop(sr, 3.2, 0.25, (st) => {
    const n = st.L.length;
    for (const [ch, seed] of [[st.L, 61], [st.R, 62]] as const) {
      const r = rng(seed);
      const hiss = white(n, r);
      filter(hiss, sr, 'bandpass', 2400, 0.7);
      const sq = white(n, r);
      const p = r() * 6;
      filter(sq, sr, 'bandpass', (t) => 1150 + 180 * Math.sin(t * 9 + p) + 90 * Math.sin(t * 23 + p * 2), 28);
      filter(sq, sr, 'bandpass', (t) => 1150 + 180 * Math.sin(t * 9 + p) + 90 * Math.sin(t * 23 + p * 2), 6);
      // Stick-slip flutter.
      let env = 0.5;
      for (let i = 0; i < n; i++) {
        if ((i & 255) === 0) env = 0.45 + 0.55 * r();
        ch[i] = hiss[i] * 0.55 + sq[i] * 7 * env;
      }
    }
  });
}

const metalModes = (r: () => number, count: number, lo: number, hi: number, t60: [number, number]): Mode[] =>
  Array.from({ length: count }, () => ({ f: lo * Math.pow(hi / lo, r()), t60: rr(r, t60[0], t60[1]), amp: rr(r, 0.3, 1) }));

/** Metal grinding on concrete: dense stick-slip impacts through inharmonic sheet-metal modes + grit. */
function scrapeLoop(sr: number): Stereo {
  return makeLoop(sr, 3.0, 0.25, (st) => {
    const n = st.L.length;
    for (const [ch, seed] of [[st.L, 71], [st.R, 72]] as const) {
      const r = rng(seed);
      const exc = new Float32Array(n);
      for (let i = 0; i < n; i++) if (r() < 0.012) exc[i] = (r() * 2 - 1) * (0.3 + r());
      const modes = metalModes(r, 14, 700, 6500, [0.03, 0.14]);
      const ring = resonate(exc, sr, modes);
      const grit = white(n, r);
      filter(grit, sr, 'highpass', 2800, 0.7);
      let env = 1;
      for (let i = 0; i < n; i++) {
        if ((i & 127) === 0) env = 0.35 + 0.65 * r();
        ch[i] = ring[i] * 0.5 + grit[i] * 0.22 * env;
      }
    }
  });
}
