import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

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
