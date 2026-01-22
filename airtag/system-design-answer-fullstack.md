# AirTag - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design AirTag, Apple's item tracking system that uses a crowd-sourced network of billions of Apple devices to locate lost items. As a fullstack engineer, the key challenges span the entire stack:
- End-to-end encrypted location flow from network detection to owner's map
- Privacy-preserving key rotation synchronized between device and server
- Real-time anti-stalking detection with immediate user notification
- UWB precision finding with directional UI feedback
- Lost mode workflow with NFC/contact info display

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

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      AirTag Device                               │
│            (BLE beacon, rotating keys every 15 min)             │
└─────────────────────────────────────────────────────────────────┘
                              │ BLE Advertisement
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Find My Network Device                         │
│              (Detects AirTag, encrypts location)                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Encrypt location with AirTag's public key (ECIES)      │   │
│  │  Submit encrypted blob to Apple servers                  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │ Encrypted Report
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Backend Services                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Report API   │  │ Query API    │  │ Anti-Stalk   │          │
│  │ (Ingestion)  │  │ (Retrieval)  │  │ (Detection)  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│          │                │                  │                   │
│          └────────────────┴──────────────────┘                  │
│                           │                                      │
│  ┌────────────────────────┴────────────────────────────────┐   │
│  │  PostgreSQL (encrypted blobs) | Redis (cache, rate limit)│   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │ Encrypted Reports
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Owner's Find My App                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Key Manager  │  │ Decryption   │  │ Map Display  │          │
│  │ (Derive keys)│  │ Service      │  │ (Leaflet)    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: End-to-End Location Flow

