# Design FaceTime - Real-Time Video Calling

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 3,727 |
| Source Files | 36 |
| .ts | 1,582 |
| .md | 1,224 |
| .tsx | 555 |
| .json | 126 |
| .sql | 84 |

## Overview

A simplified FaceTime-like platform demonstrating real-time video/audio communication using WebRTC. This educational project focuses on building a low-latency video calling system with proper signaling, NAT traversal, and peer-to-peer connections.

## Key Features

### 1. Video Calling
- 1:1 video/audio calls
- Real-time peer-to-peer connections
- Adaptive quality based on network conditions

### 2. Signaling Server
- WebSocket-based signaling
- Call initiation and notifications
- ICE candidate exchange
- Multi-device support

### 3. Connectivity
- STUN/TURN server support
- NAT traversal via ICE
- Automatic fallback to relay

### 4. User Interface
- Contact list with call buttons
- Incoming call notifications
- Active call with local/remote video
- Call controls (mute, video toggle, end call)

## Technology Stack

- **Frontend:** TypeScript + Vite + React 19 + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + WebSocket (ws)
- **Database:** PostgreSQL 16
- **Cache:** Redis 7
- **TURN Server:** Coturn
- **Protocol:** WebRTC

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- A modern browser with WebRTC support (Chrome, Firefox, Safari, Edge)

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
cd /Users/evgenyvinnik/Documents/GitHub/llm-driven-system-design/facetime

# Start PostgreSQL, Redis, and Coturn TURN server
docker-compose up -d

# Verify containers are running
docker-compose ps
```

This will start:
- PostgreSQL on port 5432
- Redis on port 6379
- Coturn TURN server on ports 3478 (UDP/TCP) and 5349 (TLS)

### 2. Start Backend

```bash
cd backend

# Install dependencies
npm install

# Start development server
npm run dev
```

The backend will start on http://localhost:3001 with:
- REST API at `/api/*`
- WebSocket signaling at `/ws`
- TURN credentials at `/turn-credentials`

### 3. Start Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

The frontend will start on http://localhost:5173

### 4. Test Video Calling

1. Open http://localhost:5173 in two different browser windows (or use incognito)
2. Log in as different users in each window (e.g., Alice in one, Bob in the other)
3. Click the video or audio call button next to a contact
4. Accept the incoming call in the other window
5. You should see both local and remote video streams

## Project Structure

```
facetime/
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   ├── index.ts          # Database connection
│   │   │   └── init.sql          # Schema and seed data
│   │   ├── routes/
│   │   │   ├── users.ts          # User API routes
│   │   │   └── calls.ts          # Call history routes
│   │   ├── services/
│   │   │   ├── signaling.ts      # WebSocket signaling logic
│   │   │   └── redis.ts          # Redis client and helpers
│   │   ├── types/
│   │   │   └── index.ts          # TypeScript types
│   │   └── index.ts              # Express server entry
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── VideoPlayer.tsx   # Video element component
│   │   │   ├── CallControls.tsx  # Mute/video/end buttons
│   │   │   ├── IncomingCall.tsx  # Incoming call overlay
│   │   │   ├── ActiveCall.tsx    # Active call view
│   │   │   ├── ContactList.tsx   # Contact list
│   │   │   └── LoginScreen.tsx   # User selection
│   │   ├── hooks/
│   │   │   └── useWebRTC.ts      # WebRTC hook
│   │   ├── services/
│   │   │   ├── api.ts            # REST API client
│   │   │   └── signaling.ts      # WebSocket client
│   │   ├── stores/
│   │   │   └── useStore.ts       # Zustand store
│   │   ├── types/
│   │   │   └── index.ts          # TypeScript types
│   │   ├── App.tsx               # Main app component
│   │   └── main.tsx              # Entry point
│   └── package.json
├── docker-compose.yml            # Infrastructure services
├── architecture.md               # System design documentation
├── claude.md                     # Development notes
└── README.md                     # This file
```

## API Endpoints

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/stats` | Online users stats |
| GET | `/turn-credentials` | ICE server configuration |
| GET | `/api/users` | List all users |
| GET | `/api/users/:id` | Get user by ID |
| POST | `/api/users/login` | Simple login |
| GET | `/api/calls/history/:userId` | User's call history |

### WebSocket Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `register` | Client -> Server | Register device |
| `call_initiate` | Client -> Server | Start a call |
| `call_ring` | Server -> Client | Incoming call notification |
| `call_answer` | Client -> Server | Accept call |
| `call_decline` | Client -> Server | Decline call |
| `call_end` | Both | End call |
| `offer` | Client -> Server | WebRTC offer |
| `answer` | Client -> Server | WebRTC answer |
| `ice_candidate` | Both | ICE candidate exchange |

## Test Users

The database is seeded with these test users:

| Username | Display Name | Role |
|----------|--------------|------|
| alice | Alice Smith | user |
| bob | Bob Johnson | user |
| charlie | Charlie Brown | user |
| admin | Admin User | admin |

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Troubleshooting

### Video not showing
- Ensure browser has camera/microphone permissions
- Check browser console for errors
- Verify HTTPS if using non-localhost

### Connection fails
- Check if TURN server is running: `docker-compose logs coturn`
- Verify WebSocket connection in browser dev tools
- Check backend logs for errors

### Database connection error
- Ensure PostgreSQL is running: `docker-compose up -d postgres`
- Check connection settings in backend

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation including:
- Call signaling protocol
- NAT traversal with ICE
- WebRTC peer connections
- Database schema
- Key design decisions and trade-offs

## Development Notes

See [claude.md](./claude.md) for development insights and LLM collaboration notes.

## Key Technical Challenges

1. **Latency**: Sub-150ms end-to-end delay
2. **NAT Traversal**: Connecting through firewalls via STUN/TURN
3. **Signaling**: Reliable WebSocket-based message exchange
4. **Quality**: Adaptive bitrate based on network conditions

## Future Enhancements

- [ ] Group video calls (SFU architecture)
- [ ] Screen sharing
- [ ] End-to-end encryption
- [ ] Call recording
- [ ] Push notifications
- [ ] Mobile app support

## References & Inspiration

- [FaceTime Security](https://support.apple.com/guide/security/facetime-security-seca93b68ed2/web) - Apple's documentation on FaceTime encryption and security
- [WebRTC.org](https://webrtc.org/) - Official WebRTC project documentation and standards
- [Real-Time Communication with WebRTC (O'Reilly)](https://www.oreilly.com/library/view/real-time-communication-with/9781449371869/) - Comprehensive WebRTC implementation guide
- [Jitsi Meet Architecture](https://jitsi.org/blog/a-looking-in-the-sausage-factory-of-jitsi/) - Open-source video conferencing architecture
- [Coturn TURN Server](https://github.com/coturn/coturn) - Open-source TURN/STUN server for NAT traversal
- [ICE: Interactive Connectivity Establishment (RFC 8445)](https://datatracker.ietf.org/doc/html/rfc8445) - NAT traversal protocol specification
- [WebRTC for the Curious](https://webrtcforthecurious.com/) - In-depth WebRTC protocol documentation
- [Twilio Video Architecture](https://www.twilio.com/docs/video) - Commercial video calling platform patterns
