import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  cacheDir: '.yarn/.vite-cache',

  resolve: {
    alias: {
      // Browser-only library: replace the Dropbox SDK's Node-only fetch
      // fallback so no `node-fetch` reference reaches dist (see the stub).
      'node-fetch': fileURLToPath(
        new URL('src/internal/nodeFetchStub.ts', import.meta.url),
      ),
    },
  },

  build: {
    lib: {
      entry: {
        'idb-free-sync': 'src/index.ts',
        core: 'src/core.ts',
        google: 'src/GoogleDriveTransport.ts',
        dropbox: 'src/DropboxTransport.ts',
        onedrive: 'src/OneDriveTransport.ts',
        webdav: 'src/WebDAVTransport.ts',
      },
      formats: ['es'],
    },
    // Transform `require()` calls inside dependency ESM (the Dropbox SDK's
    // es build mixes them in) so the node-fetch alias above can apply.
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      external: ['idb'],
    },
  },

  plugins: [dts({ include: ['src/*.ts'] })],
});
