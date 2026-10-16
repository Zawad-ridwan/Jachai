// Formatting and safety helpers shared by the popup and the admin page.

const ERROR_TEXT = {
  invalid_email: 'That email doesn\u2019t look right.',
  weak_password:
    'Password must be 8\u201312 characters with an uppercase letter, a lowercase letter, a number and a special character, and no spaces.',
  email_taken: 'An account with that email already exists.',
  invalid_credentials: 'That email or password is incorrect.',
  too_many_attempts: 'Too many attempts. Please wait a few minutes and try again.',
  quota_exceeded: 'You don\u2019t have enough coins left today. Upgrade to Pro for more.',
  network_error: 'Can\u2019t reach the Jachai server. Is it running?',
  already_subscribed: 'You\u2019re already on Pro.',
  stripe_auth: 'The payment service rejected the server\u2019s Stripe key. An admin needs to check STRIPE_SECRET_KEY.',
  stripe_checkout_failed: 'Couldn\u2019t open the payment page. Please try again in a moment.',
  admin_has_no_subscription: 'Admin accounts don\u2019t have a subscription to cancel.',
  session_revoked: 'You were signed out on another device.',
  auth_required: 'Please sign in to Jachai first.',
  forbidden: 'You don\u2019t have permission to do that.',
  not_found: 'That item no longer exists.',
  cannot_demote_self: 'You can\u2019t remove your own admin role.',
  cannot_delete_self: 'You can\u2019t delete your own account from here.',
  invalid_role: 'That isn\u2019t a valid role.',
  invalid_feedback: 'Please write between 10 and 2,000 characters.',
  too_many_feedback: 'You\u2019ve sent a lot of feedback in the last hour. Thank you! Please try again a little later.',
  invalid_feedback_type: 'Choose All, Pro users or Regular users.',
  invalid_price: 'Enter a whole number of taka between \u09F3100 and \u09F31,00,000.',
  has_active_stripe_subscription: 'This user pays through Stripe. Cancel their subscription in Stripe first.',
  invalid_audience: 'Choose who should receive this announcement.',
  invalid_title: 'The title must be 1 to 120 characters.',
  invalid_body: 'The message must be 1 to 2,000 characters.',
  untrusted_sender: 'That request was blocked for security reasons.',
  pro_required: 'This check is part of Pro. Upgrade to use it.',
  unknown_task: 'That check isn\u2019t available.',
  invalid_text: 'There\u2019s no text to analyze.',
  nothing_selected: 'No text was selected.',
  text_too_long: 'That\u2019s too much text. Please use 5,000 characters or fewer.',
  invalid_image: 'That isn\u2019t a supported image (PNG, JPEG, WebP or GIF).',
  image_too_large: 'That image is too large (4 MB maximum).',
  image_unreadable: 'Jachai couldn\u2019t read that image.',
  video_not_ready: 'That video hasn\u2019t loaded a frame yet. Play it for a moment and try again.',
  video_protected: 'That video is protected, so Jachai can\u2019t capture a frame from it.',
  page_not_accessible:
    'Jachai can\u2019t read this page. Browser pages and the Chrome Web Store are off-limits; on other sites, reopen the popup while that tab is showing.',
  no_active_tab: 'There\u2019s no open tab to scan.',
  nothing_to_scan: 'Jachai couldn\u2019t find any passages of text to check on this page.',
  too_many_requests: 'Too many checks in the last minute. Please wait a moment.',
  not_connected: 'This check isn\u2019t set up on the server yet (its API key is missing). No coins were used.',
  provider_busy: 'The AI service is busy right now. Please try again in a minute. No coins were used.',
  provider_timeout: 'The AI service took too long to answer. Please try again. No coins were used.',
  provider_unreachable: 'The server couldn\u2019t reach the AI service. No coins were used.',
  provider_error: 'The AI service returned an error. Please try again. No coins were used.',
  provider_auth: 'The server\u2019s key for this AI service was rejected; an admin needs to check it. No coins were used.',
  content_blocked: 'The AI service declined to analyze this content. No coins were used.',
  device_unsupported:
    'This browser can\u2019t run the on-device AI (it needs a recent Chrome on a capable computer). You can use the cloud instead.',
  device_language_unsupported: 'The on-device AI doesn\u2019t support this language yet. You can use the cloud instead.',
  device_failed: 'The on-device AI couldn\u2019t finish. Try again, or use the cloud instead.',
  device_needs_click: 'Click \u201cSimplify on this device\u201d to start the on-device AI.',
  device_text_too_long: 'This text is too long for the on-device AI. Try a shorter selection, or use the cloud.',
  internal_error: 'Something went wrong. Please try again.',
};

export function errorText(err) {
  return ERROR_TEXT[err?.message] ?? `Something went wrong (${err?.message ?? 'unknown error'}).`;
}

/**
 * Anything a person typed or a web page supplied (names, announcement text,
 * selected text, image descriptions) must pass through this before being
 * placed into innerHTML, or it could inject markup.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** "1 coin", "3 coins": coins are what each check costs from the daily allowance. */
export function coins(n) {
  return `${n} coin${n === 1 ? '' : 's'}`;
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

export function fmtDate(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtTimeAgo(iso) {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)} h ago`;
  return fmtDate(iso);
}

/**
 * Money is stored in the currency's smallest unit (poisha for taka: 100 poisha = 1 taka).
 * Taka is shown with the \u09F3 sign and Bangladeshi digit grouping (\u09F31,23,456),
 * with no ".00" on whole amounts.
 */
export function fmtMoney(minor, currency = 'bdt') {
  const amount = minor ?? 0;
  const bdt = String(currency).toLowerCase() === 'bdt';
  const opts = {
    style: 'currency',
    currency: String(currency).toUpperCase(),
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  };
  try {
    return new Intl.NumberFormat(bdt ? 'en-IN' : 'en-US', opts).format(amount / 100);
  } catch {
    return `${bdt ? '\u09F3' : `${String(currency).toUpperCase()} `}${(amount / 100).toFixed(opts.minimumFractionDigits)}`;
  }
}

/** "3d 4h", "6h 12m", "less than a minute": for the subscription countdown. */
export function fmtCountdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'less than a minute';
}