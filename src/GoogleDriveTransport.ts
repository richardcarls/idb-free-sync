/// <reference types="gapi" />
/// <reference types="gapi.client.drive-v3" />
/// <reference types="google.accounts" />

import { type SyncFileInfo } from './SyncTransport';
import { type BlobSyncTransport } from './BlobSyncTransport';
import { getGoogleClient } from './internal/googleAdapter';
import { request } from './internal/request';

type DriveFile = gapi.client.drive.File;
type DriveFileWithId = Omit<DriveFile, 'id'> & { id: string };

/** Syncs to Google Drive `appDataFolder` via the Drive v3 API. */
export class GoogleDriveTransport implements BlobSyncTransport {
  readonly provider = 'google';
  readonly scopes = [
    'https://www.googleapis.com/auth/drive.appdata',
    'https://www.googleapis.com/auth/drive.file',
  ];

  private readonly clientId: string;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  async list(storeName: string): Promise<SyncFileInfo[]> {
    const folder = await this.getDriveFolder(storeName);
    const result = await (
      await this.client
    ).drive.files.list({
      q: `'${folder.id}' in parents`,
      spaces: 'appDataFolder',
    });
    return (result.result.files ?? []).map((file) => this.toSyncFileInfo(file));
  }

  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    const files = await this.listRawFiles(storeName);
    const file = files.find(({ name }) => name === syncKey);
    if (!file?.id) return undefined;
    const response = await (
      await this.client
    ).drive.files.get({
      fileId: file.id,
      alt: 'media',
    });
    return JSON.parse(response.body) as T;
  }

  async put<T>(
    storeName: string,
    syncKey: string,
    value: T,
    meta?: Record<string, string>,
  ): Promise<SyncFileInfo> {
    const folder = await this.getDriveFolder(storeName, true);
    const files = await this.listRawFiles(storeName);

    const mimeType = 'application/json';
    const existingId = files.find(({ name }) => name === syncKey)?.id;

    const formData = new FormData();
    formData.append(
      'resource',
      new File(
        [
          JSON.stringify({
            mimeType,
            name: syncKey,
            parents: existingId ? null : [folder.id],
            properties: meta,
          }),
        ],
        syncKey,
        { type: mimeType },
      ),
    );
    formData.append(
      'media',
      new File([JSON.stringify(value)], syncKey, { type: mimeType }),
    );

    await this.client;

    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,version,name,modifiedTime,createdTime,md5Checksum,size,properties`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version,name,modifiedTime,createdTime,md5Checksum,size,properties`;

    const response = await request(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${gapi.auth.getToken().access_token}` },
      body: formData,
    });

    const driveFile = (await response.json()) as DriveFile;
    return this.toSyncFileInfo(driveFile);
  }

  async delete(
    storeName: string,
    syncKey: string,
    soft?: boolean,
  ): Promise<void> {
    const files = await this.listRawFiles(storeName);
    const existingId = files.find(({ name }) => name === syncKey)?.id;
    if (!existingId) return;

    if (soft) {
      const value = await this.get(storeName, syncKey);
      if (value && typeof value === 'object') {
        await this.put(
          storeName,
          syncKey,
          { ...value, deleted: true },
          { deleted: 'true' },
        );
      }
    } else {
      await (await this.client).drive.files.delete({ fileId: existingId });
    }
  }

  async deleteAll(storeName: string, soft?: boolean): Promise<void> {
    if (soft) {
      const files = await this.listRawFiles(storeName);
      await Promise.allSettled(
        files.map((file) =>
          file.name ? this.delete(storeName, file.name, true) : undefined,
        ),
      );
    } else {
      const folder = await this.getDriveFolder(storeName);
      if (folder?.id)
        await (await this.client).drive.files.delete({ fileId: folder.id });
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
    const folder = await this.getBlobFolder(storeName, true);
    const existing = await this.listRawBlobFiles(storeName);
    const existingId = existing.find(({ name }) => name === blobKey)?.id;

    const formData = new FormData();
    formData.append(
      'resource',
      new File(
        [
          JSON.stringify({
            name: blobKey,
            parents: existingId ? null : [folder.id],
          }),
        ],
        blobKey,
        { type: 'application/json' },
      ),
    );
    formData.append('media', new File([blob], blobKey, { type: contentType }));

    await this.client;

    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name,modifiedTime,createdTime,md5Checksum,size`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,createdTime,md5Checksum,size`;

    const response = await request(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${gapi.auth.getToken().access_token}` },
      body: formData,
    });

    const driveFile = (await response.json()) as DriveFile;
    return this.toSyncFileInfo(driveFile);
  }

  async getBlob(storeName: string, blobKey: string): Promise<Blob | undefined> {
    const files = await this.listRawBlobFiles(storeName);
    const file = files.find(({ name }) => name === blobKey);
    if (!file?.id) return undefined;
    const response = await (
      await this.client
    ).drive.files.get({ fileId: file.id, alt: 'media' });
    return new Blob([response.body]);
  }

  async listBlobs(storeName: string): Promise<SyncFileInfo[]> {
    try {
      const folder = await this.getBlobFolder(storeName);
      const result = await (
        await this.client
      ).drive.files.list({
        q: `'${folder.id}' in parents`,
        spaces: 'appDataFolder',
      });
      return (result.result.files ?? []).map((f) => this.toSyncFileInfo(f));
    } catch {
      return [];
    }
  }

  async deleteBlob(storeName: string, blobKey: string): Promise<void> {
    const files = await this.listRawBlobFiles(storeName);
    const existingId = files.find(({ name }) => name === blobKey)?.id;
    if (!existingId) return;
    await (await this.client).drive.files.delete({ fileId: existingId });
  }

  // --- Private helpers ---

  private toSyncFileInfo(file: DriveFile): SyncFileInfo {
    return {
      id: file.id ?? '',
      syncKey: file.name ?? '',
      modified: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
      created: file.createdTime ? new Date(file.createdTime) : undefined,
      checksum: file.md5Checksum ?? undefined,
      size: file.size ? parseInt(file.size) : undefined,
      deleted: Boolean(file.properties?.deleted),
    };
  }

  private async listRawFiles(storeName: string): Promise<DriveFile[]> {
    const folder = await this.getDriveFolder(storeName);
    const result = await (
      await this.client
    ).drive.files.list({
      q: `'${folder.id}' in parents`,
      spaces: 'appDataFolder',
    });
    return result.result.files ?? [];
  }

  private async listRawBlobFiles(storeName: string): Promise<DriveFile[]> {
    try {
      const folder = await this.getBlobFolder(storeName);
      const result = await (
        await this.client
      ).drive.files.list({
        q: `'${folder.id}' in parents`,
        spaces: 'appDataFolder',
      });
      return result.result.files ?? [];
    } catch {
      return [];
    }
  }

  private get client(): Promise<typeof gapi.client> {
    return getGoogleClient(this.clientId, this.scopes);
  }

  private async getDriveFolder(
    name: string,
    create?: boolean,
  ): Promise<DriveFileWithId> {
    const folderList =
      (
        await (
          await this.client
        ).drive.files.list({
          q: `name = '${name}' and mimeType = 'application/vnd.google-apps.folder'`,
          spaces: 'appDataFolder',
        })
      ).result?.files ?? [];

    if (!folderList.length) {
      if (!create) console.warn(`Folder with name "${name}" does not exist.`);
      const ids = await this.generateIds(1);
      if (!ids.length) throw new Error('No id generated for folder.');
      return (
        await (
          await this.client
        ).drive.files.create({
          uploadType: 'multipart',
          resource: {
            id: ids[0],
            mimeType: 'application/vnd.google-apps.folder',
            name,
            parents: ['appDataFolder'],
          },
        })
      ).result as DriveFileWithId;
    }
    return folderList[0] as DriveFileWithId;
  }

  private async getBlobFolder(
    storeName: string,
    create?: boolean,
  ): Promise<DriveFileWithId> {
    return this.getDriveFolder(`${storeName}-blobs`, create);
  }

  private async generateIds(count: number): Promise<string[]> {
    if (count < 1) throw new RangeError(`count of ${count} is out of bounds.`);
    return (
      (
        await (
          await this.client
        ).drive.files.generateIds({ count, space: 'appDataFolder' })
      ).result.ids ?? []
    );
  }
}
