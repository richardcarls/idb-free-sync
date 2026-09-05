import { type IDBPDatabase } from 'idb';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';
import { type BlobStore } from './BlobStore';
import {
  type BlobSyncTransport,
  isBlobSyncTransport,
} from './BlobSyncTransport';
import { runQueue } from './internal/runQueue';

/**
 * Outcome of a conflict between a local record and its remote counterpart.
 *
 * - `keep-local`  — upload the local record, overwriting remote.
 * - `keep-remote` — download the remote record, overwriting local.
 * - `delete`      — delete the local record and soft-delete remote.
 * - `ignore`      — leave both sides unchanged.
 */
export type ConflictResolution =
  | 'keep-local'
  | 'keep-remote'
  | 'delete'
  | 'ignore';

/** @deprecated Use {@link ConflictResolution}. */
export type ResolveAction = ConflictResolution;

/** Minimum shape a synced record must satisfy. */
export interface SyncRecord {
  modified?: Date;
  [key: string]: unknown;
}

/**
 * Called once per record that exists on both sides. Returns how to resolve the
 * conflict. Records only on one side are handled automatically (upload or
 * download) and never passed to this function.
 */
export type ResolveConflict<T extends SyncRecord = SyncRecord> = (
  localRecord: T,
  remoteInfo: SyncFileInfo,
) => ConflictResolution;

/** @deprecated Use {@link ResolveConflict}. */
export type ConflictResolverCB<T extends SyncRecord = SyncRecord> =
  ResolveConflict<T>;

/**
 * Configures blob sync for a single string record field. The remote JSON
 * stores the raw blob key; `keyFromValue` and `valueFromKey` map between that
 * key and the local field value (e.g. an OPFS app URL).
 */
export interface BlobFieldConfig {
  /** Discriminant; omit (or set `'scalar'`) for single string fields. */
  kind?: 'scalar';

  /** Local storage backend for the binary blob. */
  blobStore: BlobStore;

  /**
   * Extract a stable blob key from the local field value. When omitted the
   * raw field value is used as the key (identity).
   *
   * @example (url) => url.replace('/_cache/', '')  // '/_cache/abc' → 'abc'
   */
  keyFromValue?: (value: string) => string;

  /**
   * Reconstruct the local field value from a blob key. When omitted the raw
   * key is stored in the local record (identity).
   *
   * @example (key) => `/_cache/${key}`  // 'abc' → '/_cache/abc'
   */
  valueFromKey?: (key: string) => string;

  /** MIME type hint passed to the transport on upload. */
  contentType?: string;
}

/**
 * Configures blob sync for a record field holding an **array of items**, where
 * each item may reference a binary blob by key. Items whose `itemKey` returns
 * `undefined` are skipped entirely (e.g. remote-only/hotlinked entries).
 *
 * Unlike {@link BlobFieldConfig}, the field value is never rewritten: items
 * are expected to store the bare blob key, so local and remote JSON are
 * identical. Only the referenced blobs are pushed/pulled.
 */
export interface ArrayBlobFieldConfig<Item = unknown> {
  /** Discriminant selecting array-of-items blob sync. */
  kind: 'array';

  /** Local storage backend for the binary blobs. */
  blobStore: BlobStore;

  /**
   * Extract the blob key from an array item. Return `undefined` to skip the
   * item (no blob is uploaded or downloaded for it).
   *
   * Declared with method syntax so configs typed for a concrete item shape
   * remain assignable to `ArrayBlobFieldConfig<unknown>`.
   *
   * @example (photo) => photo.key
   */
  itemKey(item: Item): string | undefined;

  /**
   * Per-item MIME type hint passed to the transport on upload. When omitted
   * (or returning `undefined`) no hint is sent.
   *
   * @example (photo) => photo.contentType
   */
  itemContentType?(item: Item): string | undefined;
}

/** Any per-field blob sync configuration accepted by `blobFields`. */
export type AnyBlobFieldConfig = BlobFieldConfig | ArrayBlobFieldConfig;

/**
 * Reported immediately before `syncStore` performs a local IDB write for
 * `key` — a `put` (record created or overwritten from the remote side) or a
 * `delete` (record removed following a `'delete'` resolution). `previous` is
 * the record's full local value right before this write, or `undefined`
 * when the write is a create (the key had no local record before this run).
 * Callers use this to build a per-run undo log: replaying these events in
 * reverse (`put` the `previous` value back, or `delete` when `previous` is
 * `undefined`) restores exactly what this run touched, without disturbing
 * any record it didn't.
 */
