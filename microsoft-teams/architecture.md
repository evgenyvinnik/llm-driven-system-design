# Microsoft Teams - Architecture

## System Overview

Microsoft Teams is an enterprise communication and collaboration platform that enables team-based messaging within organizational hierarchies. This project explores the design of a real-time chat system organized around organizations, teams, and channels, with support for threaded conversations, file sharing, emoji reactions, and user presence tracking.

**Learning goals:** Real-time messaging architecture, hierarchical resource modeling (org > team > channel), Server-Sent Events for push updates, presence tracking with TTL-based keys, and file storage with object storage integration.

## Requirements

### Functional Requirements
- Users create and join organizations, which contain teams and channels
- Channel-based messaging with threaded replies
- File uploads attached to channels/messages
- Emoji reactions on messages
- Real-time message delivery via SSE
- User presence (online/offline) indicators
- User search for adding members

### Non-Functional Requirements (Production Scale)
- 99.99% uptime for messaging delivery
- p99 message delivery latency < 200ms
- Support 10M concurrent users across 500K organizations
- Message storage: 1B+ messages retained for compliance
- File uploads up to 250MB per file
- Presence updates within 60 seconds of state change

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| Concurrent users | 10M | Peak-hour active sessions |
| Organizations | 500K | Enterprise tenants |
| Messages/day | 5B | ~500 msgs/user/day |
| Message size (avg) | 500 bytes | Text + metadata |
| Daily message storage | 2.5 TB | 5B x 500B |
| File uploads/day | 50M | ~5 files/user/day |
| SSE connections | 10M | One per active user |
| Presence heartbeats/sec | 333K | 10M users / 30s interval |

### Storage Growth (Annual)

| Data | Growth/Year | 5-Year Total |
|------|-------------|--------------|
| Messages | ~900 TB | 4.5 PB |
| Files | ~500 TB (avg 10KB compressed metadata, objects in S3) | 2.5 PB |
| User/org metadata | ~50 GB | 250 GB |

## High-Level Architecture

```
┌──────────────┐      ┌──────────────┐
│              │      │              │
│   React SPA  │─────▶│     CDN      │  (static assets, file downloads)
│  (Vite/TS)   │      │              │
│              │      └──────────────┘
└──────┬───────┘
       │  HTTPS
       ▼
┌──────────────┐      ┌──────────────────────────────────────────────────────┐
│              │      │                  Backend Services                     │
│  API Gateway │─────▶│                                                      │
│  (nginx/ALB) │      │  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│              │      │  │   Auth      │  │  Message   │  │  Presence  │    │
└──────────────┘      │  │  Service    │  │  Service   │  │  Service   │    │
       ▲              │  └────────────┘  └─────┬──────┘  └─────┬──────┘    │
       │              │                        │               │            │
       │  SSE         │  ┌────────────┐  ┌────┴───────┐  ┌────┴───────┐   │
       │  Stream      │  │   File     │  │  Message   │  │  Redis     │   │
       └──────────────│  │  Service   │  │  Queue     │  │  TTL Keys  │   │
                      │  └─────┬──────┘  │  (Kafka)   │  └────────────┘   │
                      │        │         └────────────┘                     │
                      └────────┼───────────────────────────────────────────┘
                               │
            ┌─────────────┐  ┌─┴───────────┐  ┌─────────────┐  ┌──────────────┐
            │ PostgreSQL   │  │    S3       │  │   Redis     │  │ Elasticsearch │
            │ (Messages,   │  │  (File      │  │ (Sessions,  │  │  (Message     │
            │  Orgs, Users)│  │  Storage)   │  │  Presence,  │  │   Search)     │
            └─────────────┘  └─────────────┘  │  Pub/Sub)   │  └──────────────┘
                                               └─────────────┘
```

## Core Components

### Organization Hierarchy

The resource hierarchy follows: **Organization > Team > Channel > Message/Thread**. This mirrors enterprise structures where a company (org) contains cross-functional teams, each with topic-specific channels.

