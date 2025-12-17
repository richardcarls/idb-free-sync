import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DropboxTransport } from '../src/DropboxTransport';
import { expectSyncFileInfo } from './support/transportContract';

// Makes the shared client available to Vitest's hoisted adapter mock.
const { client } = vi.hoisted(() => ({
  client: {
    filesListFolder: vi.fn(),
    filesDownload: vi.fn(),
    filesUpload: vi.fn(),
    filesDeleteV2: vi.fn(),
  },
}));

vi.mock('../src/internal/dropboxAdapter', () => ({
  createDropboxClient: () => client,
}));

const file = {
  '.tag': 'file',
  id: 'id:a',
  name: 'a.json',
  client_modified: '2026-01-02T00:00:00Z',
  size: 12,
};

beforeEach(() => {
  vi.clearAllMocks();

  client.filesDeleteV2.mockResolvedValue({});
});

describe('DropboxTransport', () => {
  it('lists only files and handles a missing folder', async () => {
    client.filesListFolder.mockResolvedValueOnce({
      result: { entries: [file, { '.tag': 'folder', name: 'folder' }] },
    });

    const transport = new DropboxTransport();

    expect(await transport.list('notes')).toEqual([
      expect.objectContaining({ id: 'id:a', syncKey: 'a.json', size: 12 }),
    ]);

    client.filesListFolder.mockRejectedValueOnce({ status: 409 });

    expect(await transport.list('missing')).toEqual([]);
  });

  it('downloads JSON and treats download failures as missing', async () => {
    client.filesDownload.mockResolvedValueOnce({
      result: { ...file, fileBlob: new Blob(['{"id":"a"}']) },
    });

    const transport = new DropboxTransport();

    expect(await transport.get('notes', 'a.json')).toEqual({ id: 'a' });

    client.filesDownload.mockRejectedValueOnce(new Error('missing'));

    expect(await transport.get('notes', 'missing.json')).toBeUndefined();
  });

  it('uploads JSON and maps metadata', async () => {
    client.filesUpload.mockResolvedValue({ result: file });

    const result = await new DropboxTransport().put('notes', 'a.json', {
      id: 'a',
    });

    expect(result).toMatchObject({ id: 'id:a', syncKey: 'a.json', size: 12 });
    expectSyncFileInfo(result, 'a.json');
    expect(client.filesUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/Apps/RecipeTome/notes/a.json',
        mode: { '.tag': 'overwrite' },
        contents: expect.any(Blob),
      }),
    );
  });

  it('soft deletes, hard deletes, deletes stores, and counts', async () => {
    client.filesDownload.mockResolvedValue({
      result: { ...file, fileBlob: new Blob(['{"id":"a"}']) },
    });
    client.filesUpload.mockResolvedValue({ result: file });
    client.filesListFolder.mockResolvedValue({ result: { entries: [file] } });

    const transport = new DropboxTransport();

    await transport.delete('notes', 'a.json', true);
    await transport.delete('notes', 'a.json');
    await transport.deleteAll('notes', true);
    await transport.deleteAll('notes');

    expect(client.filesUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contents: expect.any(Blob) }),
    );
    expect(client.filesDeleteV2).toHaveBeenCalledWith({
      path: '/Apps/RecipeTome/notes/a.json',
    });
    expect(client.filesDeleteV2).toHaveBeenCalledWith({
      path: '/Apps/RecipeTome/notes',
    });

    expect(await transport.count('notes')).toBe(1);
  });
});
