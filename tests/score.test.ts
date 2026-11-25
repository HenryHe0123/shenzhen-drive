import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { finalScore, penaltySeconds } from '../src/race/score';

describe('final score', () => {
  it('adds 5 s per heavy and 10 s per severe wall impact', () => {
    expect(CONFIG.race.penaltyHeavy).toBe(5);
    expect(CONFIG.race.penaltySevere).toBe(10);
    expect(penaltySeconds(0, 0)).toBe(0);
    expect(penaltySeconds(1, 1)).toBe(15);
    expect(penaltySeconds(3, 2)).toBe(35);
    expect(finalScore(220.5, 1, 1)).toBeCloseTo(235.5, 9);
    expect(finalScore(220.5, 0, 0)).toBe(220.5);
  });
});
