import { type SyncFileInfo } from './SyncTransport';
import { type BlobSyncTransport } from './BlobSyncTransport';
import { type TokenProvider } from './TokenProvider';
import { request } from './internal/request';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS =
  'id,name,mimeType,parents,properties,modifiedTime,createdTime,md5Checksum,size';

/** The subset of the Drive v3 File resource this transport reads/writes. */
type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  properties?: Record<string, string>;
  modifiedTime?: string;
  createdTime?: string;
  md5Checksum?: string;
  size?: string;
};
type DriveFileWithId = Omit<DriveFile, 'id'> & { id: string };

/** Syncs to Google Drive `appDataFolder` via the Drive v3 REST API. */
export class GoogleDriveTransport implements BlobSyncTransport {
  readonly provider = 'google';
  readonly scopes = [
    'https://www.googleapis.com/auth/drive.appdata',
    'https://www.googleapis.com/auth/drive.file',
  ];

  constructor(private readonly tokenProvider: TokenProvider) {}

  async list(storeName: string): Promise<SyncFileInfo[]> {
    return (await this.listRawFiles(storeName)).map((file) =>
      this.toSyncFileInfo(file),
    );
  }

  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    const files = await this.listRawFiles(storeName);
    const file = files.find(({ name }) => name === syncKey);

    if (!file?.id) {
      return undefined;
    }

    const response = await this.driveFetch(`/files/${file.id}?alt=media`);

    return JSON.parse(await response.text()) as T;
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

    const driveFile = await this.uploadMultipart(
      existingId,
      syncKey,
      {
        mimeType,
        name: syncKey,
        parents: existingId ? undefined : [folder.id],
        properties: meta,
      },
      new File([JSON.stringify(value)], syncKey, { type: mimeType }),
      FILE_FIELDS,
    );

    return this.toSyncFileInfo(driveFile);
  }

  async delete(
    storeName: string,
    syncKey: string,
    soft?: boolean,
  ): Promise<void> {
    const files = await this.listRawFiles(storeName);
    const existingId = files.find(({ name }) => name === syncKey)?.id;

    if (!existingId) {
      return;
    }

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
      await this.driveFetch(`/files/${existingId}`, { method: 'DELETE' });
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

      if (folder?.id) {
        await this.driveFetch(`/files/${folder.id}`, { method: 'DELETE' });
      }
    }
  }

  async count(storeName: string): Promise<number> {
    return (await this.list(storeName)).length;
  }

  async putBlob(
    storeName: string,
    blobKey: string,
    blob: Blob,
    contentType = 'application/octet-stream',
  ): Promise<SyncFileInfo> {
    const folder = await this.getBlobFolder(storeName, true);
    const existing = await this.listRawBlobFiles(storeName);
    const existingId = existing.find(({ name }) => name === blobKey)?.id;

    const driveFile = await this.uploadMultipart(
      existingId,
      blobKey,
      { name: blobKey, parents: existingId ? undefined : [folder.id] },
      new File([blob], blobKey, { type: contentType }),
      'id,name,modifiedTime,createdTime,md5Checksum,size',
    );

    return this.toSyncFileInfo(driveFile);
  }

  async getBlob(storeName: string, blobKey: string): Promise<Blob | undefined> {
    const files = await this.listRawBlobFiles(storeName);
    const file = files.find(({ name }) => name === blobKey);

    if (!file?.id) {
      return undefined;
    }

    const response = await this.driveFetch(`/files/${file.id}?alt=media`);

    return response.blob();
  }

  async listBlobs(storeName: string): Promise<SyncFileInfo[]> {
    return (await this.listRawBlobFiles(storeName)).map((f) =>
      this.toSyncFileInfo(f),
    );
  }

  async deleteBlob(storeName: string, blobKey: string): Promise<void> {
    const files = await this.listRawBlobFiles(storeName);
    const existingId = files.find(({ name }) => name === blobKey)?.id;

    if (!existingId) {
      return;
    }

    await this.driveFetch(`/files/${existingId}`, { method: 'DELETE' });
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

  /** Bearer-authenticated fetch against the Drive v3 REST API. */
  private async driveFetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await this.tokenProvider();

    return request(`${DRIVE_API}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });
  }

  /** Drive's multipart upload endpoint, used for both create and update. */
  private async uploadMultipart(
    existingId: string | undefined,
    fileName: string,
    resource: Record<string, unknown>,
    contents: File,
    fields: string,
  ): Promise<DriveFile> {
    const token = await this.tokenProvider();

    const formData = new FormData();

    formData.append(
      'resource',
      new File([JSON.stringify(resource)], fileName, {
        type: 'application/json',
      }),
    );

    formData.append('media', contents);

    const url = existingId
      ? `${DRIVE_UPLOAD_API}/files/${existingId}?uploadType=multipart&fields=${fields}`
      : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${fields}`;

    const response = await request(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    return (await response.json()) as DriveFile;
  }

  private async listFiles(query: string): Promise<DriveFile[]> {
    const response = await this.driveFetch(
      `/files?q=${encodeURIComponent(query)}&spaces=appDataFolder&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`,
    );
    const data = (await response.json()) as { files?: DriveFile[] };

    return data.files ?? [];
  }

  private async listRawFiles(storeName: string): Promise<DriveFile[]> {
    const folder = await this.getDriveFolder(storeName);

    return this.listFiles(`'${folder.id}' in parents`);
  }

  private async listRawBlobFiles(storeName: string): Promise<DriveFile[]> {
    try {
      const folder = await this.getBlobFolder(storeName);

      return this.listFiles(`'${folder.id}' in parents`);
    } catch {
      return [];
    }
  }

  private async getDriveFolder(
    name: string,
    create?: boolean,
  ): Promise<DriveFileWithId> {
    const folderList = await this.listFiles(
      `name = '${name}' and mimeType = 'application/vnd.google-apps.folder'`,
    );

    if (!folderList.length) {
      if (!create) {
        console.warn(`Folder with name "${name}" does not exist.`);
      }

      const ids = await this.generateIds(1);

      if (!ids.length) {
        throw new Error('No id generated for folder.');
      }

      const response = await this.driveFetch('/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: ids[0],
          mimeType: 'application/vnd.google-apps.folder',
          name,
          parents: ['appDataFolder'],
        }),
      });

      return (await response.json()) as DriveFileWithId;
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
    if (count < 1) {
      throw new RangeError(`count of ${count} is out of bounds.`);
    }

    const response = await this.driveFetch(
      `/files/generateIds?count=${count}&space=appDataFolder`,
    );
    const data = (await response.json()) as { ids?: string[] };

    return data.ids ?? [];
  }
}
