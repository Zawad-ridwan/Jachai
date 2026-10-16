import { ApiError } from '../shared/api.js';
import { TASKS, TEXT_TASKS, MAX_TEXT, canUse, detectLanguage } from '../shared/tasks.js';
import { authed, refreshSession } from './api-client.js';
import { getSession } from './session.js';
import { addResult, updateResult, getResult } from './results.js';
import { mediaInput, darkScan, collectBlocks } from './page-tools.js';
import { pushToPage, blurBlocksOnPage } from './on-page.js';

// Each analysis creates a result entry straight away ("running") and fills it
// in when finished, so the popup can show progress and results live.
// Entries that started from something on a web page carry an "anchor"
// (tab, frame, target); their progress and result are also shown on the page.
//
// The jargon simplifier is different: Chrome's on-device AI can only run in a
// page (not in this background worker) and its first use must start from a
// click, so its entry waits in the "device" state until the popup runs it.

const codeOf = (err) => (err instanceof ApiError ? err.code : 'internal_error');

async function requireAccess(task) {
  const session = await getSession();
  if (!session?.token) throw new ApiError(401, 'auth_required', null);
  if (!canUse(task, session.user.role)) throw new ApiError(403, 'pro_required', null);
}

/**
 * Runs the work for an entry and records how it went. Never throws.
 * `onDone(data)` (optional) runs after a successful result is saved, e.g. the
 * text checks the person chose for an image's extracted text.
 */
async function settle(entry, work, onDone = null) {
  try {
    const data = await work();
    const saved = await updateResult(entry.id, { status: 'done', data, progress: null, error: null });
    pushToPage(saved);
    if (onDone) await onDone(saved ?? entry, data).catch((err) => console.error('[Jachai]', err));
  } catch (err) {
    const code = codeOf(err);
    if (code === 'internal_error') console.error('[Jachai]', err);
    pushToPage(await updateResult(entry.id, { status: 'error', error: code, progress: null }));
  } finally {
    refreshSession().catch(() => {}); // pick up the new coin balance
  }
}

/** For failures that happen before an entry exists (e.g. nothing was selected). */
export function recordFailure({ task, source, page, err, parentId = null }) {
  return addResult({ task, source, page: page ?? null, status: 'error', error: codeOf(err), preview: null, ...(parentId ? { parentId } : {}) });
}

// ---------------------------------------------------------------------------
// Text checks on the text found in an image
// ---------------------------------------------------------------------------

/** Keeps only real text checks, once each, in the usual order. */
export const cleanTextTasks = (list) => (Array.isArray(list) ? TEXT_TASKS.filter((t) => list.includes(t)) : []);

/**
 * After an image is analyzed, run the text checks the person picked on the
 * text found in it. Each check is its own result, linked to the image with
 * parentId, and goes through the normal text-check path, so the server still
 * decides who may use it and charges its coins. With no readable text, nothing
 * runs and nothing is charged.
 */
function imageTextFollowUp(textTasks) {
  const tasks = cleanTextTasks(textTasks);
  if (!tasks.length) return null;
  return async (image, data) => {
    const text = String(data?.result?.extractedText ?? '').trim();
    if (!text) {
      await updateResult(image.id, { textChecks: { tasks, skipped: 'no_text' } });
      return;
    }
    await updateResult(image.id, { textChecks: { tasks } });
    for (const task of tasks) {
      await analyzeText({ task, text, source: 'image_text', page: image.page ?? null, parentId: image.id }).catch((err) =>
        recordFailure({ task, source: 'image_text', page: image.page ?? null, parentId: image.id, err }),
      );
    }
  };
}

/** Only include a pre-chosen id if there is one (a right-click marks the page with it before the entry exists). */
const withId = (id) => (id ? { id } : {});

export async function analyzeText({ task, text, source, page = null, id = null, anchor = null, parentId = null }) {
  if (TASKS[task]?.input !== 'text') throw new ApiError(400, 'unknown_task', null);
  let clean = String(text ?? '').replace(/\u0000/g, '').trim();
  if (!clean) throw new ApiError(400, 'nothing_selected', null);
  const truncated = clean.length > MAX_TEXT;
  if (truncated) clean = clean.slice(0, MAX_TEXT);

  const common = {
    ...withId(id),
    task,
    source,
    page,
    anchor,
    ...(parentId ? { parentId } : {}), // a check on the text found in an image
    language: detectLanguage(clean),
    preview: { kind: 'text', text: clean.slice(0, 280), length: clean.length, truncated },
  };

  if (TASKS[task].runsOn === 'device') {
    await requireAccess(task);
    // The full text is kept (in memory only) so the popup can run it on-device or in the cloud.
    const waiting = await addResult({ ...common, status: 'device', input: { text: clean } });
    pushToPage(waiting);
    return waiting;
  }

  const entry = await addResult({ ...common, status: 'running' });
  pushToPage(entry);
  settle(entry, async () => {
    await requireAccess(task);
    return authed(`/analyze/${task}`, { method: 'POST', body: { text: clean } });
  });
  return entry;
}

