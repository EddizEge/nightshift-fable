/**
 * Generated impulse response for the tunnel convolution reverb: a long concrete tube.
 * Early part = flutter echoes between the side walls (~10 m apart) and the ceiling, then a
 * dense diffuse tail with frequency-dependent decay (concrete keeps the lows, air eats the highs).
 * RT60 ≈ 2.2 s in the mids.
 */
import { filter, rng, rr, stereo, type Stereo } from './dsp';

export function tunnelImpulse(sr: number, rt60 = 2.2, seed = 77): Stereo {
  const len = rt60 * 1.25;
  const st = stereo(sr, len);
  const n = st.L.length;
  const r = rng(seed);
  for (const [ch, side] of [[st.L, 0], [st.R, 1]] as const) {
    // Three bands of noise with their own decay times.
    const bands: [Float32Array, number][] = [];
    const mk = () => {
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = r() * 2 - 1;
      return x;
    };
    const low = filter(filter(mk(), sr, 'lowpass', 320), sr, 'lowpass', 320);
    const mid = filter(filter(mk(), sr, 'bandpass', 1200, 0.5), sr, 'highpass', 250);
    const high = filter(mk(), sr, 'highpass', 3200);
    bands.push([low, rt60 * 1.2], [mid, rt60], [high, rt60 * 0.5]);
    const gains = [1.0, 0.8, 0.35];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // Tail builds up over the first ~40 ms (diffusion grows), no sharp onset.
      const build = Math.min(1, t / 0.04);
      let s = 0;
      for (let b = 0; b < 3; b++) s += bands[b][0][i] * gains[b] * Math.exp((-6.9 * t) / bands[b][1]);
      ch[i] = s * build * 0.5;
    }
    // Early reflections: walls at ≈ ±5 m (flutter, period ≈ 29 ms) and a 6 m ceiling.
    const wallPeriod = 0.029 + side * 0.0013;
    for (let k = 1; k < 40; k++) {
      const t = 0.011 + k * wallPeriod * rr(r, 0.97, 1.03);
      const i = Math.round(t * sr);
      if (i >= n) break;
      const g = 0.55 * Math.exp((-6.9 * t) / (rt60 * 0.8)) * (k % 2 === side ? 1 : 0.7);
      // Smear each reflection over a few samples so it is not a hard click.
      for (let j = -6; j <= 6; j++) if (i + j >= 0 && i + j < n) ch[i + j] += g * Math.exp(-(j * j) / 8) * (r() < 0.5 ? 1 : -1) * 0.5;
    }
    const ceil = Math.round((0.035 + side * 0.002) * sr);
    for (let j = -8; j <= 8; j++) ch[ceil + j] += 0.35 * Math.exp(-(j * j) / 12);
  }
  // Energy-normalise so the reverb send level is predictable.
  let e = 0;
  for (let i = 0; i < n; i++) e += st.L[i] * st.L[i] + st.R[i] * st.R[i];
  const g = 1 / Math.sqrt(e / 2);
  for (let i = 0; i < n; i++) {
    st.L[i] *= g;
    st.R[i] *= g;
  }
  return st;
}
