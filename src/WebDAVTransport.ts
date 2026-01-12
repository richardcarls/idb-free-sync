import { type WebDAVClient, type FileStat } from 'webdav';

import { type SyncFileInfo } from './SyncTransport';
import { type BlobSyncTransport } from './BlobSyncTransport';
import { createWebDAVClient } from './internal/webdavAdapter';

/** Connection configuration for {@link WebDAVTransport}. */
export type WebDAVConfig = {
  /** Base URL of the WebDAV server (e.g. `https://cloud.example.com/remote.php/dav/files/user`). */
  url: string;
  /** Username for HTTP Basic authentication. */
  username?: string;
  /** Password for HTTP Basic authentication. */
  password?: string;
  /** Bearer token for token-based authentication. */
  token?: string;
};

const BASE_PATH = '/RecipeTome';

/** Syncs to a WebDAV server under `/RecipeTome`. */
export class WebDAVTransport implements BlobSyncTransport {
  readonly provider = 'webdav';
  readonly scopes: string[] = [];

  private readonly client: WebDAVClient;

  constructor(config: WebDAVConfig) {
    this.client = createWebDAVClient(config);
  }

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
      // Ignore if already gone
    }
  }

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
      // Ignore if already gone
    }
  }

  async count(storeName: string): Promise<number> {
    return (await this.list(storeName)).length;
  }

  // --- Blob methods ---

  async putBlob(
    storeName: string,
    blobKey: string,
    blob: Blob,
    contentType = 'application/octet-stream',
  ): Promise<SyncFileInfo> {
    const path = `${BASE_PATH}/${storeName}-blobs/${blobKey}`;
    await this.ensureBlobDirectory(storeName);
    await this.client.putFileContents(path, await blob.arrayBuffer(), {
      overwrite: true,
      headers: { 'Content-Type': contentType },
    });
    const stat = (await this.client.stat(path)) as FileStat;
    return {
      id: path,
      syncKey: blobKey,
      modified: stat.lastmod ? new Date(stat.lastmod) : undefined,
      size: stat.size,
    };
  }

  async getBlob(storeName: string, blobKey: string): Promise<Blob | undefined> {
    try {
      const path = `${BASE_PATH}/${storeName}-blobs/${blobKey}`;
      const buffer = (await this.client.getFileContents(path, {
        format: 'binary',
      })) as ArrayBuffer;
      return new Blob([buffer]);
    } catch {
      return undefined;
    }
  }

  async listBlobs(storeName: string): Promise<SyncFileInfo[]> {
    const path = `${BASE_PATH}/${storeName}-blobs`;
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

  async deleteBlob(storeName: string, blobKey: string): Promise<void> {
    try {
      await this.client.deleteFile(
        `${BASE_PATH}/${storeName}-blobs/${blobKey}`,
      );
    } catch {
      // Ignore if already gone
    }
  }

  // --- Private helpers ---

  private async ensureDirectory(storeName: string): Promise<void> {
    const basePath = BASE_PATH;
    const storePath = `${BASE_PATH}/${storeName}`;
    try {
      await this.client.createDirectory(basePath, { recursive: true });
    } catch {
      /* already exists */
    }
    try {
      await this.client.createDirectory(storePath, { recursive: true });
    } catch {
      /* already exists */
    }
  }

  private async ensureBlobDirectory(storeName: string): Promise<void> {
    const blobPath = `${BASE_PATH}/${storeName}-blobs`;
    try {
      await this.client.createDirectory(BASE_PATH, { recursive: true });
    } catch {
      /* already exists */
    }
    try {
      await this.client.createDirectory(blobPath, { recursive: true });
    } catch {
      /* already exists */
    }
  }
}
