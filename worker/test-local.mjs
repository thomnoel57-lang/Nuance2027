/**
 * Test local de l'API sans Cloudflare : adaptateur D1 -> better-sqlite3.
 * OBJECTIF : vérifier que chaque endpoint respecte le contrat attendu par
 * le client Nuance (apiFetch). Ce fichier n'est PAS déployé.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import api from './index.js';

const db = new Database(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// --- adaptateur minimal de l'API D1 (prepare/bind/first/run/all) ---
const stmt = (sql, params = []) => {
  const s = db.prepare(sql);
  const norm = params.map((p) => (p === undefined ? null : p));
  return {
    bind: (...more) => stmt(sql, [...norm, ...more]),
    _runSync: () => /^\s*SELECT\b/i.test(sql) ? ({ success: true, results: db.prepare(sql).all(...norm), meta: {} }) : ({ success: true, meta: db.prepare(sql).run(...norm) }),
    first: async () => s.get(...norm) ?? null,
    all: async () => ({ results: s.all(...norm) }),
    run: async () => ({ success: true, meta: s.run(...norm) }),
  };
};
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (statements) => db.transaction(() => statements.map((s) => s._runSync()))() } };

// --- helpers de requête ---
const ORIGIN = 'https://exemple.test';
let cookie = '';
const call = async (path, { method = 'GET', body, raw, cookies = cookie, ip = '203.0.113.7' } = {}) => {
  const headers = new Headers({ Accept: 'application/json' });
  if (body || raw !== undefined) headers.set('Content-Type', 'application/json');
  if (cookies) headers.set('Cookie', cookies);
  headers.set('CF-Connecting-IP', ip);
  const res = await api.fetch(
    new Request(ORIGIN + path, { method, headers, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined }),
    env
  );
  const setC = res.headers.get('Set-Cookie');
  if (setC) cookie = setC.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ctype: res.headers.get('Content-Type') };
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};

const localState = {
  v: 16, answers: { 'eco-01': { st: '2', imp: 3, sub: { favm: 'option_détaillée', second: 'autre' } }, 'tra-v1': { st: '1', imp: 2 } },
  mode: 'fusion', focus: [], idx: 4, autoAdv: false, subStep: null, order: ['eco-01'],
  stageSnapshots: {}, checkpoint: 1, paused: false, finished: false,
  updatedAt: new Date().toISOString(),
};

console.log('\n=== 1. GET /api/auth/session (aucun compte) ===');
let r = await call('/api/auth/session');
check('200 + JSON', r.status === 200 && r.ctype.includes('application/json'));
check('authenticated=false', r.data.authenticated === false);
check('hasAnyAccount=false', r.data.hasAnyAccount === false);

console.log('\n=== 2. POST /api/auth/register (premier compte, migration auto) ===');
r = await call('/api/auth/register', { method: 'POST', body: {
  email: 'Test@Exemple.FR', displayName: 'Test', password: 'motdepasse123', localState } });
check('201', r.status === 201, JSON.stringify(r.data));
check('ok=true', r.data.ok === true);
check('isFirstAccount=true', r.data.isFirstAccount === true);
check('migratedAuto=true', r.data.migratedAuto === true);
check('revision=1', r.data.revision === 1);
check('user.email normalisé en minuscules', r.data.user?.email === 'test@exemple.fr');
check('cookie de session posé', !!cookie);
check('user.displayName', r.data.user?.displayName === 'Test');

console.log('\n=== 3. GET /api/auth/session (connecté) ===');
r = await call('/api/auth/session');
check('authenticated=true', r.data.authenticated === true);
check('hasAnyAccount=true', r.data.hasAnyAccount === true);
check('state renvoyé', !!r.data.state && Object.keys(r.data.state.answers).length === 2);
check('revision=1', r.data.revision === 1);
check('précisions conservées lors de la migration', r.data.state.answers['eco-01'].sub?.favm === 'option_détaillée');

console.log('\n=== 4. PUT /api/state (mise à jour) ===');
r = await call('/api/state', { method: 'PUT', body: {
  state: { ...localState, answers: { ...localState.answers, 'eco-02': { st: '-1', imp: 2 } } },
  expectedRevision: 1, force: false, backupPrevious: true, reason: 'auto_sync' } });
check('200 + ok', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
check('revision incrémentée à 2', r.data.revision === 2);

console.log('\n=== 5. PUT /api/state avec révision périmée → 409 ===');
r = await call('/api/state', { method: 'PUT', body: { state: localState, expectedRevision: 1, force: false } });
check('409', r.status === 409, JSON.stringify(r.data));
check('conflict=true', r.data.conflict === true);
check('serverRevision fourni', r.data.serverRevision === 2);
check('serverState fourni', !!r.data.serverState);

console.log('\n=== 6. PUT /api/state force=true (résolution de conflit) ===');
r = await call('/api/state', { method: 'PUT', body: { state: localState, expectedRevision: null, force: true } });
check('200 + revision=3', r.status === 200 && r.data.revision === 3);

console.log('\n=== 7. GET /api/state/backups ===');
r = await call('/api/state/backups');
check('200', r.status === 200);
check('tableau backups', Array.isArray(r.data.backups));
check('au moins 1 archive', r.data.backups.length >= 1, JSON.stringify(r.data));
const bid = r.data.backups[0]?.id;
check('champs attendus (id, answers_count, reason, created_at)',
  r.data.backups[0] && 'answers_count' in r.data.backups[0] && 'reason' in r.data.backups[0] && 'created_at' in r.data.backups[0]);

console.log('\n=== 8. GET /api/state/backup?id=N ===');
r = await call('/api/state/backup?id=' + bid);
check('200', r.status === 200);
check('backup.state présent', !!r.data.backup?.state);

console.log('\n=== 9. Isolation : un autre compte ne voit pas ces données ===');
const savedCookie = cookie; cookie = '';
r = await call('/api/auth/register', { method: 'POST', body: {
  email: 'autre@exemple.fr', password: 'motdepasse456', displayName: 'Autre', localState: { answers: {} } } });
check('second compte : isFirstAccount=false', r.data.isFirstAccount === false);
check('second compte : migratedAuto=false', r.data.migratedAuto === false);
r = await call('/api/state/backups');
check('aucune archive visible', r.data.backups.length === 0, JSON.stringify(r.data));
r = await call('/api/state/backup?id=' + bid);
check('archive d\'autrui → 404', r.status === 404);
cookie = savedCookie;

console.log('\n=== 10. Authentification ===');
r = await call('/api/state', { method: 'PUT', body: { state: localState }, cookies: '' });
check('PUT /api/state sans session → 401', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email: 'test@exemple.fr', password: 'mauvais' }, cookies: '' });
check('mot de passe faux → 401', r.status === 401);
r = await call('/api/auth/login', { method: 'POST', body: { email: 'inconnu@exemple.fr', password: 'motdepasse123' }, cookies: '' });
check('compte inexistant → 401 (message identique)', r.status === 401 && /incorrect/i.test(r.data.error));

console.log('\n=== 11. Anti-force brute (6 échecs) ===');
let last;
for (let i = 0; i < 6; i++) last = await call('/api/auth/login', { method: 'POST', body: { email: 'brute@exemple.fr', password: 'x' }, cookies: '' });
check('blocage 429 après 5 échecs', last.status === 429, JSON.stringify(last.data));

console.log('\n=== 12. POST /api/auth/logout ===');
r = await call('/api/auth/logout', { method: 'POST' });
check('200', r.status === 200);
r = await call('/api/auth/session');
check('session invalidée côté serveur', r.data.authenticated === false);

console.log('\n=== 13. Validations ===');
r = await call('/api/auth/register', { method: 'POST', body: { email: 'pasunemail', password: 'motdepasse123' }, cookies: '' });
check('e-mail invalide → 400', r.status === 400);
r = await call('/api/auth/register', { method: 'POST', body: { email: 'ok@exemple.fr', password: 'court' }, cookies: '' });
check('mot de passe < 8 → 400', r.status === 400);
r = await call('/api/auth/register', { method: 'POST', body: { email: 'test@exemple.fr', password: 'motdepasse123' }, cookies: '' });
check('e-mail déjà pris → 409', r.status === 409);

console.log('\n=== 14. Robustesse des entrées ===');
let relog = await call('/api/auth/login', { method: 'POST', body: { email: 'test@exemple.fr', password: 'motdepasse123' }, cookies: '' });
check('reconnexion OK (status ' + relog.status + ')', relog.status === 200 && !!cookie, JSON.stringify(relog.data));
let chk = await call('/api/auth/session');
check('session redevenue authentifiée', chk.data.authenticated === true, JSON.stringify(chk.data).slice(0,120));
r = await call('/api/state', { method: 'PUT', body: { state: { answers: { '__proto__': { st: '2' }, 'eco-01': { st: '2', imp: 99 } } }, force: true }, cookies: cookie });
check('proto pollué ignoré + imp borné', r.status === 200);
const row = db.prepare("SELECT state_json FROM states WHERE user_id=(SELECT id FROM users WHERE email='test@exemple.fr')").get();
const parsed = JSON.parse(row.state_json);
check('__proto__ non stocké comme clé propre', !Object.prototype.hasOwnProperty.call(parsed.answers, '__proto__'));
check('imp ramené à 2', parsed.answers['eco-01'].imp === 2);
r = await call('/api/state', { method: 'PUT', raw: '{ceci nest pas du json', cookies: cookie });
check('corps non-JSON → 400', r.status === 400);
r = await call('/api/inexistant');
check('route inconnue → 404', r.status === 404);

console.log('\n=== 15. Précisions et concurrence ===');
r = await call('/api/auth/session');
const baseRevision = r.data.revision;
const subState = { ...localState, answers: { 'eco-01': { st: '2', imp: 3, sub: { option: 'valeur', autre: 'seconde' } } } };
const [raceA, raceB] = await Promise.all([
  call('/api/state', { method: 'PUT', body: { state: subState, expectedRevision: baseRevision, backupPrevious: true } }),
  call('/api/state', { method: 'PUT', body: { state: localState, expectedRevision: baseRevision, backupPrevious: true } }),
]);
check('une seule écriture simultanée acceptée', [raceA.status, raceB.status].sort().join(',') === '200,409');
check('une seule révision ajoutée', (await call('/api/auth/session')).data.revision === baseRevision + 1);
const winnerState = raceA.status === 200 ? subState : localState;
const currentState = (await call('/api/auth/session')).data.state;
check('les précisions de la version gagnante sont conservées', JSON.stringify(currentState.answers['eco-01'].sub) === JSON.stringify(winnerState.answers['eco-01'].sub));
const allBackups = await call('/api/state/backups');
const countBeforeStale = allBackups.data.backups.length;
r = await call('/api/state', { method: 'PUT', body: { state: subState, expectedRevision: baseRevision, backupPrevious: true } });
check('aucune archive créée pour une écriture périmée', r.status === 409 && (await call('/api/state/backups')).data.backups.length === countBeforeStale);
r = await call('/api/state', { method: 'PUT', body: { state: subState, expectedRevision: baseRevision + 1, backupPrevious: true } });
check('écriture des précisions sans perte', r.status === 200 && (await call('/api/auth/session')).data.state.answers['eco-01'].sub?.autre === 'seconde');
r = await call('/api/state', { method: 'PUT', body: { state: subState } });
check('révision obligatoire hors mode forcé', r.status === 400);
r = await call('/api/state', { method: 'PUT', raw: JSON.stringify({ state: { padding: 'x'.repeat(2 * 1024 * 1024) }, expectedRevision: 0 }) });
check('corps trop volumineux refusé', r.status === 413);
r = await call('/api/auth/register', { method: 'POST', raw: 'null', cookies: '' });
check('JSON null refusé sans erreur serveur', r.status === 400);

console.log('\n=== 16. Anti-force brute renforcé et ré-hachage ===');
for (let i = 0; i < 20; i++) {
  await call('/api/auth/login', { method: 'POST', body: { email: 'cible@exemple.fr', password: 'faux' }, cookies: '', ip: `198.51.100.${i + 1}` });
}
r = await call('/api/auth/login', { method: 'POST', body: { email: 'cible@exemple.fr', password: 'faux' }, cookies: '', ip: '198.51.100.21' });
check('limite par compte sur plusieurs IP', r.status === 429);
for (let i = 0; i < 50; i++) {
  await call('/api/auth/login', { method: 'POST', body: { email: `tentative${i}@exemple.fr`, password: 'faux' }, cookies: '', ip: '192.0.2.5' });
}
r = await call('/api/auth/login', { method: 'POST', body: { email: 'suivant@exemple.fr', password: 'faux' }, cookies: '', ip: '192.0.2.5' });
check('limite par IP sur plusieurs comptes', r.status === 429);
env.PBKDF2_ITERATIONS = 100001;
r = await call('/api/auth/login', { method: 'POST', body: { email: 'test@exemple.fr', password: 'motdepasse123' }, cookies: '', ip: '192.0.2.6' });
check('rehachage du mot de passe à la connexion si coût augmenté', r.status === 200 && db.prepare('SELECT iterations FROM users WHERE email=?').get('test@exemple.fr').iterations === 100001);
delete env.PBKDF2_ITERATIONS;

console.log(`\n${'='.repeat(52)}`);
console.log(`  RÉSULTAT : ${pass} tests réussis, ${fail} échec(s)`);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
