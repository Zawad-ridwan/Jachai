// Must match a host in manifest.json "host_permissions".
export const API_BASE = 'http://localhost:4000';

export const STORAGE_KEYS = Object.freeze({
  SESSION: 'ms_session', // chrome.storage.local: { token, user, quota, updatedAt }
  RESULTS: 'ms_results', // chrome.storage.session: recent analysis results (cleared when Chrome closes)
});