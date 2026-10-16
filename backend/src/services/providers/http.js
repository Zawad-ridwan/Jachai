import { AnalysisError } from '../errors.js';

/**
 * Calls an AI provider and turns every kind of failure into a clear
 * AnalysisError. Never logs request URLs or headers (they can contain keys).
 *
 * 429 (rate limited) and 503 (the provider is temporarily overloaded — Gemini
 * returns this fairly often at busy times) are treated as transient: worth a
 * couple of quick retries before giving up and telling the person to try again.
 */
const RETRYABLE = new Set([429, 503]);
const RETRY_DELAYS_MS = [800, 2000]; // two retries: ~0.8s, then ~2s

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(url, { method, body, headers = {}, timeoutMs = 30_000 }) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, ok: res.ok, data, text };
}

async function request(url, opts) {
  const { provider } = opts;
  let lastNetworkErr = null;

  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    let result;
    try {
      result = await attempt(url, opts);
    } catch (err) {
      lastNetworkErr = err;
      if (i < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[i]);
        continue;
      }
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new AnalysisError(timedOut ? 'provider_timeout' : 'provider_unreachable', 504, { provider });
    }

    if (result.ok) return result.data;

    console.warn(`[${provider}] HTTP ${result.status}: ${result.text.slice(0, 300)}`);
    if (RETRYABLE.has(result.status) && i < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[i]);
      continue;
    }

    const detail = { provider, status: result.status, data: result.data };
    if (RETRYABLE.has(result.status)) throw new AnalysisError('provider_busy', 503, detail);
    if (result.status === 401 || result.status === 403) throw new AnalysisError('provider_auth', 502, detail);
    throw new AnalysisError('provider_error', 502, detail);
  }
  // Unreachable, but keeps the type checker happy.
  throw new AnalysisError('provider_unreachable', 504, { provider, cause: lastNetworkErr });
}

export const postJson = (url, body, opts) => request(url, { ...opts, method: 'POST', body });
export const getJson = (url, opts) => request(url, { ...opts, method: 'GET' });