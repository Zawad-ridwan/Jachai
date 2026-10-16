import crypto from 'node:crypto';
import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { db, queries, publicUser } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { activatePro, deactivatePro, addDays } from '../services/subscriptions.js';
import { getProPricePoisha } from '../services/settings.js';

export const billingRouter = Router();

const { mode, currency } = config.billing;
const stripe = mode === 'stripe' ? new Stripe(config.billing.stripeSecretKey) : null;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** "৳500" or "৳1,249.50": amounts are in the currency's smallest unit (poisha for BDT). */
const money = (minor, cur = currency) => {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(cur.toLowerCase() === 'bdt' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: cur.toUpperCase(),
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
};

// ---------- Plans (public) ----------

billingRouter.get('/plans', (_req, res) => {
  res.json({
    mode,
    currency,
    plans: [
      {
        id: 'regular', name: 'Regular', priceCents: 0, interval: 'month',
        dailyTokens: config.limits.regular,
        features: ['AI text detection', 'Toxicity filter', 'Dark pattern scanner', 'Jargon simplifier (on-device)'],
      },
      {
        id: 'pro', name: 'Pro', priceCents: getProPricePoisha(), interval: 'month', // price set by the admin
        dailyTokens: config.limits.paid,
        features: ['Everything in Regular', 'Emotion analysis', 'Fake news detection', 'Media analysis', 'Invoices & billing history'],
      },
    ],
  });
});

// ---------- Checkout ----------

billingRouter.post('/checkout', requireAuth, async (req, res, next) => {
  if (req.user.role !== 'regular') {
    return res.status(409).json({ error: 'already_subscribed' });
  }

  if (mode === 'mock') {
    const user = activatePro(req.user.id, {
      expiresAt: addDays(30),
      amountCents: getProPricePoisha(),
      currency,
      externalId: `mock_${crypto.randomUUID()}`,
    });
    return res.json({ mode, user: publicUser(user) });
  }

  try {
    // Stripe TEST mode: the buyer pays with a test card, no real money moves.
    // The price is built here from the admin-set value (in poisha), so changing
    // the price in the admin portal needs nothing set up in Stripe.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: getProPricePoisha(),
          recurring: { interval: 'month' },
          product_data: { name: 'Jachai Pro', description: 'Pro plan, billed monthly' },
        },
      }],
      client_reference_id: String(req.user.id),
      ...(req.user.stripe_customer_id
        ? { customer: req.user.stripe_customer_id }
        : { customer_email: req.user.email }),
      metadata: { userId: String(req.user.id) },
      subscription_data: { metadata: { userId: String(req.user.id) } },
      // {CHECKOUT_SESSION_ID} is filled in by Stripe, so /return can confirm the payment itself.
      success_url: `${config.publicUrl}/billing/return?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicUrl}/billing/return?status=cancelled`,
    });
    res.json({ mode, url: session.url });
  } catch (err) {
    if (err?.type?.startsWith?.('Stripe')) {
      // e.g. a rejected key, or a currency/amount the Stripe account can't charge.
      console.error(`[stripe] checkout failed (${err.type}): ${err.message}`);
      const code = err.type === 'StripeAuthenticationError' ? 'stripe_auth' : 'stripe_checkout_failed';
      return res.status(502).json({ error: code });
    }
    next(err);
  }
});

const RETURN_PAGES = {
  paid: ['Payment successful', 'You\u2019re now on Jachai Pro. You can close this tab and reopen Jachai.'],
  processing: ['Payment processing', 'Stripe is still confirming your payment. Reopen Jachai in a minute; Pro turns on as soon as it\u2019s confirmed.'],
  cancelled: ['Payment cancelled', 'You were not charged. You can close this tab.'],
  unknown: ['Couldn\u2019t confirm the payment', 'We couldn\u2019t check this payment with Stripe. If you paid, reopen Jachai in a minute. You can close this tab.'],
};

