import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const optional = (name) => process.env[name]?.trim() || null;

const billingMode = (process.env.BILLING_MODE || 'mock').toLowerCase();
if (!['mock', 'stripe'].includes(billingMode)) {
  throw new Error('BILLING_MODE must be "mock" or "stripe"');
}

// Payments are simulated with Stripe's TEST mode only: a live key could charge real cards.
function stripeTestKey() {
  const key = required('STRIPE_SECRET_KEY').trim();
  if (/^(sk|rk)_live_/.test(key)) {
    throw new Error('STRIPE_SECRET_KEY is a LIVE key. Jachai only simulates payments, so use your TEST key (it starts with sk_test_).');
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error('STRIPE_SECRET_KEY should be your Stripe TEST secret key, which starts with sk_test_ (Stripe Dashboard > Developers > API keys, with "Test mode" on).');
  }
  return key;
}

export const config = Object.freeze({
  port: Number(process.env.PORT || 4000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:4000').replace(/\/$/, ''),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  dbPath: process.env.DB_PATH || './data/multishield.db',
  extensionOrigin: process.env.EXTENSION_ORIGIN || '',
  billing: Object.freeze({
    mode: billingMode,
    stripeSecretKey: billingMode === 'stripe' ? stripeTestKey() : null,
    // Optional: only needed if you also run "stripe listen" to forward webhooks.
    // Payments are confirmed without it when Stripe sends the buyer back.
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET'),
    // The price comes from the admin-set value in the database, so no Stripe Price ID is needed.
    currency: 'bdt',
    // Only the starting value: the first time the server runs it is copied into
    // the database, and from then on the admin changes it in the admin portal.
    initialProPriceTaka: Number(process.env.PRO_PRICE_TAKA || 500),
  }),
  // null = unlimited
  limits: Object.freeze({
    regular: Number(process.env.DAILY_LIMIT_REGULAR || 50),
    paid: Number(process.env.DAILY_LIMIT_PAID || 1000),
    admin: null,
  }),
  // AI service keys. These stay on the server and are never sent to the extension.
  providers: Object.freeze({
    saplingKey: optional('SAPLING_API_KEY'),
    openaiKey: optional('OPENAI_API_KEY'),
    geminiKey: optional('GEMINI_API_KEY'),
    geminiModel: optional('GEMINI_MODEL') || 'gemini-3.8-flash',
    geminiFallbackModels: (optional('GEMINI_FALLBACK_MODELS') ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    factCheckKey: optional('FACTCHECK_API_KEY'),
  }),
});

if (config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}