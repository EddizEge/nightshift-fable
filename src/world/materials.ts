import {
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
} from 'three';
import type { Material, Texture } from 'three';
import type { IWorldMaterials, StaticMaterialOpts } from '../core/types';
import type { LightField } from './lightField';

const sideOf = (s?: 'front' | 'double' | 'back') => (s === 'double' ? DoubleSide : s === 'back' ? BackSide : FrontSide);

/**
 * Resolve a path under public/. The production build uses a relative base ('./', so it works
 * from any static sub-path); the dev server serves from '/', which also covers sandbox pages.
 */
export function assetUrl(path: string): string {
  return new URL(import.meta.env.BASE_URL + path.replace(/^\//, ''), document.baseURI).href;
}

export class WorldMaterials implements IWorldMaterials {
  private cache = new Map<string, Material>();
  private textures = new Map<string, Texture>();
  private loader = new TextureLoader();
  /** Materials created through cached() — never disposed with chunks. */
  readonly shared = new WeakSet<Material>();
  anisotropy = 8;
  /** Pending texture loads (so the loading screen can wait for them). */
  readonly pending: Promise<unknown>[] = [];

  constructor(private lighting: LightField) {}

  standard(o: StaticMaterialOpts): Material {
    const m = new MeshStandardMaterial({
      name: o.name ?? 'static',
      color: o.color !== undefined ? new Color(o.color as never) : new Color(0xffffff),
      map: o.map ?? null,
      normalMap: o.normalMap ?? null,
      roughnessMap: o.roughnessMap ?? null,
      roughness: o.roughness ?? 0.8,
      metalness: o.metalness ?? 0,
      emissive: o.emissive !== undefined ? new Color(o.emissive as never) : new Color(0x000000),
      emissiveIntensity: o.emissiveIntensity ?? 1,
      emissiveMap: o.emissiveMap ?? null,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      side: sideOf(o.side),
      fog: !o.noFog,
      vertexColors: o.vertexColors ?? false,
      alphaTest: o.alphaTest ?? 0,
    });
    return this.lighting.patchStatic(m, { wetness: o.wetness ?? 1, retroReflect: o.retroReflect ?? 0 });
  }

  cached(key: string, factory: () => Material): Material {
    let m = this.cache.get(key);
    if (!m) {
      m = factory();
      this.cache.set(key, m);
      this.shared.add(m);
    }
    return m;
  }

  emissive(
    color: number | string | Color,
    intensity: number,
    opts: { map?: Texture | null; transparent?: boolean; fogScale?: number; side?: 'front' | 'double' } = {},
  ): Material {
    const c = new Color(color as never).multiplyScalar(intensity);
    const m = new MeshBasicMaterial({
      color: c,
      map: opts.map ?? null,
      transparent: opts.transparent ?? false,
      side: sideOf(opts.side),
      fog: true,
      toneMapped: false,
    });
    const fogScale = opts.fogScale ?? 0.6;
    if (fogScale !== 1) {
      // Bright sources punch through fog more than lit surfaces do.
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float nsFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * ${(fogScale * fogScale).toFixed(4)});
  #else
    float nsFog = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, nsFog);
#endif`,
        );
      };
      m.customProgramCacheKey = () => `nsEmissive:${fogScale.toFixed(3)}`;
    }
    return m;
  }

  texture(file: string, opts: { srgb?: boolean; repeat?: [number, number] } = {}): Texture {
    const key = `${file}|${opts.srgb ? 's' : 'l'}|${opts.repeat ? opts.repeat.join(',') : ''}`;
    let t = this.textures.get(key);
    if (!t) {
      let resolve!: () => void;
      this.pending.push(new Promise<void>((r) => (resolve = r)));
      t = this.loader.load(
        assetUrl(`assets/textures/${file}`),
        () => resolve(),
        undefined,
        () => {
          console.warn(`[ns] texture failed to load: ${file}`);
          resolve();
        },
      );
      t.wrapS = t.wrapT = RepeatWrapping;
      if (opts.srgb) t.colorSpace = SRGBColorSpace;
      if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
      t.anisotropy = this.anisotropy;
      this.textures.set(key, t);
    }
    return t;
  }

  patchStatic<T extends Material>(m: T, opts?: { wetness?: number; retroReflect?: number }): T {
    return this.lighting.patchStatic(m, opts);
  }
}
