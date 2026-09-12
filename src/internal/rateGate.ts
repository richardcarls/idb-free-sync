/**
 * A leaky-bucket-style request gate: each `wait()` call resolves
 * immediately if at least `minIntervalMs` has passed since the last one
 * started, otherwise it delays just long enough to space itself out.
 *
 * Concurrent callers (e.g. SyncOrchestrator's bounded queue lanes) each
 * reserve their own slot up front, so they queue up single-file at
 * `minIntervalMs` apart instead of all firing at once and relying on a
 * provider's 429 to tell them to slow down after the fact.
 *
 * One gate instance is meant to be shared by every request a given
 * transport makes; `minIntervalMs` is the transport's own call, tuned to
 * how aggressively that provider's API rate-limits (a personal/dev-mode
 * Dropbox app needs a much wider gap than an approved production app).
 */
export function createRateGate(minIntervalMs: number) {
  let nextAvailableAt = 0;

  return {
    async wait(): Promise<void> {
      const now = Date.now();
      const start = Math.max(now, nextAvailableAt);

      nextAvailableAt = start + minIntervalMs;

      const delay = start - now;

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    },
  };
}
