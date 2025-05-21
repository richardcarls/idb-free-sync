/// <reference types="gapi" />
/// <reference types="gapi.client.drive-v3" />

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
    ).drive.files.get({ fileId: file.id, alt: 'media' });
    return JSON.parse(response.body) as T;
  }

  async put<T>(
    _storeName: string,
    syncKey: string,
    _value: T,
  ): Promise<SyncFileInfo> {
    return { id: syncKey, syncKey };
  }
  async delete(_storeName: string, _syncKey: string): Promise<void> {}
  async deleteAll(_storeName: string): Promise<void> {}
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
                if (tokenResponse?.access_token)
                  gapi.auth.setToken(tokenResponse);
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
