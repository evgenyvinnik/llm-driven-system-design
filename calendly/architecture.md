# Calendly - Meeting Scheduling Platform - Architecture Design

## System Overview

A meeting scheduling platform that allows users to share their availability and let others book meetings without back-and-forth email coordination.

## Requirements

### Functional Requirements

1. **Availability Management**
   - Users can define their working hours and availability
   - Support for multiple meeting types (1-on-1, group meetings, round-robin)
   - Support for buffer time between meetings
   - Recurring availability patterns (weekly schedules)

2. **Meeting Booking**
   - Invitees can view available time slots
   - Real-time availability checking
   - Instant booking confirmation
   - Conflict prevention

3. **Calendar Integration**
   - Sync with Google Calendar, Outlook, iCal
   - Check calendar for existing events
   - Create calendar events on booking
   - Two-way sync for updates/cancellations

4. **Time Zone Handling**
   - Automatic time zone detection
   - Display times in invitee's local time zone
   - Support for users in different time zones

5. **Notifications**
   - Email confirmations
   - Email reminders
   - Cancellation/rescheduling notifications
   - SMS notifications (optional)

6. **Booking Management**
   - Reschedule meetings
   - Cancel meetings
   - Add to calendar options
   - Custom booking questions

### Non-Functional Requirements

- **Low Latency**: Availability checks should be < 200ms
- **High Availability**: 99.9% uptime for booking system
- **Consistency**: No double-bookings (strong consistency required)
- **Scalability**: Handle millions of users with varying booking frequencies
- **Security**: Secure calendar access tokens, prevent unauthorized access

## Capacity Estimation

*To be calculated based on expected scale:*

### Traffic Estimates
- **Daily Active Users (DAU)**: 1M users
- **Booking rate**: Average 3 bookings per user per week
- **Availability checks**: ~100 checks per booking (users browsing slots)
- **Peak hours**: 10x normal load during business hours

### Calculations
- **Bookings per day**: 1M users × 3 bookings/week ÷ 7 = ~430K bookings/day
- **Availability checks per day**: 430K × 100 = 43M checks/day
- **Peak RPS for availability**: 43M ÷ 86400 × 10 = ~5,000 RPS
- **Booking RPS**: 430K ÷ 86400 = ~5 RPS (50 RPS peak)

### Storage Requirements
- **User data**: 1M users × 10KB = 10GB
- **Meeting types**: 1M users × 5 types × 5KB = 25GB
- **Bookings**: 430K/day × 365 days × 10KB = ~1.5TB/year
- **Calendar cache**: 1M users × 100 events × 5KB = 500GB

## High-Level Architecture

```
┌─────────────┐
│   Invitee   │
└──────┬──────┘
       │
       ▼
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
       ├─────────────┬──────────────┬──────────────┐
       ▼             ▼              ▼              ▼
┌──────────┐  ┌────────────┐ ┌────────────┐ ┌──────────────┐
│Booking   │  │Availability│ │Integration │ │Notification  │
│Service   │  │Service     │ │Service     │ │Service       │
└──────────┘  └────────────┘ └────────────┘ └──────────────┘
       │             │              │              │
       ▼             ▼              ▼              ▼
┌──────────────────────────────────────────────────────┐
│              PostgreSQL (Primary Database)           │
│  - Users, Meeting Types, Bookings, Availability      │
└──────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│          Valkey/Redis (Caching Layer)                │
│  - Availability cache, Calendar event cache          │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│          Message Queue (RabbitMQ)                    │
│  - Email notifications, Calendar sync jobs           │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│       External Calendar APIs                         │
│  - Google Calendar API, Microsoft Graph API          │
└──────────────────────────────────────────────────────┘
```

### Core Components

1. **API Gateway**
   - Request routing
   - Authentication/Authorization
   - Rate limiting

2. **Booking Service**
   - Handle booking creation
   - Validate time slots
   - Prevent double-bookings (pessimistic locking)
   - Trigger notifications

3. **Availability Service**
   - Calculate available time slots
   - Merge user's working hours with calendar events
   - Apply buffer times and constraints
   - Cache computed availability

4. **Integration Service**
   - OAuth flow for calendar providers
   - Sync calendar events
   - Create/update/delete events in external calendars
   - Webhook handling for calendar changes

5. **Notification Service**
   - Send confirmation emails
   - Send reminders (scheduled jobs)
   - Handle cancellation/rescheduling notifications

## Data Model

### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CALENDLY DATABASE SCHEMA                               │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐
│        users         │
├──────────────────────┤
│ PK id (UUID)         │
│    email (UNIQUE)    │
│    password_hash     │
│    name              │
│    time_zone         │
│    role              │
│    created_at        │
│    updated_at        │
└──────────┬───────────┘
           │
           │ 1:N (CASCADE DELETE)
           │
     ┌─────┴─────┬─────────────────┐
     │           │                 │
     ▼           ▼                 ▼
┌────────────┐ ┌───────────────┐ ┌────────────────┐
│ meeting_   │ │ availability_ │ │   bookings     │
│   types    │ │    rules      │ │  (as host)     │
├────────────┤ ├───────────────┤ ├────────────────┤
│ PK id      │ │ PK id         │ │ PK id          │
│ FK user_id │ │ FK user_id    │ │ FK meeting_    │
│    name    │ │    day_of_week│ │    type_id     │
│    slug    │ │    start_time │ │ FK host_user_id│
│    desc    │ │    end_time   │ │    invitee_    │
│    duration│ │    is_active  │ │    name/email  │
│    buffer_*│ │    created_at │ │    start_time  │
│    max_    │ └───────────────┘ │    end_time    │
│    bookings│                   │    status      │
│    color   │                   │    version     │
│    is_     │                   │    idempotency_│
│    active  │                   │    key         │
│    created_│                   │    notes       │
│    updated_│                   │    created_at  │
└─────┬──────┘                   │    updated_at  │
      │                          └───────┬────────┘
      │ 1:N (CASCADE DELETE)             │
      │                                  │ 1:N (CASCADE DELETE)
      └──────────────────────────────────┤
                                         ▼
                               ┌──────────────────────┐
                               │ email_notifications  │
                               ├──────────────────────┤
                               │ PK id                │
                               │ FK booking_id        │
                               │    recipient_email   │
                               │    notification_type │
                               │    subject           │
                               │    body              │
                               │    sent_at           │
                               │    status            │
                               └──────────────────────┘

┌──────────────────────┐     ┌──────────────────────┐
│  bookings_archive    │     │      sessions        │
├──────────────────────┤     ├──────────────────────┤
│ PK id                │     │ PK sid               │
│    meeting_type_id   │     │    sess (JSON)       │
│    host_user_id      │     │    expire            │
│    (same as bookings)│     └──────────────────────┘
│    archived_at       │
│    idempotency_key   │     (Standalone table for
└──────────────────────┘      express-session fallback)

(Archive table intentionally
 has NO foreign keys to allow
 parent record deletion)
