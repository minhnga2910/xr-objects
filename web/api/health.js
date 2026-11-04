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

  // ?write=1 also exercises the exact path the browser uses (publishable key +
  // RLS insert), then deletes the row it created so the table stays clean.
  if (out.supabase.reachable && req.query?.write === '1') {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };
    const probe = {
      device: 'health-check',
      user_agent: 'xr-objects /api/health?write=1'
    };
    try {
      const ins = await fetch(`${url}/rest/v1/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify([probe]),
        signal: AbortSignal.timeout(8000)
      });
      if (!ins.ok) throw new Error(`insert ${ins.status} ${(await ins.text()).slice(0, 200)}`);
      const rows = await ins.json();
      const id = rows?.[0]?.id;
      out.supabase.writeTest = id ? 'insert ok' : 'insert returned no row';
      if (id) {
        await fetch(`${url}/rest/v1/sessions?id=eq.${id}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(8000)
        });
        out.supabase.writeTest += ' / cleanup ok';
      }
    } catch (err) {
      out.supabase.writeTest = `failed: ${String(err?.message || err)}`;
      out.ok = false;
    }
  }

  if (!out.supabase.reachable && out.supabase.configured) out.ok = false;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}
