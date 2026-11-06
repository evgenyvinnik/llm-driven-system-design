-- Freight quote service schema. Every statement is idempotent (npm run db:migrate reruns it).

-- ─── Reference data ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  api_key_hash        TEXT UNIQUE,
  -- Callbacks go only to the URL registered here, never to a URL in a request (no SSRF via quotes).
  webhook_url         TEXT,
  webhook_secret      TEXT,
  rate_limit_per_min  INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('customer', 'ops', 'admin')),
  customer_id    TEXT REFERENCES customers(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'customer') = (customer_id IS NOT NULL))
);

-- Contract references replicated from the pricing system. The quote service needs the contract id
-- before it calls pricing, to build a cache key that can never cross customers.
CREATE TABLE IF NOT EXISTS contracts (
  id           TEXT NOT NULL,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  version      INT NOT NULL,
  origin       TEXT NOT NULL,
  destination  TEXT NOT NULL,
  commodity    TEXT NOT NULL,
  equipment    TEXT NOT NULL,
  PRIMARY KEY (id, origin, destination, commodity, equipment)
);
CREATE INDEX IF NOT EXISTS contracts_customer_lane ON contracts (customer_id, origin, destination, commodity, equipment);

-- ─── Quotes (source of truth for quote state) ─────────────────────────────
CREATE TABLE IF NOT EXISTS quotes (
  id               UUID PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  client_class     TEXT NOT NULL CHECK (client_class IN ('portal', 'api', 'api_requote')),
  origin           TEXT NOT NULL,
  destination      TEXT NOT NULL,
  commodity        TEXT NOT NULL,
  equipment        TEXT NOT NULL,
  quantity         INT NOT NULL CHECK (quantity > 0),
  ship_week        DATE NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('firm', 'indicative')),
  firm_status      TEXT NOT NULL CHECK (firm_status IN ('not_needed', 'pending', 'completed', 'delayed')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'expired')),
  revision         INT NOT NULL DEFAULT 1,
  total_cents      BIGINT NOT NULL,
  band_low_cents   BIGINT NOT NULL,
  band_high_cents  BIGINT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  -- Exactly the inputs this revision used: tariff/contract version, fuel surcharge date, snapshots, rules version.
  inputs           JSONB NOT NULL,
  components       JSONB NOT NULL,
  -- The first (indicative) answer, kept when the quote turns firm, for disputes and analytics.
  indicative_snapshot JSONB,
  valid_until      TIMESTAMPTZ NOT NULL,
  callback         BOOLEAN NOT NULL DEFAULT false,
  deadline_ms      INT NOT NULL,
  latency_ms       INT NOT NULL,
  correlation_id   TEXT NOT NULL,
  firm_attempts    INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  firm_at          TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Optimistic concurrency between the completer, re-pricing and booking.
  version          INT NOT NULL DEFAULT 1,
  -- Idempotency keys are scoped to the customer: two customers may pick the same key.
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS quotes_customer_created ON quotes (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_open_expiry ON quotes (valid_until) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS quotes_open_indicative_lane ON quotes (origin, destination, commodity, equipment) WHERE status = 'open' AND kind = 'indicative';

CREATE TABLE IF NOT EXISTS bookings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           UUID NOT NULL UNIQUE REFERENCES quotes(id),
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  idempotency_key    TEXT NOT NULL,
  honored_total_cents BIGINT NOT NULL,
  honored_inputs     JSONB NOT NULL,
  current_tariff_version INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);

-- Published pricing inputs as the quote service has seen them (from TariffPublished / FuelSurchargeChanged).
-- Together with quotes.inputs this reconstructs any quote's pricing for a dispute.
CREATE TABLE IF NOT EXISTS tariff_versions (
  tariff_id          TEXT NOT NULL,
  version            INT NOT NULL,
  origin             TEXT NOT NULL,
  destination        TEXT NOT NULL,
  commodity          TEXT NOT NULL,
  equipment          TEXT NOT NULL,
  rate_per_car_cents BIGINT NOT NULL,
  effective_at       TIMESTAMPTZ NOT NULL,
  event_id           UUID NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tariff_id, version)
);

