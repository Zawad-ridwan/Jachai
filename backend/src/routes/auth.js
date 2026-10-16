import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, queries, publicUser } from '../db.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { getQuota } from '../services/quota.js';
import { passwordProblems } from '../services/password.js';

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Compared against when an email doesn't exist, so response time doesn't
// reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', BCRYPT_ROUNDS);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

const insertUser = db.prepare(
  'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
);
const updatePassword = db.prepare(`
  UPDATE users SET password_hash = ?, token_version = token_version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);
const bumpTokenVersion = db.prepare(
  'UPDATE users SET token_version = token_version + 1 WHERE id = ?',
);


function sessionPayload(user) {
  return { token: signToken(user), user: publicUser(user), quota: getQuota(user) };
}

authRouter.post('/signup', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = req.body?.password;
    const displayName = String(req.body?.displayName ?? '').trim().slice(0, 60) || null;

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'invalid_email', field: 'email' });
    }
    const problems = passwordProblems(password);
    if (problems.length) {
      return res.status(400).json({ error: 'weak_password', field: 'password', failed: problems });
    }
    if (queries.userByEmail.get(email)) {
      return res.status(409).json({ error: 'email_taken', field: 'email' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { lastInsertRowid } = insertUser.run(email, hash, displayName);
    res.status(201).json(sessionPayload(queries.userById.get(lastInsertRowid)));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const user = queries.userByEmail.get(email);

    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    res.json(sessionPayload(user));
  } catch (err) {
    next(err);
  }
});

/** Changing the password signs out every other device. */
authRouter.post('/change-password', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!(await bcrypt.compare(String(currentPassword ?? ''), req.user.password_hash))) {
      return res.status(401).json({ error: 'invalid_credentials', field: 'currentPassword' });
    }
    const problems = passwordProblems(newPassword);
    if (problems.length) {
      return res.status(400).json({ error: 'weak_password', field: 'newPassword', failed: problems });
    }
    updatePassword.run(await bcrypt.hash(newPassword, BCRYPT_ROUNDS), req.user.id);
    res.json(sessionPayload(queries.userById.get(req.user.id)));
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout-all', requireAuth, (req, res) => {
  bumpTokenVersion.run(req.user.id);
  res.status(204).end();
});