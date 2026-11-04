import { generate, fail, json, readBody, parts, looksVietnamese } from './_gemini.js';

// POST /api/ask  { image, label, question, history? }
// The "ask a question" action — ActionAsk.cs / RunFollowUpImageQuery().
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD', message: 'Use POST' });

  try {
    const { image, label = 'object', question = '', history = [] } = await readBody(req);
    if (!question.trim()) {
      return json(res, 400, { error: 'BAD_REQUEST', message: 'missing question' });
    }

    const lang = looksVietnamese(question) ? 'vi' : 'en';
    const turns = Array.isArray(history) ? history.slice(-4) : [];
    const historyText = turns
      .map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text}`)
      .join('\n');

    const prompt = `You are XR-Objects: the user is holding their phone up at a real object, which the camera sees in the photo. Its label is "${label}".
Answer their question about *this specific object* concisely and concretely — 1 to 3 sentences, no markdown, no bullet lists. Search the internet when the answer depends on current facts (price, release date, nutrition, availability).
${historyText ? `Earlier in this conversation:\n${historyText}\n` : ''}
Question: ${question}`;

    const { text, model, latencyMs } = await generate({
      parts: parts(prompt, image),
      search: true,
      temperature: 0.6
    });

    return json(res, 200, { text, model, latencyMs, lang });
  } catch (err) {
    return fail(res, err);
  }
}