```

### Complete Database Schema

All times are stored in UTC. The schema is consolidated from `init.sql` and migrations `001_add_bookings_archive.sql` and `002_add_idempotency_key.sql`.

---

#### **users** - User Accounts

Stores all user accounts including meeting hosts and administrators.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique user identifier |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL | User's email for login and notifications |
| `password_hash` | VARCHAR(255) | NOT NULL | bcrypt-hashed password |
| `name` | VARCHAR(255) | NOT NULL | Display name |
| `time_zone` | VARCHAR(50) | NOT NULL, DEFAULT 'UTC' | IANA time zone (e.g., 'America/New_York') |
| `role` | VARCHAR(20) | NOT NULL, DEFAULT 'user' | Either 'user' or 'admin' |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Account creation timestamp |
| `updated_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Last modification timestamp |

**Design Rationale:**
- `time_zone` stored as IANA identifier for accurate DST handling
- `role` kept simple (user/admin) to avoid over-engineering; expand to RBAC if needed
- `password_hash` uses bcrypt with cost factor 10 for security/performance balance

---

#### **meeting_types** - Meeting Templates

Defines different meeting templates a user can offer to invitees.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique meeting type identifier |
| `user_id` | UUID | NOT NULL, FK -> users(id) ON DELETE CASCADE | Owner of this meeting type |
| `name` | VARCHAR(255) | NOT NULL | Display name (e.g., "30 Minute Consultation") |
| `slug` | VARCHAR(255) | NOT NULL | URL-friendly identifier (e.g., "30-min-call") |
| `description` | TEXT | | Long-form description shown to invitees |
| `duration_minutes` | INTEGER | NOT NULL, DEFAULT 30 | Meeting length in minutes |
| `buffer_before_minutes` | INTEGER | NOT NULL, DEFAULT 0 | Prep time before meeting |
| `buffer_after_minutes` | INTEGER | NOT NULL, DEFAULT 0 | Buffer time after meeting |
| `max_bookings_per_day` | INTEGER | | Optional daily booking limit |
| `color` | VARCHAR(7) | DEFAULT '#3B82F6' | Hex color for UI display |
| `is_active` | BOOLEAN | DEFAULT true | Whether this type accepts new bookings |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Creation timestamp |
| `updated_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Last modification timestamp |

**Constraints:**
- `UNIQUE(user_id, slug)` - Ensures unique URLs per user

**Design Rationale:**
- `slug` enables clean booking URLs: `/user/demo/30-min-call`
- Buffer times prevent back-to-back meetings and allow for travel/prep
- `max_bookings_per_day` prevents host burnout
- `ON DELETE CASCADE` ensures meeting types are deleted when user is deleted

---

#### **availability_rules** - Weekly Schedule

Defines recurring weekly availability windows for each user.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique rule identifier |
| `user_id` | UUID | NOT NULL, FK -> users(id) ON DELETE CASCADE | User who owns this rule |
| `day_of_week` | INTEGER | NOT NULL, CHECK (0-6) | 0=Sunday through 6=Saturday |
| `start_time` | TIME | NOT NULL | Start of availability window |
| `end_time` | TIME | NOT NULL | End of availability window |
| `is_active` | BOOLEAN | DEFAULT true | Whether this rule is currently active |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Creation timestamp |

**Constraints:**
- `CHECK (day_of_week >= 0 AND day_of_week <= 6)` - Valid day values
- `CHECK (end_time > start_time)` - End must be after start

**Indexes:**
- `idx_availability_user_day(user_id, day_of_week, is_active)` - Fast lookup by user and day

**Design Rationale:**
- TIME type (not TIMESTAMP) because these are recurring patterns, not specific dates
- Multiple rules per day supported (e.g., 9-12 and 14-17 with lunch break)
- `is_active` allows temporarily disabling rules without deletion
- `ON DELETE CASCADE` cleans up rules when user is deleted

---

#### **bookings** - Active Meeting Bookings

Stores confirmed and active meeting bookings between hosts and invitees.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique booking identifier |
| `meeting_type_id` | UUID | NOT NULL, FK -> meeting_types(id) ON DELETE CASCADE | Which meeting type was booked |
| `host_user_id` | UUID | NOT NULL, FK -> users(id) ON DELETE CASCADE | The meeting host |
| `invitee_name` | VARCHAR(255) | NOT NULL | Invitee's display name |
| `invitee_email` | VARCHAR(255) | NOT NULL | Invitee's email for notifications |
| `start_time` | TIMESTAMP WITH TIME ZONE | NOT NULL | Meeting start (stored in UTC) |
| `end_time` | TIMESTAMP WITH TIME ZONE | NOT NULL | Meeting end (stored in UTC) |
| `invitee_timezone` | VARCHAR(50) | NOT NULL | Invitee's time zone for display |
| `status` | VARCHAR(20) | NOT NULL, DEFAULT 'confirmed' | One of: confirmed, cancelled, rescheduled |
| `cancellation_reason` | TEXT | | Reason if cancelled/rescheduled |
| `notes` | TEXT | | Optional notes from invitee |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Booking creation timestamp |
| `updated_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | Last modification timestamp |
| `version` | INTEGER | DEFAULT 1 | Optimistic locking version number |
| `idempotency_key` | VARCHAR(255) | | Client-provided or auto-generated key |

**Constraints:**
- `CHECK (end_time > start_time)` - Valid time range

**Indexes:**
- `idx_bookings_no_double(host_user_id, start_time) WHERE status = 'confirmed'` - **UNIQUE partial index** prevents double-booking
- `idx_bookings_host_time(host_user_id, start_time, end_time)` - Fast availability queries
- `idx_bookings_status(status)` - Filter by status
- `idx_bookings_meeting_type(meeting_type_id)` - Join optimization
- `idx_bookings_idempotency_key(idempotency_key) WHERE idempotency_key IS NOT NULL` - **UNIQUE partial index** for duplicate prevention

**Design Rationale:**
- `host_user_id` duplicates data from meeting_type but enables faster queries and survives meeting type deletion
- `invitee_timezone` stored for correct email/calendar display even if invitee's location changes
- `version` field enables optimistic locking to detect concurrent modifications
- `idempotency_key` prevents duplicate bookings from network retries (see Implementation Notes)
- Partial unique index on `(host_user_id, start_time)` only for confirmed status allows cancelled bookings to exist at same time
- `ON DELETE CASCADE` on both FKs means deleting a user or meeting type removes all related bookings

---

#### **bookings_archive** - Historical Booking Archive

