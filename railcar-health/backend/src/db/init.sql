-- Railcar health monitoring schema. Every statement is idempotent: migrate.ts reruns it safely.
-- Domain timestamps (passed_at, received_at, opened_at...) are in the domain clock, which the
-- simulator compresses; operational timestamps (inserted_at, processed_at) are database now().

-- gen_random_uuid() is built into PostgreSQL 13+; no extension needed.

-- ── Reference data ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dispatcher_desks (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subdivisions (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  start_mp NUMERIC(6,2) NOT NULL,
  end_mp   NUMERIC(6,2) NOT NULL,
  desk_id  TEXT NOT NULL REFERENCES dispatcher_desks(id)
);

CREATE TABLE IF NOT EXISTS yards (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  milepost       NUMERIC(6,2) NOT NULL,
  subdivision_id TEXT NOT NULL REFERENCES subdivisions(id)
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('dispatcher', 'yard', 'admin')),
  desk_id       TEXT REFERENCES dispatcher_desks(id),
  yard_id       TEXT REFERENCES yards(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per wayside site, plus the analyzer's health inputs (heartbeats, bias, missed trains).
-- The decided status (ok/offline/silent/biased) is an event, DetectorHealthChanged; the
-- detector_health projection holds the current value for screens.
CREATE TABLE IF NOT EXISTS detectors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  milepost        NUMERIC(6,2) NOT NULL,
  subdivision_id  TEXT NOT NULL REFERENCES subdivisions(id),
  has_aei         BOOLEAN NOT NULL DEFAULT false,
  braking_zone    BOOLEAN NOT NULL DEFAULT false,
  gateway_id      TEXT NOT NULL,
  last_heard_at   TIMESTAMPTZ,
  last_pass_at    TIMESTAMPTZ,
  buffered_passes INT NOT NULL DEFAULT 0,
  self_test       TEXT NOT NULL DEFAULT 'ok',
  bias_offset_f   NUMERIC(6,2),
  bias_samples    INT NOT NULL DEFAULT 0,
  missed_passes   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS railcars (
  car_id     TEXT PRIMARY KEY,           -- reporting mark + number, e.g. 'NRLX 220187'
  owner_mark TEXT NOT NULL,              -- most cars belong to lessors and shippers, not the railroad
  owner_name TEXT NOT NULL,
  car_type   TEXT NOT NULL,
  axle_count INT NOT NULL DEFAULT 4
);

-- ── Trips and consists (from the transportation system) ──────────────────────

CREATE TABLE IF NOT EXISTS trips (
  trip_id             TEXT PRIMARY KEY,
  symbol              TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('EB', 'WB')),
  origin_yard_id      TEXT NOT NULL REFERENCES yards(id),
  destination_yard_id TEXT NOT NULL REFERENCES yards(id),
  stops               TEXT[] NOT NULL DEFAULT '{}',   -- yards the train stops at, in order, ending at the destination
  status              TEXT NOT NULL DEFAULT 'en_route' CHECK (status IN ('en_route', 'arrived')),
  consist_revision    INT NOT NULL DEFAULT 1,
  departed_at         TIMESTAMPTZ NOT NULL,
  arrived_at          TIMESTAMPTZ,
  arrived_yard_id     TEXT REFERENCES yards(id),
  speed_mph           NUMERIC(5,1),
  last_detector_id    TEXT REFERENCES detectors(id),
  last_milepost       NUMERIC(6,2),
  last_pass_at        TIMESTAMPTZ,
  territory_id        TEXT REFERENCES subdivisions(id),
  next_yard_id        TEXT REFERENCES yards(id),
  next_yard_eta       TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trips_status_idx ON trips (status, departed_at DESC);

-- A consist can be rebuilt en route (cars set out or picked up at a yard). Each revision is kept with
-- the time it took effect, so a pass is resolved against the consist that was true when it was measured.
CREATE TABLE IF NOT EXISTS trip_consist_versions (
  trip_id      TEXT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  revision     INT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  identified_at TIMESTAMPTZ,              -- when the analyzer emitted CarIdentified for this revision's cars
  PRIMARY KEY (trip_id, revision)
);

-- Units in train order from the head end, per consist revision. leading_end = which end of the car faces the head of the train.
CREATE TABLE IF NOT EXISTS trip_units (
  trip_id               TEXT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  revision              INT NOT NULL DEFAULT 1,
  position              INT NOT NULL,
  unit_id               TEXT NOT NULL,
  unit_type             TEXT NOT NULL CHECK (unit_type IN ('locomotive', 'car')),
  axle_count            INT NOT NULL,
  leading_end           CHAR(1) NOT NULL CHECK (leading_end IN ('A', 'B')),
  orientation_source    TEXT NOT NULL DEFAULT 'consist' CHECK (orientation_source IN ('consist', 'aei')),
  corrected_by_detector TEXT,
  loaded                BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (trip_id, revision, position)
);
CREATE INDEX IF NOT EXISTS trip_units_unit_idx ON trip_units (unit_id);

-- The latest revision of each trip's consist, for screens that show "the train now".
CREATE OR REPLACE VIEW current_trip_units AS
  SELECT u.* FROM trip_units u
    JOIN (SELECT trip_id, max(revision) AS revision FROM trip_units GROUP BY trip_id) v
      ON v.trip_id = u.trip_id AND v.revision = u.revision;

CREATE TABLE IF NOT EXISTS trip_events (
  event_id TEXT PRIMARY KEY,               -- idempotency key from the sender
  trip_id  TEXT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('departed', 'arrived')),
  yard_id  TEXT NOT NULL REFERENCES yards(id),
  at       TIMESTAMPTZ NOT NULL
);

-- ── Raw detector data: an append-only FACT LOG, not an event-sourced aggregate ──
-- Volume (hundreds of readings per pass) and no invariants to protect: nothing about a reading
-- depends on an earlier one. The ingest transaction appends PassRecorded and AxleReadingsRecorded
-- to the event store (the outbox); AxleReadingsRecorded carries a claim check to these rows.
-- (Production: a columnar time-series store.)

-- One train passing one detector. (detector_id, pass_id) is the idempotency key: the
-- detector assigns pass_id, so a gateway retry of the same pass is a no-op.
CREATE TABLE IF NOT EXISTS detector_passes (
  detector_id      TEXT NOT NULL REFERENCES detectors(id),
  pass_id          TEXT NOT NULL,
  trip_id          TEXT NOT NULL,
  gateway_id       TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('EB', 'WB')),
  passed_at        TIMESTAMPTZ NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL,
  lag_seconds      INT GENERATED ALWAYS AS (GREATEST(0, EXTRACT(EPOCH FROM (received_at - passed_at)))::int) STORED,
  speed_mph        NUMERIC(5,1) NOT NULL,
  ambient_f        NUMERIC(5,1) NOT NULL,
  axle_count       INT NOT NULL,
  aei              JSONB,                  -- [{ position, unitId, leadingEnd }] at AEI-equipped sites
  edge_alarms      JSONB,                  -- the detector's own alarms, already radioed to the crew
  payload_sha      TEXT NOT NULL,          -- a retry with the same key but different readings is a conflict, not a duplicate
  identity_status  TEXT NOT NULL DEFAULT 'pending'
                   CHECK (identity_status IN ('pending', 'resolved', 'unresolved', 'awaiting_consist')),
  median_bearing_n NUMERIC(5,1),           -- per-rail medians across the train's car bearings
  median_bearing_s NUMERIC(5,1),
  median_wheel_n   NUMERIC(5,1),
  median_wheel_s   NUMERIC(5,1),
  inserted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,            -- set in the analyzer's transaction
  PRIMARY KEY (detector_id, pass_id)
);
CREATE INDEX IF NOT EXISTS detector_passes_trip_idx ON detector_passes (trip_id, passed_at);

