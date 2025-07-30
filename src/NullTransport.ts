import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

/**
 * No-op transport for disabling remote persistence while preserving the
 * {@link SyncTransport} interface.
 */
export class NullTransport implements SyncTransport {
  readonly provider = 'none';

  /** The null transport requires no OAuth scopes. */
  readonly scopes: string[] = [];

  /** Returns an empty remote file listing. */
  async list(): Promise<SyncFileInfo[]> {
    return [];
  }

  /** Always reports that the requested remote value does not exist. */
  async get(): Promise<undefined> {
    return undefined;
  }

  /**
   * Reports successful metadata without persisting the supplied value.
   *
   * @typeParam _T - ignored record type
   */
  async put<_T>(_storeName: string, syncKey: string): Promise<SyncFileInfo> {
    return { id: syncKey, syncKey };
  }

  /** Performs no deletion. */
  async delete(): Promise<void> {}

  /** Performs no deletion. */
  async deleteAll(): Promise<void> {}

  /** Always reports zero remote items. */
  async count(): Promise<number> {
    return 0;
  }
}
