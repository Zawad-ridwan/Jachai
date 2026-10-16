import { apiFetch, ApiError } from '../shared/api.js';
import { getSession, saveSession, clearSession, toPublic } from './session.js';

/** Unread count on the toolbar icon (no extra permission needed). */
export async function setBadge(count) {
  await chrome.action.setBadgeText({ text: count > 0 ? (count > 9 ? '9+' : String(count)) : '' });
  if (count > 0) await chrome.action.setBadgeBackgroundColor({ color: '#c62f3a' });
}

/** Authenticated API call. A 401 means the session is dead everywhere: sign out locally. */
export async function authed(path, opts = {}) {
  const session = await getSession();
  if (!session?.token) throw new ApiError(401, 'auth_required', null);
  try {
    return await apiFetch(path, { ...opts, token: session.token });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await clearSession();
      await setBadge(0);
    }
    throw err;
  }
}

export async function refreshSession() {
  const session = await getSession();
  if (!session?.token) return toPublic(null);
  const { user, quota } = await authed('/me');
  return toPublic(await saveSession({ user, quota }));
}