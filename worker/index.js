/**
 * Nuance — API d'authentification et de synchronisation pour Cloudflare Workers + D1
 *
 * Contrat vérifié contre le code client de Nuance V16/V17 (apiFetch).
 * Chaque réponse contient { ok: true } ou { ok: false, error: "..." }.
 *
 * Sécurité :
 *  - mots de passe : PBKDF2-SHA256, coût configurable, sel unique par compte
 *  - sessions : jeton aléatoire de 32 octets, stocké côté base uniquement sous
 *    forme de SHA-256 ; cookie HttpOnly + Secure + SameSite=Lax
 *  - comparaison du jeton en temps constant
 *  - limitation des tentatives de connexion (5 échecs / 15 min / e-mail+IP)
 *  - CORS inutile : le site et l'API partagent la même origine (routing)
 */

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

const COOKIE_NAME = 'nuance_session';
const SESSION_DAYS = 30;
/* Coût du hachage.
 * OWASP recommande 600 000 itérations pour PBKDF2-SHA256. C'est hors de portée
 * du plan Workers Free (10 ms de CPU par requête) : /api/auth/login et
 * /api/auth/register sont les deux seuls points coûteux.
 * Valeur par défaut : 100 000, qui tient sur Free. Sur Workers Paid (30 s),
 * passez à 600 000 via la variable d'environnement PBKDF2_ITERATIONS.
 * Le nombre d'itérations est stocké PAR COMPTE (colonne `iterations`), donc
 * augmenter la valeur ne casse jamais les comptes existants : chaque compte
 * reste vérifiable avec son propre coût, et vous pouvez le réhacher à sa
 * prochaine connexion réussie.
 */
const DEFAULT_ITERATIONS = 100000;
const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const enc = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function fail(error, status = 400) {
  return json({ ok: false, error }, status);
}

// Borne aussi les requêtes sans Content-Length, avant d'allouer le JSON entier.
async function readJson(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) throw new RangeError('body too large');
  if (!request.body) throw new SyntaxError('empty body');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError('body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SyntaxError('object required');
  return result;
}

function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function randomB64(n) {
  return b64(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PBKDF2-SHA256 → 32 octets, renvoyés en base64 */
async function pbkdf2(password, saltB64, iterations) {
  const rawSalt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: rawSalt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return b64(bits);
}

/** Comparaison à temps constant (évite les attaques temporelles) */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function nowIso() {
  return new Date().toISOString();
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** Normalise et borne un état reçu du client (ne jamais faire confiance) */
function sanitizeState(raw) {
  const base = {
    v: 16,
    answers: {},
    mode: 'fusion',
    focus: [],
    idx: 0,
    autoAdv: false,
    subStep: null,
    order: [],
    stageSnapshots: {},
    checkpoint: 0,
    paused: false,
    finished: false,
    updatedAt: nowIso(),
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const src = raw.answers;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [id, a] of Object.entries(src)) {
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
      if (typeof a.st !== 'string' || a.st.length > 8) continue;
      const rec = { st: a.st, imp: [1, 2, 3].includes(a.imp) ? a.imp : 2 };
      if (typeof a.lv === 'string' && a.lv.length <= 40) rec.lv = a.lv;
      if (a.sub && typeof a.sub === 'object' && !Array.isArray(a.sub)) {
        const sub = {};
        for (const [key, value] of Object.entries(a.sub)) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          if (typeof value === 'string' && value) sub[key] = value;
        }
        if (Object.keys(sub).length) rec.sub = sub;
      }
      if (a.ts && typeof a.ts === 'string' && a.ts.length <= 32) rec.ts = a.ts;
      base.answers[id] = rec;
    }
  }
  base.focus = Array.isArray(raw.focus) ? raw.focus.filter((x) => typeof x === 'string').slice(0, 50) : [];
  base.idx = Number.isInteger(raw.idx) && raw.idx >= 0 ? raw.idx : 0;
  base.autoAdv = !!raw.autoAdv;
  base.subStep = typeof raw.subStep === 'string' ? raw.subStep.slice(0, 40) : null;
  base.order = Array.isArray(raw.order) ? raw.order.filter((x) => typeof x === 'string').slice(0, 500) : [];
  base.stageSnapshots =
    raw.stageSnapshots && typeof raw.stageSnapshots === 'object' && !Array.isArray(raw.stageSnapshots)
      ? raw.stageSnapshots
      : {};
  base.checkpoint = Number.isInteger(raw.checkpoint) && raw.checkpoint >= 0 ? raw.checkpoint : 0;
  base.paused = !!raw.paused;
  base.finished = !!raw.finished;
  base.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 32) : nowIso();
  return base;
}

