// Shared Gemini helper for the XR-Objects web demo.
// Files in /api whose name starts with "_" are not exposed as routes by Vercel.

export const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);
export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google retires model IDs constantly (gemini-2.0-flash was shut down on
// 2026-06-01, replaced by the 3.x Flash line). Hard-coding one ID is what broke
// this app, so instead we ASK THE API which models the key can reach, rank them,
// and only use a static list as a last resort.
//
// Ordered fallbacks used when discovery fails or the key cannot list models.
// `gemini-flash-latest` is an alias Google keeps pointed at the current Flash
// model, which makes it the safest default.
const STATIC_FALLBACK = [
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

// Per-instance caches (survive while the serverless instance stays warm).
let resolvedModel = null; // a model that actually answered
let discovered = null; // ranked list from the Models API

/** Families that cannot do plain "look at a photo and answer" text generation. */
const EXCLUDE = /embedding|aqa|imagen|veo|tts|transcribe|image|audio|live|nano-banana|lyria|robotics|computer-use|deep-research|antigravity|omni/;

/** Higher is better. Non-text models score -1 and are skipped entirely. */
function rank(id) {
  if (EXCLUDE.test(id)) return -1;
  if (!/^(gemini|gemma)/.test(id)) return -1;
  // gemma is fine but weaker at vision; keep it as a late fallback only.
  if (/^gemma/.test(id)) return 1;

  let s = 0;
  // The "-latest" aliases are what Google recommends and what keeps working
  // across retirements, so they win ties against pinned snapshots.
  if (id === 'gemini-flash-latest') s += 500;
  else if (id === 'gemini-flash-lite-latest') s += 460;
  else if (id === 'gemini-pro-latest') s += 430;

  const m = id.match(/gemini-(\d+)(?:\.(\d+))?/);
  if (m) s += Number(m[1]) * 100 + Number(m[2] || 0) * 10;

  if (/flash/.test(id)) s += 60;
  if (/pro/.test(id)) s += 20;
  if (/lite/.test(id)) s -= 5;
  if (/preview|exp\b|experimental/.test(id)) s -= 80; // often free-tier gated
  if (/\d{8}$/.test(id)) s -= 40; // dated snapshots
  return s;
}

/** Models this API key can actually use, newest/most capable first. */
export async function listModels() {
  if (!HAS_KEY) return [];
  const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}&pageSize=100`, {
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`listModels ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), display: m.displayName }));
}

/** Ranked text-capable model IDs from the API (cached per instance). */
async function discoveredModels() {
  if (discovered) return discovered;
  try {
    const models = await listModels();
    discovered = models
      .map((m) => m.id)
      .filter((id) => rank(id) > 0)
      .sort((a, b) => rank(b) - rank(a));
  } catch {
    discovered = [];
  }
  return discovered;
}

function stripDataUrl(image) {
  if (!image) return null;
  const comma = image.indexOf(',');
  if (image.startsWith('data:') && comma !== -1) return image.slice(comma + 1);
  return image;
}

function parts(text, image, mime = 'image/jpeg') {
  const out = [];
  if (text) out.push({ text });
  const data = stripDataUrl(image);
  if (data) out.push({ inline_data: { mime_type: mime, data } });
  return out;
}

function buildBody({ contentParts, search, json: wantJson, temperature }) {
  const body = {
    contents: [{ parts: contentParts }],
    generationConfig: { temperature }
  };
  // Grounding with Google Search is what makes labels/dates/prices current,
  // exactly like the `tools: [{ google_search: {} }]` body in ImageQuery.cs.
  // It cannot be combined with a forced JSON mime type.
  if (search && !wantJson) body.tools = [{ google_search: {} }];
  if (wantJson) body.generationConfig.responseMimeType = 'application/json';
  return body;
}

/** Ordered list of models to try, best first. */
export async function modelOrder() {
  const override = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
  return [
    ...new Set([resolvedModel, ...override, ...(await discoveredModels()), ...STATIC_FALLBACK].filter(Boolean))
  ];
}

/** True when the error means "this model ID does not exist / was retired". */
function isRetired(err) {
  const msg = String(err?.message || err);
  return /NOT_FOUND|is no longer available|not found|not supported|404|unsupported/i.test(msg);
}

/**
 * Call Gemini, transparently falling back to another model if the preferred one
 * has been retired by Google.
 * @returns {Promise<{text: string, model: string, latencyMs: number, tried: string[]}>}
 */
export async function generate(opts) {
  if (!HAS_KEY) throw new Error('NO_KEY');

  const body = buildBody(opts);
  const order = await modelOrder();
  const tried = [];
  let lastErr = null;

  for (const model of order) {
    const started = Date.now();
    try {
      const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000)
      });
      const latencyMs = Date.now() - started;

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 400);
        const err = new Error(`Gemini ${res.status} (${model}): ${detail}`);
        err.status = res.status;
        tried.push({ model, status: res.status });
        lastErr = err;
        // Retired model, bad request, quota or a transient upstream error: all of
        // these can be model-specific, so move on and let another model answer.
        if ([400, 403, 404, 429, 500, 502, 503, 504].includes(res.status) || isRetired(err)) continue;
        throw err;
      }

      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const text = (candidate?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();

      if (!text) {
        const reason = candidate?.finishReason || data?.promptFeedback?.blockReason || 'EMPTY';
        throw new Error(`Gemini returned no text (${reason}) from ${model}`);
      }

      resolvedModel = model;
      return { text, model, latencyMs, tried };
    } catch (err) {
      if (!tried.some((t) => (typeof t === 'string' ? t : t.model) === model)) {
        tried.push({ model, status: err.status || 'error' });
      }
      lastErr = err;
      if (!isRetired(err) && ![400, 403, 404, 429, 500, 502, 503, 504].includes(err.status)) throw err;
    }
  }

  const err = lastErr || new Error('No Gemini model available');
  err.tried = tried;
  throw err;
}

/** Model that has already proven to work in this instance, or null. */
export function currentModel() {
  return resolvedModel;
}

export async function candidates() {
  return modelOrder();
}

export function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Small helper so every route reports the same error shape. */
export function fail(res, err) {
  const message = String(err?.message || err);
  if (message === 'NO_KEY') {
    return json(res, 503, {
      error: 'NO_KEY',
      message: 'GEMINI_API_KEY chưa được cấu hình trên Vercel. App đang chạy ở chế độ demo.'
    });
  }
  if (isRetired(err)) {
    return json(res, 502, {
      error: 'MODEL_RETIRED',
      message:
        'Không model Gemini nào trong danh sách còn hoạt động với API key này. ' +
        'Kiểm tra biến GEMINI_MODEL (ví dụ gemini-flash-latest) hoặc key đã bị thu hồi.',
      detail: message
    });
  }
  console.error('[xr-objects]', message);
  return json(res, 502, { error: 'UPSTREAM', message });
}

/** Rough language guess so answers come back in Vietnamese for Vietnamese asks. */
export function looksVietnamese(text = '') {
  return /[ăâđêôơưàáảãạằắẳẵặèéẻẽẹìíỉĩịòóỏõọồốổỗộùúủũụỳýỷỹỵ]/i.test(text);
}

export { parts };
