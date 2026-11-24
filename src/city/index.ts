import { CONFIG } from '../config';
import type { FrameInfo, SceneryModule, WorldContext } from '../game/contracts';
import { loadJson } from '../route/Route';
import type { CityModelsData } from '../route/types';
import { createBuildings } from './buildings';
import { createLandmarks } from './landmarks';
import { createCityModels } from './models';
import { createProps } from './props';
import { createRoad } from './road';

/** Builds all static scenery along the route. */
export async function createCity(baseCtx: WorldContext): Promise<SceneryModule> {
  const cityModels =
    baseCtx.cityModels !== undefined
      ? baseCtx.cityModels
      : await loadJson<CityModelsData>(import.meta.env.BASE_URL + CONFIG.data.cityModelsUrl).catch(() => null);
  const ctx: WorldContext = { ...baseCtx, cityModels };
  const modules = await Promise.all([
    createRoad(ctx),
    createProps(ctx),
    createBuildings(ctx),
    createLandmarks(ctx),
    createCityModels(ctx),
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
