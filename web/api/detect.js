import { generate, fail, json, readBody, parts, DETECT_PROMPT } from './_gemini.js';

// POST /api/detect  { image: "data:image/jpeg;base64,..." }
// Returns normalized boxes for actionable real-world objects — the web stand-in
// for MediaPipe's ObjectDetector in ARCursor.cs (which only knows 12 COCO classes;
// Gemini also reads brand names, so we get "Arizona Iced Tea" for free).
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD', message: 'Use POST' });

  try {
    const { image } = await readBody(req);
    if (!image) return json(res, 400, { error: 'BAD_REQUEST', message: 'missing image' });

    const { text, model, latencyMs } = await generate({
      parts: parts(DETECT_PROMPT, image),
      json: true,
      temperature: 0.1
    });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Gemini occasionally wraps JSON in a fenced block.
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { objects: [] };
    }

    const objects = (parsed.objects || [])
      .map((o) => {
        const b = o.bbox || {};
        const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
        const w = clamp(b.w);
        const h = clamp(b.h);
        return {
          label: String(o.label || 'object').toLowerCase().slice(0, 40),
          bbox: {
            x: Math.min(clamp(b.x), 1 - w),
            y: Math.min(clamp(b.y), 1 - h),
            w,
            h
          },
          confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0.8))
        };
      })
      .filter((o) => o.bbox.w > 0.02 && o.bbox.h > 0.02)
      .slice(0, 8);

    return json(res, 200, { objects, model, latencyMs });
  } catch (err) {
    return fail(res, err);
  }
}
