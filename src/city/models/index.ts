import type { SceneryModule, WorldContext } from '../../game/contracts';

/**
 * Real Shenzhen building models (3D Warehouse, processed offline into
 * public/models/city/) placed from ctx.cityModels. Placeholder: nothing.
 */
export async function createCityModels(_ctx: WorldContext): Promise<SceneryModule> {
  return { update() {} };
}
