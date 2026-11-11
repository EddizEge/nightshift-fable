/**
 * VFX sandbox (sandbox/vfx.html) on the shared kit: real renderer, wet road, lamps, player car.
 *
 * Query (plus every kit parameter: q, s, speed, t, cam, cs/cd/ch/ls/ld/lh, car, seed, fov):
 *   fx=explosion|tanker|fire|sparks|nitro|debris|smoke|all   effect to trigger
 *   scale=<n>      explosion / fire scale (tanker defaults to 2.5)
 *   at=<m>         distance ahead of the player (default 30)    fd=<m> lateral d (default 1.85)
 *   trig=<s>       kit time of the automatic trigger (default 0.5)
 *   ctl=1          manual clock: VFX + lighting time only advance via window.__vfxGoto(t)
 *                  (fixed 1/60 s steps, one per rendered frame) → exact, deterministic time-lapses
 *   repeat=<s>     re-trigger every <s> seconds (free-running mode)
 *   hud=0          hide the info line
 *
 * Window hooks: __vfx (IVfx + stats), __fx() trigger now, __vfxGoto(t) (ctl=1), __vfxAt (VFX
 * seconds since the trigger), __gpu() → { ms, n } average GPU frame time (EXT_disjoint_timer_query).
 */
import { Vector3 } from 'three';
import { createKit } from './kit';
import { createVfx } from '../vfx';
import type { FireHandle } from '../core/types';

const kit = createKit();
const P = kit.params;
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);
const fx = P.get('fx') || 'explosion';
const scale = num('scale', fx === 'tanker' ? 2.5 : 1);
const at = num('at', 30);
const fd = num('fd', 1.85);
const trig = num('trig', 0.5);
const manual = P.get('ctl') === '1';
const repeat = num('repeat', 0);

const vfx = createVfx(kit.ctx);
kit.ctx.vfx = vfx;
for (const e of vfx.distortionEffects) kit.engine.addDistortionEffect(e);

// ── clock: in manual mode the lighting (flash decay) and the VFX share a fixed-step clock ──
const STEP = 1 / 60;
let vfxClock = 0; // seconds of VFX time
let target = 0;
let frameDt = 0;
let trigClock = -1;
const lightUpdate = kit.lighting.update.bind(kit.lighting);
kit.lighting.update = (dt: number, time: number) => {
  frameDt = manual ? (target > vfxClock + 1e-6 ? Math.min(STEP, target - vfxClock) : 0) : dt;
  lightUpdate(frameDt, time);
};

// ── GPU timer around the whole frame ──
const gl = kit.engine.renderer.getContext() as WebGL2RenderingContext;
const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
const pending: WebGLQuery[] = [];
let gpuSum = 0;
let gpuN = 0;
const render = kit.engine.render.bind(kit.engine);
kit.engine.render = (f) => {
  let q: WebGLQuery | null = null;
  if (tq && pending.length < 6) {
    q = gl.createQuery();
    if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
  }
  render(f);
  if (q && tq) {
    gl.endQuery(tq.TIME_ELAPSED_EXT);
    pending.push(q);
  }
  while (pending.length && tq) {
    const head = pending[0];
    if (!gl.getQueryParameter(head, gl.QUERY_RESULT_AVAILABLE)) break;
    const ns = gl.getQueryParameter(head, gl.QUERY_RESULT) as number;
    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) {
      gpuSum += ns / 1e6;
      gpuN++;
    }
    gl.deleteQuery(head);
    pending.shift();
  }
};

