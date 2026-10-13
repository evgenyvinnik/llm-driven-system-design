# Fleet Telemetry and Command Dispatch - System Design Answer (Backend Focus)

*60-minute system design interview format - Backend Engineer Position*

## 🎯 Introduction (2 minutes)

"Thanks. I'll design the backend for monitoring and controlling about a million grid-edge devices (smart inverters, battery controllers, feeder sensors) that talk to us over the public internet: cellular modems and customer broadband. Four things make this hard, and none of them is raw throughput. Devices go offline and come back with hours of buffered readings, so data arrives late, out of order and duplicated. Seven years of firmware are in the field, so the same quantity shows up under different names and units. Operators need to send commands to devices that may not be connected when the command is issued. And everything crosses an untrusted network. I'll spend most of the time on idempotent ingestion, late data and aggregate correction, and command dispatch, then cover the metric-name registry, security, and what breaks first."

---

## 📋 Requirements Clarification (4 minutes)

### Questions I'd ask

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Monitoring or protection? | Protection needs millisecond local loops; monitoring tolerates seconds | Monitoring and operator control. Relays trip locally; we are not in that loop |
| How long can devices be offline? | Sets the device buffer and the late-data horizon | Buffer 7 days on flash; accept readings up to 30 days old |
| Can we change device firmware? | Decides whether we can add sequence numbers | Yes for new firmware, but old firmware stays in the field for years |
| What commands exist? | Imperative versus declarative changes delivery semantics | Setpoints (export limit), curtailment, reboot, diagnostics, firmware update trigger |
| Who consumes the aggregates? | Revisions matter if someone acts on them | Dashboards, alerting, and daily energy reports that feed settlement |
| Multi-region? | Changes the dedup story under failover | Two regions, active/standby per device |

### Functional Requirements

1. Devices upload telemetry batches, including multi-hour backlogs after an outage
2. Each reading is counted exactly once even when uploads are retried or re-chunked
3. Raw points and rollups are bucketed by event time; late data corrects past aggregates, and each aggregate exposes completeness and a revision count
4. A metric-name registry maps names from every firmware version to canonical metrics with unit conversion
5. A device shadow holds desired and reported state; commands have TTLs, acknowledgements and reconciliation
6. Fleet status (online, backfilling, stale, offline) by region, substation and feeder

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Durability | Zero loss of acknowledged readings |
| Correctness | Duplicates never double-count an aggregate |
| Ingest availability | 99.95% (devices buffer, so an outage costs freshness, not data) |
| Freshness | Receipt to queryable p95 < 10 s; online reading to dashboard p95 < 75 s |
| Command delivery | Online device p95 < 2 s; never executed after its TTL; never executed twice |

> "The device buffer is my availability budget. If ingestion is down for an hour, no data is lost, only freshness. That lets me spend complexity on correctness instead of on five nines for the gateway."

---

## 📊 Capacity Estimation (3 minutes)

Assume 1 million devices, a reading every 10 seconds with 20 metrics each, uploads every 60 seconds while online, and about 200 bytes per reading on the wire.

| Quantity | Calculation | Result |
|----------|-------------|--------|
| Readings/s | 1M / 10 s | 100,000/s |
| Points/s | 100,000 × 20 | 2,000,000/s |
| Upload requests/s | 1M / 60 s | ~16,700/s |
| Ingest bandwidth | 100,000 × 200 B | 20 MB/s |
| Points/day | 2M × 86,400 | 172.8 billion |
| Raw storage | 172.8B × ~3 B compressed | ~518 GB/day, ~15.6 TB for 30 days |
| Kafka, 7 days | 20 MB/s × 604,800 s | ~12.1 TB per replica, ~36 TB at RF 3 |
| Device buffer, 7 days | 60,480 readings × 200 B | ~12.1 MB per device |
| Shadows | 1M × ~2 KB | ~2 GB, fits one PostgreSQL primary |
| Commands | ~5 per device per day | ~58/s average |

