# Fleet Telemetry and Command Dispatch - Architecture Design

## System Overview

A platform that monitors and controls about one million grid-edge devices (smart inverters, battery controllers and feeder sensors) connected over the public internet through cellular modems and customer broadband. Devices sample every 10 seconds, buffer readings on flash while their link is down, and upload batches when it comes back, so telemetry arrives late, out of order and sometimes twice. Seven years of firmware are in the field at once, so the same quantity arrives under different metric names and units. Operators also need to send commands (curtail export, change a setpoint, reboot, run a diagnostic) to devices that may not be connected when the command is issued. This is monitoring and control at operator timescale, measured in seconds to minutes. Protection (relays tripping in milliseconds) stays on the device and is out of scope.

**Learning goals:**

- Idempotent ingestion keyed on (device_id, sequence) when devices re-chunk and retry their buffers
- Event time versus processing time, watermarks, and correcting aggregates when late data arrives
- Schema drift across client versions: a metric-name registry, normalizing at ingestion versus at query time
- Desired versus reported state (a device shadow), command TTLs, acknowledgements and reconciliation
- Device identity and command integrity over an untrusted network (mTLS, signed commands)

## Requirements

### Functional Requirements

1. **Buffered upload**: devices upload telemetry in batches and keep up to 7 days of readings on flash when offline. A batch is acknowledged only once it is durable.
2. **Idempotent ingestion**: a reading identified by (device_id, epoch, seq) is counted exactly once, however many times or in whatever batch shapes it is uploaded.
3. **Event-time storage**: raw points and rollups are bucketed by when the reading was taken, not when it arrived. Late readings correct historical aggregates, and every aggregate exposes its completeness and revision count.
4. **Metric registry**: canonical metrics with units; aliases from (raw name, schema-version range) to a canonical metric with a unit conversion; a queue of unmapped names; re-normalization of stored data when an alias changes.
5. **Device shadow**: per-device desired and reported state with versions, delta delivery on connect, and drift detection.
6. **Commands**: imperative commands with TTL, per-device ordering, delivery and result acknowledgements, cancellation, supersession, and fleet-wide jobs that need a second approver.
7. **Fleet views**: online, backfilling, stale and offline state per device, rolled up by region, substation and feeder.
8. **Device security**: per-device X.509 identity, revocation, and commands signed end to end.

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Durability | Zero loss of acknowledged readings | A device deletes readings once acked; a lost ack-then-drop is unrecoverable |
| Correctness | Duplicates never double-count an aggregate | Energy totals feed settlement and planning |
| Ingest availability | 99.95% | Devices buffer for 7 days, so an outage costs freshness, not data |
| Freshness | Receipt to queryable p95 < 10 s; online reading to dashboard p95 < 75 s | 60 s upload interval plus pipeline time |
| Command latency | Issue to delivery on an online device p95 < 2 s | Curtailment during a grid event |
| Command safety | No command executes after its TTL; no command executes twice | A stale "curtail to 0%" three hours later is an outage |
| Late data | Accepted up to 30 days after event time | Matches raw retention |
| Dashboard queries | p95 < 500 ms for a 24-hour chart | Control-room use |

### Out of Scope

- Protection and sub-second control loops (local to the device)
- Firmware binary distribution (a command can trigger an update, but the binary comes from a CDN)
- Settlement and billing (consumers of revised aggregates)
- SCADA protocol adapters (DNP3, IEC 61850)

## Capacity Estimation

### Production Scale

| Assumption | Value |
|------------|-------|
| Devices | 1,000,000 (50 regions, 2,000 substations, 10,000 feeders of ~100 devices) |
| Sample interval | 10 s, 20 metrics per reading |
| Upload interval when online | 60 s (6 readings per batch) |
| Reading size on the wire | ~200 bytes compressed |
| Device buffer | 7 days |
| Stored size per point | ~3 bytes after ClickHouse compression |
| Commands | ~5 per device per day |
| MQTT connections per broker node | ~100,000 |
| ClickHouse sustained insert rate | ~1M narrow rows/s per shard |

| Derived quantity | Calculation | Result |
|------------------|-------------|--------|
| Readings/s | 1,000,000 / 10 s | 100,000/s |
| Points/s | 100,000 × 20 | 2,000,000/s |
| Upload requests/s | 1,000,000 / 60 s | ~16,700/s |
| Ingest bandwidth | 100,000 × 200 B | 20 MB/s (~160 Mbps) |
| Points/day | 2,000,000 × 86,400 | 172.8 billion |
| Raw storage/day | 172.8B × 3 B | ~518 GB/day |
| Raw storage, 30 days | 518.4 GB × 30 | ~15.6 TB per replica |
| Kafka, 7-day retention | 20 MB/s × 604,800 s | ~12.1 TB per replica, ~36 TB at RF 3 |
| Device buffer, 7 days | 8,640 readings/day × 7 × 200 B | ~12.1 MB per device |
| MQTT broker nodes | 1M / 100K, plus 2 spare | 12 nodes |
| MQTT keepalives | 1M / 60 s | ~16,700 pings/s |
| Shadow state | 1M × ~2 KB | ~2 GB |
| Commands | 5M/day / 86,400 | ~58/s average |
| ClickHouse shards | 2× steady points/s / 1M rows/s | 4 shards |

### Storage Breakdown (ClickHouse, per replica)

| Table | Rows/day | Bytes/row | Retention | Size |
|-------|----------|-----------|-----------|------|
| Raw points | 172.8B | ~3 | 30 days | ~15.6 TB |
| Device 5-minute rollups | 1M × 20 × 288 = 5.76B | ~10 | 90 days | ~5.2 TB |
| Device 1-hour rollups | 1M × 20 × 24 = 480M | ~10 | 5 years | ~8.8 TB |
| Feeder 1-minute rollups | 10,000 × 20 × 1,440 = 288M | ~12 | 13 months | ~1.4 TB |
| Total | | | | ~31 TB |

### Reconnect Storm

The sizing case is not the steady state. A regional cellular outage takes 20% of the fleet (200,000 devices, about 2,000 feeders) offline for 6 hours.

| Quantity | Calculation | Result |
|----------|-------------|--------|
| Buffered readings per device | 6 h × 360 readings/h | 2,160 |
| Total backlog | 200,000 × 2,160 | 432M readings (~86.4 GB) |
| Unpaced: all devices upload within 10 minutes | 432M / 600 s | 720,000 readings/s (7.2× steady, 144 MB/s) |
| Paced: backlog admitted at storage headroom | 4M points/s capacity − 2M steady = 2M points/s | 100,000 readings/s |
| Drain time when paced | 432M / 100,000/s | 4,320 s = 72 minutes |
| TLS handshakes with jittered reconnect over 5 minutes | 200,000 / 300 s | ~667/s |

