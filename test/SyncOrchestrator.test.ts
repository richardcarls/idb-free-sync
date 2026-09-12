import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BlobIntegrityError,
  defaultResolve,
  syncStore,
  type ArrayBlobFieldConfig,
  type BlobFieldConfig,
  type SyncItemSettledEvent,
  type SyncRecord,
  type SyncWriteEvent,
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
type Photo = { key?: string; remoteUrl?: string; contentType?: string };
type PhotoRecord = SyncRecord & {
  id: string;
  name: string;
  photos?: Photo[];
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

describe('syncStore – signal', () => {
  it('skips all work when the signal is already aborted', async () => {
    await db.put('notes', { id: 'a', title: 'A' });

    const sync = transport([{ id: 'a.json', syncKey: 'a.json' }], {
      'a.json': { id: 'a', title: 'Remote A' },
    });
    const controller = new AbortController();

    controller.abort();

    await syncStore<NoteRecord>(db, sync, 'notes', {
      signal: controller.signal,
    });

    expect(sync.list).not.toHaveBeenCalled();
    expect(await db.get('notes', 'a')).toMatchObject({ title: 'A' });
  });

  it('does not start queued local deletes once aborted mid cursor-scan', async () => {
    for (const id of ['a', 'b', 'c']) {
      await db.put('notes', { id, title: id });
    }

    const files = ['a', 'b', 'c'].map((id) => ({
      id: `${id}.json`,
      syncKey: `${id}.json`,
    }));
    const sync = transport(files);
    const controller = new AbortController();
    let resolveCalls = 0;

    await syncStore<NoteRecord>(db, sync, 'notes', {
      signal: controller.signal,
      resolve: () => {
        resolveCalls += 1;

        if (resolveCalls === 1) {
          controller.abort();
        }

        return 'delete';
      },
    });

    expect(resolveCalls).toBe(1);
    expect(await db.get('notes', 'a')).toMatchObject({ title: 'a' });
    expect(await db.get('notes', 'b')).toMatchObject({ title: 'b' });
    expect(await db.get('notes', 'c')).toMatchObject({ title: 'c' });
  });

  it('lets already-started queue items settle but starts no new ones once aborted mid-queue', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `u${i}`);

    for (const id of ids) {
      await db.put('notes', { id, title: id });
    }

    const sync = transport();
    const controller = new AbortController();
    let putCalls = 0;

    vi.mocked(sync.put).mockImplementation(async (_store, key) => {
      putCalls += 1;
      controller.abort();

      return { id: key, syncKey: key };
    });

    await syncStore<NoteRecord>(db, sync, 'notes', {
      signal: controller.signal,
    });

    // Bounded concurrency means only the first wave of already-launched
    // uploads can call `put` — aborting inside the very first call must
    // still stop the remaining, not-yet-started uploads from ever running.
    expect(putCalls).toBeGreaterThanOrEqual(1);
    expect(putCalls).toBeLessThan(ids.length);
  });
});

describe('syncStore – onBeforeWrite', () => {
  it('reports the previous value for a keep-remote update, undefined for a new remote-only record, and never fires for uploads', async () => {
    await db.put('notes', { id: 'updated', title: 'Local (stale)' });
    await db.put('notes', { id: 'uploaded', title: 'Local only' });

    const sync = transport(
      [
        { id: 'updated.json', syncKey: 'updated.json' },
        { id: 'new.json', syncKey: 'new.json' },
      ],
      {
        'updated.json': { id: 'updated', title: 'Remote (fresh)' },
        'new.json': { id: 'new', title: 'Brand new' },
      },
    );
    const events: SyncWriteEvent<NoteRecord>[] = [];

    await syncStore<NoteRecord>(db, sync, 'notes', {
      resolve: (local) =>
        local.id === 'uploaded' ? 'keep-local' : 'keep-remote',
      onBeforeWrite: (event) => {
        events.push(event as SyncWriteEvent<NoteRecord>);
      },
    });

    const byKey = new Map(events.map((event) => [event.key, event]));

    expect(byKey.get('updated')).toMatchObject({
      kind: 'put',
      previous: { title: 'Local (stale)' },
    });

    expect(byKey.get('new')).toMatchObject({
      kind: 'put',
      previous: undefined,
    });

    expect(byKey.has('uploaded')).toBe(false);
  });

  it('reports the previous value right before a delete', async () => {
    await db.put('notes', { id: 'gone', title: 'Going away' });

    const sync = transport([{ id: 'gone.json', syncKey: 'gone.json' }]);
    const events: SyncWriteEvent<NoteRecord>[] = [];

    await syncStore<NoteRecord>(db, sync, 'notes', {
      resolve: () => 'delete',
      onBeforeWrite: (event) => {
        events.push(event as SyncWriteEvent<NoteRecord>);
      },
    });

    expect(events).toEqual([
      {
        key: 'gone',
        kind: 'delete',
        previous: { id: 'gone', title: 'Going away' },
      },
    ]);
  });
});

