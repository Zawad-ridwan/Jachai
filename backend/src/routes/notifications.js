import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

// The user-facing side of the broadcast center: what the bell icon shows.
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

/** Admins see every announcement so they can check what they sent. */
function audiencesFor(role) {
  return role === 'admin' ? ['all', 'regular', 'paid'] : ['all', role];
}

notificationsRouter.get('/', (req, res) => {
  const audiences = audiencesFor(req.user.role);
  const rows = db
    .prepare(
      `SELECT b.id, b.audience, b.title, b.body, b.created_at, r.read_at
       FROM broadcasts b
       LEFT JOIN broadcast_reads r ON r.broadcast_id = b.id AND r.user_id = ?
       WHERE b.audience IN (${audiences.map(() => '?').join(', ')})
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT 50`,
    )
    .all(req.user.id, ...audiences);

  const notifications = rows.map((r) => ({
    id: r.id,
    audience: r.audience,
    title: r.title,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
  }));
  res.json({ notifications, unreadCount: notifications.filter((n) => !n.readAt).length });
});

/** Body: { all: true } or { ids: [1, 2, 3] }. Only announcements this user can see are marked. */
notificationsRouter.post('/read', (req, res) => {
  const audiences = audiencesFor(req.user.role);
  const aud = audiences.map(() => '?').join(', ');

  if (req.body?.all === true) {
    db.prepare(
      `INSERT OR IGNORE INTO broadcast_reads (user_id, broadcast_id)
       SELECT ?, id FROM broadcasts WHERE audience IN (${aud})`,
    ).run(req.user.id, ...audiences);
    return res.json({ ok: true });
  }

  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 100)
    : [];
  if (!ids.length) return res.status(400).json({ error: 'nothing_to_mark' });

  const mark = db.prepare(
    `INSERT OR IGNORE INTO broadcast_reads (user_id, broadcast_id)
     SELECT ?, id FROM broadcasts WHERE id = ? AND audience IN (${aud})`,
  );
  db.transaction(() => ids.forEach((id) => mark.run(req.user.id, id, ...audiences)))();
  res.json({ ok: true });
});