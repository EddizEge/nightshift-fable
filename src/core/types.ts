/**
 * NIGHTSHIFT — shared contracts.
 *
 * Every system talks to the others ONLY through the interfaces in this file (plus the
 * concrete helpers in src/core and src/world/roadProfile.ts). Keep this file dependency-light.
 *
 * Conventions
 *  - Units: metres, seconds, radians, kilograms. Y is up. The road surface is the plane y = 0.
 *  - Heading `h`: forward = (sin h, 0, -cos h), right = (cos h, 0, sin h). h = 0 looks down -Z.
 *    For an Object3D whose model faces -Z: object.rotation.y = -h.
 *  - Road space: `s` = arc length along the carriageway centre line (m, grows in the driving
 *    direction), `d` = lateral offset from the centre of OUR carriageway (m, + = right).
 *  - Colours are linear-sRGB scene-referred radiance. Exposure reference: lit asphalt ≈ 0.05–0.4,
 *    white paint under a lamp ≈ 0.8, emissive light sources 4–60 (they bloom above ≈ 1.2).
 */
import type {
  Color,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
  Material,
  IUniform,
  BufferGeometry,
  InstancedMesh,
  Mesh,
} from 'three';

// ───────────────────────────────────────────────────────────────── Quality

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  /** Internal resolution scale (multiplies the pixel ratio). Dynamic resolution moves this. */
  renderScale: number;
  /** Lowest scale dynamic resolution may reach. */
  minRenderScale: number;
  dynamicResolution: boolean;
  msaa: 0 | 2 | 4;
  /** Planar reflection of the wet road (second scene render). */
  planarReflection: boolean;
  /** Reflection buffer scale relative to the internal resolution. */
  reflectionScale: number;
  /** Dynamic environment probe: cube face size (0 = static environment only). */
  envProbeSize: number;
  /** Cube faces refreshed per frame (1–6). */
  envProbeFacesPerFrame: number;
  bloom: boolean;
  /** Speed / nitro radial blur. */
  motionBlur: boolean;
  lensRain: boolean;
  /** Headlight shadow map size (0 = off). */
  shadowMapSize: number;
  /** Rain streak instance count. */
  rainCount: number;
  /** Scales every particle emitter budget (spray, smoke, sparks, debris). */
  particleScale: number;
  /** Max simultaneous traffic vehicles on our carriageway. */
  trafficMax: number;
  /** Max decorative oncoming vehicles. */
  oncomingMax: number;
  /** World chunks kept ahead of the player. */
  chunksAhead: number;
  anisotropy: number;
  /** Volumetric light cones / halos. */
  volumetrics: boolean;
  filmGrain: boolean;
}

export interface IQuality {
  readonly settings: QualitySettings;
  readonly level: QualityLevel;
  set(level: QualityLevel): void;
  /** Effective pixel ratio currently in use (after dynamic resolution). */
  readonly pixelRatio: number;
}

// ───────────────────────────────────────────────────────────────── Events

export type GameState = 'boot' | 'menu' | 'intro' | 'playing' | 'paused' | 'crashed' | 'gameover';
export type CameraMode = 'chase' | 'hood' | 'orbit' | 'crash' | 'cinematic';
export type CollisionKind = 'traffic' | 'barrier' | 'wreck' | 'debris';
export type CinematicId = 'chainReaction' | 'lastSecondEscape';

export interface RunSummary {
  score: number;
  distance: number; // metres
  topSpeedKmh: number;
  nearMisses: number;
  survivalTime: number; // seconds
  riskBonus: number;
  bestCombo: number;
  bestScore: number;
  isNewBest: boolean;
  cause: string; // short English label, e.g. "REAR-ENDED A TRUCK"
}

export interface HudState {
  speedKmh: number;
  gear: number; // -1 R, 0 N, 1..n
  rpm01: number;
  nitro01: number;
  nitroActive: boolean;
  distance: number;
  score: number;
  combo: number; // multiplier, 1 = none
  comboTimer01: number; // 1 → 0 until the combo expires
  damage01: number; // 0 pristine → 1 destroyed
  survivalTime: number;
}

