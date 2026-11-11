/**
 * NIGHTSHIFT — bootstrap. Creates every system, shows loading progress, then hands over to Game.
 *
 * URL parameters (all optional, for testing):
 *   ?q=low|medium|high|ultra   start with this quality preset
 *   ?debug                     show the perf line and expose extra logging
 *   ?autostart=1               skip the menu
 *   ?autopilot=1               the test driver plays (soak tests, screenshots)
 */
import type { Texture } from 'three';
import type { Effect } from 'postprocessing';
import { EventBus } from './core/events';
import { Input } from './core/input';
import { Quality } from './core/quality';
import type { CinematicId, GameContext, IAudio, IChunkBuilder, ITrafficSystem, ITrafficVehicleFactory, IVfx, IWeather, QualityLevel, SfxName } from './core/types';
import { Engine } from './render/engine';
import { RoadPath } from './world/roadPath';
import { LightField } from './world/lightField';
import { WorldMaterials } from './world/materials';
import { World } from './world/world';
import { RoadSurface } from './world/roadSurface';
import { Headlights } from './game/headlights';
import { createPlayerState } from './game/playerState';
import { Game } from './game/game';
import type { OncomingLike } from './game/game';
import { CrashWorld } from './physics/crashWorld';
import { createPlayerCarVisual } from './vehicle/playerCarVisual';
import { CameraRig } from './vehicle/cameraRig';
import { createUi } from './ui';
import { createAudio } from './audio';
import { createTrafficVehicleFactory } from './traffic/vehicleFactory';
import { createTraffic } from './traffic/trafficSystem';
import { furnitureFeatures } from './world/features/furniture';
import { structureFeatures } from './world/features/structures';
import { backdropFeatures, createBackdrop } from './world/backdrop';
import { createVfx } from './vfx';
import { createWeather } from './weather';

declare global {
  interface Window {
    __NS?: unknown;
    __ready?: boolean;
  }
}

type Feature = { name: string; build: (b: IChunkBuilder) => void };

