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

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Encryption | End-to-end | Server-side | Privacy |
| Key rotation | 15 minutes | Hourly | Privacy vs. battery |
| Anti-stalking | Proactive alerts | Manual check | Safety |
| Precision | UWB | BLE only | Accuracy |
