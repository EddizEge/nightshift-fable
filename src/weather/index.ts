/**
 * NIGHTSHIFT weather — the storm.
 *
 *   rain streaks   (LAYERS.MAIN_ONLY, 1 draw)   GPU-only wrap-around volume, motion-blurred by the
 *                                               drop velocity relative to the camera
 *   ground splashes(LAYERS.PARTICLES, 1 draw)   GPU-only crown sprites around the camera
 *   tyre spray     (LAYERS.PARTICLES, 1 draw)   pooled CPU emitters: player wheels, traffic, bursts
 *   lens rain      (postprocessing Effect)      `distortionEffects[0]`
 *
 * Rain coverage follows world.rainAt(s) sampled along the road around the camera (tunnels) and
 * the nearest overpass deck (shelter). update(dt) uses the scaled dt: slow motion shortens the
 * streaks (shutter = 1/48 s of real time) and makes the drops hang.
 */
import { Vector2, Vector3 } from 'three';
import type { GameContext, IWeather, QualitySettings, RoadFrame } from '../core/types';
import { clamp01, damp, noise1 } from '../core/math';
import { OVERPASS_CLEARANCE, OVERPASS_WIDTH } from '../world/roadProfile';
import { RAIN_LINE_N, RAIN_LINE_S0, RAIN_LINE_STEP, WRAP_T, createWeatherUniforms } from './shared';
import { RainStreaks } from './rainStreaks';
import { Splashes } from './splashes';
import { SprayPool } from './spray';
import { beginTails, emitBurst, emitPlayer, emitTraffic, endTails } from './sprayEmitters';
import type { SprayContext } from './sprayEmitters';
import { LensRainEffect } from './lensRain';

export { LensRainEffect } from './lensRain';

const SHUTTER = 1 / 48;
/** LCM of the rain box footprints (26 and 64 m → 832): wind offset wraps seamlessly. */
const WIND_WRAP = 832;

