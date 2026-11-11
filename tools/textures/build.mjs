#!/usr/bin/env node
/**
 * NIGHTSHIFT texture pipeline (reproducible).
 *
 *   node tools/textures/build.mjs            # download (cached) + process everything
 *   node tools/textures/build.mjs --offline  # fail instead of downloading missing sources
 *
 * 1. Downloads the CC0 source maps (Poly Haven / ambientCG) with curl into assets-src/textures/src/
 *    (cached; Poly Haven files are md5-verified). Downloads are treated as data only: zips are
 *    unpacked with `unzip -j` restricted to the image maps we need, nothing in them is executed.
 * 2. Grades / converts them with sharp into public/assets/textures/*.webp (power-of-two, tiling-safe
 *    resampling, OpenGL normals, renormalised).
 * 3. Generates the procedural maps (grunge mask, RGBA noise, fbm) with tools/textures/noise.mjs.
 * 4. Copies the fallback night HDRI.
 * 5. Writes screenshots/textures-contact.png (every map tiled 2×2 so seams show) and prints a report
 *    (sizes, budget, asphalt luminance, seam ratios), also saved as assets-src/textures/build-report.json.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fbm, worley, field, normalize, equalize, blurWrap, rng } from './noise.mjs';
import { seamRatio } from './seam.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(root, 'assets-src/textures/src');
const OUT = path.join(root, 'public/assets/textures');
const SHOT = path.join(root, 'screenshots/textures-contact.png');
const OFFLINE = process.argv.includes('--offline');
const BUDGET_BYTES = 12 * 1024 * 1024;

sharp.concurrency(2); // keep the machine responsive (the user may be gaming)

// ───────────────────────────────────────────────────────────── source definitions

/**
 * grade.lum      target mean sRGB luma (0–255, Rec.709 weights on encoded values); null = keep
 * grade.neutral  0–1, how far to pull the per-channel means together (1 = fully grey-balanced)
 * grade.sat      saturation multiplier applied in linear space after balancing
 * rough          { lo, hi } linear remap of the source roughness (output = lo + r·(hi-lo))
 * normalScale    multiplies the tangent-space XY before renormalising (1 = source strength)
 */
const MATERIALS = [
  {
    name: 'asphalt', size: 2048, src: { kind: 'acg', id: 'Asphalt015', res: '2K' },
    grade: { lum: 68, neutral: 1, sat: 0.6 }, rough: { lo: 0.04, hi: 1.0 }, normalScale: 1,
    tile: 4, note: 'Dense wearing course with fine aggregate. Graded from light grey to dry dark neutral asphalt.',
  },
  {
    name: 'asphalt2', size: 1024, src: { kind: 'acg', id: 'Asphalt031', res: '2K' },
    grade: { lum: 76, neutral: 1, sat: 0.6 }, rough: { lo: 0.0, hi: 1.0 }, normalScale: 1,
    tile: 4, note: 'Coarser, patchier, more worn asphalt for shoulders / patch variation; slightly lighter than the main lanes.',
  },
  {
    name: 'concrete', size: 1024, src: { kind: 'acg', id: 'Concrete024', res: '2K' },
    grade: { lum: 150, neutral: 0.8, sat: 0.7 }, rough: { lo: 0, hi: 1 }, normalScale: 1,
    tile: 2, note: 'Smooth cast concrete with faint blotches and pores (Jersey barriers, parapets, piers).',
  },
  {
    name: 'concrete_panel', size: 1024, src: { kind: 'ph', id: 'concrete', res: '2k' },
    grade: { lum: 120, neutral: 0.75, sat: 0.6 }, rough: { lo: 0, hi: 1 }, normalScale: 1,
    tile: 4, note: 'Weathered board/panel-formed concrete with vertical joints every ~1 m (retaining & tunnel walls, overpasses). Joints run along V.',
  },
  {
    name: 'metal_galv', size: 512, src: { kind: 'acg', id: 'Metal011', res: '1K' },
    grade: { lum: 180, neutral: 1, sat: 0.3 }, rough: { lo: 0, hi: 1 }, normalScale: 1,
    tile: 1, note: 'Galvanised / brushed steel; albedo is the metal F0 colour (use metalness = 1). Brushing runs along U.',
  },
  {
    name: 'metal_corrugated', size: 1024, src: { kind: 'ph', id: 'corrugated_iron_03', res: '2k' },
    grade: { lum: null, neutral: 0.3, sat: 0.85 }, rough: { lo: 0, hi: 1 }, normalScale: 1,
    tile: 2, note: 'Painted corrugated steel cladding with fastener rows and small rust runs (warehouses). Ribs run along V. Painted → metalness ≈ 0.',
  },
];

