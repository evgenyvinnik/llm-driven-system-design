# Design iMessage - Development with Claude

## Project Context

Building an encrypted messaging system to understand E2E encryption, multi-device sync, and offline-first architecture.

**Key Learning Goals:**
- Build E2E encrypted messaging
- Design multi-device key management
- Implement message sync protocols
- Handle offline-first messaging

---

## Key Challenges to Explore

### 1. Multi-Device Encryption

**Challenge**: Same user on multiple devices

**Approaches:**
- Per-device encryption
- Device linking
- Key synchronization
- Forward secrecy maintenance

### 2. Group Scalability

**Problem**: O(n) encryption per message

**Solutions:**
- Sender keys (Signal protocol)
- Fan-out encryption
- Key ratcheting
- Member add/remove handling

### 3. Sync Consistency

**Challenge**: Messages consistent across devices

**Solutions:**
- Sync cursors
- Conflict resolution
- Tombstones for deletes
- Read receipt sync

---

## Development Phases

### Phase 1: Encryption
- [ ] Key generation
- [ ] X3DH key agreement
- [ ] Message encryption
- [ ] Prekey management

### Phase 2: Direct Messages (In Progress)
- [x] Send/receive
- [x] Delivery receipts
- [x] Read receipts
- [x] Typing indicators

### Phase 3: Multi-Device
- [ ] Device registration
- [ ] Per-device encryption
- [ ] Message sync
- [ ] Read state sync

### Phase 4: Groups
- [ ] Group creation
- [ ] Sender keys
- [ ] Member management
- [ ] Admin controls

---

## Resources

- [Signal Protocol](https://signal.org/docs/)
- [Double Ratchet Algorithm](https://signal.org/docs/specifications/doubleratchet/)
- [X3DH Key Agreement](https://signal.org/docs/specifications/x3dh/)