describe('syncStore – onItemSettled', () => {
  it('reports completed items while later queue work is still pending', async () => {
    await db.put('notes', { id: 'a', title: 'A' });
    await db.put('notes', { id: 'b', title: 'B' });

    const sync = transport();
    let releaseSecondUpload!: () => void;
    const secondUpload = new Promise<void>((resolve) => {
      releaseSecondUpload = resolve;
    });

    vi.mocked(sync.put).mockImplementation(async (_store, key) => {
      if (key === 'b.json') {
        await secondUpload;
      }

      return { id: key, syncKey: key };
    });

    const events: SyncItemSettledEvent[] = [];
    let finished = false;
    const run = syncStore<NoteRecord>(db, sync, 'notes', {
      onItemSettled: (event) => {
        events.push(event);
      },
    }).then(() => {
      finished = true;
    });

    await vi.waitFor(() => expect(sync.put).toHaveBeenCalledTimes(2));

    await vi.waitFor(() =>
      expect(events).toContainEqual({
        key: 'a',
        kind: 'upload',
        status: 'fulfilled',
      }),
    );

    expect(finished).toBe(false);

    releaseSecondUpload();
    await run;

    expect(events).toHaveLength(2);
  });

  it('fires once per queue item with the outcome, surfacing the caught error on failure', async () => {
    await db.put('notes', { id: 'upload-ok', title: 'Upload ok' });
    await db.put('notes', { id: 'delete-ok', title: 'Delete ok' });

    const sync = transport(
      [
        { id: 'delete-ok.json', syncKey: 'delete-ok.json' },
        { id: 'download-fail.json', syncKey: 'download-fail.json' },
      ],
      { 'download-fail.json': undefined },
    );

    vi.mocked(sync.put).mockRejectedValueOnce(new Error('upload failed'));

    const events: SyncItemSettledEvent[] = [];

    await syncStore<NoteRecord>(db, sync, 'notes', {
      resolve: () => 'delete',
      onItemSettled: (event) => {
        events.push(event);
      },
    });

    const byKey = new Map(events.map((event) => [event.key, event]));

    expect(byKey.get('upload-ok')).toMatchObject({
      kind: 'upload',
      status: 'rejected',
    });

    expect(
      (byKey.get('upload-ok') as SyncItemSettledEvent).error,
    ).toBeInstanceOf(Error);

    expect(byKey.get('delete-ok')).toMatchObject({
      kind: 'delete',
      status: 'fulfilled',
    });

    expect(byKey.get('download-fail')).toMatchObject({
      kind: 'download',
      status: 'rejected',
    });

    expect(events).toHaveLength(3);
  });

  it('reports every item skipped after cancellation as rejected with an AbortError', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `u${index}`);

    for (const id of ids) {
      await db.put('notes', { id, title: id });
    }

    const sync = transport();
    const controller = new AbortController();
    const events: SyncItemSettledEvent[] = [];

    vi.mocked(sync.put).mockImplementation(async (_store, key) => {
      controller.abort();

      return { id: key, syncKey: key };
    });

    await syncStore<NoteRecord>(db, sync, 'notes', {
      signal: controller.signal,
      onItemSettled: (event) => {
        events.push(event);
      },
    });

    expect(events).toHaveLength(ids.length);

    const aborted = events.filter(
      (event) =>
        event.status === 'rejected' &&
        event.error instanceof DOMException &&
        event.error.name === 'AbortError',
    );

    expect(aborted.length).toBeGreaterThan(0);
  });

  it('logs observer errors without relabeling outcomes or suppressing later events', async () => {
    await db.put('notes', { id: 'a', title: 'A' });
    await db.put('notes', { id: 'b', title: 'B' });

    const sync = transport();
    const events: SyncItemSettledEvent[] = [];

    await syncStore<NoteRecord>(db, sync, 'notes', {
      onItemSettled: (event) => {
        events.push(event);

        if (event.key === 'a') {
          throw new Error('observer failed');
        }
      },
    });

    expect(events).toHaveLength(2);
    expect(events.every(({ status }) => status === 'fulfilled')).toBe(true);

    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'observer failed' }),
    );
  });
});

