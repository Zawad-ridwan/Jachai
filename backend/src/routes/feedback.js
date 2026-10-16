import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

// Regular and Pro users send feedback to the admin: what works, what doesn't
// and how to fix it, or which features they'd like. The admin reads it in the
// admin portal (GET /admin/feedback).
export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

export const FEEDBACK_MIN = 10;
export const FEEDBACK_MAX = 2000;

// At most 5 messages per person per hour, so the inbox can't be flooded.
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `feedback:${req.user.id}`,
  skipFailedRequests: true, // a rejected (e.g. too short) message doesn't count
  message: { error: 'too_many_feedback' },
});

const insertFeedback = db.prepare('INSERT INTO feedback (user_id, user_role, message) VALUES (?, ?, ?)');
const getCreatedAt = db.prepare('SELECT created_at FROM feedback WHERE id = ?');

/** The admin receives feedback; they don't send it. Checked before the rate limit so it doesn't use up a slot. */
function usersOnly(req, res, next) {
  if (!['regular', 'paid'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
  next();
}

feedbackRouter.post('/', usersOnly, feedbackLimiter, (req, res) => {
  const message = typeof req.body?.message === 'string'
    ? req.body.message.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
    : '';
  const length = [...message].length;
  if (length < FEEDBACK_MIN || length > FEEDBACK_MAX) {
    return res.status(400).json({ error: 'invalid_feedback', field: 'message', min: FEEDBACK_MIN, max: FEEDBACK_MAX });
  }
  const { lastInsertRowid } = insertFeedback.run(req.user.id, req.user.role, message);
  const id = Number(lastInsertRowid);
  res.status(201).json({ id, createdAt: getCreatedAt.get(id).created_at });
});
