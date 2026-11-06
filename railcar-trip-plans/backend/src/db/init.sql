-- Railcar Trip Plans and ETAs: consolidated schema. Every statement is idempotent.
--
-- Three groups of tables:
--   1. Reference data (network, schedule, dwell history, shippers, cars, users).
--   2. The event store: append-only `events` (the source of truth and the outbox) plus three log indexes
--      written in the same transaction as the append.
--   3. Consumer-owned state: idempotency markers, read models (projections), the replanning process
--      manager's state, and the notifier's batching state. Every read model can be rebuilt from `events`.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shippers (
  shipper_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  contact      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('shipper', 'ops', 'admin')),
  shipper_id    TEXT REFERENCES shippers(shipper_id),
  CHECK ((role = 'shipper') = (shipper_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS yards (
  yard_id                 TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  -- The yard's published minimum connection standard: the least time from arrival to departure on another train.
  min_connection_minutes  INT NOT NULL,
  interchange_road        TEXT
);

CREATE TABLE IF NOT EXISTS aei_sites (
  site_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('line', 'yard_lead')),
  yard_id     TEXT REFERENCES yards(yard_id),
  from_yard   TEXT REFERENCES yards(yard_id),
  to_yard     TEXT REFERENCES yards(yard_id),
  -- Reader firmware: v1 readers send CarSighted v1, v2 readers add reader confidence and orientation.
  firmware    INT NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS trains (
  train_id                TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  from_yard               TEXT NOT NULL REFERENCES yards(yard_id),
  to_yard                 TEXT NOT NULL REFERENCES yards(yard_id),
  depart_minute_of_day    INT NOT NULL,          -- UTC
  run_p50_minutes         INT NOT NULL,
  run_p90_minutes         INT NOT NULL,
  capacity                INT NOT NULL,
  priority                BOOLEAN NOT NULL DEFAULT false
);

-- One row per scheduled run (train + service date). Materialized lazily and idempotently for the window a
-- planner looks at. Whether a run departed, arrived, was delayed or was cancelled is in the event log.
CREATE TABLE IF NOT EXISTS train_runs (
  run_id               TEXT PRIMARY KEY,
  train_id             TEXT NOT NULL REFERENCES trains(train_id),
  service_date         DATE NOT NULL,
  from_yard            TEXT NOT NULL,
  to_yard              TEXT NOT NULL,
  scheduled_departure  TIMESTAMPTZ NOT NULL,
  scheduled_arrival    TIMESTAMPTZ NOT NULL,
  capacity             INT NOT NULL
);
CREATE INDEX IF NOT EXISTS train_runs_departure_idx ON train_runs (from_yard, to_yard, scheduled_departure);

-- Capacity bookings. One row per (run, trip); a run is full when its count reaches capacity.
CREATE TABLE IF NOT EXISTS run_reservations (
  run_id       TEXT NOT NULL REFERENCES train_runs(run_id),
  trip_id      TEXT NOT NULL,
  reserved_by  TEXT NOT NULL,            -- 'planner', 'saga:<id>' or 'ops:<username>'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, trip_id)
);
CREATE INDEX IF NOT EXISTS run_reservations_trip_idx ON run_reservations (trip_id);
CREATE INDEX IF NOT EXISTS run_reservations_by_idx ON run_reservations (reserved_by);

-- Historical yard time per yard and block: how long after arrival a car is ready to leave (classified,
-- inspected, blocked). The ETA model samples this and then waits for the next train that carries the block.
CREATE TABLE IF NOT EXISTS dwell_stats (
  yard_id      TEXT NOT NULL,
  block        TEXT NOT NULL,           -- destination yard of the outbound block, or LOCAL / REPAIR / FOREIGN
  p10_minutes  INT NOT NULL,
  p50_minutes  INT NOT NULL,
  p90_minutes  INT NOT NULL,
  samples      INT NOT NULL,
  PRIMARY KEY (yard_id, block)
);

CREATE TABLE IF NOT EXISTS cars (
  car_id         TEXT PRIMARY KEY,
  car_type       TEXT NOT NULL,
  owner_mark     TEXT NOT NULL,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. The event store (source of truth, and the outbox the relay publishes from)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  position        BIGSERIAL PRIMARY KEY,                 -- global order of commit-time assignment
  event_id        UUID NOT NULL UNIQUE,                  -- producer-assigned; a resend with the same id is a no-op
  type            TEXT NOT NULL,
  version         INT NOT NULL,                          -- schema version as produced (never rewritten)
  stream_id       TEXT NOT NULL,                         -- car-<id>, train-<run>, plan-<trip>, exception-<id>, ...
  stream_version  INT NOT NULL,
  topic           TEXT NOT NULL CHECK (topic IN ('car', 'train', 'shipper')),
  partition_key   TEXT NOT NULL,                         -- car id, train run id or shipper id
  occurred_at     TIMESTAMPTZ NOT NULL,                  -- event time
  recorded_at     TIMESTAMPTZ NOT NULL,                  -- processing time (simulation clock when one runs)
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),    -- wall clock, for throughput metrics only
  correlation_id  UUID NOT NULL,
  causation_id    UUID,
  producer        TEXT NOT NULL,
  dedupe_key      TEXT UNIQUE,                           -- natural key: catches resends that carry a new event id
  payload         JSONB NOT NULL,
  published_at    TIMESTAMPTZ,
  UNIQUE (stream_id, stream_version)
);
CREATE INDEX IF NOT EXISTS events_unpublished_idx ON events (position) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, occurred_at);
CREATE INDEX IF NOT EXISTS events_causation_idx ON events (causation_id);
CREATE INDEX IF NOT EXISTS events_correlation_idx ON events (correlation_id);
CREATE INDEX IF NOT EXISTS events_inserted_idx ON events (inserted_at);

