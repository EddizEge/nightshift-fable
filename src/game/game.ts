import { Quaternion, Vector3 } from 'three';
import type {
  AudioFrame,
  CameraMode,
  DriveControls,
  FireHandle,
  GameContext,
  GameState,
  HudState,
  IPlayerCarVisual,
  ITrafficVehicleFactory,
  RunSummary,
  TrafficVehicle,
} from '../core/types';
import { clamp, damp, smoothstep } from '../core/math';
import type { Quality } from '../core/quality';
import type { Engine } from '../render/engine';
import type { CrashWorld } from '../physics/crashWorld';
import type { CameraRig } from '../vehicle/cameraRig';
import type { LightField } from '../world/lightField';
import type { RoadCar, RoadPool, RoadSurface } from '../world/roadSurface';
import { ROAD_MAX_CARS, ROAD_MAX_POOLS } from '../world/roadSurface';
import { LAMP_SPACING } from '../world/roadProfile';
import type { World } from '../world/world';
import type { WorldMaterials } from '../world/materials';
import { Autopilot } from './autopilot';
import { Director } from './director';
import type { Headlights } from './headlights';
import { Player } from './player';
import type { CrashInfo } from './player';
import { ScoreSystem, readBest } from './score';

const FIXED = 1 / 120;
const START_S = 20;
const START_D = 1.85;
const START_SPEED = 33;
const MENU_S = 24;
const MENU_D = 8.85;
/** Orbit angle of the menu camera: 3π/2 = straight left of the car (the road side). */
const MENU_ANGLE = 4.08;
/** Passing traffic while the car is parked on the shoulder (vehicles per km per lane). */
const MENU_TRAFFIC = 2.2;

export interface OncomingLike {
  position: Vector3;
  heading: number;
}

export interface GameDeps {
  ctx: GameContext;
  engine: Engine;
  quality: Quality;
  world: World;
  lighting: LightField;
  materials: WorldMaterials;
  surface: RoadSurface;
  headlights: Headlights;
  car: IPlayerCarVisual;
  rig: CameraRig;
  crash: CrashWorld;
  factory: ITrafficVehicleFactory | null;
  backdrop: { update(dt: number, time: number): void } | null;
  /** Decorative oncoming traffic (for road light pools), if the traffic system exposes it. */
  oncoming: (() => readonly OncomingLike[]) | null;
}

const _v = new Vector3();
const _fwd = new Vector3();
const _camFwd = new Vector3();
const _q = new Quaternion();

export class Game {
  state: GameState = 'boot';
  readonly player: Player;
  readonly score: ScoreSystem;
  readonly director: Director;
  readonly autopilot: Autopilot;
  autopilotOn = false;
  private ctx: GameContext;
  private acc = 0;
  private trafficAcc = 0;
  private stateTime = 0; // real seconds in the current state
  private seed = 1;
  private worldSeed = 1;
  private timeScale = 1;
  private flash = 0;
  private crashInfo: CrashInfo | null = null;
  private crashExploded = false;
  private crashClock = 0; // scaled seconds since the crash
  private playerFire: FireHandle | null = null;
  private cameraPref: CameraMode = 'chase';
  private volume = 0.8;
  private muted = false;
  private cleanupTimer = 0;
  private smokeTimer = 0;
  private lastGear = 1;
  private rain = 1;
  private readonly hud: HudState = {
    speedKmh: 0, gear: 1, rpm01: 0, nitro01: 1, nitroActive: false, distance: 0, score: 0, combo: 1, comboTimer01: 0, damage01: 0, survivalTime: 0,
  };
  private readonly audioFrame: AudioFrame = {
    state: 'boot', rpm01: 0.1, throttle: 0, speedKmh: 0, skid: 0, brake: 0, nitroActive: false, rain: 1, tunnel: 0, scrape: 0, timeScale: 1, shifted: false,
  };
  private readonly introControls: DriveControls = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
  private readonly idleControls: DriveControls = { throttle: 0, brake: 1, steer: 0, handbrake: true, nitro: false };
  private roadCars: RoadCar[] = [];
  private roadPools: RoadPool[] = [];
  debug = false;
  private fpsEma = 60;

