import { MSG, send } from '../../../shared/messages.js';
import { TASKS, TEXT_TASKS, canUse } from '../../../shared/tasks.js';
import { state, setState } from '../../state.js';
import { runAction, errorText, escapeHtml as h, coins } from '../../ui-helpers.js';
import { readUploads, UPLOAD_TYPES } from '../../uploads.js';

// The Images tab has two sources:
//   1. "Upload from your device": images the person picks from their computer.
//   2. The images on the current web page.
// Up to 5 images in total (from either source) can be analyzed at once.

const CATEGORIES = [
  ['photos', 'Photos'],
  ['graphics', 'Graphics'],
  ['icons', 'Icons & logos'],
  ['backgrounds', 'Background images'],
];
const MAX_SELECTED = 5;

/** In a normal browser tab (the upload fallback) there's no web page to scan. */
export const isStandalone = () => new URLSearchParams(location.search).has('standalone');

/** Scans the current page's images. Runs once per popup opening (or on Rescan). */
export function ensurePageImages(force = false) {
  if (isStandalone()) return;
  if (!force && state.pageImages !== null) return;
  state.pageImages = 'loading';
  state.selectedImages = state.selectedImages.filter((id) => id.startsWith('up-')); // keep chosen uploads
  send(MSG.PAGE_SCAN_IMAGES)
    .then((data) => setState({ pageImages: data }))
    .catch((err) => setState({ pageImages: { error: errorText(err) } }));
}

