#!/usr/bin/env node
/**
 * Candidate-review helper: lays out a set of images as a labelled grid so texture candidates can be
 * compared side by side (used while choosing sources; not part of the runtime build).
 *
 *   node tools/textures/montage.mjs --out screenshots/textures-candidates.png --cell 200 --cols 8 file1.png file2.png ...
 */
import sharp from 'sharp';
import path from 'node:path';

const args = process.argv.slice(2);
let out = 'montage.png';
let cell = 200;
let cols = 8;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--cell') cell = Number(args[++i]);
  else if (args[i] === '--cols') cols = Number(args[++i]);
  else files.push(args[i]);
}

const label = 18;
const rows = Math.ceil(files.length / cols);
const esc = (s) => s.replace(/[<>&]/g, '');
const comps = [];
for (let i = 0; i < files.length; i++) {
  const x = (i % cols) * cell;
  const y = Math.floor(i / cols) * (cell + label);
  try {
    const buf = await sharp(files[i]).resize(cell, cell, { fit: 'cover' }).removeAlpha().png().toBuffer();
    comps.push({ input: buf, left: x, top: y + label });
  } catch (e) {
    console.warn('skip', files[i], e.message);
  }
  const name = esc(path.basename(files[i]).replace(/\.[a-z]+$/i, ''));
  const svg = `<svg width="${cell}" height="${label}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="3" y="13" font-family="Arial" font-size="12" fill="#eee">${name}</text></svg>`;
  comps.push({ input: Buffer.from(svg), left: x, top: y });
}
await sharp({ create: { width: cols * cell, height: rows * (cell + label), channels: 3, background: '#222' } })
  .composite(comps)
  .png()
  .toFile(out);
console.log('wrote', out);
