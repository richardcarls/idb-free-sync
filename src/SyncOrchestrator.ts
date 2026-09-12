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
 * Reported once for every planned queue item (a download, upload, delete, or
 * blob reconciliation)
 * after it settles. Items that cancellation prevents from starting are
 * rejected with an `AbortError`. `error` is set only when `status` is
 * `'rejected'`. Failures are still logged via `console.error` regardless of
 * whether a caller supplies this hook. Errors thrown by the hook itself are
 * logged separately and do not change item outcomes or suppress later events.
 */
export interface SyncItemSettledEvent {
  key: string;
  kind: 'download' | 'upload' | 'delete' | 'reconcile';
  status: 'fulfilled' | 'rejected';
  error?: unknown;
}

/** Identifies a record whose blob reference cannot be satisfied locally or remotely. */
export class BlobIntegrityError extends Error {
  /** Object store containing the record. */
  readonly storeName: string;

  /** Primary key of the affected record. */
  readonly recordKey: string;

  /** Referenced blob key missing from both stores. */
  readonly blobKey: string;

  /** Sync operation that discovered the missing blob. */
  readonly operation: 'download' | 'upload' | 'reconcile';

  /**
   * Creates a structured missing-blob error.
   *
   * @param storeName - object store containing the record
   * @param recordKey - primary key of the affected record
   * @param blobKey - referenced blob key missing from both stores
   * @param operation - sync operation that discovered the missing blob
   */
  constructor(
    storeName: string,
    recordKey: string,
    blobKey: string,
    operation: BlobIntegrityError['operation'],
  ) {
    super(
      `Blob ${blobKey} referenced by ${storeName}/${recordKey} is unavailable locally and remotely.`,
    );

    this.name = 'BlobIntegrityError';
    this.storeName = storeName;
    this.recordKey = recordKey;
    this.blobKey = blobKey;
    this.operation = operation;
  }
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

  /** Fires as each planned queue item settles, including cancelled items. */
  onItemSettled?: (event: SyncItemSettledEvent) => void;

  /**
   * Fires after the local scan with the number of queued operations.
   * Use this total with {@link onItemSettled} for visible progress because
   * the IndexedDB scan cannot yield for rendering without closing its
   * transaction.
   */
  onQueueBuilt?: (total: number) => void;
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

type BlobOperation = BlobIntegrityError['operation'];

interface BlobTransferState {
  remoteKeys: Set<string>;
  inFlight: WeakMap<BlobStore, Map<string, Promise<void>>>;
}

async function reconcileBlob(
  transport: BlobSyncTransport,
  storeName: string,
  recordKey: string,
  blobStore: BlobStore,
  blobKey: string,
  contentType: string | undefined,
  operation: BlobOperation,
  state: BlobTransferState,
): Promise<void> {
  let storeTransfers = state.inFlight.get(blobStore);

  if (!storeTransfers) {
    storeTransfers = new Map();
    state.inFlight.set(blobStore, storeTransfers);
  }

  const pending = storeTransfers.get(blobKey);

  if (pending) {
    await pending;

    return;
  }

  const transfer = (async () => {
    const localBlob = await blobStore.get(blobKey);
    const remoteExists = state.remoteKeys.has(blobKey);

    if (localBlob) {
      if (!remoteExists) {
        await transport.putBlob(storeName, blobKey, localBlob, contentType);
        state.remoteKeys.add(blobKey);
      }

      return;
    }

    if (remoteExists) {
      const remoteBlob = await transport.getBlob(storeName, blobKey);

      if (remoteBlob) {
        await blobStore.put(blobKey, remoteBlob);

        return;
      }

      state.remoteKeys.delete(blobKey);
    }

    throw new BlobIntegrityError(storeName, recordKey, blobKey, operation);
  })();

  storeTransfers.set(blobKey, transfer);

  try {
    await transfer;
  } finally {
    storeTransfers.delete(blobKey);
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
  recordKey: string,
  record: T,
  blobFields: NonNullable<SyncOptions<T>['blobFields']>,
  state: BlobTransferState,
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

        await reconcileBlob(
          transport,
          storeName,
          recordKey,
          config.blobStore,
          blobKey,
          config.itemContentType?.(item),
          'upload',
          state,
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

    await reconcileBlob(
      transport,
      storeName,
      recordKey,
      config.blobStore,
      blobKey,
      config.contentType,
      'upload',
      state,
    );

    (out as Record<string, unknown>)[field] = blobKey;
  }

  return out;
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
  recordKey: string,
  record: T,
  blobFields: NonNullable<SyncOptions<T>['blobFields']>,
  state: BlobTransferState,
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
          await reconcileBlob(
            transport,
            storeName,
            recordKey,
            config.blobStore,
            blobKey,
            config.itemContentType?.(item),
            'download',
            state,
          );
        }
      }

      continue;
    }

    if (typeof rawValue !== 'string' || !rawValue) {
      continue;
    }

    await reconcileBlob(
      transport,
      storeName,
      recordKey,
      config.blobStore,
      rawValue,
      config.contentType,
      'download',
      state,
    );

    const localValue = config.valueFromKey
      ? config.valueFromKey(rawValue)
      : rawValue;

    (out as Record<string, unknown>)[field] = localValue;
  }

  return out;
}