### Complete Data Flow: Detection to Display

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        LOCATION FLOW                                      │
│                                                                           │
│  1. BROADCAST                                                             │
│  ┌─────────┐                                                              │
│  │ AirTag  │──▶ BLE Advertisement (rotating public key + identifier)     │
│  └─────────┘                                                              │
│       │                                                                   │
│       ▼                                                                   │
│  2. DETECTION                                                             │
│  ┌──────────────┐                                                         │
│  │ Finder iPhone │                                                        │
│  │              │──▶ encryptLocation(myGPS, airtagPublicKey)             │
│  └──────────────┘                                                         │
│       │                                                                   │
│       ▼                                                                   │
│  3. SUBMISSION                                                            │
│  ┌──────────────┐     ┌──────────────┐                                   │
│  │ POST /report │────▶│ Report API   │                                   │
│  │ {            │     │              │                                   │
│  │  identifier  │     │ - Validate   │                                   │
│  │  encrypted   │     │ - Dedupe     │                                   │
│  │  timestamp   │     │ - Store      │                                   │
│  │ }            │     └──────────────┘                                   │
│  └──────────────┘            │                                           │
│                              ▼                                            │
│  4. STORAGE                                                               │
│  ┌──────────────────────────────────────────────────────────────┐        │
│  │ PostgreSQL: location_reports                                  │        │
│  │ ┌────────────────┬──────────────────────────────────────────┐│        │
│  │ │ identifier_hash│ encrypted_payload (JSONB)                 ││        │
│  │ ├────────────────┼──────────────────────────────────────────┤│        │
│  │ │ a1b2c3d4...    │ {ephemeralKey, iv, ciphertext, authTag}  ││        │
│  │ └────────────────┴──────────────────────────────────────────┘│        │
│  └──────────────────────────────────────────────────────────────┘        │
│                              │                                            │
│                              ▼                                            │
│  5. QUERY (Owner's Device)                                                │
│  ┌──────────────┐     ┌──────────────┐                                   │
│  │ Owner App    │────▶│ Query API    │                                   │
│  │              │     │              │                                   │
│  │ - Generate   │◀────│ - Return     │                                   │
│  │   identifier │     │   encrypted  │                                   │
│  │   hashes     │     │   blobs      │                                   │
│  └──────────────┘     └──────────────┘                                   │
│       │                                                                   │
│       ▼                                                                   │
│  6. DECRYPTION (Client-side)                                              │
│  ┌──────────────┐                                                         │
│  │ Decryption   │──▶ for each report:                                    │
│  │ Service      │      privateKey = deriveKey(masterSecret, period)      │
│  │              │      location = decrypt(report, privateKey)            │
│  └──────────────┘                                                         │
│       │                                                                   │
│       ▼                                                                   │
│  7. DISPLAY                                                               │
│  ┌──────────────┐                                                         │
│  │ Map Component│──▶ Show marker at decrypted lat/lon                    │
│  └──────────────┘                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

### Backend: Report Ingestion API

```typescript
// POST /api/v1/reports
app.post('/api/v1/reports', async (req, res) => {
  const { identifierHash, encryptedPayload, timestamp } = req.body;

  // 1. Validate timestamp (reject stale reports)
  const reportAge = Date.now() - timestamp;
  if (reportAge > 7 * 24 * 60 * 60 * 1000) {  // 7 days
    return res.status(400).json({ error: 'Report too old' });
  }

  // 2. Generate idempotency key
  const idempotencyKey = crypto.createHash('sha256')
    .update(`${identifierHash}:${Math.floor(timestamp / 60000)}`)
    .digest('hex')
    .slice(0, 32);

  // 3. Check for duplicate (Redis)
  const existing = await redis.get(`idem:${idempotencyKey}`);
  if (existing) {
    return res.status(200).json({ reportId: existing, duplicate: true });
  }

  // 4. Store encrypted report (PostgreSQL)
  const result = await db.query(`
    INSERT INTO location_reports (identifier_hash, encrypted_payload, created_at)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [identifierHash, encryptedPayload, new Date(timestamp)]);

  const reportId = result.rows[0]?.id || idempotencyKey;

  // 5. Cache idempotency key
  await redis.setex(`idem:${idempotencyKey}`, 86400, reportId.toString());

  // 6. Queue anti-stalking analysis
  await channel.publish('airtag.events', 'report.new', Buffer.from(JSON.stringify({
    identifierHash,
    timestamp
  })));

  return res.status(202).json({ reportId });
});
```

### Frontend: Location Query and Decryption

```tsx
function useDeviceLocations(deviceId: string) {
  const { masterSecret } = useAuth();
  const [locations, setLocations] = useState<DecryptedLocation[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'decrypting' | 'done'>('idle');

  const fetchAndDecrypt = useCallback(async (timeRange: TimeRange) => {
    setStatus('loading');

    // 1. Generate all possible identifier hashes for time range
    const identifierHashes: string[] = [];
    const periodKeys = new Map<number, CryptoKey>();

    const startPeriod = Math.floor(timeRange.start / (15 * 60 * 1000));
    const endPeriod = Math.floor(timeRange.end / (15 * 60 * 1000));

    for (let period = startPeriod; period <= endPeriod; period++) {
      const privateKey = await deriveKeyForPeriod(masterSecret, period);
      const publicKey = await derivePublicKey(privateKey);
      const identifier = await sha256(publicKey).slice(0, 6);
      const hash = await sha256(identifier);

      identifierHashes.push(hash);
      periodKeys.set(period, privateKey);
    }

    // 2. Query server for matching encrypted reports
    const response = await fetch('/api/v1/locations/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifierHashes,
        startTime: timeRange.start,
        endTime: timeRange.end
      })
    });

    const { reports } = await response.json();
    setStatus('decrypting');

    // 3. Decrypt reports locally
    const decrypted: DecryptedLocation[] = [];

    for (const report of reports) {
      for (const [period, privateKey] of periodKeys) {
        try {
          const location = await decryptReport(report.encrypted_payload, privateKey);
          decrypted.push({
            ...location,
            reportId: report.id,
            period
          });
          break;  // Found matching key
        } catch {
          // Wrong key, try next period
        }
      }
    }

    setLocations(decrypted.sort((a, b) => b.timestamp - a.timestamp));
    setStatus('done');
  }, [masterSecret]);

  return { locations, status, fetchAndDecrypt };
}

