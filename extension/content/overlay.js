// On-page feedback: floating result cards, and blurring of harmful passages
// or images with a warning badge and click-to-reveal.
//
// Injected only when needed (never on every site). It runs in Jachai's
// isolated content-script world, and everything it draws lives inside a
// closed Shadow DOM, so the website's CSS and scripts can't restyle, read or
// tamper with it. All text is inserted with textContent, never as HTML.
(() => {
  // Version check, so a page that still holds an older copy (from before an
  // extension update) gets this one instead of keeping the old functions.
  const VERSION = 2;
  if (globalThis.__msOverlay?.version === VERSION) return;

  const BLUR_CLASS = 'ms-shield-toxic-blur'; // styled by the extension's injected CSS
  const cards = new Map(); // result id -> { host, box }
  const badges = new Map(); // blurred element -> { host, text, button, label, onClick }

  const CARD_CSS = `
    .card { box-sizing: border-box; width: 340px; max-height: 60vh; overflow: auto; padding: 12px 14px;
      background: #fff; color: #1a1f2e; border: 1px solid #dde2ec; border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,.22);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "Noto Sans Bengali", sans-serif; text-align: left; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
    .brand { font-weight: 700; font-size: 12px; color: #5b6478; }
    .x { all: unset; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 7px; border-radius: 6px; color: #5b6478; }
    .x:hover, .x:focus-visible { background: #eef1f7; }
    .title { font-weight: 700; margin: 0 0 4px; }
    .verdict { font-weight: 700; font-size: 15px; margin: 4px 0; }
    .good { color: #1d9e6c; } .warn { color: #a06f00; } .bad { color: #c62f3a; } .neutral { color: inherit; }
    p { margin: 4px 0; }
    .muted { color: #5b6478; font-size: 12px; }
    .row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
    .bar { height: 6px; border-radius: 999px; background: #e6e9f0; overflow: hidden; margin: 2px 0 6px; }
    .fill { height: 100%; border-radius: 999px; background: #2f5bea; }
    .fill.good { background: #1d9e6c; } .fill.warn { background: #c89400; }
    .fill.bad { background: #c62f3a; } .fill.neutral { background: #8a93a6; }
    ul { margin: 4px 0; padding-left: 18px; }
    .long { white-space: pre-wrap; overflow-wrap: anywhere; background: #f5f7fb; border-radius: 8px;
      padding: 8px; margin: 6px 0; max-height: 220px; overflow: auto; }
    .spin { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
      border-radius: 50%; border: 2px solid #dde2ec; border-top-color: #2f5bea; animation: s .8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      .card { background: #1a2030; color: #e8ebf2; border-color: #2a3142; }
      .brand, .muted, .x { color: #9aa3b5; } .x:hover, .x:focus-visible { background: #252c3d; }
      .bar { background: #2a3142; } .long { background: #151924; }
      .good { color: #4fd8a0; } .warn { color: #e0b84c; } .bad { color: #ff6b76; }
    }`;

  const BADGE_CSS = `
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 4px 9px; border-radius: 8px;
      background: #fff4d6; color: #4a3200; border: 1px solid #f0c36a;
      font: 12px/1.3 system-ui, -apple-system, "Segoe UI", "Noto Sans Bengali", sans-serif; }
    button { all: unset; cursor: pointer; font-weight: 700; text-decoration: underline; }
    button:focus-visible { outline: 2px solid #2f5bea; outline-offset: 2px; border-radius: 3px; }
    @media (prefers-color-scheme: dark) { .badge { background: #3a2f12; color: #ffe2a3; border-color: #7a5d1c; } }`;

  // ---------- small helpers ----------

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  /** Style a shadow root. Constructed stylesheets aren't blocked by a site's security policy; <style> is the fallback. */
  function styleRoot(root, css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', null, css));
    }
  }

  /** A host element the page's own CSS can't touch (its styling is reset and everything else is in a closed shadow). */
  function makeHost(tag, display) {
    const host = document.createElement(tag);
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('display', display, 'important');
    return host;
  }

  const setStyle = (el, prop, value) => el.style.setProperty(prop, value, 'important');

  // ---------- floating result cards ----------

  const anchorOf = (id) => globalThis.__msAnchors?.get(id) ?? null;

  function place(host, id) {
    const a = anchorOf(id);
    setStyle(host, 'z-index', '2147483647');
    if (!a) {
      // No selection to point at (e.g. a whole-page scan): top-right corner of the window.
      setStyle(host, 'position', 'fixed');
      setStyle(host, 'top', '16px');
      setStyle(host, 'right', '16px');
      return;
    }
    const width = 340;
    const viewportWidth = document.documentElement.clientWidth;
    const left = Math.max(window.scrollX + 8, Math.min(a.left, window.scrollX + viewportWidth - width - 8));
    // Several checks on the same selection: stagger them so they don't hide each other.
    const sameSpot = [...cards.keys()].filter((k) => k !== id && anchorOf(k)?.bottom === a.bottom).length;
    setStyle(host, 'position', 'absolute');
    setStyle(host, 'top', `${a.bottom + 8 + sameSpot * 18}px`);
    setStyle(host, 'left', `${left + sameSpot * 18}px`);
  }

  function closeCard(id) {
    cards.get(id)?.host.remove();
    cards.delete(id);
  }

  function fill(box, model) {
    box.replaceChildren();
    const head = h('div', 'head');
    const close = h('button', 'x', '\u00d7');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => closeCard(model.id));
    head.append(h('span', 'brand', '\u{1F6E1}\uFE0F Jachai'), close);
    box.append(head, h('div', 'title', model.title));

    if (model.state === 'loading') {
      const p = h('p', 'muted');
      p.append(h('span', 'spin'), document.createTextNode(model.message));
      box.append(p);
      return;
    }
    if (model.state === 'error' || model.state === 'info') {
      box.append(h('p', model.state === 'error' ? 'bad' : 'muted', model.message));
      return;
    }

    if (model.verdict) box.append(h('div', `verdict ${model.verdict.tone ?? 'neutral'}`, model.verdict.text));
    for (const line of model.lines ?? []) if (line) box.append(h('p', null, line));
    for (const b of model.bars ?? []) {
      const pct = Math.max(0, Math.min(100, Math.round((Number(b.value) || 0) * 100)));
      const row = h('div', 'row');
      row.append(h('span', null, b.label), h('span', 'muted', `${pct}%`));
      const bar = h('div', 'bar');
      const f = h('div', `fill ${b.tone ?? ''}`);
      f.style.width = `${Math.max(2, pct)}%`;
      bar.append(f);
      box.append(row, bar);
    }
    if (model.longText) box.append(h('div', 'long', model.longText));
    if (model.list?.length) {
      const ul = h('ul');
      for (const item of model.list) ul.append(h('li', null, item));
      box.append(ul);
    }
    if (model.footnote) box.append(h('p', 'muted', model.footnote));
  }

  function render(model) {
    if (!model?.id) return false;
    let card = cards.get(model.id);
    if (!card) {
      const host = makeHost('ms-shield-card', 'block');
      const root = host.attachShadow({ mode: 'closed' });
      styleRoot(root, CARD_CSS);
      const box = h('div', 'card');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', `Jachai: ${model.title}`);
      root.append(box);
      card = { host, box };
      cards.set(model.id, card);
      place(host, model.id);
      document.documentElement.append(host);
    }
    fill(card.box, model);
    if (model.blur) blurElement(document.querySelector(`[data-ms-target="${CSS.escape(model.id)}"]`), model.blur.label);
    return true;
  }

  // Esc closes the most recently opened card.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || cards.size === 0) return;
    closeCard([...cards.keys()].at(-1));
  });

  // ---------- blur + warning badge + click to reveal ----------

  function hide(el) {
    const s = badges.get(el);
    el.classList.add(BLUR_CLASS);
    s.text.textContent = `\u26A0\uFE0F Hidden by Jachai: ${s.label}`;
    s.button.textContent = 'Show';
    // Clicking the blurred content itself reveals it (and doesn't follow any link inside it).
    s.onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      reveal(el);
    };
    el.addEventListener('click', s.onClick, { capture: true, once: true });
  }

  function reveal(el) {
    const s = badges.get(el);
    el.classList.remove(BLUR_CLASS);
    if (s.onClick) el.removeEventListener('click', s.onClick, { capture: true });
    s.onClick = null;
    s.text.textContent = `Flagged by Jachai: ${s.label}`;
    s.button.textContent = 'Hide';
  }

  function blurElement(el, label) {
    if (!el || badges.has(el) || el === document.body || el === document.documentElement) return false;
    const host = makeHost('ms-shield-badge', 'block');
    setStyle(host, 'margin', '4px 0');
    const root = host.attachShadow({ mode: 'closed' });
    styleRoot(root, BADGE_CSS);
    const box = h('div', 'badge');
    box.setAttribute('role', 'note');
    const text = h('span');
    const button = h('button');
    box.append(text, button);
    root.append(box);
    el.before(host);

    badges.set(el, { host, text, button, label: label || 'Harmful content', onClick: null });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (el.classList.contains(BLUR_CLASS)) reveal(el);
      else hide(el);
    });
    hide(el);
    return true;
  }

  /**
   * Highlighted-text checks: blur the selected passage (marked earlier with
   * data-ms-target) without drawing a result card. The result itself is shown
   * only in the extension popup.
   */
  function blurTarget(id, label) {
    const el = document.querySelector(`[data-ms-target="${CSS.escape(String(id))}"]`);
    return blurElement(el, label);
  }

  /** Whole-page scan: blur the passages the server flagged, by the numbers the page scan gave them. */
  function blurBlocks(list) {
    let count = 0;
    for (const item of Array.isArray(list) ? list : []) {
      const el = document.querySelector(`[data-ms-block="${Number(item?.index)}"]`);
      if (blurElement(el, item?.label)) count++;
    }
    return count;
  }

  /** Undo everything: un-blur and remove all badges. The page is left exactly as it was. */
  function revealAll() {
    let count = 0;
    for (const [el, s] of badges) {
      el.classList.remove(BLUR_CLASS);
      if (s.onClick) el.removeEventListener('click', s.onClick, { capture: true });
      s.host.remove();
      count++;
    }
    badges.clear();
    return count;
  }

  globalThis.__msOverlay = { version: VERSION, render, blurTarget, blurBlocks, revealAll, closeCard };
})();