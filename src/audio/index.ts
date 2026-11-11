/**
 * NIGHTSHIFT audio system (Web Audio only, fully procedural, no runtime downloads).
 *
 * Graph
 *   engine worklet ─► engineState ─► [engine bus] ─┐
 *   tyre spray, rumble, wind, skid, brake, scrape, nitro ─► roadDuck ─► [road bus] ─┤
 *   rain shower + patter ─► tunnel LP ─► ambDuck ─► [ambience bus] ─┤─► mix ─► pause LP ─► pause gain ─┐
 *   world one-shots ─► [sfx bus] ─┘                                                                    │
 *   engine / road / sfx buses ─► tunnel send ─► convolver (generated 2.2 s IR) ─► mix                  │
 *   [ui bus] (not ducked by pause) ───────────────────────────────────────────────────────────────────┤
 *                                                     master gain ─► compressor ─► limiter ─► soft clipper ─► out
 *
 * Autoplay: nothing (not even the AudioContext) exists before unlock(); update()/play() are no-ops
 * until the graph is ready. The context is suspended while the page is hidden.
 *
 * Resilience: the context's 'error' (audio device / renderer failure), 'statechange' (closed,
 * suspended, interrupted), mediaDevices 'devicechange', the engine worklet's 'processorerror' and a
 * stall watchdog (context clock not advancing while 'running') are all handled. A dead graph is torn
 * down (listeners removed, context closed) and rebuilt lazily from update() with back-off, at most
 * MAX_REBUILDS times in a row; after that the game runs silent. A suspended / interrupted context is
 * resumed, on the next user gesture if the browser insists. Every public method is a no-op while audio
 * is down and never throws. Volume / mute live on this object and are re-applied by every rebuild.
 * Buffers are rendered off the main thread (render.ts) and survive rebuilds.
 */
import type { AudioFrame, GameState, IAudio, SfxName, SfxOpts } from '../core/types';
import type { Vector3 } from 'three';
import { SfxBank, SFX, SFX_NAMES, type BusName } from './bank';
import { EngineVoice, IDLE_RPM, REDLINE_RPM } from './engine';
import { LOOP_NAMES } from './loops';
import { makeBuffer, renderRate } from './dsp';
import { runJob } from './jobs';
import { Renderer } from './render';

/** NaN-safe (NaN → 0): a bad frame value must never reach an AudioParam (non-finite values throw). */
const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
const fin = (x: number, d: number): number => (Number.isFinite(x) ? x : d);

interface Voice {
  name: SfxName;
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** Every node this voice created (all disconnected when it ends). */
  nodes: AudioNode[];
}

/** Rebuilds in a row (without 20 s of healthy audio in between) before running silent. */
const MAX_REBUILDS = 5;
const BACKOFF_MS = [250, 1000, 3000, 8000, 15000];
/** Context clock frozen this long while 'running' and visible = dead device. */
const STALL_MS = 4000;
/** Global cap on simultaneous one-shot voices (each sound also has its own `poly`). */
const MAX_VOICES = 28;
/** The same sound started again within this window (context time) is merged into the previous one. */
const MIN_GAP = 0.03;
/** Level of the drops on the car body in full rain (the shower bed is 0.36). */
export const PATTER_GAIN = 0.12;
/** Brake pad noise: Q of each of the two band-passes at 3150 Hz, and its level at full squeal. */
export const BRAKE_Q = 14;
export const BRAKE_GAIN = 1.6;

type LoopBuffers = Record<(typeof LOOP_NAMES)[number], AudioBuffer>;
/** Page-lifetime caches of context-free buffers, keyed by rate (survive context rebuilds). */
const loopCache = new Map<number, Promise<LoopBuffers>>();
const irCache = new Map<number, Promise<AudioBuffer>>();

/** Tunnel IR at the context rate (a convolver requires it), rendered in the worker. */
function irBuffer(r: Renderer, sr: number, ctx: BaseAudioContext): Promise<AudioBuffer> {
  let p = irCache.get(sr);
  if (!p) {
    p = r.request({ kind: 'ir', sr }).then((sts) => makeBuffer(sts[0], ctx));
    p.catch(() => irCache.delete(sr));
    irCache.set(sr, p);
  }
  return p;
}

function loopBuffers(r: Renderer, sr: number, ctx: BaseAudioContext): Promise<LoopBuffers> {
  let p = loopCache.get(sr);
  if (!p) {
    p = r.request({ kind: 'loops', sr }).then((sts) => {
      const o = {} as LoopBuffers;
      LOOP_NAMES.forEach((k, i) => (o[k] = makeBuffer(sts[i], ctx)));
      return o;
    });
    p.catch(() => loopCache.delete(sr));
    loopCache.set(sr, p);
  }
  return p;
}