export interface GameEvents {
  /** Game state machine transition. */
  state: { from: GameState; to: GameState };
  runStart: { seed: number };
  runEnd: RunSummary;
  nearMiss: { vehicleId: number; gap: number; speedKmh: number; points: number; side: -1 | 1; combo: number };
  /** Score popup-worthy bonus (events, risk, etc.). */
  bonus: { label: string; points: number };
  collision: {
    kind: CollisionKind;
    position: Vector3;
    normal: Vector3;
    /** Closing speed along the contact normal, m/s. */
    relSpeed: number;
    /** 0..1 perceptual strength for shake / audio. */
    intensity: number;
    fatal: boolean;
    /** True when the player's own car is one side of the contact. */
    player?: boolean;
  };
  explosion: { position: Vector3; scale: number };
  nitro: { active: boolean };
  cinematic: { id: CinematicId; phase: 'warn' | 'start' | 'climax' | 'end'; position?: Vector3 };
  cameraMode: { mode: CameraMode };
  quality: { settings: QualitySettings };
  /** Fired by the UI. */
  uiPlay: {};
  uiResume: {};
  uiRestart: {};
  uiQuitToMenu: {};
  uiPauseToggle: {};
  uiSetQuality: { level: QualityLevel };
  uiSetVolume: { master: number };
  uiSetMuted: { muted: boolean };
  /** Lightning strike far away (sky flashes, thunder follows). */
  lightning: { intensity: number };
}

export interface IEventBus {
  on<K extends keyof GameEvents>(type: K, fn: (e: GameEvents[K]) => void): () => void;
  off<K extends keyof GameEvents>(type: K, fn: (e: GameEvents[K]) => void): void;
  emit<K extends keyof GameEvents>(type: K, e: GameEvents[K]): void;
}

// ───────────────────────────────────────────────────────────────── Input

export interface DriveControls {
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverse when stopped)
  steer: number; // -1 (left) .. +1 (right), raw target
  handbrake: boolean;
  nitro: boolean;
}

export interface IInput {
  readonly controls: DriveControls;
  /** True for exactly one frame after the key went down. */
  pressed(action: 'camera' | 'pause' | 'restart' | 'confirm'): boolean;
  /** Test/autopilot override; pass null to release. */
  setOverride(c: Partial<DriveControls> | null): void;
  update(): void;
}

// ───────────────────────────────────────────────────────────────── Road & world

export interface RoadFrame {
  s: number;
  x: number;
  z: number;
  /** Heading (see conventions). */
  h: number;
  /** Signed curvature 1/m (+ = bends right). */
  k: number;
  /** Unit tangent (forward). */
  tx: number;
  tz: number;
  /** Unit right vector. */
  rx: number;
  rz: number;
}

export interface IRoadPath {
  frameAt(s: number, out?: RoadFrame): RoadFrame;
  /** Road space → world. */
  toWorld(s: number, d: number, y: number, out: Vector3): Vector3;
  headingAt(s: number): number;
  curvatureAt(s: number): number;
  /** World → road space. `hintS` should be a nearby s (e.g. last frame's). */
  project(x: number, z: number, hintS: number, out?: { s: number; d: number }): { s: number; d: number };
  /** Make sure the path is generated up to sMax. */
  ensure(sMax: number): void;
  reset(seed: number): void;
}

export type ZoneType = 'city' | 'industrial' | 'bridge' | 'tunnel' | 'rural';

export interface LampSlot {
  /** Arc length of the lamp head. */
  s: number;
  /** Lateral position of the luminaire (light source). */
  d: number;
  /** Lateral position of the pole base. */
  poleD: number;
  /** Luminaire height. */
  h: number;
  side: 'median' | 'right';
  /** false = this slot has no lamp (tunnel, rural dark stretch, broken lamp). */
  on: boolean;
}

export interface ChunkSpec {
  index: number;
  s0: number;
  s1: number;
  zone: ZoneType;
  prevZone: ZoneType;
  nextZone: ZoneType;
  /** Deterministic per-chunk seed. */
  seed: number;
  /** Street lamp slots inside this chunk (already decided; build the poles for those with on=true). */
  lamps: LampSlot[];
  /** Arc length of an overpass crossing above the road in this chunk, or null. */
  overpassS: number | null;
  /** Arc length of an overhead sign gantry in this chunk, or null. */
  gantryS: number | null;
  /** 0-based index of this chunk inside its zone run and the length of that run. */
  zoneIndex: number;
  zoneLength: number;
}

