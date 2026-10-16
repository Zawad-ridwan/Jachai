import { config } from '../config.js';
import { db } from '../db.js';

const today = () => new Date().toISOString().slice(0, 10);

function nextUtcMidnight() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

const getUsed = db.prepare('SELECT used FROM token_usage WHERE user_id = ? AND day = ?');
const addUsage = db.prepare(`
  INSERT INTO token_usage (user_id, day, used) VALUES (@userId, @day, @delta)
  ON CONFLICT(user_id, day) DO UPDATE SET used = MAX(0, used + @delta)
`);
const addLedger = db.prepare(
  'INSERT INTO token_ledger (user_id, task, delta) VALUES (?, ?, ?)',
);

export function limitFor(role) {
  return config.limits[role] ?? null;
}

export function getQuota(user) {
  const used = getUsed.get(user.id, today())?.used ?? 0;
  const limit = limitFor(user.role);
  return {
    used,
    limit, // null means unlimited
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsAt: nextUtcMidnight(),
  };
}

/** Check-and-charge in one transaction, so two quick requests can't both slip under the limit. */
const tryConsume = db.transaction((userId, limit, cost, task) => {
  const day = today();
  const used = getUsed.get(userId, day)?.used ?? 0;
  if (limit !== null && used + cost > limit) return false;
  addUsage.run({ userId, day, delta: cost });
  addLedger.run(userId, task, cost);
  return true;
});

const refund = db.transaction((userId, cost, task) => {
  addUsage.run({ userId, day: today(), delta: -cost });
  addLedger.run(userId, `${task}:refund`, -cost);
});

/**
 * Route middleware: charges `cost` tokens before the handler runs.
 * If the analysis then fails for any reason (an AI service is down, an image
 * can't be fetched, a check isn't set up), the tokens are refunded, so people
 * are only charged for results they actually receive.
 */
export function meter(task, cost = 1) {
  return (req, res, next) => {
    const limit = limitFor(req.user.role);
    if (!tryConsume(req.user.id, limit, cost, task)) {
      return res.status(429).json({ error: 'quota_exceeded', quota: getQuota(req.user) });
    }
    res.on('finish', () => {
      if (res.statusCode >= 400) refund(req.user.id, cost, task);
    });
    next();
  };
}