  constructor(private d: GameDeps) {
    const ctx = (this.ctx = d.ctx);
    this.player = new Player(ctx);
    this.score = new ScoreSystem(ctx.events);
    this.director = new Director(ctx, this.score, d.factory);
    this.autopilot = new Autopilot(ctx);
    for (let i = 0; i < ROAD_MAX_CARS; i++) this.roadCars.push({ x: 0, z: 0, heading: 0, halfWidth: 0, halfLength: 0, height: 0 });
    for (let i = 0; i < ROAD_MAX_POOLS; i++) this.roadPools.push({ x: 0, z: 0, dx: 0, dz: 1, r: 0, g: 0, b: 0, size: 0 });
    this.player.onCrash = (info) => this.onPlayerCrash(info);
    try {
      const v = localStorage.getItem('nightshift.volume');
      if (v !== null) this.volume = clamp(Number(v), 0, 1);
      this.muted = localStorage.getItem('nightshift.muted') === '1';
      const cam = localStorage.getItem('nightshift.camera');
      if (cam === 'hood' || cam === 'chase') this.cameraPref = cam;
    } catch {
      /* storage unavailable */
    }
    this.wireEvents();
  }

  // ── events ──────────────────────────────────────────────────────────────

  private wireEvents(): void {
    const { ctx, d } = this;
    const ev = ctx.events;
    ev.on('uiPlay', () => this.startRun());
    ev.on('uiRestart', () => this.startRun());
    ev.on('uiResume', () => this.state === 'paused' && this.setState('playing'));
    ev.on('uiPauseToggle', () => this.togglePause());
    ev.on('uiQuitToMenu', () => this.toMenu());
    ev.on('uiSetQuality', ({ level }) => {
      d.quality.set(level);
      this.pushSettings();
    });
    ev.on('uiSetVolume', ({ master }) => {
      this.volume = clamp(master, 0, 1);
      ctx.audio?.setMasterVolume(this.volume);
      try {
        localStorage.setItem('nightshift.volume', String(this.volume));
      } catch {
        /* ignore */
      }
    });
    ev.on('uiSetMuted', ({ muted }) => {
      this.muted = muted;
      ctx.audio?.setMuted(muted);
      try {
        localStorage.setItem('nightshift.muted', muted ? '1' : '0');
      } catch {
        /* ignore */
      }
    });
    ev.on('quality', ({ settings }) => {
      d.surface.refreshQuality();
      d.headlights.applyQuality(settings);
      d.materials.anisotropy = settings.anisotropy;
    });
    ev.on('nearMiss', (e) => {
      ctx.ui?.popup(`NEAR MISS  +${e.points}`, 'nearMiss');
      ctx.audio?.play('nearMiss', { pan: e.side * 0.7, pitch: 1 + Math.min(0.5, (e.combo - 1) * 0.06) });
      ctx.audio?.play('passBy', { pan: e.side * 0.9, volume: 0.7 });
      this.player.sim.addNitro(e.gap < 0.45 ? 0.2 : 0.13);
      d.rig.addShake(0.1);
    });
    ev.on('bonus', (e) => ctx.ui?.popup(`${e.label}  +${e.points}`, 'bonus'));
    ev.on('nitro', (e) => {
      ctx.audio?.play(e.active ? 'nitroStart' : 'nitroEnd');
      ctx.vfx?.setNitro(e.active, 1);
    });
    ev.on('collision', (e) => {
      const near = e.position.distanceTo(ctx.player.position) < 9;
      const camDist = e.position.distanceTo(d.engine.camera.position);
      d.rig.addShake(e.intensity * (near ? 0.75 : 0.4 / (1 + camDist / 30)));
      if (e.fatal) {
        ctx.audio?.play('crashHeavy', { position: e.position });
        ctx.audio?.play('glass', { position: e.position, delay: 0.05 });
      } else if (e.intensity > 0.55) ctx.audio?.play('crashHeavy', { position: e.position, volume: 0.5 + e.intensity * 0.5 });
      else ctx.audio?.play('crashLight', { position: e.position, volume: 0.45 + e.intensity });
      if (ctx.vfx) {
        _v.copy(e.normal);
        _v.y += 0.35;
        ctx.vfx.sparks(e.position, _v, Math.round(18 + 70 * e.intensity), 7 + e.relSpeed * 0.7);
        if (e.intensity > 0.4) ctx.vfx.debris(e.position, _v.multiplyScalar(4 + e.relSpeed * 0.3), Math.round(6 + 16 * e.intensity));
      }
      if (e.player && this.state === 'playing') {
        this.score.combo = 1;
        this.score.comboTimer = 0;
        this.flash = Math.max(this.flash, 0.05);
      }
    });
    ev.on('explosion', (e) => {
      // Remember it: the crash camera must not sit inside the fireball.
      let slot = this.blasts[0];
      for (const b of this.blasts) if (b.scale <= 0 || b.age > slot.age) slot = b;
      slot.pos.copy(e.position);
      if (this.blastVel) slot.vel.copy(this.blastVel);
      else slot.vel.set(0, 0, 0);
      this.blastVel = null;
      slot.scale = e.scale;
      slot.age = 0;
      const cam = d.engine.camera.position;
      const dist = e.position.distanceTo(cam);
      d.rig.addShake(clamp((e.scale * 1.5) / (1 + dist / 22), 0.1, 1));
      this.flash = Math.max(this.flash, clamp((e.scale * 0.1) / (1 + dist / 30), 0, 0.13));
      ctx.audio?.play(e.scale > 1.7 ? 'explosionBig' : 'explosion', { position: e.position, delay: Math.min(0.6, dist / 343) });
    });
    ev.on('lightning', (e) => {
      ctx.audio?.play('thunder', { delay: 1.2 + Math.random() * 2.8, volume: 0.35 + 0.5 * e.intensity, pan: Math.random() * 1.2 - 0.6 });
    });
  }

