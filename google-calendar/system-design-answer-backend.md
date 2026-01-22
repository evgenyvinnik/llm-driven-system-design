# 📅 Google Calendar - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 🎯 Problem Statement

Design the backend infrastructure for a calendar application that allows users to:
- Manage events across multiple calendars
- Detect scheduling conflicts in real-time
- Handle efficient date range queries
- Scale to millions of users

---

## 1️⃣ Requirements Clarification (5 minutes)

### ✅ Functional Requirements

| # | Requirement | Description |
|---|-------------|-------------|
| 1 | User Management | Authentication, session handling, timezone preferences |
| 2 | Calendar CRUD | Users can create/manage multiple calendars with metadata |
| 3 | Event CRUD | Create, read, update, delete events with time ranges |
| 4 | Conflict Detection | Identify overlapping events across all user calendars |
| 5 | Date Range Queries | Efficiently fetch events for any time window |

### ⚡ Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Low Latency | < 50ms p99 | Calendar must feel instant |
| Consistency | Strong | No double-booking issues |
| Availability | 99.9% | Read operations critical |
| Scalability | 10M+ users | 100+ events per user average |

### 📊 Scale Estimates

```
Users:        10M users × 100 events avg = 1B total events
Storage:      500 bytes/event avg → 500GB raw data
Traffic:      Read-heavy 100:1 ratio
Peak Load:    100K reads/sec, 1K writes/sec
```

### 🚫 Out of Scope

- Recurring events (RRULE expansion)
- Calendar sharing/collaboration
- Notification system

---

## 2️⃣ High-Level Architecture (10 minutes)

### 🏗️ System Overview

```
                              ┌─────────────────────────────────────┐
                              │    🌐 Load Balancer (nginx)          │
                              │    • SSL termination                │
                              │    • Health checks                  │
                              └─────────────────┬───────────────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
                    ▼                           ▼                           ▼
            ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
            │ ⚙️ API Server │           │ ⚙️ API Server │           │ ⚙️ API Server │
            │   (Node.js)  │           │   (Node.js)  │           │   (Node.js)  │
            └──────┬───────┘           └──────┬───────┘           └──────┬───────┘
                   │                          │                          │
                   └──────────────────────────┼──────────────────────────┘
                                              │
                   ┌──────────────────────────┼──────────────────────────┐
                   │                          │                          │
                   ▼                          ▼                          ▼
           ┌──────────────┐          ┌───────────────┐          ┌───────────────┐
           │ 🔴 Valkey     │          │ 🐘 PostgreSQL  │          │ 🐘 PostgreSQL  │
           │  (Cache +    │          │    Primary    │          │    Replica    │
           │   Sessions)  │          │               │          │  (Read-only)  │
           └──────────────┘          └───────────────┘          └───────────────┘
```

### 🔧 Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| 🌐 Load Balancer | Distribute traffic, health checks, SSL termination |
| ⚙️ API Servers | Stateless request handling, business logic, conflict detection |
| 🐘 PostgreSQL Primary | Source of truth for all writes |
| 🐘 PostgreSQL Replica | Handle read-heavy date range queries |
| 🔴 Valkey Cache | Session storage, event cache, rate limiting |

---

## 3️⃣ Data Model Design (10 minutes)

### 📐 Entity Relationships

```
┌─────────────────┐       1:N       ┌─────────────────┐       1:N       ┌─────────────────┐
│     👤 Users     │────────────────►│  📁 Calendars    │────────────────►│   📅 Events      │
├─────────────────┤                 ├─────────────────┤                 ├─────────────────┤
│ • id (PK)       │                 │ • id (PK)       │                 │ • id (PK)       │
│ • email         │                 │ • user_id (FK)  │                 │ • calendar_id   │
│ • password_hash │                 │ • name          │                 │ • title         │
│ • timezone      │                 │ • color         │                 │ • start_time    │
│ • created_at    │                 │ • is_primary    │                 │ • end_time      │
└─────────────────┘                 └─────────────────┘                 │ • location      │
                                                                        │ • description   │
                                                                        └─────────────────┘
```

### 🗂️ Key Tables

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| **users** | id, email, password_hash, timezone | User account with TZ preference |
| **calendars** | id, user_id, name, color, is_primary | Multiple calendars per user |
| **events** | id, calendar_id, title, start_time, end_time | Core event data (TIMESTAMPTZ) |
| **sessions** | sid, sess, expire | Server-side session storage |

