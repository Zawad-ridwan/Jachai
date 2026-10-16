import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { db, queries, publicUser } from '../db.js';
import { activatePro, deactivatePro, addDays } from '../services/subscriptions.js';
import { getProPricePoisha, setProPriceTaka, PRICE_MIN_TAKA, PRICE_MAX_TAKA } from '../services/settings.js';

// Mounted behind requireAuth + requireRole('admin') in server.js,
// so every handler here can assume req.user is an admin.
export const adminRouter = Router();

const ROLES = ['regular', 'paid', 'admin'];
const AUDIENCES = ['all', 'regular', 'paid'];
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

// ======================================================================
// Overview
// ======================================================================

const countByRole = db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role');

function roleCounts() {
  const counts = { regular: 0, paid: 0, admin: 0 };
  for (const { role, n } of countByRole.all()) counts[role] = n;
  return { counts, total: counts.regular + counts.paid + counts.admin };
}

adminRouter.get('/stats', (_req, res) => {
  const { counts, total } = roleCounts();
  res.json({ counts, total, mrrCents: counts.paid * getProPricePoisha() });
});

// ======================================================================
// User directory & CRUD
// ======================================================================

adminRouter.get('/users', (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : null;
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const where = [];
  const filter = {};
  if (role) {
    where.push('u.role = @role');
    filter.role = role;
  }
  if (q) {
    // Escape LIKE wildcards so searching for "50%" or "a_b" matches literally.
    where.push("(u.email LIKE @q ESCAPE '\\' OR u.display_name LIKE @q ESCAPE '\\')");
    filter.q = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).get(filter).n;
  const rows = db
    .prepare(
      `SELECT u.*, COALESCE(t.used, 0) AS used_today
       FROM users u
       LEFT JOIN token_usage t ON t.user_id = u.id AND t.day = @day
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...filter, day: today(), limit: pageSize, offset: (page - 1) * pageSize });

  res.json({
    users: rows.map((u) => ({ ...publicUser(u), usedToday: u.used_today })),
    total,
    page,
    pageSize,
  });
});

const setRole = db.prepare(`
  UPDATE users SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
`);
const setName = db.prepare(`
  UPDATE users SET display_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
`);
const deleteUser = db.prepare('DELETE FROM users WHERE id = ?');

/** Changing a paying Stripe customer's access here would leave Stripe still billing them. */
function hasLiveStripeSubscription(user) {
  return config.billing.mode === 'stripe' && Boolean(user.stripe_subscription_id);
}

const applyRole = db.transaction((target, role) => {
  if (role === 'paid') {
    // Admin-granted ("complimentary") Pro: 30 days, recorded at 0 taka.
    setRole.run('regular', target.id); // so activatePro's admin-preserving rule doesn't block it
    activatePro(target.id, {
      expiresAt: addDays(30),
      amountCents: 0,
      externalId: `comp_${crypto.randomUUID()}`,
      type: target.role === 'regular' ? 'subscribed' : 'renewed',
    });
  } else if (role === 'regular' && target.role === 'paid') {
    deactivatePro(target.id, { type: 'cancelled', externalId: `admin_${crypto.randomUUID()}` });
  } else {
    setRole.run(role, target.id);
  }
});

adminRouter.patch('/users/:id', (req, res) => {
  const target = queries.userById.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'not_found' });

  const { role, displayName } = req.body ?? {};

  if (role !== undefined && role !== target.role) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'cannot_demote_self' });
    if (target.role === 'paid' && hasLiveStripeSubscription(target)) {
      return res.status(409).json({ error: 'has_active_stripe_subscription' });
    }
    applyRole(target, role);
  }

  if (displayName !== undefined) {
    setName.run(String(displayName).trim().slice(0, 60) || null, target.id);
  }

  res.json({ user: publicUser(queries.userById.get(target.id)) });
});

adminRouter.delete('/users/:id', (req, res) => {
  const target = queries.userById.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  if (hasLiveStripeSubscription(target)) {
    return res.status(409).json({ error: 'has_active_stripe_subscription' });
  }
  // Billing events keep their rows (user_id becomes NULL) so revenue history stays accurate.
  deleteUser.run(target.id);
  res.status(204).end();
});

const clearTodayUsage = db.prepare('DELETE FROM token_usage WHERE user_id = ? AND day = ?');
const ledgerNote = db.prepare('INSERT INTO token_ledger (user_id, task, delta) VALUES (?, ?, ?)');
const usedToday = db.prepare('SELECT used FROM token_usage WHERE user_id = ? AND day = ?');

adminRouter.post('/users/:id/reset-quota', (req, res) => {
  const target = queries.userById.get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'not_found' });
  const day = today();
  const used = usedToday.get(target.id, day)?.used ?? 0;
  db.transaction(() => {
    clearTodayUsage.run(target.id, day);
    if (used > 0) ledgerNote.run(target.id, 'admin_reset', -used);
  })();
  res.json({ ok: true });
});

// ======================================================================
// Finance & churn calendar
// ======================================================================

const eventsBetween = db.prepare(`
  SELECT substr(created_at, 1, 10) AS day, type, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
  FROM billing_events
  WHERE created_at >= ? AND created_at < ?
  GROUP BY day, type
`);
const subChangesSince = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type = 'subscribed' THEN 1 ELSE 0 END), 0) AS gained,
    COALESCE(SUM(CASE WHEN type IN ('cancelled', 'expired') THEN 1 ELSE 0 END), 0) AS lost
  FROM billing_events WHERE created_at >= ?
`);

adminRouter.get('/finance', (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month))
    ? String(req.query.month)
    : nowIso().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const days = Array.from({ length: daysInMonth }, (_, i) => ({
    date: `${month}-${String(i + 1).padStart(2, '0')}`,
    gained: 0,
    lost: 0,
    revenueCents: 0,
  }));
  const totals = { gained: 0, lost: 0, revenueCents: 0 };

  for (const row of eventsBetween.all(start, end)) {
    const d = days[Number(row.day.slice(8)) - 1];
    if (!d) continue;
    if (row.type === 'subscribed') d.gained += row.n;
    if (row.type === 'cancelled' || row.type === 'expired') d.lost += row.n;
    d.revenueCents += row.cents;
  }
  for (const d of days) {
    totals.gained += d.gained;
    totals.lost += d.lost;
    totals.revenueCents += d.revenueCents;
  }

  // Reconstruct how many Pro subscribers there were at the start of the month
  // by rewinding today's count through every change since then.
  const price = getProPricePoisha();
  const paidNow = roleCounts().counts.paid;
  const since = subChangesSince.get(start);
  const subsAtStart = Math.max(0, paidNow - since.gained + since.lost);
  const subsAtEnd = Math.max(0, subsAtStart + totals.gained - totals.lost);

  res.json({
    month,
    days,
    totals,
    mrrCents: paidNow * price,
    mrrEndCents: subsAtEnd * price,
    subscribersAtStart: subsAtStart,
    subscribersAtEnd: subsAtEnd,
    churnRate: subsAtStart > 0 ? totals.lost / subsAtStart : 0,
  });
});

