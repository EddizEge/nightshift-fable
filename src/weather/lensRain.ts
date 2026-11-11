/**
 * Lens rain: a postprocessing Effect (distortion stage) — sparse water drops on the camera lens.
 *
 *  - up to MAX_DROPS larger drops simulated on the CPU (a few dozen floats, written into uniform
 *    arrays): they land, sit, slowly grow and slide down when stopped; at speed the airflow drags
 *    them outward / upward from the centre as streaks and blows them off, so the lens stays clear
 *  - tiny static micro-droplets near the screen edges (procedural cells, no texture)
 *  - each drop refracts the image as an inverted, minified mini view (mainUv) with a faint dark
 *    rim and specular edge (mainImage)
 *  - never touches the centre 40 % of the screen; fades out a few seconds after entering a tunnel
 */
import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, Vector4 } from 'three';

export const MAX_DROPS = 20;

const FRAG = /* glsl */ `
#define NS_LDROPS ${MAX_DROPS}
uniform vec4 uLDrops[NS_LDROPS];
uniform vec4 uLDropsB[NS_LDROPS];
uniform float uLMicro;
uniform float uLOn;
vec4 nsLensHit;

// Drops live only in the side bands and along the top edge: never over the car or the road ahead.
float nsLensMask(vec2 p) {
  float side = 1.0 - smoothstep(0.11, 0.2, min(p.x, 1.0 - p.x));
  float top = smoothstep(0.8, 0.9, p.y);
  return max(side, top);
}
vec3 nsLensHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

void mainUv(inout vec2 uv) {
  nsLensHit = vec4(0.0);
  if (uLOn < 0.5) return;
  float m = nsLensMask(uv);
  if (m <= 0.0) return;
  vec2 asp = vec2(aspect, 1.0);
  vec2 o = vec2(0.0);
  float best = 0.0;
  for (int i = 0; i < NS_LDROPS; i++) {
    vec4 d = uLDrops[i];
    if (d.z <= 0.0) continue;
    vec4 b = uLDropsB[i];
    vec2 q = (uv - d.xy) * asp / d.z;
    float al = dot(q, b.xy);
    float ac = dot(q, vec2(-b.y, b.x));
    // trail behind the drop (opposite to its motion) is elongated and thinner
    float tail = al < 0.0 ? 1.0 : 0.0;
    al = al / (1.0 + d.w * tail);
    ac = ac / (1.0 - 0.35 * tail * smoothstep(0.0, 1.0, -al));
    float r2 = al * al + ac * ac;
    if (r2 >= 1.0) continue;
    float w = smoothstep(1.0, 0.72, r2) * b.z;
    float hgt = sqrt(1.0 - r2);
    // inverted, minified mini view of the scene around the drop
    o += -q * d.z * (2.3 + 1.6 * hgt) / asp * w;
    if (w > best) { best = w; nsLensHit = vec4(al, ac, w, hgt); }
  }
  // micro droplets near the edges
  if (uLMicro > 0.0) {
    const float CELL = 0.022;
    vec2 g = uv * asp / CELL;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec3 h = nsLensHash(id + 17.0);
    float edge = smoothstep(0.3, 0.48, max(abs(uv.x - 0.5) * 0.92, abs(uv.y - 0.5)));
    if (h.x < uLMicro * edge * 0.3) {
      vec2 c = (h.yz - 0.5) * 0.4;
      float rr = 0.16 + 0.2 * fract(h.x * 37.7 + h.y);
      vec2 q = (f - c) / rr;
      float r2 = dot(q, q);
      if (r2 < 1.0) {
        float w = smoothstep(1.0, 0.55, r2) * smoothstep(0.0, 0.25, uLMicro);
        o += -q * rr * CELL * 1.6 / asp * w;
        if (w * 0.6 > best) nsLensHit = vec4(q, w * 0.6, sqrt(1.0 - r2));
      }
    }
  }
  uv += o * m;
  nsLensHit.z *= m;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  float w = nsLensHit.z;
  if (w <= 0.0) return;
  // a refracted lamp / flame stays a small highlight, not a glowing disc (bloom follows)
  float l0 = max(max(inputColor.r, inputColor.g), inputColor.b);
  outputColor.rgb *= mix(1.0, min(1.0, 1.2 / max(l0, 1e-4)), w);
  vec2 q = nsLensHit.xy;
  float r = length(q);
  float rim = smoothstep(0.55, 0.98, r);
  outputColor.rgb *= 1.0 - 0.5 * rim * w;
  vec3 n = normalize(vec3(q, nsLensHit.w * 1.3 + 0.05));
  float spec = pow(max(dot(n, normalize(vec3(-0.35, 0.6, 0.72))), 0.0), 48.0);
  float lum = dot(inputColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  outputColor.rgb += vec3(spec * w * (0.04 + 0.25 * min(lum, 1.5)));
  // faint edge catch-light so drops read even over dark areas
  outputColor.rgb += vec3(0.9, 0.85, 0.8) * (0.012 * smoothstep(0.75, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r)) * w);
}
`;

interface Drop {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  age: number;
  alpha: number;
  live: boolean;
  seed: number;
}

export class LensRainEffect extends Effect {
  private a: Vector4[] = [];
  private b: Vector4[] = [];
  private drops: Drop[] = [];
  private amount = 0;
  private spawnAcc = 0;
  private primed = false;
  private rs = 0x13579bdf;
  enabled = true;

