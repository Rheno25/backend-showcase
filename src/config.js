export function loadConfig(overrides = {}) {
  const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    port: num(overrides.port ?? process.env.PORT, 8080),
    host: overrides.host ?? process.env.HOST ?? "0.0.0.0",
    dbPath: overrides.dbPath ?? process.env.DB_PATH ?? "data/showcase.db",
    token: overrides.token ?? process.env.API_TOKEN ?? "nxs_demo_local",
    rateCapacity: num(overrides.rateCapacity ?? process.env.RATE_CAPACITY, 8),
    rateRefillPerSec: num(overrides.rateRefillPerSec ?? process.env.RATE_REFILL_PER_SEC, 2),
    cacheTtlMs: num(overrides.cacheTtlMs ?? process.env.CACHE_TTL_MS, 5000),
    circuitMinSamples: num(overrides.circuitMinSamples ?? process.env.CIRCUIT_MIN_SAMPLES, 4),
    circuitFailureRate: num(overrides.circuitFailureRate ?? process.env.CIRCUIT_FAILURE_RATE, 0.5),
    circuitCooldownMs: num(overrides.circuitCooldownMs ?? process.env.CIRCUIT_COOLDOWN_MS, 10000),
  };
}