**The sizing case is the reconnect storm, not the steady state.** A regional cellular outage takes 200,000 devices (20% of the fleet) offline for 6 hours. Each comes back with 6 × 360 = 2,160 readings, so the backlog is 432M readings, about 86.4 GB. If every device dumped its buffer within 10 minutes, that's 720,000 readings/s: 7.2× steady state, 144 MB/s. Assuming ClickHouse sustains about 1M narrow rows/s per shard, I size storage at four shards (4M points/s, 2× steady). The headroom left for backlog is 2M points/s, which is 100,000 readings/s, so a paced backlog drains in 432M / 100,000 = 4,320 s, or 72 minutes. Reconnects with jittered backoff over 5 minutes cost about 667 TLS handshakes/s.

> "Storage, not the gateway, sets the pace. The design question is how to make 200,000 devices wait politely while live data stays fresh."

---

## 🏗️ High-Level Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ DEVICES (1M) · flash ring buffer · per-device seq · outbound connections only│
└──────────────┬────────────────────────────────────────────────▲──────────────┘
               │ HTTPS batches (mTLS)                           │ MQTT (mTLS)
               ▼                                                ▼
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│ Ingest gateway (stateless)   │                 │ MQTT brokers (12 nodes)      │
│ cert → device_id · validate  │                 │ presence · deltas · commands │
│ rate limit · route by age    │                 └──────────────▲───────────────┘
└──────┬───────────────┬───────┘                                │
       │ live          │ backfill                               ▼
       ▼               ▼                         ┌──────────────────────────────┐
┌──────────────────────────────┐                 │ Command and shadow service   │
│ Kafka (keyed by device_id)   │                 │ TTL · seq · sign · reconcile │
│ telemetry.live · .backfill   │                 └──────────────┬───────────────┘
└──────────────┬───────────────┘                                ▼
               ▼                                 ┌──────────────────────────────┐
┌──────────────────────────────┐   registry      │ PostgreSQL                   │
│ Stream processor (by device) │◀── snapshots ───│ devices · shadows · commands │
│ dedup → normalize → clock    │                 │ metric registry              │
│ → watermark → dirty marks    │                 └──────────────────────────────┘
└──────┬────────────────┬──────┘
       ▼                ▼
┌──────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ ClickHouse   │ │ Revision tracker │ │ Redis: presence, │
│ raw + rollup │ │ alerts · exports │ │ status counters  │
│ states       │ │ · dashboards     │ └────────┬─────────┘
└──────┬───────┘ └────────┬─────────┘          │
       └──────────────────┴──────────┬─────────┘
                                     ▼
                   ┌──────────────────────────────────┐
                   │ Operator API + SSE → dashboard   │
                   └──────────────────────────────────┘
