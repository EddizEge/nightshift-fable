/**
 * Audio sandbox / verification harness (we cannot listen, so we measure).
 *
 *  1. Scripted 12 s scenario through IAudio.update(): idle → full throttle through the gears →
 *     nitro → tunnel → brake. Master + bus analysers log RMS / peak / DC / spectral centroid and
 *     the engine's measured firing frequency vs the expected rpm/15 once per second.
 *  2. Every one-shot: exact stats from the rendered bank buffers (peak, RMS, duration, DC), then
 *     all of them played through IAudio.play() (positions, pans, delays) as a stress test while
 *     the master is metered for clipping.
 *  3. Console errors are counted; `window.__done` + `window.__result` signal completion.
 *
 * URL: sandbox/audio.html?auto=1 (runs immediately; the harness allows autoplay).
 */
import type { AudioFrame, GameState, SfxName } from '../core/types';
import { createAudio, SFX_NAMES, type NightshiftAudio } from '../audio';
import { Vector3 } from 'three';

declare global {
  interface Window {
    __ready?: boolean;
    __done?: boolean;
    __result?: unknown;
  }
}

const logEl = document.getElementById('log')!;
const out = (s: string): void => {
  console.log('[ns] ' + s);
  logEl.textContent += s + '\n';
};
let consoleErrors = 0;
const origErr = console.error.bind(console);
console.error = (...a: unknown[]) => {
  consoleErrors++;
  origErr(...a);
};
window.addEventListener('error', () => consoleErrors++);
window.addEventListener('unhandledrejection', () => consoleErrors++);

const db = (x: number): number => 20 * Math.log10(Math.max(1e-9, x));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Analyser tap with running peak / energy accumulators fed by polling. */
class Meter {
  readonly an: AnalyserNode;
  private td: Float32Array<ArrayBuffer>;
  private fd: Float32Array<ArrayBuffer>;
  peak = 0;
  sumSq = 0;
  sum = 0;
  count = 0;
  // Whole-run mean: true DC, not the slow low-frequency swing a 1 s window still sees.
  totSum = 0;
  totCount = 0;
  constructor(ctx: BaseAudioContext, src: AudioNode, fft = 16384) {
    this.an = ctx.createAnalyser();
    this.an.fftSize = fft;
    this.an.smoothingTimeConstant = 0;
    src.connect(this.an);
    this.td = new Float32Array(fft);
    this.fd = new Float32Array(fft / 2);
  }
  /** Poll the newest window (called often enough that windows overlap → no peak is missed). */
  poll(): void {
    this.an.getFloatTimeDomainData(this.td);
    // Only the newest ~60 ms enters the energy sums (poll period), the whole window feeds the peak.
    const fresh = Math.min(this.td.length, Math.round(this.an.context.sampleRate * 0.05));
    for (let i = 0; i < this.td.length; i++) {
      const v = this.td[i];
      const a = Math.abs(v);
      if (a > this.peak) this.peak = a;
      if (i >= this.td.length - fresh) {
        this.sumSq += v * v;
        this.sum += v;
        this.count++;
        this.totSum += v;
        this.totCount++;
      }
    }
  }
  reset(): { rmsDb: number; peakDb: number; dc: number; n: number } {
    const r = { rmsDb: db(Math.sqrt(this.sumSq / Math.max(1, this.count))), peakDb: db(this.peak), dc: this.sum / Math.max(1, this.count), n: this.count };
    this.peak = this.sumSq = this.sum = this.count = 0;
    return r;
  }
  spectrum(): Float32Array {
    this.an.getFloatFrequencyData(this.fd);
    return this.fd;
  }
  centroid(): number {
    const s = this.spectrum();
    const hz = this.an.context.sampleRate / this.an.fftSize;
    let num = 0, den = 0;
    for (let i = 1; i < s.length; i++) {
      const m = Math.pow(10, s[i] / 20);
      num += m * i * hz;
      den += m;
    }
    return den > 0 ? num / den : 0;
  }
  /** Level (dB above the median 20–1500 Hz floor) of the half, 1st and 2nd firing orders. */
  orders(f0: number): { o05: number; o1: number; o2: number } {
    const s = this.spectrum();
    const hz = this.an.context.sampleRate / this.an.fftSize;
    const band = Array.from(s.slice(Math.ceil(20 / hz), Math.floor(1500 / hz))).sort((a, b) => a - b);
    const floor = band[band.length >> 1];
    const at = (f: number) => {
      let m = -200;
      for (let k = Math.floor((f * 0.96) / hz); k <= Math.ceil((f * 1.04) / hz); k++) m = Math.max(m, s[k] ?? -200);
      return +(m - floor).toFixed(1);
    };
    return { o05: at(f0 / 2), o1: at(f0), o2: at(f0 * 2) };
  }
  /** Dominant peak in [lo, hi] Hz plus a harmonic-sum pitch estimate (robust to formant boosts). */
  pitch(lo: number, hi: number): { peak: number; hsum: number } {
    const s = this.spectrum();
    const hz = this.an.context.sampleRate / this.an.fftSize;
    const mag = (f: number) => {
      const i = f / hz;
      const a = Math.floor(i);
      let m = -200;
      for (let k = a - 1; k <= a + 2; k++) if (k > 0 && k < s.length) m = Math.max(m, s[k]);
      return Math.pow(10, m / 20);
    };
    let best = 0, bf = 0;
    for (let i = Math.ceil(lo / hz); i <= hi / hz; i++) if (s[i] > -150 && Math.pow(10, s[i] / 20) > best) { best = Math.pow(10, s[i] / 20); bf = i * hz; }
    let hb = 0, hf = 0;
    for (let f = lo; f <= hi; f += hz / 2) {
      // Weighted harmonic sum minus the half-harmonics (penalises octave-down errors).
      let sc = 0;
      for (let h = 1; h <= 6; h++) sc += mag(f * h) / Math.sqrt(h) - 0.5 * mag(f * (h - 0.5)) / Math.sqrt(h);
      if (sc > hb) { hb = sc; hf = f; }
    }
    return { peak: bf, hsum: hf };
  }
}

