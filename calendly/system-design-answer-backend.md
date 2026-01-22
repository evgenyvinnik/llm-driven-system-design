# Calendly - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction

"Today I'll design a meeting scheduling platform like Calendly, focusing on the backend architecture. The core challenge is preventing double bookings while efficiently calculating availability across multiple calendar sources. I'll walk through the database design, booking transaction handling, calendar integration patterns, and the notification system."

---

## Step 1: Requirements Clarification

### Functional Requirements

1. **Availability Management**: Users define working hours and weekly schedules
2. **Meeting Types**: Different durations with buffer times before/after
3. **Booking Flow**: Invitees see available slots and book instantly with conflict prevention
4. **Calendar Integration**: OAuth-based sync with Google Calendar and Outlook
5. **Notifications**: Email confirmations, reminders, cancellation notices via queue
6. **Time Zone Handling**: Store UTC, display in user's local time zone

### Non-Functional Requirements

- **Consistency**: Zero tolerance for double bookings (strong consistency required)
- **Latency**: Availability checks < 200ms (5,000 RPS peak)
- **Availability**: 99.9% uptime for booking system
- **Scale**: 1M users, 430K bookings/day

---

## Step 2: High-Level Architecture

```
┌─────────────────────────────────────────┐
│         Load Balancer (nginx)           │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│    API Gateway / Application Layer      │
│        (Node.js + Express)              │
└─────────────────────────────────────────┘
                    │
     ┌──────────────┼──────────────┬──────────────┐
     ▼              ▼              ▼              ▼
┌──────────┐  ┌────────────┐ ┌────────────┐ ┌──────────────┐
│ Booking  │  │Availability│ │Integration │ │Notification  │
│ Service  │  │ Service    │ │ Service    │ │ Service      │
└──────────┘  └────────────┘ └────────────┘ └──────────────┘
     │              │              │              │
     └──────────────┼──────────────┴──────────────┘
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
┌──────────┐  ┌────────────┐  ┌────────────┐
│PostgreSQL│  │ Valkey/    │  │  RabbitMQ  │
│(Primary) │  │  Redis     │  │  (Queue)   │
└──────────┘  └────────────┘  └────────────┘
```

---

## Step 3: Database Schema Design

### Core Tables

```
┌─────────────────────────────────────────────────────────────┐
│                        users                                │
├─────────────────────────────────────────────────────────────┤
│ id (UUID PK)                                                │
│ email (VARCHAR UNIQUE NOT NULL)                             │
│ password_hash, name, time_zone (default 'UTC')              │
│ role (default 'user'), created_at, updated_at               │
└─────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   meeting_types     │ │availability_    │ │    bookings     │
├─────────────────────┤ │    rules        │ ├─────────────────┤
│ id (UUID PK)        │ ├─────────────────┤ │ id (UUID PK)    │
│ user_id (FK)        │ │ id (UUID PK)    │ │ meeting_type_id │
│ name, slug (UNIQUE  │ │ user_id (FK)    │ │ host_user_id FK │
│   with user_id)     │ │ day_of_week 0-6 │ │ invitee_name    │
│ duration_minutes    │ │ start_time TIME │ │ invitee_email   │
│ buffer_before/after │ │ end_time TIME   │ │ start_time TZ   │
│ max_bookings_per_day│ │ is_active       │ │ end_time TZ     │
│ color, is_active    │ └─────────────────┘ │ status, version │
└─────────────────────┘                     │ idempotency_key │
                                            └─────────────────┘
```

### Critical Indexes for Double-Booking Prevention

```
┌────────────────────────────────────────────────────────────────┐
│                     Index Strategy                              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  idx_bookings_no_double (UNIQUE PARTIAL)                       │
│  ──────────────────────────────────────                        │
│  ON bookings(host_user_id, start_time)                         │
│  WHERE status = 'confirmed'                                    │
│                                                                │
│  idx_bookings_idempotency_key (UNIQUE PARTIAL)                 │
│  ─────────────────────────────────────────────                 │
│  ON bookings(idempotency_key)                                  │
│  WHERE idempotency_key IS NOT NULL                             │
│                                                                │
│  idx_bookings_host_time                                        │
│  ──────────────────────                                        │
│  ON bookings(host_user_id, start_time, end_time)               │
│                                                                │
│  idx_availability_user_day                                     │
│  ─────────────────────────                                     │
│  ON availability_rules(user_id, day_of_week, is_active)        │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Archive Table for Data Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│                   bookings_archive                           │
├──────────────────────────────────────────────────────────────┤
│ Same columns as bookings (no foreign keys)                   │
│ archived_at TIMESTAMP                                        │
│                                                              │
│ Purpose: Move completed bookings to reduce active table size │
└──────────────────────────────────────────────────────────────┘
```