const params = new URLSearchParams(location.search);
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** Run an optional subsystem factory; a failure there must not take the game down. */
function optional<T>(name: string, make: () => T): T | null {
  try {
    return make();
  } catch (err) {
    console.error(`[ns] ${name} failed to start`, err);
    return null;
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const events = new EventBus();

  let audio: IAudio | null = null;
  const ui = createUi({ events, root: uiRoot, onSound: (n: SfxName) => audio?.play(n) });
  ui.setLoading(0.03, 'Starting engine');
  await nextFrame();

  const qParam = params.get('q') as QualityLevel | null;
  const quality = new Quality(events, qParam && ['low', 'medium', 'high', 'ultra'].includes(qParam) ? qParam : undefined);
  const engine = new Engine(canvas, quality, events);
  const road = new RoadPath(1);
  // The physics chunk (Rapier + its WebAssembly) downloads and compiles while the models load.
  const crash = new CrashWorld(road);
  const crashReady = crash.init();
  crashReady.catch(() => undefined); // reported where it is awaited
  const lighting = new LightField(road);
  const materials = new WorldMaterials(lighting);
  materials.anisotropy = quality.settings.anisotropy;
  const world = new World(engine.scene, road, lighting, quality, materials);
  const surface = new RoadSurface(lighting, quality, materials);
  world.addFeature('road', surface.build);
  engine.addReflectionReceiver(surface);
  const features: Feature[] = [...structureFeatures, ...furnitureFeatures, ...backdropFeatures];
  for (const f of features) world.addFeature(f.name, f.build);

  const player = createPlayerState();
  const headlights = new Headlights(engine.scene, lighting, quality.settings);
  const input = new Input();
  const ctx: GameContext = {
    engine,
    events,
    input,
    quality,
    road,
    world,
    lighting,
    player,
    ui,
    time: { now: 0, real: 0, dt: 0, rawDt: 0, scale: 1, frame: 0 },
    state: 'boot',
  };

  ui.setLoading(0.12, 'Loading vehicle');
  const car = await createPlayerCarVisual({ lighting, anisotropy: quality.settings.anisotropy, quality });
  player.dims = car.dims;
  engine.scene.add(car.root);
  ctx.playerVisual = car;
  const rig = new CameraRig(engine.camera, { hoodAnchor: car.anchors.hoodCam });
  ctx.cameraRig = rig;

  ui.setLoading(0.34, 'Loading traffic');
  let factory: (ITrafficVehicleFactory & { setEnvMap(tex: Texture | null): void }) | null = null;
  let traffic: (ITrafficSystem & { readonly oncoming: readonly OncomingLike[] }) | null = null;
  try {
    const f = createTrafficVehicleFactory({ lighting, envMap: engine.envMap, quality: quality.settings });
    await f.load();
    traffic = createTraffic(ctx, f);
    ctx.traffic = traffic;
    factory = f;
  } catch (err) {
    console.error('[ns] traffic failed to start', err);
  }
  engine.onEnvMap((tex) => {
    car.setEnvMap(tex, 1);
    factory?.setEnvMap(tex);
  });

  ui.setLoading(0.5, 'Starting physics');
  await crashReady;
  ctx.crash = crash;

  ui.setLoading(0.58, 'Preparing effects');
  const vfx: IVfx | null = optional('vfx', () => createVfx(ctx));
  if (vfx) ctx.vfx = vfx;
  const weather: IWeather | null = optional('weather', () => createWeather(ctx));
  if (weather) ctx.weather = weather;
  for (const e of [...(weather?.distortionEffects ?? []), ...(vfx?.distortionEffects ?? [])]) engine.addDistortionEffect(e as Effect);
  const backdrop = optional('backdrop', () => createBackdrop(ctx));
  audio = optional('audio', () => createAudio());
  if (audio) ctx.audio = audio;

  const game = new Game({
    ctx,
    engine,
    quality,
    world,
    lighting,
    materials,
    surface,
    headlights,
    car,
    rig,
    crash,
    factory,
    backdrop,
    oncoming: traffic ? () => traffic.oncoming : null,
  });
  game.debug = params.has('debug');
  game.autopilotOn = params.get('autopilot') === '1';

  // Build the opening stretch of the world and wait for textures.
  ui.setLoading(0.66, 'Building the highway');
  await nextFrame();
  game.boot(); // places the car, builds the chunks around the start, enters the menu state silently
  const pendingTotal = Math.max(1, materials.pending.length);
  let done = 0;
  await Promise.all(
    materials.pending.map((p) =>
      p.then(
        () => ui.setLoading(0.66 + 0.2 * (++done / pendingTotal), 'Loading textures'),
        () => undefined,
      ),
    ),
  );

  // Warm-up: render real frames so shaders compile and the probe / reflection targets fill in
  // before the menu appears.
  ui.setLoading(0.88, 'Warming up');
  let last = performance.now();
  for (let i = 0; i < 24; i++) {
    const now = await nextFrame();
    game.update(Math.min(0.05, Math.max(0.001, (now - last) / 1000)));
    last = now;
    ui.setLoading(0.88 + 0.12 * ((i + 1) / 24), 'Warming up');
  }
  ui.setLoading(1, 'Ready');
  game.showMenu();

  // The first user gesture unlocks audio (autoplay policy).
  const unlock = () => {
    void audio?.unlock();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // Pause when the tab is hidden; never integrate a huge delta afterwards.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'playing') game.togglePause();
    last = performance.now();
  });
  // An unfocused but visible window gets no key input (Input releases every key on blur): pause too.
  // (Checked a moment later: a blur that is followed by a focus straight away — a fullscreen switch,
  // an automated browser moving focus between its own surfaces — is not the player leaving.)
  window.addEventListener('blur', () => {
    setTimeout(() => {
      if (!document.hasFocus() && game.state === 'playing') game.togglePause();
    }, 200);
  });

  const frame = (now: number) => {
    const rawDt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000));
    last = now;
    game.update(rawDt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.__NS = {
    ctx,
    game,
    engine,
    world,
    crash,
    traffic,
    vfx,
    weather,
    start: () => game.startRun(),
    autopilot: (on: boolean) => (game.autopilotOn = on),
    teleport: (s: number, d?: number, speed?: number) => game.teleport(s, d, speed),
    trigger: (id: CinematicId) => game.director.trigger(id),
    setQuality: (level: QualityLevel) => events.emit('uiSetQuality', { level }),
    stats: () => ({
      state: game.state,
      fps: 1000 / Math.max(0.01, engine.frameMs),
      frameMs: engine.frameMs,
      gpuMs: engine.gpuMs,
      ...engine.stats,
      pixelRatio: quality.pixelRatio,
      quality: quality.level,
      s: player.s,
      d: player.d,
      speedKmh: player.speedKmh,
      damage: player.damage,
      score: Math.round(game.score.score),
      distance: game.score.distance,
      nearMisses: game.score.nearMisses,
      traffic: traffic?.vehicles.length ?? 0,
      wrecks: crash.bodies.length,
      event: game.director.current,
      zone: world.zoneAt(player.s),
    }),
  };
  window.__ready = true;
  console.log(`[ns] ready calls=${engine.stats.calls} tris=${engine.stats.triangles} programs=${engine.stats.programs} frameMs=${engine.frameMs.toFixed(1)}`);
  if (params.get('autostart') === '1') game.startRun();
}

boot().catch((err) => {
  console.error('[ns] boot failed', err);
  const el = document.getElementById('boot-error');
  if (el) {
    el.hidden = false;
    el.textContent = `NIGHTSHIFT could not start: ${err instanceof Error ? err.message : String(err)}`;
  }
});
