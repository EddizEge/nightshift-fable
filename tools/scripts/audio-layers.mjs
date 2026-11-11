/**
 * Records the game's sound layer by layer while a scripted session runs (menu, driving, nitro, coasting,
 * braking, standing, pause, traffic, crash and game over), so every layer can be listened to and analysed.
 *
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/audio-layers.mjs --timeout 400000 --out-dir tools/tmp/audio/run1
 *   python tools/audio/analyze.py tools/tmp/audio/run1          (numbers + spectrograms)
 *
 * Taps (all at once, sample-aligned, through one AudioWorklet): the final output after the limiter, the five
 * buses and every continuous layer behind them. Written as 16-bit WAV files plus marks.json (which second
 * belongs to which part of the session, and what the game told the audio every 100 ms).
 * --dist works too.  --skip-crash leaves the crash part out.
 */
import fs from 'node:fs';
import path from 'node:path';

const WORKLET = `
class NsRecorder extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.n = o.numberOfInputs;
    this.len = 187 * 128;
    this.pos = 0;
    this.first = true;
    this.alloc();
  }
  alloc() {
    this.bufs = [];
    for (let i = 0; i < this.n; i++) this.bufs.push([new Float32Array(this.len), new Float32Array(this.len)]);
  }
  process(inputs) {
    if (this.first) { this.first = false; this.port.postMessage({ t0: currentTime, sr: sampleRate }); }
    for (let i = 0; i < this.n; i++) {
      const inp = inputs[i];
      for (let c = 0; c < 2; c++) {
        const src = inp && inp[c];
        if (src) this.bufs[i][c].set(src, this.pos);
      }
    }
    this.pos += 128;
    if (this.pos >= this.len) {
      const tr = [];
      for (const b of this.bufs) { tr.push(b[0].buffer, b[1].buffer); }
      this.port.postMessage({ bufs: this.bufs }, tr);
      this.alloc();
      this.pos = 0;
    }
    return true;
  }
}
registerProcessor('ns-recorder', NsRecorder);
`;

