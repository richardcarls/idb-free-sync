import {
  type AccountInfo,
  InteractionRequiredAuthError,
  type PublicClientApplication,
} from '@azure/msal-browser';

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';
import { createMsalClient } from './internal/msalAdapter';
import { request } from './internal/request';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

type GraphDriveItem = {
  /** Microsoft Graph's unique identifier for the drive item. */
  id: string;

  /** File name used as the provider-neutral sync key. */
  name: string;

  /** Timestamp of the drive item's most recent modification. */
  lastModifiedDateTime: string;

  /** Timestamp when the drive item was created. */
  createdDateTime: string;

  /** Size of the drive item, in bytes. */
  size: number;

  /** File facet present when the drive item represents a file. */
  file?: object;
};

/**
 * {@link SyncTransport} for OneDrive's application folder.
 *
 * The transport requests a Microsoft Graph access token lazily when an
 * operation first needs the OneDrive API.
 */
export class OneDriveTransport implements SyncTransport {
  readonly provider = 'onedrive';

  /** Microsoft Graph scopes required to manage app-folder sync files. */
  readonly scopes = ['Files.ReadWrite.AppFolder', 'openid', 'profile'];

  private readonly clientId: string;
  private msalInstance: PublicClientApplication | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Creates a OneDrive transport.
   *
   * @param clientId - Microsoft Entra application client ID
   */
  constructor(clientId: string) {
    this.clientId = clientId;
  }

  /** Lists metadata for every file in a OneDrive sync folder. */
  async list(storeName: string): Promise<SyncFileInfo[]> {
    const token = await this.getToken();
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}:/children?$select=id,name,lastModifiedDateTime,createdDateTime,size,file`;
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      throw new Error(`OneDrive list failed: ${response.status}`);
    }

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

  /**
   * Downloads and parses a JSON file, or returns `undefined` when absent.
   *
   * @typeParam T - JSON-serializable record type
   */
  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    const token = await this.getToken();
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}/${syncKey}:/content`;
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`OneDrive get failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }

  /**
   * Creates or replaces a JSON file and returns its updated OneDrive metadata.
   *
   * @typeParam T - JSON-serializable record type
   */
  async put<T>(
    storeName: string,
    syncKey: string,
    value: T,
  ): Promise<SyncFileInfo> {
    const token = await this.getToken();

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

    if (!response.ok) {
      throw new Error(`OneDrive put failed: ${response.status}`);
    }

    const item = (await response.json()) as GraphDriveItem;

    return {
      id: item.id,
      syncKey: item.name,
      modified: new Date(item.lastModifiedDateTime),
      created: new Date(item.createdDateTime),
      size: item.size,
    };
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

    const token = await this.getToken();
    const fileId = await this.getFileId(storeName, syncKey, token);

    if (!fileId) {
      return;
    }

    const url = `${GRAPH_BASE}/me/drive/items/${fileId}`;

    await request(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
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

    const token = await this.getToken();
    const dirId = await this.getDirectoryId(storeName, token);

    if (!dirId) {
      return;
    }

    await request(`${GRAPH_BASE}/me/drive/items/${dirId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  /** Counts files in a OneDrive sync folder. */
  async count(storeName: string): Promise<number> {
    return (await this.list(storeName)).length;
  }

  /** Resolves a Microsoft Graph access token for the current user. */
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

  /** Initializes the Microsoft Authentication Library client once. */
  private async ensureMsal(): Promise<void> {
    if (this.msalInstance) {
      return;
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.msalInstance = createMsalClient(this.clientId);

        await this.msalInstance.initialize();
        await this.msalInstance.handleRedirectPromise();
      })();
    }

    await this.initPromise;
  }

  /** Creates a OneDrive sync folder when it is missing. */
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
  }

  /** Finds a file ID by sync key, returning `null` when absent. */
  private async getFileId(
    storeName: string,
    syncKey: string,
    token: string,
  ): Promise<string | null> {
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${storeName}/${syncKey}?$select=id`;
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return null;
    }

    const item = (await response.json()) as { id: string };

    return item.id ?? null;
  }

  /** Finds a sync folder ID, returning `null` when absent. */
  private async getDirectoryId(
    name: string,
    token: string,
  ): Promise<string | null> {
    const url = `${GRAPH_BASE}/me/drive/special/approot:/${name}?$select=id`;
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return null;
    }

    const item = (await response.json()) as { id: string };

    return item.id ?? null;
  }
}