-- Current tariff per key. Only moves forward: a late or replayed older version never wins.
CREATE TABLE IF NOT EXISTS tariff_current (
  tariff_id          TEXT PRIMARY KEY,
  version            INT NOT NULL,
  rate_per_car_cents BIGINT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every published surcharge; the current one is the latest (effective_date, published_at).
CREATE TABLE IF NOT EXISTS fuel_surcharges (
  event_id        UUID PRIMARY KEY,
  effective_date  DATE NOT NULL,
  published_at    TIMESTAMPTZ NOT NULL,
  cents_per_mile  NUMERIC(8, 2) NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fuel_surcharges_current ON fuel_surcharges (effective_date DESC, published_at DESC);

-- ─── Event log: transactional outbox + integration backbone ───────────────
CREATE TABLE IF NOT EXISTS events (
  position        BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  version         INT NOT NULL,
  stream_id       TEXT NOT NULL,
  stream_version  INT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id  TEXT NOT NULL,
  causation_id    UUID,
  producer        TEXT NOT NULL,
  payload         JSONB NOT NULL,
  published_at    TIMESTAMPTZ,
  CONSTRAINT events_stream_version UNIQUE (stream_id, stream_version)
);
CREATE INDEX IF NOT EXISTS events_unpublished ON events (position) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS events_type_position ON events (type, position DESC);
CREATE INDEX IF NOT EXISTS events_correlation ON events (correlation_id);
CREATE INDEX IF NOT EXISTS events_recorded ON events (recorded_at);

-- Append-only: the log is never updated except to stamp published_at, and never deleted from.
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'events is append-only';
  END IF;
  IF NEW.event_id <> OLD.event_id OR NEW.payload <> OLD.payload OR NEW.type <> OLD.type OR NEW.version <> OLD.version
     OR NEW.stream_id <> OLD.stream_id OR NEW.stream_version <> OLD.stream_version
     OR NEW.occurred_at <> OLD.occurred_at OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'events is append-only (only published_at may change)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only ON events;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

-- Idempotent consumers: one row per (consumer, event) inside the consumer's own transaction.
CREATE TABLE IF NOT EXISTS processed_events (
  consumer      TEXT NOT NULL,
  event_id      UUID NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- ─── Callbacks (signed, at-least-once) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL UNIQUE,
  quote_id         UUID NOT NULL REFERENCES quotes(id),
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  url              TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'delivered', 'dead')),
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until     TIMESTAMPTZ,
  last_status_code INT,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_due ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'in_flight');

-- ─── Analytics projection (rebuilt from the event log by npm run replay -- analytics) ───
CREATE TABLE IF NOT EXISTS analytics_counters (
  bucket     TIMESTAMPTZ NOT NULL,       -- hour of the event's occurred_at (event time)
  metric     TEXT NOT NULL,              -- requested, issued, firm_completed, booked, expired, repriced, ...
  dimension  TEXT NOT NULL,              -- client class, quote kind, dependency, ...
  value      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, metric, dimension)
);

CREATE TABLE IF NOT EXISTS analytics_latency (
  dependency  TEXT NOT NULL,             -- pricing, fuel, capacity, availability, firm_completion
  le_ms       INT NOT NULL,              -- histogram bucket upper bound; 2147483647 is +Inf
  count       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (dependency, le_ms)
);

CREATE TABLE IF NOT EXISTS analytics_sources (
  dependency  TEXT NOT NULL,
  source      TEXT NOT NULL,             -- live, cache, fallback, unknown (upcast v1)
  count       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (dependency, source)
);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection        TEXT PRIMARY KEY,
  events_applied    BIGINT NOT NULL DEFAULT 0,
  max_position      BIGINT NOT NULL DEFAULT 0,
  last_recorded_at  TIMESTAMPTZ,
  rebuilt_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
