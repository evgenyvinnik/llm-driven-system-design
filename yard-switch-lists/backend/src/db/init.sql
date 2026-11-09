-- Yard Switch Lists schema. Every statement is idempotent, so db:migrate can rerun.
-- All times are TIMESTAMPTZ. Domain times are on the simulated yard clock
-- (yard_state.sim_now); created_at/lease columns use the database's wall clock.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('yardmaster', 'crew', 'admin')),
  password_hash TEXT NOT NULL
);

-- One row per yard. Every solve reads an explicit state_version; every surprise bumps it.
-- Progress that goes as planned does NOT bump it, or no plan could ever be published while crews work.
CREATE TABLE IF NOT EXISTS yard_state (
  yard_id            TEXT PRIMARY KEY,
  shift_id           INT NOT NULL,
  seed               INT NOT NULL,
  state_version      BIGINT NOT NULL DEFAULT 1,
  sim_now            TIMESTAMPTZ NOT NULL,
  head_version_id    UUID,
  working_version_id UUID,
  auto_publish       BOOLEAN NOT NULL DEFAULT TRUE,
  planner_settings   JSONB NOT NULL DEFAULT '{}',
  rules              JSONB NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS yard_state_log (
  version    BIGINT PRIMARY KEY,
  shift_id   INT NOT NULL,
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  actor      TEXT NOT NULL,
  sim_at     TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id         INT PRIMARY KEY,
  seed       INT NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  summary    JSONB,
  closed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tracks (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('receiving', 'classification', 'departure')),
  capacity_ft    INT NOT NULL CHECK (capacity_ft > 0),
  is_open        BOOLEAN NOT NULL DEFAULT TRUE,
  blocked_reason TEXT,
  blocked_by     TEXT,
  blocked_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS blocks (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  destination         TEXT NOT NULL,
  standing_track_id   TEXT NOT NULL REFERENCES tracks(id),
  alternate_track_ids TEXT[] NOT NULL DEFAULT '{}',
  -- Tracks a yardmaster has knowingly added to the standing order this shift (each has an overrides row).
  override_track_ids  TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS inbound_trains (
  id                 TEXT PRIMARY KEY,
  shift_id           INT NOT NULL,
  symbol             TEXT NOT NULL,
  scheduled_arrival  TIMESTAMPTZ NOT NULL,
  eta                TIMESTAMPTZ NOT NULL,
  actual_arrival     TIMESTAMPTZ,
  receiving_track_id TEXT REFERENCES tracks(id)
);
CREATE INDEX IF NOT EXISTS inbound_shift_idx ON inbound_trains (shift_id, eta);

CREATE TABLE IF NOT EXISTS outbound_trains (
  id                  TEXT PRIMARY KEY,
  shift_id            INT NOT NULL,
  symbol              TEXT NOT NULL,
  scheduled_departure TIMESTAMPTZ NOT NULL,
  revised_departure   TIMESTAMPTZ,
  block_sequence      TEXT[] NOT NULL,
  max_length_ft       INT NOT NULL,
  max_tons            INT NOT NULL,
  min_cars            INT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'departed', 'missed')),
  actual_departure    TIMESTAMPTZ,
  departure_track_id  TEXT,
  car_count           INT,
  note                TEXT
);
CREATE INDEX IF NOT EXISTS outbound_shift_idx ON outbound_trains (shift_id, scheduled_departure);

-- Actual yard state. Only crew reports, arrivals and departures write position columns; a plan never does.
CREATE TABLE IF NOT EXISTS cars (
  id             TEXT PRIMARY KEY,
  shift_id       INT NOT NULL,
  length_ft      INT NOT NULL CHECK (length_ft > 0),
  tons           INT NOT NULL CHECK (tons > 0),
  block_id       TEXT NOT NULL REFERENCES blocks(id),
  hazmat_class   TEXT,
  inbound_id     TEXT REFERENCES inbound_trains(id),
  consist_pos    INT NOT NULL DEFAULT 0,
  position       TEXT NOT NULL CHECK (position IN ('inbound', 'on_track', 'unknown', 'departed')),
  track_id       TEXT REFERENCES tracks(id),
  coupled_to     TEXT REFERENCES outbound_trains(id),
  coupled_seq    BIGINT,
  arrived_at     TIMESTAMPTZ,
  departed_at    TIMESTAMPTZ,
  departed_on    TEXT REFERENCES outbound_trains(id),
  -- Event-time watermark of the last report that moved this car, so reports synced out of order can't move it backwards.
  position_as_of TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cars_track_idx ON cars (track_id) WHERE position = 'on_track';
CREATE INDEX IF NOT EXISTS cars_inbound_idx ON cars (inbound_id);
CREATE INDEX IF NOT EXISTS cars_departed_idx ON cars (departed_on);

-- Immutable plan versions: draft -> published -> superseded, or draft -> superseded when discarded.
CREATE TABLE IF NOT EXISTS switch_lists (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id               INT NOT NULL,
  version_no             INT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  parent_id              UUID REFERENCES switch_lists(id),
  author_kind            TEXT NOT NULL CHECK (author_kind IN ('planner', 'person')),
  author_name            TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  based_on_state_version BIGINT NOT NULL,
  solve_id               UUID,
  objective              JSONB NOT NULL DEFAULT '{}',
  validation             JSONB NOT NULL DEFAULT '{}',
  conflicts              JSONB NOT NULL DEFAULT '[]',
  consequences           JSONB NOT NULL DEFAULT '[]',
  stability              JSONB,
  review_required        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at           TIMESTAMPTZ,
  published_by           TEXT,
  superseded_at          TIMESTAMPTZ,
  UNIQUE (shift_id, version_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS switch_lists_one_published ON switch_lists (shift_id) WHERE status = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS switch_lists_one_per_solve ON switch_lists (solve_id) WHERE solve_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS moves (
  list_id       UUID NOT NULL REFERENCES switch_lists(id),
  seq           INT NOT NULL,
  key           TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('receive', 'classify', 'assemble', 'setout')),
  crew          TEXT NOT NULL CHECK (crew IN ('road', 'hump', 'trim')),
  car_ids       TEXT[] NOT NULL,
  from_track_id TEXT,
  to_track_id   TEXT NOT NULL,
  block_id      TEXT,
  inbound_id    TEXT,
  outbound_id   TEXT,
  planned_start TIMESTAMPTZ NOT NULL,
  planned_end   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, seq),
  UNIQUE (list_id, key)
);

CREATE OR REPLACE FUNCTION refuse_move_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'moves are immutable: a change is a new switch list version';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS moves_immutable ON moves;
CREATE TRIGGER moves_immutable BEFORE UPDATE OR DELETE ON moves FOR EACH ROW EXECUTE FUNCTION refuse_move_change();

CREATE OR REPLACE FUNCTION guard_switch_list() RETURNS trigger AS $$
BEGIN
  IF NEW.shift_id <> OLD.shift_id OR NEW.version_no <> OLD.version_no OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.author_kind <> OLD.author_kind OR NEW.author_name <> OLD.author_name OR NEW.reason <> OLD.reason
     OR NEW.based_on_state_version <> OLD.based_on_state_version OR NEW.solve_id IS DISTINCT FROM OLD.solve_id
     OR NEW.objective <> OLD.objective OR NEW.consequences <> OLD.consequences OR NEW.conflicts <> OLD.conflicts THEN
    RAISE EXCEPTION 'a switch list version is immutable; only its status moves forward';
  END IF;
  IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'draft' AND NEW.status IN ('published', 'superseded')) OR (OLD.status = 'published' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'illegal switch list transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS switch_lists_guard ON switch_lists;
CREATE TRIGGER switch_lists_guard BEFORE UPDATE ON switch_lists FOR EACH ROW EXECUTE FUNCTION guard_switch_list();

-- What actually happened to each move, keyed by its stable key so it survives new plan versions.
CREATE TABLE IF NOT EXISTS move_executions (
  shift_id     INT NOT NULL,
  key          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  crew_name    TEXT,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  move         JSONB,
  deviated     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shift_id, key)
);

-- The idempotency ledger for handheld reports. The primary key is generated by the client, so a retry or a late sync collides.
CREATE TABLE IF NOT EXISTS crew_reports (
  client_report_id    TEXT PRIMARY KEY,
  shift_id            INT NOT NULL,
  move_key            TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('start', 'complete', 'exception')),
  exception_type      TEXT,
  payload             JSONB NOT NULL DEFAULT '{}',
  reporter            TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  offline             BOOLEAN NOT NULL DEFAULT FALSE,
  outcome             TEXT NOT NULL,
  mismatch            BOOLEAN NOT NULL DEFAULT FALSE,
  response            JSONB NOT NULL DEFAULT '{}',
  state_version_after BIGINT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crew_reports_shift_idx ON crew_reports (shift_id, received_at DESC);

-- One row per car per physical handling: the raw material of "moves per car".
CREATE TABLE IF NOT EXISTS car_handlings (
  id        BIGSERIAL PRIMARY KEY,
  shift_id  INT NOT NULL,
  car_id    TEXT NOT NULL,
  move_key  TEXT NOT NULL,
  kind      TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  UNIQUE (shift_id, car_id, move_key)
);

-- Track-over-capacity observations from what crews reported, not from what the plan said.
CREATE TABLE IF NOT EXISTS capacity_events (
  id        BIGSERIAL PRIMARY KEY,
  shift_id  INT NOT NULL,
  track_id  TEXT NOT NULL,
  over_ft   INT NOT NULL,
  move_key  TEXT,
  at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id      INT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('move', 'car_track', 'sequence')),
  move_key      TEXT,
  before_key    TEXT,
  car_id        TEXT,
  track_id      TEXT,
  move          JSONB,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by   TEXT,
  released_reason TEXT,
  released_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS locks_active_idx ON locks (shift_id) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS locks_one_move ON locks (shift_id, move_key) WHERE active AND kind = 'move';
CREATE UNIQUE INDEX IF NOT EXISTS locks_one_car ON locks (shift_id, car_id) WHERE active AND kind = 'car_track';

-- Every human decision against the plan: who, why, before and after. Refused attempts are kept too.
CREATE TABLE IF NOT EXISTS overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id        INT NOT NULL,
  kind            TEXT NOT NULL,
  actor           TEXT NOT NULL,
  reason          TEXT NOT NULL,
  reason_code     TEXT NOT NULL,
  before          JSONB,
  after           JSONB,
  violations      JSONB NOT NULL DEFAULT '[]',
  refused         BOOLEAN NOT NULL DEFAULT FALSE,
  from_version_no INT,
  to_version_no   INT,
  sim_at          TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS overrides_shift_idx ON overrides (shift_id, created_at DESC);

-- The durable job. A solve is a row before anything computes it, and a crash leaves a row to reclaim.
CREATE TABLE IF NOT EXISTS solve_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id            INT NOT NULL,
  lane                TEXT NOT NULL DEFAULT 'plan' CHECK (lane IN ('plan', 'analysis')),
  purpose             TEXT NOT NULL CHECK (purpose IN ('initial', 'replan', 'manual', 'compare', 'replay')),
  algorithm           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  reason              TEXT NOT NULL DEFAULT '',
  time_limit_ms       INT NOT NULL,
  iteration_limit     INT NOT NULL,
  seed                INT NOT NULL,
  params              JSONB NOT NULL DEFAULT '{}',
  state_version       BIGINT,
  baseline_version_id UUID,
  trigger_count       INT NOT NULL DEFAULT 0,
  attempts            INT NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_token         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  queued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  result_version_id   UUID,
  stats               JSONB,
  snapshot            JSONB,
  error               TEXT
);
CREATE INDEX IF NOT EXISTS solve_jobs_claim_idx ON solve_jobs (lane, queued_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS replan_triggers (
  id            BIGSERIAL PRIMARY KEY,
  shift_id      INT NOT NULL,
  kind          TEXT NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}',
  state_version BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  solve_id      UUID
);
CREATE INDEX IF NOT EXISTS replan_triggers_open_idx ON replan_triggers (created_at) WHERE solve_id IS NULL;

