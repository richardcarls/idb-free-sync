export interface SyncFileInfo {
  /** Provider-specific unique identifier (e.g., Google Drive file ID, OPFS file name) */
  id: string;
  /** The sync key (file name like "uuid.json") */
  syncKey: string;
  /** Last modified timestamp from the provider */
  modified?: Date;
  /** Creation timestamp from the provider */
  created?: Date;
  /** Checksum for content comparison */
  checksum?: string;
  /** File size in bytes */
  size?: number;
  /** Whether the remote record is soft-deleted */
  deleted?: boolean;
}

export interface SyncTransport {
  /** Human-readable provider name */
  readonly provider: string;

  /** OAuth scopes required (empty for local providers) */
  readonly scopes: string[];

  /** List all file metadata for a given store directory */
  list(storeName: string): Promise<SyncFileInfo[]>;

  /** Read a single item by sync key */
  get<T>(storeName: string, syncKey: string): Promise<T | undefined>;

  /** Write a single item, creating or overwriting */
  put<T>(
    storeName: string,
    syncKey: string,
    value: T,
    meta?: Record<string, string>,
  ): Promise<SyncFileInfo>;

  /** Delete a single item by sync key */
  delete(storeName: string, syncKey: string, soft?: boolean): Promise<void>;

  /** Delete all items in a store directory */
  deleteAll(storeName: string, soft?: boolean): Promise<void>;

  /** Count items for a store */
  count(storeName: string): Promise<number>;
}
