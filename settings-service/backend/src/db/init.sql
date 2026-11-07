-- Settings service schema. Every statement is idempotent, so migrate can rerun.
--
-- Storage choice: key-value rows (one row per user and key), storing only
-- explicit choices. A key with no row inherits. That gives per-key versions
-- (different-key writes never conflict), and a definition added at runtime is
-- visible to every existing user with no backfill. Types are enforced by the
-- definition at write time, not by column types.

CREATE TABLE IF NOT EXISTS organizations (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  -- Bumped on every policy change; org events and the admin If-Match use it.
  policy_revision  BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id),
  username           TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('member', 'org_admin', 'platform_admin')),
  password_hash      TEXT NOT NULL,
  -- The per-user revision counter. Bumped once per PATCH that changes anything;
  -- it is the ETag clients send back in If-Match and the key of SSE events.
  settings_revision  BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- Single-row table holding the global catalog revision.
CREATE TABLE IF NOT EXISTS catalog_state (
  id        BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  revision  BIGINT NOT NULL DEFAULT 0
);
INSERT INTO catalog_state (id, revision) VALUES (true, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS setting_definitions (
  key             TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  type            TEXT NOT NULL CHECK (type IN ('boolean', 'enum', 'integer', 'string')),
  scope           TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'org')),
  default_value   JSONB NOT NULL CHECK (jsonb_typeof(default_value) IN ('boolean', 'number', 'string')),
  allowed_values  JSONB CHECK (allowed_values IS NULL OR jsonb_typeof(allowed_values) = 'array'),
  min_value       INTEGER,
  max_value       INTEGER,
  max_length      INTEGER CHECK (max_length IS NULL OR max_length > 0),
  format          TEXT CHECK (format IS NULL OR format IN ('hhmm', 'timezone')),
  category        TEXT NOT NULL,
  label           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  display_order   INTEGER NOT NULL DEFAULT 1000,
  -- Deprecation lifecycle: active → deprecated (writes accepted and ignored,
  -- with a warning) → retired at sunset_at (writes get 422 RETIRED). A retired
  -- key is never deleted, so its name can't be reused with a different type.
  deprecated_at   TIMESTAMPTZ,
  sunset_at       TIMESTAMPTZ,
  replaced_by     TEXT REFERENCES setting_definitions(key),
  catalog_rev     BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sunset_at IS NULL OR deprecated_at IS NOT NULL),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);

-- Org policy. value NULL is a tombstone (policy cleared), kept so rev survives.
CREATE TABLE IF NOT EXISTS org_settings (
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  key         TEXT NOT NULL REFERENCES setting_definitions(key),
  value       JSONB CHECK (value IS NULL OR jsonb_typeof(value) IN ('boolean', 'number', 'string')),
  enforced    BOOLEAN NOT NULL DEFAULT false,
  rev         BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id),
  PRIMARY KEY (org_id, key)
);

-- A user's explicit choices. value NULL is a tombstone ("reset to inherited");
-- rev is the user's settings_revision when this key last changed, which is
-- monotonic, so reset-then-set can never look unchanged to a stale client.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL REFERENCES setting_definitions(key),
  value       JSONB CHECK (value IS NULL OR jsonb_typeof(value) IN ('boolean', 'number', 'string')),
  rev         BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (user_id, key)
);
-- "How many users would an enforcement shadow?" on the admin screen.
CREATE INDEX IF NOT EXISTS user_settings_key_idx ON user_settings (key) WHERE value IS NOT NULL;

-- Append-only change log, written in the same transaction as the change.
CREATE TABLE IF NOT EXISTS setting_changes (
  id            BIGSERIAL PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('user', 'org', 'catalog')),
  org_id        TEXT REFERENCES organizations(id),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  old_value     JSONB,
  new_value     JSONB,
  enforced      BOOLEAN,
  revision      BIGINT NOT NULL,
  actor_id      UUID REFERENCES users(id),
  client_label  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS setting_changes_user_idx ON setting_changes (user_id, id DESC);
CREATE INDEX IF NOT EXISTS setting_changes_org_idx ON setting_changes (org_id, id DESC);
