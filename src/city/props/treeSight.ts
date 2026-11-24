import { CONFIG } from '../../config';
import type { Route } from '../../route/Route';
import type { Landmark, Vec2 } from '../../route/types';

/** Lane the view corridors are swept from (m right of the centerline) and camera spacing along the route (m). */
const CAM_D = 1.75;
const CAM_STEP = 5;
/** Sight lines further than this from the driving direction are off screen. */
const COS_HALF_FOV = Math.cos((50 * Math.PI) / 180);

export interface SightTree {
  x: number;
  z: number;
  /** Uncapped height and canopy radius (m). */
  h: number;
  r: number;
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

function polygonDistance(pts: readonly Vec2[], x: number, z: number): number {
  if (inPolygon(pts, x, z)) return 0;
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j];
    const ex = pts[i][0] - ax;
    const ez = pts[i][1] - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return best;
}

/**
 * Height caps (m) for trees in the landmark view corridors (route.data.clearZones): a tree's canopy,
 * a dome from `base` × height up to the top, may not rise above any sight line that crosses it,
 * running from the chase camera to the top `keep` fraction of the zone's landmark (footprint corners
 * and centroid). Trees outside the zones keep their height `h`.
 */
export function treeSightCaps(route: Route, trees: readonly SightTree[], keep: number, base: number): Float32Array {
  const caps = Float32Array.from(trees, (t) => t.h);
  const zones = (route.data.clearZones ?? []).filter((z) => z.length >= 3);
  const marks = route.data.landmarks.filter((l) => (l.height ?? 0) > 0);
  if (!zones.length || !marks.length) return caps;
  const gap = (l: Landmark, zone: Vec2[]) => Math.min(polygonDistance(zone, l.x, l.z), ...(l.footprint ?? []).map(([x, z]) => polygonDistance(zone, x, z)));
  const zoneMark = zones.map((zone) => marks.reduce((a, b) => (gap(b, zone) < gap(a, zone) ? b : a)));
  const used = [...new Set(zoneMark)];

  const { distance: back, height: eye } = CONFIG.camera;
  const nCam = Math.floor(route.length / CAM_STEP) + 1;
  const camX = new Float64Array(nCam);
  const camZ = new Float64Array(nCam);
  const camTx = new Float64Array(nCam);
  const camTz = new Float64Array(nCam);
  const p = { x: 0, z: 0 };
  for (let i = 0; i < nCam; i++) {
    route.pointAt(Math.max(0, i * CAM_STEP - back), CAM_D, p);
    camX[i] = p.x;
    camZ[i] = p.z;
    route.tangentAt(i * CAM_STEP, p);
    camTx[i] = p.x;
    camTz[i] = p.z;
  }
  // Per landmark: lines [ux, uz, length, slope] grouped by camera (camera i owns lines first[i]..first[i+1]).
  const lines = used.map((l) => {
    const top = (l.height ?? 0) * (1 - keep);
    const targets: Vec2[] = [...(l.footprint ?? []), [l.x, l.z]];
    const data: number[] = [];
    const first = new Int32Array(nCam + 1);
    let minSlope = Infinity;
    for (let i = 0; i < nCam; i++) {
      first[i] = data.length / 4;
      for (const [x, z] of targets) {
        const vx = x - camX[i];
        const vz = z - camZ[i];
        const len = Math.hypot(vx, vz);
        if (len < 1 || (camTx[i] * vx + camTz[i] * vz) / len < COS_HALF_FOV) continue;
        const slope = (top - eye) / len;
        minSlope = Math.min(minSlope, slope);
        data.push(vx / len, vz / len, len, slope);
      }
    }
    first[nCam] = data.length / 4;
    return { data: Float64Array.from(data), first, minSlope };
  });

  trees.forEach((tree, k) => {
    const { x, z, r } = tree;
    for (let zi = 0; zi < zones.length; zi++) {
      if (!inPolygon(zones[zi], x, z)) continue;
      const { data, first, minSlope } = lines[used.indexOf(zoneMark[zi])];
      if (!(minSlope > 0)) continue;
      // Lines from cameras further away than this rise above the tree before reaching it.
      const reach = (caps[k] - eye) / minSlope + r;
      for (let i = 0; i < nCam; i++) {
        const dx = x - camX[i];
        const dz = z - camZ[i];
        if (dx * dx + dz * dz > reach * reach) continue;
        for (let j = first[i] * 4; j < first[i + 1] * 4; j += 4) {
          const along = dx * data[j] + dz * data[j + 1];
          const off = (dx * data[j + 1] - dz * data[j]) / r;
          if (along <= 0 || along >= data[j + 2] || off * off >= 1) continue;
          const dome = base + (1 - base) * Math.sqrt(1 - off * off);
          caps[k] = Math.min(caps[k], (eye + data[j + 3] * along) / dome);
        }
      }
    }
  });
  return caps;
}
