import { type FileStat, type WebDAVClient } from 'webdav';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';
import { createWebDAVClient } from './internal/webdavAdapter';

/** Connection configuration for {@link WebDAVTransport}. */
export type WebDAVConfig = {
  /** Base URL of the WebDAV server. */
  url: string;

  /** Username for HTTP Basic authentication. */
  username?: string;

  /** Password for HTTP Basic authentication. */
  password?: string;

  /** Bearer token for token-based authentication. */
  token?: string;
};

const BASE_PATH = '/RecipeTome';

/** Syncs JSON records to a WebDAV server under `/RecipeTome`. */
export class WebDAVTransport implements SyncTransport {
  readonly provider = 'webdav';

  /** WebDAV authentication is configured directly rather than through scopes. */
  readonly scopes: string[] = [];

  private readonly client: WebDAVClient;

  /** Creates a WebDAV transport from direct server credentials. */
  constructor(config: WebDAVConfig) {
    this.client = createWebDAVClient(config);
  }

  /** Lists metadata for every file in a WebDAV sync folder. */
  async list(storeName: string): Promise<SyncFileInfo[]> {
    const path = `${BASE_PATH}/${storeName}`;
    try {
      const contents = (await this.client.getDirectoryContents(
        path,
      )) as FileStat[];

      return contents
        .filter((item) => item.type === 'file')
        .map((item) => ({
          id: item.filename,
          syncKey: item.basename,
          modified: item.lastmod ? new Date(item.lastmod) : undefined,
          size: item.size,
        }));
    } catch {
      return [];
    }
  }

  /** Downloads and parses a JSON file, or returns `undefined` when absent. */
  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    try {
      const path = `${BASE_PATH}/${storeName}/${syncKey}`;
      const text = (await this.client.getFileContents(path, {
        format: 'text',
      })) as string;

      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /** Creates or replaces a JSON file and returns its updated WebDAV metadata. */
  async put<T>(
    storeName: string,
    syncKey: string,
    value: T,
  ): Promise<SyncFileInfo> {
    const path = `${BASE_PATH}/${storeName}/${syncKey}`;

    await this.ensureDirectory(storeName);
    await this.client.putFileContents(path, JSON.stringify(value, null, 2), {
      overwrite: true,
    });

    const stat = (await this.client.stat(path)) as FileStat;

    return {
      id: path,
      syncKey,
      modified: stat.lastmod ? new Date(stat.lastmod) : undefined,
      size: stat.size,
    };
  }

  /**
   * Deletes a file permanently or marks it as deleted in its JSON when soft
   * deletion is requested.
   */
  async delete(
    storeName: string,
    syncKey: string,
    soft?: boolean,
  ): Promise<void> {
    if (soft) {
      const value = await this.get(storeName, syncKey);

      if (value && typeof value === 'object') {
        await this.put(storeName, syncKey, { ...value, deleted: true });
      }

      return;
    }

    try {
      await this.client.deleteFile(`${BASE_PATH}/${storeName}/${syncKey}`);
    } catch {
      // no-op: Deletion is idempotent for synchronization callers.
    }
  }

  /** Deletes every file in a sync folder, optionally using soft deletion. */
  async deleteAll(storeName: string, soft?: boolean): Promise<void> {
    if (soft) {
      const files = await this.list(storeName);

      await Promise.allSettled(
        files.map((f) => this.delete(storeName, f.syncKey, true)),
      );

      return;
    }

    try {
      await this.client.deleteFile(`${BASE_PATH}/${storeName}`);
    } catch {
      // no-op: Deletion is idempotent for synchronization callers.
    }
  }

  /** Counts files in a WebDAV sync folder. */
  async count(storeName: string): Promise<number> {
    return (await this.list(storeName)).length;
  }

  /** Creates the provider root and sync folder when they are missing. */
  private async ensureDirectory(storeName: string): Promise<void> {
    const basePath = BASE_PATH;
    const storePath = `${BASE_PATH}/${storeName}`;

    try {
      await this.client.createDirectory(basePath, { recursive: true });
    } catch {
      // no-op: Recursive creation may report an existing collection as an error.
    }

    try {
      await this.client.createDirectory(storePath, { recursive: true });
    } catch {
      // no-op: Recursive creation may report an existing collection as an error.
    }
  }
}
