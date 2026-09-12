# @rcarls/idb-free-sync

## 0.9.0

### Minor Changes

- 74655dc: Reconcile blob references for equal records and report structured integrity
  errors instead of persisting records whose blobs are unavailable locally and
  remotely.
- d576aa9: Use host-provided token callbacks for Google Drive, OneDrive, and Dropbox
  transports. This pre-1.0 breaking change removes built-in interactive OAuth.
  Google Drive and OneDrive now call their REST APIs directly and advertise only
  the data scopes each transport requires.
- 8951d17: Add `signal`, `onBeforeWrite`, and `onItemSettled` to `SyncOptions`.
  `signal` cancels a run in progress: already-started queue items still settle,
  nothing further starts, and skipped items report a rejected `AbortError`.
  `onBeforeWrite` fires just before each
  local write with the record's prior value (or `undefined` for a new
  record), for callers building an undo log. `onItemSettled` reports each queue
  item's outcome, download/upload/delete, fulfilled or rejected. Observer errors
  are logged without changing item outcomes or suppressing later events.

  `syncStore`'s write queues now run through a bounded-concurrency pool
  instead of starting every item at once, required for `signal` to actually
  stop queued work that hasn't started, and a smaller request burst against
  sync providers as a side effect.

### Patch Changes

- fc739cf: Accept schema-typed `IDBPDatabase` instances in `syncStore`.

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