/** Simple scripted car: 6-speed box, nitro, tunnel and brake phases. */
function scenario(t: number, s: { speed: number; gear: number; rpm01: number }, dt: number): AudioFrame {
  const ratios = [0, 3.2, 2.2, 1.65, 1.3, 1.07, 0.9];
  let throttle = 0, brake = 0, skid = 0, tunnel = 0, nitro = false;
  let shifted = false;
  if (t < 2) throttle = 0;
  else if (t < 11) throttle = 1;
  else { brake = 1; skid = 0.35; }
  if (t >= 7 && t < 9) nitro = true;
  if (t >= 9 && t < 11) tunnel = Math.min(1, (t - 9) / 0.4);
  if (t >= 11) tunnel = Math.max(0, 1 - (t - 11) / 0.6);
  const accel = throttle * (nitro ? 16 : 11) * (1 - s.speed / 330) - brake * 28;
  s.speed = Math.max(0, s.speed + accel * dt * 3.6);
  // rpm from speed and gear (wheel-locked, clutch slip at very low speed keeps idle).
  const rpmFrom = (g: number) => Math.max(0, (s.speed / 300) * ratios[g] * 1.05);
  let r = rpmFrom(s.gear);
  if (r > 0.93 && s.gear < 6) { s.gear++; shifted = true; r = rpmFrom(s.gear); }
  if (brake > 0 && r < 0.35 && s.gear > 1) { s.gear--; shifted = true; r = rpmFrom(s.gear); }
  if (throttle > 0 && s.gear === 1) r = Math.max(r, 0.32); // launch: clutch slip holds revs
  s.rpm01 = Math.min(1, r);
  return {
    state: 'playing' as GameState,
    rpm01: s.rpm01, throttle, speedKmh: s.speed, skid, brake, nitroActive: nitro, rain: 0.85,
    tunnel, scrape: 0, timeScale: 1, shifted,
  };
}

/**
 * ?noworker=throw  — the Worker constructor throws (no Worker support / CSP that throws synchronously);
 * ?noworker=error  — the Worker is created but fails to load asynchronously (CSP worker-src without blob:
 *                    / data: as Chrome reports it today: an 'error' event, never a message).
 * Either way every buffer must still be rendered through the main-thread fallback.
 */
