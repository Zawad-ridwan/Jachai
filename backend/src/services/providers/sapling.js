import { config } from '../../config.js';
import { AnalysisError } from '../errors.js';
import { postJson } from './http.js';
import { clamp01, str } from './util.js';

/** Sapling AI Detector: 0 = likely human-written, 1 = likely AI-generated. */
export async function detectAiText(text) {
  const data = await postJson(
    'https://api.sapling.ai/api/v1/aidetect',
    { text, sent_scores: true },
    { headers: { Authorization: `Bearer ${config.providers.saplingKey}` }, provider: 'sapling' },
  );
  if (!Number.isFinite(Number(data?.score))) throw new AnalysisError('provider_error', 502, { provider: 'sapling' });

  return {
    score: clamp01(data.score),
    sentences: (Array.isArray(data.sentence_scores) ? data.sentence_scores : [])
      .slice(0, 200)
      .map((s) => ({ text: str(s?.sentence, 1000), score: clamp01(s?.score) }))
      .filter((s) => s.text),
  };
}