/** Live counters for tests / diagnostics (NightshiftAudio.health()). */
export interface AudioHealth {
  state: string;
  generation: number;
  rebuilds: number;
  failures: number;
  lastFailure: string;
  failStreak: number;
  gaveUp: boolean;
  liveVoices: number;
  nodesLive: number;
  plays: number;
  merged: number;
  noBuffer: number;
  stolen: number;
  exceptions: number;
  deviceChanges: number;
  gestureResumes: number;
  engineRestarts: number;
  worklet: boolean;
  renderJobs: number;
  renderPending: number;
  mainThreadRenderMs: number;
  volume: number;
  muted: boolean;
  masterGain: number;
}

/** Nodes exposed for the sandbox meters (not part of the game contract). */
export interface AudioDebug {
  ctx: AudioContext;
  master: AudioNode;
  buses: Record<BusName, AudioNode>;
  reverb: AudioNode;
  bank: SfxBank;
  engineUsesWorklet: boolean;
}

export class NightshiftAudio implements IAudio {
  private ctx: AudioContext | null = null;
  private ready = false;
  private unlocking: Promise<void> | null = null;
  private volume = 0.8;
  private muted = false;
  private hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';

  // Graph (assigned in build()).
  private master!: GainNode;
  private out!: AudioNode;
  private buses!: Record<BusName, GainNode>;
  private pauseGain!: GainNode;
  private pauseLp!: BiquadFilterNode;
  private engine!: EngineVoice;
  private engineState!: GainNode;
  private reverbSend!: GainNode;
  private reverbReturn!: GainNode;
  private ambDuck!: GainNode;
  private roadDuck!: GainNode;
  private ambLp!: BiquadFilterNode;
  private rainGain!: GainNode;
  private patterGain!: GainNode;
  private sprayGain!: GainNode;
  private spraySrc!: AudioBufferSourceNode;
  private rumbleGain!: GainNode;
  private rumbleLp!: BiquadFilterNode;
  private windGain!: GainNode;
  private windBp!: BiquadFilterNode;
  private skidGain!: GainNode;
  private skidSrc!: AudioBufferSourceNode;
  private brakeGain!: GainNode;
  private brakeBp!: BiquadFilterNode[];
  private scrapeGain!: GainNode;
  private scrapeSrc!: AudioBufferSourceNode;
  private nitroGain!: GainNode;
  private nitroBp!: BiquadFilterNode;
  private bank!: SfxBank;

