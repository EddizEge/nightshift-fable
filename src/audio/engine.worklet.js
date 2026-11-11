/*
 * NIGHTSHIFT engine synthesiser — AudioWorkletProcessor (plain JS on purpose: it is imported as a
 * raw string and loaded from a Blob URL, so it never goes through TypeScript or the bundler).
 *
 * Model (physically flavoured, not physically exact):
 *   crank phase → 8 combustion events per 720° (flat-plane V8, banks alternate L/R)
 *   each event deposits a pressure impulse (+ a burst of combustion noise) with per-cylinder
 *   gain/timing offsets and per-cycle random irregularity (stronger at idle / on overrun)
 *   → per-bank pulse shaper (2× one-pole, width follows rpm)
 *   → per-bank exhaust pipe waveguide (delay line with inverting, lossy open-end reflection)
 *   → muffler formant bank (parallel band-passes) + load-dependent low-pass (overrun = muffled)
 *   → soft saturation (drive rises with load = "bark") → DC blocker
 *   + intake roar (noise gated by the intake pulses through an rpm-tracking band-pass)
 *   + overrun afterfire crackle and shift pops (message 'pop')
 *
 * Parameters (k-rate, smoothed again per sample here so there is no zipper noise):
 *   rpm   crank speed            load  0..1 throttle/load      cut   0..1 ignition cut (shifts)
 *   pitch time-scale factor (slow motion: lowers firing rate AND resonances, like slowed tape)
 *   boost 0..1 nitro (more intake roar + brightness)
 */
const TAU = Math.PI * 2;

class BP {
  constructor() {
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0;
  }
  bandpass(f, q) {
    const w = (TAU * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; this.a1 = (-2 * Math.cos(w)) / a0; this.a2 = (1 - al) / a0;
  }
  lowpass(f, q) {
    const w = (TAU * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
  }
  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class Pipe {
  constructor(maxLen) {
    this.buf = new Float32Array(maxLen);
    this.mask = maxLen - 1;
    this.w = 0;
    this.lp = 0;
  }
  /** delay = round-trip time in samples (fractional), refl = end reflection (negative for an open end). */
  tick(x, delay, refl, loss) {
    let rp = this.w - delay;
    const i = Math.floor(rp);
    const fr = rp - i;
    const a = this.buf[i & this.mask];
    const b = this.buf[(i + 1) & this.mask];
    const d = a + (b - a) * fr;
    this.lp += (d - this.lp) * loss; // high frequencies die faster in the pipe
    const y = x + refl * this.lp;
    this.buf[this.w & this.mask] = y;
    this.w++;
    return y;
  }
}

const FIRING = [0, 4, 2, 6, 3, 7, 1, 5]; // cylinders 0-3 = bank A, 4-7 = bank B → alternate banks
const RING = 512;
const LAT = 48; // samples of look-ahead so timing jitter can move events both ways

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 14000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 1, minValue: 0.05, maxValue: 2, automationRate: 'k-rate' },
      { name: 'boost', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 1234567;
    this.s = seed >>> 0;
    this.slotAcc = 0;
    this.slot = 0;
    this.ex = [new Float32Array(RING), new Float32Array(RING)];
    this.rp = 0;
    this.nz = [0, 0];
    this.sh = [[0, 0], [0, 0]];
    this.pipes = [new Pipe(8192), new Pipe(8192)];
    this.intakeEnv = 0;
    this.popEnv = 0;
    this.popQueue = [];
    this.pendingPops = 0;
    // Static per-cylinder character: slightly different charge and spark timing.
    this.cylGain = new Float32Array(8);
    this.cylTime = new Float32Array(8);
    for (let c = 0; c < 8; c++) {
      this.cylGain[c] = 1 + (this.rand() - 0.5) * 0.14;
      this.cylTime[c] = (this.rand() - 0.5) * 0.02;
    }
    // Smoothed controls.
    this.rpm = 900; this.load = 0; this.cut = 0; this.pitch = 1; this.boost = 0;
    this.lastPitch = -1;
    // Muffler formants: [freq, Q, gain]
    this.formants = [
      [92, 2.2, 1.0],
      [205, 2.8, 0.75],
      [450, 3.0, 0.55],
      [980, 2.6, 0.38],
      [2150, 2.0, 0.22],
    ];
    this.fb = this.formants.map(() => new BP());
    this.toneL = new BP();
    this.toneR = new BP();
    this.sideLp = new BP();
    this.intakeBp = new BP();
    this.inductBp = new BP();
    this.popBp = new BP();
    this.popBp.bandpass(1700, 1.1);
    this.dcL = [0, 0]; this.dcR = [0, 0];
    this.hpA = [0, 0]; this.hpB = [0, 0];
    this.whinePh = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      // Capped: a burst of lift-offs / shifts must never queue minutes of crackle.
      if (d && d.type === 'pop') this.pendingPops = Math.min(8, this.pendingPops + (d.count | 0));
      // Test hook (NightshiftAudio.debugFail('worklet')): throw from process() → 'processorerror'.
      if (d && d.type === 'die') this.dead = true;
      if (d && d.type === 'seed') this.s = d.seed >>> 0;
    };
  }

