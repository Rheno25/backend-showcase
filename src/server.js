import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createCache } from "./cache.js";
import { createRateLimiter } from "./ratelimit.js";
import { createCircuitBreaker } from "./circuit.js";
import { createMetrics } from "./metrics.js";
import { createGateway } from "./gateway.js";
import { ApiError, createOrderService, parseOrderBody, readIdempotencyKey, safeEqual } from "./orders.js";

const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"));

export async function startServer(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDatabase(config.dbPath);
  const cache = createCache({ ttlMs: config.cacheTtlMs });
  const limiter = createRateLimiter({
    capacity: config.rateCapacity,
    refillPerSec: config.rateRefillPerSec,
  });
  const circuit = createCircuitBreaker({
    minSamples: config.circuitMinSamples,
    failureRate: config.circuitFailureRate,
    cooldownMs: config.circuitCooldownMs,
  });
  const metrics = createMetrics();
  const gateway = createGateway();
  const orders = createOrderService(db, cache);
  const logs = [];
  const sseClients = new Set();
  const sampleCpu = createCpuSampler();
  const startedAt = Date.now();
  let cpuPercent = 0;

  function log(level, message) {
    const entry = { t: new Date().toISOString(), level, message };
    logs.push(entry);
    if (logs.length > 80) logs.shift();
    broadcast({ type: "log", entry });
  }

  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) client.write(payload);
  }

  function snapshot() {
    const memory = process.memoryUsage();
    const metric = metrics.snapshot();
    const cacheStats = cache.stats();
    return {
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      rps: round(metric.rps, 2),
      p99_ms: round(metric.p99Ms, 2),
      request_total: metric.requestTotal,
      cpu_percent: cpuPercent,
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      cache: cacheStats,
      circuit: circuit.snapshot(),
      gateway: gateway.mode(),
      rate_limit: { capacity: config.rateCapacity, refill_per_sec: config.rateRefillPerSec },
    };
  }

  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    let route = url.pathname;
    let status = 500;

    try {
      if (req.method === "OPTIONS") {
        status = 204;
        send(res, status, null, corsHeaders());
        return;
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        status = 200;
        res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.end(indexHtml);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        status = 200;
        send(res, status, {
          status: "ok",
          service: "backend-showcase",
          uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
          database: config.dbPath === ":memory:" ? "memory" : "sqlite",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        status = 200;
        const body = metrics.prometheus({ cache: cache.stats(), circuit: circuit.snapshot() });
        res.writeHead(status, { "content-type": "text/plain; version=0.0.4; charset=utf-8", ...corsHeaders() });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/snapshot") {
        status = 200;
        send(res, status, { ...snapshot(), logs });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/stream") {
        status = 200;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...corsHeaders(),
        });
        res.write(`data: ${JSON.stringify({ type: "hello", logs, snapshot: snapshot() })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api") {
        status = 200;
        send(res, status, {
          name: "backend-showcase",
          auth: "Authorization: Bearer <API_TOKEN>",
          endpoints: [
            "GET /health",
            "GET /metrics",
            "GET /api/snapshot",
            "GET /api/stream",
            "GET /v2/inventory/:sku",
            "POST /v2/orders",
            "GET /v2/orders",
            "POST /v2/payments",
            "POST /v2/admin/faults",
          ],
        });
        return;
      }

      if (!url.pathname.startsWith("/v2/")) {
        status = 404;
        send(res, status, { error: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` });
        return;
      }

      if (!authorized(req, config.token)) {
        status = 401;
        send(res, status, {
          error: "UNAUTHORIZED",
          message: "Send Authorization: Bearer <API_TOKEN>. The local demo token is nxs_demo_local unless API_TOKEN is set.",
        });
        return;
      }

      const inventoryMatch = url.pathname.match(/^\/v2\/inventory\/([^/]+)$/);
      if (req.method === "GET" && inventoryMatch) {
        route = "/v2/inventory/:sku";
        const sku = decodeURIComponent(inventoryMatch[1]);
        const body = orders.readInventory(sku);
        status = 200;
        send(res, status, body, { "x-cache": body.cache_hit ? "HIT" : "MISS" });
        log("INFO", `inventory ${sku} ${body.cache_hit ? "cache hit" : "cache miss"} available=${body.available_stock}`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v2/orders") {
        route = "/v2/orders";
        const limit = Number(url.searchParams.get("limit") ?? 8);
        status = 200;
        send(res, status, { orders: orders.listOrders(Number.isInteger(limit) ? limit : 8) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v2/orders") {
        route = "/v2/orders";
        const raw = await readBody(req);
        const parsed = parseJson(raw);
        const input = parseOrderBody(parsed);
        const idempotencyKey = readIdempotencyKey(req.headers["x-idempotency-key"], parsed);
        const replay = orders.findReplay({ ...input, idempotencyKey });
        if (replay) {
          status = replay.status;
          send(res, status, replay.body);
          log("INFO", `replayed ${replay.body.order_id}`);
          return;
        }

        const decision = limiter.take(clientKey(req));
        if (!decision.allowed) {
          status = 429;
          send(res, status, {
            error: "RATE_LIMIT_EXCEEDED",
            message: "Order token bucket is empty for this client.",
            retry_after_ms: decision.retryAfterMs,
            limit: decision.limit,
            remaining: 0,
          }, {
            "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
            "x-ratelimit-limit": String(decision.limit),
            "x-ratelimit-remaining": "0",
          });
          log("WARN", `rate limit blocked an order for ${input.sku}`);
          return;
        }

        const result = orders.placeOrder({ ...input, idempotencyKey });
        status = result.status;
        send(res, status, result.body);
        log(result.replay ? "INFO" : "READY", `${result.replay ? "replayed" : "reserved"} ${result.body.order_id} ${input.sku} x${input.quantity}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v2/payments") {
        route = "/v2/payments";
        const parsed = parseJson(await readBody(req));
        const orderId = parsed?.order_id;
        if (typeof orderId !== "string" || !/^ord_[a-f0-9]+$/.test(orderId)) {
          throw new ApiError(400, "INVALID_ORDER", "order_id must be an order id returned by POST /v2/orders.");
        }
        const gatewayName = typeof parsed.gateway === "string" ? parsed.gateway.slice(0, 40) : "demo";
        const result = await orders.payOrder({ orderId, gatewayName }, circuit, gateway);
        status = result.status;
        send(res, status, result.body);
        log("INFO", `captured ${orderId} via ${gatewayName}`);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v2/admin/faults") {
        route = "/v2/admin/faults";
        const parsed = parseJson(await readBody(req));
        if (parsed?.payment_gateway !== undefined) {
          if (parsed.payment_gateway !== "healthy" && parsed.payment_gateway !== "down") {
            throw new ApiError(400, "INVALID_FAULT", "payment_gateway must be \"healthy\" or \"down\".");
          }
          gateway.setMode(parsed.payment_gateway);
        }
        if (parsed?.reset_circuit) circuit.reset();
        status = 200;
        const body = { gateway: gateway.mode(), circuit: circuit.snapshot() };
        send(res, status, body);
        log("WARN", `fault control gateway=${body.gateway} circuit=${body.circuit.state}`);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v2/admin/faults") {
        route = "/v2/admin/faults";
        status = 200;
        send(res, status, { gateway: gateway.mode(), circuit: circuit.snapshot() });
        return;
      }

      status = 404;
      send(res, status, { error: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` });
    } catch (error) {
      if (error instanceof ApiError) {
        status = error.status;
        send(res, status, { error: error.code, message: error.message, ...error.extra });
        log(status >= 500 ? "ERROR" : "WARN", `${status} ${error.code} ${error.message}`);
        return;
      }
      if (error?.status === 413) {
        status = 413;
        send(res, status, { error: "BODY_TOO_LARGE", message: "JSON body must be 64KB or smaller." });
        return;
      }
      status = 500;
      console.error(error);
      send(res, status, { error: "INTERNAL", message: "Unexpected server error." });
    } finally {
      if (url.pathname !== "/api/stream") {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        metrics.observe(req.method ?? "GET", route, status, durationMs);
        if (!res.headersSent) return;
        // Latency is recorded even when the body was already written.
      }
    }
  });

  const timer = setInterval(() => {
    cpuPercent = round(sampleCpu(), 1);
    broadcast({ type: "tick", snapshot: snapshot() });
  }, 1000);

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  log("INFO", `listening on :${port}`);
  log("INFO", "sqlite ready, inventory cache empty, payment circuit closed");

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    token: config.token,
    close() {
      clearInterval(timer);
      for (const client of sseClients) client.end();
      sseClients.clear();
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          try {
            db.close();
          } catch (closeError) {
            rejectClose(error ?? closeError);
            return;
          }
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

function authorized(req, token) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(Array.isArray(header) ? header[0] : header);
  if (!match) return false;
  return safeEqual(match[1], token);
}

function clientKey(req) {
  return req.socket.remoteAddress ?? "unknown";
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "INVALID_JSON_BODY", "Failed to parse request JSON. Check the syntax.");
  }
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        rejectBody(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function send(res, status, body, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(),
    ...extraHeaders,
  };
  if (body == null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-idempotency-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function createCpuSampler() {
  let last = process.cpuUsage();
  let lastAt = process.hrtime.bigint();
  return () => {
    const nowUsage = process.cpuUsage();
    const nowAt = process.hrtime.bigint();
    const elapsedUs = Number(nowAt - lastAt) / 1000;
    const usedUs = nowUsage.user - last.user + (nowUsage.system - last.system);
    last = nowUsage;
    lastAt = nowAt;
    if (elapsedUs <= 0) return 0;
    return (usedUs / elapsedUs) * 100;
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const handle = await startServer();
  console.log(`backend-showcase listening on ${handle.url}`);
}
