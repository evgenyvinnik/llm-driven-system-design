# AirTag - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Introduction

**Interviewer prompt:** "Design the backend infrastructure for AirTag, Apple's item tracking system that uses a crowd-sourced network of billions of Apple devices to locate lost items."

**Candidate response:**

"This is a fascinating privacy-first system design challenge. AirTag relies on a global mesh of 1 billion+ Apple devices to detect lost items, but the critical constraint is that Apple itself cannot see where items are located. The backend must store encrypted location reports, serve them to owners for local decryption, and detect stalking patterns - all while maintaining zero-knowledge of actual locations.

Let me walk through the key backend challenges:
1. Privacy-preserving storage where Apple cannot decrypt locations
2. High-volume ingestion of 100K+ encrypted reports per second
3. Key rotation and identifier management at scale
4. Anti-stalking detection with real-time pattern analysis
5. Exactly-once semantics to prevent duplicate reports"

---

## 🎯 Requirements

### Functional Requirements

| Priority | Requirement | Description |
|----------|-------------|-------------|
| P0 | Report Ingestion | Receive encrypted location reports from Find My network devices |
| P0 | Location Queries | Serve encrypted blobs to device owners for local decryption |
| P1 | Anti-Stalking | Detect unknown trackers following users |
| P1 | Lost Mode | Store and serve contact information for found devices |
| P2 | Notifications | Alert users when devices are found or unknown trackers detected |

### Non-Functional Requirements

| Metric | Target | Rationale |
|--------|--------|-----------|
| Privacy | End-to-end encryption | Apple cannot decrypt locations |
| Throughput | 100K+ reports/second | Global device network |
| Ingestion Latency | < 50ms | Real-time location updates |
| Query Latency | < 100ms | Responsive Find My app |
| Retention | 7 days | Balance findability vs storage |

### Scale Estimates

"Let me do some back-of-envelope math:"

- 1 billion+ Apple devices in Find My network
- ~100M active AirTags generating ~1B reports/day
- Key rotation every 15 minutes = 96 periods per day
- Each encrypted report: ~1KB
- Daily storage: ~1TB of encrypted reports

---

## 🏗️ High-Level Design

"Let me draw the main components:"

```
+-----------------------------------------------------------+
|              Find My Network (1B+ devices)                 |
|           (iPhones, iPads, Macs detect AirTags)           |
+-----------------------------------------------------------+
                           |
                           | Encrypted Reports
                           v
+-----------------------------------------------------------+
|                   API Gateway Layer                        |
|      (Rate limiting, validation, regional routing)        |
+-----------------------------------------------------------+
              |                              |
              v                              v
+------------------------+       +---------------------------+
|  Report Ingestion API  |       |  Location Query Service   |
|    (Express/Node.js)   |       |     (Express/Node.js)     |
+------------------------+       +---------------------------+
              |                              |
              v                              v
+------------------------+       +---------------------------+
|     Redis/Valkey       |       |       PostgreSQL          |
| - Idempotency (24h)    |       | - location_reports        |
| - Rate limiting        |       | - registered_devices      |
| - Query cache          |       | - notifications           |
+------------------------+       +---------------------------+
              |
              v
+-----------------------------------------------------------+
|                       RabbitMQ                             |
| - location.reports (ingestion workers)                     |
| - antistalk.analyze (pattern detection)                    |
| - notifications.push (alert delivery)                      |
+-----------------------------------------------------------+
              |
              v
+-----------------------------------------------------------+
|               Anti-Stalking Workers                        |
|    (Pattern analysis, alert generation)                    |
+-----------------------------------------------------------+
```

---

## 🔍 Deep Dive

### Privacy-Preserving Storage Architecture

"The core challenge is storing location reports without Apple being able to read them. Let me explain the schema design."

**Key Database Tables:**

| Table | Purpose | Key Fields |
|-------|---------|------------|
| location_reports | Encrypted location blobs | identifier_hash, encrypted_payload, created_at |
| registered_devices | User device ownership | user_id, device_id, master_secret_hash |
| tracker_sightings | Anti-stalking data | user_id, identifier_hash, lat, lon, seen_at |
| notifications | User alerts | user_id, type, message, data |

**Encrypted Payload Contents (only owner can decrypt):**
- Latitude/longitude coordinates
- Accuracy radius in meters
- Timestamp of detection
- Reporter device region (coarse)

---

### Why No Foreign Key from Reports to Devices?

| Approach | Pros | Cons |
|----------|------|------|
| **No FK (chosen)** | Privacy by design, zero-knowledge, supports key rotation | Cannot query "all reports for device X" server-side |
| FK to devices | Easier queries, referential integrity | Server can correlate reports to devices, breaks privacy model |

