import type { Route } from '../../route/Route';
import type { Landmark, Vec2 } from '../../route/types';

export interface LandmarkSite {
  id: string;
  x: number;
  z: number;
  /** rotation.y; the landmark's local +z (main facade) faces (sin yaw, 0, cos yaw). */
  yaw: number;
  /** Half extents of the exclusion rectangle in local x / z (m). */
  hx: number;
  hz: number;
  /** Extra exclusion in front of the main facade (local +z), e.g. a plaza. */
  front?: number;
  height: number;
  data?: Landmark;
}

const DEFAULT_HEIGHT: Record<string, number> = {
  pingan: 599,
  civic_center: 60,
  tencent: 193,
  eiffel: 108,
  lianhuashan: 106,
  kk100: 442,
};

/** Principal axis angle of a footprint (radians, of the long axis in the x-z plane). */
function principalAxis(fp: Vec2[]): { ax: number; az: number; long: number; short: number } {
  let cx = 0;
  let cz = 0;
  for (const p of fp) {
    cx += p[0];
    cz += p[1];
  }
  cx /= fp.length;
  cz /= fp.length;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of fp) {
    const x = p[0] - cx;
    const z = p[1] - cz;
    sxx += x * x;
    szz += z * z;
    sxz += x * z;
  }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ax = Math.cos(ang);
  const az = Math.sin(ang);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of fp) {
    const x = p[0] - cx;
    const z = p[1] - cz;
    const u = x * ax + z * az;
    const v = -x * az + z * ax;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  return { ax, az, long: maxU - minU, short: maxV - minV };
}

function longestEdge(fp: Vec2[]): Vec2 {
  let best = 0;
  let dir: Vec2 = [1, 0];
  for (let i = 0; i < fp.length; i++) {
    const p = fp[i];
    const q = fp[(i + 1) % fp.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l > best) {
      best = l;
      dir = [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    }
  }
  return dir;
}

/** yaw whose local +z points along (fx, fz). */
function yawFacing(fx: number, fz: number): number {
  return Math.atan2(fx, fz);
}

let cache: { route: Route; sites: Map<string, LandmarkSite> } | null = null;

/**
 * Resolves where each landmark stands: from route.data.landmarks when present
 * (OSM, already cut-transformed), otherwise a plausible spot along the route.
 */
export function resolveLandmarkSites(route: Route): Map<string, LandmarkSite> {
  if (cache && cache.route === route) return cache.sites;
  const sites = new Map<string, LandmarkSite>();
  const byId = new Map<string, Landmark>();
  for (const l of route.data.landmarks ?? []) byId.set(l.id, l);
  const L = route.length;
  const turn = route.data.turn;
  const finishS = route.data.finish?.s ?? L;

  const fromRoute = (id: string, s: number, d: number, hx: number, hz: number, facing: 'street' | 'south-of-road' = 'street') => {
    const p = route.pointAt(s, d);
    const t = route.tangentAt(s);
    let yaw: number;
    if (facing === 'street') {
      // Face the road: local +z toward the centerline.
      const n = route.normalAt(s);
      const sign = d > 0 ? -1 : 1;
      yaw = yawFacing(n.x * sign, n.z * sign);
    } else {
      yaw = yawFacing(-t.x, -t.z);
    }
    sites.set(id, { id, x: p.x, z: p.z, yaw, hx, hz, height: DEFAULT_HEIGHT[id] ?? 50 });
  };

  const fromData = (l: Landmark, hxDef: number, hzDef: number, southFacing = false) => {
    let yaw = route.headingAt(Math.max(0, Math.min(L, l.s)));
    let hx = hxDef;
    let hz = hzDef;
    if (l.footprint && l.footprint.length >= 3) {
      const pa = principalAxis(l.footprint);
      hx = Math.max(hxDef * 0.5, pa.long / 2);
      hz = Math.max(hzDef * 0.5, pa.short / 2);
      if (!southFacing) {
        // Square-ish towers: PCA is unstable, align with the longest footprint edge instead.
        const e = longestEdge(l.footprint);
        pa.ax = e[0];
        pa.az = e[1];
      }
      // Local +x = long axis; local +z = the perpendicular, chosen to face south (+z world).
      let fx = -pa.az;
      let fz = pa.ax;
      if (southFacing && fz < 0) {
        fx = -fx;
        fz = -fz;
      }
      yaw = yawFacing(fx, fz);
    }
    sites.set(l.id, { id: l.id, x: l.x, z: l.z, yaw, hx, hz, height: l.height ?? DEFAULT_HEIGHT[l.id] ?? 50, data: l });
  };

  const pa = byId.get('pingan');
  if (pa) fromData(pa, 34, 34);
  else fromRoute('pingan', Math.max(0, (turn?.s0 ?? L) - 600), 120, 34, 34);

  const cc = byId.get('civic_center');
  if (cc) fromData(cc, 240, 70, true);
  else {
    const s = Math.min(L, finishS + 40);
    const t = route.tangentAt(s);
    const p = route.pointAt(s, -300);
    sites.set('civic_center', {
      id: 'civic_center',
      x: p.x,
      z: p.z,
      yaw: yawFacing(-t.x, -t.z),
      hx: 245,
      hz: 75,
      height: DEFAULT_HEIGHT.civic_center,
    });
  }

  sites.get('civic_center')!.front = 180;

  const tc = byId.get('tencent');
  if (tc) fromData(tc, 26, 20);
  else fromRoute('tencent', Math.min(150, L * 0.05), -80, 26, 20);

  const ef = byId.get('eiffel');
  if (ef) fromData(ef, 22, 22);
  else {
    const oct = route.data.sections.find((x) => x.id === 'oct');
    fromRoute('eiffel', oct ? (oct.s0 + oct.s1) / 2 : L * 0.35, 150, 22, 22);
  }

  const lh = byId.get('lianhuashan');
  if (lh) fromData(lh, 420, 420);
  else {
    const civic = sites.get('civic_center')!;
    // North of the Civic Center (north = -z).
    sites.set('lianhuashan', { id: 'lianhuashan', x: civic.x, z: civic.z - 950, yaw: 0, hx: 420, hz: 420, height: 106 });
  }

  const kk = byId.get('kk100') ?? byId.get('kingkey100');
  if (kk) fromData({ ...kk, id: 'kk100' }, 35, 35);

  cache = { route, sites };
  return sites;
}

/** True when (x, z) lies within `margin` m of a landmark's exclusion rectangle (hill excluded). */
export function insideLandmarkSite(sites: Map<string, LandmarkSite>, x: number, z: number, margin = 0): boolean {
  for (const site of sites.values()) {
    if (site.id === 'lianhuashan') continue;
    const dx = x - site.x;
    const dz = z - site.z;
    const c = Math.cos(site.yaw);
    const s = Math.sin(site.yaw);
    // local x axis = (cos yaw, -sin yaw), local z axis = (sin yaw, cos yaw)
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    const zMax = site.hz + (site.front ?? 0) + margin;
    if (Math.abs(lx) < site.hx + margin && lz > -site.hz - margin && lz < zMax) return true;
  }
  return false;
}
