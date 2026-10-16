import { MSG, send } from '../shared/messages.js';
import { STORAGE_KEYS } from '../shared/config.js';
import { state, setState, onStateChange } from './state.js';
import { renderHeader, loadNotifications } from './header.js';
import { renderAuth } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderProfile } from './views/profile.js';
import { renderUpgrade } from './views/upgrade.js';
import { renderFeedback } from './views/feedback.js';
import { ensurePageImages } from './views/tabs/images.js';

const headerRoot = document.getElementById('header-root');

// Opened in a normal tab (the "upload in a tab" fallback): full-page layout,
// straight to the Images tab.
if (new URLSearchParams(location.search).has('standalone')) {
  document.body.classList.add('standalone');
  if (location.hash === '#images') state.tab = 'images';
}
const viewRoot = document.getElementById('view-root');

const VIEWS = {
  auth: renderAuth,
  dashboard: renderDashboard,
  profile: renderProfile,
  upgrade: renderUpgrade,
  feedback: renderFeedback,
};

// Results started from outside the popup (right-click menu) switch to the Results tab.
const isExternal = (entry) => !['paste', 'gallery', 'upload', 'image_text', 'page_scan'].includes(entry.source);

function ensureResults() {
  if (state.resultsLoaded) return;
  state.resultsLoaded = true;
  chrome.storage.session.get(STORAGE_KEYS.RESULTS).then(({ [STORAGE_KEYS.RESULTS]: list = [] }) => {
    const newest = list[0];
    const justStarted = newest && isExternal(newest) && Date.now() - new Date(newest.createdAt).getTime() < 15_000;
    setState({ results: list, ...(justStarted ? { view: 'dashboard', tab: 'results' } : {}) });
  });
}

// The background refreshes the saved session (coins left, tier) after every
// check, so pick that up to keep the coin counter current while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEYS.SESSION] || !state.session.signedIn) return;
  send(MSG.SESSION_GET)
    .then((session) => {
      if (session.signedIn && state.session.signedIn) setState({ session });
    })
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[STORAGE_KEYS.RESULTS]) return;
  const list = changes[STORAGE_KEYS.RESULTS].newValue ?? [];
  const known = new Set(state.results.map((r) => r.id));
  const external = list.some((r) => !known.has(r.id) && isExternal(r));
  setState({ results: list, ...(external ? { view: 'dashboard', tab: 'results' } : {}) });
});

let notificationsLoadedFor = null;
let lastScreen = '';

function render() {
  const { signedIn, user } = state.session;

  // Re-rendering replaces the HTML, so remember focus, cursor and scroll first.
  const active = document.activeElement;
  const focusId = active && active !== document.body ? active.id : '';
  const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scrollTop = document.body.scrollTop;

  if (signedIn) {
    if (notificationsLoadedFor !== user.id) {
      notificationsLoadedFor = user.id;
      loadNotifications(); // async: updates state when it arrives
    }
    ensureResults();
    ensurePageImages(); // scan this page's images as soon as the popup opens
  } else if (notificationsLoadedFor !== null) {
    // Signed out: forget everything from the previous account.
    notificationsLoadedFor = null;
    Object.assign(state, {
      tab: 'paste', notifications: { notifications: [], unreadCount: 0 }, invoices: null, plans: null,
      feedbackDraft: '', feedbackSent: false,
      pasteDraft: '', pageImages: null, selectedImages: [], uploads: [], uploadProblems: [], imageTextTasks: [], dark: null, pageTox: null, results: [], resultsLoaded: false,
    });
  }

  renderHeader(headerRoot);
  const view = signedIn ? state.view : 'auth';
  (VIEWS[view] ?? renderDashboard)(viewRoot);

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      if (caret && el.setSelectionRange) {
        try {
          el.setSelectionRange(caret[0], caret[1]);
        } catch {
          /* not a text field */
        }
      }
    }
  }
  const screen = `${view}:${state.tab}`;
  document.body.scrollTop = screen === lastScreen ? scrollTop : 0;
  lastScreen = screen;
}

onStateChange(render);

// Boot: show cached session instantly (no flash of the login screen), then
// verify with the server. A dead/expired session quietly falls back to auth.
(async () => {
  const cached = await send(MSG.SESSION_GET);
  setState({ session: cached });
  if (cached.signedIn) {
    try {
      setState({ session: await send(MSG.SESSION_REFRESH) });
    } catch {
      setState({ session: { signedIn: false }, view: 'auth' });
    }
  }
})();