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
- [ ] BLE advertisement
- [ ] Key rotation
- [ ] Identifier derivation
- [ ] Power management

### Phase 2: Crowd-Sourced Network
- [ ] Location detection
- [ ] Encrypted reporting
- [ ] Server storage
- [ ] Query protocol

### Phase 3: Owner Experience
- [ ] Location retrieval
- [ ] Decryption
- [ ] Map display
- [ ] Lost mode

### Phase 4: Safety
- [ ] Anti-stalking detection
- [ ] Unknown tracker alerts
- [ ] Sound playback
- [ ] NFC identification

---

## Resources

- [Apple Find My Security](https://support.apple.com/en-us/HT210515)
- [ECIES Encryption](https://en.wikipedia.org/wiki/Integrated_Encryption_Scheme)
- [UWB Positioning](https://www.nxp.com/docs/en/white-paper/UWBSECURITYWP.pdf)