// ======================================================================
// Broadcast center
// ======================================================================

const insertBroadcast = db.prepare(
  'INSERT INTO broadcasts (audience, title, body, created_by) VALUES (?, ?, ?, ?)',
);
const listBroadcasts = db.prepare(`
  SELECT b.*, u.email AS author,
    (SELECT COUNT(*) FROM broadcast_reads r WHERE r.broadcast_id = b.id) AS reads
  FROM broadcasts b
  LEFT JOIN users u ON u.id = b.created_by
  ORDER BY b.created_at DESC, b.id DESC
  LIMIT 100
`);
const deleteBroadcast = db.prepare('DELETE FROM broadcasts WHERE id = ?');

const toBroadcast = (b) => ({
  id: b.id,
  audience: b.audience,
  title: b.title,
  body: b.body,
  author: b.author ?? null,
  reads: b.reads ?? 0,
  createdAt: b.created_at,
});

adminRouter.get('/broadcasts', (_req, res) => {
  res.json({ broadcasts: listBroadcasts.all().map(toBroadcast) });
});

adminRouter.post('/broadcasts', (req, res) => {
  const audience = String(req.body?.audience ?? '');
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();

  if (!AUDIENCES.includes(audience)) return res.status(400).json({ error: 'invalid_audience', field: 'audience' });
  if (!title || title.length > 120) return res.status(400).json({ error: 'invalid_title', field: 'title' });
  if (!body || body.length > 2000) return res.status(400).json({ error: 'invalid_body', field: 'body' });

  const { lastInsertRowid } = insertBroadcast.run(audience, title, body, req.user.id);
  res.status(201).json({ id: Number(lastInsertRowid) });
});

