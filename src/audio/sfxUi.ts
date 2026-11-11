/**
 * UI and reward sounds: short, soft, premium. No raw square/saw beeps — every tone is a few
 * band-limited partials with smooth envelopes, often with a breath of filtered noise and a small
 * baked room so they sit in front of the mix without poking out.
 */
import {
  additive,
  applyEnv,
  brown,
  envAD,
  envASR,
  filter,
  filter2,
  mixInto,
  mixPan,
  pink,
  reverb,
  rr,
  sawPartials,
  softClip,
  stereo,
  sweptSine,
  white,
  widen,
  type Rng,
  type Stereo,
} from './dsp';

const note = (semisFromA4: number): number => 440 * Math.pow(2, semisFromA4 / 12);

/** Soft bell: a few slightly inharmonic partials, upper ones decaying faster. */
function bell(sr: number, f: number, dur: number, decay: number, bright = 1): Float32Array {
  const n = Math.ceil(sr * dur);
  const x = additive(n, sr, f, [
    { ratio: 1, amp: 1, decay },
    { ratio: 2.0, amp: 0.32 * bright, decay: decay * 0.55 },
    { ratio: 3.01, amp: 0.14 * bright, decay: decay * 0.35 },
    { ratio: 4.12, amp: 0.07 * bright, decay: decay * 0.22 },
    { ratio: 5.43, amp: 0.035 * bright, decay: decay * 0.15 },
  ]);
  return applyEnv(x, sr, (t) => Math.min(1, t / 0.003));
}

/** Short damped tick. */
function tick(sr: number, r: Rng, f: number, tau: number, noise = 0.3): Float32Array {
  const n = Math.ceil(sr * (tau * 6 + 0.01));
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += f / sr;
    x[i] = Math.sin(ph * Math.PI * 2) * Math.exp(-t / tau) * Math.min(1, t / 0.0006) + (r() * 2 - 1) * noise * Math.exp(-t / 0.0006);
  }
  return x;
}

export function uiHover(sr: number, r: Rng): Stereo {
  const st = stereo(sr, 0.09);
  const x = tick(sr, r, 3300, 0.0055, 0.2);
  filter(x, sr, 'highpass', 900);
  mixPan(st, x, 0, 0.6, -0.08);
  mixPan(st, widen(x, sr, 3), 0, 0.6, 0.08);
  return st;
}

export function uiClick(sr: number, r: Rng): Stereo {
  const st = stereo(sr, 0.2);
  const a = tick(sr, r, 1350, 0.016, 0.25);
  const b = tick(sr, r, 2950, 0.007, 0);
  const body = tick(sr, r, 210, 0.022, 0);
  mixInto(a, b, 0, 0.45);
  mixInto(a, body, 0, 0.55);
  mixPan(st, a, 0, 0.8, 0);
  return reverb(st, { room: 0.2, wet: 0.06 });
}

export function uiBack(sr: number, r: Rng): Stereo {
  const st = stereo(sr, 0.28);
  const a = tick(sr, r, 1150, 0.014, 0.2);
  const b = tick(sr, r, 760, 0.02, 0.15);
  mixPan(st, a, 0, 0.7, 0.05);
  mixPan(st, b, 0.065 * sr, 0.75, -0.05);
  return reverb(st, { room: 0.2, wet: 0.06 });
}