// Decryption using Web Crypto API
async function decryptReport(
  payload: EncryptedPayload,
  privateKey: CryptoKey
): Promise<RawLocation> {
  const { ephemeralPublicKey, iv, ciphertext, authTag } = payload;

  // Import ephemeral public key
  const ephemeralKey = await crypto.subtle.importKey(
    'raw',
    base64ToBuffer(ephemeralPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // Derive shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephemeralKey },
    privateKey,
    256
  );

  // Derive AES key
  const aesKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    aesKey,
    concatBuffers(base64ToBuffer(ciphertext), base64ToBuffer(authTag))
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}
```

## Deep Dive: Key Rotation System

### Synchronized Key Derivation

Both the AirTag and owner's device derive the same keys from a shared master secret.

```typescript
// Shared between AirTag firmware and owner's app
class KeyManager {
  constructor(private masterSecret: string) {}

  // Get current 15-minute period
  getCurrentPeriod(): number {
    return Math.floor(Date.now() / (15 * 60 * 1000));
  }

  // Derive private key for a period
  async derivePrivateKey(period: number): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.masterSecret),
      { name: 'HKDF' },
      false,
      ['deriveBits']
    );

    const privateKeyBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(`airtag_period_${period}`),
        info: encoder.encode('private_key')
      },
      keyMaterial,
      256
    );

    return new Uint8Array(privateKeyBits);
  }

  // Derive public key from private key
  async derivePublicKey(privateKey: Uint8Array): Promise<Uint8Array> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );

    // In reality, derive from privateKey; simplified here
    const publicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    return new Uint8Array(publicKey);
  }

  // Generate BLE advertisement identifier
  async getIdentifier(period: number): Promise<{ identifier: Uint8Array; publicKey: Uint8Array }> {
    const privateKey = await this.derivePrivateKey(period);
    const publicKey = await this.derivePublicKey(privateKey);

    // First 6 bytes of SHA-256(publicKey) as identifier
    const hash = await crypto.subtle.digest('SHA-256', publicKey);
    const identifier = new Uint8Array(hash).slice(0, 6);

    return { identifier, publicKey };
  }
}
```

### Backend: Key Period Validation

```typescript
// Validate that report timestamp matches identifier's key period
function validateReportTiming(identifierHash: string, timestamp: number): boolean {
  const reportPeriod = Math.floor(timestamp / (15 * 60 * 1000));
  const currentPeriod = Math.floor(Date.now() / (15 * 60 * 1000));

  // Allow some clock drift (2 periods = 30 minutes)
  const allowedDrift = 2;

  if (Math.abs(reportPeriod - currentPeriod) > allowedDrift) {
    return false;  // Report timestamp too far from current time
  }

  return true;
}
```

## Deep Dive: Anti-Stalking Detection

### End-to-End Alert Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      ANTI-STALKING FLOW                                   │
│                                                                           │
│  1. User's iPhone detects unknown AirTag                                  │
│  ┌──────────────┐                                                         │
│  │ Background   │──▶ Record sighting locally                             │
│  │ BLE Scanner  │    Check: Is this my device? (local device list)       │
│  └──────────────┘                                                         │
│         │ Not my device                                                   │
│         ▼                                                                 │
│  2. Report to anti-stalking service                                       │
│  ┌──────────────┐     ┌──────────────┐                                   │
│  │ POST /stalk  │────▶│ Anti-Stalk   │                                   │
│  │ {            │     │ Service      │                                   │
│  │  identifier  │     │              │                                   │
│  │  my_location │     │ - Record     │                                   │
│  │ }            │     │ - Analyze    │                                   │
│  └──────────────┘     └──────────────┘                                   │
│                              │                                            │
│                              ▼                                            │
│  3. Pattern analysis (backend)                                            │
│  ┌──────────────────────────────────────────────────────────────┐        │
│  │ SELECT sightings WHERE user_id AND identifier_hash           │        │
│  │   AND seen_at > NOW() - 3 hours                              │        │
│  │                                                               │        │
│  │ IF sightings >= 3 AND (distance > 500m OR time > 1 hour)     │        │
│  │   THEN trigger_alert()                                        │        │
│  └──────────────────────────────────────────────────────────────┘        │
│                              │                                            │
│                              ▼                                            │
│  4. Create notification                                                   │
│  ┌──────────────┐     ┌──────────────┐                                   │
│  │ INSERT INTO  │────▶│ Notification │                                   │
│  │ notifications│     │ Worker       │                                   │
│  │ (unknown_    │     │              │                                   │
│  │  tracker)    │     │ - Push notif │                                   │
│  └──────────────┘     └──────────────┘                                   │
│                              │                                            │
│                              ▼                                            │
│  5. Display alert (frontend)                                              │
│  ┌──────────────────────────────────────────────────────────────┐        │
│  │ ┌────────────────────────────────────────────────────────┐   │        │
│  │ │ ⚠️ Unknown AirTag Detected                             │   │        │
│  │ │ An AirTag has been traveling with you for 2 hours.     │   │        │
│  │ │                                                         │   │        │
│  │ │ [View Locations] [Play Sound] [Learn More]              │   │        │
│  │ └────────────────────────────────────────────────────────┘   │        │
│  └──────────────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
```

