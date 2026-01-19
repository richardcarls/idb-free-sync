import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebDAVTransport } from '../src/WebDAVTransport';
import { expectSyncFileInfo } from './support/transportContract';

const { client, createWebDAVClient } = vi.hoisted(() => ({
  client: {
    getDirectoryContents: vi.fn(),
    getFileContents: vi.fn(),
    putFileContents: vi.fn(),
    stat: vi.fn(),
    deleteFile: vi.fn(),
    createDirectory: vi.fn(),
  },
  createWebDAVClient: vi.fn(),
}));

vi.mock('../src/internal/webdavAdapter', () => ({
  createWebDAVClient,
}));

const stat = {
  filename: '/RecipeTome/notes/a.json',
  basename: 'a.json',
  type: 'file',
  lastmod: '2026-01-02T00:00:00Z',
  size: 12,
};

beforeEach(() => {
  vi.clearAllMocks();

  createWebDAVClient.mockReturnValue(client);
  client.deleteFile.mockResolvedValue(undefined);
  client.createDirectory.mockResolvedValue(undefined);
});

describe('WebDAVTransport', () => {
  it('passes configuration to its private adapter', () => {
    const config = { url: 'https://dav.example', token: 'token' };

    new WebDAVTransport(config);

    expect(createWebDAVClient).toHaveBeenCalledWith(config);
  });

  it('lists files and treats listing failures as empty', async () => {
    client.getDirectoryContents.mockResolvedValueOnce([
      stat,
      { ...stat, type: 'directory' },
    ]);

    const transport = new WebDAVTransport({ url: 'https://dav.example' });

    expect(await transport.list('notes')).toEqual([
      expect.objectContaining({ syncKey: 'a.json', size: 12 }),
    ]);

    client.getDirectoryContents.mockRejectedValueOnce(new Error('missing'));
    expect(await transport.list('missing')).toEqual([]);
  });

  it('gets JSON and treats failures as missing', async () => {
    client.getFileContents.mockResolvedValueOnce('{"id":"a"}');

    const transport = new WebDAVTransport({ url: 'https://dav.example' });

    expect(await transport.get('notes', 'a.json')).toEqual({ id: 'a' });

    client.getFileContents.mockRejectedValueOnce(new Error('missing'));
    expect(await transport.get('notes', 'missing.json')).toBeUndefined();
  });

  it('ensures directories, uploads JSON, and maps metadata', async () => {
    client.stat.mockResolvedValue(stat);

    const transport = new WebDAVTransport({ url: 'https://dav.example' });
    const result = await transport.put('notes', 'a.json', { id: 'a' });

    expect(client.createDirectory).toHaveBeenCalledTimes(2);
    expect(client.putFileContents).toHaveBeenCalledWith(
      '/RecipeTome/notes/a.json',
      '{\n  "id": "a"\n}',
      { overwrite: true },
    );

    expect(result).toMatchObject({ syncKey: 'a.json', size: 12 });
    expectSyncFileInfo(result, 'a.json');
  });

  it('soft deletes, tolerates delete failures, and counts', async () => {
    client.getFileContents.mockResolvedValue('{"id":"a"}');
    client.stat.mockResolvedValue(stat);
    client.getDirectoryContents.mockResolvedValue([stat]);
    client.deleteFile.mockRejectedValue(new Error('already gone'));

    const transport = new WebDAVTransport({ url: 'https://dav.example' });

    await expect(
      transport.delete('notes', 'a.json', true),
    ).resolves.toBeUndefined();
    await expect(transport.delete('notes', 'a.json')).resolves.toBeUndefined();
    await expect(transport.deleteAll('notes', true)).resolves.toBeUndefined();
    await expect(transport.deleteAll('notes')).resolves.toBeUndefined();
    expect(await transport.count('notes')).toBe(1);
  });

  it('putBlob ensures blob directory, uploads, and maps metadata', async () => {
    const blobStat = {
      filename: '/RecipeTome/notes-blobs/img.jpg',
      basename: 'img.jpg',
      type: 'file',
      lastmod: '2026-01-02T00:00:00Z',
      size: 42,
    };

    client.stat.mockResolvedValue(blobStat);

    const transport = new WebDAVTransport({ url: 'https://dav.example' });
    const blob = new Blob(['img'], { type: 'image/jpeg' });

    const result = await transport.putBlob(
      'notes',
      'img.jpg',
      blob,
      'image/jpeg',
    );

    expect(client.putFileContents).toHaveBeenCalledWith(
      '/RecipeTome/notes-blobs/img.jpg',
      expect.any(ArrayBuffer),
      expect.objectContaining({ overwrite: true }),
    );
    expect(result).toMatchObject({ syncKey: 'img.jpg', size: 42 });
  });

  it('getBlob returns Blob on success and undefined on failure', async () => {
    const buffer = new ArrayBuffer(4);

    client.getFileContents.mockResolvedValueOnce(buffer);

    const transport = new WebDAVTransport({ url: 'https://dav.example' });

    const result = await transport.getBlob('notes', 'img.jpg');
    expect(result).toBeInstanceOf(Blob);

    client.getFileContents.mockRejectedValueOnce(new Error('missing'));
    expect(await transport.getBlob('notes', 'missing.jpg')).toBeUndefined();
  });

  it('listBlobs filters to files and treats failures as empty', async () => {
    const blobStat = {
      filename: '/RecipeTome/notes-blobs/img.jpg',
      basename: 'img.jpg',
      type: 'file',
      lastmod: '2026-01-02T00:00:00Z',
      size: 42,
    };

    client.getDirectoryContents.mockResolvedValueOnce([
      blobStat,
      { ...blobStat, type: 'directory' },
    ]);

    const transport = new WebDAVTransport({ url: 'https://dav.example' });

    expect(await transport.listBlobs('notes')).toEqual([
      expect.objectContaining({ syncKey: 'img.jpg', size: 42 }),
    ]);

    client.getDirectoryContents.mockRejectedValueOnce(new Error('missing'));
    expect(await transport.listBlobs('empty')).toEqual([]);
  });

  it('deleteBlob removes the blob and tolerates missing files', async () => {
    const transport = new WebDAVTransport({ url: 'https://dav.example' });

    await expect(
      transport.deleteBlob('notes', 'img.jpg'),
    ).resolves.toBeUndefined();

    expect(client.deleteFile).toHaveBeenCalledWith(
      '/RecipeTome/notes-blobs/img.jpg',
    );

    client.deleteFile.mockRejectedValueOnce(new Error('already gone'));

    await expect(
      transport.deleteBlob('notes', 'missing.jpg'),
    ).resolves.toBeUndefined();
  });
});