**Decision: No Foreign Key**

"I'm choosing no foreign key because the entire privacy model depends on the server not knowing which reports belong to which device. The identifier_hash changes every 15 minutes due to key rotation, and only the device owner can derive which hashes belong to their AirTag. If we had a foreign key, Apple could trivially track any AirTag's location history - defeating the entire privacy design."

---

### Why JSONB for Encrypted Payloads Over Normalized Columns?

| Approach | Pros | Cons |
|----------|------|------|
| **JSONB (chosen)** | Schema flexibility, encryption format can evolve, no parsing needed | Slightly larger storage, no column-level indexing |
| Normalized columns | Smaller storage, can index fields | Requires schema changes when format evolves, breaks abstraction |

**Decision: JSONB**

"I'm choosing JSONB because the encrypted payload is an opaque blob to the server anyway - we cannot index or query its contents since they're encrypted. Storing it as JSONB allows the encryption format to evolve (new fields, different ciphers) without database migrations. The payload contains: ephemeral public key, IV, ciphertext, and auth tag."

---

### Why Redis for Idempotency Over Database Unique Constraints?

| Approach | Pros | Cons |
|----------|------|------|
| **Redis SET NX (chosen)** | Sub-millisecond checks, auto-expiry via TTL, distributed | No durability, memory cost |
| DB unique constraint | Durable, no extra infrastructure | Slower (disk I/O), no auto-expiry, lock contention |

**Decision: Redis SET NX**

"I'm choosing Redis because idempotency checks happen on every single report submission - at 100K reports/second, we cannot afford disk I/O latency. The 24-hour TTL provides automatic cleanup, and if Redis loses data, the worst case is duplicate processing which the database can handle with ON CONFLICT DO NOTHING."

**Idempotency Key Generation:**
- Combine: identifier_hash + rounded_timestamp + payload_hash
- Round timestamp to minute to handle clock drift
- SHA-256 hash the combination
- Store in Redis with 24-hour TTL

---

### Why RabbitMQ Over Kafka for Report Processing?

| Approach | Pros | Cons |
|----------|------|------|
| **RabbitMQ (chosen)** | Simpler operations, built-in dead letter queues, per-message acks | Lower throughput ceiling (~50K/sec) |
| Kafka | Higher throughput (1M+/sec), replay capability, exactly-once semantics | More complex operations, requires Zookeeper, overkill for initial scale |

**Decision: RabbitMQ**

"I'm choosing RabbitMQ because our initial scale of 100K reports/second is well within RabbitMQ's capabilities, and the operational simplicity is valuable. The dead letter queue pattern handles failed messages gracefully, and per-message acknowledgments give us precise delivery guarantees. If we exceed 500K/second sustained, we'd migrate to Kafka."

---

### Why 15-Minute Cache TTL?

| Approach | Pros | Cons |
|----------|------|------|
| **15-minute TTL (chosen)** | Matches key rotation period, natural invalidation boundary | Slightly higher cache miss rate |
| Shorter TTL (5 min) | Fresher data | More database load, unnecessary refreshes |
| Longer TTL (1 hour) | Better cache hit rate | Stale data across rotation boundaries |

**Decision: 15-Minute TTL**

"I'm choosing a 15-minute cache TTL because it exactly matches the AirTag key rotation period. When a key rotates, the identifier hash changes, so cached data for old identifiers becomes irrelevant anyway. This creates a natural cache invalidation boundary without requiring explicit invalidation logic."

---

### Why PostgreSQL Over Cassandra for Location Reports?

| Approach | Pros | Cons |
|----------|------|------|
| **PostgreSQL (chosen)** | ACID transactions, familiar tooling, read replicas, JSON support | Write throughput ceiling (~100K/sec with partitioning) |
| Cassandra | Linear write scaling, built for time-series | Eventual consistency, more complex operations, no joins |

**Decision: PostgreSQL with Time-Based Partitioning**

"I'm choosing PostgreSQL because our write volume of 100K/second is achievable with partitioning and proper indexing. The 7-day retention with automatic partition dropping is straightforward. We need ACID guarantees for the anti-stalking detection system, and PostgreSQL's JSONB support handles encrypted payloads well. If writes exceed 200K/second, we'd consider Cassandra."

---

### Why Time-Based Partitioning for Reports?

| Approach | Pros | Cons |
|----------|------|------|
| **Time-based partitioning (chosen)** | Efficient retention cleanup, fast range queries, partition pruning | Requires partition management |
| Single table with DELETE | Simpler schema | Slow deletes, table bloat, index fragmentation |
| Hash partitioning | Even data distribution | Cannot efficiently drop old data |

