import { existsSync } from 'node:fs';
import { chromium, defineConfig, devices } from '@playwright/test';

const PORT = 5177;

// The bundled Chromium is optional (`npx playwright install chromium`). Without it we use
// the system Google Chrome, whose headless mode renders WebGL 2 through ANGLE/Metal on macOS.
// PW_CHANNEL overrides the choice (e.g. PW_CHANNEL=chromium or PW_CHANNEL=chrome).
const channel = process.env.PW_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'chrome');
const gpuArgs = process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        channel,
        launchOptions: { args: gpuArgs },
      },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
