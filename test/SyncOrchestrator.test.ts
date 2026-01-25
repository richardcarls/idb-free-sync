import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultResolve,
  syncStore,
  type BlobFieldConfig,
  type SyncRecord,
} from '../src/SyncOrchestrator';
import type { BlobSyncTransport } from '../src/BlobSyncTransport';
import type { BlobStore } from '../src/BlobStore';
import type { SyncFileInfo, SyncTransport } from '../src/SyncTransport';

type NoteRecord = SyncRecord & { id: string; title: string; deleted?: boolean };
type TimestampedNote = SyncRecord & {
  id: string;
  title: string;
  updatedAt?: Date;
};
type RecipeRecord = SyncRecord & {
  id: string;
  name: string;
  imageUrl?: string;
};

const dbName = 'free-sync-orchestrator-test';
let db: IDBPDatabase;

function transport(
  files: SyncFileInfo[] = [],
  values: globalThis.Record<string, NoteRecord | undefined> = {},
): SyncTransport {
  const get = vi.fn((_store: string, key: string) =>
    Promise.resolve(values[key]),
  );
  return {
    provider: 'test',
    scopes: [],
    list: vi.fn().mockResolvedValue(files),
    get: get as SyncTransport['get'],
    put: vi.fn((_store, key) => Promise.resolve({ id: key, syncKey: key })),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(files.length),
  };
}

function blobTransport(
  records: SyncFileInfo[] = [],
  recordValues: globalThis.Record<string, RecipeRecord | undefined> = {},
  remoteBlobs: SyncFileInfo[] = [],
  remoteBlobValues: globalThis.Record<string, Blob | undefined> = {},
): BlobSyncTransport {
  const get = vi.fn((_store: string, key: string) =>
    Promise.resolve(recordValues[key]),
  );
  return {
    provider: 'blob-test',
    scopes: [],
    list: vi.fn().mockResolvedValue(records),
    get: get as SyncTransport['get'],
    put: vi.fn((_store, key) => Promise.resolve({ id: key, syncKey: key })),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(records.length),
    putBlob: vi.fn((_store, key) => Promise.resolve({ id: key, syncKey: key })),
    getBlob: vi.fn((_store: string, key: string) =>
      Promise.resolve(remoteBlobValues[key]),
    ),
    listBlobs: vi.fn().mockResolvedValue(remoteBlobs),
    deleteBlob: vi.fn().mockResolvedValue(undefined),
  };
}