**Decision: Daily Partitions with Auto-Drop**

"I'm choosing time-based partitioning because our primary access pattern is 'get reports for these identifiers in the last N hours' - which naturally aligns with time partitions. More importantly, our 7-day retention policy becomes a simple DROP PARTITION operation instead of massive DELETE queries that would cause table bloat and index fragmentation."

---

### Why Async Anti-Stalking Processing?

| Approach | Pros | Cons |
|----------|------|------|
| **Async via queue (chosen)** | Decoupled from ingestion, can scale independently, doesn't block writes | Slight delay in alerts |
| Synchronous processing | Immediate alerts | Blocks report ingestion, harder to scale, latency spikes |

**Decision: Async Processing**

"I'm choosing async processing because anti-stalking analysis is computationally expensive - it requires querying recent sightings, calculating distances, and detecting patterns. This work shouldn't block the hot path of report ingestion. A few seconds of delay in stalking alerts is acceptable; blocking 100K writes/second is not."

**Anti-Stalking Detection Algorithm:**
1. Track sightings per user per identifier_hash
2. Alert if: 3+ sightings AND (>500m traveled OR >1 hour together)
3. 1-hour cooldown between alerts per tracker
4. Queue push notification on alert

---

## 📊 Data Flow

### Report Ingestion Flow

```
+-------------+     +----------+     +-------+     +----------+
|  iPhone     |     |  API     |     | Redis |     | RabbitMQ |
|  (reporter) |     | Gateway  |     |       |     |          |
+------+------+     +----+-----+     +---+---+     +----+-----+
       |                 |               |              |
       | POST /report    |               |              |
       |---------------->|               |              |
       |                 | Check idem key|              |
       |                 |-------------->|              |
       |                 |    miss       |              |
       |                 |<--------------|              |
       |                 | Queue report  |              |
       |                 |----------------------------->|
       |   202 Accepted  |               |              |
       |<----------------|               |              |
       |                 |               |              |
```

```
+----------+     +------------+     +-------+     +----------+
| RabbitMQ |     |  Worker    |     | Redis |     | Postgres |
|          |     |            |     |       |     |          |
+----+-----+     +------+-----+     +---+---+     +----+-----+
     |                  |               |              |
     | Consume msg      |               |              |
     |----------------->|               |              |
     |                  | Set idem key  |              |
     |                  |-------------->|              |
     |                  | INSERT report |              |
     |                  |----------------------------->|
     |                  |     OK        |              |
     |                  |<-----------------------------|
     |        ACK       |               |              |
     |<-----------------|               |              |
     |                  |               |              |
```

### Location Query Flow

```
+-------------+     +----------+     +-------+     +----------+
|  Owner's    |     |  Query   |     | Redis |     | Postgres |
|  iPhone     |     | Service  |     | Cache |     |          |
+------+------+     +----+-----+     +---+---+     +----+-----+
       |                 |               |              |
       | Query hashes    |               |              |
       | [h1, h2, h3...] |               |              |
       |---------------->|               |              |
       |                 | Cache lookup  |              |
       |                 |-------------->|              |
       |                 |    miss       |              |
       |                 |<--------------|              |
       |                 | SELECT        |              |
       |                 |----------------------------->|
       |                 | encrypted     |              |
       |                 | blobs         |              |
       |                 |<-----------------------------|
       |                 | Cache result  |              |
       |                 |-------------->|              |
       | Encrypted blobs |               |              |
       |<----------------|               |              |
       |                 |               |              |
       | [Local decrypt] |               |              |
       | [Show on map]   |               |              |
```

### Anti-Stalking Detection Flow

```
+----------+     +------------+     +----------+     +-----------+
| RabbitMQ |     | AntiStalk  |     | Postgres |     | RabbitMQ  |
| (reports)|     |  Worker    |     |          |     | (notifs)  |
+----+-----+     +------+-----+     +----+-----+     +-----+-----+
     |                  |               |                  |
     | report.stored    |               |                  |
     |----------------->|               |                  |
     |                  | Get sightings |                  |
     |                  |-------------->|                  |
     |                  | Recent 3hrs   |                  |
     |                  |<--------------|                  |
     |                  |               |                  |
     |                  | [Analyze      |                  |
     |                  |  pattern]     |                  |
     |                  |               |                  |
     |                  | IF stalking:  |                  |
     |                  | INSERT alert  |                  |
     |                  |-------------->|                  |
     |                  | Queue push    |                  |
     |                  |----------------------------->|   |
     |        ACK       |               |                  |
     |<-----------------|               |                  |
```

