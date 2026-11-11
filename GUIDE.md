# Migrer Nuance vers Cloudflare — site statique → site avec comptes utilisateurs

**Guide d'installation et de migration**
Cible : Cloudflare Workers (site statique + API) + D1 (base de données)
Dernière vérification : 11 novembre 2026 — Wrangler 4.86, Node.js ≥ 22.12

---

## Ce que vous obtenez à la fin

- Votre site reste **un seul fichier HTML autonome** (aucun changement de code côté client).
- Les visiteurs peuvent **créer un compte, se connecter, retrouver leurs réponses sur n'importe quel appareil**.
- La synchronisation est **multi-appareils avec détection de conflit** (elle utilise déjà le code présent dans votre HTML).
- **Aucun serveur à administrer** : rien à patcher, rien à superviser.
- Coût : **0 € / mois** tant que vous restez sous les limites gratuites (voir §7).

---

## 1. Comprendre ce qui existe déjà dans votre fichier

C'est le point le plus important, et il est rassurant : **vous n'avez rien à modifier dans `index.html`**.

Votre fichier (`Nuance-publication 2.html`) contient déjà toute la partie cliente : l'écran de connexion (`view-auth`), la fonction `apiFetch`, la synchronisation (`pushStateToCloud`), la gestion des conflits multi-appareils et un mode « continuer sans compte ».

Il lui manque **uniquement le serveur**. Il appelle 7 routes et attend des réponses JSON précises :

| Méthode | Route | Rôle | Réponse attendue par le client |
|---|---|---|---|
| `GET` | `/api/auth/session` | qui suis-je ? | `{ ok, authenticated, hasAnyAccount, user?, revision?, updatedAt?, state? }` |
| `POST` | `/api/auth/register` | créer un compte | `{ ok, user, revision, updatedAt, isFirstAccount, migratedAuto }` |
| `POST` | `/api/auth/login` | se connecter | `{ ok, user, revision, updatedAt, state }` |
| `POST` | `/api/auth/logout` | se déconnecter | `{ ok }` |
| `PUT` | `/api/state` | enregistrer les réponses | `{ ok, revision, updatedAt }` ou `409 { conflict, serverState, serverRevision }` |
| `GET` | `/api/state/backups` | lister les archives | `{ ok, backups: [{ id, answers_count, reason, created_at }] }` |
| `GET` | `/api/state/backup?id=N` | restaurer une archive | `{ ok, backup: { id, state, … } }` |

Le Worker fourni dans ce dossier implémente **exactement** ce contrat. Il a été testé contre votre code : **48 tests automatisés, 0 échec** (§6).

> **Deux points de conception qui en découlent**
> 1. Le site et l'API sont servis **sur le même domaine** — donc pas de CORS à configurer, et le cookie de session reste en `SameSite=Lax`.
> 2. Le client attend une réponse **JSON** : si une route renvoie du HTML (404 par défaut), il considère l'API comme indisponible. D'où le routage explicite `/api/*` dans le Worker.

---

## 1 bis. Architecture mise en place

```
                    ┌─────────────────────────────────────────┐
  navigateur  ─────▶│  Cloudflare (un seul domaine)            │
  (un seul fichier  │                                          │
   HTML autonome)   │   /api/*  ──▶  Worker  ──▶  D1 (SQLite)  │
                    │                  │            users      │
                    │                  │            sessions   │
                    │                  │            states     │
                    │                  │       legacy_snapshots │
                    │                  │       auth_throttle    │
                    │                              │            │
                    │   /*      ──▶  assets  ──────┘            │
                    │                public/index.html          │
                    └─────────────────────────────────────────┘
```

Pourquoi ce choix plutôt qu'un site statique seul + une API sur un autre domaine :

1. **Pas de CORS.** Le navigateur envoie les requêtes vers sa propre origine. Moins de configuration, moins de surface d'erreur.
2. **Cookie `SameSite=Lax` possible.** Les cookies `SameSite=None` sont bloqués par défaut sur Safari et de plus en plus ailleurs. Sur un domaine séparé, la session ne tiendrait pas de façon fiable.
3. **HTTPS et CDN inclus**, sans certificat à renouveler.
4. **Un seul déploiement** : `npx wrangler deploy` publie le site et l'API ensemble, donc ils ne peuvent pas se désynchroniser.

