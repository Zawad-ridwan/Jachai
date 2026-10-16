import { buildCard } from './card-model.js';
import { ensureOverlay, overlayCall } from './page-tools.js';

// Sends results to the web page they came from. Every call here is
// best-effort: if the tab was closed or navigated away, the result still
// lives in the popup's Results tab, so failures are ignored quietly.

/**
 * Show or update the floating card for a result that started from the page.
 *
 * Checks on highlighted text are the exception: their result appears only in
 * the extension popup (which opens by itself), so no card is drawn next to the
 * text. If a toxicity check flags the passage, it is still blurred on the page.
 */
export async function pushToPage(entry) {
  if (!entry?.anchor) return;
  const { tabId, frameId = 0 } = entry.anchor;
  try {
    if (entry.source === 'selection') {
      const blur = entry.status === 'done' ? buildCard(entry)?.blur : null;
      if (!blur) return;
      await ensureOverlay(tabId, frameId);
      await overlayCall(tabId, frameId, 'blurTarget', [entry.id, blur.label]);
      return;
    }
    await ensureOverlay(tabId, frameId);
    await overlayCall(tabId, frameId, 'render', [buildCard(entry)]);
  } catch {
    /* page gone; the Results tab still has it */
  }
}

/** Blur the passages a whole-page scan flagged. */
export async function blurBlocksOnPage(tabId, blocks) {
  await ensureOverlay(tabId, 0);
  return overlayCall(tabId, 0, 'blurBlocks', [blocks]);
}

/** Un-blur everything and remove all badges on the current page. */
export async function revealAllOnPage(tabId) {
  await ensureOverlay(tabId, 0);
  return (await overlayCall(tabId, 0, 'revealAll', [])) ?? 0;
}