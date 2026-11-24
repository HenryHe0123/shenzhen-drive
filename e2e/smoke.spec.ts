import { statSync } from 'node:fs';
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
  paused: boolean;
  minimap: 'overview' | 'local';
  recording: { enabled: boolean; status: string; active: boolean; mimeType: string; bytes: number; duration: number };
}

/** Test hooks published by the game as window.__SZD__. */
interface Hooks {
  ready: boolean;
  version: string;
  getState(): GameState;
  teleport(s: number): void;
  pause(): boolean;
  resume(): boolean;
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

test('menu → countdown → drive → pause → reset → finish → download recording, without console errors', async ({ page }, testInfo) => {
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
  await expect(page.locator('#menu-version')).toHaveText(/v\d+\.\d+\.\d+/);
  expect(await page.evaluate(() => (window as HookWindow).__SZD__!.version)).toMatch(/^\d+\.\d+\.\d+$/);
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
  await expect(page.locator('#hud-version')).toHaveText(/v\d+\.\d+\.\d+/);
  expect(driving.recording.active, 'recording starts with the countdown').toBe(true);
  // Minimap: a sized canvas with drawn (non-transparent) pixels.
  await expect(page.locator('#minimap canvas')).toBeVisible();
  const painted = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#minimap canvas')!;
    const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
    return { w: c.width, h: c.height, n };
  });
  expect(painted.w).toBeGreaterThan(0);
  expect(painted.n, `painted minimap pixels of ${painted.w}x${painted.h}`).toBeGreaterThan(500);
  await page.screenshot({ path: evidence('smoke-02-driving.png') });

  // Esc pauses: physics, timer and recording freeze for the whole second; Esc resumes.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await getState(page)).paused).toBe(true);
  await expect(page.locator('#pause')).toBeVisible();
  const p0 = await getState(page);
  await page.waitForTimeout(1000);
  const p1 = await getState(page);
  expect(p1.paused).toBe(true);
  expect(p1.time, 'timer frozen while paused').toBe(p0.time);
  expect(p1.s, 'car frozen while paused').toBe(p0.s);
  expect(p1.recording.status).toBe('paused');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await getState(page)).paused).toBe(false);
  await expect(page.locator('#pause')).toBeHidden();
  await page.waitForTimeout(300);
  expect((await getState(page)).time).toBeGreaterThan(p1.time);
  // Losing focus auto-pauses; the hook resumes.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect((await getState(page)).paused).toBe(true);
  expect(await page.evaluate(() => (window as HookWindow).__SZD__!.resume())).toBe(true);
  expect((await getState(page)).paused).toBe(false);

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

  // The recording keeps running ~2 s past the finish, then the download button appears.
  const download = page.locator('#rec-download');
  await expect(download).toBeEnabled({ timeout: 30_000 });
  await expect(download).toHaveText(/下载录像 · (MP4|WebM) · \d+:\d\d · [\d.]+ MB/);
  await page.screenshot({ path: evidence('smoke-03-result.png') });
  const rec = (await getState(page)).recording;
  console.log('[smoke] recording:', rec.mimeType, `${(rec.bytes / 1e6).toFixed(1)} MB`, `${rec.duration.toFixed(1)} s`);
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toMatch(/^shenzhen-drive-\d{8}-\d{4}-\d\dm\d\ds\d\d\.(mp4|webm)$/);
  const saved = testInfo.outputPath(file.suggestedFilename());
  await file.saveAs(saved);
  expect(statSync(saved).size).toBeGreaterThan(10_000);
  expect(statSync(saved).size).toBe(rec.bytes);

  expect(errors).toEqual([]);
});
