import { generate, fail, json, readBody, parts, looksVietnamese } from './_gemini.js';

// POST /api/compare  { images: [dataUrl, ...], labels: [..], question? }
// ActionCompareMultiple.cs equivalent: the Unity app crops every registered
// object, tiles them into one image and asks Gemini to compare. We just pass the
// crops through (max 4) — same prompt, same 30-word constraint.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD', message: 'Use POST' });

  try {
    const { images = [], labels = [], question = '' } = await readBody(req);
    if (!Array.isArray(images) || images.length < 2) {
      return json(res, 400, {
        error: 'BAD_REQUEST',
        message: 'Cần ít nhất 2 vật thể. Hãy nhận diện thêm vật thể rồi thử lại.'
      });
    }

    const labelList = labels.filter(Boolean).join(', ') || 'these objects';
    const lang = looksVietnamese(question) ? 'vi' : 'en';
    const base = question.trim()
      ? `The user asks: "${question}".`
      : 'In only 1-2 sentences compare the objects/products here by searching the Internet and summarizing key facts and differences (in only 30 words).';

    const prompt = `You are XR-Objects comparing several real-world objects the user has in front of them.
The objects are: ${labelList}. Each image below is one of them, in the same order.
${base}
Be specific and practical (use, price, materials, which one to pick). No markdown, no bullet points.
Answer in ${lang === 'vi' ? 'Vietnamese' : 'English'}.`;

    const contentParts = [{ text: prompt }];
    images.slice(0, 4).forEach((img, i) => {
      contentParts.push({ text: `Object ${i + 1}${labels[i] ? ` — ${labels[i]}` : ''}:` });
      contentParts.push(...parts('', img));
    });

    const { text, model, latencyMs } = await generate({
      parts: contentParts,
      search: true,
      temperature: 0.5
    });

    return json(res, 200, { text, model, latencyMs, lang });
  } catch (err) {
    return fail(res, err);
  }
}