function thumb(img, selected) {
  const showable = /^(https?|data):/i.test(img.src);
  return `
    <div class="thumb ${selected ? 'selected' : ''}" data-id="${h(img.id)}"
         title="${h(img.alt || 'No description')} · ${img.width}×${img.height}">
      ${
        showable
          ? `<img src="${h(img.src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
          : `<span class="thumb-ph">${h(img.scheme)}</span>`
      }
      <button class="thumb-locate" data-locate="${h(img.id)}" title="Show on page" aria-label="Show on page">⌖</button>
      ${selected ? '<span class="thumb-check" aria-hidden="true">✓</span>' : ''}
    </div>`;
}

function uploadThumb(up, selected) {
  return `
    <div class="thumb ${selected ? 'selected' : ''}" data-id="${h(up.id)}" title="${h(up.name)}">
      <img src="${h(up.thumb)}" alt="${h(up.name)}" />
      <button class="thumb-remove" data-remove="${h(up.id)}" title="Remove" aria-label="Remove ${h(up.name)}">×</button>
      ${selected ? '<span class="thumb-check" aria-hidden="true">✓</span>' : ''}
    </div>`;
}

function uploadSection(pro, selected) {
  const list = state.uploads;
  return `
    <section class="upload-box" aria-labelledby="upload-head">
      <div class="row-between">
        <h3 id="upload-head" class="gallery-head">Upload from your device</h3>
        <button id="upload-btn" class="secondary small-btn" ${state.busy ? 'disabled' : ''}>Choose images…</button>
      </div>
      <input id="upload-input" type="file" accept="${UPLOAD_TYPES.join(',')}" multiple hidden />
      ${
        list.length
          ? `<div class="thumb-grid">${list.map((up) => uploadThumb(up, selected.has(up.id))).join('')}</div>`
          : `<p class="muted small">PNG, JPEG, WebP or GIF, up to 4 MB each.${pro ? '' : ' Analyzing them is a Pro feature.'}</p>`
      }
      ${state.uploadProblems.length ? `<ul class="upload-problems">${state.uploadProblems.map((p) => `<li>${h(p)}</li>`).join('')}</ul>` : ''}
      <p class="muted small upload-note">Uploads stay only while this window is open.${
        isStandalone() ? '' : ' If the popup closes when you choose a file, <button id="upload-in-tab" class="link">upload in a tab</button> instead.'
      }</p>
    </section>`;
}

function pageSection(data, selected) {
  if (isStandalone()) {
    return '<p class="muted small pad">Images on web pages can be analyzed from the Jachai popup.</p>';
  }
  if (data === null || data === 'loading') return '<p class="muted pad">Scanning images on this page…</p>';
  if (data.error) {
    return `
      <div class="empty-state">
        <p class="muted">${h(data.error)}</p>
        <button id="rescan" class="secondary">Try again</button>
      </div>`;
  }
  const groups = {};
  for (const img of data.images) (groups[img.category] ??= []).push(img);
  return `
    <div class="row-between page-images-head">
      <span class="muted small">${data.images.length} image${data.images.length === 1 ? '' : 's'} on this page</span>
      <button id="rescan" class="link">Rescan</button>
    </div>
    ${data.images.length === 0 ? '<p class="muted pad">No images found on this page.</p>' : ''}
    ${CATEGORIES.filter(([cat]) => groups[cat]?.length)
      .map(
        ([cat, label]) => `
        <h3 class="gallery-head">${label} <span class="muted">(${groups[cat].length})</span></h3>
        <div class="thumb-grid">${groups[cat].map((img) => thumb(img, selected.has(img.id))).join('')}</div>`,
      )
      .join('')}`;
}

function textTaskCost(task, locked) {
  const t = TASKS[task];
  if (locked) return 'PRO';
  if (t.runsOn === 'device') return 'free \u00b7 on-device';
  return coins(t.cost);
}

/** "Also check the text found in the image": nothing is picked until the person chooses. */
function textChecksSection(role) {
  return `
    <fieldset class="text-checks">
      <legend class="small">Also check the text found in the image</legend>
      <div class="task-grid compact" role="group" aria-label="Checks to run on the text found in the image">
        ${TEXT_TASKS.map((task) => {
          const locked = !canUse(task, role);
          const on = !locked && state.imageTextTasks.includes(task);
          return `
            <label class="task-toggle ${on ? 'on' : ''} ${locked ? 'locked' : ''}" title="${h(TASKS[task].label)}">
              <input type="checkbox" data-text-task="${task}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''} />
              <span class="task-name">${h(TASKS[task].short)}</span>
              <span class="task-cost">${textTaskCost(task, locked)}</span>
            </label>`;
        }).join('')}
      </div>
      <p class="muted small">The description and the text found in the image are always shown. These checks run only if the image has text; otherwise no coins are used for them.</p>
    </fieldset>`;
}

export function renderImages(root) {
  const data = state.pageImages;
  const { user, quota } = state.session;
  const pro = canUse('media', user.role);
  const pageImages = Array.isArray(data?.images) ? data.images : [];
  const known = new Set([...state.uploads.map((u) => u.id), ...pageImages.map((i) => i.id)]);
  const selected = new Set(state.selectedImages.filter((id) => known.has(id)));
  const textTasks = TEXT_TASKS.filter((t) => state.imageTextTasks.includes(t) && canUse(t, user.role));
  const perImageTextCost = textTasks.reduce((sum, t) => sum + TASKS[t].cost, 0);
  const cost = selected.size * (TASKS.media.cost + perImageTextCost); // the most it can cost
  const upTo = perImageTextCost > 0 ? 'up to ' : '';
  const overBudget = quota.limit !== null && cost > quota.remaining;
  const anything = state.uploads.length > 0 || pageImages.length > 0;

  root.innerHTML = `
    <div class="images">
      ${uploadSection(pro, selected)}
      ${pageSection(data, selected)}
      ${
        anything
          ? `<div class="gallery-actions">
              ${
                pro
                  ? `${textChecksSection(user.role)}
                    <button id="analyze-images" class="primary full" ${selected.size === 0 || overBudget || state.busy ? 'disabled' : ''}>
                      ${
                        selected.size
                          ? `Analyze ${selected.size} image${selected.size === 1 ? '' : 's'} \u00b7 ${upTo}${coins(cost)}`
                          : `Tap up to ${MAX_SELECTED} images to analyze them`
                      }
                    </button>
                    ${overBudget ? '<p class="error">Not enough coins left today.</p>' : ''}`
                  : `<p class="muted small">Tap a page image to find it on the page. Analyzing images is a Pro feature.
                     <button id="images-upgrade" class="link">Upgrade</button></p>`
              }
            </div>`
          : ''
      }
    </div>
  `;

  const locate = (id) => send(MSG.PAGE_LOCATE_IMAGE, { id }).catch((err) => setState({ error: errorText(err) }));

  // ---- Uploading ----
  const input = root.querySelector('#upload-input');
  root.querySelector('#upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = ''; // so choosing the same file again still fires "change"
    if (!files.length) return;
    const { accepted, problems } = await readUploads(files, state.uploads.length);
    // Newly added uploads are selected straight away, while there's room.
    const room = Math.max(0, MAX_SELECTED - state.selectedImages.length);
    const autoSelect = pro ? accepted.slice(0, room).map((u) => u.id) : [];
    setState({
      uploads: [...state.uploads, ...accepted],
      uploadProblems: problems,
      selectedImages: [...state.selectedImages, ...autoSelect],
      error: null,
    });
  });
  root.querySelector('#upload-in-tab')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?standalone=1#images') });
    window.close();
  });

  root.querySelector('#rescan')?.addEventListener('click', () => {
    ensurePageImages(true);
    setState({ error: null });
  });
  root.querySelector('#images-upgrade')?.addEventListener('click', () => setState({ view: 'upgrade' }));

  root.querySelector('.images').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      e.stopPropagation();
      const id = removeBtn.dataset.remove;
      setState({
        uploads: state.uploads.filter((u) => u.id !== id),
        selectedImages: state.selectedImages.filter((x) => x !== id),
        uploadProblems: [],
        error: null,
      });
      return;
    }
    const locateBtn = e.target.closest('[data-locate]');
    if (locateBtn) {
      e.stopPropagation();
      locate(locateBtn.dataset.locate);
      return;
    }
    const tile = e.target.closest('.thumb');
    if (!tile) return;
    const id = tile.dataset.id;
    const isUpload = id.startsWith('up-');
    if (!pro) {
      if (!isUpload) locate(id);
      return;
    }
    if (selected.has(id)) {
      setState({ selectedImages: state.selectedImages.filter((x) => x !== id), error: null });
    } else if (selected.size >= MAX_SELECTED) {
      setState({ error: `You can analyze up to ${MAX_SELECTED} images at a time.` });
    } else {
      setState({ selectedImages: [...state.selectedImages.filter((x) => known.has(x)), id], error: null });
    }
  });

  root.querySelector('.text-checks')?.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-text-task]');
    if (!box) return;
    const others = state.imageTextTasks.filter((t) => t !== box.dataset.textTask);
    setState({ imageTextTasks: box.checked ? [...others, box.dataset.textTask] : others });
  });

  root.querySelector('#analyze-images')?.addEventListener('click', () => {
    const chosenPage = pageImages.filter((img) => selected.has(img.id));
    const chosenUploads = state.uploads.filter((up) => selected.has(up.id));
    runAction(async () => {
      for (const up of chosenUploads) {
        await send(MSG.ANALYZE_UPLOAD, { imageData: up.data, mimeType: up.mimeType, fileName: up.name, thumb: up.thumb, textTasks });
      }
      for (const img of chosenPage) await send(MSG.ANALYZE_IMAGE, { src: img.src, textTasks });
      setState({ selectedImages: [], tab: 'results' });
    });
  });
}