/**
 * Helper handed to feature builders. Geometry is authored in *straight road space*:
 *   x = d (lateral, + right), y = up, z = -(s - s0)  (i.e. forward is -Z, like the world at h = 0)
 * and the helper bends it along the real road, bakes street-lamp lighting into it and adds it
 * to the chunk. Long pieces must be tessellated along z (≤ 5 m per segment) so they bend smoothly.
 */
export interface IChunkBuilder {
  readonly spec: ChunkSpec;
  readonly road: IRoadPath;
  readonly quality: QualitySettings;
  /** Deterministic RNG for this chunk: returns [0,1). */
  rand(): number;
  /** Chunk root (world space, identity transform). Prefer the add* helpers. */
  readonly group: Object3D;
  /**
   * Bend a straight-road-space geometry into world space (in place), bake lamp light and add it.
   * `material` should come from `materials` (or be patched with lighting.patchStatic).
   */
  addBent(geometry: BufferGeometry, material: Material | Material[], opts?: AddOpts): Mesh;
  /**
   * Instanced props. Each placement is in road space; yaw is relative to the road heading
   * (0 = model -Z faces forward). Baked lamp light is stored per instance.
   */
  addInstances(geometry: BufferGeometry, material: Material, placements: Placement[], opts?: AddOpts): InstancedMesh;
  /** Add a ready-made world-space object (you handle transforms yourself). */
  addObject(object: Object3D): void;
  /** Register a callback run every frame while the chunk is alive (blinking lights etc.). */
  onUpdate(fn: (time: number, dt: number) => void): void;
  /** Register extra disposal work (textures you created, etc.). Geometries/materials added through the helpers are disposed automatically unless marked shared. */
  onDispose(fn: () => void): void;
  /** Shared static-world material library. */
  readonly materials: IWorldMaterials;
}

export interface AddOpts {
  /** Bake street-lamp irradiance (default true). */
  bake?: boolean;
  /** Geometry is shared/cached between chunks: do not dispose it with the chunk (default false). Only valid for addInstances. */
  sharedGeometry?: boolean;
  /** Exclude from the planar road reflection (default false). */
  noReflect?: boolean;
  /** Exclude from the dynamic environment probe (default false). */
  noProbe?: boolean;
  castShadow?: boolean;
  name?: string;
}

export interface Placement {
  s: number;
  d: number;
  y?: number;
  /** Yaw relative to road heading, radians. */
  yaw?: number;
  scale?: number | [number, number, number];
}

export interface StaticMaterialOpts {
  name?: string;
  color?: number | string | Color;
  map?: Texture | null;
  normalMap?: Texture | null;
  roughnessMap?: Texture | null;
  roughness?: number;
  metalness?: number;
  emissive?: number | string | Color;
  emissiveIntensity?: number;
  emissiveMap?: Texture | null;
  /** 0..1: how much rain wets this surface (darkens albedo, lowers roughness on up-facing areas). Default 1. */
  wetness?: number;
  transparent?: boolean;
  opacity?: number;
  side?: 'front' | 'double' | 'back';
  /** Retro-reflective paint/sheeting: bounces headlight back toward the camera (signs, lane paint, delineators). 0..1 */
  retroReflect?: number;
  /** Do not apply scene fog (rarely needed). */
  noFog?: boolean;
  vertexColors?: boolean;
  alphaTest?: number;
}

export interface IWorldMaterials {
  /** Create (uncached) a lit static-world material that receives baked lamp light, headlights, fog and rain wetness. */
  standard(opts: StaticMaterialOpts): Material;
  /** Cached variant keyed by `key`; the factory runs once. Cached materials are never disposed with chunks. */
  cached(key: string, factory: () => Material): Material;
  /** Pure emissive (unlit) HDR material for light sources / lit windows. `intensity` multiplies colour. */
  emissive(color: number | string | Color, intensity: number, opts?: { map?: Texture | null; transparent?: boolean; fogScale?: number; side?: 'front' | 'double' }): Material;
  /** Load (cached) a texture from /assets/textures. sRGB when `srgb`, repeat-wrapped, anisotropic. */
  texture(file: string, opts?: { srgb?: boolean; repeat?: [number, number] }): Texture;
  /** Patch any built-in lit material so that it receives the baked `bakedLight` attribute + wetness. */
  patchStatic<T extends Material>(m: T, opts?: { wetness?: number; retroReflect?: number }): T;
}

