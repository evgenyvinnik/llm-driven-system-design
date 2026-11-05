-- Railcar health monitoring schema. Every statement is idempotent: migrate.ts reruns it safely.
-- Domain timestamps (passed_at, received_at, opened_at...) are in the domain clock, which the
-- simulator compresses; operational timestamps (inserted_at, processed_at) are database now().

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

-- One row per wayside site. Health columns are maintained by the analyzer.
CREATE TABLE IF NOT EXISTS detectors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  milepost        NUMERIC(6,2) NOT NULL,
  subdivision_id  TEXT NOT NULL REFERENCES subdivisions(id),
  has_aei         BOOLEAN NOT NULL DEFAULT false,
  braking_zone    BOOLEAN NOT NULL DEFAULT false,
  gateway_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'offline', 'silent', 'biased')),
  status_reason   TEXT,
  status_since    TIMESTAMPTZ,
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

-- ── Raw detector data (production: a time-series store) ──────────────────────

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
  published_at     TIMESTAMPTZ,            -- set once the stream message is written
  processed_at     TIMESTAMPTZ,            -- set in the analyzer's transaction
  PRIMARY KEY (detector_id, pass_id)
);
CREATE INDEX IF NOT EXISTS detector_passes_trip_idx ON detector_passes (trip_id, passed_at);
CREATE INDEX IF NOT EXISTS detector_passes_unpublished_idx ON detector_passes (inserted_at) WHERE published_at IS NULL;

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

-- ── Alerts, holds, work orders, findings ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS alerts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id             TEXT NOT NULL REFERENCES trips(trip_id),
  car_id              TEXT NOT NULL,
  -- hot_bearing = journal bearing failure; hot_wheel = stuck or dragging brake; cold_wheel = inoperative brake.
  kind                TEXT NOT NULL CHECK (kind IN ('hot_bearing', 'hot_wheel', 'cold_wheel')),
  position            TEXT NOT NULL,       -- car-relative bearing, e.g. 'R3'; 'CAR' for brake (wheel) alerts
  tier                SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 4),
  -- open -> acknowledged (a person owns it) -> inspected (finding recorded) -> closed (car repaired or released).
  -- Delivery (the notification provider accepted the message) is tracked separately in delivered_at.
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'inspected', 'closed')),
  owner_role          TEXT,                -- dispatcher | yard | owner
  owner_id            TEXT,                -- desk id, yard id or owner mark
  escalation_level    SMALLINT NOT NULL DEFAULT 0,  -- 0 primary owner, 1 supervisor, 2 operations center
  ack_due_at          TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  inspected_at        TIMESTAMPTZ,
  action              TEXT NOT NULL,
  routing             TEXT NOT NULL,
  desk_id             TEXT REFERENCES dispatcher_desks(id),
  territory_id        TEXT REFERENCES subdivisions(id),
  yard_id             TEXT REFERENCES yards(id),
  reasons             JSONB NOT NULL DEFAULT '[]',
  features            JSONB NOT NULL DEFAULT '{}',
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
  version             INT NOT NULL DEFAULT 1
);
-- One open alert per bearing per trip: new evidence escalates it in place instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_per_bearing
  ON alerts (trip_id, car_id, kind, position) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS alerts_queue_idx ON alerts (status, tier DESC, opened_at DESC);
CREATE INDEX IF NOT EXISTS alerts_ack_due_idx ON alerts (ack_due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS alerts_car_idx ON alerts (car_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS alert_events (
  id          BIGSERIAL PRIMARY KEY,
  alert_id    UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,              -- opened, escalated, delivered, acknowledged, ack_overdue, handoff, rerouted, inspected, closed
  tier        SMALLINT,
  detector_id TEXT,
  pass_id     TEXT,
  note        TEXT,
  actor       TEXT NOT NULL DEFAULT 'analyzer',
  at          TIMESTAMPTZ NOT NULL
);
-- Redelivery backstop: the same transition from the same pass is recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS alert_events_dedupe
  ON alert_events (alert_id, kind, COALESCE(tier, 0), COALESCE(pass_id, ''));

-- A hold stops the yard from building the car into an outbound train until it is inspected.
CREATE TABLE IF NOT EXISTS car_holds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id      TEXT NOT NULL,
  alert_id    UUID NOT NULL UNIQUE REFERENCES alerts(id),
  yard_id     TEXT NOT NULL REFERENCES yards(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'bad_ordered', 'released')),
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  released_by TEXT
);
CREATE INDEX IF NOT EXISTS car_holds_car_idx ON car_holds (car_id) WHERE status <> 'released';

