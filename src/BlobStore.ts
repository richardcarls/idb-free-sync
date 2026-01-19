/** Local binary storage backend for blob fields. */
export interface BlobStore {
  get(key: string): Promise<Blob | undefined>;
  put(key: string, blob: Blob): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  has(key: string): Promise<boolean>;
}

/**
 * OPFS-backed {@link BlobStore}. Stores blobs under a named subdirectory of
 * the origin-private file system (`navigator.storage.getDirectory()`).
 *
 * @example
 * const store = new OPFSBlobStore('recipe-images');
 * await store.put('abc123', imageBlob);
 * const blob = await store.get('abc123'); // Blob | undefined
 */
export class OPFSBlobStore implements BlobStore {
  constructor(private readonly root = 'idb-free-sync-blobs') {}

  private async dir(): Promise<FileSystemDirectoryHandle> {
    return (await navigator.storage.getDirectory()).getDirectoryHandle(
      this.root,
      { create: true },
    );
  }

  async get(key: string): Promise<Blob | undefined> {
    try {
      return await (await (await this.dir()).getFileHandle(key)).getFile();
    } catch {
      return undefined;
    }
  }

  async put(key: string, blob: Blob): Promise<void> {
    const fh = await (await this.dir()).getFileHandle(key, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async delete(key: string): Promise<void> {
    try {
      await (await this.dir()).removeEntry(key);
    } catch {
      // Ignore — already absent
    }
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    for await (const [name] of (await this.dir()).entries()) {
      keys.push(name);
    }
    return keys;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }
}
