import { Redis } from "ioredis";

export const MOBILE_RATE_LIMITER = Symbol("MOBILE_RATE_LIMITER");

/** Fixed-window limiter for the unauthenticated pairing endpoints. */
export interface MobileRateLimiter {
  /** Records one attempt; false once `limit` attempts happened in the current window. */
  consume(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  close?(): Promise<void>;
}

export class InMemoryMobileRateLimiter implements MobileRateLimiter {
  readonly #windows = new Map<string, { resetAt: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const now = this.now();
    if (this.#windows.size > 10_000) {
      for (const [candidate, window] of this.#windows) if (window.resetAt <= now) this.#windows.delete(candidate);
    }
    const current = this.#windows.get(key);
    const window = current && current.resetAt > now ? current : { resetAt: now + windowSeconds * 1000, count: 0 };
    window.count += 1;
    this.#windows.set(key, window);
    return window.count <= limit;
  }
}

/**
 * Shares limits across API replicas. If Redis is unreachable the limiter keeps
 * protecting this replica with in-memory windows rather than failing open.
 */
export class RedisMobileRateLimiter implements MobileRateLimiter {
  readonly #redis: Redis;
  readonly #fallback = new InMemoryMobileRateLimiter();

  constructor(url: string) {
    this.#redis = new Redis(url, { maxRetriesPerRequest: 1 });
    this.#redis.on("error", () => undefined);
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey = `berry:mobile-pairing:rl:${key}:${bucket}`;
    try {
      const count = await this.#redis.incr(redisKey);
      if (count === 1) await this.#redis.expire(redisKey, windowSeconds);
      return count <= limit;
    } catch {
      return this.#fallback.consume(key, limit, windowSeconds);
    }
  }

  async close(): Promise<void> {
    this.#redis.disconnect();
  }
}

export function createMobileRateLimiterFromEnv(env: NodeJS.ProcessEnv): MobileRateLimiter {
  const url = env.BERRY_REDIS_URL?.trim() || env.REDIS_URL?.trim();
  return url ? new RedisMobileRateLimiter(url) : new InMemoryMobileRateLimiter();
}
