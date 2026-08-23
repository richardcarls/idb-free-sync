import { beforeEach, describe, expect, it, vi } from 'vitest';

// Makes constructor spies available to Vitest's hoisted SDK module mocks.
const { Dropbox, createClient } = vi.hoisted(() => ({
  Dropbox: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('dropbox', () => ({ Dropbox }));
vi.mock('webdav', () => ({ createClient }));

import { createDropboxClient } from '../src/internal/dropboxAdapter';
import { createWebDAVClient } from '../src/internal/webdavAdapter';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SDK adapters', () => {
  it('constructs Dropbox with the given access token and global fetch', () => {
    createDropboxClient('dropbox-token');

    expect(Dropbox).toHaveBeenCalledWith({
      accessToken: 'dropbox-token',
      fetch: globalThis.fetch,
    });
  });

  it('constructs WebDAV clients with password or bearer authentication', () => {
    createWebDAVClient({
      url: 'https://dav.example',
      username: 'user',
      password: 'password',
    });

    createWebDAVClient({ url: 'https://dav.example', token: 'token' });

    expect(createClient).toHaveBeenNthCalledWith(1, 'https://dav.example', {
      username: 'user',
      password: 'password',
      token: undefined,
    });

    expect(createClient).toHaveBeenNthCalledWith(2, 'https://dav.example', {
      username: undefined,
      password: undefined,
      token: { token_type: 'Bearer', access_token: 'token' },
    });
  });
});