const HDRI = { id: 'kloppenheim_04', res: '1k', out: 'night_sky_1k.hdr' };

// ───────────────────────────────────────────────────────────── download helpers

function curl(url, dest) {
  if (OFFLINE) throw new Error(`missing source (offline): ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  execFileSync('curl', ['-sSL', '--fail', '--retry', '3', '-o', tmp, url], { stdio: 'inherit' });
  fs.renameSync(tmp, dest);
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function phFiles(id) {
  const f = path.join(SRC, 'meta', `ph_files_${id}.json`);
  if (!fs.existsSync(f)) curl(`https://api.polyhaven.com/files/${id}`, f);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** Returns { albedo, normal, rough } local paths for a material source. */
function fetchSource(src) {
  const dir = path.join(SRC, src.id);
  if (src.kind === 'ph') {
    const files = phFiles(src.id);
    // Poly Haven names: Diffuse / nor_gl (OpenGL, +Y up) / Rough
    const pick = (key) => {
      const e = files[key]?.[src.res]?.jpg;
      if (!e) throw new Error(`${src.id}: no ${key} ${src.res} jpg`);
      const dest = path.join(dir, path.basename(new URL(e.url).pathname));
      if (!fs.existsSync(dest) || md5(dest) !== e.md5) curl(e.url, dest);
      if (md5(dest) !== e.md5) throw new Error(`md5 mismatch ${dest}`);
      return dest;
    };
    return { albedo: pick('Diffuse'), normal: pick('nor_gl'), rough: pick('Rough') };
  }
  // ambientCG: zip with <ID>_<RES>-JPG_{Color,NormalGL,Roughness}.jpg
  const base = `${src.id}_${src.res}-JPG`;
  const want = { albedo: `${base}_Color.jpg`, normal: `${base}_NormalGL.jpg`, rough: `${base}_Roughness.jpg` };
  const have = Object.values(want).every((f) => fs.existsSync(path.join(dir, f)));
  if (!have) {
    const zip = path.join(dir, `${base}.zip`);
    if (!fs.existsSync(zip)) curl(`https://ambientcg.com/get?file=${base}.zip`, zip);
    // -j: junk paths (no traversal), only the three image members are extracted
    execFileSync('unzip', ['-o', '-j', '-q', zip, ...Object.values(want), '-d', dir], { stdio: 'inherit' });
  }
  return Object.fromEntries(Object.entries(want).map(([k, f]) => [k, path.join(dir, f)]));
}

// ───────────────────────────────────────────────────────────── image helpers

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const l2s = (l) => {
  l = Math.min(1, Math.max(0, l));
  return (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055) * 255;
};

/**
 * Resample a tiling image to size×size without breaking the wrap: pad with a repeated copy of the
 * image (so the filter kernel sees the neighbouring tile), resize, crop the centre back out.
 */
async function resizeTiling(file, size, channels) {
  let img = sharp(file).removeAlpha();
  if (channels === 1) img = img.greyscale();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  if (info.width !== info.height) throw new Error(`${file}: not square (${info.width}x${info.height})`);
  if (info.width === size) return { data, ch: info.channels };
  const pad = info.width / 8;
  const padded = await sharp(data, { raw: info })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'repeat' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const big = Math.round(size * 1.25);
  const resized = await sharp(padded.data, { raw: padded.info })
    .resize(big, big, { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const off = (big - size) / 2;
  const out = await sharp(resized.data, { raw: resized.info })
    .extract({ left: off, top: off, width: size, height: size })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, ch: out.info.channels };
}

function meanLuma(data, ch) {
  let s = 0;
  const n = data.length / ch;
  for (let i = 0; i < data.length; i += ch) s += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return s / n;
}

function channelMeans(data, ch) {
  const m = [0, 0, 0];
  for (let i = 0; i < data.length; i += ch) for (let c = 0; c < 3; c++) m[c] += data[i + c];
  const n = data.length / ch;
  return m.map((v) => v / n);
}

/** Colour grading in linear light: grey-balance, desaturate, then scale to the target mean luma. */
function gradeAlbedo(data, ch, { lum, neutral, sat }) {
  const n = data.length / ch;
  const lin = new Float32Array(n * 3);
  const m = [0, 0, 0];
  for (let i = 0, j = 0; i < data.length; i += ch, j += 3) {
    for (let c = 0; c < 3; c++) { lin[j + c] = S2L[data[i + c]]; m[c] += lin[j + c]; }
  }
  const L = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  const gain = m.map((v) => (L / v) ** neutral);
  for (let j = 0; j < lin.length; j += 3) {
    const r = lin[j] * gain[0], g = lin[j + 1] * gain[1], b = lin[j + 2] * gain[2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lin[j] = y + (r - y) * sat; lin[j + 1] = y + (g - y) * sat; lin[j + 2] = y + (b - y) * sat;
  }
  const out = Buffer.alloc(n * 3);
  const encode = (k) => {
    for (let j = 0; j < lin.length; j++) out[j] = Math.round(l2s(lin[j] * k));
  };
  let k = 1;
  encode(k);
  if (lum != null) {
    // Exposure scale is multiplicative in linear light (keeps the material's relative contrast);
    // iterate because mean sRGB luma is non-linear in k.
    for (let it = 0; it < 8; it++) {
      const cur = meanLuma(out, 3);
      if (Math.abs(cur - lum) < 0.3) break;
      k *= S2L[Math.round(lum)] / S2L[Math.max(1, Math.round(cur))];
      encode(k);
    }
  }
  return out;
}

/** Decode RGB normal map (OpenGL), optional XY scale, renormalise, re-encode. */
function processNormal(data, ch, scale) {
  const n = data.length / ch;
  const out = Buffer.alloc(n * 3);
  for (let i = 0, j = 0; i < data.length; i += ch, j += 3) {
    let x = (data[i] / 255) * 2 - 1, y = (data[i + 1] / 255) * 2 - 1, z = (data[i + 2] / 255) * 2 - 1;
    x *= scale; y *= scale;
    z = Math.max(z, 0.02);
    const l = Math.hypot(x, y, z);
    out[j] = Math.round(((x / l) * 0.5 + 0.5) * 255);
    out[j + 1] = Math.round(((y / l) * 0.5 + 0.5) * 255);
    out[j + 2] = Math.round(((z / l) * 0.5 + 0.5) * 255);
  }
  return out;
}

function remapRough(data, { lo, hi }) {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round(Math.min(255, Math.max(0, lo * 255 + data[i] * (hi - lo))));
  return out;
}

async function writeWebp(buf, size, channels, file, quality) {
  await sharp(buf, { raw: { width: size, height: size, channels } })
    .webp({ quality, effort: 6, smartSubsample: true, alphaQuality: 100 })
    .toFile(file);
}

const QUALITY = { albedo: 88, normal: 94, rough: 86 };

async function buildMaterial(m, report) {
  const files = fetchSource(m.src);
  const s = m.size;

  const a = await resizeTiling(files.albedo, s, 3);
  const albedo = gradeAlbedo(a.data, a.ch, m.grade);
  await writeWebp(albedo, s, 3, path.join(OUT, `${m.name}_albedo.webp`), QUALITY.albedo);

  const nrm = await resizeTiling(files.normal, s, 3);
  const normal = processNormal(nrm.data, nrm.ch, m.normalScale);
  await writeWebp(normal, s, 3, path.join(OUT, `${m.name}_normal.webp`), QUALITY.normal);

  const r = await resizeTiling(files.rough, s, 1);
  const rough = remapRough(r.data, m.rough);
  await writeWebp(rough, s, 1, path.join(OUT, `${m.name}_rough.webp`), QUALITY.rough);

  const nMean = channelMeans(normal, 3);
  report.materials[m.name] = {
    source: m.src,
    size: s,
    albedoMeanRGB: channelMeans(albedo, 3).map((v) => +v.toFixed(1)),
    albedoMeanLuma: +meanLuma(albedo, 3).toFixed(1),
    roughMean: +(rough.reduce((x, y) => x + y, 0) / rough.length / 255).toFixed(3),
    // a well-formed tangent-space map averages ≈ (128,128,~250); a flipped green channel would not
    // change the mean, so the GL convention is guaranteed by source choice (nor_gl / NormalGL).
    normalMeanRGB: nMean.map((v) => +v.toFixed(1)),
  };
}

// ───────────────────────────────────────────────────────────── procedural maps

const to8 = (arr) => Buffer.from(Array.from(arr, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)));

async function buildNoise(report) {
  const N = 256;
  // R: low-frequency fbm (4 cells across, 5 octaves) — large soft variation
  const R = normalize(field(N, N, (u, v) => fbm(u, v, { period: 4, octaves: 5, seed: 11 })), 0.005, 0.995);
  // G: higher-frequency fbm (16 cells across, 4 octaves) — detail breakup
  const G = normalize(field(N, N, (u, v) => fbm(u, v, { period: 16, octaves: 4, seed: 23 })), 0.005, 0.995);
  // B: inverted Worley F1 (8 cells) → bright billowy cell centres, dark creases
  const B = normalize(field(N, N, (u, v) => 1 - worley(u, v, 8, 37)));
  // A: blue-ish noise — white noise minus its (wrapped) blur keeps only the high frequencies,
  // rank-equalised back to a uniform histogram. Good for dithering / jittering.
  const r = rng(41);
  const white = Float32Array.from({ length: N * N }, () => r());
  const low = blurWrap(white, N, N, 2);
  const A = equalize(white.map((v, i) => v - low[i]));
  const rgba = Buffer.alloc(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    rgba[i * 4] = Math.round(R[i] * 255);
    rgba[i * 4 + 1] = Math.round(G[i] * 255);
    rgba[i * 4 + 2] = Math.round(B[i] * 255);
    rgba[i * 4 + 3] = Math.min(255, Math.floor(A[i] * 256));
  }
  await sharp(rgba, { raw: { width: N, height: N, channels: 4 } })
    .png({ compressionLevel: 9, palette: false })
    .toFile(path.join(OUT, 'noise_rgba.png'));

  const M = 512;
  const F = normalize(field(M, M, (u, v) => fbm(u, v, { period: 4, octaves: 7, gain: 0.52, seed: 59 })), 0.002, 0.998);
  await sharp(to8(F), { raw: { width: M, height: M, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, 'noise_fbm_512.png'));
  report.procedural.noise_rgba = { size: N, channels: 'R fbm p4 | G fbm p16 | B 1-worley p8 | A blue-ish noise' };
  report.procedural.noise_fbm_512 = { size: M, period: 4, octaves: 7 };
}

/**
 * Grunge mask: white = dirty. Mix of large blotchy stains (thresholded fbm), vertical leak streaks
 * (fbm with a tall anisotropic period, gated by a soft "source" band), and fine speckle.
 */
async function buildGrunge(report) {
  const N = 1024;
  const stains = field(N, N, (u, v) => {
    const warp = fbm(u, v, { period: 3, octaves: 3, seed: 71 }) * 0.08;
    const f = fbm(u + warp, v - warp, { period: 3, octaves: 6, gain: 0.55, seed: 73 });
    return smooth(-0.05, 0.55, f);
  });
  const streaks = field(N, N, (u, v) => {
    // 48 streak columns across, only 2 periods tall → long vertical runs
    const s = fbm(u, v, { period: 48, periodY: 2, octaves: 3, gain: 0.45, seed: 79 });
    const gate = smooth(0.0, 0.6, fbm(u, v, { period: 6, periodY: 3, octaves: 2, seed: 83 }));
    return smooth(0.15, 0.7, s) * gate;
  });
  const speck = field(N, N, (u, v) => smooth(0.35, 0.8, fbm(u, v, { period: 64, octaves: 2, seed: 89 })));
  const g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) {
    const v = 1 - (1 - stains[i] * 0.85) * (1 - streaks[i] * 0.9) * (1 - speck[i] * 0.35);
    g[i] = v;
  }
  normalize(g, 0.001, 0.999);
  await sharp(to8(g), { raw: { width: N, height: N, channels: 1 } })
    .webp({ quality: 88, effort: 6 })
    .toFile(path.join(OUT, 'grunge_mask.webp'));
  report.procedural.grunge_mask = { size: N, mean: +(g.reduce((a, b) => a + b, 0) / g.length).toFixed(3) };
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ───────────────────────────────────────────────────────────── HDRI

function fetchHdri() {
  const files = phFiles(HDRI.id);
  const e = files.hdri[HDRI.res].hdr;
  const dest = path.join(SRC, HDRI.id, path.basename(new URL(e.url).pathname));
  if (!fs.existsSync(dest) || md5(dest) !== e.md5) curl(e.url, dest);
  if (md5(dest) !== e.md5) throw new Error(`md5 mismatch ${dest}`);
  fs.copyFileSync(dest, path.join(OUT, HDRI.out));
  return dest;
}

/** Minimal Radiance RGBE reader (new-style RLE scanlines) → Float32 RGB, for preview/stats only. */
function readHdr(file) {
  const buf = fs.readFileSync(file);
  let p = 0;
  const line = () => {
    let s = '';
    while (buf[p] !== 0x0a) s += String.fromCharCode(buf[p++]);
    p++;
    return s;
  };
  if (!line().startsWith('#?')) throw new Error('not a Radiance file');
  let l;
  while ((l = line()) !== '') if (l.startsWith('FORMAT=') && !l.includes('32-bit_rle_rgbe')) throw new Error(l);
  const m = /-Y (\d+) \+X (\d+)/.exec(line());
  const h = +m[1], w = +m[2];
  const out = new Float32Array(w * h * 3);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (buf[p] !== 2 || buf[p + 1] !== 2) throw new Error('flat RGBE not supported');
    p += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < w) {
        let n = buf[p++];
        if (n > 128) { n -= 128; const v = buf[p++]; while (n--) scan[(x++) * 4 + c] = v; }
        else while (n--) scan[(x++) * 4 + c] = buf[p++];
      }
    }
    for (let x = 0; x < w; x++) {
      const e = scan[x * 4 + 3];
      const f = e ? 2 ** (e - 136) : 0;
      for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = scan[x * 4 + c] * f;
    }
  }
  return { w, h, data: out };
}

async function hdriPreview(file, report) {
  const { w, h, data } = readHdr(file);
  let sum = 0, max = 0, skySum = 0, skyN = 0;
  for (let i = 0; i < w * h; i++) {
    const y = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
    sum += y; if (y > max) max = y;
    if (i < (w * h) / 2) { skySum += y; skyN++; }
  }
  const mean = sum / (w * h);
  // auto-exposed Reinhard preview so the content is visible in the contact sheet
  const k = 0.18 / mean;
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < px.length; i++) { const v = data[i] * k; px[i] = Math.round(l2s(v / (1 + v))); }
  report.hdri = {
    id: HDRI.id, size: [w, h], meanLuminance: +mean.toExponential(3), upperHemisphereMean: +(skySum / skyN).toExponential(3),
    maxLuminance: +max.toFixed(3), previewExposure: +k.toFixed(1),
  };
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ───────────────────────────────────────────────────────────── contact sheet

async function tile2x2(file, cell, { channel } = {}) {
  let img = sharp(file);
  if (channel != null) {
    // extract in its own pass: inside one pipeline removeAlpha() would run first and drop channel 3
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const g = Buffer.alloc(info.width * info.height);
    for (let i = 0; i < g.length; i++) g[i] = data[i * info.channels + channel];
    img = sharp(g, { raw: { width: info.width, height: info.height, channels: 1 } });
  }
  const half = Math.floor(cell / 2);
  const t = await img.resize(half, half, { kernel: 'lanczos3' }).removeAlpha().toColourspace('srgb').png().toBuffer();
  return sharp({ create: { width: half * 2, height: half * 2, channels: 3, background: '#000' } })
    .composite([
      { input: t, left: 0, top: 0 }, { input: t, left: half, top: 0 },
      { input: t, left: 0, top: half }, { input: t, left: half, top: half },
    ])
    .png()
    .toBuffer();
}

/** Full-resolution 2×2 crop around the point where four copies meet (seam check at 1:1). */
async function seamCrop(file, cell) {
  const meta = await sharp(file).metadata();
  const half = Math.floor(cell / 2);
  const br = await sharp(file).extract({ left: meta.width - half, top: meta.height - half, width: half, height: half }).removeAlpha().png().toBuffer();
  const bl = await sharp(file).extract({ left: 0, top: meta.height - half, width: half, height: half }).removeAlpha().png().toBuffer();
  const tr = await sharp(file).extract({ left: meta.width - half, top: 0, width: half, height: half }).removeAlpha().png().toBuffer();
  const tl = await sharp(file).extract({ left: 0, top: 0, width: half, height: half }).removeAlpha().png().toBuffer();
  return sharp({ create: { width: half * 2, height: half * 2, channels: 3, background: '#000' } })
    .composite([{ input: br, left: 0, top: 0 }, { input: bl, left: half, top: 0 }, { input: tr, left: 0, top: half }, { input: tl, left: half, top: half }])
    .png()
    .toBuffer();
}

const esc = (s) => String(s).replace(/[<>&]/g, '');
const labelSvg = (w, h, text, sub) =>
  Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#101010"/>` +
    `<text x="6" y="16" font-family="Arial" font-size="14" font-weight="bold" fill="#f0f0f0">${esc(text)}</text>` +
    `<text x="6" y="33" font-family="Arial" font-size="12" fill="#a8a8a8">${esc(sub)}</text></svg>`);

