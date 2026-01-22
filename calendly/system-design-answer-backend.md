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

```sql
-- Users with time zone preference
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Meeting type templates
CREATE TABLE meeting_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_day INTEGER,
  color VARCHAR(7) DEFAULT '#3B82F6',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, slug)
);

-- Weekly availability rules
CREATE TABLE availability_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL CHECK (end_time > start_time),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bookings with multi-layer conflict prevention
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_type_id UUID NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL CHECK (end_time > start_time),
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
  cancellation_reason TEXT,
  notes TEXT,
  version INTEGER DEFAULT 1,
  idempotency_key VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Critical indexes for double-booking prevention
CREATE UNIQUE INDEX idx_bookings_no_double
  ON bookings(host_user_id, start_time)
  WHERE status = 'confirmed';

CREATE UNIQUE INDEX idx_bookings_idempotency_key
  ON bookings(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_bookings_host_time
  ON bookings(host_user_id, start_time, end_time);

CREATE INDEX idx_availability_user_day
  ON availability_rules(user_id, day_of_week, is_active);
```

### Archive Table for Data Lifecycle

```sql
-- Separate archive table for old bookings (no foreign keys)
CREATE TABLE bookings_archive (
  id UUID PRIMARY KEY,
  meeting_type_id UUID NOT NULL,
  host_user_id UUID NOT NULL,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  cancellation_reason TEXT,
  notes TEXT,
  version INTEGER DEFAULT 1,
  idempotency_key VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

## Step 4: Deep Dive - Double Booking Prevention

### Multi-Layer Approach

"The booking race condition is the hardest problem. Two invitees clicking 'Book' at the same moment must never both succeed for the same slot."

```typescript
// backend/src/services/bookingService.ts

interface BookingRequest {
  meetingTypeId: string;
  hostUserId: string;
  startTime: Date;
  endTime: Date;
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimezone: string;
  idempotencyKey?: string;
}

export class BookingService {
  private pool: Pool;
  private cache: CacheService;
  private idempotencyService: IdempotencyService;

  async createBooking(request: BookingRequest): Promise<Booking> {
    // Layer 1: Idempotency check (prevents duplicate submissions)
    const idempotencyKey = request.idempotencyKey ||
      this.generateIdempotencyKey(request);

    const cachedResult = await this.idempotencyService.getResult(idempotencyKey);
    if (cachedResult) {
      return cachedResult;
    }

    // Layer 2: Acquire distributed lock for this host's calendar
    const lockKey = `booking_lock:${request.hostUserId}`;
    const lock = await this.cache.acquireLock(lockKey, 5000);

    if (!lock) {
      throw new ConflictError('Booking in progress, please retry');
    }

    try {
      return await this.pool.transaction(async (tx) => {
        // Layer 3: Row-level lock on host (serializes concurrent bookings)
        await tx.query(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [request.hostUserId]
        );

        // Layer 4: Check for overlapping confirmed bookings
        const conflicts = await tx.query(`
          SELECT id FROM bookings
          WHERE host_user_id = $1
            AND status = 'confirmed'
            AND start_time < $2
            AND end_time > $3
        `, [request.hostUserId, request.endTime, request.startTime]);

        if (conflicts.rows.length > 0) {
          throw new ConflictError('Slot is no longer available');
        }

        // Layer 5: Insert with unique partial index as final guard
        const result = await tx.query(`
          INSERT INTO bookings (
            meeting_type_id, host_user_id, invitee_name, invitee_email,
            start_time, end_time, invitee_timezone, status, idempotency_key
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8)
          RETURNING *
        `, [
          request.meetingTypeId,
          request.hostUserId,
          request.inviteeName,
          request.inviteeEmail,
          request.startTime,
          request.endTime,
          request.inviteeTimezone,
          idempotencyKey
        ]);

        const booking = result.rows[0];

        // Cache idempotency result for 1 hour
        await this.idempotencyService.storeResult(idempotencyKey, booking);

        // Invalidate availability cache
        await this.cache.invalidatePattern(
          `availability:${request.hostUserId}:*`
        );

        // Queue email notification (async, non-blocking)
        await this.queueConfirmationEmail(booking);

        return booking;
      });
    } finally {
      await this.cache.releaseLock(lockKey);
    }
  }

