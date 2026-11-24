import type { Turn } from '../route/types';

/** Distance before turn.s0 at which the next-turn hint appears (m). */
export const TURN_HINT_DISTANCE = 1200;
/** Comfortable cornering acceleration used for the safe speed (m/s^2): v_safe = sqrt(a · R). */
export const TURN_SAFE_LAT_ACCEL = 10;
/** Braking deceleration assumed for the slow-down warning (m/s^2). */
export const TURN_WARN_DECEL = 15;
/** Extra margin added to the braking distance (m). */
export const TURN_WARN_MARGIN = 80;
/** Radius assumed when a turn has none (m). */
export const TURN_DEFAULT_RADIUS = 30;

export interface TurnHint {
  name: string;
  direction: 'left' | 'right';
  /** Meters to the turn entry, 0 inside the turn. */
  distance: number;
  /** Safe entry speed, rounded down to 5 km/h. */
  safeKmh: number;
  /** Speed above the safe speed while the turn is within braking distance. */
  slowDown: boolean;
}

export function safeTurnSpeed(turn: Turn): number {
  return Math.sqrt(TURN_SAFE_LAT_ACCEL * (turn.radius ?? TURN_DEFAULT_RADIUS));
}

/** Hint for `turn` (normally route.nextTurn(s)) at arc length s and speed (m/s); null hides it. */
export function turnHint(turn: Turn | null, s: number, speed: number): TurnHint | null {
  if (!turn || s >= turn.s1) return null;
  const toTurn = turn.s0 - s;
  if (toTurn > TURN_HINT_DISTANCE) return null;
  const vSafe = safeTurnSpeed(turn);
  const v = Math.max(0, speed);
  const brakeDist = (v * v - vSafe * vSafe) / (2 * TURN_WARN_DECEL) + TURN_WARN_MARGIN;
  return {
    name: turn.name,
    direction: turn.direction,
    distance: Math.max(0, toTurn),
    safeKmh: Math.floor((vSafe * 3.6) / 5) * 5,
    slowDown: v > vSafe && toTurn <= brakeDist,
  };
}