async function contactSheet(report, hdriPng) {
  const cell = 300, lab = 40, cols = 6;
  const items = [];
  for (const m of MATERIALS) {
    for (const map of ['albedo', 'normal', 'rough']) {
      const f = path.join(OUT, `${m.name}_${map}.webp`);
      const seam = await seamRatio(f);
      report.materials[m.name][`seam_${map}`] = [+seam.x.toFixed(2), +seam.y.toFixed(2)];
      const info = report.materials[m.name];
      const sub = map === 'albedo' ? `luma ${info.albedoMeanLuma}  rgb ${info.albedoMeanRGB.map(Math.round).join('/')}  seam ${seam.x.toFixed(2)}/${seam.y.toFixed(2)}`
        : map === 'rough' ? `mean ${info.roughMean}  seam ${seam.x.toFixed(2)}/${seam.y.toFixed(2)}`
        : `mean ${info.normalMeanRGB.map(Math.round).join('/')}  seam ${seam.x.toFixed(2)}/${seam.y.toFixed(2)}`;
      items.push({ title: `${m.name}_${map} ${m.size}² (2×2)`, sub, img: await tile2x2(f, cell) });
    }
  }
  items.push({ title: 'asphalt_albedo 1:1 seam', sub: 'corner where 4 tiles meet', img: await seamCrop(path.join(OUT, 'asphalt_albedo.webp'), cell) });
  items.push({ title: 'asphalt_normal 1:1 seam', sub: 'corner where 4 tiles meet', img: await seamCrop(path.join(OUT, 'asphalt_normal.webp'), cell) });
  items.push({ title: 'grunge_mask 1024² (2×2)', sub: `mean ${report.procedural.grunge_mask.mean}`, img: await tile2x2(path.join(OUT, 'grunge_mask.webp'), cell) });
  const names = ['R low fbm', 'G high fbm', 'B 1-worley', 'A blue noise'];
  for (let c = 0; c < 4; c++) {
    items.push({ title: `noise_rgba.${'RGBA'[c]} (2×2)`, sub: names[c], img: await tile2x2(path.join(OUT, 'noise_rgba.png'), cell, { channel: c }) });
  }
  items.push({ title: 'noise_fbm_512 (2×2)', sub: '512² tiling fbm', img: await tile2x2(path.join(OUT, 'noise_fbm_512.png'), cell) });

  const rows = Math.ceil(items.length / cols);
  const hdriW = cols * cell, hdriH = hdriW / 2;
  const W = cols * cell, H = rows * (cell + lab) + lab + hdriH;
  const comps = [];
  items.forEach((it, i) => {
    const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + lab);
    comps.push({ input: labelSvg(cell, lab, it.title, it.sub), left: x, top: y });
    comps.push({ input: it.img, left: x, top: y + lab });
  });
  const hy = rows * (cell + lab);
  const h = report.hdri;
  comps.push({ input: labelSvg(W, lab, `night_sky_1k.hdr — ${h.id} (auto-exposed ×${h.previewExposure} for preview)`, `mean luminance ${h.meanLuminance}  upper hemisphere ${h.upperHemisphereMean}  max ${h.maxLuminance}`), left: 0, top: hy });
  comps.push({ input: await sharp(hdriPng).resize(hdriW, hdriH).png().toBuffer(), left: 0, top: hy + lab });
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#202020' } }).composite(comps).png().toFile(SHOT);
}

