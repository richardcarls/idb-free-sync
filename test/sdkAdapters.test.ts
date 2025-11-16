import { beforeEach, describe, expect, it, vi } from 'vitest';

const { Dropbox, PublicClientApplication, createClient } = vi.hoisted(() => ({
  Dropbox: vi.fn(),
  PublicClientApplication: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('dropbox', () => ({ Dropbox }));
vi.mock('@azure/msal-browser', () => ({ PublicClientApplication }));
vi.mock('webdav', () => ({ createClient }));

import { createDropboxClient } from '../src/internal/dropboxAdapter';
import { createMsalClient } from '../src/internal/msalAdapter';
import { createWebDAVClient } from '../src/internal/webdavAdapter';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => 'dropbox-token'),
  });
  vi.stubGlobal('window', {
    location: { origin: 'https://app.example' },
  });
});

describe('SDK adapters', () => {
  it('constructs Dropbox with the stored access token', () => {
    createDropboxClient();
    expect(Dropbox).toHaveBeenCalledWith({ accessToken: 'dropbox-token' });

    vi.stubGlobal('localStorage', { getItem: () => null });
    createDropboxClient();
    expect(Dropbox).toHaveBeenLastCalledWith({ accessToken: '' });
  });

  it('constructs MSAL with the application identity settings', () => {
    createMsalClient('client-id');
    expect(PublicClientApplication).toHaveBeenCalledWith({
      auth: {
        clientId: 'client-id',
        authority: 'https://login.microsoftonline.com/common',
        redirectUri: 'https://app.example',
      },
      cache: { cacheLocation: 'localStorage' },
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
