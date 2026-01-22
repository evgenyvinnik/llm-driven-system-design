# AirTag - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design the backend infrastructure for AirTag, Apple's item tracking system that uses a crowd-sourced network of billions of Apple devices to locate lost items. The key backend challenges include:
- Privacy-preserving location storage where even Apple cannot see locations
- High-volume encrypted report ingestion from 1B+ devices
- Key rotation and identifier management at scale
- Anti-stalking detection with real-time pattern analysis
- Exactly-once semantics for location reports

## Requirements Clarification

### Functional Requirements
1. **Report Ingestion**: Receive encrypted location reports from Find My network devices
2. **Location Queries**: Serve encrypted blobs to device owners for local decryption
3. **Anti-Stalking**: Detect unknown trackers following users
4. **Lost Mode**: Store and serve contact information for found devices
5. **Notifications**: Alert users when devices are found or unknown trackers detected

### Non-Functional Requirements
1. **Privacy**: End-to-end encryption - Apple cannot decrypt locations
2. **Throughput**: Handle 100K+ location reports per second globally
3. **Latency**: Location queries < 100ms, report ingestion < 50ms
4. **Retention**: Reports stored for 24 hours, auto-expired

### Scale Estimates
- 1 billion+ Apple devices in Find My network
- Each AirTag broadcasts every 2 seconds
- Key rotation every 15 minutes = 96 periods per day
- ~100M active AirTags generating ~1B reports/day
- Each encrypted report: ~1KB

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Find My Network (1B+ devices)                  │
│              (iPhones, iPads, Macs detect AirTags)              │
└─────────────────────────────────────────────────────────────────┘
                              │ Encrypted Reports
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway Layer                           │
│    (Rate limiting, request validation, regional routing)        │
└─────────────────────────────────────────────────────────────────┘
              │                                    │
              ▼                                    ▼
┌─────────────────────────┐          ┌─────────────────────────────┐
│   Report Ingestion API  │          │   Location Query Service    │
│   (Express + Node.js)   │          │   (Express + Node.js)       │
└───────────┬─────────────┘          └─────────────┬───────────────┘
            │                                      │
            ▼                                      ▼
┌─────────────────────────┐          ┌─────────────────────────────┐
│     Redis/Valkey        │          │       PostgreSQL            │
│  - Idempotency (24h)    │          │  - location_reports         │
│  - Rate limiting        │          │  - registered_devices       │
│  - Cache-aside          │          │  - notifications            │
└─────────────────────────┘          └─────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RabbitMQ                                    │
│  - location.reports (ingestion workers)                          │
│  - antistalk.analyze (pattern detection)                         │
│  - notifications.push (alert delivery)                           │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Privacy-Preserving Storage Architecture

### The Zero-Knowledge Challenge

Apple must store location reports without being able to read them. This requires careful database design.

### Database Schema for Encrypted Reports

```sql
-- Location reports: encrypted blobs with NO FK to devices
CREATE TABLE location_reports (
    id BIGSERIAL PRIMARY KEY,
    identifier_hash VARCHAR(64) NOT NULL,     -- SHA-256 of rotating BLE identifier
    encrypted_payload JSONB NOT NULL,         -- ECIES encrypted location
    reporter_region VARCHAR(10),              -- Coarse region for routing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for query patterns
CREATE INDEX idx_reports_identifier ON location_reports(identifier_hash);
CREATE INDEX idx_reports_identifier_time ON location_reports(identifier_hash, created_at DESC);
CREATE INDEX idx_reports_time ON location_reports(created_at);
```

**Why No Foreign Key to Devices:**
1. **Privacy by Design**: Server cannot correlate identifier_hash to a device
2. **Key Rotation**: Identifier changes every 15 minutes; no stable reference
3. **Anonymity**: Reports come from random network devices, not owners
4. **Zero-Knowledge**: Only the owner can derive which hashes belong to their device

### Encrypted Payload Structure

```typescript
interface EncryptedPayload {
  ephemeralPublicKey: string;  // Reporter's ephemeral P-224 public key
  iv: string;                   // 12-byte nonce for AES-GCM
  ciphertext: string;           // Encrypted location data
  authTag: string;              // GCM authentication tag
}

// What's encrypted (only owner can decrypt):
interface DecryptedLocation {
  lat: number;
  lon: number;
  accuracy: number;
  timestamp: number;
}
```

## Deep Dive: Report Ingestion Pipeline

### Idempotency Layer

Location reports may be submitted multiple times due to network retries. We implement idempotent processing:

```typescript
import crypto from 'crypto';

function generateIdempotencyKey(
  identifierHash: string,
  timestamp: number,
  encryptedPayload: object
): string {
  // Round timestamp to minute for clock drift tolerance
  const roundedTimestamp = Math.floor(timestamp / 60000) * 60000;

  const payloadHash = crypto.createHash('sha256')
    .update(JSON.stringify(encryptedPayload))
    .digest('hex')
    .slice(0, 16);

  return crypto.createHash('sha256')
    .update(`${identifierHash}:${roundedTimestamp}:${payloadHash}`)
    .digest('hex')
    .slice(0, 32);
}

async function submitLocationReport(report: LocationReport): Promise<string> {
  const idempotencyKey = generateIdempotencyKey(
    report.identifierHash,
    report.timestamp,
    report.encryptedPayload
  );

  // Check Redis for duplicate
  const existing = await redis.get(`idem:report:${idempotencyKey}`);
  if (existing) {
    return existing;  // Return existing report ID
  }

  // Insert with ON CONFLICT DO NOTHING
  const result = await db.query(`
    INSERT INTO location_reports (identifier_hash, encrypted_payload, reporter_region)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [report.identifierHash, report.encryptedPayload, report.region]);

  const reportId = result.rows[0]?.id || idempotencyKey;

  // Cache for 24 hours
  await redis.setex(`idem:report:${idempotencyKey}`, 86400, reportId);

  return reportId;
}
```

### Async Processing with RabbitMQ

```typescript
// Producer: API handler queues report for processing
async function handleReportSubmission(req: Request, res: Response) {
  const report = validateReport(req.body);

  // Check backpressure
  const queueDepth = await checkQueueDepth('location.reports');
  if (queueDepth > 500000) {
    return res.status(503).json({
      error: 'Service temporarily overloaded',
      retryAfter: 60
    });
  }

  // Queue for async processing
  await channel.publish('airtag.events', 'report.location.new',
    Buffer.from(JSON.stringify(report)), {
      persistent: true,
      messageId: report.idempotencyKey
    }
  );

  return res.status(202).json({
    status: 'accepted',
    reportId: report.idempotencyKey
  });
}

// Consumer: Background worker processes reports
async function consumeReports(channel: Channel) {
  await channel.prefetch(100);  // Backpressure control

  channel.consume('location.reports', async (msg) => {
    try {
      const report = JSON.parse(msg.content.toString());
      await submitLocationReport(report);

      // Trigger anti-stalking analysis
      await channel.publish('airtag.events', 'report.location.stored',
        msg.content, { persistent: true });

      channel.ack(msg);
    } catch (err) {
      if (msg.fields.redelivered) {
        channel.nack(msg, false, false);  // Dead letter
      } else {
        channel.nack(msg, false, true);   // Requeue
      }
    }
  });
}
```

## Deep Dive: Location Query Service

### Identifier Hash Generation on Owner Device

The owner generates all possible identifier hashes for a time range:

```typescript
class FindMyClient {
  constructor(private masterSecret: string) {}

  async queryLocations(deviceId: string, timeRange: TimeRange): Promise<Location[]> {
    // Generate all possible identifiers for time range
    const identifierHashes = this.generateIdentifierHashes(timeRange);

    // Query encrypted reports from server
    const encryptedReports = await this.fetchReports(identifierHashes);

    // Decrypt locally using derived private keys
    const locations: Location[] = [];
    for (const report of encryptedReports) {
      const period = this.getPeriodForTimestamp(report.timestamp);
      const privateKey = this.deriveKeyForPeriod(period);

      try {
        const decrypted = await this.decryptReport(report, privateKey);
        locations.push(decrypted);
      } catch {
        // Not our report (hash collision) - skip
      }
    }

    return locations.sort((a, b) => b.timestamp - a.timestamp);
  }