-- Per-axle, per-rail readings. Raw columns never change; the resolved columns
-- (car, car-relative axle and side) are derived and may be rewritten when an AEI
-- read corrects the consist.
CREATE TABLE IF NOT EXISTS axle_readings (
  detector_id   TEXT NOT NULL,
  pass_id       TEXT NOT NULL,
  axle_seq      INT NOT NULL,              -- counted from the head end, locomotives included
  rail          CHAR(1) NOT NULL CHECK (rail IN ('N', 'S')),
  bearing_f     NUMERIC(5,1) NOT NULL,
  wheel_f       NUMERIC(5,1) NOT NULL,
  car_id        TEXT,
  unit_position INT,
  car_axle      INT,
  car_side      CHAR(1) CHECK (car_side IN ('L', 'R')),
  PRIMARY KEY (detector_id, pass_id, axle_seq, rail),
  FOREIGN KEY (detector_id, pass_id) REFERENCES detector_passes(detector_id, pass_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS axle_readings_car_idx ON axle_readings (car_id, car_side, car_axle);

-- Which detectors a trip should have passed, and whether we heard from them.
CREATE TABLE IF NOT EXISTS expected_passes (
  trip_id     TEXT NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  detector_id TEXT NOT NULL REFERENCES detectors(id),
  status      TEXT NOT NULL CHECK (status IN ('missing', 'received')),
  noted_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (trip_id, detector_id)
);

-- One bias sample per detector per trip: this detector's train median vs its neighbours' for the same train.
CREATE TABLE IF NOT EXISTS detector_bias_samples (
  detector_id TEXT NOT NULL REFERENCES detectors(id),
  trip_id     TEXT NOT NULL,
  sample_f    NUMERIC(6,2) NOT NULL,
  sampled_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (detector_id, trip_id)
);

-- Per-car, per-bearing summary of each trip: the long-term history the trend logic consults.
CREATE TABLE IF NOT EXISTS bearing_trip_summary (
  car_id            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  position          TEXT NOT NULL,
  trip_id           TEXT NOT NULL,
  observations      INT NOT NULL,
  median_side_delta NUMERIC(6,1) NOT NULL,
  max_side_delta    NUMERIC(6,1) NOT NULL,
  max_above_ambient NUMERIC(6,1) NOT NULL,
  elevated          BOOLEAN NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (car_id, kind, position, trip_id)
);

-- ── Configuration ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS thresholds (
  id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config     JSONB NOT NULL,
  version    INT NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS threshold_changes (
  id         BIGSERIAL PRIMARY KEY,
  version    INT NOT NULL,
  config     JSONB NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Upgrade from the pre-event-sourcing schema (runs once; a no-op afterwards) ─
-- Alerts, holds, work orders, findings, notifications and component installs used to be the
-- source of truth. They are now projections of the event store, rebuilt by the projectors.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'events') THEN
    DROP TABLE IF EXISTS alert_events, notifications, findings, component_installs, work_orders, car_holds, alerts CASCADE;
  END IF;
END $$;
ALTER TABLE detectors DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS status_reason, DROP COLUMN IF EXISTS status_since;
ALTER TABLE detector_passes DROP COLUMN IF EXISTS published_at;
ALTER TABLE trip_consist_versions ADD COLUMN IF NOT EXISTS identified_at TIMESTAMPTZ;

-- ── Event store ───────────────────────────────────────────────────────────────
-- One append-only table plays three roles:
--   * EVENT STORE for the event-sourced aggregates: case-<uuid> (an alert or audit case and its
--     yard response) and car-<car id> (component history). Their events ARE the state; the
--     current-state tables below are projections. Appends carry an expected stream version.
--   * OUTBOX for state-based writes (trips, consists, detector health, raw passes): the state
--     row and its event commit in one transaction; the event is the integration record.
--   * LOG the relay publishes, in global_position order, to one broker stream per event family.
-- global_position is assigned under a short transaction-scoped advisory lock taken just before
-- the INSERT, so positions become visible in commit order and the relay can never skip one.
CREATE TABLE IF NOT EXISTS events (
  global_position BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  stream_id       TEXT NOT NULL,             -- case-<uuid>, car-<car id>, trip-<trip id>, pass-<detector>/<pass>, detector-<id>
  stream_type     TEXT NOT NULL,             -- case | car | trip | pass | detector
  stream_version  INT NOT NULL,              -- 1, 2, 3... per stream: optimistic concurrency
  type            TEXT NOT NULL,             -- past tense: AlertRaised, ComponentReplaced, ...
  version         SMALLINT NOT NULL,         -- schema version of the payload as written (upcast on read)
  family          TEXT NOT NULL,             -- broker stream (Kafka topic) the relay publishes it to
  partition_key   TEXT NOT NULL,             -- Kafka message key: trip id, car id, case id, detector id
  occurred_at     TIMESTAMPTZ NOT NULL,      -- event time (when it happened, domain clock)
  recorded_at     TIMESTAMPTZ NOT NULL,      -- processing time (when we learned it, domain clock)
  committed_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),  -- wall clock, for lag and events/sec
  correlation_id  TEXT NOT NULL,             -- one business flow: a pass, a tablet submission, a timer
  causation_id    UUID,                      -- the event that directly caused this one
  actor           TEXT NOT NULL,             -- user name or system component
  tags            TEXT[] NOT NULL DEFAULT '{}',  -- car:<id>, trip:<id>, case:<id>, detector:<id> for cross-stream timelines
  payload         JSONB NOT NULL,
  UNIQUE (stream_id, stream_version)
);
CREATE INDEX IF NOT EXISTS events_tags_idx ON events USING GIN (tags);
CREATE INDEX IF NOT EXISTS events_family_idx ON events (family, global_position);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, global_position);
CREATE INDEX IF NOT EXISTS events_correlation_idx ON events (correlation_id);
CREATE INDEX IF NOT EXISTS events_causation_idx ON events (causation_id);

-- Append-only: history is never edited. Schema changes are new versions plus upcasters.
-- (TRUNCATE, used by the seed to start over, is a statement-level operation and stays allowed.)
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only (% refused)', TG_OP;
END $$;
DROP TRIGGER IF EXISTS events_no_update ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();

-- The relay's position in the log. At-least-once: a crash after publishing but before this
-- update republishes a few events, which every consumer drops by event id.
CREATE TABLE IF NOT EXISTS relay_checkpoint (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_position BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO relay_checkpoint (id, last_position) VALUES (1, 0) ON CONFLICT DO NOTHING;

-- Per consumer group, per broker stream: the highest global position applied and how many.
-- Updated in the same transaction as the consumer's effects.
CREATE TABLE IF NOT EXISTS consumer_checkpoints (
  group_name       TEXT NOT NULL,
  stream_key       TEXT NOT NULL,
  last_position    BIGINT NOT NULL DEFAULT 0,
  last_message_id  TEXT,
  events_handled   BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_name, stream_key)
);

-- Idempotent consumers: an event id is applied at most once per group. The insert happens in the
-- same transaction as the effects, so a redelivery after a crash (before XACK) is a no-op.
CREATE TABLE IF NOT EXISTS processed_events (
  group_name   TEXT NOT NULL,
  event_id     UUID NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_name, event_id)
);

