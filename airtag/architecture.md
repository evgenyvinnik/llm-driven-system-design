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

1. **Track**: Locate items via the Find My network of billions of Apple devices
2. **Precision**: UWB-based directional finding for nearby items
3. **Lost Mode**: Notify owner when a lost item is found by the network
4. **Anti-Stalking**: Detect and alert users to unknown trackers traveling with them
5. **Sound**: Play sound to locate nearby items

### Non-Functional Requirements

- **Privacy**: Apple cannot decrypt or see item locations -- end-to-end encrypted
- **Scale**: 1B+ Find My network devices submitting reports, 500M+ AirTags
- **Latency**: < 15 minutes for location update (limited by key rotation period)
- **Battery**: 1+ year battery life on CR2032 (requires ultra-low-power BLE)
- **Availability**: 99.99% for report ingestion, 99.9% for location retrieval
- **Throughput**: 10M+ encrypted location reports per minute globally

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     AirTag Device                                │
│         (BLE beacon, UWB, NFC, Speaker, Motion sensor)          │
│         Broadcasts rotating BLE identifier every 2 seconds      │
└─────────────────────────────────────────────────────────────────┘
                              │ BLE advertisement
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Find My Network                                │
│              (1B+ iPhones, iPads, Macs)                         │
│         Detect BLE beacons, encrypt location, report            │
└─────────────────────────────────────────────────────────────────┘
                              │ Encrypted reports (HTTPS)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                   │
│              (Auth, Rate Limiting, Geo-routing)                 │
└─────────────────────────────────────────────────────────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│  Report    │ │  Query     │ │ Anti-Stalk │ │Notification│
│  Ingestion │ │  Service   │ │  Service   │ │  Service   │
│            │ │            │ │            │ │            │
│ Store blobs│ │ Lookup by  │ │ Pattern    │ │ Push alerts│
│ No decrypt │ │ id hash   │ │ detection  │ │ Lost mode  │
└─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
      │              │              │              │
      ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────────┬───────────────────┬───────────────────────────┤
│  PostgreSQL     │  Redis/Valkey     │  RabbitMQ                 │
│  - Reports      │  - Cache          │  - Report ingestion       │
│  - Devices      │  - Sessions       │  - Anti-stalk analysis    │
│  - Sightings    │  - Rate limits    │  - Notification delivery  │
│  - Notifications│  - Idempotency    │  - Report cleanup         │
└─────────────────┴───────────────────┴───────────────────────────┘
```

### Privacy Flow (Zero-Knowledge Design)

```
AirTag                          iPhone (finder)              Apple Server              Owner's iPhone
  │                                  │                           │                          │
  │─── BLE: {rotatingId, pubKey} ──▶│                           │                          │
  │                                  │                           │                          │
  │                        Encrypt(myLocation, pubKey)           │                          │
  │                                  │                           │                          │
  │                                  │──── {hash(id), blob} ───▶│                          │
  │                                  │                           │── Store encrypted blob   │
  │                                  │                           │                          │
  │                                  │                           │◀── Query by hash(id) ────│
  │                                  │                           │                          │
  │                                  │                           │──── Return blob ────────▶│
  │                                  │                           │                          │
  │                                  │                      Decrypt(blob, privateKey)       │
  │                                  │                           │           = location      │
