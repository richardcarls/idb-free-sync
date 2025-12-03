import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebDAVTransport } from '../src/WebDAVTransport';
import { expectSyncFileInfo } from './support/transportContract';

// Makes adapter delegates available to Vitest's hoisted module mock.
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
});