-- ── Write-side indexes for the case aggregate ─────────────────────────────────
-- Set-based invariants span aggregates, so the event store alone can't enforce them. This lookup
-- table is written in the same transaction as the case's events (never by a projector) and gives:
--   * one open alert case per bearing (or per car, for brakes) per trip;
--   * one audit case per arriving trip;
--   * the hold index the yard's outbound-build check reads (a stale "clear" would be unsafe,
--     so that check never reads an asynchronous projection).
CREATE TABLE IF NOT EXISTS case_index (
  case_id        UUID PRIMARY KEY,
  case_type      TEXT NOT NULL CHECK (case_type IN ('alert', 'audit')),
  trip_id        TEXT NOT NULL,
  car_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,
  position       TEXT NOT NULL,
  is_open        BOOLEAN NOT NULL DEFAULT true,
  work_order_id  UUID UNIQUE,
  hold_yard_id   TEXT,
  hold_status    TEXT CHECK (hold_status IN ('active', 'bad_ordered', 'released')),
  version        INT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS case_index_one_open_alert ON case_index (trip_id, car_id, kind, position) WHERE is_open AND case_type = 'alert';
CREATE UNIQUE INDEX IF NOT EXISTS case_index_one_audit ON case_index (trip_id) WHERE case_type = 'audit';
CREATE INDEX IF NOT EXISTS case_index_trip_idx ON case_index (trip_id) WHERE is_open;
CREATE INDEX IF NOT EXISTS case_index_car_idx ON case_index (car_id) WHERE is_open;
CREATE INDEX IF NOT EXISTS case_index_holds_idx ON case_index (car_id) WHERE hold_status IN ('active', 'bad_ordered');

-- ── Process manager: durable timers for acknowledgment deadlines ──────────────
-- Orchestration, not choreography: deadline -> escalate -> (handoff) needs memory and time.
-- due_at is domain time. Pollers claim due rows with FOR UPDATE SKIP LOCKED, so two workers never
-- fire the same timer, and a crash mid-fire leaves the row pending for the next poll.
CREATE TABLE IF NOT EXISTS ack_timers (
  case_id       UUID NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ack_deadline', 'approach_yard')),
  due_at        TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled')),
  level         SMALLINT NOT NULL DEFAULT 0,
  case_version  INT NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  fired_at      TIMESTAMPTZ,
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, kind)
);
CREATE INDEX IF NOT EXISTS ack_timers_due_idx ON ack_timers (due_at) WHERE status = 'pending';

