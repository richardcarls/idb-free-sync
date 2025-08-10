/**
 * Provider-neutral file metadata describing one synchronized record.
 */
export interface SyncFileInfo {
  /** Provider-specific unique identifier (e.g., Google Drive file ID, OPFS file name) */
  id: string;

  /** The sync key (usually the filename of the synced JSON file / the record's unique id) */
  syncKey: string;

  /** Last modified timestamp (provider-side) */
  modified?: Date;

  /** Creation timestamp (provider-side) */
  created?: Date;

  /** MD5 checksum supplied by the provider, when available */
  checksum?: string;

  /** File size, in bytes */
  size?: number;

  /** Whether the remote record is soft-deleted */
  deleted?: boolean;
}

/**
 * Storage-provider contract used by the SyncOrchestrator.
 *
 * Each IndexedDB store maps to a provider directory, and each record maps to
 * a JSON file, identified by a sync key.
 */
export interface SyncTransport {
  /** Provider identifier, lowercase (e.g., `google`) */
  readonly provider: string;

  /** OAuth scopes if required */
  readonly scopes: string[];

  /**
   * Lists all file metadata for a store directory.
   *
   * @param storeName - the IndexedDB store name / transport folder
   */
  list(storeName: string): Promise<SyncFileInfo[]>;

  /**
   * Reads and parses a single item by sync key.
   *
   * @typeParam T - JSON-serializable record type
   * @param storeName - the IndexedDB store name / transport folder
   * @param syncKey - the JSON filename used by the transport
   */
  get<T>(storeName: string, syncKey: string): Promise<T | undefined>;

  /**
   * Writes a single item, creating or overwriting the provider file.
   *
   * @typeParam T - JSON-serializable record type
   * @param storeName - the IndexedDB store name / transport folder
   * @param syncKey - the JSON filename used by the transport
   * @param value - the value to persist
   * @param meta - optional provider-specific metadata
   */
  put<T>(
    storeName: string,
    syncKey: string,
    value: T,
    meta?: Record<string, string>,
  ): Promise<SyncFileInfo>;

  /**
   * Deletes a single item by sync key.
   *
   * @param storeName - the IndexedDB store name / transport folder
   * @param syncKey - the JSON file name used by the transport
   * @param soft - whether to mark the item as deleted instead of removing it
   */
  delete(storeName: string, syncKey: string, soft?: boolean): Promise<void>;

  /**
   * Deletes all items in a store directory.
   *
   * @param storeName - the IndexedDB store name / transport folder
   * @param soft - whether to mark items as deleted instead of removing them
   */
  deleteAll(storeName: string, soft?: boolean): Promise<void>;

  /**
   * Counts items for a store.
   *
   * @param storeName - the IndexedDB store name / transport folder
   */
  count(storeName: string): Promise<number>;
}
