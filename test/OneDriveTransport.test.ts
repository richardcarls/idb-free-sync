import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OneDriveTransport } from '../src/OneDriveTransport';
import { server } from './support/server';
import { expectSyncFileInfo } from './support/transportContract';

const { msal } = vi.hoisted(() => ({
  msal: {
    initialize: vi.fn().mockResolvedValue(undefined),
    handleRedirectPromise: vi.fn().mockResolvedValue(null),
    getAllAccounts: vi.fn(() => [{ homeAccountId: 'account' }]),
    acquireTokenSilent: vi.fn().mockResolvedValue({ accessToken: 'token' }),
    acquireTokenPopup: vi
      .fn()
      .mockResolvedValue({ accessToken: 'popup-token' }),
  },
}));

vi.mock('../src/internal/msalAdapter', () => ({
  createMsalClient: vi.fn(() => msal),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  msal.getAllAccounts.mockReturnValue([{ homeAccountId: 'account' }]);
  msal.acquireTokenSilent.mockResolvedValue({ accessToken: 'token' });
});

describe('OneDriveTransport', () => {
  it('lists files and ignores folders', async () => {
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes:/children'), () =>
        HttpResponse.json({
          value: [item, { ...item, id: 'folder', file: undefined }],
        }),
      ),
    );

    const files = await new OneDriveTransport('client').list('notes');

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
    const transport = new OneDriveTransport('client');

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
    const transport = new OneDriveTransport('client');

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

    const result = await new OneDriveTransport('client').put(
      'notes',
      'a.json',
      { id: 'a' },
    );

    expect(result).toMatchObject({ id: '1', syncKey: 'a.json' });
    expectSyncFileInfo(result, 'a.json');
    expect(await requests[0].json()).toMatchObject({ name: 'notes' });
    expect(await requests[1].json()).toEqual({ id: 'a' });
  });

  it('uses popup authentication when interaction is required', async () => {
    msal.acquireTokenSilent.mockRejectedValue(
      new InteractionRequiredAuthError('interaction_required'),
    );
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes:/children'), () =>
        HttpResponse.json({ value: [] }),
      ),
    );

    await new OneDriveTransport('client').list('notes');

    expect(msal.acquireTokenPopup).toHaveBeenCalled();
  });

  it('uses popup authentication when there is no account', async () => {
    msal.getAllAccounts.mockReturnValue([]);
    msal.acquireTokenSilent.mockRejectedValue(new Error('no account'));
    server.use(
      http.get(endpoint('/me/drive/special/approot:/notes:/children'), () =>
        HttpResponse.json({ value: [] }),
      ),
    );

    await new OneDriveTransport('client').list('notes');
    expect(msal.acquireTokenPopup).toHaveBeenCalled();
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
    const transport = new OneDriveTransport('client');

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
    const transport = new OneDriveTransport('client');

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

    const transport = new OneDriveTransport('client');
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

    const transport = new OneDriveTransport('client');

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

    const transport = new OneDriveTransport('client');

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

    const transport = new OneDriveTransport('client');

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

    expect(await new OneDriveTransport('client').count('notes')).toBe(2);
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

    const transport = new OneDriveTransport('client');
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
      new OneDriveTransport('client').deleteAll('notes', true),
    ).resolves.toBeUndefined();
  });
});
