# Backend Showcase

A small API that can run locally and click through in the browser. It serves the showcase page and the endpoints behind it.

The page is not a mock. Inventory, orders, rate limits, the payment circuit, and the chart all come from this process.

## What it demonstrates

- **Idempotent orders.** `POST /v2/orders` stores the idempotency key in the same SQLite transaction as the order. The same key and body return the original order. The same key with a different body returns 409. Replays do not spend another rate-limit token.
- **Optimistic versions.** Inventory and account updates commit only when the `version` column still matches and the balance or stock can cover the write.
- **A short TTL cache.** `GET /v2/inventory/:sku` caches the row for five seconds and drops it when an order reserves that SKU. Responses include `X-Cache: HIT` or `MISS`.
- **A token bucket.** New orders are limited per client address. The default bucket holds 8 tokens and refills 2 per second.
- **A circuit breaker.** `POST /v2/payments` goes through a breaker. After the failure rate trips it, later calls return 503 without calling the gateway. A cooldown moves it to half-open.
- **Prometheus text and a server-sent event stream** at `/metrics` and `/api/stream`.

SQLite is the database on purpose. It gives this demo crash-safe commits and write-ahead logging without extra services. The version check is the piece you would keep if the tables moved to Postgres.

## Run

Node.js 22 or newer.

```bash
npm start
```

Open http://127.0.0.1:8080

```bash
npm test
```

The demo bearer token is `nxs_demo_local`. Set `API_TOKEN` if the port is reachable beyond your machine. The database file defaults to `data/showcase.db`.

Seed data:

| SKU | Stock | Price |
| --- | --- | --- |
| SKU-992 | 500 | $49.99 |
| SKU-100 | 40 | $12.99 |
| SKU-LOW | 1 | $25.00 |

Accounts: `ACC_99201` ($5,000.00) and `ACC_EMPTY` ($1.00).

## API

Authenticated routes expect `Authorization: Bearer <API_TOKEN>`.

```bash
curl -H "Authorization: Bearer nxs_demo_local" \
  http://127.0.0.1:8080/v2/inventory/SKU-992

curl -X POST http://127.0.0.1:8080/v2/orders \
  -H "Authorization: Bearer nxs_demo_local" \
  -H "Content-Type: application/json" \
  -d '{"account_id":"ACC_99201","sku":"SKU-992","quantity":1,"currency":"USD","idempotency_token":"idem_demo_0001"}'
```

| Method | Path | Role |
| --- | --- | --- |
| GET | `/health` | Process health |
| GET | `/metrics` | Prometheus text |
| GET | `/api/snapshot` | Current counters, cache, circuit |
| GET | `/api/stream` | Server-sent events for the chart and log |
| GET | `/v2/inventory/:sku` | Cached stock read |
| POST | `/v2/orders` | Reserve stock and funds |
| GET | `/v2/orders` | Recent orders |
| POST | `/v2/payments` | Capture a reserved order |
| POST | `/v2/admin/faults` | Set the gateway to `healthy` or `down`, or reset the circuit |

`POST /v2/admin/faults` is a demo control. Do not expose it on a shared network.

## Docker

```bash
docker compose up --build
```

The SQLite file lives in the `showcase-data` volume.

## Tests

`npm test` starts the server on an ephemeral port against an in-memory database and covers auth, cache invalidation, idempotency, insufficient stock and funds, the rate limit, the circuit breaker, and `/metrics`.

GitHub Actions runs the same command on Node 22.
