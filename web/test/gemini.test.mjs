// Offline checks for the Gemini helper — no network, no API key needed.
// Run: node test/gemini.test.mjs
//
// These exist because a wrong field name once made every request send
// {"contents":[{"parts":undefined}]}, which Google answered with
// "400 Request has empty input" for every single model — looking like an
// API/model problem when it was a typo in our own payload.

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Capture the request body generate() would send, by stubbing global fetch.
let captured = [];
globalThis.fetch = async (url, init = {}) => {
  captured.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'stub answer' }] } }] }),
    text: async () => ''
  };
};

process.env.GEMINI_API_KEY = 'test-key';

const { generate, parts, LABEL_PROMPT, DETECT_PROMPT } = await import('../api/_gemini.js');

console.log('gemini payload');

await generate({ parts: parts('hello', null), temperature: 0.3 });
const body = captured.at(-1)?.body;
check('request contains at least one text part', () => {
  assert(body, 'no request captured');
  assert(Array.isArray(body.contents?.[0]?.parts), 'contents[0].parts is not an array');
  assert(body.contents[0].parts.length > 0, 'contents[0].parts is empty');
  assert(body.contents[0].parts[0].text === 'hello', 'text part missing');
});

check('generationConfig carries the temperature', () => {
  assert(body.generationConfig?.temperature === 0.3, 'temperature not forwarded');
});

check('image part uses inline_data with a stripped data URL', async () => {
  captured = [];
  await generate({ parts: parts('describe', 'data:image/jpeg;base64,QUJD'), json: true });
  const inline = captured.at(-1).body.contents[0].parts[1];
  assert(inline?.inline_data?.mime_type === 'image/jpeg', 'mime type wrong');
  assert(inline.inline_data.data === 'QUJD', `base64 not stripped: ${inline.inline_data.data}`);
});

check('json mode sets responseMimeType and omits search tools', async () => {
  captured = [];
  await generate({ parts: parts('x', null), json: true, search: true });
  const b = captured.at(-1).body;
  assert(b.generationConfig.responseMimeType === 'application/json', 'responseMimeType missing');
  assert(!b.tools, 'search tool must not be combined with forced JSON');
});

check('search grounding is sent when requested without json mode', async () => {
  captured = [];
  await generate({ parts: parts('x', null), search: true });
  const b = captured.at(-1).body;
  assert(Array.isArray(b.tools) && b.tools[0].google_search, 'google_search tool missing');
});

check('empty parts are rejected before hitting the network', async () => {
  captured = [];
  let threw = false;
  try {
    await generate({ parts: [] });
  } catch {
    threw = true;
  }
  assert(threw, 'generate() accepted an empty parts array');
  assert(captured.length === 0, 'request was sent despite empty parts');
});

console.log('prompts');
check('label prompt keeps the original XR-Objects wording', () => {
  assert(/XR-Objects/.test(LABEL_PROMPT), 'label prompt lost its XR-Objects preamble');
  assert(/brand and name/.test(LABEL_PROMPT), 'label prompt lost the brand instruction');
});
check('detect prompt asks for JSON with bbox', () => {
  assert(/"objects"/.test(DETECT_PROMPT), 'detect prompt is missing the objects key');
  assert(/bbox/.test(DETECT_PROMPT), 'detect prompt is missing bbox');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