export interface IWorld {
  update(playerS: number, dt: number, time: number): void;
  reset(seed: number): void;
  chunkAt(s: number): ChunkSpec;
  zoneAt(s: number): ZoneType;
  /** 0 outside, 1 fully inside a tunnel (smooth across portals). */
  tunnelAt(s: number): number;
  /** Next overpass at or after s (within the planned horizon), else null. */
  nextOverpass(s: number): number | null;
  /** Rain reaching the ground at s (0 in tunnels / under wide decks). */
  rainAt(s: number): number;
}

/** Geometry constants of an overpass deck (see world/roadProfile.ts for the numbers). */
export interface OverpassInfo {
  s: number;
  /** Clearance under the deck. */
  clearance: number;
  /** Deck top surface height (where vehicles drive on the overpass). */
  deckY: number;
  /** Deck width along our road's s axis. */
  width: number;
}

// ───────────────────────────────────────────────────────────────── Lighting

export const MAX_DYNAMIC_LAMPS = 12;

/**
 * Night lighting model:
 *  - scene.environment (dim IBL) + FogExp2
 *  - street lamps: analytic, never three.js lights.
 *      · road surface: per-pixel periodic lamp field (road shader)
 *      · static world: baked into the `bakedLight` vertex / instance attribute at build time
 *      · dynamic objects (cars, wrecks, debris): the K nearest lamps via `patchDynamic`
 *      · particles / rain: `glslLampField` + `uniforms`
 *  - player headlights: one real three.js SpotLight (affects every built-in material)
 */
export interface ILighting {
  /** Shared uniforms (same objects every frame — reference them from ShaderMaterials). */
  readonly uniforms: {
    /** World positions of the nearest lamps (length MAX_DYNAMIC_LAMPS). */
    uLampPos: IUniform<Vector3[]>;
    /** Linear RGB radiant intensity (0 for unused slots). Irradiance ≈ color * cos / dist². */
    uLampColor: IUniform<Color[]>;
    /** Player headlight source position / direction (world) and intensity colour. */
    uHeadPos: IUniform<Vector3>;
    uHeadDir: IUniform<Vector3>;
    uHeadColor: IUniform<Color>;
    /** x = cos(inner half angle), y = cos(outer half angle), z = range (m). */
    uHeadCone: IUniform<Vector3>;
    /** Ambient radiance estimate (sky + city glow) for unlit particles. */
    uAmbient: IUniform<Color>;
    uFogColor: IUniform<Color>;
    uFogDensity: IUniform<number>;
    /** Seconds since start (wraps hourly). */
    uTime: IUniform<number>;
    /** Extra transient light (explosion flash): xyz = world pos, colour = intensity. Up to 2. */
    uFlashPos: IUniform<Vector3[]>;
    uFlashColor: IUniform<Color[]>;
  };
  /**
   * GLSL (fragment or vertex) declaring the uniforms above and:
   *   vec3 nsLampLight(vec3 worldPos)                 — isotropic irradiance from lamps + flashes (no normal)
   *   vec3 nsLampLightN(vec3 worldPos, vec3 normal)   — Lambert irradiance
   *   vec3 nsHeadlight(vec3 worldPos)                 — headlight cone irradiance (no normal)
   *   vec3 nsApplyFog(vec3 color, float viewDist)     — exp² fog
   * Use for particles, rain and other custom ShaderMaterials.
   */
  readonly glslLampField: string;
  /** Patch a built-in lit material (Standard/Physical/Lambert) used on a MOVING object so the nearest lamps and flashes light it. */
  patchDynamic<T extends Material>(m: T): T;
  /** Add a transient point flash (explosions). Decays over `duration` seconds. */
  flash(position: Vector3, color: Color | number, intensity: number, duration: number): void;
  /** CPU evaluation of lamp irradiance at a road-space point (used for baking and for gameplay). */
  irradianceAt(s: number, d: number, y: number, nx: number, ny: number, nz: number, out: Color): Color;
  update(dt: number, time: number): void;
}

// ───────────────────────────────────────────────────────────────── Engine / rendering

export const LAYERS = {
  /** Everything normal. */
  DEFAULT: 0,
  /** Rendered by the main camera only: not in the road reflection, not in the env probe (rain, lens-space things, the road itself). */
  MAIN_ONLY: 1,
  /** Soft particles: rendered in a dedicated pass after the opaque scene, with scene depth available. */
  PARTICLES: 2,
  /** The player car: in the main view and road reflection, excluded from its own env probe. */
  PLAYER: 3,
  /** Visible in main view + reflection but NOT in the env probe (small props, clutter). */
  NO_PROBE: 4,
  /** The road surface: main view + env probe, never in its own planar reflection. */
  ROAD: 5,
} as const;

