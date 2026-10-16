import { MSG, send } from '../../../shared/messages.js';
import { TASKS } from '../../../shared/tasks.js';
import { state, setState } from '../../state.js';
import { runAction, errorText, escapeHtml as h, coins } from '../../ui-helpers.js';
import { renderFinished } from './renderers.js';

// The "Page scan" tab: two tools that act on the whole page.
//   1. Toxic content: score up to 30 passages in one request and blur the harmful ones.
//   2. Dark patterns: find pressure tricks (runs locally, free).

// ---------------------------------------------------------------------------
// Toxic content
// ---------------------------------------------------------------------------

function renderToxic(root) {
  const { quota } = state.session;
  const cost = TASKS.toxicity_page.cost;
  const canAfford = quota.limit === null || quota.remaining >= cost;
  const entry = state.pageTox && state.results.find((r) => r.id === state.pageTox.entryId);

  let body;
  if (!entry) {
    body = `
      <p class="small">Check the comments and posts on this page for hate speech, bullying and threats, and blur any that are harmful.
        You can reveal any of them with a click.</p>
      <button id="tox-scan" class="primary" ${canAfford && !state.busy ? '' : 'disabled'}>Scan &amp; blur \u00b7 ${coins(cost)}</button>
      ${canAfford ? '' : '<p class="error">Not enough coins left today.</p>'}`;
  } else if (entry.status === 'running') {
    body = '<p class="status running"><span class="spinner"></span> Checking the passages on this page\u2026</p>';
  } else if (entry.status === 'error') {
    body = `<p class="status error">${h(errorText({ message: entry.error }))}</p>
      <button id="tox-scan" class="secondary" ${canAfford ? '' : 'disabled'}>Try again \u00b7 ${coins(cost)}</button>`;
  } else {
    const flagged = entry.data?.result?.flaggedCount ?? 0;
    body = `${renderFinished(entry)}
      <div class="row">
        <button id="tox-scan" class="secondary" ${canAfford ? '' : 'disabled'}>Scan again \u00b7 ${coins(cost)}</button>
        ${flagged ? '<button id="tox-reveal" class="link">Show everything</button>' : ''}
      </div>`;
  }
  root.innerHTML = `<h3>Toxic content</h3>${body}`;

  root.querySelector('#tox-scan')?.addEventListener('click', () => {
    runAction(async () => {
      const { id } = await send(MSG.PAGE_TOXICITY_SCAN);
      setState({ pageTox: { entryId: id } });
    });
  });
  root.querySelector('#tox-reveal')?.addEventListener('click', () => {
    runAction(async () => {
      await send(MSG.PAGE_REVEAL_ALL);
      setState({ pageTox: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Dark patterns (unchanged behaviour from Phase 4)
// ---------------------------------------------------------------------------

// Most serious first.
const ORDER = ['preselected', 'hidden_costs', 'confirmshaming', 'countdown', 'scarcity', 'activity', 'urgency'];

function scanDark() {
  setState({ dark: 'scanning', error: null });
  send(MSG.DARK_SCAN)
    .then((result) => setState({ dark: result }))
    .catch((err) => setState({ dark: { error: errorText(err) } }));
}

function renderDarkPatterns(root) {
  const d = state.dark;

  if (d === null) {
    root.innerHTML = `
      <h3>Dark patterns</h3>
      <p class="small">Look for tricks shopping sites use to pressure you: pre-ticked sign-up boxes,
         hidden subscription terms, fake countdowns, guilt-trip buttons and more.</p>
      <p class="muted small">Runs entirely in your browser. Free, and uses no coins.</p>
      <button id="dark-scan" class="primary">Find dark patterns</button>`;
    root.querySelector('#dark-scan').addEventListener('click', scanDark);
    return;
  }
  if (d === 'scanning') {
    root.innerHTML = '<h3>Dark patterns</h3><p class="muted">Scanning this page\u2026 (checking whether any timers are ticking)</p>';
    return;
  }
  if (d.error) {
    root.innerHTML = `
      <h3>Dark patterns</h3>
      <p class="muted">${h(d.error)}</p>
      <button id="dark-scan" class="secondary">Try again</button>`;
    root.querySelector('#dark-scan').addEventListener('click', scanDark);
    return;
  }

  const groups = {};
  for (const f of d.findings) (groups[f.category] ??= []).push(f);

  root.innerHTML = `
    <h3>Dark patterns</h3>
    ${
      d.total
        ? `<p><strong>${d.total} possible dark pattern${d.total === 1 ? '' : 's'}</strong>
             <span class="muted small">outlined on the page with dashed borders.</span></p>`
        : `<p><strong>No common dark patterns found.</strong></p>
           <p class="muted small">This scan checks wording, pre-ticked boxes, fine print and ticking timers.
             It can\u2019t catch every trick, so stay alert at checkout.</p>`
    }
    ${ORDER.filter((cat) => groups[cat])
      .map((cat) => {
        const items = groups[cat];
        return `
        <section class="finding-group">
          <h3><span class="sev sev-${items[0].severity}"></span>${h(items[0].label)} <span class="muted">(${items.length})</span></h3>
          <p class="muted small">${h(items[0].why)}</p>
          <ul class="finding-list">
            ${items
              .map(
                (f) => `
              <li>
                <span class="finding-snippet">\u201c${h(f.snippet)}\u201d</span>
                <button class="link" data-show="${f.id}">Show</button>
              </li>`,
              )
              .join('')}
          </ul>
        </section>`;
      })
      .join('')}
    <div class="row">
      <button id="dark-rescan" class="secondary">Scan again</button>
      ${d.total ? '<button id="dark-clear" class="link">Remove outlines</button>' : ''}
    </div>`;

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-show]');
    if (btn) send(MSG.DARK_LOCATE, { id: btn.dataset.show }).catch((err) => setState({ error: errorText(err) }));
  });
  root.querySelector('#dark-rescan').addEventListener('click', scanDark);
  root.querySelector('#dark-clear')?.addEventListener('click', () => {
    send(MSG.DARK_CLEAR)
      .then(() => setState({ dark: null }))
      .catch((err) => setState({ error: errorText(err) }));
  });
}

// ---------------------------------------------------------------------------

export function renderDark(root) {
  root.innerHTML = '<section id="tox-section" class="scan-section"></section><section id="dark-section" class="scan-section"></section>';
  renderToxic(root.querySelector('#tox-section'));
  renderDarkPatterns(root.querySelector('#dark-section'));
}