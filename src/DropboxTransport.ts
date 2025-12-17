import { type files } from 'dropbox';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';
import { createDropboxClient } from './internal/dropboxAdapter';

const APP_PATH = '/Apps/RecipeTome';

/**
 * {@link SyncTransport} for Dropbox's application folder.
 *
 * The transport reads an access token from local storage lazily when an
 * operation first needs the Dropbox API.
 */
export class DropboxTransport implements SyncTransport {
  readonly provider = 'dropbox';

  /** Dropbox scopes are managed by the caller's OAuth flow. */
  readonly scopes: string[] = [];

  /** Resolves a Dropbox SDK client for the current access token. */
  private get client() {
    return createDropboxClient();
  }

  /** Lists metadata for every file in a Dropbox sync folder. */
  async list(storeName: string): Promise<SyncFileInfo[]> {
    try {
      const response = await this.client.filesListFolder({
        path: `${APP_PATH}/${storeName}`,
      });

      return (response.result.entries ?? [])
        .filter((e): e is files.FileMetadataReference => e['.tag'] === 'file')
        .map((file) => this.toSyncFileInfo(file));
    } catch (err) {
      if (this.isPathNotFound(err)) {
        return [];
      }

      throw err;
    }
  }

  /**
   * Downloads and parses a JSON file, or returns `undefined` when absent.
   *
   * @typeParam T - JSON-serializable record type
   */
  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    try {
      const response = await this.client.filesDownload({
        path: `${APP_PATH}/${storeName}/${syncKey}`,
      });

      const meta = response.result as files.FileMetadata & { fileBlob?: Blob };

      if (!meta.fileBlob) {
        return undefined;
      }

      const text = await meta.fileBlob.text();

      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * Creates or replaces a JSON file and returns its updated Dropbox metadata.
   *
   * @typeParam T - JSON-serializable record type
   */
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

    return this.toSyncFileInfo(file);
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

    await this.client.filesDeleteV2({
      path: `${APP_PATH}/${storeName}/${syncKey}`,
    });
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

    await this.client.filesDeleteV2({ path: `${APP_PATH}/${storeName}` });
  }

  /** Counts files in a Dropbox sync folder. */
  async count(storeName: string): Promise<number> {
    return (await this.list(storeName)).length;
  }

  /** Converts Dropbox metadata into provider-neutral sync metadata. */
  private toSyncFileInfo(file: files.FileMetadata): SyncFileInfo {
    return {
      id: file.id,
      syncKey: file.name,
      modified: file.client_modified
        ? new Date(file.client_modified)
        : undefined,
      size: file.size,
    };
  }

  /** Dropbox returns 409 when a requested path does not exist. */
  private isPathNotFound(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'status' in err &&
      err.status === 409
    );
  }
}
