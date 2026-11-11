/**
 * NIGHTSHIFT cinematic VFX: explosions, fires, sparks, debris, crash smoke, nitro afterburner.
 *
 *   const vfx = createVfx(ctx);                // adds its meshes to ctx.engine.scene
 *   for (const e of vfx.distortionEffects) ctx.engine.addDistortionEffect(e);
 *   vfx.update(scaledDt, time);                // every frame (slow motion: pass the scaled dt)
 *
 * Draw calls (only while something is alive): puffs 1 (fire + flame tongues + smoke + spray +
 * flash, sorted, premultiplied blend-add), sparks 1, debris ≤ 2, scorch decals 1, nitro 1 — each ×2
 * with the wet-road reflection — plus ground light pools 1 (main view only). Idle: 0 draw calls
 * (after 3 warm-up frames that compile every program); the distortion pass skips itself (blend DST).
 *
 * Pools (× quality.particleScale: low 0.4, medium 0.7, high 1, ultra 1.5; capacity is allocated
 * for 1.5): puffs 1000, sparks 1500, debris 64, scorch decals 6, simultaneous explosions 6,
 * fires 16 (explosion ground patches included), shockwaves 2, heat-haze columns 2, fire lights 4.
 */
import { Color, Quaternion, Vector3 } from 'three';
import type { ExplosionOpts, FireHandle, GameContext, IVfx } from '../core/types';
import { makeRng } from '../core/math';
import { FIRE_LIGHTS, WIND, createFireLightUniforms, vfxNoise } from './common';
import { KIND_FIRE, KIND_FLAME, KIND_FLASH, KIND_SPRAY, PuffSystem } from './puffs';
import { EMBER, GLASS, SPARK, SparkSystem } from './sparks';
import { DebrisSystem } from './debris';
import { ScorchDecals } from './decals';
import { VfxDistortionEffect } from './distortion';
import { NitroFlames } from './nitro';
import { GroundGlow } from './glow';

export const VFX_LIMITS = {
  puffs: 1000,
  sparks: 1500,
  debris: 64,
  decals: 6,
  explosions: 6,
  fires: 16,
  shockwaves: 2,
  haze: 2,
  fireLights: FIRE_LIGHTS,
} as const;

const MAX_SCALE = 1.5;
/** Soft limit (intensity units of ILighting.flash) and lift (m) of the lingering fire light. */
const FIRE_FLASH_K = 2000;
const FIRE_FLASH_LIFT = 3;
const TAU = Math.PI * 2;

export interface VfxStats {
  puffs: number;
  sparks: number;
  debris: number;
  peakPuffs: number;
  peakSparks: number;
  explosions: number;
  fires: number;
  cpuMs: number;
  distortion: boolean;
}

export interface VfxExtended extends IVfx {
  /** Resolves once the noise texture is loaded. */
  readonly ready: Promise<void>;
  stats(): VfxStats;
  dispose(): void;
}

class Blast {
  active = false;
  t = 0;
  S = 1;
  pos = new Vector3();
  vel = new Vector3();
  smoke = 12;
  secondary = 0;
  smokeAcc = 0;
  columnAcc = 0;
  patches = false;
  /** Current fireball light intensity (for smoke self-illumination / glow). */
  light = 0;
  lightPos = new Vector3();
}

class Fire {
  active = false;
  gen = 0;
  target: { position: Vector3 } | null = null;
  fixed = new Vector3();
  scale = 1;
  duration = 1;
  age = 0;
  intensity = 1;
  stopping = false;
  stopAge = 0;
  level = 0;
  flameAcc = 0;
  smokeAcc = 0;
  emberAcc = 0;
  /** Vertical offset of the flame base above target.position. */
  lift = 0;
  smokeMul = 1;
  base = new Vector3();
  light = 0;
  lightPos = new Vector3();
  coreAcc = 0;
  /** Previous source position + smoothed source velocity (moving / tumbling wrecks). */
  prev = new Vector3();
  tv = new Vector3();
  hasPrev = false;
  glow = 0;
  /** Burning fuel on the road (explosion ground patch): lower, wider, less smoke. */
  patch = false;
}

const _v = new Vector3();
const _w = new Vector3();
const _col = new Color();
const UP = new Vector3(0, 1, 0);

class Vfx implements VfxExtended {
  readonly distortionEffects: unknown[];
  readonly ready: Promise<void>;
  private puffs: PuffSystem;
  private sparkSys: SparkSystem;
  private debrisSys: DebrisSystem;
  private decals: ScorchDecals;
  private nitro: NitroFlames;
  private distortion: VfxDistortionEffect;
  private glow: GroundGlow;
  private fireU = createFireLightUniforms();
  private blasts: Blast[] = [];
  private fires: Fire[] = [];
  private rnd = makeRng(0xf1a3e);
  private time = 0;
  private glowTimer = 0;
  private nitroTarget = 0;
  private nitroIntensity = 1;
  private nitroPop = 0;
  private warm = 3;
  private lastNow = 0;
  private timeScale = 1;
  private cpuMs = 0;
  private ps = 1;
  private exL = new Vector3();
  private exR = new Vector3();
  private exQ = new Quaternion();
  private back = new Vector3();
  /** Scratch: drawn position of the fire target being stepped. */
  private src = new Vector3();
  // fire-light selection scratch
  private lightI = new Float32Array(VFX_LIMITS.explosions + VFX_LIMITS.fires);
  private lightP: Vector3[] = [];

  constructor(private ctx: GameContext) {
    const { lighting } = ctx;
    const particles = ctx.engine.particles;
    const noise = vfxNoise();
    this.ready = noise.ready;
    this.puffs = new PuffSystem(Math.round(VFX_LIMITS.puffs * MAX_SCALE), lighting, particles, this.fireU, noise.texture);
    this.sparkSys = new SparkSystem(Math.round(VFX_LIMITS.sparks * MAX_SCALE), lighting, particles);
    this.debrisSys = new DebrisSystem(VFX_LIMITS.debris, lighting);
    this.decals = new ScorchDecals(lighting, noise.texture);
    this.nitro = new NitroFlames(lighting, particles, noise.texture);
    this.distortion = new VfxDistortionEffect(noise.texture);
    this.glow = new GroundGlow(lighting, particles);
    this.distortionEffects = [this.distortion];
    const scene = ctx.engine.scene;
    scene.add(this.puffs.mesh, this.sparkSys.mesh, this.decals.mesh, this.nitro.mesh, this.glow.mesh, ...this.debrisSys.meshes);
    for (let i = 0; i < VFX_LIMITS.explosions; i++) this.blasts.push(new Blast());
    for (let i = 0; i < VFX_LIMITS.fires; i++) this.fires.push(new Fire());
    for (let i = 0; i < this.lightI.length; i++) this.lightP.push(new Vector3());
    this.debrisSys.hooks = {
      trail: (x, y, z, dvx, dvy, dvz, age, size, burning) => {
        const p = this.puffs.spawn;
        const r = this.rnd;
        this.base(p);
        p.x = x;
        p.y = y;
        p.z = z;
        p.vx = (r() - 0.5) * 0.6;
        p.vy = 0.4 + r() * 0.5;
        p.vz = (r() - 0.5) * 0.6;
        const s = Math.min(1.0, 0.3 + size * 0.45);
        if (burning && age < 0.6) {
          // burning piece: overlapping short glowing streak segments form a continuous fire trail
          const sp = this.sparkSys.spawn;
          sp.x = x;
          sp.y = y;
          sp.z = z;
          // carries the piece's velocity but brakes hard: a streak along the path that shrinks
          sp.vx = dvx;
          sp.vy = dvy;
          sp.vz = dvz;
          sp.life = 0.3 + r() * 0.15;
          sp.heat = 0.62 - age * 0.5;
          sp.cool = 2.5;
          sp.size = 0.035 + s * 0.04;
          sp.drag = 9;
          sp.grav = 0;
          sp.bounce = 0;
          sp.kind = SPARK;
          this.sparkSys.emit();
        }
        p.size0 = s * 0.25;
        p.size1 = s * (0.9 + r() * 0.4);
        p.grow = 2.0;
        p.life = 1.0 + r() * 0.7;
        p.heat = 0;
        p.dens = 0.34 * (1 - age * 0.7);
        p.stretch = -3.2;
        p.dirX = dvx;
        p.dirY = dvy;
        p.dirZ = dvz;
        p.albedo = 0.02;
        p.buoy = 1.0;
        p.drag = 2.4;
        p.wind = 0.8;
        p.turb = 1.2;
        p.erode0 = 0.18;
        p.erode1 = 0.9;
        p.noise = 0.45;
        p.fadeIn = 0.3;
        p.rot = r() * TAU;
        p.rotV = (r() - 0.5) * 1.5;
        this.puffs.emit();
      },
    };
  }

