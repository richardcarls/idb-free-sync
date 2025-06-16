/// <reference types="gapi" />
/// <reference types="gapi.client.drive-v3" />
/// <reference types="google.accounts" />

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

type DriveFile = gapi.client.drive.File;
type DriveFileWithId = Omit<DriveFile, 'id'> & { id: string };

export class GoogleDriveTransport implements SyncTransport {
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

    const response = await fetch(url, {
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

  private get client(): Promise<typeof gapi.client> {
    if (gapi != null && gapi.client != null)
      return Promise.resolve(gapi.client);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (google !== undefined && gapi !== undefined) {
          clearTimeout(timeout);
          const tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: this.clientId,
            scope: this.scopes.join(' '),
            prompt: '',
            login_hint: window.localStorage.getItem('syncUserId') ?? undefined,
            callback: (tokenResponse: google.accounts.oauth2.TokenResponse) => {
              gapi.load('client', async () => {
                await gapi.client.init({
                  discoveryDocs: [
                    'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
                  ],
                });
                if (tokenResponse && tokenResponse.access_token) {
                  gapi.auth.setToken(tokenResponse);
                }
                resolve(gapi.client);
              });
            },
          });
          tokenClient.requestAccessToken();
        }
      }, 1000);
    });
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
