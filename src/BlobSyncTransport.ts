import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

/**
 * Optional extension of {@link SyncTransport} for providers that can
 * synchronise binary blobs alongside JSON records. Implement all four methods
 * to participate in blob field sync via {@link SyncOptions.blobFields}.
 *
 * Blobs are stored in a sibling directory named `<storeName>-blobs/` so they
 * do not appear in the JSON record listing returned by `list()`.
 */
export interface BlobSyncTransport extends SyncTransport {
  /**
   * Upload a binary blob. If a blob with this key already exists it is
   * overwritten.
   */
  putBlob(
    storeName: string,
    blobKey: string,
    blob: Blob,
    contentType?: string,
  ): Promise<SyncFileInfo>;

  /** Download a blob by key, or `undefined` if absent. */
  getBlob(storeName: string, blobKey: string): Promise<Blob | undefined>;

  /** List blob metadata for a store. */
  listBlobs(storeName: string): Promise<SyncFileInfo[]>;

  /** Delete a blob by key. */
  deleteBlob(storeName: string, blobKey: string): Promise<void>;
}

/**
 * Returns `true` when `transport` implements {@link BlobSyncTransport}.
 * Use this guard before accessing blob methods on an unknown transport.
 */
export function isBlobSyncTransport(
  transport: SyncTransport,
): transport is BlobSyncTransport {
  return typeof (transport as BlobSyncTransport).putBlob === 'function';
}
