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

### Database Schema

**Users Table**
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Meeting Types Table**
```sql
CREATE TABLE meeting_types (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  buffer_before_minutes INTEGER DEFAULT 0,
  buffer_after_minutes INTEGER DEFAULT 0,
  max_bookings_per_day INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Availability Rules Table**
```sql
CREATE TABLE availability_rules (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  day_of_week INTEGER NOT NULL, -- 0-6 (Sunday-Saturday)
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Bookings Table**
```sql
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  meeting_type_id UUID REFERENCES meeting_types(id),
  host_user_id UUID REFERENCES users(id),
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  time_zone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL, -- confirmed, cancelled, rescheduled
  cancellation_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(host_user_id, start_time) -- Prevent double bookings
);

CREATE INDEX idx_bookings_host_time ON bookings(host_user_id, start_time);
CREATE INDEX idx_bookings_status ON bookings(status);
```

**Calendar Integrations Table**
```sql
CREATE TABLE calendar_integrations (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  provider VARCHAR(50) NOT NULL, -- google, outlook, etc.
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMP NOT NULL,
  calendar_id VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Calendar Events Cache Table**
```sql
CREATE TABLE calendar_events_cache (
  id UUID PRIMARY KEY,
  calendar_integration_id UUID REFERENCES calendar_integrations(id),
  external_event_id VARCHAR(255) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  summary TEXT,
  cached_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_calendar_cache_integration_time ON calendar_events_cache(calendar_integration_id, start_time, end_time);
```

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

### Core Endpoints

**User & Meeting Type Management**
- `POST /api/users` - Create user account
- `GET /api/users/:id` - Get user profile
- `POST /api/meeting-types` - Create meeting type
- `GET /api/meeting-types/:id` - Get meeting type details
- `PUT /api/meeting-types/:id` - Update meeting type
- `DELETE /api/meeting-types/:id` - Delete meeting type

**Availability Management**
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

*This architecture is designed for educational purposes to demonstrate key concepts in building a scheduling platform. Production systems would require additional considerations around disaster recovery, multi-region deployment, and advanced security measures.*
