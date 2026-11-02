import { ApiError } from "./errors.js";

export const RATE_LIMITS = { global: 600, join: 30, admin: 10, identity: 60 } as const;
export const RATE_WINDOW_MS = 60_000;
export const MAX_RATE_BUCKETS = 1_024;

interface Bucket {
  count: number;
  until: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity: number = MAX_RATE_BUCKETS,
  ) {}

  take(key: string, limit: number): void {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (existing && existing.until > now) {
      if (existing.count >= limit) throw new ApiError("RATE_LIMITED");
      existing.count++;
      return;
    }
    if (this.buckets.size >= this.capacity) {
      for (const [candidate, bucket] of this.buckets) {
        if (bucket.until <= now) this.buckets.delete(candidate);
      }
    }
    if (this.buckets.size >= this.capacity) throw new ApiError("RATE_LIMITED");
    this.buckets.set(key, { count: 1, until: now + RATE_WINDOW_MS });
  }
}
