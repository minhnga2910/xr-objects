// GET /api/models — diagnostics for the Gemini integration.
//
// Google retires model IDs constantly (gemini-2.0-flash was shut down on
// 2026-06-01). A retired ID used to surface in the app as a bare "502", so this
// route reports exactly what the configured key can reach.
//
//   /api/models           -> models the key can use + the ranked try-order
//   /api/models?test=1    -> also send a real prompt to prove it works
//
// Never returns the API key.
import { HAS_KEY, currentModel, modelOrder, listModels, generate, json } from './_gemini.js';

export default async function handler(req, res) {
  const out = {
    ok: false,
    keyConfigured: HAS_KEY,
    resolvedNow: currentModel(),
    order: [],
    available: [],
    usable: [],
    error: null,
    test: null
  };

  if (!HAS_KEY) {
    out.error = 'GEMINI_API_KEY is not set';
    return json(res, 503, out);
  }

  try {
    const models = await listModels();
    out.available = models.map((m) => m.id);
    out.usable = out.available.filter(
      (id) => /^(gemini|gemma)/.test(id) && !/embedding|aqa|imagen|veo|tts|image|audio|live/.test(id)
    );
    out.ok = out.usable.length > 0;
  } catch (err) {
    out.error = String(err?.message || err);
  }

  try {
    out.order = await modelOrder();
  } catch {
    /* order is best-effort */
  }

  if (req.query?.test === '1') {
    try {
      const result = await generate({
        parts: [{ text: 'Reply with exactly: ping' }],
        temperature: 0
      });
      out.test = {
        ok: true,
        model: result.model,
        reply: result.text.slice(0, 60),
        latencyMs: result.latencyMs,
        triedBefore: result.tried
      };
      out.ok = true;
    } catch (err) {
      out.test = {
        ok: false,
        error: String(err?.message || err).slice(0, 300),
        // which models were tried and how each failed (e.g. 429 on one model
        // does not mean the key or quota is dead for every model)
        tried: err?.tried || []
      };
      out.ok = false;
    }
  }

  return json(res, out.ok ? 200 : 502, out);
}
