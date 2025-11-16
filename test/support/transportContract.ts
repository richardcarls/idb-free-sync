import { expect } from 'vitest';

import type { SyncFileInfo, SyncTransport } from '../../src/SyncTransport';

export function expectTransportIdentity(
  transport: SyncTransport,
  provider: string,
): void {
  expect(transport.provider).toBe(provider);
  expect(transport.scopes).toEqual(expect.any(Array));
}

export function expectSyncFileInfo(value: SyncFileInfo, syncKey: string): void {
  expect(value).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      syncKey,
    }),
  );
}