adminRouter.delete('/broadcasts/:id', (req, res) => {
  const { changes } = deleteBroadcast.run(Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

// ======================================================================
// Feedback inbox (sent by Regular and Pro users from the popup)
// ======================================================================

const FEEDBACK_TYPES = { all: null, paid: 'paid', regular: 'regular' };
const FEEDBACK_PAGE_SIZE = 20;

const feedbackCounts = db.prepare('SELECT user_role, COUNT(*) AS n FROM feedback GROUP BY user_role');
const listFeedback = db.prepare(`
  SELECT f.id, f.message, f.user_role, f.created_at, u.id AS user_id, u.email, u.display_name
  FROM feedback f JOIN users u ON u.id = f.user_id
  WHERE (@role IS NULL OR f.user_role = @role)
  ORDER BY f.created_at DESC, f.id DESC
  LIMIT @limit OFFSET @offset
`);

adminRouter.get('/feedback', (req, res) => {
  const type = String(req.query.type ?? 'all');
  if (!Object.hasOwn(FEEDBACK_TYPES, type)) return res.status(400).json({ error: 'invalid_feedback_type' });
  const role = FEEDBACK_TYPES[type];

  const counts = { all: 0, paid: 0, regular: 0 };
  for (const { user_role, n } of feedbackCounts.all()) {
    counts[user_role] = n;
    counts.all += n;
  }
  const total = role ? counts[role] : counts.all;
  const pages = Math.max(1, Math.ceil(total / FEEDBACK_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));

  const items = listFeedback.all({ role, limit: FEEDBACK_PAGE_SIZE, offset: (page - 1) * FEEDBACK_PAGE_SIZE }).map((f) => ({
    id: f.id,
    message: f.message,
    userRole: f.user_role, // the sender's tier when they sent it
    createdAt: f.created_at,
    user: { id: f.user_id, displayName: f.display_name, email: f.email },
  }));
  res.json({ items, total, page, pageSize: FEEDBACK_PAGE_SIZE, counts });
});

// ======================================================================
// Settings: Pro subscription price
// ======================================================================

const priceInfo = () => ({
  proPriceTaka: getProPricePoisha() / 100,
  currency: config.billing.currency,
  minTaka: PRICE_MIN_TAKA,
  maxTaka: PRICE_MAX_TAKA,
});

adminRouter.get('/settings', (_req, res) => {
  res.json(priceInfo());
});

/** New price applies to new upgrades only; current Pro users keep their paid period. */
adminRouter.patch('/settings/pro-price', (req, res) => {
  const error = setProPriceTaka(req.body?.priceTaka, req.user.id);
  if (error) return res.status(400).json({ error, field: 'priceTaka', minTaka: PRICE_MIN_TAKA, maxTaka: PRICE_MAX_TAKA });
  console.log(`[admin] ${req.user.email} set the Pro price to BDT ${getProPricePoisha() / 100}/month`);
  res.json(priceInfo());
});