// ── triggers ──
const pos = new Vector3();
const dir = new Vector3();
const vel = new Vector3();
let fires: FireHandle[] = [];
const fireTarget = { position: new Vector3() };
function spot(ahead: number, d: number, y: number, out: Vector3): Vector3 {
  return kit.ctx.road.toWorld(kit.player.s + ahead, d, y, out);
}
function trigger(): void {
  trigClock = vfxClock;
  const f = kit.ctx.road.frameAt(kit.player.s + at);
  switch (fx) {
    case 'tanker':
    case 'explosion':
      vfx.explosion(spot(at, fd, 0.6, pos), { scale, smoke: num('smoke', 12) });
      break;
    case 'fire':
      spot(at, fd, 0.1, fireTarget.position);
      fires.push(vfx.attachFire(fireTarget, scale, num('dur', 0)));
      break;
    case 'sparks':
      spot(at, fd, 0.3, pos);
      dir.set(-f.tx, 0.25, -f.tz);
      vfx.sparks(pos, dir, num('count', 160), num('spd', 16));
      break;
    case 'debris':
      spot(at, fd, 0.8, pos);
      vel.set(f.tx * 8, 2, f.tz * 8);
      vfx.debris(pos, vel, num('count', 14));
      break;
    case 'smoke':
      spot(at, fd, 0.5, pos);
      vel.set(0, 1, 0);
      vfx.smokePuff(pos, vel, scale);
      break;
    case 'nitro':
      vfx.setNitro(true, num('nitro', 1));
      break;
    case 'all':
      vfx.explosion(spot(at, fd, 0.6, pos), { scale });
      spot(at - 12, -4, 0.3, pos);
      dir.set(f.rx, 0.4, f.rz);
      vfx.sparks(pos, dir, 140, 18);
      vfx.setNitro(true, 1);
      break;
  }
}
const W = window as unknown as Record<string, unknown>;
W.__vfx = vfx;
W.__fx = () => trigger();
W.__vfxGoto = (t: number) => {
  // t = seconds after the trigger
  target = (trigClock >= 0 ? trigClock : vfxClock) + t;
};
W.__vfxAt = -1;
W.__gpu = (reset?: boolean) => {
  const r = { ms: gpuN ? gpuSum / gpuN : -1, n: gpuN, available: !!tq };
  if (reset) {
    gpuSum = 0;
    gpuN = 0;
  }
  return r;
};
W.__stats = () => ({ ...vfx.stats(), calls: kit.engine.stats.calls, tris: kit.engine.stats.triangles });

const info = document.getElementById('info');
const hud = P.get('hud') !== '0';
let lastRepeat = 0;
let triggered = false;
kit.onFrame((_dt, time) => {
  const dt = frameDt;
  if (!manual) {
    if (!triggered && time >= trig) {
      triggered = true;
      trigger();
      lastRepeat = time;
    } else if (repeat > 0 && triggered && time - lastRepeat >= repeat) {
      lastRepeat = time;
      if (fx !== 'fire' && fx !== 'nitro') trigger();
    }
  }
  vfxClock += dt;
  vfx.update(dt, vfxClock);
  W.__vfxAt = trigClock >= 0 ? vfxClock - trigClock : -1;
  if (info && hud && kit.ctx.time.frame % 10 === 0) {
    const s = vfx.stats();
    const g = W.__gpu as () => { ms: number };
    info.textContent = `fx=${fx} t=${(W.__vfxAt as number).toFixed(2)}  puffs ${s.puffs} sparks ${s.sparks} debris ${s.debris}  cpu ${s.cpuMs.toFixed(3)} ms  gpu ${g().ms.toFixed(2)} ms  calls ${kit.engine.stats.calls}`;
  }
});
void fires;

await vfx.ready;
await kit.start();

/** Debug: irradiance contributions at a road-space point ahead of the player (lamps / flashes / head). */
W.__probe = (ahead: number, d: number, y: number) => {
  const p = kit.ctx.road.toWorld(kit.player.s + ahead, d, y, new Vector3());
  const u = kit.lighting.uniforms;
  let lamps = 0;
  for (let i = 0; i < u.uLampPos.value.length; i++) {
    const lv = u.uLampPos.value[i].clone().sub(p);
    const d2 = lv.lengthSq();
    const down = Math.min(1, Math.max(0, (lv.y / Math.sqrt(d2 + 1e-3) + 0.12) * 2.2));
    lamps += (u.uLampColor.value[i].g * down) / (d2 + 4);
  }
  let flash = 0;
  for (let i = 0; i < 2; i++) flash += u.uFlashColor.value[i].g / (u.uFlashPos.value[i].distanceToSquared(p) + 9);
  const hv = p.clone().sub(u.uHeadPos.value);
  const r = hv.length();
  const c = hv.divideScalar(r).dot(u.uHeadDir.value);
  const cone = Math.min(1, Math.max(0, (c - u.uHeadCone.value.y) / (u.uHeadCone.value.x - u.uHeadCone.value.y)));
  const head = (u.uHeadColor.value.g * cone) / (r * r + 6);
  return { lamps, flash, head, amb: u.uAmbient.value.g };
};