function returnPage(res, kind) {
  const [title, body] = RETURN_PAGES[kind];
  const tone = kind === 'paid' ? '#1d9e6c' : kind === 'cancelled' ? '#5b6478' : '#a06f00';
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Jachai: ${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f7fb;color:#1a1f2e}
main{text-align:center;max-width:440px;padding:32px}h1{color:${tone}}</style>
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main>`);
}

/**
 * Stripe sends the buyer's browser tab here after checkout. For a successful
 * checkout we ask Stripe directly whether it was paid, and turn on Pro if so,
 * so no webhook (and no Stripe CLI) is needed when running locally.
 */
billingRouter.get('/return', async (req, res) => {
  if (req.query.status !== 'success') return returnPage(res, 'cancelled');
  const sessionId = String(req.query.session_id ?? '');
  if (mode !== 'stripe' || !/^cs_(test_)?[A-Za-z0-9]+$/.test(sessionId)) return returnPage(res, 'unknown');
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'complete' && session.payment_status === 'paid') {
      await fulfilCheckout(session);
      return returnPage(res, 'paid');
    }
    return returnPage(res, session.status === 'expired' ? 'cancelled' : 'processing');
  } catch (err) {
    console.error('[stripe] could not confirm checkout', sessionId, err?.message);
    return returnPage(res, 'unknown');
  }
});

// ---------- Cancel ----------

billingRouter.post('/cancel', requireAuth, requireRole('paid'), async (req, res, next) => {
  if (req.user.role === 'admin') {
    return res.status(400).json({ error: 'admin_has_no_subscription' });
  }
  if (mode === 'mock') {
    const user = deactivatePro(req.user.id, { externalId: `mock_cancel_${crypto.randomUUID()}` });
    return res.json({ user: publicUser(user), cancelAtPeriodEnd: false });
  }
  try {
    // Access continues until the paid period ends; Stripe then sends
    // customer.subscription.deleted and the webhook downgrades the user.
    await stripe.subscriptions.update(req.user.stripe_subscription_id, { cancel_at_period_end: true });
    res.json({ user: publicUser(req.user), cancelAtPeriodEnd: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Invoices ----------

const listDemoInvoices = db.prepare(`
  SELECT id, type, amount_cents, currency, created_at FROM billing_events
  WHERE user_id = ? AND amount_cents > 0 ORDER BY created_at DESC LIMIT 24
`);
const getDemoInvoice = db.prepare(
  'SELECT * FROM billing_events WHERE id = ? AND user_id = ? AND amount_cents > 0',
);

billingRouter.get('/invoices', requireAuth, async (req, res, next) => {
  try {
    if (mode === 'stripe' && req.user.stripe_customer_id) {
      const { data } = await stripe.invoices.list({ customer: req.user.stripe_customer_id, limit: 24 });
      return res.json({
        invoices: data.map((inv) => ({
          id: inv.id,
          number: inv.number,
          amountCents: inv.amount_paid,
          currency: inv.currency,
          status: inv.status,
          createdAt: new Date(inv.created * 1000).toISOString(),
          downloadUrl: inv.invoice_pdf, // public Stripe-hosted PDF
        })),
      });
    }
    res.json({
      invoices: listDemoInvoices.all(req.user.id).map((e) => ({
        id: String(e.id),
        number: `MS-DEMO-${String(e.id).padStart(5, '0')}`,
        amountCents: e.amount_cents,
        currency: e.currency,
        status: 'paid',
        createdAt: e.created_at,
        downloadUrl: `/billing/invoices/${e.id}/download`, // needs the auth header
      })),
    });
  } catch (err) {
    next(err);
  }
});

billingRouter.get('/invoices/:id/download', requireAuth, (req, res) => {
  const e = getDemoInvoice.get(Number(req.params.id), req.user.id);
  if (!e) return res.status(404).json({ error: 'not_found' });

  const number = `MS-DEMO-${String(e.id).padStart(5, '0')}`;
  res
    .type('html')
    .set('Content-Disposition', `attachment; filename="${number}.html"`)
    .send(`<!doctype html><meta charset="utf-8"><title>Invoice ${number}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;color:#1a1f2e}
table{width:100%;border-collapse:collapse;margin-top:24px}td,th{padding:10px;border-bottom:1px solid #dde2ec;text-align:left}
.demo{background:#fff4d6;padding:8px 12px;border-radius:6px}</style>
<p class="demo">DEMO INVOICE. No real payment was taken.</p>
<h1>Jachai</h1>
<p><strong>Invoice</strong> ${number}<br><strong>Date</strong> ${escapeHtml(e.created_at.slice(0, 10))}<br>
<strong>Billed to</strong> ${escapeHtml(req.user.email)}</p>
<table><tr><th>Description</th><th>Amount</th></tr>
<tr><td>Jachai Pro, 1 month (${escapeHtml(e.type)})</td><td>${money(e.amount_cents, e.currency)}</td></tr>
<tr><th>Total paid</th><th>${money(e.amount_cents, e.currency)}</th></tr></table>`);
});

// ---------- Stripe webhook (mounted in server.js with a raw body parser) ----------

const alreadyProcessed = db.prepare('SELECT 1 FROM processed_webhooks WHERE event_id = ?');
const markProcessed = db.prepare('INSERT OR IGNORE INTO processed_webhooks (event_id) VALUES (?)');

/**
 * Turns on Pro for a paid checkout. Called from the return page and from the
 * webhook; the billing record uses the checkout session id, which is unique,
 * so if both run for the same payment it is still only counted once.
 */
async function fulfilCheckout(session) {
  const userId = Number(session.client_reference_id);
  if (!userId || !session.subscription) return;
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const sub = await stripe.subscriptions.retrieve(subId);
  activatePro(userId, {
    expiresAt: periodEndIso(sub),
    amountCents: session.amount_total ?? 0, // what Stripe actually charged, in poisha
    currency: session.currency ?? currency,
    externalId: session.id,
    stripeCustomerId: customerId ?? null,
    stripeSubscriptionId: subId,
  });
}

/** Newer Stripe API versions moved current_period_end onto subscription items. */
function periodEndIso(sub) {
  const ts = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : addDays(30);
}

export async function stripeWebhook(req, res) {
  if (mode !== 'stripe') return res.status(404).end();
  if (!config.billing.webhookSecret) return res.status(503).json({ error: 'webhook_not_configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.billing.webhookSecret);
  } catch {
    return res.status(400).json({ error: 'invalid_signature' });
  }
  if (alreadyProcessed.get(event.id)) return res.json({ received: true, duplicate: true });

  try {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.payment_status === 'paid') await fulfilCheckout(obj);
        break;
      }
      case 'invoice.paid': {
        if (obj.billing_reason === 'subscription_create') break; // counted by checkout
        const user = queries.userByStripeCustomer.get(obj.customer);
        const periodEnd = obj.lines?.data?.[0]?.period?.end;
        if (!user || !periodEnd) break;
        activatePro(user.id, {
          type: 'renewed',
          expiresAt: new Date(periodEnd * 1000).toISOString(),
          amountCents: obj.amount_paid,
          currency: obj.currency,
          externalId: obj.id,
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const user = queries.userByStripeSubscription.get(obj.id);
        if (user) deactivatePro(user.id, { type: 'cancelled', externalId: event.id });
        break;
      }
      default:
        break; // ignore events we don't use
    }
    markProcessed.run(event.id);
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook]', event.type, err);
    res.status(500).json({ error: 'webhook_failed' }); // Stripe will retry
  }
}