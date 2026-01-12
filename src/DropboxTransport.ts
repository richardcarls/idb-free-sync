import { type files } from 'dropbox';

import { type SyncFileInfo } from './SyncTransport';
import { type BlobSyncTransport } from './BlobSyncTransport';
import { createDropboxClient } from './internal/dropboxAdapter';

const APP_PATH = '/Apps/RecipeTome';

/** Syncs to Dropbox under `/Apps/RecipeTome` via the Dropbox SDK. */
export class DropboxTransport implements BlobSyncTransport {
  readonly provider = 'dropbox';
  readonly scopes: string[] = [];

  private get client() {
    return createDropboxClient();
  }

  async list(storeName: string): Promise<SyncFileInfo[]> {
    const path = `${APP_PATH}/${storeName}`;
    try {
      const response = await this.client.filesListFolder({ path });
      return (response.result.entries ?? [])
        .filter((e): e is files.FileMetadataReference => e['.tag'] === 'file')
        .map((file) => ({
          id: file.id,
          syncKey: file.name,
          modified: file.client_modified
            ? new Date(file.client_modified)
            : undefined,
          size: file.size,
        }));
    } catch (err: unknown) {
      // 409 = path not found (empty store)
      if (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status: number }).status === 409
      ) {
        return [];
      }
      throw err;
    }
  }

  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    try {
      const response = await this.client.filesDownload({
        path: `${APP_PATH}/${storeName}/${syncKey}`,
      });
      const meta = response.result as files.FileMetadata & { fileBlob?: Blob };
      if (!meta.fileBlob) return undefined;
      const text = await meta.fileBlob.text();
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
    const json = JSON.stringify(value);
    const blob = new Blob([json], { type: 'application/json' });

    const response = await this.client.filesUpload({
      path: `${APP_PATH}/${storeName}/${syncKey}`,
      mode: { '.tag': 'overwrite' },
      contents: blob,
    });

    const file = response.result;
    return {
      id: file.id,
      syncKey: file.name,
      modified: file.client_modified
        ? new Date(file.client_modified)
        : undefined,
      size: file.size,
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

    await this.client.filesDeleteV2({
      path: `${APP_PATH}/${storeName}/${syncKey}`,
    });
  }

  async deleteAll(storeName: string, soft?: boolean): Promise<void> {
    if (soft) {
      const files = await this.list(storeName);
      await Promise.allSettled(
        files.map((f) => this.delete(storeName, f.syncKey, true)),
      );
      return;
    }

    await this.client.filesDeleteV2({ path: `${APP_PATH}/${storeName}` });
  }

  async count(storeName: string): Promise<number> {
    return (await this.list(storeName)).length;
  }

  // --- Blob methods ---

  async putBlob(
    storeName: string,
    blobKey: string,
    blob: Blob,
  ): Promise<SyncFileInfo> {
    const response = await this.client.filesUpload({
      path: `${APP_PATH}/${storeName}-blobs/${blobKey}`,
      mode: { '.tag': 'overwrite' },
      contents: blob,
    });

    const file = response.result;
    return {
      id: file.id,
      syncKey: file.name,
      modified: file.client_modified
        ? new Date(file.client_modified)
        : undefined,
      size: file.size,
    };
  }

  async getBlob(storeName: string, blobKey: string): Promise<Blob | undefined> {
    try {
      const response = await this.client.filesDownload({
        path: `${APP_PATH}/${storeName}-blobs/${blobKey}`,
      });
      const meta = response.result as files.FileMetadata & { fileBlob?: Blob };
      return meta.fileBlob;
    } catch {
      return undefined;
    }
  }

  async listBlobs(storeName: string): Promise<SyncFileInfo[]> {
    const path = `${APP_PATH}/${storeName}-blobs`;
    try {
      const response = await this.client.filesListFolder({ path });
      return (response.result.entries ?? [])
        .filter((e): e is files.FileMetadataReference => e['.tag'] === 'file')
        .map((file) => ({
          id: file.id,
          syncKey: file.name,
          modified: file.client_modified
            ? new Date(file.client_modified)
            : undefined,
          size: file.size,
        }));
    } catch {
      return [];
    }
  }

  async deleteBlob(storeName: string, blobKey: string): Promise<void> {
    try {
      await this.client.filesDeleteV2({
        path: `${APP_PATH}/${storeName}-blobs/${blobKey}`,
      });
    } catch {
      // Ignore if absent
    }
  }
}
