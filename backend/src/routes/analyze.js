import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { getQuota, meter } from '../services/quota.js';
import { detectLanguage } from '../services/language.js';
import { AnalysisError } from '../services/errors.js';
import {
  ANALYSIS_TASKS,
  MAX_TEXT_CHARS,
  MAX_IMAGE_BASE64,
  MAX_BLOCKS,
  MAX_BLOCK_CHARS,
  isTaskAvailable,
  runTask,
} from '../services/analysis.js';

export const analyzeRouter = Router();
analyzeRouter.use(requireAuth);

const ROLE_RANK = { regular: 0, paid: 1, admin: 2 };
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Per-user burst limit, on top of the daily token quota.
const analyzeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { error: 'too_many_requests' },
});

analyzeRouter.get('/tasks', (_req, res) => {
  const tasks = Object.fromEntries(
    Object.entries(ANALYSIS_TASKS).map(([id, def]) => [id, { ...def, available: isTaskAvailable(id) }]),
  );
  res.json({ tasks, maxTextChars: MAX_TEXT_CHARS });
});

// Kept from Phase 1 for testing the quota system by hand.
analyzeRouter.post('/_test', meter('test', 1), (req, res) => {
  res.json({ ok: true, quota: getQuota(req.user) });
});

function readText(body) {
  if (typeof body?.text !== 'string') return { error: 'invalid_text' };
  const text = body.text.replace(/\u0000/g, '').trim();
  if (!text) return { error: 'invalid_text' };
  if (text.length > MAX_TEXT_CHARS) return { error: 'text_too_long' };
  return { input: { text } };
}

/** Passages for a whole-page scan. Empty entries are kept so positions still line up with the page. */
function readBlocks(body) {
  if (!Array.isArray(body?.blocks)) return { error: 'invalid_text' };
  const blocks = body.blocks
    .slice(0, MAX_BLOCKS)
    .map((b) => (typeof b === 'string' ? b.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_BLOCK_CHARS) : ''));
  if (!blocks.some(Boolean)) return { error: 'invalid_text' };
  return { input: { blocks } };
}

function readImage(body) {
  if (typeof body?.imageUrl === 'string') {
    let url;
    try {
      url = new URL(body.imageUrl);
    } catch {
      return { error: 'invalid_image' };
    }
    if (!['http:', 'https:'].includes(url.protocol) || body.imageUrl.length > 2048) {
      return { error: 'invalid_image' };
    }
    return { input: { kind: 'url', url: url.href } }; // fetched later with SSRF protection
  }
  if (typeof body?.imageData === 'string') {
    if (!IMAGE_TYPES.test(String(body.mimeType))) return { error: 'invalid_image' };
    if (body.imageData.length > MAX_IMAGE_BASE64) return { error: 'image_too_large' };
    if (!BASE64.test(body.imageData)) return { error: 'invalid_image' };
    return { input: { kind: 'data', data: body.imageData, mimeType: body.mimeType } };
  }
  return { error: 'invalid_image' };
}

/** Checks the task, the user's tier and the input before any tokens are charged. */
function validate(req, res, next) {
  const { task } = req.params;
  const def = Object.hasOwn(ANALYSIS_TASKS, task) ? ANALYSIS_TASKS[task] : null;
  if (!def) return res.status(404).json({ error: 'unknown_task' });
  if (ROLE_RANK[req.user.role] < ROLE_RANK[def.minRole]) {
    return res.status(403).json({ error: 'pro_required', task });
  }
  if (!isTaskAvailable(task)) return res.status(503).json({ error: 'not_connected', task });

  const parsed =
    def.input === 'text' ? readText(req.body) : def.input === 'blocks' ? readBlocks(req.body) : readImage(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  req.analysis = {
    task,
    def,
    input: parsed.input,
    language:
      def.input === 'text'
        ? detectLanguage(parsed.input.text)
        : def.input === 'blocks'
          ? detectLanguage(parsed.input.blocks.join(' '))
          : null,
  };
  next();
}

const charge = (req, res, next) => meter(req.analysis.task, req.analysis.def.cost)(req, res, next);

analyzeRouter.post('/:task', analyzeLimiter, validate, charge, async (req, res, next) => {
  const { task, input, language } = req.analysis;
  try {
    const result = await runTask(task, { ...input, language });
    res.json({ task, language, result, quota: getQuota(req.user) });
  } catch (err) {
    // Any error status refunds the tokens (see services/quota.js).
    if (err instanceof AnalysisError) {
      if (err.status >= 500) console.warn(`[analyze:${task}] ${err.code}`);
      return res.status(err.status).json({ error: err.code, task, language });
    }
    next(err);
  }
});