export interface SyncWriteEvent<T extends SyncRecord = SyncRecord> {
  key: string;
  kind: 'put' | 'delete';
  previous: T | undefined;
}

/**
 * Reported once a single queue item (a download, upload, or delete) has
 * settled, success or failure. `error` is set only when `status` is
 * `'rejected'`. Failures are still logged via `console.error` regardless of
 * whether a caller supplies this hook — it's an additional, structured way
 * to observe the same failures, not a replacement for the default logging.
 */
export interface SyncItemSettledEvent {
  key: string;
  kind: 'download' | 'upload' | 'delete';
  status: 'fulfilled' | 'rejected';
  error?: unknown;
}

function isArrayBlobFieldConfig(
  config: AnyBlobFieldConfig,
): config is ArrayBlobFieldConfig {
  return config.kind === 'array';
}

/** Options passed to {@link syncStore}. */
export interface SyncOptions<T extends SyncRecord = SyncRecord> {
  /**
   * Custom conflict resolver. When provided, replaces {@link defaultResolve}
   * entirely. Receives the local record and remote file metadata; returns how
   * to resolve the conflict. `modifiedField` has no effect when this is set.
   */
  resolve?: ResolveConflict<T>;

  /**
   * Local record field that marks a record as soft-deleted. Downloads are
   * skipped for any record whose value at this key is truthy.
   */
  softDeleteField?: keyof T;

  /**
   * Local record field holding the last-modified `Date`. Defaults to
   * `modified`. Set this when your schema uses a different name (e.g.
   * `updatedAt`). Has no effect when a custom `resolve` is provided.
   */
  modifiedField?: keyof T;

  /**
   * Per-field blob sync configuration. Each key names a record field whose
   * value references one or more binary blobs.
   *
   * With a {@link BlobFieldConfig} (scalar string field), the blob is pushed
   * on upload and the field value is replaced with the blob key in the remote
   * JSON; on download the blob is fetched and the key is rewritten to the
   * local value before the record is stored in IDB.
   *
   * With an {@link ArrayBlobFieldConfig} (array-of-items field), each item's
   * blob (resolved via `itemKey`) is pushed/pulled and the field value is
   * stored as-is on both sides.
   *
   * Requires the transport to implement {@link BlobSyncTransport}. An error is
   * thrown at the start of `syncStore` when this option is set and the
   * transport does not support blobs.
   */
  blobFields?: { [K in keyof T & string]?: AnyBlobFieldConfig };

  /**
   * Aborting stops the local record scan from issuing further deletes and
   * stops the write queues from starting any new item — already-started
   * items still run to completion and settle normally.
   */
  signal?: AbortSignal;

  /** Fires immediately before each local IDB write this run performs. */
  onBeforeWrite?: (event: SyncWriteEvent<T>) => void;

  /** Fires once each queue item (download/upload/delete) settles. */
  onItemSettled?: (event: SyncItemSettledEvent) => void;
}

/**
 * Default conflict resolver: compares modification timestamps, newer wins.
 * Remote soft-deletion always takes precedence. Reads the local record's
 * `modified` field; use `modifiedField` in {@link SyncOptions} to read a
 * different field without replacing the entire resolver.
 */
export const defaultResolve: ResolveConflict = (local, remote) => {
  if (remote.deleted) {
    return 'delete';
  }

  if (!remote.modified) {
    return 'keep-local';
  }

  const localMod = local.modified;

  if (!localMod) {
    return 'keep-remote';
  }

  return localMod > remote.modified
    ? 'keep-local'
    : localMod < remote.modified
      ? 'keep-remote'
      : 'ignore';
};

/** @deprecated Use {@link defaultResolve}. */
export const defaultResolver = defaultResolve;

function keyToSyncKey(key: string): string {
  return `${key}.json`;
}

function syncKeyToKey(syncKey: string): string {
  return syncKey.replace('.json', '');
}