- **Organizations** are top-level containers with unique slugs. At production scale, each org maps to a tenant with isolated data access policies.
- **Teams** belong to one organization and can be public or private. Team membership gates access to all contained channels.
- **Channels** belong to one team; creating a team auto-creates a "General" channel. Channels are the primary unit of real-time subscription.
- **Messages** belong to channels; thread replies reference a `parent_message_id`. This self-referencing design supports flat threading (one level deep) without a separate threads table.

### Real-Time Messaging

Messages flow through a pub/sub pipeline:

1. Client sends POST to `/api/messages`
2. Server validates, persists to PostgreSQL, and returns acknowledgement
3. Server publishes to Redis pub/sub channel `teams:channel:{channelId}`
4. All server instances subscribed to that channel receive the event
5. Each server pushes the message to connected SSE clients for that channel

At production scale, a message queue (Kafka) sits between the write path and the fan-out layer. Kafka provides durability for messages during server restarts, enables replay for missed events, and decouples write throughput from SSE delivery speed. Redis pub/sub handles the last-mile delivery from each server instance to its connected SSE clients.

### Presence System

Presence uses Redis keys with a 60-second TTL:

- Client sends heartbeat every 30 seconds to `/api/presence/heartbeat`
- Server sets `presence:{userId}` with 60-second TTL
- If heartbeat stops (tab closed, network loss), key expires automatically
- Querying presence uses Redis pipeline to check multiple keys in one round trip

At 10M concurrent users generating heartbeats every 30 seconds, the presence system handles ~333K writes/sec. This is within a single Redis cluster's capacity, but at larger scale, presence would be sharded by user ID hash across multiple Redis instances.

### File Storage

Files are uploaded through the API, then streamed to object storage:

- Upload: `POST /api/files` with multipart form data
- Storage path: `channels/{channelId}/{fileId}.{ext}`
- Download: presigned URLs (1-hour expiry) via `GET /api/files/:fileId/download`
- At production scale, a CDN sits in front of S3 to cache frequently accessed files and offload bandwidth from the origin

## Database Schema

The schema contains 10 tables modeling the organizational hierarchy, messaging, and file storage.

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  parent_message_id UUID REFERENCES messages(id),
  content TEXT NOT NULL,
  is_edited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  emoji VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100),
  size_bytes BIGINT,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_parent ON messages(parent_message_id);
