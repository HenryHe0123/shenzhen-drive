import { CONFIG } from '../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../game/contracts';
import { loadJson } from '../route/Route';
import type { CityModelsData } from '../route/types';
import { createBuildings } from './buildings';
import { createLandmarks } from './landmarks';
import { createCityModels } from './models';
import { createProps } from './props';
import { createRoad } from './road';
import { createScreens } from './screens';

/**
 * public/data/city_models.json, or null. ?noCityModels turns the real-building
 * models off (before/after comparisons); in dev, ?cityModels=<url> loads another file.
 */
function loadCityModels(): Promise<CityModelsData | null> {
  const params = new URLSearchParams(location.search);
  if (params.has('noCityModels')) return Promise.resolve(null);
  const override = import.meta.env.DEV ? params.get('cityModels') : null;
  return loadJson<CityModelsData>(override ?? import.meta.env.BASE_URL + CONFIG.data.cityModelsUrl).catch(() => null);
}

/** Builds all static scenery along the route. */
export async function createCity(baseCtx: WorldContext): Promise<SceneryModule> {
  const cityModels = baseCtx.cityModels !== undefined ? baseCtx.cityModels : await loadCityModels();
  const ctx: WorldContext = { ...baseCtx, cityModels };
  const modules = await Promise.all([
    createRoad(ctx),
    createProps(ctx),
    createBuildings(ctx),
    createLandmarks(ctx),
    createCityModels(ctx),
    createScreens(ctx),
  ]);
  return {
    update(frame: FrameInfo) {
      for (const m of modules) m.update(frame);
    },
    dispose() {
      for (const m of modules) m.dispose?.();
    },
  };
}
