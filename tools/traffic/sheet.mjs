// Contact sheet for the traffic sandbox (use with tools/shot.mjs --script).
//   node tools/shot.mjs --page "sandbox/traffic.html?car=0&type=sedan" --script tools/traffic/sheet.mjs \
//        --out screenshots/traffic-sheet.png --label traffic [--size 800x450]
// env TRAFFIC_TYPES=sedan,hatch  TRAFFIC_VIEWS=rear,front
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

export default async ({ page, shot, sleep, log, root, args }) => {
  const types = (process.env.TRAFFIC_TYPES || 'sedan,hatch,suv,sports,van,boxtruck,semi,tanker').split(',');
  const views = (process.env.TRAFFIC_VIEWS || 'rear,front').split(',');
  const out = path.resolve(root, args.out || 'screenshots/traffic-sheet.png');
  const tmp = path.join(path.dirname(out), '_tmp_traffic');
  fs.mkdirSync(tmp, { recursive: true });
  const files = [];
  for (const t of types) {
    for (const v of views) {
      await page.evaluate(([t, v]) => window.__traffic.show(t, v), [t, v]);
      await sleep(450);
      files.push(await shot(path.join(tmp, `${t}-${v}.png`)));
    }
  }
  const meta = await sharp(files[0]).metadata();
  const W = Math.round(meta.width / 2), H = Math.round(meta.height / 2);
  const cols = views.length * (types.length > 4 ? 2 : 1);
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(W, H).png().toBuffer()));
  await sharp({ create: { width: W * cols, height: H * rows, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
    .png()
    .toFile(out);
  for (const f of files) fs.unlinkSync(f);
  fs.rmdirSync(tmp);
  log('sheet', path.relative(root, out), `${cols}x${rows}`);
};
