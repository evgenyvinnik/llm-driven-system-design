# AirTag - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design AirTag, Apple's item tracking system that uses a crowd-sourced network of billions of Apple devices to locate lost items. As a fullstack engineer, the key challenges span the entire stack:
- End-to-end encrypted location flow from network detection to owner's map
- Privacy-preserving key rotation synchronized between device and server
- Real-time anti-stalking detection with immediate user notification
- UWB precision finding with directional UI feedback
- Lost mode workflow with NFC/contact info display

---

## Requirements Clarification

### Functional Requirements
1. **Device Registration**: Pair AirTag with owner's account
2. **Location Tracking**: Crowd-sourced detection and encrypted reporting
3. **Location Display**: Decrypt and show on interactive map
4. **Precision Finding**: UWB-based directional guidance
5. **Lost Mode**: Enable contact sharing when found
6. **Anti-Stalking**: Detect and alert about unknown trackers

### Non-Functional Requirements
1. **Privacy**: End-to-end encryption - Apple cannot see locations
2. **Scale**: 1B+ devices in Find My network
3. **Latency**: Location updates within 15 minutes
4. **Offline**: View last known locations without network

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          AirTag Device                                   │
│                (BLE beacon, rotating keys every 15 min)                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ BLE Advertisement
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Find My Network Device                              │
│                 (Detects AirTag, encrypts location)                      │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │     Encrypt location with AirTag's public key (ECIES)           │   │
│   │     Submit encrypted blob to Apple servers                       │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Encrypted Report
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Backend Services                                 │
│                                                                          │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐             │
│   │  Report API  │    │  Query API   │    │  Anti-Stalk  │             │
│   │ (Ingestion)  │    │ (Retrieval)  │    │ (Detection)  │             │
│   └──────────────┘    └──────────────┘    └──────────────┘             │
│           │                  │                    │                      │
│           └──────────────────┴────────────────────┘                     │
│                              │                                           │
│   ┌──────────────────────────┴───────────────────────────────────┐      │
│   │   PostgreSQL (encrypted blobs) │ Redis (cache, rate limit)   │      │
│   └──────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Encrypted Reports
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Owner's Find My App                                │
│                                                                          │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐             │
│   │ Key Manager  │    │  Decryption  │    │ Map Display  │             │
│   │(Derive keys) │    │   Service    │    │  (Leaflet)   │             │
│   └──────────────┘    └──────────────┘    └──────────────┘             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: End-to-End Location Flow