-- Hold feed: same envelope as railcar-health/events.md. event_id dedupes redelivery.
CREATE TABLE IF NOT EXISTS hold_events (
  event_id       TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  version        INT NOT NULL,
  stream_id      TEXT NOT NULL,
  stream_version BIGINT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  hold_id        TEXT,
  car_id         TEXT,
  envelope       JSONB NOT NULL,
  outcome        TEXT NOT NULL,
  via            TEXT NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hold_events_received_idx ON hold_events (received_at DESC);

-- The fold: one register per hold, last writer by stream_version, so delivery order doesn't matter.
CREATE TABLE IF NOT EXISTS car_holds (
  hold_id        TEXT PRIMARY KEY,
  car_id         TEXT NOT NULL,
  yard_id        TEXT,
  status         TEXT NOT NULL CHECK (status IN ('active', 'bad_ordered', 'released', 'moved_away')),
  reason         TEXT,
  stream_id      TEXT NOT NULL,
  stream_version BIGINT NOT NULL,
  placed_at      TIMESTAMPTZ,
  released_at    TIMESTAMPTZ,
  released_by    TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS car_holds_car_idx ON car_holds (car_id);

CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key   TEXT NOT NULL UNIQUE,
  shift_id    INT NOT NULL,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  message     TEXT NOT NULL,
  car_id      TEXT,
  outbound_id TEXT,
  move_key    TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  sim_at      TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_by    TEXT,
  acked_at    TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alerts_open_idx ON alerts (status, created_at DESC);

-- Planner comparison: heuristic vs local search vs exact.
CREATE TABLE IF NOT EXISTS comparison_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solve_job_id UUID,
  status       TEXT NOT NULL DEFAULT 'running',
  params       JSONB NOT NULL DEFAULT '{}',
  summary      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS comparison_rows (
  run_id         UUID NOT NULL REFERENCES comparison_runs(id) ON DELETE CASCADE,
  instance       TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('small', 'full')),
  algorithm      TEXT NOT NULL,
  time_limit_ms  INT NOT NULL,
  cost           DOUBLE PRECISION NOT NULL,
  elapsed_ms     INT NOT NULL,
  iterations     INT NOT NULL,
  terminated_by  TEXT NOT NULL,
  proven_optimal BOOLEAN,
  gap_pct        DOUBLE PRECISION,
  valid          BOOLEAN NOT NULL,
  moves          INT NOT NULL,
  PRIMARY KEY (run_id, instance, algorithm, time_limit_ms)
);

-- Seeded replay under three policies, kept as raw rows so the summary can be recomputed by anyone.
CREATE TABLE IF NOT EXISTS replay_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solve_job_id UUID,
  status       TEXT NOT NULL DEFAULT 'running',
  params       JSONB NOT NULL DEFAULT '{}',
  summary      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS replay_departures (
  run_id    UUID NOT NULL REFERENCES replay_runs(id) ON DELETE CASCADE,
  seed      INT NOT NULL,
  policy    TEXT NOT NULL,
  outbound_id TEXT NOT NULL,
  symbol    TEXT NOT NULL,
  scheduled TIMESTAMPTZ NOT NULL,
  actual    TIMESTAMPTZ,
  cars      INT NOT NULL,
  status    TEXT NOT NULL,
  on_time   BOOLEAN NOT NULL,
  PRIMARY KEY (run_id, seed, policy, outbound_id)
);
CREATE TABLE IF NOT EXISTS replay_cars (
  run_id     UUID NOT NULL REFERENCES replay_runs(id) ON DELETE CASCADE,
  seed       INT NOT NULL,
  policy     TEXT NOT NULL,
  car_id     TEXT NOT NULL,
  arrived_at TIMESTAMPTZ,
  departed_at TIMESTAMPTZ,
  handlings  INT NOT NULL,
  PRIMARY KEY (run_id, seed, policy, car_id)
);
CREATE TABLE IF NOT EXISTS replay_events (
  run_id   UUID NOT NULL REFERENCES replay_runs(id) ON DELETE CASCADE,
  seed     INT NOT NULL,
  policy   TEXT NOT NULL,
  n        INT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('override', 'capacity', 'replan')),
  at       TIMESTAMPTZ NOT NULL,
  code     TEXT,
  value    DOUBLE PRECISION,
  detail   TEXT,
  PRIMARY KEY (run_id, seed, policy, n)
);
