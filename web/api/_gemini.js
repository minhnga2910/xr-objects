// Shared Gemini helper for the XR-Objects web demo.
// Files in /api whose name starts with "_" are not exposed as routes by Vercel.

export const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
export const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// The label prompt is lifted from XRObjects/Assets/XRObjects/Scripts/ImageQuery.cs
// so the web demo names objects exactly like the Unity prototype does.
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

function parts(text, image, mime = 'image/jpeg') {
  const out = [];
  if (text) out.push({ text });
  const data = stripDataUrl(image);
  if (data) out.push({ inline_data: { mime_type: mime, data } });
  return out;
}

/**
 * One-shot call to Gemini.
 * @param {object} opts
 * @param {Array} opts.parts  Gemini content parts
 * @param {boolean} [opts.search] enable the google_search grounding tool
 * @param {boolean} [opts.json]   force a JSON response
 * @param {number} [opts.temperature]
 * @returns {Promise<{text: string, model: string, latencyMs: number}>}
 */
export async function generate({ parts: contentParts, search = false, json = false, temperature = 0.4 }) {
  if (!HAS_KEY) throw new Error('NO_KEY');

  const url = `${ENDPOINT}/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: contentParts }],
    generationConfig: { temperature }
  };
  // Grounding with Google Search is what makes labels/dates/prices current,
  // exactly like the `tools: [{ google_search: {} }]` body in ImageQuery.cs.
  // It cannot be combined with a forced JSON mime type.
  if (search && !json) body.tools = [{ google_search: {} }];
  if (json) body.generationConfig.responseMimeType = 'application/json';

  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000)
  });

  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 400)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason || 'EMPTY';
    throw new Error(`Gemini returned no text (${reason})`);
  }
  return { text, model: MODEL, latencyMs };
}

export function textPart(text) {
  return { text };
}

export { parts };

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
  console.error('[xr-objects]', message);
  return json(res, 502, { error: 'UPSTREAM', message });
}

/** Rough language guess so answers come back in Vietnamese for Vietnamese asks. */
export function looksVietnamese(text = '') {
  return /[ăâđêôơưàáảãạằắẳẵặèéẻẽẹìíỉĩịòóỏõọồốổỗộùúủũụỳýỷỹỵ]/i.test(text);
}
