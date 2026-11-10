import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withTransaction } from "./db.js";

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function parseOrderBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_JSON_BODY", "Request body must be a JSON object.");
  }

  const accountId = body.account_id;
  const sku = body.sku;
  const quantity = body.quantity;
  const currency = body.currency ?? "USD";

  if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
    throw new ApiError(400, "INVALID_ACCOUNT", "account_id must be 1-64 letters, numbers, _ or -.");
  }
  if (typeof sku !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sku)) {
    throw new ApiError(400, "INVALID_SKU", "sku must be 1-64 letters, numbers, _ or -.");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new ApiError(400, "INVALID_QUANTITY", "quantity must be an integer from 1 to 100.");
  }
  if (currency !== "USD") {
    throw new ApiError(400, "UNSUPPORTED_CURRENCY", "Only USD is supported in this demo.");
  }

  return { accountId, sku, quantity, currency };
}

export function readIdempotencyKey(headerValue, body) {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const key = (header && String(header)) || body?.idempotency_token;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Send X-Idempotency-Key or idempotency_token (8-80 letters, numbers, _ or -).",
    );
  }
  return key;
}

function money(cents) {
  return (cents / 100).toFixed(2);
}

function shapeInventory(row) {
  return {
    sku: row.sku,
    name: row.name,
    available_stock: row.available,
    reserved_stock: row.reserved,
    price_cents: row.price_cents,
    price: money(row.price_cents),
    version: row.version,
    updated_at: row.updated_at,
  };
}

