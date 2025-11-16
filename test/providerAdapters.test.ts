import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { getGoogleClient } from '../src/internal/googleAdapter';
import { request } from '../src/internal/request';
import { server } from './support/server';

describe('request adapter', () => {
  it('dispatches requests through the native fetch boundary', async () => {
    server.use(
      http.post('https://api.example/items', async ({ request }) =>
        HttpResponse.json({
          authorization: request.headers.get('authorization'),
          body: await request.json(),
        }),
      ),
    );

    const response = await request('https://api.example/items', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: JSON.stringify({ id: 'a' }),
    });

    expect(await response.json()).toEqual({
      authorization: 'Bearer token',
      body: { id: 'a' },
    });
  });
});

describe('Google adapter', () => {
  it('returns an already loaded client', async () => {
    const client = { drive: {} };
    vi.stubGlobal('gapi', { client });

    await expect(getGoogleClient('client', ['scope'])).resolves.toBe(client);
  });

  it('initializes OAuth and the Drive client when globals become available', async () => {
    vi.useFakeTimers();
    const client = { init: vi.fn().mockResolvedValue(undefined) };
    const setToken = vi.fn();
    const requestAccessToken = vi.fn();
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'user@example.com' },
    });

    const pending = getGoogleClient('client', ['scope-a', 'scope-b']);
    setTimeout(() => {
      vi.stubGlobal('gapi', {
        client,
        auth: { setToken },
        load: (_name: string, callback: () => void) => callback(),
      });
      vi.stubGlobal('google', {
        accounts: {
          oauth2: {
            initTokenClient: vi.fn((config) => {
              queueMicrotask(() => config.callback({ access_token: 'token' }));
              return { requestAccessToken };
            }),
          },
        },
      });
    }, 500);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toBe(client);
    expect(requestAccessToken).toHaveBeenCalled();
    expect(client.init).toHaveBeenCalled();
    expect(setToken).toHaveBeenCalledWith({ access_token: 'token' });
    vi.useRealTimers();
  });
});