async function reconcileBlobFields<T extends SyncRecord>(
  transport: BlobSyncTransport,
  storeName: string,
  recordKey: string,
  record: T,
  blobFields: NonNullable<SyncOptions<T>['blobFields']>,
  state: BlobTransferState,
): Promise<void> {
  await uploadBlobFields(
    transport,
    storeName,
    recordKey,
    record,
    blobFields,
    state,
  );
}

function hasBlobReferences<T extends SyncRecord>(
  record: T,
  blobFields: NonNullable<SyncOptions<T>['blobFields']>,
): boolean {
  return (Object.entries(blobFields) as [string, AnyBlobFieldConfig][]).some(
    ([field, config]) => {
      const rawValue = record[field];

      if (isArrayBlobFieldConfig(config)) {
        return (
          Array.isArray(rawValue) &&
          rawValue.some((item) => Boolean(config.itemKey(item)))
        );
      }

      return typeof rawValue === 'string' && rawValue.length > 0;
    },
  );
}

/** One unit of work in `syncStore`'s combined write queue. */
type QueueItem =
  | { kind: 'download'; uuid: string }
  | { kind: 'upload'; uuid: string }
  | { kind: 'delete'; uuid: string }
  | { kind: 'reconcile'; uuid: string };

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
 * fields are synced alongside their records. Equal records reconcile a blob
 * missing from either side, while a reference missing from both sides rejects
 * only that record's queue item with {@link BlobIntegrityError}. The transport
 * must implement {@link BlobSyncTransport}; an error is thrown at startup if
 * it does not.
 *
 * Individual queue failures are logged and do not cause `syncStore` to
 * reject — pass `options.onItemSettled` for a structured, per-item view of
 * the same failures. Pass `options.signal` to cancel a run in progress
 * (already-started items still settle; nothing further starts) and
 * `options.onBeforeWrite` to observe each local write before it happens,
 * e.g. to build an undo log for reverting a cancelled run.
 *
 * @param db - an open `idb` database instance
 * @param transport - storage provider implementing {@link SyncTransport}
 * @param storeName - name of the object store to sync
 * @param options - optional conflict resolution and field configuration
 */
export async function syncStore<T extends SyncRecord>(
  // `IDBPDatabase` (implicitly `IDBPDatabase<unknown>`) rejects a
  // schema-typed `IDBPDatabase<YourSchema>` argument here — the `idb`
  // package's cursor/async-iterator return types aren't structurally
  // bivariant across DBTypes, even though this function only ever accesses
  // stores by name. `any` is the standard workaround for a schema-agnostic
  // helper like this one; it doesn't weaken anything callers rely on since
  // no schema-specific type ever flows out of `syncStore` itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-agnostic store access requires idb's open database type
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

  const blobTransferState: BlobTransferState = {
    remoteKeys: new Set<string>(
      blobTransport
        ? (await blobTransport.listBlobs(storeName)).map((b) => b.syncKey)
        : [],
    ),
    inFlight: new WeakMap(),
  };

  // 2. Iterate local records, resolve conflicts
  const fromRemoteQueue: string[] = [];
  const toRemoteQueue: string[] = [];
  const deleteQueue: string[] = [];
  const reconcileQueue: string[] = [];
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
        break;

      case 'ignore':
        if (blobFields && hasBlobReferences(localValue, blobFields)) {
          reconcileQueue.push(cursor.primaryKey as string);
        }

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
    ...reconcileQueue.map((uuid): QueueItem => ({ kind: 'reconcile', uuid })),
  ];

  options?.onQueueBuilt?.(queueItems.length);

  await runQueue(
    queueItems,
    QUEUE_CONCURRENCY,
    async (item) => {
      if (item.kind === 'download') {
        const value = await transport.get<T>(
          storeName,
          keyToSyncKey(item.uuid),
        );

        if (value === undefined) {
          throw new Error(`Fetched value for ${item.uuid} was undefined.`);
        }

        // Skip soft-deleted records
        if (softDeleteField && value[softDeleteField]) {
          return;
        }

        const local =
          blobFields && blobTransport
            ? await downloadBlobFields(
                blobTransport,
                storeName,
                item.uuid,
                value,
                blobFields,
                blobTransferState,
              )
            : value;

        options?.onBeforeWrite?.({
          key: item.uuid,
          kind: 'put',
          previous: previousByKey.get(item.uuid),
        });

        await db.put(storeName, local);

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
                item.uuid,
                value as T,
                blobFields,
                blobTransferState,
              )
            : value;

        await transport.put(storeName, keyToSyncKey(item.uuid), remote);

        return;
      }

      if (item.kind === 'reconcile') {
        const value = previousByKey.get(item.uuid);

        if (value && blobFields && blobTransport) {
          await reconcileBlobFields(
            blobTransport,
            storeName,
            item.uuid,
            value,
            blobFields,
            blobTransferState,
          );
        }

        return;
      }

      options?.onBeforeWrite?.({
        key: item.uuid,
        kind: 'delete',
        previous: previousByKey.get(item.uuid),
      });

      await db.delete(storeName, item.uuid);
      await transport.delete(storeName, keyToSyncKey(item.uuid), true);
    },
    signal,
    (item, result) => {
      if (result.status === 'rejected') {
        console.error(result.reason);
      }

      options?.onItemSettled?.({
        key: item.uuid,
        kind: item.kind,
        status: result.status,
        ...(result.status === 'rejected' && { error: result.reason }),
      });
    },
  );
}
