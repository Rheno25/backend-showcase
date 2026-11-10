import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startServer } from "../src/server.js";

describe("backend showcase API", { concurrency: 1 }, () => {
  let app;

  before(async () => {
    app = await startServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: ":memory:",
      token: "test-token",
      rateCapacity: 100,
      rateRefillPerSec: 100,
      circuitCooldownMs: 60_000,
    });
  });

  after(async () => {
    await app.close();
  });

  test("health and the showcase page are public", async () => {
    const health = await fetch(`${app.url}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.status, "ok");

    const page = await fetch(app.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /API Playground/);
  });

  test("inventory requires the bearer token and then caches the row", async () => {
    const denied = await fetch(`${app.url}/v2/inventory/SKU-992`);
    assert.equal(denied.status, 401);

    const first = await readSku(app, "SKU-992");
    assert.equal(first.response.status, 200);
    assert.equal(first.response.headers.get("x-cache"), "MISS");
    assert.equal(first.body.cache_hit, false);
    assert.equal(first.body.available_stock, 500);

    const second = await readSku(app, "SKU-992");
    assert.equal(second.response.headers.get("x-cache"), "HIT");
    assert.equal(second.body.cache_hit, true);
  });

  test("an order reserves stock once and a replay returns the same id", async () => {
    const beforeRead = await readSku(app, "SKU-100");
    const created = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-100",
      quantity: 2,
      idempotency_token: "idem_replay_01",
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, "RESERVED");
    assert.equal(created.body.idempotent_replay, false);
    assert.equal(created.body.total_amount, "25.98");

    const again = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-100",
      quantity: 2,
      idempotency_token: "idem_replay_01",
    });
    assert.equal(again.response.status, 201);
    assert.equal(again.body.order_id, created.body.order_id);
    assert.equal(again.body.idempotent_replay, true);

    const afterRead = await readSku(app, "SKU-100");
    assert.equal(afterRead.body.available_stock, beforeRead.body.available_stock - 2);
    assert.equal(afterRead.response.headers.get("x-cache"), "MISS");

    const conflict = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-100",
      quantity: 1,
      idempotency_token: "idem_replay_01",
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error, "IDEMPOTENCY_CONFLICT");
  });

  test("stock and funds are refused without writing a partial order", async () => {
    const stock = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-LOW",
      quantity: 2,
      idempotency_token: "idem_stock_short",
    });
    assert.equal(stock.response.status, 409);
    assert.equal(stock.body.error, "INSUFFICIENT_STOCK");

    const stillThere = await readSku(app, "SKU-LOW");
    assert.equal(stillThere.body.available_stock, 1);

    const broke = await placeOrder(app, {
      account_id: "ACC_EMPTY",
      sku: "SKU-992",
      quantity: 1,
      idempotency_token: "idem_no_funds",
    });
    assert.equal(broke.response.status, 409);
    assert.equal(broke.body.error, "INSUFFICIENT_FUNDS");
  });

  test("malformed JSON is a client error", async () => {
    const response = await fetch(`${app.url}/v2/orders`, {
      method: "POST",
      headers: auth(),
      body: "{",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "INVALID_JSON_BODY");
  });

  test("payment stays reserved while the gateway is down, then the circuit opens", async () => {
    const created = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-LOW",
      quantity: 1,
      idempotency_token: "idem_pay_low",
    });
    assert.equal(created.response.status, 201);
    const orderId = created.body.order_id;

    const fault = await fetch(`${app.url}/v2/admin/faults`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ payment_gateway: "down", reset_circuit: true }),
    });
    assert.equal(fault.status, 200);

    const failures = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const payment = await pay(app, orderId);
      failures.push(payment.response.status);
      assert.equal(payment.body.error, "GATEWAY_UNAVAILABLE");
    }
    assert.deepEqual(failures, [502, 502, 502, 502]);

    const open = await pay(app, orderId);
    assert.equal(open.response.status, 503);
    assert.equal(open.body.error, "CIRCUIT_BREAKER_OPEN");
    assert.equal(open.body.fallback_action, "REJECTED_FAST");

    const stillDown = await fetch(`${app.url}/v2/admin/faults`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ payment_gateway: "healthy" }),
    });
    assert.equal(stillDown.status, 200);
    const rejected = await pay(app, orderId);
    assert.equal(rejected.response.status, 503);

    const reset = await fetch(`${app.url}/v2/admin/faults`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ payment_gateway: "healthy", reset_circuit: true }),
    });
    assert.equal(reset.status, 200);

    const paid = await pay(app, orderId);
    assert.equal(paid.response.status, 200);
    assert.equal(paid.body.status, "PAID");
    assert.match(paid.body.provider_ref, /^pay_/);

    const replay = await pay(app, orderId);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.idempotent_replay, true);
  });

  test("prometheus metrics include the requests this process handled", async () => {
    const response = await fetch(`${app.url}/metrics`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /http_requests_total\{/);
    assert.match(text, /circuit_breaker_state\{name="payments"\}/);
  });
});

describe("order rate limit", { concurrency: 1 }, () => {
  let app;

  before(async () => {
    app = await startServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: ":memory:",
      token: "test-token",
      rateCapacity: 2,
      rateRefillPerSec: 0,
    });
  });

  after(async () => {
    await app.close();
  });

  test("the third new order is rejected and a replay still succeeds", async () => {
    const first = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-992",
      quantity: 1,
      idempotency_token: "idem_rate_one",
    });
    const second = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-992",
      quantity: 1,
      idempotency_token: "idem_rate_two",
    });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);

    const blocked = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-992",
      quantity: 1,
      idempotency_token: "idem_rate_three",
    });
    assert.equal(blocked.response.status, 429);
    assert.equal(blocked.body.error, "RATE_LIMIT_EXCEEDED");
    assert.ok(blocked.response.headers.get("retry-after"));

    const replay = await placeOrder(app, {
      account_id: "ACC_99201",
      sku: "SKU-992",
      quantity: 1,
      idempotency_token: "idem_rate_one",
    });
    assert.equal(replay.response.status, 201);
    assert.equal(replay.body.order_id, first.body.order_id);

    const inventory = await readSku(app, "SKU-992");
    assert.equal(inventory.body.available_stock, 498);
  });
});

function auth() {
  return {
    authorization: "Bearer test-token",
    "content-type": "application/json",
  };
}

function readSku(app, sku) {
  return requestJson(`${app.url}/v2/inventory/${sku}`, { headers: auth() });
}

function placeOrder(app, body) {
  return requestJson(`${app.url}/v2/orders`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ currency: "USD", ...body }),
  });
}

function pay(app, orderId) {
  return requestJson(`${app.url}/v2/payments`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ order_id: orderId, gateway: "demo" }),
  });
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}