-- The work-order integration's record of what it pushed to the yard maintenance system (simulated).
CREATE TABLE IF NOT EXISTS mro_tickets (
  work_order_id UUID PRIMARY KEY,
  case_id       UUID NOT NULL,
  external_ref  TEXT NOT NULL UNIQUE,
  yard_id       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at     TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ
);

-- ── Projections (read models) ─────────────────────────────────────────────────
-- Every table below is derived from events and can be dropped and rebuilt with
-- `npm run replay -- <projection>`. Projectors write only values found in events (no now(), no
-- random ids), so a rebuild from position 0 produces identical rows. No foreign keys: projections
-- consume several broker streams whose relative order is not guaranteed.

-- alert-queue projection: alerts, car_holds, work_orders, findings, notifications, bearing_trends_latest
CREATE TABLE IF NOT EXISTS alerts (
  id                  UUID PRIMARY KEY,
  trip_id             TEXT NOT NULL,
  car_id              TEXT NOT NULL,
  -- hot_bearing = journal bearing failure; hot_wheel = stuck or dragging brake; cold_wheel = inoperative brake.
  kind                TEXT NOT NULL CHECK (kind IN ('hot_bearing', 'hot_wheel', 'cold_wheel')),
  position            TEXT NOT NULL,       -- car-relative bearing, e.g. 'R3'; 'CAR' for brake (wheel) alerts
  tier                SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 4),
  -- open -> acknowledged (a person owns it) -> inspected (finding recorded) -> closed (repaired or released).
  status              TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'inspected', 'closed')),
  owner_role          TEXT,
  owner_id            TEXT,
  escalation_level    SMALLINT NOT NULL DEFAULT 0,
  ack_due_at          TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  inspected_at        TIMESTAMPTZ,
  action              TEXT NOT NULL,
  routing             TEXT NOT NULL,
  desk_id             TEXT,
  territory_id        TEXT,
  yard_id             TEXT,
  reasons             JSONB NOT NULL DEFAULT '[]',
  features            JSONB NOT NULL DEFAULT '{}',   -- as of the last decision (raise or escalation)
  route_note          TEXT,
  trigger_detector_id TEXT,
  trigger_pass_id     TEXT,
  trigger_passed_at   TIMESTAMPTZ,
  data_lag_seconds    INT NOT NULL DEFAULT 0,
  late                BOOLEAN NOT NULL DEFAULT false,
  opened_at           TIMESTAMPTZ NOT NULL,
  escalated_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL,
  acknowledged_by     TEXT,
  acknowledged_at     TIMESTAMPTZ,
  ack_action          TEXT,
  ack_note            TEXT,
  closed_at           TIMESTAMPTZ,
  outcome             TEXT,
  version             INT NOT NULL,        -- the case stream version this row reflects
  last_position       BIGINT NOT NULL      -- global position of the last case event applied
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_per_bearing ON alerts (trip_id, car_id, kind, position) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS alerts_queue_idx ON alerts (status, tier DESC, opened_at DESC);
CREATE INDEX IF NOT EXISTS alerts_car_idx ON alerts (car_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS car_holds (
  id          UUID PRIMARY KEY,
  car_id      TEXT NOT NULL,
  alert_id    UUID NOT NULL,
  yard_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'bad_ordered', 'released')),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  released_by TEXT
);
CREATE INDEX IF NOT EXISTS car_holds_car_idx ON car_holds (car_id) WHERE status <> 'released';
CREATE INDEX IF NOT EXISTS car_holds_yard_idx ON car_holds (yard_id, status);