```

> "There are two planes. The data plane is bulk and request/response shaped: the device needs an answer that says 'these readings are durable, you may delete them'. The control plane needs the opposite: the server pushes to a device behind carrier NAT within seconds, which only works over a connection the device opened. So telemetry goes over HTTPS batches and commands go over a persistent MQTT session."

| Component | Responsibility | Why this choice |
|-----------|----------------|-----------------|
| Ingest gateway | mTLS identity, validation, rate limiting, routing live versus backfill | Stateless, scales on request rate, standard HTTP backpressure |
| Kafka | Durable buffer between devices and storage, partitioned by device | 7 days of replay; one consumer owns each device's state |
| Stream processor | Dedup, normalize names, check clocks, watermark, emit dirty marks | Keyed state per device without locks |
| ClickHouse | Raw points (30 days) and mergeable rollup states | Columnar compression, materialized views at insert |
| Revision tracker | Turns late data into revision events | Alerts, exports and dashboards learn what changed |
| Command service | Commands, shadows, TTL sweeper, reconciliation | Authoritative lifecycle in PostgreSQL |
| MQTT brokers | Connection fan-in, presence via last-will, delivery | Transport only; not the command queue |

**Why not everything over MQTT?** One connection per device is cheaper on radio and battery. But a QoS 1 PUBACK only proves the broker received the message, so the ack the device deletes data on would not mean durable unless the broker-to-Kafka bridge is synchronous. A 2,160-reading backlog drained over the same session would also put a curtailment command behind it. The cost of the split is two protocols in firmware; TLS session resumption keeps the HTTPS side cheap.

---

## 💾 Data Model (4 minutes)

### Control plane (PostgreSQL)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| devices | device_id (PK, equals cert subject), model, firmware_version, feeder_id, current_epoch, next_command_seq | feeder_id (active only), firmware_version | epoch bumps on factory reset |
| device_certificates | fingerprint (PK), device_id, not_after, revoked_at | device_id; partial on revoked | Mirrored to gateways as a revocation set |
| device_shadows | device_id (PK), desired, desired_version, reported, reported_applied_version, sync_state | partial on sync_state ≠ in_sync | sync_state: in_sync, pending, drifted, conflict |
| commands | command_id (PK), device_id, seq, kind, payload, status, expires_at, idempotency_key, signature | unique (device_id, seq); unique (operator, idempotency_key); partial on queued/sent | 30 days hot, then archived |
| command_jobs | job_id, selector, ttl, dispatch_rate, created_by, approved_by | — | approver must differ from creator |
| metric_definitions | metric_id, canonical_name (unique), unit, valid range | — | metric_id 0 means unmapped |
| metric_aliases | raw_name, schema_version range, metric_id, scale, offset, status | exclusion: no two active aliases overlap on (raw_name, range) | The key includes the version range |
| unmapped_metric_names | (raw_name, schema_version), points_24h, device_count, sample values | partial on unresolved, by volume | The admin's work queue |

### Telemetry (ClickHouse)

| Table | Key Columns | Sort Key | Notes |
|-------|-------------|----------|-------|
| telemetry_points | device_id, epoch, seq, event_time, raw_name, raw_value, metric_id, value, registry_version | (device_id, event_time, epoch, seq, raw_name) | Replacing engine versioned by registry_version; 30-day TTL |
| rollup_device_5m / 1h | metric_id, device_id, bucket, min/max/sum/count/last states | (metric_id, device_id, bucket) | Aggregating engine; fed by a materialized view |
| rollup_feeder_1m | metric_id, feeder_id, bucket, states incl. count | (metric_id, feeder_id, bucket) | completeness = count / (expected devices × 6) |
| bucket_revisions | scope, metric_group, hour, revision, reason | (scope, metric_group, hour) | One row per revised feeder-hour |

> "Raw points sort by device first because the raw query is 'this device, this time range'. Rollups sort by metric first because fleet questions are 'this metric across feeders'. The metric is not in the raw sort key on purpose: re-normalization can change a point's metric, and a replacing engine only replaces rows with the same key."

---

## 🔌 API Design (2 minutes)

```
Device-facing (mTLS; device_id comes from the certificate)
POST /device/v1/telemetry:batch         → accepted seq ranges, committed_through, next_upload_after_ms
GET  /device/v1/ingest-cursor           → epoch + committed_through, to resume after a lost response
GET  /device/v1/commands?after_seq=N    → pending commands (fallback when MQTT is blocked)
POST /device/v1/commands/:id/ack        → delivered | succeeded | failed | rejected
POST /device/v1/shadow/reported         → reported state + applied desired_version + executed log

