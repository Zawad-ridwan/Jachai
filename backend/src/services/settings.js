import { config } from '../config.js';
import { db } from '../db.js';

// Small key/value store for things the admin can change at runtime.
// Values survive restarts because they live in the database.

const getRow = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsert = db.prepare(`
  INSERT INTO settings (key, value, updated_by, updated_at)
  VALUES (@key, @value, @updatedBy, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
`);
const insertIfMissing = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

export function getSetting(key) {
  return getRow.get(key)?.value ?? null;
}

export function setSetting(key, value, updatedBy = null) {
  upsert.run({ key, value: String(value), updatedBy });
}

// ---------- Pro subscription price ----------
// Stored in poisha (100 poisha = 1 taka), the smallest unit of BDT, which is
// also what Stripe expects. The admin sets it in whole taka.

export const PRICE_MIN_TAKA = 100; // safely above Stripe's minimum charge
export const PRICE_MAX_TAKA = 100_000;
const PRO_PRICE_KEY = 'pro_price_poisha';

// First start: seed the price from PRO_PRICE_TAKA in .env (default 500).
insertIfMissing.run(PRO_PRICE_KEY, String(Math.round(config.billing.initialProPriceTaka * 100)));

export function getProPricePoisha() {
  return Number(getSetting(PRO_PRICE_KEY));
}

/** Returns an error code, or null if the price was saved. */
export function setProPriceTaka(priceTaka, adminId) {
  const n = typeof priceTaka === 'string' && priceTaka.trim() !== '' ? Number(priceTaka) : priceTaka;
  if (typeof n !== 'number' || !Number.isInteger(n)) return 'invalid_price';
  if (n < PRICE_MIN_TAKA || n > PRICE_MAX_TAKA) return 'invalid_price';
  setSetting(PRO_PRICE_KEY, n * 100, adminId);
  return null;
}
