const BENGALI = /[\u0980-\u09FF]/u;

/**
 * Rough script-based language check: 'bn' (Bangla), 'en' (Latin script),
 * 'mixed', or 'unknown' (no letters). Good enough to pick prompts and labels;
 * the AI services in Phase 5 do their own detection too.
 */
export function detectLanguage(text) {
  const letters = String(text ?? '').match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 'unknown';
  let bengali = 0;
  for (const ch of letters) if (BENGALI.test(ch)) bengali++;
  const ratio = bengali / letters.length;
  if (ratio >= 0.6) return 'bn';
  if (ratio >= 0.15) return 'mixed';
  return 'en';
}