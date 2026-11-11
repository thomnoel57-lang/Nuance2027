/**
 * Nuance — point d'entrée Cloudflare Worker.
 *
 * Deux modes, selon la présence du binding ASSETS (voir wrangler.toml) :
 *
 *  1. ASSETS présent (hébergement statique récent) :
 *     /api/*  -> API (worker/index.js)
 *     reste   -> fichiers statiques servis par Cloudflare
 *
 *  2. ASSETS absent (compatibilité maximale) :
 *     tout    -> fichiers statiques lus dans le dossier ./public via le
 *                binding KV `SITE` (facultatif) ; si SITE est absent,
 *                l'API seule est servie et les fichiers doivent être
 *                déployés par Pages.
 *
 * Ce fichier n'ajoute des en-têtes de sécurité que sur les réponses HTML/API,
 * jamais sur les assets binaires.
 */
import api from './api.js';

const SECURITY_HEADERS = {
  // Interdit l'inférence de type, le cadrage par un tiers, et le sniffing.
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  // À ajuster si vous ajoutez des ressources externes. 'unsafe-inline' est
  // nécessaire ici car Nuance embarque son CSS et son JS dans la page.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function withSecurity(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- API ----
    if (url.pathname.startsWith('/api/')) {
      return withSecurity(await api.fetch(request, env, ctx));
    }

    // ---- Fichiers statiques ----
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      // N'ajouter les en-têtes de sécurité qu'aux documents HTML
      const ctype = res.headers.get('Content-Type') || '';
      return ctype.includes('text/html') ? withSecurity(res) : res;
    }

    // Repli : API seule (le site est alors servi par Cloudflare Pages)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return withSecurity(
        new Response(
          '<!doctype html><meta charset="utf-8"><title>API Nuance</title>' +
            '<p>Cette Worker sert uniquement l’API. Déployez <code>public/index.html</code> ' +
            'via Cloudflare Pages, ou activez le binding <code>ASSETS</code>.</p>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )
      );
    }

    return new Response('Not found', { status: 404 });
  },
};
