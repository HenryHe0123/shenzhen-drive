import { CONFIG } from '../config';
import { loadJson, Route } from '../route/Route';
import { makeSyntheticRoute } from '../route/synthetic';
import type { BuildingsData, RouteData } from '../route/types';

export interface WorldData {
  route: Route;
  buildings: BuildingsData | null;
  /** True when route.json was missing and the synthetic placeholder is used. */
  synthetic: boolean;
}

export async function loadWorldData(): Promise<WorldData> {
  const base = import.meta.env.BASE_URL;
  const [routeData, buildings] = await Promise.all([
    loadJson<RouteData>(base + CONFIG.data.routeUrl).catch((e) => {
      console.warn('[world] route.json unavailable, using synthetic route:', e.message);
      return null;
    }),
    loadJson<BuildingsData>(base + CONFIG.data.buildingsUrl).catch(() => null),
  ]);
  return {
    route: new Route(routeData ?? makeSyntheticRoute()),
    buildings,
    synthetic: !routeData,
  };
}