export interface IParticleShared {
  /**
   * Uniforms every particle ShaderMaterial should reference (by object identity):
   *   uSceneDepth (sampler2D), uResolution (vec2, px), uCameraNear, uCameraFar (float),
   *   uSoftParticles (float 0/1; 0 while rendering reflections)
   */
  readonly uniforms: {
    uSceneDepth: IUniform<Texture | null>;
    uResolution: IUniform<{ x: number; y: number }>;
    uCameraNear: IUniform<number>;
    uCameraFar: IUniform<number>;
    uSoftParticles: IUniform<number>;
  };
  /**
   * GLSL fragment helpers (declares the uniforms above):
   *   float nsLinearDepth(float fragCoordZ)       — view-space distance of this fragment
   *   float nsSceneLinearDepth(vec2 screenUv)     — view-space distance of the opaque scene
   *   float nsSoftFade(float softness)            — 0..1 fade near intersections, and 0 when occluded
   * Particle materials: transparent:true, depthWrite:false, depthTest:true (the particle pass draws
   * into the main HDR buffer whose depth buffer is intact; uSceneDepth is a separate copy, so
   * sampling it is safe). Multiply alpha (or additive colour) by nsSoftFade(softness).
   * Objects on LAYERS.PARTICLES are also drawn in the wet-road reflection (with uSoftParticles = 0).
   */
  readonly glsl: string;
}

export interface IEngine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly particles: IParticleShared;
  /** Add a postprocessing `Effect` (from the 'postprocessing' package) to the distortion stage (before bloom). */
  addDistortionEffect(effect: unknown): void;
  /** Dynamic environment cube texture (PMREM-filtered by three when assigned to material.envMap), or null on LOW. */
  readonly envMap: Texture | null;
  readonly width: number;
  readonly height: number;
}

// ───────────────────────────────────────────────────────────────── Player vehicle

export interface VehicleDims {
  length: number;
  width: number;
  height: number;
  wheelBase: number;
  trackFront: number;
  trackRear: number;
  wheelRadius: number;
  /** Distance from the car origin (centre of the wheelbase on the ground) to the front axle (+forward). */
  frontAxle: number;
  /** ... and to the rear axle (positive number, behind). */
  rearAxle: number;
  /** Body ahead of the front axle and behind the rear axle (absent on stand-in cars). */
  frontOverhang?: number;
  rearOverhang?: number;
  cgHeight: number;
  mass: number;
}

/** Wheel order everywhere: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right. */
export interface PlayerState {
  /** Car origin: centre of the wheelbase projected on the ground (world). */
  position: Vector3;
  quaternion: Quaternion;
  /** World velocity m/s. */
  velocity: Vector3;
  /** Yaw heading (see conventions). */
  heading: number;
  yawRate: number;
  /** Signed forward speed m/s. */
  speed: number;
  speedKmh: number;
  /** Sideways speed in car space m/s (+ = sliding right). */
  lateralSpeed: number;
  s: number;
  d: number;
  /** Heading relative to the road tangent (rad). */
  relHeading: number;
  /** Applied inputs. */
  throttle: number;
  brake: number;
  /** Front wheel steering angle (rad, + = right). */
  steerAngle: number;
  handbrake: boolean;
  rpm: number;
  /** rpm / redline, 0..1. */
  rpm01: number;
  gear: number;
  nitro01: number;
  nitroActive: boolean;
  /** Longitudinal / lateral acceleration in g (car space), smoothed for camera / audio. */
  accelLong: number;
  accelLat: number;
  /** Per-wheel slide intensity 0..1 (skid / spray boost / tyre noise). */
  wheelSkid: [number, number, number, number];
  /** Per-wheel spin angle (rad) and suspension compression (m, + = compressed). */
  wheelSpin: [number, number, number, number];
  suspension: [number, number, number, number];
  /** Visual body attitude (rad): + pitch = nose up, + roll = leans right. */
  bodyPitch: number;
  bodyRoll: number;
  /** World-space wheel contact points. */
  wheelContacts: [Vector3, Vector3, Vector3, Vector3];
  /** 0 pristine → 1 destroyed. */
  damage: number;
  /** false once wrecked (physics handed to the crash world). */
  alive: boolean;
  /** True while a dynamics → wreck handoff is active (car tumbling). */
  wrecked: boolean;
  dims: VehicleDims;
}

