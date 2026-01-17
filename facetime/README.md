# Design FaceTime - Real-Time Video Calling

## Overview

A simplified FaceTime-like platform demonstrating real-time video/audio communication, group calls, and cross-device handoff. This educational project focuses on building a low-latency video calling system with end-to-end encryption.

## Key Features

### 1. Video Calling
- 1:1 video calls
- Group FaceTime (up to 32)
- FaceTime Audio
- SharePlay integration

### 2. Media Processing
- Hardware acceleration
- Adaptive bitrate
- Noise cancellation
- Portrait mode

### 3. Connectivity
- NAT traversal
- Relay fallback
- Network handoff
- Multi-device ring

### 4. Security
- End-to-end encryption
- Authentication
- No recording
- Privacy controls

## Implementation Status

- [ ] Initial architecture design
- [ ] Signaling server
- [ ] WebRTC integration
- [ ] TURN/STUN servers
- [ ] Group calling
- [ ] E2E encryption
- [ ] SharePlay
- [ ] Documentation

## Key Technical Challenges

1. **Latency**: Sub-150ms end-to-end delay
2. **NAT Traversal**: Connecting through firewalls
3. **Group Calls**: Scalable multi-party architecture
4. **Quality**: Adaptive to network conditions
5. **Encryption**: E2E with perfect forward secrecy

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
