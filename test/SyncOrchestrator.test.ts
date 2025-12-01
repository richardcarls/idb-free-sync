import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultResolver,
  syncStore,
  type SyncRecord,
} from '../src/SyncOrchestrator';
import type { SyncFileInfo, SyncTransport } from '../src/SyncTransport';

type NoteRecord = SyncRecord & { id: string; title: string; deleted?: boolean };
type TimestampedNote = SyncRecord & {
  id: string;
  title: string;
  updatedAt?: Date;
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

describe('defaultResolver', () => {
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
    expect(defaultResolver(local, remote as SyncFileInfo)).toBe(expected);
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

  it('skips downloaded soft-deleted records', async () => {
    const sync = transport([{ id: 'gone.json', syncKey: 'gone.json' }], {
      'gone.json': { id: 'gone', title: 'Gone', deleted: true },
    });

    await syncStore<NoteRecord>(db, sync, 'notes', {
      softDeleteField: 'deleted',
    });

    expect(await db.get('notes', 'gone')).toBeUndefined();
  });

  it('uses a configured modification field for conflicts', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db.put('notes', { id: 'local', title: 'Local', updatedAt: now });
    await db.put('notes', { id: 'remote', title: 'Local', updatedAt: earlier });
    const sync = transport(
      [
        { id: 'local.json', syncKey: 'local.json', modified: earlier },
        { id: 'remote.json', syncKey: 'remote.json', modified: now },
      ],
      {
        'remote.json': { id: 'remote', title: 'Remote', updatedAt: now },
      },
    );

    await syncStore<TimestampedNote>(db, sync, 'notes', {
      modifiedField: 'updatedAt',
    });

    expect(sync.put).toHaveBeenCalledWith(
      'notes',
      'local.json',
      expect.objectContaining({ title: 'Local' }),
    );
    expect(await db.get('notes', 'remote')).toMatchObject({ title: 'Remote' });
  });

  it('gives a custom resolver precedence over modifiedField', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db.put('notes', { id: 'a', title: 'Local', updatedAt: now });
    const sync = transport(
      [{ id: 'a.json', syncKey: 'a.json', modified: earlier }],
      { 'a.json': { id: 'a', title: 'Remote', updatedAt: earlier } },
    );

    await syncStore<TimestampedNote>(db, sync, 'notes', {
      modifiedField: 'updatedAt',
      resolve: () => 'keep-remote',
    });

    expect(await db.get('notes', 'a')).toMatchObject({ title: 'Remote' });
  });

  it.each([
    [{ deleted: true }, undefined, true],
    [{ modified: new Date('2026-01-02T00:00:00Z') }, undefined, false],
    [
      { modified: new Date('2026-01-02T00:00:00Z') },
      new Date('2026-01-02T00:00:00Z'),
      false,
    ],
  ] as const)(
    'handles modifiedField edge cases',
    async (remoteInfo, updatedAt, deleted) => {
      await db.put('notes', { id: 'edge', title: 'Local', updatedAt });
      const sync = transport(
        [{ id: 'edge.json', syncKey: 'edge.json', ...remoteInfo }],
        {
          'edge.json': { id: 'edge', title: 'Remote', updatedAt },
        },
      );

      await syncStore<TimestampedNote>(db, sync, 'notes', {
        modifiedField: 'updatedAt',
      });

      if (deleted) {
        expect(await db.get('notes', 'edge')).toBeUndefined();
      }
    },
  );

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
