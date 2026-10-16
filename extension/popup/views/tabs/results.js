import { MSG, send } from '../../../shared/messages.js';
import { TASKS, TEXT_TASKS, LANGUAGE_LABEL } from '../../../shared/tasks.js';
import { state, setState } from '../../state.js';
import { runAction, errorText, escapeHtml as h, clip, fmtTimeAgo, coins } from '../../ui-helpers.js';
import { renderFinished } from './renderers.js';
import { simplifyOnDevice, deviceAiPresent } from '../../ondevice.js';

const SOURCE_LABEL = {
  paste: 'Pasted text',
  selection: 'Selected text',
  gallery: 'Image from this page',
  menu: 'Right-clicked on the page',
  page_scan: 'Whole-page scan',
  upload: 'Uploaded from your device',
  image_text: 'Text found in an image',
};

const STALE_MS = 90_000; // an on-device run with no news for this long was interrupted (popup closed)
const autoTried = new Set();

function preview(r) {
  const p = r.preview;
  if (!p) return '';
  if (p.kind === 'text') {
    const lang = LANGUAGE_LABEL[r.language];
    return `
      <details class="source-text">
        <summary class="muted small">${lang ? `<span class="pill">${lang}</span>` : ''}${p.length.toLocaleString()} characters${
          p.truncated ? ' (only the first 5,000 were checked)' : ''
        }</summary>
        <blockquote>${h(p.text)}${p.length > p.text.length ? '\u2026' : ''}</blockquote>
      </details>`;
  }
  if (p.kind === 'image') {
    const caption = p.name ? `<p class="muted small upload-name">\u{1F4C1} Uploaded: ${h(p.name)}</p>` : '';
    return p.src
      ? `<img class="result-thumb" src="${h(p.src)}" alt="" referrerpolicy="no-referrer" />${caption}`
      : caption ||
          `<p class="muted small">${p.mediaType === 'video' ? 'A frame from a video' : 'An image from the page'}</p>`;
  }
  return '';
}

const isStaleDeviceRun = (r) =>
  r.status === 'running' && r.runner === 'device' && Date.now() - new Date(r.updatedAt ?? r.createdAt).getTime() > STALE_MS;

function jargonControls(r) {
  if (r.status === 'running' && !isStaleDeviceRun(r)) {
    if (r.runner === 'cloud') return '<p class="status running"><span class="spinner"></span> Simplifying in the cloud\u2026</p>';
    return `<p class="status running"><span class="spinner"></span> ${
      r.progress != null && r.progress < 100
        ? `Downloading the on-device AI (first time only): ${r.progress}%`
        : 'Simplifying on your device\u2026'
    }</p>`;
  }

  const { quota } = state.session;
  const cloudCost = TASKS.jargon.cloudCost;
  const canAffordCloud = quota.limit === null || quota.remaining >= cloudCost;
  const note = r.error ? `<p class="status error">${h(errorText({ message: r.error }))}</p>` : '';
  const deviceBlocked = ['device_unsupported', 'device_language_unsupported'].includes(r.error) || !deviceAiPresent();

  return `${note}
    <div class="row">
      ${deviceBlocked ? '' : `<button class="primary" data-jargon-device="${h(r.id)}">Simplify on this device \u00b7 free</button>`}
      <button class="secondary" data-jargon-cloud="${h(r.id)}" ${canAffordCloud ? '' : 'disabled'}>Use the cloud \u00b7 ${coins(cloudCost)}</button>
    </div>
    ${deviceBlocked ? '' : '<p class="muted small">On-device keeps the text on your computer. The first run downloads Chrome\u2019s built-in AI model.</p>'}`;
}

function outcome(r) {
  if (r.task === 'jargon' && r.status !== 'done') return jargonControls(r);
  switch (r.status) {
    case 'running':
      return '<p class="status running"><span class="spinner"></span> Analyzing\u2026</p>';
    case 'error':
      return `<p class="status error">${h(errorText({ message: r.error }))}</p>`;
    case 'done':
      return renderFinished(r);
    default:
      return '';
  }
}

