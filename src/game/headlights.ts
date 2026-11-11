import { CanvasTexture, Color, LinearFilter, Object3D, SpotLight, SRGBColorSpace, Vector3 } from 'three';
import type { Scene } from 'three';
import type { ILighting, PlayerState, QualitySettings } from '../core/types';

const _fwd = new Vector3();
const _pos = new Vector3();

/** Low-beam cookie: wide flat beam with a soft cut-off above the horizon and two hot spots. */
function makeBeamCookie(): CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1)) * 2 - 1; // −1 left … +1 right
      const v = (y / (size - 1)) * 2 - 1; // −1 top … +1 bottom (canvas space)
      // Elevation above the beam axis is −v. Cut-off slightly above the axis, right side kicked up a little.
      const cut = 0.06 + Math.max(0, u) * 0.07;
      const above = -v - cut;
      const cutoff = above > 0 ? Math.exp(-above * above * 90) * 0.5 : 1;
      const horiz = Math.exp(-Math.pow(u / 0.78, 4));
      const down = Math.exp(-Math.pow(Math.max(0, v) / 0.62, 2.2));
      const hot = Math.exp(-(Math.pow((u - 0.16) / 0.3, 2) + Math.pow((v - 0.06) / 0.12, 2))) + Math.exp(-(Math.pow((u + 0.16) / 0.3, 2) + Math.pow((v - 0.06) / 0.12, 2)));
      let val = cutoff * horiz * down * (0.34 + 0.66 * Math.min(1, hot));
      // Spill light: a faint glow everywhere inside the cone so nearby objects are not pitch black.
      const r = Math.hypot(u, v);
      val = Math.max(val, 0.035 * Math.max(0, 1 - r));
      const b = Math.max(0, Math.min(255, Math.round(val * 255)));
      const i = (y * size + x) * 4;
      img.data[i] = b;
      img.data[i + 1] = b;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/**
 * The player's low beams: one real SpotLight with a beam cookie (lights every built-in material,
 * casts the only shadow map in the game) plus the analytic headlight uniforms used by rain,
 * spray, smoke and retro-reflective surfaces.
 */
export class Headlights {
  readonly light: SpotLight;
  private target = new Object3D();
  private color = new Color(0.86, 0.92, 1.0);
  intensity = 5200;
  on = true;
  /** 0..1 flicker/damage multiplier. */
  health = 1;

  constructor(
    scene: Scene,
    private lighting: ILighting,
    quality: QualitySettings,
  ) {
    this.light = new SpotLight(this.color, this.intensity, 190, 0.62, 0.55, 2);
    this.light.map = makeBeamCookie();
    scene.add(this.light, this.target);
    this.light.target = this.target;
    this.applyQuality(quality);
    lighting.uniforms.uHeadCone.value.set(Math.cos(0.2), Math.cos(0.6), 170);
  }

  applyQuality(q: QualitySettings): void {
    const sh = q.shadowMapSize > 0;
    this.light.castShadow = sh;
    if (sh) {
      this.light.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.light.shadow.camera.near = 1.2;
      this.light.shadow.camera.far = 150;
      this.light.shadow.bias = -0.0006;
      this.light.shadow.normalBias = 0.03;
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
    }
  }

  update(player: PlayerState, time: number): void {
    const h = player.heading;
    _fwd.set(Math.sin(h), 0, -Math.cos(h));
    // Inside the nose, under the bonnet skin: every outer surface of the car faces away from the source,
    // and the bright foot of the cone lands on the road under the bumper where no camera sees it.
    const front = player.dims.frontAxle + (player.dims.frontOverhang ?? 0.95) - 0.75;
    _pos.copy(player.position).addScaledVector(_fwd, front);
    _pos.y = 0.66;
    this.light.position.copy(_pos);
    // Aim slightly down: the hot spot lands ~35 m ahead.
    this.target.position.copy(_pos).addScaledVector(_fwd, 40);
    this.target.position.y = -0.1;
    let k = this.on ? this.health : 0;
    if (this.health < 0.99 && this.on) {
      // Damaged: irregular flicker.
      const n = Math.sin(time * 37.0) * Math.sin(time * 13.7 + 1.3);
      k *= n > 0.2 * this.health ? 1 : 0.25;
    }
    this.light.intensity = this.intensity * k;
    const u = this.lighting.uniforms;
    u.uHeadPos.value.copy(_pos);
    u.uHeadDir.value.copy(this.target.position).sub(_pos).normalize();
    u.uHeadColor.value.copy(this.color).multiplyScalar(this.intensity * k);
  }
}
