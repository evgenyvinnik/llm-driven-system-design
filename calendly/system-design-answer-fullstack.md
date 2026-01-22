# Calendly - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction

"Today I'll design a meeting scheduling platform like Calendly, focusing on the end-to-end architecture. The core challenge is preventing double bookings while providing a seamless guest booking experience. I'll walk through the shared type system, API contract design, the complete booking flow from UI to database, and how the frontend and backend coordinate on time zone handling and conflict prevention."

---

## Step 1: Requirements Clarification

### Functional Requirements

1. **Availability Management**: Users define working hours with weekly recurring patterns
2. **Meeting Types**: Configurable durations, buffer times, booking limits
3. **Guest Booking Flow**: View slots, select time, submit form, receive confirmation
4. **Calendar Integration**: OAuth sync with Google Calendar and Outlook
5. **Notifications**: Email confirmations and reminders
6. **Time Zone Handling**: Store UTC, display in user's local time

### Non-Functional Requirements

- **Consistency**: Zero double bookings (strong consistency on writes)
- **Latency**: Availability checks < 200ms, booking creation < 500ms
- **Scale**: 1M users, 430K bookings/day, 5,000 RPS peak availability checks

---

## Step 2: High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           React Frontend                                     │
│                    (Vite + TanStack Router + Zustand)                        │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │ REST API (JSON)
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Load Balancer (nginx)                                │
└─────────────────────────────────────────┬───────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     API Layer (Express + TypeScript)                         │
├─────────────────────┬─────────────────────┬─────────────────────────────────┤
│   Booking Service   │ Availability Service │      Integration Service        │
└─────────────────────┴─────────────────────┴─────────────────────────────────┘
          │                       │                        │
          ▼                       ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐
│   PostgreSQL    │    │  Valkey/Redis   │    │          RabbitMQ           │
│   (Bookings)    │    │   (Cache)       │    │    (Notifications)          │
└─────────────────┘    └─────────────────┘    └─────────────────────────────┘
```

---

## Step 3: Shared Type Definitions

### Core Types (Shared Between Frontend and Backend)

"I use TypeScript interfaces duplicated in both projects with Zod schemas for runtime validation. This ensures frontend/backend consistency without monorepo complexity."

**User Types**: id, email, name, timezone, role, createdAt

**MeetingType**: id, userId, name, slug, description, durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, maxBookingsPerDay, color, isActive, timestamps

**AvailabilityRule**: id, userId, dayOfWeek (0-6), startTime (HH:MM), endTime (HH:MM), isActive

**TimeSlot**: startTime (ISO 8601 UTC), endTime (ISO 8601 UTC)

**Booking**: id, meetingTypeId, hostUserId, inviteeName, inviteeEmail, startTime, endTime, inviteeTimezone, status (confirmed/cancelled/rescheduled), cancellationReason, notes, version, timestamps

**Error Codes**: SLOT_UNAVAILABLE, INVALID_TIME_SLOT, MEETING_TYPE_INACTIVE, MAX_BOOKINGS_REACHED, IDEMPOTENCY_CONFLICT

### Validation Schemas

Zod schemas enforce validation on both sides:
- ISO datetime strings for timestamps
- Email validation for invitee
- Timezone regex pattern matching IANA format
- UUID validation for IDs
- HH:MM pattern for time strings with end > start refinement

---

## Step 4: API Client Layer

### Frontend API Client Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            ApiClient Class                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Constructor:                                                                │
│  ├── baseURL from VITE_API_URL or localhost:3000/api                        │
│  ├── withCredentials: true (for cookies)                                    │
│  └── Response interceptor for error handling                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Availability Methods:                                                       │
│  ├── getAvailability(meetingTypeId, startDate, endDate)                     │
│  └── checkSlotAvailability(meetingTypeId, startTime)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Booking Methods:                                                            │
│  ├── createBooking(request, idempotencyKey?) ──▶ X-Idempotency-Key header   │
│  ├── getBooking(bookingId)                                                  │
│  └── cancelBooking(bookingId, reason?)                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Meeting Type Methods:                                                       │
│  ├── getMeetingType(meetingTypeId)                                          │
│  └── getMeetingTypeBySlug(username, slug)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 5: End-to-End Booking Flow

### Sequence Diagram

```
┌─────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────┐    ┌─────────┐
│  Guest  │    │   React     │    │   Express   │    │PostgreSQL│    │RabbitMQ │
│ Browser │    │  Frontend   │    │   Backend   │    │          │    │         │
└────┬────┘    └──────┬──────┘    └──────┬──────┘    └────┬─────┘    └────┬────┘
     │                │                  │                │               │
     │ 1. Visit /{user}/{slug}          │                │               │
     │───────────────▶│                  │                │               │
     │                │ 2. GET /api/{user}/{slug}        │               │
     │                │─────────────────▶│                │               │
     │                │                  │ 3. Query meeting_types        │
     │                │                  │───────────────▶│               │
     │                │                  │◀──────────────│               │
     │◀───────────────│◀─────────────────│                │               │
     │                │                  │                │               │
     │ 4. Select date │                  │                │               │
     │───────────────▶│                  │                │               │
     │                │ 5. GET /api/availability         │               │
     │                │─────────────────▶│                │               │
     │                │                  │ 6. Check cache (Valkey)       │
     │                │                  │ 7. Query availability_rules   │
     │                │                  │ 8. Query bookings             │
     │                │                  │ 9. Merge & calculate slots    │
     │◀───────────────│◀─────────────────│                │               │
     │                │                  │                │               │
     │ 10. Select slot + Submit form    │                │               │
     │───────────────▶│                  │                │               │
     │                │ 12. POST /api/bookings           │               │
     │                │   (X-Idempotency-Key header)     │               │
     │                │─────────────────▶│                │               │
     │                │                  │ 13. Check idempotency (cache) │
     │                │                  │ 14. BEGIN TRANSACTION         │
     │                │                  │ 15. SELECT FOR UPDATE (lock)  │
     │                │                  │ 16. Check conflicts           │
     │                │                  │ 17. INSERT booking            │
     │                │                  │ 18. COMMIT                    │
     │                │                  │───────────────▶│               │
     │                │                  │ 19. Queue confirmation email  │
     │                │                  │────────────────────────────────▶
     │                │                  │ 20. Invalidate cache          │
     │◀───────────────│◀─────────────────│                │               │
     │ 21. Confirmation (dual timezone) │                │               │