### Backend: Stalking Pattern Detection

```typescript
class AntiStalkingService {
  private readonly ALERT_THRESHOLD = 3;
  private readonly TIME_WINDOW_MS = 3 * 60 * 60 * 1000;  // 3 hours
  private readonly DISTANCE_THRESHOLD = 500;  // meters

  async recordSighting(userId: string, identifierHash: string, location: GeoPoint): Promise<void> {
    // Skip user's own devices
    const isOwned = await this.isUserDevice(userId, identifierHash);
    if (isOwned) return;

    // Record sighting
    await db.query(`
      INSERT INTO tracker_sightings (user_id, identifier_hash, latitude, longitude)
      VALUES ($1, $2, $3, $4)
    `, [userId, identifierHash, location.lat, location.lon]);

    // Analyze pattern
    await this.analyzePattern(userId, identifierHash);
  }

  private async analyzePattern(userId: string, identifierHash: string): Promise<void> {
    // Get recent sightings
    const result = await db.query(`
      SELECT latitude, longitude, seen_at
      FROM tracker_sightings
      WHERE user_id = $1
        AND identifier_hash = $2
        AND seen_at > NOW() - INTERVAL '3 hours'
      ORDER BY seen_at
    `, [userId, identifierHash]);

    const sightings = result.rows;

    if (sightings.length < this.ALERT_THRESHOLD) return;

    // Calculate total distance traveled with tracker
    let totalDistance = 0;
    for (let i = 1; i < sightings.length; i++) {
      totalDistance += haversineDistance(
        { lat: sightings[i-1].latitude, lon: sightings[i-1].longitude },
        { lat: sightings[i].latitude, lon: sightings[i].longitude }
      );
    }

    // Calculate time span
    const timeSpan = new Date(sightings[sightings.length - 1].seen_at).getTime()
                   - new Date(sightings[0].seen_at).getTime();

    // Trigger alert if stalking pattern detected
    if (totalDistance > this.DISTANCE_THRESHOLD || timeSpan > 60 * 60 * 1000) {
      await this.createAlert(userId, identifierHash, sightings);
    }
  }

  private async createAlert(
    userId: string,
    identifierHash: string,
    sightings: Sighting[]
  ): Promise<void> {
    // Check cooldown
    const cooldownKey = `alert:${userId}:${identifierHash}`;
    if (await redis.get(cooldownKey)) return;

    // Create notification
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

    // Set 1-hour cooldown
    await redis.setex(cooldownKey, 3600, '1');

    // Queue push notification
    await this.sendPushNotification(userId, 'Unknown AirTag Detected');
  }
}
```

### Frontend: Unknown Tracker Alert Component

