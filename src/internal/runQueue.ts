/**
 * Runs `worker` over `items` with at most `concurrency` calls in flight at
 * once, returning one settled result per item in `items` order — the same
 * shape `Promise.allSettled` produces, so callers can swap between the two
 * without changing how they read the result.
 *
 * Unlike `items.map(worker)` fed into `Promise.allSettled`, which starts
 * every call synchronously before any `await`, this only starts a new call
 * once a previous one in its "lane" finishes — the property `signal` relies
 * on: checked before each new item starts, so aborting mid-run lets
 * already-started work finish but starts nothing further. Skipped items
 * (never started because of an abort) are reported as a rejected
 * `AbortError`, keeping every input item represented in the output.
 */
export async function runQueue<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let nextIndex = 0;

  async function runLane(): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        return;
      }

      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        await worker(items[index] as T);
        results[index] = { status: 'fulfilled', value: undefined };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  }

  const laneCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: laneCount }, () => runLane()));

  for (let i = 0; i < items.length; i++) {
    results[i] ??= {
      status: 'rejected',
      reason: new DOMException('Aborted', 'AbortError'),
    };
  }

  return results;
}