---

## Step 4: Deep Dive - Double Booking Prevention

### Multi-Layer Approach

"The booking race condition is the hardest problem. Two invitees clicking 'Book' at the same moment must never both succeed for the same slot."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    FIVE-LAYER BOOKING PROTECTION                        │
└─────────────────────────────────────────────────────────────────────────┘

  Invitee A ──▶ ┌─────────────────────────────────────────────────────────┐
                │ Layer 1: Idempotency Check                              │
  Invitee B ──▶ │ ────────────────────────                                │
                │ Check cache for idempotency_key                         │
                │ If exists ──▶ Return cached booking result              │
                └────────────────────────┬────────────────────────────────┘
                                         ▼
                ┌─────────────────────────────────────────────────────────┐
                │ Layer 2: Distributed Lock (Valkey/Redis)                │
                │ ─────────────────────────────────────                   │
                │ Key: booking_lock:{host_user_id}                        │
                │ TTL: 5 seconds                                          │
                │ If lock fails ──▶ Return "Booking in progress, retry"   │
                └────────────────────────┬────────────────────────────────┘
                                         ▼
                ┌─────────────────────────────────────────────────────────┐
                │ Layer 3: Row-Level Lock (PostgreSQL Transaction)        │
                │ ───────────────────────────────────────────             │
                │ SELECT id FROM users WHERE id = host_id FOR UPDATE      │
                │ Serializes all bookings for same host                   │
                └────────────────────────┬────────────────────────────────┘
                                         ▼
                ┌─────────────────────────────────────────────────────────┐
                │ Layer 4: Overlap Query Check                            │
                │ ─────────────────────────                               │
                │ SELECT id FROM bookings                                 │
                │ WHERE host_user_id = ? AND status = 'confirmed'         │
                │   AND start_time < new_end AND end_time > new_start     │
                │ If rows found ──▶ Throw ConflictError                   │
                └────────────────────────┬────────────────────────────────┘
                                         ▼
                ┌─────────────────────────────────────────────────────────┐
                │ Layer 5: Unique Partial Index (Database Constraint)     │
                │ ──────────────────────────────────────────────          │
                │ INSERT INTO bookings (...) VALUES (...)                 │
                │ If duplicate key error ──▶ Throw ConflictError          │
                │ SUCCESS ──▶ Cache idempotency result, invalidate cache  │
                └─────────────────────────────────────────────────────────┘
```

### Post-Booking Actions

```
┌───────────────────────────────────────────────────────────────┐
│                   After Successful Booking                     │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Store idempotency result (1 hour TTL)                     │
│     └──▶ Prevents duplicate bookings from network retries     │
│                                                               │
│  2. Invalidate availability cache                             │
│     └──▶ Pattern: availability:{host_user_id}:*               │
│                                                               │
│  3. Queue confirmation email (async, non-blocking)            │
│     └──▶ RabbitMQ: notifications queue                        │
│                                                               │
│  4. Release distributed lock                                  │
│     └──▶ Always in finally block                              │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Why Five Layers?

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| 1 | Idempotency Key | Prevents duplicate submissions from network retries |
| 2 | Distributed Lock | Serializes concurrent requests to same host |
| 3 | SELECT FOR UPDATE | Row-level lock within transaction |
| 4 | Overlap Query | Explicit conflict check with current data |
| 5 | Unique Partial Index | Database-level constraint as last defense |

---

## Step 5: Deep Dive - Availability Calculation

