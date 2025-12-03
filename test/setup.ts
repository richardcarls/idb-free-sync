// Installs IndexedDB globals into the otherwise minimal Node test environment.
import 'fake-indexeddb/auto';

import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { server } from './support/server';

// Unhandled requests indicate that a provider escaped its mocked contract.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  server.resetHandlers();

  // Provider tests replace browser globals and console methods extensively.
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => server.close());
