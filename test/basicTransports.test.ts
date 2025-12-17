import { describe, expect, it } from 'vitest';

import { NullTransport } from '../src/NullTransport';
import { OPFSTransport } from '../src/OPFSTransport';
import { expectTransportIdentity } from './support/transportContract';

describe('NullTransport', () => {
  const transport = new NullTransport();

  it('implements a no-op transport', async () => {
    expectTransportIdentity(transport, 'none');
    expect(await transport.list()).toEqual([]);
    expect(await transport.get()).toBeUndefined();

    expect(await transport.put('notes', 'a.json')).toEqual({
      id: 'a.json',
      syncKey: 'a.json',
    });

    await expect(transport.delete()).resolves.toBeUndefined();
    await expect(transport.deleteAll()).resolves.toBeUndefined();

    expect(await transport.count()).toBe(0);
  });
});

describe('OPFSTransport', () => {
  it('retains its deprecated local transport identity', () => {
    expectTransportIdentity(new OPFSTransport(), 'opfs');
  });
});