### Algorithm Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     AVAILABILITY CALCULATION                            │
└─────────────────────────────────────────────────────────────────────────┘

 Request: getAvailableSlots(meetingTypeId, date, timezone)
                              │
                              ▼
           ┌──────────────────────────────────────┐
           │ Step 1: Check Cache (5-min TTL)      │
           │ Key: availability:{typeId}:{date}    │
           ├──────────────────────────────────────┤
           │ Cache hit? ──▶ Convert timezone      │
           │             ──▶ Return slots         │
           └──────────────────┬───────────────────┘
                              │ Cache miss
                              ▼
           ┌──────────────────────────────────────┐
           │ Step 2: Get Availability Rules       │
           │ Query: availability_rules            │
           │ WHERE user_id=? AND day_of_week=?    │
           │       AND is_active=true             │
           ├──────────────────────────────────────┤
           │ No rules? ──▶ Return empty []        │
           └──────────────────┬───────────────────┘
                              ▼
           ┌──────────────────────────────────────┐
           │ Step 3: Get Existing Bookings        │
           │ Query: bookings WHERE host_user_id=? │
           │        AND status='confirmed'        │
           │        AND start_time in day range   │
           └──────────────────┬───────────────────┘
                              ▼
           ┌──────────────────────────────────────┐
           │ Step 4: Get External Calendar Events │
           │ CalendarIntegrationService.getEvents │
           │ (from cache or API)                  │
           └──────────────────┬───────────────────┘
                              ▼
           ┌──────────────────────────────────────┐
           │ Step 5: Merge Busy Periods           │
           │ Sort by start time                   │
           │ Merge overlapping intervals          │
           └──────────────────┬───────────────────┘
                              ▼
           ┌──────────────────────────────────────┐
           │ Step 6: Generate Available Slots     │
           │ For each rule window:                │
           │   Generate 15-min interval slots     │
           │   Check each against busy periods    │
           │   Account for buffer before/after    │
           └──────────────────┬───────────────────┘
                              ▼
           ┌──────────────────────────────────────┐
           │ Step 7: Cache and Return             │
           │ Cache result (5-min TTL)             │
           │ Convert to requested timezone        │
           └──────────────────────────────────────┘
```

### Busy Period Merge Algorithm

```
┌─────────────────────────────────────────────────────────────────────┐
│                   INTERVAL MERGING                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Input (sorted by start):                                           │
│  ┌─────┐  ┌─────────┐    ┌───┐ ┌───────┐                            │
│  │ 9-10│  │ 9:30-11 │    │2-3│ │3:30-5 │                            │
│  └─────┘  └─────────┘    └───┘ └───────┘                            │
│                                                                     │
│  Algorithm:                                                         │
│  1. Sort by start time                                              │
│  2. For each period:                                                │
│     - If overlaps with last merged ──▶ Extend end time              │
│     - Else ──▶ Add as new period                                    │
│                                                                     │
│  Output:                                                            │
│  ┌──────────────┐      ┌───┐ ┌───────┐                              │
│  │    9-11      │      │2-3│ │3:30-5 │                              │
│  └──────────────┘      └───┘ └───────┘                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Cache Invalidation Strategy

```
┌───────────────────────────────────────────────────────────────────┐
│                 CACHE INVALIDATION TRIGGERS                        │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Trigger                    │  Action                             │
│  ─────────────────────────  │  ─────────────────────              │
│  Booking created/cancelled  │  Invalidate all dates for host     │
│  Calendar sync completed    │  Invalidate all dates for host     │
│  Availability rules changed │  Invalidate all dates for host     │
│                                                                   │
│  Pattern-based deletion: availability:{host_user_id}:*           │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Deep Dive - Calendar Integration

### OAuth Token Management Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   OAUTH TOKEN LIFECYCLE                                 │
└─────────────────────────────────────────────────────────────────────────┘

        getValidToken(integrationId)
                    │
                    ▼
    ┌───────────────────────────────────┐
    │ Query calendar_integrations       │
    │ WHERE id = ? AND is_active = true │
    └──────────────────┬────────────────┘
                       ▼
    ┌───────────────────────────────────┐
    │ Token expires_at > now + 5min?    │
    ├───────────────────────────────────┤
    │ Yes ──▶ Return access_token       │
    │ No  ──▶ Refresh token flow        │
    └──────────────────┬────────────────┘
                       │ Needs refresh
                       ▼
    ┌───────────────────────────────────┐
    │ Call provider refresh endpoint    │
    │ (Google OAuth2 / Microsoft Graph) │
    └──────────────────┬────────────────┘
                       ▼
    ┌───────────────────────────────────┐
    │ Update DB with new access_token   │
    │ and expires_at timestamp          │
    └──────────────────┬────────────────┘
                       ▼
    ┌───────────────────────────────────┐
    │ Return new access_token           │
    └───────────────────────────────────┘
```

