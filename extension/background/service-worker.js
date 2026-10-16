import { apiFetch, ApiError } from '../shared/api.js';
import { API_BASE } from '../shared/config.js';
import { MSG } from '../shared/messages.js';
import { getSession, saveSession, clearSession, toPublic } from './session.js';
import { authed, refreshSession, setBadge } from './api-client.js';
import { clearResults } from './results.js';
import { analyzeText, analyzeImage, analyzeUpload, analyzePageToxicity, runJargonInCloud, applyDeviceUpdate } from './analysis.js';
import { revealAllOnPage } from './on-page.js';
import { registerContextMenus, onMenuClick } from './context-menus.js';
import { activeTab, scanImages, locateImage, darkScan, darkClear, darkLocate } from './page-tools.js';

const POLL_ALARM = 'ms-poll';

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
  // Every 5 minutes: refresh role/quota and check for new announcements.
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 5 });
  poll().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => poll().catch(() => {}));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Open the popup so the person sees the result arrive (Chrome 127+; on older
  // versions the result is simply waiting in the Results tab next time).
  chrome.action.openPopup?.()?.catch?.(() => {});
  onMenuClick(info, tab).catch((err) => console.error('[Jachai]', err));
});

async function poll() {
  const session = await getSession();
  if (!session?.token) return setBadge(0);
  await refreshSession();
  const { unreadCount } = await authed('/notifications');
  await setBadge(unreadCount);
}

const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'not_found', null);
  return n;
};

const pageOf = (tab) => ({ title: tab.title ?? '', url: tab.url ?? '' });

// ---------- Message handlers ----------

