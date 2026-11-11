import { CubeCamera, HalfFloatType, LinearFilter, PMREMGenerator, Vector3, WebGLCubeRenderTarget } from 'three';
import type { PerspectiveCamera, Scene, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import { LAYERS } from '../core/types';

/**
 * Dynamic environment probe that follows the player: a cube map refreshed a few faces per frame
 * (round robin) and PMREM-filtered here, explicitly, between scene renders. (Letting three do
 * the PMREM lazily happens in the middle of a material's uniform upload, which overflows the
 * texture units and binds wrong textures.) `texture` is the filtered CubeUV map: assign it as
 * material.envMap.
 */
export class EnvProbe {
  readonly target: WebGLCubeRenderTarget;
  readonly cubeCamera: CubeCamera;
  private face = 0;
  private pmremEvery = 1;
  private frame = 0;
  readonly position = new Vector3();
  mask = (1 << LAYERS.DEFAULT) | (1 << LAYERS.ROAD);
  /** Called before/after the probe renders (the road switches its planar reflection off). */
  onBefore: (() => void) | null = null;
  onAfter: (() => void) | null = null;
  private pmrem: PMREMGenerator | null = null;
  private filtered: WebGLRenderTarget | null = null;

  constructor(size: number, private facesPerFrame: number) {
    this.target = new WebGLCubeRenderTarget(size, {
      type: HalfFloatType,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
    });
    this.target.texture.name = 'EnvProbe';
    this.cubeCamera = new CubeCamera(0.4, 700, this.target);
    for (const c of this.cubeCamera.children) (c as PerspectiveCamera).layers.mask = this.mask;
    // PMREM work is the expensive bit at large sizes: refilter at most every other frame there.
    this.pmremEvery = size >= 512 ? 2 : 1;
  }

  /** PMREM-filtered environment (valid after the first renderAll/update). */
  get texture(): Texture | null {
    return this.filtered ? this.filtered.texture : null;
  }

  private filter(renderer: WebGLRenderer): void {
    if (!this.pmrem) this.pmrem = new PMREMGenerator(renderer);
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    this.filtered = this.pmrem.fromCubemap(this.target.texture, this.filtered as never);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  /** Render all six faces now (startup / teleports). */
  renderAll(renderer: WebGLRenderer, scene: Scene): void {
    for (let i = 0; i < 6; i++) this.renderFace(renderer, scene, i);
    this.filter(renderer);
  }

  private renderFace(renderer: WebGLRenderer, scene: Scene, face: number): void {
    const cams = this.cubeCamera.children as PerspectiveCamera[];
    if (this.cubeCamera.coordinateSystem !== renderer.coordinateSystem) {
      this.cubeCamera.coordinateSystem = renderer.coordinateSystem;
      this.cubeCamera.updateCoordinateSystem();
    }
    this.cubeCamera.position.copy(this.position);
    this.cubeCamera.updateMatrixWorld(true);
    const cam = cams[face];
    cam.layers.mask = this.mask;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    this.onBefore?.();
    renderer.setRenderTarget(this.target, face);
    renderer.render(scene, cam);
    this.onAfter?.();
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
  }

  update(renderer: WebGLRenderer, scene: Scene): void {
    for (let i = 0; i < this.facesPerFrame; i++) {
      this.renderFace(renderer, scene, this.face);
      this.face = (this.face + 1) % 6;
    }
    this.frame++;
    if (this.frame % this.pmremEvery === 0) this.filter(renderer);
  }

  dispose(): void {
    this.target.dispose();
    this.filtered?.dispose();
    this.pmrem?.dispose();
  }
}
