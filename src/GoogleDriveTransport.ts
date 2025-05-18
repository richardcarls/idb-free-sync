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

  async list(_storeName: string): Promise<SyncFileInfo[]> {
    return [];
  }
  async get<T>(_storeName: string, _syncKey: string): Promise<T | undefined> {
    return undefined;
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
  async count(_storeName: string): Promise<number> {
    return 0;
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
}
