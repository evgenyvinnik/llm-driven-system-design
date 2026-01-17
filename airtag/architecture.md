# Design AirTag - Architecture

## System Overview

AirTag uses the Find My network to locate items using crowd-sourced Bluetooth detection. Core challenges involve privacy-preserving location, key rotation, and anti-stalking measures.

**Learning Goals:**
- Build privacy-preserving location systems
- Design end-to-end encrypted reporting
- Implement key rotation schemes
- Handle crowd-sourced data at scale

---

## Requirements

### Functional Requirements

1. **Track**: Locate items via Find My network
2. **Precision**: UWB-based precise finding
3. **Lost Mode**: Notify when item is found
4. **Anti-Stalking**: Detect unknown trackers
5. **Sound**: Play sound to locate nearby item

### Non-Functional Requirements

- **Privacy**: Apple cannot see locations
- **Scale**: 1B+ Find My network devices
- **Latency**: < 15 minutes for location update
- **Battery**: Years of battery life

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     AirTag Device                               │
│         (BLE beacon, UWB, NFC, Speaker, Motion sensor)         │
└─────────────────────────────────────────────────────────────────┘
                              │ BLE
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Find My Network                               │
│              (Billions of Apple devices)                        │
└─────────────────────────────────────────────────────────────────┘
                              │ Encrypted reports
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Apple Servers                                │
│         (Encrypted blob storage, no location access)           │
└─────────────────────────────────────────────────────────────────┘
        │                                           │
        ▼                                           ▼
┌───────────────┐                          ┌───────────────┐
│  Owner Device │                          │Anti-Stalk Svc │
│               │                          │               │
│ - Decrypts    │                          │ - Detection   │
│ - Shows map   │                          │ - Alerts      │
└───────────────┘                          └───────────────┘
```

---

## Core Components

### 1. Key Rotation and Beacon

**Rotating Identity:**
```javascript
class AirTagKeyManager {
  constructor(masterSecret) {
    this.masterSecret = masterSecret // Shared with owner's iCloud
    this.currentPeriod = this.getCurrentPeriod()
  }

  getCurrentPeriod() {
    // Rotate keys every 15 minutes
    return Math.floor(Date.now() / (15 * 60 * 1000))
  }

  deriveCurrentKey() {
    // Derive period-specific key from master secret
    const period = this.getCurrentPeriod()
    return crypto.createHmac('sha256', this.masterSecret)
      .update(`airtag_key_${period}`)
      .digest()
  }

  derivePublicKey() {
    // Generate EC public key for this period
    const privateKey = this.deriveCurrentKey()
    const keyPair = crypto.createECDH('p224')
    keyPair.setPrivateKey(privateKey.slice(0, 28)) // P-224 key size

    return keyPair.getPublicKey()
  }

  // BLE advertisement payload
  getBLEPayload() {
    const publicKey = this.derivePublicKey()

    return {
      // Advertised identifier (derived from public key)
      identifier: crypto.createHash('sha256')
        .update(publicKey)
        .digest()
        .slice(0, 6), // 6 bytes identifier

      // Full public key (for encryption)
      publicKey: publicKey
    }
  }
}
```

### 2. Location Reporting

**Privacy-Preserving Reports:**
```javascript
class FindMyReporter {
  // Called when iPhone detects an AirTag
  async reportSighting(airtag, myLocation) {
    const { identifier, publicKey } = airtag

    // Encrypt location with AirTag's public key
    // Only owner (who knows master secret) can decrypt
    const encryptedLocation = await this.encryptLocation(
      myLocation,
      publicKey
    )

    // Report to Apple servers
    await fetch('https://findmy.apple.com/report', {
      method: 'POST',
      body: JSON.stringify({
        // Hashed identifier (Apple can correlate reports)
        identifierHash: crypto.createHash('sha256')
          .update(identifier)
          .digest('hex'),

        // Encrypted location blob (Apple cannot decrypt)
        encryptedPayload: encryptedLocation,

        // Timestamp (for freshness)
        timestamp: Date.now()
      })
    })
  }

  async encryptLocation(location, publicKey) {
    // ECIES encryption
    // Generate ephemeral key pair
    const ephemeral = crypto.createECDH('p224')
    ephemeral.generateKeys()

    // Derive shared secret
    const sharedSecret = ephemeral.computeSecret(publicKey)

    // Derive encryption key from shared secret
    const encryptionKey = crypto.createHash('sha256')
      .update(sharedSecret)
      .update('encryption')
      .digest()

    // Encrypt location
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv)

