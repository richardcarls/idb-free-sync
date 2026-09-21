import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRateGate } from '../src/internal/rateGate';

describe('createRateGate', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves immediately the first time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const gate = createRateGate(1000);

    await gate.wait();

    expect(Date.now()).toBe(0);
  });

  it('spaces concurrent callers at least minIntervalMs apart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const gate = createRateGate(50);
    const elapsed: number[] = [];

    const settled = Promise.all(
      Array.from({ length: 4 }, () =>
        gate.wait().then(() => {
          elapsed.push(Date.now());
        }),
      ),
    );

    await vi.runAllTimersAsync();
    await settled;

    expect(elapsed).toEqual([0, 50, 100, 150]);
  });

  it('lets a caller through immediately once minIntervalMs has already elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const gate = createRateGate(20);

    await gate.wait();
    await vi.advanceTimersByTimeAsync(30);

    await gate.wait();

    expect(Date.now()).toBe(30);
  });
});