### Calendar Sync Error Handling

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ERROR HANDLING MATRIX                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Error Type              │  Action                                  │
│  ──────────────────────  │  ─────────────────────────────────────   │
│  RateLimitError          │  Schedule retry with exponential backoff │
│                          │  (start at 60 seconds)                   │
│                                                                     │
│  TokenExpiredError       │  Mark integration as needing             │
│                          │  reauthorization, notify user            │
│                                                                     │
│  NetworkError            │  Use cached data, retry in background    │
│                                                                     │
│  ProviderDown            │  Fallback to last cached events          │
│                          │  Continue with local bookings only       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Hybrid Sync Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   CALENDAR SYNC STRATEGY                                │
└─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────┐      ┌─────────────────────┐
  │ PUSH (Webhooks)     │      │ PULL (Polling)      │
  │ ─────────────────── │      │ ───────────────────  │
  │ Google Calendar     │      │ Every 10 minutes    │
  │ sends notification  │      │ for stale records   │
  │ to our endpoint     │      │ or webhook failures │
  └──────────┬──────────┘      └──────────┬──────────┘
             │                            │
             ▼                            ▼
  ┌───────────────────────────────────────────────────┐
  │              Sync Handler                          │
  │ 1. Fetch events from provider                     │
  │ 2. Cache events (10-min TTL)                      │
  │ 3. Invalidate availability cache                  │
  └───────────────────────────────────────────────────┘

  Webhook Endpoint: POST /api/webhooks/google-calendar
  Headers: x-goog-channel-id, x-goog-resource-state
  States: 'sync' or 'exists' ──▶ Trigger calendar refresh
```

---

## Step 7: Notification System

### Queue-Based Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   NOTIFICATION FLOW                                     │
└─────────────────────────────────────────────────────────────────────────┘

  Booking Created
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                    NotificationService                               │
  │                                                                     │
  │  queueConfirmation(booking)                                         │
  │  ┌─────────────────────────────────────────────────────────────┐    │
  │  │ Publish to 'notifications' queue:                           │    │
  │  │                                                             │    │
  │  │   ┌──────────────┐  ┌──────────────┐                        │    │
  │  │   │ To: Invitee  │  │ To: Host     │                        │    │
  │  │   │ Type: confirm│  │ Type: confirm│                        │    │
  │  │   │ bookingId    │  │ bookingId    │                        │    │
  │  │   └──────────────┘  └──────────────┘                        │    │
  │  └─────────────────────────────────────────────────────────────┘    │
  │                                                                     │
  │  scheduleReminders(booking)                                         │
  │  ┌─────────────────────────────────────────────────────────────┐    │
  │  │ Publish delayed messages:                                   │    │
  │  │                                                             │    │
  │  │   ┌──────────────────┐  ┌──────────────────┐                │    │
  │  │   │ 24h before       │  │ 1h before        │                │    │
  │  │   │ Type: reminder   │  │ Type: reminder   │                │    │
  │  │   └──────────────────┘  └──────────────────┘                │    │
  │  └─────────────────────────────────────────────────────────────┘    │
  └─────────────────────────────────────────────────────────────────────┘
```

### Notification Worker

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   NOTIFICATION WORKER                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  consume('notifications', async (message) => {                          │
│                                                                         │
│    ┌────────────────────────────────────────────────────────────────┐   │
│    │ 1. Fetch booking by ID                                         │   │
│    │    If cancelled ──▶ Acknowledge and skip                       │   │
│    └────────────────────────────┬───────────────────────────────────┘   │
│                                 ▼                                       │
│    ┌────────────────────────────────────────────────────────────────┐   │
│    │ 2. Generate email content based on type                        │   │
│    │    - confirmation: Meeting details + calendar link             │   │
│    │    - reminder: Time until meeting + join details               │   │
│    │    - cancellation: Reason + rebooking link                     │   │
│    └────────────────────────────┬───────────────────────────────────┘   │
│                                 ▼                                       │
│    ┌────────────────────────────────────────────────────────────────┐   │
│    │ 3. Send email via SMTP/SendGrid                                │   │
│    └────────────────────────────┬───────────────────────────────────┘   │
│                                 ▼                                       │
│    ┌────────────────────────────────────────────────────────────────┐   │
│    │ 4. Log to email_notifications table for audit                  │   │
│    │    (booking_id, recipient, type, subject, body, status='sent') │   │
│    └────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│    On error: Throw to trigger RabbitMQ retry with exponential backoff   │
│  })                                                                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Database Scaling Strategy

