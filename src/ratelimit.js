export function createRateLimiter({ capacity = 8, refillPerSec = 2 } = {}) {
  const buckets = new Map();

  function take(key, now = Date.now()) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: now };
      buckets.set(key, bucket);
    }

    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      const missing = 1 - bucket.tokens;
      const retryAfterMs = refillPerSec <= 0 ? 1000 : Math.ceil((missing / refillPerSec) * 1000);
      return { allowed: false, remaining: 0, retryAfterMs, limit: capacity };
    }

    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: 0,
      limit: capacity,
    };
  }

  return { take };
}
