import { MSG, send } from '../shared/messages.js';
import { escapeHtml as h, errorText, fmtDate, fmtMoney } from '../shared/format.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const ui = {
  me: null,
  stats: null,
  users: { role: 'paid', q: '', page: 1, pageSize: 25, data: null },
  feedback: { type: 'all', page: 1, data: null },
  month: new Date().toISOString().slice(0, 7),
};

// ---------- Errors ----------

function showError(err) {
  if (err?.message === 'forbidden' || err?.message === 'auth_required' || err?.message === 'session_revoked') {
    $('#app').hidden = true;
    $('#denied').hidden = false;
  }
  const banner = $('#banner');
  banner.textContent = errorText(err);
  banner.hidden = false;
}

/** Runs an action, clearing old errors first and showing any new one. */
async function act(fn) {
  $('#banner').hidden = true;
  try {
    await fn();
  } catch (err) {
    showError(err);
  }
}

const card = (label, value, tone = '') =>
  `<div class="stat ${tone}"><span class="muted small">${h(label)}</span><strong>${h(value)}</strong></div>`;

// ---------- Boot ----------

(async () => {
  const session = await send(MSG.SESSION_GET).catch(() => ({ signedIn: false }));
  if (!session.signedIn || session.user.role !== 'admin') {
    $('#denied').hidden = false;
    return;
  }
  ui.me = session.user;
  $('#me').textContent = `Signed in as ${session.user.email}`;
  $('#app').hidden = false;

  wireTabs();
  wireUsers();
  wireFinance();
  wireBroadcasts();
  wireFeedback();
  await act(async () => {
    await loadStats();
    await loadUsers();
  });
})();

function wireTabs() {
  $$('.tabs button').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      for (const t of ['users', 'finance', 'broadcasts', 'feedback']) $(`#panel-${t}`).hidden = t !== tab;

      if (tab === 'users') act(async () => { await loadStats(); await loadUsers(); });
      if (tab === 'finance') act(loadFinance);
      if (tab === 'broadcasts') act(async () => { await loadStats(); await loadBroadcasts(); });
      if (tab === 'feedback') act(loadFeedback);
    }),
  );
}

// ======================================================================
// Users
// ======================================================================

async function loadStats() {
  ui.stats = await send(MSG.ADMIN_STATS);
  const { counts, total, mrrCents } = ui.stats;

  $('#stats-cards').innerHTML = [
    card('Total users', total),
    card('Paid users', counts.paid, 'good'),
    card('Regular users', counts.regular),
    card('Admins', counts.admin),
    card('MRR', fmtMoney(mrrCents)),
  ].join('');

  $$('[data-count]').forEach((el) => {
    const key = el.dataset.count;
    el.textContent = `(${key === 'total' ? total : counts[key]})`;
  });
  updateReach();
}

async function loadUsers() {
  const { role, q, page, pageSize } = ui.users;
  ui.users.data = await send(MSG.ADMIN_USERS, { role, q, page, pageSize });
  renderUsers(ui.users.data);
}

function renderUsers({ users, total, page, pageSize }) {
  $('#users-body').innerHTML = users.length
    ? users.map(userRow).join('')
    : `<tr><td colspan="6" class="empty muted">No users match.</td></tr>`;

  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#page-label').textContent = `Page ${page} of ${pages} \u00b7 ${total} ${total === 1 ? 'user' : 'users'}`;
  $('#prev-page').disabled = page <= 1;
  $('#next-page').disabled = page >= pages;
}

