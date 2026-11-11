/**
 * Cinematic event probe: triggers one event and logs the stage every 250 ms, with a screenshot burst.
 *   node tools/shot.mjs --page "index.html?debug" --script tools/scripts/events.mjs --id chainReaction --prefix evA [--s 1400] [--cruise 55] [--manual 1]
 * --id chainReaction | lastSecondEscape   --s start arc length (default: A 1400, B 420)   --shots 10
 */
import path from 'node:path';
export default async ({ page, shot, sleep, log, args, root }) => {
  const id = args.id || 'chainReaction';
  const prefix = args.prefix || (id === 'chainReaction' ? 'evA' : 'evB');
  const startS = Number(args.s ?? (id === 'chainReaction' ? 1400 : 420));
  const maxShots = Number(args.shots ?? 10);
  await page.evaluate(() => window.__NS.start());
  await page.waitForFunction(() => window.__NS.game.state === 'playing', null, { timeout: 15000 });
  await page.evaluate(([s, cruise]) => {
    const NS = window.__NS; NS.autopilot(true); NS.game.autopilot.cruise = cruise; NS.game.autopilot.risk = 0.3; NS.teleport(s, 1.85, 45);
    const c = (window.__ev = { cin: [], expl: [], bonus: [], coll: 0 });
    NS.ctx.events.on('cinematic', (e) => c.cin.push(`${e.id}:${e.phase}@${NS.ctx.time.now.toFixed(1)}`));
    NS.ctx.events.on('explosion', (e) => c.expl.push({ t: +NS.ctx.time.now.toFixed(2), scale: e.scale, ahead: +(NS.ctx.road.project(e.position.x, e.position.z, NS.ctx.player.s).s - NS.ctx.player.s).toFixed(0), y: +e.position.y.toFixed(1) }));
    NS.ctx.events.on('bonus', (e) => c.bonus.push(e.label));
    NS.ctx.events.on('collision', () => c.coll++);
  }, [startS, Number(args.cruise ?? 55)]);
  await sleep(4000);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    ok = await page.evaluate((id) => window.__NS.trigger(id), id);
    if (!ok) await sleep(500);
  }
  log(`trigger ${id}: ${ok} at s=${await page.evaluate(() => window.__NS.ctx.player.s.toFixed(0))}`);
  const files = [];
  let shots = 0;
  let lastPhase = '';
  let sinceStart = -1;
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    const r = await page.evaluate(() => {
      const NS = window.__NS; const p = NS.ctx.player; const d = NS.game.director; const road = NS.ctx.road;
      const rel = (v) => { if (!v) return null; const b = NS.crash.bodies.find((x) => x.owner === v); const pos = b ? b.position : v.position; const pr = road.project(pos.x, pos.z, p.s); return `${v.type}:${v.mode} ds=${(pr.s - p.s).toFixed(0)} d=${pr.d.toFixed(1)} y=${pos.y.toFixed(1)}${b ? ' v=' + Math.hypot(b.linvel.x, b.linvel.z).toFixed(0) : ' v=' + v.speed.toFixed(0)}`; };
      const bB = d.bBody; const bV = d.bVisual;
      let bInfo = null;
      if (bV) { const pos = bB ? bB.position : bV.object.position; const pr = road.project(pos.x, pos.z, p.s); bInfo = `tanker ds=${(pr.s - p.s).toFixed(0)} d=${pr.d.toFixed(1)} y=${pos.y.toFixed(1)} ${bB ? 'body' : 'scripted'}`; }
      return { phase: d.phase, cur: d.current, t: +NS.ctx.time.now.toFixed(1), ps: +p.s.toFixed(0), pd: +p.d.toFixed(1), v: +(p.speed * 3.6).toFixed(0), state: NS.game.state, dmg: +p.damage.toFixed(2), scale: NS.ctx.time.scale, a: [rel(d.tanker), rel(d.truck), rel(d.follower)].filter(Boolean).join(' | '), b: bInfo, wrecks: NS.crash.bodies.length, ev: window.__ev };
    });
    if (r.phase !== lastPhase) { log(`PHASE ${lastPhase} → ${r.phase} at t=${r.t}`); lastPhase = r.phase; if (r.phase === 'running' || (id !== 'chainReaction' && r.phase === 'warned')) sinceStart = 0; }
    if (i % 2 === 0 || r.phase === 'running') log(`t=${r.t} ${r.state} ${r.phase} p(s=${r.ps} d=${r.pd} v=${r.v} dmg=${r.dmg} ts=${r.scale.toFixed(2)}) ${r.a || ''}${r.b ? ' ' + r.b : ''} wrecks=${r.wrecks}`);
    const want = id === 'chainReaction' ? (r.phase === 'running' || r.phase === 'aftermath') : (r.phase !== 'idle');
    if (want && shots < maxShots && (id === 'chainReaction' ? i % 2 === 0 : (r.b && Math.abs(parseFloat(r.b.split('ds=')[1])) < 260 && i % 2 === 0))) { shots++; files.push(await shot(`screenshots/${prefix}-${String(shots).padStart(2, '0')}.png`)); }
    if ((r.cur === null && i > 8) || r.state === 'gameover') { log(`END state=${r.state} cinematics=${r.ev.cin.join(' ')} explosions=${JSON.stringify(r.ev.expl)} bonus=${r.ev.bonus.join(',')} collisions=${r.ev.coll}`); break; }
  }
  if (files.length) {
    const sharp = (await import('sharp')).default;
    const cols = 3, w = 800, h = 450, rows = Math.ceil(files.length / cols);
    const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
    await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } }).composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h }))).png().toFile(path.resolve(root, `screenshots/${prefix}-sheet.png`));
    log(`saved screenshots/${prefix}-sheet.png`);
  }
};