export interface IPlayerCarVisual {
  /** Root object. Origin: centre of wheelbase on the ground; model faces -Z. Put on LAYERS.PLAYER. */
  readonly root: Object3D;
  readonly dims: VehicleDims;
  /** Wheel hub positions in car space (FL, FR, RL, RR). */
  readonly wheelLocal: readonly Vector3[];
  /** Attach points (children of root or of the body group). */
  readonly anchors: {
    headlightL: Object3D;
    headlightR: Object3D;
    taillightL: Object3D;
    taillightR: Object3D;
    exhaustL: Object3D;
    exhaustR: Object3D;
    /** Driver eye point for a cockpit/hood camera. */
    hoodCam: Object3D;
  };
  /** Per-frame visual update from the simulation state. */
  update(dt: number, state: PlayerState): void;
  setLights(o: { headlights?: boolean; brake?: number; reverse?: boolean }): void;
  /** Assign the dynamic environment map to the body/glass materials. */
  setEnvMap(tex: Texture | null, intensity: number): void;
  /** 0..1 cosmetic damage (dirt/scratches/darkening, loose parts). */
  setDamage(d: number): void;
  setVisible(v: boolean): void;
}

// ───────────────────────────────────────────────────────────────── Traffic

export type TrafficType = 'sedan' | 'hatch' | 'suv' | 'van' | 'boxtruck' | 'semi' | 'tanker' | 'sports';

export interface TrafficVehicleDef {
  type: TrafficType;
  length: number;
  width: number;
  height: number;
  mass: number;
  /** Typical cruise speed range (m/s). */
  speedMin: number;
  speedMax: number;
  /** Tail light height / half-spacing, for light pools & flares. */
  tailY: number;
  tailX: number;
  headY: number;
  headX: number;
}

export interface ITrafficVisual {
  /** Origin: centre of the footprint on the ground; model faces -Z. */
  readonly object: Object3D;
  readonly def: TrafficVehicleDef;
  /** brake 0..1, indicator -1 left / 0 / +1 right, time in s (for blinking), hazard = both blink. */
  setLights(brake: number, indicator: -1 | 0 | 1, time: number, hazard?: boolean): void;
  /** Called when returned to the pool. */
  reset(): void;
  /** Burnt-out look for wrecks (0..1). */
  setCharred(amount: number): void;
}

export interface ITrafficVehicleFactory {
  load(): Promise<void>;
  readonly defs: Readonly<Record<TrafficType, TrafficVehicleDef>>;
  /** Pooled creation. `seed` picks paint colour / variant deterministically. */
  acquire(type: TrafficType, seed: number): ITrafficVisual;
  release(v: ITrafficVisual): void;
}

export interface TrafficVehicle {
  id: number;
  type: TrafficType;
  def: TrafficVehicleDef;
  visual: ITrafficVisual;
  /** Road space (centre of the vehicle). */
  s: number;
  d: number;
  /** Forward speed m/s. */
  speed: number;
  lane: number;
  targetLane: number;
  /** Yaw relative to the road tangent (rad). */
  relYaw: number;
  /** World pose (authoritative for collisions). */
  position: Vector3;
  /** World heading (see conventions). */
  heading: number;
  halfLength: number;
  halfWidth: number;
  /** 'drive' = AI, 'scripted' = an event owns it (AI skips it), 'wreck' = crash physics owns it. */
  mode: 'drive' | 'scripted' | 'wreck';
  braking: number;
  indicator: -1 | 0 | 1;
  /** Near miss already awarded for this pass. */
  nearMissDone: boolean;
  /** Free slot for the owner of scripted/wreck vehicles. */
  userData: Record<string, unknown>;
}

