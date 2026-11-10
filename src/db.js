import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  available INTEGER NOT NULL CHECK (available >= 0),
  reserved INTEGER NOT NULL CHECK (reserved >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
`;

const SEED = [
  {
    sku: "SKU-992",
    name: "Field notebook",
    available: 500,
    priceCents: 4999,
  },
  {
    sku: "SKU-100",
    name: "Brass pen",
    available: 40,
    priceCents: 1299,
  },
  {
    sku: "SKU-LOW",
    name: "Last unit sample",
    available: 1,
    priceCents: 2500,
  },
];

const ACCOUNTS = [
  { id: "ACC_99201", name: "Demo buyer", balanceCents: 500_000 },
  { id: "ACC_EMPTY", name: "Empty wallet", balanceCents: 100 },
];

export function openDatabase(dbPath) {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 3000");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM inventory").get().n;
  if (count > 0) return;

  const now = new Date().toISOString();
  const insertSku = db.prepare(`
    INSERT INTO inventory (sku, name, available, reserved, price_cents, version, updated_at)
    VALUES (?, ?, ?, 0, ?, 0, ?)
  `);
  const insertAccount = db.prepare(`
    INSERT INTO accounts (id, name, balance_cents, version)
    VALUES (?, ?, ?, 0)
  `);

  db.exec("BEGIN");
  try {
    for (const item of SEED) {
      insertSku.run(item.sku, item.name, item.available, item.priceCents, now);
    }
    for (const account of ACCOUNTS) {
      insertAccount.run(account.id, account.name, account.balanceCents);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  }
}
