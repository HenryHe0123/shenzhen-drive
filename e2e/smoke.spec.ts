import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { makeSyntheticRoute } from '../src/route/synthetic';

type Phase = 'loading' | 'menu' | 'countdown' | 'racing' | 'finished';

interface GameState {
  phase: Phase;
  time: number;
  speed: number;
  x: number;
  z: number;
  yaw: number;
  s: number;
  d: number;
  checkpointsPassed: number;
  checkpointCount: number;
  fps: number;
}

/** Test hooks published by the game as window.__SZD__. */
interface Hooks {
  ready: boolean;
  getState(): GameState;
  teleport(s: number): void;
}

type HookWindow = Window & { __SZD__?: Hooks };

const getState = (page: Page) => page.evaluate(() => (window as HookWindow).__SZD__!.getState());

const describe = (st: GameState) =>
  `${st.phase} t=${st.time.toFixed(2)} s=${st.s.toFixed(1)} d=${st.d.toFixed(2)} v=${st.speed.toFixed(1)} ` +
  `cp=${st.checkpointsPassed}/${st.checkpointCount} fps=${Math.round(st.fps)}`;

/** finish.s of the route the game loads: public/data/route.json, else the synthetic placeholder. */
async function finishS(page: Page): Promise<number> {
  const res = await page.request.get('/data/route.json');
  if (res.ok()) {
    try {
      const data = await res.json();
      if (typeof data?.finish?.s === 'number') return data.finish.s;
    } catch {
      // Missing file: the dev server's SPA fallback answers with index.html.
    }
  }
  return makeSyntheticRoute().finish.s;
}

test('menu → countdown → drive → reset → finish, without console errors', async ({ page }, testInfo) => {
  const evidence = (name: string) => path.join(testInfo.project.testDir, '..', 'evidence', name);
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location().url;
    if (/favicon\.ico$/.test(url)) return;
    errors.push(`console.error: ${msg.text()}${url ? ` (${url})` : ''}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  let loads = 0;
  page.on('load', () => loads++);
  // Answer Vite's HMR socket with a silent mock so source edits made while the test runs
  // cannot hot-reload the page mid-race.
  await page.routeWebSocket((url) => url.searchParams.has('token'), () => {});

  await page.goto('/');
  // Vite may reload the page once while it optimizes dependencies on a cold start.
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__SZD__?.ready === true).catch(() => false), {
      message: 'window.__SZD__.ready',
      timeout: 60_000,
    })
    .toBe(true);
  const loadsAtReady = loads;
  const noReload = () =>
    expect(loads, 'page reloaded mid-test (Vite full reload after a source edit?)').toBe(loadsAtReady);
  await expect(page.locator('#start-btn')).toBeVisible();
  await page.screenshot({ path: evidence('smoke-01-menu.png') });

  await page.click('#start-btn');
  await expect.poll(async () => (await getState(page)).phase, { timeout: 20_000 }).toBe('racing');
  const start = await getState(page);
  console.log('[smoke] racing:', describe(start));

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  const driving = await getState(page);
  console.log('[smoke] after 4 s of W:', describe(driving));
  noReload();
  expect(driving.speed, describe(driving)).toBeGreaterThan(10);
  expect(driving.s, describe(driving)).toBeGreaterThan(start.s);
  await expect(page.locator('#hud')).toBeVisible();
  await page.screenshot({ path: evidence('smoke-02-driving.png') });

  await page.keyboard.press('KeyA', { delay: 150 });
  await page.keyboard.press('KeyD', { delay: 150 });
  await page.keyboard.up('KeyW');
  const steered = await getState(page);
  expect(Number.isFinite(steered.yaw) && Number.isFinite(steered.x) && Number.isFinite(steered.z)).toBe(true);

  // R returns to the last checkpoint; the clock keeps running.
  const beforeReset = await getState(page);
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(600);
  const afterReset = await getState(page);
  console.log('[smoke] after R:', describe(afterReset));
  noReload();
  expect(afterReset.phase).toBe('racing');
  expect(afterReset.time, 'time must not reset on R').toBeGreaterThan(beforeReset.time);

  const fs = await finishS(page);
  await page.evaluate((s) => (window as HookWindow).__SZD__!.teleport(s), fs - 60);
  await page.keyboard.down('KeyW');
  await expect
    .poll(async () => describe(await getState(page)), { message: `drive to the finish (s=${fs})`, timeout: 30_000 })
    .toMatch(/^finished/);
  await page.keyboard.up('KeyW');
  console.log('[smoke] finished:', describe(await getState(page)));
  noReload();

  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#result-time')).toHaveText(/\d\d:\d\d\.\d\d/);
  await page.screenshot({ path: evidence('smoke-03-result.png') });

  expect(errors).toEqual([]);
});
