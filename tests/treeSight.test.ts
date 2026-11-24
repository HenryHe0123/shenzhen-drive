import { describe, expect, it } from 'vitest';
import { treeSightCaps } from '../src/city/props/treeSight';
import { CONFIG } from '../src/config';
import { Route } from '../src/route/Route';
import { makeSyntheticRoute } from '../src/route/synthetic';
import type { Landmark, Vec2 } from '../src/route/types';

// The synthetic route's first 700 m run east along +x from the origin; +z is the right-hand side.
const TOWER_H = 300;
const tower: Landmark = { id: 'tower', name: 'tower', x: 2000, z: 300, s: 2000, d: 300, height: TOWER_H };
const zone: Vec2[] = [
  [-10, -5],
  [2100, -5],
  [2100, 400],
  [-10, 400],
];
const routeWith = (clearZones?: Vec2[][]) => new Route({ ...makeSyntheticRoute(), landmarks: [tower], clearZones });
const tree = (x: number, z: number) => ({ x, z, h: 11, r: 5 });

// 30 m along the sight line from the chase camera of route s = 200 to the tower.
const cam = { x: 200 - CONFIG.camera.distance, z: 1.75 };
const len = Math.hypot(tower.x - cam.x, tower.z - cam.z);
const onLine = tree(cam.x + ((tower.x - cam.x) / len) * 30, cam.z + ((tower.z - cam.z) / len) * 30);

describe('treeSightCaps', () => {
  it('caps a tree on a landmark sight line below the line, leaves the others alone', () => {
    const [capped, offLine, outside] = treeSightCaps(routeWith([zone]), [onLine, tree(100, 380), tree(onLine.x, -20)], 0.2, 0.3);
    const lineHeight = CONFIG.camera.height + ((TOWER_H * 0.8 - CONFIG.camera.height) * 30) / len;
    expect(capped).toBeLessThanOrEqual(lineHeight + 1e-3);
    expect(capped).toBeGreaterThan(2);
    expect(offLine).toBe(11);
    expect(outside).toBe(11);
  });

  it('caps less when less of the landmark has to stay visible', () => {
    const route = routeWith([zone]);
    const [most] = treeSightCaps(route, [onLine], 0.5, 0.3);
    const [least] = treeSightCaps(route, [onLine], 0.05, 0.3);
    expect(most).toBeLessThan(least);
  });

  it('keeps every tree when the route has no clear zones', () => {
    expect([...treeSightCaps(routeWith(undefined), [onLine], 0.2, 0.3)]).toEqual([11]);
  });
});