  private generateIdempotencyKey(request: BookingRequest): string {
    const data = `${request.meetingTypeId}:${request.startTime.toISOString()}:${request.inviteeEmail}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}
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

### Algorithm

```typescript
// backend/src/services/availabilityService.ts

interface TimeSlot {
  startTime: Date;
  endTime: Date;
}

interface BusyPeriod {
  start: Date;
  end: Date;
}

export class AvailabilityService {
  private pool: Pool;
  private cache: CacheService;
  private calendarService: CalendarIntegrationService;

  async getAvailableSlots(
    meetingTypeId: string,
    date: Date,
    timezone: string
  ): Promise<TimeSlot[]> {
    // Check cache first (5-minute TTL)
    const cacheKey = `availability:${meetingTypeId}:${date.toISOString().split('T')[0]}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return this.convertTimezone(cached, timezone);
    }

    // Fetch meeting type with user info
    const meetingType = await this.getMeetingType(meetingTypeId);
    const dayOfWeek = date.getDay();

    // Step 1: Get availability rules for this day
    const rules = await this.pool.query(`
      SELECT start_time, end_time FROM availability_rules
      WHERE user_id = $1 AND day_of_week = $2 AND is_active = true
    `, [meetingType.userId, dayOfWeek]);

    if (rules.rows.length === 0) {
      return []; // No availability on this day
    }

    // Step 2: Get existing bookings
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const bookings = await this.pool.query(`
      SELECT start_time, end_time FROM bookings
      WHERE host_user_id = $1
        AND status = 'confirmed'
        AND start_time >= $2
        AND start_time < $3
    `, [meetingType.userId, dayStart, dayEnd]);

    // Step 3: Get external calendar events (from cache or API)
    const calendarEvents = await this.calendarService.getEvents(
      meetingType.userId,
      dayStart,
      dayEnd
    );

    // Step 4: Merge all busy periods
    const busyPeriods = this.mergeBusyPeriods([
      ...bookings.rows.map(b => ({
        start: new Date(b.start_time),
        end: new Date(b.end_time)
      })),
      ...calendarEvents.map(e => ({
        start: e.start,
        end: e.end
      }))
    ]);

    // Step 5: Generate available slots
    const slots = this.findAvailableSlots(
      rules.rows,
      busyPeriods,
      meetingType.durationMinutes,
      meetingType.bufferBeforeMinutes,
      meetingType.bufferAfterMinutes,
      date
    );

    // Cache result (5 min TTL)
    await this.cache.set(cacheKey, slots, 300);

    return this.convertTimezone(slots, timezone);
  }

  private mergeBusyPeriods(periods: BusyPeriod[]): BusyPeriod[] {
    if (periods.length === 0) return [];

    // Sort by start time
    const sorted = [...periods].sort(
      (a, b) => a.start.getTime() - b.start.getTime()
    );

    const merged: BusyPeriod[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const last = merged[merged.length - 1];

      if (current.start.getTime() <= last.end.getTime()) {
        // Overlapping - extend the end
        last.end = new Date(Math.max(last.end.getTime(), current.end.getTime()));
      } else {
        merged.push(current);
      }
    }

    return merged;
  }

  private findAvailableSlots(
    rules: { start_time: string; end_time: string }[],
    busyPeriods: BusyPeriod[],
    duration: number,
    bufferBefore: number,
    bufferAfter: number,
    date: Date
  ): TimeSlot[] {
    const slots: TimeSlot[] = [];
    const totalDuration = bufferBefore + duration + bufferAfter;

    for (const rule of rules) {
      // Convert TIME to Date for this specific date
      const windowStart = this.timeToDate(date, rule.start_time);
      const windowEnd = this.timeToDate(date, rule.end_time);

      // Generate slots at 15-minute intervals
      let current = windowStart;
      while (current.getTime() + totalDuration * 60000 <= windowEnd.getTime()) {
        const slotStart = new Date(current.getTime() + bufferBefore * 60000);
        const slotEnd = new Date(slotStart.getTime() + duration * 60000);

        // Check if slot conflicts with any busy period
        const hasConflict = busyPeriods.some(busy =>
          slotStart < busy.end && slotEnd > busy.start
        );

        if (!hasConflict) {
          slots.push({ startTime: slotStart, endTime: slotEnd });
        }

        current = new Date(current.getTime() + 15 * 60000); // 15-min increments
      }
    }

    return slots;
  }
}
```

### Cache Invalidation Strategy

```typescript
// backend/src/services/cacheService.ts

export class CacheService {
  private redis: Redis;

  async invalidateAvailability(hostUserId: string, date?: Date): Promise<void> {
    if (date) {
      // Invalidate specific date
      const key = `availability:${hostUserId}:${date.toISOString().split('T')[0]}`;
      await this.redis.del(key);
    } else {
      // Invalidate all dates for this host
      const pattern = `availability:${hostUserId}:*`;
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    }
  }

  // Called after: booking creation, cancellation, calendar sync
  async onBookingChange(booking: Booking): Promise<void> {
    await this.invalidateAvailability(booking.hostUserId);
  }
}
```

---

## Step 6: Deep Dive - Calendar Integration

### OAuth Token Management

```typescript
// backend/src/services/calendarIntegrationService.ts

interface CalendarTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export class CalendarIntegrationService {
  private pool: Pool;
  private cache: CacheService;

  async getValidToken(integrationId: string): Promise<string> {
    const integration = await this.pool.query(`
      SELECT access_token, refresh_token, token_expires_at
      FROM calendar_integrations
      WHERE id = $1 AND is_active = true
    `, [integrationId]);

    if (integration.rows.length === 0) {
      throw new NotFoundError('Calendar integration not found');
    }

    const { access_token, refresh_token, token_expires_at } = integration.rows[0];

    // Token still valid (with 5-min buffer)
    if (new Date(token_expires_at).getTime() > Date.now() + 5 * 60000) {
      return access_token;
    }

    // Refresh the token
    const newTokens = await this.refreshGoogleToken(refresh_token);

    await this.pool.query(`
      UPDATE calendar_integrations
      SET access_token = $1, token_expires_at = $2, updated_at = NOW()
      WHERE id = $3
    `, [newTokens.accessToken, newTokens.expiresAt, integrationId]);

    return newTokens.accessToken;
  }

  async syncCalendar(userId: string): Promise<void> {
    const integrations = await this.pool.query(`
      SELECT id, provider, calendar_id FROM calendar_integrations
      WHERE user_id = $1 AND is_active = true
    `, [userId]);

    for (const integration of integrations.rows) {
      try {
        const token = await this.getValidToken(integration.id);
        const events = await this.fetchCalendarEvents(
          integration.provider,
          token,
          integration.calendar_id
        );

        // Cache events for 10 minutes
        const cacheKey = `calendar_events:${integration.id}`;
        await this.cache.set(cacheKey, events, 600);

      } catch (error) {
        if (error instanceof RateLimitError) {
          // Schedule retry with exponential backoff
          await this.scheduleRetry(integration.id, 60);
        } else if (error instanceof TokenExpiredError) {
          // Mark integration as needing reauthorization
          await this.markAsExpired(integration.id);
        } else {
          throw error;
        }
      }
    }
  }

  async getEvents(
    userId: string,
    startDate: Date,
    endDate: Date
  ): Promise<CalendarEvent[]> {
    // Try cache first
    const integrations = await this.pool.query(`
      SELECT id FROM calendar_integrations
      WHERE user_id = $1 AND is_active = true
    `, [userId]);

    const allEvents: CalendarEvent[] = [];

    for (const integration of integrations.rows) {
      const cacheKey = `calendar_events:${integration.id}`;
      let events = await this.cache.get<CalendarEvent[]>(cacheKey);

      if (!events) {
        // Cache miss - sync calendar
        await this.syncCalendar(userId);
        events = await this.cache.get<CalendarEvent[]>(cacheKey);
      }

      if (events) {
        // Filter to requested date range
        const filtered = events.filter(e =>
          e.start >= startDate && e.end <= endDate
        );
        allEvents.push(...filtered);
      }
    }

    return allEvents;
  }
}
```

### Hybrid Sync Strategy

```typescript
// backend/src/workers/calendarSyncWorker.ts

export class CalendarSyncWorker {
  private calendarService: CalendarIntegrationService;

  async start(): Promise<void> {
    // Webhook handler for push notifications (Google Calendar)
    this.registerWebhookHandler();

    // Fallback polling every 10 minutes
    setInterval(() => this.pollAllCalendars(), 10 * 60 * 1000);
  }

  private async registerWebhookHandler(): Promise<void> {
    // POST /api/webhooks/google-calendar
    router.post('/webhooks/google-calendar', async (req, res) => {
      const channelId = req.headers['x-goog-channel-id'];
      const resourceState = req.headers['x-goog-resource-state'];

      if (resourceState === 'sync' || resourceState === 'exists') {
        // Calendar was updated - trigger refresh
        const integration = await this.findIntegrationByChannel(channelId);
        if (integration) {
          await this.calendarService.syncCalendar(integration.userId);
        }
      }

      res.sendStatus(200);
    });
  }

  private async pollAllCalendars(): Promise<void> {
    // Fetch all active integrations that need sync
    const staleIntegrations = await this.pool.query(`
      SELECT DISTINCT user_id FROM calendar_integrations
      WHERE is_active = true
        AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '10 minutes')
      LIMIT 100
    `);

    for (const row of staleIntegrations.rows) {
      try {
        await this.calendarService.syncCalendar(row.user_id);
      } catch (error) {
        console.error(`Calendar sync failed for user ${row.user_id}:`, error);
      }
    }
  }
}
```

---

## Step 7: Notification System

### Queue-Based Architecture

```typescript
// backend/src/services/notificationService.ts

interface NotificationPayload {
  type: 'confirmation' | 'reminder' | 'cancellation' | 'reschedule';
  bookingId: string;
  recipientEmail: string;
  recipientName: string;
}

export class NotificationService {
  private queue: RabbitMQClient;
  private pool: Pool;

  async queueConfirmation(booking: Booking): Promise<void> {
    // Queue emails for both host and invitee
    await this.queue.publish('notifications', {
      type: 'confirmation',
      bookingId: booking.id,
      recipientEmail: booking.inviteeEmail,
      recipientName: booking.inviteeName
    });

    const host = await this.getHost(booking.hostUserId);
    await this.queue.publish('notifications', {
      type: 'confirmation',
      bookingId: booking.id,
      recipientEmail: host.email,
      recipientName: host.name
    });
  }

  async scheduleReminders(booking: Booking): Promise<void> {
    const startTime = new Date(booking.startTime);

    // 24 hours before
    const reminder24h = new Date(startTime.getTime() - 24 * 60 * 60 * 1000);
    if (reminder24h > new Date()) {
      await this.queue.publishDelayed('notifications', {
        type: 'reminder',
        bookingId: booking.id,
        recipientEmail: booking.inviteeEmail,
        recipientName: booking.inviteeName
      }, reminder24h);
    }

    // 1 hour before
    const reminder1h = new Date(startTime.getTime() - 60 * 60 * 1000);
    if (reminder1h > new Date()) {
      await this.queue.publishDelayed('notifications', {
        type: 'reminder',
        bookingId: booking.id,
        recipientEmail: booking.inviteeEmail,
        recipientName: booking.inviteeName
      }, reminder1h);
    }
  }
}

// backend/src/workers/notificationWorker.ts

export class NotificationWorker {
  async start(): Promise<void> {
    await this.queue.consume('notifications', async (message) => {
      const payload = message as NotificationPayload;

      try {
        const booking = await this.getBooking(payload.bookingId);

        // Booking might have been cancelled
        if (!booking || booking.status === 'cancelled') {
          return; // Acknowledge and skip
        }

        const emailContent = await this.generateEmail(payload.type, booking);
        await this.sendEmail(payload.recipientEmail, emailContent);

        // Log notification for audit
        await this.pool.query(`
          INSERT INTO email_notifications
          (booking_id, recipient_email, notification_type, subject, body, status)
          VALUES ($1, $2, $3, $4, $5, 'sent')
        `, [
          booking.id,
          payload.recipientEmail,
          payload.type,
          emailContent.subject,
          emailContent.body
        ]);

      } catch (error) {
        console.error('Notification failed:', error);
        // Retry with exponential backoff (RabbitMQ handles this)
        throw error;
      }
    });
  }
}
```

---

## Step 8: Database Scaling Strategy

### Table Partitioning

```sql
-- Partition bookings by month for efficient queries and archival
CREATE TABLE bookings (
    id UUID,
    host_user_id UUID NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    -- ... other columns
    PRIMARY KEY (id, start_time)
) PARTITION BY RANGE (start_time);

-- Create monthly partitions
CREATE TABLE bookings_2024_01 PARTITION OF bookings
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE bookings_2024_02 PARTITION OF bookings
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- ... etc

-- Auto-create future partitions
CREATE OR REPLACE FUNCTION create_monthly_partition()
RETURNS void AS $$
DECLARE
    partition_date DATE;
    partition_name TEXT;
BEGIN
    partition_date := DATE_TRUNC('month', NOW() + INTERVAL '1 month');
    partition_name := 'bookings_' || TO_CHAR(partition_date, 'YYYY_MM');

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF bookings
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        partition_date,
        partition_date + INTERVAL '1 month'
    );
END;
$$ LANGUAGE plpgsql;
```

### Read Replica Configuration

```typescript
// backend/src/shared/db.ts

import { Pool } from 'pg';

// Primary pool for writes
export const primaryPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

// Replica pool for reads
export const replicaPool = new Pool({
  connectionString: process.env.DATABASE_REPLICA_URL || process.env.DATABASE_URL,
  max: 50, // Higher limit for read-heavy availability queries
});

// Route read queries to replica
export function getReadPool(): Pool {
  return process.env.DATABASE_REPLICA_URL ? replicaPool : primaryPool;
}

// Always use primary for writes
export function getWritePool(): Pool {
  return primaryPool;
}
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

```typescript
// backend/src/shared/metrics.ts

import { Counter, Histogram, Gauge } from 'prom-client';

// Booking metrics
export const bookingOperations = new Counter({
  name: 'calendly_booking_operations_total',
  help: 'Total booking operations',
  labelNames: ['operation', 'status']
});

export const bookingLatency = new Histogram({
  name: 'calendly_booking_creation_duration_seconds',
  help: 'Booking creation latency',
  labelNames: ['status'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5]
});

export const doubleBookingPrevented = new Counter({
  name: 'calendly_double_booking_prevented_total',
  help: 'Count of prevented double bookings'
});

// Availability metrics
export const availabilityChecks = new Counter({
  name: 'calendly_availability_checks_total',
  help: 'Availability check requests',
  labelNames: ['cache_hit']
});

export const availabilityLatency = new Histogram({
  name: 'calendly_availability_calculation_duration_seconds',
  help: 'Availability calculation latency',
  labelNames: ['cache_hit'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1]
});

// Calendar sync metrics
export const calendarSyncLag = new Gauge({
  name: 'calendly_calendar_sync_lag_seconds',
  help: 'Time since last successful calendar sync',
  labelNames: ['provider']
});
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
