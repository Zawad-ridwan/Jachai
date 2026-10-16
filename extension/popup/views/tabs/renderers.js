import { escapeHtml as h } from '../../ui-helpers.js';

// How each check's finished result is shown in the Results tab.

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);

const bar = (value, tone = 'accent') =>
  `<div class="bar"><div class="bar-fill ${tone}" style="width:${Math.max(2, Math.round(Math.min(1, value) * 100))}%"></div></div>`;
const verdict = (label, tone) => `<div class="verdict ${tone}">${label}</div>`;
const list = (items, cls = 'compact') =>
  items?.length ? `<ul class="${cls}">${items.map((i) => `<li>${h(i)}</li>`).join('')}</ul>` : '';
const caveats = (items) => (items?.length ? `<div class="caveats">${list(items)}</div>` : '');

// ---- AI-written text ----
const AI_VERDICT = {
  likely_ai: ['Likely AI-written', 'bad'],
  uncertain: ['Unclear: could be either', 'warn'],
  likely_human: ['Likely human-written', 'good'],
};
function aiText(r) {
  const [label, tone] = AI_VERDICT[r.verdict] ?? AI_VERDICT.uncertain;
  const sentences =
    r.sentences?.length > 1
      ? `<details class="sentences">
          <summary>Sentence by sentence</summary>
          <p>${r.sentences
            .slice(0, 60)
            .map((s) => `<span class="sent ${s.score >= 0.75 ? 'hi' : s.score >= 0.4 ? 'mid' : 'lo'}" title="${pct(s.score)} likely AI">${h(s.text)}</span>`)
            .join(' ')}</p>
          <p class="muted small">Darker highlight = more likely AI-written. Sentence scores are worked out differently from the overall score, so they may not match.</p>
        </details>`
      : '';
  return `${verdict(label, tone)}
    <p class="small">${pct(r.score)} likely to be AI-generated</p>${bar(r.score, tone)}
    ${sentences}${caveats(r.caveats)}`;
}

// ---- Toxicity (also used inside media results) ----
const SEVERITY = {
  high: ['Harmful content found', 'bad'],
  medium: ['Harmful content found', 'bad'],
  low: ['Mild warning signs', 'warn'],
  none: ['No harmful content found', 'good'],
};
export function moderation(m) {
  const [label, tone] = SEVERITY[m.severity] ?? SEVERITY.none;
  const rows = (m.categories ?? [])
    .map(
      (c) => `<li>
        <div class="bar-label"><span>${h(c.label)}${c.flagged ? ' <strong>\u2022 flagged</strong>' : ''}</span><span class="muted">${pct(c.score)}</span></div>
        ${bar(c.score, c.flagged ? 'bad' : 'neutral')}
      </li>`,
    )
    .join('');
  return `${verdict(label, tone)}${rows ? `<ul class="bars">${rows}</ul>` : ''}
    ${m.explanation ? `<p class="small">${h(m.explanation)}</p>` : ''}
    ${caveats(m.caveats)}`;
}

// ---- Emotion ----
const EMOJI = {
  joy: '\u{1F60A}', sadness: '\u{1F622}', anger: '\u{1F620}', fear: '\u{1F628}', surprise: '\u{1F632}',
  disgust: '\u{1F922}', trust: '\u{1F91D}', anticipation: '\u{1F91E}', neutral: '\u{1F610}',
};
function emotion(r) {
  return `${verdict(`${EMOJI[r.primaryEmotion] ?? ''} Mostly ${h(r.primaryEmotion)}`, 'neutral')}
    <p class="small"><span class="pill">${h(cap(r.sentiment))}</span><span class="pill">${h(cap(r.intensity))} intensity</span></p>
    <ul class="bars">${(r.emotions ?? [])
      .map(
        (e) => `<li>
          <div class="bar-label"><span>${EMOJI[e.emotion] ?? ''} ${h(cap(e.emotion))}</span><span class="muted">${e.percent}%</span></div>
          ${bar(e.percent / 100)}
        </li>`,
      )
      .join('')}</ul>
    ${r.explanation ? `<p class="small">${h(r.explanation)}</p>` : ''}`;
}