  private pushSettings(): void {
    this.ctx.ui?.setSettings({ quality: this.d.quality.level, volume: this.volume, muted: this.muted, cameraMode: this.cameraPref });
  }

  // ── state machine ───────────────────────────────────────────────────────

  private setState(to: GameState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.ctx.state = to;
    this.stateTime = 0;
    // Overload measured on another screen (menu, pause, crash shot) must not step quality down in play.
    this.d.engine.overloadTime = 0;
    this.ctx.ui?.setState(to);
    this.ctx.events.emit('state', { from, to });
  }

  /** Called once everything is created: sets up the menu scene while the loading screen is still up. */
  boot(): void {
    const ctx = this.ctx;
    ctx.audio?.setMasterVolume(this.volume);
    ctx.audio?.setMuted(this.muted);
    this.pushSettings();
    this.enterMenuScene();
  }

  /** Reveal the main menu (after warm-up). */
  showMenu(): void {
    this.setState('menu');
  }

  private resetWorld(seed: number): void {
    const { ctx, d } = this;
    if (seed !== this.worldSeed) {
      this.worldSeed = seed;
      ctx.road.reset(seed);
      d.world.reset(seed);
    }
    ctx.traffic?.reset();
    d.crash.reset();
    ctx.vfx?.reset();
    ctx.weather?.reset();
    this.director.reset();
    this.playerFire = null;
    this.crashInfo = null;
    this.crashExploded = false;
    for (const b of this.blasts) b.scale = 0;
    this.blastVel = null;
    this.camPush.set(0, 0, 0);
    this.camLift = 0;
    this.timeScale = 1;
    this.flash = 0;
    this.acc = 0;
    d.car.setDamage(0);
    d.car.setVisible(true);
    d.car.setLights({ headlights: true, brake: 0, reverse: false });
    d.headlights.health = 1;
    d.headlights.on = true;
    ctx.vfx?.setNitro(false, 0);
    ctx.ui?.banner(null);
  }

  private placePlayer(s: number, dLat: number, speed: number): void {
    const { ctx, d } = this;
    this.player.reset(s, dLat, speed);
    d.lighting.setPlayerS(s);
    d.world.update(s, 0, ctx.time.now);
    d.world.buildAll();
  }

  /** Car parked on the hard shoulder, slow orbit camera. */
  private enterMenuScene(): void {
    const { ctx, d } = this;
    this.resetWorld(this.worldSeed);
    this.placePlayer(MENU_S, MENU_D, 0);
    ctx.traffic?.setDensity(MENU_TRAFFIC);
    ctx.traffic?.setAggression(0);
    d.rig.setOrbit({ radius: 6.9, height: 0.9, speed: 0, angle: MENU_ANGLE, fov: 33, targetHeight: 0.6 });
    d.rig.setMode('orbit');
    d.rig.snap();
  }

  toMenu(): void {
    this.enterMenuScene();
    this.setState('menu');
  }

  startRun(): void {
    const { ctx, d } = this;
    if (this.state === 'intro' || this.state === 'boot') return;
    void ctx.audio?.unlock();
    if (this.state === 'crashed' && this.crashInfo) this.endRun(this.crashInfo);
    // The first run reuses the menu's world (no hitch); a restart gets a new road.
    if (this.state !== 'menu') this.seed++;
    this.resetWorld(this.seed);
    this.placePlayer(START_S, START_D, START_SPEED);
    this.player.sim.addNitro(1);
    this.autopilot.reset();
    this.score.reset();
    ctx.traffic?.setDensity(3.5);
    ctx.traffic?.setAggression(0.1);
    d.rig.setMode(this.cameraPref);
    d.rig.snap();
    ctx.events.emit('cameraMode', { mode: this.cameraPref });
    ctx.events.emit('runStart', { seed: this.worldSeed });
    this.setState('intro');
  }

  /** Test hook: jump the current run to arc length `s` (zone review, screenshots). */
  teleport(s: number, dLat = START_D, speed = START_SPEED): void {
    this.ctx.traffic?.reset();
    this.d.crash.reset();
    this.director.reset();
    this.placePlayer(s, dLat, speed);
    this.d.rig.snap();
  }