The backlog is admitted at whatever headroom the storage tier has left after live traffic, so live data stays fresh while the backlog drains. Storage, not the gateway, sets the pace.

### Local Development Scale

The planned local build simulates 5,000 devices (500 readings/s, 10,000 points/s, ~83 uploads/s), 50 feeders, 5 substations and 1 region. That is enough to exercise reconnect storms (take 1,000 simulated devices offline for 30 minutes and release them together) on one laptop.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ DEVICES (1M) · flash ring buffer (7 days) · per-device seq · outbound-only links │
└───────────────┬───────────────────────────────────────────────▲──────────────────┘
                │ HTTPS batches (mTLS)                          │ MQTT session (mTLS)
                ▼                                               ▼
┌───────────────────────────────┐                 ┌───────────────────────────────┐
│ Ingest gateway (stateless)    │                 │ MQTT broker cluster (12)      │
│ cert → device_id · validate   │                 │ presence (LWT) · deltas ·     │
│ rate limit · live / backfill  │                 │ commands · acks               │
└───────┬───────────────┬───────┘                 └───────────────▲───────────────┘
        │ live          │ backfill                                │
        ▼               ▼                                         ▼
┌───────────────────────────────┐                 ┌───────────────────────────────┐
│ Kafka                         │                 │ Command and shadow service    │
│ telemetry.live (256)          │                 │ desired/reported · TTL · seq  │
│ telemetry.backfill (256)      │                 │ dispatch · reconcile · jobs   │
│ registry.changes (compacted)  │                 └───────────────┬───────────────┘
│ telemetry.revisions           │                                 │
└───────────────┬───────────────┘                                 ▼
                ▼                                 ┌───────────────────────────────┐
┌───────────────────────────────┐   registry      │ PostgreSQL                    │
│ Stream processor (by device)  │◀── snapshots ───│ devices · shadows · commands  │
│ dedup → normalize → clock     │                 │ jobs · metric registry        │
│ check → watermark → dirty     │                 └───────────────┬───────────────┘
└───────┬───────────────┬───────┘                                 │
        ▼               ▼                                         │
┌───────────────┐ ┌─────────────────┐ ┌──────────────────┐        │
│ ClickHouse    │ │ Revision tracker│ │ Redis            │        │
│ raw points +  │ │ dirty buckets → │ │ presence · fleet │        │
│ rollup states │ │ alerts, exports │ │ status counts    │        │
└───────┬───────┘ └────────┬────────┘ └────────┬─────────┘        │
        └──────────────────┴─────────┬─────────┴──────────────────┘
                                     ▼
                 ┌──────────────────────────────────────┐
                 │ Operator API + SSE push              │
                 │ fleet · device · commands · registry │
                 └──────────────────┬───────────────────┘
                                    ▼
                 ┌──────────────────────────────────────┐
                 │ Web dashboard (operators, admins)    │
                 └──────────────────────────────────────┘
