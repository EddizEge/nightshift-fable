/**
 * tools/shot.mjs --script for the VFX sandbox (page must use ctl=1):
 *   node tools/shot.mjs --label vfx --page "sandbox/vfx.html?ctl=1&fx=explosion" \
 *     --script src/vfx/tools/timelapse.mjs --times 0.05,0.2,0.5,1,2,4 --sheet screenshots/vfx-sheet.png
 * Triggers the effect, steps the deterministic VFX clock to each time, screenshots, measures GPU
 * frame time at each step (and idle before the trigger) and montages one labelled contact sheet.
 */
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export default async ({ page, shot, sleep, log, args, root }) => {
  const times = String(args.times || '0.05,0.2,0.5,1,2,4').split(',').map(Number);
  const sheet = String(args.sheet || 'screenshots/vfx-sheet.png');
  const cols = Number(args.cols || 3);
  const tw = Number(args.tw || 640);
  const raf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))));
  const gpu = async (frames) => {
    await page.evaluate(() => window.__gpu(true));
    for (let i = 0; i < frames; i++) await raf();
    return page.evaluate(() => window.__gpu());
  };
  await sleep(300);
  const idle = await gpu(20);
  const idleStats = await page.evaluate(() => window.__stats());
  log('idle gpu', idle.ms.toFixed(2), 'ms', JSON.stringify(idleStats));
  await page.evaluate(() => window.__fx());
  const files = [];
  const labels = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-tl-'));
  for (const t of times) {
    await page.evaluate((t) => window.__vfxGoto(t), t);
    await page.waitForFunction((t) => window.__vfxAt >= t - 1e-4, t, { timeout: 60000, polling: 'raf' });
    await raf();
    const g = await gpu(12);
    const st = await page.evaluate(() => window.__stats());
    const f = path.join(tmp, `t${t}.png`);
    await shot(f);
    files.push(f);
    const label = `t=${t}s  gpu ${g.ms.toFixed(2)}ms (idle ${idle.ms.toFixed(2)})  calls ${st.calls}  puffs ${st.puffs} sparks ${st.sparks} deb ${st.debris} cpu ${st.cpuMs.toFixed(2)}ms`;
    labels.push(label);
    log(label);
  }
  // contact sheet
  const meta = await sharp(files[0]).metadata();
  const th = Math.round((tw * meta.height) / meta.width);
  const rows = Math.ceil(files.length / cols);
  const tiles = [];
  for (let i = 0; i < files.length; i++) {
    const img = await sharp(files[i]).resize(tw, th).toBuffer();
    const svg = Buffer.from(
      `<svg width="${tw}" height="22"><rect width="100%" height="100%" fill="black" fill-opacity="0.55"/><text x="6" y="15" font-family="Consolas,monospace" font-size="12" fill="#e8e8e8">${labels[i]}</text></svg>`,
    );
    tiles.push({ input: img, left: (i % cols) * tw, top: Math.floor(i / cols) * th });
    tiles.push({ input: svg, left: (i % cols) * tw, top: Math.floor(i / cols) * th });
  }
  await sharp({ create: { width: tw * cols, height: th * rows, channels: 3, background: '#000' } })
    .composite(tiles)
    .png()
    .toFile(path.resolve(root, sheet));
  log('sheet', sheet);
  fs.rmSync(tmp, { recursive: true, force: true });
};
