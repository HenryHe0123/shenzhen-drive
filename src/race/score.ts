import { CONFIG } from '../config';

/** Penalty seconds for the heavy and severe wall impacts of a run. */
export function penaltySeconds(heavy: number, severe: number): number {
  return heavy * CONFIG.race.penaltyHeavy + severe * CONFIG.race.penaltySevere;
}

/** Final score: the driven time plus the wall-impact penalties (s). */
export function finalScore(time: number, heavy: number, severe: number): number {
  return time + penaltySeconds(heavy, severe);
}