    const plaintext = JSON.stringify({
      lat: location.latitude,
      lon: location.longitude,
      accuracy: location.accuracy,
      timestamp: Date.now()
    })

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ])

    return {
      ephemeralPublicKey: ephemeral.getPublicKey(),
      iv: iv,
      ciphertext: encrypted,
      authTag: cipher.getAuthTag()
    }
  }
}
```

### 3. Location Retrieval

**Owner Decryption:**
```javascript
class FindMyClient {
  constructor(masterSecret) {
    this.masterSecret = masterSecret
  }

  async getLocations(timeRange) {
    // Generate all possible identifiers for time range
    const identifiers = []
    const startPeriod = Math.floor(timeRange.start / (15 * 60 * 1000))
    const endPeriod = Math.floor(timeRange.end / (15 * 60 * 1000))

    for (let period = startPeriod; period <= endPeriod; period++) {
      const key = this.deriveKeyForPeriod(period)
      const publicKey = this.derivePublicKeyFromPrivate(key)
      const identifier = crypto.createHash('sha256')
        .update(publicKey)
        .digest()
        .slice(0, 6)

      identifiers.push({
        period,
        identifierHash: crypto.createHash('sha256')
          .update(identifier)
          .digest('hex'),
        privateKey: key
      })
    }

    // Query Apple for encrypted reports
    const reports = await this.queryReports(identifiers.map(i => i.identifierHash))

    // Decrypt reports
    const locations = []
    for (const report of reports) {
      const identifier = identifiers.find(i => i.identifierHash === report.identifierHash)
      if (!identifier) continue

      try {
        const location = await this.decryptReport(report, identifier.privateKey)
        locations.push(location)
      } catch (e) {
        // Decryption failed - not our AirTag
        continue
      }
    }

    return locations.sort((a, b) => b.timestamp - a.timestamp)
  }

  async decryptReport(report, privateKey) {
    const { ephemeralPublicKey, iv, ciphertext, authTag } = report.encryptedPayload

    // Derive shared secret
    const keyPair = crypto.createECDH('p224')
    keyPair.setPrivateKey(privateKey.slice(0, 28))
    const sharedSecret = keyPair.computeSecret(ephemeralPublicKey)

    // Derive decryption key
    const decryptionKey = crypto.createHash('sha256')
      .update(sharedSecret)
      .update('encryption')
      .digest()

    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', decryptionKey, iv)
    decipher.setAuthTag(authTag)

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ])

    return JSON.parse(decrypted.toString('utf8'))
  }
}
```

### 4. Anti-Stalking Detection

**Unknown Tracker Alerts:**
```javascript
class AntiStalkingService {
  constructor() {
    this.seenTrackers = new Map() // identifier -> sightings
    this.alertThreshold = 3 // sightings
    this.timeWindow = 3 * 60 * 60 * 1000 // 3 hours
  }

  async onTrackerDetected(tracker, myLocation) {
    const { identifier } = tracker

    // Skip if it's one of my registered devices
    if (await this.isMyDevice(identifier)) {
      return
    }

    // Record sighting
    const sightings = this.seenTrackers.get(identifier) || []
    sightings.push({
      location: myLocation,
      timestamp: Date.now()
    })

    // Filter to recent sightings
    const recentSightings = sightings.filter(
      s => Date.now() - s.timestamp < this.timeWindow
    )
    this.seenTrackers.set(identifier, recentSightings)

    // Check for stalking pattern
    if (this.detectStalkingPattern(recentSightings)) {
      await this.alertUser(identifier, recentSightings)
    }
  }

  detectStalkingPattern(sightings) {
    if (sightings.length < this.alertThreshold) {
      return false
    }

    // Check if tracker has been with us across multiple locations
    const locations = sightings.map(s => s.location)

    // Calculate total distance traveled
    let totalDistance = 0
    for (let i = 1; i < locations.length; i++) {
      totalDistance += this.haversineDistance(locations[i-1], locations[i])
    }

    // If we've traveled significant distance with this tracker
    if (totalDistance > 0.5) { // > 500 meters
      return true
    }

    // Check time span
    const timeSpan = sightings[sightings.length - 1].timestamp - sightings[0].timestamp
    if (timeSpan > 60 * 60 * 1000) { // > 1 hour
      return true
    }

    return false
  }