function mockBlobStore(localBlobs: Map<string, Blob> = new Map()): BlobStore {
  return {
    get: vi.fn((key: string) => Promise.resolve(localBlobs.get(key))),
    put: vi.fn((key: string, blob: Blob) => {
      localBlobs.set(key, blob);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      localBlobs.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve([...localBlobs.keys()])),
    has: vi.fn((key: string) => Promise.resolve(localBlobs.has(key))),
  };
}

beforeEach(async () => {
  db = await openDB(dbName, 1, {
    upgrade(database) {
      database.createObjectStore('notes', { keyPath: 'id' });
    },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  db.close();
  await deleteDB(dbName);
});

describe('defaultResolve', () => {
  const now = new Date('2026-01-02T00:00:00Z');
  const earlier = new Date('2026-01-01T00:00:00Z');

  it.each([
    [{ modified: now }, { deleted: true }, 'delete'],
    [{ modified: now }, {}, 'keep-local'],
    [{}, { modified: now }, 'keep-remote'],
    [{ modified: now }, { modified: earlier }, 'keep-local'],
    [{ modified: earlier }, { modified: now }, 'keep-remote'],
    [{ modified: now }, { modified: now }, 'ignore'],
  ] as const)('resolves conflicts', (local, remote, expected) => {
    expect(defaultResolve(local, remote as SyncFileInfo)).toBe(expected);
  });
});

describe('syncStore', () => {
  it('uploads local-only records and downloads remote-only records', async () => {
    await db.put('notes', { id: 'local', title: 'Local' });
    const remote = { id: 'remote', title: 'Remote' };
    const sync = transport([{ id: 'remote.json', syncKey: 'remote.json' }], {
      'remote.json': remote,
    });

    await syncStore<NoteRecord>(db, sync, 'notes');

    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'local.json',
      expect.objectContaining({ id: 'local' }),
    );
    expect(await db.get('notes', 'remote')).toEqual(remote);
  });

  it('executes every conflict resolution', async () => {
    for (const id of ['remote', 'local', 'delete', 'ignore']) {
      await db.put('notes', { id, title: id });
    }
    const files = ['remote', 'local', 'delete', 'ignore'].map((id) => ({
      id: `${id}.json`,
      syncKey: `${id}.json`,
    }));
    const sync = transport(files, {
      'remote.json': { id: 'remote', title: 'updated' },
    });

    await syncStore<NoteRecord>(db, sync, 'notes', {
      resolve(local) {
        return local.id === 'remote'
          ? 'keep-remote'
          : local.id === 'local'
            ? 'keep-local'
            : local.id === 'delete'
              ? 'delete'
              : 'ignore';
      },
    });

    expect(await db.get('notes', 'remote')).toMatchObject({ title: 'updated' });
    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'local.json',
      expect.anything(),
    );
    expect(sync.delete).toHaveBeenCalledWith('notes', 'delete.json', true);
    expect(await db.get('notes', 'delete')).toBeUndefined();
    expect(sync.get).not.toHaveBeenCalledWith('notes', 'ignore.json');
  });

  it('uses modifiedField for conflict resolution', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db.put('notes', { id: 'a', title: 'Local', updatedAt: now });
    const sync = transport(
      [{ id: 'a.json', syncKey: 'a.json', modified: earlier }],
      { 'a.json': { id: 'a', title: 'Remote', updatedAt: earlier } },
    );

    await syncStore<TimestampedNote>(db, sync, 'notes', {
      modifiedField: 'updatedAt',
    });

    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'a.json',
      expect.objectContaining({ title: 'Local' }),
    );
  });

  it('uses modifiedField to keep-remote when remote is newer', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db.put('notes', { id: 'c', title: 'Local', updatedAt: earlier });
    const sync = transport(
      [{ id: 'c.json', syncKey: 'c.json', modified: now }],
      { 'c.json': { id: 'c', title: 'Remote', updatedAt: now } },
    );

    await syncStore<TimestampedNote>(db, sync, 'notes', {
      modifiedField: 'updatedAt',
    });

    expect(await db.get('notes', 'c')).toMatchObject({ title: 'Remote' });
  });

  it('uses modifiedField to delete when remote is soft-deleted', async () => {
    await db.put('notes', { id: 'd', title: 'Local' });
    const sync = transport(
      [{ id: 'd.json', syncKey: 'd.json', deleted: true }],
      {},
    );

    await syncStore<TimestampedNote>(db, sync, 'notes', {
      modifiedField: 'updatedAt',
    });

    expect(await db.get('notes', 'd')).toBeUndefined();
  });

  it('ignores modifiedField when a custom resolve is provided', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db.put('notes', { id: 'b', title: 'Local', updatedAt: now });
    const sync = transport(
      [{ id: 'b.json', syncKey: 'b.json', modified: earlier }],
      { 'b.json': { id: 'b', title: 'Remote', updatedAt: earlier } },
    );

    await syncStore<TimestampedNote>(db, sync, 'notes', {
      modifiedField: 'updatedAt',
      resolve: () => 'keep-remote',
    });

    expect(await db.get('notes', 'b')).toMatchObject({ title: 'Remote' });
  });

  it('skips downloaded soft-deleted records', async () => {
    const sync = transport([{ id: 'gone.json', syncKey: 'gone.json' }], {
      'gone.json': { id: 'gone', title: 'Gone', deleted: true },
    });

    await syncStore<NoteRecord>(db, sync, 'notes', {
      softDeleteField: 'deleted',
    });

    expect(await db.get('notes', 'gone')).toBeUndefined();
  });

  it('settles queue failures and logs transport failures', async () => {
    await db.put('notes', { id: 'upload', title: 'Upload' });

    const sync = transport([{ id: 'missing.json', syncKey: 'missing.json' }], {
      'missing.json': undefined,
    });

    vi.mocked(sync.put).mockRejectedValue(new Error('upload failed'));

    await expect(
      syncStore<NoteRecord>(db, sync, 'notes'),
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(expect.any(Error));
  });

  it('settles gracefully when a local record is gone from IDB before the upload queue runs', async () => {
    await db.put('notes', { id: 'vanished', title: 'Will be gone' });

    const sync = transport();

    // Simulate record deleted between queue build and execution
    vi.spyOn(db, 'get').mockResolvedValueOnce(undefined);

    await expect(
      syncStore<NoteRecord>(db, sync, 'notes'),
    ).resolves.toBeUndefined();

    expect(sync.put).not.toHaveBeenCalled();
  });

  it('logs local database and remote delete queue failures', async () => {
    await db.put('notes', { id: 'delete', title: 'Delete' });

    const sync = transport(
      [
        { id: 'delete.json', syncKey: 'delete.json' },
        { id: 'remote.json', syncKey: 'remote.json' },
      ],

      {
        'remote.json': { id: 'remote', title: 'Remote' },
      },
    );

    vi.mocked(sync.delete).mockRejectedValue(new Error('delete failed'));
    vi.spyOn(db, 'put').mockRejectedValue(new Error('database failed'));

    await syncStore<NoteRecord>(db, sync, 'notes', {
      resolve: () => 'delete',
    });

    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

describe('syncStore – blobFields', () => {
  const imageBlob = new Blob(['img-data'], { type: 'image/jpeg' });

  const blobFieldConfig = (store: BlobStore): BlobFieldConfig => ({
    blobStore: store,
    keyFromValue: (url: string) => url.replace('/_cache/', ''),
    valueFromKey: (key: string) => `/_cache/${key}`,
    contentType: 'image/jpeg',
  });

  it('throws when blobFields is set and transport does not support blobs', async () => {
    const sync = transport();

    await expect(
      syncStore<RecipeRecord>(db, sync, 'notes', {
        blobFields: { imageUrl: blobFieldConfig(mockBlobStore()) },
      }),
    ).rejects.toThrow('BlobSyncTransport');
  });

  it('uploads the blob and stores the key in remote JSON', async () => {
    const localBlobs = new Map([['abc123', imageBlob]]);
    const store = mockBlobStore(localBlobs);
    const sync = blobTransport();

    await db.put('notes', {
      id: 'r1',
      name: 'Pasta',
      imageUrl: '/_cache/abc123',
    });

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
    });

    expect(sync.putBlob).toHaveBeenCalledWith(
      'notes',
      'abc123',
      imageBlob,
      'image/jpeg',
    );

    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'r1.json',
      expect.objectContaining({ imageUrl: 'abc123' }),
    );
  });

  it('skips putBlob when blob already exists remotely', async () => {
    const localBlobs = new Map([['abc123', imageBlob]]);
    const store = mockBlobStore(localBlobs);
    const sync = blobTransport(
      [],
      {},
      [{ id: 'abc123', syncKey: 'abc123' }], // remote blob already present
    );

    await db.put('notes', {
      id: 'r2',
      name: 'Pizza',
      imageUrl: '/_cache/abc123',
    });

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
    });

    expect(sync.putBlob).not.toHaveBeenCalled();
  });

  it('downloads the blob and rewrites field to local URL', async () => {
    const store = mockBlobStore();
    const sync = blobTransport(
      [{ id: 'r3.json', syncKey: 'r3.json' }],
      { 'r3.json': { id: 'r3', name: 'Soup', imageUrl: 'abc123' } },
      [],
      { abc123: imageBlob },
    );

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
    });

    const saved = await db.get('notes', 'r3');
    expect(saved).toMatchObject({ imageUrl: '/_cache/abc123' });
    expect(vi.mocked(store.put)).toHaveBeenCalledWith('abc123', imageBlob);
  });

  it('skips getBlob when blob already exists locally', async () => {
    const localBlobs = new Map([['abc123', imageBlob]]);
    const store = mockBlobStore(localBlobs);
    const sync = blobTransport(
      [{ id: 'r4.json', syncKey: 'r4.json' }],
      { 'r4.json': { id: 'r4', name: 'Stew', imageUrl: 'abc123' } },
      [],
      { abc123: imageBlob },
    );

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
    });

    expect(sync.getBlob).not.toHaveBeenCalled();
  });

  it('handles records with no blob value without error', async () => {
    const store = mockBlobStore();
    const sync = blobTransport();

    await db.put('notes', { id: 'r5', name: 'No Image' });

    await expect(
      syncStore<RecipeRecord>(db, sync, 'notes', {
        blobFields: { imageUrl: blobFieldConfig(store) },
      }),
    ).resolves.toBeUndefined();

    expect(sync.putBlob).not.toHaveBeenCalled();
  });

  it('skips putBlob when local blobStore has no blob for the key', async () => {
    // imageUrl is set but the blob is missing from OPFS
    const store = mockBlobStore(); // empty store — no blob
    const sync = blobTransport();

    await db.put('notes', {
      id: 'r6',
      name: 'Ghost',
      imageUrl: '/_cache/ghost',
    });

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
    });

    expect(sync.putBlob).not.toHaveBeenCalled();

    // Field is still replaced with the key in remote JSON
    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'r6.json',
      expect.objectContaining({ imageUrl: 'ghost' }),
    );
  });

  it('handles download when remote blob is absent', async () => {
    // Remote record references a blob that does not exist remotely
    const store = mockBlobStore();
    const sync = blobTransport(
      [{ id: 'r7.json', syncKey: 'r7.json' }],
      { 'r7.json': { id: 'r7', name: 'Orphan', imageUrl: 'ghost' } },
      [],
      {}, // no blob data
    );

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
    });

    // Field is still rewritten to local URL even though no blob was downloaded
    const saved = await db.get('notes', 'r7');
    expect(saved).toMatchObject({ imageUrl: '/_cache/ghost' });
    expect(vi.mocked(store.put)).not.toHaveBeenCalled();
  });

  it('uses identity transforms when keyFromValue and valueFromKey are omitted', async () => {
    // Without transforms, the raw field value IS the blob key
    const localBlobs = new Map([['img.jpg', new Blob(['img'])]]);
    const store = mockBlobStore(localBlobs);
    const sync = blobTransport();

    await db.put('notes', { id: 'r8', name: 'Identity', imageUrl: 'img.jpg' });

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: {
        imageUrl: { blobStore: store }, // no keyFromValue / valueFromKey
      },
    });

    expect(sync.putBlob).toHaveBeenCalledWith(
      'notes',
      'img.jpg',
      expect.any(Blob),
      undefined,
    );

    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'r8.json',
      expect.objectContaining({ imageUrl: 'img.jpg' }),
    );
  });
});