  // ───────────────────────────────────────────────────────── public API

  explosion(position: Vector3, opts: ExplosionOpts = {}): void {
    const S = Math.max(0.2, opts.scale ?? 1);
    let b = this.blasts.find((x) => !x.active);
    if (!b) b = this.blasts.reduce((a, c) => (a.t > c.t ? a : c));
    b.active = true;
    b.t = 0;
    b.S = S;
    b.pos.copy(position);
    if (opts.velocity) b.vel.copy(opts.velocity);
    else b.vel.set(0, 0, 0);
    b.smoke = opts.smoke ?? 12;
    b.secondary = 0;
    b.smokeAcc = 0;
    b.columnAcc = 0;
    b.patches = false;
    b.light = 0;
    this.detonate(b, opts.debris !== false);
  }

  attachFire(target: { position: Vector3 }, scale: number, duration: number): FireHandle {
    const f = this.startFire(target, null, scale, duration, 0.35, 1);
    return this.handle(f);
  }

  sparks(position: Vector3, direction: Vector3, count: number, speed: number): void {
    const r = this.rnd;
    const n = Math.max(1, Math.round(count * this.ps));
    _w.copy(direction);
    if (_w.lengthSq() < 1e-6) _w.set(0, 1, 0);
    _w.normalize();
    // metal torn off the player's car keeps most of the car's velocity: a scrape throws a shower
    // that trails behind the car instead of a radial starburst
    const pl = this.ctx.player;
    const dx = position.x - pl.position.x;
    const dz = position.z - pl.position.z;
    const own = dx * dx + dz * dz < 16;
    const pv = pl.velocity;
    const sp = this.sparkSys.spawn;
    for (let i = 0; i < n; i++) {
      randomCone(_v, _w, 0.55, r);
      const v = speed * (0.3 + r() * 0.8) * (own ? 0.6 : 1);
      const inh = own ? 0.5 + r() * 0.4 : 0;
      sp.x = position.x;
      sp.y = Math.max(0.02, position.y);
      sp.z = position.z;
      sp.vx = _v.x * v + pv.x * inh;
      sp.vy = _v.y * v + r() * 1.5;
      sp.vz = _v.z * v + pv.z * inh;
      sp.life = 0.45 + r() * 0.9;
      sp.heat = 0.8 + r() * 0.3;
      sp.cool = 1.6 + r() * 2.2;
      sp.size = 0.005 + r() * 0.007;
      sp.drag = 0.9;
      sp.grav = 1;
      sp.bounce = 0.42;
      sp.kind = SPARK;
      this.sparkSys.emit();
    }
  }

  debris(position: Vector3, velocity: Vector3, count: number): void {
    const r = this.rnd;
    const n = Math.max(1, Math.round(count * Math.min(1, 0.4 + 0.6 * this.ps)));
    // pieces of the player's car keep part of its velocity
    const pl = this.ctx.player;
    const own = (position.x - pl.position.x) ** 2 + (position.z - pl.position.z) ** 2 < 16;
    const ivx = own ? pl.velocity.x * 0.55 : 0;
    const ivz = own ? pl.velocity.z * 0.55 : 0;
    for (let i = 0; i < n; i++) {
      const s = 0.06 + r() * r() * 0.22;
      this.debrisSys.spawn(
        position.x + (r() - 0.5) * 0.4,
        Math.max(0.1, position.y + (r() - 0.5) * 0.3),
        position.z + (r() - 0.5) * 0.4,
        velocity.x * (0.5 + r() * 0.6) + (r() - 0.5) * 7 + ivx * (0.7 + 0.5 * r()),
        Math.abs(velocity.y) * 0.4 + 1.5 + r() * 4.5,
        velocity.z * (0.5 + r() * 0.6) + (r() - 0.5) * 7 + ivz * (0.7 + 0.5 * r()),
        s,
        r() < 0.4 ? 1 : 0,
        0,
        false,
        10 + r() * 6,
      );
    }
    // glass glitter
    const g = Math.round(n * 4 * this.ps);
    const sp = this.sparkSys.spawn;
    for (let i = 0; i < g; i++) {
      sp.x = position.x + (r() - 0.5) * 0.6;
      sp.y = Math.max(0.05, position.y + (r() - 0.5) * 0.4);
      sp.z = position.z + (r() - 0.5) * 0.6;
      sp.vx = velocity.x * (0.4 + r() * 0.7) + (r() - 0.5) * 8 + ivx * (0.6 + 0.6 * r());
      sp.vy = 1 + r() * 4;
      sp.vz = velocity.z * (0.4 + r() * 0.7) + (r() - 0.5) * 8 + ivz * (0.6 + 0.6 * r());
      sp.life = 2.5 + r() * 3;
      sp.heat = 1;
      sp.cool = 0;
      sp.size = 0.008 + r() * 0.01;
      sp.drag = 0.35;
      sp.grav = 1;
      sp.bounce = 0.22;
      sp.kind = GLASS;
      this.sparkSys.emit();
    }
  }

