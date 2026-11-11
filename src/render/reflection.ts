import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  PerspectiveCamera,
  Plane,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import type { Scene, Texture, WebGLRenderer } from 'three';
import { LAYERS } from '../core/types';

const _v = new Vector3();
const _t = new Vector3();
const _up = new Vector3();
const _plane = new Plane();
const _clip = new Vector4();
const _q = new Vector4();
const _rot = new Matrix4();

/**
 * Planar mirror of the scene about the road plane (y = 0), rendered at reduced resolution with
 * a mip chain so the road shader can pick blur by roughness. The mirror camera is the main
 * camera reflected through the plane (an upside-down proper rotation: sample with u = 1 − x),
 * with an oblique near plane so nothing below the road leaks into the reflection.
 */
export class PlanarReflection {
  readonly target: WebGLRenderTarget;
  readonly camera = new PerspectiveCamera();
  scale = 0.5;
  /** Layers visible in the reflection. */
  mask = (1 << LAYERS.DEFAULT) | (1 << LAYERS.PLAYER) | (1 << LAYERS.NO_PROBE) | (1 << LAYERS.PARTICLES);

  constructor() {
    this.target = new WebGLRenderTarget(4, 4, {
      type: HalfFloatType,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.name = 'PlanarReflection';
    this.camera.matrixAutoUpdate = false;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(16, Math.round(width * this.scale));
    const h = Math.max(16, Math.round(height * this.scale));
    if (w !== this.target.width || h !== this.target.height) this.target.setSize(w, h);
  }

  render(renderer: WebGLRenderer, scene: Scene, main: PerspectiveCamera): void {
    main.updateMatrixWorld();
    const cam = this.camera;
    const mpos = _v.setFromMatrixPosition(main.matrixWorld);
    // Keep the mirror camera strictly above/below the plane (a camera exactly at y = 0 degenerates).
    const camY = Math.max(0.05, mpos.y);
    _rot.extractRotation(main.matrixWorld);
    _t.set(0, 0, -1).applyMatrix4(_rot).add(mpos); // look target
    _up.set(0, 1, 0).applyMatrix4(_rot);
    cam.position.set(mpos.x, -camY, mpos.z);
    _t.y = -_t.y;
    cam.up.set(_up.x, -_up.y, _up.z);
    cam.matrixAutoUpdate = true;
    cam.lookAt(_t);
    cam.updateMatrixWorld(true);
    cam.matrixAutoUpdate = false;
    cam.near = main.near;
    cam.far = main.far;
    cam.projectionMatrix.copy(main.projectionMatrix);
    cam.projectionMatrixInverse.copy(main.projectionMatrixInverse);

    // Oblique near plane = road plane (Lengyel), as in three's Reflector.
    _plane.set(_v.set(0, 1, 0), 0).applyMatrix4(cam.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const e = cam.projectionMatrix.elements;
    _q.x = (Math.sign(_clip.x) + e[8]) / e[0];
    _q.y = (Math.sign(_clip.y) + e[9]) / e[5];
    _q.z = -1.0;
    _q.w = (1.0 + e[10]) / e[14];
    _clip.multiplyScalar(2.0 / _clip.dot(_q));
    e[2] = _clip.x;
    e[6] = _clip.y;
    e[10] = _clip.z + 1.0 - 0.003;
    e[14] = _clip.w;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    cam.layers.mask = this.mask;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
  }

  dispose(): void {
    this.target.dispose();
  }
}