export async function analyzeImage({ tabId, frameId, src, mediaType = 'image', source, page = null, id = null, anchor = null, textTasks = [] }) {
  const entry = await addResult({
    ...withId(id),
    task: 'media',
    source,
    page,
    anchor,
    status: 'running',
    preview: { kind: 'image', mediaType, src: /^https?:\/\//i.test(src ?? '') ? src : null },
  });
  pushToPage(entry);

  settle(entry, async () => {
    await requireAccess('media'); // check before touching the page
    const input = await mediaInput({ tabId, frameId, src, mediaType });
    return authed('/analyze/media', { method: 'POST', body: input });
  }, imageTextFollowUp(textTasks));
  return entry;
}

const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_UPLOAD_BASE64 = 5_600_000; // about 4 MB of image bytes, same as the server
const MAX_THUMB_CHARS = 120_000;

/**
 * An image the person uploaded from their device (Images tab). Only a small
 * JPEG preview is kept with the result; the full image goes to the server once.
 */
export async function analyzeUpload({ imageData, mimeType, fileName, thumb, textTasks = [] }) {
  const name = String(fileName ?? 'image').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'image';
  const preview = typeof thumb === 'string' && thumb.startsWith('data:image/jpeg;base64,') && thumb.length <= MAX_THUMB_CHARS ? thumb : null;
  const entry = await addResult({
    task: 'media',
    source: 'upload',
    page: null,
    status: 'running',
    preview: { kind: 'image', mediaType: 'upload', src: preview, name },
  });
  settle(entry, async () => {
    await requireAccess('media');
    if (!UPLOAD_TYPES.has(mimeType) || typeof imageData !== 'string' || !imageData) throw new ApiError(400, 'invalid_image', null);
    if (imageData.length > MAX_UPLOAD_BASE64) throw new ApiError(413, 'image_too_large', null);
    return authed('/analyze/media', { method: 'POST', body: { imageData, mimeType } });
  }, imageTextFollowUp(textTasks));
  return entry;
}

export async function analyzePageDarkPatterns({ tabId, source, page = null }) {
  const entry = await addResult({
    task: 'dark_patterns',
    source,
    page,
    status: 'running',
    preview: { kind: 'page', title: page?.title ?? '' },
  });
  settle(entry, async () => {
    await requireAccess('dark_patterns');
    return darkScan(tabId);
  });
  return entry;
}

/**
 * Whole-page toxicity scan: collect up to 30 passages, score them all in one
 * server request, then blur the flagged ones on the page.
 */
export async function analyzePageToxicity({ tabId, source, page = null, anchor = null }) {
  const entry = await addResult({
    task: 'toxicity_page',
    source,
    page,
    anchor,
    status: 'running',
    preview: { kind: 'page', title: page?.title ?? '' },
  });
  pushToPage(entry);

  settle(entry, async () => {
    await requireAccess('toxicity_page');
    const { blocks } = await collectBlocks(tabId);
    if (!blocks.length) throw new ApiError(0, 'nothing_to_scan', null);
    const data = await authed('/analyze/toxicity_page', { method: 'POST', body: { blocks: blocks.map((b) => b.text) } });
    const flagged = (data?.result?.blocks ?? [])
      .map((f) => ({ index: blocks[f.index]?.index, label: f.label }))
      .filter((f) => f.index != null);
    if (flagged.length) await blurBlocksOnPage(tabId, flagged);
    return data;
  });
  return entry;
}

// ---------------------------------------------------------------------------
// Jargon simplifier: cloud run, and progress reports from the on-device run
// ---------------------------------------------------------------------------

async function jargonEntry(id) {
  const entry = await getResult(id);
  if (!entry || entry.task !== 'jargon' || !entry.input?.text) throw new ApiError(404, 'not_found', null);
  return entry;
}

export async function runJargonInCloud(id) {
  const entry = await jargonEntry(id);
  if (entry.status === 'running' || entry.status === 'done') return { id };
  pushToPage(await updateResult(id, { status: 'running', runner: 'cloud', progress: null, error: null }));
  settle(entry, async () => {
    await requireAccess('jargon');
    return authed('/analyze/jargon', { method: 'POST', body: { text: entry.input.text } });
  });
  return { id };
}

const DEVICE_ERRORS = new Set([
  'device_unsupported', 'device_language_unsupported', 'device_failed', 'device_needs_click', 'device_text_too_long',
]);

const showOnPage = (entry) => {
  pushToPage(entry);
  return entry;
};

/** The popup reports each stage of an on-device run here; only safe, expected values are stored. */
export async function applyDeviceUpdate({ id, status, progress, result, error }) {
  await jargonEntry(id);
  if (status === 'running') {
    const pct = Number(progress);
    return showOnPage(await updateResult(id, {
      status: 'running',
      runner: 'device',
      progress: Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct))) : null,
      error: null,
    }));
  }
  if (status === 'done') {
    const simplified = String(result?.simplified ?? '').trim().slice(0, 4000);
    if (!simplified) throw new ApiError(400, 'invalid_text', null);
    return showOnPage(await updateResult(id, {
      status: 'done',
      runner: 'device',
      progress: null,
      error: null,
      data: { result: { simplified, keyPoints: [], watchOutFor: [], via: 'device' } },
    }));
  }
  if (status === 'device') {
    return showOnPage(await updateResult(id, {
      status: 'device',
      runner: null,
      progress: null,
      error: DEVICE_ERRORS.has(error) ? error : 'device_failed',
    }));
  }
  throw new ApiError(400, 'not_found', null);
}