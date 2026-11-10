export function createCircuitBreaker({
  minSamples = 4,
  failureRate = 0.5,
  windowMs = 15000,
  cooldownMs = 10000,
} = {}) {
  let state = "closed";
  let openedAt = 0;
  const samples = [];

  function prune(now) {
    while (samples.length > 0 && now - samples[0].t > windowMs) samples.shift();
  }

  function record(ok, now) {
    samples.push({ t: now, ok });
    prune(now);

    if (state === "half_open") {
      if (ok) {
        state = "closed";
        samples.length = 0;
      } else {
        state = "open";
        openedAt = now;
      }
      return;
    }

    if (state === "closed" && samples.length >= minSamples) {
      const failures = samples.filter((sample) => !sample.ok).length;
      if (failures / samples.length >= failureRate) {
        state = "open";
        openedAt = now;
      }
    }
  }

  return {
    async exec(fn) {
      const now = Date.now();
      prune(now);

      if (state === "open") {
        if (now - openedAt >= cooldownMs) {
          state = "half_open";
        } else {
          const error = new Error("Circuit is open. The payment gateway is not being called.");
          error.code = "CIRCUIT_OPEN";
          error.circuitState = state;
          throw error;
        }
      }

      try {
        const result = await fn();
        record(true, Date.now());
        return result;
      } catch (error) {
        record(false, Date.now());
        error.circuitState = state;
        throw error;
      }
    },
    snapshot() {
      return {
        state,
        samples: samples.length,
        openedAt: openedAt || null,
        cooldownMs,
      };
    },
    reset() {
      state = "closed";
      openedAt = 0;
      samples.length = 0;
    },
  };
}
