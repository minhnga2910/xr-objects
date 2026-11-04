// Minimal local dev server that emulates Vercel's static + serverless behaviour.
// Usage: node dev.mjs            (PORT=3000 by default)
// Not used in production — Vercel serves web/public and web/api directly.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const ROOT = resolve(import.meta.dirname, 'public');
const API = resolve(import.meta.dirname, 'api');

// load .env.local if present (GEMINI_API_KEY etc.)
for (const file of ['.env.local', '.env']) {
  if (!existsSync(join(import.meta.dirname, file))) continue;
  const text = await readFile(join(import.meta.dirname, file), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };
  return res;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!extname(rel)) {
    if (existsSync(join(ROOT, `${rel}.html`))) rel = `${rel}.html`;
    else if (existsSync(join(ROOT, rel, 'index.html'))) rel = join(rel, 'index.html');
  }
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.status(403).end('Forbidden'); return; }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>404</h1><p>Không tìm thấy trang.</p>');
  }
}

async function serveApi(req, res, pathname) {
  const name = pathname.replace(/^\/api\//, '').replace(/\.js$/, '');
  const file = join(API, `${name}.js`);
  if (!existsSync(file) || name.includes('..')) {
    res.status(404).json({ error: 'NOT_FOUND', message: `No API route ${name}` });
    return;
  }
  // collect body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  req.body = raw ? JSON.parse(raw) : {};

  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  await mod.default(req, decorate(res));
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await serveApi(req, res, url.pathname);
      else await serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'DEV_SERVER', message: String(err.message || err) });
    }
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`XR-Objects dev server → http://0.0.0.0:${PORT}`);
    console.log(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'set' : 'missing (demo mode)'}`);
    console.log(`SUPABASE_URL:   ${process.env.SUPABASE_URL || 'missing'}`);
  });
