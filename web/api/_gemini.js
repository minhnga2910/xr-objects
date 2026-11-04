// Shared Gemini helper for the XR-Objects web demo.
// Files in /api whose name starts with "_" are not exposed as routes by Vercel.

export const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);
export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google retires model IDs constantly (gemini-2.0-flash was shut down on
// 2026-06-01; gemini-2.5-* now answer "no longer available to new users").
// Hard-coding one ID is what broke this app, so instead we ASK THE API which
// models the key can reach, rank them, and only use a static list as a last
// resort.
const STATIC_FALLBACK = [
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3-flash-preview'
];

// Per-instance caches (survive while the serverless instance stays warm).
let resolvedModel = null; // a model that actually answered
let discovered = null; // ranked list from the Models API
let quotaBlocked = false; // set after a 429 so callers can explain it

/** Families that cannot do plain "look at a photo and answer" text generation. */
const EXCLUDE = /embedding|aqa|imagen|veo|tts|transcribe|image|audio|live|nano-banana|lyria|robotics|computer-use|deep-research|antigravity|omni/;

/** Higher is better. Non-text models score -1 and are skipped entirely. */
function rank(id) {
  if (EXCLUDE.test(id)) return -1;
  if (!/^(gemini|gemma)/.test(id)) return -1;
  if (/^gemma/.test(id)) return 1; // weaker at vision: late fallback only

  let s = 0;
  // The "-latest" aliases are what Google recommends and they keep working
  // across retirements, so they win against pinned snapshots.
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

/** Models this API key can actually use. */
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

/** Ordered list of models to try, best first. */
export async function modelOrder() {
  const override = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
  return [
    ...new Set([resolvedModel, ...override, ...(await discoveredModels()), ...STATIC_FALLBACK].filter(Boolean))
  ];
}

export const LABEL_PROMPT = `You are powering an interactive tool called XR-Objects. The user has provided you with an image of an object. For this task please provide a brief label for the object.

For consumer products, search the internet and include the brand and name (e.g., "Apple Airpods" or "Logitech MX Keys Mini").
Similarly for packaged food and drink items (e.g., "Arizona Iced Tea").

For generic objects, like cups, bowls, tissues, boxes with no notable features then just simply say what it is (e.g., "Mug") - do not include terms like "generic" in your label.

For plants and other living things, try to include a species (or however they are commonly known) - for example, "Pothos" is preferable to "plant".

For fruits and other foods, try to include the type as well (e.g., "Fuji Apple") - if no specific type is clear, it is fine to just say the simple name (e.g., "Orange" or "Hot Dog").

For books, search the internet and include the title in quotes followed by the author (e.g., "The DaVinci Code" by Dan Brown).

Do not include size information. Search the internet as needed to confirm product names.

In your response, please do not provide any other text besides the label.
—---
Now please provide your label for the object in the image.`;

export const DETECT_PROMPT = `Find the physical, real-world objects in this photograph that a person could touch: drinkware, bottles, laptops, phones, plants, books, bags, fruit, headphones, keyboards, mice.
Return JSON only, matching:
{"objects":[{"label":"<short COCO-ish class in English, e.g. cup, bottle, laptop, potted plant, cell phone, book, backpack, apple>","bbox":{"x":<0-1 left>,"y":<0-1 top>,"w":<0-1 width>,"h":<0-1 height>},"confidence":<0-1>}]}
Rules: at most 8 objects, boxes must hug the object tightly, skip people, screens' contents, walls, floors, and background clutter. If nothing qualifies return {"objects":[]}.`;

function stripDataUrl(image) {
  if (!image) return null;
  const comma = image.indexOf(',');
  if (image.startsWith('data:') && comma !== -1) return image.slice(comma + 1);
  return image;
}

/** Build a Gemini content `parts` array from optional text + optional image. */
export function parts(text, image, mime = 'image/jpeg') {
  const out = [];
  if (text) out.push({ text });
  const data = stripDataUrl(image);
  if (data) out.push({ inline_data: { mime_type: mime, data } });
  return out;
}

function buildBody({ parts: contentParts, search, json: wantJson, temperature }) {
  if (!Array.isArray(contentParts) || contentParts.length === 0) {
    // Guards the bug that once sent {"parts": undefined} and made Google answer
    // "400 Request has empty input" for every model.
    throw new Error('generate() called without any content parts');
  }
  const body = {
    contents: [{ parts: contentParts }],
    generationConfig: { temperature: temperature ?? 0.4 }
  };
  // Grounding with Google Search is what makes labels/dates/prices current,
  // exactly like the `tools: [{ google_search: {} }]` body in ImageQuery.cs.
  // It cannot be combined with a forced JSON mime type.
  if (search && !wantJson) body.tools = [{ google_search: {} }];
  if (wantJson) body.generationConfig.responseMimeType = 'application/json';
  return body;
}

/** True when the error means "this model ID does not exist / was retired". */
function isRetired(err) {
  const msg = String(err?.message || err);
  return /NOT_FOUND|is no longer available|not found|not supported|404|unsupported/i.test(msg);
}

/** Statuses that are model-specific, so another model may still answer. */
const RETRYABLE = new Set([400, 403, 404, 429, 500, 502, 503, 504]);

/**
 * Call Gemini, transparently falling back to another model when the preferred
 * one was retired, is gated for this account, or is out of quota.
 * @returns {Promise<{text: string, model: string, latencyMs: number, tried: Array}>}
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
        const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
        const err = new Error(`Gemini ${res.status} (${model}): ${detail}`);
        err.status = res.status;
        if (res.status === 429) quotaBlocked = true;
        tried.push({ model, status: res.status, detail: detail.slice(0, 220) });
        lastErr = err;
        if (RETRYABLE.has(res.status) || isRetired(err)) continue;
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
        tried.push({ model, status: reason });
        lastErr = new Error(`Gemini returned no text (${reason}) from ${model}`);
        continue;
      }

      resolvedModel = model;
      return { text, model, latencyMs, tried };
    } catch (err) {
      if (!tried.some((t) => t.model === model)) {
        tried.push({ model, status: err.status || 'error' });
      }
      lastErr = err;
      if (!isRetired(err) && !RETRYABLE.has(err.status)) throw err;
    }
  }

  const err = lastErr || new Error('No Gemini model available');
  err.tried = tried;
  err.quota = quotaBlocked;
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
  if (/without any content parts/.test(message)) {
    return json(res, 500, { error: 'BAD_PAYLOAD', message });
  }
  if (isRetired(err)) {
    return json(res, 502, {
      error: 'MODEL_RETIRED',
      message:
        'Không model Gemini nào trong danh sách còn hoạt động với API key này. ' +
        'Mở /api/models?test=1 để xem model nào lỗi gì.',
      detail: message,
      tried: err?.tried || []
    });
  }
  if (err?.quota || /429/.test(message)) {
    return json(res, 429, {
      error: 'QUOTA',
      message:
        'Gemini báo hết quota free-tier (429). Đợi hạn mức reset, hoặc bật billing / dùng key khác.',
      detail: message,
      tried: err?.tried || []
    });
  }
  console.error('[xr-objects]', message);
  return json(res, 502, {
    error: 'UPSTREAM',
    message: 'Gemini trả lỗi. Mở /api/models?test=1 để xem chi tiết từng model.',
    detail: message,
    tried: err?.tried || []
  });
}

/** Rough language guess so answers come back in Vietnamese for Vietnamese asks. */
export function looksVietnamese(text = '') {
  return /[ăâđêôơưàáảãạằắẳẵặèéẻẽẹìíỉĩịòóỏõọồốổỗộùúủũụỳýỷỹỵ]/i.test(text);
}
