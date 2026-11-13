/**
 * Serveur de développement local (hors Cloudflare) : sert public/ et l'API
 * avec une base D1 simulée par better-sqlite3 (fichier ./dev.sqlite).
 * Utile pour tester sans compte Cloudflare : node dev-server.mjs
 * NON destiné à la production.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import worker from './worker/worker.js';

const DB_FILE = './dev.sqlite';
const fresh = !fs.existsSync(DB_FILE);
const db = new Database(DB_FILE);
if (fresh) db.exec(fs.readFileSync('./worker/schema.sql', 'utf8'));

const stmt = (sql, params = []) => {
  const s = db.prepare(sql);
  const norm = params.map((p) => (p === undefined ? null : p));
  return {
    bind: (...m) => stmt(sql, [...norm, ...m]),
    _runSync: () => /^\s*SELECT\b/i.test(sql) ? ({ success: true, results: db.prepare(sql).all(...norm), meta: {} }) : ({ success: true, meta: db.prepare(sql).run(...norm) }),
    first: async () => s.get(...norm) ?? null,
    all: async () => ({ results: s.all(...norm) }),
    run: async () => ({ success: true, meta: s.run(...norm) }),
  };
};
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (statements) => db.transaction(() => statements.map((s) => s._runSync()))() } };
const PUBLIC = path.resolve('./public');

/* Faux binding ASSETS : reproduit ce que fait Cloudflare pour [assets].
   On passe ainsi par worker/worker.js — le MÊME point d'entrée qu'en
   production — donc les en-têtes de sécurité et le routage /api/* sont
   réellement testés en local. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const ASSETS = {
  async fetch(request) {
    const u = new URL(request.url);
    let rel = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // not_found_handling = single-page-application : on renvoie index.html
      const idx = path.join(PUBLIC, 'index.html');
      if (fs.existsSync(idx)) {
        return new Response(fs.readFileSync(idx), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('404', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response(fs.readFileSync(file), {
      status: 200,
      headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' },
    });
  },
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request('http://localhost' + req.url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const out = await worker.fetch(request, { ...env, ASSETS }, {});
  const outHeaders = {};
  out.headers.forEach((val, key) => { outHeaders[key] = val; });
  res.writeHead(out.status, outHeaders);
  res.end(Buffer.from(await out.arrayBuffer()));
});

server.listen(8787, '0.0.0.0', () => console.log('dev : http://localhost:8787'));
