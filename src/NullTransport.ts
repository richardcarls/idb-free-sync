import { type SyncFileInfo } from './SyncTransport';
import { type BlobSyncTransport } from './BlobSyncTransport';

/**
 * No-op transport. Implements {@link BlobSyncTransport} without persisting
 * anything. Useful for disabling sync without changing application logic, and
 * for use with `blobFields` in tests or offline-only builds.
 */
export class NullTransport implements BlobSyncTransport {
  readonly provider = 'none';
  readonly scopes: string[] = [];

  async list(): Promise<SyncFileInfo[]> {
    return [];
  }

  async get(): Promise<undefined> {
    return undefined;
  }

  async put<_T>(_storeName: string, syncKey: string): Promise<SyncFileInfo> {
    return { id: syncKey, syncKey };
  }

  async delete(): Promise<void> {}

  async deleteAll(): Promise<void> {}

  async count(): Promise<number> {
    return 0;
  }

  async putBlob(_storeName: string, blobKey: string): Promise<SyncFileInfo> {
    return { id: blobKey, syncKey: blobKey };
  }

  async getBlob(): Promise<undefined> {
    return undefined;
  }

  async listBlobs(): Promise<SyncFileInfo[]> {
    return [];
  }

  async deleteBlob(): Promise<void> {}
}