export function createWeather(ctx: GameContext): IWeather {
  const scene = ctx.engine.scene;
  const wu = createWeatherUniforms();
  let rain: RainStreaks;
  let splashes: Splashes;
  let spray: SprayPool;
  const lens = new LensRainEffect();

  const build = (q: QualitySettings) => {
    rain = new RainStreaks(ctx, wu, q.rainCount);
    splashes = new Splashes(ctx, wu, 1300 * q.particleScale);
    spray = new SprayPool(ctx, wu, 2500 * q.particleScale);
    scene.add(rain.mesh, splashes.mesh, spray.mesh);
    lens.enabled = q.lensRain;
  };
  const destroy = () => {
    scene.remove(rain.mesh, splashes.mesh, spray.mesh);
    rain.dispose();
    splashes.dispose();
    spray.dispose();
  };
  build(ctx.quality.settings);
  ctx.events.on('quality', (e) => {
    const s = e.settings;
    if (s.rainCount !== rain.count || Math.round(2500 * s.particleScale) !== spray.cap) {
      destroy();
      build(s);
    }
    lens.enabled = s.lensRain;
  });

  // ── state (all preallocated) ────────────────────────────────────────────
  let intensity = 1;
  let wTime = 0;
  let windT = 0;
  let camS = ctx.player.s;
  let cover = 1;
  // lightning (emitted by the backdrop): the flash briefly reveals the rain against the sky
  let flash = 0;
  let flashT = 0;
  ctx.events.on('lightning', (e) => {
    flash = Math.max(flash, Math.min(1, e.intensity));
    flashT = 0;
  });
  let haveLast = false;
  const lastCam = new Vector3();
  const camVel = new Vector3();
  const rawVel = new Vector3();
  const windOff = new Vector3();
  const fwd3 = new Vector3();
  const vp = new Vector2();
  const frame: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };
  const proj = { s: 0, d: 0 };
  const line = wu.uWRainLine.value;

  const sc: SprayContext = {
    pool: null as unknown as SprayPool,
    wetAt: (s: number) => ctx.world.rainAt(s),
    camX: 0,
    camZ: 0,
    intensity: 1,
    budget: 1,
    scale: 1,
    windX: 0,
    windZ: 0,
  };

  function update(dt: number, _time: number): void {
    const cam = ctx.engine.camera;
    const cp = cam.position;
    const realDt = ctx.time.rawDt > 0 ? ctx.time.rawDt : dt;
    const timeScale = realDt > 0 ? Math.min(2, dt / realDt) : 1;
    wTime = (wTime + dt) % WRAP_T;
    wu.uWTime.value = wTime;

    // camera velocity (scaled-time m/s) from its motion; robust to teleports / snaps
    if (haveLast && dt > 1e-5) {
      rawVel.subVectors(cp, lastCam).divideScalar(dt);
      if (rawVel.lengthSq() > 160 * 160) rawVel.copy(ctx.player.velocity);
      camVel.x = damp(camVel.x, rawVel.x, 14, dt);
      camVel.y = damp(camVel.y, rawVel.y, 14, dt);
      camVel.z = damp(camVel.z, rawVel.z, 14, dt);
    } else if (!haveLast) {
      camVel.copy(ctx.player.velocity);
    }
    lastCam.copy(cp);
    haveLast = true;
    wu.uWCamPos.value.copy(cp);
    wu.uWCamVel.value.copy(camVel);

    // road frame at the camera
    ctx.road.project(cp.x, cp.z, camS, proj);
    camS = proj.s;
    ctx.road.frameAt(camS, frame);
    wu.uWRoadFwd.value.set(frame.tx, frame.tz);
    wu.uWRoadOrigin.value.set(frame.x, frame.z);
    let anyRain = 0;
    for (let i = 0; i < RAIN_LINE_N; i++) {
      const r = ctx.world.rainAt(camS + RAIN_LINE_S0 + i * RAIN_LINE_STEP);
      line[i] = r;
      anyRain = Math.max(anyRain, r);
    }
    // overpass shelter
    const ov = ctx.world.nextOverpass(camS - 30);
    let sheltered = 0;
    if (ov !== null && ov - camS < 140) {
      ctx.road.frameAt(ov, frame);
      wu.uWRoof.value.set(frame.x, frame.z, frame.tx, frame.tz);
      wu.uWRoofP.value.set(OVERPASS_WIDTH * 0.5, OVERPASS_CLEARANCE);
      if (Math.abs(ov - camS) < OVERPASS_WIDTH * 0.5 && cp.y < OVERPASS_CLEARANCE) sheltered = 1;
    } else {
      wu.uWRoofP.value.set(0, -100);
    }
    const here = ctx.world.rainAt(camS) * (1 - sheltered);
    cover = damp(cover, here, 3, dt);

    // wind: slow base drift + gusts
    windT += dt;
    const gust = noise1(windT * 0.23, 7) * 2 - 1;
    const gust2 = noise1(windT * 0.9, 11) * 2 - 1;
    const wx = 2.2 + 2.0 * gust + 0.8 * gust2;
    const wz = 0.9 + 1.2 * (noise1(windT * 0.17, 3) * 2 - 1);
    wu.uWind.value.set(wx, 0, wz);
    windOff.x = (windOff.x + wx * dt) % WIND_WRAP;
    windOff.z = (windOff.z + wz * dt) % WIND_WRAP;

    ctx.engine.renderer.getDrawingBufferSize(vp);
    wu.uWViewport.value.copy(vp);
    wu.uWIntensity.value = intensity;

    // horizontal view direction
    cam.getWorldDirection(fwd3);
    let fx = fwd3.x;
    let fz = fwd3.z;
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-3) {
      fx /= fl;
      fz /= fl;
    } else {
      fx = frame.tx;
      fz = frame.tz;
    }
    const shutter = SHUTTER * timeScale;
    // slow motion: the same light lands on a much shorter streak, so the hanging drops read brighter
    const slowBoost = timeScale < 1 ? Math.min(2.5, 1 / Math.sqrt(Math.max(timeScale, 0.05))) : 1;
    const vis = anyRain > 0.001 && intensity > 0.001;
    // flash envelope: a double flicker over ~0.35 s of real time, then gone
    let lf = 0;
    if (flash > 0) {
      flashT += realDt;
      lf = flash * Math.exp(-flashT * 7) * (flashT < 0.12 || flashT > 0.2 ? 1 : 0.35);
      if (flashT > 0.8) flash = 0;
    }
    rain.update(cp, fx, fz, windOff, shutter, vis ? intensity : 0, vis ? (0.32 + 0.18 * intensity) * slowBoost : 0, vp.y, lf * cover);
    splashes.update(cp.x, cp.z, fx, fz, vis ? intensity : 0, vis ? 0.6 + 0.4 * intensity : 0);

    // spray
    sc.pool = spray;
    sc.camX = cp.x;
    sc.camZ = cp.z;
    sc.intensity = 0.25 + 0.75 * intensity;
    sc.scale = ctx.quality.settings.particleScale;
    const used = spray.alive / spray.cap;
    sc.budget = used < 0.7 ? 1 : clamp01((0.98 - used) / 0.28);
    sc.windX = wx;
    sc.windZ = wz;
    beginTails();
    if (dt > 0) {
      emitPlayer(sc, ctx.player, dt);
      emitTraffic(sc, ctx, dt);
    }
    endTails(sc);
    spray.update(dt, wx, wz, shutter);

    // lens
    const speed = camVel.length();
    lens.tick(dt, speed, intensity * cover);
  }

  return {
    update,
    setIntensity(i: number) {
      intensity = clamp01(i);
    },
    splash(position: Vector3, scale: number) {
      sc.pool = spray;
      sc.scale = ctx.quality.settings.particleScale;
      emitBurst(sc, position, scale);
    },
    reset() {
      spray.clear();
      lens.reset();
      haveLast = false;
      camVel.set(0, 0, 0);
      camS = ctx.player.s;
      cover = ctx.world.rainAt(camS);
      wTime = 0;
    },
    distortionEffects: [lens],
  };
}