const handlers = {
  // --- Auth & session ---
  async [MSG.AUTH_SIGNUP]({ email, password, displayName }) {
    const data = await apiFetch('/auth/signup', { method: 'POST', body: { email, password, displayName } });
    const pub = toPublic(await saveSession(data));
    poll().catch(() => {});
    return pub;
  },

  async [MSG.AUTH_LOGIN]({ email, password }) {
    const data = await apiFetch('/auth/login', { method: 'POST', body: { email, password } });
    const pub = toPublic(await saveSession(data));
    poll().catch(() => {});
    return pub;
  },

  async [MSG.AUTH_LOGOUT]() {
    await clearSession();
    await clearResults(); // results can contain what the person read; don't leave them behind
    await setBadge(0);
    return toPublic(null);
  },

  async [MSG.AUTH_CHANGE_PASSWORD]({ currentPassword, newPassword }) {
    const data = await authed('/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    return toPublic(await saveSession(data));
  },

  async [MSG.SESSION_GET]() {
    return toPublic(await getSession());
  },

  [MSG.SESSION_REFRESH]: refreshSession,

  async [MSG.PROFILE_UPDATE]({ displayName }) {
    const { user } = await authed('/me', { method: 'PATCH', body: { displayName } });
    return toPublic(await saveSession({ user }));
  },

  // --- Billing ---
  async [MSG.BILLING_PLANS]() {
    return apiFetch('/billing/plans');
  },

  async [MSG.BILLING_CHECKOUT]() {
    const data = await authed('/billing/checkout', { method: 'POST' });
    if (data.url) {
      await chrome.tabs.create({ url: data.url }); // real Stripe test checkout
      return { redirected: true };
    }
    return refreshSession(); // mock mode: already upgraded
  },

  // --- Feedback ---
  async [MSG.FEEDBACK_SEND]({ message }) {
    return authed('/feedback', { method: 'POST', body: { message: String(message ?? '') } });
  },

  async [MSG.BILLING_CANCEL]() {
    await authed('/billing/cancel', { method: 'POST' });
    return refreshSession();
  },

  async [MSG.BILLING_INVOICES]() {
    return authed('/billing/invoices');
  },

  /**
   * Invoice downloads need the auth header, which a plain link can't send.
   * The service worker fetches the file and opens it as a data: URL tab.
   */
  async [MSG.BILLING_INVOICE_OPEN]({ downloadUrl }) {
    if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('/billing/invoices/')) {
      throw new ApiError(400, 'not_found', null);
    }
    const session = await getSession();
    if (!session?.token) throw new ApiError(401, 'auth_required', null);
    const res = await fetch(`${API_BASE}${downloadUrl}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!res.ok) throw new ApiError(res.status, 'request_failed', null);
    const html = await res.text();
    const b64 = btoa(unescape(encodeURIComponent(html)));
    await chrome.tabs.create({ url: `data:text/html;base64,${b64}` });
    return { opened: true };
  },

  // --- Notifications (bell) ---
  async [MSG.NOTIFICATIONS_LIST]() {
    const data = await authed('/notifications');
    await setBadge(data.unreadCount);
    return data;
  },

  async [MSG.NOTIFICATIONS_MARK_READ]({ ids } = {}) {
    await authed('/notifications/read', {
      method: 'POST',
      body: Array.isArray(ids) ? { ids } : { all: true },
    });
    const { unreadCount } = await authed('/notifications');
    await setBadge(unreadCount);
    return { unreadCount };
  },

  // --- Analysis (results arrive in chrome.storage.session; the popup watches it) ---
  async [MSG.ANALYZE_TEXT]({ task, text }) {
    const entry = await analyzeText({ task, text, source: 'paste' });
    return { id: entry.id };
  },

  async [MSG.ANALYZE_UPLOAD]({ imageData, mimeType, fileName, thumb, textTasks }) {
    const entry = await analyzeUpload({ imageData, mimeType, fileName, thumb, textTasks });
    return { id: entry.id };
  },

  async [MSG.ANALYZE_IMAGE]({ src, textTasks }) {
    const tab = await activeTab();
    const entry = await analyzeImage({ tabId: tab.id, src, mediaType: 'image', source: 'gallery', page: pageOf(tab), textTasks });
    return { id: entry.id };
  },

  async [MSG.RESULTS_CLEAR]() {
    await clearResults();
    return { cleared: true };
  },

  // Jargon simplifier: the popup runs it on-device and reports back, or asks for the cloud.
  async [MSG.JARGON_DEVICE_UPDATE](update) {
    await applyDeviceUpdate(update);
    return { ok: true };
  },

  async [MSG.JARGON_CLOUD]({ id: entryId }) {
    return runJargonInCloud(entryId);
  },

  // --- Page tools (only work on the tab the popup was opened on) ---
  [MSG.PAGE_SCAN_IMAGES]: () => scanImages(),

  async [MSG.PAGE_LOCATE_IMAGE]({ id: imageId }) {
    return locateImage(imageId);
  },
  
    async [MSG.PAGE_TOXICITY_SCAN]() {
    const tab = await activeTab();
    const entry = await analyzePageToxicity({ tabId: tab.id, source: 'page_scan', page: pageOf(tab) });
    return { id: entry.id };
  },

  async [MSG.PAGE_REVEAL_ALL]() {
    const tab = await activeTab();
    return { revealed: await revealAllOnPage(tab.id) };
  },

  async [MSG.DARK_SCAN]() {
    const tab = await activeTab();
    return darkScan(tab.id);
  },

  async [MSG.DARK_CLEAR]() {
    const tab = await activeTab();
    await darkClear(tab.id);
    return { cleared: true };
  },

  async [MSG.DARK_LOCATE]({ id: findingId }) {
    const tab = await activeTab();
    return darkLocate(tab.id, findingId);
  },

  // --- Admin portal (the server enforces the admin role on every call) ---
  async [MSG.ADMIN_OPEN]() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('admin/admin.html') });
    return { opened: true };
  },

  async [MSG.ADMIN_STATS]() {
    return authed('/admin/stats');
  },

  async [MSG.ADMIN_USERS]({ role, q, page, pageSize } = {}) {
    const params = new URLSearchParams();
    if (role && role !== 'all') params.set('role', role);
    if (q) params.set('q', q);
    params.set('page', String(page || 1));
    params.set('pageSize', String(pageSize || 25));
    return authed(`/admin/users?${params}`);
  },

  async [MSG.ADMIN_USER_UPDATE]({ id: userId, role, displayName }) {
    return authed(`/admin/users/${id(userId)}`, { method: 'PATCH', body: { role, displayName } });
  },

  async [MSG.ADMIN_USER_DELETE]({ id: userId }) {
    await authed(`/admin/users/${id(userId)}`, { method: 'DELETE' });
    return { deleted: true };
  },

  async [MSG.ADMIN_USER_RESET_QUOTA]({ id: userId }) {
    return authed(`/admin/users/${id(userId)}/reset-quota`, { method: 'POST' });
  },

  async [MSG.ADMIN_FINANCE]({ month } = {}) {
    const params = new URLSearchParams(month ? { month } : {});
    return authed(`/admin/finance?${params}`);
  },

  async [MSG.ADMIN_SETTINGS]() {
    return authed('/admin/settings');
  },

  async [MSG.ADMIN_SET_PRO_PRICE]({ priceTaka }) {
    return authed('/admin/settings/pro-price', { method: 'PATCH', body: { priceTaka } });
  },

  async [MSG.ADMIN_FEEDBACK]({ type = 'all', page = 1 } = {}) {
    const params = new URLSearchParams({ type: String(type), page: String(Number(page) || 1) });
    return authed(`/admin/feedback?${params}`);
  },

  async [MSG.ADMIN_BROADCASTS]() {
    return authed('/admin/broadcasts');
  },

  async [MSG.ADMIN_BROADCAST_SEND]({ audience, title, body }) {
    return authed('/admin/broadcasts', { method: 'POST', body: { audience, title, body } });
  },

  async [MSG.ADMIN_BROADCAST_DELETE]({ id: broadcastId }) {
    await authed(`/admin/broadcasts/${id(broadcastId)}`, { method: 'DELETE' });
    return { deleted: true };
  },
};

// Only the extension's own pages (popup, admin page) may send these messages.
// Anything running inside a web page has that website's address as its
// sender.url, never a chrome-extension:// URL, and is rejected here.
function isTrustedSender(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;

  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted_sender' });
    return false;
  }

  Promise.resolve()
    .then(() => handler(msg.payload ?? {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      if (!(err instanceof ApiError)) console.error('[Jachai]', err);
      sendResponse({
        ok: false,
        error: err instanceof ApiError ? err.code : 'internal_error',
        field: err?.data?.field,
        details: err?.data,
      });
    });
  return true; // keep the channel open for the async response
});