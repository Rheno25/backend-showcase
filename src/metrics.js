const BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

export function createMetrics() {
  const counts = new Map();
  const durations = [];
  const timestamps = [];
  const histogram = new Map();
  let durationSum = 0;

  function key(method, route, status) {
    return `${method}|${route}|${status}`;
  }

  return {
    observe(method, route, status, durationMs) {
      const now = Date.now();
      counts.set(key(method, route, status), (counts.get(key(method, route, status)) ?? 0) + 1);
      durations.push(durationMs);
      if (durations.length > 400) durations.shift();
      timestamps.push(now);
      durationSum += durationMs;

      for (const bucket of BUCKETS) {
        if (durationMs <= bucket) {
          const name = String(bucket);
          histogram.set(name, (histogram.get(name) ?? 0) + 1);
        }
      }
      histogram.set("+Inf", (histogram.get("+Inf") ?? 0) + 1);
    },
    snapshot() {
      const now = Date.now();
      while (timestamps.length > 0 && now - timestamps[0] > 5000) timestamps.shift();
      const sorted = [...durations].sort((a, b) => a - b);
      const p99 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)];
      const requests = [...counts.entries()].map(([id, count]) => {
        const [method, route, status] = id.split("|");
        return { method, route, status: Number(status), count };
      });
      return {
        rps: timestamps.length / 5,
        p99Ms: p99,
        requestTotal: requests.reduce((sum, row) => sum + row.count, 0),
        requests,
        durationSumMs: durationSum,
      };
    },
    prometheus(extra = {}) {
      const lines = [
        "# HELP http_requests_total HTTP requests handled by this process.",
        "# TYPE http_requests_total counter",
      ];
      for (const [id, count] of counts) {
        const [method, route, status] = id.split("|");
        lines.push(
          `http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`,
        );
      }
      lines.push(
        "# HELP http_request_duration_ms Request duration in milliseconds.",
        "# TYPE http_request_duration_ms histogram",
      );
      let cumulative = 0;
      const seen = new Map();
      for (const bucket of BUCKETS) {
        cumulative = histogram.get(String(bucket)) ?? cumulative;
        seen.set(bucket, cumulative);
        lines.push(`http_request_duration_ms_bucket{le="${bucket}"} ${cumulative}`);
      }
      lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${histogram.get("+Inf") ?? 0}`);
      lines.push(`http_request_duration_ms_sum ${durationSum}`);
      lines.push(`http_request_duration_ms_count ${histogram.get("+Inf") ?? 0}`);
      lines.push(
        "# HELP process_resident_memory_bytes Resident memory of this Node process.",
        "# TYPE process_resident_memory_bytes gauge",
        `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      );
      if (extra.cache) {
        lines.push(
          "# HELP cache_hits_total Inventory cache hits.",
          "# TYPE cache_hits_total counter",
          `cache_hits_total ${extra.cache.hits}`,
          "# HELP cache_misses_total Inventory cache misses.",
          "# TYPE cache_misses_total counter",
          `cache_misses_total ${extra.cache.misses}`,
        );
      }
      if (extra.circuit) {
        const encoded = extra.circuit.state === "open" ? 2 : extra.circuit.state === "half_open" ? 1 : 0;
        lines.push(
          "# HELP circuit_breaker_state Payment circuit. 0 closed, 1 half-open, 2 open.",
          "# TYPE circuit_breaker_state gauge",
          `circuit_breaker_state{name="payments"} ${encoded}`,
        );
      }
      return `${lines.join("\n")}\n`;
    },
  };
}
