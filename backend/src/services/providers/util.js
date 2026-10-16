export const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const strList = (v, maxItems = 5, maxLen = 300) =>
  (Array.isArray(v) ? v : []).map((s) => str(s, maxLen)).filter(Boolean).slice(0, maxItems);

export const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);