describe('syncStore – onQueueBuilt', () => {
  it('fires once with the queue size, before any item settles', async () => {
    await db.put('notes', { id: 'upload-me', title: 'Upload me' });

    const sync = transport([
      { id: 'download-me.json', syncKey: 'download-me.json' },
    ]);
    const calls: number[] = [];
    const settledBeforeQueueBuilt: boolean[] = [];

    await syncStore<NoteRecord>(db, sync, 'notes', {
      resolve: () => 'keep-local',
      onQueueBuilt: (total) => {
        calls.push(total);
        settledBeforeQueueBuilt.push(false);
      },
      onItemSettled: () => {
        settledBeforeQueueBuilt.push(true);
      },
    });

    expect(calls).toEqual([2]);
    expect(settledBeforeQueueBuilt[0]).toBe(false);
  });

  it('reports zero when every record is already in sync', async () => {
    await db.put('notes', { id: 'already-synced', title: 'Already synced' });

    const sync = transport([
      { id: 'already-synced.json', syncKey: 'already-synced.json' },
    ]);
    const calls: number[] = [];

    await syncStore<NoteRecord>(db, sync, 'notes', {
      resolve: () => 'ignore',
      onQueueBuilt: (total) => calls.push(total),
    });

    expect(calls).toEqual([0]);
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

  it('restores a missing local blob when it already exists remotely', async () => {
    const store = mockBlobStore();
    const sync = blobTransport([], {}, [{ id: 'abc123', syncKey: 'abc123' }], {
      abc123: imageBlob,
    });

    await db.put('notes', {
      id: 'r2',
      name: 'Pizza',
      imageUrl: '/_cache/abc123',
    });

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
    });

    expect(sync.putBlob).not.toHaveBeenCalled();
    expect(vi.mocked(store.put)).toHaveBeenCalledWith('abc123', imageBlob);
  });

  it('downloads the blob and rewrites field to local URL', async () => {
    const store = mockBlobStore();
    const sync = blobTransport(
      [{ id: 'r3.json', syncKey: 'r3.json' }],
      { 'r3.json': { id: 'r3', name: 'Soup', imageUrl: 'abc123' } },
      [{ id: 'abc123', syncKey: 'abc123' }],
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

  it('rejects an upload item when its blob is missing on both sides', async () => {
    const store = mockBlobStore();
    const sync = blobTransport();
    const settled: SyncItemSettledEvent[] = [];

    await db.put('notes', {
      id: 'r6',
      name: 'Ghost',
      imageUrl: '/_cache/ghost',
    });

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
      onItemSettled: (event) => settled.push(event),
    });

    expect(sync.putBlob).not.toHaveBeenCalled();
    expect(sync.put).not.toHaveBeenCalled();

    expect(settled).toEqual([
      expect.objectContaining({
        key: 'r6',
        kind: 'upload',
        status: 'rejected',
        error: expect.any(BlobIntegrityError),
      }),
    ]);
  });

  it('rejects a download item when its blob is missing on both sides', async () => {
    const store = mockBlobStore();
    const settled: SyncItemSettledEvent[] = [];
    const sync = blobTransport([{ id: 'r7.json', syncKey: 'r7.json' }], {
      'r7.json': { id: 'r7', name: 'Orphan', imageUrl: 'ghost' },
    });

    await syncStore<RecipeRecord>(db, sync, 'notes', {
      blobFields: { imageUrl: blobFieldConfig(store) },
      onItemSettled: (event) => settled.push(event),
    });

    expect(await db.get('notes', 'r7')).toBeUndefined();
    expect(vi.mocked(store.put)).not.toHaveBeenCalled();

    expect(settled).toEqual([
      expect.objectContaining({
        key: 'r7',
        kind: 'download',
        status: 'rejected',
        error: expect.any(BlobIntegrityError),
      }),
    ]);
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

describe('syncStore – array blobFields', () => {
  const jpegBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
  const webpBlob = new Blob(['webp-data'], { type: 'image/webp' });

  const photosFieldConfig = (
    store: BlobStore,
  ): ArrayBlobFieldConfig<Photo> => ({
    kind: 'array',
    blobStore: store,
    itemKey: (photo) => photo.key,
    itemContentType: (photo) => photo.contentType,
  });

  it('uploads a blob per keyed item and keeps the field value as-is', async () => {
    const localBlobs = new Map([
      ['a1.jpg', jpegBlob],
      ['b2.webp', webpBlob],
    ]);
    const store = mockBlobStore(localBlobs);
    const sync = blobTransport();
    const photos: Photo[] = [
      { key: 'a1.jpg', contentType: 'image/jpeg' },
      { key: 'b2.webp', contentType: 'image/webp' },
    ];

    await db.put('notes', { id: 'p1', name: 'Tacos', photos });

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
    });

    expect(sync.putBlob).toHaveBeenCalledWith(
      'notes',
      'a1.jpg',
      jpegBlob,
      'image/jpeg',
    );

    expect(sync.putBlob).toHaveBeenCalledWith(
      'notes',
      'b2.webp',
      webpBlob,
      'image/webp',
    );

    // Field value serialised unchanged — items already store bare keys
    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'p1.json',
      expect.objectContaining({ photos }),
    );
  });

  it('skips remote-only items with no key on upload', async () => {
    const store = mockBlobStore(new Map([['local.jpg', jpegBlob]]));
    const sync = blobTransport();

    await db.put('notes', {
      id: 'p2',
      name: 'Scraped',
      photos: [
        { remoteUrl: 'https://example.com/hotlink.jpg' },
        { key: 'local.jpg' },
      ],
    });

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
    });

    expect(sync.putBlob).toHaveBeenCalledTimes(1);

    expect(sync.putBlob).toHaveBeenCalledWith(
      'notes',
      'local.jpg',
      jpegBlob,
      undefined,
    );
  });

  it('skips items whose blob already exists remotely', async () => {
    const store = mockBlobStore(new Map([['dup.jpg', jpegBlob]]));
    const sync = blobTransport(
      [],
      {},
      [{ id: 'dup.jpg', syncKey: 'dup.jpg' }], // already remote
    );

    await db.put('notes', {
      id: 'p3',
      name: 'Dup',
      photos: [{ key: 'dup.jpg' }],
    });

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
    });

    expect(sync.putBlob).not.toHaveBeenCalled();
  });

  it('downloads blobs per keyed item and stores the record unchanged', async () => {
    const store = mockBlobStore();
    const remotePhotos: Photo[] = [
      { key: 'x1.jpg' },
      { remoteUrl: 'https://example.com/x2.jpg' },
    ];
    const sync = blobTransport(
      [{ id: 'p4.json', syncKey: 'p4.json' }],
      { 'p4.json': { id: 'p4', name: 'Curry', photos: remotePhotos } },
      [{ id: 'x1.jpg', syncKey: 'x1.jpg' }],
      { 'x1.jpg': jpegBlob },
    );

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
    });

    expect(vi.mocked(store.put)).toHaveBeenCalledWith('x1.jpg', jpegBlob);
    expect(vi.mocked(store.put)).toHaveBeenCalledTimes(1);

    expect(await db.get('notes', 'p4')).toMatchObject({
      photos: remotePhotos,
    });
  });

  it('skips download for blobs already present locally', async () => {
    const store = mockBlobStore(new Map([['have.jpg', jpegBlob]]));
    const sync = blobTransport(
      [{ id: 'p5.json', syncKey: 'p5.json' }],
      { 'p5.json': { id: 'p5', name: 'Have', photos: [{ key: 'have.jpg' }] } },
      [],
      { 'have.jpg': jpegBlob },
    );

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
    });

    expect(sync.getBlob).not.toHaveBeenCalled();
  });

  it('handles records with a missing or non-array field without error', async () => {
    const store = mockBlobStore();
    const sync = blobTransport();

    await db.put('notes', { id: 'p6', name: 'No Photos' });

    await expect(
      syncStore<PhotoRecord>(db, sync, 'notes', {
        blobFields: { photos: photosFieldConfig(store) },
      }),
    ).resolves.toBeUndefined();

    expect(sync.putBlob).not.toHaveBeenCalled();
  });

  it('does not push the same blob key twice across records', async () => {
    const store = mockBlobStore(new Map([['shared.jpg', jpegBlob]]));
    const sync = blobTransport();

    await db.put('notes', {
      id: 'p7',
      name: 'One',
      photos: [{ key: 'shared.jpg' }],
    });

    await db.put('notes', {
      id: 'p8',
      name: 'Two',
      photos: [{ key: 'shared.jpg' }],
    });

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
    });

    expect(sync.putBlob).toHaveBeenCalledTimes(1);
  });

  it('repairs a missing local blob for an otherwise ignored record', async () => {
    const modified = new Date('2026-01-01T00:00:00Z');
    const store = mockBlobStore();
    const sync = blobTransport(
      [{ id: 'repair-local.json', syncKey: 'repair-local.json', modified }],
      {},
      [{ id: 'repair.jpg', syncKey: 'repair.jpg' }],
      { 'repair.jpg': jpegBlob },
    );
    const settled: SyncItemSettledEvent[] = [];

    await db.put('notes', {
      id: 'repair-local',
      name: 'Repair local',
      modified,
      photos: [{ key: 'repair.jpg' }],
    });

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
      onItemSettled: (event) => settled.push(event),
    });

    expect(vi.mocked(store.put)).toHaveBeenCalledWith('repair.jpg', jpegBlob);
    expect(sync.put).not.toHaveBeenCalled();

    expect(settled).toEqual([
      expect.objectContaining({
        key: 'repair-local',
        kind: 'reconcile',
        status: 'fulfilled',
      }),
    ]);
  });

  it('repairs a missing remote blob for an otherwise ignored record', async () => {
    const modified = new Date('2026-01-01T00:00:00Z');
    const store = mockBlobStore(new Map([['repair.jpg', jpegBlob]]));
    const sync = blobTransport([
      { id: 'repair-remote.json', syncKey: 'repair-remote.json', modified },
    ]);

    await db.put('notes', {
      id: 'repair-remote',
      name: 'Repair remote',
      modified,
      photos: [{ key: 'repair.jpg', contentType: 'image/jpeg' }],
    });

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
    });

    expect(sync.putBlob).toHaveBeenCalledWith(
      'notes',
      'repair.jpg',
      jpegBlob,
      'image/jpeg',
    );

    expect(sync.put).not.toHaveBeenCalled();
  });

  it('reports an ignored record whose blob is missing on both sides', async () => {
    const modified = new Date('2026-01-01T00:00:00Z');
    const store = mockBlobStore();
    const sync = blobTransport([
      { id: 'orphan.json', syncKey: 'orphan.json', modified },
    ]);
    const settled: SyncItemSettledEvent[] = [];

    await db.put('notes', {
      id: 'orphan',
      name: 'Orphan',
      modified,
      photos: [{ key: 'ghost.jpg' }],
    });

    await syncStore<PhotoRecord>(db, sync, 'notes', {
      blobFields: { photos: photosFieldConfig(store) },
      onItemSettled: (event) => settled.push(event),
    });

    expect(settled).toEqual([
      expect.objectContaining({
        key: 'orphan',
        kind: 'reconcile',
        status: 'rejected',
        error: expect.any(BlobIntegrityError),
      }),
    ]);

    expect(sync.put).not.toHaveBeenCalled();
    expect(sync.putBlob).not.toHaveBeenCalled();
  });
});
