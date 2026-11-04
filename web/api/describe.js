import { generate, fail, json, readBody, parts } from './_gemini.js';

// POST /api/describe  { image, label, lang }
// The "information" action — ActionSearch.cs equivalent: a 2-4 sentence summary
// grounded in a Google Search so prices/specs/dates are current.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD', message: 'Use POST' });

  try {
    const { image, label = 'object', lang = 'vi' } = await readBody(req);

    const prompt = `You are the "information" panel of XR-Objects, an augmented-reality app.
The user is looking at the real-world object in the photo. Its label is: "${label}".

Search the internet and give a genuinely useful summary of this object, as if the user were holding it:
- what it is, and the brand/model if it is a product
- 2-3 concrete facts someone would care about (what it is for, key spec, origin, price range, calories, care instructions...)
- if it is edible, say what it is and anything notable
Keep it to 3 short sentences maximum. No preamble, no markdown headings, no bullet points.
Answer in ${lang === 'vi' ? 'Vietnamese' : 'English'}.`;

    const { text, model, latencyMs } = await generate({
      parts: parts(prompt, image),
      search: true,
      temperature: 0.5
    });

    return json(res, 200, { text, model, latencyMs });
  } catch (err) {
    return fail(res, err);
  }
}