-- Log indexes, written in the same transaction as the append (not projections: never rebuilt, never stale).
CREATE TABLE IF NOT EXISTS event_cars (          -- events that name a car directly (carId, carIds, consist)
  position  BIGINT NOT NULL REFERENCES events(position),
  car_id    TEXT NOT NULL,
  PRIMARY KEY (car_id, position)
);
CREATE TABLE IF NOT EXISTS train_run_cars (      -- consist membership, from TrainDeparted
  run_id  TEXT NOT NULL,
  car_id  TEXT NOT NULL,
  PRIMARY KEY (run_id, car_id)
);
CREATE INDEX IF NOT EXISTS train_run_cars_car_idx ON train_run_cars (car_id);
CREATE TABLE IF NOT EXISTS plan_run_index (      -- every run named by any version of a trip plan
  trip_id  TEXT NOT NULL,
  car_id   TEXT NOT NULL,
  run_id   TEXT NOT NULL,
  PRIMARY KEY (trip_id, run_id)
);
CREATE INDEX IF NOT EXISTS plan_run_index_run_idx ON plan_run_index (run_id);
CREATE INDEX IF NOT EXISTS plan_run_index_car_idx ON plan_run_index (car_id);

-- ---------------------------------------------------------------------------
-- 3. Consumer-owned state
-- ---------------------------------------------------------------------------