-- Alert work orders, plus random audit inspections of unflagged cars (alert_id NULL, kind 'audit'):
-- audits are how the system learns what it misses, since otherwise only flagged cars get inspected.
CREATE TABLE IF NOT EXISTS work_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id     UUID UNIQUE REFERENCES alerts(id),
  trip_id      TEXT,
  audit_key    TEXT UNIQUE,                -- one audit per arriving trip
  car_id       TEXT NOT NULL,
  position     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  yard_id      TEXT NOT NULL REFERENCES yards(id),
  priority     SMALLINT NOT NULL,          -- mirrors the alert tier; 0 for audits
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  assigned_to  TEXT,
  created_at   TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  version      INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS work_orders_yard_idx ON work_orders (yard_id, status, priority DESC);

-- Inspection outcomes: the labels that measure precision and drive threshold calibration.
CREATE TABLE IF NOT EXISTS findings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_submission_id TEXT NOT NULL UNIQUE,   -- the tablet's idempotency key
  work_order_id        UUID UNIQUE REFERENCES work_orders(id),
  alert_id             UUID REFERENCES alerts(id),
  car_id               TEXT NOT NULL,
  position             TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT 'alert' CHECK (source IN ('alert', 'audit', 'routine', 'teardown')),
  finding              TEXT NOT NULL CHECK (finding IN ('confirmed_bearing_defect', 'brake_defect', 'wheel_defect', 'no_defect_found')),
  disposition          TEXT NOT NULL CHECK (disposition IN ('bad_order', 'release', 'repaired')),
  notes                TEXT,
  recorded_by          TEXT NOT NULL,
  observed_at          TIMESTAMPTZ NOT NULL,   -- when the inspector looked (tablet clock, may be offline)
  recorded_at          TIMESTAMPTZ NOT NULL    -- when the server accepted it
);

-- Notification outbox: who was told what. Production fans these out to dispatcher consoles,
-- yard mechanical systems and car owners (the industry's EHMS-style alert routing).
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  alert_id   UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('dispatcher', 'yard', 'car_owner', 'reliability', 'supervisor', 'operations')),
  target     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ                 -- the provider accepted it; says nothing about a person reading it
);
CREATE INDEX IF NOT EXISTS notifications_alert_idx ON notifications (alert_id);
CREATE INDEX IF NOT EXISTS notifications_undelivered_idx ON notifications (created_at) WHERE delivered_at IS NULL;

-- ── Component lifecycle ───────────────────────────────────────────────────────

-- A railcar outlives its wheelsets: a wheelset (axle, two wheels, two journal bearings) is changed out
-- at a repair track. Installs are events with an event time (installed_at) and a processing time
-- (recorded_at); the component on an axle at any instant is rebuilt from them. Readings measured
-- before installed_at belong to the previous wheelset and are never evidence against this one.
CREATE TABLE IF NOT EXISTS component_installs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id               TEXT NOT NULL,
  axle                 INT NOT NULL CHECK (axle BETWEEN 1 AND 12),   -- car-relative, 1 = B-end
  component_id         TEXT NOT NULL,      -- wheelset serial
  installed_at         TIMESTAMPTZ NOT NULL,
  removed_at           TIMESTAMPTZ,
  recorded_at          TIMESTAMPTZ NOT NULL,
  recorded_by          TEXT NOT NULL,
  finding_id           UUID REFERENCES findings(id),
  client_submission_id TEXT UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS component_installs_current ON component_installs (car_id, axle) WHERE removed_at IS NULL;
