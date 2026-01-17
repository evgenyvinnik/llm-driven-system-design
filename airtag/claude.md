# Design AirTag - Development with Claude

## Project Context

Building an item tracking system to understand privacy-preserving location, crowd-sourced networks, and Bluetooth beaconing.

**Key Learning Goals:**
- Build privacy-preserving location systems
- Design end-to-end encrypted reporting
- Implement key rotation schemes
- Handle crowd-sourced data at scale

---

## Key Challenges to Explore

### 1. Privacy-Preserving Location

**Challenge**: Track items without Apple seeing locations

**Approaches:**
- End-to-end encryption with owner keys
- Rotating identifiers
- Decentralized key derivation
- Zero-knowledge design

### 2. Key Management

**Problem**: Rotate keys while maintaining trackability

**Solutions:**
- Deterministic key derivation
- Time-based key rotation
- Master secret synchronization
- Key recovery mechanisms

### 3. Anti-Stalking

**Challenge**: Prevent misuse for tracking people

**Solutions:**
- Unknown tracker alerts
- Time and distance heuristics
- Sound playback option
- Easy disabling instructions

---

## Development Phases

### Phase 1: Beacon Protocol
- [ ] BLE advertisement (hardware required)
- [x] Key rotation (implemented in KeyManager)
- [x] Identifier derivation (implemented in crypto utils)
- [ ] Power management (hardware required)

### Phase 2: Crowd-Sourced Network - **In Progress**
- [x] Location detection (simulated via map clicks)
- [x] Encrypted reporting (ECIES-like encryption)
- [x] Server storage (PostgreSQL with encrypted blobs)
- [x] Query protocol (identifier hash lookup)

### Phase 3: Owner Experience - **Completed**
- [x] Location retrieval (API with time range query)
- [x] Decryption (AES-256-GCM with derived keys)
- [x] Map display (Leaflet with history visualization)
- [x] Lost mode (enable/disable with notifications)

### Phase 4: Safety - **Completed**
- [x] Anti-stalking detection (pattern analysis)
- [x] Unknown tracker alerts (notification system)
- [x] Sound playback (simulated)
- [ ] NFC identification (hardware required)

---

## Implementation Notes

### Encryption Approach

For this demo, we use a simplified encryption scheme:
- AES-256-GCM for symmetric encryption
- HMAC-SHA256 for key derivation
- 15-minute key rotation periods

In production (like Apple's Find My):
- Elliptic curve cryptography (P-224)
- ECIES for asymmetric encryption
- Hardware security module integration

### Anti-Stalking Algorithm

The detection algorithm considers:
1. **Sighting Count**: 3+ sightings trigger analysis
2. **Distance Traveled**: >500m with tracker indicates following
3. **Time Span**: >1 hour with same tracker
4. **Alert Cooldown**: 1 hour between alerts per tracker

### Database Design Decisions

1. **Encrypted Payloads**: Stored as JSONB for flexibility
2. **Identifier Hashes**: Indexed for fast lookup
3. **Separate Lost Mode Table**: Allows NULL device references
4. **Session Store**: Redis for horizontal scaling

---

## Resources

- [Apple Find My Security](https://support.apple.com/en-us/HT210515)
- [ECIES Encryption](https://en.wikipedia.org/wiki/Integrated_Encryption_Scheme)
- [UWB Positioning](https://www.nxp.com/docs/en/white-paper/UWBSECURITYWP.pdf)