-- Alert work orders, plus random audit inspections of unflagged cars (alert_id NULL, kind 'audit').
CREATE TABLE IF NOT EXISTS work_orders (
  id           UUID PRIMARY KEY,
  case_id      UUID NOT NULL,
  alert_id     UUID,                       -- = case_id for alert cases, NULL for audits
  trip_id      TEXT,
  car_id       TEXT NOT NULL,
  position     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  yard_id      TEXT NOT NULL,
  priority     SMALLINT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  assigned_to  TEXT,
  created_at   TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  version      INT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_orders_yard_idx ON work_orders (yard_id, status, priority DESC);

CREATE TABLE IF NOT EXISTS findings (
  id                   UUID PRIMARY KEY,
  client_submission_id TEXT,
  case_id              UUID,
  work_order_id        UUID,
  alert_id             UUID,
  car_id               TEXT NOT NULL,
  position             TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('alert', 'audit', 'routine', 'teardown')),
  finding              TEXT NOT NULL CHECK (finding IN ('confirmed_bearing_defect', 'brake_defect', 'wheel_defect', 'no_defect_found')),
  disposition          TEXT NOT NULL CHECK (disposition IN ('bad_order', 'release', 'repaired')),
  notes                TEXT,
  recorded_by          TEXT NOT NULL,
  observed_at          TIMESTAMPTZ NOT NULL,   -- when the inspector looked (tablet clock, may be offline)
  recorded_at          TIMESTAMPTZ NOT NULL,   -- when the server accepted it
  superseded_by        UUID,                   -- a later, more severe finding from another tablet
  schema_version       SMALLINT NOT NULL       -- version the event was written at (v1 rows were upcast)
);
CREATE INDEX IF NOT EXISTS findings_work_order_idx ON findings (work_order_id);