```

The design has two planes. The **data plane** carries telemetry: devices push HTTPS batches to a stateless gateway, which writes them to Kafka. A stream processor keyed by device deduplicates, normalizes metric names, checks clocks, and writes raw points and mergeable rollup states to ClickHouse. The **control plane** carries presence, shadow deltas and commands over a persistent MQTT session that the device opens outbound, because a device behind carrier NAT cannot accept inbound connections. The command service keeps the authoritative command and shadow state in PostgreSQL. The broker is transport only.

## Core Components / Request Flows

### 1. Telemetry upload (device to ack)

1. The device takes up to 360 readings (one hour) from the oldest unacknowledged end of its ring buffer. When it has just reconnected, it first sends the newest minute so the dashboard turns live immediately, then drains the backlog oldest-first.
2. The batch header carries `epoch`, `oldest_buffered_seq`, `schema_version`, `firmware_version`, `device_now` and `buffer_depth`. Each reading carries `seq`, `event_time` and a map of raw metric names to values.
3. The gateway terminates mTLS and takes `device_id` from the certificate subject. It checks revocation, applies the per-device rate limit, and validates bounds (no event time more than 5 minutes in the future or more than 30 days in the past, batch ≤ 512 KB).
4. The gateway routes the batch: if its oldest event time is more than 5 minutes behind receipt time it goes to `telemetry.backfill`, otherwise to `telemetry.live`. Both topics are keyed by `device_id`.
5. The gateway waits for Kafka `acks=all` (RF 3, `min.insync.replicas=2`), then responds with the accepted seq ranges, the device's `committed_through` cursor, a pending-command hint, and `next_upload_after_ms`. The last value is how the server paces a reconnect storm.
6. The device marks those ranges as acknowledged and frees them from the buffer. If the response is lost, it re-sends; the duplicate is removed downstream.

### 2. Dedup, normalize, write (stream processor)

1. The processor consumes both topics. Live partitions get priority; the backfill consumer group is rate-limited to the storage headroom (100,000 readings/s at production scale).
2. **Dedup**: per (device_id, epoch), keyed state holds a contiguous high-water mark `hw` and a small set of seen seqs above it. A reading with seq ≤ hw or already in the set is dropped and counted. After each batch, `hw` advances to at least `oldest_buffered_seq − 1`, because the device has promised never to send anything older. That bounds the set.
3. **Normalize**: look up (raw_name, schema_version) in the cached registry snapshot. On a hit, emit (metric_id, value × scale + add_offset). On a miss, store the point with `metric_id = 0` and increment the unmapped-name counter.
4. **Clock check**: compare `device_now` in the header with receipt time. Beyond ±60 s skew, flag the batch `clock_suspect`, and shift event times by the measured offset if the device has reported a clock step since its last sync.
5. **Write**: insert into `telemetry_points` with an insert deduplication token derived from (topic, partition, offset range), so a retried sink insert is a no-op. Materialized views turn each insert into partial aggregate states in the rollup tables.

### 3. Late data and aggregate correction

- The **watermark** on the live topics is the minimum over partitions of (max event time, clamped to receipt time) − 2 minutes. A 1-minute bucket provisionally closes when the watermark passes its end. That close is the moment to evaluate alerts and publish the bucket as provisional.
- A reading that lands behind the watermark is **late**. It still goes into raw points and rollup states, because the rollups are mergeable (sum, count, min, max, last-by-time): a late insert adds one more partial state and ClickHouse merges it. No rewrite is needed.
- The processor also emits a coarse **dirty mark** for (feeder, hour, metric group) to `telemetry.revisions`. The revision tracker coalesces marks every 10 s, bumps the revision counter for those buckets, and notifies three consumers. Dashboards showing that range refetch it. The alert re-evaluator raises a *retrospective* incident if a revised bucket would have breached a rule; it does not page. Export consumers re-issue affected daily reports with a revision number.
- Dirty marks are coarse on purpose. During the storm above, device-level marks would be 200,000 devices × 360 minutes × 20 metrics = 1.44B entries. Feeder-hour marks are 2,000 feeders × 6 hours = 12,000.

### 4. Metric registry and re-normalization

- Admins map an unmapped raw name to a canonical metric for a schema-version range, with a unit conversion. A dry run reports affected points, devices and buckets before publishing.
- Publishing creates a new registry version. The registry service writes the full snapshot to the compacted `registry.changes` topic; processors swap it in atomically and stamp `registry_version` on every point they write.
- A **re-normalization job** then rewrites stored points for that (raw_name, schema range) within raw retention. Two cases differ:
  - **Additive** (a name that was unmapped is now mapped): the job inserts the normalized points, and rollup materialized views add their states. This is the same path as late data.
  - **Corrective** (a conversion or mapping was wrong): the job re-inserts points with a higher `registry_version` (ReplacingMergeTree keeps the newest), then rebuilds the affected rollup buckets from deduplicated points, because adding a corrected state on top of a wrong one would double count.
- Both cases emit dirty marks, so dashboards and exports see an alias fix as a revision.

### 5. Presence and fleet status

- The broker publishes connect and disconnect events, including last-will messages for ungraceful drops. The presence service writes `last_seen` and the broker node to Redis.
- The stream processor writes each device's newest event time and backlog depth.
- A status evaluator, partitioned by device hash, recomputes status every 15 s with 30 s of hysteresis:

| Status | Rule |
|--------|------|
| Online | Control session connected and data lag ≤ 3 minutes |
| Backfilling | Connected, data lag > 3 minutes, and backlog shrinking |
| Stale | Connected but no new data for > 3 minutes and not backfilling, or disconnected for < 15 minutes |
| Offline | No contact for ≥ 15 minutes |

- Transitions update per-feeder counters with `HINCRBY`. A full recount every 5 minutes corrects counter drift.

### 6. Shadow update and command dispatch

1. An operator changes desired state (`PATCH .../shadow/desired` with `If-Match: desired_version`) or issues an imperative command (`POST .../commands` with an `Idempotency-Key`).
2. In one transaction the command service allocates the next per-device `seq`, inserts the command (status `queued`, `expires_at` = now + TTL), signs it, and marks older queued desired-state commands for the same keys `superseded`.
3. If the device is online, the dispatcher publishes to `devices/{id}/commands` at QoS 1 and marks it `sent`. If not, the command waits; the device's next MQTT connect (or a pending-command hint on an HTTPS ack) triggers dispatch of everything still unexpired, in seq order.
4. The device verifies the signature, checks expiry (absolute against its synced clock, and relative using `ttl_remaining_ms`), persists the command id, and acks `delivered`. After executing, it reports `succeeded`, `failed` or `rejected` with a result.
5. A sweeper marks `queued` commands past `expires_at` as `expired`. A `sent` command past expiry without an ack becomes `expired` with `unconfirmed = true`. If the device later reports in its executed-command log that it ran the command before expiry, the status is corrected.

### 7. Reconciliation

- On every connect the device publishes its reported state, the desired version it last applied, and its last 50 executed command ids with results.
- The service compares those with the shadow: it sends the delta when `desired_version > reported_applied_version`, and resolves any commands whose outcome was unknown.
- A sweep every 5 minutes re-pushes deltas to devices that have been online for over 2 minutes but are still behind. After 3 attempts the shadow is marked `drifted` and an alert fires.
- If the device reports `override_source = local` (a technician changed a setting on site), the shadow is marked `conflict`. The service does not fight a local safety override; an operator decides whether to re-assert or adopt it.

## Database Schema

### PostgreSQL (control plane)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE grid_nodes (
  node_id    TEXT PRIMARY KEY,                     -- 'feeder:west-114-3'
  kind       TEXT NOT NULL CHECK (kind IN ('region', 'substation', 'feeder')),
  parent_id  TEXT REFERENCES grid_nodes(node_id),
  name       TEXT NOT NULL
);
CREATE INDEX idx_grid_nodes_parent ON grid_nodes(parent_id);

CREATE TABLE firmware_versions (
  firmware_version TEXT PRIMARY KEY,
  schema_version   INT NOT NULL CHECK (schema_version >= 0),
  released_at      TIMESTAMPTZ
);

CREATE TABLE operators (
  operator_id   UUID PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  region_scope  TEXT[] NOT NULL DEFAULT '{}'       -- empty array = all regions
);

CREATE TABLE devices (
  device_id          TEXT PRIMARY KEY,             -- equals the certificate subject
  model              TEXT NOT NULL,
  firmware_version   TEXT NOT NULL REFERENCES firmware_versions(firmware_version),
  feeder_id          TEXT NOT NULL REFERENCES grid_nodes(node_id),
  lifecycle          TEXT NOT NULL DEFAULT 'active'
                     CHECK (lifecycle IN ('provisioned', 'active', 'maintenance', 'decommissioned')),
  current_epoch      BIGINT NOT NULL DEFAULT 1,    -- bumps on factory reset
  next_command_seq   BIGINT NOT NULL DEFAULT 1,
  last_seen_at       TIMESTAMPTZ,                  -- flushed from Redis every minute
  newest_event_time  TIMESTAMPTZ,
  committed_through  BIGINT NOT NULL DEFAULT 0,    -- copy of dedup hw, for the cursor endpoint
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_feeder ON devices(feeder_id) WHERE lifecycle = 'active';
CREATE INDEX idx_devices_firmware ON devices(firmware_version);

CREATE TABLE device_certificates (
  fingerprint   BYTEA PRIMARY KEY,                 -- SHA-256 of the DER certificate
  device_id     TEXT NOT NULL REFERENCES devices(device_id),
  not_before    TIMESTAMPTZ NOT NULL,
  not_after     TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT,
  CHECK (not_after > not_before)
);
CREATE INDEX idx_certs_device ON device_certificates(device_id);
CREATE INDEX idx_certs_revoked ON device_certificates(revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE device_shadows (
  device_id                TEXT PRIMARY KEY REFERENCES devices(device_id),
  desired                  JSONB NOT NULL DEFAULT '{}',
  desired_version          BIGINT NOT NULL DEFAULT 0,
  desired_updated_by       UUID REFERENCES operators(operator_id),
  desired_updated_at       TIMESTAMPTZ,
  reported                 JSONB NOT NULL DEFAULT '{}',
  reported_applied_version BIGINT NOT NULL DEFAULT 0,
  reported_at              TIMESTAMPTZ,
  override_source          TEXT CHECK (override_source IN ('local', 'remote')),
  sync_state               TEXT NOT NULL DEFAULT 'in_sync'
                           CHECK (sync_state IN ('in_sync', 'pending', 'drifted', 'conflict')),
  push_attempts            INT NOT NULL DEFAULT 0,
  CHECK (reported_applied_version <= desired_version)
);
CREATE INDEX idx_shadows_unsynced ON device_shadows(sync_state) WHERE sync_state <> 'in_sync';

CREATE TABLE command_jobs (
  job_id        UUID PRIMARY KEY,
  selector      JSONB NOT NULL,                    -- {"feeder_id": "...", "model": "..."}
  command_name  TEXT NOT NULL,
  payload       JSONB NOT NULL,
  ttl_seconds   INT NOT NULL CHECK (ttl_seconds BETWEEN 30 AND 604800),
  target_count  INT,
  dispatch_rate INT NOT NULL DEFAULT 2000 CHECK (dispatch_rate > 0),
  status        TEXT NOT NULL
                CHECK (status IN ('awaiting_approval', 'dispatching', 'done', 'cancelled')),
  created_by    UUID NOT NULL REFERENCES operators(operator_id),
  approved_by   UUID REFERENCES operators(operator_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE commands (
  command_id      UUID PRIMARY KEY,
  device_id       TEXT NOT NULL REFERENCES devices(device_id),
  seq             BIGINT NOT NULL,                 -- per-device order
  job_id          UUID REFERENCES command_jobs(job_id),
  kind            TEXT NOT NULL CHECK (kind IN ('desired_state', 'imperative')),
  name            TEXT NOT NULL,                   -- 'set_export_limit', 'reboot', ...
  payload         JSONB NOT NULL,
  desired_version BIGINT,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sent', 'delivered', 'succeeded', 'failed',
                                    'rejected', 'expired', 'superseded', 'cancelled')),
  unconfirmed     BOOLEAN NOT NULL DEFAULT false,  -- expired after send without an ack
  idempotency_key TEXT,
  created_by      UUID NOT NULL REFERENCES operators(operator_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  send_attempts   INT NOT NULL DEFAULT 0,
  result          JSONB,
  signature       BYTEA NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (kind <> 'desired_state' OR desired_version IS NOT NULL)
);
CREATE UNIQUE INDEX uq_commands_device_seq ON commands(device_id, seq);
CREATE UNIQUE INDEX uq_commands_idempotency ON commands(created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_commands_pending ON commands(device_id, seq) WHERE status IN ('queued', 'sent');
CREATE INDEX idx_commands_expiry ON commands(expires_at) WHERE status IN ('queued', 'sent');
CREATE INDEX idx_commands_job ON commands(job_id, status) WHERE job_id IS NOT NULL;

CREATE TABLE command_events (
  command_id UUID NOT NULL REFERENCES commands(command_id),
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status     TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('operator', 'dispatcher', 'device', 'sweeper')),
  detail     JSONB,
  PRIMARY KEY (command_id, at, status)
);

CREATE TABLE metric_definitions (
  metric_id      SERIAL PRIMARY KEY,               -- 0 is reserved for "unmapped"
  canonical_name TEXT NOT NULL UNIQUE,             -- 'ac_power_kw'
  unit           TEXT NOT NULL,                    -- 'kW'
  value_type     TEXT NOT NULL CHECK (value_type IN ('gauge', 'counter', 'state')),
  valid_min      DOUBLE PRECISION,
  valid_max      DOUBLE PRECISION,
  description    TEXT
);

CREATE TABLE registry_versions (
  version      INT PRIMARY KEY,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by UUID NOT NULL REFERENCES operators(operator_id),
  summary      TEXT NOT NULL
);

CREATE TABLE metric_aliases (
  alias_id        SERIAL PRIMARY KEY,
  raw_name        TEXT NOT NULL,                   -- exactly as the device sends it
  schema_versions INT4RANGE NOT NULL,              -- e.g. [1,4)
  metric_id       INT NOT NULL REFERENCES metric_definitions(metric_id),
  scale           DOUBLE PRECISION NOT NULL DEFAULT 1,
  add_offset      DOUBLE PRECISION NOT NULL DEFAULT 0,   -- canonical = raw * scale + add_offset
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  introduced_in   INT REFERENCES registry_versions(version),
  retired_in      INT REFERENCES registry_versions(version),
  created_by      UUID NOT NULL REFERENCES operators(operator_id),
  CHECK (status = 'draft' OR introduced_in IS NOT NULL),
  EXCLUDE USING gist (raw_name WITH =, schema_versions WITH &&) WHERE (status = 'active')
);
CREATE INDEX idx_aliases_metric ON metric_aliases(metric_id);

CREATE TABLE unmapped_metric_names (
  raw_name       TEXT NOT NULL,
  schema_version INT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL,
  last_seen_at   TIMESTAMPTZ NOT NULL,
  points_24h     BIGINT NOT NULL DEFAULT 0,
  device_count   INT NOT NULL DEFAULT 0,
  sample_values  DOUBLE PRECISION[] NOT NULL DEFAULT '{}',  -- reservoir sample of 100
  resolved_alias INT REFERENCES metric_aliases(alias_id),
  PRIMARY KEY (raw_name, schema_version)
);
CREATE INDEX idx_unmapped_open ON unmapped_metric_names(points_24h DESC) WHERE resolved_alias IS NULL;

CREATE TABLE renormalization_jobs (
  job_id           UUID PRIMARY KEY,
  registry_version INT NOT NULL REFERENCES registry_versions(version),
  raw_name         TEXT NOT NULL,
  schema_versions  INT4RANGE NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('additive', 'corrective')),
  from_time        TIMESTAMPTZ NOT NULL,
  to_time          TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  points_written   BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_time > from_time)
);
```

