import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Makes constructor spies available to Vitest's hoisted SDK module mocks.
const { Dropbox, createClient } = vi.hoisted(() => ({
  Dropbox: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('dropbox', () => ({ Dropbox }));
vi.mock('webdav', () => ({ createClient }));

import {
  createDropboxClient,
  createRateLimitRetry,
} from '../src/internal/dropboxAdapter';
import { createWebDAVClient } from '../src/internal/webdavAdapter';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => vi.useRealTimers());

describe('SDK adapters', () => {
  it('constructs Dropbox with the given access token and a bound global fetch', () => {
    createDropboxClient('dropbox-token');

    expect(Dropbox).toHaveBeenCalledWith({
      accessToken: 'dropbox-token',
      fetch: expect.any(Function),
    });

    const { fetch: passedFetch } = Dropbox.mock.calls[0]?.[0] as {
      fetch: typeof fetch;
    };

    expect(passedFetch).not.toBe(globalThis.fetch);
  });

  it('retries rate limits with exponential fallback when Retry-After is absent', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, headers: new Headers() })
      .mockResolvedValue('ok');
    const gate = { wait: vi.fn(() => Promise.resolve()) };
    const delays: number[] = [];
    let now = 0;
    const wrap = createRateLimitRetry({
      gate,
      maxRetries: 2,
      now: () => now,
      random: () => 0,
      sleep: (delay) => {
        delays.push(delay);
        now += delay;

        return Promise.resolve();
      },
    });
    const client = wrap({ provider: 'dropbox', request });

    await expect(client.request('value')).resolves.toBe('ok');

    expect(client.provider).toBe('dropbox');
    expect(request).toHaveBeenCalledTimes(2);
    expect(gate.wait).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
  });

  it('honors Retry-After and preserves the method receiver', async () => {
    const delays: number[] = [];
    let now = 0;
    const client = {
      attempts: 0,
      request() {
        this.attempts += 1;

        if (this.attempts === 1) {
          return Promise.reject({
            status: 429,
            headers: new Headers({ 'Retry-After': '2' }),
          });
        }

        return Promise.resolve('ok');
      },
    };
    const wrap = createRateLimitRetry({
      gate: { wait: () => Promise.resolve() },
      now: () => now,
      random: () => 0,
      sleep: (delay) => {
        delays.push(delay);
        now += delay;

        return Promise.resolve();
      },
    });

    await expect(wrap(client).request()).resolves.toBe('ok');

    expect(client.attempts).toBe(2);
    expect(delays).toEqual([2000]);
  });

  it('uses the default timer for fallback delays', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue('ok');
    const wrap = createRateLimitRetry({
      gate: { wait: () => Promise.resolve() },
      maxRetries: 1,
      random: () => 0,
    });
    const result = wrap({ request }).request();

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(Date.now()).toBe(500);
  });

  it('does not retry unrelated errors or rate limits beyond the limit', async () => {
    const unrelatedError = new Error('failed');
    const unrelatedRequest = vi.fn(() => Promise.reject(unrelatedError));
    const rateLimitError = { status: 429 };
    const rateLimitedRequest = vi.fn(() => Promise.reject(rateLimitError));
    const wrap = createRateLimitRetry({
      gate: { wait: () => Promise.resolve() },
      maxRetries: 0,
    });

    await expect(wrap({ request: unrelatedRequest }).request()).rejects.toBe(
      unrelatedError,
    );

    await expect(wrap({ request: rateLimitedRequest }).request()).rejects.toBe(
      rateLimitError,
    );

    expect(unrelatedRequest).toHaveBeenCalledOnce();
    expect(rateLimitedRequest).toHaveBeenCalledOnce();
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
