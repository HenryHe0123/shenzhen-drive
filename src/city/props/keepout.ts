import type { CityModelsData, Vec2 } from '../../route/types';
import { inLandmark, type RoadLayout } from '../road/layout';

interface Zone {
  pts: readonly Vec2[];
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function inPolygon(pts: readonly Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function nearEdge(pts: readonly Vec2[], x: number, z: number, margin: number): boolean {
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j];
    const ex = pts[i][0] - ax;
    const ez = pts[i][1] - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    if (Math.hypot(x - ax - ex * t, z - az - ez * t) < margin) return true;
  }
  return false;
}

/**
 * Keep-out test for props: true when world (x, z) lies inside, or within `margin` meters of, a
 * landmark footprint (route data) or a real-building model footprint (ctx.cityModels; null until the
 * pipeline publishes public/data/city_models.json, then only landmarks count). `stats` counts the
 * model footprints and the tests they rejected.
 */
export function createKeepOut(l: RoadLayout, cityModels: CityModelsData | null | undefined) {
  const zones: Zone[] = [];
  for (const m of cityModels?.models ?? []) {
    const pts = m.footprint;
    if (!pts || pts.length < 3) continue;
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    zones.push({ pts, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) });
  }
  const stats = { modelFootprints: zones.length, modelHits: 0 };
  const test = (x: number, z: number, margin = 3): boolean => {
    if (inLandmark(l, x, z, margin)) return true;
    for (const f of zones) {
      if (x < f.x0 - margin || x > f.x1 + margin || z < f.z0 - margin || z > f.z1 + margin) continue;
      if (inPolygon(f.pts, x, z) || nearEdge(f.pts, x, z, margin)) {
        stats.modelHits++;
        return true;
      }
    }
    return false;
  };
  return Object.assign(test, { stats });
}