// ───────────────────────────────────────────────────────────── main

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(SRC, 'meta'), { recursive: true });
  const report = { materials: {}, procedural: {}, hdri: null, files: {}, totalBytes: 0 };
  for (const m of MATERIALS) {
    process.stdout.write(`material ${m.name} … `);
    await buildMaterial(m, report);
    console.log('ok');
  }
  await buildNoise(report);
  await buildGrunge(report);
  const hdrFile = fetchHdri();
  const hdriPng = await hdriPreview(hdrFile, report);
  await contactSheet(report, hdriPng);

  for (const f of fs.readdirSync(OUT).sort()) {
    const b = fs.statSync(path.join(OUT, f)).size;
    report.files[f] = b;
    report.totalBytes += b;
  }
  fs.writeFileSync(path.join(root, 'assets-src/textures/build-report.json'), JSON.stringify(report, null, 2));
  for (const [f, b] of Object.entries(report.files)) console.log(`${f.padEnd(32)} ${(b / 1024).toFixed(0).padStart(6)} KB`);
  console.log(`total ${(report.totalBytes / 1048576).toFixed(2)} MB / budget ${(BUDGET_BYTES / 1048576).toFixed(0)} MB`);
  for (const [n, m] of Object.entries(report.materials)) {
    console.log(`${n.padEnd(18)} luma ${m.albedoMeanLuma} rgb ${m.albedoMeanRGB.join('/')} rough ${m.roughMean} nrm ${m.normalMeanRGB.join('/')} seams A${m.seam_albedo} N${m.seam_normal} R${m.seam_rough}`);
  }
  console.log('hdri', JSON.stringify(report.hdri));
  if (report.totalBytes > BUDGET_BYTES) {
    console.error('OVER BUDGET');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
