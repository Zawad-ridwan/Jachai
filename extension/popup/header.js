import { MSG, send } from '../shared/messages.js';
import { escapeHtml as h, fmtDate } from '../shared/format.js';
import { state, setState } from './state.js';

export async function loadNotifications() {
  try {
    setState({ notifications: await send(MSG.NOTIFICATIONS_LIST) });
  } catch {
    /* the bell just stays empty if this fails */
  }
}

async function openBell() {
  setState({ bellOpen: true });
  if (state.notifications.unreadCount > 0) {
    try {
      await send(MSG.NOTIFICATIONS_MARK_READ);
    } catch {
      return;
    }
    // Clear the counter but keep this panel's "new" highlighting until it closes.
    setState({ notifications: { ...state.notifications, unreadCount: 0 } });
  }
}

export function renderHeader(root) {
  const { signedIn, user, quota } = state.session;

  if (!signedIn) {
    root.innerHTML = `<div class="brand-mini">\u{1F6E1}\uFE0F Jachai</div>`;
    return;
  }

  const { unreadCount } = state.notifications;
  const tierBadge =
    user.role === 'admin'
      ? `<button id="hdr-admin" class="chip chip-admin" title="Open the admin portal">Admin</button>`
      : user.isPro
        ? `<span class="badge pro">PRO</span>`
        : `<button id="hdr-upgrade" class="chip chip-action">Upgrade</button>`;

  root.innerHTML = `
    <div class="brand-mini">\u{1F6E1}\uFE0F Jachai</div>
    <div class="header-right">
      ${quota.limit !== null ? `<span class="chip" title="Coins left today">${quota.remaining}/${quota.limit}</span>` : ''}
      ${tierBadge}
      <div class="bell-wrap">
        <button id="hdr-bell" class="icon-btn" aria-label="Notifications${unreadCount ? `, ${unreadCount} unread` : ''}">
          \u{1F514}${unreadCount > 0 ? `<span class="count">${unreadCount > 9 ? '9+' : unreadCount}</span>` : ''}
        </button>
        ${state.bellOpen ? renderBellPanel() : ''}
      </div>
      ${
        user.role === 'admin'
          ? '' // admins read feedback in the admin portal instead of sending it
          : `<button id="hdr-feedback" class="icon-btn ${state.view === 'feedback' ? 'active' : ''}" aria-label="Send feedback" title="Send feedback">\u{1F4AC}</button>`
      }
      <button id="hdr-avatar" class="avatar" aria-label="Profile">${h((user.displayName || user.email)[0].toUpperCase())}</button>
    </div>
  `;

  root.querySelector('#hdr-upgrade')?.addEventListener('click', () => setState({ view: 'upgrade' }));
  root.querySelector('#hdr-admin')?.addEventListener('click', async () => {
    await send(MSG.ADMIN_OPEN);
    window.close();
  });
  root.querySelector('#hdr-avatar').addEventListener('click', () => setState({ view: 'profile' }));
  root.querySelector('#hdr-feedback')?.addEventListener('click', () => setState({ view: 'feedback', bellOpen: false, error: null }));
  root.querySelector('#hdr-bell').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.bellOpen) setState({ bellOpen: false });
    else openBell();
  });
  // Clicks inside the panel shouldn't close it.
  root.querySelector('.bell-panel')?.addEventListener('click', (e) => e.stopPropagation());
}

function renderBellPanel() {
  const { notifications } = state.notifications;
  return `
    <div class="bell-panel">
      <h3>Notifications</h3>
      ${
        notifications.length
          ? `<ul>${notifications
              .map(
                (n) => `
              <li class="${n.readAt ? '' : 'unread'}">
                <strong>${h(n.title)}</strong>
                <p>${h(n.body)}</p>
                <span class="muted small">${fmtDate(n.createdAt)}</span>
              </li>`,
              )
              .join('')}</ul>`
          : `<p class="muted">Nothing yet. Announcements from the Jachai team will show up here.</p>`
      }
    </div>
  `;
}

// Clicking anywhere outside the bell closes its panel.
document.addEventListener('click', () => {
  if (state.bellOpen) setState({ bellOpen: false });
});