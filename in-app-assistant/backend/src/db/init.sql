-- In-app assistant schema. Every statement is idempotent so `npm run db:migrate`
-- can be rerun safely.
--
-- Three groups of tables:
--   1. The host app (a small productivity suite): users, mail, docs, calendar.
--      The assistant never writes these directly; it calls tools that do.
--   2. The retrieval index: chunks with an ACL, a keyword vector and an
--      embedding, fed by a transactional outbox (index_events).
--   3. The assistant: conversations, turns (each turn's saved state machine),
--      the step audit log, pending confirmations and tool idempotency records.

CREATE EXTENSION IF NOT EXISTS vector;

-- ───────────────────────── Host app: identity ─────────────────────────

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  timezone      TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

-- ───────────────────────── Host app: mail ─────────────────────────

CREATE TABLE IF NOT EXISTS mail_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  from_email   TEXT NOT NULL,
  from_name    TEXT NOT NULL,
  to_emails    TEXT[] NOT NULL DEFAULT '{}',
  cc_emails    TEXT[] NOT NULL DEFAULT '{}',
  subject      TEXT NOT NULL,
  body_html    TEXT,
  body_text    TEXT NOT NULL,
  is_external  BOOLEAN NOT NULL DEFAULT false,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages (thread_id, sent_at);

-- Visibility is per message: a user sees a message only if it has a mailbox
-- entry for them (they sent it or received it). Thread membership is not access.
CREATE TABLE IF NOT EXISTS mailbox_entries (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  folder      TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive')),
  unread      BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS mailbox_entries_folder ON mailbox_entries (user_id, folder);

CREATE TABLE IF NOT EXISTS mail_drafts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_emails        TEXT[] NOT NULL DEFAULT '{}',
  cc_emails        TEXT[] NOT NULL DEFAULT '{}',
  subject          TEXT NOT NULL DEFAULT '',
  body             TEXT NOT NULL DEFAULT '',
  in_reply_to      TEXT REFERENCES mail_messages(id),
  thread_id        TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'discarded')),
  created_by       TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'assistant')),
  turn_id          UUID,
  sent_message_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_drafts_user ON mail_drafts (user_id, status, updated_at DESC);

-- ───────────────────────── Host app: docs ─────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  next_pid    INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Paragraph IDs (p_1, p_2, ...) are stable for the life of a document, so the
-- model can say "insert after p_3" without counting characters.
CREATE TABLE IF NOT EXISTS doc_paragraphs (
  doc_id              TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  id                  TEXT NOT NULL,
  position            DOUBLE PRECISION NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'body' CHECK (kind IN ('title', 'heading', 'body', 'bullet')),
  text                TEXT NOT NULL,
  -- Tracked changes: 'insert' is a suggested new paragraph, 'replace' carries
  -- suggested_text for an existing one. Either can be accepted or rejected.
  suggestion          TEXT CHECK (suggestion IN ('insert', 'replace')),
  suggested_text      TEXT,
  suggested_by        TEXT,
  suggestion_turn_id  UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, id)
);
CREATE INDEX IF NOT EXISTS doc_paragraphs_order ON doc_paragraphs (doc_id, position);

-- principal is 'user:<id>', 'group:<id>' or 'org:<id>'.
CREATE TABLE IF NOT EXISTS doc_shares (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  principal  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  PRIMARY KEY (doc_id, principal)
);

-- ───────────────────────── Host app: calendar ─────────────────────────

CREATE TABLE IF NOT EXISTS calendar_events (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  location     TEXT,
  attendees    TEXT[] NOT NULL DEFAULT '{}',
  description  TEXT,
  created_by   TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'assistant')),
  turn_id      UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_events_owner ON calendar_events (owner_id, starts_at);

-- ───────────────────────── Retrieval index ─────────────────────────

-- Transactional outbox: every write to mail or docs inserts an event in the
-- same transaction, so the index can never silently miss a change.
-- priority 0 = permission change or delete (processed first, never delayed),
-- 1 = content change, 2 = backfill.
CREATE TABLE IF NOT EXISTS index_events (
  id            BIGSERIAL PRIMARY KEY,
  source_type   TEXT NOT NULL CHECK (source_type IN ('mail', 'doc')),
  source_id     TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('upsert', 'delete', 'acl')),
  priority      SMALLINT NOT NULL,
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS index_events_pending ON index_events (priority, id) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS index_events_source ON index_events (source_type, source_id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS chunks (
  id            TEXT PRIMARY KEY,
  source_type   TEXT NOT NULL CHECK (source_type IN ('mail', 'doc')),
  source_id     TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  title         TEXT NOT NULL,
  author        TEXT NOT NULL,
  author_email  TEXT NOT NULL,
  source_date   TIMESTAMPTZ NOT NULL,
  position      INTEGER NOT NULL,
  anchor        TEXT,
  text          TEXT NOT NULL,
  -- Principals allowed to read this chunk. The permission filter runs inside
  -- the search query, never after it.
  acl           TEXT[] NOT NULL,
  is_external   BOOLEAN NOT NULL DEFAULT false,
  tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || author || ' ' || text)) STORED,
  embedding     VECTOR(256) NOT NULL,
  content_hash  TEXT NOT NULL,
  indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source_type, source_id);
