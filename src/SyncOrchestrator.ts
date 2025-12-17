import { type IDBPDatabase } from 'idb';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

export type ResolveAction = 'keep-local' | 'keep-remote' | 'delete' | 'ignore';

/** Minimum shape required for records using the default resolver. */
export interface SyncRecord {
  modified?: Date;
  [key: string]: unknown;
}

/**
 * @callback
 *
 * Chooses how a local record and its matching remote file should be reconciled.
 */
export type ConflictResolverCB<T extends SyncRecord = SyncRecord> = (
  localRecord: T,
  remoteInfo: SyncFileInfo,
) => ResolveAction;

export interface SyncOptions<T extends SyncRecord = SyncRecord> {
  /** Custom conflict resolver. Defaults to {@link defaultResolver}. */
  resolve?: ConflictResolverCB<T>;

  /** Record field whose truthy value marks a downloaded record as deleted. */
  softDeleteField?: keyof T;

  /**
   * Record field containing the local modification date. Defaults to
   * `modified` and has no effect when `resolve` is provided.
   */
  modifiedField?: keyof T;
}

/**
 * @callback
 *
 * Resolves conflicts by honoring remote deletions, then keeping the most
 * recently modified copy.
 */
export const defaultResolver: ConflictResolverCB = (local, remote) => {
  if (remote.deleted) {
    return 'delete';
  }

  if (!remote.modified) {
    return 'keep-local';
  }

  const localMod = local['modified'] as Date | undefined;
  if (!localMod) {
    return 'keep-remote';
  }

  return localMod > remote.modified
    ? 'keep-local'
    : localMod < remote.modified
      ? 'keep-remote'
      : 'ignore';
};

/** Converts an IndexedDB primary key to its JSON file name. */
function keyToSyncKey(key: string): string {
  return `${key}.json`;
}

/** Converts a JSON file name back to its IndexedDB primary key. */
function syncKeyToKey(syncKey: string): string {
  return syncKey.replace('.json', '');
}

/** Creates the default timestamp resolver for a custom modification field. */
function buildResolver<T extends SyncRecord>(
  modifiedField?: keyof T,
): ConflictResolverCB<T> {
  if (!modifiedField) {
    return defaultResolver as ConflictResolverCB<T>;
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
 * Reconciles every record in an IndexedDB object store with the transport.
 *
 * Existing record conflicts are delegated to the configured resolver. Records
 * found on only one side are copied to the other side. Individual transfer
 * failures are currently just logged without rejecting the overall sync operation.
 *
 * @param db - the opened IndexDB database
 * @param transport - transport for sync operation
 * @param storeName - the IndexedDB store name / transport folder
 * @param options - for conflict-resolution, timestamps, and soft-delete behavior
 */
export async function syncStore<T extends SyncRecord>(
  db: IDBPDatabase<any>,
  transport: SyncTransport,
  storeName: string,
  options?: SyncOptions<T>,
): Promise<void> {
  const resolve = options?.resolve ?? buildResolver(options?.modifiedField);
  const softDeleteField = options?.softDeleteField;

  const remoteItems = await transport.list(storeName);

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
    } else {
      toRemoteQueue.push(cursor.primaryKey as string);

      continue;
    }

    const action = resolve(cursor.value as T, remoteItem);

    switch (action) {
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

  const newRemoteKeys = remoteItems
    .filter((r) => !matchedRemoteKeys.has(r.syncKey))
    .map((r) => syncKeyToKey(r.syncKey));

  fromRemoteQueue.push(...newRemoteKeys);

  await Promise.allSettled([
    ...fromRemoteQueue.map(async (uuid) => {
      const value = await transport.get<T>(storeName, keyToSyncKey(uuid));

      if (value === undefined) {
        throw new Error(`Fetched value for ${uuid} was undefined.`);
      }

      if (softDeleteField && value[softDeleteField]) {
        return;
      }

      return db.put(storeName, value).catch((er) => console.error(er));
    }),

    ...toRemoteQueue.map(async (uuid) => {
      const value = await db.get(storeName, uuid);

      if (value === undefined) {
        throw new Error(`Local value for ${uuid} was undefined.`);
      }

      return transport
        .put(storeName, keyToSyncKey(uuid), value)
        .catch((er) => console.error(er));
    }),

    ...deleteQueue.map(async (uuid) =>
      transport
        .delete(storeName, keyToSyncKey(uuid), true)
        .catch((er) => console.error(er)),
    ),
  ]);
}
