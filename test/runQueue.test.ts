import { describe, expect, it, vi } from 'vitest';

import { runQueue } from '../src/internal/runQueue';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

describe('runQueue', () => {
  it('runs every item and returns one settled result per item, in order', async () => {
    const results = await runQueue(
      [1, 2, 3],
      2,
      async (item) => {
        if (item === 2) {
          throw new Error('boom');
        }
      },
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: undefined });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[2]).toEqual({ status: 'fulfilled', value: undefined });
  });

  it('never runs more than `concurrency` workers at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runQueue(items, 3, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('does not start a new item once the signal is already aborted', async () => {
    const controller = new AbortController();
    const worker = vi.fn(async () => {});

    controller.abort();

    const results = await runQueue([1, 2, 3], 2, worker, controller.signal);

    expect(worker).not.toHaveBeenCalled();
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('lets an already-started item finish, but starts nothing further once aborted mid-run', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const first = deferred<void>();

    const runPromise = runQueue(
      [1, 2, 3],
      1, // single lane so item 1 fully gates items 2/3 from starting
      async (item) => {
        started.push(item);

        if (item === 1) {
          controller.abort();
          await first.promise;
        }
      },
      controller.signal,
    );

    // Let the first (already-started) item begin before resolving it.
    await Promise.resolve();
    await Promise.resolve();
    first.resolve();

    const results = await runPromise;

    expect(started).toEqual([1]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: undefined });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(results[2]).toMatchObject({ status: 'rejected' });
  });

  it('resolves immediately for an empty item list', async () => {
    const worker = vi.fn(async () => {});

    await expect(runQueue([], 4, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });
});
