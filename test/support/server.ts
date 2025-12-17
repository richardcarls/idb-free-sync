import { setupServer } from 'msw/node';

/** Shared in-process HTTP boundary used by provider and request-adapter tests. */
export const server = setupServer();