export function createOrderService(db, cache) {
  const getInventory = db.prepare("SELECT * FROM inventory WHERE sku = ?");
  const getAccount = db.prepare("SELECT * FROM accounts WHERE id = ?");
  const getIdempotency = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?");
  const getOrder = db.prepare("SELECT * FROM orders WHERE id = ?");
  const updateInventory = db.prepare(`
    UPDATE inventory
    SET available = available - ?,
        reserved = reserved + ?,
        version = version + 1,
        updated_at = ?
    WHERE sku = ? AND version = ? AND available >= ?
  `);
  const updateAccount = db.prepare(`
    UPDATE accounts
    SET balance_cents = balance_cents - ?,
        version = version + 1
    WHERE id = ? AND version = ? AND balance_cents >= ?
  `);
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, account_id, sku, quantity, total_cents, currency, status, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
  `);
  const insertIdempotency = db.prepare(`
    INSERT INTO idempotency_keys (key, request_hash, status_code, response_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const markPaid = db.prepare(`
    UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'reserved'
  `);
  const listStmt = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?");

  function findReplay({ accountId, sku, quantity, currency, idempotencyKey }) {
    const existing = getIdempotency.get(idempotencyKey);
    if (!existing) return null;
    const requestHash = stableHash({ accountId, sku, quantity, currency });
    if (existing.request_hash !== requestHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used for a different request.",
      );
    }
    return {
      status: existing.status_code,
      body: { ...JSON.parse(existing.response_json), idempotent_replay: true },
    };
  }

  function readInventory(sku) {
    const cacheKey = `inv:${sku}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached.value,
        cache_hit: true,
        cache_ttl_seconds: Math.max(0, Math.ceil(cached.ttlMs / 1000)),
      };
    }

    const row = getInventory.get(sku);
    if (!row) throw new ApiError(404, "UNKNOWN_SKU", `No inventory row for ${sku}.`);
    const body = shapeInventory(row);
    cache.set(cacheKey, body);
    return { ...body, cache_hit: false, cache_ttl_seconds: null };
  }

  function placeOrder({ accountId, sku, quantity, currency, idempotencyKey }) {
    const requestHash = stableHash({ accountId, sku, quantity, currency });
    const result = withTransaction(db, () => {
      const existing = getIdempotency.get(idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for a different request.",
          );
        }
        return {
          replay: true,
          status: existing.status_code,
          body: { ...JSON.parse(existing.response_json), idempotent_replay: true },
        };
      }

      const inventory = getInventory.get(sku);
      if (!inventory) throw new ApiError(404, "UNKNOWN_SKU", `No inventory row for ${sku}.`);
      if (inventory.available < quantity) {
        throw new ApiError(409, "INSUFFICIENT_STOCK", "Not enough available stock for this order.", {
          available_stock: inventory.available,
        });
      }

      const account = getAccount.get(accountId);
      if (!account) throw new ApiError(404, "UNKNOWN_ACCOUNT", `No account ${accountId}.`);
      const totalCents = inventory.price_cents * quantity;
      if (account.balance_cents < totalCents) {
        throw new ApiError(409, "INSUFFICIENT_FUNDS", "Account balance cannot cover this order.", {
          balance: money(account.balance_cents),
          required: money(totalCents),
        });
      }

      const now = new Date().toISOString();
      const inventoryWrite = updateInventory.run(quantity, quantity, now, sku, inventory.version, quantity);
      if (inventoryWrite.changes !== 1) {
        throw new ApiError(409, "CONCURRENT_MODIFICATION", "Inventory changed before the write committed. Retry.");
      }
      const accountWrite = updateAccount.run(totalCents, accountId, account.version, totalCents);
      if (accountWrite.changes !== 1) {
        throw new ApiError(409, "CONCURRENT_MODIFICATION", "Account changed before the write committed. Retry.");
      }

      const orderId = `ord_${randomBytes(6).toString("hex")}`;
      insertOrder.run(orderId, accountId, sku, quantity, totalCents, currency, idempotencyKey, now, now);

      const body = {
        status: "RESERVED",
        order_id: orderId,
        account_id: accountId,
        sku,
        quantity,
        currency,
        total_amount: money(totalCents),
        total_cents: totalCents,
        execution_path: "BEGIN_IMMEDIATE -> VERSION_CHECK -> WAL_COMMIT",
        idempotent_replay: false,
        inventory_version: inventory.version + 1,
        account_version: account.version + 1,
        timestamp: now,
      };
      insertIdempotency.run(idempotencyKey, requestHash, 201, JSON.stringify(body), now);
      return { replay: false, status: 201, body, sku };
    });

    if (!result.replay) cache.delete(`inv:${result.sku}`);
    return result;
  }

  async function payOrder({ orderId, gatewayName }, circuit, gateway) {
    const order = getOrder.get(orderId);
    if (!order) throw new ApiError(404, "UNKNOWN_ORDER", `No order ${orderId}.`);
    if (order.status === "paid") {
      return {
        status: 200,
        body: {
          status: "PAID",
          order_id: order.id,
          total_amount: money(order.total_cents),
          idempotent_replay: true,
          circuit_state: circuit.snapshot().state,
        },
      };
    }
    if (order.status !== "reserved") {
      throw new ApiError(409, "ORDER_NOT_PAYABLE", `Order is ${order.status} and cannot be captured.`);
    }

    let charge;
    try {
      charge = await circuit.exec(() =>
        gateway.charge({
          orderId: order.id,
          amountCents: order.total_cents,
          gateway: gatewayName,
        }),
      );
    } catch (error) {
      if (error.code === "CIRCUIT_OPEN") {
        throw new ApiError(503, "CIRCUIT_BREAKER_OPEN", error.message, {
          circuit_state: "open",
          fallback_action: "REJECTED_FAST",
        });
      }
      if (error.code === "GATEWAY_DOWN") {
        throw new ApiError(
          502,
          "GATEWAY_UNAVAILABLE",
          "Payment gateway failed. This failure counts toward opening the circuit.",
          { circuit_state: error.circuitState ?? circuit.snapshot().state },
        );
      }
      throw error;
    }

    const now = new Date().toISOString();
    const write = markPaid.run(now, order.id);
    if (write.changes !== 1) {
      throw new ApiError(409, "CONCURRENT_MODIFICATION", "Order status changed before payment could be stored.");
    }

    return {
      status: 200,
      body: {
        status: "PAID",
        order_id: order.id,
        total_amount: money(order.total_cents),
        provider_ref: charge.providerRef,
        gateway: gatewayName || "demo",
        idempotent_replay: false,
        circuit_state: circuit.snapshot().state,
        timestamp: now,
      },
    };
  }

  function listOrders(limit) {
    const size = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 8;
    return listStmt.all(size).map((row) => ({
      order_id: row.id,
      account_id: row.account_id,
      sku: row.sku,
      quantity: row.quantity,
      total_amount: money(row.total_cents),
      currency: row.currency,
      status: row.status,
      created_at: row.created_at,
    }));
  }

  return { readInventory, findReplay, placeOrder, payOrder, listOrders };
}
