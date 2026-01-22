# Google Calendar - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design the backend infrastructure for a calendar application that allows users to:
- Manage events across multiple calendars
- Detect scheduling conflicts in real-time
- Handle efficient date range queries
- Scale to millions of users

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements
1. **User Management**: Authentication, session handling, user preferences (timezone)
2. **Calendar CRUD**: Users can create/manage multiple calendars with metadata
3. **Event CRUD**: Create, read, update, delete events with time ranges
4. **Conflict Detection**: Identify overlapping events across all user calendars
5. **Date Range Queries**: Efficiently fetch events for any time window

### Non-Functional Requirements
1. **Low Latency**: Event queries < 50ms at p99
2. **Consistency**: Strong consistency for event operations (no double-booking issues)
3. **Availability**: 99.9% uptime for read operations
4. **Scalability**: Support 10M+ users with 100+ events each

### Scale Estimates
- 10M users × 100 events avg = **1B total events**
- Avg event size: 500 bytes → **500GB raw data**
- Read-heavy: **100:1 read:write ratio**
- Peak traffic: **100K reads/sec, 1K writes/sec**

### Out of Scope (for 45 min)
- Recurring event expansion (RRULE)
- Calendar sharing/collaboration
- Notification system

---

## 2. High-Level Architecture (10 minutes)

### System Overview

```
                              ┌─────────────────────────────────────┐
                              │        Load Balancer (nginx)         │
                              └─────────────────┬───────────────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
                    ▼                           ▼                           ▼
            ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
            │  API Server  │           │  API Server  │           │  API Server  │
            │   (Node.js)  │           │   (Node.js)  │           │   (Node.js)  │
            └──────┬───────┘           └──────┬───────┘           └──────┬───────┘
                   │                          │                          │
                   └──────────────────────────┼──────────────────────────┘
                                              │
                   ┌──────────────────────────┼──────────────────────────┐
                   │                          │                          │
                   ▼                          ▼                          ▼
           ┌──────────────┐          ┌───────────────┐          ┌───────────────┐
           │    Valkey    │          │  PostgreSQL   │          │  PostgreSQL   │
           │   (Cache +   │          │    Primary    │          │    Replica    │
           │   Sessions)  │          │               │          │  (Read-only)  │
           └──────────────┘          └───────────────┘          └───────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **Load Balancer** | Distribute traffic, health checks, SSL termination |
| **API Servers** | Stateless request handling, business logic, conflict detection |
| **PostgreSQL Primary** | Source of truth for all writes (events, calendars, users) |
| **PostgreSQL Replica** | Handle read-heavy date range queries |
| **Valkey Cache** | Session storage, event cache, rate limiting |

---

## 3. Data Model Design (10 minutes)

### Entity Relationships

```
┌─────────────┐       1:N       ┌─────────────┐       1:N       ┌─────────────┐
│    Users    │────────────────►│  Calendars  │────────────────►│   Events    │
│             │                 │             │                 │             │
│ • id        │                 │ • id        │                 │ • id        │
│ • email     │                 │ • user_id   │                 │ • calendar_id│
│ • timezone  │                 │ • name      │                 │ • title     │
│             │                 │ • color     │                 │ • start_time│
│             │                 │ • is_primary│                 │ • end_time  │
└─────────────┘                 └─────────────┘                 │ • location  │
                                                                └─────────────┘
```

### Key Schema Decisions

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| **users** | id, email, password_hash, timezone | User account with TZ preference |
| **calendars** | id, user_id, name, color, is_primary | Support multiple calendars per user |
| **events** | id, calendar_id, title, start_time, end_time | Core event data with TIMESTAMPTZ |
| **sessions** | sid, sess, expire | Server-side session storage |

### Index Strategy

```
Events Table Indexes:
├── PRIMARY KEY (id)
├── BTREE (calendar_id, start_time, end_time)  ← Date range queries
└── BTREE (calendar_id, start_time) INCLUDE (title, end_time)  ← Covering index for list views

