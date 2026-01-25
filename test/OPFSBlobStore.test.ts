import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OPFSBlobStore } from '../src/BlobStore';

// Minimal in-memory OPFS mock
function makeMockDir() {
  const files = new Map<string, Blob>();

  return {
    _files: files,

    getFileHandle: vi.fn(async (key: string, opts?: { create?: boolean }) => {
      if (!files.has(key) && !opts?.create) {
        throw new DOMException('File not found', 'NotFoundError');
      }

      const handle = {
        getFile: vi.fn(async () => files.get(key) as Blob),
        createWritable: vi.fn(async () => {
          let written: BlobPart | undefined;

          return {
            write: vi.fn(async (data: BlobPart) => {
              written = data;
            }),

            close: vi.fn(async () => {
              if (written !== undefined) {
                files.set(key, new Blob([written as BlobPart]));
              }
            }),
          };
        }),
      };
      return handle;
    }),

    removeEntry: vi.fn(async (key: string) => {
      if (!files.has(key)) {
        throw new DOMException('File not found', 'NotFoundError');
      }

      files.delete(key);
    }),

    entries: async function* () {
      for (const [name] of files) {
        yield [name, {}] as const;
      }
    },
  };
}

let mockDir: ReturnType<typeof makeMockDir>;

beforeEach(() => {
  mockDir = makeMockDir();

  const mockOpfsRoot = {
    getDirectoryHandle: vi.fn(async () => mockDir),
  };

  Object.defineProperty(navigator, 'storage', {
    value: { getDirectory: vi.fn(async () => mockOpfsRoot) },
    writable: true,
    configurable: true,
  });
});

describe('OPFSBlobStore', () => {
  it('put and get round-trips a blob', async () => {
    const store = new OPFSBlobStore('test-blobs');
    const blob = new Blob(['hello'], { type: 'text/plain' });

    await store.put('key1', blob);

    const result = await store.get('key1');
    expect(result).toBeInstanceOf(Blob);
    expect(await result!.text()).toBe('hello');
  });

  it('get returns undefined for missing keys', async () => {
    const store = new OPFSBlobStore('test-blobs');

    expect(await store.get('missing')).toBeUndefined();
  });

  it('has returns true for existing keys and false for missing', async () => {
    const store = new OPFSBlobStore('test-blobs');
    const blob = new Blob(['data']);

    await store.put('exists', blob);

    expect(await store.has('exists')).toBe(true);
    expect(await store.has('missing')).toBe(false);
  });

  it('delete removes an existing entry', async () => {
    const store = new OPFSBlobStore('test-blobs');

    await store.put('del', new Blob(['bye']));
    await store.delete('del');

    expect(await store.get('del')).toBeUndefined();
  });

  it('delete on a missing key does not throw', async () => {
    const store = new OPFSBlobStore('test-blobs');

    await expect(store.delete('ghost')).resolves.toBeUndefined();
  });

  it('list returns all stored keys', async () => {
    const store = new OPFSBlobStore('test-blobs');

    await store.put('a', new Blob(['a']));
    await store.put('b', new Blob(['b']));

    const keys = await store.list();

    expect(keys).toContain('a');
    expect(keys).toContain('b');
    expect(keys).toHaveLength(2);
  });
});
