import { Dropbox, type files } from 'dropbox';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

const APP_PATH = '/Apps/RecipeTome';

export class DropboxTransport implements SyncTransport {
  readonly provider = 'dropbox';
  readonly scopes: string[] = [];

  private get client(): Dropbox {
    const token = localStorage.getItem('dropboxAccessToken') ?? '';
    return new Dropbox({ accessToken: token });
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
      mode: { '.tag': 'add' },
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
}
