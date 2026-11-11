import type { IEventBus, IQuality, QualityLevel, QualitySettings } from './types';

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low', maxPixelRatio: 1, renderScale: 0.8, minRenderScale: 0.55, dynamicResolution: true, msaa: 0,
    planarReflection: false, reflectionScale: 0.4, envProbeSize: 0, envProbeFacesPerFrame: 0,
    bloom: true, motionBlur: false, lensRain: false, shadowMapSize: 0,
    rainCount: 2500, particleScale: 0.4, trafficMax: 14, oncomingMax: 8, chunksAhead: 4,
    anisotropy: 2, volumetrics: false, filmGrain: false,
  },
  medium: {
    level: 'medium', maxPixelRatio: 1, renderScale: 1, minRenderScale: 0.65, dynamicResolution: true, msaa: 2,
    planarReflection: true, reflectionScale: 0.4, envProbeSize: 128, envProbeFacesPerFrame: 1,
    bloom: true, motionBlur: true, lensRain: true, shadowMapSize: 0,
    rainCount: 5000, particleScale: 0.7, trafficMax: 18, oncomingMax: 12, chunksAhead: 5,
    anisotropy: 4, volumetrics: true, filmGrain: true,
  },
  high: {
    level: 'high', maxPixelRatio: 1.25, renderScale: 1, minRenderScale: 0.7, dynamicResolution: true, msaa: 4,
    planarReflection: true, reflectionScale: 0.5, envProbeSize: 256, envProbeFacesPerFrame: 2,
    bloom: true, motionBlur: true, lensRain: true, shadowMapSize: 1024,
    rainCount: 9000, particleScale: 1, trafficMax: 22, oncomingMax: 16, chunksAhead: 6,
    anisotropy: 8, volumetrics: true, filmGrain: true,
  },
  ultra: {
    level: 'ultra', maxPixelRatio: 2, renderScale: 1, minRenderScale: 0.8, dynamicResolution: false, msaa: 4,
    planarReflection: true, reflectionScale: 0.75, envProbeSize: 512, envProbeFacesPerFrame: 3,
    bloom: true, motionBlur: true, lensRain: true, shadowMapSize: 2048,
    rainCount: 14000, particleScale: 1.5, trafficMax: 26, oncomingMax: 20, chunksAhead: 7,
    anisotropy: 16, volumetrics: true, filmGrain: true,
  },
};

const STORAGE_KEY = 'nightshift.quality';

export class Quality implements IQuality {
  settings: QualitySettings;
  /** Dynamic-resolution multiplier on top of settings.renderScale (1 = none). */
  dynamicScale = 1;
  /** True until the player picks a preset: the game may then step down by itself (see stepDown). */
  auto = true;

  constructor(private events: IEventBus, initial?: QualityLevel) {
    let level: QualityLevel = initial ?? 'high';
    if (initial) this.auto = false;
    if (!initial) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY) as QualityLevel | null;
        if (saved && saved in QUALITY_PRESETS) {
          level = saved;
          this.auto = false;
        }
      } catch {
        /* storage unavailable */
      }
    }
    this.settings = { ...QUALITY_PRESETS[level] };
  }

  get level(): QualityLevel {
    return this.settings.level;
  }

  get pixelRatio(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio);
    return dpr * this.settings.renderScale * this.dynamicScale;
  }

  set(level: QualityLevel): void {
    this.settings = { ...QUALITY_PRESETS[level] };
    this.dynamicScale = 1;
    this.auto = false;
    try {
      localStorage.setItem(STORAGE_KEY, level);
    } catch {
      /* ignore */
    }
    this.events.emit('quality', { settings: this.settings });
  }

  /**
   * Automatic fallback: one preset down, not stored, so a faster machine (or a later visit with
   * the GPU free again) starts from the default once more. Returns the new level, or null at LOW.
   */
  stepDown(): QualityLevel | null {
    const order: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
    const i = order.indexOf(this.settings.level);
    if (i <= 0) return null;
    this.settings = { ...QUALITY_PRESETS[order[i - 1]] };
    this.dynamicScale = 1;
    this.events.emit('quality', { settings: this.settings });
    return order[i - 1];
  }
}
