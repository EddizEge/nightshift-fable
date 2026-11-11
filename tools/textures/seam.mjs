#!/usr/bin/env node
/**
 * Tiling-seam metric. For each axis compares the mean absolute difference across the wrap edge
 * (last column vs first column) with the mean difference between neighbouring interior columns.
 * A ratio near 1 means the wrap is as smooth as the interior (seamless); > ~2 means a visible seam.
 *
 *   node tools/textures/seam.mjs file1 [file2 ...]
 * Also exported as seamRatio(file) for build.mjs.
 */
import sharp from 'sharp';
import { pathToFileURL } from 'node:url';

export async function seamRatio(file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ch = info.channels;
  const px = (x, y) => data[(y * w + x) * ch];
  let edgeX = 0, inX = 0, edgeY = 0, inY = 0;
  for (let y = 0; y < h; y++) {
    edgeX += Math.abs(px(w - 1, y) - px(0, y));
    // interior reference: a handful of column pairs spread across the image
    for (const x of [w >> 3, w >> 2, w >> 1, (3 * w) >> 2]) inX += Math.abs(px(x, y) - px(x + 1, y)) / 4;
  }
  for (let x = 0; x < w; x++) {
    edgeY += Math.abs(px(x, h - 1) - px(x, 0));
    for (const y of [h >> 3, h >> 2, h >> 1, (3 * h) >> 2]) inY += Math.abs(px(x, y) - px(x, y + 1)) / 4;
  }
  return { x: edgeX / Math.max(inX, 1e-6), y: edgeY / Math.max(inY, 1e-6) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const f of process.argv.slice(2)) {
    const r = await seamRatio(f);
    console.log(`${f}  seamX ${r.x.toFixed(2)}  seamY ${r.y.toFixed(2)}`);
  }
}
