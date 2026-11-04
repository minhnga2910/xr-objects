// GET /api/health — self-check used after deployment (and by the Settings sheet).
// Verifies that the Gemini key and the Supabase project are reachable from the
// serverless runtime, without ever returning a secret.
export default async function handler(req, res) {
  const out = {
    ok: true,
    gemini: {
      configured: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    },
    supabase: { configured: false, reachable: false, tables: null, error: null },
    time: new Date().toISOString()
  };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (url && key) {
    out.supabase.configured = true;
    try {
      const r = await fetch(`${url}/rest/v1/object_feed?select=id&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
        signal: AbortSignal.timeout(8000)
      });
      out.supabase.reachable = r.ok;
      out.supabase.tables = r.headers.get('content-range');
      if (!r.ok) out.supabase.error = `${r.status} ${(await r.text()).slice(0, 200)}`;
    } catch (err) {
      out.supabase.error = String(err?.message || err);
    }
  } else {
    out.ok = false;
  }

  if (!out.supabase.reachable && out.supabase.configured) out.ok = false;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
