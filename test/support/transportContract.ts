import { expect } from 'vitest';

import type { SyncFileInfo, SyncTransport } from '../../src/SyncTransport';

/**
 * Verifies the stable identity fields shared by every transport.
 *
 * @param transport - transport under test
 * @param provider - expected public provider identifier
 */
export function expectTransportIdentity(
  transport: SyncTransport,
  provider: string,
): void {
  expect(transport.provider).toBe(provider);
  expect(transport.scopes).toEqual(expect.any(Array));
}

/**
 * Verifies metadata fields required for records to participate in synchronization.
 *
 * @param value - provider metadata returned by a transport
 * @param syncKey - expected provider file name
 */
export function expectSyncFileInfo(value: SyncFileInfo, syncKey: string): void {
  expect(value).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      syncKey,
    }),
  );
}
