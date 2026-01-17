# AirTag - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design AirTag, Apple's item tracking system that uses a crowd-sourced network of billions of Apple devices to locate lost items. The key challenge here is building a privacy-preserving location system where even Apple cannot see the location of your items, while still enabling accurate tracking through encrypted, crowd-sourced reports.

The core technical challenges are end-to-end encryption with rotating keys, crowd-sourced location reporting at massive scale, and anti-stalking measures to prevent misuse."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Track**: Locate items via the Find My network of Apple devices
- **Precision Finding**: UWB-based directional finding when nearby
- **Lost Mode**: Get notified when an item is found by the network
- **Anti-Stalking**: Detect unknown trackers traveling with you
- **Sound**: Play a sound to locate nearby items

### Non-Functional Requirements
- **Privacy**: Apple cannot see item locations (end-to-end encrypted)
- **Scale**: 1B+ devices in the Find My network
- **Latency**: Location updates within 15 minutes
- **Battery**: Years of battery life on the AirTag device

### Scale Estimates
- 1 billion+ Apple devices participating in Find My network
- Each AirTag broadcasts every 2 seconds
- Rotating keys every 15 minutes = 96 key rotations per day
- Location reports stored for 24 hours on Apple servers

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                     AirTag Device                          |
|      (BLE beacon, UWB, NFC, Speaker, Motion sensor)       |
+----------------------------------------------------------+
                           | BLE Advertisement
                           v
+----------------------------------------------------------+
|                   Find My Network                          |
|               (Billions of Apple devices)                  |
|   - iPhones, iPads, Macs detect nearby AirTags            |
|   - Encrypt location with AirTag's public key             |
|   - Report to Apple servers                                |
+----------------------------------------------------------+
                           | Encrypted reports
                           v
+----------------------------------------------------------+
|                    Apple Servers                           |
|       (Encrypted blob storage - cannot decrypt)           |
|   - Store encrypted location reports                       |
|   - Index by hashed identifier                             |
|   - Serve reports to owners                                |
+----------------------------------------------------------+
          |                                    |
          v                                    v
