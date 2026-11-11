-- =====================================================================
-- Nuance — schéma D1
-- Exécuter : npx wrangler d1 execute nuance-db --remote --file=./schema.sql
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Comptes
-- L'e-mail est stocké EN MINUSCULES (normalisation applicative) pour que
-- l'unicité soit insensible à la casse sans dépendre de COLLATE NOCASE.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,              -- UUID v4
  email         TEXT NOT NULL UNIQUE,          -- toujours en minuscules
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,                 -- PBKDF2-SHA256, base64
  password_salt TEXT NOT NULL,                 -- 16 octets aléatoires, base64
  iterations    INTEGER NOT NULL DEFAULT 210000,
  created_at    TEXT NOT NULL                  -- ISO 8601 UTC
);

-- ---------------------------------------------------------------------
-- Sessions
-- On ne stocke JAMAIS le jeton en clair : uniquement son SHA-256.
-- Une fuite de la base ne permet donc pas de rejouer une session.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                 -- SHA-256(jeton) en hexadécimal
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------
-- État de questionnaire synchronisé
-- Une ligne par utilisateur. `revision` sert au contrôle de concurrence :
-- le client envoie expectedRevision, on refuse en 409 s'il y a divergence.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS states (
  user_id    TEXT PRIMARY KEY,
  revision   INTEGER NOT NULL DEFAULT 1,
  state_json TEXT NOT NULL,                    -- snapshot complet sérialisé
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Archives serveur ("legacy_snapshots")
-- Lecture par GET /api/state/backups et GET /api/state/backup?id=N
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legacy_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  answers_count INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user ON legacy_snapshots(user_id, id DESC);

-- ---------------------------------------------------------------------
-- Limitation des tentatives de connexion (anti-force brute)
-- Clé = sha256(email + '|' + IP). Fenêtre glissante de 15 minutes.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_throttle (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