```

Apple servers store only encrypted blobs and identifier hashes. They cannot correlate reports to devices or decrypt locations. Only the owner, who holds the master secret, can derive the identifier hashes for their device and decrypt the payloads.

---

## Core Components

### 1. Key Rotation and Beacon Protocol

The AirTag derives a new key pair every 15 minutes from a deterministic master secret shared with the owner's iCloud account.

**Key Derivation Chain:**
1. Master secret (32 bytes) is generated at pairing time and synced to owner's iCloud Keychain
2. Current period = `floor(timestamp / (15 * 60 * 1000))`
3. Period key = `HMAC-SHA256(masterSecret, "airtag_key_" + period)`
4. EC key pair: private key = period key (truncated to P-224 size), public key derived via ECDH
5. BLE identifier = `SHA-256(publicKey)` truncated to 6 bytes
6. BLE advertisement broadcasts: {identifier (6 bytes), publicKey (full)}

**Why 15-minute rotation**: Balances privacy (shorter = harder to track) against battery life (longer = fewer key derivations) and location freshness (reports are only useful within the rotation window). A 15-minute window also aligns with typical urban transit times, preventing long-distance tracking by passive observers.

### 2. Location Reporting (Crowd-Sourced)

When an iPhone detects an AirTag BLE advertisement, it encrypts its own GPS location using the AirTag's public key (ECIES: Elliptic Curve Integrated Encryption Scheme) and submits the encrypted blob to Apple's servers.

**ECIES Encryption:**
1. Generate ephemeral EC key pair (P-224)
2. Compute shared secret via ECDH with AirTag's public key
3. Derive AES-256-GCM key from shared secret using SHA-256
4. Encrypt `{lat, lon, accuracy, timestamp}` with random IV
5. Transmit: `{ephemeralPublicKey, iv, ciphertext, authTag}`

Only the owner (who can derive the matching private key from the master secret) can decrypt. The finder iPhone never knows which AirTag it reported -- it just forwards the blob.

### 3. Location Retrieval (Owner)

When the owner opens Find My, the client derives all possible identifier hashes for a time range (one per 15-minute period), queries Apple's servers for matching encrypted reports, and decrypts each payload locally.

**Query Flow:**
1. Derive period keys for the time range (typically last 24 hours = 96 periods)
2. Compute identifier hash for each period: `SHA-256(SHA-256(publicKey)[:6])`
3. Batch query: `SELECT * FROM location_reports WHERE identifier_hash = ANY($hashes) AND created_at BETWEEN $start AND $end`
4. Decrypt each payload using the period's private key
5. Cache decrypted locations in `decrypted_locations` table for map display

### 4. Anti-Stalking Detection

Detects unknown trackers traveling with a user across multiple locations.

**Detection Algorithm:**
1. iPhone periodically scans for BLE advertisements
2. Unknown identifiers (not belonging to the user's registered devices) are recorded as sightings
3. Sightings are analyzed for stalking patterns within a 3-hour sliding window:
   - **Threshold**: 3+ sightings of the same identifier
   - **Distance**: User has traveled > 500 meters with the tracker
   - **Duration**: Tracker has been present for > 1 hour
4. If pattern detected, alert the user with notification: "Unknown AirTag Detected"
5. Offer options: play sound, show map of sighting locations, instructions to disable

**False Positive Mitigation**: Family members' AirTags, shared spaces (offices, transit), and AirTags on shared items are common false positives. The distance threshold (500m) and time window (1 hour) filter out most static encounters.

### 5. Lost Mode

When enabled, Lost Mode tags the device with contact information. When a network device detects a lost AirTag:
1. The location report is submitted (standard flow)
2. The server checks if the identifier hash matches any device in Lost Mode
3. If matched, a push notification is queued for the owner
4. NFC tap on the AirTag reveals the owner's contact message

---

## Database Schema

### Entity-Relationship Diagram

```
                                ┌─────────────────┐
                                │     session      │
                                │─────────────────│
                                │ sid (PK)         │
                                │ sess (JSON)      │
                                │ expire           │
                                └─────────────────┘

┌─────────────────┐       1:N        ┌─────────────────────┐
│      users      │◄─────────────────│  registered_devices  │
│─────────────────│                  │─────────────────────│
│ id (PK, UUID)   │                  │ id (PK, UUID)        │
│ email (UNIQUE)  │                  │ user_id (FK) ────────┤ CASCADE
│ password_hash   │                  │ device_type          │
│ name            │                  │ name, emoji          │
│ role            │                  │ master_secret        │
└────────┬────────┘                  │ current_period       │
         │                           │ is_active            │
         │ 1:N CASCADE               └──────────┬──────────┘
         │                                       │
         ▼                                       │ 1:1 CASCADE
┌─────────────────┐                              ▼
│  notifications  │                    ┌─────────────────────┐
│─────────────────│                    │     lost_mode        │
│ id (PK, UUID)   │                    │─────────────────────│
│ user_id (FK)    │                    │ device_id (PK, FK)  │
│ device_id (FK)  │ SET NULL           │ enabled             │
│ type            │                    │ contact_phone/email │
│ title, message  │                    │ message             │
│ is_read, data   │                    │ notify_when_found   │
└─────────────────┘                    └─────────────────────┘
         │
         │ 1:N CASCADE                 1:N CASCADE
         ▼                                       ▼
┌─────────────────┐                    ┌─────────────────────┐
│tracker_sightings│                    │ decrypted_locations  │
│─────────────────│                    │─────────────────────│
│ id (PK, BIGSER) │                    │ id (PK, BIGSERIAL)  │
│ user_id (FK)    │                    │ device_id (FK)       │
│ identifier_hash │                    │ latitude, longitude  │
│ latitude, lng   │                    │ accuracy, address    │
│ seen_at         │                    │ timestamp            │
└─────────────────┘                    └─────────────────────┘

┌─────────────────────┐
│  location_reports   │  ◄── Standalone (no FK to devices -- privacy by design)
│─────────────────────│
│ id (PK, BIGSERIAL)  │      Server cannot correlate reports to devices
│ identifier_hash     │      Only owner can derive matching hashes
│ encrypted_payload   │
│ reporter_region     │
│ created_at          │
└─────────────────────┘
```

### Table Definitions

```sql
-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Registered devices (AirTags, iPhones, etc.)
CREATE TABLE IF NOT EXISTS registered_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type VARCHAR(50) NOT NULL CHECK (device_type IN ('airtag', 'iphone', 'macbook', 'ipad', 'airpods')),
    name VARCHAR(100) NOT NULL,
    emoji VARCHAR(10) DEFAULT '📍',
    master_secret VARCHAR(64) NOT NULL,
    current_period INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON registered_devices(user_id);
CREATE INDEX idx_devices_active ON registered_devices(is_active);

