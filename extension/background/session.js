import { STORAGE_KEYS } from '../shared/config.js';

// The token lives in chrome.storage.local so users stay signed in across
// browser restarts. Only the service worker ever reads it: content scripts
// (which run inside untrusted web pages) are never handed the token.

export async function getSession() {
  const { [STORAGE_KEYS.SESSION]: s } = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  return s ?? null;
}

export async function saveSession(patch) {
  const current = (await getSession()) ?? {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: next });
  return next;
}

export async function clearSession() {
  await chrome.storage.local.remove(STORAGE_KEYS.SESSION);
}

/** What the UI is allowed to see: everything except the raw token. */
export function toPublic(session) {
  if (!session?.token) return { signedIn: false };
  return { signedIn: true, user: session.user, quota: session.quota };
}