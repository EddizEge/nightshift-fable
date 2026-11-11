import { Effect, EffectAttribute, BlendFunction, Pass } from 'postprocessing';
import { Color, DepthTexture, FloatType, HalfFloatType, NoBlending, ShaderMaterial, Uniform, Vector2, WebGLRenderTarget } from 'three';
import type { Camera, Scene, Texture, WebGLRenderer } from 'three';
import { LAYERS } from '../core/types';
import type { IParticleShared } from '../core/types';

/**
 * HDR colour grade, applied before tone mapping: exposure, white balance, split toning
 * (cool shadows / warm highlights around the sodium lamps), saturation and a gentle contrast
 * curve in log space. Kept subtle on purpose — the scene must stay readable.
 */
export class GradeEffect extends Effect {
  constructor() {
    super(
      'NsGrade',
      /* glsl */ `
uniform float uExposure;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec3 uFlashTint;
uniform float uFlash;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Split toning by log luminance.
  float ll = clamp((log2(max(l, 1e-5)) + 8.0) / 10.0, 0.0, 1.0);
  vec3 tint = mix(uShadowTint, uHighTint, smoothstep(0.25, 0.85, ll));
  c *= tint;
  // Contrast around mid grey in log space.
  vec3 lc = log2(max(c, vec3(1e-6)));
  lc = (lc - log2(0.18)) * uContrast + log2(0.18);
  c = exp2(lc);
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c += uFlashTint * uFlash;
  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`,
      {
        blendFunction: BlendFunction.SET,
        uniforms: new Map<string, Uniform>([
          ['uExposure', new Uniform(1.0)],
          ['uSaturation', new Uniform(0.92)],
          ['uContrast', new Uniform(1.06)],
          ['uShadowTint', new Uniform(new Color(0.93, 1.0, 1.1))],
          ['uHighTint', new Uniform(new Color(1.06, 1.0, 0.93))],
          ['uFlashTint', new Uniform(new Color(1.0, 0.75, 0.5))],
          ['uFlash', new Uniform(0)],
        ]),
      },
    );
  }
  get exposure(): number {
    return this.uniforms.get('uExposure')!.value;
  }
  set exposure(v: number) {
    this.uniforms.get('uExposure')!.value = v;
  }
  set flash(v: number) {
    this.uniforms.get('uFlash')!.value = v;
  }
}

/** After tone mapping: vignette + fine film grain (in display space). */
export class FilmEffect extends Effect {
  constructor() {
    super(
      'NsFilm',
      /* glsl */ `
uniform float uVignette;
uniform float uGrain;
uniform float uSeed;
uniform float uRed;
float nsH(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  vec2 q = uv - 0.5;
  q.x *= 1.25;
  float v = 1.0 - uVignette * smoothstep(0.25, 0.85, length(q));
  c *= v;
  // Damage: red edge pulse.
  c = mix(c, c * vec3(1.25, 0.55, 0.5) + vec3(0.06, 0.0, 0.0), uRed * smoothstep(0.3, 0.8, length(q)));
  float g = nsH(uv * resolution + uSeed * 91.7) - 0.5;
  // Grain strongest in the mid tones, invisible in pure black.
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c += g * uGrain * (0.25 + 0.75 * smoothstep(0.02, 0.4, lum)) * (1.0 - smoothstep(0.6, 1.0, lum));
  outputColor = vec4(c, inputColor.a);
}
`,
      {
        blendFunction: BlendFunction.SET,
        uniforms: new Map<string, Uniform>([
          ['uVignette', new Uniform(0.32)],
          ['uGrain', new Uniform(0.035)],
          ['uSeed', new Uniform(0)],
          ['uRed', new Uniform(0)],
        ]),
      },
    );
  }
  override update(_r: WebGLRenderer, _i: WebGLRenderTarget, dt?: number): void {
    const u = this.uniforms.get('uSeed')!;
    u.value = (u.value + (dt ?? 0.016) * 7.31) % 97;
  }
  set grain(v: number) {
    this.uniforms.get('uGrain')!.value = v;
  }
  set damage(v: number) {
    this.uniforms.get('uRed')!.value = v;
  }
}

/**
 * Speed blur: a radial smear towards a vanishing point plus a touch of lateral chromatic
 * aberration at the edges. Centre stays sharp (the car and the road ahead must stay readable).
 */
export class SpeedBlurEffect extends Effect {
  constructor() {
    super(
      'NsSpeedBlur',
      /* glsl */ `
uniform float uStrength;
uniform vec2 uCenter;
float nsIgn(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uStrength < 0.002) { outputColor = inputColor; return; }
  vec2 dir = uv - uCenter;
  float dist = length(dir * vec2(aspect, 1.0));
  // Only the periphery streaks: the car and the road ahead stay sharp.
  float mask = smoothstep(0.3, 1.0, dist);
  float amt = uStrength * mask;
  if (amt < 0.001) { outputColor = inputColor; return; }
  vec3 acc = inputColor.rgb;
  float j = nsIgn(gl_FragCoord.xy);
  const int N = 10;
  for (int i = 1; i <= N; i++) {
    float t = (float(i) - j) / float(N);
    acc += texture2D(inputBuffer, uv - dir * t * amt * 0.085).rgb;
  }
  acc /= float(N + 1);
  // A whisper of radial chromatic fringe at the very edge.
  vec2 off = dir * amt * 0.0035;
  acc.r = mix(acc.r, texture2D(inputBuffer, uv + off).r, 0.3 * mask);
  acc.b = mix(acc.b, texture2D(inputBuffer, uv - off).b, 0.3 * mask);
  outputColor = vec4(acc, inputColor.a);
}
`,
      {
        attributes: EffectAttribute.CONVOLUTION,
        blendFunction: BlendFunction.SET,
        uniforms: new Map<string, Uniform>([
          ['uStrength', new Uniform(0)],
          ['uCenter', new Uniform(new Vector2(0.5, 0.56))],
        ]),
      },
    );
  }
  set strength(v: number) {
    this.uniforms.get('uStrength')!.value = v;
  }
  get strength(): number {
    return this.uniforms.get('uStrength')!.value;
  }
}

