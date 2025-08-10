/// <reference lib="DOM.AsyncIterable" />

import { type SyncTransport, type SyncFileInfo } from './SyncTransport';

// TODO: Transport for testing only, remove

/**
 * {@link SyncTransport} to persist data in the browser's Origin Private File System.
 */
export class OPFSTransport implements SyncTransport {
  readonly provider = 'opfs';

  /** OPFS requires no OAuth scopes. */
  readonly scopes: string[] = [];

  /** Lists JSON file metadata in an OPFS store directory. */
  async list(storeName: string): Promise<SyncFileInfo[]> {
    let storeRoot: FileSystemDirectoryHandle;

    try {
      storeRoot = await this.getFolder(storeName);
    } catch {
      return [];
    }

    const files: SyncFileInfo[] = [];
    for await (const [name, handle] of storeRoot.entries()) {
      if (handle.kind === 'file') {
        const file = await (await storeRoot.getFileHandle(name)).getFile();

        files.push({
          id: name,
          syncKey: name,
          modified: new Date(file.lastModified),
          size: file.size,
        });
      }
    }

    return files;
  }

  /**
   * Reads and parses a JSON file, returning `undefined` when it cannot be read.
   *
   * @typeParam T - JSON-serializable record type
   */
  async get<T>(storeName: string, syncKey: string): Promise<T | undefined> {
    try {
      const storeRoot = await this.getFolder(storeName);
      const handle = await storeRoot.getFileHandle(syncKey);
      const file = await handle.getFile();
      const json = await file.text();

      return JSON.parse(json) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * Serializes a value to a JSON file, creating the store directory as needed.
   *
   * @typeParam T - JSON-serializable record type
   */
  async put<T>(
    storeName: string,
    syncKey: string,
    value: T,
  ): Promise<SyncFileInfo> {
    const storeRoot = await this.getFolder(storeName, true);

    const handle = await storeRoot.getFileHandle(syncKey, { create: true });
    const writable = await handle.createWritable();

    const json = JSON.stringify(value, null, 2);
    const blob = new Blob([json], { type: 'application/json' });

    await writable.write(blob);
    await writable.close();

    const file = await handle.getFile();

    return {
      id: syncKey,
      syncKey,
      modified: new Date(file.lastModified),
      size: file.size,
    };
  }

  /** Permanently removes a file from an OPFS store directory. */
  async delete(storeName: string, syncKey: string): Promise<void> {
    const storeRoot = await this.getFolder(storeName);

    await storeRoot.removeEntry(syncKey, { recursive: true });
  }

  /** Permanently removes an OPFS store directory and all of its files. */
  async deleteAll(storeName: string): Promise<void> {
    const root = await navigator.storage.getDirectory();

    await root.removeEntry(storeName, { recursive: true });
  }

  /** Counts files in an OPFS store directory. */
  async count(storeName: string): Promise<number> {
    const items = await this.list(storeName);

    return items.length;
  }

  /** Opens an OPFS store directory, optionally creating it. */
  private async getFolder(
    name: string,
    create?: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();

    return root.getDirectoryHandle(name, { create });
  }
}