The exclusion constraint is the important line in the registry. It makes it impossible for two active aliases to claim the same raw name for overlapping schema versions. That matters because `temp` meant °F in schema 1 and °C in schema 4; one mapping for "temp" across all versions would silently corrupt one of them.

Completed commands older than 30 days are archived to a ClickHouse `command_history` table, which keeps the hot `commands` table near 150M rows (5M/day × 30).

### ClickHouse (telemetry)

```sql
CREATE TABLE telemetry_points (
  device_id        String,
  epoch            UInt32,
  seq              UInt64,
  event_time       DateTime64(3, 'UTC'),
  raw_name         LowCardinality(String),
  schema_version   UInt16,
  raw_value        Float64 CODEC(Gorilla, ZSTD(1)),
  metric_id        UInt32,                          -- 0 = unmapped
  value            Float64 CODEC(Gorilla, ZSTD(1)),
  registry_version UInt32,
  feeder_id        LowCardinality(String),
  received_at      DateTime64(3, 'UTC'),
  clock_suspect    UInt8,
  INDEX idx_metric metric_id TYPE set(64) GRANULARITY 4
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/{shard}/telemetry_points', '{replica}', registry_version)
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (device_id, event_time, epoch, seq, raw_name)
TTL toDateTime(event_time) + INTERVAL 30 DAY;

CREATE TABLE rollup_device_5m (
  metric_id  UInt32,
  device_id  String,
  bucket     DateTime('UTC'),
  v_min      AggregateFunction(min, Float64),
  v_max      AggregateFunction(max, Float64),
  v_sum      AggregateFunction(sum, Float64),
  v_count    AggregateFunction(count),
  v_last     AggregateFunction(argMax, Float64, DateTime64(3, 'UTC'))
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/{shard}/rollup_device_5m', '{replica}')
PARTITION BY toYYYYMM(bucket)
ORDER BY (metric_id, device_id, bucket)
TTL bucket + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW mv_rollup_device_5m TO rollup_device_5m AS
SELECT metric_id, device_id, toStartOfFiveMinutes(event_time) AS bucket,
       minState(value) AS v_min, maxState(value) AS v_max, sumState(value) AS v_sum,
       countState() AS v_count, argMaxState(value, event_time) AS v_last
FROM telemetry_points
WHERE metric_id != 0
GROUP BY metric_id, device_id, bucket;

CREATE TABLE rollup_feeder_1m (
  metric_id  UInt32,
  feeder_id  LowCardinality(String),
  bucket     DateTime('UTC'),
  v_min      AggregateFunction(min, Float64),
  v_max      AggregateFunction(max, Float64),
  v_sum      AggregateFunction(sum, Float64),
  v_count    AggregateFunction(count)              -- completeness = count / (expected devices × 6)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/{shard}/rollup_feeder_1m', '{replica}')
PARTITION BY toYYYYMM(bucket)
ORDER BY (metric_id, feeder_id, bucket)
TTL bucket + INTERVAL 13 MONTH;

CREATE TABLE bucket_revisions (
  scope        LowCardinality(String),            -- 'feeder:west-114-3'
  metric_group LowCardinality(String),
  hour         DateTime('UTC'),
  revision     UInt32,
  late_points  UInt64,
  reason       LowCardinality(String),            -- 'late_data' | 'renormalization' | 'failover'
  revised_at   DateTime('UTC')
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/{shard}/bucket_revisions', '{replica}', revision)
ORDER BY (scope, metric_group, hour);
```