Stores completed/cancelled bookings moved from the active table after 90 days.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PRIMARY KEY | Original booking ID (preserved) |
| `meeting_type_id` | UUID | NOT NULL | Original meeting type (no FK) |
| `host_user_id` | UUID | NOT NULL | Original host user (no FK) |
| `invitee_name` | VARCHAR(255) | NOT NULL | Invitee's name |
| `invitee_email` | VARCHAR(255) | NOT NULL | Invitee's email |
| `start_time` | TIMESTAMP WITH TIME ZONE | NOT NULL | Meeting start time |
| `end_time` | TIMESTAMP WITH TIME ZONE | NOT NULL | Meeting end time |
| `invitee_timezone` | VARCHAR(50) | NOT NULL | Invitee's time zone |
| `status` | VARCHAR(20) | NOT NULL | Final status at archival |
| `cancellation_reason` | TEXT | | Cancellation reason if applicable |
| `notes` | TEXT | | Original notes |
| `created_at` | TIMESTAMP WITH TIME ZONE | | Original creation time |
| `updated_at` | TIMESTAMP WITH TIME ZONE | | Last update before archival |
| `version` | INTEGER | DEFAULT 1 | Final version number |
| `idempotency_key` | VARCHAR(255) | | Original idempotency key |
| `archived_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | When booking was archived |

**Indexes:**
- `idx_bookings_archive_host_time(host_user_id, start_time)` - Query archived bookings by host
- `idx_bookings_archive_archived_at(archived_at)` - Cleanup queries

**Design Rationale:**
- **No foreign keys** - Allows archival to survive parent record deletion
- Same structure as `bookings` plus `archived_at` for easy data movement
- Keeps active `bookings` table small for fast queries
- Supports legal/audit requirements (2-year retention)
- Can restore bookings if needed for support cases

---

#### **email_notifications** - Email Audit Log

Tracks all email notifications sent for booking events.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique notification ID |
| `booking_id` | UUID | FK -> bookings(id) ON DELETE CASCADE | Related booking |
| `recipient_email` | VARCHAR(255) | NOT NULL | Email recipient address |
| `notification_type` | VARCHAR(50) | NOT NULL | One of: confirmation, reminder, cancellation, reschedule |
| `subject` | VARCHAR(500) | NOT NULL | Email subject line |
| `body` | TEXT | NOT NULL | Full email body content |
| `sent_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | When email was sent |
| `status` | VARCHAR(20) | NOT NULL, DEFAULT 'sent' | Either 'sent' or 'failed' |

**Indexes:**
- `idx_email_booking(booking_id)` - Find all emails for a booking

**Design Rationale:**
- Audit trail for all communications
- `ON DELETE CASCADE` removes notification history when booking is deleted
- `status` field tracks delivery success for retry/debugging

---

#### **sessions** - Express Session Fallback

Stores HTTP sessions when Redis is unavailable (fallback only).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `sid` | VARCHAR(255) | PRIMARY KEY | Session ID |
| `sess` | JSON | NOT NULL | Serialized session data |
| `expire` | TIMESTAMP WITH TIME ZONE | NOT NULL | Session expiration time |

**Indexes:**
- `idx_sessions_expire(expire)` - Fast cleanup of expired sessions

**Design Rationale:**
- Fallback for development when Redis/Valkey is not running
- Production should use Redis for session storage

---

### Foreign Key Relationships and Cascade Behaviors

| Parent Table | Child Table | FK Column | Cascade Behavior | Rationale |
|--------------|-------------|-----------|------------------|-----------|
| users | meeting_types | user_id | ON DELETE CASCADE | When a user is deleted, their meeting types become invalid |
| users | availability_rules | user_id | ON DELETE CASCADE | User's schedule belongs only to them |
| users | bookings | host_user_id | ON DELETE CASCADE | If host leaves, their bookings are cancelled |
| meeting_types | bookings | meeting_type_id | ON DELETE CASCADE | If meeting type is removed, related bookings are removed |
| bookings | email_notifications | booking_id | ON DELETE CASCADE | Email history is only relevant with booking context |

**Why CASCADE DELETE everywhere?**
- Simplifies cleanup: No orphaned records
- Atomic operations: Deleting a user removes all their data in one transaction
- GDPR compliance: Easy "right to erasure" implementation

**Why no CASCADE on bookings_archive?**
- Archive serves as historical record
- Must survive deletion of users/meeting types
- Data can exist without active parent records

---

### Data Flow for Key Operations

#### 1. Creating a Booking

```
Client                  API Server              Database                Redis
   │                        │                       │                     │
   │──POST /api/bookings───▶│                       │                     │
   │   (idempotency_key)    │                       │                     │
   │                        │──Check idempotency───▶│                     │
   │                        │   key in Redis        │                     │
   │                        │◀─────────────────────▶│                     │
   │                        │                       │                     │
   │                        │──BEGIN TRANSACTION───▶│                     │
   │                        │                       │                     │
   │                        │──SELECT availability_rules                  │
   │                        │   WHERE user_id = ?   │                     │
   │                        │◀─────────────────────▶│                     │
   │                        │                       │                     │
   │                        │──SELECT bookings      │                     │
   │                        │   WHERE host_user_id  │                     │
   │                        │   AND status='confirmed'                    │
   │                        │   FOR UPDATE          │  (Row-level lock)   │
   │                        │◀─────────────────────▶│                     │
   │                        │                       │                     │
   │                        │──INSERT INTO bookings─▶│                     │
   │                        │   (uses partial unique index)               │
   │                        │◀─────────────────────▶│                     │
   │                        │                       │                     │
   │                        │──COMMIT──────────────▶│                     │
   │                        │                       │                     │
   │                        │──Cache idempotency───▶│                     │
   │                        │   result (1 hour TTL) │                     │
   │                        │◀─────────────────────▶│                     │
   │                        │                       │                     │
   │                        │──Queue email notification                   │
   │                        │   (via RabbitMQ)      │                     │
   │                        │                       │                     │
   │◀─────201 Created───────│                       │                     │
```

**Double-Booking Prevention (Multi-Layer):**
1. **Optimistic**: Check available slots before attempting insert
2. **Pessimistic**: `SELECT FOR UPDATE` locks conflicting rows during transaction
3. **Database Constraint**: Partial unique index `(host_user_id, start_time) WHERE status = 'confirmed'`
4. **Idempotency**: Same request with same key returns cached result

#### 2. Checking Availability

```
Client                  API Server              Database                Valkey/Redis
   │                        │                       │                     │
   │──GET /availability────▶│                       │                     │
   │   ?meeting_type=X      │                       │                     │
   │   &date=2024-01-15     │                       │                     │
   │                        │──Check cache─────────▶│                     │
   │                        │   (availability:X:    │                     │
   │                        │    2024-01-15)        │                     │
   │                        │                       │                     │
   │                        │  (If cache miss)      │                     │
   │                        │──SELECT meeting_types▶│                     │
   │                        │   WHERE id = X        │                     │
   │                        │                       │                     │
   │                        │──SELECT availability_▶│                     │
   │                        │   rules WHERE user_id │                     │
   │                        │   AND day_of_week = ? │                     │
   │                        │   (uses idx_availability_user_day)          │
   │                        │                       │                     │
   │                        │──SELECT bookings─────▶│                     │
   │                        │   WHERE host_user_id  │                     │
   │                        │   AND start_time      │                     │
   │                        │   BETWEEN ? AND ?     │                     │
   │                        │   (uses idx_bookings_host_time)             │
   │                        │                       │                     │
   │                        │  [Calculate slots]    │                     │
   │                        │  - Merge busy periods │                     │
   │                        │  - Apply buffers      │                     │
   │                        │  - Generate slots     │                     │
   │                        │                       │                     │
   │                        │──Cache result────────▶│                     │
   │                        │   (5 min TTL)         │                     │
   │                        │                       │                     │
   │◀─────Available slots───│                       │                     │
```

#### 3. Archiving Old Bookings

```
Cron Job (daily)        Database
   │                        │
   │──BEGIN TRANSACTION────▶│
   │                        │
   │──INSERT INTO bookings_▶│
   │   archive SELECT *     │
   │   FROM bookings        │
   │   WHERE status IN      │
   │   ('completed',        │
   │    'cancelled')        │
   │   AND end_time <       │
   │   NOW() - 90 days      │
   │                        │
   │──DELETE FROM bookings─▶│
   │   WHERE (same filter)  │
   │                        │
   │──COMMIT───────────────▶│
   │                        │
   │◀─────Rows affected─────│
```

