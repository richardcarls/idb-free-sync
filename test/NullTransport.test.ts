import { describe, expect, it } from 'vitest';

import { NullTransport } from '../src/NullTransport';
import {
  isBlobSyncTransport,
  type BlobSyncTransport,
} from '../src/BlobSyncTransport';

describe('NullTransport', () => {
  it('satisfies BlobSyncTransport', () => {
    expect(isBlobSyncTransport(new NullTransport())).toBe(true);
  });

  it('returns empty values from all read methods', async () => {
    const t = new NullTransport() as BlobSyncTransport;
    expect(await t.list('notes')).toEqual([]);
    expect(await t.get('notes', 'a.json')).toBeUndefined();
    expect(await t.count('notes')).toBe(0);
    expect(await t.listBlobs('notes')).toEqual([]);
    expect(await t.getBlob('notes', 'img.jpg')).toBeUndefined();
  });

  it('put returns minimal SyncFileInfo with the provided syncKey', async () => {
    const t = new NullTransport() as BlobSyncTransport;
    const result = await t.put('notes', 'a.json', { id: 'a' });
    expect(result).toEqual({ id: 'a.json', syncKey: 'a.json' });
  });

  it('putBlob returns minimal SyncFileInfo with the provided blobKey', async () => {
    const t = new NullTransport() as BlobSyncTransport;
    const result = await t.putBlob('notes', 'img.jpg', new Blob(['img']));
    expect(result).toEqual({ id: 'img.jpg', syncKey: 'img.jpg' });
  });

  it('delete, deleteAll, and deleteBlob resolve without error', async () => {
    const t = new NullTransport() as BlobSyncTransport;
    await expect(t.delete('notes', 'a.json')).resolves.toBeUndefined();
    await expect(t.deleteAll('notes')).resolves.toBeUndefined();
    await expect(t.deleteBlob('notes', 'img.jpg')).resolves.toBeUndefined();
  });
});
