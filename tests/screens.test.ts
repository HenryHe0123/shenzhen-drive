import { describe, expect, it } from 'vitest';
import { getRoadLayout, inJunction, SIDE } from '../src/city/road/layout';
import { ringsOverlap } from '../src/city/screens/geom';
import { placePylons, segmentHitsFace, type PylonPlacement } from '../src/city/screens/pylons';
import { CONFIG } from '../src/config';
import { Route } from '../src/route/Route';
import type { BuildingsData, CityModelsData, RouteData } from '../src/route/types';

const first = <T>(g: Record<string, T>): T | null => Object.values(g)[0] ?? null;
const routeJson = first(import.meta.glob<RouteData>('../public/data/route.json', { eager: true, import: 'default' }));
const buildingsJson = first(
  import.meta.glob<BuildingsData>('../public/data/buildings.json', { eager: true, import: 'default' }),
);
const modelsJson = first(
  import.meta.glob<CityModelsData>('../public/data/city_models.json', { eager: true, import: 'default' }),
);

const S = CONFIG.screens;

/** Footprint outline sampled every ~1 m. */
function outline(p: PylonPlacement): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = p.footprint[i];
    const [bx, bz] = p.footprint[(i + 1) % 4];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az));
    for (let k = 0; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return pts;
}

describe('segmentHitsFace', () => {
  const face = { x: 0, z: 0, nx: 0, nz: 1, width: 10, height: 5, bottom: 20 } as PylonPlacement;
  it('hits through the face and misses beside, below and above it', () => {
    expect(segmentHitsFace(face, [0, 22, 10], [0, 22, -10])).toBe(true);
    expect(segmentHitsFace(face, [8, 22, 10], [8, 22, -10])).toBe(false);
    expect(segmentHitsFace(face, [0, 10, 10], [0, 10, -10])).toBe(false);
    expect(segmentHitsFace(face, [0, 30, 10], [0, 30, -10])).toBe(false);
    expect(segmentHitsFace(face, [0, 22, 10], [0, 22, 1])).toBe(false);
  });
});

describe.skipIf(!routeJson || !buildingsJson)('APEC roadside screens', () => {
  const route = new Route(routeJson!);
  const l = getRoadLayout(route);
  const { placed, skipped } = placePylons(route, buildingsJson, modelsJson, S.windows, S);

  it('places one screen in every window', () => {
    if (skipped.length) console.info('[screens] skipped', skipped);
    for (const p of placed) {
      console.info(
        `[screens] ${p.window}: s ${p.s.toFixed(0)} d ${p.d.toFixed(1)} ${p.side}, yaw ${p.yawDeg}°, ` +
          `seen from ${p.visible.join('/')} m (over the tree model ${p.overTrees.join('/') || '-'})`,
      );
    }
    expect(placed.map((p) => p.window)).toEqual(S.windows.map((w) => w.name));
  });

  it('keeps each screen inside its window, facing approaching traffic above the canopy', () => {
    for (const p of placed) {
      const w = S.windows.find((x) => x.name === p.window)!;
      expect(p.s).toBeGreaterThanOrEqual(w.s0);
      expect(p.s).toBeLessThanOrEqual(w.s1);
      expect(p.yawDeg).toBeGreaterThanOrEqual(15);
      expect(p.yawDeg).toBeLessThanOrEqual(30);
      const t = route.tangentAt(p.s);
      const toward = -(p.nx * t.x + p.nz * t.z);
      expect(toward).toBeCloseTo(Math.cos((p.yawDeg * Math.PI) / 180), 6);
      // Turned toward the carriageway: the normal has a lateral component pointing at the road.
      const lateral = p.nx * -t.z + p.nz * t.x;
      expect(Math.sign(lateral)).toBe(p.d > 0 ? -1 : 1);
      expect(p.bottom).toBeGreaterThanOrEqual(14);
      expect(p.visible.length).toBeGreaterThanOrEqual(S.minVisible);
    }
  });

  it('keeps every footprint off the carriageways, sidewalks, median and junctions', () => {
    for (const p of placed) {
      for (const [x, z] of outline(p)) {
        const pr = route.project(x, z, p.s, 400);
        expect(inJunction(l, pr.s)).toBe(false);
        if (p.side === 'right') expect(pr.d).toBeGreaterThanOrEqual(l.edgeR + SIDE.walk[1]);
        else expect(pr.d).toBeLessThanOrEqual(l.opp(pr.s) - 7.3 - SIDE.walk[1]);
      }
    }
  });

  it('keeps every footprint out of the clear zones and off landmark and real-building footprints', () => {
    const zones = (routeJson!.clearZones ?? []).filter((z) => z.length >= 3);
    const solids = [
      ...(routeJson!.landmarks ?? []).flatMap((m) => (m.footprint && m.footprint.length >= 3 ? [m.footprint] : [])),
      ...(modelsJson?.models ?? []).map((m) => m.footprint).filter((f) => f.length >= 3),
    ];
    for (const p of placed) {
      for (const z of zones) expect(ringsOverlap(p.footprint, z)).toBe(false);
      for (const f of solids) expect(ringsOverlap(p.footprint, f)).toBe(false);
    }
  });

  it('does not cut the chase camera’s sight lines to the landmarks on the approach', () => {
    const marks = (routeJson!.landmarks ?? []).filter((m) => (m.height ?? 0) > 0);
    for (const p of placed) {
      for (let back = S.landmarkBackMin; back <= S.landmarkBackMax; back += 10) {
        const v = route.pointAt(Math.max(0, p.s - back - CONFIG.camera.distance), 1.75);
        for (const m of marks) {
          for (const f of [0.5, 0.8]) expect(segmentHitsFace(p, [v.x, CONFIG.camera.height, v.z], [m.x, (m.height ?? 0) * f, m.z])).toBe(false);
        }
      }
    }
  });

  it('is deterministic', () => {
    expect(placePylons(route, buildingsJson, modelsJson, S.windows, S)).toEqual({ placed, skipped });
  });
});
