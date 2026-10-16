// Every check Jachai can run. Costs and Pro requirements must match
// backend/src/services/analysis.js, which is what actually enforces them;
// the copy here only drives labels, buttons and cost estimates.

export const TASKS = Object.freeze({
  ai_text: {
    label: 'AI text detection', short: 'AI-check', menu: 'Detect AI-written text',
    cost: 1, minRole: 'regular', input: 'text', runsOn: 'server',
  },
  toxicity: {
    label: 'Hate speech & toxicity', short: 'Toxicity', menu: 'Check for hate speech & toxicity',
    cost: 1, minRole: 'regular', input: 'text', runsOn: 'server',
  },
  emotion: {
    label: 'Emotion & sentiment', short: 'Emotion', menu: 'Analyze emotion & sentiment (Pro)',
    cost: 1, minRole: 'paid', input: 'text', runsOn: 'server',
  },
  fake_news: {
    label: 'Fake news check', short: 'Fact-check', menu: 'Fact-check this text (Pro)',
    cost: 2, minRole: 'paid', input: 'text', runsOn: 'server',
  },
  jargon: {
    // Free on the person's own device (Gemini Nano); `cloudCost` applies if they
    // choose the cloud instead (e.g. for Bangla, which the device model may not support).
    label: 'Jargon simplifier', short: 'Simplify', menu: 'Simplify jargon & legalese',
    cost: 0, cloudCost: 1, minRole: 'regular', input: 'text', runsOn: 'device',
  },
  media: {
    label: 'Media analysis', short: 'Media', menu: 'Analyze media (Pro)',
    cost: 3, minRole: 'paid', input: 'image', runsOn: 'server',
  },
  toxicity_page: {
    label: 'Toxic content scan', short: 'Page toxicity', menu: 'Blur toxic content on this page',
    cost: 3, minRole: 'regular', input: 'page', runsOn: 'server',
  },
  dark_patterns: {
    label: 'Dark pattern scan', short: 'Dark patterns', menu: 'Scan this page for dark patterns',
    cost: 0, minRole: 'regular', input: 'page', runsOn: 'local',
  },
});

export const TEXT_TASKS = Object.freeze(['ai_text', 'toxicity', 'emotion', 'fake_news', 'jargon']);
export const MAX_TEXT = 5000;

const RANK = { regular: 0, paid: 1, admin: 2 };
export function canUse(task, role) {
  const def = TASKS[task];
  return Boolean(def) && (RANK[role] ?? -1) >= RANK[def.minRole];
}

export const LANGUAGE_LABEL = Object.freeze({ en: 'English', bn: 'Bangla', mixed: 'English + Bangla', unknown: '' });

/** Same rule as backend/src/services/language.js. */
export function detectLanguage(text) {
  const letters = String(text ?? '').match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 'unknown';
  let bengali = 0;
  for (const ch of letters) if (/[\u0980-\u09FF]/u.test(ch)) bengali++;
  const ratio = bengali / letters.length;
  if (ratio >= 0.6) return 'bn';
  if (ratio >= 0.15) return 'mixed';
  return 'en';
}