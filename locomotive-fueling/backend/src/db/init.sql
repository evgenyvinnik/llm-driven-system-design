-- Locomotive fueling schema. Every statement is idempotent so migrate can rerun.
-- Production splits telemetry into a time-series store (TimescaleDB hypertable or
-- Cassandra); locally it is a plain PostgreSQL table with the same keys.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('fuel_desk', 'crew', 'admin')),
  train_id      TEXT,                       -- crew only: the train they may see
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Network ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  state TEXT NOT NULL,
  lat   DOUBLE PRECISION NOT NULL,
  lon   DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  a               TEXT NOT NULL REFERENCES locations(id),
  b               TEXT NOT NULL REFERENCES locations(id),
  miles           DOUBLE PRECISION NOT NULL CHECK (miles > 0),
  rise_ab         DOUBLE PRECISION NOT NULL,   -- feet climbed going a -> b
  rise_ba         DOUBLE PRECISION NOT NULL,
  curve_lb_per_ton DOUBLE PRECISION NOT NULL DEFAULT 0,
  speed_mph       DOUBLE PRECISION NOT NULL,
  dark            BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS routes (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT[] NOT NULL
);

CREATE TABLE IF NOT EXISTS fuel_options (
  id              TEXT PRIMARY KEY,
  location_id     TEXT NOT NULL REFERENCES locations(id),
  kind            TEXT NOT NULL CHECK (kind IN ('pad', 'dtl')),
  vendor          TEXT NOT NULL,
  price_per_gal   NUMERIC(6,3) NOT NULL CHECK (price_per_gal > 0),
  fee             NUMERIC(8,2) NOT NULL DEFAULT 0,
  setup_minutes   INTEGER NOT NULL,
  pump_gpm        INTEGER NOT NULL CHECK (pump_gpm > 0),
  lead_time_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  cancel_fee      NUMERIC(8,2) NOT NULL DEFAULT 0,
  bays            INTEGER NOT NULL DEFAULT 2 CHECK (bays > 0),   -- trains that can fuel at once
  active          BOOLEAN NOT NULL DEFAULT true,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fuel_options_location ON fuel_options(location_id);

-- Append-only price history: who changed what, and the simulated time it took effect.
CREATE TABLE IF NOT EXISTS fuel_price_history (
  id            BIGSERIAL PRIMARY KEY,
  option_id     TEXT NOT NULL REFERENCES fuel_options(id),
  price_per_gal NUMERIC(6,3) NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL,
  changed_by    TEXT NOT NULL,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_history_option ON fuel_price_history(option_id, effective_at DESC);

-- ── Fleet ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locomotives (
  id            TEXT PRIMARY KEY,           -- road number
  model         TEXT NOT NULL,
  horsepower    INTEGER NOT NULL,
  tank_gal      INTEGER NOT NULL,
  model_factor  DOUBLE PRECISION NOT NULL DEFAULT 1
);

-- One row per train run (symbol + trip). path is copied from the route and rewritten on a reroute.
CREATE TABLE IF NOT EXISTS trains (
  id            TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,
  route_id      TEXT NOT NULL REFERENCES routes(id),
  path          TEXT[] NOT NULL,
  planned_tons  INTEGER NOT NULL CHECK (planned_tons > 0),
  cars          INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'arrived')),
  departed_at   TIMESTAMPTZ NOT NULL,
  arrived_at    TIMESTAMPTZ,
  last_milepost DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_location TEXT,
  path_version  INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trains_status ON trains(status);

CREATE TABLE IF NOT EXISTS consist_units (
  train_id      TEXT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  locomotive_id TEXT NOT NULL REFERENCES locomotives(id),
  position      INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('lead', 'trailing', 'dp')),
  online        BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (train_id, locomotive_id)
);
CREATE INDEX IF NOT EXISTS idx_consist_loco ON consist_units(locomotive_id);

