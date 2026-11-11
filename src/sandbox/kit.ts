/**
 * Sandbox kit: the real engine, road, lighting, world streaming, wet road, headlights and the
 * player car, driven along the highway at a constant speed. Feature sandboxes build on this so
 * they are tested inside the real renderer (lamp field, fog, reflections, particle pass).
 *
 * URL parameters (all optional):
 *   q=low|medium|high|ultra   quality preset (default high)
 *   s=<m>                     start arc length (default 60)          d=<m> lateral offset (default 1.85)
 *   speed=<m/s>               constant forward speed (default 0)
 *   t=<s>                     seconds to simulate before window.__ready (default 1.5)
 *   cam=chase|low|side|front|high|free
 *        free: cs,cd,ch = camera (s relative to the player, absolute d, height); ls,ld,lh = look-at
 *   car=0                     hide the player car
 *   seed=<n>                  world seed (default 1)
 */
import { Vector3 } from 'three';
import { EventBus } from '../core/events';
import { Input } from '../core/input';
import { Quality } from '../core/quality';
import type { GameContext, PlayerState, QualityLevel } from '../core/types';
import { Engine } from '../render/engine';
import { RoadPath } from '../world/roadPath';
import { LightField } from '../world/lightField';
import { WorldMaterials } from '../world/materials';
import { World } from '../world/world';
import { RoadSurface } from '../world/roadSurface';
import { Headlights } from '../game/headlights';
import { createPlayerState } from '../game/playerState';
import { createPlayerCarVisual } from '../vehicle/playerCarVisual';

export interface Kit {
  ctx: GameContext;
  engine: Engine;
  world: World;
  surface: RoadSurface;
  lighting: LightField;
  mats: WorldMaterials;
  headlights: Headlights;
  player: PlayerState;
  params: URLSearchParams;
  /** Run every frame before rendering. */
  onFrame(fn: (dt: number, time: number) => void): void;
  /** Start the loop. Sets window.__ready after `t` simulated seconds once textures and chunks are in. */
  start(): Promise<void>;
  /** Constant forward speed in m/s (can be changed while running). */
  speed: number;
}