Purpose:
• Fast lookups: "All events for calendar X between dates A and B"
• Conflict detection: "Find events overlapping time range [start, end]"
```

### Database Selection: Alternatives Considered

| Database | Pros | Cons | Decision |
|----------|------|------|----------|
| **PostgreSQL** | ACID, excellent range queries, mature tooling | Single-writer scaling | ✓ Chosen |
| **Cassandra** | High write throughput, horizontal scale | Poor range queries, eventual consistency | Rejected |
| **MongoDB** | Flexible schema, good read scale | Weaker consistency guarantees | Rejected |
| **CockroachDB** | Distributed SQL, auto-scaling | Operational complexity, higher latency | Future option |

**Decision Rationale**: Calendar data requires:
1. Time range queries (core feature) → PostgreSQL B-tree indexes excel
2. Strong consistency for conflict detection → ACID required
3. Moderate write volume (1K/sec) → Single-writer PostgreSQL handles this

---

## 4. Deep Dive: Conflict Detection (10 minutes)

### The Time Overlap Problem

Two events overlap if their time ranges intersect:

```
Case 1: Partial overlap (A starts during B)
    B: |---------|
    A:      |---------|

Case 2: Partial overlap (B starts during A)
    B:      |---------|
    A: |---------|

Case 3: A contains B
    B:    |---|
    A: |---------|

Case 4: B contains A
    B: |---------|
    A:    |---|

All cases detected by: (A.start < B.end) AND (A.end > B.start)
```

### Query Approach

**Find conflicts for a proposed event [start, end] across all user calendars:**

```
SELECT events.id, title, start_time, end_time, calendar.name, calendar.color
FROM events
JOIN calendars ON events.calendar_id = calendars.id
WHERE calendars.user_id = :user_id
  AND events.start_time < :proposed_end    -- Existing starts before proposed ends
  AND events.end_time > :proposed_start    -- Existing ends after proposed starts
  AND events.id != :exclude_id             -- Exclude self when editing
ORDER BY start_time
```

**Index utilization**: Uses `(calendar_id, start_time, end_time)` composite index for efficient range scan.

### Design Decision: Non-Blocking Conflicts

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Warn but allow** | Flexible, matches real calendar behavior | Users may miss warnings | ✓ Chosen |
| **Block creation** | Prevents all overlaps | Too restrictive (intentional overlaps exist) | Rejected |
| **Require confirmation** | Explicit user acknowledgment | Adds friction to workflow | Alternative for settings |

**Rationale**: Real calendars allow overlapping events (e.g., "tentative" meetings, background tasks). Better to inform than to block.

---

## 5. API Design (5 minutes)

### RESTful Endpoints

```
Authentication:
┌─────────────────────────────────────────────────────────────────────┐
│ POST   /api/auth/register   → Create account                       │
│ POST   /api/auth/login      → Authenticate, create session         │
│ POST   /api/auth/logout     → Destroy session                      │
│ GET    /api/auth/me         → Get current user                     │
└─────────────────────────────────────────────────────────────────────┘

Calendars:
┌─────────────────────────────────────────────────────────────────────┐
│ GET    /api/calendars       → List user's calendars                │
│ POST   /api/calendars       → Create new calendar                  │
│ PUT    /api/calendars/:id   → Update calendar (name, color)        │
│ DELETE /api/calendars/:id   → Delete calendar + all events         │
└─────────────────────────────────────────────────────────────────────┘

Events:
┌─────────────────────────────────────────────────────────────────────┐
│ GET    /api/events?start=&end=  → Fetch events in range            │
│ GET    /api/events/:id          → Get single event                 │
│ POST   /api/events              → Create (returns conflicts)       │
│ PUT    /api/events/:id          → Update (returns conflicts)       │
│ DELETE /api/events/:id          → Delete event                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Response Pattern for Conflict-Aware Operations

```
POST /api/events → 201 Created

Response:
{
  "event": { id, title, start_time, end_time, ... },
  "conflicts": [
    { id, title, start_time, end_time, calendar_name }
  ]
}
```

The event is created AND conflicts are returned as informational data.

---

## 6. Caching Strategy (3 minutes)

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Request Flow                               │
├─────────────────────────────────────────────────────────────────┤
│  GET /api/events?start=2025-01-01&end=2025-01-31                │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 1. Check Valkey: events:{userId}:{month}                    ││
│  │    HIT?  → Return cached (< 1ms)                            ││
│  │    MISS? → Query PostgreSQL → Cache result (TTL: 5 min)     ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Cache Key Patterns

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `sessions:{sid}` | 7 days | User session data |
| `calendars:{userId}` | 1 hour | User's calendar list (rarely changes) |
| `events:{userId}:{month}` | 5 min | Events for a month (common query) |