Operator-facing (session auth)
GET   /api/v1/fleet/summary?group_by=feeder      → status counts per group
GET   /api/v1/aggregates?scope=&metric=&from=&to= → buckets with completeness and revision
PATCH /api/v1/devices/:id/shadow/desired          → If-Match desired_version; creates a command
POST  /api/v1/devices/:id/commands                → Idempotency-Key; returns status queued
POST  /api/v1/command-jobs                        → fleet job, needs a second approver
POST  /api/v1/admin/registry/aliases?dry_run=true → impact preview before publishing
```

---

## 🔧 Deep Dive 1: Idempotent Ingestion of Buffered Batches (8 minutes)

### The protocol

1. Every reading gets a sequence number from a per-device counter persisted on flash with the reading. The batch header carries the device's `epoch`, `oldest_buffered_seq`, `schema_version`, `device_now` and `buffer_depth`.
2. On reconnect, the device sends the newest minute first so the dashboard turns live, then drains the backlog oldest-first, up to 360 readings per batch.
3. The gateway takes device_id from the certificate, validates bounds (no event time more than 5 minutes in the future or 30 days in the past), and routes the batch to `telemetry.live` if its oldest reading is under 5 minutes old, otherwise to `telemetry.backfill`.
4. It waits for Kafka acks=all, then returns the accepted ranges plus `next_upload_after_ms`. The device frees exactly those ranges.
5. If the response is lost, the device re-sends. Duplicates are removed downstream, not at the gateway.
6. In the stream processor, keyed state per (device_id, epoch) holds a contiguous high-water mark and a small set of seqs seen above it. A reading at or below the mark, or already in the set, is dropped and counted.
7. After each batch the mark advances to at least `oldest_buffered_seq − 1`, because the device has promised never to resend anything older. Seqs that were skipped this way are counted as data loss (buffer overflow), not left waiting forever.
8. The ClickHouse sink inserts with a deduplication token derived from (partition, offset range), so a retried insert is a no-op.

### The trade-off: per-reading dedup in a keyed stage vs batch-id dedup at the gateway

**Decision:** I dedup each reading on (device_id, epoch, seq) in a stream stage partitioned by device, rather than deduplicating batches by id at the edge.

**Why it works here:** a sequence number belongs to a reading, so it survives anything the device does to batch boundaries. Partitioning Kafka by device_id makes one consumer the only writer of each device's state, so there are no races and no locks. The state is tiny: a high-water mark plus a sparse set, about 64 bytes per device in steady state, or around 64 MB for the fleet. The `oldest_buffered_seq` promise is what keeps the set bounded. Without it, one reading lost to buffer overflow would leave a permanent gap above the mark, and every later seq would sit in the set forever.

**How batch-id dedup breaks:** devices re-chunk their buffers all the time. After a reboot, the device rebuilds batches from flash with different boundaries. A `413` forces a smaller batch size. Live-first ordering puts the newest minute ahead of a backlog it was part of a moment earlier. In each case the same reading arrives inside a batch with a new id, the gateway sees a new batch, and the reading is counted twice. Moving reading-level dedup to the gateway with a shared Redis set is the other option: it puts a network round trip and a write for each of 172.8 billion points a day on the hot path, and two gateway nodes handling a retry and its original concurrently can both see "not seen".

**What I give up:** keyed state that must be checkpointed atomically with Kafka offsets; a dependency on firmware persisting its counter correctly; and trust in the device's `oldest_buffered_seq` claim. A device that lies loses its own data, but it cannot corrupt anyone else's.

| Approach | Survives re-chunking | Hot-path cost | Race-free |
|----------|----------------------|---------------|-----------|
| ✅ Per-reading seq in device-partitioned stream state | Yes | In-memory lookup | Yes, single owner |
| ❌ Batch id at the gateway | No | Small | Yes |
| ❌ Per-reading seq in shared Redis at the gateway | Yes | Round trip per reading | No, without Lua or locks |
| ❌ Rely on storage-level replacing merges only | Yes, eventually | None | Yes, but rollups double count |

> "That last row is the subtle one. A replacing engine deduplicates raw rows at merge time, eventually. But materialized-view rollups compute their states at insert time, so a duplicate that reaches storage has already been added to a sum. Storage dedup is my backstop, not my mechanism."

### The epoch

If a device is factory-reset, its counter restarts at 1, and every new reading would look like a duplicate of something old and be silently dropped. The epoch, stored at provisioning and bumped on reset, makes the key (device_id, epoch, seq). A new epoch starts fresh state, and the old epoch's state is kept for 30 days so late uploads from before the reset still dedup correctly.

### Backpressure in the storm

The gateway answers every upload with `next_upload_after_ms`, computed from current backfill consumer lag against the 100,000 readings/s budget. Devices that are behind wait longer; a device whose batch was live gets 60 seconds as usual. Because live and backfill use separate topics, and the live consumers have priority, an hour of backlog in Kafka never delays the dashboard. The device buffer remains the queue of last resort: if Kafka is down, the gateway's circuit breaker returns 503 and devices keep buffering.

---

## 🔧 Deep Dive 2: Event Time, Watermarks and Late-Data Correction (8 minutes)

### Two clocks

Every reading has an **event time** (when the device measured it) and a **processing time** (when we received it). Dashboards, energy totals and alerts care about event time. Freshness SLOs care about processing time. I store both, and I record the gap as a lateness histogram, because it's the best single health signal for the fleet's connectivity.

Device clocks lie. The header's `device_now` against receipt time gives a skew estimate per batch. Past ±60 s I flag the batch as clock-suspect, and future-dated readings beyond 5 minutes are quarantined. For the watermark, a device's event times are clamped to receipt time, so one device with a fast clock cannot drag the watermark forward and make everyone else look late.

### The watermark's job

The watermark on the live topics is the minimum over partitions of the maximum clamped event time, minus 2 minutes. A 1-minute bucket provisionally closes when the watermark passes its end. That close is when I evaluate alert rules and publish the bucket as provisional. A reading that arrives after its bucket closed is **late**. Everything on the backfill topic is late by definition.

### The trade-off: mergeable rollups plus a revision ledger vs dropping or waiting

**Decision:** rollups are stored as mergeable aggregate states (sum, count, min, max, last-by-time), so a late reading is just another insert. The watermark decides when to *act* on a bucket, not whether the bucket can still change.

**Why it works here:** a late reading for 08:06 inserts one more partial state for the 08:05 bucket, and the engine merges it with the existing states in the background. Order does not matter because the merge is commutative and associative. No job has to find and rewrite the old row. In parallel, the processor emits a coarse dirty mark for (feeder, hour, metric group). The revision tracker coalesces marks every 10 seconds, bumps the revision counter, and tells three consumers: dashboards showing that range refetch it, the alert re-evaluator opens a *retrospective* incident if the revised bucket would have breached a rule (it doesn't page anyone for history), and the export consumer re-issues the affected daily report with a revision number.

**How the alternatives break:**

- **Drop after an allowed-lateness window** (the stream-processor default). An inverter that was offline for six hours during a storm holds exactly the data the fault analysis needs. Dropping it makes that feeder's energy total permanently wrong, and settlement inherits the error.
- **Hold the window open until every device reports.** One dead device holds its feeder's buckets open forever, so the dashboard never shows a number. A per-feeder watermark computed as the minimum over devices has the same problem in another form.
- **Recompute everything nightly.** Simple and correct by morning, but operators stare at wrong numbers for up to 24 hours, including during the storm, which is exactly when they need the numbers.

**What I give up:** numbers on the screen change after the fact. Every bucket the API returns carries completeness and a revision count, so the UI can say "82% complete, provisional" and later "revised 3 times". Non-mergeable consumers need explicit revision handling. And a *corrective* change, such as a wrong unit conversion, can't be fixed by adding states; it needs a rebuild of the affected buckets from deduplicated raw points.

| Approach | Late storm data | Dashboard latency | Complexity |
|----------|-----------------|-------------------|------------|
| ✅ Mergeable states + coarse revision ledger | Corrects history | Provisional in ~2 min | Revision consumers |
| ❌ Drop after allowed lateness | Lost forever | ~2 min | Low |
| ❌ Wait for all devices | Correct | Unbounded | Low |
| ❌ Nightly batch recompute | Correct next day | Up to 24 h wrong | Low |

### Why the dirty marks are coarse

During the storm, device-level marks would be 200,000 devices × 360 minutes × 20 metrics = 1.44 billion entries. Feeder-hour marks are 2,000 feeders × 6 hours = 12,000. Device-level queries don't need marks at all, because they read the merged states directly. Marks exist for consumers that act on shared aggregates.

### Completeness

For a feeder bucket, expected samples = active devices on the feeder × 6 readings per minute, using the feeder's membership at that hour. Completeness = merged count / expected. It mixes "half the devices" with "half the samples from every device", which I accept: either way the operator should not trust the number yet.

---

## 🔧 Deep Dive 3: Command Dispatch to Intermittently Connected Devices (8 minutes)

### Two kinds of change

**Declarative** changes go through the device shadow: an operator sets desired state ("export limit 5 kW") with a version, and the device converges and reports back. **Imperative** commands (reboot, run a diagnostic, start a firmware update) are one-shot and ordered. Both are rows in PostgreSQL with a per-device seq, a TTL, a status and a signature.

### The lifecycle

```
queued ──▶ sent ──▶ delivered ──▶ succeeded | failed | rejected
   │         │
   │         └──▶ expired (unconfirmed) ──▶ corrected if the device's log shows it ran in time
   ├──▶ expired       (TTL passed while the device was offline)
   ├──▶ superseded    (a newer desired value for the same key replaced it)
   └──▶ cancelled     (operator)