  private readonly voices = new Map<SfxName, Voice[]>();
  private readonly live: Voice[] = [];
  /** Stolen voices still fading out (nodes freed on 'ended'). */
  private readonly dying = new Set<Voice>();
  private readonly lastStart = new Map<SfxName, number>();
  private readonly renderer = new Renderer(runJob);
  // Health.
  private gen = 0;
  private wanted = false;
  private failStreak = 0;
  private retryAt = 0;
  private gaveUp = false;
  private gaveUpAt = 0;
  private healthySince = 0;
  private lastCtxTime = -1;
  private lastAdvance = 0;
  private ctxAbort: AbortController | null = null;
  private gestureAbort: AbortController | null = null;
  private excCount = 0;
  private buildStart = 0;
  private fakeStallGen = -1;
  private excWindow = 0;
  private analyser: AnalyserNode | null = null;
  private anBuf: Float32Array<ArrayBuffer> | null = null;
  private readonly counters = {
    rebuilds: 0, failures: 0, lastFailure: '', plays: 0, merged: 0, noBuffer: 0, stolen: 0, exceptions: 0,
    deviceChanges: 0, gestureResumes: 0, nodesMade: 0, nodesFreed: 0,
  };
  private listenerPos = { x: 0, y: 0, z: 0 };
  private listenerFwd = { x: 0, y: 0, z: -1 };
  private prevRpm01 = 0;
  private prevThrottle = 0;
  private timeScale = 1;
  private t = 0;
  private lastState: GameState | null = null;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        try {
          this.hidden = document.visibilityState === 'hidden';
          const c = this.ctx;
          if (!c) return;
          if (this.hidden) void c.suspend().catch(() => undefined);
          else {
            this.lastAdvance = performance.now();
            this.tryResume(c);
          }
        } catch (e) {
          this.onException('visibilitychange', e);
        }
      });
    }
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (md && typeof md.addEventListener === 'function') {
      md.addEventListener('devicechange', () => {
        // The default output changed: Chrome re-routes the context itself. Make sure it is still
        // running and give the stall watchdog a fresh start (a dead device is caught by it).
        this.counters.deviceChanges++;
        const c = this.ctx;
        if (!c || this.hidden) return;
        this.lastAdvance = performance.now();
        if (c.state !== 'running') this.tryResume(c);
      });
    }
  }

  get unlocked(): boolean {
    return this.ready;
  }

  unlock(): Promise<void> {
    try {
      this.wanted = true;
      if (this.ctx) {
        if (!this.hidden && this.ctx.state !== 'running') this.tryResume(this.ctx);
        return this.unlocking ?? Promise.resolve();
      }
      const t = performance.now();
      // A fresh user gesture earns one more attempt after giving up (at most every 30 s).
      if (this.gaveUp && t - this.gaveUpAt > 30000) {
        this.gaveUp = false;
        this.failStreak = MAX_REBUILDS - 1;
        this.retryAt = 0;
      }
      if (this.gaveUp || t < this.retryAt) return Promise.resolve();
      return this.open(false);
    } catch (e) {
      this.onException('unlock', e);
      return Promise.resolve();
    }
  }

  /** Create a context + graph. Never rejects. */
  private open(rebuild: boolean): Promise<void> {
    const Ctor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) {
      this.gaveUp = true;
      return Promise.resolve();
    }
    let ctx: AudioContext;
    try {
      // Created + resumed synchronously (inside the gesture when called from unlock()).
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      this.noteFailure('context creation failed: ' + String(e));
      return Promise.resolve();
    }
    this.ctx = ctx;
    this.ready = false;
    this.gen++;
    this.buildStart = performance.now();
    if (rebuild) this.counters.rebuilds++;
    const ac = new AbortController();
    this.ctxAbort = ac;
    ctx.addEventListener('statechange', () => this.onStateChange(ctx), { signal: ac.signal });
    // Chrome: "The AudioContext encountered an error from the audio device or the WebAudio renderer."
    ctx.addEventListener('error', () => this.fail('audio device / renderer error', ctx), { signal: ac.signal });
    let resumed: Promise<unknown> = Promise.resolve();
    if (this.hidden) void ctx.suspend().catch(() => undefined);
    else resumed = ctx.resume().catch(() => undefined);
    const unlocking = (async () => {
      try {
        await this.build(ctx);
        const tBuilt = performance.now() - this.buildStart;
        if (ctx !== this.ctx) return; // failed while building
        // resume() can stay pending without a user gesture: do not wait for it forever.
        await Promise.race([resumed, new Promise((r) => setTimeout(r, 1000))]);
        if (ctx !== this.ctx) return;
        this.ready = true;
        this.healthySince = this.lastAdvance = performance.now();
        this.lastCtxTime = -1;
        if (!this.hidden && ctx.state !== 'running') this.tryResume(ctx);
        if (rebuild) console.warn(`[audio] rebuilt (generation ${this.gen}, ${ctx.state}; graph ${tBuilt.toFixed(0)} ms, ready ${(performance.now() - this.buildStart).toFixed(0)} ms)`);
        void this.bank.warm();
      } catch (e) {
        if (ctx === this.ctx) this.fail('init failed: ' + String(e), ctx);
        else console.warn('[audio] init failed', e);
      }
    })();
    this.unlocking = unlocking;
    return unlocking;
  }

  private onStateChange(ctx: AudioContext): void {
    try {
      if (ctx !== this.ctx) return;
      const st = ctx.state as string;
      if (st === 'closed') this.fail('context closed', ctx);
      else if (st === 'running') {
        this.disarmGesture();
        this.lastAdvance = performance.now();
        this.lastCtxTime = -1;
      } else if (!this.hidden) this.tryResume(ctx); // 'suspended' (not by us) or 'interrupted'
    } catch (e) {
      this.onException('statechange', e);
    }
  }

  /** resume(); if the browser wants a user gesture for it, the next pointer / key press does it. */
  private tryResume(ctx: AudioContext): void {
    if (ctx.state === 'closed') return;
    void ctx.resume().catch(() => undefined);
    this.armGesture();
  }

  private armGesture(): void {
    if (this.gestureAbort || typeof window === 'undefined') return;
    const ac = new AbortController();
    this.gestureAbort = ac;
    const h = (): void => {
      const c = this.ctx;
      if (!c || c.state === 'running' || c.state === 'closed') {
        this.disarmGesture();
        return;
      }
      if (this.hidden) return;
      this.counters.gestureResumes++;
      void c.resume().catch(() => undefined);
    };
    for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, h, { capture: true, passive: true, signal: ac.signal });
  }

  private disarmGesture(): void {
    this.gestureAbort?.abort();
    this.gestureAbort = null;
  }

  /** The graph is dead: stop touching it, tear it down, schedule a lazy rebuild (or give up). */
  private fail(reason: string, ctx: AudioContext | null): void {
    if (!ctx || ctx !== this.ctx) return;
    this.teardown();
    this.noteFailure(reason);
  }

  private noteFailure(reason: string): void {
    this.counters.failures++;
    this.counters.lastFailure = reason;
    this.failStreak++;
    if (this.failStreak > MAX_REBUILDS) {
      this.gaveUp = true;
      this.gaveUpAt = performance.now();
      console.warn(`[audio] ${reason}; ${MAX_REBUILDS} rebuilds failed in a row: running silent`);
      return;
    }
    const wait = BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, this.failStreak - 1)];
    this.retryAt = performance.now() + wait;
    console.warn(`[audio] ${reason}; graph torn down, rebuilding in ${wait} ms (attempt ${this.failStreak}/${MAX_REBUILDS})`);
  }

  private teardown(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.ready = false;
    this.unlocking = null;
    this.ctxAbort?.abort();
    this.ctxAbort = null;
    this.disarmGesture();
    // Voices die with the context (their 'ended' may never fire now).
    for (const v of [...this.live, ...this.dying]) {
      v.src.onended = null;
      this.counters.nodesFreed += v.nodes.length;
    }
    this.live.length = 0;
    this.dying.clear();
    this.voices.clear();
    this.lastStart.clear();
    this.analyser = null;
    try {
      this.engine?.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.master?.disconnect();
    } catch {
      /* ignore */
    }
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }

  /** Anything thrown inside the audio code stays here; repeated throws mean the graph is unusable. */
  private onException(where: string, e: unknown): void {
    this.counters.exceptions++;
    const t = performance.now();
    if (t - this.excWindow > 5000) {
      this.excWindow = t;
      this.excCount = 0;
    }
    if (++this.excCount <= 3) console.warn(`[audio] ${where} threw`, e);
    if (this.excCount >= 3 && this.ctx) {
      try {
        this.fail(`${where} keeps throwing`, this.ctx);
      } catch {
        /* ignore */
      }
    }
  }

  // ─────────────────────────────────────────────────────────────── graph

  private async build(ctx: AudioContext): Promise<void> {
    const g = (v = 1): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const bq = (type: BiquadFilterType, f: number, q = 0.707): BiquadFilterNode => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };

    // Output chain: gentle glue compressor → brickwall-ish limiter → soft clipper (guarantees < 0 dBFS).
    this.master = g(this.muted ? 0 : this.volume);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.012;
    comp.release.value = 0.25;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4;
    lim.knee.value = 1;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.12;
    const pre = g(0.5);
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = ((i / (curve.length - 1)) * 2 - 1) * 2; // shaper input is pre-scaled by 0.5
      const a = Math.abs(x);
      const y = a < 0.8 ? a : 0.8 + 0.17 * Math.tanh((a - 0.8) / 0.17);
      curve[i] = Math.sign(x) * y;
    }
    clip.curve = curve;
    clip.oversample = '4x';
    // Sub-sonic clean-up: keeps headroom for the 35–60 Hz explosion thumps and removes any residual offset.
    const hp = bq("highpass", 22, 0.6);
    // The compressor / limiter gain riding on asymmetric engine pulses leaves a small negative offset
    // (≈ −1e-3 measured): a second, very low high-pass before the clipper removes it.
    const dcHp = bq('highpass', 12, 0.6);
    this.master.connect(hp).connect(comp).connect(lim).connect(dcHp).connect(pre).connect(clip).connect(ctx.destination);
    this.out = clip;

    this.pauseLp = bq('lowpass', 20000, 0.5);
    this.pauseGain = g(1);
    const mix = g(1);
    mix.connect(this.pauseLp).connect(this.pauseGain).connect(this.master);

    this.buses = { engine: g(0.9), road: g(0.7), ambience: g(0.7), sfx: g(0.95), ui: g(0.8) };
    for (const k of ['engine', 'road', 'ambience', 'sfx'] as const) this.buses[k].connect(mix);
    this.buses.ui.connect(this.master);

    // Tunnel reverb.
    const conv = ctx.createConvolver();
    conv.normalize = false;
    const irReady = irBuffer(this.renderer, ctx.sampleRate, ctx).then((b) => {
      if (ctx === this.ctx) conv.buffer = b;
    });
    this.reverbSend = g(0);
    this.reverbReturn = g(0.55);
    this.buses.engine.connect(this.reverbSend);
    this.buses.road.connect(this.reverbSend);
    this.buses.sfx.connect(this.reverbSend);
    this.reverbSend.connect(bq('highpass', 90)).connect(conv).connect(this.reverbReturn).connect(mix);

    // Engine.
    this.engine = new EngineVoice(ctx);
    this.engineState = g(0);
    this.engine.output.connect(this.engineState).connect(this.buses.engine);
    // Worklet module + loop beds (rendered in the worker) in parallel.
    const [, loops] = await Promise.all([this.engine.init(), loopBuffers(this.renderer, renderRate(ctx.sampleRate), ctx), irReady]);
    if (ctx !== this.ctx) return;

    // Loop beds.
    const loop = (buf: AudioBuffer, offset: number): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(ctx.currentTime + 0.05, offset % buf.duration);
      return s;
    };
    const white = loops.white;
    const brown = loops.brown;

    this.roadDuck = g(1);
    this.roadDuck.connect(this.buses.road);
    this.ambDuck = g(1);
    this.ambDuck.connect(this.buses.ambience);

    // Rain: shower bed + close patter, both through the tunnel muffler.
    this.ambLp = bq('lowpass', 18000, 0.6);
    this.ambLp.connect(this.ambDuck);
    this.rainGain = g(0);
    this.patterGain = g(0);
    loop(loops.rainShower, 0).connect(this.rainGain).connect(this.ambLp);
    // The patter starts somewhere else in its loop every time, so two sessions never open with the same drops.
    loop(loops.rainPatter, Math.random() * loops.rainPatter.duration).connect(this.patterGain).connect(this.ambLp);

    // Wet tyre spray (rate follows speed) and low road rumble.
    this.sprayGain = g(0);
    this.spraySrc = loop(loops.tyreSpray, 0);
    this.spraySrc.connect(this.sprayGain).connect(this.roadDuck);
    this.rumbleGain = g(0);
    this.rumbleLp = bq('lowpass', 120, 0.9);
    loop(brown, 0.7).connect(this.rumbleLp).connect(this.rumbleGain).connect(this.roadDuck);

    // Wind: band-passed noise whose centre rises with speed.
    this.windGain = g(0);
    this.windBp = bq('bandpass', 500, 0.55);
    loop(white, 1.9).connect(this.windBp).connect(bq('lowpass', 7000, 0.5)).connect(this.windGain).connect(this.roadDuck);

    // Skid + brake squeal (two cascaded narrow bands on noise: a soft pad squeal, never a sine beep).
    this.skidGain = g(0);
    this.skidSrc = loop(loops.skid, 0);
    this.skidSrc.connect(this.skidGain).connect(this.roadDuck);
    this.brakeGain = g(0);
    // Q 14 twice gives a band about 150 Hz wide: a breathy pad noise. (Q 35 was 60 Hz wide and whistled like a tone.)
    this.brakeBp = [bq('bandpass', 3150, BRAKE_Q), bq('bandpass', 3150, BRAKE_Q)];
    loop(white, 2.7).connect(this.brakeBp[0]).connect(this.brakeBp[1]).connect(this.brakeGain).connect(this.roadDuck);

    // Sustained metal scrape.
    this.scrapeGain = g(0);
    this.scrapeSrc = loop(loops.scrape, 0);
    this.scrapeSrc.connect(this.scrapeGain).connect(this.buses.sfx);

    // Nitro jet: hissy band + low roar.
    this.nitroGain = g(0);
    this.nitroBp = bq('bandpass', 900, 0.8);
    loop(white, 0.4).connect(this.nitroBp).connect(this.nitroGain);
    const nitroLow = bq('lowpass', 260, 0.8);
    const nitroLowG = g(0.9);
    loop(brown, 2.2).connect(nitroLow).connect(nitroLowG).connect(this.nitroGain);
    this.nitroGain.connect(this.buses.road);

    this.bank = new SfxBank(ctx, this.renderer);
  }

  // ─────────────────────────────────────────────────────────────── per frame

  update(dt: number, f: AudioFrame): void {
    try {
      const ctx = this.ctx;
      const wall = performance.now();
      if (!ctx) {
        // Lazy rebuild after a failure (back-off in retryAt; nothing while hidden).
        if (this.wanted && !this.gaveUp && !this.hidden && wall >= this.retryAt) void this.open(true);
        return;
      }
      if (!this.ready) {
        // A build that never finishes (worklet module / device hanging) counts as a failure.
        if (wall - this.buildStart > 10000) this.fail('init timed out', ctx);
        return;
      }
      if (ctx.state !== 'running') {
        this.lastAdvance = wall;
        return;
      }
      // Watchdog: a 'running' context whose clock stopped is a dead device / renderer.
      const ct = this.fakeStallGen === this.gen ? this.lastCtxTime : ctx.currentTime;
      if (ct !== this.lastCtxTime) {
        this.lastCtxTime = ct;
        this.lastAdvance = wall;
      } else if (!this.hidden && wall - this.lastAdvance > STALL_MS) {
        this.fail('audio clock stalled', ctx);
        return;
      }
      if (this.failStreak > 0 && wall - this.healthySince > 20000) this.failStreak = 0;
      this.tick(ct, fin(dt, 0), f);
    } catch (e) {
      this.onException('update', e);
    }
  }

  private tick(now: number, dt: number, f: AudioFrame): void {
    this.t += dt;
    const st = f.state;
    const set = (p: AudioParam, v: number, tau = 0.05): void => {
      if (Number.isFinite(v)) p.setTargetAtTime(v, now, tau);
    };

    // Global state: pause ducks everything (except UI) under a low-pass.
    const paused = st === 'paused';
    set(this.pauseGain.gain, paused ? 0.22 : 1, 0.08);
    set(this.pauseLp.frequency, paused ? 650 : 20000, 0.08);
    this.timeScale = Math.max(0.05, fin(f.timeScale, 1));

    // ── Engine
    const live = st === 'playing' || st === 'intro' || st === 'paused';
    const menu = st === 'menu';
    const dead = st === 'crashed' || st === 'gameover';
    const pitch = 0.35 + 0.65 * Math.min(1, this.timeScale);
    let rpm = IDLE_RPM + clamp01(f.rpm01) * (REDLINE_RPM - IDLE_RPM);
    // An idling engine still burns fuel: keep a little load near idle so it never sounds dead.
    let load = Math.max(clamp01(f.throttle), 0.22 * Math.pow(1 - clamp01(f.rpm01), 3));
    if (menu || st === 'boot') {
      // Calm idle with a slow, lazy wander so the menu does not sound like a loop.
      rpm = IDLE_RPM * (1 + 0.025 * Math.sin(this.t * 0.7) + 0.012 * Math.sin(this.t * 2.3));
      load = 0.1;
    }
    if (dead) {
      rpm = IDLE_RPM * 0.8;
      load = 0;
    }
    const engineLevel = live ? 1 + 0.25 * clamp01(f.tunnel) : menu ? 0.8 : 0;
    set(this.engineState.gain, engineLevel, dead ? (st === 'gameover' ? 0.6 : 0.35) : 0.25);
    if (live && f.shifted) this.engine.shift(now, f.rpm01 <= this.prevRpm01 + 0.01, load);
    // Lift-off at high rpm → afterfire crackle.
    if (live && this.prevThrottle > 0.6 && load < 0.15 && f.rpm01 > 0.5) this.engine.pops(2 + ((Math.random() * 3) | 0));
    this.engine.set({ rpm, load, pitch, boost: f.nitroActive && live ? 1 : 0 }, now, f.shifted ? 0.02 : 0.035);
    this.prevRpm01 = clamp01(f.rpm01);
    this.prevThrottle = load;

    // ── Road (speed-driven beds)
    const moving = live ? 1 : 0;
    const v = Math.max(0, fin(f.speedKmh, 0)) * moving;
    const s01 = clamp01(v / 300);
    const wet = 0.45 + 0.55 * clamp01(f.rain);
    const dryTunnel = 1 - 0.45 * clamp01(f.tunnel); // tunnel tarmac is drier: less spray
    set(this.sprayGain.gain, 0.75 * Math.pow(s01, 0.75) * wet * dryTunnel, 0.08);
    this.spraySrc.playbackRate.setTargetAtTime((0.7 + 0.6 * s01) * pitch, now, 0.1);
    set(this.rumbleGain.gain, 0.9 * Math.pow(s01, 0.7), 0.1);
    set(this.rumbleLp.frequency, (70 + 220 * s01) * pitch, 0.1);
    const gust = 1 + 0.12 * Math.sin(this.t * 0.37) + 0.08 * Math.sin(this.t * 1.13 + 1.7);
    set(this.windGain.gain, 0.55 * s01 * s01 * gust * (1 - 0.3 * clamp01(f.tunnel)), 0.12);
    set(this.windBp.frequency, (350 + 2300 * s01) * pitch * gust, 0.12);
    const skid = clamp01(f.skid) * clamp01(v / 25);
    set(this.skidGain.gain, 0.7 * skid, 0.04);
    this.skidSrc.playbackRate.setTargetAtTime((0.9 + 0.2 * s01) * pitch, now, 0.1);
    // Brake pads only sing at moderate speed and light-to-medium pressure.
    const squeal = clamp01(f.brake) * Math.exp(-Math.pow((v - 45) / 35, 2)) * (v > 3 ? 1 : 0);
    set(this.brakeGain.gain, BRAKE_GAIN * squeal, 0.15);
    const bf = 3150 * (1 + 0.012 * Math.sin(this.t * 5.3)) * pitch;
    for (const b of this.brakeBp) set(b.frequency, bf, 0.05);
    set(this.scrapeGain.gain, 0.8 * clamp01(f.scrape) * moving, 0.03);
    this.scrapeSrc.playbackRate.setTargetAtTime((0.85 + 0.35 * s01) * pitch, now, 0.1);
    const nitro = f.nitroActive && live;
    set(this.nitroGain.gain, nitro ? 0.42 : 0, nitro ? 0.06 : 0.22);
    set(this.nitroBp.frequency, (700 + 1600 * s01) * pitch, 0.2);

    // ── Ambience: rain disappears (and is muffled on the way) inside tunnels.
    const rain = clamp01(f.rain);
    const tun = clamp01(f.tunnel);
    const open = Math.pow(1 - tun, 1.5);
    set(this.rainGain.gain, 0.36 * rain * open, 0.25);
    // The patter sits well under the shower (about 6 dB below it): a texture on top of the rain, never a voice of its own.
    set(this.patterGain.gain, PATTER_GAIN * rain * open * (st === 'boot' ? 0 : 1), 0.25);
    set(this.ambLp.frequency, 400 + 17600 * Math.pow(1 - tun, 2), 0.2);

    // ── Tunnel reverb send.
    set(this.reverbSend.gain, 0.6 * tun, 0.2);

    if (st !== this.lastState) {
      // Stop sustained loops immediately when the run ends.
      if (dead) set(this.scrapeGain.gain, 0, 0.3);
      this.lastState = st;
    }
  }

  // ─────────────────────────────────────────────────────────────── one-shots

  play(name: SfxName, opts: SfxOpts = {}): void {
    try {
      this.playOne(name, opts);
    } catch (e) {
      this.onException('play', e);
    }
  }

  private playOne(name: SfxName, opts: SfxOpts): void {
    const ctx = this.ctx;
    if (!this.ready || !ctx || ctx.state !== 'running') return;
    const def = SFX[name];
    if (!def) return;
    let delay = Math.max(0, fin(opts.delay ?? 0, 0));
    let gain = Math.max(0, fin(opts.volume ?? 1, 1));
    let pan = Math.max(-1, Math.min(1, fin(opts.pan ?? 0, 0)));
    let lpHz = 0;
    if (opts.position) {
      const p = this.spatial(opts.position);
      if (!Number.isFinite(p.gain + p.pan + p.lpHz + p.delay)) return;
      gain *= p.gain;
      pan = p.pan;
      lpHz = p.lpHz;
      delay += p.delay;
      if (gain < 0.003) return;
    }
    const at = ctx.currentTime + delay;
    // Pile-ups emit the same event many times per frame: one start per MIN_GAP is plenty.
    const prev = this.lastStart.get(name);
    if (prev !== undefined && Math.abs(at - prev) < MIN_GAP) {
      this.counters.merged++;
      return;
    }
    const buffer = this.bank.next(name);
    if (!buffer) {
      this.counters.noBuffer++; // still rendering (first seconds after unlock)
      return;
    }
    this.lastStart.set(name, at);
    // World sounds follow slow motion (deeper, longer); UI does not.
    const slow = def.bus === 'sfx' || def.bus === 'ambience' ? 0.45 + 0.55 * Math.min(1, this.timeScale) : 1;
    const rate = Math.max(0.25, fin(opts.pitch ?? 1, 1) * slow * (1 + (Math.random() * 2 - 1) * def.spread));

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const vg = ctx.createGain();
    vg.gain.value = gain;
    const nodes: AudioNode[] = [src, vg];
    let node: AudioNode = src;
    if (lpHz > 0 && lpHz < 18000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lpHz;
      lp.Q.value = 0.5;
      node = node.connect(lp);
      nodes.push(lp);
    }
    node = node.connect(vg);
    if (pan !== 0) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = pan;
      node = node.connect(pn);
      nodes.push(pn);
    }
    node.connect(this.buses[def.bus]);
    src.start(at);
    this.counters.plays++;
    this.counters.nodesMade += nodes.length;

    const list = this.voices.get(name) ?? [];
    this.voices.set(name, list);
    const voice: Voice = { name, src, gain: vg, nodes };
    list.push(voice);
    this.live.push(voice);
    src.onended = () => this.release(voice);
    // Per-sound polyphony, then the global cap (oldest non-UI voice goes first).
    while (list.length > def.poly) this.steal(list[0]);
    if (this.live.length > MAX_VOICES) {
      const victim = this.live.find((v) => SFX[v.name].bus !== 'ui' && v !== voice) ?? this.live[0];
      this.steal(victim);
    }
    if (def.duck) this.duck(at, def.duck.depth, def.duck.release / Math.max(0.5, slow));
  }

  /** Fade a voice out quickly; it leaves the voice lists now, its nodes are freed on 'ended'. */
  private steal(v: Voice): void {
    this.unlist(v);
    this.dying.add(v);
    this.counters.stolen++;
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    v.gain.gain.setTargetAtTime(0, t0, 0.02);
    try {
      v.src.stop(t0 + 0.12);
    } catch {
      /* already stopped */
    }
  }

  private unlist(v: Voice): void {
    const list = this.voices.get(v.name);
    const i = list ? list.indexOf(v) : -1;
    if (i >= 0) list!.splice(i, 1);
    const j = this.live.indexOf(v);
    if (j >= 0) this.live.splice(j, 1);
  }

  /** Voice finished: disconnect every node it made so nothing stays attached to the buses. */
  private release(v: Voice): void {
    v.src.onended = null;
    this.unlist(v);
    this.dying.delete(v);
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.counters.nodesFreed += v.nodes.length;
    v.nodes.length = 0;
  }

  /** Briefly pull the beds down so a big hit owns the moment, then let them breathe back in. */
  private duck(at: number, depth: number, release: number): void {
    for (const [node, d] of [[this.ambDuck, depth], [this.roadDuck, 0.5 + 0.5 * depth]] as const) {
      const p = node.gain;
      const now = this.ctx!.currentTime;
      if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(now);
      else {
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
      }
      p.setTargetAtTime(d, at, 0.03);
      p.setTargetAtTime(1, at + 0.35, release / 3);
    }
  }

  /** Distance attenuation, pan, air absorption and propagation delay relative to the listener. */
  private spatial(pos: Vector3): { gain: number; pan: number; lpHz: number; delay: number } {
    const lp = this.listenerPos;
    const fw = this.listenerFwd;
    const rx = pos.x - lp.x;
    const ry = pos.y - lp.y;
    const rz = pos.z - lp.z;
    const d = Math.hypot(rx, ry, rz);
    // Right vector in the horizontal plane: forward × up.
    const fl = Math.hypot(fw.x, fw.z) || 1;
    const rightX = -fw.z / fl;
    const rightZ = fw.x / fl;
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, ((rx * rightX + rz * rightZ) / d) * 0.9)) : 0;
    const behind = d > 0.5 && (rx * fw.x + rz * fw.z) / (d * fl) < -0.3;
    const ref = 6;
    const gain = ref / (ref + Math.max(0, d - ref));
    const lpHz = Math.max(900, 20000 * Math.exp(-d / 140)) * (behind ? 0.7 : 1);
    return { gain, pan, lpHz, delay: Math.min(1.5, d / 343) };
  }

  // ─────────────────────────────────────────────────────────────── controls

  setMasterVolume(v: number): void {
    if (!Number.isFinite(v)) return;
    this.volume = clamp01(v);
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this.muted = !!m;
    this.applyMaster();
  }

  private applyMaster(): void {
    try {
      if (!this.ctx || !this.master || this.ctx.state === 'closed') return;
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
    } catch (e) {
      this.onException('volume', e);
    }
  }

  setListener(position: Vector3, forward: Vector3): void {
    try {
      const lp = this.listenerPos;
      const fw = this.listenerFwd;
      lp.x = fin(position.x, lp.x);
      lp.y = fin(position.y, lp.y);
      lp.z = fin(position.z, lp.z);
      fw.x = fin(forward.x, fw.x);
      fw.y = fin(forward.y, fw.y);
      fw.z = fin(forward.z, fw.z);
    } catch {
      /* bad vector: keep the last pose */
    }
  }

  // ─────────────────────────────────────────────────────────────── test hooks (not part of IAudio)

  /**
   * Simulate an audio failure (tests only): 'error' dispatches the context's error event (what Chrome
   * fires on a device / renderer failure), 'close' closes the context behind our back, 'worklet' makes
   * the engine processor throw ('processorerror'), 'suspend' suspends it as an OS interruption would,
   * 'stall' fakes a frozen audio clock for the watchdog.
   */
  debugFail(kind: 'error' | 'close' | 'worklet' | 'suspend' | 'stall'): string {
    const ctx = this.ctx;
    if (!ctx) return 'no context';
    if (kind === 'error') ctx.dispatchEvent(new Event('error'));
    else if (kind === 'close') void ctx.close().catch(() => undefined);
    else if (kind === 'worklet') return this.engine?.debugKill() ? 'worklet killed' : 'no worklet';
    else if (kind === 'suspend') void ctx.suspend().catch(() => undefined);
    else if (kind === 'stall') this.fakeStallGen = this.gen; // update() now sees a frozen clock
    return kind;
  }

  /** RMS of the final output over the last ~85 ms in dBFS (−200 when audio is down). */
  level(): number {
    try {
      const ctx = this.ctx;
      if (!ctx || !this.ready || ctx.state !== 'running') return -200;
      if (!this.analyser || this.analyser.context !== ctx) {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 4096;
        this.out.connect(this.analyser);
        this.anBuf = new Float32Array(4096);
      }
      const b = this.anBuf!;
      this.analyser.getFloatTimeDomainData(b);
      let ss = 0;
      for (let i = 0; i < b.length; i++) ss += b[i] * b[i];
      return 10 * Math.log10(Math.max(1e-20, ss / b.length));
    } catch {
      return -200;
    }
  }

  health(): AudioHealth {
    const c = this.counters;
    const ctx = this.ctx;
    let masterGain = -1;
    try {
      masterGain = ctx && this.master ? this.master.gain.value : -1;
    } catch {
      /* ignore */
    }
    return {
      state: ctx ? (ctx.state as string) + (this.ready ? '' : ' (building)') : this.gaveUp ? 'silent' : this.wanted ? 'down' : 'locked',
      generation: this.gen,
      rebuilds: c.rebuilds,
      failures: c.failures,
      lastFailure: c.lastFailure,
      failStreak: this.failStreak,
      gaveUp: this.gaveUp,
      liveVoices: this.live.length,
      nodesLive: c.nodesMade - c.nodesFreed,
      plays: c.plays,
      merged: c.merged,
      noBuffer: c.noBuffer,
      stolen: c.stolen,
      exceptions: c.exceptions,
      deviceChanges: c.deviceChanges,
      gestureResumes: c.gestureResumes,
      engineRestarts: this.engine?.restartCount ?? 0,
      worklet: !!this.engine?.usingWorklet,
      renderJobs: this.renderer.stats.jobs,
      renderPending: this.renderer.pendingJobs,
      mainThreadRenderMs: Math.round(this.renderer.stats.mainThreadMs),
      volume: this.volume,
      muted: this.muted,
      masterGain,
    };
  }

  /** Sandbox / diagnostics only. Null before unlock() has finished. */
  debug(): AudioDebug | null {
    if (!this.ready || !this.ctx) return null;
    return {
      ctx: this.ctx,
      master: this.out,
      buses: this.buses,
      reverb: this.reverbReturn,
      bank: this.bank,
      engineUsesWorklet: this.engine.usingWorklet,
    };
  }
}

export { SFX_NAMES };

export function createAudio(): IAudio {
  return new NightshiftAudio();
}
