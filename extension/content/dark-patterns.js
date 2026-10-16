// Dark Pattern Scanner. Injected only when the person asks for a scan, never
// on every page. It runs in Jachai's isolated "content script" world,
// so the website's own scripts can't see or interfere with it.
//
// It uses pattern matching (wording, checkbox states, text size and contrast,
// timers that tick), not AI, so it's fast and fully offline. It will miss some
// tricks and occasionally flag honest text; results are hints, not verdicts.
(() => {
  if (globalThis.__msDark) return;

  const RULES = {
    preselected: {
      label: 'Pre-ticked opt-in', severity: 'high',
      why: 'A box that signs you up for something extra is already ticked for you.',
    },
    hidden_costs: {
      label: 'Hidden recurring charge', severity: 'high',
      why: 'Subscription or renewal terms are in small or faint text.',
    },
    confirmshaming: {
      label: 'Confirmshaming', severity: 'medium',
      why: 'The "no" option is worded to make you feel bad for declining.',
    },
    countdown: {
      label: 'Countdown pressure', severity: 'medium',
      why: 'A live timer pushes you to decide quickly.',
    },
    scarcity: {
      label: 'Scarcity claim', severity: 'low',
      why: 'Low-stock claims push you to buy now. They may or may not be true.',
    },
    activity: {
      label: 'Activity pressure', severity: 'low',
      why: 'Messages about other shoppers create a sense of competition.',
    },
    urgency: {
      label: 'Urgency language', severity: 'low',
      why: 'Wording designed to rush your decision.',
    },
  };

  // Order matters: the first rule that matches an element wins.
  const TEXT_RULES = [
    ['confirmshaming',
      /\bno,?\s*thanks?\b.{0,20}\bi\s*(?:don'?t|do not|would rather not)\b|\bi\s*(?:don'?t|do not)\s*(?:want|like|need|care about)\s*(?:to\s*)?(?:save|saving|savings|deals|discounts|free|protect|security|being)|\bi(?:'ll| will)\s*pass\s*on\b|\bi\s*prefer\s*(?:to\s*)?pay(?:ing)?\s*(?:full|more)\b|\bi(?:'m| am)\s*not\s*interested\s*in\s*(?:saving|deals|discounts)/i],
    ['scarcity',
      /\bonly\s+\d+\s+(?:left|remaining|available)\b|\b\d+\s+(?:left|remaining)\s+in\s+stock\b|\b(?:almost|nearly)\s+(?:gone|sold\s*out)\b|\bselling\s+fast\b|\bhigh\s+demand\b|\blow\s+stock\b|মাত্র\s*[০-৯0-9]+\s*টি?\s*(?:বাকি|অবশিষ্ট)|স্টক\s*সীমিত/iu],
    ['activity',
      /\b\d[\d,]*\s+(?:people|others|shoppers|customers|users)\s+(?:are\s+)?(?:viewing|looking\s+at|watching|have\s+this\s+in|bought|purchased|booked|added)/i],
    ['urgency',
      /\b(?:offer|deal|sale|price|discount)s?\s+(?:ends?|expires?)\s+(?:soon|today|tonight|in\b)|\blimited[-\s]time\b|\blast\s+chance\b|\bhurry(?:\s*[!,.]|\s+(?:up|now|before|while))|\btoday\s+only\b|\bwhile\s+(?:supplies|stocks?)\s+last|সীমিত\s*সময়|শেষ\s*সুযোগ|তাড়াতাড়ি\s*করুন/iu],
    ['hidden_costs',
      /auto[-\s]?renew|recurring\s+(?:charge|payment|billing|fee)|billed\s+(?:monthly|annually|yearly|every)|after\s+(?:your|the)\s+(?:free\s+)?trial|then\s+[$€£৳]?\s?\d+(?:[.,]\d{2})?\s*(?:\/|per\s+)?\s*(?:mo|month|yr|year)\b/i],
  ];

  const OPT_IN =
    /subscri|newsletter|marketing|promotion|special\s+offers|partners|third[-\s]part|recurring|auto[-\s]?renew|keep\s+me\s+(?:updated|informed|posted)|email\s+me|send\s+me|sign\s+me\s+up|add\s+(?:protection|insurance|warranty|coverage|a\s+donation|a\s+tip)|share\s+my|সাবস্ক্রাইব|নিউজলেটার/iu;
  const TIME =
    /\b\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?\b|\b\d{1,2}\s*(?:h|hrs?|hours?)\s*\d{1,2}\s*(?:m|mins?|minutes?)\b|\b\d{1,2}\s*(?:m|mins?)\s*\d{1,2}\s*(?:s|secs?)\b/i;
  const TIMER_CONTEXT = /ends?|expires?|left|remaining|offer|deal|sale|hurry|only|limited|reserved|held|checkout|cart|discount|শেষ|বাকি/iu;
  const SKIP = 'script,style,noscript,template,svg,textarea,input,select,video,audio,[contenteditable="true"],[aria-hidden="true"]';
  const NOT_A_SALES_TIMER = 'video,audio,[class*="player" i],[class*="clock" i],[class*="duration" i]';
  const MAX_FINDINGS = 60;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }

  // ---- "Fine print" test: tiny, faded, or low-contrast text ----
  function parseRgb(color) {
    const m = String(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a].some(Number.isNaN) ? null : { r, g, b, a };
  }
  function luminance({ r, g, b }) {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function backgroundOf(el) {
    for (let n = el; n; n = n.parentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  function isFinePrint(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (parseFloat(s.fontSize) <= 11.5 || Number(s.opacity) < 0.7) return true;
    const fg = parseRgb(s.color);
    if (!fg) return false;
    const a = luminance(fg);
    const b = luminance(backgroundOf(el));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 3;
  }

  /** Climbs from a bit of text to the element that holds the whole phrase ("Only <b>3</b> left"). */
  function phraseElement(textNode) {
    let el = textNode.parentElement;
    while (
      el?.parentElement &&
      el !== document.body &&
      norm(el.textContent).length < 25 &&
      norm(el.parentElement.textContent).length <= 300
    ) {
      el = el.parentElement;
    }
    return el;
  }

  let findings = [];

  function mark(el, category, snippet) {
    if (!el || findings.length >= MAX_FINDINGS) return;
    if (el.closest('[data-ms-dark]') || !isVisible(el)) return;
    const rule = RULES[category];
    const id = findings.length + 1;
    el.setAttribute('data-ms-dark', category);
    el.setAttribute('data-ms-dark-id', String(id));
    if (!el.hasAttribute('title')) {
      el.setAttribute('title', `Jachai: ${rule.label}. ${rule.why}`);
      el.setAttribute('data-ms-dark-title', '');
    }
    findings.push({ id, category, label: rule.label, severity: rule.severity, why: rule.why, snippet: clip(norm(snippet)) });
  }

  async function scan() {
    clear();
    const body = document.body;
    if (!body) return summary();

    // 1. Checkboxes that opt you into something and arrive already ticked.
    for (const box of body.querySelectorAll('input[type="checkbox"]')) {
      if (!box.checked) continue;
      const label = box.labels?.[0] ?? box.closest('label');
      const text = norm(label?.textContent || box.getAttribute('aria-label') || box.parentElement?.textContent).slice(0, 300);
      if (OPT_IN.test(text)) mark(label ?? box.parentElement ?? box, 'preselected', text);
    }

    // 2. Wording patterns in visible text.
    const tested = new Set();
    const timers = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        return !p || p.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });

    let visited = 0;
    while (walker.nextNode() && visited++ < 25_000 && findings.length < MAX_FINDINGS) {
      const node = walker.currentNode;
      const el = phraseElement(node);
      if (!el || tested.has(el)) continue;
      tested.add(el);

      const text = norm(el.textContent).slice(0, 400);
      if (text.length < 3) continue;

      for (const [category, re] of TEXT_RULES) {
        if (!re.test(text)) continue;
        // Renewal terms are fine when stated clearly; only flag them when hidden.
        if (category === 'hidden_costs' && !isFinePrint(node.parentElement)) continue;
        mark(el, category, text);
        break;
      }
      if (text.length <= 120 && TIME.test(text) && !el.closest(NOT_A_SALES_TIMER)) {
        timers.push({ el, before: el.textContent });
      }
    }

    // 3. Countdown timers: only flagged if they actually tick, and sit near sales wording.
    if (timers.length) {
      await sleep(1100);
      for (const { el, before } of timers.slice(0, 40)) {
        if (!el.isConnected || el.textContent === before) continue;
        const context = norm(el.parentElement?.parentElement?.textContent ?? el.textContent).slice(0, 400);
        if (TIMER_CONTEXT.test(context)) mark(el, 'countdown', context);
      }
    }

    return summary();
  }

  function summary() {
    const counts = {};
    for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
    return {
      findings,
      counts,
      total: findings.length,
      url: location.href,
      title: document.title,
      scannedAt: new Date().toISOString(),
    };
  }

  function clear() {
    for (const el of document.querySelectorAll('[data-ms-dark]')) {
      if (el.hasAttribute('data-ms-dark-title')) el.removeAttribute('title');
      el.removeAttribute('data-ms-dark');
      el.removeAttribute('data-ms-dark-id');
      el.removeAttribute('data-ms-dark-title');
    }
    const cleared = findings.length;
    findings = [];
    return cleared;
  }

  globalThis.__msDark = { scan, clear };
})();