function userRow(u) {
  const self = u.id === ui.me.id;
  const options = ['regular', 'paid', 'admin']
    .map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`)
    .join('');
  return `
    <tr data-id="${u.id}">
      <td>
        <strong>${h(u.email)}</strong>
        ${u.displayName ? `<div class="muted small">${h(u.displayName)}</div>` : ''}
        ${self ? '<div class="muted small">(you)</div>' : ''}
      </td>
      <td><select data-action="role" ${self ? 'disabled' : ''} aria-label="Role">${options}</select></td>
      <td>${u.usedToday}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>${u.role === 'paid' ? fmtDate(u.subscriptionExpiresAt) : '\u2014'}</td>
      <td class="actions">
        <button data-action="reset" ${u.usedToday ? '' : 'disabled'}>Reset coins</button>
        <button data-action="delete" class="danger" ${self ? 'disabled' : ''}>Delete</button>
      </td>
    </tr>`;
}

function wireUsers() {
  $('#role-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-role]');
    if (!btn) return;
    $$('#role-filter button').forEach((b) => b.classList.toggle('active', b === btn));
    ui.users.role = btn.dataset.role;
    ui.users.page = 1;
    act(loadUsers);
  });

  let debounce;
  $('#user-search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      ui.users.q = e.target.value.trim();
      ui.users.page = 1;
      act(loadUsers);
    }, 300);
  });

  $('#prev-page').addEventListener('click', () => { ui.users.page -= 1; act(loadUsers); });
  $('#next-page').addEventListener('click', () => { ui.users.page += 1; act(loadUsers); });

  const findUser = (el) => {
    const id = Number(el.closest('tr').dataset.id);
    return ui.users.data.users.find((u) => u.id === id);
  };

  $('#users-body').addEventListener('change', (e) => {
    const select = e.target.closest('select[data-action="role"]');
    if (!select) return;
    const user = findUser(select);
    const newRole = select.value;
    const note = newRole === 'paid' ? '\n\nThis grants 30 days of free Pro.' : '';
    if (!confirm(`Change ${user.email} from ${user.role} to ${newRole}?${note}`)) {
      select.value = user.role;
      return;
    }
    act(async () => {
      try {
        await send(MSG.ADMIN_USER_UPDATE, { id: user.id, role: newRole });
      } finally {
        await loadStats();
        await loadUsers();
      }
    });
  });

  $('#users-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const user = findUser(btn);

    if (btn.dataset.action === 'reset') {
      act(async () => {
        await send(MSG.ADMIN_USER_RESET_QUOTA, { id: user.id });
        await loadUsers();
      });
    }
    if (btn.dataset.action === 'delete') {
      if (!confirm(`Permanently delete ${user.email}? This can\u2019t be undone.`)) return;
      act(async () => {
        await send(MSG.ADMIN_USER_DELETE, { id: user.id });
        await loadStats();
        await loadUsers();
      });
    }
  });
}

// ======================================================================
// Finance & churn calendar
// ======================================================================

const thisMonth = () => new Date().toISOString().slice(0, 7);

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

function wireFinance() {
  $('#prev-month').addEventListener('click', () => { ui.month = shiftMonth(ui.month, -1); act(loadFinance); });
  $('#next-month').addEventListener('click', () => { ui.month = shiftMonth(ui.month, 1); act(loadFinance); });
  $('#price-form').addEventListener('submit', (e) => {
    e.preventDefault();
    savePrice();
  });
  $('#price-input').addEventListener('input', () => setPriceStatus(''));
}

async function loadFinance() {
  const [finance, settings] = await Promise.all([send(MSG.ADMIN_FINANCE, { month: ui.month }), send(MSG.ADMIN_SETTINGS)]);
  renderPrice(settings);
  renderFinance(finance);
}

// ---------- Pro price ----------

function setPriceStatus(text, tone = '') {
  const el = $('#price-status');
  el.textContent = text;
  el.className = `small ${tone}`;
}

function renderPrice(s) {
  ui.price = s;
  $('#price-current').textContent = fmtMoney(s.proPriceTaka * 100);
  const input = $('#price-input');
  input.min = s.minTaka;
  input.max = s.maxTaka;
  if (document.activeElement !== input) input.value = s.proPriceTaka;
  $('#price-help').textContent =
    `Whole taka only, from ${fmtMoney(s.minTaka * 100)} to ${fmtMoney(s.maxTaka * 100)}.`;
}

function savePrice() {
  const raw = $('#price-input').value.trim();
  const priceTaka = Number(raw);
  const { minTaka, maxTaka, proPriceTaka } = ui.price ?? { minTaka: 100, maxTaka: 100000 };
  if (!raw || !Number.isInteger(priceTaka) || priceTaka < minTaka || priceTaka > maxTaka) {
    setPriceStatus(errorText({ message: 'invalid_price' }), 'err');
    return;
  }
  if (priceTaka === proPriceTaka) {
    setPriceStatus('That\u2019s already the current price.');
    return;
  }
  if (!confirm(`Change the Pro price from ${fmtMoney(proPriceTaka * 100)} to ${fmtMoney(priceTaka * 100)} per month?\n\n` +
    'The new price applies to new upgrades only. People already on Pro keep their current period.')) return;

  const btn = $('#price-save');
  btn.disabled = true;
  act(async () => {
    try {
      renderPrice(await send(MSG.ADMIN_SET_PRO_PRICE, { priceTaka }));
      setPriceStatus(`Saved. New upgrades now cost ${fmtMoney(priceTaka * 100)}/month.`, 'ok');
      renderFinance(await send(MSG.ADMIN_FINANCE, { month: ui.month })); // MRR uses the new price
      await loadStats();
    } catch (err) {
      setPriceStatus(errorText(err), 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

function renderFinance(d) {
  const [y, m] = d.month.split('-').map(Number);
  $('#month-label').textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  $('#next-month').disabled = d.month >= thisMonth();

  const t = d.totals;
  const net = t.gained - t.lost;
  $('#finance-cards').innerHTML = [
    card('Current MRR', fmtMoney(d.mrrCents)),
    card(d.month === thisMonth() ? 'MRR so far this month' : 'MRR at month end', fmtMoney(d.mrrEndCents)),
    card('Revenue collected', fmtMoney(t.revenueCents)),
    card('Gained', `+${t.gained}`, 'good'),
    card('Lost', `\u2212${t.lost}`, 'bad'),
    card('Net change', `${net >= 0 ? '+' : '\u2212'}${Math.abs(net)}`, net >= 0 ? 'good' : 'bad'),
    card('Churn rate', `${(d.churnRate * 100).toFixed(1)}%`),
  ].join('');

  const todayIso = new Date().toISOString().slice(0, 10);
  const leading = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const heads = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .map((w) => `<div class="cal-head">${w}</div>`)
    .join('');
  const blanks = '<div class="cal-cell blank"></div>'.repeat(leading);
  const cells = d.days
    .map((day) => {
      const busy = day.gained || day.lost || day.revenueCents;
      return `
      <div class="cal-cell ${day.date === todayIso ? 'today' : ''} ${busy ? 'has-data' : ''} ${day.date > todayIso ? 'future' : ''}">
        <span class="cal-num">${Number(day.date.slice(8))}</span>
        ${day.gained ? `<span class="good">+${day.gained}</span>` : ''}
        ${day.lost ? `<span class="bad">\u2212${day.lost}</span>` : ''}
        ${day.revenueCents ? `<span class="muted small">${fmtMoney(day.revenueCents)}</span>` : ''}
      </div>`;
    })
    .join('');
  $('#calendar').innerHTML = heads + blanks + cells;
}

// ======================================================================
// Feedback (sent by Regular and Pro users from the popup's speech-bubble button)
// ======================================================================

const USER_TYPE = { paid: ['PRO', 'paid'], regular: ['REGULAR', 'regular'] };

function wireFeedback() {
  $('#feedback-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    $$('#feedback-filter button').forEach((b) => b.classList.toggle('active', b === btn));
    ui.feedback.type = btn.dataset.type;
    ui.feedback.page = 1;
    act(loadFeedback);
  });
  $('#feedback-refresh').addEventListener('click', () => act(loadFeedback));
  $('#fb-prev-page').addEventListener('click', () => { ui.feedback.page -= 1; act(loadFeedback); });
  $('#fb-next-page').addEventListener('click', () => { ui.feedback.page += 1; act(loadFeedback); });
}

async function loadFeedback() {
  const { type, page } = ui.feedback;
  ui.feedback.data = await send(MSG.ADMIN_FEEDBACK, { type, page });
  ui.feedback.page = ui.feedback.data.page;
  renderFeedback(ui.feedback.data);
}

function renderFeedback({ items, total, page, pageSize, counts }) {
  $$('[data-fb-count]').forEach((el) => { el.textContent = `(${counts[el.dataset.fbCount] ?? 0})`; });

  const empty = ui.feedback.type === 'all' ? 'No feedback yet.' : 'No feedback from this group yet.';
  // Everything a user wrote goes through h() so it can never inject markup into this page.
  $('#feedback-body').innerHTML = items.length
    ? items.map((f) => {
        const [label, cls] = USER_TYPE[f.userRole] ?? [String(f.userRole).toUpperCase(), 'regular'];
        return `
        <tr>
          <td class="fb-date">${fmtDate(f.createdAt)}<div class="muted small">${h(new Date(f.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</div></td>
          <td class="fb-name">${f.user.displayName ? h(f.user.displayName) : '<span class="muted">(no name)</span>'}</td>
          <td class="fb-email">${h(f.user.email)}</td>
          <td><span class="pill ${cls}">${label}</span></td>
          <td class="fb-message">${h(f.message)}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="5" class="empty muted">${empty}</td></tr>`;

  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#fb-page-label').textContent = `Page ${page} of ${pages} \u00b7 ${total} ${total === 1 ? 'message' : 'messages'}`;
  $('#fb-prev-page').disabled = page <= 1;
  $('#fb-next-page').disabled = page >= pages;
}

// ======================================================================
// Broadcasts
// ======================================================================

const AUDIENCE_LABEL = { all: 'All users', regular: 'Regular only', paid: 'Paid only' };

function updateReach() {
  if (!ui.stats) return;
  const audience = $('#bc-audience').value;
  const { counts, total } = ui.stats;
  // Admins see every announcement, so they're included in each audience.
  const n =
    audience === 'all' ? total : audience === 'paid' ? counts.paid + counts.admin : counts.regular + counts.admin;
  $('#bc-reach').textContent = `Reaches ${n} ${n === 1 ? 'account' : 'accounts'} (admins see every announcement).`;
}

function wireBroadcasts() {
  const bodyEl = $('#bc-body');
  const updateChars = () => ($('#bc-chars').textContent = `${bodyEl.value.length} / 2000`);
  bodyEl.addEventListener('input', updateChars);
  updateChars();
  $('#bc-audience').addEventListener('change', updateReach);

  $('#broadcast-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const audience = $('#bc-audience').value;
    const title = $('#bc-title').value.trim();
    const body = bodyEl.value.trim();
    const label = $('#bc-audience').selectedOptions[0].textContent.toLowerCase();
    if (!confirm(`Send \u201c${title}\u201d to ${label}?`)) return;

    const submit = e.submitter;
    submit.disabled = true;
    act(async () => {
      try {
        await send(MSG.ADMIN_BROADCAST_SEND, { audience, title, body });
        form.reset();
        updateChars();
        updateReach();
        await loadBroadcasts();
      } finally {
        submit.disabled = false;
      }
    });
  });

  $('#broadcast-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-delete]');
    if (!btn) return;
    if (!confirm('Delete this announcement? People will no longer see it.')) return;
    act(async () => {
      await send(MSG.ADMIN_BROADCAST_DELETE, { id: Number(btn.dataset.delete) });
      await loadBroadcasts();
    });
  });
}

async function loadBroadcasts() {
  const { broadcasts } = await send(MSG.ADMIN_BROADCASTS);
  $('#broadcast-list').innerHTML = broadcasts.length
    ? broadcasts
        .map(
          (b) => `
        <li class="card">
          <div class="bc-head">
            <strong>${h(b.title)}</strong>
            <span class="pill ${h(b.audience)}">${AUDIENCE_LABEL[b.audience] ?? h(b.audience)}</span>
          </div>
          <p class="bc-body">${h(b.body)}</p>
          <div class="bc-meta muted small">
            <span>${fmtDate(b.createdAt)} \u00b7 by ${h(b.author ?? 'a deleted admin')} \u00b7 read by ${b.reads}</span>
            <button class="link danger" data-delete="${b.id}">Delete</button>
          </div>
        </li>`,
        )
        .join('')
    : '<li class="muted">No announcements sent yet.</li>';
}