### Table Partitioning

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   MONTHLY PARTITIONING                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  bookings (parent table)                                                │
│  PARTITION BY RANGE (start_time)                                        │
│      │                                                                  │
│      ├──▶ bookings_2024_01 (Jan 1 - Feb 1)                              │
│      ├──▶ bookings_2024_02 (Feb 1 - Mar 1)                              │
│      ├──▶ bookings_2024_03 (Mar 1 - Apr 1)                              │
│      └──▶ ...                                                           │
│                                                                         │
│  Benefits:                                                              │
│  - Query performance: Only scan relevant partitions                     │
│  - Easy archival: DETACH old partitions, move to cold storage           │
│  - Maintenance: VACUUM/ANALYZE on smaller tables                        │
│                                                                         │
│  Auto-partition creation:                                               │
│  - Scheduled job creates next month's partition                         │
│  - create_monthly_partition() function                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Read Replica Configuration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   READ/WRITE SPLITTING                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                      ┌─────────────────┐                                │
│                      │  Application    │                                │
│                      └────────┬────────┘                                │
│                               │                                         │
│             ┌─────────────────┴─────────────────┐                       │
│             ▼                                   ▼                       │
│  ┌─────────────────────┐             ┌─────────────────────┐            │
│  │   Primary Pool      │             │   Replica Pool      │            │
│  │   (max: 20 conn)    │             │   (max: 50 conn)    │            │
│  │                     │             │                     │            │
│  │  Used for:          │             │  Used for:          │            │
│  │  - Booking create   │             │  - Availability     │            │
│  │  - Cancellation     │             │  - Meeting types    │            │
│  │  - Status updates   │             │  - User profiles    │            │
│  │  - Any INSERT/UPDATE│             │  - All SELECT       │            │
│  └─────────────────────┘             └─────────────────────┘            │
│             │                                   │                       │
│             ▼                                   ▼                       │
│  ┌─────────────────────┐             ┌─────────────────────┐            │
│  │ PostgreSQL Primary  │ ──repl──▶   │ PostgreSQL Replica  │            │
│  └─────────────────────┘             └─────────────────────┘            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Step 9: Trade-offs Summary

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Database | PostgreSQL | DynamoDB | ACID transactions essential for double-booking prevention |
| Locking | Pessimistic (FOR UPDATE) | Optimistic only | Correctness over latency for booking creation |
| Time Storage | UTC only | Local time zones | Simpler, no DST issues in storage |
| Calendar Sync | Hybrid (webhook + polling) | Polling only | Real-time freshness when supported |
| Availability Cache | 5-min TTL | No cache | Balance freshness vs. 5000 RPS peak load |
| Notifications | Async via RabbitMQ | Synchronous | Booking latency should not include email delivery |
| Partitioning | Monthly by start_time | None | Efficient archival, query performance |

---

## Step 10: Monitoring

### Key Backend Metrics

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   PROMETHEUS METRICS                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Booking Metrics                                                        │
│  ───────────────                                                        │
│  calendly_booking_operations_total                                      │
│    Labels: operation (create/cancel), status (success/failure)          │
│                                                                         │
│  calendly_booking_creation_duration_seconds                             │
│    Buckets: 0.1, 0.25, 0.5, 1, 2.5, 5                                   │
│                                                                         │
│  calendly_double_booking_prevented_total                                │
│    Count of race conditions caught                                      │
│                                                                         │
│  Availability Metrics                                                   │
│  ────────────────────                                                   │
│  calendly_availability_checks_total                                     │
│    Labels: cache_hit (true/false)                                       │
│                                                                         │
│  calendly_availability_calculation_duration_seconds                     │
│    Buckets: 0.05, 0.1, 0.2, 0.5, 1                                      │
│                                                                         │
│  Calendar Sync Metrics                                                  │
│  ─────────────────────                                                  │
│  calendly_calendar_sync_lag_seconds                                     │
│    Labels: provider (google/outlook)                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Alert Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Booking p95 latency | > 500ms | > 2s | Check database locks |
| Double booking prevented | Any occurrence | - | Investigate race condition |
| Availability cache hit rate | < 70% | < 50% | Increase TTL or pre-warm |
| Calendar sync lag | > 30 min | > 1 hour | Check API rate limits |
| Notification queue depth | > 100 | > 500 | Scale workers |

---

## Summary

"To summarize the backend architecture for Calendly:

1. **Double Booking Prevention**: Five-layer approach with idempotency, distributed locks, row-level locking, conflict queries, and unique partial index
2. **Availability Calculation**: Merge availability rules, bookings, and calendar events with smart caching (5-min TTL)
3. **Calendar Integration**: OAuth token management with automatic refresh, hybrid sync (webhooks + polling fallback)
4. **Notification System**: Async queue-based processing with scheduled reminders and retry logic
5. **Scaling**: Table partitioning by month, read replicas for availability queries, aggressive caching

The key architectural decision is prioritizing consistency over availability - we would rather fail a booking attempt than create a double booking. The multi-layer locking strategy ensures this guarantee while maintaining reasonable latency."
