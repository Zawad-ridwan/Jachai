import { db, queries } from '../db.js';

const upgrade = db.prepare(`
  UPDATE users SET
    role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'paid' END,
    subscription_expires_at = @expiresAt,
    stripe_customer_id      = COALESCE(@stripeCustomerId, stripe_customer_id),
    stripe_subscription_id  = COALESCE(@stripeSubscriptionId, stripe_subscription_id),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = @userId
`);

const downgrade = db.prepare(`
  UPDATE users SET
    role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'regular' END,
    subscription_expires_at = NULL,
    stripe_subscription_id  = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = @userId
`);

const recordEvent = db.prepare(`
  INSERT OR IGNORE INTO billing_events (user_id, type, amount_cents, currency, external_id)
  VALUES (@userId, @type, @amountCents, @currency, @externalId)
`);

/** Grants or extends Pro. Admins keep the admin role. */
export const activatePro = db.transaction((userId, opts) => {
  upgrade.run({
    userId,
    expiresAt: opts.expiresAt,
    stripeCustomerId: opts.stripeCustomerId ?? null,
    stripeSubscriptionId: opts.stripeSubscriptionId ?? null,
  });
  recordEvent.run({
    userId,
    type: opts.type ?? 'subscribed',
    amountCents: opts.amountCents ?? 0,
    currency: opts.currency ?? 'bdt',
    externalId: opts.externalId ?? null,
  });
  return queries.userById.get(userId);
});

/** Returns the user to the free tier. */
export const deactivatePro = db.transaction((userId, opts = {}) => {
  downgrade.run({ userId });
  recordEvent.run({
    userId,
    type: opts.type ?? 'cancelled',
    amountCents: 0,
    currency: 'bdt',
    externalId: opts.externalId ?? null,
  });
  return queries.userById.get(userId);
});

/**
 * Safety net in case a cancellation webhook is missed: a Pro user whose
 * paid-through date has passed is downgraded on their next request.
 */
export function expireIfLapsed(user) {
  if (
    user.role === 'paid' &&
    user.subscription_expires_at &&
    new Date(user.subscription_expires_at).getTime() < Date.now()
  ) {
    return deactivatePro(user.id, {
      type: 'expired',
      externalId: `expired:${user.id}:${user.subscription_expires_at}`,
    });
  }
  return user;
}

export function addDays(days, from = new Date()) {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}