  rand() {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  fire(samplesAgo, interval) {
    const c = FIRING[this.slot & 7];
    this.slot++;
    const bank = c < 4 ? 0 : 1;
    const loadEff = this.load * (1 - this.cut);
    const rpm01 = Math.min(1.1, this.rpm / 8200);
    // Irregularity: lumpy at idle, burbly on overrun, tight at high load.
    const irr = 0.05 + 0.16 * (1 - loadEff) * (1 - 0.6 * rpm01) + 0.1 * (1 - loadEff) * rpm01;
    let amp = this.cylGain[c] * (0.2 + 0.8 * Math.pow(loadEff, 0.8)) * (1 + (this.rand() - 0.5) * 2 * irr);
    if (this.cut > 0.5) amp *= 0.3; // no combustion, just pumping
    // Overrun misfire / weak cycle now and then — the "burble".
    if (loadEff < 0.15 && this.rand() < 0.05 + 0.08 * rpm01) amp *= 0.35 + this.rand() * 0.4;
    const jit = (this.cylTime[c] + (this.rand() - 0.5) * 2 * (0.008 + 0.022 * (1 - loadEff))) * interval;
    let off = LAT - samplesAgo + jit;
    if (off < 1) off = 1;
    if (off > RING - 4) off = RING - 4;
    const i = Math.floor(off);
    const fr = off - i;
    const ring = this.ex[bank];
    ring[(this.rp + i) & (RING - 1)] += amp * (1 - fr);
    ring[(this.rp + i + 1) & (RING - 1)] += amp * fr;
    this.nz[bank] = Math.max(this.nz[bank], amp * (0.25 + 0.75 * loadEff));
    this.intakeEnv = Math.max(this.intakeEnv, amp);
    // Afterfire crackle on overrun at mid/high rpm, plus queued shift pops.
    let popP = loadEff < 0.12 && this.rpm > 2800 ? 0.018 + 0.05 * Math.max(0, rpm01 - 0.35) : 0;
    if (this.pendingPops > 0 && this.rand() < 0.45) {
      this.pendingPops--;
      popP = 1;
    }
    if (this.rand() < popP) this.popQueue.push(LAT + Math.floor(this.rand() * interval * 0.5), 0.5 + this.rand() * 0.7);
  }

  updateCoefs() {
    const p = this.pitch;
    if (Math.abs(p - this.lastPitch) > 0.002) {
      this.lastPitch = p;
      for (let k = 0; k < this.formants.length; k++) {
        const f = this.formants[k];
        this.fb[k].bandpass(f[0] * p, f[1]);
      }
      this.sideLp.lowpass(1400 * p, 0.7);
    }
    const ld = this.load * (1 - this.cut * 0.8);
    const rpm01 = Math.min(1.1, this.rpm / 8200);
    // Overrun: closed throttle and the exhaust note goes dull; on load it opens right up.
    const tone = (750 + 5200 * Math.pow(ld, 1.3) + 1800 * this.boost) * (0.65 + 0.45 * rpm01) * p;
    this.toneL.lowpass(tone, 0.75);
    this.toneR.lowpass(tone * 1.04, 0.75);
    const rpmE = this.rpm * p;
    this.intakeBp.bandpass(170 + rpmE * 0.075, 1.6);
    this.inductBp.bandpass((1500 + rpmE * 0.12) * (1 + 0.15 * this.boost), 1.1);
  }

  process(inputs, outputs, parameters) {
    if (this.dead) throw new Error('nightshift-engine: simulated processor failure');
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    const sr = sampleRate;
    const tRpm = parameters.rpm[0];
    const tLoad = parameters.load[0];
    const tCut = parameters.cut[0];
    const tPitch = parameters.pitch[0];
    const tBoost = parameters.boost[0];
    // Block-level smoothing (≈ 6 ms) on top of the main thread's setTargetAtTime ramps.
    const k = 1 - Math.exp(-n / (0.006 * sr));
    this.rpm += (tRpm - this.rpm) * k;
    this.load += (tLoad - this.load) * k;
    this.cut += (tCut - this.cut) * Math.min(1, k * 3);
    this.pitch += (tPitch - this.pitch) * k;
    this.boost += (tBoost - this.boost) * k;
    this.updateCoefs();

    const rpmE = Math.max(60, this.rpm * this.pitch);
    const slotInc = (rpmE / 15) / sr; // firing events per sample
    const interval = 1 / slotInc;
    const ld = this.load * (1 - this.cut);
    const rpm01 = Math.min(1.1, this.rpm / 8200);
    // Pulse shaper width tracks rpm (shorter, sharper pulses when revving).
    const aSh = 1 - Math.exp((-TAU * (320 + rpmE * 0.2)) / sr);
    const shGain = 1.0 / aSh;
    const dA = (2 * 1.66 * sr) / 343 / this.pitch;
    const dB = (2 * 1.74 * sr) / 343 / this.pitch;
    const nzDecay = Math.exp(-1 / (0.0016 * sr));
    const inDecay = Math.exp(-1 / (Math.max(0.0015, interval * 0.45 / sr) * sr));
    const popDecay = Math.exp(-1 / (0.007 * sr));
    const dcR = Math.exp((-TAU * 24) / sr);
    const hpR = Math.exp((-TAU * 35) / sr);
    const drive = 1.1 + 2.0 * ld + 0.6 * this.boost;
    const satNorm = 1 / Math.pow(drive, 0.72);
    const intakeG = (0.08 + 0.42 * ld + 0.35 * this.boost) * (0.5 + 0.7 * rpm01);
    const inductG = 0.1 * rpm01 * rpm01 * (0.25 + ld) + 0.08 * this.boost;
    const whineInc = (rpmE / 60) * 7.0 / sr;
    const whineG = 0.0035 * (0.3 + rpm01);
    const fm = this.formants;
    const fb = this.fb;
    const out0 = 0.32;

    for (let i = 0; i < n; i++) {
      this.slotAcc += slotInc;
      if (this.slotAcc >= 1) {
        this.slotAcc -= 1;
        this.fire(this.slotAcc / slotInc, interval);
      }
      // Popping queue (sample countdowns).
      for (let q = 0; q < this.popQueue.length; q += 2) {
        if (--this.popQueue[q] <= 0) {
          this.popEnv = Math.max(this.popEnv, this.popQueue[q + 1]);
          this.popQueue.splice(q, 2);
          q -= 2;
        }
      }
      const idx = this.rp & (RING - 1);
      let xA = this.ex[0][idx];
      let xB = this.ex[1][idx];
      this.ex[0][idx] = 0;
      this.ex[1][idx] = 0;
      this.rp++;

      // Pulse shaping.
      const shA = this.sh[0];
      shA[0] += aSh * (xA * shGain - shA[0]);
      shA[1] += aSh * (shA[0] - shA[1]);
      const shB = this.sh[1];
      shB[0] += aSh * (xB * shGain - shB[0]);
      shB[1] += aSh * (shB[0] - shB[1]);
      // Combustion turbulence.
      this.nz[0] *= nzDecay;
      this.nz[1] *= nzDecay;
      const pA = shA[1] + (this.rand() * 2 - 1) * this.nz[0] * 0.35;
      const pB = shB[1] + (this.rand() * 2 - 1) * this.nz[1] * 0.35;
      // Remove the pulse train's DC before the pipes/saturation so the bias doesn't skew the drive.
      const hA = pA - this.hpA[0] + hpR * this.hpA[1];
      this.hpA[0] = pA; this.hpA[1] = hA;
      const hB = pB - this.hpB[0] + hpR * this.hpB[1];
      this.hpB[0] = pB; this.hpB[1] = hB;
      // Exhaust pipes.
      const yA = this.pipes[0].tick(hA, dA, -0.52, 0.55);
      const yB = this.pipes[1].tick(hB, dB, -0.5, 0.5);
      const m = yA + yB;
      const side = this.sideLp.tick(yA - yB);
      // Muffler formants.
      let f = m * 0.35;
      for (let kf = 0; kf < fb.length; kf++) f += fb[kf].tick(m) * fm[kf][2];
      let l = this.toneL.tick(f + side * 0.3);
      let r = this.toneR.tick(f - side * 0.3);
      // Saturation = exhaust bark.
      l = Math.tanh(l * drive) * satNorm;
      r = Math.tanh(r * drive) * satNorm;
      // Intake roar & induction.
      this.intakeEnv *= inDecay;
      const nzI = this.rand() * 2 - 1;
      const intake = this.intakeBp.tick(nzI * (0.25 + this.intakeEnv)) * intakeG;
      const induct = this.inductBp.tick(nzI * (0.4 + 0.6 * this.intakeEnv)) * inductG;
      // Afterfire crackle.
      this.popEnv *= popDecay;
      const pop = this.popEnv > 1e-4 ? this.popBp.tick((this.rand() * 2 - 1) * this.popEnv) * 2.2 + (this.rand() - 0.5) * this.popEnv * 0.4 : 0;
      // Faint mechanical whine (cam drive), very low level.
      this.whinePh += whineInc;
      if (this.whinePh > 1) this.whinePh -= 1;
      const whine = Math.sin(TAU * this.whinePh) * whineG;
      let oL = (l + intake * 0.9 + induct + pop + whine) * out0;
      let oR = (r + intake + induct * 0.9 + pop * 0.9 + whine) * out0;
      // DC blockers.
      const yl = oL - this.dcL[0] + dcR * this.dcL[1];
      this.dcL[0] = oL; this.dcL[1] = yl;
      const yr = oR - this.dcR[0] + dcR * this.dcR[1];
      this.dcR[0] = oR; this.dcR[1] = yr;
      L[i] = yl;
      R[i] = yr;
    }
    return true;
  }
}

registerProcessor('nightshift-engine', EngineProcessor);
