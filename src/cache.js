export function createCache({ max = 128, ttlMs = 5000 } = {}) {
  const entries = new Map();
  const stats = { hits: 0, misses: 0 };

  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  return {
    get(key) {
      const now = Date.now();
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now) {
        if (entry) entries.delete(key);
        stats.misses += 1;
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      stats.hits += 1;
      return {
        value: entry.value,
        ttlMs: entry.expiresAt - now,
      };
    },
    set(key, value) {
      const now = Date.now();
      entries.delete(key);
      entries.set(key, { value, expiresAt: now + ttlMs });
      prune(now);
    },
    delete(key) {
      entries.delete(key);
    },
    stats() {
      const lookups = stats.hits + stats.misses;
      return {
        ...stats,
        hitRate: lookups === 0 ? 0 : stats.hits / lookups,
      };
    },
  };
}
