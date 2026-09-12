---
'@rcarls/idb-free-sync': minor
---

Add `signal`, `onBeforeWrite`, and `onItemSettled` to `SyncOptions`.
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