// ---- Fake news ----
const NEWS_VERDICT = {
  likely_accurate: ['Likely accurate', 'good'],
  mixed: ['Partly accurate', 'warn'],
  unverified: ['Can\u2019t be verified', 'warn'],
  misleading: ['Misleading', 'bad'],
  likely_false: ['Likely false', 'bad'],
  not_checkable: ['Opinion, or nothing to fact-check', 'neutral'],
};
function fakeNews(r) {
  const [label, tone] = NEWS_VERDICT[r.verdict] ?? NEWS_VERDICT.unverified;
  const basis =
    r.source === 'fact_checkers'
      ? 'Based on published fact-checks'
      : r.factCheckUnavailable
        ? 'AI assessment (the fact-check search wasn\u2019t available)'
        : 'AI assessment (no published fact-checks found)';
  const checks = (r.factChecks ?? [])
    .map((f) => {
      const url = safeUrl(f.url);
      const who = url ? `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(f.publisher)}</a>` : h(f.publisher);
      return `<li>${who} rated it <strong>${h(f.rating)}</strong>: \u201c${h(f.claim)}\u201d</li>`;
    })
    .join('');
  return `${verdict(label, tone)}
    <p class="muted small">${basis} \u00b7 ${r.confidence}% confidence</p>
    ${checks ? `<p class="small"><strong>Fact-checks</strong></p><ul class="compact factchecks">${checks}</ul>` : ''}
    ${r.reasons?.length ? `<p class="small"><strong>Why</strong></p>${list(r.reasons)}` : ''}
    ${r.redFlags?.length ? `<p class="small"><strong>Red flags</strong></p>${list(r.redFlags)}` : ''}
    ${r.advice ? `<p class="small">${h(r.advice)}</p>` : ''}
    ${caveats(r.caveats)}`;
}

// ---- Media ----
function media(r) {
  return `
    ${r.description ? `<p class="small">${h(r.description)}</p>` : ''}
    ${
      r.extractedText
        ? `<p class="small"><strong>Text in the image</strong></p><blockquote>${h(r.extractedText)}</blockquote>`
        : '<p class="muted small">No readable text in the image.</p>'
    }
    ${r.contentWarnings?.length ? `<p class="small"><strong>Notes</strong></p>${list(r.contentWarnings)}` : ''}
    ${r.moderation ? moderation(r.moderation) : '<p class="muted small">The safety check isn\u2019t set up on the server.</p>'}`;
}

// ---- Jargon ----
function jargon(r) {
  return `
    <p class="muted small">${
      r.via === 'device' ? 'Simplified on your device: nothing left your computer.' : 'Simplified in the cloud.'
    }</p>
    <div class="simplified">${h(r.simplified)}</div>
    ${r.keyPoints?.length ? `<p class="small"><strong>Key points</strong></p>${list(r.keyPoints)}` : ''}
    ${r.watchOutFor?.length ? `<p class="small"><strong>Watch out for</strong></p>${list(r.watchOutFor)}` : ''}`;
}

// ---- Dark patterns (scan run from the right-click menu) ----
function darkPatterns(d) {
  if (!d.total) return '<p>No common dark patterns found on this page.</p>';
  const labels = {};
  for (const f of d.findings) labels[f.label] = (labels[f.label] ?? 0) + 1;
  return `<p><strong>${d.total} possible dark pattern${d.total === 1 ? '' : 's'}</strong>, outlined on the page:</p>
    <ul class="compact">${Object.entries(labels).map(([l, n]) => `<li>${h(l)} \u00d7 ${n}</li>`).join('')}</ul>`;
}

// ---- Whole-page toxicity scan ----
function pageToxicity(r) {
  if (r.refused) {
    return `${verdict('Couldn\u2019t finish the scan', 'warn')}
      <p class="small">Some content on this page was too extreme for the AI service to process. Try selecting specific passages instead.</p>`;
  }
  const n = r.flaggedCount ?? 0;
  const labels = {};
  for (const b of r.blocks ?? []) labels[b.label] = (labels[b.label] ?? 0) + 1;
  return `${verdict(n ? `${n} passage${n === 1 ? '' : 's'} blurred` : 'No toxic passages found', n ? 'bad' : 'good')}
    <p class="muted small">Checked ${r.total} passage${r.total === 1 ? '' : 's'} on the page.</p>
    ${n ? `<ul class="compact">${Object.entries(labels).map(([l, c]) => `<li>${h(l)} \u00d7 ${c}</li>`).join('')}</ul>` : ''}
    ${caveats(r.caveats)}`;
}

const RENDERERS = { ai_text: aiText, toxicity: moderation, emotion, fake_news: fakeNews, media, jargon, toxicity_page: pageToxicity };

export function renderFinished(entry) {
  if (entry.task === 'dark_patterns') return darkPatterns(entry.data ?? {});
  const result = entry.data?.result;
  const render = RENDERERS[entry.task];
  if (!result || !render) return '<p class="muted small">No details available.</p>';
  try {
    return render(result);
  } catch {
    return '<p class="muted small">This result couldn\u2019t be displayed.</p>';
  }
}