CREATE INDEX idx_reactions_message ON message_reactions(message_id);
CREATE INDEX idx_files_channel ON files(channel_id);
CREATE INDEX idx_files_message ON files(message_id);
CREATE INDEX idx_org_members ON org_members(user_id);
CREATE INDEX idx_team_members ON team_members(user_id);
CREATE INDEX idx_channel_members ON channel_members(user_id);
```

Key schema design decisions:

- **UUID primary keys** across all tables for distributed ID generation without coordination
- **Cascading deletes** from parent to child (org > team > channel > message) for referential integrity
- **Composite unique constraints** prevent duplicate memberships (org_members, team_members, channel_members)
- **`parent_message_id`** self-reference on messages enables threaded replies without a separate table
- **`last_read_at`** on channel_members tracks read position per user per channel for unread badges
- **Reaction uniqueness** enforced by `(message_id, user_id, emoji)` constraint -- one reaction per emoji per user
- **`idx_messages_channel`** on `(channel_id, created_at DESC)` enables efficient paginated message loading with cursor-based pagination

## API Design

### Authentication
```
POST /api/auth/register    → Create account
POST /api/auth/login       → Login, create session
POST /api/auth/logout      → Destroy session
GET  /api/auth/me          → Current user info
```

### Organizations
```
GET  /api/organizations              → List user's organizations
POST /api/organizations              → Create organization
GET  /api/organizations/:orgId       → Get organization details
GET  /api/organizations/:orgId/members → List org members
POST /api/organizations/:orgId/members → Add member to org
```

### Teams
```
GET  /api/teams?orgId=xxx           → List teams in org
POST /api/teams                     → Create team (auto-creates General channel)
GET  /api/teams/:teamId             → Get team details
GET  /api/teams/:teamId/members     → List team members
POST /api/teams/:teamId/members     → Add member to team
```

### Channels
```
GET  /api/channels?teamId=xxx        → List channels in team
POST /api/channels                   → Create channel
GET  /api/channels/:channelId        → Get channel details
GET  /api/channels/:channelId/members → List channel members
POST /api/channels/:channelId/members → Add member to channel
POST /api/channels/:channelId/read   → Mark channel as read
```

### Messages
```
GET    /api/messages?channelId=xxx&before=xxx&limit=50 → Paginated messages
GET    /api/messages/:messageId/thread                 → Thread messages
POST   /api/messages                                   → Send message
PUT    /api/messages/:messageId                        → Edit message
DELETE /api/messages/:messageId                        → Delete message
```

### Reactions, Files, Presence, SSE
```
POST   /api/reactions                → Add reaction
DELETE /api/reactions                → Remove reaction
POST   /api/files                   → Upload file (multipart)
GET    /api/files/:fileId/download  → Get presigned download URL
GET    /api/files?channelId=xxx     → List channel files
POST   /api/presence/heartbeat      → Send presence heartbeat
GET    /api/presence/channel/:id    → Get channel member presence
GET    /api/sse/:channelId          → SSE stream for real-time updates
```

## Key Design Decisions

### SSE vs WebSocket for Real-Time Transport

We chose SSE over WebSocket because the message flow is asymmetric: clients send messages via REST POST (which gives us proper request/response semantics with status codes and error handling) and receive updates via server push. SSE is HTTP-native, works through all proxies and load balancers without special configuration, and the browser's `EventSource` API provides automatic reconnection with last-event-ID tracking for free. The trade-off is that SSE is unidirectional -- if we later needed bidirectional streaming (e.g., typing indicators at high frequency), WebSocket would be more efficient. For a chat system where the "write" path (sending messages) naturally fits REST semantics, SSE's simplicity wins.

### Redis Pub/Sub vs Kafka for Cross-Instance Messaging

Redis pub/sub delivers messages to all subscribed server instances with sub-millisecond latency, which is critical for chat's perceived responsiveness. Kafka would add 5-10ms of latency per message due to disk writes and consumer group coordination. However, Redis pub/sub has no durability -- if a server instance is restarting when a message is published, that message is lost for its clients. For a chat application, this is acceptable because clients can fetch missed messages via the REST API on reconnect. At larger scale (>1M concurrent users), we would add Kafka as a durable write-ahead log between the message service and the pub/sub layer, using Redis only for last-mile fan-out.

### Self-Referencing Thread Model

Threads use a `parent_message_id` foreign key back to the messages table rather than a separate threads table. This works because Teams uses flat threads (one level deep) -- a reply always points to a top-level message. The trade-off is that deeply nested threading (like Reddit-style comment trees) is not supported. For enterprise chat, flat threading is the correct UX choice: it keeps conversations focused and prevents the "reply to a reply to a reply" confusion. The query pattern is simple: fetch top-level messages with `WHERE parent_message_id IS NULL`, then fetch thread replies with `WHERE parent_message_id = :id`.

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time transport | SSE | WebSocket | Simpler server-side, sufficient for unidirectional push; messages sent via REST |
| Cross-instance messaging | Redis pub/sub | Kafka | Lower latency for real-time chat; no durability needed for push |
| Presence tracking | Redis TTL keys | Database polling | Sub-second state change detection, automatic cleanup on disconnect |
| Thread model | Self-referencing FK | Separate threads table | Simpler schema, thread is just a message with `parent_message_id` |
| File storage | S3/MinIO | Database BLOBs | Scalable object storage, presigned URLs offload download bandwidth |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler invalidation |
| Org hierarchy | Org > Team > Channel | Flat channel list | Mirrors enterprise structure, enables per-level access control |

## Consistency and Idempotency

- **Message creation** uses client-generated UUIDs as idempotency keys. If a client retries a failed POST, the server detects the duplicate UUID via unique constraint and returns the existing message rather than creating a duplicate.
- **Reaction toggle** uses `ON CONFLICT DO NOTHING` for adds and explicit deletes for removes -- both operations are naturally idempotent.
- **Membership operations** use `ON CONFLICT DO NOTHING` to handle duplicate join requests gracefully.
- **Read position** updates use `UPDATE ... SET last_read_at = NOW()` which is naturally idempotent -- reapplying the same operation produces the same result.
- **File uploads** use a two-phase approach: first reserve a file ID, then upload to S3 with that ID as the key. Retrying the upload overwrites the same key.

## Security and Auth

- Session-based authentication with Redis-backed store (immediate revocation on logout)
- Password hashing with bcryptjs (cost factor 10)
- Rate limiting: 1000 req/15min for API, 50 req/15min for auth, 120 msg/min for messages
- HTTP-only, SameSite cookies prevent CSRF and XSS-based session theft
- File upload size limited to 50MB per request
- At production scale: OAuth2/SAML integration for enterprise SSO, mTLS between services, encryption at rest for messages and files

## Observability

- **Prometheus metrics**: HTTP request duration/count by endpoint, SSE active connections gauge, messages sent counter, presence heartbeat rate, Redis pub/sub message count
- **Structured logging**: Pino with JSON output, request correlation via pino-http for tracing message flow across services
- **Health check**: `GET /api/health` verifies database connectivity and Redis reachability for load balancer health probes
- **At production scale**: Distributed tracing (Jaeger/OpenTelemetry), Grafana dashboards for SLO tracking, PagerDuty alerting on p99 latency spikes and error rate thresholds

## Failure Handling

- **Circuit breakers** (Opossum) wrap external service calls (Redis, MinIO) with 10s timeout and 50% error threshold. When Redis pub/sub fails, the circuit opens and messages are still delivered to clients connected to the same server instance via in-process EventEmitter -- degraded but not broken.
- **Redis reconnection**: Exponential backoff with max 2s delay and lazy connect to avoid thundering herd on recovery.
- **SSE heartbeat**: 30-second keepalive prevents proxy timeouts and detects stale connections. If a client misses heartbeats, the server closes the connection and frees resources.
- **Graceful shutdown**: SIGTERM/SIGINT handlers close the server, drain SSE connections, flush pub/sub, and close database pool in order.
- **Database connection pool**: Max 20 connections, 5s connect timeout, 30s idle timeout. Pool exhaustion triggers queuing with backpressure rather than connection storms.

## Scalability Considerations

**What breaks first at scale:**

1. **SSE connections** -- Each server holds connections in memory. At 100K users per server, memory becomes the bottleneck (~500MB just for connection buffers). Solution: dedicated SSE gateway servers with sticky sessions, or migrate to WebSocket with connection pooling at the gateway layer.

2. **Message table** -- A single PostgreSQL table with billions of rows. Full-table scans for old messages become untenable. Solution: partition by `(channel_id, created_at)` using range partitioning, archive partitions older than 1 year to cold storage, or migrate hot channels to Cassandra for write-optimized time-series access.

3. **Redis pub/sub** -- Fan-out to many subscribers on popular channels with 10K+ members creates O(N) work per message. Solution: channel-based sharding across Redis clusters, with a routing layer that maps channel IDs to specific Redis nodes.

**Scaling path:**
- Horizontal API scaling behind a load balancer (SSE requires sticky sessions or shared pub/sub)
- Read replicas for message history queries (eventual consistency acceptable for historical data)
- Separate write and read paths for messages (CQRS) with async replication
- CDN for static assets and file downloads
- Message search via Elasticsearch with async indexing from the write path
- Multi-region deployment with per-region message routing and cross-region replication for org metadata

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| SSE over WebSocket | Simpler, HTTP-native | WebSocket for bidirectional | Messages sent via REST, only push needed |
| Single PostgreSQL | Simpler operations | Sharded cluster | Partition by channel_id when table exceeds 1B rows |
| Redis pub/sub | Low latency (<1ms) | Kafka | Chat needs speed over durability; fetch missed msgs on reconnect |
| Self-referencing threads | Simple schema, fast queries | Separate table | One table handles both top-level and replies |
| Presigned URLs for files | Offloads bandwidth | Proxy through API | CDN-compatible, scales independently |
| Session auth | Immediate revocation | JWT | Enterprise apps need instant session kill |

## Implementation Notes

### Local Setup Diagram

```
┌─────────────────┐         ┌──────────────────────────────────────┐
│   React SPA     │         │        Express Server                │
│  localhost:5173  │────────▶│        localhost:3000                │
│  (Vite + TS)    │◀── SSE ─│                                      │
└─────────────────┘         │  Routes: auth, orgs, teams,          │
                            │  channels, messages, reactions,      │
                            │  files, presence, sse, users         │
                            │                                      │
                            │  Services: pubsub, presence,         │
                            │  storage, metrics, circuitBreaker,   │
                            │  rateLimiter, logger                 │
                            └──────┬──────────┬──────────┬─────────┘
                                   │          │          │
                            ┌──────┴───┐ ┌────┴────┐ ┌──┴──────┐
                            │PostgreSQL│ │ Valkey  │ │  MinIO  │
                            │  :5432   │ │  :6379  │ │ :9000   │
                            │  teams   │ │sessions,│ │  files  │
                            │          │ │presence,│ │         │
                            │          │ │ pub/sub │ │         │
                            └──────────┘ └─────────┘ └─────────┘
