import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Build info shown in the menus and the HUD corner: package.json version (single source of
// truth), short commit and local build date, fixed when the dev server / build starts.
const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}
const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const buildDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

export default defineConfig({
  server: { port: 5173, host: '127.0.0.1' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILD_DATE__: JSON.stringify(buildDate),
  },
  // Pre-bundle every three entry point up front; discovering one mid-session makes
  // Vite re-optimize and the page ends up with two copies of three.
  optimizeDeps: {
    include: [
      'three',
      'postprocessing',
      'three/examples/jsm/controls/OrbitControls.js',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/HDRLoader.js',
      'three/examples/jsm/libs/meshopt_decoder.module.js',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
    ],
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never);
