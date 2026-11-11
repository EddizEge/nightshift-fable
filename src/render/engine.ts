import {
  BackSide,
  Color,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  NoToneMapping,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import type { Texture, WebGLRenderTarget } from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import type { Effect } from 'postprocessing';
import { LAYERS } from '../core/types';
import type { IEngine, IEventBus, IParticleShared, PlayerState } from '../core/types';
import type { Quality } from '../core/quality';
import { clamp, damp } from '../core/math';
import { EnvProbe } from './envProbe';
import { PlanarReflection } from './reflection';
import { FilmEffect, GradeEffect, ScenePass, SpeedBlurEffect } from './postEffects';
import { GpuTimer } from './gpuTimer';

/** Anything that wants its planar-reflection hookup (the road). */
export interface ReflectionReceiver {
  uniforms: {
    tRefl: { value: Texture | null };
    uReflOn: { value: number };
    uNsResolution: { value: { x: number; y: number; set(x: number, y: number): unknown } };
  };
}

export interface FrameInfo {
  dt: number;
  rawDt: number;
  time: number;
  player: PlayerState | null;
  /** 0..1 extra blur/aberration (nitro, impacts). */
  speedFx: number;
  /** 0..1 global flash (explosion close by). */
  flash: number;
  damage: number;
}

const PARTICLE_GLSL = /* glsl */ `
#ifndef NS_PARTICLES
#define NS_PARTICLES
uniform sampler2D uSceneDepth;
uniform vec2 uResolution;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uSoftParticles;
float nsLinearDepth(float fragCoordZ) {
  return uCameraNear * uCameraFar / (uCameraFar - fragCoordZ * (uCameraFar - uCameraNear));
}
float nsSceneLinearDepth(vec2 screenUv) {
  return nsLinearDepth(texture2D(uSceneDepth, screenUv).r);
}
float nsSoftFade(float softness) {
  if (uSoftParticles < 0.5) return 1.0;
  vec2 suv = gl_FragCoord.xy / uResolution;
  float sceneZ = nsSceneLinearDepth(suv);
  float myZ = nsLinearDepth(gl_FragCoord.z);
  return clamp((sceneZ - myZ) / max(softness, 1e-3), 0.0, 1.0);
}
#endif
`;

/**
 * Renderer + frame graph:
 *   [env probe faces] → [planar road reflection] → main scene (MSAA, HDR half float)
 *   → particles (soft, depth-aware) → distortion effects (lens rain, shockwaves)
 *   → speed blur → bloom + grade + ACES tone mapping + vignette/grain → screen
 * Dynamic resolution scales the internal pixel ratio to hold the frame-time target.
 */
export class Engine implements IEngine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly particles: IParticleShared;
  readonly fog: FogExp2;
  composer!: EffectComposer;
  private scenePass: ScenePass | null = null;
  private distortionEffects: Effect[] = [];
  private distortionPasses: EffectPass[] = [];
  private speedPass!: EffectPass;
  private finalPass!: EffectPass;
  readonly speedBlur = new SpeedBlurEffect();
  readonly grade = new GradeEffect();
  /** Cool glow of the overcast sky: only matters where no street lamp reaches (see setNightAdaptation). */
  private skyFill = new HemisphereLight(0x8fa6c8, 0x07090c, 0);
  readonly film = new FilmEffect();
  bloom!: BloomEffect;
  private tone!: ToneMappingEffect;
  private reflection: PlanarReflection | null = null;
  private probe: EnvProbe | null = null;
  private staticEnv: Texture | null = null;
  private receivers: ReflectionReceiver[] = [];
  /** Hook to override the env map handed to materials (player car / traffic subscribe). */
  private envListeners: Array<(tex: Texture | null) => void> = [];
  width = 1;
  height = 1;
  /** Frame interval EMA (ms): what the player experiences (includes vsync). */
  frameMs = 16.7;
  /** Shortest frame interval seen recently = the display period (ms). */
  private displayMs = 16.7;
  private gpu!: GpuTimer;
  /** Profiling switches (tests): skip whole stages to measure what they cost. */
  readonly debug = { reflection: true, probe: true };
  private dynTimer = 0;
  private dynBase = 0; // value dynTimer restarted from at the last evaluation
  private dynCalm = 0;
  private dynOver = 0;
  /** Seconds spent over budget with the resolution already at its floor (auto quality). */
  overloadTime = 0;
  private lastResizeKey = '';
  stats = { calls: 0, triangles: 0, programs: 0, geometries: 0, textures: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    private quality: Quality,
    events: IEventBus,
  ) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.info.autoReset = false;
    this.gpu = new GpuTimer(r.getContext() as WebGL2RenderingContext);

    this.camera = new PerspectiveCamera(58, 16 / 9, 0.1, 2600);
    this.camera.layers.enableAll();
    this.camera.layers.disable(LAYERS.PARTICLES);

    this.fog = new FogExp2(0x05070a, 0.0036);
    this.scene.fog = this.fog;
    this.scene.add(this.skyFill);
    this.scene.background = new Color(0x020305);
    this.scene.matrixWorldAutoUpdate = true;

    this.particles = {
      uniforms: {
        uSceneDepth: { value: null },
        uResolution: { value: { x: 1, y: 1 } },
        uCameraNear: { value: this.camera.near },
        uCameraFar: { value: this.camera.far },
        uSoftParticles: { value: 0 },
      },
      glsl: PARTICLE_GLSL,
    };

    this.buildStaticEnvironment();
    this.buildPipeline();
    events.on('quality', () => this.buildPipeline());
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // ── environment ─────────────────────────────────────────────────────────

  /** Dim overcast night with city glow at the horizon: the IBL fallback (and LOW's only env). */
  private buildStaticEnvironment(): void {
    const envScene = new Scene();
    const mat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
varying vec3 vDir;
void main(){
  float y = vDir.y;
  vec3 zenith = vec3(0.010, 0.013, 0.020);
  vec3 horizon = vec3(0.070, 0.050, 0.038);
  vec3 ground = vec3(0.012, 0.011, 0.010);
  vec3 c = y > 0.0 ? mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.45)) : mix(horizon * 0.6, ground, clamp(-y * 3.0, 0.0, 1.0));
  // Sodium lamp rows along the road direction (±Z) give car paint long warm highlights.
  float band = exp(-pow(abs((y - 0.42) / 0.05), 2.0));
  float along = pow(abs(vDir.z), 6.0);
  c += vec3(1.0, 0.62, 0.3) * band * along * 2.2;
  // Soft overhead cloud glow.
  c += vec3(0.03, 0.028, 0.03) * smoothstep(0.6, 1.0, y);
  gl_FragColor = vec4(c, 1.0);
}`,
    });
    envScene.add(new Mesh(new SphereGeometry(10, 48, 24), mat));
    const pmrem = new PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(envScene, 0.02);
    this.staticEnv = rt.texture;
    pmrem.dispose();
    mat.dispose();
    this.scene.environment = this.staticEnv;
    this.scene.environmentIntensity = 1.0;
  }

  /** Current env map for reflective dynamic objects (probe if enabled, else static). */
  get envMap(): Texture | null {
    return this.probe ? this.probe.texture : this.staticEnv;
  }

  onEnvMap(fn: (tex: Texture | null) => void): void {
    this.envListeners.push(fn);
    fn(this.envMap);
  }

  addReflectionReceiver(r: ReflectionReceiver): void {
    this.receivers.push(r);
    this.syncReceivers();
  }

  private syncReceivers(): void {
    for (const r of this.receivers) {
      r.uniforms.tRefl.value = this.reflection ? this.reflection.texture : null;
      r.uniforms.uReflOn.value = this.reflection ? 1 : 0;
    }
  }

  addDistortionEffect(effect: unknown): void {
    this.distortionEffects.push(effect as Effect);
    this.buildPipeline();
  }

  // ── pipeline ────────────────────────────────────────────────────────────

  private buildPipeline(): void {
    const q = this.quality.settings;
    const r = this.renderer;
    r.shadowMap.enabled = q.shadowMapSize > 0;

    // Reflection / probe follow the preset.
    if (q.planarReflection) {
      if (!this.reflection) this.reflection = new PlanarReflection();
      this.reflection.scale = q.reflectionScale;
    } else if (this.reflection) {
      this.reflection.dispose();
      this.reflection = null;
    }
    const probeKey = `${q.envProbeSize}:${q.envProbeFacesPerFrame}`;
    if (q.envProbeSize > 0) {
      if (!this.probe || (this.probe as unknown as { key: string }).key !== probeKey) {
        this.probe?.dispose();
        this.probe = new EnvProbe(q.envProbeSize, Math.max(1, q.envProbeFacesPerFrame));
        (this.probe as unknown as { key: string }).key = probeKey;
        this.probe.onBefore = () => {
          for (const rc of this.receivers) rc.uniforms.uReflOn.value = 0;
        };
        this.probe.onAfter = () => this.syncReceivers();
        this.probe.position.set(0, 1.2, 0);
        this.probe.renderAll(r, this.scene);
      }
    } else if (this.probe) {
      this.probe.dispose();
      this.probe = null;
    }
    this.syncReceivers();
    for (const fn of this.envListeners) fn(this.envMap);

    // Composer. Only the scene pass is multisampled; the effect chain runs on single-sample buffers.
    if (this.composer) this.composer.dispose();
    this.scenePass?.dispose();
    this.composer = new EffectComposer(r, {
      frameBufferType: HalfFloatType,
      multisampling: 0,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.scenePass = new ScenePass(this.scene, this.camera, this.particles, q.msaa);
    this.composer.addPass(this.scenePass);

    this.distortionPasses = [];
    for (const e of this.distortionEffects) {
      const p = new EffectPass(this.camera, e);
      this.distortionPasses.push(p);
      this.composer.addPass(p);
    }
    if (q.motionBlur) {
      this.speedPass = new EffectPass(this.camera, this.speedBlur);
      this.composer.addPass(this.speedPass);
    }
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.9,
      luminanceSmoothing: 0.35,
      intensity: 0.85,
      radius: 0.72,
      levels: q.level === 'low' ? 5 : 7,
    });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.film.grain = q.filmGrain ? 0.035 : 0;
    const finals: Effect[] = [];
    if (q.bloom) finals.push(this.bloom);
    finals.push(this.grade, this.tone, this.film);
    this.finalPass = new EffectPass(this.camera, ...finals);
    this.composer.addPass(this.finalPass);
    this.lastResizeKey = '';
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const pr = this.quality.pixelRatio;
    const key = `${w}x${h}@${pr.toFixed(3)}`;
    if (key === this.lastResizeKey) return;
    this.lastResizeKey = key;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dw = Math.round(w * pr);
    const dh = Math.round(h * pr);
    this.reflection?.setSize(dw, dh);
    for (const rc of this.receivers) rc.uniforms.uNsResolution.value.set(dw, dh);
  }

  // ── frame ───────────────────────────────────────────────────────────────

  /** Smoothed GPU time per frame in ms (0 when the timer extension is unavailable). */
  get gpuMs(): number {
    return this.gpu.samples > 0 ? this.gpu.ms : 0;
  }

  /**
   * Dynamic resolution. With a GPU timer the scale follows the measured GPU time against the
   * frame budget (so vsync does not hide head-room); without one it reacts to dropped frames
   * and probes upwards now and then.
   */
  private updateDynamicResolution(rawDt: number): void {
    const q = this.quality.settings;
    const ms = rawDt * 1000;
    this.frameMs = damp(this.frameMs, ms, 3, rawDt);
    // Display period: follow the shortest interval, drift up slowly so it can re-learn.
    this.displayMs = Math.min(this.displayMs + rawDt * 0.25, Math.max(4, ms));
    if (!q.dynamicResolution) return;
    this.dynTimer += rawDt;
    if (this.dynTimer < 1.2) return;
    // Real time since the last evaluation (dynTimer restarts at 0.7, not 0, when the scale holds).
    const span = this.dynTimer - this.dynBase;
    const budget = Math.max(16.67, Math.min(this.displayMs, 34)); // never chase more than 60 fps
    const minScale = q.minRenderScale / q.renderScale;
    let s = this.quality.dynamicScale;
    if (this.gpu.samples > 30) {
      const load = this.gpu.ms / budget;
      // Only the fill-rate bound part of the frame scales with pixel count, so a drop helps less
      // than scale squared and a raise costs at most that. Drop only on sustained overload
      // (a chunk bake or a shader compile is a spike, not a trend); raise in small steps while
      // the worst-case load after the step still clears the drop threshold.
      if (load > 0.92) {
        this.dynOver += span;
        if (s <= minScale + 1e-3) this.overloadTime += span;
        if (this.dynOver > 1.6) s = Math.max(minScale, s * Math.max(0.9, Math.sqrt(0.82 / load)));
      } else {
        this.dynOver = 0;
        this.overloadTime = 0;
        if (load < 0.74 && s < 1) s = Math.min(1, s * 1.06);
      }
    } else {
      if (this.frameMs > budget * 1.22) {
        if (s <= minScale + 1e-3) this.overloadTime += span;
        s = Math.max(minScale, s - 0.07);
        this.dynCalm = 0;
      } else if (this.frameMs < budget * 1.06) {
        this.overloadTime = 0;
        this.dynCalm += span;
        if (this.dynCalm > 8 && s < 1) {
          s = Math.min(1, s + 0.04);
          this.dynCalm = 4;
        }
      }
    }
    if (Math.abs(s - this.quality.dynamicScale) > 4e-3) {
      this.quality.dynamicScale = s;
      this.dynTimer = this.dynBase = 0;
      this.resize();
    } else this.dynTimer = this.dynBase = 0.7;
  }

  render(f: FrameInfo): void {
    const r = this.renderer;
    r.info.reset();
    this.updateDynamicResolution(f.rawDt);
    this.resize();
    this.gpu.begin();
    this.particles.uniforms.uCameraNear.value = this.camera.near;
    this.particles.uniforms.uCameraFar.value = this.camera.far;

    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    if (this.probe && f.player && this.debug.probe) {
      this.probe.position.set(f.player.position.x, 1.1, f.player.position.z);
      this.probe.update(r, this.scene);
    }
    if (this.reflection && !this.debug.reflection) {
      for (const rc of this.receivers) rc.uniforms.uReflOn.value = 0;
    } else if (this.reflection) {
      for (const rc of this.receivers) rc.uniforms.uReflOn.value = 0;
      this.particles.uniforms.uSoftParticles.value = 0;
      this.reflection.render(r, this.scene, this.camera);
      this.syncReceivers();
    }

    // Speed effects.
    const kmh = f.player ? Math.abs(f.player.speedKmh) : 0;
    const speedAmt = clamp((kmh - 185) / 165, 0, 1);
    this.speedBlur.strength = damp(this.speedBlur.strength, Math.min(1, speedAmt * 0.4 + f.speedFx * 0.6), 6, f.rawDt);
    this.grade.flash = f.flash;
    this.film.damage = clamp(f.damage, 0, 1) * 0.5;

    this.composer.render(f.dt);
    this.gpu.end();
    const info = r.info;
    this.stats.calls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
  }

  /**
   * Unlit stretches: the eye adapts. `a` = 0 under street lamps, 1 on a dark road: exposure goes
   * up, and the sky glow (hemisphere fill + environment reflections) becomes the light that
   * models the road, the barriers and the cars instead of leaving them black.
   */
  setNightAdaptation(a: number): void {
    this.grade.exposure = 1 + 0.7 * a;
    this.skyFill.intensity = 0.6 * a;
    this.scene.environmentIntensity = 1 + 1.1 * a;
  }

  /** Read back the last frame (tests). */
  get inputBuffer(): WebGLRenderTarget {
    return this.composer.inputBuffer;
  }
}