CREATE INDEX IF NOT EXISTS chunks_acl ON chunks USING GIN (acl);
CREATE INDEX IF NOT EXISTS chunks_tsv ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- ───────────────────────── Assistant ─────────────────────────

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  confirm_writes                  BOOLEAN NOT NULL DEFAULT false,
  block_external_after_untrusted  BOOLEAN NOT NULL DEFAULT false,
  allow_send                      BOOLEAN NOT NULL DEFAULT true,
  allow_doc_edits                 BOOLEAN NOT NULL DEFAULT true,
  prefetch                        BOOLEAN NOT NULL DEFAULT true,
  max_steps                       INTEGER NOT NULL DEFAULT 15 CHECK (max_steps BETWEEN 1 AND 30),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app         TEXT NOT NULL CHECK (app IN ('mail', 'docs', 'calendar')),
  title       TEXT,
  is_eval     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations (user_id, app, updated_at DESC);

-- One turn = one user message and everything the assistant did to answer it.
-- `messages` is the turn's slice of the model conversation (user message,
-- assistant replies, tool results), checkpointed after every step, so any API
-- instance can resume the turn after a confirmation, a client tool result or
-- a crash.
CREATE TABLE IF NOT EXISTS turns (
  id                UUID PRIMARY KEY,
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  user_text         TEXT NOT NULL,
  client_context    JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL CHECK (status IN
                      ('running', 'waiting_client', 'waiting_confirmation', 'completed', 'failed', 'cancelled')),
  messages          JSONB NOT NULL DEFAULT '[]',
  -- In-flight tool batch: the calls of the last assistant reply, results so
  -- far, and the call the turn is waiting on.
  batch             JSONB,
  tainted           BOOLEAN NOT NULL DEFAULT false,
  toolset_hash      TEXT,
  model             TEXT,
  steps             INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  active_ms         INTEGER NOT NULL DEFAULT 0,
  final_text        TEXT,
  citations         JSONB NOT NULL DEFAULT '[]',
  sources           JSONB NOT NULL DEFAULT '{}',
  error_code        TEXT,
  error_message     TEXT,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  waiting_since     TIMESTAMPTZ,
  cancel_requested  BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key),
  UNIQUE (conversation_id, seq)
);
-- One active turn per conversation: a second tab submitting at the same time
-- gets 409 and attaches to the running turn instead.
CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active ON turns (conversation_id)
  WHERE status IN ('running', 'waiting_client', 'waiting_confirmation');
CREATE INDEX IF NOT EXISTS turns_sweep ON turns (status, lease_expires_at)
  WHERE status IN ('running', 'waiting_client', 'waiting_confirmation');
CREATE INDEX IF NOT EXISTS turns_recent ON turns (created_at DESC);

-- Audit trail: every model call, tool call, policy decision and notice.
CREATE TABLE IF NOT EXISTS turn_steps (
  id                 BIGSERIAL PRIMARY KEY,
  turn_id            UUID NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  step               INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN
                       ('model_call', 'tool_call', 'policy', 'notice', 'wrap_up', 'prefetch', 'compaction')),
  name               TEXT,
  detail             JSONB NOT NULL DEFAULT '{}',
  latency_ms         INTEGER,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turn_steps_turn ON turn_steps (turn_id, id);

CREATE TABLE IF NOT EXISTS pending_actions (
  id          TEXT PRIMARY KEY,
  turn_id     UUID NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args        JSONB NOT NULL,
  preview     JSONB NOT NULL,
  reason      TEXT NOT NULL,
  tainted     BOOLEAN NOT NULL DEFAULT false,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  expires_at  TIMESTAMPTZ NOT NULL,
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (turn_id, call_id)
);

-- Idempotency for tool writes, keyed by "<turn id>:<tool call id>". The row is
-- inserted in the same transaction as the write, so a resumed turn that runs
-- the same call again gets the stored result instead of a second write.
CREATE TABLE IF NOT EXISTS tool_executions (
  idempotency_key  TEXT PRIMARY KEY,
  turn_id          UUID NOT NULL,
  call_id          TEXT NOT NULL,
  tool             TEXT NOT NULL,
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id          BIGSERIAL PRIMARY KEY,
  model       TEXT NOT NULL,
  summary     JSONB NOT NULL,
  results     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Live quality signals: was an AI edit kept or undone, was an AI draft sent or
-- discarded. Offline evals say whether the assistant can do a task; these say
-- whether people actually wanted what it did.
CREATE TABLE IF NOT EXISTS assistant_feedback (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_id     UUID,
  kind        TEXT NOT NULL CHECK (kind IN ('edit_kept', 'edit_undone', 'draft_sent', 'draft_discarded')),
  subject     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_feedback_recent ON assistant_feedback (created_at DESC);
