import { Router } from 'express';
import { db, queries, publicUser } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getQuota } from '../services/quota.js';

export const meRouter = Router();
meRouter.use(requireAuth);

const updateName = db.prepare(`
  UPDATE users SET display_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = ?
`);

/** Everything the popup header needs in one call. */
meRouter.get('/', (req, res) => {
  res.json({ user: publicUser(req.user), quota: getQuota(req.user) });
});

meRouter.patch('/', (req, res) => {
  const displayName = String(req.body?.displayName ?? '').trim().slice(0, 60) || null;
  updateName.run(displayName, req.user.id);
  res.json({ user: publicUser(queries.userById.get(req.user.id)) });
});