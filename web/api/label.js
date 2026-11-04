import { generate, fail, json, readBody, parts, LABEL_PROMPT } from './_gemini.js';

// POST /api/label  { image }
// Runs the exact initial prompt from ImageQuery.cs: name/brand + model/type/species.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD', message: 'Use POST' });

  try {
    const { image } = await readBody(req);
    if (!image) return json(res, 400, { error: 'BAD_REQUEST', message: 'missing image' });

    const { text, model, latencyMs } = await generate({
      parts: parts(LABEL_PROMPT, image),
      search: true,
      temperature: 0.2
    });

    const label = text.split('\n')[0].replace(/^["'“”]|["'“”]$/g, '').trim().slice(0, 120);
    return json(res, 200, { label, model, latencyMs });
  } catch (err) {
    return fail(res, err);
  }
}
