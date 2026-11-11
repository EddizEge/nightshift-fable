/**
 * Player engine voice: wraps the AudioWorklet synthesiser (engine.worklet.js) and converts game
 * values into smoothly ramped AudioParams. Falls back to a filtered two-oscillator drone only if
 * AudioWorklet is unavailable (insecure context / very old browser) so the game is never silent.
 */
import workletSource from './engine.worklet.js?raw';

export const IDLE_RPM = 900;
export const REDLINE_RPM = 8200;

/** Worklet modules are per-context; remember which contexts already have it. */
const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

function loadWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (!p) {
    p = (async () => {
      if (!ctx.audioWorklet) return false;
      // A Blob URL from the raw source works the same under the dev server, a relative-base
      // production build and any static host: no extra file, no path resolution, no transpile.
      const url = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch (e) {
        console.warn('[audio] engine worklet failed to load, using fallback', e);
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    loaded.set(ctx, p);
  }
  return p;
}

export interface EngineTargets {
  rpm: number;
  load: number;
  pitch: number;
  boost: number;
}

export class EngineVoice {
  readonly output: GainNode;
  private node: AudioWorkletNode | null = null;
  private rpm: AudioParam | null = null;
  private load: AudioParam | null = null;
  private cut: AudioParam | null = null;
  private pitch: AudioParam | null = null;
  private boost: AudioParam | null = null;
  // Fallback graph.
  private fbOsc: OscillatorNode[] = [];
  private fbFilter: BiquadFilterNode | null = null;
  private lastShift = -1;
  /** While a shift is being played the shift owns the load param. */
  private holdUntil = -1;
  private restarts = 0;
  private disposed = false;
  static readonly MAX_RESTARTS = 3;

  constructor(private readonly ctx: BaseAudioContext) {
    this.output = ctx.createGain();
    // The worklet renders with ~12 dB of internal headroom; bring it up to mix level here.
    this.output.gain.value = 3;
  }

  async init(): Promise<void> {
    const ok = await loadWorklet(this.ctx);
    if (ok && this.spawn()) return;
    this.initFallback();
  }

  /** (Re)create the worklet node; false if the constructor throws. */
  private spawn(): boolean {
    try {
      const node = new AudioWorkletNode(this.ctx, 'nightshift-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { seed: 0x5eed1234 + this.restarts },
      });
      node.connect(this.output);
      node.onprocessorerror = () => this.onProcessorError(node);
      this.node = node;
      const p = node.parameters as unknown as Map<string, AudioParam>;
      this.rpm = p.get('rpm') ?? null;
      this.load = p.get('load') ?? null;
      this.cut = p.get('cut') ?? null;
      this.pitch = p.get('pitch') ?? null;
      this.boost = p.get('boost') ?? null;
      this.holdUntil = -1;
      return true;
    } catch (e) {
      console.warn('[audio] engine worklet node failed', e);
      return false;
    }
  }

  /**
   * The processor threw (it now outputs silence for good): drop it and start a fresh one, at most
   * MAX_RESTARTS times; after that the oscillator fallback keeps the car audible.
   */
  private onProcessorError(node: AudioWorkletNode): void {
    if (node !== this.node || this.disposed) return;
    this.release(node);
    this.node = this.rpm = this.load = this.cut = this.pitch = this.boost = null;
    this.restarts++;
    console.warn(`[audio] engine processor error (${this.restarts})`);
    if (this.restarts <= EngineVoice.MAX_RESTARTS && this.spawn()) return;
    this.initFallback();
  }

  private release(node: AudioWorkletNode): void {
    node.onprocessorerror = null;
    node.port.onmessage = null;
    try {
      node.port.close();
    } catch {
      /* ignore */
    }
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
  }

  /** Stop and disconnect everything (context teardown). */
  dispose(): void {
    this.disposed = true;
    if (this.node) this.release(this.node);
    this.node = null;
    for (const o of this.fbOsc) {
      try {
        o.stop();
        o.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.fbOsc = [];
    try {
      this.output.disconnect();
    } catch {
      /* ignore */
    }
  }

  /** Test hook: makes the processor throw on its next block (→ 'processorerror'). */
  debugKill(): boolean {
    if (!this.node) return false;
    this.node.port.postMessage({ type: 'die' });
    return true;
  }

  get restartCount(): number {
    return this.restarts;
  }

  private initFallback(): void {
    if (this.fbFilter) return;
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 600;
    f.Q.value = 2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 2.5) * 0.8;
    shaper.curve = curve;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    for (const det of [0, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = IDLE_RPM / 15;
      o.detune.value = det;
      o.connect(f);
      o.start();
      this.fbOsc.push(o);
    }
    f.connect(shaper).connect(g).connect(this.output);
    this.fbFilter = f;
  }

  /** Ramp towards new targets. `tau` ≈ ramp time-constant in seconds. */
  set(t: EngineTargets, time: number, tau = 0.03): void {
    if (this.node) {
      this.rpm!.setTargetAtTime(t.rpm, time, tau);
      if (time >= this.holdUntil) this.load!.setTargetAtTime(t.load, time, tau * 1.6);
      this.pitch!.setTargetAtTime(t.pitch, time, 0.08);
      this.boost!.setTargetAtTime(t.boost, time, 0.12);
    } else if (this.fbFilter) {
      const f = (t.rpm * t.pitch) / 15;
      for (const o of this.fbOsc) o.frequency.setTargetAtTime(f, time, tau);
      this.fbFilter.frequency.setTargetAtTime(400 + 2600 * t.load * (t.rpm / REDLINE_RPM), time, tau);
    }
  }

  /** Gear change: ~70 ms ignition cut, then the cut lifts quickly (the "blip" comes from the load ramp). */
  shift(time: number, up: boolean, throttle: number): void {
    if (time - this.lastShift < 0.12) return;
    this.lastShift = time;
    if (!this.cut) return;
    this.holdUntil = time + 0.16;
    this.cut.cancelScheduledValues(time);
    this.cut.setValueAtTime(1, time);
    this.cut.setTargetAtTime(0, time + (up ? 0.065 : 0.04), 0.012);
    // Load dip during the cut and a short overshoot "blip" as the next gear bites.
    this.load!.cancelScheduledValues(time);
    this.load!.setTargetAtTime(0.05, time, 0.01);
    this.load!.setTargetAtTime(1, time + 0.07, 0.015);
    this.load!.setTargetAtTime(throttle, time + 0.11, 0.03);
    if (up) this.node?.port.postMessage({ type: 'pop', count: 1 + ((time * 1000) % 2 | 0) });
  }

  /** Queue afterfire pops (e.g. lift-off at high rpm). */
  pops(count: number): void {
    this.node?.port.postMessage({ type: 'pop', count });
  }

  get usingWorklet(): boolean {
    return this.node !== null;
  }
}