  async alertUser(identifier, sightings) {
    // Send local notification
    await this.sendNotification({
      title: 'Unknown AirTag Detected',
      body: 'An AirTag has been traveling with you. Tap to learn more.',
      data: {
        type: 'unknown_tracker',
        identifier,
        firstSeen: sightings[0].timestamp,
        sightingCount: sightings.length
      }
    })

    // Show option to play sound
    // Show map of where tracker has been seen
    // Provide instructions for disabling
  }
}
```

### 5. Precision Finding

**UWB Directional Finding:**
```javascript
class PrecisionFinder {
  async startPrecisionFinding(airtag) {
    // Establish UWB ranging session
    const session = await this.initUWBSession(airtag.identifier)

    // Continuous ranging loop
    while (session.active) {
      const ranging = await session.measureRange()

      // Calculate distance from time-of-flight
      const distance = this.calculateDistance(ranging.timeOfFlight)

      // Calculate direction from angle-of-arrival
      const direction = this.calculateDirection(ranging.angleOfArrival)

      // Update UI
      this.updateUI({
        distance, // in meters
        direction: {
          azimuth: direction.azimuth, // horizontal angle
          elevation: direction.elevation // vertical angle
        },
        signalStrength: ranging.rssi
      })

      await this.sleep(100) // 10 Hz update rate
    }
  }

  calculateDistance(timeOfFlight) {
    const speedOfLight = 299792458 // m/s
    return (timeOfFlight * speedOfLight) / 2 // Round trip
  }