The 1-hour device rollup and the feeder materialized view follow the same pattern and are omitted. Raw points are sorted by device first, because the dominant raw query is "this device, this time range". Fleet-wide questions are answered from rollups, which are sorted by metric first.

### Redis keys

| Key | Type | Contents | TTL |
|-----|------|----------|-----|
| `presence:{device_id}` | Hash | broker node, connected_at, last_seen, data_lag_s, backlog | 1 hour |
| `status:feeder:{feeder_id}` | Hash | online / backfilling / stale / offline counts | none (recounted every 5 minutes) |
| `ratelimit:ingest:{device_id}` | String | token bucket state | 2 minutes |
| `revoked:certs` | Set | revoked certificate fingerprints, mirrored to gateways | none |
| `idem:{operator_id}:{key}` | String | command_id for a recent idempotency key | 24 hours |

### Kafka topics

| Topic | Key | Partitions | Retention | Notes |
|-------|-----|------------|-----------|-------|
| `telemetry.live` | device_id | 256 | 7 days | Batches whose oldest reading is ≤ 5 minutes old |
| `telemetry.backfill` | device_id | 256 | 7 days | Older batches; consumed at storage headroom |
| `registry.changes` | `snapshot` | 1 | compacted | Full registry snapshot per version |
| `telemetry.revisions` | scope | 32 | 3 days | Dirty marks (feeder, hour, metric group) |
| `presence.events` | device_id | 64 | 1 day | Connect, disconnect and last-will events |

## API Design

### Device-facing (mTLS)

```
POST /device/v1/telemetry:batch          → 200 accepted ranges · 413 split · 429 Retry-After · 503 keep buffering
GET  /device/v1/ingest-cursor            → { epoch, committed_through } for resuming after a lost ack
GET  /device/v1/commands?after_seq=N     → pending commands (HTTPS fallback when MQTT is blocked)
POST /device/v1/commands/{id}/ack        → delivered | succeeded | failed | rejected, with result
POST /device/v1/shadow/reported          → reported state + applied desired_version + executed log
```

```
MQTT topics (device subscribes to its own topics only; enforced by the broker ACL from the cert):
devices/{id}/commands         server → device   signed commands, QoS 1
devices/{id}/shadow/delta     server → device   desired-state delta, QoS 1
devices/{id}/shadow/reported  device → server   reported state, QoS 1
devices/{id}/commands/ack     device → server   delivery and result acks, QoS 1
devices/{id}/presence         device → server   retained online flag; last will publishes offline
```

Batch upload request and response (the device sends protobuf; JSON shown for readability):

```json
{
  "epoch": 3, "oldest_buffered_seq": 88120, "schema_version": 2,
  "firmware_version": "2.7.4", "device_now": "2026-10-11T14:06:02.120Z", "buffer_depth": 2160,
  "readings": [
    { "seq": 88120, "event_time": "2026-10-11T08:06:00.000Z", "metrics": { "pwr": 4.21, "volt": 241.7, "temp": 41.0 } }
  ]
}
```

```json
{
  "accepted": [[88120, 88479]], "committed_through": 88119,
  "pending_commands": 1, "next_upload_after_ms": 4000
}
```

### Operator API (session auth)

```
GET    /api/v1/fleet/summary?group_by=region|substation|feeder&parent=…  → status counts per group
GET    /api/v1/devices?status=&feeder=&firmware=&cursor=&limit=          → device page (cursor)
GET    /api/v1/devices/:id                                               → device, presence, status, backlog
GET    /api/v1/devices/:id/metrics?metric=&from=&to=&points=             → buckets: min/max/avg/count/revision
GET    /api/v1/aggregates?scope=feeder:…&metric=&from=&to=               → buckets with completeness and revision
GET    /api/v1/devices/:id/shadow                                        → desired, reported, sync_state
PATCH  /api/v1/devices/:id/shadow/desired    (If-Match, Idempotency-Key) → new desired_version + command
POST   /api/v1/devices/:id/commands          (Idempotency-Key)           → command (status queued)
GET    /api/v1/devices/:id/commands?cursor=                              → command history with events
POST   /api/v1/commands/:id/cancel                                       → cancelled if still queued
POST   /api/v1/command-jobs                  (Idempotency-Key)           → job awaiting approval, target count
POST   /api/v1/command-jobs/:id/approve                                  → second operator starts dispatch
GET    /api/v1/command-jobs/:id                                          → per-status counts
GET    /api/v1/stream?topics=fleet,device:…,job:…                        → SSE: status, command, revision events
```