---

## 📐 Scalability Strategy

### Horizontal Scaling

| Component | Strategy | Trigger |
|-----------|----------|---------|
| Report Ingestion API | Stateless, add instances behind LB | CPU > 70% |
| Location Query Service | Stateless, add instances behind LB | Latency > 50ms |
| Anti-Stalking Workers | Consumer groups, partition by user_id | Queue depth > 10K |
| PostgreSQL | Read replicas, time-based partitioning | Read latency > 20ms |
| Redis | Cluster mode, sharded by key prefix | Memory > 70% |
| RabbitMQ | Cluster with quorum queues | Queue depth > 500K |

### Regional Deployment

```
                    +------------------+
                    |   Global LB      |
                    |  (Anycast DNS)   |
                    +--------+---------+
                             |
        +--------------------+--------------------+
        |                    |                    |
        v                    v                    v
+---------------+    +---------------+    +---------------+
|   US-West     |    |   EU-West     |    |   AP-East     |
|    Region     |    |    Region     |    |    Region     |
+-------+-------+    +-------+-------+    +-------+-------+
        |                    |                    |
        +--------------------+--------------------+
                             |
                   Cross-Region Async
                      Replication
```

"Each region handles local traffic, with async replication for global queries. Reports are written to the nearest region, and owners can query globally."

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Key Rationale |
|----------|--------|-------------|---------------|
| No FK on reports | Privacy-first | FK to devices | Server cannot correlate reports to devices |
| JSONB payload | Schema flexibility | Normalized columns | Encryption format may evolve |
| Redis idempotency | Sub-ms checks | DB unique constraint | Cannot afford disk I/O at 100K/sec |
| RabbitMQ | Simpler ops | Kafka | Sufficient throughput, better DLQ support |
| 15-min cache TTL | Natural boundary | Shorter/longer TTL | Matches key rotation period |
| PostgreSQL | ACID + partitioning | Cassandra | Manageable scale, familiar tooling |
| Async anti-stalking | Decoupled | Synchronous | Don't block hot path |
| Time partitions | Easy retention | Single table | DROP vs DELETE for cleanup |

---

## 🚀 Future Enhancements

| Enhancement | Trigger | Description |
|-------------|---------|-------------|
| Kafka migration | > 500K reports/sec | Replace RabbitMQ for higher throughput |
| ClickHouse analytics | Growth analysis needs | Aggregate statistics without exposing locations |
| Global database | Multi-region consistency | CockroachDB or Spanner |
| ML anti-stalking | False positive complaints | Anomaly detection beyond rules |
| HSM integration | Security audit | Hardware security modules for key derivation |
| Bloom filters | Memory pressure | Probabilistic deduplication |

---

## 📝 Summary

"To summarize the AirTag backend design:

1. **Privacy is the foundation**: We store encrypted blobs that Apple cannot decrypt. No foreign keys link reports to devices. Only device owners can derive identifier hashes to query their locations.

2. **Scale through async processing**: Reports are accepted quickly via Redis idempotency checks, queued in RabbitMQ, and processed by background workers. This achieves 100K+/second throughput.

3. **Anti-stalking runs independently**: Pattern detection is decoupled from ingestion, allowing both systems to scale separately.

4. **Time-based partitioning**: Makes 7-day retention efficient - just drop old partitions instead of slow DELETE operations.

5. **15-minute boundaries everywhere**: Cache TTL, key rotation, and identifier changes all align to simplify the system.

The key insight is that privacy constraints actually simplify the backend - since we cannot see locations, we just store opaque blobs with content-derived keys. The complexity moves to client-side cryptography."

---

### Retention Policy Reference

| Data Type | Retention | Cleanup Method |
|-----------|-----------|----------------|
| Location reports | 7 days | DROP partition |
| Tracker sightings | 24 hours | Scheduled DELETE |
| Idempotency keys | 24 hours | Redis TTL expiry |
| Rate limit counters | 1 minute | Redis TTL expiry |
| Query cache | 15 minutes | Redis TTL expiry |

---

### Key Metrics to Monitor

| Metric | Alert Threshold | Meaning |
|--------|-----------------|---------|
| Report ingestion p95 | > 100ms | Ingestion bottleneck |
| Queue depth (reports) | > 100K | Workers falling behind |
| Queue depth (antistalk) | > 10K | Analysis backlogged |
| Duplicate rate | > 20% | Idempotency layer issue |
| Cache hit rate | < 80% | Sizing or TTL problem |
