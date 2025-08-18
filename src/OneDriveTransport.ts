import {
  PublicClientApplication,
  type AccountInfo,
  InteractionRequiredAuthError,
} from '@azure/msal-browser';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

type GraphDriveItem = {
  id: string;
  name: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
  size: number;
  file?: object;
};

export class OneDriveTransport implements SyncTransport {
  readonly provider = 'onedrive';
  readonly scopes = ['Files.ReadWrite.AppFolder', 'openid', 'profile'];

  private readonly clientId: string;
  private msalInstance: PublicClientApplication | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  async list(storeName: string): Promise<SyncFileInfo[]> {
    const token = await this.getToken();
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}:/children?$select=id,name,lastModifiedDateTime,createdDateTime,size,file`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) return [];
    if (!response.ok)
      throw new Error(`OneDrive list failed: ${response.status}`);

    const data = (await response.json()) as { value: GraphDriveItem[] };
    return (data.value ?? [])
      .filter((item) => item.file)
      .map((item) => ({
        id: item.id,
        syncKey: item.name,
        modified: new Date(item.lastModifiedDateTime),
        created: new Date(item.createdDateTime),
        size: item.size,
      }));
  }

  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    const token = await this.getToken();
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}/${syncKey}:/content`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(`OneDrive get failed: ${response.status}`);

    return (await response.json()) as T;
  }

  async put<T>(
    storeName: string,
    syncKey: string,
    value: T,
  ): Promise<SyncFileInfo> {
    const token = await this.getToken();

    // Ensure parent directory exists
    await this.ensureDirectory(storeName, token);

    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}/${syncKey}:/content`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });

    if (!response.ok)
      throw new Error(`OneDrive put failed: ${response.status}`);

    const item = (await response.json()) as GraphDriveItem;
    return {
      id: item.id,
      syncKey: item.name,
      modified: new Date(item.lastModifiedDateTime),
      created: new Date(item.createdDateTime),
      size: item.size,
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

    const token = await this.getToken();
    const fileId = await this.getFileId(storeName, syncKey, token);
    if (!fileId) return;

    const url = `${GRAPH_BASE}/me/drive/items/${fileId}`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
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

    const token = await this.getToken();
    const dirId = await this.getDirectoryId(storeName, token);
    if (!dirId) return;

    await fetch(`${GRAPH_BASE}/me/drive/items/${dirId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async count(storeName: string): Promise<number> {
    return (await this.list(storeName)).length;
  }

  // --- Private helpers ---

  private async getToken(): Promise<string> {
    await this.ensureMsal();
    const accounts = this.msalInstance!.getAllAccounts();
    const account: AccountInfo | null = accounts[0] ?? null;

    try {
      const result = await this.msalInstance!.acquireTokenSilent({
        scopes: this.scopes,
        account: account ?? undefined,
      });
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError || !account) {
        const result = await this.msalInstance!.acquireTokenPopup({
          scopes: this.scopes,
        });
        return result.accessToken;
      }
      throw err;
    }
  }

  private async ensureMsal(): Promise<void> {
    if (this.msalInstance) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.msalInstance = new PublicClientApplication({
          auth: {
            clientId: this.clientId,
            authority: 'https://login.microsoftonline.com/common',
            redirectUri: window.location.origin,
          },
          cache: { cacheLocation: 'localStorage' },
        });
        await this.msalInstance.initialize();
        await this.msalInstance.handleRedirectPromise();
      })();
    }
    await this.initPromise;
  }

  private async ensureDirectory(name: string, token: string): Promise<void> {
    const url = `${GRAPH_BASE}/me/drive/special/approot/children`;
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
    });
    // Ignore 409 conflicts (directory already exists)
  }

  private async getFileId(
    storeName: string,
    syncKey: string,
    token: string,
  ): Promise<string | null> {
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}/${syncKey}?$select=id`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const item = (await response.json()) as { id: string };
    return item.id ?? null;
  }

  private async getDirectoryId(
    name: string,
    token: string,
  ): Promise<string | null> {
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${name}?$select=id`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const item = (await response.json()) as { id: string };
    return item.id ?? null;
  }
}
