import { ApiError } from '../shared/api.js';

// Everything Jachai does inside a web page happens here, on demand.
// There is no content script running on every site: code is injected only
// when the person opens the popup or uses the right-click menu, which is
// what Chrome's "activeTab" permission allows.
//
// Functions passed to executeScript are copied into the page and run there,
// so each one must be completely self-contained.

export const PAGE_CSS = `
[data-ms-dark] { outline: 2px dashed #f59e0b !important; outline-offset: 3px !important; }
[data-ms-dark="preselected"], [data-ms-dark="hidden_costs"], [data-ms-dark="confirmshaming"] {
  outline-color: #dc2626 !important;
}
[data-ms-flash] {
  outline: 3px solid #2f5bea !important; outline-offset: 3px !important;
  box-shadow: 0 0 0 6px rgba(47, 91, 234, .28) !important;
}
.ms-shield-toxic-blur {
  filter: blur(8px) !important; cursor: pointer !important; user-select: none !important;
  transition: filter .15s ease !important;
}
.ms-shield-toxic-blur * { pointer-events: none !important; }`;

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new ApiError(0, 'no_active_tab', null);
  return tab;
}

async function exec(tabId, func, args = [], frameId) {
  const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
  try {
    const [first] = await chrome.scripting.executeScript({ target, func, args });
    return first?.result;
  } catch (err) {
    throw new ApiError(0, 'page_not_accessible', { detail: String(err?.message ?? err) });
  }
}

/** Adds the outline and blur styles. insertCSS isn't blocked by a site's own security policy. */
async function ensureCss(tabId, frameId) {
  const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
  await chrome.scripting.removeCSS({ target, css: PAGE_CSS }).catch(() => {});
  await chrome.scripting.insertCSS({ target, css: PAGE_CSS }).catch(() => {});
}

const digits = (id) => String(id ?? '').replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Functions that run inside the page
// ---------------------------------------------------------------------------

/**
 * Right-click moment: remember where the selected text (or media) is, so the
 * result card can appear next to it and a harmful passage can be blurred.
 * Only a reasonably tight block around the selection is marked for blurring,
 * never a whole page section.
 */
function markTargetInPage(entryId, kind, src) {
  const anchors = (globalThis.__msAnchors ??= new Map());
  let el = null;
  let rect = null;
  let text = '';

  if (kind === 'selection') {
    const sel = window.getSelection?.();
    text = String(sel ?? '');
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      rect = range.getBoundingClientRect();
      let node = range.commonAncestorContainer;
      if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
      const block = node?.closest('p,li,blockquote,dd,td,h1,h2,h3,h4,h5,h6,article,section,div') ?? node;
      const blockLength = (block?.innerText ?? '').length;
      const tightEnough = blockLength <= Math.max(text.length * 3, text.length + 400);
      const editable = block?.closest('[contenteditable="true"],input,textarea');
      if (block && tightEnough && !editable && block !== document.body && block !== document.documentElement) el = block;
    }
  } else if (kind === 'media') {
    el = [...document.querySelectorAll('img,video')].find((m) => src && (m.currentSrc === src || m.src === src || m.poster === src)) ?? null;
    if (el) rect = el.getBoundingClientRect();
  }

  if (el) el.setAttribute('data-ms-target', entryId);
  if (rect && (rect.width || rect.height)) {
    anchors.set(entryId, {
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      bottom: rect.bottom + window.scrollY,
      right: rect.right + window.scrollX,
    });
  }
  return { text, anchored: anchors.has(entryId) };
}

/**
 * Whole-page toxicity scan: find up to 30 readable passages (comments, posts,
 * paragraphs, list items), preferring what's on screen, and number them so
 * flagged ones can be found again. Menus, headers, footers and forms are skipped.
 */
