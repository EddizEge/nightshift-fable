#!/usr/bin/env node
/**
 * Contact sheet for UI review rounds (agent "ui").
 *   node tools/scripts/ui-sheet.mjs <out.png> <cols> <cellWidth> <img[=caption]>...
 * Each image is scaled to cellWidth (aspect kept) and captioned underneath.
 */
import sharp from 'sharp';
import path from 'node:path';

const [out, colsArg, cwArg, ...items] = process.argv.slice(2);
const cols = Number(colsArg) || 2;
const cw = Number(cwArg) || 800;
const capH = 26;

const cells = [];
for (const it of items) {
  const [file, cap] = it.split('=');
  const img = sharp(file);
  const m = await img.metadata();
  const hgt = Math.round((m.height / m.width) * cw);
  const buf = await img.resize(cw, hgt).png().toBuffer();
  cells.push({ buf, hgt, cap: cap || path.basename(file) });
}
const rows = Math.ceil(cells.length / cols);
const rowH = [];
for (let r = 0; r < rows; r++) rowH.push(Math.max(...cells.slice(r * cols, r * cols + cols).map((c) => c.hgt)) + capH);
const W = cols * cw + (cols + 1) * 6;
const H = rowH.reduce((a, b) => a + b + 6, 6);
const comps = [];
let y = 6;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const cell = cells[r * cols + c];
    if (!cell) continue;
    const x = 6 + c * (cw + 6);
    comps.push({ input: cell.buf, left: x, top: y });
    const esc = cell.cap.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const svg = `<svg width="${cw}" height="${capH}" xmlns="http://www.w3.org/2000/svg"><text x="4" y="18" font-family="Segoe UI, sans-serif" font-size="15" fill="#fff">${esc}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: x, top: y + cell.hgt });
  }
  y += rowH[r] + 6;
}
await sharp({ create: { width: W, height: H, channels: 3, background: '#202226' } }).composite(comps).png().toFile(out);
console.log('sheet', out, W + 'x' + H);
