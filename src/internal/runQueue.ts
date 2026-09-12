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
 * `onSettled` runs as each started item finishes; observer errors are logged
 * without changing the queue result or stopping another lane.
 */
export async function runQueue<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
  onSettled?: (item: T, result: PromiseSettledResult<void>) => void,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let nextIndex = 0;

  function settle(index: number, result: PromiseSettledResult<void>): void {
    results[index] = result;

    try {
      onSettled?.(items[index] as T, result);
    } catch (error) {
      console.error(error);
    }
  }

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
        settle(index, { status: 'fulfilled', value: undefined });
      } catch (error) {
        settle(index, { status: 'rejected', reason: error });
      }
    }
  }

  const laneCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: laneCount }, () => runLane()));

  for (let i = 0; i < items.length; i++) {
    if (!results[i]) {
      settle(i, {
        status: 'rejected',
        reason: new DOMException('Aborted', 'AbortError'),
      });
    }
  }

  return results;
}
