# Calendly (Meeting Scheduling Platform) - System Design Interview Answer

## Introduction

"Today I'll design a meeting scheduling platform like Calendly. The core problem is allowing users to share their availability and let others book meetings without the back-and-forth of email. This involves interesting challenges around calendar integration, time zones, and most critically - preventing double bookings. Let me walk through my approach."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the core functionality:

1. **Availability Management**: Users define their working hours and availability patterns
2. **Meeting Types**: Different meeting durations (15min, 30min, 60min) with buffer times
3. **Booking Flow**: Invitees see available slots and book instantly
4. **Calendar Integration**: Sync with Google Calendar, Outlook to check/block time
5. **Notifications**: Email confirmations, reminders, cancellation notices
6. **Time Zone Handling**: Display times correctly for users in different time zones

Should I also include group scheduling or team round-robin assignments?"

### Non-Functional Requirements

"For a scheduling platform:

- **Consistency**: Absolutely no double bookings - this is critical
- **Latency**: Availability checks should be fast (<200ms)
- **Availability**: 99.9% uptime - broken booking links hurt users
- **Scale**: 1 million users, 400K+ bookings per day
- **Calendar API Limits**: Must respect external API rate limits"

---

## Step 2: Scale Estimation

"Let me work through the numbers:

**Users & Bookings:**
- 1M active users
- Average 3 bookings per user per week
- Daily bookings: 1M * 3 / 7 = ~430K bookings/day
- Booking RPS: 430K / 86400 = ~5 RPS (50 RPS peak)

**Availability Checks:**
- Users browse ~100 slots before booking
- Availability check RPS: 430K * 100 / 86400 = ~500 RPS
- Peak (business hours): ~5,000 RPS

**Storage:**
- User data: 1M * 10KB = 10 GB
- Meeting types: 1M * 5 types * 5KB = 25 GB
- Bookings: 430K/day * 365 * 10KB = 1.5 TB/year
- Calendar cache: 1M * 100 events * 5KB = 500 GB

The write load is low, but availability calculations are read-heavy and compute-intensive."

---

## Step 3: High-Level Architecture

```
┌─────────────┐          ┌─────────────┐
│   Invitee   │          │    Host     │
│  (Browser)  │          │  (Browser)  │
└──────┬──────┘          └──────┬──────┘
       │                        │
       ▼                        ▼
┌─────────────────────────────────────────┐
│         Load Balancer (nginx)           │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│      API Gateway / Application Layer    │
│          (Node.js + Express)            │
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
│PostgreSQL│  │   Redis    │  │  RabbitMQ  │
│(Primary) │  │  (Cache)   │  │  (Queue)   │
└──────────┘  └────────────┘  └────────────┘
                                     │
                                     ▼
                          ┌────────────────────┐
                          │ External Calendar  │
                          │ APIs (Google, MS)  │
                          └────────────────────┘
```

---

## Step 4: Core Service Design

### Booking Service

"This is the critical path - where double-booking prevention happens.

**Booking Flow:**
```
1. Invitee selects time slot
2. Booking Service validates slot is still available
3. Acquires lock on host's calendar for that time
4. Creates booking record
5. Creates external calendar event
6. Releases lock
7. Triggers confirmation emails
```

**Preventing Double Bookings (The Hard Part):**

I'd use a multi-layered approach:

**Layer 1: Database Constraints**
```sql
CREATE UNIQUE INDEX idx_no_overlap ON bookings
USING GIST (host_user_id, tsrange(start_time, end_time));
```

This uses PostgreSQL's exclusion constraints to prevent overlapping time ranges.

**Layer 2: Row-Level Locking**
```sql
BEGIN;
-- Lock the host's row to serialize booking attempts
SELECT * FROM users WHERE id = $host_id FOR UPDATE;

-- Check for conflicts
SELECT COUNT(*) FROM bookings
WHERE host_user_id = $host_id
  AND start_time < $end_time
  AND end_time > $start_time;

-- If no conflicts, insert
INSERT INTO bookings (...) VALUES (...);
COMMIT;
```

**Layer 3: Optimistic Locking**
```sql
UPDATE bookings
SET status = 'confirmed', version = version + 1
WHERE id = $booking_id AND version = $expected_version;
-- If 0 rows affected, concurrent modification occurred
```

**Why all three layers?**
- Constraints: Last line of defense, catches bugs
- Row locking: Prevents race conditions during booking creation
- Optimistic locking: Handles concurrent modifications to existing bookings"

### Availability Service

"This calculates available time slots by merging multiple data sources.