### 📇 Index Strategy

```
Events Table Indexes:
├── PRIMARY KEY (id)
├── BTREE (calendar_id, start_time, end_time)  ← Date range queries
└── BTREE (calendar_id, start_time) INCLUDE (title, end_time)  ← Covering index

Purpose:
• Fast lookups: "All events for calendar X between dates A and B"
• Conflict detection: "Find events overlapping time range [start, end]"
```

### 🔄 Alternatives: Database Selection

| Database | Pros | Cons | Decision |
|----------|------|------|----------|
| **PostgreSQL** | ACID, excellent range queries, mature | Single-writer scaling | ✅ Chosen |
| **Cassandra** | High write throughput, horizontal scale | Poor range queries | ❌ |
| **MongoDB** | Flexible schema, good read scale | Weaker consistency | ❌ |
| **CockroachDB** | Distributed SQL, auto-scaling | Higher latency | Future option |

**Rationale**: Calendar requires time range queries (PostgreSQL B-trees excel) + strong consistency for conflict detection (ACID required).

---

## 4️⃣ Deep Dive: Conflict Detection (10 minutes)

### 📐 The Time Overlap Problem

Two events overlap if their time ranges intersect. Four cases, one condition:

```
Case 1: Partial overlap (A starts during B)
    B: |───────────|
    A:      |───────────|

Case 2: Partial overlap (B starts during A)
    B:      |───────────|
    A: |───────────|

Case 3: A contains B
    B:    |───|
    A: |───────────|

Case 4: B contains A
    B: |───────────|
    A:    |───|

✅ All cases detected by: (A.start < B.end) AND (A.end > B.start)
```

### 🔍 Query Approach

**Find conflicts for a proposed event across all user calendars:**

1️⃣ Join events with calendars to get user context
2️⃣ Filter by user_id
3️⃣ Apply overlap condition: `start < proposed_end AND end > proposed_start`
4️⃣ Exclude self (when editing existing event)
5️⃣ Order by start_time

**Index utilization**: Uses `(calendar_id, start_time, end_time)` composite index for efficient range scan.

### 🔄 Alternatives: Conflict Handling

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Warn but allow** | Flexible, real-world behavior | May miss warnings | ✅ Chosen |
| **Block creation** | Prevents all overlaps | Too restrictive | ❌ |
| **Require confirmation** | Explicit acknowledgment | Adds friction | User setting |

**Rationale**: Real calendars allow overlapping events (tentative meetings, background tasks). Better to inform than block.

---

## 5️⃣ API Design (5 minutes)

### 🔌 RESTful Endpoints

```
🔐 Authentication:
├─▶ POST   /api/auth/register   → Create account
├─▶ POST   /api/auth/login      → Authenticate, create session
├─▶ POST   /api/auth/logout     → Destroy session
└─▶ GET    /api/auth/me         → Get current user

📁 Calendars:
├─▶ GET    /api/calendars       → List user's calendars
├─▶ POST   /api/calendars       → Create new calendar
├─▶ PUT    /api/calendars/:id   → Update calendar (name, color)
└─▶ DELETE /api/calendars/:id   → Delete calendar + all events

📅 Events:
├─▶ GET    /api/events?start=&end=  → Fetch events in range
├─▶ GET    /api/events/:id          → Get single event
├─▶ POST   /api/events              → Create (returns conflicts)
├─▶ PUT    /api/events/:id          → Update (returns conflicts)
└─▶ DELETE /api/events/:id          → Delete event
```

### 📤 Response Pattern

Event creation/update returns BOTH the created event AND any conflicts:

```
POST /api/events → 201 Created

Response includes:
├─▶ event: { id, title, start_time, end_time, ... }
└─▶ conflicts: [ { id, title, time, calendar_name }, ... ]
```

Event is created **and** conflicts returned as informational data (non-blocking).

---

## 6️⃣ Caching Strategy (3 minutes)

### 🔄 Request Flow

```
GET /api/events?start=2025-01-01&end=2025-01-31
                    │
                    ▼
    ┌───────────────────────────────────────┐
    │  1️⃣ Check Valkey cache                │
    │     Key: events:{userId}:{month}      │
    │                                       │
    │  HIT?  → Return cached (< 1ms) ✅     │
    │  MISS? → Query PostgreSQL            │
    │         → Cache result (TTL: 5 min)  │
    └───────────────────────────────────────┘
```

