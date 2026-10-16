import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import './db.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { billingRouter, stripeWebhook } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';
import { analyzeRouter } from './routes/analyze.js';
import { notificationsRouter } from './routes/notifications.js';
import { feedbackRouter } from './routes/feedback.js';
import { providerStatus } from './services/analysis.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // correct client IPs for rate limiting behind a host's proxy
app.use(helmet());

// Only the Jachai extension may call the API from a browser.
app.use(cors({
  origin(origin, cb) {
    cb(null, !origin || (config.extensionOrigin && origin === config.extensionOrigin));
  },
}));

// Stripe signs the raw bytes, so the webhook must be registered before express.json().
app.post('/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
// Image analysis can carry up to ~4 MB of image data; everything else stays small.
app.use('/analyze', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '100kb' }));

// Shows which AI services have keys configured (true/false only, never the keys).
app.get('/health', (_req, res) =>
  res.json({ ok: true, billingMode: config.billing.mode, aiServices: providerStatus(), geminiModel: config.providers.geminiModel }),
);
app.use('/auth', authRouter);
app.use('/me', meRouter);
app.use('/billing', billingRouter);
app.use('/admin', requireAuth, requireRole('admin'), adminRouter);
app.use('/analyze', analyzeRouter);
app.use('/notifications', notificationsRouter);
app.use('/feedback', feedbackRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// Never leak stack traces or internal messages to the client.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'image_too_large' });
  res.status(500).json({ error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`Jachai API on ${config.publicUrl} (billing: ${config.billing.mode})`);
  const ai = providerStatus();
  const missing = Object.entries(ai).filter(([, ok]) => !ok).map(([name]) => name);
  console.log(missing.length ? `AI services without keys (those checks stay off): ${missing.join(', ')}` : 'All AI services configured.');
});