-- Location reports (encrypted blobs from crowd-sourced network)
CREATE TABLE IF NOT EXISTS location_reports (
    id BIGSERIAL PRIMARY KEY,
    identifier_hash VARCHAR(64) NOT NULL,
    encrypted_payload JSONB NOT NULL,
    reporter_region VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reports_identifier ON location_reports(identifier_hash);
CREATE INDEX idx_reports_time ON location_reports(created_at);
CREATE INDEX idx_reports_identifier_time ON location_reports(identifier_hash, created_at DESC);

-- Lost mode settings
CREATE TABLE IF NOT EXISTS lost_mode (
    device_id UUID PRIMARY KEY REFERENCES registered_devices(id) ON DELETE CASCADE,
    enabled BOOLEAN DEFAULT FALSE,
    contact_phone VARCHAR(50),
    contact_email VARCHAR(200),
    message TEXT,
    notify_when_found BOOLEAN DEFAULT TRUE,
    enabled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES registered_devices(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('device_found', 'unknown_tracker', 'low_battery', 'system')),
    title VARCHAR(200) NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- Anti-stalking tracker sightings
CREATE TABLE IF NOT EXISTS tracker_sightings (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identifier_hash VARCHAR(64) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sightings_user_identifier ON tracker_sightings(user_id, identifier_hash);
CREATE INDEX idx_sightings_time ON tracker_sightings(seen_at);

-- Decrypted location cache
CREATE TABLE IF NOT EXISTS decrypted_locations (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES registered_devices(id) ON DELETE CASCADE,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    accuracy DECIMAL(10, 2),
    address TEXT,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_decrypted_device ON decrypted_locations(device_id);
CREATE INDEX idx_decrypted_time ON decrypted_locations(device_id, timestamp DESC);

-- Session table for express-session
CREATE TABLE IF NOT EXISTS session (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
);

CREATE INDEX idx_session_expire ON session(expire);
```

### Schema Design Rationale

**location_reports has NO foreign key to registered_devices**: This is the most critical design decision. The server cannot correlate an identifier_hash to a specific device because: (1) identifiers rotate every 15 minutes, (2) only the owner can derive which hashes belong to their device, (3) reports come from anonymous network devices. This enforces the zero-knowledge privacy guarantee.

**Separated encrypted and decrypted data**: `location_reports` stores what the server receives (encrypted blobs, anonymous). `decrypted_locations` stores what the owner sees (plaintext coordinates, linked to device). This separation enforces that the server cannot JOIN reports to devices without the master_secret.

**Lost mode as 1:1 table**: `device_id` is both PK and FK, enforcing exactly one record per device. Separating from `registered_devices` avoids nullable contact columns and cleanly separates device identity from lost state.

**BIGSERIAL for high-volume tables**: `location_reports` (billions of rows), `tracker_sightings`, and `decrypted_locations` use BIGSERIAL for compact storage (8 bytes vs 16 for UUID) and faster sequential inserts. User-facing entities use UUID for security (no enumeration) and distributed generation.

**Partial index for unread notifications**: `WHERE is_read = FALSE` keeps the index small since most notifications are eventually read. The badge count query (`SELECT COUNT(*) WHERE user_id = $1 AND is_read = FALSE`) hits only the small partial index.

### Foreign Key Strategy

| Parent | Child | FK Column | On Delete | Rationale |
|--------|-------|-----------|-----------|-----------|
| `users` | `registered_devices` | `user_id` | CASCADE | Device meaningless without owner |
| `users` | `notifications` | `user_id` | CASCADE | Notifications are user-specific |
| `users` | `tracker_sightings` | `user_id` | CASCADE | Anti-stalking data is user-specific |
| `registered_devices` | `lost_mode` | `device_id` | CASCADE | Lost mode settings meaningless without device |
| `registered_devices` | `notifications` | `device_id` | SET NULL | Preserve notification history ("Your AirTag was found") even after device removal |
| `registered_devices` | `decrypted_locations` | `device_id` | CASCADE | Cached locations useless without device |

---

## API Design

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create user account |
| POST | `/api/auth/login` | Authenticate and create session |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/devices` | List user's registered devices |
| POST | `/api/devices` | Register a new device |
| DELETE | `/api/devices/:id` | Remove a device |
| POST | `/api/locations/report` | Submit encrypted location report (idempotent) |
| GET | `/api/locations/:deviceId` | Get decrypted locations for a device |
| POST | `/api/lost-mode/:deviceId` | Enable/disable lost mode |
| GET | `/api/lost-mode/:deviceId` | Get lost mode status |
| GET | `/api/notifications` | List user notifications |
| PATCH | `/api/notifications/:id/read` | Mark notification as read |
| GET | `/api/anti-stalking/check` | Check for unknown trackers |
| POST | `/api/anti-stalking/sighting` | Report tracker sighting |
| GET | `/api/admin/stats` | Admin dashboard statistics |
| GET | `/health` | Shallow health check (liveness) |
| GET | `/health/ready` | Deep health check (readiness) |
| GET | `/metrics` | Prometheus metrics |

---

## Key Design Decisions

### 1. End-to-End Encryption (Zero-Knowledge)

Apple cannot decrypt location reports. The finder encrypts with the AirTag's rotating public key; only the owner (with the master secret) can derive the matching private key to decrypt. This means Apple is not a liability for location data, and a server breach exposes only encrypted blobs. The trade-off is that Apple cannot provide server-side features like geofencing or location-based alerts -- all location processing must happen on the owner's device after decryption.

### 2. 15-Minute Key Rotation

Rotating BLE identifiers every 15 minutes prevents passive tracking by third parties who observe BLE advertisements. A shorter rotation (e.g., 1 minute) would improve privacy but dramatically increase battery consumption (more key derivations, more BLE advertisement changes) and reduce the window for network devices to submit reports. The 15-minute window provides a practical balance: long enough for nearby iPhones to detect and report, short enough to prevent sustained tracking across a city.

### 3. Anti-Stalking as a First-Class Feature

Rather than relying on users to manually check for trackers, the system proactively scans and alerts. The detection thresholds (3+ sightings, 500m distance, 1 hour duration) are calibrated to minimize false positives from family AirTags, shared spaces, and transit while catching genuine stalking attempts. The trade-off is alert fatigue -- in dense urban environments with many AirTags, the false positive rate can be noticeable. We mitigate this by requiring significant user movement (500m) alongside persistent tracker presence.

---

## Caching and Edge Strategy

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Mobile    │───▶│    CDN      │───▶│   Valkey    │───▶│ PostgreSQL  │
│   Client    │    │  (Static)   │    │   (Cache)   │    │  (Source)   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

| Layer | What's Cached | TTL | Strategy |
|-------|---------------|-----|----------|
| CDN | Static assets, NFC landing pages | 24 hours | Cache-Control headers |
| Valkey L1 | User's device list | 5 minutes | Cache-aside, invalidate on device change |
| Valkey L2 | Location report lookups | 15 minutes | Cache-aside (aligns with key rotation) |
| Valkey L3 | Idempotency keys | 24 hours | Write-on-submit, prevents replay |
| Client | Recent decrypted locations | 1 minute | Stale-while-revalidate |

**Cache-Aside** is the primary pattern: check cache first, fetch from DB on miss, populate cache with TTL. On writes (device registered, lost mode toggled), the relevant cache keys are explicitly invalidated. The 15-minute TTL for reports aligns with key rotation -- cached data expires as new identifiers become active.

---

## Async Queue Architecture (RabbitMQ)

```
┌───────────────────────────────────────────────────────────────┐
│                         RabbitMQ                               │
│                                                                │
│  Exchange: airtag.events (topic)                               │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ location.reports ── Store encrypted blobs (at-least-1) │    │
│  ├────────────────────────────────────────────────────────┤    │
│  │ antistalk.analyze ── Pattern detection (at-least-1)    │    │
│  ├────────────────────────────────────────────────────────┤    │
│  │ notifications.push ── Alert delivery (at-least-1)      │    │
│  ├────────────────────────────────────────────────────────┤    │
│  │ reports.cleanup ── TTL expiration (at-most-1)          │    │
│  └────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

| Queue | Semantics | Prefetch | Backpressure |
|-------|-----------|----------|--------------|
| `location.reports` | At-least-once, idempotent writes | 100 | Max 1M messages, 7-day TTL |
| `antistalk.analyze` | At-least-once, stateless check | 10 | Dead-letter after 2 retries |
| `notifications.push` | At-least-once, dedup in push | 50 | Retry with backoff |
| `reports.cleanup` | At-most-once, cron backup | 1000 | Acceptable to miss some |

---

## Consistency and Idempotency

### Write Semantics

| Operation | Consistency | Idempotency | Rationale |
|-----------|-------------|-------------|-----------|
| Location Report | Eventual | Idempotent (content-hash dedup) | High volume; duplicates are harmless |
| Device Registration | Strong | Idempotent (upsert by device_id) | Critical user data |
| Lost Mode Toggle | Strong | Idempotent (last-write-wins) | User expects immediate effect |
| Anti-Stalking Alert | Eventual | At-least-once | Missing an alert is worse than a duplicate |

**Location Report Idempotency**: The idempotency key is `SHA-256(identifierHash + timestamp_rounded_to_minute + payloadHash)`. Redis stores this key with 24-hour TTL. Duplicate submissions return 200 without re-inserting. This handles client retries on cellular networks.

**Lost Mode Optimistic Locking**: Toggle operations include a version number. The UPDATE checks `WHERE version = $expected`, returning a conflict error if another session modified the record. This prevents race conditions between multiple devices.

---

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | API latency by endpoint |
| `location_reports_total` | Counter | Ingestion throughput, regional breakdown |
| `cache_operations_total{result}` | Counter | Cache hit/miss ratio |
| `db_query_duration_seconds` | Histogram | Slow query detection |
| `rate_limit_hits_total` | Counter | Abuse detection, limit tuning |

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Report ingestion p99 | > 200ms | > 500ms |
| Report error rate | > 1% | > 5% |
| Anti-stalking queue depth | > 10K | > 100K |
| Redis memory | > 80% | > 95% |

### Structured Logging

Pino JSON logs with request correlation IDs, component-level child loggers (e.g., `locationService`, `antiStalkingService`), and automatic redaction of sensitive fields. Development mode uses `pino-pretty` for readability.

---

## Failure Handling

### Graceful Degradation

- **Redis down**: Cache misses fall through to PostgreSQL; rate limiting degrades to in-memory counters; idempotency checks are bypassed (at-least-once is acceptable)
- **RabbitMQ down**: Location reports are written directly to PostgreSQL (synchronous fallback); anti-stalking analysis is deferred until queue recovers
- **PostgreSQL read replica down**: Queries fall back to primary; write performance may degrade

### Retry Strategy

Queue consumers use exponential backoff with dead-letter queues after 3 attempts. HTTP clients retry with jitter on 5xx responses. All retryable operations use idempotency keys.

---

## Scalability Considerations

### What Breaks First

1. **Location report ingestion** -- 10M+ reports/minute requires Kafka-level throughput. RabbitMQ works for moderate scale; at global scale, partition by region with Kafka.
2. **Identifier hash lookups** -- Each owner query generates 96+ hashes (24h / 15min). PostgreSQL compound index handles this, but at 500M AirTags, consider Cassandra partitioned by identifier_hash prefix.
3. **Anti-stalking analysis** -- Per-user pattern detection is CPU-bound. Horizontally scale workers, partition by user_id.

### Horizontal Scaling Path

- **Report ingestion**: Partition by `reporter_region` across Kafka topics and consumer groups
- **Query service**: Stateless, horizontal scaling behind load balancer
- **Anti-stalking**: Worker pool consuming from RabbitMQ with configurable prefetch
- **Database**: Read replicas for query service, time-based partitioning for `location_reports` (7-day retention), geographic sharding for global scale

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Encryption | End-to-end (ECIES) | Server-side | Zero-knowledge privacy; Apple cannot see locations |
| Key rotation | 15 minutes | Hourly / 1 minute | Balance privacy, battery life, and report window |
| Anti-stalking | Proactive alerts | Manual check | Safety-first; false positives preferable to missed stalking |
| Precision finding | UWB | BLE RSSI only | Centimeter-level accuracy vs meter-level |
| Report storage | PostgreSQL + BIGSERIAL | Cassandra | Simpler operations; partition by time at scale |
| Queue | RabbitMQ | Kafka | Easier setup, sufficient for learning scale |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler session management |
| Identifier hash index | Compound B-tree | Hash index | Supports range scans (time-ordered retrieval) |

---

## Frontend Architecture

### Component Hierarchy

```
App (conditional rendering based on auth + tab state)
├── [Unauthenticated]
│   └── LoginForm (email/password + register toggle)
├── [Authenticated]
│   ├── Header (logo, user info, notification bell with badge)
│   ├── NotificationsPanel (slide-out panel, mark read, mark all read)
│   ├── Tab Switcher (My Devices / Admin Dashboard -- admin only)
│   ├── [Devices Tab]
│   │   ├── Device List
│   │   │   └── DeviceCard (emoji, name, type, last location, battery)
│   │   ├── MapView (Leaflet map with device markers + location history)
│   │   └── DeviceDetails (device info, lost mode controls, sound, delete)
│   ├── [Admin Tab]
│   │   └── AdminDashboard (system stats, user list, report counts)
│   └── AddDeviceModal (device type selector, name, emoji picker)
```

### Zustand Store

A single unified store (`useStore`) manages all application state, organized into five domains:

**Auth state**: `user` (current user or null), `isLoading`, `error`. Actions: `login`, `register`, `logout`, `checkAuth`. The `checkAuth` action runs on mount to restore sessions from existing cookies. After login, it cascades to fetch devices and unread notification count.

**Devices state**: `devices` (array of registered devices), `selectedDevice` (currently selected for map/details view). Actions: `fetchDevices`, `createDevice`, `updateDevice`, `deleteDevice`, `selectDevice`, `playSound`. Selecting a device triggers automatic loading of its location history and lost mode settings.

**Locations state**: `locations` (location history for the selected device). Actions: `fetchLocations`, `simulateLocation`. The simulate action is the demo equivalent of a crowd-sourced network report -- clicking on the map submits an encrypted location report for the selected device, then refreshes the location history.

**Lost Mode state**: `lostModeSettings` (Record keyed by device ID). Actions: `fetchLostMode`, `updateLostMode`, `enableLostMode`, `disableLostMode`. Lost mode settings are fetched lazily when a device is selected, not eagerly on login.

**Notifications state**: `notifications` (array), `unreadCount` (for badge display). Actions: `fetchNotifications`, `fetchUnreadCount`, `markAsRead`, `markAllAsRead`. The unread count is fetched on login and decremented optimistically when marking individual notifications as read.

### Routing

The AirTag frontend does not use a router library. Instead, it uses conditional rendering in the root `App` component based on authentication state and a local `activeTab` state variable (`'devices' | 'admin'`). The authentication check happens on mount via `useStore().checkAuth()`. If the user is not authenticated, `LoginForm` is rendered. If authenticated, the main layout (Header + DeviceList + MapView) is rendered. Admin users see a tab switcher to toggle between the devices view and the admin dashboard.

This routing approach is appropriate because the application has only two views (devices and admin), and there is no need for deep linking, browser history, or shareable URLs for internal pages.

### Data Fetching

API communication is centralized in `services/api.ts`, which exports domain-specific API objects (`authApi`, `devicesApi`, `locationsApi`, `lostModeApi`, `notificationsApi`). Each API object wraps `fetch` calls with `credentials: 'include'` for cookie-based session auth and standardized error handling (parsing the response body for error messages).

Data fetching is triggered by store actions, which update state on success. There is no background polling or WebSocket connection -- location data is refreshed by a 30-second `setInterval` timer that runs while a device is selected, and by user-initiated actions (clicking the map to simulate a report).

### Key UI Patterns

**Interactive map with Leaflet**: The `MapView` component renders a Leaflet map showing the selected device's location history as markers. Clicking on the map triggers `simulateLocation`, which submits an encrypted location report for the selected device at the clicked coordinates. This simulates the crowd-sourced Find My network without requiring hardware.

**Device card selection**: `DeviceCard` components support selection via click. Selecting a device loads its location history, renders markers on the map, and shows the `DeviceDetails` panel below the map. The selected device is visually highlighted.

**Notification badge**: The `Header` component shows a bell icon with a badge count of unread notifications. Clicking opens the `NotificationsPanel`, a slide-out panel listing all notifications with mark-as-read and mark-all-as-read actions. The badge count updates optimistically (decrements immediately on mark-as-read without waiting for the API response).

**Periodic location refresh**: When a device is selected, a `useEffect` sets up a 30-second interval to re-fetch locations. This ensures the map stays reasonably current without WebSocket infrastructure. The interval is cleared when the device is deselected or the component unmounts.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in this project. Each explanation covers what the pattern is, why it exists, how it works mechanically, and why it matters for a system operating at scale.

### RBAC (Role-Based Access Control)

RBAC is a method for restricting system access based on the roles assigned to individual users, rather than assigning permissions directly to each user. In this project, users have a `role` column in the `users` table with a CHECK constraint limiting values to `'user'` or `'admin'`.

The purpose of RBAC is to separate "who can do what" from "who is who." Instead of maintaining a per-user permission list (which becomes unmanageable at thousands of users), you define a small set of roles and assign permissions to roles. A user inherits all permissions of their role. In this project, regular users can manage their own devices, view their own locations, and configure lost mode. Admins can additionally view system-wide statistics, see all users, and access report counts.

On the frontend, the admin tab is conditionally rendered only when `user.role === 'admin'`. On the backend, the admin routes middleware verifies the role server-side via the session, so even direct API calls from non-admin users are rejected with 403 Forbidden.

At production scale, RBAC prevents unauthorized access to sensitive operations (viewing all users' device locations, accessing aggregate tracking data) without requiring complex per-resource permission checks on every request.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database, and populates the cache on a miss. The cache does not communicate with the database directly -- the application code sits between them and manages both.

The flow works as follows: (1) The application receives a request for data. (2) It checks Valkey/Redis for a cached value using a deterministic key. (3) If the key exists (cache hit), the cached value is returned immediately, avoiding a database query. (4) If the key does not exist (cache miss), the application queries PostgreSQL, stores the result in Redis with a TTL (time-to-live), and returns the result.

On writes, the application explicitly invalidates (deletes) the relevant cache keys so that subsequent reads fetch fresh data from the database. This project uses cache-aside for device lists (5-minute TTL) and location report lookups (15-minute TTL, aligned with the key rotation period -- cached reports expire as new identifiers become active).

The pattern matters at scale because database queries are orders of magnitude slower than Redis lookups. When an owner queries for their AirTag's location, the server must look up reports by identifier hash across potentially billions of rows. Caching recent lookup results in Redis avoids repeating expensive PostgreSQL index scans for the same query within the TTL window.

The trade-off is eventual consistency: after a new location report arrives, there is a brief window (up to TTL) where the cached result does not include the new report. For location tracking with 15-minute key rotation periods, a few minutes of staleness is acceptable -- the user will see the new location on the next refresh after TTL expiry.

### Circuit Breaker

This project does not implement a circuit breaker in the backend because it does not have an external storage service (like MinIO/S3) that could fail independently. Location reports are stored directly in PostgreSQL, which is the same dependency that handles all other queries. A circuit breaker is most valuable when wrapping calls to an external service that can fail independently of the core database -- see the iCloud project for a full circuit breaker implementation around MinIO operations.

However, the architectural principle still applies: if this system were deployed at production scale with a separate object storage layer for large encrypted payloads, circuit breakers would wrap those storage calls to prevent cascade failures when the storage tier becomes unavailable while allowing metadata queries to continue functioning.

### Structured Logging

Structured logging means emitting log entries as machine-parseable data (typically JSON objects) rather than free-form text strings. Each log entry contains a set of named fields (timestamp, level, message, request ID, component name, etc.) that can be indexed, searched, and aggregated by log management systems.

This project uses Pino, a high-performance Node.js JSON logger. In development, `pino-pretty` formats the output for human readability. In production, raw JSON is emitted for consumption by log aggregation systems (ELK stack, Grafana Loki).

Key features of the logging setup:
- **Component child loggers**: Separate child loggers are created for `locationService`, `antiStalkingService`, and other components. Each child logger automatically includes the component name in every log entry, making it trivial to filter logs by subsystem.
- **Request correlation**: Each HTTP request receives a unique ID that propagates through all log entries generated during that request. This allows tracing a single location report from ingestion through queue processing to storage.
- **Sensitive field redaction**: The logger is configured to automatically redact sensitive fields, preventing accidental logging of master secrets, encrypted payloads, or session tokens.

At scale, structured logging is essential because text-based logging is unsearchable across thousands of server instances processing millions of location reports per minute. When investigating why a particular device's location is not updating, you need to search across all servers for that device's identifier hash. With structured logs, this is a simple JSON field query. With text logs, you would need regex matching across terabytes of log files.

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical measurements from applications at regular intervals (scraping). Applications expose an HTTP endpoint (`/metrics`) in a specific text format, and the Prometheus server periodically fetches this endpoint.

This project exposes metrics via the `prom-client` library with the following metric types:

- **Histogram** (`http_request_duration_seconds`): Records the distribution of API latency by endpoint. Prometheus computes percentiles (p50, p95, p99). This answers "what is the latency that 99% of requests are below?"
- **Counter** (`location_reports_total`): Tracks total ingested reports, segmented by region. Since counters only increase, Prometheus computes the rate (reports/second) by differentiating over time.
- **Counter** (`cache_operations_total` with `result` label): Tracks cache hits and misses. The hit rate (hits / (hits + misses)) indicates whether the cache is effective.
- **Counter** (`rate_limit_hits_total`): Counts how often rate limits are triggered, useful for detecting abuse patterns and tuning limits.
- **Histogram** (`db_query_duration_seconds`): Detects slow database queries before they become user-facing latency issues.

At scale, metrics enable alerting and capacity planning. Without metrics, you discover that report ingestion is backed up only when users report stale locations. With metrics, you set an alert: "if ingestion p99 exceeds 500ms for 5 minutes, page the on-call engineer." Metrics also reveal trends: "report volume has increased 20% this month" -- which signals the need to add more ingestion workers or move from RabbitMQ to Kafka.

### Rate Limiting

Rate limiting restricts how many requests a client can make to the API within a time window. Its purpose is to prevent abuse (intentional or accidental) from overwhelming the server and degrading service for all users.

This project implements per-endpoint rate limiting with Redis-backed counters:

| Endpoint Group | Limit | Window | Purpose |
|---------------|-------|--------|---------|
| Auth (login/register) | 10 | 1 minute | Prevent brute-force login attacks |
| Location reports | 100 | 1 minute | Throttle high-volume report submission |
| Location queries | 60 | 1 minute | Prevent excessive polling |
| Admin endpoints | 20 | 1 minute | Protect admin operations |

Each incoming request increments a counter keyed by the client's IP address and endpoint group. If the counter exceeds the limit, the server returns 429 Too Many Requests with a `Retry-After` header.

Rate limiting is especially important for the location report endpoint because it is publicly accessible (any Find My network device can submit reports). Without rate limiting, a malicious actor could flood the ingestion pipeline with fake reports, consuming database write capacity and queue space. Per-endpoint limits ensure that a burst of report submissions does not affect the owner's ability to query their device's location.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In a distributed system with unreliable networks, clients frequently retry requests when they do not receive a response. Without idempotency, a retry could create duplicate location reports or duplicate device registrations.

This project implements idempotency for location reports using content-hash deduplication. The idempotency key is `SHA-256(identifierHash + timestamp_rounded_to_minute + payloadHash)`. This key is stored in Redis with a 24-hour TTL. When a duplicate report arrives (same identifier, same time window, same payload), the server returns 200 without re-inserting the report.

This approach is particularly important for the Find My network because reports are submitted by iPhones on cellular networks, which are prone to timeouts and retries. A single AirTag detection might generate multiple submission attempts from the same finder device. Without deduplication, each retry would create a separate database row, inflating report counts and wasting storage. The content-hash approach ensures that duplicate reports are detected regardless of which server instance processes the retry.

Device registration uses upsert semantics (INSERT ON CONFLICT UPDATE), which is another form of idempotency -- registering the same device twice updates the existing record rather than creating a duplicate.

### Health Checks

Health checks are HTTP endpoints that report whether the application is functioning correctly. They are designed for automated systems (load balancers, container orchestrators) to determine whether to route traffic to an instance.

This project implements a two-tier health check system:

1. **`/health`** (liveness probe): Returns 200 if the process is running. This is the simplest check -- if the HTTP server can respond at all, the process is alive. Kubernetes uses this to decide whether to restart a container.

2. **`/health/ready`** (readiness probe): Tests connectivity to PostgreSQL and Redis. It executes a lightweight query against each dependency (e.g., `SELECT 1` for PostgreSQL, `PING` for Redis). If either dependency is unreachable, the endpoint returns 503 Service Unavailable. Load balancers use this to stop routing traffic to instances that cannot serve requests.

The distinction between liveness and readiness is critical at scale. A server stuck in an infinite loop is not live (needs restart). A server that just started and has not yet established database connections is live but not ready (should not receive traffic yet). A server whose Redis connection was temporarily dropped during a Redis failover is live but not ready until the connection is re-established.

Without health checks, a load balancer has no way to know that an instance is unhealthy. It continues routing traffic to a broken instance, causing user-facing errors, while healthy instances sit underutilized. Health checks enable automatic traffic shifting away from unhealthy instances within seconds of a failure.

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + Express + React.

### Local Architecture

```
┌─────────────────────────────────────────────────────────────┐
│               React Frontend (:5173)                         │
│  MapView (Leaflet) + DeviceCards + NotificationsPanel        │
│  LoginForm + AddDeviceModal + AdminDashboard                 │
│  State: Zustand (useStore)                                   │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP (fetch, credentials: include)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│           Express Backend (:3000)                             │
│  Routes: auth, devices, locations, lostMode,                │
│          notifications, antiStalking, admin                  │
│  Middleware: session (Redis), auth, rate limiting            │
│  Shared: logger, metrics, cache, idempotency, health        │
└──────┬──────────────┬──────────────┬────────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐
│ PostgreSQL │ │   Valkey   │ │  RabbitMQ  │
│  (:5432)   │ │  (:6379)   │ │(:5672/mgmt │
│ DB: findmy │ │  Sessions, │ │  :15672)   │
│ User:findmy│ │  cache,    │ │ Location   │
│            │ │  rate limit│ │ workers    │
└────────────┘ └────────────┘ └────────────┘
```

**Workers** (separate processes):
- `location-worker` (`src/workers/location-worker.ts`) -- consumes from RabbitMQ, stores encrypted reports, checks lost mode, triggers notifications
- `notification-worker` (`src/workers/notification-worker.ts`) -- processes notification queue

### Production Patterns Actually Implemented

| Pattern | File | Why It Matters at Scale |
|---------|------|------------------------|
| Structured logging (Pino) | `backend/src/shared/logger.ts` | JSON logs with component-level child loggers, request IDs for correlation |
| Prometheus metrics | `backend/src/shared/metrics.ts` | HTTP duration histograms, report counters, cache hit/miss, rate limit hits |
| Redis caching (cache-aside) | `backend/src/shared/cache.ts` | 15-min TTL for location lookups, 5-min TTL for device lists; invalidate on write |
| Idempotency | `backend/src/shared/idempotency.ts` | Content-hash dedup for location reports, 24h Redis TTL, safe retries |
| Rate limiting (Redis-backed) | `backend/src/shared/rateLimit.ts` | Per-endpoint: auth 10/min, reports 100/min, queries 60/min, admin 20/min |
| Health checks | `backend/src/shared/health.ts` | `/health` (liveness), `/health/ready` (PostgreSQL + Redis check) |
| Session auth (Redis store) | `backend/src/index.ts` | connect-redis with 24h session TTL, httpOnly cookies |
| AES-256-GCM encryption | `backend/src/utils/crypto.ts` | Simplified ECIES: HMAC-SHA256 key derivation, AES-256-GCM for payloads |
| Key rotation | `backend/src/utils/crypto.ts` | 15-minute period derivation from master secret |
| Anti-stalking detection | `backend/src/services/antiStalkingService.ts` | Sighting count, distance, time-span heuristics with 1h alert cooldown |
| RabbitMQ workers | `backend/src/workers/location-worker.ts` | Background report processing with prefetch, ack/nack, lost mode notification trigger |
| Notification service | `backend/src/services/notificationService.ts` | Database-backed notifications with unread count, type filtering |

### Simplifications from Production Design

| Production | Local Substitute | Why |
|------------|-----------------|-----|
| ECIES with P-224 elliptic curves | AES-256-GCM with HMAC-SHA256 key derivation | Full ECIES requires hardware key management; simplified crypto demonstrates the pattern |
| Hardware BLE beacon | Simulated via map clicks in frontend | No physical AirTag hardware |
| Billions of Find My network devices | Single user submitting reports manually | Demonstrates the protocol without crowd-sourcing |
| Kafka for report ingestion | RabbitMQ with 2 worker instances | Sufficient for dev scale, same at-least-once semantics |
| Hardware Security Module (HSM) | Master secret stored as plaintext in DB | HSM integration requires specialized hardware |
| Push notifications (APNs) | Database notifications polled by frontend | No Apple Push Notification Service access |
| UWB precision finding | Not implemented | Requires U1 chip hardware |
| NFC identification | Not implemented | Requires NFC reader hardware |
| OAuth / Apple ID | Session-based email/password auth | Simpler; focused on tracking, not identity |

### What Was Omitted

- **CDN and edge caching** -- no multi-POP deployment
- **Multi-region deployment** -- single local instance
- **Kubernetes orchestration** -- Docker Compose only
- **Geographic sharding** -- single PostgreSQL instance
- **Time-based table partitioning** -- single `location_reports` table
- **UWB precision finding** -- hardware required
- **NFC tap identification** -- hardware required
- **Power management / BLE advertising** -- hardware required
- **iCloud Keychain integration** -- Apple ecosystem only
- **GDPR data export pipeline** -- CASCADE delete implemented, export not
