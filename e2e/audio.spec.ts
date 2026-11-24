import { expect, test } from '@playwright/test';
import { CONFIG } from '../src/config';

const A = CONFIG.audio;

/**
 * Runs the real AudioEngine in Chrome on a blank same-origin page (Vite serves the module;
 * the game itself is not booted) and measures its output with an AnalyserNode.
 */
test('procedural audio: silent at rest, pitch tracks speed, mute/suspend work', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(err.message));

  await page.route('**/__audio_sandbox', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>audio</title><button id="go">go</button>' }),
  );
  await page.goto('/__audio_sandbox');
  await page.addScriptTag({
    type: 'module',
    content: `
      import { AudioEngine } from '/src/audio/AudioEngine.ts';
      const engine = new AudioEngine();
      // Every call must be a no-op before start().
      engine.update({ dt: 0.016, speed: 20, throttle: 1, braking: false, driving: true });
      engine.collision(1); engine.beep(false); engine.beep(true); engine.chime(false); engine.chime(true);
      engine.setMuted(true); engine.setMuted(false); engine.suspend(); engine.resume();
      const frame = { dt: 0.016, speed: 0, throttle: 0, braking: false, driving: true };
      let analyser = null;
      window.__audio = {
        engine, frame,
        async start() {
          await engine.start();
          const ctx = engine.context;
          analyser = ctx.createAnalyser();
          analyser.fftSize = 8192;
          analyser.smoothingTimeConstant = 0;
          engine.output.connect(analyser);
          setInterval(() => engine.update(frame), 16);
          return ctx.state;
        },
        /** RMS of the mix and the strongest frequency in [lo, hi] Hz over the last ~170 ms. */
        measure(lo = 200, hi = 4000) {
          const t = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(t);
          let sum = 0;
          for (const v of t) sum += v * v;
          const f = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(f);
          const binHz = engine.context.sampleRate / analyser.fftSize;
          let best = -Infinity, peakHz = 0;
          for (let i = Math.ceil(lo / binHz); i <= Math.floor(hi / binHz); i++) {
            if (f[i] > best) { best = f[i]; peakHz = i * binHz; }
          }
          return { rms: Math.sqrt(sum / t.length), peakHz };
        },
      };
    `,
  });
  await page.waitForFunction(() => '__audio' in window);

  await page.click('#go');
  const state = await page.evaluate(() => (window as any).__audio.start());
  expect(state).toBe('running');

  type Measure = { rms: number; peakHz: number };
  const measure = (): Promise<Measure> => page.evaluate(() => (window as any).__audio.measure());
  /**
   * Sets the car state and polls until `done` holds. The analyser trails the live output
   * by ~300 ms (more under CPU load), so fixed sleeps are not reliable.
   */
  const settle = async (speed: number, throttle: number, what: string, done: (m: Measure) => boolean) => {
    await page.evaluate(([v, t]) => Object.assign((window as any).__audio.frame, { speed: v, throttle: t }), [speed, throttle]);
    await expect
      .poll(async () => {
        const m = await measure();
        return done(m) ? 'ok' : JSON.stringify(m);
      }, { message: what, timeout: 8000, intervals: [100] })
      .toBe('ok');
    await page.waitForTimeout(300);
    return measure();
  };
  // Motor fundamental: linear from motorHzMin at rest to motorHzMax at refSpeed (350 km/h).
  const pitched = (v: number) => (m: Measure) => {
    const expected = A.motorHzMin + ((A.motorHzMax - A.motorHzMin) * Math.abs(v)) / A.refSpeed;
    return Math.abs(m.peakHz - expected) / expected < 0.04;
  };

  const rest = await settle(0, 0, 'silent at rest', (m) => m.rms < 1e-3);
  const slow = await settle(10, 1, 'pitch at 10 m/s', pitched(10));
  const cruise = await settle(25, 1, 'pitch at 25 m/s', pitched(25));
  const fast = await settle(40, 1, 'pitch at 40 m/s', pitched(40));
  const top = await settle(95, 1, 'pitch at 95 m/s', pitched(95));
  const reverse = await settle(-5, 1, 'pitch at -5 m/s', pitched(-5));
  console.log('[audio]', JSON.stringify({ rest, slow, cruise, fast, top, reverse }));
  expect(cruise.rms).toBeGreaterThan(0.01);
  expect(fast.rms).toBeGreaterThan(slow.rms);
  expect(top.rms).toBeGreaterThan(fast.rms);
  // still under the limiter's ceiling at 350 km/h with full wind
  expect(top.rms).toBeLessThan(0.5);

  await page.evaluate(() => (window as any).__audio.engine.setMuted(true));
  await settle(40, 1, 'silent while muted', (m) => m.rms < 1e-4);
  await page.evaluate(() => (window as any).__audio.engine.setMuted(false));
  await settle(40, 1, 'audible after unmute', (m) => m.rms > 0.01);

  // One-shots at rest, each starting from silence: the thud and the chimes must be audible.
  const oneShots: [string, number | boolean][] = [
    ['collision', 1],
    ['beep', false],
    ['beep', true],
    ['chime', false],
    ['chime', true],
  ];
  for (const [method, arg] of oneShots) {
    const call = `${method}(${arg})`;
    await settle(0, 0, `silent before ${call}`, (m) => m.rms < 1e-3);
    const peak = await page.evaluate(async ([m, x]) => {
      const a = (window as any).__audio;
      a.engine[m](x);
      let max = 0;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 40));
        max = Math.max(max, a.measure().rms);
      }
      return max;
    }, [method, arg] as const);
    console.log(`[audio] ${call} peak rms ${peak.toFixed(4)}`);
    expect(peak, call).toBeGreaterThan(0.01);
  }

  await page.evaluate(() => (window as any).__audio.engine.suspend());
  await expect.poll(() => page.evaluate(() => (window as any).__audio.engine.context.state)).toBe('suspended');
  await page.evaluate(() => (window as any).__audio.engine.resume());
  await expect.poll(() => page.evaluate(() => (window as any).__audio.engine.context.state)).toBe('running');

  expect(errors).toEqual([]);
});
