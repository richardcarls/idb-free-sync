import {
  type AccountInfo,
  InteractionRequiredAuthError,
  type PublicClientApplication,
} from '@azure/msal-browser';

import { type SyncFileInfo } from './SyncTransport';
import { type BlobSyncTransport } from './BlobSyncTransport';
import { createMsalClient } from './internal/msalAdapter';
import { request } from './internal/request';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

type GraphDriveItem = {
  id: string;
  name: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
  size: number;
  file?: object;
};

/** Syncs to the OneDrive application folder via Microsoft Graph. */
export class OneDriveTransport implements BlobSyncTransport {
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
    const response = await request(url, {
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
    const response = await request(url, {
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
    const response = await request(url, {
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
    await request(url, {
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

    await request(`${GRAPH_BASE}/me/drive/items/${dirId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
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
    const token = await this.getToken();
    await this.ensureDirectory(`${storeName}-blobs`, token);

    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}-blobs/${blobKey}:/content`;
    const response = await request(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
      },
      body: blob,
    });

    if (!response.ok)
      throw new Error(`OneDrive putBlob failed: ${response.status}`);

    const item = (await response.json()) as GraphDriveItem;
    return {
      id: item.id,
      syncKey: item.name,
      modified: new Date(item.lastModifiedDateTime),
      created: new Date(item.createdDateTime),
      size: item.size,
    };
  }

  async getBlob(storeName: string, blobKey: string): Promise<Blob | undefined> {
    const token = await this.getToken();
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}-blobs/${blobKey}:/content`;
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(`OneDrive getBlob failed: ${response.status}`);

    return response.blob();
  }

  async listBlobs(storeName: string): Promise<SyncFileInfo[]> {
    const token = await this.getToken();
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}-blobs:/children?$select=id,name,lastModifiedDateTime,createdDateTime,size,file`;
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) return [];
    if (!response.ok)
      throw new Error(`OneDrive listBlobs failed: ${response.status}`);

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

  async deleteBlob(storeName: string, blobKey: string): Promise<void> {
    const token = await this.getToken();
    const fileId = await this.getFileId(`${storeName}-blobs`, blobKey, token);
    if (!fileId) return;

    await request(`${GRAPH_BASE}/me/drive/items/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
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
        this.msalInstance = createMsalClient(this.clientId);
        await this.msalInstance.initialize();
        await this.msalInstance.handleRedirectPromise();
      })();
    }
    await this.initPromise;
  }

  private async ensureDirectory(name: string, token: string): Promise<void> {
    const url = `${GRAPH_BASE}/me/drive/special/approot/children`;
    await request(url, {
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
    const response = await request(url, {
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
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const item = (await response.json()) as { id: string };
    return item.id ?? null;
  }
}
