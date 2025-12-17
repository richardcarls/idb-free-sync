import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  cacheDir: '.yarn/.vite-cache',

  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FreeSync',
      fileName: 'idb-free-sync',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['idb'],
    },
  },

  plugins: [dts({ include: ['src/*.ts'], insertTypesEntry: true })],
});