**Algorithm:**
```python
def get_available_slots(host_id, date, meeting_duration):
    # 1. Get host's availability rules (working hours)
    rules = get_availability_rules(host_id, date.weekday())

    # 2. Get existing bookings (from our database)
    bookings = get_bookings(host_id, date)

    # 3. Get external calendar events (from cache or API)
    calendar_events = get_calendar_events(host_id, date)

    # 4. Merge all busy periods
    busy_periods = merge_periods(bookings + calendar_events)

    # 5. Find gaps that fit meeting duration + buffer
    available_slots = []
    for rule in rules:
        slots = find_available_in_range(
            rule.start_time, rule.end_time,
            busy_periods, meeting_duration
        )
        available_slots.extend(slots)

    return available_slots
```

**Period Merging Algorithm:**
```python
def merge_periods(periods):
    # Sort by start time
    sorted_periods = sorted(periods, key=lambda p: p.start)

    merged = []
    for period in sorted_periods:
        if merged and period.start <= merged[-1].end:
            # Overlapping, extend the end
            merged[-1].end = max(merged[-1].end, period.end)
        else:
            merged.append(period)

    return merged
```

**Caching Strategy:**
- Cache computed availability for 5 minutes
- Cache key: `availability:{host_id}:{date}:{meeting_type_id}`
- Invalidate on: new booking, booking cancellation, calendar sync"

### Integration Service

"Handles OAuth flows and calendar synchronization.

**Sync Strategy (Hybrid Push/Pull):**

1. **Webhook-Based (Real-time)**:
   - Google Calendar supports push notifications
   - Register webhook on calendar integration
   - Receive events when calendar changes

2. **Polling (Fallback)**:
   - Background job syncs calendars every 10 minutes
   - For providers without webhook support
   - Catches missed webhooks

3. **On-Demand**:
   - When user views availability, trigger fresh sync
   - Only if cache is older than 10 minutes

**Rate Limit Handling:**
```python
async def sync_calendar(integration):
    try:
        events = await calendar_api.list_events(
            integration.access_token,
            time_min=now,
            time_max=now + timedelta(days=30)
        )
        cache_events(integration.id, events)
    except RateLimitError:
        # Back off and retry later
        schedule_retry(integration.id, delay=60)
    except TokenExpiredError:
        # Refresh OAuth token
        new_token = await refresh_token(integration.refresh_token)
        integration.access_token = new_token
        await sync_calendar(integration)
```"

---

## Step 5: Data Model

### Core Tables

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) NOT NULL,  -- e.g., 'America/New_York'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Meeting Types
CREATE TABLE meeting_types (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  buffer_before_minutes INTEGER DEFAULT 0,
  buffer_after_minutes INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true
);

-- Availability Rules (Weekly Schedule)
CREATE TABLE availability_rules (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  day_of_week INTEGER NOT NULL,  -- 0=Sunday, 6=Saturday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL
);

-- Bookings
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  meeting_type_id UUID REFERENCES meeting_types(id),
  host_user_id UUID REFERENCES users(id),
  invitee_email VARCHAR(255) NOT NULL,
  invitee_name VARCHAR(255) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL,  -- confirmed, cancelled, rescheduled
  created_at TIMESTAMP DEFAULT NOW(),
  version INTEGER DEFAULT 1,

  -- Prevent overlapping bookings
  EXCLUDE USING GIST (
    host_user_id WITH =,
    tsrange(start_time, end_time) WITH &&
  )
);

-- Calendar Integrations
CREATE TABLE calendar_integrations (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  provider VARCHAR(50) NOT NULL,  -- google, outlook
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMP NOT NULL,
  calendar_id VARCHAR(255),
  is_active BOOLEAN DEFAULT true
);
```

---

## Step 6: Time Zone Handling

"Time zones are surprisingly complex. Here's my approach:

**Principle: Store UTC, Display Local**

```python
# When saving a booking
def create_booking(host, invitee_tz, selected_slot):
    # Convert invitee's selection to UTC
    start_utc = selected_slot.start.astimezone(UTC)
    end_utc = selected_slot.end.astimezone(UTC)

    booking = Booking(
        start_time=start_utc,  # Store in UTC
        end_time=end_utc,
        invitee_timezone=invitee_tz  # Remember for display
    )
    return booking

# When displaying to host
def format_for_host(booking, host):
    host_tz = pytz.timezone(host.time_zone)
    return booking.start_time.astimezone(host_tz)

# When displaying to invitee
def format_for_invitee(booking):
    invitee_tz = pytz.timezone(booking.invitee_timezone)
    return booking.start_time.astimezone(invitee_tz)
```

**DST Edge Cases:**
- Store all times in UTC (no DST in UTC)
- Re-calculate display times on render (catches DST changes)
- For recurring meetings, store the rule (every Tuesday 2pm host's time), not the specific UTC time

**Confirmation Emails:**
```
Meeting Scheduled!

