import { type IDBPDatabase } from 'idb';
import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

export type ConflictResolution =
  | 'keep-local'
  | 'keep-remote'
  | 'delete'
  | 'ignore';

export type ResolveConflict = (
  localRecord: Record<string, unknown>,
  remoteInfo: SyncFileInfo,
) => ConflictResolution;

export interface SyncOptions {
  resolve?: ResolveConflict;
  softDeleteField?: string;
}

export const defaultResolve: ResolveConflict = (local, remote) => {
  if (remote.deleted) return 'delete';
  if (!remote.modified) return 'keep-local';
  const localMod = local['modified'] as Date | undefined;
  if (!localMod) return 'keep-remote';
  return localMod > remote.modified
    ? 'keep-local'
    : localMod < remote.modified
      ? 'keep-remote'
      : 'ignore';
};

function keyToSyncKey(key: string): string {
  return `${key}.json`;
}

function syncKeyToKey(syncKey: string): string {
  return syncKey.replace('.json', '');
}

export async function syncStore(
  db: IDBPDatabase<any>,
  transport: SyncTransport,
  storeName: string,
  options?: SyncOptions,
): Promise<void> {
  const resolve = options?.resolve ?? defaultResolve;
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

    if (remoteItem) matchedRemoteKeys.add(remoteItem.syncKey);

    if (!remoteItem) {
      toRemoteQueue.push(cursor.primaryKey as string);
      continue;
    }

    const resolution = resolve(
      cursor.value as Record<string, unknown>,
      remoteItem,
    );

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

  const newRemoteKeys = remoteItems
    .filter((r) => !matchedRemoteKeys.has(r.syncKey))
    .map((r) => syncKeyToKey(r.syncKey));
  fromRemoteQueue.push(...newRemoteKeys);

  for (const uuid of fromRemoteQueue) {
    const value = await transport.get(storeName, keyToSyncKey(uuid));
    if (value !== undefined) {
      if (
        softDeleteField &&
        (value as Record<string, unknown>)[softDeleteField]
      )
        continue;
      await db.put(storeName, value);
    }
  }
  for (const uuid of toRemoteQueue) {
    const value = await db.get(storeName, uuid);
    if (value !== undefined)
      await transport.put(storeName, keyToSyncKey(uuid), value);
  }
  for (const uuid of deleteQueue) {
    await transport.delete(storeName, keyToSyncKey(uuid), true);
  }
}