```tsx
function UnknownTrackerAlert({ notification }: { notification: TrackerNotification }) {
  const [showMap, setShowMap] = useState(false);
  const { sightingCount, firstSeen, locations } = notification.data;

  const playSound = async () => {
    // This would trigger the unknown AirTag to play a sound
    await fetch(`/api/v1/trackers/${notification.data.identifierHash}/play-sound`, {
      method: 'POST'
    });
    toast.info('Sound command sent. Listen for a beeping noise nearby.');
  };

  return (
    <div className="bg-amber-50 border-l-4 border-amber-400 p-4 rounded-r-lg">
      <div className="flex items-start">
        <AlertTriangleIcon className="w-6 h-6 text-amber-400 flex-shrink-0" />

        <div className="ml-3 flex-1">
          <h3 className="font-semibold text-amber-800">
            Unknown AirTag Found
          </h3>
          <p className="mt-1 text-amber-700">
            An AirTag has been detected traveling with you since{' '}
            {formatTimeAgo(new Date(firstSeen))}.
            Seen at {sightingCount} locations.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="px-4 py-2 bg-amber-100 text-amber-800 rounded-lg"
              onClick={() => setShowMap(true)}
            >
              View Locations
            </button>

            <button
              className="px-4 py-2 bg-amber-600 text-white rounded-lg"
              onClick={playSound}
            >
              Play Sound
            </button>
          </div>
        </div>
      </div>

      {/* Map modal showing tracker's path */}
      <Modal open={showMap} onClose={() => setShowMap(false)}>
        <TrackerPathMap locations={locations} />
      </Modal>
    </div>
  );
}
```

## Deep Dive: Lost Mode Workflow