-- ── Telemetry history ───────────────────────────────────────────────────────
-- (locomotive_id, seq) is the natural key: a re-sent reading collides and is dropped.
CREATE TABLE IF NOT EXISTS telemetry (
  locomotive_id TEXT NOT NULL,
  seq           BIGINT NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  train_id      TEXT,
  milepost      DOUBLE PRECISION,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  speed_mph     DOUBLE PRECISION,
  notch         SMALLINT,
  engine_state  TEXT,
  fuel_raw      DOUBLE PRECISION,
  fuel_smoothed DOUBLE PRECISION,             -- NULL for late readings, which never rewind the filter
  late          BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (locomotive_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_loco_time ON telemetry(locomotive_id, recorded_at DESC);

-- Fueling detected from telemetry (level rising while stationary). Matched to tickets.
CREATE TABLE IF NOT EXISTS fueling_events (
  id              BIGSERIAL PRIMARY KEY,
  locomotive_id   TEXT NOT NULL,
  train_id        TEXT,
  location_id     TEXT,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  level_before    DOUBLE PRECISION NOT NULL,
  level_after     DOUBLE PRECISION NOT NULL,
  gallons_observed DOUBLE PRECISION NOT NULL,
  ticket_id       TEXT,
  UNIQUE (locomotive_id, started_at)
);

-- ── Plans ───────────────────────────────────────────────────────────────────
-- A plan version is immutable: the stops and per-unit targets the crew was told.
-- lifecycle: recommended (in force, reserves nothing) -> accepted (fuel desk or crew; stops reserve
-- pad slots and DTL trucks) -> superseded. A cheaper plan found after acceptance is stored as
-- 'proposed' (not in force) until the fuel desk confirms or rejects it.
CREATE TABLE IF NOT EXISTS fuel_plans (
  id              BIGSERIAL PRIMARY KEY,
  train_id        TEXT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  is_current      BOOLEAN NOT NULL DEFAULT true,
  lifecycle       TEXT NOT NULL DEFAULT 'recommended' CHECK (lifecycle IN ('recommended', 'accepted', 'proposed', 'superseded', 'rejected')),
  accepted_by     TEXT,
  accepted_at     TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'dp' CHECK (source IN ('dp', 'greedy_fallback', 'last_good')),
  confidence      TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'medium', 'low')),
  assumptions     JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL CHECK (status IN ('ok', 'emergency', 'infeasible')),
  trigger         TEXT NOT NULL,
  reason          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,      -- simulated time
  milepost        DOUBLE PRECISION NOT NULL,
  cost_total      NUMERIC(12,2) NOT NULL,
  cost_breakdown  JSONB NOT NULL,
  greedy_cost     NUMERIC(12,2),
  greedy_stops    TEXT,
  inputs          JSONB NOT NULL,            -- snapshot: fuel per unit, shares, calibration, prices
  profile         JSONB NOT NULL,
  calibration     DOUBLE PRECISION NOT NULL DEFAULT 1,
  UNIQUE (train_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_plans_current ON fuel_plans(train_id) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_plans_proposed ON fuel_plans(train_id) WHERE lifecycle = 'proposed';

CREATE TABLE IF NOT EXISTS plan_stops (
  plan_id       BIGINT NOT NULL REFERENCES fuel_plans(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  stop_key      TEXT NOT NULL,               -- train:location:option; also the DTL idempotency key
  location_id   TEXT NOT NULL REFERENCES locations(id),
  option_id     TEXT NOT NULL REFERENCES fuel_options(id),
  kind          TEXT NOT NULL,
  milepost      DOUBLE PRECISION NOT NULL,
  eta           TIMESTAMPTZ NOT NULL,
  gallons       DOUBLE PRECISION NOT NULL,
  per_unit      JSONB NOT NULL,              -- [{locomotiveId, arrivalGal, targetGal, gallons}]
  price_per_gal NUMERIC(6,3) NOT NULL,
  fuel_cost     NUMERIC(12,2) NOT NULL,
  fee           NUMERIC(8,2) NOT NULL,
  delay_cost    NUMERIC(10,2) NOT NULL,
  dwell_minutes DOUBLE PRECISION NOT NULL,
  committed     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (plan_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_plan_stops_key ON plan_stops(stop_key);

-- Stops of an accepted plan: the only things that reserve capacity. A pad stop holds a bay for
-- its slot window; the reservation expires if the train has not arrived by expires_at.
-- accepted -> executing (train on site) -> fueled | cancelled | expired
CREATE TABLE IF NOT EXISTS stop_commitments (
  stop_key      TEXT PRIMARY KEY,
  train_id      TEXT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES locations(id),
  option_id     TEXT NOT NULL REFERENCES fuel_options(id),
  plan_version  INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('accepted', 'executing', 'fueled', 'cancelled', 'expired')),
  slot_start    TIMESTAMPTZ NOT NULL,          -- simulated time
  slot_end      TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_by   TEXT NOT NULL,
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commitments_option ON stop_commitments(option_id, state, slot_start);
CREATE INDEX IF NOT EXISTS idx_commitments_train ON stop_commitments(train_id, state);

-- Every planner run, including the ones that kept the current plan, and why.
CREATE TABLE IF NOT EXISTS plan_evaluations (
  id                BIGSERIAL PRIMARY KEY,
  train_id          TEXT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  evaluated_at      TIMESTAMPTZ NOT NULL,     -- simulated time
  trigger           TEXT NOT NULL,
  trigger_detail    TEXT,
  decision          TEXT NOT NULL,
  current_version   INTEGER,
  resulting_version INTEGER NOT NULL,
  incumbent_cost    NUMERIC(12,2),
  candidate_cost    NUMERIC(12,2) NOT NULL,
  candidate_stops   TEXT NOT NULL,
  explanation       TEXT NOT NULL,
  projection        JSONB NOT NULL,           -- expected fuel profile of the plan in force
  duration_ms       DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_evals_train ON plan_evaluations(train_id, id DESC);

-- ── DTL vendor orders ───────────────────────────────────────────────────────
-- stop_key is the idempotency key sent to the vendor: one order per train trip per stop.
CREATE TABLE IF NOT EXISTS dtl_orders (
  id                BIGSERIAL PRIMARY KEY,
  stop_key          TEXT NOT NULL UNIQUE,
  train_id          TEXT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  location_id       TEXT NOT NULL REFERENCES locations(id),
  option_id         TEXT NOT NULL REFERENCES fuel_options(id),
  plan_version      INTEGER NOT NULL,
  gallons_requested DOUBLE PRECISION NOT NULL,
  per_unit          JSONB NOT NULL,
  eta               TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
                      'pending', 'unknown', 'confirmed', 'rejected', 'failed',
                      'cancel_requested', 'cancelled', 'delivered', 'reconciled', 'discrepancy')),
  vendor_order_id   TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),   -- wall clock
  lease_until       TIMESTAMPTZ,                          -- wall clock
  last_error        TEXT,
  cancel_fee        NUMERIC(8,2),
  gallons_delivered DOUBLE PRECISION,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dtl_orders_due ON dtl_orders(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_dtl_orders_train ON dtl_orders(train_id);

CREATE TABLE IF NOT EXISTS dtl_order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES dtl_orders(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON dtl_order_events(order_id, id);

-- Fuel tickets from pads and DTL vendors. ticket id is the source's id: a re-sent webhook collides.
CREATE TABLE IF NOT EXISTS fuel_tickets (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('pad', 'vendor')),
  order_id          BIGINT REFERENCES dtl_orders(id),
  stop_key          TEXT,
  train_id          TEXT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  location_id       TEXT NOT NULL REFERENCES locations(id),
  option_id         TEXT NOT NULL REFERENCES fuel_options(id),
  delivered_at      TIMESTAMPTZ NOT NULL,
  gallons_total     DOUBLE PRECISION NOT NULL,
  per_unit          JSONB NOT NULL,            -- [{locomotiveId, gallons}]
  price_per_gal     NUMERIC(6,3) NOT NULL,
  fee               NUMERIC(8,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'discrepancy', 'unverified')),
  telemetry_gallons DOUBLE PRECISION,
  discrepancy_gal   DOUBLE PRECISION,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON fuel_tickets(status);

-- ── Alerts ──────────────────────────────────────────────────────────────────
-- dedup_key keeps one open alert per (type, subject); redelivered readings don't duplicate alerts.
CREATE TABLE IF NOT EXISTS alerts (
  id              BIGSERIAL PRIMARY KEY,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  train_id        TEXT,
  locomotive_id   TEXT,
  message         TEXT NOT NULL,
  dedup_key       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  raised_at       TIMESTAMPTZ NOT NULL,          -- simulated time
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  details         JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open ON alerts(dedup_key) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_alerts_train ON alerts(train_id, status);

-- ── Parameters ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_params (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
