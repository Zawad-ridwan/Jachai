import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    email                   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash           TEXT NOT NULL,
    display_name            TEXT,
    role                    TEXT NOT NULL DEFAULT 'regular'
                            CHECK (role IN ('regular', 'paid', 'admin')),
    token_version           INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    subscription_expires_at TEXT,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- One row per user per UTC day: fast quota checks.
  CREATE TABLE IF NOT EXISTS token_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    used    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  -- Append-only audit trail of every charge and refund.
  CREATE TABLE IF NOT EXISTS token_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task       TEXT NOT NULL,
    delta      INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Feeds the Phase 3 MRR / gained / churned calendar.
  -- amount_cents holds the amount in the smallest unit of \`currency\`
  -- (poisha for BDT: 100 poisha = 1 taka). The name is kept from the USD days.
  CREATE TABLE IF NOT EXISTS billing_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type         TEXT NOT NULL CHECK (type IN ('subscribed', 'renewed', 'cancelled', 'expired')),
    amount_cents INTEGER NOT NULL DEFAULT 0,
    currency     TEXT NOT NULL DEFAULT 'bdt',
    external_id  TEXT UNIQUE,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Stripe can deliver the same webhook more than once.
  CREATE TABLE IF NOT EXISTS processed_webhooks (
    event_id     TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Used from Phase 3 onward.
  CREATE TABLE IF NOT EXISTS broadcasts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audience   TEXT NOT NULL CHECK (audience IN ('all', 'regular', 'paid')),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS broadcast_reads (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    read_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, broadcast_id)
  );

  -- Values the admin can change from the admin portal (e.g. the Pro price).
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  -- Feedback from Regular and Pro users, read by the admin in the admin portal.
  -- user_role is the sender's tier at the moment they sent it ('regular' or 'paid').
  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_role  TEXT NOT NULL CHECK (user_role IN ('regular', 'paid')),
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_role    ON feedback(user_role, created_at);

  CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
  CREATE INDEX IF NOT EXISTS idx_users_stripe_cust ON users(stripe_customer_id);
  CREATE INDEX IF NOT EXISTS idx_users_stripe_sub  ON users(stripe_subscription_id);
  CREATE INDEX IF NOT EXISTS idx_billing_created   ON billing_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_ledger_user       ON token_ledger(user_id, created_at);
`);

export const queries = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userByStripeCustomer: db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?'),
  userByStripeSubscription: db.prepare('SELECT * FROM users WHERE stripe_subscription_id = ?'),
};

/** The only shape of a user ever sent to the client. */
export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    isPro: u.role === 'paid' || u.role === 'admin',
    subscriptionExpiresAt: u.subscription_expires_at,
    createdAt: u.created_at,
  };
}