import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '.yarn/.vite-cache',
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FreeSync',
      fileName: 'free-sync',
      formats: ['es', 'cjs'],
    },
  },
});