### Cache Invalidation Strategy

**Invalidate on write**: When user creates/updates/deletes an event:
1. Delete all `events:{userId}:*` keys
2. Event is immediately visible on next read

**Trade-off**: Slightly aggressive invalidation vs. stale data risk.

---

## 7. Scalability Considerations (3 minutes)

### Read Scaling Path

```
            ┌─────────────────────────────────────────────────┐
            │              Read Scaling Options                │
            ├─────────────────────────────────────────────────┤
            │                                                  │
            │  Level 1: Read Replicas                          │
            │  ├── Route reads to replicas                     │
            │  └── Handles 10x read throughput                 │
            │                                                  │
            │  Level 2: Caching                                │
            │  ├── Valkey for hot data                         │
            │  └── 90%+ cache hit rate target                  │
            │                                                  │
            │  Level 3: Connection Pooling                     │
            │  ├── PgBouncer for connection management         │
            │  └── 1000s of app connections → 100 DB conns     │
            │                                                  │
            └─────────────────────────────────────────────────┘
```

### Write Scaling Path (Future)

| Technique | When to Apply | Complexity |
|-----------|---------------|------------|
| **Partitioning by user_id** | > 10K writes/sec | Medium |
| **Sharding across databases** | > 100K writes/sec | High |
| **CQRS (separate read/write stores)** | > 1M writes/sec | Very High |

For this design (1K writes/sec), single primary with replicas is sufficient.

### Capacity Estimates

| Component | Single Instance | With Scaling |
|-----------|-----------------|--------------|
| PostgreSQL writes | 1K/sec | 4K/sec (partitioned) |
| PostgreSQL reads | 10K/sec | 40K/sec (4 replicas) |
| Valkey ops | 100K/sec | 100K/sec |
| API servers | 5K req/sec each | 20K/sec (4 servers) |

---

## 8. Session Management (2 minutes)

### Session Storage: Alternatives Considered

| Approach | Latency | Persistence | Ops Complexity | Decision |
|----------|---------|-------------|----------------|----------|
| **PostgreSQL** | ~5ms | Yes | Low (already have) | ✓ Default |
| **Valkey/Redis** | ~1ms | Optional | Medium | For scale |
| **JWT (stateless)** | 0ms | N/A | Low | Rejected (revocation issues) |

**Decision**: Use PostgreSQL sessions for simplicity. Switch to Valkey when session operations become a bottleneck (unlikely at < 10K users).

### Security Measures

- **HttpOnly cookies**: Prevent XSS token theft
- **Secure flag**: HTTPS only in production
- **SameSite=Lax**: CSRF protection
- **Session rotation on login**: Prevent fixation attacks
- **Automatic expiration cleanup**: Prevent table bloat

---

## 9. Trade-offs Summary

| Decision | Trade-off |
|----------|-----------|
| **PostgreSQL over NoSQL** | Strong consistency vs. horizontal write scaling |
| **Non-blocking conflicts** | User flexibility vs. potential overlaps |
| **PostgreSQL sessions** | Simpler ops vs. slightly higher latency |
| **Aggressive cache invalidation** | Freshness vs. more DB queries on write |
| **Synchronous conflict check** | Consistency vs. added write latency (~5ms) |

---

## 10. Future Enhancements

1. **Recurring Events**: Store RRULE, expand instances on read with caching
2. **Event Sharing**: Add `event_invites` table with RSVP status
3. **Real-time Sync**: WebSocket server for multi-device updates
4. **Webhooks**: Notify external systems on event changes
5. **Audit Logging**: Track modifications for compliance
6. **Rate Limiting**: Per-user quotas with Valkey counters

---

## Questions I Would Ask

1. What's the expected user scale? (Affects sharding strategy)
2. Do we need recurring events in MVP?
3. Is calendar sharing required? (Adds complexity)
4. What's the consistency requirement? (Strong vs. eventual)
5. Any compliance requirements? (GDPR, data residency)
