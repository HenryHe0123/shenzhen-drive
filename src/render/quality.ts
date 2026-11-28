import { CONFIG } from '../config';

/**
 * Global graphics quality preset. Chosen on the start / pause menu (persisted in localStorage)
 * or forced with ?quality=standard|high. 'standard' caps pixel ratio and tightens racing-mode
 * whole-city streaming radii so full-screen Retina / web sessions stay smooth; 'high' uses the
 * full Retina pixel ratio and wider streaming radii.
 */
export type QualityLevel = 'standard' | 'high';

export const QUALITY_LEVELS: readonly QualityLevel[] = ['standard', 'high'];

export const QUALITY_LABELS: Record<QualityLevel, string> = {
  standard: '标准',
  high: '高',
};

export interface QualitySettings {
  maxPixelRatio: number;
  detailRadius: number;
  massRadius: number;
  roadRadiusScale: number;
  massCull: number;
}

const STORAGE_KEY = 'shenzhen-drive.quality.v1';
const DEFAULT_QUALITY: QualityLevel = 'standard';

type Listener = (q: QualityLevel) => void;
const listeners = new Set<Listener>();

function isQuality(v: unknown): v is QualityLevel {
  return typeof v === 'string' && (QUALITY_LEVELS as readonly string[]).includes(v);
}

function initialQuality(): QualityLevel {
  if (typeof window === 'undefined') return DEFAULT_QUALITY;
  const fromUrl = new URLSearchParams(window.location.search).get('quality');
  if (isQuality(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isQuality(stored)) return stored;
  } catch {
    // localStorage unavailable (privacy mode); fall through to default.
  }
  return DEFAULT_QUALITY;
}

let current: QualityLevel = initialQuality();

export function getQuality(): QualityLevel {
  return current;
}

export function qualitySettings(q: QualityLevel = current): QualitySettings {
  const M = CONFIG.metro;
  if (q === 'high') {
    return {
      maxPixelRatio: CONFIG.render.maxPixelRatio,
      detailRadius: M.detailRadius,
      massRadius: M.massRadius,
      roadRadiusScale: M.roadRadiusScale,
      massCull: M.massCull,
    };
  }
  return {
    maxPixelRatio: CONFIG.render.standardPixelRatio,
    detailRadius: M.standardDetailRadius,
    massRadius: M.standardMassRadius,
    roadRadiusScale: M.standardRoadRadiusScale,
    massCull: M.standardMassCull,
  };
}

export function setQuality(q: QualityLevel): void {
  if (q === current) return;
  current = q;
  try {
    window.localStorage.setItem(STORAGE_KEY, q);
  } catch {
    // Not persisted; still applies to this session.
  }
  for (const cb of listeners) cb(q);
}

export function onQualityChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