  /**
   * Crash smoke burst (scale ≥ 1, game uses 1.4–2.2) or an engine-smoke wisp (scale < 1, game uses 0.35–0.83, emitted
   * every ~0.09 s from a moving car). A burst is many overlapping soft billows of mixed size,
   * density and albedo (sooty core, lighter grey-brown dusty rim, a low fast ground skirt), so it
   * keeps internal structure and broken edges even with the camera a few metres away.
   */
  smokePuff(position: Vector3, velocity: Vector3, scale: number): void {
    const r = this.rnd;
    const S = Math.max(0.15, scale);
    const p = this.puffs.spawn;
    const vl = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (S < 1.0) {
      // engine wisp: two small streaky puffs strung along the motion so the trail stays continuous
      for (let i = 0; i < 2; i++) {
        this.base(p);
        const back = i * 0.5 * r();
        p.x = position.x - velocity.x * 0.05 * back + (r() - 0.5) * 0.3 * S;
        p.y = Math.max(0.2, position.y + (r() - 0.5) * 0.2);
        p.z = position.z - velocity.z * 0.05 * back + (r() - 0.5) * 0.3 * S;
        p.vx = velocity.x * (0.42 + r() * 0.2) + (r() - 0.5) * 0.8;
        p.vy = velocity.y * 0.3 + 0.5 + r() * 0.7;
        p.vz = velocity.z * (0.42 + r() * 0.2) + (r() - 0.5) * 0.8;
        p.size0 = (0.25 + r() * 0.15) * S;
        p.size1 = (1.5 + r() * 1.0) * S;
        p.grow = 1.4;
        p.life = 1.5 + r() * 1.2;
        p.albedo = 0.07 + r() * 0.05;
        p.dens = (0.34 + r() * 0.16) * Math.min(1, 0.6 + S);
        p.buoy = 0.8;
        p.drag = 1.8;
        p.wind = 1;
        p.turb = 1.1;
        p.erode0 = 0.16;
        p.erode1 = 0.95;
        p.noise = 0.55 + r() * 0.15;
        p.floor = 0.5;
        p.fadeIn = 0.12;
        p.rot = r() * TAU;
        p.rotV = (r() - 0.5) * 1.2;
        if (vl > 4) {
          p.stretch = -(1 + Math.min(1.6, vl * 0.045));
          p.dirX = velocity.x;
          p.dirY = 0;
          p.dirZ = velocity.z;
        }
        this.puffs.emit();
      }
      return;
    }
    const q = Math.sqrt(Math.max(0.4, this.ps));
    const n = Math.min(34, Math.max(6, Math.round((8 + 11 * S) * q)));
    const sm = 1 / Math.pow(q, 0.5); // fewer billows on low quality → slightly bigger ones
    // What a high-speed impact throws up: road dust, steam from the wet asphalt and the radiator,
    // tyre smoke — light grey-brown and semi-transparent, bursting out fast and thinning within a
    // second or two (no dense sooty ball: soot only comes with the fire). A few slower, slightly
    // darker tyre / oil smoke billows linger near the car.
    for (let i = 0; i < n; i++) {
      this.base(p);
      // billow centres in a squashed ellipsoid; the outer ones roll outwards faster
      randomHemisphere(_v, r, 0.15);
      const rr = Math.sqrt(r());
      const linger = i % 4 === 0;
      p.x = position.x + _v.x * rr * 0.9 * S;
      p.y = Math.max(0.3, position.y + (_v.y * rr * 0.55 - 0.1) * S);
      p.z = position.z + _v.z * rr * 0.9 * S;
      const out = (linger ? 0.8 + r() * 1.6 : 3 + r() * 5) * Math.sqrt(S) * (0.4 + rr);
      const inh = 0.25 + r() * 0.45;
      p.vx = velocity.x * inh + _v.x * out;
      p.vy = velocity.y * 0.3 + 0.5 + r() * 1.5 + _v.y * out * 0.45;
      p.vz = velocity.z * inh + _v.z * out;
      const big = r() < 0.3;
      p.size0 = (big ? 0.4 + r() * 0.2 : 0.22 + r() * 0.16) * S * sm;
      p.size1 = (big ? 1.5 + r() * 0.6 : 0.95 + r() * 0.55) * S * sm;
      p.grow = linger ? 0.9 + r() * 0.6 : 2.2 + r() * 1.4;
      p.life = linger ? 3.0 + r() * 2.5 : 1.1 + r() * 1.3;
      p.kind = KIND_FIRE;
      p.heat = 0;
      p.albedo = linger ? 0.18 + r() * 0.08 : 0.32 + r() * 0.14;
      p.dens = linger ? 0.26 + r() * 0.12 : 0.14 + r() * 0.12;
      p.buoy = 0.5 + r() * 0.6;
      p.drag = linger ? 1.3 + r() * 0.6 : 2.4 + r() * 1.0;
      p.wind = 0.9;
      p.turb = 1.2 + r() * 1.0;
      p.erode0 = 0.14 + r() * 0.06;
      p.erode1 = 0.97;
      p.noise = 0.5 + r() * 0.25;
      p.floor = 0.55;
      p.rot = r() * TAU;
      p.rotV = (r() < 0.5 ? -1 : 1) * (0.25 + r() * 0.6);
      p.fadeIn = 0.03 + r() * 0.05;
      this.puffs.emit();
    }
    // scraping metal: a fan of sparks thrown forward along the slide, low over the road
    const spk = this.sparkSys.spawn;
    const nSp = Math.round(32 * Math.sqrt(S) * this.ps);
    for (let i = 0; i < nSp; i++) {
      randomHemisphere(_v, r, 0.1);
      const v = 8 + r() * r() * 18;
      spk.x = position.x + (r() - 0.5) * 1.2;
      spk.y = Math.max(0.1, position.y - 0.3 + r() * 0.5);
      spk.z = position.z + (r() - 0.5) * 1.2;
      spk.vx = velocity.x * (0.8 + r() * 0.8) + _v.x * v;
      spk.vy = 0.5 + _v.y * v * 0.45;
      spk.vz = velocity.z * (0.8 + r() * 0.8) + _v.z * v;
      spk.life = 0.3 + r() * 0.6;
      spk.heat = 0.75 + r() * 0.35;
      spk.cool = 2.2 + r() * 2.0;
      spk.size = 0.006 + r() * 0.008;
      spk.drag = 1.2 + r() * 0.8;
      spk.grav = 1;
      spk.bounce = 0.3;
      spk.kind = SPARK;
      this.sparkSys.emit();
    }
    // low skirt of road dust / water spray thrown sideways
    const nk = Math.max(3, Math.round(6 * S * q));
    for (let i = 0; i < nk; i++) {
      this.base(p);
      const a = r() * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      p.kind = KIND_SPRAY;
      p.x = position.x + ca * 0.6 * S;
      p.y = 0.3;
      p.z = position.z + sa * 0.6 * S;
      const sp = (4 + r() * 5) * Math.sqrt(S);
      p.vx = velocity.x * 0.35 + ca * sp;
      p.vy = 0.3 + r() * 0.5;
      p.vz = velocity.z * 0.35 + sa * sp;
      p.drag = 2.6;
      p.size0 = 0.3 * S;
      p.size1 = (1.0 + r() * 0.6) * S;
      p.grow = 1.8;
      p.life = 1.4 + r() * 1.0;
      p.albedo = 0.3;
      p.dens = 0.2;
      p.buoy = 0.15;
      p.wind = 1;
      p.turb = 0.8;
      p.erode0 = 0.2;
      p.erode1 = 0.95;
      p.noise = 0.6;
      p.floor = 0.35;
      p.rot = r() * TAU;
      p.rotV = (r() - 0.5) * 1.0;
      p.fadeIn = 0.04;
      this.puffs.emit();
    }
  }

  setNitro(active: boolean, intensity: number): void {
    this.nitroTarget = active ? 1 : 0;
    this.nitroIntensity = Math.max(0, Math.min(1.5, intensity));
  }

  reset(): void {
    this.puffs.clear();
    this.sparkSys.clear();
    this.debrisSys.clear();
    this.decals.clear();
    this.distortion.clear();
    this.glow.clear();
    for (const b of this.blasts) b.active = false;
    for (const f of this.fires) {
      if (f.active) f.gen++;
      f.active = false;
      f.target = null;
    }
    this.nitroTarget = 0;
    this.nitro.setLevel(0, this.time);
    const L = this.fireU.uFireL.value;
    for (let i = 0; i < L.length; i++) L[i].set(0, -1000, 0, 0);
  }

  stats(): VfxStats {
    let ex = 0;
    let fi = 0;
    for (const b of this.blasts) if (b.active) ex++;
    for (const f of this.fires) if (f.active) fi++;
    return {
      puffs: this.puffs.count,
      sparks: this.sparkSys.count,
      debris: this.debrisSys.count,
      peakPuffs: this.puffs.peak,
      peakSparks: this.sparkSys.peak,
      explosions: ex,
      fires: fi,
      cpuMs: this.cpuMs,
      distortion: this.distortion.active,
    };
  }

