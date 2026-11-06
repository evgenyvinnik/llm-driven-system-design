-- Track hazard detection schema. Every statement is idempotent (npm run db:migrate reruns it).
--
-- Layout:
--   reference data      desks, subdivisions, segments, sensors, users
--   edge inbox          edge_events (append-only, dedup on (source_id, seq)), gateway_state, train_positions
--   event store         events (append-only, per-stream versions, global position) - source of truth for hazards
--   outbox              outbox (one row per event to publish; the relay marks rows published)
--   consumer state      processed_events, command_log, timers, evidence, correlation_hazards, rail_temp_samples,
--                       heat_state, sensor_state, notifications, latency_samples
--   projections         proj_hazards, proj_alerts, proj_restrictions, proj_coverage, train_view,
--                       projection_versions, projection_checkpoints

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- reference data
CREATE TABLE IF NOT EXISTS desks (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subdivisions (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  start_mp NUMERIC(6,1) NOT NULL,
  end_mp   NUMERIC(6,1) NOT NULL,
  desk_id  TEXT NOT NULL REFERENCES desks(id)
);

CREATE TABLE IF NOT EXISTS segments (
  id             TEXT PRIMARY KEY,
  subdivision_id TEXT NOT NULL REFERENCES subdivisions(id),
  start_mp       NUMERIC(6,1) NOT NULL,
  end_mp         NUMERIC(6,1) NOT NULL,
  gateway_id     TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sensors (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('geophone', 'slide_fence', 'camera', 'rail_temp', 'water_level')),
  subdivision_id TEXT NOT NULL REFERENCES subdivisions(id),
  segment_id     TEXT NOT NULL REFERENCES segments(id),
  milepost       NUMERIC(6,1) NOT NULL,
  gateway_id     TEXT NOT NULL,
  neutral_temp_f NUMERIC(5,1),
  label          TEXT,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_by  TEXT NOT NULL DEFAULT 'seed'
);
CREATE INDEX IF NOT EXISTS sensors_segment_idx ON sensors (segment_id);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('dispatcher', 'inspector', 'admin')),
  desk_id       TEXT REFERENCES desks(id)
);

-- ---------------------------------------------------------------- edge inbox
-- Every event a gateway delivered, exactly once per (source_id, seq), whatever its payload.
-- Accept-and-store: payload validation happens in consumers, so one bad event never wedges a gateway's queue.
CREATE TABLE IF NOT EXISTS edge_events (
  event_id       UUID PRIMARY KEY,
  source_id      TEXT NOT NULL,
  seq            BIGINT NOT NULL,
  type           TEXT NOT NULL,
  version        INT NOT NULL,
  sensor_id      TEXT,
  subdivision_id TEXT,
  segment_id     TEXT,
  partition_key  TEXT NOT NULL,
  lane           TEXT NOT NULL CHECK (lane IN ('critical', 'bulk', 'trains')),
  late           BOOLEAN NOT NULL DEFAULT false,
  occurred_at    TIMESTAMPTZ NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lag_ms         INT NOT NULL,
  batch_id       TEXT,
  payload        JSONB NOT NULL,
  UNIQUE (source_id, seq)
);
CREATE INDEX IF NOT EXISTS edge_events_recorded_idx ON edge_events (recorded_at);
CREATE INDEX IF NOT EXISTS edge_events_sensor_idx ON edge_events (sensor_id, occurred_at);

CREATE TABLE IF NOT EXISTS gateway_state (
  gateway_id         TEXT PRIMARY KEY,
  segment_id         TEXT NOT NULL,
  last_seen_at       TIMESTAMPTZ,
  -- "I have delivered everything that occurred before this": the gateway's own watermark.
  reported_watermark TIMESTAMPTZ,
  -- The cloud's watermark for the segment: monotonic. Follows the reported watermark while the gateway is
  -- active; advances on processing time (now - idle timeout) while it is silent, so windows still close.
  -- Events that occurred before it are late.
  effective_watermark TIMESTAMPTZ,
  buffered_count     INT NOT NULL DEFAULT 0,
  last_seq           BIGINT NOT NULL DEFAULT 0,
  batches            INT NOT NULL DEFAULT 0,
  events_accepted    BIGINT NOT NULL DEFAULT 0,
  duplicates         BIGINT NOT NULL DEFAULT 0,
  coverage           TEXT NOT NULL DEFAULT 'ok' CHECK (coverage IN ('ok', 'degraded')),
  coverage_since     TIMESTAMPTZ
);

