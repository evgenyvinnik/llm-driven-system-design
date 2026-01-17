# Design FaceTime - Development with Claude

## Project Context

Building a real-time video calling system to understand WebRTC, NAT traversal, and low-latency media delivery.

**Key Learning Goals:**
- Build real-time media pipelines
- Design WebRTC-based calling systems
- Implement E2E encryption for calls
- Handle network adaptation

---

## Key Challenges to Explore

### 1. NAT Traversal

**Challenge**: Connect devices behind firewalls

**Approaches:**
- STUN for NAT mapping
- TURN as relay fallback
- ICE for connectivity checks
- Hole punching techniques

### 2. Group Call Scaling

**Problem**: Mesh doesn't scale past ~4 participants

**Solutions:**
- SFU (Selective Forwarding Unit)
- MCU (Mixing Unit)
- Simulcast for quality layers
- Dominant speaker detection

### 3. Quality Adaptation

**Challenge**: Maintain quality on variable networks

**Solutions:**
- Bandwidth estimation
- Simulcast/SVC encoding
- Jitter buffer tuning
- FEC for packet loss

---

## Development Phases

### Phase 1: 1:1 Calls
- [ ] Signaling protocol
- [ ] WebRTC integration
- [ ] STUN/TURN setup
- [ ] Basic call flow

### Phase 2: Media Quality
- [ ] Adaptive bitrate
- [ ] Network stats
- [ ] Quality controls
- [ ] Audio processing

### Phase 3: Group Calls
- [ ] SFU implementation
- [ ] Multi-party routing
- [ ] Speaker detection
- [ ] Grid/spotlight views

### Phase 4: Security
- [ ] E2E encryption
- [ ] Key exchange
- [ ] Identity verification
- [ ] Privacy controls

---

## Resources

- [WebRTC.org](https://webrtc.org/)
- [Jitsi Architecture](https://jitsi.org/blog/a-]oking-in-the-sausage-factory-ofjitsi/)
- [Real-time Communication with WebRTC](https://www.oreilly.com/library/view/real-time-communication-with/9781449371869/)