export interface ITrafficSystem {
  readonly vehicles: readonly TrafficVehicle[];
  /** Fixed-step simulation. */
  step(dt: number): void;
  /** Per-frame visual sync (pose → Object3D, lights). */
  syncVisuals(dt: number, time: number): void;
  reset(): void;
  /** Vehicles per km per lane (difficulty). */
  setDensity(perKmPerLane: number): void;
  /** 0..1 how erratic drivers are (lane changes, speed variance). */
  setAggression(a: number): void;
  /** Scripted spawn (events). Returns null if the spot is blocked. */
  spawn(type: TrafficType, s: number, lane: number, speed: number, mode?: 'drive' | 'scripted'): TrafficVehicle | null;
  remove(v: TrafficVehicle): void;
  /** Do not ambient-spawn inside [s0, s1] until cleared (events). Returns a release function. */
  reserve(s0: number, s1: number): () => void;
  /** Traffic approaching arc length `s` slows to a crawl (the crash site once the run is over); null clears it. */
  setCaution?(s: number | null): void;
  /** Desired cruise speed of one vehicle from now on (m/s); it gets there at its own pace. */
  setCruise?(v: TrafficVehicle, speed: number): void;
  /** Hand a vehicle to the crash world (it becomes mode 'wreck'). */
  wreck(v: TrafficVehicle, linVel: Vector3, angVel: Vector3): void;
}

// ───────────────────────────────────────────────────────────────── Crash physics

export interface WreckBody {
  id: number;
  object: Object3D;
  halfExtents: Vector3;
  position: Vector3;
  quaternion: Quaternion;
  linvel: Vector3;
  mass: number;
  /** true while it is still moving noticeably. */
  awake: boolean;
  /** Arbitrary owner (TrafficVehicle, 'player', debris). */
  owner: unknown;
  burning: boolean;
}

export interface ICrashWorld {
  readonly bodies: readonly WreckBody[];
  ready: boolean;
  addBox(object: Object3D, halfExtents: Vector3, mass: number, position: Vector3, quaternion: Quaternion, linVel: Vector3, angVel: Vector3, owner?: unknown, yOffset?: number): WreckBody;
  remove(b: WreckBody): void;
  /** Instant impulse (N·s) on a body, optionally at a world point (adds spin). Wakes it up. */
  applyImpulse(b: WreckBody, impulse: Vector3, point?: Vector3): void;
  /** Radial blast: pushes and spins every body inside `radius` (strength ≈ Δv in m/s at the centre). */
  applyBlast(center: Vector3, strength: number, radius: number): void;
  step(dt: number, playerS: number): void;
  reset(): void;
}

// ───────────────────────────────────────────────────────────────── VFX / weather

export interface ExplosionOpts {
  /** 1 = car fuel explosion (~7 m fireball), 2.5 = tanker. */
  scale?: number;
  /** Inherited drift of the fire/smoke (world m/s). */
  velocity?: Vector3;
  /** Lingering smoke column duration (s). */
  smoke?: number;
  /** Throw physical-looking debris. */
  debris?: boolean;
}

export interface FireHandle {
  /** Stop emitting (existing particles finish). */
  stop(): void;
  /** 0..1 */
  setIntensity(i: number): void;
}

export interface IVfx {
  update(dt: number, time: number): void;
  explosion(position: Vector3, opts?: ExplosionOpts): void;
  /** Continuous fire + smoke following `target.position` (burning wreck). */
  attachFire(target: { position: Vector3 }, scale: number, duration: number): FireHandle;
  /** One-shot spark burst (metal impact). `direction` is the main spray direction. */
  sparks(position: Vector3, direction: Vector3, count: number, speed: number): void;
  /** Small debris / glass shards burst. */
  debris(position: Vector3, velocity: Vector3, count: number): void;
  /** Dark smoke puff (crash). */
  smokePuff(position: Vector3, velocity: Vector3, scale: number): void;
  /** Nitro exhaust flames on/off (anchors come from the player car visual). */
  setNitro(active: boolean, intensity: number): void;
  reset(): void;
  /** Optional `postprocessing` Effects (heat haze / shockwave distortion) to add to the distortion stage. */
  readonly distortionEffects: unknown[];
}

export interface IWeather {
  update(dt: number, time: number): void;
  /** 0..1 overall rain strength. */
  setIntensity(i: number): void;
  /** Big splash (something heavy lands / drives through a puddle). */
  splash(position: Vector3, scale: number): void;
  reset(): void;
  readonly distortionEffects: unknown[];
}

// ───────────────────────────────────────────────────────────────── Audio