---

### Indexes Summary

| Index Name | Table | Columns | Type | Purpose |
|------------|-------|---------|------|---------|
| `idx_availability_user_day` | availability_rules | (user_id, day_of_week, is_active) | B-tree | Fast availability lookup by user and day |
| `idx_bookings_no_double` | bookings | (host_user_id, start_time) WHERE status='confirmed' | Unique Partial | Prevent double-booking |
| `idx_bookings_host_time` | bookings | (host_user_id, start_time, end_time) | B-tree | Range queries for availability |
| `idx_bookings_status` | bookings | (status) | B-tree | Filter by booking status |
| `idx_bookings_meeting_type` | bookings | (meeting_type_id) | B-tree | Join with meeting_types |
| `idx_bookings_idempotency_key` | bookings | (idempotency_key) WHERE NOT NULL | Unique Partial | Duplicate request prevention |
| `idx_bookings_archive_host_time` | bookings_archive | (host_user_id, start_time) | B-tree | Historical queries |
| `idx_bookings_archive_archived_at` | bookings_archive | (archived_at) | B-tree | Cleanup/retention queries |
| `idx_email_booking` | email_notifications | (booking_id) | B-tree | Find emails by booking |
| `idx_sessions_expire` | sessions | (expire) | B-tree | Session cleanup |

---

### Storage Strategy

- **PostgreSQL**: Primary data store for all structured data
  - ACID compliance for preventing double bookings
  - Relational data (users, bookings, meeting types)
  - Use row-level locking for booking creation

- **Valkey/Redis**: Caching layer
  - Cache computed availability slots (TTL: 5 minutes)
  - Cache calendar events fetched from external APIs (TTL: 10 minutes)
  - Rate limiting counters

## API Design

### Public Booking URL Pattern (Real-World Approach)

The booking URL follows the pattern used by real scheduling platforms like Calendly:

```
/john-doe/30min-x7k2m9
```

This hybrid approach combines:
- **Human-readable prefix**: `john-doe/30min` - Clean, shareable, memorable
- **Security token suffix**: `-x7k2m9` - Prevents URL enumeration, can be rotated if leaked