### Complete Lost Mode Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        LOST MODE FLOW                                     │
│                                                                           │
│  1. Owner enables Lost Mode                                               │
│  ┌──────────────┐     ┌──────────────┐                                   │
│  │ LostModePanel│────▶│ PUT /devices │                                   │
│  │              │     │ /{id}/lost   │                                   │
│  │ - Toggle on  │     │              │                                   │
│  │ - Contact    │     │ - Store info │                                   │
│  │   info       │     │ - Notify     │                                   │
│  └──────────────┘     └──────────────┘                                   │
│                              │                                            │
│                              ▼                                            │
│  2. Database update                                                       │
│  ┌──────────────────────────────────────────────────────────────┐        │
│  │ INSERT INTO lost_mode (device_id, enabled, contact_phone,    │        │
│  │                        contact_email, message)                │        │
│  │ VALUES (...) ON CONFLICT (device_id) DO UPDATE               │        │
│  └──────────────────────────────────────────────────────────────┘        │
│                              │                                            │
│  3. Finder taps AirTag with NFC                                           │
│  ┌──────────────┐                                                         │
│  │ Finder's     │──▶ NFC reads AirTag identifier                         │
│  │ iPhone       │──▶ Opens found.apple.com/item?id=xxx                   │
│  └──────────────┘                                                         │
│         │                                                                 │
│         ▼                                                                 │
│  4. Display contact info                                                  │
│  ┌──────────────┐     ┌──────────────┐                                   │
│  │ GET /found/  │────▶│ Found API    │                                   │
│  │   {id}       │     │              │                                   │
│  │              │◀────│ - Return     │                                   │
│  │ Show contact │     │   contact    │                                   │
│  │ to finder    │     │   info       │                                   │
│  └──────────────┘     └──────────────┘                                   │
│                              │                                            │
│  5. Notify owner                                                          │
│  ┌──────────────┐     ┌──────────────┐                                   │
│  │ INSERT INTO  │────▶│ Push notif   │                                   │
│  │ notifications│     │ to owner     │                                   │
│  │ (device_found│     │              │                                   │
│  └──────────────┘     └──────────────┘                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

### Backend: Lost Mode API

```typescript
// Enable/update lost mode
app.put('/api/v1/devices/:deviceId/lost-mode', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  const { enabled, contactPhone, contactEmail, message } = req.body;

  // Verify device ownership
  const device = await db.query(
    'SELECT * FROM registered_devices WHERE id = $1 AND user_id = $2',
    [deviceId, req.userId]
  );

  if (device.rows.length === 0) {
    return res.status(404).json({ error: 'Device not found' });
  }

  // Upsert lost mode settings
  await db.query(`
    INSERT INTO lost_mode (device_id, enabled, contact_phone, contact_email, message, enabled_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (device_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      contact_phone = EXCLUDED.contact_phone,
      contact_email = EXCLUDED.contact_email,
      message = EXCLUDED.message,
      enabled_at = CASE WHEN EXCLUDED.enabled THEN NOW() ELSE lost_mode.enabled_at END,
      updated_at = NOW()
  `, [deviceId, enabled, contactPhone, contactEmail, message, enabled ? new Date() : null]);

  // Create notification
  await db.query(`
    INSERT INTO notifications (user_id, device_id, type, title, message)
    VALUES ($1, $2, 'system', $3, $4)
  `, [
    req.userId,
    deviceId,
    enabled ? 'Lost Mode Enabled' : 'Lost Mode Disabled',
    enabled ? 'You will be notified when your device is found.' : 'Lost Mode has been turned off.'
  ]);

  return res.json({ success: true });
});

// Found page API (public, no auth)
app.get('/api/v1/found/:identifier', async (req, res) => {
  const { identifier } = req.params;

  // Look up device by identifier hash
  // In production, this would involve more complex identifier resolution
  const device = await db.query(`
    SELECT rd.name, rd.emoji, lm.contact_phone, lm.contact_email, lm.message
    FROM registered_devices rd
    JOIN lost_mode lm ON rd.id = lm.device_id
    WHERE lm.enabled = TRUE
      AND rd.id = $1
  `, [identifier]);

  if (device.rows.length === 0) {
    return res.status(404).json({ error: 'Device not in Lost Mode' });
  }

  const { name, emoji, contact_phone, contact_email, message } = device.rows[0];

  // Notify owner that device was found
  const deviceRow = await db.query(
    'SELECT user_id FROM registered_devices WHERE id = $1',
    [identifier]
  );

  if (deviceRow.rows.length > 0) {
    await db.query(`
      INSERT INTO notifications (user_id, device_id, type, title, message, data)
      VALUES ($1, $2, 'device_found', 'Your Item Was Found',
              'Someone found your item and viewed the contact information.',
              $3)
    `, [deviceRow.rows[0].user_id, identifier, JSON.stringify({
      foundAt: new Date().toISOString()
    })]);
  }

  return res.json({
    name,
    emoji,
    contactPhone: contact_phone,
    contactEmail: contact_email,
    message
  });
});
```

### Frontend: Lost Mode Panel

```tsx
function LostModePanel({ device }: { device: RegisteredDevice }) {
  const [enabled, setEnabled] = useState(device.lostMode?.enabled ?? false);
  const [contactInfo, setContactInfo] = useState({
    phone: device.lostMode?.contactPhone ?? '',
    email: device.lostMode?.contactEmail ?? '',
    message: device.lostMode?.message ?? ''
  });

  const updateLostMode = useMutation({
    mutationFn: async (data: { enabled: boolean; contactInfo: ContactInfo }) => {
      const response = await fetch(`/api/v1/devices/${device.id}/lost-mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: data.enabled,
          contactPhone: data.contactInfo.phone,
          contactEmail: data.contactInfo.email,
          message: data.contactInfo.message
        })
      });
      if (!response.ok) throw new Error('Failed to update');
      return response.json();
    },
    onSuccess: () => {
      toast.success(enabled ? 'Lost Mode enabled' : 'Lost Mode disabled');
    }
  });

  return (
    <div className="bg-white rounded-xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Lost Mode</h2>
          <p className="text-gray-600">
            {enabled
              ? 'Anyone who finds this can see your contact info'
              : 'Enable to help finders contact you'}
          </p>
        </div>

        <Switch
          checked={enabled}
          onChange={(newEnabled) => {
            setEnabled(newEnabled);
            updateLostMode.mutate({ enabled: newEnabled, contactInfo });
          }}
        />
      </div>

      <div className={cn(
        'space-y-4 transition-opacity',
        enabled ? 'opacity-100' : 'opacity-50 pointer-events-none'
      )}>
        <input
          type="tel"
          placeholder="Phone number"
          value={contactInfo.phone}
          onChange={(e) => setContactInfo(prev => ({ ...prev, phone: e.target.value }))}
          className="w-full px-4 py-2 border rounded-lg"
        />

        <input
          type="email"
          placeholder="Email address"
          value={contactInfo.email}
          onChange={(e) => setContactInfo(prev => ({ ...prev, email: e.target.value }))}
          className="w-full px-4 py-2 border rounded-lg"
        />

        <textarea
          placeholder="Message for finder"
          value={contactInfo.message}
          onChange={(e) => setContactInfo(prev => ({ ...prev, message: e.target.value }))}
          className="w-full px-4 py-2 border rounded-lg"
          rows={3}
        />

        <button
          onClick={() => updateLostMode.mutate({ enabled, contactInfo })}
          className="w-full py-3 bg-blue-600 text-white rounded-lg"
          disabled={!enabled}
        >
          Save Contact Info
        </button>
      </div>
    </div>
  );
}
```

## Deep Dive: State Management

### Zustand Store for Find My

```typescript
interface FindMyState {
  // Devices
  devices: RegisteredDevice[];
  selectedDeviceId: string | null;