---

## 2. Prérequis

| Outil | Version | Vérifier |
|---|---|---|
| Node.js | **≥ 22.12** (exigé par Wrangler 4) | `node --version` |
| npm | ≥ 10 | `npm --version` |
| Compte Cloudflare | gratuit | [dash.cloudflare.com](https://dash.cloudflare.com) |

Si votre Node est plus ancien, installez la version 22 LTS :

```bash
# avec nvm (recommandé)
nvm install 22 && nvm use 22
```

---

## 3. Contenu du dossier fourni

```
cloudflare-guide/
├── public/
│   └── index.html              ← votre site (copie de Nuance-publication 2.html)
├── worker/
│   ├── index.js                ← l'API : 7 routes, sessions, hachage, anti-force brute
│   ├── api.js                  ← simple ré-export
│   ├── worker.js               ← point d'entrée : routage /api/*, statique, en-têtes de sécurité
│   ├── schema.sql              ← structure de la base D1
│   └── test-local.mjs          ← 48 tests de l'API (sans Cloudflare)
├── scripts/
│   └── smoke-test.sh           ← vérifie le site déployé (18 contrôles)
├── wrangler.toml               ← configuration du déploiement
├── package.json
├── dev-server.mjs              ← serveur local de test (SQLite)
└── .gitignore
```

---

## 4. Installation, étape par étape

### 4.1 Installer les dépendances

```bash
cd cloudflare-guide
npm install
```

### 4.2 Se connecter à Cloudflare

```bash
npx wrangler login
```

Une page s'ouvre dans le navigateur : autorisez Wrangler. Vérifiez ensuite :

```bash
npx wrangler whoami
```

### 4.3 Créer la base D1

```bash
npx wrangler d1 create nuance-db
```

La commande affiche un bloc à recopier :

```
[[d1_databases]]
binding = "DB"
database_name = "nuance-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copiez le `database_id`** dans `wrangler.toml`, à la place de `REMPLACER-PAR-VOTRE-DATABASE-ID`.

### 4.4 Créer les tables

```bash
npx wrangler d1 execute nuance-db --remote --file=./worker/schema.sql
```

Vous devez voir 5 tables créées : `users`, `sessions`, `states`, `legacy_snapshots`, `auth_throttle`.

Pour vérifier :

```bash
npx wrangler d1 execute nuance-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

### 4.5 Tester en local **avant** de déployer

```bash
npm run test        # 48 tests de l'API, sans réseau
```

Puis démarrez le site en local :

```bash
node dev-server.mjs
```

Ouvrez `http://localhost:8787` : le site doit s'afficher, vous pouvez créer un compte, répondre et voir vos réponses se synchroniser. Les données sont dans `dev.sqlite` (supprimez le fichier pour repartir de zéro).

> Alternative : `npx wrangler dev` utilise le vrai moteur D1 en local. C'est plus fidèle, mais il faut d'abord initialiser la base locale avec `npm run db:init:local`.

### 4.6 Déployer

```bash
npx wrangler deploy
```

Sortie attendue :

```
Total Upload: 18.06 KiB / gzip: 5.35 KiB
Your worker has access to the following bindings:
- D1 Databases:
  - DB: nuance-db
Deployed nuance workers.dev  →  https://nuance.VOTRE-SOUS-DOMAINE.workers.dev
```

### 4.7 Vérifier le déploiement

```bash
./scripts/smoke-test.sh https://nuance.VOTRE-SOUS-DOMAINE.workers.dev
```

Attendu : **18 réussi(s), 0 échec(s)**. Ce script contrôle l'API, le fichier statique, les en-têtes de sécurité et le comportement des routes protégées.

### 4.8 Brancher votre domaine (facultatif)

Deux possibilités :

**A. Via `wrangler.toml`** — décommentez le bloc en fin de fichier :

```toml
[[routes]]
pattern = "çavote.fr"
custom_domain = true
```

puis `npx wrangler deploy`. Cloudflare crée le certificat TLS automatiquement.

**B. Via le tableau de bord** — Workers & Pages → votre Worker → *Settings* → *Domains & Routes* → *Add custom domain*.

> ⚠️ Votre domaine contient un caractère non-ASCII (`ç`). Les navigateurs l'afficheront correctement, mais certains outils (archives, e-mails, réseaux sociaux) montreront sa forme punycode `xn--avote-9oa.fr`. Rien de bloquant, à garder en tête pour les liens partagés.

---

## 5. Ce que le Worker fait pour la sécurité

| Mesure | Détail |
|---|---|
| **Mots de passe** | PBKDF2-SHA256, sel unique de 16 octets par compte. Jamais stockés en clair, jamais renvoyés. |
| **Sessions** | Jeton aléatoire de 32 octets. La base ne stocke que son **SHA-256** : une fuite de la base ne permet pas de rejouer une session. |
| **Cookie** | `HttpOnly` (inaccessible au JavaScript, donc au XSS), `Secure`, `SameSite=Lax`, 30 jours. |
| **Comparaison** | À temps constant, pour ne pas fuiter d'information par le temps de réponse. |
| **Anti-force brute** | 5 échecs en 15 minutes sur un couple e-mail+IP → blocage temporaire (HTTP 429). |
| **Énumération de comptes** | Le message d'erreur est identique que l'e-mail existe ou non. |
| **Concurrence** | `expectedRevision` : si un autre appareil a écrit entre-temps, l'API répond **409** avec l'état serveur — votre client ouvre alors sa fenêtre de conflit. |
| **Entrées** | Chaque état est **normalisé et borné** côté serveur (`sanitizeState`) : pas de pollution de prototype, `imp` ramené à {1,2,3}, tailles plafonnées. |
| **En-têtes** | CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. |
| **Erreurs** | Jamais de pile d'appels renvoyée au client ; journalisée côté Cloudflare (`wrangler tail`). |

### Un compromis à connaître : le coût du hachage

Le plan **Workers Free** limite à **10 ms de CPU par requête**. PBKDF2 à 600 000 itérations (la recommandation OWASP) dépasse ce budget.

Le code utilise donc **100 000 itérations par défaut**, stockées **par compte** dans la colonne `iterations`. Conséquences :

- cela tient sur le plan gratuit ;
- **augmenter la valeur ne casse aucun compte existant** : chacun reste vérifiable avec son propre coût.

Si vous passez sur **Workers Paid** (5 $/mois, 30 s de CPU), activez la valeur recommandée :

```bash
npx wrangler secret put PBKDF2_ITERATIONS
# saisir : 600000
```

---

## 6. Ce qui a été vérifié

### 6.1 Les 48 tests de l'API (`npm run test`)

Exécutés sans Cloudflare, avec un adaptateur D1 → SQLite :

- session non authentifiée, `hasAnyAccount` ;
- inscription du **premier compte** : `isFirstAccount` + `migratedAuto` + migration automatique des données locales ;
- inscription d'un **second compte** : pas de migration automatique ;
- `PUT /api/state` : incrément de révision ;
- **conflit 409** avec `serverState` et `serverRevision` ;
- `force: true` : écrasement assumé (résolution de conflit) ;
- archives : liste + restauration ;
- **isolation entre comptes** (un compte ne voit ni les archives ni l'état d'un autre) ;
- 401 sur toutes les routes protégées sans session ;
- 429 après 5 échecs de connexion ;
- validations : e-mail, longueur du mot de passe, doublon d'e-mail ;
- robustesse : corps non-JSON, pollution de prototype, valeurs hors bornes.

**Résultat : 48 réussis, 0 échec.**

### 6.2 Les 18 contrôles du site déployé (`scripts/smoke-test.sh`)

Validés contre le serveur local, puis à rejouer sur votre URL de production.

### 6.3 Le parcours complet, de bout en bout

Inscription → session authentifiée → enregistrement de l'état → archivage → restauration → déconnexion → session invalidée. Testé par requêtes HTTP réelles.

### 6.4 Validation de la configuration

`npx wrangler deploy --dry-run` : le Worker bundle correctement (18 Kio) et le binding D1 est reconnu.

---

## 7. Limites et coûts

### Plan gratuit (Workers Free)

| Ressource | Limite | Impact pour Nuance |
|---|---|---|
| Requêtes Worker | **100 000 / jour** | ~100 k visites ou synchronisations par jour |
| CPU par requête | **10 ms** | suffisant, sauf hachage à forte itération (voir §5) |
| D1 lignes lues | **5 000 000 / jour** | ~1 lecture par session/synchro : très large |
| D1 lignes écrites | **100 000 / jour** | ~1 écriture par synchronisation |
| D1 stockage | **5 Go** | un état complet pèse **21,6 Ko** → ~230 000 comptes |
| Taille max par ligne | **2 Mo** | marge de 99 % (état complet : 21,6 Ko) |
| Base max (Free) | **500 Mo** | ~23 000 comptes remplis |
| Bases par compte | 10 | 1 utilisée |

**Conclusion : le plan gratuit est très large pour ce projet.** Le premier facteur limitant serait 100 000 requêtes/jour, soit un vrai succès.

⚠️ Un piège documenté : **quand une limite quotidienne D1 est atteinte, toutes les requêtes D1 échouent** jusqu'à minuit UTC. Ce n'est pas une dégradation progressive. Surveillez avec `npx wrangler d1 info nuance-db`.

### Passer en payant (5 $/mois) si nécessaire

Débloque 30 s de CPU (donc PBKDF2 à 600 000 itérations), 25 milliards de lectures/mois, 50 millions d'écritures/mois, et supprime le plafond dur quotidien.

---

## 8. Migration des utilisateurs existants

Trois situations à traiter **avant** la mise en ligne.

### Cas 1 — Visiteurs sans compte (localStorage uniquement)

Rien à faire. À la création de leur compte, s'ils ont déjà répondu, le client envoie leur état (`localState`) et le serveur le migre automatiquement **s'il s'agit du premier compte créé**. C'est le comportement `isFirstAccount` + `migratedAuto` que votre code attend déjà.

### Cas 2 — Vous revenez d'une version avec comptes (V16 du 10/11)

Vous aviez alors un backend. **Si vous conservez la même base D1**, ces comptes continueront de fonctionner — mais deux précautions :

1. **Les hashs doivent être compatibles.** Le Worker fourni utilise PBKDF2-SHA256. Si votre ancien backend utilisait autre chose (bcrypt, argon2, scrypt), les mots de passe ne seront pas vérifiables. Dans ce cas, prévoyez une réinitialisation de mot de passe plutôt qu'une migration silencieuse.
2. **Vérifiez le nom des tables.** Le schéma fourni suppose `users`, `sessions`, `states`, `legacy_snapshots`. Si votre ancienne base utilise d'autres noms, adaptez `schema.sql` **ou** les requêtes de `worker/index.js` — ne renommez pas à l'aveugle une base contenant des comptes réels.

Pour inspecter une base existante :

```bash
npx wrangler d1 execute VOTRE-ANCIENNE-BASE --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table'"
```

### Cas 3 — Repartir de zéro

Si vous ne conservez pas l'ancienne base, **prévenez les utilisateurs** : leurs réponses restent dans leur navigateur (localStorage), mais ils devront recréer un compte. Le mode « Continuer sur cet appareil sans compte » évite toute perte de données questionnaire.

### Sauvegarde avant toute migration

```bash
npx wrangler d1 export VOTRE-BASE --remote --output=sauvegarde-$(date +%F).sql
```

À faire **absolument** avant de toucher à une base contenant des comptes.

---

## 9. Exploitation courante

| Besoin | Commande |
|---|---|
| Voir les logs en direct | `npx wrangler tail` |
| Lister les comptes | `npx wrangler d1 execute nuance-db --remote --command="SELECT id,email,created_at FROM users"` |
| Nombre de comptes | `npx wrangler d1 execute nuance-db --remote --command="SELECT COUNT(*) FROM users"` |
| Taille et santé | `npx wrangler d1 info nuance-db` |
| Sauvegarde | `npx wrangler d1 export nuance-db --remote --output=sauvegarde.sql` |
| Restaurer une sauvegarde | `npx wrangler d1 execute nuance-db --remote --file=sauvegarde.sql` |
| Purger les sessions expirées | `npx wrangler d1 execute nuance-db --remote --command="DELETE FROM sessions WHERE expires_at < datetime('now')"` |
| Revenir à une version antérieure | `npx wrangler rollback` |
| Mettre à jour le site | remplacer `public/index.html`, puis `npx wrangler deploy` |

> La purge des sessions n'est pas automatique. Sur un petit volume, lancez-la une fois par mois. Sinon, ajoutez un Cron Trigger dans `wrangler.toml`.

---

## 10. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Le site affiche « Serveur Cloudflare D1 non détecté » | `/api/auth/session` ne renvoie pas de JSON | Vérifiez `curl -i https://votre-domaine/api/auth/session`. Si c'est du HTML → le routage `/api/*` est cassé : `run_worker_first = true` doit être présent. |
| Erreur 500 sur toutes les routes API | Table manquante ou `database_id` faux | `npx wrangler d1 execute nuance-db --remote --command="SELECT name FROM sqlite_master"` puis `npx wrangler tail` |
| `no such table: users` | `schema.sql` non appliqué sur la base distante | `npm run db:init` |
| Connexion impossible, mot de passe correct | Hashs hérités d'un autre algorithme | Voir §8 cas 2 |
| `D1_ERROR: too many SQL variables` | Requête non paramétrée | Signalez-le, le code fourni utilise toujours des requêtes préparées |
| Cookie non conservé | Domaine différent entre site et API | Les deux doivent être **sur le même domaine** (c'est le cas avec le routage fourni) |
| `wrangler` réclame Node ≥ 22.12 | version de Node trop ancienne | `nvm install 22 && nvm use 22` |
| Le déploiement ignore `wrangler.toml` | fichier mal placé | il doit être **à la racine** du projet, pas dans `worker/` |
| `run_worker_first` refusé | syntaxe selon version de Wrangler | la forme booléenne `true` fournie fonctionne en v3 comme en v4 |

---

## 11. Mise en ligne : la liste à cocher

- [ ] Node ≥ 22.12, `npm install` fait
- [ ] `npx wrangler login` puis `whoami` OK
- [ ] `nuance-db` créée, `database_id` recopié dans `wrangler.toml`
- [ ] `schema.sql` appliqué sur la base distante (5 tables)
- [ ] `npm run test` → 48 réussis
- [ ] test local via `node dev-server.mjs` : inscription, réponse, synchronisation OK
- [ ] `npx wrangler deploy`
- [ ] `./scripts/smoke-test.sh https://…` → 18 réussis
- [ ] **sauvegarde faite** si vous reprenez une base existante
- [ ] décision prise sur les comptes existants (§8)
- [ ] domaine branché, HTTPS actif
- [ ] `npx wrangler tail` ouvert pendant le premier vrai test d'inscription

---

## 12. Deux réserves à traiter, indépendantes de Cloudflare

Ces deux points viennent de l'audit du contenu, pas de l'infrastructure. Ils restent valables après la migration.

1. **Le questionnaire est déclaré `final`** dans `meta.questionnaireStatus`, alors que les 111 propositions sont identiques au V16 dont la note disait encore « brouillon à valider ». À trancher avant d'exposer l'outil largement.
2. **Le `<title>` affiche « Nuance V16 »** alors que le corpus est en V17.

Pour les corriger, modifiez `public/index.html` puis `npx wrangler deploy`. Le site et l'API se mettent à jour ensemble.

---

## Annexe — ajouter une fonction plus tard

Le Worker est un simple routeur. Pour ajouter une route, dans `worker/index.js`, avant le `return fail('Route inconnue.', 404)` :

```js
if (path === '/api/mon-endpoint' && method === 'GET') {
  const sess = await getSession(env, request);
  if (!sess) return fail('Non authentifié.', 401);
  return json({ ok: true, données: '…' });
}
```

Puis `npm run test` et `npx wrangler deploy`. Pas de redémarrage, pas de conteneur, pas de certificat à gérer.