```

### Backend Booking Handler Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        POST /bookings Handler                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Validate request body with Zod schema                                   │
│     └── Return 400 with VALIDATION_ERROR if invalid                         │
│                                                                              │
│  2. Get or generate idempotency key                                         │
│     ├── Use X-Idempotency-Key header if provided                            │
│     └── Generate SHA256 hash of (meetingTypeId:startTime:inviteeEmail)      │
│                                                                              │
│  3. Check for existing result (idempotency)                                 │
│     └── Return cached result if found (200 OK)                              │
│                                                                              │
│  4. Acquire idempotency lock                                                │
│     └── Return 409 IDEMPOTENCY_CONFLICT if lock not acquired                │
│                                                                              │
│  5. Create booking via BookingService                                       │
│  6. Cache result for idempotency (1 hour TTL)                               │
│  7. Return 201 Created with booking response                                │
│  8. Release idempotency lock (finally block)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Error Handling:                                                             │
│  ├── SLOT_UNAVAILABLE ──▶ 409 with alternative slots                        │
│  └── MAX_BOOKINGS_REACHED ──▶ 422                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend Booking Hook

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        useBookingFlow Hook                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  State:                                                                      │
│  ├── isSubmitting: boolean                                                  │
│  ├── error: string | null                                                   │
│  └── conflictSlots: TimeSlot[] | null                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  submitBooking(data) Flow:                                                  │
│  1. Generate client-side idempotency key                                    │
│  2. Pre-check slot availability (optimistic check)                          │
│     └── If unavailable, set conflictSlots and throw                         │
│  3. Submit booking with idempotency key                                     │
│  4. Invalidate availability cache on success                                │
│                                                                              │
│  Error Handling:                                                             │
│  └── 409 Conflict ──▶ Show alternatives, invalidate cache                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Time Zone Handling (End-to-End)

### Storage Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TIME ZONE HANDLING                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  DATABASE: All timestamps stored in UTC                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ bookings.start_time = '2024-01-15T19:00:00Z' (UTC)                    │  │
│  │ bookings.invitee_timezone = 'America/New_York'                        │  │
│  │ users.time_zone = 'Europe/London' (host)                              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  API: Returns UTC, accepts UTC                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ GET /availability ──▶ slots in UTC                                    │  │
│  │ POST /bookings ──▶ startTime in UTC                                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  FRONTEND: Converts UTC to local for display                                 │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ Auto-detect: Intl.DateTimeFormat().resolvedOptions()                  │  │
│  │ Display: toLocaleString with timeZone option                          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend Time Zone Utilities

- **localTimeToUTC(date, timeString, timezone)**: Convert local HH:MM on a date to UTC using Intl.DateTimeFormat for offset calculation
- **formatForTimezone(utcDate, timezone, format)**: Format UTC date for display in specific timezone with options for time-only, date-only, or full datetime

### Frontend Time Zone Hook (useTimezone)

- Auto-detects browser timezone on mount
- Persists preferred timezone to localStorage
- **formatTime(utcIso)**: Convert UTC to display time without refetch
- **isUnusualHour(utcIso)**: Warn if time is outside 6am-10pm in guest's timezone

---

## Step 7: Conflict Prevention (End-to-End)

### Frontend Pre-Check + Backend Validation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     FRONTEND: Slot Selection                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  handleSlotSelect(slot):                                                    │
│  1. Call checkSlotAvailability (catches 95% of conflicts)                   │
│  2. If unavailable ──▶ show toast, refresh availability                     │
│  3. If available ──▶ setSelectedSlot, proceed to form                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  handleSubmit(formData):                                                    │
│  1. Submit booking with idempotency key                                     │
│  2. On 409 ──▶ Show modal with alternatives, refresh availability           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend Multi-Layer Protection

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 BookingService.createBooking() - 5 Layers                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Layer 1: Idempotency check (handled in route)                              │
│           └── Returns cached result for duplicate requests                   │
│                                                                              │
│  Layer 2: Distributed lock                                                   │
│           └── cache.acquireLock(`booking:${hostUserId}`, 5000)              │
│           └── Throws RetryableError if lock not acquired                    │
│                                                                              │
│  Layer 3: Row-level lock (inside transaction)                               │
│           └── SELECT 1 FROM users WHERE id = $1 FOR UPDATE                  │
│                                                                              │
│  Layer 4: Explicit conflict check                                           │
│           └── Query overlapping confirmed bookings                          │
│           └── Throws SlotUnavailableError with alternatives                 │
│                                                                              │
│  Layer 5: Insert with unique partial index                                  │
│           └── Database constraint as final safety net                       │
│                                                                              │
│  Post-Insert:                                                                │
│  ├── Queue notification via RabbitMQ                                        │
│  └── Invalidate availability cache                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Authentication Flow

### Session-Based Auth

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         POST /auth/login                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Query user by email                                                      │
│  2. Compare password with bcrypt                                            │
│  3. Create session in Redis with 7-day TTL                                  │
│  4. Set httpOnly cookie with session ID                                     │
│  5. Return user data                                                        │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         requireAuth Middleware                               │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Extract session ID from cookie                                          │
│  2. Look up session in Redis                                                │
│  3. Attach userId to request                                                │
│  4. Return 401 if missing or expired                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend Auth Store (Zustand + persist)

- **State**: user, isLoading
- **login(email, password)**: POST to /auth/login, set user
- **logout()**: POST to /auth/logout, clear user
- **checkAuth()**: GET /auth/me on app load
- Persists user to localStorage for hydration

---

## Step 9: Trade-offs Summary

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Type Sharing | Duplicate with Zod validation | Monorepo with shared package | Simpler setup, schemas ensure consistency |
| API Format | REST with JSON | GraphQL | Simpler caching, better for booking flow |
| Time Zone Storage | UTC only | Store local + timezone | Single source of truth, no conversion errors |
| Conflict Prevention | Pre-check + server validation | Server-only | Better UX (catches 95% before form) |
| Session Storage | Redis with cookie | JWT | Instant invalidation, simpler revocation |
| Idempotency | Client + server keys | Server-only | Prevents duplicates from network retries |
| Cache Invalidation | Invalidate on write | TTL only | Immediate consistency for booking conflicts |

---

## Step 10: API Contract Summary

### Public (Guest-Facing) Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/:username/:slug` | Get meeting type details |
| GET | `/availability` | Get available time slots |
| GET | `/availability/check` | Check single slot availability |
| POST | `/bookings` | Create a booking (with idempotency) |
| GET | `/bookings/:id` | Get booking confirmation details |