  // Decrypted locations
  locations: Map<string, DecryptedLocation[]>;
  decryptionStatus: 'idle' | 'loading' | 'decrypting' | 'done';

  // Notifications
  notifications: Notification[];
  unreadCount: number;

  // Actions
  setSelectedDevice: (id: string | null) => void;
  fetchDevices: () => Promise<void>;
  fetchLocations: (deviceId: string, timeRange: TimeRange) => Promise<void>;
  refreshNotifications: () => Promise<void>;
  markRead: (id: string) => void;
}

export const useFindMyStore = create<FindMyState>((set, get) => ({
  devices: [],
  selectedDeviceId: null,
  locations: new Map(),
  decryptionStatus: 'idle',
  notifications: [],
  unreadCount: 0,

  setSelectedDevice: (id) => {
    set({ selectedDeviceId: id });
    if (id) {
      // Auto-fetch locations for last 7 days
      get().fetchLocations(id, {
        start: Date.now() - 7 * 24 * 60 * 60 * 1000,
        end: Date.now()
      });
    }
  },

  fetchDevices: async () => {
    const response = await fetch('/api/v1/devices');
    const devices = await response.json();
    set({ devices });
  },

  fetchLocations: async (deviceId, timeRange) => {
    set({ decryptionStatus: 'loading' });

    try {
      const masterSecret = await getMasterSecret(deviceId);
      const keyManager = new KeyManager(masterSecret);

      // Generate identifier hashes
      const hashes = await keyManager.generateIdentifierHashes(timeRange);

      // Query server
      const response = await fetch('/api/v1/locations/query', {
        method: 'POST',
        body: JSON.stringify({ identifierHashes: hashes, ...timeRange })
      });
      const { reports } = await response.json();

      set({ decryptionStatus: 'decrypting' });

      // Decrypt locally
      const decrypted = await decryptReports(reports, keyManager, timeRange);

      set((state) => ({
        locations: new Map(state.locations).set(deviceId, decrypted),
        decryptionStatus: 'done'
      }));
    } catch (error) {
      set({ decryptionStatus: 'idle' });
      throw error;
    }
  },

  refreshNotifications: async () => {
    const response = await fetch('/api/v1/notifications');
    const notifications = await response.json();
    set({
      notifications,
      unreadCount: notifications.filter((n: Notification) => !n.isRead).length
    });
  },

  markRead: async (id) => {
    await fetch(`/api/v1/notifications/${id}/read`, { method: 'POST' });
    set((state) => ({
      notifications: state.notifications.map(n =>
        n.id === id ? { ...n, isRead: true } : n
      ),
      unreadCount: Math.max(0, state.unreadCount - 1)
    }));
  }
}));
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Client-side decryption | WebCrypto API | Server decryption | Privacy - server never sees locations |
| No FK on location_reports | Privacy design | FK to devices | Server cannot correlate reports to owners |
| 15-min key rotation | Time-based periods | Per-broadcast IDs | Balance privacy vs. battery/complexity |
| Redis for idempotency | In-memory with TTL | DB unique constraint | Sub-ms checks for high throughput |
| Proactive anti-stalking | Background scanning | Manual check | Safety - catch tracking users wouldn't notice |
| Zustand for state | Redux | Simpler API, sufficient for complexity |

## Future Enhancements

1. **AR Precision Finding**: Camera-based overlay for visual guidance
2. **ML Anti-Stalking**: Anomaly detection beyond rule-based patterns
3. **Offline Mode**: Full offline decryption with cached master secrets
4. **Family Sharing**: Share device locations with permission management
5. **Geo-Fencing**: Notify when device leaves defined area
6. **History Playback**: Animated timeline of device movement