-- Train positions from the dispatch/PTC feed, kept as reference data for "was a train here at time t?".
CREATE TABLE IF NOT EXISTS train_positions (
  event_id       UUID PRIMARY KEY,
  train_id       TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  subdivision_id TEXT NOT NULL,
  milepost       NUMERIC(7,3) NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('increasing', 'decreasing')),
  speed_mph      NUMERIC(5,1) NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS train_positions_sub_time_idx ON train_positions (subdivision_id, occurred_at);
CREATE INDEX IF NOT EXISTS train_positions_train_time_idx ON train_positions (train_id, occurred_at);

-- ---------------------------------------------------------------- event store
-- Source of truth for every hazard's lifecycle and for coverage changes. Append-only.
-- UNIQUE (stream_id, stream_version) is the optimistic concurrency check.
CREATE TABLE IF NOT EXISTS events (
  global_position BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  stream_id       TEXT NOT NULL,
  stream_version  INT NOT NULL,
  type            TEXT NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  partition_key   TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  correlation_id  TEXT NOT NULL,
  causation_id    TEXT,
  source          TEXT NOT NULL,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload         JSONB NOT NULL,
  UNIQUE (stream_id, stream_version)
);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, global_position);
CREATE INDEX IF NOT EXISTS events_correlation_idx ON events (correlation_id);
CREATE INDEX IF NOT EXISTS events_recorded_idx ON events (recorded_at);

CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS events_no_update ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();

CREATE SEQUENCE IF NOT EXISTS hazard_code_seq START 1001;