```

1. In one transaction the service allocates the device's next seq, inserts the command with expires_at = now + TTL, signs (command_id, device_id, seq, payload hash, expires_at), and marks older queued desired-state commands for the same key as superseded.
2. If the device is online, the dispatcher publishes over MQTT at QoS 1 and marks it sent. If not, the command waits. A connect event, or a pending-command hint in an HTTPS upload response, triggers dispatch of everything unexpired in seq order.
3. The device verifies the signature, checks expiry, persists the command id, and acks delivered. After executing, it reports the outcome.
4. A sweeper expires queued commands past their deadline, and marks sent-but-unacked ones as expired and unconfirmed.

### TTL is a deadline to start, not a duration

"Curtail to 50% for 15 minutes" has two clocks. The **TTL** says the command must *start* within, say, 15 minutes, or it is pointless: a curtailment issued for an afternoon peak must not execute at 9 p.m. The **duration** says how long the effect lasts, and the device itself reverts when it ends. That matters because the server cannot reach a disconnected device to undo a curtailment; if the revert lived on the server, a device that dropped off mid-curtailment would stay curtailed indefinitely. For the TTL, the device checks both the absolute expires_at (if its clock is synced) and a relative ttl_remaining measured from receipt, so a device with a wrong clock still can't run a stale command.

### The trade-off: commands in our database vs the broker's persistent session queue

**Decision:** PostgreSQL holds the authoritative command and shadow state; the MQTT broker is transport only.

**Why it works here:** the questions operators ask are relational. Which commands are pending on feeder 12? Did the old export limit get superseded? Which commands expired without confirmation? Was this approved by a second person? A table with a status column answers all of them and gives an audit trail. Supersession is a domain rule: only the latest desired value for a key matters, so if an operator sets 5 kW and then 3 kW while the device is offline, the device should only ever receive 3 kW.

**How the broker queue breaks:** MQTT 5 can expire queued messages after an interval, but it can't express "the newer export limit replaces the older one", so a reconnecting device would replay a stale chain of setpoints. Its queue is per session and opaque, so there's no way to list pending commands for a feeder. Unless the broker cluster replicates sessions, a broker failover loses the queue, and the device reconnects to a node that never heard of its commands.

**What I give up:** the dispatcher must react to presence events to push queued commands on connect, so command latency for a reconnecting device depends on the presence pipeline (typically under a second). And there's one more system that must agree with the device about what happened, which is the next point.

| Approach | Supersession | Pending visibility | Survives broker failover |
|----------|--------------|--------------------|--------------------------|
| ✅ PostgreSQL commands + shadow, broker as transport | Yes | Query by any dimension | Yes |
| ❌ MQTT persistent session queue | No | None | Only with replicated sessions |
| ❌ Piggyback commands on telemetry responses only | Yes | Yes | Yes, but up to 60 s latency |

### Acknowledgements and reconciliation

There are three acks and they mean different things. The QoS 1 PUBACK means the broker got it. **Delivered** means the device persisted the command id. **Succeeded, failed or rejected** is the outcome. The device keeps its executed command ids and highest executed seq, so a re-delivery is re-acked rather than re-run, which gives at-most-once execution.

On every connect the device publishes its reported state, the desired version it last applied, and its last 50 executed command ids with results. Reconciliation then:

1. sends the shadow delta if desired_version is greater than reported_applied_version
2. resolves unconfirmed commands from the executed log (expired-unconfirmed becomes succeeded if it ran before the deadline)
3. every 5 minutes, re-pushes deltas to devices online for over 2 minutes that are still behind, and after 3 attempts marks the shadow drifted and alerts
4. marks a local override (a technician changed the setting on site) as a conflict instead of fighting it, because a local safety override wins until an operator decides

### Fleet jobs

"Curtail every inverter in the west region" is a job: a selector, a template, a dispatch rate and a second approver. It fans out into per-device commands at about 2,000/s, so 20,000 devices take about 10 seconds, and the job shows counts by status. Offline devices get the command if they reconnect within the TTL. Otherwise it expires and appears in the job's expired count.

---

## 🧬 Schema Drift: The Metric-Name Registry (4 minutes)

Old firmware sends `P_ac` in watts, a later version sends `pwr` in kilowatts, and the current one sends `ac_power` in kilowatts. Worse, `temp` meant °F in schema 1 and °C in schema 4. So an alias maps (raw_name, schema-version range) to a canonical metric with a scale and offset, and an exclusion constraint makes it impossible for two active aliases to claim the same name for overlapping versions.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Normalize at ingestion, keep raw name and value, re-normalize on change | Rollups per canonical metric; fast queries; mistakes stay fixable | ~50% more bytes per point; re-normalization jobs compete for inserts |
| ❌ Normalize only at query time | Retroactive by default | Every query unions aliases and converts units; per-metric rollups impossible; every consumer embeds the registry |
| ❌ Normalize at ingestion, discard raw | Smallest storage | A wrong °F/°C mapping is unrecoverable |

> "Query-time normalization sounds flexible, but my fleet dashboard is built on rollups keyed by canonical metric. If the mapping only exists at query time, I can't precompute 'AC power by feeder', and every fleet query scans raw points across three names and two units."

**Unknown names** are stored with metric_id 0 and counted in an unmapped-names queue with volume, device count, firmware versions and sample values. An admin maps one with a dry run first (affected points, devices and buckets), then publishes a new registry version. Processors receive the full snapshot through a compacted topic, swap it atomically, and stamp registry_version on every point.

**Re-normalization** reuses the late-data machinery. If the change is additive (a previously unmapped name now maps), the job inserts normalized points for the last 30 days and the rollups add states, exactly like late data. If it's corrective (a conversion was wrong), the job re-inserts points with a higher registry_version, which the replacing engine keeps, and rebuilds the affected rollup buckets, because adding a corrected state on top of a wrong one would double count. Either way, dirty marks tell dashboards and exports that history was revised.

---

## 🔐 Security Over the Public Internet (2 minutes)

- **Device identity:** an X.509 certificate per device, with the private key generated inside a secure element at manufacture and never exported. The gateway and broker derive device_id from the certificate; a device_id in a payload is ignored.
- **Revocation:** revoked fingerprints are mirrored to a Redis set that gateways and brokers poll every 60 seconds, and revocation force-disconnects live sessions. That's faster than distributing CRLs to a million clients.
- **Broker ACLs:** a device can only publish and subscribe under its own topic prefix.
- **Signed commands:** an Ed25519 key in KMS signs every command, and the device verifies against a pinned public key, so a compromised broker cannot issue commands. A seq at or below the last executed one is rejected, which stops replays.
- **Operators:** session auth, role-scoped by region; critical commands and large jobs need a second approver.
- **Abuse:** per-device token bucket on ingest (1 batch/s sustained, burst 5, 512 KB maximum batch), so a compromised device can't flood the pipeline.
- **Unreliable links:** TLS 1.3 session resumption, MQTT keepalive at 60 s (shorter than typical carrier NAT idle timeouts), and reconnect backoff with full jitter (base 1 s, cap 5 minutes).

---

## 🛡️ Failure Handling (2 minutes)

| Failure | Behavior |
|---------|----------|
| Kafka down | Gateway breaker returns 503; devices keep buffering; nothing acked is lost |
| ClickHouse slow | Processor backpressures; Kafka holds 7 days; live lag pages |
| Processor crash | Restore keyed state with offsets from the checkpoint; sink retries reuse dedup tokens |
| Broker node lost | ~100,000 devices reconnect elsewhere with jitter; queued commands dispatch on connect |
| PostgreSQL failover | Command creation returns 503 for ~30 s; telemetry unaffected |
| Region failover | Readings acked but not yet mirrored may be re-sent; rollups for the failover window are rebuilt from raw and marked revised |

---

## 📈 Scalability: What Breaks First (3 minutes)

1. **Storage inserts during a reconnect storm.** Unpaced, 720,000 readings/s (14.4M points/s) hits a tier sized for 4M points/s. Pacing via next_upload_after_ms and the separate backfill topic keep live data fresh while the backlog drains in about 72 minutes.
2. **Live data stuck behind backfill.** With one topic, live readings for every device in a partition queue behind the backlog. The topic split and live-first device ordering prevent it.
3. **Presence churn.** Flapping cellular links produce connect/disconnect pairs. A 30-second hysteresis and per-feeder counters, with a full recount every 5 minutes, keep the status counts stable.

**At 10× (10 million devices):** 20M points/s needs about 40 shards for the same 2× headroom; presence heartbeats grow to about 167,000/s and need a Redis cluster; shadows reach about 20 GB and command volume justifies sharding PostgreSQL by device. Before adding shards, I'd push edge aggregation: devices send 1-minute summaries for slow-moving metrics like temperature and keep 10-second raw only for power and voltage.

---

## ❓ Follow-up Questions (3 minutes)

**"The ack was lost. What happens?"** The device re-sends the same readings, perhaps in a different batch shape. The gateway writes them to Kafka again; the processor drops them by (device_id, epoch, seq). The device can also call the ingest cursor endpoint first to skip readings that already landed, which saves cellular data.

**"A device's clock is off by an hour."** The header skew check flags the batch; future-dated readings are quarantined; the watermark uses event times clamped to receipt time, so the bad clock doesn't move it. Commands carry a relative TTL, so an unsynced device still won't run a stale command.

**"An old client sends a metric name you've never seen."** The point is stored with metric_id 0 and appears in the unmapped queue with samples and firmware versions. Once mapped, a 30-day re-normalization brings its history into the rollups as an ordinary revision.

**"A data center goes down."** Devices fail over by DNS and anycast to the standby region. Dedup state there doesn't know about readings acked in the failed region but not yet mirrored, so some arrive twice. Raw storage collapses them, and rollups for the failover window are rebuilt from deduplicated raw points and published as revisions.

**"How do you know data is complete?"** Each bucket carries completeness against expected devices for that hour. Separately, devices report buffer_depth, so fleet backlog tells us how much data is still sitting on devices, and gaps behind the high-water mark are counted as permanent loss.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ Transport | HTTPS batches + MQTT control | ❌ All MQTT | Durable ack and backpressure; commands not stuck behind backfill |
| ✅ Dedup key | (device_id, epoch, seq) per reading | ❌ Batch id | Devices re-chunk; batch ids double count |
| ✅ Dedup location | Device-partitioned stream state | ❌ Shared Redis at gateway | Single owner, no hot-path round trip |
| ✅ Late data | Mergeable states + revisions | ❌ Drop after allowed lateness | Storm data is what operators need |
| ✅ Revision marks | (feeder, hour, metric group) | ❌ (device, minute, metric) | 12,000 marks instead of 1.44 billion |
| ✅ Live vs backfill | Separate topics, live-first order | ❌ One topic | Backlog never delays live data |
| ✅ Schema drift | Normalize at ingest, keep raw | ❌ Query-time only | Rollups stay possible; mistakes stay fixable |
| ✅ Commands | PostgreSQL lifecycle, broker as transport | ❌ Broker session queue | Supersession, visibility, audit |
| ✅ TTL enforcement | Server at send + device absolute and relative | ❌ Server only | Late delivery still can't run late |
| ✅ Identity | mTLS with secure-element keys | ❌ API tokens | Nothing exportable to leak |

---

## 📝 Summary

> "To summarize: devices are the queue. They buffer seven days on flash, number every reading, and free it only when we say it's durable. The gateway is stateless and routes by age so backlog never sits in front of live data, and it paces a reconnect storm to what storage can absorb. Dedup happens per reading in a stream stage partitioned by device, because batch ids don't survive re-chunking and storage-level dedup comes too late for rollups. Rollups are mergeable states, so late data is an insert, and the watermark only decides when to act, with completeness and revision counts making provisional numbers honest. The metric registry normalizes at ingestion but keeps raw data, so a mapping mistake becomes a re-normalization that reuses the late-data path. Commands live in PostgreSQL with sequence numbers, TTLs that bound when they may start, device-side reverts for durations, signatures, and reconciliation from the device's own executed log. The hardest part is not throughput; it's agreeing with a million unreliable devices about what happened, and every piece of this design is a way of making that agreement explicit."