/** Start: rising air swell that lands on a deep hit and a wide, dark-but-hopeful chord bloom. */
export function uiStart(sr: number, r: Rng): Stereo {
  const dur = 2.4;
  const st = stereo(sr, dur);
  const land = 0.42;
  const swell = pink(Math.ceil(sr * dur), r);
  filter(swell, sr, 'bandpass', (t) => 250 * Math.pow(18, Math.min(1, (t * dur) / land)), 1.3);
  applyEnv(swell, sr, (t) => (t < land ? Math.pow(t / land, 2.2) : Math.exp(-(t - land) / 0.12)));
  mixPan(st, swell, 0, 0.55, -0.2);
  mixPan(st, widen(swell, sr, 61), 0, 0.55, 0.2);
  // Deep landing hit.
  const hit = sweptSine(Math.ceil(sr * 1.2), sr, (t) => 42 + 40 * Math.exp(-t / 0.05), (t) => envAD(t, 0.002, 0.3));
  softClip(hit, 1.8);
  mixPan(st, hit, land * sr, 0.9, 0);
  // Chord bloom: D minor add9 voiced wide (D3 A3 E4 F4 A4), warm soft-saw partials, low-passed.
  const chord = [-19, -12, -5, -4, 0];
  chord.forEach((s, k) => {
    const n = Math.ceil(sr * (dur - land));
    const v = additive(n, sr, note(s) * (1 + (k - 2) * 0.0015), sawPartials(10, 1.6));
    filter2(v, sr, 'lowpass', (t) => 2400 * Math.exp(-t * 2.2) + 500, 0.6);
    applyEnv(v, sr, (t) => envAD(t, 0.025, 0.65));
    mixPan(st, v, land * sr, 0.16, (k / (chord.length - 1)) * 1.2 - 0.6);
  });
  // A bright confirmation bell on top.
  mixPan(st, bell(sr, note(12), 1.2, 0.5, 0.7), land * sr, 0.22, 0.15);
  return reverb(st, { room: 0.82, damp: 0.45, wet: 0.3, predelay: 0.02 });
}

/** Near miss: airy whoosh plus a soft tone gliding up a fifth — quick and rewarding, not cheesy. */
export function nearMiss(sr: number, r: Rng): Stereo {
  const dur = 0.85;
  const st = stereo(sr, dur);
  const n = Math.ceil(sr * dur);
  const air = white(n, r);
  filter(air, sr, 'bandpass', (t) => 2800 * Math.pow(0.28, t), 1.3);
  applyEnv(air, sr, (t) => envASR(t, 0.09, 0.02, 0.4));
  mixPan(st, air, 0, 0.9, -0.3);
  mixPan(st, widen(air, sr, 67), 0, 0.9, 0.3);
  const tone = additive(n, sr, (t) => {
    const tt = t * dur;
    return note(7) * Math.pow(1.5, Math.min(1, Math.max(0, (tt - 0.03) / 0.16)));
  }, [
    { ratio: 1, amp: 1 },
    { ratio: 2, amp: 0.25 },
    { ratio: 3, amp: 0.08 },
  ]);
  applyEnv(tone, sr, (t) => envAD(t - 0.02, 0.04, 0.22));
  mixPan(st, tone, 0, 0.17, 0.1);
  return reverb(st, { room: 0.5, wet: 0.16 });
}

/** Bonus: three-note rising bell arpeggio (E major), crisp but soft. */
export function bonus(sr: number, r: Rng): Stereo {
  const dur = 1.3;
  const st = stereo(sr, dur);
  const notes = [7, 11, 14, 19];
  notes.forEach((s, k) => {
    mixPan(st, bell(sr, note(s), 1.0, 0.32, 0.8), k * 0.065 * sr, 0.42 - k * 0.04, -0.3 + k * 0.2);
  });
  const sparkle = white(Math.ceil(sr * 0.5), r);
  filter(sparkle, sr, 'highpass', 7000);
  applyEnv(sparkle, sr, (t) => envAD(t - 0.12, 0.05, 0.12));
  mixPan(st, sparkle, 0, 0.06, 0.4);
  return reverb(st, { room: 0.6, wet: 0.22 });
}