### 📋 Cache Key Patterns

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `sessions:{sid}` | 7 days | User session data |
| `calendars:{userId}` | 1 hour | Calendar list (rarely changes) |
| `events:{userId}:{month}` | 5 min | Events for a month (common query) |

### 🗑️ Invalidation Strategy

**Invalidate on write**: When user creates/updates/deletes:
1. Delete all `events:{userId}:*` keys
2. Event immediately visible on next read

**Trade-off**: Aggressive invalidation vs. stale data risk

---

## 7️⃣ Scalability Path (3 minutes)

### 📈 Read Scaling

```
┌─────────────────────────────────────────────────┐
│              Read Scaling Options                │
├─────────────────────────────────────────────────┤
│                                                  │
│  Level 1: Read Replicas                          │
│  ├─▶ Route reads to replicas                     │
│  └─▶ Handles 10x read throughput                 │
│                                                  │
│  Level 2: Caching                                │
│  ├─▶ Valkey for hot data                         │
│  └─▶ Target 90%+ cache hit rate                  │
│                                                  │
│  Level 3: Connection Pooling                     │
│  ├─▶ PgBouncer for connection management         │
│  └─▶ 1000s app connections → 100 DB connections  │
│                                                  │
└─────────────────────────────────────────────────┘
```

### 📈 Write Scaling (Future)

| Technique | When to Apply | Complexity |
|-----------|---------------|------------|
| Partitioning by user_id | > 10K writes/sec | Medium |
| Sharding across databases | > 100K writes/sec | High |
| CQRS (separate read/write) | > 1M writes/sec | Very High |

For this design (1K writes/sec), single primary with replicas is sufficient.

### 📊 Capacity Estimates

| Component | Single Instance | With Scaling |
|-----------|-----------------|--------------|
| PostgreSQL writes | 1K/sec | 4K/sec (partitioned) |
| PostgreSQL reads | 10K/sec | 40K/sec (4 replicas) |
| Valkey ops | 100K/sec | 100K/sec |
| API servers | 5K req/sec each | 20K/sec (4 servers) |

---

## 8️⃣ Session Management (2 minutes)

### 🔄 Alternatives: Session Storage

| Approach | Latency | Persistence | Complexity | Decision |
|----------|---------|-------------|------------|----------|
| **PostgreSQL** | ~5ms | Yes | Low (already have) | ✅ Default |
| **Valkey/Redis** | ~1ms | Optional | Medium | For scale |
| **JWT (stateless)** | 0ms | N/A | Low | ❌ Revocation issues |

**Decision**: Use PostgreSQL sessions for simplicity. Switch to Valkey when bottleneck (unlikely at < 10K users).

### 🔒 Security Measures

- **HttpOnly cookies**: Prevent XSS token theft
- **Secure flag**: HTTPS only in production
- **SameSite=Lax**: CSRF protection
- **Session rotation**: On login to prevent fixation
- **Auto cleanup**: Prevent session table bloat

---

## 9️⃣ Trade-offs Summary

| Decision | Trade-off |
|----------|-----------|
| 🐘 PostgreSQL over NoSQL | Strong consistency vs. horizontal write scaling |
| ⚠️ Non-blocking conflicts | User flexibility vs. potential overlaps |
| 🗄️ PostgreSQL sessions | Simpler ops vs. slightly higher latency |
| 🔄 Aggressive cache invalidation | Freshness vs. more DB queries on write |
| ⏱️ Synchronous conflict check | Consistency vs. added write latency (~5ms) |

---

## 🔟 Future Enhancements

1. 🔁 **Recurring Events**: Store RRULE, expand instances on read with caching
2. 👥 **Event Sharing**: Add `event_invites` table with RSVP status
3. 🔄 **Real-time Sync**: WebSocket server for multi-device updates
4. 🪝 **Webhooks**: Notify external systems on event changes
5. 📝 **Audit Logging**: Track modifications for compliance
6. 🚦 **Rate Limiting**: Per-user quotas with Valkey counters

---

## ❓ Questions I Would Ask

1. What's the expected user scale? (Affects sharding strategy)
2. Do we need recurring events in MVP?
3. Is calendar sharing required? (Adds complexity)
4. What's the consistency requirement? (Strong vs. eventual)
5. Any compliance requirements? (GDPR, data residency)