  dispose(): void {
    this.puffs.dispose();
    this.sparkSys.dispose();
    this.debrisSys.dispose();
    this.decals.dispose();
    this.nitro.dispose();
    this.distortion.dispose();
    this.glow.dispose();
  }

  // ───────────────────────────────────────────────────────── frame

  update(dt: number, _time: number): void {
    const t0 = performance.now();
    const ps = this.ctx.quality.settings.particleScale;
    this.ps = ps;
    this.puffs.budget = Math.min(this.puffs.capacity, Math.round(VFX_LIMITS.puffs * ps));
    this.sparkSys.budget = Math.min(this.sparkSys.capacity, Math.round(VFX_LIMITS.sparks * ps));
    dt = Math.max(0, Math.min(dt, 0.1));
    this.time += dt;
    this.fireU.uVfxTime.value = this.time;
    this.distortion.beginHaze();
    this.glow.begin();

    if (dt > 0) {
      for (const b of this.blasts) if (b.active) this.stepBlast(b, dt);
      for (const f of this.fires) if (f.active) this.stepFire(f, dt);
    }
    this.updateLights(dt);
    this.updateNitro(dt);

    const cam = this.ctx.engine.camera;
    this.puffs.update(dt, cam);
    // streak length = motion during the REAL exposure: in slow motion the sim moves less per frame
    const now = performance.now();
    const raw = this.lastNow > 0 ? (now - this.lastNow) / 1000 : 1 / 60;
    this.lastNow = now;
    if (dt > 0 && raw > 1e-4) {
      const ts = Math.max(0.08, Math.min(1, dt / Math.min(0.1, raw)));
      this.timeScale += (ts - this.timeScale) * 0.25;
    }
    (this.sparkSys.material.uniforms.uShutter as { value: number }).value = 0.028 * this.timeScale;
    this.sparkSys.update(dt, this.time);
    this.debrisSys.update(dt);
    this.decals.update(dt);
    this.glow.end();
    this.distortion.step(dt, cam);
    if (this.warm > 0) {
      // first frames: draw every VFX mesh once (empty / black) so their programs are compiled at
      // load time instead of hitching on the first crash or explosion
      this.warm--;
      this.puffs.mesh.visible = true;
      this.sparkSys.mesh.visible = true;
      this.decals.mesh.visible = true;
      this.nitro.mesh.visible = true;
      this.glow.mesh.visible = true;
      for (const m of this.debrisSys.meshes) m.visible = true;
    }
    const ms = performance.now() - t0;
    this.cpuMs = this.cpuMs * 0.9 + ms * 0.1;
  }

  // ───────────────────────────────────────────────────────── explosion

  private detonate(b: Blast, withDebris: boolean): void {
    const { ctx, rnd: r } = this;
    const S = b.S;
    const P = b.pos;
    const ps = this.ps;
    const cm = Math.pow(S, 0.55) * ps; // particle count multiplier
    const sm = 1 / Math.pow(Math.max(0.4, ps), 0.3); // fewer → slightly bigger puffs
    const p = this.puffs.spawn;

    // 1. flash: white-hot core sprites + light + event + shockwave
    this.base(p);
    p.x = P.x;
    p.y = P.y + 0.9 * S;
    p.z = P.z;
    p.kind = KIND_FLASH;
    p.size0 = 1.6 * S;
    p.size1 = 4.5 * S;
    p.grow = 30;
    p.life = 0.06;
    p.dens = 0.99;
    p.fadeIn = 0.001;
    p.floor = 0;
    this.puffs.emit();
    p.size0 = 3.5 * S;
    p.size1 = 7 * S;
    p.life = 0.12;
    p.dens = 0.1;
    this.puffs.emit();
    _v.set(P.x, P.y + 1.6 * S, P.z);
    // soft-limited: a tanker (S 2.5) at 6000·S² washed the road and every car white-cream for
    // ~0.4 s; ≈ 8700 (and a shorter tail) keeps a blinding but still warm flash (S 1: 6000 → 4000)
    const fl = 6000 * S * S;
    ctx.lighting.flash(_v, _col.setRGB(1.0, 0.62, 0.32), (fl * 12000) / (12000 + fl), 0.7);
    ctx.events.emit('explosion', { position: b.pos, scale: S });
    _v.set(P.x, P.y + 1.2 * S, P.z);
    this.distortion.shock(_v, S);

    // 2. fireball: primary burst
    const nFire = Math.round(32 * cm);
    for (let i = 0; i < nFire; i++) this.fireballPuff(b, 1, sm);
    const nSoot = Math.round(10 * cm);
    for (let i = 0; i < nSoot; i++) this.fireballPuff(b, 3, sm);

    // 3a. ground ring of water spray / mist (wet road)
    const nRing = Math.round(44 * cm);
    for (let i = 0; i < nRing; i++) {
      const a = (i / nRing) * TAU + r() * 0.2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.base(p);
      p.kind = KIND_SPRAY;
      const fast = i % 3 !== 0;
      const sp = (fast ? 24 + r() * 10 : 9 + r() * 6) * Math.sqrt(S);
      p.x = P.x + ca * 1.2 * S;
      p.y = 0.25 + r() * 0.3;
      p.z = P.z + sa * 1.2 * S;
      p.vx = ca * sp + b.vel.x * 0.3;
      p.vy = 0.6 + r() * 1.2;
      p.vz = sa * sp + b.vel.z * 0.3;
      p.drag = fast ? 3.4 : 2.2;
      p.size0 = 0.5 * S * sm;
      p.size1 = (fast ? 2.4 : 3.0) * S * sm;
      p.grow = 2.2;
      p.life = fast ? 0.8 + r() * 0.5 : 1.6 + r() * 0.9;
      p.albedo = 0.08;
      p.dens = fast ? 0.22 : 0.14;
      if (fast) {
        p.stretch = -1.9;
        p.dirX = ca;
        p.dirY = 0;
        p.dirZ = sa;
      }
      p.buoy = 0.25;
      p.wind = 1;
      p.turb = 1;
      p.erode0 = 0.18;
      p.erode1 = 0.92;
      p.noise = 0.45;
      p.floor = 0.25;
      p.rot = r() * TAU;
      p.rotV = (r() - 0.5) * 1.2;
      p.fadeIn = 0.03;
      this.puffs.emit();
    }

    // 5. sparks + embers
    const sp = this.sparkSys.spawn;
    const nSpark = Math.round(280 * Math.pow(S, 0.6) * ps);
    for (let i = 0; i < nSpark; i++) {
      randomHemisphere(_v, r, 0.25);
      const v = (12 + r() * r() * 38) * Math.pow(S, 0.3);
      sp.x = P.x + _v.x * 0.8 * S;
      sp.y = P.y + 0.6 * S + _v.y * 0.5 * S;
      sp.z = P.z + _v.z * 0.8 * S;
      sp.vx = _v.x * v + b.vel.x * 0.5;
      sp.vy = _v.y * v;
      sp.vz = _v.z * v + b.vel.z * 0.5;
      sp.life = 1.0 + r() * 2.0;
      sp.heat = 0.9 + r() * 0.25;
      sp.cool = 0.7 + r() * 1.4;
      sp.size = 0.012 + r() * 0.016;
      sp.drag = 0.55 + r() * 0.5;
      sp.grav = 1;
      sp.bounce = 0.35;
      sp.kind = SPARK;
      this.sparkSys.emit();
    }
    const nEmber = Math.round(46 * Math.pow(S, 0.6) * ps);
    for (let i = 0; i < nEmber; i++) {
      randomHemisphere(_v, r, 0.5);
      const v = 2 + r() * 7;
      sp.x = P.x + _v.x * 1.5 * S;
      sp.y = P.y + 1.0 * S + _v.y * S;
      sp.z = P.z + _v.z * 1.5 * S;
      sp.vx = _v.x * v;
      sp.vy = _v.y * v + 2;
      sp.vz = _v.z * v;
      sp.life = 3 + r() * 4;
      sp.heat = 0.8 + r() * 0.3;
      sp.cool = 0.25 + r() * 0.35;
      sp.size = 0.02 + r() * 0.025;
      sp.drag = 1.2;
      sp.grav = 0.12;
      sp.bounce = 0.2;
      sp.kind = EMBER;
      this.sparkSys.emit();
    }

    // 6. debris
    if (withDebris) {
      const nDeb = Math.min(30, Math.round(12 + 9 * Math.sqrt(S)));
      for (let i = 0; i < nDeb; i++) {
        randomHemisphere(_v, r, 0.35);
        const big = r() < 0.3;
        const v = (big ? 7 + r() * 9 : 10 + r() * 16) * Math.pow(S, 0.35);
        const size = (big ? 0.35 + r() * 0.35 : 0.1 + r() * 0.25) * Math.pow(S, 0.3);
        this.debrisSys.spawn(
          P.x + _v.x * 0.6,
          P.y + 0.6 + _v.y * 0.5,
          P.z + _v.z * 0.6,
          _v.x * v + b.vel.x * 0.6,
          _v.y * v + 2,
          _v.z * v + b.vel.z * 0.6,
          size,
          big || r() < 0.4 ? 1 : 0,
          r() < 0.6 ? 0.8 + r() * 0.5 : 0,
          r() < 0.5,
          20 + r() * 8,
        );
      }
    }

    // 8. scorch decal
    this.decals.add(P.x, P.z, 3.4 * S * (0.9 + r() * 0.25), r());
  }

