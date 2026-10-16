import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queries } from '../db.js';
import { expireIfLapsed } from '../services/subscriptions.js';

const ROLE_RANK = Object.freeze({ regular: 0, paid: 1, admin: 2 });

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), tv: user.token_version },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.jwtExpiresIn },
  );
}

/**
 * Verifies the Bearer token and loads the user fresh from the database.
 * The role is read from the database, never trusted from the token, so a
 * role change (upgrade, downgrade, admin demotion) applies immediately.
 * Bumping token_version invalidates every outstanding token for that user.
 */
export function requireAuth(req, res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'auth_required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }

  const user = queries.userById.get(Number(payload.sub));
  if (!user || user.token_version !== payload.tv) {
    return res.status(401).json({ error: 'session_revoked' });
  }

  req.user = expireIfLapsed(user);
  next();
}

/** Hierarchical guard: requireRole('paid') admits paid users and admins. */
export function requireRole(minRole) {
  if (!(minRole in ROLE_RANK)) throw new Error(`Unknown role: ${minRole}`);
  return (req, res, next) => {
    if (ROLE_RANK[req.user.role] >= ROLE_RANK[minRole]) return next();
    return res.status(403).json({ error: 'forbidden', requiredRole: minRole });
  };
}