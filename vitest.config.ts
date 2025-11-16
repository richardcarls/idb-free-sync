import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.yarn/.vitest-cache',
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/OPFSTransport.ts', 'src/SyncTransport.ts'],
      thresholds: {
        perFile: true,
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 70,
        'src/SyncOrchestrator.ts': {
          statements: 95,
          lines: 95,
          functions: 95,
          branches: 90,
        },
      },
    },
  },
});
