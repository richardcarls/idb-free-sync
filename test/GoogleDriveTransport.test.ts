import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import { GoogleDriveTransport } from '../src/GoogleDriveTransport';
import { server } from './support/server';
import {
  expectSyncFileInfo,
  expectTransportIdentity,
} from './support/transportContract';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

type FakeFile = {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  properties?: Record<string, string>;
  modifiedTime?: string;
  createdTime?: string;
  md5Checksum?: string;
  size?: string;
  content?: string;
};

/** A minimal in-memory stand-in for a user's Drive appDataFolder. */
let drive: FakeFile[] = [];
let nextId = 0;

function reset() {
  drive = [];
  nextId = 0;
}

function findFolderByName(name: string): FakeFile | undefined {
  return drive.find(
    (f) =>
      f.mimeType === 'application/vnd.google-apps.folder' && f.name === name,
  );
}

function tokenProvider() {
  return Promise.resolve('token');
}

beforeEach(() => {
  reset();

  server.use(
    http.get(`${DRIVE_API}/files`, ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      const nameMatch = /^name = '(.+)' and mimeType/.exec(q);
      const parentMatch = /^'(.+)' in parents$/.exec(q);

      let files: FakeFile[] = [];

      if (nameMatch) {
        const folder = findFolderByName(nameMatch[1]);

        files = folder ? [folder] : [];
      } else if (parentMatch) {
        files = drive.filter((f) => f.parents?.includes(parentMatch[1]));
      }

      return HttpResponse.json({ files });
    }),

    http.get(`${DRIVE_API}/files/generateIds`, () => {
      nextId += 1;

      return HttpResponse.json({ ids: [`gen-${nextId}`] });
    }),

    http.get(`${DRIVE_API}/files/:id`, ({ params, request }) => {
      const file = drive.find((f) => f.id === params.id);

      if (!file) {
        return new HttpResponse(null, { status: 404 });
      }

      if (new URL(request.url).searchParams.get('alt') === 'media') {
        return new HttpResponse(file.content ?? '');
      }

      return HttpResponse.json(file);
    }),

    http.post(`${DRIVE_API}/files`, async ({ request }) => {
      const body = (await request.json()) as Partial<FakeFile>;
      const file: FakeFile = {
        id: body.id ?? `gen-${(nextId += 1)}`,
        name: body.name ?? '',
        mimeType: body.mimeType,
        parents: body.parents,
        createdTime: '2026-01-01T00:00:00Z',
        modifiedTime: '2026-01-01T00:00:00Z',
      };

      drive.push(file);

      return HttpResponse.json(file);
    }),

    http.delete(`${DRIVE_API}/files/:id`, ({ params }) => {
      drive = drive.filter((f) => f.id !== params.id);

      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${DRIVE_UPLOAD_API}/files`, async ({ request }) => {
      const formData = await request.formData();
      const resource = JSON.parse(
        await (formData.get('resource') as File).text(),
      ) as Partial<FakeFile>;
      const media = formData.get('media') as File;

      const file: FakeFile = {
        id: `gen-${(nextId += 1)}`,
        name: resource.name ?? '',
        mimeType: resource.mimeType,
        parents: resource.parents,
        properties: resource.properties,
        content: await media.text(),
        createdTime: '2026-01-01T00:00:00Z',
        modifiedTime: '2026-01-01T00:00:00Z',
        md5Checksum: 'checksum',
        size: String(media.size),
      };

      drive.push(file);

      return HttpResponse.json(file);
    }),

    http.patch(`${DRIVE_UPLOAD_API}/files/:id`, async ({ params, request }) => {
      const formData = await request.formData();
      const resource = JSON.parse(
        await (formData.get('resource') as File).text(),
      ) as Partial<FakeFile>;
      const media = formData.get('media') as File;

      const file = drive.find((f) => f.id === params.id);

      if (!file) {
        return new HttpResponse(null, { status: 404 });
      }

      Object.assign(file, {
        properties: resource.properties ?? file.properties,
        content: await media.text(),
        modifiedTime: '2026-01-02T00:00:00Z',
        size: String(media.size),
      });

      return HttpResponse.json(file);
    }),
  );
});

describe('GoogleDriveTransport', () => {
  it('reports its provider identity and scopes', () => {
    expectTransportIdentity(new GoogleDriveTransport(tokenProvider), 'google');
  });

  it('creates the store folder on first write and round-trips JSON records', async () => {
    const transport = new GoogleDriveTransport(tokenProvider);

    expect(await transport.list('notes')).toEqual([]);

    const result = await transport.put(
      'notes',
      'a.json',
      { id: 'a' },
      { source: 'test' },
    );

    expectSyncFileInfo(result, 'a.json');
    expect(await transport.get('notes', 'a.json')).toEqual({ id: 'a' });
    expect(await transport.get('notes', 'missing.json')).toBeUndefined();

    const listed = await transport.list('notes');

    expect(listed).toEqual([
      expect.objectContaining({
        syncKey: 'a.json',
        checksum: 'checksum',
        size: expect.any(Number),
      }),
    ]);
  });

  it('updates an existing file in place rather than creating a duplicate', async () => {
    const transport = new GoogleDriveTransport(tokenProvider);

    await transport.put('notes', 'a.json', { id: 'a', v: 1 });
    await transport.put('notes', 'a.json', { id: 'a', v: 2 });

    expect(await transport.get('notes', 'a.json')).toEqual({ id: 'a', v: 2 });
    expect(await transport.list('notes')).toHaveLength(1);
  });

  it('soft deletes by marking properties.deleted, and hard deletes by removing the file', async () => {
    const transport = new GoogleDriveTransport(tokenProvider);

    await transport.put('notes', 'a.json', { id: 'a' });
    await transport.delete('notes', 'a.json', true);

    expect(await transport.list('notes')).toEqual([
      expect.objectContaining({ syncKey: 'a.json', deleted: true }),
    ]);

    await transport.delete('notes', 'a.json');

    expect(await transport.list('notes')).toEqual([]);

    // Deleting an already-absent file is a no-op, not an error.
    await expect(
      transport.delete('notes', 'missing.json'),
    ).resolves.toBeUndefined();
  });

  it('deleteAll removes the whole store folder, or soft-deletes every record', async () => {
    const transport = new GoogleDriveTransport(tokenProvider);

    await transport.put('notes', 'a.json', { id: 'a' });
    await transport.put('notes', 'b.json', { id: 'b' });

    await transport.deleteAll('notes', true);

    expect(await transport.list('notes')).toEqual([
      expect.objectContaining({ deleted: true }),
      expect.objectContaining({ deleted: true }),
    ]);

    await transport.deleteAll('notes');
    expect(await transport.list('notes')).toEqual([]);
  });

  it('counts records in a store', async () => {
    const transport = new GoogleDriveTransport(tokenProvider);

    await transport.put('notes', 'a.json', { id: 'a' });
    await transport.put('notes', 'b.json', { id: 'b' });

    expect(await transport.count('notes')).toBe(2);
  });

  it('throws when Drive cannot generate a folder ID', async () => {
    server.use(
      http.get(`${DRIVE_API}/files/generateIds`, () =>
        HttpResponse.json({ ids: [] }),
      ),
    );

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      new GoogleDriveTransport(tokenProvider).list('notes'),
    ).rejects.toThrow('No id generated for folder');
  });

  it('round-trips blobs in a separate -blobs folder, keyed independently of JSON records', async () => {
    const transport = new GoogleDriveTransport(tokenProvider);
    const blob = new Blob(['img-bytes'], { type: 'image/jpeg' });

    const putResult = await transport.putBlob(
      'notes',
      'img.jpg',
      blob,
      'image/jpeg',
    );

    expectSyncFileInfo(putResult, 'img.jpg');

    const gotBlob = await transport.getBlob('notes', 'img.jpg');

    expect(gotBlob).toBeInstanceOf(Blob);
    expect(await gotBlob?.text()).toBe('img-bytes');

    expect(await transport.getBlob('notes', 'missing.jpg')).toBeUndefined();

    const listed = await transport.listBlobs('notes');

    expect(listed).toEqual([expect.objectContaining({ syncKey: 'img.jpg' })]);

    await transport.deleteBlob('notes', 'img.jpg');
    expect(await transport.listBlobs('notes')).toEqual([]);

    // Deleting an already-absent blob is a no-op.
    await expect(
      transport.deleteBlob('notes', 'missing.jpg'),
    ).resolves.toBeUndefined();
  });

  it('listBlobs returns an empty array when the blobs folder does not exist yet', async () => {
    const transport = new GoogleDriveTransport(tokenProvider);

    expect(await transport.listBlobs('empty')).toEqual([]);
  });
});
