import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
 INSERT OR IGNORE INTO schema_migrations VALUES(1, CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, terms_version TEXT NOT NULL, ai_consent TEXT);
 CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, sent INTEGER NOT NULL, attempts INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY, started INTEGER NOT NULL, count INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ideas(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
 CREATE INDEX IF NOT EXISTS ideas_user ON ideas(user_id, updated_at);
 CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE, version INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mutations(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE, response TEXT NOT NULL, PRIMARY KEY(user_id,key));
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS periods(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, starts TEXT NOT NULL, ends TEXT NOT NULL, plan TEXT NOT NULL, total INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, period_id TEXT NOT NULL REFERENCES periods(id), request_id TEXT, kind TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(request_id,kind));
 CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE, data TEXT NOT NULL, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL, period_id TEXT NOT NULL REFERENCES periods(id), state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS one_running_request ON requests(user_id) WHERE state IN ('running','reserved');
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 `);
  // Additive migration: existing ideas, free periods and ledger entries remain intact.
  db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS payment_plans(version TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS payment_orders(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_key TEXT NOT NULL,
 plan_version TEXT NOT NULL REFERENCES payment_plans(version), amount INTEGER NOT NULL CHECK(amount>0), currency TEXT NOT NULL DEFAULT 'CNY',
 channel TEXT NOT NULL, status TEXT NOT NULL, entitlement TEXT NOT NULL DEFAULT 'pending',
 transaction_id TEXT UNIQUE, payment_url TEXT, url_created_at TEXT, parent_order_id TEXT,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, paid_at TEXT, last_checked_at TEXT,
 next_check_at TEXT NOT NULL, check_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 refund_no TEXT UNIQUE, refund_reason TEXT, refund_status TEXT, support_reason TEXT,
 UNIQUE(user_id,client_key));
 CREATE UNIQUE INDEX IF NOT EXISTS one_pending_payment ON payment_orders(user_id) WHERE status IN ('creating','pending','unknown');
 CREATE INDEX IF NOT EXISTS payment_reconcile ON payment_orders(next_check_at);
 CREATE TABLE IF NOT EXISTS subscriptions(
 order_id TEXT PRIMARY KEY REFERENCES payment_orders(id), user_id TEXT NOT NULL REFERENCES users(id),
 period_id TEXT NOT NULL UNIQUE REFERENCES periods(id), anchor TEXT NOT NULL, month_index INTEGER NOT NULL,
 starts TEXT NOT NULL, ends TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
 CREATE INDEX IF NOT EXISTS subscription_user_period ON subscriptions(user_id,starts,ends);
 CREATE TABLE IF NOT EXISTS payment_events(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES payment_orders(id), kind TEXT NOT NULL, body_hash TEXT NOT NULL, created_at TEXT NOT NULL);
 INSERT OR IGNORE INTO schema_migrations VALUES(2,CURRENT_TIMESTAMP);
 COMMIT;`);
  db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS password_credentials(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, password_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
 INSERT OR IGNORE INTO schema_migrations VALUES(3,CURRENT_TIMESTAMP);
 COMMIT;`);
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
export function transaction<T>(db: DB, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