function collectTextBlocks(limit) {
  document.querySelectorAll('[data-ms-block]').forEach((el) => el.removeAttribute('data-ms-block'));
  if (!document.body) return { blocks: [] };

  const SKIP = 'script,style,noscript,template,nav,header,footer,form,button,select,textarea,code,pre,ms-shield-card,ms-shield-badge,[contenteditable="true"],[aria-hidden="true"]';
  const selector = 'p,li,blockquote,dd,h1,h2,h3,[class*="comment" i],[class*="message" i],[class*="post" i],[role="article"],article';
  const candidates = [];
  for (const el of document.body.querySelectorAll(selector)) {
    if (candidates.length >= limit * 4) break;
    if (el.closest(SKIP) || el.classList.contains('ms-shield-toxic-blur')) continue;
    const text = (el.innerText ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 15 || text.length > 600) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 8) continue;
    candidates.push({ el, text, onScreen: r.bottom > 0 && r.top < window.innerHeight, top: r.top });
  }
  // Keep the most specific passages: a comment list that contains individual comments is dropped
  // in favour of the comments, so blurring one harmful comment never hides its harmless neighbours.
  const chosen = candidates.filter((c) => !candidates.some((o) => o !== c && c.el.contains(o.el)));
  chosen.sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.top - b.top);
  const picked = chosen.slice(0, limit);
  picked.forEach((c, i) => c.el.setAttribute('data-ms-block', String(i)));
  return { blocks: picked.map((c, i) => ({ index: i, text: c.text })) };
}