### Complete Data Flow: Detection to Display

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            LOCATION FLOW                                  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  1. BROADCAST                                                             │
│  ┌─────────┐                                                              │
│  │ AirTag  │──▶ BLE Advertisement (rotating public key + identifier)     │
│  └─────────┘                                                              │
│       │                                                                   │
│       ▼                                                                   │
│  2. DETECTION                                                             │
│  ┌──────────────┐                                                         │
│  │Finder iPhone │──▶ encryptLocation(myGPS, airtagPublicKey)             │
│  └──────────────┘                                                         │
│       │                                                                   │
│       ▼                                                                   │
│  3. SUBMISSION                                                            │
│  ┌──────────────┐         ┌──────────────┐                               │
│  │ POST /report │────────▶│  Report API  │                               │
│  │              │         │              │                               │
│  │ - identifier │         │  - Validate  │                               │
│  │ - encrypted  │         │  - Dedupe    │                               │
│  │ - timestamp  │         │  - Store     │                               │
│  └──────────────┘         └──────────────┘                               │
│                                   │                                       │
│                                   ▼                                       │
│  4. STORAGE                                                               │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ PostgreSQL: location_reports                                    │      │
│  │                                                                 │      │
│  │ identifier_hash │ encrypted_payload (JSONB)                     │      │
│  │ ────────────────┼───────────────────────────────────────────    │      │
│  │ a1b2c3d4...     │ {ephemeralKey, iv, ciphertext, authTag}       │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                   │                                       │
│                                   ▼                                       │
│  5. QUERY (Owner's Device)                                                │
│  ┌──────────────┐         ┌──────────────┐                               │
│  │  Owner App   │────────▶│  Query API   │                               │
│  │              │         │              │                               │
│  │ - Generate   │◀────────│ - Return     │                               │
│  │   id hashes  │         │   encrypted  │                               │
│  │              │         │   blobs      │                               │
│  └──────────────┘         └──────────────┘                               │
│       │                                                                   │
│       ▼                                                                   │
│  6. DECRYPTION (Client-side)                                              │
│  ┌──────────────┐                                                         │
│  │  Decryption  │──▶ for each report:                                    │
│  │   Service    │      privateKey = deriveKey(masterSecret, period)      │
│  │              │      location = decrypt(report, privateKey)            │
│  └──────────────┘                                                         │
│       │                                                                   │
│       ▼                                                                   │
│  7. DISPLAY                                                               │
│  ┌──────────────┐                                                         │
│  │Map Component │──▶ Show marker at decrypted lat/lon                    │
│  └──────────────┘                                                         │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Backend: Report Ingestion API

The report ingestion endpoint handles incoming location reports from finder devices:

1. **Validate timestamp** - Reject reports older than 7 days
2. **Generate idempotency key** - Hash of identifier + minute-rounded timestamp
3. **Check for duplicate** - Redis lookup with TTL
4. **Store encrypted report** - PostgreSQL with JSONB payload
5. **Cache idempotency key** - 24-hour TTL in Redis
6. **Queue anti-stalking analysis** - Publish to RabbitMQ for async processing

> "I chose Redis for idempotency because we need sub-millisecond lookups at high throughput. The 24-hour TTL ensures memory doesn't grow unbounded."

### Frontend: Location Query and Decryption

The owner's app performs client-side decryption:

1. **Generate identifier hashes** - For each 15-minute period in the time range
2. **Derive private keys** - Using HKDF from master secret + period
3. **Query server** - POST with identifier hashes, get back encrypted blobs
4. **Decrypt locally** - Try each period's key until successful
5. **Display on map** - Sorted by timestamp, most recent first

> "Client-side decryption is the key privacy guarantee. The server only sees encrypted blobs and identifier hashes - it cannot correlate them to any user or location."

---

## Deep Dive: Key Rotation System

### Synchronized Key Derivation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      KEY DERIVATION FLOW                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Master Secret (shared at pairing)                                       │
│       │                                                                  │
│       ▼                                                                  │
│  ┌────────────────────────────────────────┐                             │
│  │              HKDF-SHA256               │                             │
│  │   salt = "airtag_period_{period}"      │                             │
│  │   info = "private_key"                 │                             │
│  └────────────────────────────────────────┘                             │
│       │                                                                  │
│       ▼                                                                  │
│  Private Key (256 bits)                                                  │
│       │                                                                  │
│       ▼                                                                  │
│  ┌────────────────────────────────────────┐                             │
│  │        Elliptic Curve (P-256)          │                             │
│  │        Derive Public Key               │                             │
│  └────────────────────────────────────────┘                             │
│       │                                                                  │
│       ▼                                                                  │
│  ┌────────────────────────────────────────┐                             │
│  │           SHA-256(publicKey)           │                             │
│  │         Take first 6 bytes             │                             │
│  └────────────────────────────────────────┘                             │
│       │                                                                  │
│       ▼                                                                  │
│  BLE Identifier (broadcasted by AirTag)                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

Both the AirTag and owner's device derive the same keys from a shared master secret:
- **Period calculation**: `Math.floor(Date.now() / (15 * 60 * 1000))`
- **Key derivation**: HKDF with period-specific salt
- **Identifier generation**: First 6 bytes of SHA-256(publicKey)

### Backend: Key Period Validation

Reports are validated to ensure timestamp matches the expected key period:
- Current period calculated from system time
- Allow 2 periods (30 minutes) of clock drift
- Reject reports with mismatched timing

---

## Deep Dive: Anti-Stalking Detection

### End-to-End Alert Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        ANTI-STALKING FLOW                                 │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  1. User's iPhone detects unknown AirTag                                  │
│  ┌──────────────┐                                                         │
│  │  Background  │──▶ Record sighting locally                             │
│  │  BLE Scanner │    Check: Is this my device? (local device list)       │
│  └──────────────┘                                                         │
│         │                                                                 │
│         │ Not my device                                                   │
│         ▼                                                                 │
│  2. Report to anti-stalking service                                       │
│  ┌──────────────┐         ┌──────────────┐                               │
│  │ POST /stalk  │────────▶│  Anti-Stalk  │                               │
│  │              │         │   Service    │                               │
│  │ - identifier │         │              │                               │
│  │ - my_location│         │  - Record    │                               │
│  │              │         │  - Analyze   │                               │
│  └──────────────┘         └──────────────┘                               │
│                                   │                                       │
│                                   ▼                                       │
│  3. Pattern analysis (backend)                                            │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ SELECT sightings WHERE user_id AND identifier_hash             │      │
│  │   AND seen_at > NOW() - 3 hours                                │      │
│  │                                                                 │      │
│  │ IF sightings >= 3 AND (distance > 500m OR time > 1 hour)       │      │
│  │   THEN trigger_alert()                                          │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                   │                                       │
│                                   ▼                                       │
│  4. Create notification                                                   │
│  ┌──────────────┐         ┌──────────────┐                               │
│  │  INSERT INTO │────────▶│    Push      │                               │
│  │ notifications│         │   Service    │                               │
│  └──────────────┘         └──────────────┘                               │
│                                   │                                       │
│                                   ▼                                       │
│  5. Display alert (frontend)                                              │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │                                                                 │      │
│  │  [!] Unknown AirTag Detected                                    │      │
│  │  An AirTag has been traveling with you for 2 hours.            │      │
│  │                                                                 │      │
│  │  [View Locations] [Play Sound] [Learn More]                     │      │
│  │                                                                 │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Detection Algorithm

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Alert Threshold | 3 sightings | Avoid false positives from brief proximity |
| Time Window | 3 hours | Balance detection speed vs noise |
| Distance Threshold | 500 meters | User has moved significantly |
| Time Threshold | 1 hour | Long co-location even without movement |
| Alert Cooldown | 1 hour | Prevent notification spam |

> "The algorithm uses both distance AND time because someone might be followed while stationary (at a restaurant) or while moving (commuting). Either pattern should trigger an alert."

### Frontend: Unknown Tracker Alert Component

The alert component provides:
- Clear warning message with time since first detection
- Location count for severity indication
- "View Locations" button to show tracker's path on map
- "Play Sound" button to help locate the physical device
- Toast notification when sound command is sent

---

## Deep Dive: Lost Mode Workflow

### Complete Lost Mode Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          LOST MODE FLOW                                   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  1. Owner enables Lost Mode                                               │
│  ┌──────────────┐         ┌──────────────┐                               │
│  │LostModePanel │────────▶│PUT /devices  │                               │
│  │              │         │  /{id}/lost  │                               │
│  │ - Toggle on  │         │              │                               │
│  │ - Contact    │         │ - Store info │                               │
│  │   info       │         │ - Notify     │                               │
│  └──────────────┘         └──────────────┘                               │
│                                   │                                       │
│                                   ▼                                       │
│  2. Database update                                                       │
│  ┌────────────────────────────────────────────────────────────────┐      │
│  │ INSERT INTO lost_mode (device_id, enabled, contact_phone,      │      │
│  │                        contact_email, message)                  │      │
│  │ VALUES (...) ON CONFLICT (device_id) DO UPDATE                  │      │
│  └────────────────────────────────────────────────────────────────┘      │
│                                   │                                       │
│  3. Finder taps AirTag with NFC                                           │
│  ┌──────────────┐                                                         │
│  │   Finder's   │──▶ NFC reads AirTag identifier                         │
│  │   iPhone     │──▶ Opens found.apple.com/item?id=xxx                   │
│  └──────────────┘                                                         │
│         │                                                                 │
│         ▼                                                                 │
│  4. Display contact info                                                  │
│  ┌──────────────┐         ┌──────────────┐                               │
│  │ GET /found/  │────────▶│  Found API   │                               │
│  │    {id}      │         │              │                               │
│  │              │◀────────│ - Return     │                               │
│  │ Show contact │         │   contact    │                               │
│  │ to finder    │         │   info       │                               │
│  └──────────────┘         └──────────────┘                               │
│                                   │                                       │
│  5. Notify owner                                                          │
│  ┌──────────────┐         ┌──────────────┐                               │
│  │  INSERT INTO │────────▶│   Push to    │                               │
│  │ notifications│         │    owner     │                               │
│  └──────────────┘         └──────────────┘                               │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Backend: Lost Mode API

**Enable/Update Endpoint (PUT /api/v1/devices/:deviceId/lost-mode)**
- Verify device ownership via user_id
- Upsert lost mode settings (enabled, contact info, message)
- Create system notification for owner
- enabled_at timestamp set only when enabling

**Found Page API (GET /api/v1/found/:identifier)**
- Public endpoint, no auth required
- Look up device by identifier, check if Lost Mode enabled
- Return name, emoji, contact info, and message
- Create notification to owner that device was found

### Frontend: Lost Mode Panel

The panel provides:
- Toggle switch to enable/disable
- Phone number input
- Email input
- Custom message textarea
- Save button (disabled when Lost Mode off)
- Visual feedback on state changes

---

## Deep Dive: State Management

### Zustand Store Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FIND MY STORE                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STATE                                                                   │
│  ├── devices: RegisteredDevice[]                                         │
│  ├── selectedDeviceId: string | null                                     │
│  ├── locations: Map<deviceId, DecryptedLocation[]>                       │
│  ├── decryptionStatus: 'idle' | 'loading' | 'decrypting' | 'done'       │
│  ├── notifications: Notification[]                                       │
│  └── unreadCount: number                                                 │
│                                                                          │
│  ACTIONS                                                                 │
│  ├── setSelectedDevice(id) ──▶ triggers fetchLocations                  │
│  ├── fetchDevices() ──▶ GET /api/v1/devices                             │
│  ├── fetchLocations(deviceId, timeRange) ──▶ decrypt pipeline           │
│  ├── refreshNotifications() ──▶ GET /api/v1/notifications               │
│  └── markRead(id) ──▶ POST /api/v1/notifications/{id}/read              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Location Fetch Flow

1. **Get master secret** from local storage
2. **Create KeyManager** with master secret
3. **Generate identifier hashes** for time range
4. **Query server** with hashes
5. **Decrypt reports** using derived keys
6. **Update store** with decrypted locations

> "I chose Zustand over Redux because the API is simpler and it's sufficient for this app's complexity. The location decryption happens client-side to maintain the privacy guarantee."

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Client-side decryption | WebCrypto API | Server decryption | Privacy - server never sees locations |
| No FK on location_reports | Privacy design | FK to devices | Server cannot correlate reports to owners |
| 15-min key rotation | Time-based periods | Per-broadcast IDs | Balance privacy vs. battery/complexity |
| Redis for idempotency | In-memory with TTL | DB unique constraint | Sub-ms checks for high throughput |
| Proactive anti-stalking | Background scanning | Manual check | Safety - catch tracking users wouldn't notice |
| Zustand for state | Simpler API | Redux | Sufficient for app complexity |

---

## Future Enhancements

1. **AR Precision Finding**: Camera-based overlay for visual guidance
2. **ML Anti-Stalking**: Anomaly detection beyond rule-based patterns
3. **Offline Mode**: Full offline decryption with cached master secrets
4. **Family Sharing**: Share device locations with permission management
5. **Geo-Fencing**: Notify when device leaves defined area
6. **History Playback**: Animated timeline of device movement
