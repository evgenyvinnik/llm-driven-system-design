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

### Phase 1: 1:1 Calls (Completed)
- [x] Signaling protocol (WebSocket-based)
- [x] WebRTC integration (peer connection, offer/answer)
- [x] STUN/TURN setup (Coturn in docker-compose)
- [x] Basic call flow (initiate, ring, answer, end)

### Phase 2: Media Quality (In Progress)
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

## Implementation Notes

### What Was Built

**Backend (Node.js + Express + WebSocket):**
- WebSocket signaling server with device registration
- Call state management in Redis
- REST API for users and call history
- PostgreSQL database with schema for calls, users, devices
- TURN credential endpoint for ICE servers

**Frontend (React + TypeScript + Tailwind):**
- Login screen with user selection
- Contact list with call buttons (audio/video)
- Incoming call overlay with accept/decline
- Active call view with local/remote video
- Call controls (mute, video toggle, end call)
- WebRTC hook for peer connection management

**Infrastructure (Docker Compose):**
- PostgreSQL 16 for persistent data
- Redis 7 for session/presence
- Coturn TURN server for NAT traversal

### Key Design Decisions

1. **WebSocket for Signaling**: Chose WebSocket over polling for low-latency bidirectional communication
2. **Coturn for TURN**: Open-source, well-documented, easy to configure
3. **Redis for Presence**: Fast in-memory storage for online status and call state
4. **Zustand for State**: Simple, minimal boilerplate compared to Redux

### Trade-offs Made

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Signaling | WebSocket | Socket.io | Less abstraction, more control |
| State | Zustand | Redux | Simpler for small app |
| Styling | Tailwind | CSS Modules | Faster development |
| DB | PostgreSQL | SQLite | Production-ready, concurrent access |

---

## Resources

- [WebRTC.org](https://webrtc.org/)
- [Jitsi Architecture](https://jitsi.org/blog/a-looking-in-the-sausage-factory-of-jitsi/)
- [Real-time Communication with WebRTC](https://www.oreilly.com/library/view/real-time-communication-with/9781449371869/)
- [Coturn Documentation](https://github.com/coturn/coturn)