For you (New York): Tuesday, Jan 15, 2024 at 2:00 PM EST
For your host (London): Tuesday, Jan 15, 2024 at 7:00 PM GMT
```"

---

## Step 7: API Design

### Availability API

```
GET /api/availability/slots
    ?meeting_type_id=xxx
    &date=2024-01-15
    &timezone=America/New_York

Response:
{
  "date": "2024-01-15",
  "timezone": "America/New_York",
  "slots": [
    {"start": "09:00", "end": "09:30"},
    {"start": "09:30", "end": "10:00"},
    {"start": "10:30", "end": "11:00"},
    // ... gaps where host is busy
  ]
}
```

### Booking API

```
POST /api/bookings

Request:
{
  "meeting_type_id": "xxx",
  "start_time": "2024-01-15T14:00:00Z",
  "invitee_name": "John Doe",
  "invitee_email": "john@example.com",
  "invitee_timezone": "America/New_York",
  "answers": {
    "What would you like to discuss?": "Product demo"
  }
}

Response:
{
  "id": "booking-uuid",
  "status": "confirmed",
  "start_time": "2024-01-15T14:00:00Z",
  "end_time": "2024-01-15T14:30:00Z",
  "join_url": "https://zoom.us/j/xxx",
  "calendar_event_id": "google-event-id"
}
```

---

## Step 8: Deep Dive - The Booking Race Condition

"Let me walk through the most challenging scenario: two people trying to book the last available slot simultaneously.

**Scenario:**
- Host has one slot available: 2:00-2:30 PM
- Alice and Bob both click 'Book' at the same time

**Without proper handling:**
```
Time T0: Alice checks availability → slot available
Time T1: Bob checks availability → slot available
Time T2: Alice creates booking → success
Time T3: Bob creates booking → DOUBLE BOOKING!
```

**With my solution:**

```
Time T0: Alice checks availability → slot available
Time T1: Bob checks availability → slot available
Time T2: Alice starts transaction, locks host row
Time T3: Bob starts transaction, waits for lock
Time T4: Alice inserts booking, commits, releases lock
Time T5: Bob acquires lock, checks availability → CONFLICT
Time T6: Bob gets error: 'Slot no longer available'
```

**User Experience:**
```
Bob sees:
'Sorry, this slot was just booked. Please select another time.'
[Show updated availability with slot removed]
```

**Implementation:**
```typescript
async function createBooking(bookingData: BookingRequest): Promise<Booking> {
  return await db.transaction(async (tx) => {
    // 1. Lock host's row (serializes concurrent bookings)
    await tx.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [bookingData.hostId]
    );

    // 2. Check for conflicts
    const conflicts = await tx.query(`
      SELECT id FROM bookings
      WHERE host_user_id = $1
        AND start_time < $2
        AND end_time > $3
        AND status = 'confirmed'
    `, [bookingData.hostId, bookingData.endTime, bookingData.startTime]);

    if (conflicts.rows.length > 0) {
      throw new ConflictError('Slot is no longer available');
    }

    // 3. Create booking
    const booking = await tx.query(`
      INSERT INTO bookings (...)
      VALUES (...)
      RETURNING *
    `, [...]);

    return booking.rows[0];
  });
}
```"

---

## Step 9: Calendar Integration Deep Dive

"Let me elaborate on the calendar sync architecture:

### OAuth Flow

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐
│  User   │────▶│ Calendly    │────▶│   Google    │
│ Browser │     │   Backend   │     │   OAuth     │
└─────────┘     └─────────────┘     └─────────────┘
     │                 │                   │
     │  1. Click       │                   │
     │  'Connect       │                   │
     │   Google'       │                   │
     │────────────────▶│                   │
     │                 │ 2. Redirect to    │
     │                 │    Google OAuth   │
     │◀────────────────│───────────────────│
     │                 │                   │
     │  3. User logs   │                   │
     │  in to Google   │                   │
     │─────────────────│──────────────────▶│
     │                 │                   │
     │  4. Google      │                   │
     │  redirects      │                   │
     │  with code      │                   │
     │◀────────────────│───────────────────│
     │                 │                   │
     │  5. Exchange    │                   │
     │  code for       │  6. Access +      │
     │  tokens         │  Refresh tokens   │
     │                 │◀──────────────────│
```

### Token Management

```python
class CalendarTokenManager:
    async def get_valid_token(self, integration_id):
        integration = await db.get_integration(integration_id)

        if integration.token_expires_at > datetime.now():
            return integration.access_token

        # Token expired, refresh it
        new_tokens = await self.refresh_token(integration.refresh_token)

        await db.update_integration(integration_id, {
            'access_token': new_tokens.access_token,
            'token_expires_at': new_tokens.expires_at
        })

        return new_tokens.access_token

    async def refresh_token(self, refresh_token):
        response = await google_oauth.refresh(
            client_id=GOOGLE_CLIENT_ID,
            client_secret=GOOGLE_CLIENT_SECRET,
            refresh_token=refresh_token
        )
        return response
```

