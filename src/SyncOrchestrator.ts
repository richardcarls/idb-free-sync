import { type IDBPDatabase } from 'idb';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';
import { type BlobStore } from './BlobStore';
import {
  type BlobSyncTransport,
  isBlobSyncTransport,
} from './BlobSyncTransport';

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
 * Configures blob sync for a single record field. The remote JSON stores the
 * raw blob key; `keyFromValue` and `valueFromKey` map between that key and the
 * local field value (e.g. an OPFS app URL).
 */
export interface BlobFieldConfig {
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
   * value references a binary blob. During upload the blob is pushed to the
   * transport and the field value is replaced with the blob key in the remote
   * JSON. During download the blob is fetched and the key is rewritten to the
   * local value before the record is stored in IDB.
   *
   * Requires the transport to implement {@link BlobSyncTransport}. An error is
   * thrown at the start of `syncStore` when this option is set and the
   * transport does not support blobs.
   */
  blobFields?: { [K in keyof T & string]?: BlobFieldConfig };
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
 * Uploads any blob fields from a local record to the transport. Returns a
 * shallow copy of the record with each blob field replaced by its blob key
 * (the form stored in remote JSON).
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
    BlobFieldConfig,
  ][]) {
    const rawValue = record[field];

    if (typeof rawValue !== 'string' || !rawValue) {
      continue;
    }

    const blobKey = config.keyFromValue
      ? config.keyFromValue(rawValue)
      : rawValue;

    if (!uploadedKeys.has(blobKey)) {
      const blob = await config.blobStore.get(blobKey);

      if (blob) {
        await transport.putBlob(storeName, blobKey, blob, config.contentType);
        uploadedKeys.add(blobKey);
      }
    }

    (out as Record<string, unknown>)[field] = blobKey;
  }
  return out;
}

/**
 * Downloads any blob fields referenced in a remote record into the local
 * blobStore. Returns a shallow copy of the record with each blob field
 * rewritten to the local value (e.g. an app URL).
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
    BlobFieldConfig,
  ][]) {
    const blobKey = record[field];

    if (typeof blobKey !== 'string' || !blobKey) {
      continue;
    }

    if (!(await config.blobStore.has(blobKey))) {
      const blob = await transport.getBlob(storeName, blobKey);
      if (blob) {
        await config.blobStore.put(blobKey, blob);
      }
    }

    const localValue = config.valueFromKey
      ? config.valueFromKey(blobKey)
      : blobKey;
    (out as Record<string, unknown>)[field] = localValue;
  }
  return out;
}

/**
 * Synchronises an `idb` object store with a cloud storage provider.
 *
 * Compares local records against remote file metadata and resolves conflicts
 * using `options.resolve` (or the default timestamp resolver). After
 * resolution, three queues run concurrently:
 *
 * - **download** — remote-wins or remote-only records fetched and written to
 *   `db`.
 * - **upload**   — local-wins or local-only records written to `transport`.
 * - **delete**   — resolved-delete records removed from `db` and soft-deleted
 *   on `transport`.
 *
 * When `options.blobFields` is configured, binary blobs referenced by those
 * fields are synced alongside their records. Remote blobs already present are
 * skipped on upload; local blobs already present are skipped on download.
 * The transport must implement {@link BlobSyncTransport}; an error is thrown
 * at startup if it does not.
 *
 * Individual queue failures are logged and do not cause `syncStore` to reject.
 *
 * @param db        An open `idb` database instance.
 * @param transport Storage provider implementing {@link SyncTransport}.
 * @param storeName Name of the object store to sync.
 * @param options   Optional conflict resolution and field configuration.
 */
export async function syncStore<T extends SyncRecord>(
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

  const tx = db.transaction(storeName, 'readwrite');

  for await (const cursor of tx.store) {
    const syncKey = keyToSyncKey(cursor.primaryKey as string);
    const remoteItem = remoteItems.find((r) => r.syncKey === syncKey);

    if (remoteItem) {
      matchedRemoteKeys.add(remoteItem.syncKey);
    }

    if (!remoteItem) {
      toRemoteQueue.push(cursor.primaryKey as string);
      continue;
    }

    const resolution = resolve(cursor.value as T, remoteItem);

    switch (resolution) {
      case 'keep-remote':
        fromRemoteQueue.push(cursor.primaryKey as string);
        break;

      case 'keep-local':
        toRemoteQueue.push(cursor.primaryKey as string);
        break;

      case 'delete':
        deleteQueue.push(cursor.primaryKey as string);
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

  // 4. Execute queues in parallel

  // TODO: add onError callback option to propagate queue failures to consumers
  await Promise.allSettled([
    ...fromRemoteQueue.map(async (uuid) => {
      const value = await transport.get<T>(storeName, keyToSyncKey(uuid));

      if (value === undefined) {
        throw new Error(`Fetched value for ${uuid} was undefined.`);
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
              value,
              blobFields,
            )
          : value;

      return db.put(storeName, local).catch((er: unknown) => console.error(er));
    }),

    ...toRemoteQueue.map(async (uuid) => {
      const value = await db.get(storeName, uuid);

      if (value === undefined) {
        throw new Error(`Local value for ${uuid} was undefined.`);
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

      return transport
        .put(storeName, keyToSyncKey(uuid), remote)
        .catch((er: unknown) => console.error(er));
    }),

    ...deleteQueue.map(async (uuid) =>
      transport
        .delete(storeName, keyToSyncKey(uuid), true)
        .catch((er: unknown) => console.error(er)),
    ),
  ]);
}
