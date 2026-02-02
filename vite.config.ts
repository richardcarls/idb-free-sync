import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  cacheDir: '.yarn/.vite-cache',

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
    rollupOptions: {
      external: ['idb'],
    },
  },

  plugins: [dts({ include: ['src/*.ts'] })],
});