  constructor() {
    const a: Vector4[] = [];
    const b: Vector4[] = [];
    for (let i = 0; i < MAX_DROPS; i++) {
      a.push(new Vector4(0, 0, 0, 0));
      b.push(new Vector4(0, -1, 0, 0));
    }
    super('NsLensRain', FRAG, {
      blendFunction: BlendFunction.SET,
      uniforms: new Map<string, Uniform>([
        ['uLDrops', new Uniform(a)],
        ['uLDropsB', new Uniform(b)],
        ['uLMicro', new Uniform(0)],
        ['uLOn', new Uniform(1)],
      ]),
    });
    this.a = a;
    this.b = b;
    for (let i = 0; i < MAX_DROPS; i++) this.drops.push({ x: 0, y: 0, r: 0, vx: 0, vy: 0, age: 0, alpha: 0, live: false, seed: 0 });
  }

  private rnd(): number {
    let x = this.rs;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rs = x;
    return (x >>> 0) / 4294967296;
  }

  private mask(x: number, y: number): number {
    const e = Math.min(x, 1 - x);
    const side = e < 0.11 ? 1 : e > 0.2 ? 0 : (0.2 - e) / 0.09;
    const top = y > 0.9 ? 1 : y < 0.8 ? 0 : (y - 0.8) / 0.1;
    return Math.max(side, top);
  }

  /**
   * @param dt scaled frame delta
   * @param speed camera speed m/s
   * @param target 0..1 how much rain reaches the lens (intensity × coverage)
   */
  tick(dt: number, speed: number, target: number): void {
    const u = this.uniforms;
    const on = this.enabled ? 1 : 0;
    (u.get('uLOn') as Uniform<number>).value = on;
    const t = this.enabled ? target : 0;
    if (!this.primed && this.enabled && t > 0.05) {
      // start with a lens that has already been out in the rain
      this.primed = true;
      this.amount = t;
      for (let i = 0; i < 9; i++) this.spawn(0.5 + this.rnd() * 4);
    }
    // rise slowly as drops accumulate; evaporate / blow off over a few seconds
    const lambda = t > this.amount ? 0.35 : 0.55;
    this.amount = t + (this.amount - t) * Math.exp(-lambda * dt);
    (u.get('uLMicro') as Uniform<number>).value = this.amount;
    if (!this.enabled) return;

    const flow = Math.min(1, Math.max(0, (speed - 6) / 28));
    // landing rate: many when stopped, few when the airflow sweeps the lens
    const rate = this.amount * (2.2 - 1.8 * flow);
    this.spawnAcc += rate * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      this.spawn();
    }
    for (let i = 0; i < MAX_DROPS; i++) {
      const d = this.drops[i];
      const A = this.a[i];
      const B = this.b[i];
      if (!d.live) {
        A.z = 0;
        continue;
      }
      d.age += dt;
      // airflow: outward from the screen centre and upward
      const ox = d.x - 0.5;
      const oy = d.y - 0.45;
      const ol = Math.hypot(ox, oy) + 1e-4;
      const air = flow * (0.35 + 18 * d.r);
      let tx = (ox / ol) * air;
      let ty = (oy / ol) * air + air * 0.35;
      // gravity slide for big drops when slow
      const heavy = Math.max(0, d.r - 0.017);
      ty -= heavy * 5 * (1 - flow);
      tx += Math.sin(d.age * 2.3 + d.seed * 20) * heavy * 0.6 * (1 - flow);
      const k = 1 - Math.exp(-3 * dt);
      d.vx += (tx - d.vx) * k;
      d.vy += (ty - d.vy) * k;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      // grows slowly by collecting micro-drops while sitting
      d.r = Math.min(0.022, d.r + dt * 0.0005 * this.amount * (1 - flow));
      const fadeIn = Math.min(1, d.age / 0.2);
      const inCentre = this.mask(d.x, d.y) < 0.05;
      d.alpha = inCentre ? Math.max(0, d.alpha - dt * 2) : fadeIn;
      if (d.x < -0.08 || d.x > 1.08 || d.y < -0.08 || d.y > 1.08 || (inCentre && d.alpha <= 0)) {
        d.live = false;
        A.z = 0;
        continue;
      }
      const v = Math.hypot(d.vx, d.vy);
      A.set(d.x, d.y, d.r, Math.min(4, (v / Math.max(d.r, 1e-3)) * 0.05));
      // the airflow at speed thins what is left on the lens
      const al = d.alpha * Math.min(1, this.amount * 1.5) * (1 - 0.45 * flow);
      if (v > 1e-4) B.set(d.vx / v, d.vy / v, al, d.seed);
      else B.set(0, -1, al, d.seed);
    }
  }

  private spawn(age = 0): void {
    let slot = -1;
    for (let i = 0; i < MAX_DROPS; i++) if (!this.drops[i].live) { slot = i; break; }
    if (slot < 0) return;
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 8; tries++) {
      // mostly the side bands (any height), sometimes along the top edge
      if (this.rnd() < 0.8) {
        const e = this.rnd() * 0.15;
        x = this.rnd() < 0.5 ? e : 1 - e;
        y = 0.06 + this.rnd() * 0.88;
      } else {
        x = this.rnd();
        y = 0.86 + this.rnd() * 0.1;
      }
      if (this.mask(x, y) > 0.6) break;
    }
    if (this.mask(x, y) <= 0.6) return;
    const d = this.drops[slot];
    d.x = x;
    d.y = y;
    const rr = this.rnd();
    d.r = 0.006 + rr * rr * 0.014;
    d.vx = 0;
    d.vy = 0;
    d.age = age;
    d.alpha = 0;
    d.seed = this.rnd();
    if (age > 0) d.r += age * 0.0006;
    d.live = true;
  }

  reset(): void {
    for (const d of this.drops) d.live = false;
    for (const A of this.a) A.z = 0;
    this.amount = 0;
    this.spawnAcc = 0;
    this.primed = false;
  }
}
