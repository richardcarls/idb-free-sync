/**
 * Build-time replacement for `node-fetch`.
 *
 * The Dropbox SDK's ES build keeps a `require('node-fetch')` fallback inside
 * its runtime environment detection. That branch is unreachable in browsers
 * (window/worker `fetch` always wins — and `dropboxAdapter` passes
 * `globalThis.fetch` explicitly besides), but the bare specifier survives
 * into our bundle and trips consumers' dependency scanners. This library is
 * browser-only, so the build aliases `node-fetch` here instead.
 */
export default globalThis.fetch;