function buildResolver<T extends SyncRecord>(
  modifiedField?: keyof T,
): ResolveConflict<T> {
  if (!modifiedField) {
    return defaultResolve as ResolveConflict<T>;
  }

  return (local, remote) => {
    if (remote.deleted) {
      return 'delete';
    }

    if (!remote.modified) {
      return 'keep-local';
    }

    const localMod = local[modifiedField] as Date | undefined;

    if (!localMod) {
      return 'keep-remote';
    }

    return localMod > remote.modified
      ? 'keep-local'
      : localMod < remote.modified
        ? 'keep-remote'
        : 'ignore';
  };
}

/**
 * Uploads a single blob to the transport unless a blob with the same key was
 * already pushed (or listed remotely) this sync cycle. `uploadedKeys` is
 * mutated to record the push.
 */
async function uploadBlob(
  transport: BlobSyncTransport,
  storeName: string,
  blobStore: BlobStore,
  blobKey: string,
  contentType: string | undefined,
  uploadedKeys: Set<string>,
): Promise<void> {
  if (uploadedKeys.has(blobKey)) {
    return;
  }

  const blob = await blobStore.get(blobKey);

  if (blob) {
    await transport.putBlob(storeName, blobKey, blob, contentType);
    uploadedKeys.add(blobKey);
  }
}

/**
 * Uploads any blob fields from a local record to the transport. Returns a
 * shallow copy of the record with each scalar blob field replaced by its blob
 * key (the form stored in remote JSON). Array blob fields are uploaded
 * per-item and the field value is left unchanged.
 *
 * `uploadedKeys` is mutated to track blobs already uploaded this sync cycle so
 * that the same blob is not pushed twice when multiple records share a key.
 */
async function uploadBlobFields<T extends SyncRecord>(
  transport: BlobSyncTransport,
  storeName: string,
  record: T,
  blobFields: NonNullable<SyncOptions<T>['blobFields']>,
  uploadedKeys: Set<string>,
): Promise<T> {
  const out = { ...record } as T;

  for (const [field, config] of Object.entries(blobFields) as [
    string,
    AnyBlobFieldConfig,
  ][]) {
    const rawValue = record[field];

    if (isArrayBlobFieldConfig(config)) {
      if (!Array.isArray(rawValue)) {
        continue;
      }

      for (const item of rawValue) {
        const blobKey = config.itemKey(item);

        if (!blobKey) {
          continue;
        }

        await uploadBlob(
          transport,
          storeName,
          config.blobStore,
          blobKey,
          config.itemContentType?.(item),
          uploadedKeys,
        );
      }

      continue;
    }

    if (typeof rawValue !== 'string' || !rawValue) {
      continue;
    }

    const blobKey = config.keyFromValue
      ? config.keyFromValue(rawValue)
      : rawValue;

    await uploadBlob(
      transport,
      storeName,
      config.blobStore,
      blobKey,
      config.contentType,
      uploadedKeys,
    );

    (out as Record<string, unknown>)[field] = blobKey;
  }

  return out;
}

/**
 * Downloads a single blob from the transport into the local blobStore unless
 * it is already present locally.
 */
async function downloadBlob(
  transport: BlobSyncTransport,
  storeName: string,
  blobStore: BlobStore,
  blobKey: string,
): Promise<void> {
  if (await blobStore.has(blobKey)) {
    return;
  }

  const blob = await transport.getBlob(storeName, blobKey);

  if (blob) {
    await blobStore.put(blobKey, blob);
  }
}

/**
 * Downloads any blob fields referenced in a remote record into the local
 * blobStore. Returns a shallow copy of the record with each scalar blob field
 * rewritten to the local value (e.g. an app URL). Array blob fields are
 * downloaded per-item and the field value is left unchanged.
 */
async function downloadBlobFields<T extends SyncRecord>(
  transport: BlobSyncTransport,
  storeName: string,
  record: T,
  blobFields: NonNullable<SyncOptions<T>['blobFields']>,
): Promise<T> {
  const out = { ...record } as T;

  for (const [field, config] of Object.entries(blobFields) as [
    string,
    AnyBlobFieldConfig,
  ][]) {
    const rawValue = record[field];

    if (isArrayBlobFieldConfig(config)) {
      if (!Array.isArray(rawValue)) {
        continue;
      }

      for (const item of rawValue) {
        const blobKey = config.itemKey(item);

        if (blobKey) {
          await downloadBlob(transport, storeName, config.blobStore, blobKey);
        }
      }

      continue;
    }

    if (typeof rawValue !== 'string' || !rawValue) {
      continue;
    }

    await downloadBlob(transport, storeName, config.blobStore, rawValue);

    const localValue = config.valueFromKey
      ? config.valueFromKey(rawValue)
      : rawValue;

    (out as Record<string, unknown>)[field] = localValue;
  }

  return out;
}

