import { describe, expect, it } from 'vitest';
import { CONFIG, KMH } from '../src/config';
import { safeTurnSpeed, TURN_HINT_DISTANCE, turnHint } from '../src/hud/turnHint';
import { Race, type RaceEvent } from '../src/race/Race';
import { Route } from '../src/route/Route';
import { makeSyntheticRoute } from '../src/route/synthetic';

const DT = 1 / CONFIG.physics.hz;
const data = makeSyntheticRoute();
const course = { checkpoints: data.checkpoints, finish: data.finish, startS: CONFIG.race.startS };

function startedRace(): Race {
  const race = new Race(course);
  race.ready();
  race.begin();
  for (let i = 0; i < 400 && race.phase === 'countdown'; i++) race.update(DT, course.startS, 1);
  expect(race.phase).toBe('racing');
  return race;
}

/** Drives s from a to b at `speed` m/s; returns all events. */
function drive(race: Race, a: number, b: number, speed = 40, forwardDot = 1): RaceEvent[] {
  const events: RaceEvent[] = [];
  const dir = Math.sign(b - a);
  let s = a;
  while ((b - s) * dir > 0) {
    s = dir > 0 ? Math.min(b, s + speed * DT) : Math.max(b, s - speed * DT);
    events.push(...race.update(DT, s, forwardDot));
  }
  return events;
}

describe('race state machine', () => {
  it('runs the countdown with 3-2-1 ticks and GO', () => {
    const race = new Race(course);
    expect(race.phase).toBe('loading');
    race.ready();
    expect(race.phase).toBe('menu');
    race.begin();
    const events: RaceEvent[] = [];
    for (let i = 0; i < 200; i++) events.push(...race.update(DT, course.startS, 1));
    expect(events.filter((e) => e.type === 'tick').map((e) => (e as { value: number }).value)).toEqual([3, 2, 1]);
    expect(events.filter((e) => e.type === 'go')).toHaveLength(1);
    expect(race.phase).toBe('racing');
  });

  it('runs the timer only while racing', () => {
    const race = new Race(course);
    race.ready();
    for (let i = 0; i < 60; i++) race.update(DT, 100, 1);
    expect(race.time).toBe(0);
    race.begin();
    for (let i = 0; i < 120; i++) race.update(DT, course.startS, 1);
    expect(race.phase).toBe('countdown');
    expect(race.time).toBe(0);
    for (let i = 0; i < 120; i++) race.update(DT, course.startS, 1);
    expect(race.phase).toBe('racing');
    expect(race.time).toBeGreaterThan(0.9);
    drive(race, course.startS, data.finish.s + 5);
    expect(race.phase).toBe('finished');
    const t = race.time;
    for (let i = 0; i < 120; i++) race.update(DT, data.finish.s + 10, 1);
    expect(race.time).toBe(t);
    expect(race.finishTime).toBe(t);
  });

  it('passes checkpoints in order and finishes only after all of them', () => {
    const race = startedRace();
    const events = drive(race, course.startS, data.finish.s + 5);
    const cps = events.filter((e) => e.type === 'checkpoint') as Extract<RaceEvent, { type: 'checkpoint' }>[];
    expect(cps.map((e) => e.index)).toEqual(data.checkpoints.map((_, i) => i));
    expect(cps[0].name).toBe(data.checkpoints[0].name);
    expect(events.at(-1)?.type).toBe('finish');
    expect(race.phase).toBe('finished');
  });

  it('cannot finish when checkpoints were skipped', () => {
    const race = startedRace();
    drive(race, course.startS, data.checkpoints[0].s + 10);
    race.syncS(data.finish.s - 20);
    drive(race, data.finish.s - 20, data.finish.s + 10);
    expect(race.passed).toBe(1);
    expect(race.phase).toBe('racing');
  });

  it('ignores wrong-direction crossings', () => {
    const race = startedRace();
    const cp = data.checkpoints[0].s;
    drive(race, cp - 30, cp + 10, 10, -1);
    expect(race.passed).toBe(0);
    drive(race, cp + 10, cp - 10, 10, -1);
    expect(race.passed).toBe(0);
    drive(race, cp - 10, cp + 10, 10, 1);
    expect(race.passed).toBe(1);
  });

  it('resets to the last passed checkpoint without resetting the timer', () => {
    const race = startedRace();
    expect(race.resetS()).toBe(course.startS);
    drive(race, course.startS, data.checkpoints[1].s + 50);
    expect(race.passed).toBe(2);
    const t = race.time;
    const target = race.resetS();
    expect(target).toBe(data.checkpoints[1].s);
    race.syncS(target);
    race.update(DT, target, 1);
    expect(race.time).toBeGreaterThan(t);
    expect(race.passed).toBe(2);
    // driving on from the reset point still requires the remaining checkpoints
    drive(race, target, data.finish.s + 5);
    expect(race.phase).toBe('finished');
  });

  it('interpolates the finish time inside the step', () => {
    const race = startedRace();
    drive(race, course.startS, data.finish.s - 1, 40);
    const t0 = race.time;
    race.update(DT, data.finish.s + 3, 1);
    expect(race.finishTime).toBeCloseTo(t0 + DT * 0.25, 6);
  });

  it('runs through all turns: checkpoints after each turn count in order', () => {
    const route = new Route(data);
    const race = startedRace();
    const events = drive(race, course.startS, data.finish.s + 5, 60);
    const cps = events.filter((e) => e.type === 'checkpoint') as Extract<RaceEvent, { type: 'checkpoint' }>[];
    expect(cps).toHaveLength(data.checkpoints.length);
    for (const t of route.turns) expect(cps.some((e) => data.checkpoints[e.index].s > t.s1)).toBe(true);
    expect(race.phase).toBe('finished');
  });

  it('teleport marks earlier checkpoints passed and flags the run as assisted', () => {
    const race = startedRace();
    race.teleportTo(data.checkpoints[2].s);
    expect(race.passed).toBe(3);
    expect(race.assisted).toBe(true);
    race.begin();
    expect(race.assisted).toBe(false);
    expect(race.passed).toBe(0);
    expect(race.time).toBe(0);
  });
});