export default async ({ page, sleep, log, args }) => {
  const outDir = path.resolve(String(args['out-dir'] || 'tools/tmp/audio/run'));
  fs.mkdirSync(outDir, { recursive: true });
  const ns = (expr) => page.evaluate(`(() => { const NS = window.__NS; return ${expr}; })()`);
  const waitState = async (states, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const s = await ns('NS.game.state');
      if ([].concat(states).includes(s)) return s;
      await sleep(100);
    }
    return ns('NS.game.state');
  };

  await sleep(1500);
  await ns('(NS.ctx.audio.unlock(), true)');
  for (let i = 0; i < 100; i++) {
    if (await ns("NS.ctx.audio.health().state === 'running' && !!NS.ctx.audio.debug()")) break;
    await sleep(100);
  }
  await sleep(1500); // sound bank warm-up, loops started

  const names = await page.evaluate(async (code) => {
    const NS = window.__NS;
    const A = NS.ctx.audio;
    const d = A.debug();
    const ctx = d.ctx;
    const taps = {
      master: d.master, engine: d.buses.engine, road: d.buses.road, ambience: d.buses.ambience, sfx: d.buses.sfx, ui: d.buses.ui,
      rainShower: A.rainGain, rainPatter: A.patterGain, spray: A.sprayGain, rumble: A.rumbleGain, wind: A.windGain,
      skid: A.skidGain, brake: A.brakeGain, scrape: A.scrapeGain, nitro: A.nitroGain,
    };
    const names = Object.keys(taps);
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'ns-recorder', {
      numberOfInputs: names.length, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit',
    });
    names.forEach((n, i) => taps[n].connect(node, 0, i));
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    const rec = (window.__rec = { names, chunks: [], t0: 0, sr: ctx.sampleRate, marks: [], frames: [], ctx });
    node.port.onmessage = (e) => {
      if (e.data.bufs) { if (!rec.stopped) rec.chunks.push(e.data.bufs); }
      else { rec.t0 = e.data.t0; rec.sr = e.data.sr; }
    };
    rec.mark = (name) => rec.marks.push({ name, t: +(ctx.currentTime - rec.t0).toFixed(3) });
    rec.timer = setInterval(() => {
      const f = NS.game.audioFrame;
      if (!f) return;
      rec.frames.push([+(ctx.currentTime - rec.t0).toFixed(2), f.state, +f.rpm01.toFixed(3), +f.throttle.toFixed(2), +f.speedKmh.toFixed(1),
        +f.skid.toFixed(3), +f.brake.toFixed(2), f.nitroActive ? 1 : 0, +f.scrape.toFixed(3), +f.rain.toFixed(2), +f.tunnel.toFixed(2)]);
    }, 100);
    return names;
  }, WORKLET);
  log('recording', names.join(', '));
  const mark = (name) => page.evaluate((n) => window.__rec.mark(n), name);
  await sleep(300);

  // ── the session
  await mark('menu');
  await sleep(8000);
  await mark('intro');
  await page.getByRole('button', { name: /^play$/i }).first().click();
  await waitState('playing', 12000);
  await ns('(NS.game.trafficScale = 0, NS.game.director.cooldown = 1e6, true)');
  await sleep(150);
  await ns('(NS.ctx.traffic.reset(), NS.autopilot(true), true)');
  await mark('accel');
  await sleep(9000);
  await mark('cruise');
  await sleep(9000);
  await mark('nitro');
  await page.keyboard.down('ShiftLeft');
  await sleep(3500);
  await page.keyboard.up('ShiftLeft');
  await ns('(NS.autopilot(false), true)');
  await mark('coast');
  await sleep(3500);
  await mark('brake');
  await page.keyboard.down('KeyS');
  for (let i = 0; i < 120; i++) {
    if ((await ns('NS.ctx.player.speedKmh')) < 2) break;
    await sleep(100);
  }
  await page.keyboard.up('KeyS');
  await mark('standing');
  await sleep(3500);
  await mark('pause');
  await page.keyboard.press('Escape');
  await sleep(3500);
  await page.keyboard.press('Escape');
  await waitState('playing', 5000);
  if (!args['skip-crash']) {
    await ns('(NS.game.trafficScale = 1, NS.teleport(NS.ctx.player.s + 600, 1.85, 55), true)');
    await mark('traffic');
    await sleep(500);
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    const st = await waitState(['crashed', 'gameover'], 90000);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    await mark('crash');
    log('state after the blind run:', st);
    await waitState('gameover', 15000);
    await mark('gameover');
    await sleep(7000);
  }
  await mark('end');

  // ── fetch the recording, one stream at a time
  const info = await page.evaluate(() => {
    const r = window.__rec;
    clearInterval(r.timer);
    r.stopped = true;
    return { sr: r.sr, marks: r.marks, frames: r.frames, samples: r.chunks.length * (r.chunks[0] ? r.chunks[0][0][0].length : 0), health: window.__NS.ctx.audio.health() };
  });
  const stats = {};
  for (let i = 0; i < names.length; i++) {
    const stereo = names[i] === 'master';
    const res = await page.evaluate(({ i, stereo }) => {
      const r = window.__rec;
      const n = r.chunks.length * r.chunks[0][0][0].length;
      const ch = stereo ? 2 : 1;
      const pcm = new Int16Array(n * ch);
      let peak = 0, over = 0, p = 0;
      for (const c of r.chunks) {
        const L = c[i][0], R = c[i][1];
        for (let k = 0; k < L.length; k++) {
          const a = L[k], b = R[k];
          const m = Math.max(Math.abs(a), Math.abs(b));
          if (m > peak) peak = m;
          if (m >= 0.999) over++;
          if (stereo) {
            pcm[p++] = Math.max(-32768, Math.min(32767, Math.round(a * 32767)));
            pcm[p++] = Math.max(-32768, Math.min(32767, Math.round(b * 32767)));
          } else pcm[p++] = Math.max(-32768, Math.min(32767, Math.round((a + b) * 0.5 * 32767)));
        }
      }
      const u8 = new Uint8Array(pcm.buffer);
      let s = '';
      for (let o = 0; o < u8.length; o += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(o, o + 0x8000));
      return { b64: btoa(s), peak, over, n, ch };
    }, { i, stereo });
    const data = Buffer.from(res.b64, 'base64');
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(res.ch, 22); h.writeUInt32LE(info.sr, 24); h.writeUInt32LE(info.sr * res.ch * 2, 28); h.writeUInt16LE(res.ch * 2, 32);
    h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(path.join(outDir, `${names[i]}.wav`), Buffer.concat([h, data]));
    stats[names[i]] = { floatPeak: +res.peak.toFixed(4), samplesAtFullScale: res.over };
  }
  fs.writeFileSync(path.join(outDir, 'marks.json'), JSON.stringify({ sampleRate: info.sr, marks: info.marks, stats, health: info.health,
    frameColumns: ['t', 'state', 'rpm01', 'throttle', 'speedKmh', 'skid', 'brake', 'nitro', 'scrape', 'rain', 'tunnel'], frames: info.frames }));
  log(`wrote ${names.length} WAV files (${(info.samples / info.sr).toFixed(1)} s at ${info.sr} Hz) and marks.json to ${outDir}`);
  log('marks', info.marks.map((m) => `${m.name}@${m.t}`).join(' '));
};