/** Warning: clean two-pulse alert, rounded tone, no square-wave harshness. */
export function warning(sr: number, r: Rng): Stereo {
  const dur = 0.6;
  const st = stereo(sr, dur);
  for (const [at, f] of [[0, 880], [0.2, 880]] as const) {
    const n = Math.ceil(sr * 0.14);
    const x = additive(n, sr, f, [
      { ratio: 1, amp: 1 },
      { ratio: 2, amp: 0.3 },
      { ratio: 3, amp: 0.12 },
      { ratio: 0.5, amp: 0.25 },
    ]);
    applyEnv(x, sr, (t) => envASR(t, 0.006, 0.085, 0.035));
    mixPan(st, x, at * sr, 0.6, 0);
  }
  return reverb(st, { room: 0.3, wet: 0.1 });
}

/** Game over: a low, dark sting — sub impact, minor cluster pad sinking, distant metallic air. */
export function gameOver(sr: number, r: Rng): Stereo {
  const dur = 4.2;
  const st = stereo(sr, dur);
  const hit = sweptSine(Math.ceil(sr * 2), sr, (t) => 36 + 30 * Math.exp(-t / 0.08), (t) => envAD(t, 0.003, 0.7));
  softClip(hit, 2);
  mixPan(st, hit, 0, 0.95, 0);
  const boom = brown(Math.ceil(sr * 2.5), r);
  filter2(boom, sr, 'lowpass', 180);
  applyEnv(boom, sr, (t) => envAD(t, 0.01, 0.6));
  mixPan(st, boom, 0, 0.6, -0.2);
  mixPan(st, widen(boom, sr, 71), 0, 0.6, 0.2);
  // D minor with a flat-9 colour, pitch sinking a little as it fades.
  const chord = [-31, -24, -21, -17, -11];
  chord.forEach((s, k) => {
    const n = Math.ceil(sr * dur);
    const v = additive(n, sr, (t) => note(s) * (1 - 0.03 * t) * (1 + (k - 2) * 0.002), sawPartials(14, 1.3));
    filter2(v, sr, 'lowpass', (t) => 1100 * Math.exp(-t * 2.5) + 220, 0.7);
    applyEnv(v, sr, (t) => envASR(t, 0.04, 0.4, 3.2));
    mixPan(st, v, 0, 0.11, (k / (chord.length - 1)) * 1.0 - 0.5);
  });
  const air = white(Math.ceil(sr * dur), r);
  filter(air, sr, 'bandpass', 2300, 6);
  applyEnv(air, sr, (t) => envASR(t, 0.6, 0.6, 2.2));
  mixPan(st, air, 0, 0.12, 0.3);
  return reverb(st, { room: 0.9, damp: 0.6, wet: 0.35, predelay: 0.03 });
}

/** New best: bright rising A-major arpeggio over a warm swell, with a sparkle tail. */
export function newBest(sr: number, r: Rng): Stereo {
  const dur = 2.6;
  const st = stereo(sr, dur);
  const notes = [0, 4, 7, 12, 16, 19];
  notes.forEach((s, k) => {
    mixPan(st, bell(sr, note(s), 1.6, 0.6, 0.9), k * 0.075 * sr, 0.3, -0.5 + k * 0.2);
  });
  [-12, -5, 0, 4].forEach((s, k) => {
    const n = Math.ceil(sr * dur);
    const v = additive(n, sr, note(s) * (1 + (k - 1.5) * 0.002), sawPartials(8, 1.7));
    filter(v, sr, 'lowpass', 1500, 0.6);
    applyEnv(v, sr, (t) => envASR(t, 0.35, 0.4, 1.6));
    mixPan(st, v, 0, 0.07, k % 2 ? 0.4 : -0.4);
  });
  const sparkle = new Float32Array(Math.ceil(sr * dur));
  for (let k = 0; k < 40; k++) {
    const at = rr(r, 0.3, 2.0);
    const p = tick(sr, r, rr(r, 4000, 9000), rr(r, 0.01, 0.03), 0);
    mixInto(sparkle, p, at * sr, 0.1 * r());
  }
  mixPan(st, sparkle, 0, 0.8, -0.3);
  mixPan(st, widen(sparkle, sr, 79), 0, 0.8, 0.3);
  return reverb(st, { room: 0.75, wet: 0.28, predelay: 0.02 });
}