  /**
   * One fireball puff. `phase` 1 = primary burst (outer lobes), 2 = secondary (hotter, slower,
   * inner core), 3 = soot pocket (dark, rich fuel smoke rolling between the fire lobes).
   */
  private fireballPuff(b: Blast, phase: number, sm: number): void {
    const r = this.rnd;
    const S = b.S;
    const p = this.puffs.spawn;
    this.base(p);
    randomHemisphere(_v, r, 0.2);
    const inner = phase === 2;
    const soot = phase === 3;
    // a few lobes shoot much further than the rest → irregular, lobed silhouette
    const lobe = !inner && r() < 0.25 ? 1.6 : 1;
    const sp = (inner ? 3 + r() * 6 : soot ? 5 + r() * 7 : 6 + r() * 10) * Math.sqrt(S) * lobe;
    const P = b.pos;
    p.x = P.x + _v.x * 0.5 * S;
    p.y = P.y + (0.5 + _v.y * 0.6) * S;
    p.z = P.z + _v.z * 0.5 * S;
    p.vx = _v.x * sp + b.vel.x * 0.6;
    p.vy = _v.y * sp * 0.9 + 2;
    p.vz = _v.z * sp + b.vel.z * 0.6;
    p.drag = 4.2;
    p.size0 = (0.7 + r() * 0.5) * S * sm;
    p.size1 = (inner ? 1.9 + r() * 0.6 : 2.3 + r() * 0.9) * S * sm;
    p.grow = inner ? 2.4 : 3.2;
    p.life = 3.2 + r() * 1.8;
    p.heat = soot ? 0.2 + r() * 0.2 : inner ? 0.95 + r() * 0.2 : 0.6 + r() * 0.45;
    // big fireballs burn longer (a tanker's fuel cloud keeps burning for well over a second)
    p.cool = soot ? 2.5 : ((inner ? 1.0 : 1.3) + r() * 0.6) / Math.sqrt(Math.max(1, S));
    p.dens = soot ? 0.95 : 0.88;
    p.albedo = 0.022;
    p.buoy = 4.5;
    p.wind = 0.6;
    p.turb = 2.5;
    p.rot = r() * TAU;
    p.rotV = (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.9);
    p.erode0 = 0.06;
    p.erode1 = 0.82;
    p.noise = 0.28;
    p.fadeIn = 0.015;
    p.floor = 0.4;
    this.puffs.emit();
  }

  private stepBlast(b: Blast, dt: number): void {
    const r = this.rnd;
    const S = b.S;
    const ps = this.ps;
    const cm = Math.pow(S, 0.55) * ps;
    const sm = 1 / Math.pow(Math.max(0.4, ps), 0.3);
    const t0 = b.t;
    b.t += dt;
    const t = b.t;
    const p = this.puffs.spawn;
    const P = b.pos;

    // fireball centroid (rises with buoyancy, carried by the inherited velocity)
    const rise = (0.9 + 1.6 * Math.min(t, 3) * Math.sqrt(S)) * S;
    const cx = P.x + b.vel.x * Math.min(t, 1) * 0.45;
    const cz = P.z + b.vel.z * Math.min(t, 1) * 0.45;
    const cy = P.y + rise;

    // 2b. secondary fireball puffs in the first 0.25 s (feed the hot core, rolling growth)
    const nSec = Math.round(16 * cm);
    const want = Math.min(nSec, Math.floor((t / 0.25) * nSec));
    while (b.secondary < want) {
      this.fireballPuff(b, 2, sm);
      b.secondary++;
    }

    // 4a. fast dark turbulent smoke from the fireball (first ~2 s)
    // (rolls up over the top of the fireball first, so the fire stays visible below it)
    const sq = Math.sqrt(Math.max(1, S));
    if (t > 0.06 * sq && t < 2.2) {
      b.smokeAcc += dt * 20 * cm * (1 - t / 2.4);
      while (b.smokeAcc >= 1) {
        b.smokeAcc -= 1;
        this.base(p);
        randomHemisphere(_v, r, t < 0.9 * sq ? 0.45 : 0.0);
        const rad = (1.6 + r() * 1.4) * S;
        p.x = cx + _v.x * rad;
        p.y = Math.max(0.6 * S, cy + (_v.y - 0.35) * rad);
        p.z = cz + _v.z * rad;
        const out = 2 + r() * 3;
        p.vx = _v.x * out;
        p.vy = 2.5 + r() * 2.5 + _v.y * out;
        p.vz = _v.z * out;
        p.drag = 1.5;
        p.size0 = (1.3 + r() * 0.6) * S * sm;
        p.size1 = (3.6 + r() * 1.6) * S * sm;
        p.grow = 0.9;
        p.life = 5 + r() * 4;
        p.heat = t < 0.8 * sq ? 0.4 + r() * 0.25 : 0.1;
        p.cool = 2.2 / sq;
        p.dens = 0.6 + 0.3 * Math.min(1, t / (1.2 * sq));
        p.albedo = 0.02;
        p.buoy = 2.2;
        p.wind = 0.7;
        p.turb = 2.2;
        p.rot = r() * TAU;
        p.rotV = (r() - 0.5) * 0.9;
        p.erode0 = 0.06;
        p.erode1 = 0.88;
        p.noise = 0.2;
        p.fadeIn = 0.25;
        p.floor = 0.4;
        this.puffs.emit();
      }
    }

    // 4b. lingering smoke column
    const sd = b.smoke;
    if (t > 0.5 && t < sd) {
      const u = (t - 0.5) / Math.max(0.5, sd - 0.5);
      b.columnAcc += dt * 5.5 * Math.pow(S, 0.6) * ps * Math.pow(1 - u, 0.7);
      while (b.columnAcc >= 1) {
        b.columnAcc -= 1;
        this.base(p);
        const a = r() * TAU;
        const rr = r() * 1.3 * S;
        p.x = P.x + Math.cos(a) * rr;
        p.y = P.y + (1.2 + r()) * S;
        p.z = P.z + Math.sin(a) * rr;
        p.vx = (r() - 0.5) * 0.8;
        p.vy = 2.2 + r() * 2.0;
        p.vz = (r() - 0.5) * 0.8;
        p.drag = 0.7;
        p.size0 = (1.6 + r() * 0.6) * S * sm;
        p.size1 = (6.0 + r() * 3.0) * S * sm;
        p.grow = 0.28;
        p.life = (8 + r() * 5) * Math.min(1.3, Math.pow(sd / 12, 0.4));
        p.heat = 0.03;
        p.cool = 0.5;
        p.dens = 0.78 * (1 - 0.45 * u);
        p.albedo = 0.022;
        p.buoy = 0.55;
        p.wind = 0.9;
        p.turb = 1.0;
        p.rot = r() * TAU;
        p.rotV = (r() - 0.5) * 0.35;
        p.erode0 = 0.08;
        p.erode1 = 0.9;
        p.noise = 0.17;
        p.fadeIn = 0.6;
        p.floor = 0.35;
        this.puffs.emit();
      }
    }

    // 8. ground fire patches near the centre
    if (!b.patches && t >= 0.12) {
      b.patches = true;
      const n = Math.min(5, Math.round(2 + 1.2 * S));
      for (let i = 0; i < n; i++) {
        const a = r() * TAU;
        const rr = (0.3 + r() * 2.2) * S;
        const f = this.startFire(null, null, (0.45 + r() * 0.45) * Math.pow(S, 0.7), (3 + r() * 4) * Math.pow(S, 0.4), 0, 0.55);
        if (!f) break;
        f.intensity = 0.7;
        f.fixed.set(P.x + Math.cos(a) * rr, 0, P.z + Math.sin(a) * rr);
      }
    }

    // fireball light (self-illumination of the smoke + lingering glow)
    const env = t < 0.08 ? t / 0.08 : Math.exp(-(t - 0.08) * 1.5);
    b.light = 9000 * S * S * env * (0.85 + 0.15 * Math.sin(t * 37 + S));
    b.lightPos.set(cx, Math.max(1, cy - 0.6 * S), cz);
    if (env > 0.02) {
      // the fireball lights the wet road around it
      const gi = 0.9 * env * Math.sqrt(S) * (0.85 + 0.15 * Math.sin(t * 31));
      this.glow.push(cx, cz, 5 + 5 * S, gi, gi * 0.5, gi * 0.2);
    }
    void t0;
    if (t > Math.max(sd, 4)) b.active = false;
  }

