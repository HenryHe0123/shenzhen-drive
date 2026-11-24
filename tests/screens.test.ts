import { describe, expect, it } from 'vitest';
import { placeScreens } from '../src/city/screens/placement';
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

describe.skipIf(!routeJson || !buildingsJson)('APEC facade screens', () => {
  const route = new Route(routeJson!);
  const { placed, skipped } = placeScreens(route, buildingsJson, modelsJson, S.windows, S);

  it('places a screen in most windows', () => {
    if (skipped.length) console.info('[screens] skipped', skipped);
    for (const p of placed) {
      console.info(
        `[screens] ${p.window}: osm ${p.buildingId} h ${p.buildingHeight} s ${p.s.toFixed(0)} d ${p.d.toFixed(1)} ${p.side} ` +
          `${p.width.toFixed(1)}×${p.height.toFixed(1)} m @ ${p.bottom.toFixed(1)} m, facing ${p.facingDeg.toFixed(1)}°, blocked ${p.blocked}`,
      );
    }
    expect(placed.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps every screen on a real, unreplaced wall below the roof and inside its window', () => {
    const replaced = new Set((modelsJson?.models ?? []).flatMap((m) => m.replacesOsm));
    const byId = new Map(buildingsJson!.buildings.map((b) => [b.id, b]));
    for (const p of placed) {
      const w = S.windows.find((x) => x.name === p.window)!;
      const b = byId.get(p.buildingId)!;
      expect(b && p.buildingId > 0 && !replaced.has(p.buildingId)).toBe(true);
      expect(p.s).toBeGreaterThanOrEqual(w.s0);
      expect(p.s).toBeLessThanOrEqual(w.s1);
      const dist = p.d > 0 ? p.d : route.oppositeOffsetAt(p.s) - p.d;
      expect(dist).toBeGreaterThanOrEqual(S.minDist);
      expect(dist).toBeLessThanOrEqual(S.maxDist);
      expect(Math.abs(p.facingDeg)).toBeLessThanOrEqual(S.maxFacingDeg);
      expect(p.width).toBeGreaterThanOrEqual(S.minWidth);
      expect(p.height / p.width).toBeCloseTo(16 / 9, 5);
      expect(p.bottom).toBeGreaterThanOrEqual(S.minBottom);
      expect(p.bottom + p.height).toBeLessThanOrEqual(b.h - S.roofGap + 1e-6);
    }
  });

  it('is deterministic', () => {
    expect(placeScreens(route, buildingsJson, modelsJson, S.windows, S)).toEqual({ placed, skipped });
  });
});
