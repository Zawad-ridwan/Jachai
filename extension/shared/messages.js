// Every message the popup and admin page can send to the service worker.
export const MSG = Object.freeze({
  AUTH_SIGNUP: 'auth/signup',
  AUTH_LOGIN: 'auth/login',
  AUTH_LOGOUT: 'auth/logout',
  AUTH_CHANGE_PASSWORD: 'auth/changePassword',
  SESSION_GET: 'session/get',
  SESSION_REFRESH: 'session/refresh',
  PROFILE_UPDATE: 'profile/update',
  BILLING_PLANS: 'billing/plans',
  BILLING_CHECKOUT: 'billing/checkout',
  BILLING_CANCEL: 'billing/cancel',
  BILLING_INVOICES: 'billing/invoices',
  BILLING_INVOICE_OPEN: 'billing/invoiceOpen',
  NOTIFICATIONS_LIST: 'notifications/list',
  NOTIFICATIONS_MARK_READ: 'notifications/markRead',
  FEEDBACK_SEND: 'feedback/send',
  ANALYZE_TEXT: 'analyze/text',
  ANALYZE_IMAGE: 'analyze/image',
  ANALYZE_UPLOAD: 'analyze/upload',
  RESULTS_CLEAR: 'results/clear',
  JARGON_DEVICE_UPDATE: 'jargon/deviceUpdate',
  JARGON_CLOUD: 'jargon/cloud',
  PAGE_SCAN_IMAGES: 'page/scanImages',
  PAGE_LOCATE_IMAGE: 'page/locateImage',
  PAGE_TOXICITY_SCAN: 'page/toxicityScan',
  PAGE_REVEAL_ALL: 'page/revealAll',
  DARK_SCAN: 'dark/scan',
  DARK_CLEAR: 'dark/clear',
  DARK_LOCATE: 'dark/locate',
  ADMIN_OPEN: 'admin/open',
  ADMIN_STATS: 'admin/stats',
  ADMIN_USERS: 'admin/users',
  ADMIN_USER_UPDATE: 'admin/userUpdate',
  ADMIN_USER_DELETE: 'admin/userDelete',
  ADMIN_USER_RESET_QUOTA: 'admin/userResetQuota',
  ADMIN_FINANCE: 'admin/finance',
  ADMIN_SETTINGS: 'admin/settings',
  ADMIN_SET_PRO_PRICE: 'admin/setProPrice',
  ADMIN_BROADCASTS: 'admin/broadcasts',
  ADMIN_FEEDBACK: 'admin/feedback',
  ADMIN_BROADCAST_SEND: 'admin/broadcastSend',
  ADMIN_BROADCAST_DELETE: 'admin/broadcastDelete',
});

/** Page-side helper: send a message and unwrap { ok, data } / { ok:false, error }. */
export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (!res?.ok) {
    const err = new Error(res?.error ?? 'unknown_error');
    err.field = res?.field;
    err.details = res?.details;
    throw err;
  }
  return res.data;
}