  private generateIdentifierHashes(timeRange: TimeRange): string[] {
    const hashes: string[] = [];
    const startPeriod = Math.floor(timeRange.start / (15 * 60 * 1000));
    const endPeriod = Math.floor(timeRange.end / (15 * 60 * 1000));

    for (let period = startPeriod; period <= endPeriod; period++) {
      const privateKey = this.deriveKeyForPeriod(period);
      const publicKey = this.derivePublicKey(privateKey);
      const identifier = crypto.createHash('sha256')
        .update(publicKey)
        .digest()
        .slice(0, 6);
      const identifierHash = crypto.createHash('sha256')
        .update(identifier)
        .digest('hex');

      hashes.push(identifierHash);
    }

    return hashes;
  }
}
```

### Server-Side Query Handler

```typescript
app.post('/api/v1/locations/query', async (req, res) => {
  const { identifierHashes, startTime, endTime } = req.body;

  // Rate limit per user
  const remaining = await checkRateLimit(req.userId, 'location_query', 60);
  if (remaining <= 0) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // Check cache first
  const cacheKey = `locations:${crypto.createHash('sha256')
    .update(identifierHashes.join(':'))
    .digest('hex').slice(0, 16)}:${startTime}:${endTime}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // Query database for matching reports
  const result = await db.query(`
    SELECT id, identifier_hash, encrypted_payload, created_at
    FROM location_reports
    WHERE identifier_hash = ANY($1)
      AND created_at BETWEEN $2 AND $3
    ORDER BY created_at DESC
    LIMIT 1000
  `, [identifierHashes, new Date(startTime), new Date(endTime)]);

  const response = {
    reports: result.rows,
    count: result.rows.length
  };

  // Cache for 15 minutes (matches key rotation period)
  await redis.setex(cacheKey, 900, JSON.stringify(response));

  return res.json(response);
});
```

## Deep Dive: Anti-Stalking Detection Service

### Pattern Analysis Worker

```typescript
class AntiStalkingWorker {
  private readonly ALERT_THRESHOLD = 3;        // Minimum sightings
  private readonly TIME_WINDOW = 3 * 60 * 60 * 1000;  // 3 hours
  private readonly DISTANCE_THRESHOLD = 500;  // meters

  async analyzeSighting(userId: string, sighting: TrackerSighting): Promise<void> {
    // Skip user's own devices
    if (await this.isUserDevice(userId, sighting.identifierHash)) {
      return;
    }

    // Record sighting
    await db.query(`
      INSERT INTO tracker_sightings (user_id, identifier_hash, latitude, longitude)
      VALUES ($1, $2, $3, $4)
    `, [userId, sighting.identifierHash, sighting.lat, sighting.lon]);

    // Get recent sightings of this tracker
    const recentSightings = await db.query(`
      SELECT latitude, longitude, seen_at
      FROM tracker_sightings
      WHERE user_id = $1
        AND identifier_hash = $2
        AND seen_at > NOW() - INTERVAL '3 hours'
      ORDER BY seen_at
    `, [userId, sighting.identifierHash]);

    if (this.detectStalkingPattern(recentSightings.rows)) {
      await this.createAlert(userId, sighting.identifierHash, recentSightings.rows);
    }
  }

  private detectStalkingPattern(sightings: Sighting[]): boolean {
    if (sightings.length < this.ALERT_THRESHOLD) {
      return false;
    }

    // Calculate total distance traveled with tracker
    let totalDistance = 0;
    for (let i = 1; i < sightings.length; i++) {
      totalDistance += this.haversineDistance(
        sightings[i-1],
        sightings[i]
      );
    }

    // Alert if traveled significant distance together
    if (totalDistance > this.DISTANCE_THRESHOLD) {
      return true;
    }

    // Alert if tracker present for extended time
    const timeSpan = new Date(sightings[sightings.length - 1].seen_at).getTime()
                   - new Date(sightings[0].seen_at).getTime();
    if (timeSpan > 60 * 60 * 1000) {  // 1 hour
      return true;
    }

    return false;
  }

  private async createAlert(
    userId: string,
    identifierHash: string,
    sightings: Sighting[]
  ): Promise<void> {
    // Check cooldown (1 alert per tracker per hour)
    const cooldownKey = `alert:cooldown:${userId}:${identifierHash}`;
    if (await redis.get(cooldownKey)) {
      return;
    }

    await db.query(`
      INSERT INTO notifications (user_id, type, title, message, data)
      VALUES ($1, 'unknown_tracker', 'Unknown AirTag Detected',
              'An AirTag has been traveling with you.',
              $2)
    `, [userId, JSON.stringify({
      identifierHash,
      sightingCount: sightings.length,
      firstSeen: sightings[0].seen_at,
      locations: sightings.map(s => ({ lat: s.latitude, lon: s.longitude }))
    })]);

    // Set cooldown
    await redis.setex(cooldownKey, 3600, '1');

    // Queue push notification
    await channel.publish('airtag.events', 'alert.unknown_tracker',
      Buffer.from(JSON.stringify({ userId, identifierHash })));
  }
}
```

## Deep Dive: Data Lifecycle and Retention

### TTL-Based Cleanup

```typescript
// Scheduled job: Run every hour
async function cleanupExpiredReports(): Promise<void> {
  const batchSize = 10000;
  let deleted = 0;

  do {
    const result = await db.query(`
      DELETE FROM location_reports
      WHERE id IN (
        SELECT id FROM location_reports
        WHERE created_at < NOW() - INTERVAL '7 days'
        LIMIT $1
      )
      RETURNING id
    `, [batchSize]);

    deleted = result.rowCount;

    // Avoid overwhelming the database
    if (deleted > 0) {
      await sleep(1000);
    }
  } while (deleted === batchSize);

  log.info({ deleted }, 'Expired reports cleaned up');
}

// Cleanup tracker sightings (shorter retention for privacy)
async function cleanupSightings(): Promise<void> {
  await db.query(`
    DELETE FROM tracker_sightings
    WHERE seen_at < NOW() - INTERVAL '24 hours'
  `);
}
```

### Retention Policy Summary

| Data Type | Retention | Rationale |
|-----------|-----------|-----------|
| Location reports | 7 days | Balance findability vs. storage cost |
| Tracker sightings | 24 hours | Privacy - minimize stalking data |
| Idempotency keys | 24 hours | Sufficient for retry handling |
| Rate limit counters | 1 minute | Per-minute limit windows |
| Decrypted locations cache | 15 minutes | Matches key rotation period |

## Deep Dive: Observability

### Prometheus Metrics

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

const reportsReceived = new Counter({
  name: 'location_reports_received_total',
  help: 'Total location reports received',
  labelNames: ['region', 'status']  // 'accepted', 'duplicate', 'rejected'
});

const reportIngestionLatency = new Histogram({
  name: 'report_ingestion_duration_seconds',
  help: 'Report ingestion latency',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25]
});

const queueDepth = new Gauge({
  name: 'rabbitmq_queue_depth',
  help: 'RabbitMQ queue message count',
  labelNames: ['queue']
});

const cacheHitRate = new Counter({
  name: 'cache_operations_total',
  help: 'Cache operation outcomes',
  labelNames: ['operation', 'result']  // 'hit', 'miss'
});
```

### Alert Rules

```yaml
groups:
  - name: airtag-backend
    rules:
      - alert: HighReportIngestionLatency
        expr: histogram_quantile(0.95, rate(report_ingestion_duration_seconds_bucket[5m])) > 0.1
        for: 5m
        annotations:
          summary: "Report ingestion p95 > 100ms"

      - alert: QueueBacklog
        expr: rabbitmq_queue_depth{queue="location.reports"} > 100000
        for: 10m
        annotations:
          summary: "Location reports queue backlog growing"

      - alert: HighDuplicateRate
        expr: rate(location_reports_received_total{status="duplicate"}[5m]) /
              rate(location_reports_received_total[5m]) > 0.2
        for: 5m
        annotations:
          summary: "Duplicate report rate > 20%"

      - alert: AntiStalkingBacklog
        expr: rabbitmq_queue_depth{queue="antistalk.analyze"} > 10000
        for: 5m
        annotations:
          summary: "Anti-stalking analysis backlogged"
```

## Scalability Considerations

### Horizontal Scaling

| Component | Strategy | Notes |
|-----------|----------|-------|
| Report Ingestion API | Stateless, load balanced | Redis for distributed rate limits |
| Location Query Service | Stateless, read replicas | Cache reduces DB load |
| Anti-Stalking Workers | Consumer groups | Partition by user_id |
| PostgreSQL | Read replicas, partitioning by time | Archive old partitions |
| Redis/Valkey | Cluster mode, sharded | Key prefix routing |

### Regional Deployment

```
                    ┌─────────────────┐
                    │   Global LB     │
                    │  (Anycast DNS)  │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌──────────┐      ┌──────────┐      ┌──────────┐
    │  US-West │      │  EU-West │      │  AP-East │
    │  Region  │      │  Region  │      │  Region  │
    └──────────┘      └──────────┘      └──────────┘
         │                 │                 │
         └─────────────────┴─────────────────┘
                    │
              Cross-Region
              Replication
              (Async)
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| No FK on reports | Privacy-first | FK to devices | Server cannot correlate reports to devices |
| JSONB payload | Schema flexibility | Normalized columns | Encryption format may evolve |
| Redis idempotency | Fast checks | DB unique constraint | Sub-ms response critical for throughput |
| Async anti-stalking | Decoupled processing | Synchronous | Don't block report ingestion |
| 15-min cache TTL | Matches key rotation | Shorter TTL | Avoid stale data after rotation |

## Future Backend Enhancements

1. **Kafka for Higher Throughput**: Replace RabbitMQ for 1M+ reports/second
2. **ClickHouse for Analytics**: Aggregate statistics without exposing locations
3. **Global Database**: CockroachDB or Spanner for multi-region consistency
4. **ML Anti-Stalking**: Anomaly detection beyond rule-based patterns
5. **Hardware Security Modules**: Store master key derivation in HSMs
6. **Bloom Filters**: Probabilistic deduplication for memory efficiency