+-------------------+              +-------------------+
|   Owner Device    |              |  Anti-Stalk Svc   |
|                   |              |                   |
| - Query reports   |              | - Detect unknown  |
| - Decrypt locally |              |   trackers        |
| - Show on map     |              | - Alert users     |
+-------------------+              +-------------------+
```

### Core Components
1. **AirTag Device** - BLE beacon with rotating identity, UWB for precision finding
2. **Find My Network** - Crowd-sourced detection by all Apple devices
3. **Encrypted Reporting** - ECIES encryption so only owner can decrypt
4. **Apple Servers** - Store encrypted blobs without seeing locations
5. **Anti-Stalking Service** - Detect unknown trackers following users

## Deep Dive: Privacy-Preserving Location System (8 minutes)

This is the heart of the system - enabling location tracking while ensuring complete privacy.

### Rotating Key Architecture

```
Master Secret (shared between AirTag and owner's iCloud)
         |
         v
+------------------+
| Key Derivation   |
| (HMAC-SHA256)    |
+------------------+
         |
         +---> Period 1 Key ---> P-224 Public Key 1
         |
         +---> Period 2 Key ---> P-224 Public Key 2
         |
         +---> Period N Key ---> P-224 Public Key N
```

**How it works:**
1. AirTag and owner share a master secret (synced via iCloud)
2. Every 15 minutes, AirTag derives a new key pair from master secret + time period
3. BLE advertisement contains:
   - 6-byte identifier (hash of public key)
   - Full public key (for encryption)
4. Only someone with master secret can predict what identifiers will be used

### Encrypted Location Reporting

When an iPhone detects an AirTag:

```javascript
// Finder's iPhone encrypts location
async encryptLocation(location, airtagPublicKey) {
  // Generate ephemeral key pair (ECDH)
  const ephemeral = crypto.generateECDH('P-224')

  // Derive shared secret
  const sharedSecret = ephemeral.computeSecret(airtagPublicKey)

  // Derive encryption key
  const encryptionKey = HKDF(sharedSecret, 'encryption')

  // Encrypt location with AES-256-GCM
  const encrypted = AES_GCM_Encrypt(
    encryptionKey,
    JSON.stringify({
      lat: location.latitude,
      lon: location.longitude,
      accuracy: location.accuracy,
      timestamp: Date.now()
    })
  )

  return {
    ephemeralPublicKey: ephemeral.getPublicKey(),
    ciphertext: encrypted,
    iv: randomBytes(12)
  }
}
```

**Key insight**: Apple receives encrypted blobs indexed by hashed identifiers. They cannot:
- See the actual location (encrypted with owner's key)
- Correlate different reports to the same AirTag (identifiers rotate)
- Determine who owns which AirTag

### Owner Location Retrieval

```javascript
async getLocations(timeRange) {
  // Generate all possible identifiers for time range
  const identifiers = []
  for (let period = startPeriod; period <= endPeriod; period++) {
    const key = deriveKeyForPeriod(masterSecret, period)
    const publicKey = derivePublicKey(key)
    const identifier = SHA256(publicKey).slice(0, 6)
    identifiers.push({ period, identifier, privateKey: key })
  }

  // Query Apple servers for matching reports
  const reports = await queryReports(identifiers.map(i => SHA256(i.identifier)))

  // Decrypt each report locally
  const locations = []
  for (const report of reports) {
    const matchingKey = identifiers.find(i => matches(i, report))
    const decrypted = await decryptWithPrivateKey(report, matchingKey.privateKey)
    locations.push(decrypted)
  }

  return locations
}
```

**Privacy guarantees:**
- Finder never knows whose item they found
- Apple never sees the location data
- Only the owner can correlate reports and decrypt them

## Deep Dive: Anti-Stalking Detection (6 minutes)

Preventing misuse is critical for a tracking device. The system must detect when someone is being tracked without their knowledge.

### Detection Algorithm

```javascript
class AntiStalkingService {
  constructor() {
    this.seenTrackers = new Map()  // identifier -> sightings
    this.alertThreshold = 3
    this.timeWindow = 3 * 60 * 60 * 1000  // 3 hours
  }

  async onTrackerDetected(tracker, myLocation) {
    // Skip if it's my own device
    if (await this.isMyDevice(tracker.identifier)) return

    // Record sighting
    const sightings = this.seenTrackers.get(tracker.identifier) || []
    sightings.push({ location: myLocation, timestamp: Date.now() })

    // Keep only recent sightings
    const recent = sightings.filter(s =>
      Date.now() - s.timestamp < this.timeWindow
    )
    this.seenTrackers.set(tracker.identifier, recent)

    // Check for stalking pattern
    if (this.detectStalkingPattern(recent)) {
      await this.alertUser(tracker.identifier, recent)
    }
  }

  detectStalkingPattern(sightings) {
    if (sightings.length < this.alertThreshold) return false

    // Calculate total distance traveled with this tracker
    let totalDistance = 0
    for (let i = 1; i < sightings.length; i++) {
      totalDistance += haversine(sightings[i-1].location, sightings[i].location)
    }

    // Alert if significant distance traveled together (> 500m)
    if (totalDistance > 500) return true

    // Alert if tracker has been with us for extended time (> 1 hour)
    const timeSpan = sightings[sightings.length-1].timestamp - sightings[0].timestamp
    if (timeSpan > 60 * 60 * 1000) return true

    return false
  }
}
```

### Multi-Layer Protection

1. **Passive Detection**: iPhone continuously scans for unknown AirTags
2. **Time + Distance Heuristics**: Alert when tracker follows across locations
3. **Sound Alert**: After 8-24 hours separated from owner, AirTag plays sound
4. **NFC Identification**: Tap any phone to get owner's contact info (if in Lost Mode)

### Edge Cases

- **Borrowed items**: User can temporarily disable alerts for specific AirTags
- **False positives**: Family members' AirTags, AirTags in shared transport
- **Android detection**: Separate Tracker Detect app available

## Deep Dive: UWB Precision Finding (5 minutes)

When you're within 10 meters, UWB enables centimeter-level accuracy with directional guidance.

### How UWB Works

```
+------------------+                    +------------------+
|  iPhone          |  <--- UWB --->     |  AirTag          |
|                  |                    |                  |
| - U1 chip        |  Time of Flight    | - U1 chip        |
| - Antenna array  |  Angle of Arrival  | - Antenna        |
+------------------+                    +------------------+
```

**Time of Flight (ToF):**
```javascript
calculateDistance(timeOfFlight) {
  const speedOfLight = 299792458  // m/s
  return (timeOfFlight * speedOfLight) / 2  // Round trip
}
```

**Angle of Arrival (AoA):**
- iPhone's U1 chip has multiple antennas
- Measures phase difference of arriving signal
- Calculates both azimuth (horizontal) and elevation (vertical) angle

### Implementation

```javascript
class PrecisionFinder {
  async startPrecisionFinding(airtag) {
    const session = await this.initUWBSession(airtag.identifier)

    while (session.active) {
      const ranging = await session.measureRange()

      this.updateUI({
        distance: this.calculateDistance(ranging.timeOfFlight),
        direction: {
          azimuth: ranging.angleOfArrival.horizontal,
          elevation: ranging.angleOfArrival.vertical
        },
        signalStrength: ranging.rssi
      })

      await sleep(100)  // 10 Hz update rate
    }
  }
}
```

**UX Features:**
- Haptic feedback intensifies as you get closer
- Visual arrow points in direction of AirTag
- Works in 3D (can find items above/below you)

## Trade-offs and Alternatives (5 minutes)

### 1. End-to-End Encryption vs Server-Side Processing

**Chose: End-to-End Encryption**
- Pro: Maximum privacy, Apple has no liability
- Pro: Users maintain full control
- Con: Apple cannot optimize routing or detect abuse patterns
- Alternative: Server-side encryption with Apple holding keys (simpler but less private)

### 2. Key Rotation Period (15 minutes)

**Chose: 15-minute rotation**
- Pro: Frequent enough to prevent tracking by third parties
- Pro: Infrequent enough for battery life
- Con: 15-minute window where same identifier is broadcast
- Alternative: Per-broadcast unique IDs (more private but more battery, harder correlation for owner)

### 3. Crowd-Sourced vs Cellular Network

**Chose: Crowd-Sourced BLE**
- Pro: Works anywhere with Apple devices (most places)
- Pro: Years of battery life (BLE is low power)
- Pro: No cellular subscription required
- Con: Depends on network density
- Alternative: Cellular (more reliable but requires subscription, more power)

### 4. Anti-Stalking: Proactive Alerts vs Manual Check

**Chose: Proactive Alerts**
- Pro: Users don't need to think about security
- Pro: Catches trackers users wouldn't notice
- Con: False positives from family members' AirTags
- Alternative: Only alert when user opens Find My (misses passive tracking)

### Database Design

```sql
-- Encrypted Location Reports (Apple servers)
CREATE TABLE location_reports (
  id BIGSERIAL PRIMARY KEY,
  identifier_hash VARCHAR(64) NOT NULL,  -- SHA256 of BLE identifier
  encrypted_payload BYTEA NOT NULL,       -- ECIES encrypted location
  reporter_region VARCHAR(10),            -- Coarse region for routing
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP                    -- Auto-delete after 24 hours
);

-- User's Registered Devices (per iCloud account)
CREATE TABLE registered_devices (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  device_type VARCHAR(50),
  name VARCHAR(100),
  master_secret_encrypted BYTEA,  -- Encrypted with user's iCloud key
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Closing Summary (1 minute)

"The AirTag system is built on three key principles:

1. **End-to-end encryption** - Using rotating P-224 key pairs and ECIES encryption, only the owner can decrypt location reports. Apple stores encrypted blobs without seeing the actual locations.

2. **Crowd-sourced at scale** - Leveraging a billion+ Apple devices as a passive detection network, with privacy-preserving reporting that protects both the finder and the owner.

3. **Anti-stalking by design** - Proactive detection of unknown trackers using time and distance heuristics, mandatory sound alerts when separated from owner, and NFC identification.

The main trade-off is privacy vs. capability - by ensuring Apple cannot see locations, we limit their ability to provide value-added services, but this is the right trade-off for a device that could otherwise enable stalking."
