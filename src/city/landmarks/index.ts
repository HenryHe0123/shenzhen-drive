import type { SceneryModule, WorldContext } from '../../game/contracts';

/**
 * Hand-built landmarks: Civic Center, Ping An Finance Center, Tencent Building,
 * Window of the World Eiffel replica, Lianhuashan. Placeholder: nothing.
 */
export async function createLandmarks(_ctx: WorldContext): Promise<SceneryModule> {
  return { update() {} };
}
