import { state, setState } from '../state.js';
import { escapeHtml as h, coins } from '../ui-helpers.js';
import { renderPaste } from './tabs/paste.js';
import { renderImages } from './tabs/images.js';
import { renderDark } from './tabs/dark.js';
import { renderResults } from './tabs/results.js';

const TABS = [
  ['paste', 'Paste text', renderPaste],
  ['images', 'Images', renderImages],
  ['dark', 'Page scan', renderDark],
  ['results', 'Results', renderResults],
];

function quotaBar(quota) {
  if (quota.limit === null) {
    return `<div class="quota"><p class="muted small">Unlimited \u00b7 ${coins(quota.used)} used today</p></div>`;
  }
  const pct = Math.min(100, Math.round((quota.used / Math.max(1, quota.limit)) * 100));
  const low = quota.remaining <= Math.max(1, Math.round(quota.limit * 0.1));
  return `
    <div class="quota">
      <div class="quota-row">
        <span>${quota.remaining} of ${coins(quota.limit)} left today</span>
        <span class="muted">resets at midnight UTC</span>
      </div>
      <div class="meter"><div class="meter-fill ${low ? 'low' : ''}" style="width:${pct}%"></div></div>
    </div>
  `;
}

function tabBadge(id) {
  if (id === 'images' && state.pageImages?.images) {
    return ` <span class="tab-count">${state.pageImages.images.length}</span>`;
  }
  if (id === 'dark') {
    const tox = state.pageTox && state.results.find((r) => r.id === state.pageTox.entryId);
    const found = (state.dark?.total ?? 0) + (tox?.data?.result?.flaggedCount ?? 0);
    if (tox?.status === 'running' || state.dark === 'scanning') return ' <span class="spinner" aria-label="Working"></span>';
    if (state.dark?.findings || tox?.status === 'done') return ` <span class="tab-count ${found ? 'warn' : ''}">${found}</span>`;
  }
  if (id === 'results' && state.results.some((r) => r.status === 'running')) {
    return ' <span class="spinner" aria-label="Working"></span>';
  }
  return '';
}

export function renderDashboard(root) {
  root.innerHTML = `
    <div class="dashboard">
      ${quotaBar(state.session.quota)}
      <nav class="tabbar" role="tablist">
        ${TABS.map(
          ([id, label]) =>
            `<button role="tab" data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${label}${tabBadge(id)}</button>`,
        ).join('')}
      </nav>
      <div id="tab-root"></div>
      ${state.error ? `<p class="error">${h(state.error)}</p>` : ''}
    </div>
  `;

  root.querySelector('.tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setState({ tab: btn.dataset.tab, error: null });
  });

  const [, , renderTab] = TABS.find(([id]) => id === state.tab) ?? TABS[0];
  renderTab(root.querySelector('#tab-root'));
}