export function createKit(): Kit {
  const params = new URLSearchParams(location.search);
  const num = (k: string, def: number) => (params.has(k) ? Number(params.get(k)) : def);
  let canvas = document.querySelector('canvas');
  if (!canvas) {
    document.body.style.cssText = 'margin:0;height:100vh;background:#000;overflow:hidden';
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    document.body.appendChild(canvas);
  }
  const events = new EventBus();
  const quality = new Quality(events, (params.get('q') as QualityLevel) || 'high');
  const engine = new Engine(canvas, quality, events);
  const seed = num('seed', 1);
  const road = new RoadPath(seed);
  const lighting = new LightField(road);
  const mats = new WorldMaterials(lighting);
  mats.anisotropy = quality.settings.anisotropy;
  const world = new World(engine.scene, road, lighting, quality, mats);
  world.reset(seed);
  const surface = new RoadSurface(lighting, quality, mats);
  world.addFeature('road', surface.build);
  engine.addReflectionReceiver(surface);
  const player = createPlayerState();
  const headlights = new Headlights(engine.scene, lighting, quality.settings);
  const ctx: GameContext = {
    engine,
    events,
    input: new Input(),
    quality,
    road,
    world,
    lighting,
    player,
    time: { now: 0, real: 0, dt: 0, rawDt: 0, scale: 1, frame: 0 },
    state: 'playing',
  };

  const frameFns: Array<(dt: number, time: number) => void> = [];
  const camMode = params.get('cam') || 'chase';
  const d0 = num('d', 1.85);
  let s = num('s', 60);
  const tReady = num('t', 1.5);
  const camPos = new Vector3();
  const camLook = new Vector3();

  const kit: Kit = {
    ctx,
    engine,
    world,
    surface,
    lighting,
    mats,
    headlights,
    player,
    params,
    speed: num('speed', 0),
    onFrame: (fn) => void frameFns.push(fn),
    start,
  };

  function placePlayer(dt: number): void {
    s += kit.speed * dt;
    const f = road.frameAt(s);
    player.s = s;
    player.d = d0;
    player.heading = f.h;
    player.position.set(f.x + f.rx * d0, 0, f.z + f.rz * d0);
    player.quaternion.set(0, Math.sin(-f.h * 0.5), 0, Math.cos(-f.h * 0.5));
    player.velocity.set(f.tx * kit.speed, 0, f.tz * kit.speed);
    player.speed = kit.speed;
    player.speedKmh = kit.speed * 3.6;
    player.throttle = kit.speed > 0 ? 0.5 : 0;
    const hw = player.dims.trackFront * 0.5;
    for (let i = 0; i < 4; i++) {
      const lf = i < 2 ? player.dims.frontAxle : -player.dims.rearAxle;
      const ls = i % 2 === 0 ? -hw : hw;
      player.wheelContacts[i].set(player.position.x + f.tx * lf + f.rx * ls, 0, player.position.z + f.tz * lf + f.rz * ls);
      player.wheelSpin[i] += (kit.speed / player.dims.wheelRadius) * dt;
    }
  }

  function placeCamera(): void {
    const cam = engine.camera;
    const rel: Record<string, [number, number, number, number, number, number]> = {
      // [cam s, cam d offset, cam height, look s, look d offset, look height] relative to the player
      chase: [-6.6, 0, 1.75, 14, 0, 0.7],
      low: [-5.2, 1.6, 0.55, 6, -0.4, 0.6],
      side: [0.5, 7.5, 1.3, 0.5, 0, 0.6],
      front: [9, -2.2, 0.9, 0, 0, 0.6],
      high: [-22, 3, 14, 30, 0, 0],
    };
    if (camMode === 'free') {
      road.toWorld(s + num('cs', -8), num('cd', d0), num('ch', 2), camPos);
      road.toWorld(s + num('ls', 20), num('ld', d0), num('lh', 1), camLook);
    } else {
      const r = rel[camMode] ?? rel.chase;
      road.toWorld(s + r[0], d0 + r[1], r[2], camPos);
      road.toWorld(s + r[3], d0 + r[4], r[5], camLook);
    }
    cam.position.copy(camPos);
    cam.lookAt(camLook);
    if (params.has('fov')) {
      cam.fov = num('fov', 58);
      cam.updateProjectionMatrix();
    }
  }

  async function start(): Promise<void> {
    const car = params.get('car') === '0' ? null : await createPlayerCarVisual({ lighting, anisotropy: quality.settings.anisotropy });
    if (car) {
      player.dims = car.dims;
      engine.scene.add(car.root);
      engine.onEnvMap((tex) => car.setEnvMap(tex, 1));
      car.setLights({ headlights: true, brake: 0 });
      ctx.playerVisual = car;
    }
    placePlayer(0);
    lighting.setPlayerS(s);
    world.update(s, 0, 0);
    world.buildAll();
    await Promise.all(mats.pending);

    let last = performance.now();
    let simTime = 0;
    let ready = false;
    const frame = (now: number) => {
      const rawDt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dt = rawDt;
      simTime += dt;
      const t = ctx.time;
      t.dt = dt;
      t.rawDt = rawDt;
      t.now = simTime;
      t.real = simTime;
      t.frame++;
      placePlayer(dt);
      if (car) {
        car.update(dt, player);
        surface.setCars([{ x: player.position.x, z: player.position.z, heading: player.heading, halfWidth: player.dims.width * 0.5, halfLength: player.dims.length * 0.5, height: player.dims.height }]);
      }
      lighting.setPlayerS(s);
      lighting.update(dt, simTime);
      headlights.update(player, simTime);
      world.update(s, dt, simTime);
      placeCamera();
      for (const fn of frameFns) fn(dt, simTime);
      engine.render({ dt, rawDt, time: simTime, player, speedFx: 0, flash: 0, damage: 0 });
      if (!ready && simTime >= tReady && world.settled) {
        ready = true;
        const st = engine.stats;
        console.log(`[ns] ready calls=${st.calls} tris=${st.triangles} programs=${st.programs} frameMs=${engine.frameMs.toFixed(1)}`);
        (window as unknown as { __ready: boolean }).__ready = true;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  (window as unknown as { __kit: Kit }).__kit = kit;
  return kit;
}