/** One unit of work in `syncStore`'s combined write queue. */
type QueueItem =
  | { kind: 'download'; uuid: string }
  | { kind: 'upload'; uuid: string }
  | { kind: 'delete'; uuid: string };

/** Local writes/uploads/deletes in flight at once during `syncStore`. */
const QUEUE_CONCURRENCY = 6;

/**
 * Synchronises an `idb` object store with a cloud storage provider.
 *
 * Compares local records against remote file metadata and resolves conflicts
 * using `options.resolve` (or the default timestamp resolver). After
 * resolution, every queued item — downloads (remote-wins or remote-only
 * records fetched and written to `db`), uploads (local-wins or local-only
 * records written to `transport`), and deletes (resolved-delete records
 * removed from `db` and soft-deleted on `transport`) — runs through one
 * bounded-concurrency pool (`QUEUE_CONCURRENCY` at a time).
 *
 * When `options.blobFields` is configured, binary blobs referenced by those
 * fields are synced alongside their records. Remote blobs already present are
 * skipped on upload; local blobs already present are skipped on download.
 * The transport must implement {@link BlobSyncTransport}; an error is thrown
 * at startup if it does not.
 *
 * Individual queue failures are logged and do not cause `syncStore` to
 * reject — pass `options.onItemSettled` for a structured, per-item view of
 * the same failures. Pass `options.signal` to cancel a run in progress
 * (already-started items still settle; nothing further starts) and
 * `options.onBeforeWrite` to observe each local write before it happens,
 * e.g. to build an undo log for reverting a cancelled run.
 *
 * @param db        An open `idb` database instance.
 * @param transport Storage provider implementing {@link SyncTransport}.
 * @param storeName Name of the object store to sync.
 * @param options   Optional conflict resolution and field configuration.
 */
