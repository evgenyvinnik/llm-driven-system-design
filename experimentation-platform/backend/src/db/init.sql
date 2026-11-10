-- PostgreSQL schema for the experimentation platform. Applied by `npm run db:migrate`.
-- Every statement is idempotent.

-- Console users (admin edits, viewer reads) and demo-storefront shoppers.
-- country/plan/org are the shopper attributes the storefront passes to the SDK for targeting.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer', 'shopper')),
  country       TEXT,
  plan          TEXT,
  org_id        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Environments have separate keys and separate snapshot version sequences.
-- client_key is public (it ships in the browser bundle): fetch snapshots, stream, send events.
-- server_key is secret: identity aliasing and server-side evaluation.
CREATE TABLE IF NOT EXISTS environments (
  key              TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_-]{1,31}$'),
  name             TEXT NOT NULL,
  client_key       TEXT NOT NULL UNIQUE,
  server_key       TEXT NOT NULL UNIQUE,
  -- Bumped (under the row lock) in the same transaction as every config change in this environment.
  snapshot_version BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A flag or experiment. Identity, unit type, salt and variants are global;
-- status, targeting and allocation are per environment (flag_configs).
CREATE TABLE IF NOT EXISTS flags (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                      TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  kind                     TEXT NOT NULL CHECK (kind IN ('flag', 'experiment')),
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  unit_type                TEXT NOT NULL CHECK (unit_type IN ('user', 'org', 'anonymous')),
  -- Random at creation and never changed: a new salt would re-randomize every unit.
  salt                     TEXT NOT NULL,
  variants                 JSONB NOT NULL,
  default_variant          TEXT NOT NULL,
  -- Analysis: the conversion event and how long after first exposure a conversion still counts.
  primary_metric           TEXT NOT NULL DEFAULT 'purchase',
  attribution_window_hours INT NOT NULL DEFAULT 72 CHECK (attribution_window_hours BETWEEN 1 AND 720),
  -- Where the treatment renders, shown next to "assigned vs exposed" on the results page.
  surface                  TEXT NOT NULL DEFAULT '',
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Current config of a flag in one environment. `version` bumps on every change;
-- the full config of every version is kept in flag_versions.
CREATE TABLE IF NOT EXISTS flag_configs (
  flag_id     UUID NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  environment TEXT NOT NULL REFERENCES environments(key),
  status      TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'stopped')),
  -- {"control": [[0, 9000]], "treatment": [[9000, 10000]]}: half-open bucket ranges of [0, 10000).
  allocation  JSONB NOT NULL,
  rules       JSONB NOT NULL DEFAULT '[]',
  fallthrough TEXT NOT NULL DEFAULT 'enroll' CHECK (fallthrough IN ('enroll', 'exclude')),
  version     INT NOT NULL DEFAULT 1,
  started_at  TIMESTAMPTZ,
  stopped_at  TIMESTAMPTZ,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, environment)
);

-- Immutable history: one row per config version. The SRM check reads the
-- allocation each exposure's version had, so a ramp doesn't look like a broken split.
CREATE TABLE IF NOT EXISTS flag_versions (
  flag_id     UUID NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  environment TEXT NOT NULL REFERENCES environments(key),
  version     INT NOT NULL,
  status      TEXT NOT NULL,
  allocation  JSONB NOT NULL,
  rules       JSONB NOT NULL,
  fallthrough TEXT NOT NULL,
  changed_by  UUID REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, environment, version)
);

-- Who changed what. Written in the same transaction as the change.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     UUID REFERENCES users(id),
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  flag_key     TEXT,
  environment  TEXT,
  from_version INT,
  to_version   INT,
  summary      TEXT NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_flag_idx ON audit_log (flag_key, at DESC);

-- Compiled, immutable rulesets: one row per (environment, version), never updated.
CREATE TABLE IF NOT EXISTS snapshots (
  environment TEXT NOT NULL REFERENCES environments(key),
  version     BIGINT NOT NULL,
  etag        TEXT NOT NULL,
  body        JSONB NOT NULL,
  flag_count  INT NOT NULL,
  bytes       INT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, version)
);

-- Identity aliasing for `user` experiments: the first anonymous id a user signs
-- in from becomes their stable bucketing id, on every device, from then on.
CREATE TABLE IF NOT EXISTS identity_aliases (
  environment TEXT NOT NULL REFERENCES environments(key),
  user_id     TEXT NOT NULL,
  stable_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, user_id)
);

-- Every anonymous id seen signing in as a user (a later device's id included).
CREATE TABLE IF NOT EXISTS identity_links (
  environment   TEXT NOT NULL REFERENCES environments(key),
  anonymous_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, anonymous_id, user_id)
);
CREATE INDEX IF NOT EXISTS identity_links_user_idx ON identity_links (environment, user_id);
