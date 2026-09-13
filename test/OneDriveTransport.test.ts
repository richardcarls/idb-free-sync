import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { OneDriveTransport } from '../src/OneDriveTransport';
import { server } from './support/server';
import {
  expectSyncFileInfo,
  expectTransportIdentity,
} from './support/transportContract';

const graph = 'https://graph.microsoft.com/v1.0';
const endpoint = (path: string) =>
  new RegExp(
    `^${`${graph}${path}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?.*)?$`,
  );
const item = {
  id: '1',
  name: 'a.json',
  lastModifiedDateTime: '2026-01-02T00:00:00Z',
  createdDateTime: '2026-01-01T00:00:00Z',
  size: 10,
  file: {},
};

function tokenProvider() {
  return Promise.resolve('token');
}

describe('OneDriveTransport', () => {
  it('reports its provider identity and scopes', () => {
    const transport = new OneDriveTransport(tokenProvider);

    expectTransportIdentity(transport, 'onedrive');
    expect(transport.scopes).toEqual(['Files.ReadWrite.AppFolder']);
  });

  it('calls the token provider before each API operation', async () => {
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes:/children'), () =>
        HttpResponse.json({ value: [] }),
      ),
    );

    let calls = 0;
    const transport = new OneDriveTransport(() => {
      calls += 1;

      return Promise.resolve('token');
    });

    await transport.list('notes');
    await transport.list('notes');

    expect(calls).toBe(2);
  });

  it('lists files and ignores folders', async () => {
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes:/children'), () =>
        HttpResponse.json({
          value: [item, { ...item, id: 'folder', file: undefined }],
        }),
      ),
    );

    const files = await new OneDriveTransport(tokenProvider).list('notes');

    expect(files).toEqual([
      expect.objectContaining({ id: '1', syncKey: 'a.json', size: 10 }),
    ]);
  });

  it('returns empty values for missing lists and records', async () => {
    server.use(
      http.get(
        endpoint('/me/drive/special/approot:/notes:/children'),
        () => new HttpResponse(null, { status: 404 }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    expect(await transport.list('notes')).toEqual([]);
    expect(await transport.get('notes', 'a.json')).toBeUndefined();
  });

  it('throws provider errors for failed lists, gets, and puts', async () => {
    server.use(
      http.get(
        endpoint('/me/drive/special/approot:/notes:/children'),
        () => new HttpResponse(null, { status: 500 }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => new HttpResponse(null, { status: 500 }),
      ),

      http.post(endpoint('/me/drive/special/approot/children'), () =>
        HttpResponse.json({}),
      ),

      http.put(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    await expect(transport.list('notes')).rejects.toThrow('list failed: 500');

    await expect(transport.get('notes', 'a.json')).rejects.toThrow(
      'get failed: 500',
    );

    await expect(transport.put('notes', 'a.json', {})).rejects.toThrow(
      'put failed: 500',
    );
  });

  it('puts JSON after ensuring the directory', async () => {
    const requests: Request[] = [];

    server.use(
      http.post(
        endpoint('/me/drive/special/approot/children'),
        ({ request }) => {
          requests.push(request);

          return HttpResponse.json({});
        },
      ),

      http.put(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        ({ request }) => {
          requests.push(request);

          return HttpResponse.json(item);
        },
      ),
    );

    const result = await new OneDriveTransport(tokenProvider).put(
      'notes',
      'a.json',
      { id: 'a' },
    );

    expect(result).toMatchObject({ id: '1', syncKey: 'a.json' });

    expectSyncFileInfo(result, 'a.json');

    expect(await requests[0].json()).toMatchObject({
      name: 'notes',
      '@microsoft.graph.conflictBehavior': 'fail',
    });

    expect(await requests[1].json()).toEqual({ id: 'a' });
  });

  it('ensures a directory at most once per store, across many puts', async () => {
    let ensureDirectoryCalls = 0;

    server.use(
      http.post(endpoint('/me/drive/special/approot/children'), () => {
        ensureDirectoryCalls += 1;

        return HttpResponse.json({});
      }),

      http.put(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => HttpResponse.json(item),
      ),

      http.put(
        endpoint('/me/drive/special/approot:/notes-blobs/img.jpg:/content'),
        () => HttpResponse.json({ ...item, name: 'img.jpg' }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    await transport.put('notes', 'a.json', { id: 'a' });
    await transport.put('notes', 'a.json', { id: 'a' });
    await transport.putBlob('notes', 'img.jpg', new Blob(['img']));

    expect(ensureDirectoryCalls).toBe(2);
  });

  it('ensures a directory once even when concurrent puts race the same store', async () => {
    let ensureDirectoryCalls = 0;

    server.use(
      http.post(endpoint('/me/drive/special/approot/children'), () => {
        ensureDirectoryCalls += 1;

        return HttpResponse.json({});
      }),

      http.put(
        /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/special\/approot:\/notes\/.+:\/content$/,
        () => HttpResponse.json(item),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    await Promise.all(
      ['a.json', 'b.json', 'c.json', 'd.json', 'e.json', 'f.json'].map((key) =>
        transport.put('notes', key, { id: key }),
      ),
    );

    expect(ensureDirectoryCalls).toBe(1);
  });

  it('retries directory creation after a failed request', async () => {
    let ensureDirectoryCalls = 0;

    server.use(
      http.post(endpoint('/me/drive/special/approot/children'), () => {
        ensureDirectoryCalls += 1;

        return ensureDirectoryCalls === 1
          ? new HttpResponse(null, { status: 500 })
          : new HttpResponse(null, { status: 409 });
      }),

      http.put(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => HttpResponse.json(item),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    await expect(transport.put('notes', 'a.json', {})).rejects.toThrow(
      'ensure directory failed: 500',
    );

    await expect(transport.put('notes', 'a.json', {})).resolves.toMatchObject({
      syncKey: 'a.json',
    });

    expect(ensureDirectoryCalls).toBe(2);
  });

  it('soft deletes and hard deletes records and stores', async () => {
    server.use(
      http.get(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => HttpResponse.json({ id: 'a' }),
      ),

      http.post(endpoint('/me/drive/special/approot/children'), () =>
        HttpResponse.json({}),
      ),

      http.put(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => HttpResponse.json(item),
      ),

      http.get(endpoint('/me/drive/special/approot:/notes/a.json'), () =>
        HttpResponse.json({ id: 'file-id' }),
      ),

      http.get(endpoint('/me/drive/special/approot:/notes'), () =>
        HttpResponse.json({ id: 'dir-id' }),
      ),

      http.delete(
        /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/items\/.+$/,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    await expect(
      transport.delete('notes', 'a.json', true),
    ).resolves.toBeUndefined();

    await expect(transport.delete('notes', 'a.json')).resolves.toBeUndefined();
    await expect(transport.deleteAll('notes')).resolves.toBeUndefined();
  });

  it('ignores hard deletes when file and directory IDs are absent', async () => {
    server.use(
      http.get(
        endpoint('/me/drive/special/approot:/notes/a.json'),
        () => new HttpResponse(null, { status: 404 }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes'),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    await expect(transport.delete('notes', 'a.json')).resolves.toBeUndefined();
    await expect(transport.deleteAll('notes')).resolves.toBeUndefined();
  });

  it('putBlob ensures blob directory and uploads binary content', async () => {
    const blobItem = { ...item, name: 'img.jpg' };

    server.use(
      http.post(endpoint('/me/drive/special/approot/children'), () =>
        HttpResponse.json({}),
      ),

      http.put(
        endpoint('/me/drive/special/approot:/notes-blobs/img.jpg:/content'),
        () => HttpResponse.json(blobItem),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);
    const blob = new Blob(['img'], { type: 'image/jpeg' });

    const result = await transport.putBlob(
      'notes',
      'img.jpg',
      blob,
      'image/jpeg',
    );

    expect(result).toMatchObject({ syncKey: 'img.jpg' });
  });

  it('getBlob returns a Blob and undefined for missing files', async () => {
    server.use(
      http.get(
        endpoint('/me/drive/special/approot:/notes-blobs/img.jpg:/content'),
        () => new HttpResponse(new Uint8Array([1, 2, 3])),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes-blobs/missing.jpg:/content'),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    const result = await transport.getBlob('notes', 'img.jpg');

    expect(result).toBeInstanceOf(Blob);

    expect(await transport.getBlob('notes', 'missing.jpg')).toBeUndefined();
  });

  it('listBlobs returns blobs and empty array for missing folder', async () => {
    const blobItem = { ...item, name: 'img.jpg' };

    server.use(
      http.get(
        endpoint('/me/drive/special/approot:/notes-blobs:/children'),
        () => HttpResponse.json({ value: [blobItem] }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/empty-blobs:/children'),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    const result = await transport.listBlobs('notes');

    expect(result).toEqual([expect.objectContaining({ syncKey: 'img.jpg' })]);

    expect(await transport.listBlobs('empty')).toEqual([]);
  });

  it('deleteBlob removes blob and ignores missing file IDs', async () => {
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes-blobs/img.jpg'), () =>
        HttpResponse.json({ id: 'blob-file-id' }),
      ),

      http.delete(
        /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/items\/.+$/,
        () => new HttpResponse(null, { status: 204 }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes-blobs/missing.jpg'),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);

    await expect(
      transport.deleteBlob('notes', 'img.jpg'),
    ).resolves.toBeUndefined();

    await expect(
      transport.deleteBlob('notes', 'missing.jpg'),
    ).resolves.toBeUndefined();
  });

  it('count returns the number of files in the store', async () => {
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes:/children'), () =>
        HttpResponse.json({
          value: [item, { ...item, id: '2', name: 'b.json' }],
        }),
      ),
    );

    expect(await new OneDriveTransport(tokenProvider).count('notes')).toBe(2);
  });

  it('throws for putBlob, getBlob, and listBlobs server errors', async () => {
    server.use(
      http.post(endpoint('/me/drive/special/approot/children'), () =>
        HttpResponse.json({}),
      ),

      http.put(
        endpoint('/me/drive/special/approot:/notes-blobs/img.jpg:/content'),
        () => new HttpResponse(null, { status: 500 }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes-blobs/img.jpg:/content'),
        () => new HttpResponse(null, { status: 500 }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes-blobs:/children'),
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const transport = new OneDriveTransport(tokenProvider);
    const blob = new Blob(['img']);

    await expect(transport.putBlob('notes', 'img.jpg', blob)).rejects.toThrow(
      'putBlob failed: 500',
    );

    await expect(transport.getBlob('notes', 'img.jpg')).rejects.toThrow(
      'getBlob failed: 500',
    );

    await expect(transport.listBlobs('notes')).rejects.toThrow(
      'listBlobs failed: 500',
    );
  });

  it('soft deleteAll marks all records as deleted', async () => {
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes:/children'), () =>
        HttpResponse.json({ value: [item] }),
      ),

      http.get(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => HttpResponse.json({ id: 'a', title: 'A' }),
      ),

      http.post(endpoint('/me/drive/special/approot/children'), () =>
        HttpResponse.json({}),
      ),

      http.put(
        endpoint('/me/drive/special/approot:/notes/a.json:/content'),
        () => HttpResponse.json(item),
      ),
    );

    await expect(
      new OneDriveTransport(tokenProvider).deleteAll('notes', true),
    ).resolves.toBeUndefined();
  });
});
