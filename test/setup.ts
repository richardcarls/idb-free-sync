import 'fake-indexeddb/auto';

import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { server } from './support/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => server.close());