  // ───────────────────────────────────────────────────────── fire

  private startFire(target: { position: Vector3 } | null, _unused: null, scale: number, duration: number, lift: number, smokeMul: number): Fire | null {
    let f = this.fires.find((x) => !x.active);
    if (!f) {
      // replace the weakest ground patch
      f = this.fires.reduce((a, c) => (a.scale * (a.target ? 4 : 1) < c.scale * (c.target ? 4 : 1) ? a : c));
      f.gen++;
    }
    f.active = true;
    f.target = target;
    f.scale = Math.max(0.1, scale);
    f.duration = duration > 0 ? duration : Infinity;
    f.age = 0;
    f.intensity = 1;
    f.stopping = false;
    f.stopAge = 0;
    f.level = 0;
    f.flameAcc = 0;
    f.smokeAcc = 0;
    f.emberAcc = 0;
    f.lift = lift;
    f.smokeMul = smokeMul;
    f.light = 0;
    f.coreAcc = 0;
    f.hasPrev = false;
    f.tv.set(0, 0, 0);
    f.glow = 0;
    f.patch = !target;
    if (target) f.fixed.copy(target.position);
    return f;
  }

  private handle(f: Fire | null): FireHandle {
    if (!f) return { stop() {}, setIntensity() {} };
    const gen = f.gen;
    return {
      stop: () => {
        if (f.active && f.gen === gen) f.stopping = true;
      },
      setIntensity: (i: number) => {
        if (f.active && f.gen === gen) f.intensity = Math.max(0, Math.min(1.5, i));
      },
    };
  }