  togglePause(): void {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  private onPlayerCrash(info: CrashInfo): void {
    const { ctx, d } = this;
    this.crashInfo = info;
    this.crashExploded = false;
    this.crashClock = 0;
    this.timeScale = 0.2;
    d.rig.setOrbit({ radius: 13.5, height: 3.2, speed: 0.5, fov: 46, targetHeight: 0.8 });
    d.rig.setMode('crash');
    d.rig.addShake(1);
    ctx.vfx?.setNitro(false, 0);
    ctx.vfx?.smokePuff(info.position, _v.copy(ctx.player.velocity).multiplyScalar(0.3), 1.4);
    ctx.ui?.banner(null);
    this.flash = Math.max(this.flash, 0.12);
    this.setState('crashed');
  }

  private updateCrashSequence(dt: number, rawDt: number): void {
    const { ctx, d } = this;
    const info = this.crashInfo;
    if (!info) return;
    this.crashClock += dt;
    // Ease out of slow motion.
    const target = this.stateTime < 1.5 ? 0.2 : 0.6;
    this.timeScale = damp(this.timeScale, target, 2.5, rawDt);
    const pos = ctx.player.position;
    const body = this.player.wreckBody;
    // The run is over: traffic slows down for the wreck instead of streaming past it.
    ctx.traffic?.setCaution?.(ctx.player.s);
    const violent = info.speed > 38 || (info.other !== null && 'type' in info.other && info.other.type === 'tanker');
    if (!this.crashExploded && this.crashClock > (violent ? 0.42 : 0.3)) {
      this.crashExploded = true;
      _v.copy(pos);
      _v.y += 0.7;
      if (violent) {
        const drift = body ? body.linvel.clone().multiplyScalar(0.4) : undefined;
        this.blastVel = drift ?? null;
        if (ctx.vfx) ctx.vfx.explosion(_v, { scale: 1.1, velocity: drift, smoke: 10 });
        else ctx.events.emit('explosion', { position: _v.clone(), scale: 1.1 });
        d.crash.applyBlast(_v, 5, 14);
      }
      if (ctx.vfx) this.playerFire = ctx.vfx.attachFire(body ?? { position: pos }, violent ? 1.0 : 0.55, 30);
      if (body) body.burning = true;
      d.car.setDamage(1);
      d.headlights.on = false;
      d.car.setLights({ headlights: false, brake: 0 });
    }
    if (this.stateTime > 3.6) {
      const summary = this.endRun(info);
      ctx.ui?.showGameOver(summary);
      ctx.audio?.play(summary.isNewBest ? 'newBest' : 'gameOver');
      this.setState('gameover');
    }
  }

  /** Book the finished run (best score, runEnd); also used when the crash sequence is skipped with R. */
  private endRun(info: CrashInfo): RunSummary {
    const summary = this.score.finish(info.cause);
    this.ctx.events.emit('runEnd', summary);
    return summary;
  }

  // ── frame ───────────────────────────────────────────────────────────────

  update(rawDt: number): void {
    const { ctx, d } = this;
    const input = ctx.input;
    input.update();
    this.stateTime += rawDt;
    const st = ctx.player;

    // Global keys.
    if (input.pressed('pause')) {
      if (this.state === 'playing' || this.state === 'paused') this.togglePause();
    }
    if (input.pressed('camera') && (this.state === 'playing' || this.state === 'intro')) {
      this.cameraPref = d.rig.nextMode();
      ctx.events.emit('cameraMode', { mode: this.cameraPref });
      try {
        localStorage.setItem('nightshift.camera', this.cameraPref);
      } catch {
        /* ignore */
      }
    }
    if (input.pressed('restart') && (this.state === 'gameover' || this.state === 'playing' || this.state === 'crashed')) this.startRun();
    if (input.pressed('confirm') && this.state === 'gameover') this.startRun();

    // Time.
    const paused = this.state === 'paused';
    let scale = paused ? 0 : this.timeScale;
    if (this.state === 'playing' && this.director.slowMo > 0) scale = Math.min(scale, 1 - 0.62 * Math.min(1, this.director.slowMo));
    if (this.state === 'playing') this.timeScale = damp(this.timeScale, 1, 4, rawDt);
    const dt = rawDt * scale;
    const t = ctx.time;
    t.rawDt = rawDt;
    t.dt = dt;
    t.scale = scale;
    t.now += dt;
    t.real += rawDt;
    t.frame++;

    // Fixed-step simulation.
    const simulating = this.state === 'playing' || this.state === 'intro' || this.state === 'menu' || this.state === 'crashed' || this.state === 'gameover';
    if (simulating && dt > 0) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= FIXED && n < 8) {
        this.fixedStep(FIXED);
        this.acc -= FIXED;
        n++;
      }
      if (n === 8) this.acc = 0;
      if (!st.alive) this.player.updateWrecked(dt);
      d.crash.step(dt, st.s);
    }
    if (this.state === 'intro' && this.stateTime > 1.1) this.setState('playing');
    if (this.state === 'crashed') this.updateCrashSequence(dt, rawDt);

