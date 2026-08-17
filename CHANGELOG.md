# @rcarls/idb-free-sync

## 0.8.0

### Minor Changes

- 466d9c0: Add `ArrayBlobFieldConfig` (`kind: 'array'`) to `blobFields`, syncing blobs
  referenced by items of an array record field. Items expose their blob key via
  `itemKey` (returning `undefined` skips the item, for example remote-only entries) and
  an optional per-item `itemContentType`. Array field values are stored as-is on
  both sides; only the referenced blobs are pushed and pulled. Scalar
  `BlobFieldConfig` behavior is unchanged (now accepts an optional
  `kind: 'scalar'` discriminant).

  Build: the bundled Dropbox SDK's Node-only `require('node-fetch')` fallback is
  now replaced with a browser stub at build time, so `dist/dropbox.js` no longer
  references `node-fetch` and consumers' dependency scanners stay clean. The
  Dropbox entry also shrinks substantially (the SDK's dead Node branches now
  tree-shake away).
