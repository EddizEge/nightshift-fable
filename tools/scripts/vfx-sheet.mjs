/**
 * Contact sheet of chosen frames (agent "vfx"):
 *   node tools/scripts/vfx-sheet.mjs <out.png> <tileWidth> <cols> <img1> <img2> ...
 */
import sharp from 'sharp';

const [out, tw, cols, ...files] = process.argv.slice(2);
const w = Number(tw);
const c = Number(cols);
const h = Math.round((w * 9) / 16);
const tiles = await Promise.all(
  files.map((f) =>
    sharp(f)
      .resize(w, h)
      .composite([{ input: Buffer.from(`<svg width="${w}" height="18"><rect width="${w}" height="18" fill="black" opacity="0.6"/><text x="4" y="13" font-size="12" fill="white" font-family="monospace">${f.replace(/^.*[\\/]/, '')}</text></svg>`), left: 0, top: 0 }])
      .toBuffer(),
  ),
);
const rows = Math.ceil(files.length / c);
await sharp({ create: { width: c * w, height: rows * h, channels: 3, background: '#000' } })
  .composite(tiles.map((input, i) => ({ input, left: (i % c) * w, top: Math.floor(i / c) * h })))
  .png()
  .toFile(out);
console.log('saved', out);