/** The checks run on an image's text: nested under the image's own result. */
function textChecksBlock(r, children) {
  const tc = r.textChecks;
  if (!tc && !children.length) return '';
  if (tc?.skipped === 'no_text') {
    return `<div class="image-text-checks"><p class="muted small">No readable text in the image, so the selected checks were skipped. No coins were used for them.</p></div>`;
  }
  const order = (x) => TEXT_TASKS.indexOf(x.task);
  const sorted = [...children].sort((a, b) => order(a) - order(b));
  const waiting = (tc?.tasks ?? []).filter((t) => !children.some((c) => c.task === t));
  return `
    <div class="image-text-checks">
      <p class="small"><strong>Checks on the text in this image</strong></p>
      <ul class="child-results">
        ${sorted.map((c) => resultItem(c, [], true)).join('')}
        ${waiting.map((t) => `<li class="result-card child"><div class="result-head"><strong>${h(TASKS[t]?.label ?? t)}</strong></div><p class="status running"><span class="spinner"></span> Waiting\u2026</p></li>`).join('')}
      </ul>
    </div>`;
}

function resultItem(r, children = [], nested = false) {
  const task = TASKS[r.task];
  const where = nested ? '' : SOURCE_LABEL[r.source] ?? '';
  const onPage = !nested && r.page?.title ? ` on \u201c${h(clip(r.page.title, 40))}\u201d` : '';
  return `
    <li class="result-card status-${h(r.status)} ${nested ? 'child' : ''}">
      <div class="result-head">
        <strong>${nested ? `Text \u2192 ${h(task?.short ?? r.task)}` : h(task?.label ?? r.task)}</strong>
        <span class="muted small">${fmtTimeAgo(r.createdAt)}</span>
      </div>
      ${where || onPage ? `<p class="muted small">${h(where)}${onPage}</p>` : ''}
      ${nested ? '' : preview(r)}
      ${outcome(r)}
      ${nested ? '' : textChecksBlock(r, children)}
    </li>`;
}

/**
 * Top-level results, each with the text checks that belong to it. A text check
 * whose image result is gone (e.g. dropped from the list) is shown on its own.
 */
function grouped(list) {
  const ids = new Set(list.map((r) => r.id));
  const children = new Map();
  for (const r of list) {
    if (r.parentId && ids.has(r.parentId)) {
      if (!children.has(r.parentId)) children.set(r.parentId, []);
      children.get(r.parentId).push(r);
    }
  }
  return list.filter((r) => !(r.parentId && ids.has(r.parentId))).map((r) => resultItem(r, children.get(r.id) ?? []));
}

/** A jargon request that just arrived from the right-click menu is started automatically once. */
function autoStartFreshJargon(list) {
  for (const r of list) {
    if (r.task !== 'jargon' || r.status !== 'device' || r.error || autoTried.has(r.id)) continue;
    if (Date.now() - new Date(r.createdAt).getTime() > 15_000 || !r.input?.text) continue;
    autoTried.add(r.id);
    if (deviceAiPresent()) simplifyOnDevice(r.id, r.input.text, r.language);
  }
}

export function renderResults(root) {
  const list = state.results;

  if (!list.length) {
    root.innerHTML = `
      <div class="empty-state">
        <p class="muted">Results from the paste box, the image gallery and the right-click menu appear here.</p>
        <p class="muted small">Tip: highlight text on any page, right-click, and choose <strong>Jachai</strong>.</p>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="results">
      <div class="row-between">
        <span class="muted small">Kept until you close Chrome or sign out.</span>
        <button id="clear-results" class="link">Clear all</button>
      </div>
      <ul class="result-list">${grouped(list).join('')}</ul>
    </div>
  `;

  root.querySelector('#clear-results').addEventListener('click', () => {
    runAction(async () => {
      await send(MSG.RESULTS_CLEAR);
      setState({ results: [] });
    });
  });

  root.querySelector('.result-list').addEventListener('click', (e) => {
    const deviceBtn = e.target.closest('[data-jargon-device]');
    const cloudBtn = e.target.closest('[data-jargon-cloud]');
    if (deviceBtn) {
      const entry = state.results.find((r) => r.id === deviceBtn.dataset.jargonDevice);
      if (entry?.input?.text) simplifyOnDevice(entry.id, entry.input.text, entry.language);
    } else if (cloudBtn) {
      runAction(() => send(MSG.JARGON_CLOUD, { id: cloudBtn.dataset.jargonCloud }));
    }
  });

  autoStartFreshJargon(list);
}