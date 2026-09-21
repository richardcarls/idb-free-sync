import { Dropbox } from 'dropbox';

import { createRateGate } from './rateGate';

const MAX_RATE_LIMIT_RETRIES = 10;
const DROPBOX_MIN_REQUEST_INTERVAL_MS = 350;

type RateLimitRetryOptions = {
  gate?: { wait(): Promise<void> };
  maxRetries?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function isRateLimited(
  err: unknown,
): err is { status: number; headers?: Headers } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: unknown }).status === 429
  );
}

function retryDelayMs(
  err: { headers?: Headers },
  attempt: number,
  random: () => number,
): number {
  const retryAfter = err.headers?.get('Retry-After');
  const retryAfterSeconds =
    retryAfter === null || retryAfter === undefined
      ? Number.NaN
      : Number(retryAfter);
  const base =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1000
      : 2 ** attempt * 500;

  return base + random() * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Creates a shared Dropbox rate-limit wrapper. */
export function createRateLimitRetry(options: RateLimitRetryOptions = {}) {
  const gate = options.gate ?? createRateGate(DROPBOX_MIN_REQUEST_INTERVAL_MS);
  const maxRetries = options.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const wait = options.sleep ?? sleep;
  let cooldownUntil = 0;

  return function withRateLimitRetry<T extends object>(client: T): T {
    return new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        if (typeof value !== 'function') {
          return value;
        }

        return async (...args: unknown[]) => {
          for (let attempt = 0; ; attempt += 1) {
            const cooldown = cooldownUntil - now();

            if (cooldown > 0) {
              await wait(cooldown);
            }

            await gate.wait();

            try {
              return await (
                value as (...methodArgs: unknown[]) => unknown
              ).apply(target, args);
            } catch (error) {
              if (!isRateLimited(error) || attempt >= maxRetries) {
                throw error;
              }

              const delay = retryDelayMs(error, attempt, random);

              cooldownUntil = Math.max(cooldownUntil, now() + delay);
              await wait(delay);
            }
          }
        };
      },
    });
  };
}

// Share spacing and cooldown state across short-lived SDK clients.
const withRateLimitRetry = createRateLimitRetry();

export function createDropboxClient(accessToken: string): Dropbox {
  // The SDK invokes the supplied fetch as an object method.
  const client = new Dropbox({
    accessToken,
    fetch: globalThis.fetch.bind(globalThis),
  });

  return withRateLimitRetry(client);
}