function countAnswered(state) {
  return Object.values(state.answers || {}).filter((a) => a && a.st).length;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function cookieHeader(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(request) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return null;
}

async function createSession(env, userId) {
  const token = randomB64(32);
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(tokenHash, userId, nowIso(), expires)
    .run();
  return token;
}

/** Renvoie { user, session } ou null */
async function getSession(env, request) {
  const token = readCookie(request);
  if (!token || token.length > 200) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.expires_at, u.id, u.email, u.display_name, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return {
    user: { id: row.id, email: row.email, displayName: row.display_name || '', createdAt: row.created_at },
    session: row,
  };
}

/* ------------------------------------------------------------------ */
/* Anti-force brute                                                    */
/* ------------------------------------------------------------------ */

async function throttleKeys(email, ip) {
  return Promise.all([sha256Hex(`${email}|${ip}`), sha256Hex(`ip|${ip}`), sha256Hex(`email|${email}`)]);
}

async function isThrottled(env, email, ip) {
  const keys = await throttleKeys(email, ip);
  const limits = [MAX_ATTEMPTS, 50, 20];
  for (let i = 0; i < keys.length; i++) {
    const row = await env.DB.prepare('SELECT count, window_start FROM auth_throttle WHERE key = ?').bind(keys[i]).first();
    if (row && Date.now() - new Date(row.window_start).getTime() <= WINDOW_MINUTES * 60000 && row.count >= limits[i]) return true;
  }
  return false;
}

async function registerFailure(env, email, ip) {
  const keys = await throttleKeys(email, ip);
  const now = nowIso();
  const cutoff = new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();
  await env.DB.batch(keys.map((key) => env.DB.prepare(`
    INSERT INTO auth_throttle (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END
  `).bind(key, now, cutoff, cutoff)));
}

async function clearFailures(env, email, ip) {
  const keys = await throttleKeys(email, ip);
  // Ne pas effacer le compteur IP : il limite aussi les attaques multi-comptes.
  await env.DB.batch([0, 2].map((i) => env.DB.prepare('DELETE FROM auth_throttle WHERE key = ?').bind(keys[i])));
}

/* ------------------------------------------------------------------ */
/* État                                                               */
/* ------------------------------------------------------------------ */

async function loadStateRow(env, userId) {
  return env.DB.prepare('SELECT revision, state_json, updated_at FROM states WHERE user_id = ?')
    .bind(userId)
    .first();
}

/* ------------------------------------------------------------------ */
/* Routeur                                                             */
/* ------------------------------------------------------------------ */

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

  /* ---------- GET /api/auth/session ---------- */
  if (path === '/api/auth/session' && method === 'GET') {
    const anyRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const hasAnyAccount = (anyRow?.n || 0) > 0;

    const sess = await getSession(env, request);
    if (!sess) return json({ ok: true, authenticated: false, hasAnyAccount });

    const st = await loadStateRow(env, sess.user.id);
    return json({
      ok: true,
      authenticated: true,
      hasAnyAccount,
      user: sess.user,
      revision: st?.revision || 0,
      updatedAt: st?.updated_at || null,
      state: st ? JSON.parse(st.state_json) : null,
    });
  }

  /* ---------- POST /api/auth/register ---------- */
  if (path === '/api/auth/register' && method === 'POST') {
    let body;
    try {
      body = await readJson(request);
    } catch (err) {
      return err instanceof RangeError ? fail('Requête trop volumineuse.', 413) : fail('Corps de requête invalide.', 400);
    }
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim().slice(0, 60);
    const localState = sanitizeState(body.localState);

    if (!isValidEmail(email)) return fail('Adresse e-mail invalide.', 400);
    if (password.length < 8) return fail('Le mot de passe doit contenir au moins 8 caractères.', 400);
    if (password.length > 200) return fail('Mot de passe trop long.', 400);

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) return fail('Un compte existe déjà avec cette adresse e-mail.', 409);

    const anyRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const isFirstAccount = (anyRow?.n || 0) === 0;

    const id = crypto.randomUUID();
    const salt = randomB64(16);
    const iterations = Math.min(Math.max(Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS, 50000), 1000000);
    const hash = await pbkdf2(password, salt, iterations);

    await env.DB.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, email, displayName, hash, salt, iterations, nowIso())
      .run();

    // Le premier compte migre automatiquement les données locales du navigateur :
    // c'est le comportement attendu par le client (isFirstAccount + migratedAuto).
    let revision = 0;
    let updatedAt = null;
    if (isFirstAccount && countAnswered(localState) > 0) {
      revision = 1;
      updatedAt = nowIso();
      await env.DB.prepare(
        'INSERT INTO states (user_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?)'
      )
        .bind(id, revision, JSON.stringify(localState), updatedAt)
        .run();
    }

    const token = await createSession(env, id);
    return json(
      {
        ok: true,
        user: { id, email, displayName, createdAt: nowIso() },
        revision,
        updatedAt,
        isFirstAccount,
        migratedAuto: isFirstAccount && revision === 1,
      },
      201,
      { 'Set-Cookie': cookieHeader(token, SESSION_DAYS * 86400) }
    );
  }

  /* ---------- POST /api/auth/login ---------- */
  if (path === '/api/auth/login' && method === 'POST') {
    let body;
    try {
      body = await readJson(request);
    } catch (err) {
      return err instanceof RangeError ? fail('Requête trop volumineuse.', 413) : fail('Corps de requête invalide.', 400);
    }
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!isValidEmail(email) || !password || password.length > 200) return fail('Identifiants incomplets.', 400);
    if (await isThrottled(env, email, ip))
      return fail('Trop de tentatives. Réessayez dans quelques minutes.', 429);

    const row = await env.DB.prepare(
      'SELECT id, email, display_name, password_hash, password_salt, iterations, created_at FROM users WHERE email = ?'
    )
      .bind(email)
      .first();

    // Message volontairement identique dans les deux cas d'échec
    // (ne pas révéler si l'adresse existe).
    if (!row) {
      await registerFailure(env, email, ip);
      return fail('Adresse e-mail ou mot de passe incorrect.', 401);
    }

    const candidate = await pbkdf2(password, row.password_salt, row.iterations);
    if (!safeEqual(candidate, row.password_hash)) {
      await registerFailure(env, email, ip);
      return fail('Adresse e-mail ou mot de passe incorrect.', 401);
    }

    await clearFailures(env, email, ip);
    // Les comptes existants adoptent progressivement un coût relevé par
    // configuration, sans réinitialisation de mot de passe.
    const targetIterations = Math.min(Math.max(Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS, 50000), 1000000);
    if (row.iterations < targetIterations) {
      const salt = randomB64(16);
      const hash = await pbkdf2(password, salt, targetIterations);
      await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, iterations = ? WHERE id = ? AND password_hash = ?')
        .bind(hash, salt, targetIterations, row.id, row.password_hash).run();
    }
    const st = await loadStateRow(env, row.id);
    const token = await createSession(env, row.id);

    return json(
      {
        ok: true,
        user: {
          id: row.id,
          email: row.email,
          displayName: row.display_name || '',
          createdAt: row.created_at,
        },
        revision: st?.revision || 0,
        updatedAt: st?.updated_at || null,
        state: st ? JSON.parse(st.state_json) : null,
      },
      200,
      { 'Set-Cookie': cookieHeader(token, SESSION_DAYS * 86400) }
    );
  }

  /* ---------- POST /api/auth/logout ---------- */
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = readCookie(request);
    if (token) {
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader() });
  }

  /* ---------- Routes authentifiées ---------- */
  const sess = await getSession(env, request);

  /* ---------- GET /api/state/backups ---------- */
  if (path === '/api/state/backups' && method === 'GET') {
    if (!sess) return fail('Non authentifié.', 401);
    const { results } = await env.DB.prepare(
      `SELECT id, answers_count, reason, created_at
         FROM legacy_snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 20`
    )
      .bind(sess.user.id)
      .all();
    return json({ ok: true, backups: results || [] });
  }

  /* ---------- GET /api/state/backup?id=N ---------- */
  if (path === '/api/state/backup' && method === 'GET') {
    if (!sess) return fail('Non authentifié.', 401);
    const id = Number(url.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail('Identifiant d’archive invalide.', 400);
    const row = await env.DB.prepare(
      'SELECT id, state_json, answers_count, reason, created_at FROM legacy_snapshots WHERE id = ? AND user_id = ?'
    )
      .bind(id, sess.user.id)
      .first();
    if (!row) return fail('Archive introuvable.', 404);
    return json({
      ok: true,
      backup: {
        id: row.id,
        state: JSON.parse(row.state_json),
        answers_count: row.answers_count,
        reason: row.reason,
        created_at: row.created_at,
      },
    });
  }

  /* ---------- PUT /api/state ---------- */
  if (path === '/api/state' && method === 'PUT') {
    if (!sess) return fail('Non authentifié.', 401);
    let body;
    try {
      body = await readJson(request);
    } catch (err) {
      return err instanceof RangeError ? fail('Requête trop volumineuse.', 413) : fail('Corps de requête invalide.', 400);
    }
    const incoming = sanitizeState(body.state);
    const force = body.force === true;
    const expectedRevision = body.expectedRevision;
    if (!force && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return fail('Révision attendue invalide.', 400);
    }
    const expected = force ? 0 : expectedRevision;
    const forceFlag = force ? 1 : 0;
    const backupPrevious = !!body.backupPrevious;
    const reason = String(body.reason || 'auto_sync').slice(0, 40);
    const updatedAt = nowIso();
    const payload = JSON.stringify(incoming);
    const statements = [];
    // D1 batch est transactionnel : l'archive et l'écriture conditionnelle
    // observent le même état, même lors de requêtes concurrentes.
    if (backupPrevious) {
      statements.push(env.DB.prepare(
        `INSERT INTO legacy_snapshots (user_id, state_json, answers_count, reason, created_at)
         SELECT user_id, state_json, (SELECT count(*) FROM json_each(states.state_json, '$.answers')), ?, ?
           FROM states WHERE user_id = ? AND (? = 1 OR revision = ?)`
      ).bind(reason, updatedAt, sess.user.id, forceFlag, expected));
    }
    statements.push(env.DB.prepare(
      'UPDATE states SET revision = revision + 1, state_json = ?, updated_at = ? WHERE user_id = ? AND (? = 1 OR revision = ?)'
    ).bind(payload, updatedAt, sess.user.id, forceFlag, expected));
    statements.push(env.DB.prepare(
      `INSERT INTO states (user_id, revision, state_json, updated_at)
       SELECT ?, 1, ?, ? WHERE (? = 1 OR ? = 0)
       ON CONFLICT(user_id) DO NOTHING`
    ).bind(sess.user.id, payload, updatedAt, forceFlag, expected));
    statements.push(env.DB.prepare('SELECT revision FROM states WHERE user_id = ?').bind(sess.user.id));
    const results = await env.DB.batch(statements);
    const updateResult = results[results.length - 3];
    const insertResult = results[results.length - 2];
    if (!(updateResult.meta.changes || insertResult.meta.changes)) {
      const current = await loadStateRow(env, sess.user.id);
      return json({
        ok: false, conflict: true,
        serverRevision: current?.revision || 0,
        serverUpdatedAt: current?.updated_at || null,
        serverState: current ? JSON.parse(current.state_json) : null,
      }, 409);
    }
    return json({ ok: true, revision: results[results.length - 1].results[0].revision, updatedAt });
  }

  return fail('Route inconnue.', 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    try {
      return await handle(request, env);
    } catch (err) {
      // Ne jamais renvoyer la pile d'appels au client.
      console.error('worker_error', err && err.stack ? err.stack : String(err));
      return json({ ok: false, error: 'Erreur interne du serveur.' }, 500);
    }
  },
};
