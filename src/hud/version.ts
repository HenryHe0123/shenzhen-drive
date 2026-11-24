export interface BuildInfo {
  /** package.json version, e.g. '0.3.0'. */
  version: string;
  /** Short git commit, 'dev' when git was unavailable at build time. */
  commit: string;
  /** Local build date, YYYY-MM-DD. */
  date: string;
  /** 'v0.3.0 · a1b2c3d · 2026-11-24' */
  label: string;
}

// typeof guards keep this importable where Vite's define did not run (e.g. Playwright specs).
const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
const commit = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';
const date = typeof __APP_BUILD_DATE__ === 'string' ? __APP_BUILD_DATE__ : '';

export const BUILD: BuildInfo = {
  version,
  commit,
  date,
  label: [`v${version}`, commit, date].filter(Boolean).join(' · '),
};