function simulateNoWorker(mode: string | null): void {
  if (!mode) return;
  const Native = window.Worker;
  class Broken extends EventTarget {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor() {
      super();
      if (mode === 'throw') throw new DOMException('Worker blocked (simulated)', 'SecurityError');
      setTimeout(() => {
        const e = new ErrorEvent('error', { message: 'Worker script blocked (simulated CSP)', cancelable: true });
        this.onerror?.(e);
        this.dispatchEvent(e);
      }, 30);
    }
    postMessage(): void {}
    terminate(): void {}
  }
  (window as unknown as { Worker: unknown }).Worker = Broken;
  out(`simulating ${mode === 'throw' ? 'a throwing Worker constructor' : 'a Worker that fails to load'} (native ${typeof Native})`);
}

async function run(): Promise<void> {
  simulateNoWorker(new URLSearchParams(location.search).get('noworker'));
  const audio = createAudio() as NightshiftAudio;
  // Before unlock everything must be a harmless no-op.
  audio.update(0.016, scenario(0, { speed: 0, gear: 1, rpm01: 0 }, 0.016));
  audio.play('explosion');
  const t0 = performance.now();
  await audio.unlock();
  const dbg = audio.debug();
  if (!dbg) throw new Error('audio did not unlock');
  out(`unlock ${(performance.now() - t0).toFixed(0)} ms · sr ${dbg.ctx.sampleRate} · worklet ${dbg.engineUsesWorklet} · state ${dbg.ctx.state}`);
  const ctx = dbg.ctx;
  const master = new Meter(ctx, dbg.master, 16384);
  // Constant ≈ 5.9 Hz resolution / 170 ms window whatever the device rate (a fixed 8192 at 96 kHz
  // gave 11.7 Hz bins: the 60 Hz idle firing frequency could not be resolved to ±6 %).
  const engFft = Math.max(2048, Math.min(32768, 2 ** Math.round(Math.log2((8192 * ctx.sampleRate) / 48000))));
  const eng = new Meter(ctx, dbg.buses.engine, engFft);
  const amb = new Meter(ctx, dbg.buses.ambience);
  const road = new Meter(ctx, dbg.buses.road);
  const rev = new Meter(ctx, dbg.reverb);
  const sfxM = new Meter(ctx, dbg.buses.sfx);
  const meters = [master, eng, amb, road, rev, sfxM];
  const poller = setInterval(() => meters.forEach((m) => m.poll()), 40);

  const result: Record<string, unknown> = { worklet: dbg.engineUsesWorklet };
  const rows: Record<string, number | string>[] = [];

  // ── 1. scenario
  const car = { speed: 0, gear: 1, rpm01: 0 };
  let last = performance.now();
  const start = last;
  let nextLog = 1;
  // rpm history so the expected firing frequency matches what the analyser window actually holds.
  const hist: { t: number; rpm: number }[] = [];
  const win = engFft / ctx.sampleRate;
  // Main-thread health during the scenario: the longest gap between frames (a stall starves both the
  // scripted car and the meters, which used to show up as bogus pitch / "silent" windows).
  let maxGap = 0;
  let winGap = 0;
  await new Promise<void>((done) => {
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      maxGap = Math.max(maxGap, now - last);
      winGap = Math.max(winGap, now - last);
      last = now;
      const t = (now - start) / 1000;
      const f = scenario(t, car, dt);
      audio.update(dt, f);
      hist.push({ t, rpm: 900 + f.rpm01 * 7300 });
      if (t >= nextLog) {
        const m = master.reset();
        const e = eng.reset();
        const a = amb.reset();
        const rd = road.reset();
        const rv = rev.reset();
        // Steady = the rpm target was flat over the analyser window plus the engine's settling time
        // (param ramp τ 35 ms + worklet smoothing ≈ 0.15 s), seen by enough frames to know it.
        const recent = hist.filter((h) => h.t > t - win - 0.15);
        const rpm = recent.reduce((a, h) => a + h.rpm, 0) / Math.max(1, recent.length);
        const spread = Math.max(...recent.map((h) => h.rpm)) - Math.min(...recent.map((h) => h.rpm));
        const seen = recent.length >= 5 && winGap < 100;
        const f0 = rpm / 15;
        const p = eng.pitch(25, 700);
        const row = {
          t: nextLog, rpm: Math.round(rpm), gear: car.gear, kmh: Math.round(car.speed), f0: +f0.toFixed(1),
          hsum: +p.hsum.toFixed(1), domPk: +p.peak.toFixed(1), ratio: +(p.hsum / f0).toFixed(2), steady: spread < rpm * 0.08 && seen ? 1 : 0, ...eng.orders(f0),
          masterRms: +m.rmsDb.toFixed(1), masterPk: +m.peakDb.toFixed(2), dc: +m.dc.toFixed(5),
          centroid: Math.round(master.centroid()), engRms: +e.rmsDb.toFixed(1), roadRms: +rd.rmsDb.toFixed(1),
          rainRms: +a.rmsDb.toFixed(1), revRms: +rv.rmsDb.toFixed(1), polls: m.n, gapMs: Math.round(winGap),
        };
        winGap = 0;
        rows.push(row);
        out(Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' '));
        nextLog++;
      }
      if (t < 12.05) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  result.scenario = rows;
  const dcRun = master.totSum / Math.max(1, master.totCount);
  out(`scenario DC (12 s mean at the master) ${dcRun.toExponential(2)} · longest frame gap ${maxGap.toFixed(0)} ms`);

  // ── 2a. one-shot buffer stats (exact, from the same bank play() uses)
  const shots: Record<string, unknown>[] = [];
  for (const name of SFX_NAMES) {
    const bufs = dbg.bank.render(name);
    for (let v = 0; v < bufs.length; v++) {
      const b = bufs[v];
      let pk = 0, ss = 0, sum = 0, lastLoud = 0;
      const n = b.length;
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < n; i++) {
          const a = Math.abs(d[i]);
          if (a > pk) pk = a;
          ss += d[i] * d[i];
          sum += d[i];
          if (a > 0.001 && i > lastLoud) lastLoud = i;
        }
      }
      const row = { name, v, peakDb: +db(pk).toFixed(1), rmsDb: +db(Math.sqrt(ss / (n * 2))).toFixed(1), dur: +(lastLoud / b.sampleRate).toFixed(2), len: +(n / b.sampleRate).toFixed(2), dc: +(sum / (n * 2)).toExponential(1) };
      shots.push(row);
      if (v === 0) out(`sfx ${name.padEnd(12)} peak ${row.peakDb} dBFS rms ${row.rmsDb} dBFS audible ${row.dur}s / ${row.len}s dc ${row.dc} (${bufs.length} variants)`);
    }
  }
  result.sfx = shots;

  // ── 2b. play every one-shot through play() with the game running (stress / clip test)
  master.reset();
  sfxM.reset();
  const listener = new Vector3(0, 1.2, 0);
  audio.setListener(listener, new Vector3(0, 0, -1));
  const loud: AudioFrame = { ...scenario(5, { speed: 200, gear: 4, rpm01: 0.8 }, 0), rpm01: 0.85, throttle: 1, speedKmh: 220, rain: 1 };
  const keep = setInterval(() => audio.update(0.016, loud), 16);
  const worst: { name: SfxName; pk: number }[] = [];
  for (let i = 0; i < SFX_NAMES.length; i++) {
    const name = SFX_NAMES[i];
    master.reset();
    audio.play(name, i % 3 === 0 ? { position: new Vector3((i % 2 ? 1 : -1) * 8, 0, -20) } : { pan: (i % 5) / 2 - 1, volume: 1 });
    await sleep(260);
    master.poll();
    worst.push({ name, pk: master.reset().peakDb });
  }
  // Pile-up: the loudest things at once, full engine, at the listener.
  for (const n of ['explosionBig', 'crashHeavy', 'glass', 'explosion', 'thunder', 'horn'] as SfxName[]) audio.play(n, { delay: 0.01 });
  audio.play('crashHeavy', { delay: 0.05, pan: 0.4 });
  audio.play('scrape', { delay: 0.02 });
  let pileMax = -200;
  for (let k = 0; k < 40; k++) {
    await sleep(100);
    master.poll();
    pileMax = Math.max(pileMax, master.reset().peakDb);
  }
  clearInterval(keep);
  const playMax = Math.max(...worst.map((w) => w.pk));
  out(`play() through master: max peak ${playMax.toFixed(2)} dBFS (${worst.map((w) => `${w.name}:${w.pk.toFixed(1)}`).join(' ')})`);
  out(`pile-up (explosionBig+explosion+2×crashHeavy+glass+thunder+horn+scrape, full engine): max peak ${pileMax.toFixed(2)} dBFS`);
  result.playMaxDb = playMax;
  result.pileMaxDb = pileMax;

  // ── 2c. state behaviour
  for (const st of ['paused', 'menu', 'gameover'] as GameState[]) {
    const f: AudioFrame = { ...loud, state: st };
    const iv = setInterval(() => audio.update(0.016, f), 16);
    await sleep(1500);
    master.reset();
    eng.reset();
    await sleep(600);
    master.poll();
    eng.poll();
    clearInterval(iv);
    const m = master.reset();
    const e = eng.reset();
    out(`state ${st.padEnd(8)} master rms ${m.rmsDb.toFixed(1)} dBFS · engine bus rms ${e.rmsDb.toFixed(1)} dBFS`);
    (result as Record<string, unknown>)['state_' + st] = { master: m.rmsDb, engine: e.rmsDb };
  }
  // Slow motion: same rpm, timeScale 0.3 → firing frequency must drop by the engine pitch factor.
  {
    const rpm01 = 0.6;
    const pitchF = 0.35 + 0.65 * 0.3;
    const f: AudioFrame = { ...loud, state: 'playing', rpm01, throttle: 1, nitroActive: false, timeScale: 0.3 };
    const iv = setInterval(() => audio.update(0.016, f), 16);
    await sleep(1200);
    const fExp = ((900 + rpm01 * 7300) / 15) * pitchF;
    const p = eng.pitch(25, 700);
    clearInterval(iv);
    const q = p.hsum / fExp;
    out(`slow motion (timeScale 0.3): expected firing ${fExp.toFixed(1)} Hz, measured ${p.hsum.toFixed(1)} Hz (ratio ${q.toFixed(2)})`);
    result.slowmoRatio = q;
  }
  clearInterval(poller);

  // ── 3. resilience: simulated device / renderer failures, worklet crash, OS suspend; settings survive.
  const res: { kind: string; ok: boolean; ms: number; lvl: number }[] = [];
  {
    audio.setMasterVolume(0.55);
    const iv = setInterval(() => audio.update(0.016, loud), 16);
    const waitUp = async (gen0: number, needNewGen: boolean, ms = 8000): Promise<number> => {
      const t1 = performance.now();
      while (performance.now() - t1 < ms) {
        const h = audio.health();
        if (h.state === 'running' && (!needNewGen || h.generation > gen0) && audio.level() > -60) return performance.now() - t1;
        await sleep(50);
      }
      return -1;
    };
    await sleep(400);
    for (const kind of ['error', 'close', 'worklet', 'suspend', 'stall'] as const) {
      const g0 = audio.health().generation;
      const r0 = audio.health().engineRestarts;
      audio.play('crashLight'); // in flight while the graph dies
      audio.debugFail(kind);
      // Public API must be harmless while down.
      audio.play('explosion');
      audio.setMuted(false);
      audio.setListener(new Vector3(NaN, 0, 0), new Vector3(0, 0, -1));
      audio.update(0.016, { ...loud, rpm01: NaN, speedKmh: Infinity });
      const rebuild = kind === 'error' || kind === 'close' || kind === 'stall';
      const ms = await waitUp(g0, rebuild, kind === 'stall' ? 12000 : 8000);
      await sleep(250);
      const h = audio.health();
      const lvl = audio.level();
      const ok = ms >= 0 && Math.abs(h.masterGain - 0.55) < 0.02 && (kind !== 'worklet' || (h.engineRestarts === r0 + 1 && h.worklet));
      res.push({ kind, ok, ms: Math.round(ms), lvl: +lvl.toFixed(1) });
      out(`resilience ${kind.padEnd(7)} back in ${ms.toFixed(0)} ms · level ${lvl.toFixed(1)} dBFS · gen ${h.generation} · rebuilds ${h.rebuilds} · engine restarts ${h.engineRestarts} · master gain ${h.masterGain.toFixed(2)} · live nodes ${h.nodesLive}`);
    }
    clearInterval(iv);
    audio.setMasterVolume(0.8);
  }

  // ── checks
  // Windows the meters were not fed in (main thread stalled) carry no level data: they fail the
  // stall check below instead of masquerading as silence.
  const sc = rows.filter((r) => (r.polls as number) > 0);
  const checks: [string, boolean][] = [];
  checks.push([`main thread kept running during the scenario (longest frame gap ${maxGap.toFixed(0)} ms < 250, ${rows.length - sc.length} unfed meter windows)`, maxGap < 250 && sc.length === rows.length]);
  checks.push(['worklet engine', dbg.engineUsesWorklet]);
  checks.push(['never silent (master rms > -45 dBFS)', sc.every((r) => (r.masterRms as number) > -45)]);
  checks.push(['no clipping in scenario (peak < -0.1 dBFS)', sc.every((r) => (r.masterPk as number) < -0.1)]);
  checks.push(['no clipping in sfx play / pile-up', playMax < -0.1 && pileMax < -0.1]);
  checks.push([`no DC offset (12 s mean ${dcRun.toExponential(1)}, |dc| < 1e-3)`, Math.abs(dcRun) < 1e-3]);
  // Steady-rpm windows only: the estimate must sit on the firing order (or its per-bank half order)
  // and the firing order itself must stand clearly out of the spectrum.
  const steady = sc.filter((r) => r.steady === 1);
  const tracked = steady.filter((r) => {
    const q = r.ratio as number;
    return (Math.abs(q - 1) < 0.06 || Math.abs(q - 0.5) < 0.03) && (r.o1 as number) > 10;
  }).length;
  checks.push([`engine pitch tracks rpm/15 (${tracked}/${steady.length} steady windows on order 1 or 0.5, order 1 > 10 dB over floor)`, steady.length >= 5 && tracked >= steady.length - 1]);
  const revOut = sc.filter((r) => (r.t as number) <= 8).map((r) => r.revRms as number);
  const revIn = sc.filter((r) => (r.t as number) >= 10 && (r.t as number) <= 11).map((r) => r.revRms as number);
  checks.push([`tunnel raises reverb (${Math.max(...revOut).toFixed(1)} → ${Math.min(...revIn).toFixed(1)} dBFS)`, Math.min(...revIn) > Math.max(...revOut) + 20]);
  const rainOut = sc.filter((r) => (r.t as number) <= 8).map((r) => r.rainRms as number);
  const rainIn = sc.filter((r) => r.t === 11).map((r) => r.rainRms as number);
  checks.push([`rain present outside (${Math.min(...rainOut).toFixed(1)} dBFS) and gone in tunnel (${rainIn[0]?.toFixed(1)} dBFS)`, Math.min(...rainOut) > -40 && rainIn[0] < Math.min(...rainOut) - 15]);
  checks.push(['every sfx buffer audible, < 0 dBFS, no DC', shots.every((s) => (s.peakDb as number) < 0 && (s.peakDb as number) > -30 && (s.dur as number) > 0.03 && Math.abs(Number(s.dc)) < 1e-3)]);
  const ps = result.state_paused as { master: number };
  checks.push(['paused ducks the mix', ps.master < (rows[5].masterRms as number) - 8]);
  const go = result.state_gameover as { engine: number };
  checks.push(['gameover fades engine out', go.engine < -60]);
  const sq = result.slowmoRatio as number;
  checks.push(['slow motion lowers engine pitch', Math.abs(sq - 1) < 0.06 || Math.abs(sq - 0.5) < 0.03]);
  checks.push([`survives device error / close / worklet crash / suspend / stall, settings kept (${res.map((r) => `${r.kind}:${r.ok ? r.ms + 'ms' : 'FAIL'}`).join(' ')})`, res.length === 5 && res.every((r) => r.ok)]);
  {
    const h = audio.health();
    const nw = new URLSearchParams(location.search).get('noworker');
    out(`render jobs ${h.renderJobs} · pending ${h.renderPending} · main-thread render ${h.mainThreadRenderMs} ms`);
    if (nw) checks.push([`no Worker (${nw}): every buffer rendered by the main-thread fallback (${h.renderJobs} jobs, ${h.mainThreadRenderMs} ms)`, h.renderPending === 0 && h.renderJobs > 0 && h.mainThreadRenderMs > 0]);
    else checks.push([`buffers rendered off the main thread (${h.renderJobs} jobs, main thread ${h.mainThreadRenderMs} ms)`, h.renderPending === 0 && h.mainThreadRenderMs === 0]);
  }
  checks.push([`no console errors (${consoleErrors})`, consoleErrors === 0]);
  let ok = true;
  for (const [name, pass] of checks) {
    ok &&= pass;
    out(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  }
  result.checks = checks;
  result.ok = ok;
  out(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
  window.__result = result;
  window.__done = true;
}

window.__ready = true;
const go = (): void => {
  run().catch((e) => {
    console.error('[ns] audio sandbox failed', e);
    window.__done = true;
  });
};
if (new URLSearchParams(location.search).has('auto')) go();
else document.getElementById('go')!.addEventListener('click', go, { once: true });