export type SfxName =
  | 'uiHover'
  | 'uiClick'
  | 'uiStart'
  | 'uiBack'
  | 'nearMiss'
  | 'bonus'
  | 'warning'
  | 'crashLight'
  | 'crashHeavy'
  | 'scrape'
  | 'glass'
  | 'explosion'
  | 'explosionBig'
  | 'thunder'
  | 'nitroStart'
  | 'nitroEnd'
  | 'horn'
  | 'passBy'
  | 'splash'
  | 'gameOver'
  | 'newBest';

export interface AudioFrame {
  state: GameState;
  rpm01: number;
  throttle: number;
  speedKmh: number;
  /** 0..1 tyre slide. */
  skid: number;
  brake: number;
  nitroActive: boolean;
  /** 0..1 */
  rain: number;
  /** 0..1 inside tunnel (reverb, rain muffled). */
  tunnel: number;
  /** 0..1 metal scraping right now. */
  scrape: number;
  /** Time scale (slow motion lowers pitch). */
  timeScale: number;
  /** Gear changed this frame. */
  shifted: boolean;
}

export interface SfxOpts {
  volume?: number;
  /** Playback-rate multiplier. */
  pitch?: number;
  /** -1..1 stereo position. */
  pan?: number;
  /** World position (overrides pan; distance attenuates). */
  position?: Vector3;
  /** Delay in seconds. */
  delay?: number;
}

export interface IAudio {
  /** Must be called from a user gesture; safe to call repeatedly. */
  unlock(): Promise<void>;
  readonly unlocked: boolean;
  update(dt: number, frame: AudioFrame): void;
  play(name: SfxName, opts?: SfxOpts): void;
  setMasterVolume(v: number): void;
  setMuted(m: boolean): void;
  /** Listener pose for positional sfx. */
  setListener(position: Vector3, forward: Vector3): void;
}

// ───────────────────────────────────────────────────────────────── UI

export interface IUi {
  /** Loading progress 0..1 with a short label. */
  setLoading(progress: number, label?: string): void;
  /** Called on every game state transition. */
  setState(state: GameState): void;
  updateHud(h: HudState): void;
  /** "+250 NEAR MISS x3" style popup. */
  popup(text: string, kind: 'nearMiss' | 'bonus' | 'warning' | 'info'): void;
  /** Large cinematic banner, e.g. "PILE-UP AHEAD". Pass null to hide. */
  banner(text: string | null, kind?: 'warning' | 'info'): void;
  showGameOver(summary: RunSummary): void;
  /** Reflect current settings in the settings panel. */
  setSettings(s: { quality: QualityLevel; volume: number; muted: boolean; cameraMode: CameraMode }): void;
  /** Debug/perf line (bottom-left, hidden unless enabled with ?debug). */
  setDebug(text: string): void;
}

// ───────────────────────────────────────────────────────────────── Camera rig

export interface ICameraRig {
  mode: CameraMode;
  /** Cycle player-selectable modes (chase → hood → chase). */
  nextMode(): CameraMode;
  setMode(m: CameraMode): void;
  /** Trauma-based shake, 0..1 added (decays). */
  addShake(trauma: number): void;
  /** Orbit parameters for menu / crash cameras. */
  setOrbit(o: { radius?: number; height?: number; speed?: number; angle?: number; fov?: number; targetHeight?: number }): void;
  /** Snap (no smoothing) on the next update — use after teleports/restarts. */
  snap(): void;
  update(dt: number, player: PlayerState, time: number): void;
}

// ───────────────────────────────────────────────────────────────── Context

export interface GameContext {
  engine: IEngine;
  events: IEventBus;
  input: IInput;
  quality: IQuality;
  road: IRoadPath;
  world: IWorld;
  lighting: ILighting;
  player: PlayerState;
  /** Present once the corresponding system has been created (creation order: see main.ts). */
  traffic?: ITrafficSystem;
  crash?: ICrashWorld;
  vfx?: IVfx;
  weather?: IWeather;
  audio?: IAudio;
  ui?: IUi;
  cameraRig?: ICameraRig;
  playerVisual?: IPlayerCarVisual;
  /** Simulation clock. */
  time: {
    /** Seconds of simulated (scaled) time since boot. */
    now: number;
    /** Unscaled real seconds since boot. */
    real: number;
    /** Scaled frame delta. */
    dt: number;
    /** Unscaled frame delta. */
    rawDt: number;
    /** Current time scale (slow motion < 1). */
    scale: number;
    frame: number;
  };
  /** Current game state (owned by the Game). */
  state: GameState;
}