    // World, lights.
    d.lighting.setPlayerS(st.s);
    d.world.update(st.s, dt, t.now);
    d.lighting.update(dt, t.now);
    // Night adaptation: how many street lamps are lit around the car (none on a rural stretch).
    {
      const k = Math.round(st.s / LAMP_SPACING);
      let lit = 0;
      for (let i = -2; i <= 5; i++) if (d.lighting.lampOn(k + i)) lit++;
      const target = clamp(1 - lit / 3, 0, 1) * (1 - clamp(ctx.world.tunnelAt(st.s), 0, 1));
      this.nightAdapt = damp(this.nightAdapt, target, 0.8, rawDt);
      d.engine.setNightAdaptation(this.nightAdapt);
    }
    d.headlights.health = st.damage > 0.55 ? 1 - (st.damage - 0.55) * 1.6 : 1;
    d.headlights.update(st, t.now);
    d.backdrop?.update(dt, t.now);

    // Vehicles.
    d.car.update(dt, st);
    d.car.setDamage(st.damage);
    ctx.traffic?.syncVisuals(dt, t.now);
    this.updateRoadUniforms();

    // Smoke from a badly damaged engine.
    if (st.alive && st.damage > 0.6 && ctx.vfx) {
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) {
        this.smokeTimer = 0.09;
        _fwd.set(Math.sin(st.heading), 0, -Math.cos(st.heading));
        _v.copy(st.position).addScaledVector(_fwd, st.dims.frontAxle + 0.3);
        _v.y = 0.75;
        ctx.vfx.smokePuff(_v, _fwd.multiplyScalar(st.speed * 0.6), 0.35 + (st.damage - 0.6) * 1.2);
      }
    }

    // Weather: slow waves of intensity; nothing falls inside tunnels (the weather module handles coverage).
    this.rain = 0.82 + 0.18 * Math.sin(t.now * 0.05) * Math.sin(t.now * 0.017 + 1.3);
    ctx.weather?.setIntensity(this.rain);
    d.surface.uniforms.uRain.value = this.rain;

    // Camera.
    const menuCam = this.state === 'menu' || this.state === 'boot';
    // Menu: a slow sweep along the road side of the parked car (never through the guardrail),
    // framed right of centre so the menu column stays clear.
    if (menuCam) d.rig.setOrbit({ angle: MENU_ANGLE + 0.6 * Math.sin(t.real * 0.085) });
    if (!paused) d.rig.update(rawDt, st, t.real);
    this.ageBlasts(dt);
    if (menuCam) d.engine.camera.rotateY(0.14);
    else if (!paused && d.rig.mode !== 'hood') {
      this.keepCameraClear(rawDt);
      this.keepCameraOutOfFire(rawDt);
    }

    ctx.vfx?.update(dt, t.now);
    ctx.weather?.update(dt, t.now);
    this.updateAudio(rawDt);
    this.updateHud(rawDt);

    // Automatic quality: the resolution is already at its floor and the GPU still cannot keep up.
    // Not mid set piece: the pipeline rebuild would hitch while the player threads the open lane.
    const setPiece = this.director.current !== null || this.director.slowMo > 0;
    if (d.quality.auto && this.state === 'playing' && !setPiece && d.engine.overloadTime > 5) {
      d.engine.overloadTime = 0;
      const level = d.quality.stepDown();
      if (level) {
        this.pushSettings();
        ctx.ui?.popup(`GRAPHICS: ${level.toUpperCase()}`, 'info');
      }
    }

    // Housekeeping.
    this.cleanupTimer -= rawDt;
    if (this.cleanupTimer <= 0) {
      this.cleanupTimer = 0.5;
      this.cleanup();
    }

    this.flash = Math.max(0, this.flash - rawDt * 1.7);
    d.engine.render({
      dt,
      rawDt,
      time: t.now,
      player: st,
      speedFx: st.nitroActive ? 0.55 : 0,
      flash: this.flash,
      damage: this.state === 'playing' ? Math.max(0, st.damage - 0.35) * 1.2 : 0,
    });
  }

  private fixedStep(h: number): void {
    const { ctx } = this;
    const st = ctx.player;
    let controls: DriveControls;
    const parked = this.state === 'menu' || this.state === 'boot';
    if (parked) controls = this.idleControls;
    else if (this.state === 'intro') {
      controls = this.introControls;
      controls.steer = ctx.input.controls.steer;
    } else if (this.autopilotOn) {
      // The test driver cannot read the warning banner: tell it where the set piece will block the road.
      this.autopilot.hazard = this.director.hazard(this.hazardBox) ? this.hazardBox : null;
      controls = this.autopilot.update(h);
    } else controls = ctx.input.controls;
    // Parked in the menu: the simulation would read "brake held at standstill" as reverse.
    if (st.alive && !parked) {
      const gearBefore = st.gear;
      this.player.step(h, controls);
      if (st.gear !== gearBefore) this.lastGear = gearBefore;
    }
    this.trafficAcc += h;
    if (this.trafficAcc >= 1 / 60) {
      ctx.traffic?.step(this.trafficAcc);
      this.trafficAcc = 0;
    }
    if (this.state === 'playing') {
      this.score.update(h, st, ctx.traffic?.vehicles ?? []);
      this.director.update(h, this.score.survivalTime);
      // Difficulty ramps with distance.
      const k = clamp(this.score.distance / 14000, 0, 1);
      ctx.traffic?.setDensity((3.5 + k * 7.5) * this.trafficScale);
      ctx.traffic?.setAggression(0.1 + k * 0.8);
    } else if (this.state === 'crashed' || this.state === 'gameover') {
      this.director.update(h, this.score.survivalTime);
    }
  }

  /** Feed the road shader: nearby vehicle boxes (contact AO + lamp shadows) and their light pools. */
  private updateRoadUniforms(): void {
    const { ctx, d } = this;
    const st = ctx.player;
    const cars = this.roadCars;
    const pools = this.roadPools;
    let nc = 0;
    let np = 0;
    const addCar = (x: number, z: number, heading: number, hw: number, hl: number, height: number) => {
      if (nc >= ROAD_MAX_CARS) return;
      const c = cars[nc++];
      c.x = x;
      c.z = z;
      c.heading = heading;
      c.halfWidth = hw;
      c.halfLength = hl;
      c.height = height;
    };
    const addPool = (x: number, z: number, dx: number, dz: number, r: number, g: number, b: number, size: number) => {
      if (np >= ROAD_MAX_POOLS) return;
      const p = pools[np++];
      p.x = x;
      p.z = z;
      p.dx = dx;
      p.dz = dz;
      p.r = r;
      p.g = g;
      p.b = b;
      p.size = size;
    };
    const visible = st.alive || this.state === 'crashed' || this.state === 'gameover';
    if (visible && st.position.y < 1.2) {
      addCar(st.position.x, st.position.z, st.heading, st.dims.width * 0.5, st.dims.length * 0.5, st.dims.height);
      if (st.alive) {
        const fx = Math.sin(st.heading);
        const fz = -Math.cos(st.heading);
        const k = 1.2 + st.brake * 2.4;
        addPool(st.position.x - fx * (st.dims.rearAxle + 1.5), st.position.z - fz * (st.dims.rearAxle + 1.5), -fx, -fz, k, k * 0.05, k * 0.03, 2.0);
      }
    }
    const traffic = ctx.traffic?.vehicles;
    if (traffic) {
      // Nearest first (simple insertion over a short list).
      const near = this.nearList;
      near.length = 0;
      for (const v of traffic) {
        const ds = v.s - st.s;
        if (ds < -40 || ds > 150) continue;
        near.push(v);
      }
      near.sort((a, b) => Math.abs(a.s - st.s) - Math.abs(b.s - st.s));
      for (let i = 0; i < near.length; i++) {
        const v = near[i];
        addCar(v.position.x, v.position.z, v.heading, v.halfWidth, v.halfLength, v.def.height);
        if (v.mode === 'wreck') continue;
        const fx = Math.sin(v.heading);
        const fz = -Math.cos(v.heading);
        if (np < ROAD_MAX_POOLS - 4) {
          const k = 1.2 + v.braking * 2.6;
          addPool(v.position.x - fx * (v.halfLength + 1.3), v.position.z - fz * (v.halfLength + 1.3), -fx, -fz, k, k * 0.05, k * 0.03, 2.1);
        }
        if (i < 4 && np < ROAD_MAX_POOLS - 4) addPool(v.position.x + fx * v.halfLength, v.position.z + fz * v.halfLength, fx, fz, 15, 15.5, 17, 13);
      }
    }
    const onc = d.oncoming?.();
    if (onc) {
      let added = 0;
      for (let i = 0; i < onc.length && added < 4 && np < ROAD_MAX_POOLS; i++) {
        const o = onc[i];
        const dx = o.position.x - st.position.x;
        const dz = o.position.z - st.position.z;
        if (dx * dx + dz * dz > 160 * 160) continue;
        const fx = Math.sin(o.heading);
        const fz = -Math.cos(o.heading);
        addPool(o.position.x + fx * 2.2, o.position.z + fz * 2.2, fx, fz, 16, 16.5, 18, 14);
        added++;
      }
    }
    for (let i = nc; i < ROAD_MAX_CARS; i++) cars[i].halfWidth = 0;
    for (let i = np; i < ROAD_MAX_POOLS; i++) pools[i].size = 0;
    d.surface.setCars(cars.filter((c) => c.halfWidth > 0));
    d.surface.setPools(pools.filter((p) => p.size > 0));
  }
  private nearList: TrafficVehicle[] = [];
  private nightAdapt = 0;
  /** Recent fireballs (crash camera keeps out of them). */
  private blasts = Array.from({ length: 4 }, () => ({ pos: new Vector3(), vel: new Vector3(), scale: 0, age: 0 }));
  private blastVel: Vector3 | null = null;
  private camPush = new Vector3();
  private readonly hazardBox = { s: 0, d: 0, halfS: 0, halfD: 0, speed: 0 };
  /** Test hook: 0 empties the road (screenshots, control checks). */
  trafficScale = 1;
  private camLift = 0;

  /**
   * The chase / crash cameras can end up inside a truck that sits right behind the player or a
   * wreck that tumbles through: lift the camera over whatever it is inside of.
   */
  private keepCameraClear(rawDt: number): void {
    const { ctx, d } = this;
    const cam = d.engine.camera;
    const cx = cam.position.x;
    const cy = cam.position.y; // the rig rewrites the position every frame, so this is the unlifted height
    const cz = cam.position.z;
    let need = 0;
    const traffic = ctx.traffic?.vehicles;
    if (traffic) {
      for (let i = 0; i < traffic.length; i++) {
        const v = traffic[i];
        if (v.mode === 'wreck') continue;
        const dx = cx - v.position.x;
        const dz = cz - v.position.z;
        if (dx * dx + dz * dz > 400) continue;
        const sin = Math.sin(v.heading);
        const cos = Math.cos(v.heading);
        const lx = dx * cos + dz * sin;
        const lz = dx * sin - dz * cos;
        if (Math.abs(lx) < v.halfWidth + 0.45 && Math.abs(lz) < v.halfLength + 0.6 && cy < v.def.height + 0.35) need = Math.max(need, v.def.height + 0.9 - cy);
      }
    }
    const bodies = d.crash.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.owner === 'player') continue;
      _v.set(cx - b.position.x, cy - b.position.y, cz - b.position.z);
      if (_v.lengthSq() > 500) continue;
      _q.copy(b.quaternion).invert();
      _fwd.copy(_v).applyQuaternion(_q);
      const h = b.halfExtents;
      if (Math.abs(_fwd.x) < h.x + 0.45 && Math.abs(_fwd.y) < h.y + 0.45 && Math.abs(_fwd.z) < h.z + 0.6) {
        // World-space height of the rotated box.
        _camFwd.set(0, 1, 0).applyQuaternion(_q);
        const top = b.position.y + Math.abs(_camFwd.x) * h.x + Math.abs(_camFwd.y) * h.y + Math.abs(_camFwd.z) * h.z;
        need = Math.max(need, top + 0.8 - cy);
      }
    }
    need = Math.min(need, 7);
    this.camLift = damp(this.camLift, need, need > this.camLift ? 16 : 2.5, rawDt);
    if (this.camLift > 0.01) {
      cam.position.y += this.camLift;
      // Tip the view down so the car stays in frame.
      cam.rotateX(-Math.atan2(this.camLift, 9));
    }
  }

  /**
   * The crash camera orbits a wreck that is about to blow up, and other wrecks explode around it:
   * a camera inside a fireball shows a flat orange frame. Push it out of every live fireball
   * (radius grows with the blast, drifts with it, and lets go as the fire thins out).
   */
  /** Fireballs drift and burn out in game time, whatever the camera does. */
  private ageBlasts(dt: number): void {
    for (const b of this.blasts) {
      if (b.scale <= 0) continue;
      b.age += dt;
      // Same life as in keepCameraOutOfFire: scaled seconds the fire ball stays dense.
      if (b.age > 1.5 + b.scale * 0.9) {
        b.scale = 0;
        continue;
      }
      b.pos.addScaledVector(b.vel, dt);
      b.vel.multiplyScalar(Math.max(0, 1 - dt * 1.2));
    }
  }

  private keepCameraOutOfFire(rawDt: number): void {
    const { ctx, d } = this;
    const cam = d.engine.camera;
    let px = 0;
    let py = 0;
    let pz = 0;
    const crashCam = d.rig.mode === 'crash';
    for (const b of this.blasts) {
      if (b.scale <= 0 || !crashCam) continue;
      const life = 1.5 + b.scale * 0.9;
      const grow = Math.min(1, b.age / 0.3);
      const thin = 1 - smoothstep(life * 0.55, life, b.age);
      const radius = (6.5 * b.scale + 3) * grow * thin;
      const dx = cam.position.x - b.pos.x;
      const dy = cam.position.y - b.pos.y;
      const dz = cam.position.z - b.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist >= radius) continue;
      const h = Math.hypot(dx, dz);
      const k = (radius - dist) / Math.max(h, 0.5);
      // Mostly sideways (the shot keeps its height), a little up so the road does not block it.
      px += (h > 0.2 ? dx : 1) * k;
      pz += (h > 0.2 ? dz : 0) * k;
      py += (radius - dist) * 0.3;
    }
    const cp = this.camPush;
    const rate = px * px + py * py + pz * pz > cp.lengthSq() ? 9 : 1.6;
    cp.x = damp(cp.x, px, rate, rawDt);
    cp.y = damp(cp.y, py, rate, rawDt);
    cp.z = damp(cp.z, pz, rate, rawDt);
    if (cp.lengthSq() > 1e-4) {
      cam.position.add(cp);
      if (crashCam) cam.lookAt(ctx.player.position.x, ctx.player.position.y + 0.8, ctx.player.position.z);
    }
  }

  private updateAudio(rawDt: number): void {
    const { ctx, d } = this;
    const audio = ctx.audio;
    if (!audio) return;
    const st = ctx.player;
    const a = this.audioFrame;
    a.state = this.state;
    a.rpm01 = st.rpm01;
    a.throttle = st.alive ? st.throttle : 0;
    a.speedKmh = Math.abs(st.speedKmh);
    a.skid = st.alive ? Math.max(st.wheelSkid[0], st.wheelSkid[1], st.wheelSkid[2], st.wheelSkid[3]) : 0;
    a.brake = st.brake;
    a.nitroActive = st.nitroActive && st.alive;
    a.rain = this.rain * ctx.world.rainAt(st.s);
    a.tunnel = ctx.world.tunnelAt(st.s);
    a.scrape = st.alive ? this.player.scrape : 0;
    a.timeScale = Math.max(0.05, ctx.time.scale);
    a.shifted = st.alive && st.gear !== this.lastGear && st.gear > 0;
    this.lastGear = st.gear;
    const cam = d.engine.camera;
    cam.getWorldDirection(_camFwd);
    audio.setListener(cam.position, _camFwd);
    audio.update(rawDt, a);
  }

  private updateHud(rawDt: number): void {
    const { ctx, d } = this;
    const st = ctx.player;
    const h = this.hud;
    h.speedKmh = Math.abs(st.speedKmh);
    h.gear = st.gear;
    h.rpm01 = st.rpm01;
    h.nitro01 = st.nitro01;
    h.nitroActive = st.nitroActive;
    h.distance = this.score.distance;
    h.score = Math.round(this.score.score);
    h.combo = this.score.combo;
    h.comboTimer01 = this.score.comboTimer01;
    h.damage01 = st.damage;
    h.survivalTime = this.score.survivalTime;
    ctx.ui?.updateHud(h);
    if (this.debug) {
      this.fpsEma = damp(this.fpsEma, 1 / Math.max(1e-3, rawDt), 2, rawDt);
      const s = d.engine.stats;
      ctx.ui?.setDebug(
        `${this.fpsEma.toFixed(0)} fps · ${d.engine.frameMs.toFixed(1)} ms · gpu ${d.engine.gpuMs.toFixed(1)} ms · calls ${s.calls} · tris ${(s.triangles / 1000).toFixed(0)}k · scale ${d.quality.pixelRatio.toFixed(2)} · ${d.quality.level} · s ${st.s.toFixed(0)} ${ctx.world.zoneAt(st.s)} · traffic ${ctx.traffic?.vehicles.length ?? 0} · wrecks ${d.crash.bodies.length} · ${this.director.current ?? '-'}`,
      );
    }
  }

  private cleanup(): void {
    const { ctx, d } = this;
    const ps = ctx.player.s;
    const bodies = d.crash.bodies;
    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      if (b.owner === 'player' || b.owner === 'director') continue;
      const pr = ctx.road.project(b.position.x, b.position.z, ps);
      if (pr.s < ps - 170 || pr.s > ps + 1200) {
        const owner = b.owner as TrafficVehicle | null;
        if (owner && typeof owner === 'object' && 'visual' in owner && ctx.traffic) ctx.traffic.remove(owner);
        if (d.crash.bodies.includes(b)) d.crash.remove(b);
      }
    }
    this.director.cleanup(ps);
  }

  get bestScore(): number {
    return readBest();
  }
}