-- Who was told what. Delivered means the provider accepted it, not that a person read it.
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY,
  alert_id     UUID NOT NULL,
  channel      TEXT NOT NULL,
  target       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_alert_idx ON notifications (alert_id);

-- Latest trend features per bearing per trip (telemetry, not decisions). Last-writer-wins by
-- global position, so it converges whatever order the trends and cases streams are consumed in.
CREATE TABLE IF NOT EXISTS bearing_trends_latest (
  trip_id        TEXT NOT NULL,
  car_id         TEXT NOT NULL,
  position       TEXT NOT NULL,
  features       JSONB NOT NULL,
  tier           SMALLINT NOT NULL,
  passed_at      TIMESTAMPTZ NOT NULL,
  last_position  BIGINT NOT NULL,
  PRIMARY KEY (trip_id, car_id, position)
);

-- car-history projection: component_installs, car_trips
CREATE TABLE IF NOT EXISTS component_installs (
  car_id               TEXT NOT NULL,
  axle                 INT NOT NULL CHECK (axle BETWEEN 1 AND 12),   -- car-relative, 1 = B-end
  component_id         TEXT NOT NULL,      -- wheelset serial
  installed_at         TIMESTAMPTZ NOT NULL,   -- event time
  removed_at           TIMESTAMPTZ,
  recorded_at          TIMESTAMPTZ NOT NULL,   -- processing time
  recorded_by          TEXT NOT NULL,
  finding_id           UUID,
  event_id             UUID NOT NULL,
  PRIMARY KEY (car_id, axle, installed_at)
);

-- Which trips a car ran, where it sat and which way it faced, and how that was learned.
CREATE TABLE IF NOT EXISTS car_trips (
  trip_id               TEXT NOT NULL,
  car_id                TEXT NOT NULL,
  revision              INT NOT NULL,
  position              INT NOT NULL,
  leading_end           CHAR(1) NOT NULL,
  orientation_source    TEXT NOT NULL,
  corrected_by_detector TEXT,
  identified_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (trip_id, car_id)
);

-- detector-health projection
CREATE TABLE IF NOT EXISTS detector_health (
  detector_id      TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'offline', 'silent', 'biased')),
  status_reason    TEXT,
  status_since     TIMESTAMPTZ,
  last_pass_at     TIMESTAMPTZ,
  last_received_at TIMESTAMPTZ,
  passes           INT NOT NULL DEFAULT 0,
  late_passes      INT NOT NULL DEFAULT 0,
  max_lag_seconds  INT NOT NULL DEFAULT 0
);

-- reliability projection: one row per case (alert or audit) and per stand-alone finding.
-- A fact table shaped for the precision/recall queries on the reliability page.
CREATE TABLE IF NOT EXISTS reliability_facts (
  fact_id         UUID PRIMARY KEY,        -- case id, or finding id for routine/teardown findings
  source          TEXT NOT NULL,           -- alert | audit | routine | teardown
  trip_id         TEXT,
  car_id          TEXT NOT NULL,
  alert_kind      TEXT,
  max_tier        SMALLINT,
  opened_at       TIMESTAMPTZ NOT NULL,
  first_ack_at    TIMESTAMPTZ,
  escalations     INT NOT NULL DEFAULT 0,  -- acknowledgment deadlines missed
  finding         TEXT,
  disposition     TEXT,
  status          TEXT NOT NULL,
  outcome         TEXT,
  closed_at       TIMESTAMPTZ
);
