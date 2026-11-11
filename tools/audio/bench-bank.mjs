#!/usr/bin/env node
/** Times every one-shot recipe and loop render at a given sample rate (main-thread cost of SfxBank.warm()).
 *   node tools/audio/bench-bank.mjs [sr=48000] */
import { createServer } from 'vite';
const sr = Number(process.argv[2] ?? 48000);
const server = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
try {
  const bank = await server.ssrLoadModule('/src/audio/bank.ts');
  const dsp = await server.ssrLoadModule('/src/audio/dsp.ts');
  const loops = await server.ssrLoadModule('/src/audio/loops.ts');
  let t = performance.now();
  loops.getLoops(sr);
  console.log(`loops ${(performance.now() - t).toFixed(0)} ms`);
  let total = 0;
  const rows = [];
  for (const name of bank.SFX_NAMES) {
    const def = bank.SFX[name];
    let worst = 0;
    for (let v = 0; v < def.variants; v++) {
      t = performance.now();
      const st = def.render(sr, dsp.rng(v + 1));
      const ms = performance.now() - t;
      worst = Math.max(worst, ms);
      total += ms;
      void st;
    }
    rows.push(`${name}:${worst.toFixed(0)}`);
  }
  console.log(`sr ${sr}: total ${total.toFixed(0)} ms; worst variant per sound: ${rows.join(' ')}`);
} finally {
  await server.close();
}
