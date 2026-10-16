import { ApiError } from '../shared/api.js';
import { TASKS, TEXT_TASKS } from '../shared/tasks.js';
import { analyzeText, analyzeImage, analyzePageDarkPatterns, analyzePageToxicity, recordFailure } from './analysis.js';
import { markTarget } from './page-tools.js';

const ROOT = 'ms-root';

/** Right-click menu: Jachai > [check]. Called on install and update. */
export function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: ROOT, title: 'Jachai', contexts: ['selection', 'image', 'video', 'page'] });
    for (const task of TEXT_TASKS) {
      chrome.contextMenus.create({ id: `text:${task}`, parentId: ROOT, title: TASKS[task].menu, contexts: ['selection'] });
    }
    chrome.contextMenus.create({ id: 'media', parentId: ROOT, title: TASKS.media.menu, contexts: ['image', 'video'] });
    chrome.contextMenus.create({ id: 'toxic_page', parentId: ROOT, title: TASKS.toxicity_page.menu, contexts: ['page'] });
    chrome.contextMenus.create({ id: 'dark', parentId: ROOT, title: TASKS.dark_patterns.menu, contexts: ['page'] });
  });
}

export async function onMenuClick(info, tab) {
  const id = String(info.menuItemId);
  const page = { title: tab?.title ?? '', url: tab?.url ?? info.pageUrl ?? '' };
  const frameId = info.frameId ?? 0;

  if (id.startsWith('text:')) {
    const task = id.slice('text:'.length);
    const entryId = crypto.randomUUID();
    let text = info.selectionText ?? '';
    let anchor = null;
    if (tab?.id != null) {
      // Remember where the selection is (so harmful text can be blurred) and read it with
      // its line breaks intact; Chrome's own copy of the selection flattens them.
      const marked = await markTarget(tab.id, frameId, entryId, 'selection').catch(() => null);
      if (marked) {
        anchor = { tabId: tab.id, frameId, targetId: entryId };
        if (typeof marked.text === 'string' && marked.text.trim().length >= text.trim().length) text = marked.text;
      }
    }
    await analyzeText({ task, text, source: 'selection', page, id: entryId, anchor }).catch((err) =>
      recordFailure({ task, source: 'selection', page, err }),
    );
    return;
  }

  if (tab?.id == null) {
    const task = id === 'media' ? 'media' : id === 'toxic_page' ? 'toxicity_page' : 'dark_patterns';
    await recordFailure({ task, source: 'menu', page, err: new ApiError(0, 'no_active_tab', null) });
    return;
  }

  if (id === 'media') {
    const entryId = crypto.randomUUID();
    const marked = await markTarget(tab.id, frameId, entryId, 'media', info.srcUrl).catch(() => null);
    await analyzeImage({
      tabId: tab.id,
      frameId,
      src: info.srcUrl,
      mediaType: info.mediaType === 'video' ? 'video' : 'image',
      source: 'menu',
      page,
      id: entryId,
      anchor: marked ? { tabId: tab.id, frameId, targetId: entryId } : null,
    });
  } else if (id === 'toxic_page') {
    // No single spot to point at, so the card sits in the corner of the window.
    await analyzePageToxicity({ tabId: tab.id, source: 'menu', page, anchor: { tabId: tab.id, frameId: 0, targetId: null } });
  } else if (id === 'dark') {
    await analyzePageDarkPatterns({ tabId: tab.id, source: 'menu', page });
  }
}