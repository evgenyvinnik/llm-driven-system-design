-- PostgreSQL holds configuration and jobs, never events: orgs (and their time
-- zones), users and roles, model prices, metric coverage, and export jobs.
-- Every statement is idempotent; `npm run db:migrate` applies it.

CREATE TABLE IF NOT EXISTS orgs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- IANA zone. Daily buckets are calendar days in this zone.
    time_zone   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id             BIGSERIAL PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    -- Internal support staff see every org, but never cost or conversations.
    is_staff       BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    role     TEXT NOT NULL CHECK (role IN ('admin', 'analyst')),
    PRIMARY KEY (user_id, org_id)
);

-- Prices are versioned: cost is computed at ingest with the price in effect at event_time.
CREATE TABLE IF NOT EXISTS model_prices (
    model                  TEXT NOT NULL,
    effective_from         TIMESTAMPTZ NOT NULL,
    input_micros_per_mtok  BIGINT NOT NULL,
    output_micros_per_mtok BIGINT NOT NULL,
    PRIMARY KEY (model, effective_from)
);

-- When a metric's inputs started being collected, and how far back its
-- rollups have been computed. Charts show buckets before collected_from as
-- "not collected" and buckets before available_from as "backfill pending",
-- instead of plotting zeros.
CREATE TABLE IF NOT EXISTS metric_coverage (
    metric          TEXT PRIMARY KEY,
    collected_from  DATE NOT NULL,
    available_from  DATE NOT NULL,
    note            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS export_jobs (
    id               UUID PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    idempotency_key  TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('daily_metrics', 'conversations')),
    -- The canonical dashboard query, exactly as the widgets used it.
    query            JSONB NOT NULL,
    -- Columns fixed at creation from the requester's permissions.
    columns          TEXT[] NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
    rows_total       BIGINT,
    rows_done        BIGINT NOT NULL DEFAULT 0,
    file_path        TEXT,
    file_bytes       BIGINT,
    error            TEXT,
    attempts         INT NOT NULL DEFAULT 0,
    worker_id        TEXT,
    lease_expires_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ,
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS export_jobs_claim_idx ON export_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS export_jobs_user_idx ON export_jobs (user_id, created_at DESC);