  private stepFire(f: Fire, dt: number): void {
    const r = this.rnd;
    f.age += dt;
    if (!f.stopping && f.age > f.duration) f.stopping = true;
    if (f.stopping) f.stopAge += dt;
    const fadeIn = Math.min(1, f.age / 0.35);
    const fadeOut = f.stopping ? Math.max(0, 1 - f.stopAge / 0.7) : 1;
    f.level = f.intensity * fadeIn * fadeOut;
    if (f.stopping && fadeOut <= 0) {
      f.active = false;
      f.gen++;
      f.light = 0;
      return;
    }
    const src = f.target ? drawnPosition(f.target, this.src) : f.fixed;
    // source velocity (a burning wreck may still be sliding / tumbling): flames and smoke inherit it
    if (f.hasPrev && dt > 1e-4) {
      const k = 1 - Math.exp(-10 * dt);
      _w.subVectors(src, f.prev).multiplyScalar(1 / dt);
      if (_w.lengthSq() > 3600) _w.setLength(60); // teleports / respawns
      f.tv.lerp(_w, k);
    }
    f.prev.copy(src);
    f.hasPrev = true;
    const base = f.base.set(src.x, Math.max(0.05, src.y + f.lift), src.z);
    const sc = f.scale;
    const L = f.level;
    const ps = this.ps;
    const p = this.puffs.spawn;
    const tv = f.tv;
    // flames lean back against the motion and a little with the wind
    let lx = -tv.x * 0.045 + WIND.x * 0.05;
    let lz = -tv.z * 0.045 + WIND.z * 0.05;
    const ll = Math.hypot(lx, lz);
    if (ll > 1.3) {
      lx *= 1.3 / ll;
      lz *= 1.3 / ll;
    }

    // flame tongues: vertical licking teardrops, hot base → red tips, rising and thinning out
    f.flameAcc += dt * 26 * Math.pow(sc, 0.9) * L * Math.max(0.5, ps);
    while (f.flameAcc >= 1) {
      f.flameAcc -= 1;
      this.base(p);
      p.kind = KIND_FLAME;
      const a = r() * TAU;
      const rr = Math.sqrt(r()) * 0.75 * sc;
      const rad = (0.26 + r() * 0.16) * sc;
      const st = (2.1 + r() * 1.1) * (f.patch ? 0.7 : 1);
      const dx = lx + (r() - 0.5) * 0.25;
      const dz = lz + (r() - 0.5) * 0.25;
      const dl = 1 / Math.hypot(dx, 1, dz);
      const up = st * rad * 0.8; // centre of the quad above the flame root
      p.x = base.x + Math.cos(a) * rr + dx * dl * up;
      p.y = base.y + dl * up - 0.1 * sc;
      p.z = base.z + Math.sin(a) * rr + dz * dl * up;
      p.vx = tv.x * 0.85 + (r() - 0.5) * 0.6;
      p.vy = 0.4 + r() * 0.8;
      p.vz = tv.z * 0.85 + (r() - 0.5) * 0.6;
      p.drag = 0.6;
      p.size0 = rad * 0.8;
      p.size1 = rad * (1.15 + r() * 0.3);
      p.grow = 2.2;
      p.stretch = -st;
      p.dirX = dx;
      p.dirY = 1;
      p.dirZ = dz;
      p.life = 0.45 + r() * 0.4;
      p.heat = 0.74 + r() * 0.18 - (f.patch ? 0.16 : 0);
      p.cool = 1.1 + r() * 0.5;
      p.dens = 0.5;
      p.buoy = 2.5;
      p.wind = 0.2;
      p.turb = 2.5;
      p.erode0 = 0.06 + r() * 0.06;
      p.erode1 = 0.62;
      p.noise = 0.32 + r() * 0.14;
      p.fadeIn = 0.07;
      p.floor = 0;
      this.puffs.emit();
    }
    // glowing bed at the base (the burning body itself)
    f.coreAcc += dt * 7 * Math.pow(sc, 0.8) * L * Math.max(0.5, ps);
    while (f.coreAcc >= 1) {
      f.coreAcc -= 1;
      this.base(p);
      const a = r() * TAU;
      const rr = Math.sqrt(r()) * 0.6 * sc;
      p.x = base.x + Math.cos(a) * rr;
      p.y = base.y + 0.25 * sc;
      p.z = base.z + Math.sin(a) * rr;
      p.vx = tv.x * 0.9;
      p.vy = 0.5 + r() * 0.5;
      p.vz = tv.z * 0.9;
      p.drag = 0.6;
      p.size0 = (0.3 + r() * 0.12) * sc;
      p.size1 = (0.5 + r() * 0.2) * sc;
      p.grow = 2.5;
      p.stretch = 1.25;
      p.life = 0.35 + r() * 0.3;
      p.heat = 0.66 + r() * 0.12 - (f.patch ? 0.14 : 0);
      p.cool = 1.6;
      p.dens = 0.55;
      p.albedo = 0.022;
      p.buoy = 2;
      p.wind = 0.2;
      p.turb = 1.5;
      p.rot = r() * TAU;
      p.rotV = (r() - 0.5) * 2;
      p.erode0 = 0.12;
      p.erode1 = 0.7;
      p.noise = 0.45;
      p.fadeIn = 0.05;
      p.floor = 0;
      this.puffs.emit();
    }
    // dark smoke column from above the flames: rises, leans with the wind, widens and thins out
    f.smokeAcc += dt * 6.5 * Math.pow(sc, 0.7) * L * ps * f.smokeMul;
    while (f.smokeAcc >= 1) {
      f.smokeAcc -= 1;
      this.base(p);
      p.x = base.x + (r() - 0.5) * 0.7 * sc + lx * 1.2 * sc;
      p.y = base.y + (1.3 + r() * 0.6) * sc;
      p.z = base.z + (r() - 0.5) * 0.7 * sc + lz * 1.2 * sc;
      p.vx = tv.x * 0.5 + (r() - 0.5) * 0.6;
      p.vy = 1.8 + r() * 1.2;
      p.vz = tv.z * 0.5 + (r() - 0.5) * 0.6;
      p.drag = 0.7;
      p.size0 = (0.4 + r() * 0.25) * sc;
      p.size1 = (2.2 + r() * 1.4) * sc;
      p.grow = 0.32;
      p.life = 7 + r() * 4;
      p.heat = 0.1;
      p.cool = 0.9;
      p.dens = 0.6 + r() * 0.2;
      p.albedo = 0.025 + r() * 0.02;
      p.buoy = 0.7;
      p.wind = 1;
      p.turb = 1.3;
      p.rot = r() * TAU;
      p.rotV = (r() - 0.5) * 0.5;
      p.erode0 = 0.1;
      p.erode1 = 0.96;
      p.noise = 0.3 + r() * 0.1;
      p.fadeIn = 0.35;
      p.floor = 0.3;
      this.puffs.emit();
    }
    // embers: flickering motes carried up in the plume
    f.emberAcc += dt * (f.patch ? 3 : 9) * sc * L * ps;
    const sp = this.sparkSys.spawn;
    while (f.emberAcc >= 1) {
      f.emberAcc -= 1;
      sp.x = base.x + (r() - 0.5) * sc;
      sp.y = base.y + (0.3 + r() * 0.9) * sc;
      sp.z = base.z + (r() - 0.5) * sc;
      sp.vx = tv.x * 0.7 + (r() - 0.5) * 2 + WIND.x * 0.3;
      sp.vy = 2.5 + r() * 3.5;
      sp.vz = tv.z * 0.7 + (r() - 0.5) * 2 + WIND.z * 0.3;
      sp.life = 1.5 + r() * 2.5;
      sp.heat = 0.8 + r() * 0.3;
      sp.cool = 0.35 + r() * 0.4;
      sp.size = 0.012 + r() * 0.016;
      sp.drag = 1.1;
      sp.grav = 0.08;
      sp.bounce = 0.2;
      sp.kind = EMBER;
      this.sparkSys.emit();
    }
    // light + flickering warm pool on the road + heat haze
    const fl = 0.78 + 0.22 * Math.sin(this.time * 23 + sc * 7) * Math.sin(this.time * 9.7 + sc);
    f.glow += (fl * (0.85 + 0.3 * r()) - f.glow) * Math.min(1, dt * 18);
    f.light = 1300 * sc * sc * L * fl;
    f.lightPos.set(base.x, base.y + 0.7 * sc, base.z);
    const gi = 0.5 * L * f.glow * Math.min(1.5, 0.55 + 0.45 * sc);
    this.glow.push(base.x + lx * 0.4 * sc, base.z + lz * 0.4 * sc, 2.0 + 2.6 * sc, gi, gi * 0.42, gi * 0.13);
    if (f.duration > 2.5 && L > 0.05) {
      _v.set(base.x, base.y + 0.6 * sc, base.z);
      this.distortion.pushHaze(_v, 0.9 * sc, 4.2 * sc, L * Math.min(1.5, sc));
    }
  }

  // ───────────────────────────────────────────────────────── lights