### What if Calendar API is Down?

```python
async def create_booking_with_calendar(booking_data):
    # 1. Create booking in our database first
    booking = await create_booking(booking_data)

    try:
        # 2. Try to create calendar event
        calendar_event = await create_calendar_event(booking)
        await update_booking(booking.id, {
            'calendar_event_id': calendar_event.id
        })
    except CalendarAPIError:
        # 3. Queue for retry, don't fail the booking
        await queue_calendar_event_creation(booking.id)
        logger.warning(f'Calendar event creation queued for {booking.id}')

    return booking
```

**Trade-off:** We prioritize booking creation over calendar sync. Users might not see the event immediately, but the booking is confirmed."

---

## Step 10: Scalability Considerations

### Database Scaling

"Bookings table is the main growth concern:

**Partitioning by Date:**
```sql
CREATE TABLE bookings (
    ...
) PARTITION BY RANGE (start_time);

CREATE TABLE bookings_2024_01 PARTITION OF bookings
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE bookings_2024_02 PARTITION OF bookings
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
```

**Benefits:**
- Old partitions can be archived
- Queries scoped to date range are fast
- Easy to drop old data

**Read Replicas:**
- Availability queries hit read replicas
- Booking creation hits primary
- Replication lag acceptable (few ms)"

### Caching Strategy

```
┌─────────────────────────────────────────────────────┐
│                   Cache Layers                       │
├─────────────────────────────────────────────────────┤
│                                                      │
│  1. Availability Cache (Redis)                       │
│     Key: availability:{host}:{date}:{type}           │
│     TTL: 5 minutes                                   │
│     Invalidate: On booking, On calendar sync         │
│                                                      │
│  2. Calendar Events Cache (Redis)                    │
│     Key: calendar:{integration_id}:{date}            │
│     TTL: 10 minutes                                  │
│     Invalidate: On calendar webhook, On sync         │
│                                                      │
│  3. User/Meeting Type Cache (Redis)                  │
│     Key: user:{id}, meeting_type:{id}                │
│     TTL: 1 hour                                      │
│     Invalidate: On update                            │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## Step 11: Notification System

```
                    ┌─────────────────┐
                    │  Booking Event  │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    RabbitMQ     │
                    │   (Job Queue)   │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
    │Confirmation │   │  Reminder   │   │Cancellation │
    │   Worker    │   │   Worker    │   │   Worker    │
    └─────────────┘   └─────────────┘   └─────────────┘
           │                 │                 │
           ▼                 ▼                 ▼
    ┌─────────────────────────────────────────────────┐
    │               Email Service (SendGrid)           │
    └─────────────────────────────────────────────────┘
```

**Reminder Scheduling:**
```python
async def schedule_reminders(booking):
    # 24 hours before
    await queue.schedule_job(
        job_type='send_reminder',
        booking_id=booking.id,
        run_at=booking.start_time - timedelta(hours=24)
    )

    # 1 hour before
    await queue.schedule_job(
        job_type='send_reminder',
        booking_id=booking.id,
        run_at=booking.start_time - timedelta(hours=1)
    )
```

---

## Step 12: Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Database | PostgreSQL | DynamoDB | Need ACID for double-booking prevention |
| Locking | Pessimistic (FOR UPDATE) | Optimistic | Lower latency matters less than correctness |
| Time Storage | UTC | Local time | Simpler, no DST issues in storage |
| Calendar Sync | Hybrid (webhook + polling) | Polling only | Better freshness with webhooks |
| Availability Cache | 5 min TTL | No cache | Balance freshness vs. performance |

---

## Step 13: Monitoring

"Key metrics to track:

**Business Metrics:**
- Bookings per minute
- Booking success rate
- Availability check latency (p50, p95, p99)

**Technical Metrics:**
- Database lock wait time
- Cache hit rate for availability
- Calendar API error rate
- Email delivery rate

**Alerts:**
- Double booking detected (should be 0, indicates bug)
- Availability check latency > 500ms
- Calendar sync failure rate > 5%
- Email bounce rate > 2%"

---

## Summary

"To summarize my Calendly design:

1. **Double Booking Prevention**: Multi-layered approach with database constraints, row locking, and optimistic locking
2. **Availability Calculation**: Merge working hours, bookings, and calendar events with smart caching
3. **Time Zone Handling**: Store UTC, display local, handle DST on render
4. **Calendar Integration**: OAuth with token refresh, hybrid sync (webhooks + polling)
5. **Scalability**: Read replicas, date-range partitioning, aggressive caching

The key insight is that consistency (no double bookings) trumps availability - we'd rather fail a booking attempt than create a conflict. The system is designed around this principle.

What aspects would you like me to elaborate on?"
