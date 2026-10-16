import { TASKS } from '../shared/tasks.js';
import { errorText } from '../shared/format.js';

// Turns a result entry into the plain data the on-page card displays.
// The card only ever receives text and numbers (no HTML), so nothing an AI
// service or website returns can inject markup into the page.

const cap = (s) => String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}\u2026` : String(s ?? ''));

const SEVERITY = {
  high: ['Harmful content found', 'bad'],
  medium: ['Harmful content found', 'bad'],
  low: ['Mild warning signs', 'warn'],
  none: ['No harmful content found', 'good'],
};

function fromModeration(m, extraLines = []) {
  const [text, tone] = SEVERITY[m?.severity] ?? SEVERITY.none;
  const blur = m?.blurRecommended ? { label: m.categories?.[0]?.label ?? 'Harmful content' } : null;
  return {
    verdict: { text, tone },
    lines: [...extraLines, m?.explanation],
    bars: (m?.categories ?? []).slice(0, 4).map((c) => ({ label: c.label, value: c.score, tone: c.flagged ? 'bad' : 'neutral' })),
    footnote: [blur ? 'It has been blurred on the page. Click it, or \u201cShow\u201d on the badge, to reveal it.' : '', m?.caveats?.[0] ?? '']
      .filter(Boolean)
      .join(' '),
    blur,
  };
}

const AI_VERDICT = {
  likely_ai: ['Likely AI-written', 'bad'],
  uncertain: ['Unclear: could be either', 'warn'],
  likely_human: ['Likely human-written', 'good'],
};

const NEWS_VERDICT = {
  likely_accurate: ['Likely accurate', 'good'],
  mixed: ['Partly accurate', 'warn'],
  unverified: ['Can\u2019t be verified', 'warn'],
  misleading: ['Misleading', 'bad'],
  likely_false: ['Likely false', 'bad'],
  not_checkable: ['Opinion, or nothing to fact-check', 'neutral'],
};

const BUILDERS = {
  ai_text: (r) => {
    const [text, tone] = AI_VERDICT[r.verdict] ?? AI_VERDICT.uncertain;
    return {
      verdict: { text, tone },
      bars: [{ label: 'Likelihood of AI generation', value: r.score, tone }],
      footnote: r.caveats?.at(-1),
    };
  },
  toxicity: (r) => fromModeration(r),
  emotion: (r) => ({
    verdict: { text: `Mostly ${r.primaryEmotion}`, tone: 'neutral' },
    lines: [`${cap(r.sentiment)} \u00b7 ${cap(r.intensity)} intensity`, r.explanation],
    bars: (r.emotions ?? []).slice(0, 4).map((e) => ({ label: cap(e.emotion), value: e.percent / 100 })),
  }),
  fake_news: (r) => {
    const [text, tone] = NEWS_VERDICT[r.verdict] ?? NEWS_VERDICT.unverified;
    const basis = r.source === 'fact_checkers' ? 'Based on published fact-checks' : 'AI assessment';
    return {
      verdict: { text, tone },
      lines: [`${basis} \u00b7 ${r.confidence}% confidence`],
      list: (r.reasons ?? []).slice(0, 3),
      footnote: 'Open Jachai for sources and full details.',
    };
  },
  media: (r) => ({
    ...fromModeration(r.moderation, [r.description]),
    longText: r.extractedText ? clip(r.extractedText, 400) : '',
  }),
  jargon: (r) => ({
    verdict: { text: 'In plain words', tone: 'neutral' },
    longText: r.simplified,
    list: [...(r.keyPoints ?? []), ...(r.watchOutFor ?? []).map((w) => `Watch out: ${w}`)],
    footnote: r.via === 'device' ? 'Simplified on your device: nothing left your computer.' : 'Simplified in the cloud.',
  }),
  toxicity_page: (r) => {
    if (r.refused) {
      return {
        verdict: { text: 'Couldn\u2019t finish the scan', tone: 'warn' },
        lines: ['Some content here was too extreme for the AI service to process. Try selecting specific passages instead.'],
      };
    }
    const n = r.flaggedCount ?? 0;
    return {
      verdict: { text: n ? `${n} passage${n === 1 ? '' : 's'} blurred` : 'No toxic passages found', tone: n ? 'bad' : 'good' },
      lines: [`Checked ${r.total} passage${r.total === 1 ? '' : 's'} on this page.`],
      footnote: [n ? 'Click a blurred passage, or \u201cShow\u201d on its badge, to reveal it.' : '', r.caveats?.[0] ?? '']
        .filter(Boolean)
        .join(' '),
    };
  },
};

export function buildCard(entry) {
  const base = { id: entry.id, title: TASKS[entry.task]?.label ?? 'Jachai' };

  if (entry.status === 'running') {
    const downloading = entry.task === 'jargon' && entry.progress != null && entry.progress < 100;
    return {
      ...base,
      state: 'loading',
      message: downloading
        ? `Downloading the on-device AI (first time only): ${entry.progress}%`
        : entry.task === 'toxicity_page' ? 'Checking the passages on this page\u2026' : 'Analyzing\u2026',
    };
  }
  if (entry.status === 'device') {
    return entry.error
      ? { ...base, state: 'error', message: `${errorText({ message: entry.error })} Open Jachai to continue.` }
      : { ...base, state: 'info', message: 'Finishing in the Jachai window\u2026' };
  }
  if (entry.status === 'error') return { ...base, state: 'error', message: errorText({ message: entry.error }) };

  const result = entry.data?.result;
  const build = BUILDERS[entry.task];
  if (!result || !build) return { ...base, state: 'info', message: 'Done. Open Jachai for details.' };
  try {
    return { ...base, state: 'done', ...build(result) };
  } catch {
    return { ...base, state: 'info', message: 'Done. Open Jachai for details.' };
  }
}