### Admin API

```
GET    /api/v1/admin/registry/metrics                    → canonical metrics with alias coverage
GET    /api/v1/admin/registry/unmapped                   → unmapped names by volume, with samples
POST   /api/v1/admin/registry/aliases?dry_run=true       → impact preview: points, devices, buckets
POST   /api/v1/admin/registry/versions                   → publish draft aliases as a new version
POST   /api/v1/admin/registry/versions/:v/rollback       → publish a version that restores :v
POST   /api/v1/admin/devices/:id/revoke-certificate      → revoke, disconnect, block at gateway
```

## Key Design Decisions

### 1. Separate data and control planes

**Chosen:** telemetry over HTTPS batches to a stateless gateway; presence, shadow and commands over a persistent MQTT session.

Telemetry is bulk, durable and request/response shaped: the device needs an answer that says "these ranges are durable, you may delete them". HTTPS gives that answer explicitly, scales horizontally behind an L4 balancer, and has standard backpressure (`429` plus `Retry-After`, or `next_upload_after_ms` in a 200), which is the lever that paces a reconnect storm. Commands need the opposite shape: the server must push to a device behind carrier NAT within seconds, and only a connection the device opened can carry that.

**Alternative rejected: everything over MQTT.** One connection per device is cheaper on battery and radio. But the broker cluster would become the data plane at 100,000 readings/s plus storms, and a QoS 1 PUBACK only proves the broker received the message. Whether the reading is durable then depends on the broker-to-Kafka bridge, so the ack the device deletes data on would not mean durable. A 2,160-reading backlog drained over the same session also delays a curtailment command queued behind it.

**Cost:** two protocols in firmware and two connections per device. The device keeps the HTTPS connection warm with TLS session resumption so that each upload does not pay for a full handshake.

### 2. Per-reading dedup in a keyed stream stage, not batch dedup at the gateway

**Chosen:** dedup on (device_id, epoch, seq) in the stream processor, with Kafka partitioned by device so one consumer owns each device's state.

A batch id looks like the natural idempotency key, and it breaks in practice. Devices re-chunk their buffers: after a reboot, after a `413` that forced a smaller batch, or when live-first ordering puts the newest minute ahead of the backlog. The same reading then arrives inside a batch with a different id, and batch-level dedup counts it twice. Per-reading sequence numbers survive any re-chunking.

Doing it at the gateway with a shared Redis set of seen (device, seq) pairs would put a cross-network round trip and a 172.8B-points/day write load on the hot path, and two gateway nodes could race on the same device. Partitioning by device makes the processor the single writer for each device's state, so no locks are needed.

**Cost:** keyed state that has to be checkpointed with Kafka offsets, and a dependency on firmware persisting its sequence counter correctly. A factory reset that restarts seq at 1 would make every new reading look like a duplicate; the `epoch` field exists for exactly that case.

### 3. Mergeable rollups plus a revision ledger, instead of dropping late data or waiting for it

**Chosen:** rollups stored as aggregate states that merge. The watermark decides when to *act* on a bucket (alert, publish as provisional), not whether data can still change it.

Stream processors default to an allowed-lateness window, after which late records are dropped. For the grid, that is the wrong default: an inverter that was offline for six hours during a storm holds exactly the data operators need for fault analysis, and dropping it makes feeder energy totals permanently wrong. The opposite extreme, holding a window open until every device has reported, means one dead device stalls its feeder's numbers forever. A nightly batch recompute would leave 24 hours of wrong numbers on the screen.

With mergeable states, a late reading is just another insert. Revisions are tracked coarsely (feeder, hour), and every bucket the API returns carries `completeness` and `revision`, so the UI can show provisional numbers honestly.

**Cost:** numbers on the dashboard change after the fact, which operators must be taught to read; non-mergeable consumers (alerts already raised, exported reports) need explicit revision handling; and corrective changes (a wrong unit conversion) still require a rebuild rather than an insert.

### 4. Normalize at ingestion, keep the raw name, re-normalize on change

**Chosen:** a hybrid. Each point stores the raw name and raw value as received plus the canonical metric and converted value from the registry version in force. Unknown names are stored with `metric_id = 0` and surface in an admin queue.

Normalizing only at query time means every dashboard query has to expand a canonical metric into its aliases, apply unit conversions per schema version, and union them. Rollups cannot be precomputed per canonical metric, so the fleet-wide queries that make the dashboard fast stop being possible. Every consumer (alerts, exports, notebooks) would also have to embed the registry logic. Normalizing only at ingestion, without keeping the raw data, bakes in every mapping mistake; a wrong °F/°C conversion becomes unrecoverable.

Keeping raw alongside normalized data makes a mapping mistake a re-normalization job within the 30-day raw window, and the job reuses the late-data correction path.

**Cost:** about 50% more bytes per point for the raw columns, re-normalization jobs that compete for insert capacity, and a 30-day horizon after which history is only as good as the mapping that was in force.

### 5. Commands live in our database; the broker is transport

**Chosen:** commands and shadows in PostgreSQL with per-device seq, TTL, supersession and signatures. MQTT persistent sessions are not used as the queue.

MQTT 5 can expire queued messages, but it cannot express "the newer export limit replaces the older one", "show me every command still pending on feeder 12", or "this command expired unconfirmed; resolve it from the device's executed log". It also loses its queue on a broker failover unless it is clustered with replicated sessions. Keeping state in PostgreSQL makes each command auditable and lets the operator see the same lifecycle the device follows.

**Cost:** the dispatcher must react to presence events to push queued commands on connect, so command latency for a reconnecting device depends on the presence pipeline, typically under a second.

## Consistency and Idempotency

| Operation | Mechanism | Guarantee |
|-----------|-----------|-----------|
| Batch upload | Kafka `acks=all` before HTTP 200; device deletes only acked ranges | At-least-once into Kafka |
| Reading dedup | Keyed state on (device_id, epoch, seq); `hw` advanced by `oldest_buffered_seq` | Each reading processed once |
| Sink retries | ClickHouse insert deduplication token = hash(topic, partition, offset range) | A retried insert is a no-op |
| Storage backstop | ReplacingMergeTree on (device, time, epoch, seq, raw_name) | Raw duplicates collapse at merge |
| Rollups | Fed only by deduplicated inserts; rebuilt for failover or corrective windows | No double counting |
| Operator command | `Idempotency-Key` unique per operator; replay returns the original command | One command per submission |
| Device execution | Device persists executed command ids and the highest seq; re-delivery is re-acked, not re-run | At-most-once execution |
| Shadow writes | `If-Match: desired_version`; mismatch returns 412 with the current shadow | No lost update between operators |

