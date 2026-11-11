import { describe, expect, it } from 'vitest';
import { PATTER_CREST, PATTER_LOOP_S, renderLoops } from '../src/audio/loops';
import type { Stereo } from '../src/audio/dsp';

const SR = 48000;

/** The loudest short events of a loop: sample index of each peak. */
function events(x: Float32Array, sr: number, count: number): number[] {
  const hop = Math.round(sr * 0.001);
  const env: number[] = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let m = 0;
    for (let k = 0; k < hop; k++) m = Math.max(m, Math.abs(x[i + k]));
    env.push(m);
  }
  const order = env.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const picked: number[] = [];
  for (const [, i] of order) {
    if (picked.every((p) => Math.abs(p - i) > 20)) picked.push(i);
    if (picked.length >= count) break;
  }
  return picked.map((i) => i * hop);
}

/**
 * How much an event rings: correlation of its first 6 ms with itself three periods later (period from the
 * zero crossings). A decaying sine scores near 1, a burst of filtered noise near 0.
 */
function ringing(x: Float32Array, sr: number, at: number): number {
  const a = Math.max(0, at - Math.round(sr * 0.0005));
  const n = Math.round(sr * 0.006);
  if (a + n >= x.length) return 0;
  let zc = 0;
  for (let i = 1; i < n; i++) if (x[a + i] >= 0 !== x[a + i - 1] >= 0) zc++;
  if (zc < 2) return 0;
  const period = (2 * n) / zc;
  const lag = Math.min(Math.round(3 * period), Math.floor(n / 2));
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i + lag < n; i++) {
    ab += x[a + i] * x[a + i + lag];
    aa += x[a + i] * x[a + i];
    bb += x[a + i + lag] * x[a + i + lag];
  }
  return Math.abs(ab) / Math.sqrt(aa * bb + 1e-20);
}

const median = (v: number[]): number => [...v].sort((p, q) => p - q)[v.length >> 1];
const rms = (st: Stereo): number => {
  let s = 0;
  for (const ch of [st.L, st.R]) for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
  return Math.sqrt(s / (st.L.length * 2));
};
const peak = (st: Stereo): number => {
  let m = 0;
  for (const ch of [st.L, st.R]) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
};

describe('rain patter loop', () => {
  const patter = renderLoops(SR).rainPatter;

  it('is long, so its pattern is not heard coming round', () => {
    expect(patter.L.length).toBe(Math.round(PATTER_LOOP_S * SR));
    expect(PATTER_LOOP_S).toBeGreaterThan(10);
  });

  it('has no drop that sticks out: the loudest one stays near PATTER_CREST times the RMS', () => {
    expect(peak(patter) / rms(patter)).toBeLessThan(PATTER_CREST * 1.15);
    expect(peak(patter)).toBeLessThanOrEqual(1.25); // normalised to RMS 0.25
  });

  it('is made of noise pats, not ringing tones (the tuned-percussion sound)', () => {
    const r = events(patter.L, SR, 40).map((at) => ringing(patter.L, SR, at));
    expect(median(r)).toBeLessThan(0.3); // the ringing version scored 0.53, this one 0.15
  });

  it('is seamless: no step where the loop wraps', () => {
    for (const ch of [patter.L, patter.R]) {
      const n = ch.length;
      let typical = 0;
      for (let i = 1; i < n; i++) typical = Math.max(typical, Math.abs(ch[i] - ch[i - 1]));
      expect(Math.abs(ch[0] - ch[n - 1])).toBeLessThanOrEqual(typical);
    }
  });
});
