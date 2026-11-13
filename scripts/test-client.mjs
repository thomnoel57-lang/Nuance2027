// Tests d'intégration du client dans un DOM simulé (ne remplace pas un vrai navigateur).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const local = { v: 16, answers: { 'eco-01': { st: '2', imp: 2, sub: { a: 'x', b: 'y' } } }, checkpoint: 0, finished: false };
const remoteSame = { ...local, answers: { 'eco-01': { st: '2', imp: 2, sub: { b: 'y', a: 'x' } } } };
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function createApp({ remote = remoteSame, put, backup = false } = {}) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://nuance.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem('nuance-v11', JSON.stringify(local));
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
      window.scrollTo = () => {};
      window.confirm = () => true;
      // Accélérer les temporisateurs de synchronisation sans altérer la logique.
      const realSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...args) => realSetTimeout(fn, delay === 750 || delay >= 5000 ? 20 : delay, ...args);
      window.fetch = async (path, options) => {
        calls.push({ path, options, body: options.body && JSON.parse(options.body) });
        if (path === '/api/auth/session') return response({ ok: true, authenticated: true, user: { email: 'test@example.test' }, state: remote, revision: remote ? 1 : 0, updatedAt: null });
        if (path === '/api/state/backups') return response({ ok: true, backups: backup ? [{ id: 7, answers_count: 1, reason: 'test', created_at: '2026-01-01' }] : [] });
        if (path.startsWith('/api/state/backup?')) return response({ ok: true, backup: { state: { ...local, answers: { 'eco-01': { st: '1', imp: 2 } } } } });
        if (path === '/api/state' && put) return put(calls.filter((call) => call.path === '/api/state'));
        return response({ ok: true, revision: 2, updatedAt: '2026-01-01' });
      };
    },
  });
  await wait();
  return { window: dom.window, calls, errors, close: () => dom.window.close() };
}

function conflict(app) { return app.window.document.getElementById('conflict-modal').classList.contains('is-open'); }
async function openProfile(app) { app.window.document.querySelector('[data-nav="profile"]').click(); await wait(); }

let app = await createApp();
assert.equal(conflict(app), false, 'même réponse, ordre de sous-réponses différent');
assert.equal(app.errors.length, 0);
app.close();
console.log('  ✓ comparaison des sous-réponses indépendante de l’ordre');

app = await createApp({ remote: { ...local, answers: { 'eco-01': { st: '2', imp: 2 } } } });
assert.equal(conflict(app), true, 'une précision manquante est un vrai conflit');
app.close();
console.log('  ✓ conflit si une précision est absente');

app = await createApp({ remote: { ...remoteSame, stageSnapshots: { 1: { answers: { 'eco-01': { st: '1', imp: 2 } } } } } });
assert.equal(conflict(app), true, 'au démarrage, préserver les sauvegardes d’étapes différentes');
app.close();
console.log('  ✓ sauvegardes d’étapes divergentes détectées à la connexion');

app = await createApp({ remote: null });
assert.equal(conflict(app), true, 'un compte vide demande confirmation');
assert.equal(app.calls.filter((call) => call.path === '/api/state').length, 0);
app.close();
console.log('  ✓ aucun envoi automatique des réponses vers un compte vide');

app = await createApp({ put: (calls) => calls.length === 1
  ? response({ ok: false, conflict: true, serverState: remoteSame, serverRevision: 2, serverUpdatedAt: null }, 409)
  : response({ ok: true, revision: 3, updatedAt: '2026-01-01' }) });
await openProfile(app);
app.window.document.getElementById('cloud-sync-now').click();
await wait(200);
let puts = app.calls.filter((call) => call.path === '/api/state');
assert.equal(conflict(app), false, '409 avec réponses identiques ne doit pas ouvrir de conflit');
assert.equal(puts.length, 2);
assert.equal(puts[1].body.expectedRevision, 2);
app.close();
console.log('  ✓ nouvelle tentative sans conflit pour une révision périmée mais des données identiques');

app = await createApp({ put: () => response({ ok: false, conflict: true, serverState: { ...remoteSame, stageSnapshots: { 1: { answers: { 'eco-01': { st: '1', imp: 2 } } } } }, serverRevision: 2 }, 409) });
await openProfile(app);
app.window.document.getElementById('cloud-sync-now').click();
await wait(100);
assert.equal(conflict(app), true, 'ne pas écraser des sauvegardes d’étapes différentes');
assert.match(app.window.document.getElementById('conflict-diff-list').textContent, /sauvegardes des étapes/i);
app.close();
console.log('  ✓ protection des sauvegardes d’étapes en cas de conflit');

app = await createApp({ put: () => response({ ok: false, error: 'Requête trop volumineuse.' }, 413) });
await openProfile(app);
app.window.document.getElementById('cloud-sync-now').click();
await wait(100);
assert.equal(app.calls.filter((call) => call.path === '/api/state').length, 1);
assert.match(app.window.document.getElementById('toast').textContent, /volumineuse/);
app.close();
console.log('  ✓ erreur permanente signalée sans boucle de tentatives');

app = await createApp({ put: (calls) => calls.length === 1 ? Promise.reject(new Error('offline')) : response({ ok: true, revision: 2 }) });
await openProfile(app);
app.window.document.getElementById('cloud-sync-now').click();
await wait(200);
puts = app.calls.filter((call) => call.path === '/api/state');
assert.equal(puts.length, 2, 'nouvelle tentative après une erreur réseau');
assert.match(app.window.document.getElementById('toast').textContent, /rétablie/i);
app.close();
console.log('  ✓ nouvelle tentative après échec réseau');

app = await createApp({ backup: true });
await openProfile(app);
app.window.document.querySelector('[data-restore-server-backup="7"]').click();
await wait(150);
puts = app.calls.filter((call) => call.path === '/api/state');
assert.equal(puts.length, 1);
assert.equal(puts[0].body.backupPrevious, true);
assert.equal(puts[0].body.state.answers['eco-01'].st, '1');
assert.equal(JSON.parse(app.window.localStorage.getItem('nuance-v11-local-backup')).state.answers['eco-01'].st, '2');
app.close();
console.log('  ✓ restauration serveur sauvegardée localement et synchronisée avec archive');