  private updateLights(dt: number): void {
    // gather sources
    let n = 0;
    const I = this.lightI;
    const Pp = this.lightP;
    for (const b of this.blasts) {
      if (b.active && b.light > 1) {
        I[n] = b.light;
        Pp[n].copy(b.lightPos);
        n++;
      }
    }
    for (const f of this.fires) {
      if (f.active && f.light > 1) {
        I[n] = f.light;
        Pp[n].copy(f.lightPos);
        n++;
      }
    }
    // top FIRE_LIGHTS by intensity → particle self-illumination
    const L = this.fireU.uFireL.value;
    const R = this.fireU.uFireR.value;
    for (let k = 0; k < FIRE_LIGHTS; k++) {
      let best = -1;
      let bi = 0;
      for (let i = 0; i < n; i++) {
        if (I[i] > bi) {
          bi = I[i];
          best = i;
        }
      }
      if (best < 0) {
        L[k].set(0, -1000, 0, 0);
        continue;
      }
      // smoke self-illumination is much weaker than the raw source (the smoke shadows itself)
      L[k].set(Pp[best].x, Pp[best].y, Pp[best].z, I[best] * 0.1);
      R[k] = 3 + Math.sqrt(I[best]) * 0.03;
      I[best] = -I[best]; // mark used
    }
    for (let i = 0; i < n; i++) if (I[i] < 0) I[i] = -I[i];

    // lingering fire glow on the world: low flashes re-triggered at ~20 Hz with random flicker
    if (dt <= 0 || n === 0) return;
    this.glowTimer -= dt;
    if (this.glowTimer > 0) return;
    this.glowTimer = 0.045 + this.rnd() * 0.03;
    // aggregate: intensity-weighted centroid of the strongest cluster (sum of all fires)
    let sum = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < n; i++) {
      const w = I[i];
      sum += w;
      x += Pp[i].x * w;
      y += Pp[i].y * w;
      z += Pp[i].z * w;
    }
    if (sum < 50) return;
    // The world light of the fires: soft-limited (a tanker fire with its fuel patches would
    // otherwise light the asphalt next to it ≈ 6× over-exposed, cream-white) and raised above the
    // flames (r² + 9 softening in the world shaders: a flatter pool, the far field barely changes),
    // deep warm orange so the road under it stays orange.
    _v.set(x / sum, y / sum + FIRE_FLASH_LIFT, z / sum);
    const flick = 0.7 + this.rnd() * 0.55;
    const raw = sum * 0.1 * flick;
    this.ctx.lighting.flash(_v, _col.setRGB(1.0, 0.43, 0.14), (raw * FIRE_FLASH_K) / (FIRE_FLASH_K + raw), 0.26);
  }

  // ───────────────────────────────────────────────────────── nitro

  private updateNitro(dt: number): void {
    const target = this.nitroTarget * this.nitroIntensity;
    const nf = this.nitro;
    const prevLevel = nf.level;
    // fast attack, quick taper
    const rate = target > nf.level ? 20 : 13;
    let level = target + (nf.level - target) * Math.exp(-rate * dt);
    if (level < 0.02 && target === 0) level = 0;
    // ignition pop: a short over-bright, over-long burst when the nitro lights up
    if (prevLevel < 0.05 && target > 0.05) this.nitroPop = 1;
    this.nitroPop = Math.max(0, this.nitroPop - dt / 0.16);
    nf.setLevel(level, this.time, 1 + 0.9 * this.nitroPop * this.nitroPop);
    if (nf.level <= 0.01) return;
    const ctx = this.ctx;
    const vis = ctx.playerVisual;
    const pl = ctx.player;
    if (vis) {
      const a = vis.anchors;
      a.exhaustL.updateWorldMatrix(true, false);
      a.exhaustR.updateWorldMatrix(true, false);
      a.exhaustL.getWorldPosition(this.exL);
      a.exhaustR.getWorldPosition(this.exR);
      vis.root.getWorldQuaternion(this.exQ);
    } else {
      const h = pl.heading;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const rx = Math.cos(h);
      const rz = Math.sin(h);
      const bk = (pl.dims?.length ?? 4.5) * 0.5 - 0.05;
      this.exL.set(pl.position.x - fx * bk - rx * 0.45, 0.33, pl.position.z - fz * bk - rz * 0.45);
      this.exR.set(pl.position.x - fx * bk + rx * 0.45, 0.33, pl.position.z - fz * bk + rz * 0.45);
      this.exQ.copy(pl.quaternion);
    }
    this.back.set(0, 0, 1).applyQuaternion(this.exQ);
    const r = this.rnd;
    const lv = nf.level;
    const v = pl.velocity;
    const spd = Math.min(1, Math.hypot(v.x, v.z) / 80);
    const pop = this.nitroPop;
    for (let i = 0; i < 2; i++) {
      const e = i === 0 ? this.exL : this.exR;
      // per-frame flicker of the length (fast, slightly different per side)
      const fl = 0.9 + 0.2 * r();
      const len = (0.62 + 0.38 * lv + 0.3 * spd) * fl * (1 + 0.35 * pop);
      nf.set(i, e, this.exQ, 0.052 * (0.92 + 0.12 * r()) * (0.85 + 0.15 * lv), len);
    }
    // modest bluish pool on the wet road behind the exhausts + faint heat shimmer
    const gx = (this.exL.x + this.exR.x) * 0.5 + this.back.x * 0.55;
    const gz = (this.exL.z + this.exR.z) * 0.5 + this.back.z * 0.55;
    const gi = 0.16 * lv * (0.85 + 0.3 * r()) * (1 + pop);
    this.glow.push(gx, gz, 1.05, gi * 0.32, gi * 0.5, gi, this.back.x, this.back.z, 1.5);
    _v.set(gx, Math.max(0.1, (this.exL.y + this.exR.y) * 0.5 - 0.1), gz);
    this.distortion.pushHaze(_v, 0.55, 0.9, 0.35 * lv);
  }

  /** Reset the spawn template to neutral defaults. */
  private base(p: PuffSystem['spawn']): void {
    p.vx = p.vy = p.vz = 0;
    p.rot = 0;
    p.rotV = 0;
    p.heat = 0;
    p.cool = 1;
    p.dens = 0.8;
    p.albedo = 0.06;
    p.buoy = 0;
    p.drag = 1;
    p.wind = 0.5;
    p.turb = 0;
    p.kind = KIND_FIRE;
    p.stretch = 1;
    p.fadeIn = 0.05;
    p.erode0 = 0.08;
    p.erode1 = 0.7;
    p.noise = 0.32;
    p.floor = 0.35;
    p.grow = 2;
  }
}

/** Random unit vector on the upper hemisphere; `lift` biases it upward. */
/**
 * Where a fire target is DRAWN. A crash-world wreck (WreckBody) only moves its `position` on 60 Hz
 * physics steps, while its `object` is drawn interpolated between the last two steps (CrashWorld
 * syncObject: origin = body centre − R·(0, yOffset, 0)); in the 0.2× slow-motion shot the physics
 * pose jumps at 12 Hz, so attached flames / smoke follow the drawn pose instead (body centre
 * recovered as object.position + R·(0, yOffset, 0)). Anything else: its `position`.
 */
function drawnPosition(target: { position: Vector3 }, out: Vector3): Vector3 {
  const t = target as { position: Vector3; object?: { position: Vector3; quaternion: Quaternion }; yOffset?: unknown };
  const o = t.object;
  if (o && o.position && o.quaternion) {
    const yo = typeof t.yOffset === 'number' ? t.yOffset : 0;
    out.set(0, yo, 0).applyQuaternion(o.quaternion).add(o.position);
    // a recycled / re-parented object (not drawn at the body any more): trust the physics pose
    if (out.distanceToSquared(target.position) < 9) return out;
  }
  return out.copy(target.position);
}

function randomHemisphere(out: Vector3, r: () => number, lift: number): Vector3 {
  const u = r() * 2 - 1;
  const a = r() * TAU;
  const s = Math.sqrt(1 - u * u);
  out.set(Math.cos(a) * s, Math.abs(u) * (1 - lift) + lift, Math.sin(a) * s);
  return out.normalize();
}

/** Random unit vector within `spread` radians of `axis` (unit). */
function randomCone(out: Vector3, axis: Vector3, spread: number, r: () => number): Vector3 {
  const a = r() * TAU;
  const c = Math.cos(spread * Math.sqrt(r()));
  const s = Math.sqrt(1 - c * c);
  // orthonormal basis around axis
  const ux = Math.abs(axis.y) < 0.9 ? 0 : 1;
  const uy = Math.abs(axis.y) < 0.9 ? 1 : 0;
  _w2.set(ux, uy, 0).cross(axis).normalize();
  _w3.copy(axis).cross(_w2);
  out
    .copy(axis)
    .multiplyScalar(c)
    .addScaledVector(_w2, Math.cos(a) * s)
    .addScaledVector(_w3, Math.sin(a) * s);
  return out;
}
const _w2 = new Vector3();
const _w3 = new Vector3();
void UP;

export function createVfx(ctx: GameContext): VfxExtended {
  return new Vfx(ctx);
}