describe('next-turn hint', () => {
  const route = new Route(data);
  const [t1, t2] = route.turns;

  it('appears within the hint distance of the next turn and follows route.nextTurn', () => {
    expect(turnHint(route.nextTurn(t1.s0 - TURN_HINT_DISTANCE - 5), t1.s0 - TURN_HINT_DISTANCE - 5, 30)).toBeNull();
    const h = turnHint(route.nextTurn(t1.s0 - 400), t1.s0 - 400, 30)!;
    expect(h).toMatchObject({ name: t1.name, direction: 'right', distance: 400 });
    const inside = turnHint(route.nextTurn(t1.s0 + 5), t1.s0 + 5, 15)!;
    expect(inside.distance).toBe(0);
    expect(inside.name).toBe(t1.name);
    const after = turnHint(route.nextTurn(t1.s1 + 1), t1.s1 + 1, 30)!;
    expect(after.name).toBe(t2.name);
    expect(after.direction).toBe('left');
    expect(turnHint(route.nextTurn(route.turns.at(-1)!.s1 + 1), route.turns.at(-1)!.s1 + 1, 30)).toBeNull();
  });

  it('uses v_safe = sqrt(10 R) (radius fallback 30) and shows it rounded down to 5 km/h', () => {
    expect(safeTurnSpeed({ ...t1, radius: 40 })).toBeCloseTo(20, 9);
    expect(safeTurnSpeed({ ...t1, radius: undefined })).toBeCloseTo(Math.sqrt(300), 9);
    expect(turnHint({ ...t1, radius: 40 }, t1.s0 - 500, 10)!.safeKmh).toBe(70);
    expect(turnHint({ ...t1, radius: 30 }, t1.s0 - 500, 10)!.safeKmh).toBe(60);
  });

  it('warns to slow down only above the safe speed and within braking distance + 80 m', () => {
    const v = 300 * KMH;
    const vSafe = safeTurnSpeed(t1);
    const brake = (v * v - vSafe * vSafe) / 30 + 80;
    expect(turnHint(t1, t1.s0 - brake - 5, v)!.slowDown).toBe(false);
    expect(turnHint(t1, t1.s0 - brake + 5, v)!.slowDown).toBe(true);
    expect(turnHint(t1, t1.s0 - 50, vSafe - 0.5)!.slowDown).toBe(false);
    expect(turnHint(t1, t1.s0 + 2, vSafe + 5)!.slowDown).toBe(true);
    expect(turnHint(t1, t1.s0 - 50, -10)!.slowDown).toBe(false);
  });
});