  calculateDirection(angleOfArrival) {
    // UWB antenna array provides angle measurements
    return {
      azimuth: angleOfArrival.horizontal,
      elevation: angleOfArrival.vertical
    }
  }
}
```

---

## Database Schema

```sql
-- Encrypted Location Reports (Apple servers)
CREATE TABLE location_reports (
  id BIGSERIAL PRIMARY KEY,
  identifier_hash VARCHAR(64) NOT NULL,
  encrypted_payload BYTEA NOT NULL,
  reporter_region VARCHAR(10), -- Coarse region for routing
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reports_identifier ON location_reports(identifier_hash);
CREATE INDEX idx_reports_time ON location_reports(created_at);

-- User's Registered Devices (per iCloud account)
CREATE TABLE registered_devices (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  device_type VARCHAR(50), -- 'airtag', 'iphone', 'macbook'
  name VARCHAR(100),
  master_secret_encrypted BYTEA, -- Encrypted with user key
  created_at TIMESTAMP DEFAULT NOW()
);

-- Lost Mode Settings
CREATE TABLE lost_mode (
  device_id UUID PRIMARY KEY REFERENCES registered_devices(id),
  enabled BOOLEAN DEFAULT FALSE,
  contact_phone VARCHAR(50),
  contact_email VARCHAR(200),
  message TEXT,
  enabled_at TIMESTAMP
);
```

---

## Key Design Decisions

### 1. End-to-End Encryption

**Decision**: Apple cannot decrypt location reports

**Rationale**:
- Maximum privacy protection
- Apple isn't liability for location data
- User maintains full control

### 2. Rotating Identifiers

**Decision**: Change BLE identifier every 15 minutes

**Rationale**:
- Prevents tracking by third parties
- Owner can still correlate
- Balance privacy vs. battery

### 3. Anti-Stalking by Default

**Decision**: Alert users to unknown trackers

**Rationale**:
- Prevent misuse
- Proactive safety
- Balance utility vs. abuse potential

---

## Consistency and Idempotency Semantics

### Write Semantics by Operation

| Operation | Consistency | Idempotency | Rationale |
|-----------|-------------|-------------|-----------|
| Location Report | Eventual | Idempotent (dedupe by hash) | High volume, duplicates harmless |
| Device Registration | Strong | Idempotent (upsert by device_id) | Critical user data |
| Lost Mode Toggle | Strong | Idempotent (last-write-wins) | User expects immediate effect |
| Anti-Stalking Alert | Eventual | At-least-once | Missing alert is worse than duplicate |

### Location Report Handling

Location reports are the highest-volume write operation. We use **eventual consistency** with idempotent processing:

```javascript
// Location reports use composite key for deduplication
async function submitLocationReport(report) {
  // Generate idempotency key from content hash
  const idempotencyKey = crypto.createHash('sha256')
    .update(report.identifierHash)
    .update(report.timestamp.toString())
    .update(report.encryptedPayload)
    .digest('hex')
    .slice(0, 32)

  // Upsert with conflict handling
  await db.query(`
    INSERT INTO location_reports (id, identifier_hash, encrypted_payload, created_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO NOTHING  -- Ignore duplicate submissions
  `, [idempotencyKey, report.identifierHash, report.encryptedPayload, new Date(report.timestamp)])
}
```

### Replay and Conflict Resolution

**Replay Handling:**
- Reports older than 7 days are rejected at API gateway (prevents replay attacks)
- Timestamp tolerance of +/- 5 minutes for clock drift
- Duplicate detection window: 24 hours (reports with same idempotency key ignored)

**Conflict Resolution Strategy:**
- **Location Reports**: No conflict - duplicates are discarded, all unique reports are stored
- **Device Registration**: Last-write-wins with `updated_at` timestamp; frontend shows optimistic update
- **Lost Mode**: Last-write-wins; toggle operations include client timestamp for ordering

```javascript
// Lost mode uses optimistic locking with version check
async function toggleLostMode(deviceId, enabled, clientVersion) {
  const result = await db.query(`
    UPDATE lost_mode
    SET enabled = $1, enabled_at = NOW(), version = version + 1
    WHERE device_id = $2 AND version = $3
    RETURNING version
  `, [enabled, deviceId, clientVersion])

  if (result.rowCount === 0) {
    throw new ConflictError('Lost mode was modified by another session')
  }
  return result.rows[0].version
}
```

### Local Development Setup

For local testing, run PostgreSQL with synchronous commits enabled (default) to observe strong consistency:

```bash
# Verify synchronous commits in psql
SHOW synchronous_commit;  -- Should be 'on'

# Test idempotency by submitting same report twice
curl -X POST http://localhost:3001/api/v1/reports \
  -H "Content-Type: application/json" \
  -d '{"identifierHash":"abc123","encryptedPayload":"...","timestamp":1700000000000}'
# Second identical request should return 200 but not create duplicate
```

---

## Caching and Edge Strategy

### Cache Architecture

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Mobile    │───▶│    CDN      │───▶│   Valkey    │───▶│ PostgreSQL  │
│   Client    │    │  (Static)   │    │   (Cache)   │    │  (Source)   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Cache Layers

| Layer | What's Cached | TTL | Strategy |
|-------|---------------|-----|----------|
| CDN | Static assets, map tiles | 24 hours | Cache-Control headers |
| Valkey L1 | User's device list | 5 minutes | Cache-aside |
| Valkey L2 | Location report lookups | 15 minutes | Cache-aside with write-through hint |
| Local (client) | Recent locations | 1 minute | Stale-while-revalidate |

### Cache-Aside Pattern (Primary)

Used for device list and location queries where reads far exceed writes:

```javascript
class CacheAside {
  constructor(redis, db) {
    this.redis = redis
    this.db = db
  }

  async getDeviceList(userId) {
    const cacheKey = `devices:${userId}`

    // 1. Check cache first
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // 2. Cache miss - fetch from DB
    const devices = await this.db.query(
      'SELECT * FROM registered_devices WHERE user_id = $1',
      [userId]
    )

    // 3. Populate cache with TTL
    await this.redis.setex(cacheKey, 300, JSON.stringify(devices.rows)) // 5 min TTL

    return devices.rows
  }

  // Invalidate on write
  async registerDevice(userId, device) {
    await this.db.query('INSERT INTO registered_devices ...', [userId, device])
    await this.redis.del(`devices:${userId}`)  // Invalidate cache
  }
}
```

### Write-Through Pattern (Location Reports)

For location reports, we use write-through to pre-warm the cache for owner queries:

```javascript
async function submitAndCacheReport(report) {
  // 1. Write to database
  await db.query('INSERT INTO location_reports ...', [report])

  // 2. Append to cache (for owner's next query)
  const cacheKey = `reports:${report.identifierHash}`
  await redis.lpush(cacheKey, JSON.stringify(report))
  await redis.ltrim(cacheKey, 0, 99)  // Keep last 100 reports
  await redis.expire(cacheKey, 900)   // 15 min TTL (matches key rotation period)
}
```

### Cache Invalidation Rules

| Event | Invalidation Action |
|-------|---------------------|
| Device registered | Delete `devices:{userId}` |
| Device removed | Delete `devices:{userId}` |
| Lost mode toggled | Delete `lostmode:{deviceId}` |
| Key rotation (15 min) | Reports cache expires naturally (TTL = 15 min) |
| User logout | Delete all `*:{userId}` keys |

### Local Development with Valkey

```bash
# Start Valkey via Docker
docker run -d --name airtag-valkey -p 6379:6379 valkey/valkey:latest

# Or via Homebrew
brew install valkey && valkey-server

# Monitor cache operations in real-time
valkey-cli MONITOR

# Check cache hit rates
valkey-cli INFO stats | grep keyspace
```

### CDN Configuration (for Static Assets)

In local development, simulate CDN behavior with Express static middleware:

```javascript
// Simulate CDN cache headers for static assets
app.use('/static', express.static('public', {
  maxAge: '1d',  // Cache-Control: max-age=86400
  etag: true,
  lastModified: true
}))

// Map tiles and images
app.use('/tiles', express.static('tiles', {
  maxAge: '7d',
  immutable: true  // Cache-Control: immutable (content-addressed)
}))
```

---

## Async Queue Architecture (RabbitMQ)

### Queue Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           RabbitMQ                                       │
│                                                                          │
│  ┌─────────────┐    ┌─────────────────────────────────────────────────┐ │
│  │  Exchange   │───▶│  location.reports (fanout to workers)           │ │
│  │  (topic)    │    └─────────────────────────────────────────────────┘ │
│  │             │    ┌─────────────────────────────────────────────────┐ │
│  │             │───▶│  antistalk.analyze (stalking pattern check)     │ │
│  │             │    └─────────────────────────────────────────────────┘ │
│  │             │    ┌─────────────────────────────────────────────────┐ │
│  │             │───▶│  notifications.push (alert delivery)            │ │
│  │             │    └─────────────────────────────────────────────────┘ │
│  │             │    ┌─────────────────────────────────────────────────┐ │
│  │             │───▶│  reports.cleanup (TTL expiration)               │ │
│  └─────────────┘    └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Queue Definitions

| Queue | Purpose | Delivery | Backpressure |
|-------|---------|----------|--------------|
| `location.reports` | Store encrypted location blobs | At-least-once | Prefetch = 100 |
| `antistalk.analyze` | Detect stalking patterns | At-least-once | Prefetch = 10 |
| `notifications.push` | Send alerts to users | At-least-once with retry | Prefetch = 50 |
| `reports.cleanup` | Expire old reports (7 days) | At-most-once | Prefetch = 1000 |

### Producer: Location Report Ingestion

```javascript
const amqp = require('amqplib')

class ReportProducer {
  async connect() {
    this.connection = await amqp.connect('amqp://guest:guest@localhost:5672')
    this.channel = await this.connection.createChannel()

    // Declare exchange and queues
    await this.channel.assertExchange('airtag.events', 'topic', { durable: true })
    await this.channel.assertQueue('location.reports', {
      durable: true,
      arguments: {
        'x-message-ttl': 7 * 24 * 60 * 60 * 1000,  // 7 days
        'x-max-length': 1000000  // Backpressure: max 1M messages
      }
    })
    await this.channel.bindQueue('location.reports', 'airtag.events', 'report.location.*')
  }

  async publishReport(report) {
    const message = Buffer.from(JSON.stringify(report))

    // Publish with persistence
    this.channel.publish('airtag.events', 'report.location.new', message, {
      persistent: true,
      messageId: report.idempotencyKey,  // For deduplication
      timestamp: Date.now()
    })
  }
}
```

### Consumer: Anti-Stalking Analysis (Background Job)

```javascript
class AntiStalkConsumer {
  async start() {
    const connection = await amqp.connect('amqp://guest:guest@localhost:5672')
    const channel = await connection.createChannel()

    // Backpressure: only process 10 messages at a time
    await channel.prefetch(10)

    await channel.assertQueue('antistalk.analyze', { durable: true })
    await channel.bindQueue('antistalk.analyze', 'airtag.events', 'report.location.*')

    channel.consume('antistalk.analyze', async (msg) => {
      try {
        const report = JSON.parse(msg.content.toString())
        await this.analyzeForStalking(report)
        channel.ack(msg)  // Acknowledge success
      } catch (err) {
        console.error('Analysis failed:', err)
        // Requeue with delay for retry (dead letter after 3 attempts)
        if (msg.fields.redelivered) {
          channel.nack(msg, false, false)  // Dead letter
        } else {
          channel.nack(msg, false, true)   // Requeue
        }
      }
    })
  }

  async analyzeForStalking(report) {
    // Fetch recent sightings for this identifier
    const sightings = await db.query(`
      SELECT * FROM location_reports
      WHERE identifier_hash = $1
      AND created_at > NOW() - INTERVAL '3 hours'
      ORDER BY created_at
    `, [report.identifierHash])

    // Run pattern detection (see AntiStalkingService above)
    if (this.detectStalkingPattern(sightings.rows)) {
      await this.publishAlert(report.identifierHash, sightings.rows)
    }
  }

  async publishAlert(identifierHash, sightings) {
    // Queue notification for delivery
    this.channel.publish('airtag.events', 'alert.stalking', Buffer.from(JSON.stringify({
      identifierHash,
      sightingCount: sightings.length,
      firstSeen: sightings[0].created_at,
      lastSeen: sightings[sightings.length - 1].created_at
    })), { persistent: true })
  }
}
```

### Backpressure and Flow Control

```javascript
// Monitor queue depth and apply backpressure at API layer
async function checkBackpressure() {
  const queueInfo = await channel.checkQueue('location.reports')

  if (queueInfo.messageCount > 500000) {
    // Shed load: reject new reports temporarily
    console.warn('Queue depth high, applying backpressure')
    return { accept: false, retryAfter: 60 }
  }

  if (queueInfo.messageCount > 100000) {
    // Slow down: add artificial delay
    console.warn('Queue depth elevated, slowing intake')
    return { accept: true, delay: 100 }
  }

  return { accept: true, delay: 0 }
}
```

### Delivery Semantics Summary

| Queue | Semantics | Handling |
|-------|-----------|----------|
| `location.reports` | At-least-once | Idempotent writes (ON CONFLICT DO NOTHING) |
| `antistalk.analyze` | At-least-once | Idempotent analysis (stateless check) |
| `notifications.push` | At-least-once | Dedupe in push service (1 hour window) |
| `reports.cleanup` | At-most-once | Acceptable to miss some (cron backup) |

### Local Development Setup

```bash
# Start RabbitMQ via Docker
docker run -d --name airtag-rabbitmq \
  -p 5672:5672 -p 15672:15672 \
  rabbitmq:3-management

# Or via Homebrew
brew install rabbitmq && brew services start rabbitmq

# Access management UI
open http://localhost:15672  # guest/guest

# Monitor queues from CLI
rabbitmqctl list_queues name messages consumers
```

### docker-compose.yml Addition

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

  valkey:
    image: valkey/valkey:latest
    ports:
      - "6379:6379"
    volumes:
      - valkey_data:/data

volumes:
  rabbitmq_data:
  valkey_data:
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Encryption | End-to-end | Server-side | Privacy |
| Key rotation | 15 minutes | Hourly | Privacy vs. battery |
| Anti-stalking | Proactive alerts | Manual check | Safety |
| Precision | UWB | BLE only | Accuracy |

---

## Implementation Notes

This section documents the backend implementation improvements and explains **WHY** each change makes the system more reliable, observable, and scalable.

### 1. Structured Logging with Pino

**What**: Replaced `console.log` with Pino structured JSON logging.

**Why This Improves the System**:

1. **Log Aggregation**: JSON logs are machine-parseable, enabling ingestion into ELK Stack, Splunk, or CloudWatch Logs. This allows searching across all server instances with a single query like `component:locationService AND level:error`.

2. **Request Correlation**: Each request gets a unique ID (`req.id`) that flows through all log entries. When investigating an issue, you can filter by request ID to see the complete request lifecycle across services.

3. **Performance**: Pino is 5x faster than Winston/Bunyan because it uses asynchronous I/O and avoids expensive string interpolation. In a high-throughput system processing 100k+ location reports/minute, logging overhead matters.

4. **Context Propagation**: Child loggers inherit parent context, so a log entry from `locationService` automatically includes `component: "locationService"` without manual annotation.

**Files**: `src/shared/logger.ts`, `src/index.ts`

```typescript
// Before (hard to search, no context)
console.error('Submit report error:', error);

// After (structured, searchable, with context)
log.error(
  { error, identifierHash: data.identifier_hash },
  'Failed to submit location report'
);
```

---

### 2. Prometheus Metrics for Observability

**What**: Added Prometheus metrics collection with a `/metrics` endpoint.

**Why This Improves the System**:

1. **SLO Monitoring**: Track the four golden signals (latency, traffic, errors, saturation). Example alert: "P99 latency > 200ms for 5 minutes" triggers before users notice degradation.

2. **Capacity Planning**: `location_reports_total` counter shows ingestion rate over time. If reports increase 10x during a product launch, you know to scale before saturation.

3. **Cache Efficiency**: `cache_operations_total{result="hit|miss"}` reveals cache hit rate. If hit rate drops below 80%, investigate TTL settings or cache invalidation bugs.

4. **Rate Limit Tuning**: `rate_limit_hits_total` shows how often limits are hit per endpoint. If auth limits trigger frequently, either increase limits or investigate credential stuffing attacks.

5. **Database Performance**: `db_query_duration_seconds` histogram with percentiles identifies slow queries. A query with P99 > 100ms is a candidate for indexing.

**Files**: `src/shared/metrics.ts`, `src/index.ts`

**Key Metrics**:
| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | Latency SLOs, percentile tracking |
| `location_reports_total` | Counter | Ingestion throughput, regional breakdown |
| `cache_operations_total` | Counter | Cache efficiency (hit/miss ratio) |
| `db_query_duration_seconds` | Histogram | Slow query detection |
| `rate_limit_hits_total` | Counter | Abuse detection, limit tuning |

---

### 3. Redis Caching with Cache-Aside Pattern

**What**: Added Redis caching for location queries and device lookups.

**Why This Improves the System**:

1. **Read Scalability**: Location queries involve: (1) device lookup, (2) identifier hash generation for time range, (3) report query, (4) decryption. Caching the final result eliminates all four steps for repeated queries.

2. **Latency Reduction**: Cache hit: ~1ms. Database query + decryption: ~50-200ms. For a user refreshing the map every 30 seconds, caching provides 50x latency improvement.

3. **Database Protection**: During "lost device" scenarios, users may refresh obsessively. Cache absorbs this traffic, protecting PostgreSQL from connection exhaustion.

4. **TTL Alignment**: Cache TTL (15 minutes) matches key rotation period. This ensures cached data expires around the same time new reports become available, balancing freshness vs. efficiency.

**Files**: `src/shared/cache.ts`, `src/services/locationService.ts`

**Cache Strategy**:
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Location Query │────▶│   Redis Check   │────▶│  PostgreSQL     │
│                 │     │   (1ms RTT)     │     │  (50-200ms)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │                       │
         │     Cache HIT        │                       │
         │◀─────────────────────│                       │
         │                      │      Cache MISS       │
         │◀─────────────────────┼───────────────────────│
         │                      │                       │
         │                      │  Populate cache       │
         │                      │◀──────────────────────│
```

---

### 4. Idempotency for Location Report Submissions

**What**: Added idempotency layer using Redis to prevent duplicate location reports.

**Why This Improves the System**:

1. **Network Reliability**: Mobile devices on cellular networks experience packet loss. Clients retry failed requests, potentially creating duplicate reports. Idempotency ensures retries are safe.

2. **At-Least-Once Delivery**: When we add RabbitMQ for async processing, message redelivery is expected. Idempotent handlers ensure reports are processed exactly once.

3. **Replay Attack Prevention**: An attacker capturing a location report cannot replay it after 7 days (timestamp validation) or within 24 hours (duplicate detection).

4. **Consistent Responses**: Duplicate requests return the same response (same `report_id`), maintaining client-side invariants.

**Files**: `src/shared/idempotency.ts`, `src/services/locationService.ts`

**Idempotency Key Generation**:
```typescript
// Key = hash(identifier + timestamp_rounded + payload_hash)
// - Timestamp rounded to minute: handles clock drift
// - Payload hash: catches identical content
const idempotencyKey = generateIdempotencyKey(
  data.identifier_hash,
  timestamp,
  data.encrypted_payload
);
```

---

### 5. Rate Limiting for API Protection

**What**: Added Redis-backed rate limiting with different limits per endpoint.

**Why This Improves the System**:

1. **DoS Mitigation**: Without rate limits, a single client can exhaust database connections or CPU. Rate limits bound the damage from malicious or buggy clients.

2. **Fair Usage**: In a crowd-sourced network, one device shouldn't consume all server capacity. Rate limits ensure all devices get fair access.

3. **Brute Force Prevention**: Auth endpoint limit (10/min) makes password brute-forcing impractical. At 10 attempts/minute, testing 1000 passwords takes 100 minutes.

4. **Cost Control**: Each API request has a cost (compute, database, bandwidth). Rate limits prevent runaway costs from misconfigured clients or scrapers.

5. **Distributed Enforcement**: Redis-backed limits work across multiple server instances. A client can't bypass limits by hitting different servers.

**Files**: `src/shared/rateLimit.ts`, `src/index.ts`

**Rate Limit Tiers**:
| Endpoint | Limit | Rationale |
|----------|-------|-----------|
| Location Reports | 100/min | High throughput for crowd-sourced ingestion |
| Location Queries | 60/min | Normal user refresh rate (~1/min per device) |
| Authentication | 10/min | Prevent brute force attacks |
| Device Registration | 20/min | Setup-only, prevents device farming |
| Admin | 20/min | Sensitive operations, should be infrequent |

---

### 6. Comprehensive Health Checks

**What**: Added `/health/ready` endpoint that checks PostgreSQL and Redis connectivity.

**Why This Improves the System**:

1. **Kubernetes Integration**: Readiness probes determine if a pod should receive traffic. If Redis is down, the pod is marked unhealthy and removed from the load balancer.

2. **Rolling Deployments**: During deploys, new pods only receive traffic after dependencies are ready. This prevents 503 errors during startup.

3. **Graceful Degradation**: The health check reports "degraded" status if some (but not all) checks fail. This allows traffic to continue while alerting operators.

4. **Dependency Monitoring**: Health checks provide latency measurements for each dependency. Slow Redis response (>10ms) may indicate network issues or memory pressure.

**Files**: `src/shared/health.ts`, `src/index.ts`

**Health Check Endpoints**:
| Endpoint | Type | Use Case |
|----------|------|----------|
| `/health` | Shallow | Kubernetes liveness probe |
| `/health/live` | Shallow | Alias for liveness |
| `/health/ready` | Deep | Kubernetes readiness probe |
| `/metrics` | N/A | Prometheus scraping |

---

### 7. Shared Module Architecture

**What**: Organized infrastructure code into `src/shared/` with a barrel export.

**Why This Improves the System**:

1. **Separation of Concerns**: Business logic (services) is separate from infrastructure (logging, caching, metrics). Services import what they need from `shared/index.js`.

2. **Testability**: Shared modules can be mocked in unit tests. Services don't need real Redis or Prometheus connections during testing.

3. **Reusability**: When adding new services (e.g., anti-stalking worker), they import the same infrastructure. Consistent logging, metrics, and caching across all services.

4. **Configuration Centralization**: Cache TTLs, rate limits, and log levels are defined in one place. Changing a TTL affects all consumers.

**Directory Structure**:
```
src/shared/
├── index.ts       # Barrel export for all shared modules
├── logger.ts      # Pino structured logging
├── metrics.ts     # Prometheus metrics
├── cache.ts       # Redis caching with cache-aside
├── idempotency.ts # Duplicate request prevention
├── rateLimit.ts   # Rate limiting middleware
└── health.ts      # Health check endpoints
```

---

### Summary: Before vs. After

| Aspect | Before | After |
|--------|--------|-------|
| Logging | `console.log` (unstructured) | Pino JSON (structured, searchable) |
| Metrics | None | Prometheus (latency, throughput, errors) |
| Caching | None | Redis cache-aside (15-min TTL) |
| Idempotency | None | Redis-based duplicate detection (24h window) |
| Rate Limiting | None | Redis-backed, per-endpoint limits |
| Health Checks | Basic `/health` | Dependency-aware `/health/ready` |
| Error Handling | Generic 500 | Structured logging with context |

These changes transform the backend from a simple CRUD server into a production-ready service that can:
- Scale horizontally behind a load balancer
- Survive dependency failures gracefully
- Be monitored and alerted on via Grafana dashboards
- Handle network retries and duplicate submissions safely
- Protect itself from abuse and misconfigured clients
