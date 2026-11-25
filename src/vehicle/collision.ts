import { CONFIG } from '../config';
import { yawFromDir, type Route } from '../route/Route';
import type { Vehicle } from './Vehicle';

const HALF_L = CONFIG.vehicle.length / 2;
const HALF_W = CONFIG.vehicle.width / 2;
/** Corners closer than this to a boundary count as touching, so sliding contact is continuous. */
const SKIN = 0.03;
/** [forward, right] signs of the four box corners. */
const CORNERS = [
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
] as const;

/** Writes the 4 corners of the collision box as [x0, z0, x1, z1, ...] (front-left, front-right, rear-right, rear-left). */
export function carCorners(x: number, z: number, yaw: number, out = new Float64Array(8)): Float64Array {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = -fz;
  const rz = fx;
  for (let k = 0; k < 4; k++) {
    const [a, b] = CORNERS[k];
    out[2 * k] = x + fx * HALF_L * a + rx * HALF_W * b;
    out[2 * k + 1] = z + fz * HALF_L * a + rz * HALF_W * b;
  }
  return out;
}

function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

const corners = new Float64Array(8);
const tan = { x: 0, z: 0 };

/**
 * Keeps the collision box inside the drivable carriageway [dMin, dMax] and between the
 * route ends. Analytic (route projection of the corners), so it cannot tunnel. On contact
 * the outward velocity is removed, the along-wall part kept (reduced on fresh impacts and
 * by scraping) and, for the side walls, the heading turned toward the wall so the car
 * slides along it. Returns true when the car touched a boundary.
 */
export function resolveRoadContact(v: Vehicle, route: Route, dt: number): boolean {
  const C = CONFIG.collision;
  const sLo = C.startMargin;
  const sHi = route.length - C.endMargin;
  let touching = false;
  for (let iter = 0; iter < 3; iter++) {
    carCorners(v.x, v.z, v.yaw, corners);
    let over = -Infinity;
    let under = -Infinity;
    let back = -Infinity;
    let front = -Infinity;
    for (let k = 0; k < 4; k++) {
      const p = route.project(corners[2 * k], corners[2 * k + 1], v.s, 20);
      over = Math.max(over, p.d - route.dMax);
      under = Math.max(under, route.dMin - p.d);
      back = Math.max(back, sLo - p.s);
      front = Math.max(front, p.s - sHi);
    }
    const first = iter === 0;
    if (Math.max(over, under, back, front) <= (first ? -SKIN : 0)) break;
    touching = true;
    route.tangentAt(route.clampS(v.s), tan);
    if (over > -SKIN || under > -SKIN) {
      const side = over >= under ? 1 : -1;
      push(v, -tan.z * side, tan.x * side, Math.max(over, under), dt, first, true);
    }
    if (back > -SKIN) push(v, -tan.x, -tan.z, back, dt, first, false);
    if (front > -SKIN) push(v, tan.x, tan.z, front, dt, first, false);
  }
  return touching;
}

/**
 * Pushes the car by `pen` (if positive) against the outward wall normal (nx, nz); on the
 * first iteration also applies the velocity response when the car moves into the wall.
 */
function push(v: Vehicle, nx: number, nz: number, pen: number, dt: number, respond: boolean, align: boolean): void {
  const C = CONFIG.collision;
  if (pen > 0) {
    v.x -= nx * (pen + 1e-3);
    v.z -= nz * (pen + 1e-3);
  }
  if (!respond) return;
  const fx = -Math.sin(v.yaw);
  const fz = -Math.cos(v.yaw);
  const vn = v.speed * (fx * nx + fz * nz);
  if (vn <= 0) return;
  const tx = -nz;
  const tz = nx;
  const vt = v.speed * (fx * tx + fz * tz);
  const sinA = Math.min(1, vn / Math.max(1e-6, Math.abs(v.speed)));
  let along = Math.abs(vt);
  if (v.sinceContact > C.impactCooldown && vn > C.impactMinSpeed) {
    along *= C.wallFriction * (1 - C.impactSlowdown * sinA);
    v.impact = Math.max(v.impact, vn);
  }
  along = Math.max(0, along - (C.scrapeDecel + C.scrapeDrag * along) * dt);
  const dir = Math.sign(v.speed) * (vt >= 0 ? 1 : -1);
  v.speed = Math.sign(v.speed) * along;
  if (!align) return;
  const target = yawFromDir(dir * tx, dir * tz);
  const diff = wrapAngle(target - v.yaw);
  const maxTurn = C.alignRate * dt;
  v.yaw += Math.abs(diff) <= maxTurn ? diff : Math.sign(diff) * maxTurn;
}
