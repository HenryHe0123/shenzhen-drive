import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: '127.0.0.1' },
  // Pre-bundle every three entry point up front; discovering one mid-session makes
  // Vite re-optimize and the page ends up with two copies of three.
  optimizeDeps: {
    include: [
      'three',
      'postprocessing',
      'three/examples/jsm/controls/OrbitControls.js',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
    ],
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never);