### Authenticated (Host-Facing) Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login |
| POST | `/auth/logout` | Logout |
| GET | `/auth/me` | Get current user |
| GET | `/meeting-types` | List user's meeting types |
| POST | `/meeting-types` | Create meeting type |
| PUT | `/meeting-types/:id` | Update meeting type |
| DELETE | `/meeting-types/:id` | Delete meeting type |
| GET | `/availability/rules` | Get availability rules |
| PUT | `/availability/rules` | Update availability rules |
| GET | `/bookings` | List user's bookings |
| DELETE | `/bookings/:id` | Cancel booking |

---

## Summary

"To summarize the fullstack architecture for Calendly:

1. **Shared Types**: TypeScript interfaces and Zod schemas ensure frontend/backend consistency
2. **API Contract**: REST with JSON, UTC-only timestamps, idempotency keys for reliability
3. **Booking Flow**: Pre-check + server validation prevents conflicts, 409 response includes alternatives
4. **Time Zone Strategy**: Store UTC, convert on client, no timezone data in API (except user preferences)
5. **Authentication**: Session-based with Redis, cookie transport, instant invalidation
6. **Conflict Prevention**: Five-layer approach from frontend pre-check to database constraints

The key insight is that the frontend and backend must work together on conflict prevention. The frontend provides fast feedback (pre-check, optimistic updates), while the backend ensures correctness (locking, constraints). The shared type system ensures they speak the same language."
