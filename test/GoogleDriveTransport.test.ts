import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GoogleDriveTransport } from '../src/GoogleDriveTransport';
import { expectSyncFileInfo } from './support/transportContract';

// Makes adapter delegates available to Vitest's hoisted module mocks.
const { files, getGoogleClient, request } = vi.hoisted(() => {
  const files = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    generateIds: vi.fn(),
  };

  return {
    files,
    getGoogleClient: vi.fn(() => Promise.resolve({ drive: { files } })),
    request: vi.fn(),
  };
});

vi.mock('../src/internal/googleAdapter', () => ({ getGoogleClient }));
vi.mock('../src/internal/request', () => ({ request }));

const folder = { id: 'folder-id', name: 'notes' };
const file = {
  id: 'file-id',
  name: 'a.json',
  modifiedTime: '2026-01-02T00:00:00Z',
  createdTime: '2026-01-01T00:00:00Z',
  md5Checksum: 'checksum',
  size: '12',
  properties: { deleted: 'true' },
};

/**
 * Queues the folder lookup followed by the folder-content lookup used by Drive operations.
 *
 * @param entries - files returned from the target folder
 */
function folderThen(entries: unknown[]) {
  files.list
    .mockResolvedValueOnce({ result: { files: [folder] } })
    .mockResolvedValueOnce({ result: { files: entries } });
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.stubGlobal('gapi', {
    auth: { getToken: () => ({ access_token: 'token' }) },
  });

  files.delete.mockResolvedValue({});
});

describe('GoogleDriveTransport', () => {
  it('lists files and maps Drive metadata', async () => {
    folderThen([file]);

    const result = await new GoogleDriveTransport('client').list('notes');

    expect(result).toEqual([
      expect.objectContaining({
        id: 'file-id',
        syncKey: 'a.json',
        checksum: 'checksum',
        size: 12,
        deleted: true,
      }),
    ]);
  });

  it('maps absent optional metadata and empty listings', async () => {
    folderThen([{ id: undefined, name: undefined }]);

    const transport = new GoogleDriveTransport('client');

    expect(await transport.list('notes')).toEqual([
      {
        id: '',
        syncKey: '',
        modified: undefined,
        created: undefined,
        checksum: undefined,
        size: undefined,
        deleted: false,
      },
    ]);
  });

  it('gets existing JSON and returns undefined for missing files', async () => {
    folderThen([file]);
    files.get.mockResolvedValue({ body: '{"id":"a"}' });

    const transport = new GoogleDriveTransport('client');

    expect(await transport.get('notes', 'a.json')).toEqual({ id: 'a' });

    folderThen([]);

    expect(await transport.get('notes', 'missing.json')).toBeUndefined();
  });

  it('creates missing folders and uploads new files', async () => {
    files.list
      .mockResolvedValueOnce({ result: { files: [] } })
      .mockResolvedValueOnce({ result: { files: [folder] } })
      .mockResolvedValueOnce({ result: { files: [] } });
    files.generateIds.mockResolvedValue({ result: { ids: ['folder-id'] } });
    files.create.mockResolvedValue({ result: folder });

    request.mockResolvedValue({
      json: () => Promise.resolve(file),
    });

    const result = await new GoogleDriveTransport('client').put(
      'notes',
      'a.json',
      { id: 'a' },
      { source: 'test' },
    );

    expect(files.create).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('upload/drive/v3/files?'),
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    );
    expect(result).toMatchObject({ id: 'file-id', syncKey: 'a.json' });
    expectSyncFileInfo(result, 'a.json');
  });

  it('throws when Drive cannot generate a folder ID', async () => {
    files.list.mockResolvedValueOnce({ result: { files: [] } });
    files.generateIds.mockResolvedValue({ result: { ids: [] } });

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      new GoogleDriveTransport('client').list('notes'),
    ).rejects.toThrow('No id generated for folder');
  });

  it('ignores deletes for missing files', async () => {
    folderThen([]);

    await expect(
      new GoogleDriveTransport('client').delete('notes', 'missing.json'),
    ).resolves.toBeUndefined();

    expect(files.delete).not.toHaveBeenCalled();
  });

  it('updates, soft deletes, hard deletes, deletes stores, and counts', async () => {
    request.mockResolvedValue({ json: () => Promise.resolve(file) });

    files.list.mockImplementation(({ q }: { q: string }) =>
      Promise.resolve({
        result: { files: q.startsWith('name =') ? [folder] : [file] },
      }),
    );

    const transport = new GoogleDriveTransport('client');

    await transport.put('notes', 'a.json', { id: 'a' });

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('/file-id?'),
      expect.objectContaining({ method: 'PATCH' }),
    );

    files.get.mockResolvedValue({ body: '{"id":"a"}' });

    await transport.delete('notes', 'a.json', true);
    await transport.delete('notes', 'a.json');

    expect(files.delete).toHaveBeenCalledWith({ fileId: 'file-id' });

    await transport.deleteAll('notes');

    expect(files.delete).toHaveBeenCalledWith({ fileId: 'folder-id' });

    files.list.mockImplementation(({ q }: { q: string }) =>
      Promise.resolve({
        result: {
          files: q.startsWith('name =') ? [folder] : [file, { id: 'unnamed' }],
        },
      }),
    );

    await transport.deleteAll('notes', true);

    expect(await transport.count('notes')).toBe(2);
  });
});
