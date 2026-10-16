import { MSG, send } from '../../shared/messages.js';
import { state, setState } from '../state.js';
import { runAction, errorText, escapeHtml as h, fmtDate, fmtMoney, fmtCountdown } from '../ui-helpers.js';
import { PASSWORD_MAX, passwordOk, passwordChecklist, updateChecklist } from '../../shared/password.js';

let countdownTimer = null;
let editingName = false;
let showPasswordForm = false;

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

/**
 * state.invoices: null = not requested yet, 'loading' = in flight, object = loaded.
 * The 'loading' marker is set by plain assignment (no re-render), so opening
 * this page can't trigger itself again in a loop.
 */
function ensureInvoices() {
  if (state.invoices !== null) return;
  state.invoices = 'loading';
  send(MSG.BILLING_INVOICES)
    .then((invoices) => setState({ invoices }))
    .catch((err) => setState({ invoices: { invoices: [] }, error: errorText(err) }));
}

export function renderProfile(root) {
  const { user } = state.session;
  stopCountdown();
  const invoicesReady = state.invoices && state.invoices !== 'loading';

  root.innerHTML = `
    <div class="profile">
      <button class="back">\u2190 Back</button>

      <div class="card">
        <div class="identity-row">
          <div class="avatar-lg">${h((user.displayName || user.email)[0].toUpperCase())}</div>
          <div>
            ${
              editingName
                ? `<input id="name-input" type="text" maxlength="60" value="${h(user.displayName ?? '')}" placeholder="Your name" />`
                : `<strong>${user.displayName ? h(user.displayName) : '(no name set)'}</strong>`
            }
            <p class="muted">${h(user.email)}</p>
          </div>
        </div>
        <div class="row">
          <span class="badge ${h(user.role)}">${h(user.role.toUpperCase())}${user.isPro ? ' \u2605' : ''}</span>
          ${user.subscriptionExpiresAt ? `<span id="countdown" class="muted small"></span>` : ''}
        </div>
        <button id="edit-name" class="link">${editingName ? 'Save name' : 'Edit name'}</button>
      </div>

      <div class="card">
        <h2>Password</h2>
        ${
          showPasswordForm
            ? `
              <form id="password-form" novalidate>
                <input id="current-password" type="password" placeholder="Current password" autocomplete="current-password" required />
                <input id="new-password" type="password" placeholder="New password (8\u201312 characters)" autocomplete="new-password"
                       required minlength="8" maxlength="${PASSWORD_MAX}" aria-describedby="new-pw-rules" />
                <div id="new-pw-rules">${passwordChecklist('')}</div>
                <div class="row">
                  <button type="submit" id="save-password" class="primary" disabled>Save</button>
                  <button type="button" id="cancel-password" class="secondary">Cancel</button>
                </div>
                <p class="muted small">Changing your password signs you out on every other device.</p>
              </form>
            `
            : `<button id="show-password" class="secondary">Change password</button>`
        }
      </div>

      ${user.role === 'paid' ? `
        <div class="card">
          <h2>Billing</h2>
          <div id="invoices">${invoicesReady ? renderInvoiceList(state.invoices.invoices) : '<p class="muted">Loading\u2026</p>'}</div>
          ${user.role === 'paid' ? `<button id="cancel-pro" class="danger-link">Cancel Pro subscription</button>` : ''}
        </div>
      ` : ''}

      ${state.error ? `<p class="error">${h(state.error)}</p>` : ''}

      <button id="sign-out" class="link full">Sign out</button>
    </div>
  `;

  root.querySelector('.back').addEventListener('click', () => setState({ view: 'dashboard', error: null }));

  root.querySelector('#edit-name').addEventListener('click', () => {
    if (!editingName) {
      editingName = true;
      setState({});
      return;
    }
    const displayName = root.querySelector('#name-input').value.trim();
    runAction(async () => {
      editingName = false;
      setState({ session: await send(MSG.PROFILE_UPDATE, { displayName }) });
    });
  });

  if (user.subscriptionExpiresAt) {
    const tick = () => {
      const label = root.querySelector('#countdown');
      if (label) label.textContent = `Pro ends or renews in ${fmtCountdown(user.subscriptionExpiresAt)}`;
    };
    tick();
    countdownTimer = setInterval(tick, 30_000);
  }

  root.querySelector('#show-password')?.addEventListener('click', () => {
    showPasswordForm = true;
    setState({});
  });
  root.querySelector('#cancel-password')?.addEventListener('click', () => {
    showPasswordForm = false;
    setState({ error: null });
  });
  // Live checklist for the new password; Save stays disabled until every rule passes.
  const newPw = root.querySelector('#new-password');
  newPw?.addEventListener('input', () => {
    updateChecklist(root.querySelector('#new-pw-rules'), newPw.value);
    root.querySelector('#save-password').disabled = state.busy || !passwordOk(newPw.value);
  });

  root.querySelector('#password-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const currentPassword = root.querySelector('#current-password').value;
    const newPassword = root.querySelector('#new-password').value;
    if (!passwordOk(newPassword)) return;
    runAction(async () => {
      const session = await send(MSG.AUTH_CHANGE_PASSWORD, { currentPassword, newPassword });
      showPasswordForm = false;
      setState({ session });
    });
  });

  if (user.role === 'paid') ensureInvoices(); // admins have no subscription, so no billing

  root.querySelector('#invoices')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-url]');
    if (!btn) return;
    const url = btn.dataset.url;
    runAction(async () => {
      if (url.startsWith('https://')) await chrome.tabs.create({ url }); // Stripe-hosted PDF
      else await send(MSG.BILLING_INVOICE_OPEN, { downloadUrl: url });
    });
  });

  root.querySelector('#cancel-pro')?.addEventListener('click', () => {
    if (!confirm('Cancel your Pro subscription?')) return;
    runAction(async () => setState({ session: await send(MSG.BILLING_CANCEL), invoices: null }));
  });

  root.querySelector('#sign-out').addEventListener('click', () => {
    runAction(async () => {
      stopCountdown();
      setState({ session: await send(MSG.AUTH_LOGOUT), view: 'auth' });
    });
  });
}

function renderInvoiceList(invoices) {
  if (!invoices?.length) return '<p class="muted">No invoices yet.</p>';
  return `
    <ul class="invoice-list">
      ${invoices
        .map(
          (inv) => `
        <li>
          <span>${fmtDate(inv.createdAt)}</span>
          <span>${fmtMoney(inv.amountCents, inv.currency)}</span>
          <button class="link" data-url="${h(inv.downloadUrl)}">${h(inv.number)}</button>
        </li>`,
        )
        .join('')}
    </ul>
  `;
}