Exactly-once is an *effect*, not a transport property. Transport everywhere is at-least-once. Dedup happens where there is a single owner for the key (the device-partitioned processor, the device's executed-command log), and stores are made idempotent so that a retry of the last step cannot double-apply.

The device's ack is cumulative within a batch but not across batches. The gateway acknowledges exactly the ranges in the request it made durable. `committed_through` is a hint from the dedup stage, a few seconds behind; it only lets a device skip re-sending readings that already made it, which saves cellular data after a lost response.

## Security / Auth

- **Device identity:** each device gets an X.509 certificate at manufacture, with its private key generated inside a secure element and never exported. The chain runs from an offline root to an online issuing CA held in an HSM. The gateway and broker derive `device_id` from the certificate subject; any `device_id` in a payload is ignored. Certificates last two years and rotate in band (the device sends a CSR over its authenticated session).
- **Revocation:** revoked fingerprints live in PostgreSQL and are mirrored to a Redis set that gateways and brokers poll every 60 seconds. Revocation also force-disconnects any live MQTT session. This is faster than relying on CRL distribution to a million clients.
- **Broker ACLs:** a device may publish and subscribe only under `devices/{its id}/...`, derived from the certificate subject.
- **Signed commands:** the command service signs (command_id, device_id, seq, payload hash, expires_at) with an Ed25519 key in KMS. The device verifies against a pinned public key, so a compromised broker or gateway cannot forge or alter commands. The device rejects a seq at or below its last executed seq, which stops replays.
- **Operators:** session-based auth with sessions in Redis. Roles are viewer, operator (commands within `region_scope`) and admin (registry, certificates). Critical commands (open breaker, firmware update, fleet jobs over 1,000 devices) need a second approver, enforced by a constraint that the approver is not the creator. Every command and registry change writes an audit record.
- **Rate limiting:** per-device ingest token bucket (1 batch/s sustained, burst 5, 512 KB maximum batch) stops a compromised device from flooding the pipeline; per-operator API limits; per-job dispatch rate.
- **Input validation:** event times outside [now − 30 days, now + 5 minutes] are quarantined; values outside a canonical metric's `valid_min`/`valid_max` are stored but flagged.

## Observability

| Metric | Type | Why it matters |
|--------|------|----------------|
| `ingest_batches_total{result}` | Counter | Accepted, throttled, rejected, Kafka unavailable |
| `ingest_readings_total{topic}` | Counter | Live versus backfill mix |
| `dedup_duplicates_total` | Counter | Lost acks and retries; a spike means devices are not getting responses |
| `reading_lateness_seconds` | Histogram | processing time − event time, buckets from 10 s to 7 days |
| `watermark_lag_seconds` | Gauge | Now − watermark; a stalled watermark freezes alerts |
| `consumer_lag_seconds{topic}` | Gauge | Live lag pages; backfill lag only informs |
| `device_gap_readings_total` | Counter | Readings skipped when `hw` jumped (device buffer overflow) |
| `bucket_revisions_total{reason}` | Counter | Late data versus re-normalization versus failover |
| `unmapped_points_total{raw_name}` | Counter | Schema drift arriving from the field |
| `registry_version{instance}` | Gauge | A processor stuck on an old snapshot |
| `device_clock_skew_seconds` | Histogram | NTP or GNSS problems across the fleet |
| `fleet_devices{status}` | Gauge | Online, backfilling, stale, offline |
| `fleet_backlog_readings` | Gauge | Sum of reported `buffer_depth`: how much data is still on devices |
| `command_transitions_total{name,from,to}` | Counter | Lifecycle funnel; expired and unconfirmed rates |
| `command_delivery_seconds` | Histogram | Issue to delivered, online devices only |
| `shadow_unsynced_devices{state}` | Gauge | Pending, drifted, conflict |
| `mqtt_connections`, `tls_handshake_failures_total{reason}` | Gauge, Counter | Reconnect storms, expired or revoked certificates |

**SLOs:** live consumer lag p95 < 10 s; command delivery p95 < 2 s for online devices; zero acknowledged-then-lost readings, verified daily by comparing device-reported seq ranges with stored ranges for a 1% sample of devices.

**Logs and traces:** structured JSON logs carrying `device_id`, `batch_seq_range`, `command_id` and `registry_version`. A batch is traceable from the gateway through Kafka offsets to the ClickHouse insert token.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Kafka unavailable | Gateway circuit breaker opens and returns 503. Devices keep buffering (7 days of headroom); nothing acknowledged is lost |
| ClickHouse slow or down | Processor backpressures; Kafka holds 7 days. Live lag pages; dashboards show "data delayed" from the watermark lag |
| Stream processor crash | Restore keyed dedup state and offsets from the last checkpoint; sink inserts replay with the same dedup tokens |
| Broker node loss | Its ~100K devices reconnect with exponential backoff and full jitter (base 1 s, cap 5 minutes) to other nodes; queued commands re-dispatch on connect |
| PostgreSQL primary failover | Command creation and shadow writes fail for ~30 s (API returns 503 with Retry-After); telemetry is unaffected |
| Redis loss | Presence rebuilds from broker sessions and heartbeats within 90 s; status counts recount; idempotency falls back to the PostgreSQL unique index |
| Registry service down | Processors keep their last snapshot; new aliases wait |
| Lost upload response | Device re-sends; dedup drops the copies; `committed_through` lets it skip what already landed |
| Device clock wrong | Header skew check flags `clock_suspect`; future timestamps quarantined; commands carry a relative TTL as well as an absolute one |
| Device buffer overflow | Device evicts oldest; `oldest_buffered_seq` advances past unsent readings; gap counted as data loss |
| Region failure | DNS and anycast move devices to the secondary region. Readings acked in the primary but not yet mirrored may be re-sent; the failover window's rollups are rebuilt from deduplicated raw points and marked as revisions |

**Circuit breakers:** gateway to Kafka producer, operator API to ClickHouse (fail with "chart unavailable" rather than queueing), and dispatcher to broker publish.

## Scalability Considerations

- **Ingest gateways** are stateless; scale on request rate. Sized for 2× steady (about 33,000 uploads/s), with pacing doing the rest.
- **Kafka**: 256 partitions per telemetry topic give consumer parallelism well beyond steady throughput (20 MB/s is about 78 KB/s per partition).
- **Stream processors** scale with partitions; state is about 64 bytes per device in steady state (~64 MB for the fleet), more during storms while gap sets fill.
- **ClickHouse** shards by `device_id` hash. Four shards at ~1M rows/s give 2× steady; storage at ~31 TB per replica is the next limit, addressed by tiering older partitions to object storage.
- **MQTT** scales horizontally by connection count; device-to-node affinity is not required because commands route through the command service.
- **PostgreSQL** holds about 2 GB of shadows and 150M hot command rows. One primary with read replicas suffices at 1M devices. At 10M devices, shard by device_id hash.

### What Breaks First

1. **Storage insert capacity during a reconnect storm.** Unpaced, 200,000 devices returning together push 720,000 readings/s (14.4M points/s) at a tier sized for 4M points/s. Pacing through `next_upload_after_ms` plus a separate backfill topic keeps live data fresh while the backlog drains in about 72 minutes.
2. **Live data stuck behind backfill.** If both shared one topic, live readings for every device in a partition would queue behind the backlog. The live/backfill split and live-first device ordering exist for this.
3. **Presence churn.** Flapping cellular links generate connect and disconnect pairs; hysteresis and per-feeder counters keep the dashboard from thrashing.
4. **At 10× (10M devices):** 20M points/s needs about 40 shards at 2× headroom; presence heartbeats grow to ~167,000/s and need a Redis cluster; shadows reach ~20 GB and command rates justify sharding PostgreSQL. Edge aggregation (devices sending 1-minute summaries for slow-moving metrics) cuts raw volume more cheaply than more shards.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Transport | HTTPS batches + MQTT control | All MQTT | Explicit durable ack and backpressure; commands not stuck behind backfill |
| Dedup key | (device_id, epoch, seq) per reading | Batch id | Devices re-chunk buffers; batch ids double count |
| Dedup location | Device-partitioned stream state | Shared Redis set at gateway | Single owner per device, no hot-path round trip |
| Late data | Mergeable rollup states + revisions | Drop after allowed lateness | Storm data is the data operators need |
| Watermark role | Decides when to act (alert, publish) | Decides correctness | A dead device cannot stall a feeder |
| Revision granularity | (feeder, hour, metric group) | (device, minute, metric) | 12,000 marks instead of 1.44B in a storm |
| Live vs backfill | Separate topics, live-first device order | One topic | Backlog never delays live data |
| Schema drift | Normalize at ingest, keep raw, re-normalize | Query-time mapping only | Precomputed rollups stay possible; mistakes stay fixable |
| Alias key | (raw_name, schema-version range) | raw_name alone | Same name, different unit across versions |
| Command store | PostgreSQL with TTL, seq, supersession | MQTT persistent session queue | Auditable lifecycle and domain-aware expiry |
| TTL check | Server at send + device (absolute and relative) | Server only | Commands delivered just before expiry still cannot run late |
| Device identity | mTLS with secure-element keys | API keys or tokens | Non-exportable keys; no shared secret to leak |
| Command integrity | Ed25519 signatures verified on device | Trust the broker | Broker compromise cannot issue commands |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local implementation and how it maps to the production design above.

### Planned local topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Local machine (docker-compose for infrastructure)                       │
│                                                                         │
│  Device simulator (5,000 virtual devices) ──HTTPS mTLS──▶ ingest :3001  │
│        │                                                  ingest :3002  │
│        └──────────MQTT──────────▶ Mosquitto :1883                       │
│                                       ▲                                 │
│  Frontend :5173 ──▶ operator API :3000 │      command service :3003     │
│                                                                         │
│  Kafka :9092 · ClickHouse :8123 · PostgreSQL :5432 · Valkey :6379       │
│  Workers: stream processor · revision tracker · status evaluator ·      │
│           re-normalization runner · command sweeper                     │
└─────────────────────────────────────────────────────────────────────────┘
```

Planned services: an operator API with SSE on port 3000, two ingest instances on 3001 and 3002 (each an Express app on a Node `https` server with `requestCert`, so mTLS is real rather than mocked), the command and shadow service on 3003, and background workers. The frontend is React 19, Vite, TanStack Router, Zustand and Tailwind on 5173. The simulator is a Node process that runs thousands of virtual devices, each with a flash-like ring buffer, a persisted seq counter, configurable offline periods, clock skew, firmware versions that emit old metric names, and fault injection (drop the HTTP response after the server acked, duplicate a batch, re-chunk after a "reboot", factory-reset with a new epoch).

### Production patterns planned for the local build

| Pattern | Planned location | Why it matters at scale |
|---------|------------------|-------------------------|
| Idempotent ingestion | Planned `backend/src/processor/dedup.ts` | Per (device, epoch, seq) state with `hw` advanced by `oldest_buffered_seq`; the simulator's lost-ack fault proves no double counting |
| Operator idempotency keys | Planned `backend/src/shared/idempotency.ts` | `Idempotency-Key` stored with the command; replay returns the original |
| Circuit breakers (Opossum) | Planned `backend/src/shared/circuit-breaker.ts` | Around the Kafka producer (return 503 so devices keep buffering) and ClickHouse queries |
| Prometheus metrics (prom-client) | Planned `backend/src/shared/metrics.ts` | The metrics in the Observability table, exposed at `/metrics` on every service |
| Structured logging (Pino) | Planned `backend/src/shared/logger.ts` | `device_id`, seq range, `command_id` and `registry_version` on every line |
| Health checks | Planned `/health/live` and `/health/ready` per service | Ready only when Kafka, PostgreSQL and the registry snapshot are loaded |
| Rate limiting | Planned `backend/src/shared/rate-limit.ts` | Per-device token bucket in Valkey on ingest; per-operator limits on the API |
| Signed commands | Planned `backend/src/commands/signing.ts` | Ed25519 via Node `crypto`; the simulator verifies before executing |

### What will be simplified or substituted

| Production | Local substitute | Impact |
|------------|------------------|--------|
| Flink-style stream processor with checkpointed keyed state | Node Kafka consumer (kafkajs); dedup state snapshotted to PostgreSQL with committed offsets | Same semantics, far lower throughput |
| Kafka cluster (RF 3) | Single KRaft broker, RF 1 | No replication; durability demonstrated by protocol only |
| Sharded, replicated ClickHouse | Single node, non-replicated engines | Same tables and materialized views |
| MQTT broker cluster | Single Mosquitto with certificate-based ACLs | No broker failover |
| Secure element and HSM | Key files generated by a local CA script | Identity flow is real; key protection is not |
| KMS-held signing key | Key file loaded at startup | Same verification on the simulated device |
| Anycast and multi-region | One region | Failover rebuild path exercised by a manual "rebuild window" admin action |
| Real devices | Simulator with fault injection | Faults are reproducible, which is better for learning |

### What will be omitted

- Firmware OTA binaries and CDN distribution
- Multi-region replication and DNS failover
- Tiered storage of old ClickHouse partitions to object storage
- SCADA protocol adapters and real grid hardware
- Kubernetes and autoscaling
- Anomaly detection beyond static threshold alerts
