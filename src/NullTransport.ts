import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

export class NullTransport implements SyncTransport {
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
}
