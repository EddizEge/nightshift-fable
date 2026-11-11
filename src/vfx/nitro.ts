/**
 * Nitro afterburner: two volumetric-looking flame cones (one InstancedMesh, 2 instances, additive)
 * from the exhaust anchors, with shock diamonds, flicker and a hot white-blue core; plus blue
 * flame licks emitted into the shared puff system by the caller.
 */
import {
  BufferGeometry,
  FrontSide,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { Texture } from 'three';
import { LAYERS } from '../core/types';
import type { ILighting, IParticleShared } from '../core/types';
import { premultipliedBlend } from './common';

/** Unit flame volume along +Z (0 = nozzle, 1 = tip), radius 1 at the nozzle. */
function flameGeometry(): BufferGeometry {
  const rings = 28;
  const seg = 18;
  const pos: number[] = [];
  const uvz: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const z = i / rings;
    // slight bulge after the nozzle, then taper to a point
    const r = (1 + 0.55 * Math.sin(Math.min(1, z * 2.2) * Math.PI * 0.5)) * Math.pow(1 - z, 0.75) + 0.02;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, z);
      uvz.push(j / seg, z);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvz, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.boundingSphere = new Sphere(new Vector3(), 1e4);
  return g;
}

const _m = new Matrix4();
const _s = new Vector3();

export class NitroFlames {
  readonly mesh: InstancedMesh;
  private material: ShaderMaterial;
  /** 0..1 current (smoothed) strength. */
  level = 0;
  constructor(lighting: ILighting, particles: IParticleShared, noise: Texture) {
    this.material = premultipliedBlend(
      new ShaderMaterial({
        name: 'vfx_nitro',
        side: FrontSide,
        uniforms: {
          ...lighting.uniforms,
          ...particles.uniforms,
          uNoise: { value: noise },
          uLevel: { value: 0 },
          uPop: { value: 1 },
          uVfxTime: { value: 0 },
        },
        vertexShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vDist;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = float(gl_InstanceID) * 0.37;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vV = cameraPosition - wp.xyz;
  vDist = length(vV);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
        fragmentShader: /* glsl */ `
${particles.glsl}
${lighting.glslLampField}
uniform sampler2D uNoise;
uniform float uLevel;
uniform float uPop;
uniform float uVfxTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vDist;
varying float vSeed;
void main() {
  float z = vUv.y;
  vec3 v = normalize(vV);
  float facing = abs(dot(normalize(vN), v));
  // optical depth through the cone ≈ facing; the silhouette is thin and dim (no hard rim)
  float thick = pow(facing, 1.5);
  float n = texture2D(uNoise, vec2(vUv.x * 2.0 + vSeed, z * 1.6 - uVfxTime * 11.0)).g;
  float n2 = texture2D(uNoise, vec2(vUv.x * 3.0 - vSeed, z * 0.8 - uVfxTime * 6.5)).r;
  // ragged, flickering tip
  float tip = 1.0 - smoothstep(0.45 + 0.3 * n2, 1.0, z);
  // shock diamonds: bright knots along the axis near the nozzle, seen through the middle only
  float fk = fract(z * 7.5 - 0.15) - 0.5;
  float diamonds = exp(-fk * fk * 34.0) * (1.0 - smoothstep(0.12, 0.62, z)) * smoothstep(0.04, 0.12, z);
  float core = exp(-z * 6.5);
  float mid = pow(thick, 2.6);
  vec3 blue = vec3(0.3, 0.55, 1.7);
  vec3 white = vec3(0.86, 0.94, 1.18);
  vec3 violet = vec3(0.65, 0.3, 1.25);
  vec3 col = blue * (1.7 * thick * (0.55 + 0.65 * n)) * tip;
  col += white * (3.6 * core * mid);
  col += mix(white, blue * 0.6, 0.35) * (2.2 * diamonds * mid);
  col += violet * (1.3 * smoothstep(0.3, 1.0, z) * tip * thick * (0.4 + n));
  float fogT = exp(-uFogDensity * uFogDensity * vDist * vDist);
  // planar-reflection pass (soft particles off there): the wet road only shows a dim smear
  float refl = uSoftParticles < 0.5 ? 0.3 : 1.0;
  gl_FragColor = vec4(col * (uLevel * uPop * fogT * refl * nsSoftFade(0.05)), 0.0);
}`,
      }),
    );
    this.mesh = new InstancedMesh(flameGeometry(), this.material, 2);
    this.mesh.name = 'vfx_nitro';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYERS.PARTICLES);
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
  }

  /** Place flame i at `pos` pointing along quaternion `q`'s +Z (car backwards), radius r, length L. */
  set(i: number, pos: Vector3, q: Quaternion, radius: number, length: number): void {
    _s.set(radius, radius, length);
    _m.compose(pos, q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setLevel(level: number, time: number, pop = 1): void {
    this.level = level;
    (this.material.uniforms.uLevel as { value: number }).value = level;
    (this.material.uniforms.uPop as { value: number }).value = pop;
    (this.material.uniforms.uVfxTime as { value: number }).value = time;
    this.mesh.visible = level > 0.01;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