export async function syncStore<T extends SyncRecord>(
  // `IDBPDatabase` (implicitly `IDBPDatabase<unknown>`) rejects a
  // schema-typed `IDBPDatabase<YourSchema>` argument here — the `idb`
  // package's cursor/async-iterator return types aren't structurally
  // bivariant across DBTypes, even though this function only ever accesses
  // stores by name. `any` is the standard workaround for a schema-agnostic
  // helper like this one; it doesn't weaken anything callers rely on since
  // no schema-specific type ever flows out of `syncStore` itself.
  db: IDBPDatabase<any>,
  transport: SyncTransport,
  storeName: string,
  options?: SyncOptions<T>,
): Promise<void> {
  const blobFields = options?.blobFields;

  if (blobFields && !isBlobSyncTransport(transport)) {
    throw new Error(
      `syncStore: blobFields configured but transport "${transport.provider}" does not implement BlobSyncTransport.`,
    );
  }

  const blobTransport = blobFields
    ? (transport as BlobSyncTransport)
    : undefined;

  const resolve = options?.resolve ?? buildResolver(options?.modifiedField);
  const softDeleteField = options?.softDeleteField;
  const signal = options?.signal;

  if (signal?.aborted) {
    return;
  }

  // 1. List remote items (and remote blobs if needed)
  const remoteItems = await transport.list(storeName);

  // Track blob keys already uploaded this cycle to avoid redundant pushes
  const uploadedBlobKeys = new Set<string>(
    blobTransport
      ? (await blobTransport.listBlobs(storeName)).map((b) => b.syncKey)
      : [],
  );

  // 2. Iterate local records, resolve conflicts
  const fromRemoteQueue: string[] = [];
  const toRemoteQueue: string[] = [];
  const deleteQueue: string[] = [];
  const matchedRemoteKeys = new Set<string>();
  // Every locally-scanned record's value, keyed by its local key — reused
  // below as the `previous` value `onBeforeWrite` reports for downloads
  // (`undefined` for a key never scanned here, i.e. a genuinely new remote
  // record) and captured here directly for deletes, at no extra `db.get`.
  const previousByKey = new Map<string, T>();

  const tx = db.transaction(storeName, 'readwrite');

  for await (const cursor of tx.store) {
    // The scan itself performs real local deletes as it goes (below), so
    // this stops issuing new ones rather than only guarding the later
    // write queues.
    if (signal?.aborted) {
      break;
    }

    const localValue = cursor.value as T;
    const syncKey = keyToSyncKey(cursor.primaryKey as string);
    const remoteItem = remoteItems.find((r) => r.syncKey === syncKey);

    previousByKey.set(cursor.primaryKey as string, localValue);

    if (remoteItem) {
      matchedRemoteKeys.add(remoteItem.syncKey);
    }

    if (!remoteItem) {
      toRemoteQueue.push(cursor.primaryKey as string);

      continue;
    }

    const resolution = resolve(localValue, remoteItem);

    switch (resolution) {
      case 'keep-remote':
        fromRemoteQueue.push(cursor.primaryKey as string);
        break;

      case 'keep-local':
        toRemoteQueue.push(cursor.primaryKey as string);
        break;

      case 'delete':
        deleteQueue.push(cursor.primaryKey as string);

        options?.onBeforeWrite?.({
          key: cursor.primaryKey as string,
          kind: 'delete',
          previous: localValue,
        });

        cursor.delete();
        break;

      case 'ignore':
        break;
    }
  }

  // 3. New remote items not in local
  const newRemoteKeys = remoteItems
    .filter((r) => !matchedRemoteKeys.has(r.syncKey))
    .map((r) => syncKeyToKey(r.syncKey));

  fromRemoteQueue.push(...newRemoteKeys);

  // 4. Execute every queued item through one bounded-concurrency pool
  // instead of `items.map(async ...)` fed into `Promise.allSettled` — that
  // eager fan-out starts every closure synchronously before any `await`,
  // so a `signal.aborted` check placed inside those closures would almost
  // never see it in time for a real, later cancel. `runQueue` checks
  // `signal` before starting each new item instead, so an already-started
  // item still settles normally but nothing further begins.
  const queueItems: QueueItem[] = [
    ...fromRemoteQueue.map((uuid): QueueItem => ({ kind: 'download', uuid })),
    ...toRemoteQueue.map((uuid): QueueItem => ({ kind: 'upload', uuid })),
    ...deleteQueue.map((uuid): QueueItem => ({ kind: 'delete', uuid })),
  ];

  await runQueue(
    queueItems,
    QUEUE_CONCURRENCY,
    async (item) => {
      try {
        if (item.kind === 'download') {
          const value = await transport.get<T>(storeName, keyToSyncKey(item.uuid));

          if (value === undefined) {
            throw new Error(`Fetched value for ${item.uuid} was undefined.`);
          }

          // Skip soft-deleted records
          if (softDeleteField && value[softDeleteField]) {
            options?.onItemSettled?.({ key: item.uuid, kind: 'download', status: 'fulfilled' });

            return;
          }

          const local =
            blobFields && blobTransport
              ? await downloadBlobFields(blobTransport, storeName, value, blobFields)
              : value;

          options?.onBeforeWrite?.({
            key: item.uuid,
            kind: 'put',
            previous: previousByKey.get(item.uuid),
          });

          await db.put(storeName, local);
          options?.onItemSettled?.({ key: item.uuid, kind: 'download', status: 'fulfilled' });

          return;
        }

        if (item.kind === 'upload') {
          const value = await db.get(storeName, item.uuid);

          if (value === undefined) {
            throw new Error(`Local value for ${item.uuid} was undefined.`);
          }

          const remote =
            blobFields && blobTransport
              ? await uploadBlobFields(
                  blobTransport,
                  storeName,
                  value as T,
                  blobFields,
                  uploadedBlobKeys,
                )
              : value;

          await transport.put(storeName, keyToSyncKey(item.uuid), remote);
          options?.onItemSettled?.({ key: item.uuid, kind: 'upload', status: 'fulfilled' });

          return;
        }

        await transport.delete(storeName, keyToSyncKey(item.uuid), true);
        options?.onItemSettled?.({ key: item.uuid, kind: 'delete', status: 'fulfilled' });
      } catch (error) {
        console.error(error);

        options?.onItemSettled?.({
          key: item.uuid,
          kind: item.kind,
          status: 'rejected',
          error,
        });
      }
    },
    signal,
  );
}