-- ---------------------------------------------------------------- outbox
CREATE TABLE IF NOT EXISTS outbox (
  id            BIGSERIAL PRIMARY KEY,
  event_id      UUID NOT NULL,
  topic         TEXT NOT NULL CHECK (topic IN ('edge.critical', 'edge.bulk', 'trains', 'domain')),
  lane          TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  envelope      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (lane, id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------- consumer state
CREATE TABLE IF NOT EXISTS processed_events (
  consumer     TEXT NOT NULL,
  event_id     UUID NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- API command idempotency: a retried command (same command id) returns the stored result.
CREATE TABLE IF NOT EXISTS command_log (
  command_id UUID PRIMARY KEY,
  username   TEXT NOT NULL,
  hazard_id  TEXT,
  command    TEXT NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Correlator keyed state: evidence extracted from edge events, and the spatial index of hazards it opened.
CREATE TABLE IF NOT EXISTS evidence (
  event_id           UUID PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('fence_break', 'ground_vibration', 'camera_obstruction', 'high_water')),
  sensor_id          TEXT NOT NULL,
  subdivision_id     TEXT NOT NULL,
  segment_id         TEXT NOT NULL,
  milepost           NUMERIC(6,1) NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  confidence         NUMERIC(4,3) NOT NULL,
  late               BOOLEAN NOT NULL DEFAULT false,
  explained_by_train TEXT,
  hazard_id          TEXT,
  expired            BOOLEAN NOT NULL DEFAULT false,
  details            JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS evidence_window_idx ON evidence (subdivision_id, occurred_at);
CREATE INDEX IF NOT EXISTS evidence_hazard_idx ON evidence (hazard_id);

CREATE TABLE IF NOT EXISTS correlation_hazards (
  hazard_id         TEXT PRIMARY KEY,
  code              TEXT NOT NULL,
  kind              TEXT NOT NULL,
  subdivision_id    TEXT NOT NULL,
  segment_id        TEXT NOT NULL,
  mp_from           NUMERIC(6,1) NOT NULL,
  mp_to             NUMERIC(6,1) NOT NULL,
  confidence        NUMERIC(4,3) NOT NULL,
  severity          TEXT NOT NULL,
  detection_status  TEXT NOT NULL,
  first_evidence_at TIMESTAMPTZ NOT NULL,
  stream_version    INT NOT NULL
);
CREATE INDEX IF NOT EXISTS correlation_hazards_sub_idx ON correlation_hazards (subdivision_id, mp_from, mp_to);

CREATE TABLE IF NOT EXISTS rail_temp_samples (
  sensor_id   TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  temp_f      NUMERIC(5,1) NOT NULL,
  PRIMARY KEY (sensor_id, occurred_at)
);

CREATE TABLE IF NOT EXISTS heat_state (
  segment_id TEXT PRIMARY KEY,
  band       TEXT NOT NULL,
  hazard_id  TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_state (
  sensor_id      TEXT PRIMARY KEY,
  last_seen_at   TIMESTAMPTZ,
  coverage       TEXT NOT NULL DEFAULT 'ok' CHECK (coverage IN ('ok', 'degraded')),
  degraded_since TIMESTAMPTZ,
  last_value     JSONB
);

-- Durable timers for the alerting process manager (ack deadlines). They survive restarts.
CREATE TABLE IF NOT EXISTS timers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL,
  hazard_id  TEXT NOT NULL,
  due_at     TIMESTAMPTZ NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS timers_due_idx ON timers (due_at) WHERE status = 'pending';

-- Simulated notifications. idempotency_key = event id + recipient + channel, so a redelivered event never pages twice.
CREATE TABLE IF NOT EXISTS notifications (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_id        UUID NOT NULL,
  event_type      TEXT NOT NULL,
  hazard_id       TEXT,
  channel         TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sending', 'delivered', 'failed')),
  attempts        INT NOT NULL DEFAULT 0,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_hazard_idx ON notifications (hazard_id, created_at);

-- Latency budget samples. kind = 'alert' (edge detection -> alert delivered) or 'decision' (edge event -> correlator decision).
CREATE TABLE IF NOT EXISTS latency_samples (
  id               BIGSERIAL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('alert', 'decision')),
  hazard_id        TEXT,
  event_id         UUID,
  event_type       TEXT,
  lane             TEXT NOT NULL,
  late             BOOLEAN NOT NULL,
  edge_occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at      TIMESTAMPTZ NOT NULL,
  detected_at      TIMESTAMPTZ,
  alert_issued_at  TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  total_ms         INT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latency_kind_idx ON latency_samples (kind, created_at);

-- ---------------------------------------------------------------- projections (rebuildable from events)
CREATE TABLE IF NOT EXISTS proj_hazards (
  key            TEXT PRIMARY KEY,
  subdivision_id TEXT NOT NULL,
  open           BOOLEAN NOT NULL,
  severity       TEXT NOT NULL,
  doc            JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS proj_hazards_open_idx ON proj_hazards (open, subdivision_id);

CREATE TABLE IF NOT EXISTS proj_alerts (
  key     TEXT PRIMARY KEY,
  desk_id TEXT NOT NULL,
  status  TEXT NOT NULL,
  doc     JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS proj_alerts_status_idx ON proj_alerts (status, desk_id);

CREATE TABLE IF NOT EXISTS proj_restrictions (
  key            TEXT PRIMARY KEY,
  subdivision_id TEXT NOT NULL,
  active         BOOLEAN NOT NULL,
  doc            JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS proj_coverage (
  key        TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL,
  status     TEXT NOT NULL,
  doc        JSONB NOT NULL
);

-- Natural idempotency key for projections: the last stream version applied, per projection and stream.
CREATE TABLE IF NOT EXISTS projection_versions (
  projection TEXT NOT NULL,
  stream_id  TEXT NOT NULL,
  version    INT NOT NULL,
  PRIMARY KEY (projection, stream_id)
);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection       TEXT PRIMARY KEY,
  last_position    BIGINT NOT NULL DEFAULT 0,
  last_recorded_at TIMESTAMPTZ,
  events_applied   BIGINT NOT NULL DEFAULT 0,
  rebuilt_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest train positions for the strip map (from the trains topic; rebuildable from train_positions).
CREATE TABLE IF NOT EXISTS train_view (
  train_id       TEXT PRIMARY KEY,
  symbol         TEXT NOT NULL,
  subdivision_id TEXT NOT NULL,
  milepost       NUMERIC(7,3) NOT NULL,
  direction      TEXT NOT NULL,
  speed_mph      NUMERIC(5,1) NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL
);
