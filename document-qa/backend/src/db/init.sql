-- Document Q&A schema. Every statement is idempotent (npm run db:migrate reruns safely).
-- PostgreSQL is the source of truth for documents, versions, access, chunks, the
-- vector index, pipeline jobs and answer runs. All timestamps are TIMESTAMPTZ,
-- and every lease and retry time is written with the database clock (now()).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  org_id         TEXT REFERENCES orgs(id),
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  -- member: reads what is shared with them; org_admin: also manages groups;
  -- operator: platform staff, sees pipeline health but no document content.
  role           TEXT NOT NULL CHECK (role IN ('member', 'org_admin', 'operator')),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'operator') = (org_id IS NULL))
);

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  TEXT NOT NULL REFERENCES groups(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members (user_id);

-- One row per logical document. The tombstone (deleted_at) is written first on
-- delete; every read path filters on it, so the document disappears at once
-- even though its chunks, index rows, blobs and cached answers still exist
-- until the purge job removes them.
CREATE TABLE IF NOT EXISTS documents (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  owner_id            TEXT NOT NULL REFERENCES users(id),
  title               TEXT NOT NULL,
  scope               TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'group', 'org')),
  group_id            TEXT REFERENCES groups(id),
  status              TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ready', 'failed')),
  -- The version questions are answered from. Switched in one UPDATE after the
  -- new version is fully indexed, so no answer mixes two versions.
  current_version_id  TEXT,
  current_version_no  INT,
  latest_version_no   INT NOT NULL DEFAULT 0,
  content_hash        TEXT,
  -- Bumped on every access-affecting change (sharing, delete, version switch);
  -- index rows and cached answers record the epoch they were built under.
  acl_epoch           BIGINT NOT NULL DEFAULT 1,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  deleted_by          TEXT REFERENCES users(id),
  purge_completed_at  TIMESTAMPTZ,
  CHECK ((scope = 'group') = (group_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS documents_org_live ON documents (org_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_purge_backlog ON documents (deleted_at) WHERE deleted_at IS NOT NULL AND purge_completed_at IS NULL;

-- Each version has its own blob key; versions are never overwritten in place.
CREATE TABLE IF NOT EXISTS document_versions (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents(id),
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  version_no      INT NOT NULL,
  content_hash    TEXT NOT NULL,
  blob_key        TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded', 'processing', 'ready', 'failed', 'superseded', 'retired', 'cancelled')),
  failure_reason  TEXT,
  char_count      INT,
  chunk_count     INT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at        TIMESTAMPTZ,
  activated_at    TIMESTAMPTZ,
  superseded_at   TIMESTAMPTZ,
  retired_at      TIMESTAMPTZ,
  UNIQUE (document_id, version_no)
);
-- Duplicate detection: same bytes within a tenant.
CREATE INDEX IF NOT EXISTS document_versions_hash ON document_versions (org_id, content_hash);

DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk FOREIGN KEY (current_version_id) REFERENCES document_versions(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Output of the extract stage: normalized text (citation offsets index into it) and headings.
CREATE TABLE IF NOT EXISTS version_texts (
  version_id  TEXT PRIMARY KEY REFERENCES document_versions(id),
  text        TEXT NOT NULL,
  headings    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chunk ids are derived from (version, ordinal), and the chunk stage upserts on
-- that key, so a redone stage rewrites the same rows instead of adding new ones.
CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  version_id   TEXT NOT NULL REFERENCES document_versions(id),
  document_id  TEXT NOT NULL REFERENCES documents(id),
  org_id       TEXT NOT NULL,
  ordinal      INT NOT NULL,
  text         TEXT NOT NULL,
  char_start   INT NOT NULL,
  char_end     INT NOT NULL,
  heading      TEXT,
  token_count  INT NOT NULL,
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || text)) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_id, ordinal),
  CHECK (char_end > char_start)
);
CREATE INDEX IF NOT EXISTS chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_document ON chunks (document_id);

-- The embedding store, keyed by chunk id. Kept apart from the index so the
-- index can be rebuilt (new metadata, new index type) without re-embedding.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id    TEXT PRIMARY KEY REFERENCES chunks(id),
  version_id  TEXT NOT NULL,
  model       TEXT NOT NULL,
  embedding   VECTOR(256) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunk_embeddings_version ON chunk_embeddings (version_id);

-- The retrieval index. Each entry carries tenant, document version and access
-- scope so the ANN query can filter inside the search. These columns are a
-- lazily-synced copy: they are a pre-filter, never the authority on access.
CREATE TABLE IF NOT EXISTS index_entries (
  chunk_id     TEXT PRIMARY KEY REFERENCES chunks(id),
  org_id       TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  version_id   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  scope        TEXT NOT NULL,
  group_id     TEXT,
  acl_epoch    BIGINT NOT NULL,
  embedding    VECTOR(256) NOT NULL,
  indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_entries_hnsw ON index_entries USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS index_entries_org ON index_entries (org_id, scope);
CREATE INDEX IF NOT EXISTS index_entries_document ON index_entries (document_id);
CREATE INDEX IF NOT EXISTS index_entries_version ON index_entries (version_id);

-- One job per (document version, stage), or per (document, stage) for
-- document-level work (sync_acl, purge). The job row is the outbox: a ticket
-- is published after commit, and the sweeper re-publishes anything pending
-- whose ticket was lost.
CREATE TABLE IF NOT EXISTS processing_jobs (
  id                TEXT PRIMARY KEY,
  job_key           TEXT NOT NULL UNIQUE,
  document_id       TEXT NOT NULL REFERENCES documents(id),
  version_id        TEXT REFERENCES document_versions(id),
  org_id            TEXT NOT NULL,
  stage             TEXT NOT NULL CHECK (stage IN ('extract', 'chunk', 'embed', 'index', 'retire', 'sync_acl', 'purge')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'poisoned', 'cancelled')),
  attempts          INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL,
  -- Re-arming a finished or running job (sync_acl after another sharing
  -- change) bumps generation; a completion for an older generation leaves the
  -- job pending so the newest change is always applied.
  generation        INT NOT NULL DEFAULT 1,
  next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at     TIMESTAMPTZ,
  lease_owner       TEXT,
  lease_token       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  progress          JSONB NOT NULL DEFAULT '{}',
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processing_jobs_due ON processing_jobs (next_run_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS processing_jobs_lease ON processing_jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS processing_jobs_document ON processing_jobs (document_id);
CREATE INDEX IF NOT EXISTS processing_jobs_status ON processing_jobs (status, stage);

CREATE TABLE IF NOT EXISTS job_attempts (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES processing_jobs(id),
  attempt_no   INT NOT NULL,
  worker_id    TEXT NOT NULL,
  lease_token  TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  outcome      TEXT CHECK (outcome IN ('succeeded', 'retry', 'failed', 'poisoned', 'lost', 'superseded')),
  error        TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS job_attempts_job ON job_attempts (job_id, attempt_no);

-- Purge progress, one row per artifact, so the UI can say "purged 3/5" and a
-- retry skips what is already gone.
CREATE TABLE IF NOT EXISTS purge_tasks (
  document_id   TEXT NOT NULL REFERENCES documents(id),
  artifact      TEXT NOT NULL CHECK (artifact IN ('index', 'embeddings', 'chunks', 'blobs', 'cache')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts      INT NOT NULL DEFAULT 0,
  removed       INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  completed_at  TIMESTAMPTZ,
  PRIMARY KEY (document_id, artifact)
);

-- Upload idempotency: a retried POST with the same key replays this response.
CREATE TABLE IF NOT EXISTS upload_requests (
  user_id          TEXT NOT NULL REFERENCES users(id),
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status_code      INT NOT NULL,
  response         JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);

-- Durable answer runs: queued → running → completed | cancelled | failed.
CREATE TABLE IF NOT EXISTS answer_runs (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES orgs(id),
  user_id              TEXT NOT NULL REFERENCES users(id),
  question             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  output_text          TEXT NOT NULL DEFAULT '',
  error                TEXT,
  sources              JSONB NOT NULL DEFAULT '[]',
  citations            JSONB NOT NULL DEFAULT '[]',
  retrieval            JSONB NOT NULL DEFAULT '{}',
  cache                JSONB NOT NULL DEFAULT '{}',
  model                TEXT,
  executor             TEXT,
  heartbeat_at         TIMESTAMPTZ,
  cancel_requested_at  TIMESTAMPTZ,
  input_tokens         INT,
  output_tokens        INT,
  queue_ms             INT,
  retrieval_ms         INT,
  ttft_ms              INT,
  generation_ms        INT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  first_token_at       TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS answer_runs_user ON answer_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS answer_runs_running ON answer_runs (heartbeat_at) WHERE status IN ('queued', 'running');

-- Audit trail shown on the document page (uploaded, shared, version switched, deleted, purged).
CREATE TABLE IF NOT EXISTS document_events (
  id           BIGSERIAL PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id),
  actor_id     TEXT,
  kind         TEXT NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_events_document ON document_events (document_id, id);

-- Worker-side fault switches, set from the ops page. Armed counts are consumed
-- atomically (UPDATE ... WHERE value > 0), so exactly N faults fire fleet-wide.
CREATE TABLE IF NOT EXISTS chaos_switches (
  name        TEXT PRIMARY KEY,
  value       INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO chaos_switches (name, value) VALUES
  ('kill_mid_chunk', 0),
  ('blob_outage', 0),
  ('acl_sync_paused', 0),
  ('purge_paused', 0),
  ('activation_delay_ms', 0)
ON CONFLICT (name) DO NOTHING;
