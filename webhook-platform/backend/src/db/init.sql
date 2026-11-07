-- Webhook platform schema. Every statement is idempotent: `npm run db:migrate`
-- can be re-run safely. PostgreSQL is the source of truth for events,
-- deliveries, attempts and endpoint state; RabbitMQ carries only work tickets.

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('customer', 'operator')),
  org_id         TEXT REFERENCES orgs(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'customer') = (org_id IS NOT NULL))
);

-- Producer API keys. Only a SHA-256 of the key is stored; the keys are 192-bit
-- random strings, so a fast hash is safe and can be indexed for lookup.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS endpoints (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  url                   TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  -- '*' (all), 'order.*' (family) or exact types
  event_types           TEXT[] NOT NULL DEFAULT '{*}',
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason       TEXT,
  disabled_at           TIMESTAMPTZ,
  -- Requests this endpoint may have in flight across the whole worker fleet.
  max_concurrency       INT NOT NULL DEFAULT 4 CHECK (max_concurrency BETWEEN 1 AND 32),
  -- Rotation: the previous secret is still sent until previous_expires_at.
  secret_current        TEXT NOT NULL,
  secret_previous       TEXT,
  previous_expires_at   TIMESTAMPTZ,
  secret_rotated_at     TIMESTAMPTZ,
  -- Health. failing_since = start of the current unbroken failure streak.
  consecutive_failures  INT NOT NULL DEFAULT 0,
  failing_since         TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_failure_at       TIMESTAMPTZ,
  -- Set by a 429 + Retry-After: nothing is sent to this endpoint before it.
  paused_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS endpoints_org_idx ON endpoints (org_id, created_at);

-- Immutable. A retried emit with the same Idempotency-Key returns this row.
CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id),
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  ordering_key     TEXT,
  sequence         BIGINT,
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'console')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  CHECK ((ordering_key IS NULL) = (sequence IS NULL))
);
CREATE INDEX IF NOT EXISTS events_org_created_idx ON events (org_id, created_at DESC);

-- Per-key sequence numbers: receivers that need order can compare and discard stale updates.
CREATE TABLE IF NOT EXISTS ordering_sequences (
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  ordering_key   TEXT NOT NULL,
  last_sequence  BIGINT NOT NULL,
  PRIMARY KEY (org_id, ordering_key)
);

-- One event × one endpoint. State machine:
--   queued → in_flight → delivered | scheduled (retry) | failed
--   scheduled → queued (scheduler, when due)      failed|delivered → queued (replay)
CREATE TABLE IF NOT EXISTS deliveries (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id),
  endpoint_id        TEXT NOT NULL REFERENCES endpoints(id),
  org_id             TEXT NOT NULL REFERENCES orgs(id),
  state              TEXT NOT NULL CHECK (state IN ('queued', 'in_flight', 'scheduled', 'delivered', 'failed')),
  -- Bumped every time a ticket is issued; a ticket with an older number is stale.
  dispatch_seq       INT NOT NULL DEFAULT 1,
  attempt_count      INT NOT NULL DEFAULT 0,
  replay_count       INT NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ,
  -- Retry window: provisional at creation, then fixed at first attempt + horizon (window_started_at),
  -- so time the platform spent down or backlogged never counts against the endpoint.
  retry_deadline     TIMESTAMPTZ NOT NULL,
  window_started_at  TIMESTAMPTZ,
  queued_at          TIMESTAMPTZ,
  -- Lease: a worker owns an in_flight delivery until lease_until; lease_token fences its writes.
  lease_token        TEXT,
  lease_until        TIMESTAMPTZ,
  claimed_by         TEXT,
  first_attempt_at   TIMESTAMPTZ,
  last_attempt_at    TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  last_status_code   INT,
  last_error_class   TEXT,
  park_count         INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, endpoint_id)
);
-- The scheduler walks endpoints and takes each one's earliest due retries, up to its spare capacity.
CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries (endpoint_id, next_attempt_at) WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS deliveries_active_idx ON deliveries (endpoint_id) WHERE state IN ('queued', 'in_flight');
CREATE INDEX IF NOT EXISTS deliveries_lease_idx ON deliveries (lease_until) WHERE state = 'in_flight';
CREATE INDEX IF NOT EXISTS deliveries_queued_idx ON deliveries (queued_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS deliveries_endpoint_created_idx ON deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_event_idx ON deliveries (event_id);

-- Every HTTP attempt, append-only.
CREATE TABLE IF NOT EXISTS attempts (
  id               BIGSERIAL PRIMARY KEY,
  delivery_id      TEXT NOT NULL REFERENCES deliveries(id),
  attempt_no       INT NOT NULL,
  trigger          TEXT NOT NULL CHECK (trigger IN ('initial', 'retry', 'replay', 'recovered')),
  started_at       TIMESTAMPTZ NOT NULL,
  latency_ms       INT,
  status_code      INT,
  error_class      TEXT NOT NULL,
  error_message    TEXT,
  response_body    TEXT,
  outcome          TEXT NOT NULL CHECK (outcome IN ('delivered', 'retry', 'failed', 'superseded', 'lost')),
  next_attempt_at  TIMESTAMPTZ,
  worker_id        TEXT,
  resolved_ip      TEXT,
  signatures_sent  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attempts_delivery_idx ON attempts (delivery_id, id);
CREATE INDEX IF NOT EXISTS attempts_started_idx ON attempts (started_at);

-- Transactional outbox: written in the same transaction as the delivery state
-- change, published to RabbitMQ by the publisher, marked per row.
CREATE TABLE IF NOT EXISTS outbox (
  id            BIGSERIAL PRIMARY KEY,
  delivery_id   TEXT NOT NULL REFERENCES deliveries(id),
  dispatch_seq  INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_published_idx ON outbox (published_at) WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  endpoint_id  TEXT REFERENCES endpoints(id),
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_org_idx ON notifications (org_id, created_at DESC);
