import { config } from '../../config.js';
import { AnalysisError } from '../errors.js';
import { postJson } from './http.js';

// Gemini "generateContent" API with structured JSON output.
// Google now labels generateContent "legacy" but it's fully supported and
// the stable choice for a server like this one.

// This tool analyzes harmful text on purpose, so only the most severe
// content is blocked (the default would refuse to analyze most toxic posts).
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

/**
 * One call to one specific model. http.js already retries transient (429/503)
 * failures a couple of times.
 *
 * Structured output uses the older, well-established generationConfig fields
 * (responseMimeType + responseJsonSchema) rather than the newer nested
 * "responseFormat" field. That newer field was rejected outright by the API
 * with a 400 for some accounts/regions (Invalid value at
 * generation_config.response_format.text.mime_type), and detecting that
 * rejection reliably across Google's different error message shapes turned
 * out to be more fragile than just using the field that's always worked.
 */
async function callModel(model, { system, parts, schema }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJson(
    url,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      safetySettings: SAFETY_SETTINGS,
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
    },
    { headers: { 'x-goog-api-key': config.providers.geminiKey }, provider: 'gemini', timeoutMs: 60_000 },
  );

  if (data?.promptFeedback?.blockReason) throw new AnalysisError('content_blocked', 422);
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new AnalysisError('provider_error', 502, { provider: 'gemini', reason: 'no_candidate' });
  if (BLOCKED_FINISH.has(candidate.finishReason)) throw new AnalysisError('content_blocked', 422);

  const text = (candidate.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new AnalysisError('provider_error', 502, { provider: 'gemini', reason: 'bad_json' });
  }
}

const isOverload = (err) => err instanceof AnalysisError && err.code === 'provider_busy';

/**
 * @param {object} opts
 * @param {string} opts.system  instructions for the model
 * @param {Array}  opts.parts   user content parts: { text } or { inlineData: { mimeType, data } }
 * @param {object} opts.schema  JSON Schema the answer must follow
 *
 * Gemini's flash models occasionally report themselves as overloaded (a 503
 * "high demand" response) for minutes at a time — free-tier requests are hit
 * hardest, since they're served at the lowest priority. http.js already
 * retries that a couple of times on the same model; if it's still overloaded
 * after those retries, this works down a list of fallback models (usually
 * older, less contested ones) until one answers or the list runs out.
 */
export async function geminiJson(opts) {
  const { geminiModel, geminiFallbackModels } = config.providers;
  const chain = [geminiModel, ...geminiFallbackModels.filter((m) => m !== geminiModel)];

  let lastErr;
  for (const [i, model] of chain.entries()) {
    try {
      return await callModel(model, opts);
    } catch (err) {
      lastErr = err;
      if (!isOverload(err)) throw err; // a real error (bad request, blocked content) isn't worth trying another model for
      if (i < chain.length - 1) console.warn(`[gemini] ${model} is overloaded, trying ${chain[i + 1]}`);
    }
  }
  throw lastErr;
}