/**
 * Copy of the resolved scene colour into the effect chain that also makes it safe: a single NaN or
 * Inf texel (0 * inf in some light term, a degenerate highlight) is harmless on its own, but the
 * bloom mip chain spreads it into a screen-sized black block and the speed blur into a streak.
 * Non-finite texels become black, everything else is limited to a range half floats can blur.
 */
class SafeCopyMaterial extends ShaderMaterial {
  constructor() {
    super({
      name: 'NsSafeCopy',
      uniforms: { inputBuffer: new Uniform(null) },
      blending: NoBlending,
      toneMapped: false,
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`,
      fragmentShader: /* glsl */ `
uniform sampler2D inputBuffer;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(inputBuffer, vUv);
  bool bad = isnan(c.r) || isnan(c.g) || isnan(c.b) || isinf(c.r) || isinf(c.g) || isinf(c.b);
  gl_FragColor = vec4(bad ? vec3(0.0) : clamp(c.rgb, 0.0, 4000.0), 1.0);
}
`,
    });
  }
}

/**
 * First pass of the frame graph: renders the scene into its own multisampled HDR target, then the
 * soft particles (LAYERS.PARTICLES) on top of it with the resolved scene depth, and copies the
 * resolved colour into the composer's chain. Only this pass is multisampled: the composer's
 * ping-pong buffers stay single-sample, so the full-screen effect passes do not pay for MSAA
 * writes and resolves.
 */
export class ScenePass extends Pass {
  readonly target: WebGLRenderTarget;
  /** Single-sample targets cannot sample their own depth attachment: keep a copy for the particles. */
  private depthCopy: WebGLRenderTarget | null = null;
  private copy = new SafeCopyMaterial();

  constructor(
    private worldScene: Scene,
    private worldCamera: Camera,
    private shared: IParticleShared,
    samples: number,
  ) {
    super('NsScenePass');
    this.needsSwap = true;
    this.target = new WebGLRenderTarget(4, 4, {
      type: HalfFloatType,
      samples,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: makeDepthTexture(),
    });
    this.target.texture.name = 'NsScene';
    if (samples === 0) {
      this.depthCopy = new WebGLRenderTarget(4, 4, { depthBuffer: true, stencilBuffer: false, depthTexture: makeDepthTexture() });
      this.depthCopy.texture.name = 'NsSceneDepthCopy';
    }
    this.fullscreenMaterial = this.copy;
  }

  /** Scene depth as the particles see it. */
  get depthTexture(): Texture {
    return (this.depthCopy ?? this.target).depthTexture as Texture;
  }

  override setSize(width: number, height: number): void {
    for (const rt of [this.target, this.depthCopy]) {
      if (!rt || (rt.width === width && rt.height === height)) continue;
      rt.setSize(width, height);
      // three sizes a depth texture lazily when its framebuffer is set up; a material that samples
      // it first (particles in the reflection pass) would allocate it with the stale size and
      // leave the framebuffer incomplete.
      const img = rt.depthTexture!.image as { width: number; height: number };
      img.width = width;
      img.height = height;
      rt.depthTexture!.dispose();
    }
  }

  override render(renderer: WebGLRenderer, _inputBuffer: WebGLRenderTarget, outputBuffer: WebGLRenderTarget): void {
    const scene = this.worldScene;
    const cam = this.worldCamera;
    const u = this.shared.uniforms;
    u.uSceneDepth.value = this.depthTexture;
    u.uSoftParticles.value = 0;

    // 1. The scene.
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    if (this.depthCopy) this.blitDepth(renderer);

    // 2. Soft particles.
    const mask = cam.layers.mask;
    cam.layers.set(LAYERS.PARTICLES);
    const bg = scene.background;
    scene.background = null;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    u.uSoftParticles.value = 1;
    u.uResolution.value.x = this.target.width;
    u.uResolution.value.y = this.target.height;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
    scene.background = bg;
    cam.layers.mask = mask;
    u.uSoftParticles.value = 0;

    // 3. Hand the resolved colour to the effect chain.
    this.copy.uniforms.inputBuffer.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  private blitDepth(renderer: WebGLRenderer): void {
    const dst = this.depthCopy!;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const props = renderer.properties as unknown as { get(o: object): { __webglFramebuffer: WebGLFramebuffer } };
    renderer.setRenderTarget(dst); // makes three create the framebuffer
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, props.get(this.target).__webglFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, props.get(dst).__webglFramebuffer);
    gl.blitFramebuffer(0, 0, this.target.width, this.target.height, 0, 0, dst.width, dst.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    renderer.setRenderTarget(null); // resync three's framebuffer cache
  }

  override dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.depthCopy?.depthTexture?.dispose();
    this.depthCopy?.dispose();
    this.copy.dispose();
  }
}

function makeDepthTexture(): DepthTexture {
  const d = new DepthTexture(4, 4);
  d.type = FloatType;
  d.name = 'NsSceneDepth';
  return d;
}