**Why this pattern?**
- ✅ Balance of usability and security
- ✅ Can rotate the token part without changing the slug
- ✅ Supports multiple tokens per event (different campaigns, tracking)
- ✅ Prevents enumeration attacks (can't guess `/john-doe/15min`)
- ✅ Host can revoke specific tokens if shared inappropriately

**Token rotation use cases:**
- Link shared publicly (Twitter) → revoke, generate new
- Different marketing channels → separate tokens, track conversion
- Temporary access → expiring tokens for limited-time campaigns

### Core Endpoints

**User & Meeting Type Management**
- `POST /api/users` - Create user account
- `GET /api/users/:id` - Get user profile
- `POST /api/meeting-types` - Create meeting type
- `GET /api/meeting-types/:id` - Get meeting type details
- `PUT /api/meeting-types/:id` - Update meeting type
- `DELETE /api/meeting-types/:id` - Delete meeting type

**Public Booking APIs (Guest-Facing)**
- `GET /api/:username/:slug-:token` - Get event type details (validates all three parts)
- `GET /api/availability/:event_id?start_date=&end_date=` - Get available slots (UTC only)
- `POST /api/bookings` - Create a booking (with idempotency support)

**Availability Management (Host-Facing)**
- `POST /api/availability/rules` - Set availability rules
- `GET /api/availability/rules` - Get user's availability rules
- `GET /api/availability/slots?meeting_type_id=:id&date=:date&timezone=:tz` - Get available slots

**Booking Management**
- `POST /api/bookings` - Create a booking
- `GET /api/bookings/:id` - Get booking details
- `PUT /api/bookings/:id/reschedule` - Reschedule booking
- `DELETE /api/bookings/:id` - Cancel booking
- `GET /api/users/:id/bookings` - List user's bookings

**Calendar Integration**
- `GET /api/integrations/google/oauth` - Initiate Google OAuth
- `GET /api/integrations/google/callback` - Handle OAuth callback
- `POST /api/integrations/:id/sync` - Trigger calendar sync
- `DELETE /api/integrations/:id` - Remove calendar integration

### Availability API Response Format

The availability API returns UTC timestamps only, enabling instant timezone switching without re-fetching:

```json
{
  "slots": {
    "2025-01-15": [
      {
        "start_time": "2025-01-15T19:00:00Z",
        "end_time": "2025-01-15T19:30:00Z"
      }
    ]
  }
}
```

**Why UTC-only?**
- ✅ Client can switch timezones without re-fetching
- ✅ Simpler API contract
- ✅ One response works for all guests
- ✅ Enables effective client-side caching across timezone changes

## Key Design Decisions

### 1. Preventing Double Bookings

**Challenge**: Ensuring no two bookings overlap for the same user.

**Solution**: Multi-layered approach
1. **Database constraint**: Unique index on `(host_user_id, start_time)`
2. **Row-level locking**: Use `SELECT FOR UPDATE` when checking availability
3. **Optimistic locking**: Version field to detect concurrent modifications
4. **Transaction isolation**: `SERIALIZABLE` isolation level for booking creation

**Trade-off**: Slightly higher latency for booking creation vs. data consistency

### 2. Availability Calculation Algorithm

**Challenge**: Efficiently compute available time slots considering:
- User's availability rules (working hours)
- Existing bookings
- Calendar events from integrations
- Buffer times
- Meeting duration

**Approach**:
```
1. Fetch user's availability rules for requested date range
2. Fetch existing bookings from database
3. Fetch calendar events from cache (or external API if cache miss)
4. Merge all "busy" periods into a sorted list
5. Generate available slots from gaps between busy periods
6. Apply buffer times and constraints
7. Return slots in invitee's time zone
```

**Optimization**: Cache computed slots for 5 minutes in Valkey

### 3. Time Zone Handling

**Challenge**: Users and invitees in different time zones.

**Solution**:
- Store all times in database as UTC timestamps
- Store user's time zone preference separately
- API accepts time zone parameter for display
- Availability calculation happens in UTC, then converts for display
- Booking confirmation shows time in both host's and invitee's time zones

### 4. Calendar Sync Strategy

**Challenge**: Keep calendar events up-to-date without excessive API calls.

**Approach**:
- **Pull-based sync**: Background job syncs calendars every 10 minutes
- **Push-based sync**: Use webhooks when supported (Google Calendar push notifications)
- **On-demand sync**: Sync calendar when user requests availability
- **Caching**: Cache calendar events for 10 minutes
- **Rate limiting**: Respect calendar provider API rate limits

**Trade-off**: Slight staleness (up to 10 minutes) vs. API quota management

### 5. Notification System

**Architecture**:
- **Asynchronous**: Use RabbitMQ for email queue
- **Retry logic**: Exponential backoff for failed deliveries
- **Scheduled reminders**: Cron job checks for upcoming meetings and enqueues reminders
- **Email templates**: Precompiled templates for different notification types

## Technology Stack

Following the repository's preferred open-source stack:

- **Application Layer**: Node.js + Express + TypeScript
- **Data Layer**: PostgreSQL (primary database)
- **Caching Layer**: Valkey or Redis
- **Message Queue**: RabbitMQ
- **Email Service**: Nodemailer (SMTP)
- **Job Scheduler**: node-cron or Bull (Redis-backed)
- **Frontend**: TypeScript + Vite + Tanstack React

**External APIs**:
- Google Calendar API
- Microsoft Graph API (Outlook)

## Frontend Architecture

The frontend follows a component-based architecture using React with TypeScript. Components are organized by feature and concern for maintainability and reusability.

### Directory Structure

```
frontend/src/
├── components/              # Shared UI components
│   ├── icons/               # SVG icon components
│   │   ├── index.ts         # Barrel export for all icons
│   │   ├── ActivateIcon.tsx
│   │   ├── CalendarIcon.tsx
│   │   ├── DeactivateIcon.tsx
│   │   ├── DeleteIcon.tsx
│   │   └── EditIcon.tsx
│   ├── meeting-types/       # Meeting type feature components
│   │   ├── index.ts         # Barrel export
│   │   ├── MeetingTypeCard.tsx
│   │   ├── MeetingTypeModal.tsx
│   │   └── MeetingTypesEmptyState.tsx
│   ├── CalendarPicker.tsx   # Date selection widget
│   ├── LoadingSpinner.tsx   # Loading indicator
│   ├── Navbar.tsx           # Main navigation
│   └── TimeSlotPicker.tsx   # Time slot selection widget
├── routes/                  # Page components (Tanstack Router)
│   ├── __root.tsx           # Root layout with Navbar
│   ├── index.tsx            # Landing page
│   ├── login.tsx            # Login page
│   ├── register.tsx         # Registration page
│   ├── dashboard.tsx        # User dashboard
│   ├── meeting-types.tsx    # Meeting type management
│   ├── availability.tsx     # Availability settings
│   ├── bookings.tsx         # Booking list
│   ├── bookings.$bookingId.tsx  # Single booking detail
│   ├── book.$meetingTypeId.tsx  # Public booking page
│   └── admin.tsx            # Admin dashboard
├── services/                # API client and services
│   └── api.ts               # REST API wrapper
├── stores/                  # Zustand state stores
│   └── authStore.ts         # Authentication state
├── types/                   # TypeScript type definitions
│   └── index.ts             # Shared interfaces
└── utils/                   # Utility functions
    └── time.ts              # Time/timezone helpers
```

### Component Organization Principles

1. **Icons in Separate Directory**: All SVG icons are extracted into `components/icons/` with individual files. This keeps component code readable and enables tree-shaking.

2. **Feature-Based Grouping**: Related components are grouped in feature directories (e.g., `meeting-types/`) with barrel exports for clean imports.

3. **Small, Focused Components**: Components are kept under 200 lines. Larger components are split into sub-components (e.g., `MeetingTypeCard` contains `MeetingTypeCardHeader` and `MeetingTypeCardActions`).

4. **JSDoc Documentation**: All components and significant functions include JSDoc comments describing their purpose and parameters.

5. **Props Interfaces**: TypeScript interfaces are defined for all component props with descriptive documentation.

### Import Patterns

```typescript
// Icons - import from barrel export
import { CalendarIcon, EditIcon, DeleteIcon } from '../components/icons';

// Feature components - import from barrel export
import {
  MeetingTypeCard,
  MeetingTypeModal,
  MeetingTypesEmptyState,
} from '../components/meeting-types';

// Shared components - import directly
import { LoadingSpinner } from '../components/LoadingSpinner';
```

### State Management

- **Local State**: React's `useState` for component-specific UI state
- **Global State**: Zustand stores for shared state (authentication)
- **Server State**: Direct API calls with loading/error state management

### Routing

Uses Tanstack Router with file-based routing. Route files define:
- `beforeLoad`: Authentication guards and data prefetching
- `component`: The page component to render

---

## Guest Booking Experience

The public booking page is the primary interface for invitees to schedule meetings. This section documents the guest-facing booking flow design.

### User Flow

```
Guest clicks booking link → views event details → selects date →
selects time slot → fills form → confirms booking → receives confirmation
```

### Booking Page Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     BOOKING PAGE                             │
├─────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────┐  │
│  │      Event Header                                     │  │
│  │  - Host name, avatar                                  │  │
│  │  - Event title, duration                              │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │      Timezone Selector                                │  │
│  │  - Auto-detected: "Local time (EST)"                  │  │
│  │  - Quick options: Eastern, Pacific, Central, GMT      │  │
│  │  - Instant re-render on change (no loading spinner)   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │      Calendar Selector                                │  │
│  │  - Month navigation                                   │  │
│  │  - Date grid with availability indicators             │  │
│  │  - Pre-select next available date                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │      Time Slot List                                   │  │
│  │  - Available times for selected date                  │  │
│  │  - Displayed in guest's timezone                      │  │
│  │  - Late night/early morning warnings                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │      Booking Form (appears after slot selection)      │  │
│  │  - Name, Email (required)                             │  │
│  │  - Optional notes                                     │  │
│  │  - Confirm button                                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │      Confirmation Screen                              │  │
│  │  - Booking details in both timezones                  │  │
│  │  - Add to calendar link (Google, Outlook, iCal)       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Progressive Disclosure

The booking page uses progressive disclosure to reduce cognitive load:

1. **Step 1**: Show calendar (low commitment)
2. **Step 2**: After date selection → Show time slots
3. **Step 3**: After time selection → Show booking form
4. **Step 4**: After form submission → Show confirmation

### Client-Side Caching Strategy

Guest availability is cached with a 3-5 minute TTL to balance performance and freshness:

```typescript
const CACHE_DURATION = 3 * 60 * 1000; // 3 minutes
const availabilityCache = new Map();

async function getAvailability(eventId, startDate, endDate) {
  const cacheKey = `${eventId}-${startDate}-${endDate}`;
  const cached = availabilityCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

  const data = await api.getAvailability(eventId, startDate, endDate);
  availabilityCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

// Clear cache after booking to force fresh data
function onBookingCreated() {
  availabilityCache.clear();
}
```

**Trade-off**: 3-5 minute cache means there's a small window where a guest might see a slot as available that was just booked. This is mitigated by:
1. Pre-submit slot verification
2. Server-side 409 Conflict response with alternative slot suggestions

### Double-Booking Prevention (Client Side)

The client implements a pre-check before form submission:

```typescript
async function handleBooking(formData) {
  setIsSubmitting(true);

  try {
    // Pre-check availability (catches most conflicts early)
    const stillAvailable = await checkSlotAvailability(formData.selected_slot);

    if (!stillAvailable) {
      showError("This slot was just booked. Here are alternatives:");
      refreshAvailability();
      showAlternativeSlots();
      return;
    }

    // Server validates again (race condition could still happen)
    const booking = await createBooking(formData);
    showConfirmation(booking);

  } catch (error) {
    if (error.status === 409) {
      showError("Someone just booked this slot");
      refreshAvailability();
      showAlternativeSlots();
    }
  } finally {
    setIsSubmitting(false);
  }
}
```

### Timezone Handling (Client Side)

All times are stored and transmitted in UTC. The client handles timezone display:

```typescript
// Auto-detect guest timezone
const guestTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Display conversion
import { utcToZonedTime, format } from 'date-fns-tz';

function displayTime(utcTimestamp, guestTimezone) {
  const zonedTime = utcToZonedTime(utcTimestamp, guestTimezone);
  return format(zonedTime, 'h:mm a zzz', { timeZone: guestTimezone });
}

// Late night/early morning warning
const hour = utcToZonedTime(slotTime, guestTimezone).getHours();
if (hour < 6 || hour > 22) {
  showWarning("Note: This is outside typical working hours in your timezone");
}
```

### Mobile UX Optimization

- **Touch targets**: Min 44x44px for date/time buttons
- **Swipe gestures**: Swipe to change months
- **Vertical layout**: Stack calendar above form
- **Bottom sheet**: Booking form slides up on mobile
- **Sticky elements**: Timezone selector and confirm button stay visible

### Guest Booking Component Structure

```
frontend/src/
├── routes/
│   └── book.$meetingTypeId.tsx    # Main booking page route
├── components/
│   └── booking/                   # Guest booking components
│       ├── index.ts               # Barrel export
│       ├── EventHeader.tsx        # Host info + event details
│       ├── TimezoneSelector.tsx   # Timezone dropdown with auto-detect
│       ├── BookingCalendar.tsx    # Month calendar with availability
│       ├── TimeSlotList.tsx       # Available times for selected date
│       ├── BookingForm.tsx        # Guest info collection form
│       ├── ConfirmationScreen.tsx # Success state with calendar links
│       └── SlotUnavailable.tsx    # 409 error state with alternatives
```

### Security Considerations

1. **URL token validation**: All three parts (username, slug, token) validated together
2. **Rate limiting**: Max 20 availability checks per IP per minute
3. **Bot detection**: CAPTCHA for suspicious booking patterns
4. **Honeypot fields**: Hidden fields to catch automated submissions
5. **Email verification** (optional): Confirmation link before finalizing booking

---

## Scalability Considerations

### Database Scaling
- **Read replicas**: Offload availability queries to read replicas
- **Partitioning**: Partition bookings table by date range (monthly partitions)
- **Archiving**: Archive old bookings (> 1 year) to cold storage

### Application Scaling
- **Horizontal scaling**: Stateless API servers behind load balancer
- **Service isolation**: Separate services can scale independently
- **Caching**: Aggressive caching of availability and calendar events

### Performance Optimizations
- **Database indexing**: Indexes on frequently queried fields
- **Connection pooling**: PostgreSQL connection pool (pg-pool)
- **Query optimization**: Avoid N+1 queries, use batching
- **API rate limiting**: Prevent abuse and ensure fair usage

## Trade-offs and Alternatives

### PostgreSQL vs. NoSQL
**Decision**: PostgreSQL
**Rationale**:
- Strong consistency required for preventing double bookings
- Relational data model fits naturally
- ACID transactions critical
- Complex queries for availability calculation

**Alternative**: Could use Cassandra for bookings history, but would need additional layer for consistency

### Caching Strategy
**Decision**: Cache computed availability slots
**Trade-off**: Freshness vs. performance
**Mitigation**: Short TTL (5 minutes), invalidate on booking creation

### Calendar Sync Frequency
**Decision**: 10-minute polling + webhooks
**Trade-off**: API quota usage vs. real-time accuracy
**Mitigation**: On-demand sync when user requests availability

## Monitoring and Observability

**Metrics** (using Prometheus + Grafana):
- Booking creation latency (p50, p95, p99)
- Availability query latency
- Calendar API response times
- Double-booking prevention failures (should be zero)
- Cache hit ratio
- Queue depth for notifications

**Logging**:
- Structured logging (JSON format)
- Log all booking events (create, cancel, reschedule)
- Log calendar API errors
- Log authentication failures

**Alerts**:
- High error rates on booking creation
- Calendar API failures
- Queue backlog exceeding threshold
- Database connection pool exhaustion

## Security Considerations

1. **Authentication**:
   - JWT-based authentication
   - OAuth 2.0 for calendar integrations
   - Secure token storage (encrypted)

2. **Authorization**:
   - Users can only modify their own data
   - Invitees can only book, not modify meeting types
   - Rate limiting per user and per IP

3. **Data Protection**:
   - Encrypt calendar access tokens at rest
   - HTTPS for all API communication
   - Validate and sanitize all user inputs
   - Prevent calendar token leakage in logs

4. **Privacy**:
   - Don't expose calendar event details to invitees
   - Allow users to delete their data (GDPR compliance)
   - Anonymize booking data for analytics

## Data Lifecycle Policies

### Retention and TTL

| Data Type | Retention Period | Storage Location | Notes |
|-----------|-----------------|------------------|-------|
| Active bookings | Indefinite (until completed/cancelled) | PostgreSQL | Primary working set |
| Completed bookings | 90 days | PostgreSQL | For rescheduling reference and analytics |
| Archived bookings | 2 years | PostgreSQL archive table | Legal/audit requirements |
| Calendar event cache | 24 hours | PostgreSQL + Valkey | Refreshed on sync |
| Availability cache | 5 minutes | Valkey | Invalidated on booking |
| OAuth tokens | Until revoked | PostgreSQL (encrypted) | Rotate refresh tokens monthly |
| Notification queue messages | 7 days | RabbitMQ | Dead-letter queue for failures |
| Rate limiting counters | 1 hour sliding window | Valkey | Auto-expire with TTL |

### Archival Strategy

**Bookings Archival (Local Development)**:
```sql
-- Run monthly via cron job or manual script
-- Move completed bookings older than 90 days to archive table

CREATE TABLE bookings_archive (LIKE bookings INCLUDING ALL);

-- Archive script (run with: npm run db:archive-bookings)
INSERT INTO bookings_archive
SELECT * FROM bookings
WHERE status IN ('completed', 'cancelled')
  AND end_time < NOW() - INTERVAL '90 days';

DELETE FROM bookings
WHERE status IN ('completed', 'cancelled')
  AND end_time < NOW() - INTERVAL '90 days';
```

**Calendar Cache Cleanup**:
```sql
-- Clean up expired calendar event cache entries daily
DELETE FROM calendar_events_cache
WHERE expires_at < NOW();
```

### Backfill and Replay Procedures

**Calendar Sync Backfill**:
When calendar integration is newly connected or after extended downtime:
```bash
# Trigger full calendar sync for a user
npm run calendar:backfill -- --user-id=<uuid> --days-back=30

# Bulk backfill for all users (use sparingly due to API limits)
npm run calendar:backfill-all -- --days-back=7 --rate-limit=10
```

**Notification Replay**:
For failed notifications stored in dead-letter queue:
```bash
# View failed notifications
npm run queue:dlq-inspect -- --queue=notifications

# Replay specific notification
npm run queue:dlq-replay -- --message-id=<id>

# Replay all failed notifications from last 24 hours
npm run queue:dlq-replay-all -- --since="24 hours"
```

**Booking Data Restoration**:
```bash
# Restore archived bookings for a user (for support cases)
npm run db:restore-bookings -- --user-id=<uuid> --from-date=2024-01-01

# Verify booking integrity after restore
npm run db:verify-bookings -- --user-id=<uuid>
```

---

## Deployment and Operations

### Rollout Strategy

**Local Development Rollout (2-3 service instances)**:

1. **Blue-Green Deployment (Recommended for Learning)**:
   ```bash
   # Terminal 1: Blue instance (current production)
   PORT=3001 npm run dev:server1

   # Terminal 2: Green instance (new version)
   PORT=3002 npm run dev:server2

   # Terminal 3: Load balancer pointing to blue (port 3001)
   npm run dev:lb

   # After testing green instance manually:
   # Update load balancer config to point to green (port 3002)
   # Verify all endpoints work
   # Terminate blue instance
   ```

2. **Canary Deployment (Advanced)**:
   ```bash
   # Configure nginx to split traffic
   # 90% to stable (port 3001), 10% to canary (port 3002)
   # Monitor error rates for 15 minutes before full rollout
   ```

**Deployment Checklist**:
- [ ] Run `npm run type-check` (TypeScript validation)
- [ ] Run `npm run test` (all tests pass)
- [ ] Run `npm run lint` (no linting errors)
- [ ] Run `npm run db:migrate` (apply pending migrations)
- [ ] Verify RabbitMQ connection
- [ ] Verify Valkey/Redis connection
- [ ] Test booking creation end-to-end
- [ ] Test availability calculation
- [ ] Monitor logs for errors for 5 minutes

### Schema Migrations

**Migration Workflow**:
```bash
# Create new migration
npm run db:migrate:create -- --name=add_booking_reminder_sent

# This creates: backend/src/db/migrations/003_add_booking_reminder_sent.sql
```

**Migration File Template**:
```sql
-- Migration: 003_add_booking_reminder_sent
-- Created: 2024-01-15
-- Description: Add flag to track reminder email status

-- UP
ALTER TABLE bookings ADD COLUMN reminder_sent BOOLEAN DEFAULT false;
CREATE INDEX idx_bookings_reminder ON bookings(reminder_sent) WHERE reminder_sent = false;

-- DOWN (for rollback)
-- DROP INDEX idx_bookings_reminder;
-- ALTER TABLE bookings DROP COLUMN reminder_sent;
```

**Running Migrations**:
```bash
# Apply all pending migrations
npm run db:migrate

# Check migration status
npm run db:migrate:status

# Rollback last migration (manual - requires editing migration file)
npm run db:migrate:rollback -- --steps=1
```

**Migration Safety Rules**:
1. Never drop columns in the same release as code changes - use two-phase approach
2. Add new columns as nullable or with defaults
3. Create indexes concurrently when possible: `CREATE INDEX CONCURRENTLY`
4. Test migrations on a copy of production data before applying
5. Keep migrations small and focused (one change per migration)

### Rollback Runbooks

**Scenario 1: Bad Code Deployment (No Database Changes)**
```bash
# 1. Identify the issue in logs
npm run logs:tail

# 2. Stop the new instance
# Ctrl+C on the new server process

# 3. Restart with previous code version
git checkout <previous-commit>
npm run dev:server1

# 4. Verify functionality
curl http://localhost:3001/health
```

**Scenario 2: Failed Database Migration**
```bash
# 1. Stop all application servers to prevent data corruption

# 2. Check migration status
npm run db:migrate:status

# 3. Manual rollback (execute DOWN section of migration)
psql $DATABASE_URL -f backend/src/db/rollback/003_rollback.sql

# 4. Update migration tracking
psql $DATABASE_URL -c "DELETE FROM schema_migrations WHERE version = '003';"

# 5. Restart application with previous code version
git checkout <previous-commit>
npm run dev
```

**Scenario 3: RabbitMQ Queue Backup**
```bash
# 1. Check queue depth
npm run queue:status

# 2. Pause consumers (let messages accumulate)
npm run queue:pause -- --queue=notifications

# 3. Investigate and fix the issue

# 4. Resume consumers
npm run queue:resume -- --queue=notifications

# 5. Monitor queue draining
watch 'npm run queue:status'
```

**Scenario 4: Cache Corruption (Valkey/Redis)**
```bash
# 1. Flush specific cache prefix
npm run cache:flush -- --prefix=availability:*

# 2. Or flush all caches (nuclear option)
npm run cache:flush-all

# 3. Application will rebuild cache on next request
# Monitor cache hit rates
```

---

## Capacity and Cost Guardrails

### Alert Thresholds

**RabbitMQ Queue Monitoring**:
| Queue | Warning Threshold | Critical Threshold | Action |
|-------|------------------|-------------------|--------|
| notifications | 100 messages | 500 messages | Scale consumers or check email service |
| calendar-sync | 50 messages | 200 messages | Check calendar API rate limits |
| dead-letter | 10 messages | 50 messages | Investigate failed messages |

**Prometheus Alert Rules** (for local Grafana setup):
```yaml
# prometheus/alerts.yml
groups:
  - name: calendly_alerts
    rules:
      - alert: QueueLagHigh
        expr: rabbitmq_queue_messages{queue="notifications"} > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Notification queue lag exceeds 100 messages"

      - alert: QueueLagCritical
        expr: rabbitmq_queue_messages{queue="notifications"} > 500
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Notification queue lag critical - check email service"

      - alert: CacheHitRateLow
        expr: rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m])) < 0.7
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 70% - review cache strategy"

      - alert: BookingLatencyHigh
        expr: histogram_quantile(0.95, rate(booking_create_duration_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Booking creation p95 latency exceeds 500ms"
```

### Storage Growth Monitoring

**PostgreSQL Table Sizes** (check weekly):
```sql
-- Run to monitor table growth
SELECT
  schemaname || '.' || tablename AS table_name,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
  pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS table_size,
  pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) AS index_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;
```

**Storage Thresholds** (Local Development):
| Resource | Warning | Critical | Action |
|----------|---------|----------|--------|
| PostgreSQL total | 5 GB | 10 GB | Run archival scripts |
| bookings table | 2 GB | 5 GB | Archive old bookings |
| calendar_events_cache | 500 MB | 1 GB | Reduce cache TTL or clean up |
| Valkey memory | 256 MB | 512 MB | Review cache eviction policy |
| RabbitMQ disk | 1 GB | 2 GB | Purge old messages |

### Cache Hit Rate Targets

| Cache Type | Target Hit Rate | Minimum Acceptable | Improvement Actions |
|------------|-----------------|-------------------|---------------------|
| Availability slots | 80% | 70% | Increase TTL to 10 min, pre-warm popular users |
| Calendar events | 85% | 75% | Batch calendar fetches, use webhook updates |
| User profiles | 95% | 90% | Increase TTL, cache is stable data |
| Meeting types | 95% | 90% | Invalidate only on explicit update |

**Cache Monitoring Script**:
```bash
# Add to package.json scripts
# "cache:stats": "node scripts/cache-stats.js"

# scripts/cache-stats.js outputs:
# - Total keys by prefix
# - Memory usage
# - Hit/miss rates (from application metrics)
# - TTL distribution
```

### Cost Optimization (Local Development Context)

**Resource Limits for Docker Compose**:
```yaml
# docker-compose.yml resource limits
services:
  postgres:
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M

  valkey:
    deploy:
      resources:
        limits:
          memory: 128M

  rabbitmq:
    deploy:
      resources:
        limits:
          memory: 256M
```

**Development vs. "Production-like" Configuration**:
| Setting | Development | Production-like |
|---------|-------------|-----------------|
| PostgreSQL connections | 5 | 20 |
| Valkey max memory | 64 MB | 256 MB |
| RabbitMQ prefetch | 1 | 10 |
| Calendar sync interval | 30 min | 10 min |
| Availability cache TTL | 1 min | 5 min |
| Log level | debug | info |

---

## Future Optimizations

1. **Intelligent Availability Prediction**
   - Use ML to predict user's preferred meeting times
   - Suggest optimal meeting times based on historical data

2. **Group Meeting Optimization**
   - Find common availability across multiple participants
   - Round-robin assignment across team members

3. **Advanced Scheduling Rules**
   - "Office hours" with first-come-first-served booking
   - Conditional availability (only if previous meeting type booked)
   - Dynamic pricing or prioritization

4. **Webhook Support**
   - Allow external systems to receive booking notifications
   - Enable custom integrations

5. **Mobile Apps**
   - Native iOS/Android apps for on-the-go scheduling

---

## Implementation Notes

This section documents the reasoning behind key implementation decisions in the codebase.

### Why Idempotency Prevents Double-Bookings

**The Problem:**
When a client submits a booking request, network issues or timeouts may cause them to retry the same request. Without idempotency handling, this can result in duplicate bookings:

1. First request succeeds and creates booking A
2. Client doesn't receive response (network timeout)
3. Client retries with identical data
4. Second request creates duplicate booking B
5. Host now has two overlapping meetings

**The Solution:**
The booking creation endpoint (`POST /api/bookings`) implements idempotency at two levels:

1. **Client-Provided Keys:** Clients can include an `X-Idempotency-Key` header. The system stores the result in Redis with this key. Subsequent requests with the same key return the cached result.

2. **Automatic Key Generation:** Even without a header, the system generates a deterministic key from `meeting_type_id + start_time + invitee_email`. This prevents accidental duplicates when the same invitee books the same slot.

**Implementation Details:**
- Keys are stored in Redis with a 1-hour TTL (`IDEMPOTENCY_CONFIG.KEY_TTL_SECONDS`)
- A distributed lock prevents race conditions during concurrent retries
- The idempotency key is also stored in the database for audit purposes

**Files:**
- `/backend/src/shared/idempotency.ts` - Idempotency service
- `/backend/src/services/bookingService.ts` - Integration in `createBooking()`
- `/backend/src/routes/bookings.ts` - Header extraction

### Why Meeting Archival Balances History vs Storage Costs

**The Problem:**
Scheduling systems accumulate booking data rapidly. A system with 1M users averaging 3 bookings/week generates ~157M bookings/year. Without data lifecycle management:
- Database tables grow unbounded, slowing queries
- Index maintenance becomes expensive
- Backup and restore times increase
- Storage costs escalate

**The Solution:**
A tiered retention strategy that balances operational needs with cost:

| Data State | Location | Retention | Purpose |
|------------|----------|-----------|---------|
| Active bookings | `bookings` table | Indefinite | Fast queries for scheduling |
| Completed (recent) | `bookings` table | 90 days | Rescheduling reference, analytics |
| Archived | `bookings_archive` table | 2 years | Legal/audit compliance |
| Expired | Deleted | - | Free storage |

**Why These Retention Periods?**
- **90 days in active table:** Covers most rescheduling scenarios and monthly reporting needs while keeping the working set small enough for fast queries.
- **2 years in archive:** Meets typical legal requirements for business records and provides sufficient history for analytics.

**Implementation Details:**
- Archival is triggered by `npm run db:archive-bookings` (run as a cron job)
- The `archived_at` timestamp tracks when data was moved
- Archive table has the same schema plus `archived_at` column
- Restoration is possible via `archivalService.restoreArchivedBookings()`

**Files:**
- `/backend/src/services/archivalService.ts` - Archival logic
- `/backend/src/shared/config.ts` - Retention configuration (`RETENTION_CONFIG`)
- `/backend/src/db/migrations/001_add_bookings_archive.sql` - Archive table schema

### Why Metrics Enable Availability Optimization

**The Problem:**
Availability calculation is the hottest path in a scheduling system (100 availability checks per booking). Without visibility into this operation:
- You can't identify performance bottlenecks
- Cache effectiveness is unknown
- You can't proactively optimize before users complain

**The Solution:**
Prometheus metrics at `/metrics` provide real-time observability:

**Booking Metrics:**
- `calendly_booking_operations_total{operation, status}` - Count of create/cancel/reschedule operations
- `calendly_booking_creation_duration_seconds{status}` - Latency histogram with p50/p95/p99
- `calendly_double_booking_prevented_total` - Should remain at zero in normal operation

**Availability Metrics:**
- `calendly_availability_checks_total{cache_hit}` - Cache effectiveness tracking
- `calendly_availability_calculation_duration_seconds{cache_hit}` - Calculation time by cache status

**Cache Metrics:**
- `calendly_cache_operations_total{operation, cache_type}` - Hit/miss/set/delete counts
- Target: 80% cache hit rate (minimum 70%)

**How This Enables Optimization:**
1. **Low cache hit rate?** Increase TTL or pre-warm cache for popular users
2. **High calculation latency?** Add indexes or simplify availability rules
3. **Many double-booking preventions?** Potential race condition in frontend
4. **Queue lag growing?** Scale notification workers

**Alert Thresholds:**
Configured in `ALERT_THRESHOLDS` in `/backend/src/shared/config.ts`:
- Booking p95 latency warning: 500ms
- Cache hit rate minimum: 70%
- Queue depth warnings at 100/500 messages

**Files:**
- `/backend/src/shared/metrics.ts` - Prometheus metric definitions
- `/backend/src/index.ts` - `/metrics` endpoint
- `/backend/src/shared/config.ts` - Alert thresholds

### Why Health Checks Enable Calendar Sync Reliability

**The Problem:**
External calendar APIs (Google, Outlook) are third-party dependencies. If they become unavailable:
- New bookings might conflict with external events
- Calendar events might not be created
- Users lose trust in the system

**The Solution:**
Multi-level health checks that detect and communicate failures:

**Health Check Endpoints:**
| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /health` | Load balancer check | Quick database + Redis ping |
| `GET /health/detailed` | Debugging | Component status with latencies |
| `GET /health/live` | K8s liveness | Process is running |
| `GET /health/ready` | K8s readiness | Ready to accept traffic |

**Health Status Levels:**
- `healthy` - All systems operational
- `degraded` - Some issues but functional (e.g., elevated latency)
- `unhealthy` - Critical failure, should not receive traffic

**Calendar Sync Reliability:**
The health check system supports calendar sync reliability by:
1. **Detecting Redis failures** - If Redis is down, calendar cache is stale
2. **Monitoring database connectivity** - Calendar events are persisted here
3. **Tracking sync lag** - `calendly_calendar_sync_lag_seconds` metric
4. **Alert thresholds** - Warning at 30 min lag, critical at 1 hour

**Graceful Degradation:**
When calendar sync is unavailable:
- Availability calculation uses cached data
- Booking still succeeds (with warning)
- Calendar event creation is queued for retry
- User is notified of potential conflicts

**Files:**
- `/backend/src/shared/health.ts` - Health check logic
- `/backend/src/index.ts` - Health endpoints
- `/backend/src/shared/config.ts` - `ALERT_THRESHOLDS.CALENDAR_SYNC`

---

*This architecture is designed for educational purposes to demonstrate key concepts in building a scheduling platform. Production systems would require additional considerations around disaster recovery, multi-region deployment, and advanced security measures.*