-- Idempotency: a consumer group records each event id in the same transaction as its effects.
CREATE TABLE IF NOT EXISTS processed_events (
  consumer      TEXT NOT NULL,
  event_id      UUID NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS consumer_checkpoints (
  consumer          TEXT PRIMARY KEY,
  events_processed  BIGINT NOT NULL DEFAULT 0,
  duplicates        BIGINT NOT NULL DEFAULT 0,
  last_event_id     UUID,
  last_position     BIGINT,
  last_recorded_at  TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inline projection of the trip-plan aggregate (updated in the same transaction as each plan event).
CREATE TABLE IF NOT EXISTS trip_plans (
  trip_id               TEXT PRIMARY KEY,
  car_id                TEXT NOT NULL,
  shipper_id            TEXT NOT NULL,
  origin_yard           TEXT NOT NULL,
  destination_yard      TEXT NOT NULL,
  destination_customer  TEXT NOT NULL,
  handoff_road          TEXT,
  released_at           TIMESTAMPTZ NOT NULL,
  current_version       INT NOT NULL,
  legs                  JSONB NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS trip_plans_car_idx ON trip_plans (car_id);
CREATE INDEX IF NOT EXISTS trip_plans_shipper_idx ON trip_plans (shipper_id);

CREATE TABLE IF NOT EXISTS trip_plan_versions (
  trip_id      TEXT NOT NULL,
  version      INT NOT NULL,
  legs         JSONB NOT NULL,
  reason_code  TEXT NOT NULL,
  reason_text  TEXT NOT NULL,
  revised_by   TEXT NOT NULL,
  event_id     UUID NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (trip_id, version)
);

CREATE TABLE IF NOT EXISTS plan_legs_current (
  trip_id              TEXT NOT NULL,
  leg_seq              INT NOT NULL,
  car_id               TEXT NOT NULL,
  plan_version         INT NOT NULL,
  run_id               TEXT NOT NULL,
  train_id             TEXT NOT NULL,
  from_yard            TEXT NOT NULL,
  to_yard              TEXT NOT NULL,
  planned_departure    TIMESTAMPTZ NOT NULL,
  planned_arrival      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (trip_id, leg_seq)
);
CREATE INDEX IF NOT EXISTS plan_legs_current_run_idx ON plan_legs_current (run_id);

-- Car-state projection (consumer group car-state). A pure fold of the car's timeline.
CREATE TABLE IF NOT EXISTS car_state (
  car_id               TEXT PRIMARY KEY,
  trip_id              TEXT,
  shipper_id           TEXT,
  plan_version         INT,
  status               TEXT NOT NULL,
  location_id          TEXT,
  train_run_id         TEXT,
  position_confidence  TEXT NOT NULL,
  position_source      TEXT,
  last_observed_at     TIMESTAMPTZ,
  last_event_at        TIMESTAMPTZ,
  arrived_at           TIMESTAMPTZ,
  current_leg          INT,
  plan_status          TEXT NOT NULL,
  missed_reads         INT NOT NULL DEFAULT 0,
  late_events          INT NOT NULL DEFAULT 0,
  out_of_order_events  INT NOT NULL DEFAULT 0,
  event_count          INT NOT NULL DEFAULT 0,
  foreign_road         TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS car_state_shipper_idx ON car_state (shipper_id);

-- ETA projection (consumer group eta).
CREATE TABLE IF NOT EXISTS car_eta (
  car_id          TEXT PRIMARY KEY,
  trip_id         TEXT NOT NULL,
  plan_version    INT NOT NULL,
  p10             TIMESTAMPTZ NOT NULL,
  p50             TIMESTAMPTZ NOT NULL,
  p90             TIMESTAMPTZ NOT NULL,
  confidence      TEXT NOT NULL,
  as_of           TIMESTAMPTZ NOT NULL,
  final           BOOLEAN NOT NULL DEFAULT false,
  basis           JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every prediction, keyed by the event that triggered it (an audit log, not rebuilt by replay).
CREATE TABLE IF NOT EXISTS eta_history (
  id                BIGSERIAL PRIMARY KEY,
  car_id            TEXT NOT NULL,
  trip_id           TEXT NOT NULL,
  plan_version      INT NOT NULL,
  p10               TIMESTAMPTZ NOT NULL,
  p50               TIMESTAMPTZ NOT NULL,
  p90               TIMESTAMPTZ NOT NULL,
  as_of             TIMESTAMPTZ NOT NULL,
  trigger_event_id  UUID NOT NULL,
  trigger_type      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (car_id, trigger_event_id)
);

-- Exceptions projection (consumer group exceptions), applied from ExceptionOpened / ExceptionResolved.
CREATE TABLE IF NOT EXISTS exceptions (
  exception_id      TEXT PRIMARY KEY,
  car_id            TEXT NOT NULL,
  trip_id           TEXT,
  shipper_id        TEXT,
  type              TEXT NOT NULL,
  severity          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  yard_id           TEXT,
  summary           TEXT NOT NULL,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  opened_at         TIMESTAMPTZ NOT NULL,
  opened_event_id   UUID NOT NULL,
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  resolution        TEXT,
  version           INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS exceptions_status_idx ON exceptions (status, type);
CREATE INDEX IF NOT EXISTS exceptions_car_idx ON exceptions (car_id);

-- Replanning process manager state: one row per saga instance.
CREATE TABLE IF NOT EXISTS replan_sagas (
  saga_id             TEXT PRIMARY KEY,
  dedupe_key          TEXT NOT NULL UNIQUE,      -- trip:planVersion:legSeq
  trip_id             TEXT NOT NULL,
  car_id              TEXT NOT NULL,
  shipper_id          TEXT NOT NULL,
  trigger_type        TEXT NOT NULL,             -- inbound_delay, departed_without_car, train_cancelled
  trigger_event_id    UUID NOT NULL,
  correlation_id      UUID NOT NULL,
  state               TEXT NOT NULL,
  attempt             INT NOT NULL DEFAULT 1,
  parent_saga_id      TEXT,
  from_plan_version   INT NOT NULL,
  to_plan_version     INT,
  leg_seq             INT NOT NULL,
  yard_id             TEXT NOT NULL,
  missed_run_id       TEXT NOT NULL,
  ready_at            TIMESTAMPTZ NOT NULL,
  chosen_run_id       TEXT,
  revision_event_id   UUID,
  eta_before          JSONB,
  eta_after           JSONB,
  error               TEXT,
  steps               JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replan_sagas_state_idx ON replan_sagas (state, updated_at);
CREATE INDEX IF NOT EXISTS replan_sagas_run_idx ON replan_sagas (chosen_run_id);
CREATE INDEX IF NOT EXISTS replan_sagas_trip_idx ON replan_sagas (trip_id);

-- Notifier: items waiting for a digest, per-shipper batching windows, sent digests.
CREATE TABLE IF NOT EXISTS notification_items (
  id               BIGSERIAL PRIMARY KEY,
  shipper_id       TEXT NOT NULL,
  car_id           TEXT NOT NULL,
  trip_id          TEXT,
  kind             TEXT NOT NULL,              -- eta_change, replanned, bad_order, delivered
  source_event_id  UUID NOT NULL UNIQUE,
  payload          JSONB NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  digest_id        TEXT
);
CREATE INDEX IF NOT EXISTS notification_items_pending_idx ON notification_items (shipper_id) WHERE digest_id IS NULL;

CREATE TABLE IF NOT EXISTS shipper_digest_state (
  shipper_id        TEXT PRIMARY KEY,
  window_opened_at  TIMESTAMPTZ,
  last_item_at      TIMESTAMPTZ,
  last_sent_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS digests (
  digest_id        TEXT PRIMARY KEY,
  shipper_id       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sim_time         TIMESTAMPTZ NOT NULL,
  item_count       INT NOT NULL,
  car_count        INT NOT NULL,
  suppressed_count INT NOT NULL,
  lines            JSONB NOT NULL,
  event_id         UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS digests_shipper_idx ON digests (shipper_id, created_at DESC);

CREATE TABLE IF NOT EXISTS car_last_notified (
  car_id        TEXT PRIMARY KEY,
  p50           TIMESTAMPTZ,
  plan_version  INT,
  notified_at   TIMESTAMPTZ NOT NULL
);

-- Results of `npm run replay -- <projection>`.
CREATE TABLE IF NOT EXISTS replay_runs (
  id             BIGSERIAL PRIMARY KEY,
  projection     TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ NOT NULL,
  events_read    INT NOT NULL,
  rows_live      INT NOT NULL,
  rows_rebuilt   INT NOT NULL,
  checksum_live  TEXT NOT NULL,
  checksum_rebuilt TEXT NOT NULL,
  matches        BOOLEAN NOT NULL,
  applied        BOOLEAN NOT NULL,
  mismatches     JSONB NOT NULL DEFAULT '[]'::jsonb
);