function scanPageImages() {
  const LIMIT = 150;
  const out = [];
  const seen = new Set();
  let next = 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const visible = (el, r) => {
    if (r.width < 8 || r.height < 8) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const categorize = (w, h, src) => {
    if (/\.svg(?:[?#]|$)/i.test(src) || src.startsWith('data:image/svg')) return 'icons';
    const side = Math.min(w, h);
    if (side >= 200) return 'photos';
    if (side >= 64) return 'graphics';
    return 'icons';
  };
  const add = (el, src, isBackground, r, alt, nw, nh) => {
    if (!src || seen.has(src) || out.length >= LIMIT) return;
    if (src.startsWith('data:') && src.length > 1_000_000) return;
    seen.add(src);
    const id = String(++next);
    el.setAttribute('data-ms-img', id);
    const w = Math.round(nw || r.width);
    const h = Math.round(nh || r.height);
    out.push({
      id,
      src,
      alt: String(alt || '').trim().slice(0, 140),
      width: w,
      height: h,
      category: isBackground ? 'backgrounds' : categorize(w, h, src),
      scheme: src.split(':')[0].toLowerCase(),
      inViewport: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
    });
  };

  document.querySelectorAll('[data-ms-img]').forEach((el) => el.removeAttribute('data-ms-img'));

  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    if (!visible(img, r)) continue;
    add(img, img.currentSrc || img.src, false, r, img.alt || img.title, img.naturalWidth, img.naturalHeight);
  }

  // Large CSS background images (hero banners, product tiles).
  let checked = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (++checked > 4000 || out.length >= LIMIT) break;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.includes('url(')) continue;
    const m = bg.match(/url\((['"]?)(.*?)\1\)/);
    if (!m) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 100 || !visible(el, r)) continue;
    let src;
    try {
      src = new URL(m[2], document.baseURI).href;
    } catch {
      continue;
    }
    add(el, src, true, r, el.getAttribute('aria-label'), 0, 0);
  }

  out.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || b.width * b.height - a.width * a.height);
  return { title: document.title, url: location.href, images: out };
}

function flashElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  el.setAttribute('data-ms-flash', '');
  setTimeout(() => el.removeAttribute('data-ms-flash'), 1800);
  return true;
}

/** Reads an image the page can reach (including blob: and data: URLs) as base64. */
async function readImageFromPage(src) {
  try {
    const res = await fetch(src);
    if (!res.ok) return { error: 'image_unreadable' };
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return { error: 'invalid_image' };
    if (blob.size > 4_000_000) return { error: 'image_too_large' };
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return { imageData: dataUrl.split(',')[1], mimeType: blob.type };
  } catch {
    return { error: 'image_unreadable' };
  }
}

/** Grabs the current frame of the right-clicked video as a JPEG. */
function captureVideoFrame(srcUrl) {
  const videos = [...document.querySelectorAll('video')];
  const video =
    videos.find((v) => srcUrl && (v.currentSrc === srcUrl || v.src === srcUrl)) ??
    videos.find((v) => !v.paused) ??
    videos[0];
  if (!video || !video.videoWidth) return { error: 'video_not_ready' };

  const scale = Math.min(1, 1280 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { imageData: dataUrl.split(',')[1], mimeType: 'image/jpeg' };
  } catch {
    // Videos from other sites can't be copied; fall back to the poster image if there is one.
    return video.poster ? { imageUrl: video.poster } : { error: 'video_protected' };
  }
}

// ---------------------------------------------------------------------------
// Service-worker side
// ---------------------------------------------------------------------------

export async function markTarget(tabId, frameId, entryId, kind, src) {
  return exec(tabId, markTargetInPage, [entryId, kind, src ?? ''], frameId);
}

export async function collectBlocks(tabId, limit = 30) {
  return (await exec(tabId, collectTextBlocks, [limit])) ?? { blocks: [] };
}

/** Loads the on-page overlay (cards, blur, badges) into a page or frame. Safe to call repeatedly. */
export async function ensureOverlay(tabId, frameId = 0) {
  await ensureCss(tabId, frameId);
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content/overlay.js'] });
  } catch (err) {
    throw new ApiError(0, 'page_not_accessible', { detail: String(err?.message ?? err) });
  }
}

/** Calls one of the overlay's functions (render, blurTarget, blurBlocks, revealAll) inside the page. */
export async function overlayCall(tabId, frameId, method, args = []) {
  return exec(tabId, (name, list) => globalThis.__msOverlay?.[name]?.(...list), [method, args], frameId);
}

export async function scanImages() {
  const tab = await activeTab();
  const data = await exec(tab.id, scanPageImages);
  if (!data) throw new ApiError(0, 'page_not_accessible', null);
  return data;
}

export async function locateImage(id) {
  const tab = await activeTab();
  await ensureCss(tab.id);
  return { found: Boolean(await exec(tab.id, flashElement, [`[data-ms-img="${digits(id)}"]`])) };
}

/**
 * Turns a right-clicked or selected image/video into something the server can
 * analyze: image bytes when the page can read them, otherwise the image's URL.
 */
export async function mediaInput({ tabId, frameId, src, mediaType }) {
  if (mediaType === 'video') {
    const r = await exec(tabId, captureVideoFrame, [src ?? ''], frameId);
    if (!r || r.error) throw new ApiError(0, r?.error ?? 'image_unreadable', null);
    return r.imageUrl ? { imageUrl: r.imageUrl } : { imageData: r.imageData, mimeType: r.mimeType };
  }
  if (!src) throw new ApiError(0, 'image_unreadable', null);
  const r = await exec(tabId, readImageFromPage, [src], frameId).catch(() => null);
  if (r?.imageData) return { imageData: r.imageData, mimeType: r.mimeType };
  if (/^https?:\/\//i.test(src)) return { imageUrl: src }; // the server fetches it instead
  throw new ApiError(0, r?.error ?? 'image_unreadable', null);
}

export async function darkScan(tabId) {
  await ensureCss(tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/dark-patterns.js'] });
  } catch (err) {
    throw new ApiError(0, 'page_not_accessible', { detail: String(err?.message ?? err) });
  }
  const result = await exec(tabId, () => globalThis.__msDark?.scan());
  if (!result) throw new ApiError(0, 'page_not_accessible', null);
  return result;
}

export async function darkClear(tabId) {
  await exec(tabId, () => globalThis.__msDark?.clear() ?? 0).catch(() => {});
  await chrome.scripting.removeCSS({ target: { tabId }, css: PAGE_CSS }).catch(() => {});
}

export async function darkLocate(tabId, id) {
  await ensureCss(tabId);
  return { found: Boolean(await exec(tabId, flashElement, [`[data-ms-dark-id="${digits(id)}"]`])) };
}