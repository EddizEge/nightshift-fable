// Review script for tools/shot.mjs: visits several sandbox views and writes one contact sheet.
//   node tools/shot.mjs --page "sandbox/structures.html?s=700" --script src/world/features/structures/tools/review.mjs \
//        --label structures --views "s=700&cam=chase;s=740&cam=low" --out screenshots/structures-sheet.png
import sharp from 'sharp';
import path from 'node:path';

export default async ({ page, shot, sleep, log, baseUrl, args, root }) => {
  const views = String(args.views || 's=700&cam=chase').split(';');
  const out = String(args.out || 'screenshots/structures-sheet.png');
  const tiles = [];
  for (let i = 0; i < views.length; i++) {
    const url = `${baseUrl}sandbox/structures.html?${views[i]}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', null, { timeout: 60000, polling: 100 });
    await sleep(400);
    const f = await shot(out.replace(/\.png$/, `-v${i}.png`));
    tiles.push(await sharp(f).resize(800, 450).toBuffer());
    log('view', views[i]);
  }
  const cols = views.length > 2 ? 2 : 1;
  const rows = Math.ceil(views.length / cols);
  await sharp({ create: { width: 800 * cols, height: 450 * rows, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * 800, top: Math.floor(i / cols) * 450 })))
    .png()
    .toFile(path.resolve(root, out));
  log('sheet', out);
};