```

### Production-Grade Patterns Implemented

1. **Redis pub/sub for cross-instance messaging** -- Enables horizontal scaling by broadcasting messages through Redis rather than relying on in-process EventEmitter alone. Each server subscribes to channels its connected clients are viewing. See `src/services/pubsub.ts`.

2. **Prometheus metrics** (prom-client) -- Tracks HTTP request latency histograms, SSE connection gauge, message throughput counter, and presence heartbeat rate. Exposed at `/metrics` for Prometheus scraping. See `src/services/metrics.ts`.

3. **Structured logging** (Pino) -- JSON-formatted logs with request correlation via pino-http. Every log entry includes service name, timestamp, and request context for debugging distributed message flows. See `src/services/logger.ts`.

4. **Circuit breakers** (Opossum) -- Protect against cascading failures when Redis or MinIO become unavailable. Configured with 10s timeout, 50% error threshold, and 10s reset window. See `src/services/circuitBreaker.ts`.

5. **Rate limiting** -- Tiered limits: auth (50/15min), general API (1000/15min), and messaging (120/min). Uses express-rate-limit with Redis-backed store for cross-instance rate counting. See `src/services/rateLimiter.ts`.

6. **Health check endpoint** -- `GET /api/health` verifies database connectivity for load balancer integration.

### Simplifications vs Production

| Component | Local Implementation | Production Equivalent |
|-----------|---------------------|----------------------|
| Database | Single PostgreSQL instance | Sharded cluster with read replicas |
| File storage | MinIO on localhost:9000 | AWS S3 + CloudFront CDN |
| Session store | Valkey on localhost:6379 | Redis Cluster with replication |
| Auth | Session cookies + bcrypt | OAuth2/SAML enterprise SSO |
| Real-time transport | SSE (sufficient for unidirectional) | SSE or WebSocket behind API Gateway |
| Message bus | In-process EventEmitter + Redis pub/sub | Kafka for durability + Redis for last-mile |
| Search | Not implemented | Elasticsearch with async indexing |
| Load balancer | Single server instance | nginx/ALB with sticky sessions |

### Omitted from Local Implementation
- CDN for file delivery and static assets
- Multi-region deployment and geo-routing
- Kubernetes orchestration and auto-scaling
- Message search (Elasticsearch)
- Video/audio calling (WebRTC)
- End-to-end encryption
- SAML/OAuth2 enterprise SSO
- Message retention policies and compliance archival
- Distributed tracing (OpenTelemetry/Jaeger)
