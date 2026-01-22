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
┌─────────────────────────────────────────┐
│            React Frontend               │
│  (Vite + TanStack Router + Zustand)     │
└─────────────────────────────────────────┘
                    │
                    │ REST API (JSON)
                    ▼
┌─────────────────────────────────────────┐
│         Load Balancer (nginx)           │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│       API Layer (Express + TypeScript)  │
├─────────────────────────────────────────┤
│  Booking  │Availability│ Integration │  │
│  Service  │ Service    │  Service    │  │
└─────────────────────────────────────────┘
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
┌──────────┐  ┌────────────┐  ┌────────────┐
│PostgreSQL│  │ Valkey/    │  │  RabbitMQ  │
│          │  │ Redis      │  │            │
└──────────┘  └────────────┘  └────────────┘
```

---

## Step 3: Shared Type Definitions

### Core Types (Shared Between Frontend and Backend)

```typescript
// shared/types.ts (or types/index.ts in both projects)

// ============= User Types =============
export interface User {
  id: string;
  email: string;
  name: string;
  timezone: string;
  role: 'user' | 'admin';
  createdAt: string;
}

// ============= Meeting Type =============
export interface MeetingType {
  id: string;
  userId: string;
  name: string;
  slug: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  maxBookingsPerDay?: number;
  color: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============= Availability =============
export interface AvailabilityRule {
  id: string;
  userId: string;
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
  startTime: string; // HH:MM format
  endTime: string;   // HH:MM format
  isActive: boolean;
}

export interface TimeSlot {
  startTime: string; // ISO 8601 UTC
  endTime: string;   // ISO 8601 UTC
}

export interface AvailabilityResponse {
  meetingTypeId: string;
  slots: Record<string, TimeSlot[]>; // dateKey (YYYY-MM-DD) -> slots
}

// ============= Booking =============
export type BookingStatus = 'confirmed' | 'cancelled' | 'rescheduled';

export interface Booking {
  id: string;
  meetingTypeId: string;
  hostUserId: string;
  inviteeName: string;
  inviteeEmail: string;
  startTime: string;  // ISO 8601 UTC
  endTime: string;    // ISO 8601 UTC
  inviteeTimezone: string;
  status: BookingStatus;
  cancellationReason?: string;
  notes?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ============= API Request/Response Types =============
export interface CreateBookingRequest {
  meetingTypeId: string;
  startTime: string;  // ISO 8601 UTC
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimezone: string;
  notes?: string;
}

export interface CreateBookingResponse {
  booking: Booking;
  hostName: string;
  meetingTypeName: string;
  hostTimezone: string;
}

export interface GetAvailabilityRequest {
  meetingTypeId: string;
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
}

export interface SlotCheckRequest {
  meetingTypeId: string;
  startTime: string;
}

export interface SlotCheckResponse {
  available: boolean;
  alternativeSlots?: TimeSlot[];
}

// ============= Error Types =============
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export const ErrorCodes = {
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  INVALID_TIME_SLOT: 'INVALID_TIME_SLOT',
  MEETING_TYPE_INACTIVE: 'MEETING_TYPE_INACTIVE',
  MAX_BOOKINGS_REACHED: 'MAX_BOOKINGS_REACHED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;
```

### Validation Schemas (Shared)

```typescript
// shared/validation.ts

import { z } from 'zod';

// Reusable validators
const isoDatetime = z.string().datetime();
const email = z.string().email();
const timezone = z.string().regex(/^[A-Za-z_\/]+$/);

// Booking creation schema
export const createBookingSchema = z.object({
  meetingTypeId: z.string().uuid(),
  startTime: isoDatetime,
  inviteeName: z.string().min(1).max(255),
  inviteeEmail: email,
  inviteeTimezone: timezone,
  notes: z.string().max(1000).optional(),
});

// Availability query schema
export const getAvailabilitySchema = z.object({
  meetingTypeId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Meeting type creation schema
export const createMeetingTypeSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000).optional(),
  durationMinutes: z.number().int().min(5).max(480),
  bufferBeforeMinutes: z.number().int().min(0).max(60).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(60).default(0),
  maxBookingsPerDay: z.number().int().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
});

// Availability rule schema
export const availabilityRuleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
}).refine(data => data.endTime > data.startTime, {
  message: 'End time must be after start time',
});

// Export types inferred from schemas
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type GetAvailabilityInput = z.infer<typeof getAvailabilitySchema>;
export type CreateMeetingTypeInput = z.infer<typeof createMeetingTypeSchema>;
export type AvailabilityRuleInput = z.infer<typeof availabilityRuleSchema>;
```

---

## Step 4: API Client Layer

### Frontend API Client

```typescript
// frontend/src/services/api.ts

import axios, { AxiosError, AxiosInstance } from 'axios';
import type {
  CreateBookingRequest,
  CreateBookingResponse,
  AvailabilityResponse,
  SlotCheckResponse,
  ApiError,
} from '../types';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000/api',
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError<ApiError>) => {
        const apiError = error.response?.data;
        if (apiError) {
          const err = new Error(apiError.message) as Error & { code: string; status: number };
          err.code = apiError.code;
          err.status = error.response?.status || 500;
          throw err;
        }
        throw error;
      }
    );
  }

  // ============= Availability =============
  async getAvailability(
    meetingTypeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<AvailabilityResponse> {
    const response = await this.client.get('/availability', {
      params: {
        meeting_type_id: meetingTypeId,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      },
    });
    return response.data;
  }

  async checkSlotAvailability(
    meetingTypeId: string,
    startTime: Date
  ): Promise<SlotCheckResponse> {
    const response = await this.client.get('/availability/check', {
      params: {
        meeting_type_id: meetingTypeId,
        start_time: startTime.toISOString(),
      },
    });
    return response.data;
  }

  // ============= Bookings =============
  async createBooking(
    request: CreateBookingRequest,
    idempotencyKey?: string
  ): Promise<CreateBookingResponse> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['X-Idempotency-Key'] = idempotencyKey;
    }

    const response = await this.client.post('/bookings', request, { headers });
    return response.data;
  }

  async getBooking(bookingId: string): Promise<CreateBookingResponse> {
    const response = await this.client.get(`/bookings/${bookingId}`);
    return response.data;
  }

  async cancelBooking(bookingId: string, reason?: string): Promise<void> {
    await this.client.delete(`/bookings/${bookingId}`, {
      data: { reason },
    });
  }

  // ============= Meeting Types (Public) =============
  async getMeetingType(meetingTypeId: string) {
    const response = await this.client.get(`/meeting-types/${meetingTypeId}`);
    return response.data;
  }

  async getMeetingTypeBySlug(username: string, slug: string) {
    const response = await this.client.get(`/${username}/${slug}`);
    return response.data;
  }
}

export const api = new ApiClient();
```

---

## Step 5: End-to-End Booking Flow

### Sequence Diagram

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌──────────┐     ┌─────────┐
│  Guest  │     │   React     │     │   Express   │     │PostgreSQL│     │RabbitMQ │
│ Browser │     │  Frontend   │     │   Backend   │     │          │     │         │
└────┬────┘     └──────┬──────┘     └──────┬──────┘     └────┬─────┘     └────┬────┘
     │                 │                   │                 │                │
     │ 1. Visit /{user}/{slug}            │                 │                │
     │────────────────▶│                   │                 │                │
     │                 │                   │                 │                │
     │                 │ 2. GET /api/{user}/{slug}          │                │
     │                 │──────────────────▶│                 │                │
     │                 │                   │ 3. Query meeting_types           │
     │                 │                   │────────────────▶│                │
     │                 │                   │◀────────────────│                │
     │                 │◀──────────────────│                 │                │
     │◀────────────────│                   │                 │                │
     │                 │                   │                 │                │
     │ 4. Select date  │                   │                 │                │
     │────────────────▶│                   │                 │                │
     │                 │ 5. GET /api/availability            │                │
     │                 │──────────────────▶│                 │                │
     │                 │                   │ 6. Check cache (Valkey)          │
     │                 │                   │ 7. Query availability_rules      │
     │                 │                   │ 8. Query bookings                │
     │                 │                   │ 9. Merge & calculate slots       │
     │                 │◀──────────────────│                 │                │
     │◀────────────────│                   │                 │                │
     │                 │                   │                 │                │
     │ 10. Select slot │                   │                 │                │
     │────────────────▶│                   │                 │                │
     │                 │                   │                 │                │
     │ 11. Submit form │                   │                 │                │
     │────────────────▶│                   │                 │                │
     │                 │ 12. POST /api/bookings              │                │
     │                 │   (X-Idempotency-Key header)        │                │
     │                 │──────────────────▶│                 │                │
     │                 │                   │ 13. Check idempotency (cache)    │
     │                 │                   │ 14. BEGIN TRANSACTION            │
     │                 │                   │ 15. SELECT FOR UPDATE (lock)     │
     │                 │                   │ 16. Check conflicts              │
     │                 │                   │ 17. INSERT booking               │
     │                 │                   │ 18. COMMIT                       │
     │                 │                   │────────────────▶│                │
     │                 │                   │◀────────────────│                │
     │                 │                   │ 19. Queue confirmation email     │
     │                 │                   │───────────────────────────────────▶
     │                 │                   │ 20. Invalidate availability cache │
     │                 │◀──────────────────│                 │                │
     │◀────────────────│                   │                 │                │
     │                 │                   │                 │                │
     │ 21. Show confirmation              │                 │                │
     │    (dual timezone display)         │                 │                │
```

### Backend Booking Handler

```typescript
// backend/src/routes/bookings.ts

import { Router, Request, Response, NextFunction } from 'express';
import { createBookingSchema } from '../shared/validation';
import { BookingService } from '../services/bookingService';
import { IdempotencyService } from '../shared/idempotency';
import { ErrorCodes } from '../shared/errors';

const router = Router();
const bookingService = new BookingService();
const idempotencyService = new IdempotencyService();

interface BookingRequest {
  meetingTypeId: string;
  startTime: string;
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimezone: string;
  notes?: string;
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Validate request body
    const validationResult = createBookingSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: validationResult.error.flatten(),
      });
    }

    const bookingData: BookingRequest = validationResult.data;

    // 2. Get or generate idempotency key
    const clientKey = req.headers['x-idempotency-key'] as string | undefined;
    const idempotencyKey = clientKey || generateIdempotencyKey(bookingData);

    // 3. Check for existing result (idempotency)
    const existingResult = await idempotencyService.getResult(idempotencyKey);
    if (existingResult) {
      // Return cached result (same request was already processed)
      return res.status(200).json(existingResult);
    }

    // 4. Acquire idempotency lock
    const lockAcquired = await idempotencyService.acquireLock(idempotencyKey);
    if (!lockAcquired) {
      // Another request with same key is in progress
      return res.status(409).json({
        code: ErrorCodes.IDEMPOTENCY_CONFLICT,
        message: 'Duplicate request in progress, please retry',
      });
    }

    try {
      // 5. Create the booking
      const result = await bookingService.createBooking({
        meetingTypeId: bookingData.meetingTypeId,
        startTime: new Date(bookingData.startTime),
        inviteeName: bookingData.inviteeName,
        inviteeEmail: bookingData.inviteeEmail,
        inviteeTimezone: bookingData.inviteeTimezone,
        notes: bookingData.notes,
        idempotencyKey,
      });

      // 6. Cache result for idempotency (1 hour TTL)
      await idempotencyService.storeResult(idempotencyKey, result);

      // 7. Return success response
      return res.status(201).json(result);

    } finally {
      // 8. Release idempotency lock
      await idempotencyService.releaseLock(idempotencyKey);
    }

  } catch (error: any) {
    // Handle known business errors
    if (error.code === ErrorCodes.SLOT_UNAVAILABLE) {
      return res.status(409).json({
        code: error.code,
        message: error.message,
        details: { alternativeSlots: error.alternativeSlots },
      });
    }

    if (error.code === ErrorCodes.MAX_BOOKINGS_REACHED) {
      return res.status(422).json({
        code: error.code,
        message: error.message,
      });
    }

    next(error);
  }
});

function generateIdempotencyKey(data: BookingRequest): string {
  const input = `${data.meetingTypeId}:${data.startTime}:${data.inviteeEmail}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

export default router;
```

### Frontend Booking Submission

```typescript
// frontend/src/hooks/useBookingFlow.ts

import { useState, useCallback } from 'react';
import { api } from '../services/api';
import { useAvailabilityStore } from '../stores/availabilityStore';
import type { CreateBookingRequest, CreateBookingResponse, TimeSlot } from '../types';

interface BookingFormData {
  meetingTypeId: string;
  slot: TimeSlot;
  inviteeName: string;
  inviteeEmail: string;
  timezone: string;
  notes?: string;
}

interface UseBookingFlowResult {
  submitBooking: (data: BookingFormData) => Promise<CreateBookingResponse>;
  isSubmitting: boolean;
  error: string | null;
  conflictSlots: TimeSlot[] | null;
}

export function useBookingFlow(): UseBookingFlowResult {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictSlots, setConflictSlots] = useState<TimeSlot[] | null>(null);
  const invalidateCache = useAvailabilityStore((s) => s.invalidateCache);

  const submitBooking = useCallback(async (data: BookingFormData) => {
    setIsSubmitting(true);
    setError(null);
    setConflictSlots(null);

    // Generate client-side idempotency key
    const idempotencyKey = `${data.meetingTypeId}:${data.slot.startTime}:${data.inviteeEmail}:${Date.now()}`;

    try {
      // Step 1: Pre-check slot availability (optimistic check)
      const checkResult = await api.checkSlotAvailability(
        data.meetingTypeId,
        new Date(data.slot.startTime)
      );

      if (!checkResult.available) {
        setConflictSlots(checkResult.alternativeSlots || []);
        throw new Error('This slot was just booked by someone else');
      }

      // Step 2: Submit booking with idempotency key
      const request: CreateBookingRequest = {
        meetingTypeId: data.meetingTypeId,
        startTime: data.slot.startTime,
        inviteeName: data.inviteeName,
        inviteeEmail: data.inviteeEmail,
        inviteeTimezone: data.timezone,
        notes: data.notes,
      };

      const result = await api.createBooking(request, idempotencyKey);

      // Step 3: Invalidate availability cache
      invalidateCache(data.meetingTypeId);

      return result;

    } catch (err: any) {
      // Handle 409 Conflict (slot taken between pre-check and submit)
      if (err.status === 409 && err.code === 'SLOT_UNAVAILABLE') {
        setError('This slot was just booked. Please select another time.');
        setConflictSlots(err.alternativeSlots || []);
        invalidateCache(data.meetingTypeId);
      } else {
        setError(err.message || 'Failed to create booking');
      }
      throw err;

    } finally {
      setIsSubmitting(false);
    }
  }, [invalidateCache]);

  return {
    submitBooking,
    isSubmitting,
    error,
    conflictSlots,
  };
}
```

---

## Step 6: Time Zone Handling (End-to-End)

### Storage Strategy

```
┌──────────────────────────────────────────────────────────────────┐
│                     TIME ZONE HANDLING                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  DATABASE: All timestamps stored in UTC                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ bookings.start_time = '2024-01-15T19:00:00Z' (UTC)      │    │
│  │ bookings.invitee_timezone = 'America/New_York'          │    │
│  │ users.time_zone = 'Europe/London' (host)                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  API: Returns UTC, accepts UTC                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ GET /availability → slots in UTC                        │    │
│  │ POST /bookings → startTime in UTC                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  FRONTEND: Converts UTC to local for display                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Auto-detect: Intl.DateTimeFormat().resolvedOptions()    │    │
│  │ Display: new Date(utc).toLocaleString('en-US', {        │    │
│  │            timeZone: 'America/New_York' })              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Backend Time Zone Utilities

```typescript
// backend/src/utils/time.ts

/**
 * Convert a local time string (HH:MM) on a specific date in a timezone to UTC
 */
export function localTimeToUTC(
  date: Date,
  timeString: string, // "09:00"
  timezone: string    // "America/New_York"
): Date {
  const [hours, minutes] = timeString.split(':').map(Number);

  // Create a date string in the target timezone
  const localDate = new Date(date);
  localDate.setHours(hours, minutes, 0, 0);

  // Use Intl to get the UTC offset for this timezone at this date
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Parse back to create UTC date
  const parts = formatter.formatToParts(localDate);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

  const isoString = `${getPart('year')}-${getPart('month')}-${getPart('day')}T${timeString}:00`;

  // Get UTC offset and adjust
  const tempDate = new Date(isoString);
  const utcDate = new Date(tempDate.toLocaleString('en-US', { timeZone: 'UTC' }));
  const localDateInTz = new Date(tempDate.toLocaleString('en-US', { timeZone: timezone }));
  const offset = localDateInTz.getTime() - utcDate.getTime();

  return new Date(localDate.getTime() - offset);
}

/**
 * Format a UTC date for display in a specific timezone
 */
export function formatForTimezone(
  utcDate: Date,
  timezone: string,
  format: 'time' | 'date' | 'datetime' = 'datetime'
): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone };

  switch (format) {
    case 'time':
      options.hour = 'numeric';
      options.minute = '2-digit';
      options.hour12 = true;
      break;
    case 'date':
      options.weekday = 'long';
      options.month = 'long';
      options.day = 'numeric';
      options.year = 'numeric';
      break;
    case 'datetime':
      options.weekday = 'short';
      options.month = 'short';
      options.day = 'numeric';
      options.hour = 'numeric';
      options.minute = '2-digit';
      options.hour12 = true;
      options.timeZoneName = 'short';
      break;
  }

  return new Intl.DateTimeFormat('en-US', options).format(utcDate);
}
```

### Frontend Time Zone Hook

```typescript
// frontend/src/hooks/useTimezone.ts

import { useState, useCallback, useMemo } from 'react';

export function useTimezone() {
  const autoDetected = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );

  const [timezone, setTimezone] = useState<string>(() => {
    return localStorage.getItem('preferred_timezone') || autoDetected;
  });

  const setAndPersist = useCallback((tz: string) => {
    setTimezone(tz);
    localStorage.setItem('preferred_timezone', tz);
  }, []);

  // Convert UTC to display time (no refetch needed)
  const formatTime = useCallback((utcIso: string) => {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    }).format(new Date(utcIso));
  }, [timezone]);

  // Check if time is outside 6am-10pm in guest's timezone
  const isUnusualHour = useCallback((utcIso: string) => {
    const date = new Date(utcIso);
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone,
      }).format(date)
    );
    return hour < 6 || hour >= 22;
  }, [timezone]);

  return {
    timezone,
    autoDetected,
    setTimezone: setAndPersist,
    formatTime,
    isUnusualHour,
  };
}
```

---

## Step 7: Conflict Prevention (End-to-End)

### Frontend Pre-Check + Backend Validation

```typescript
// Frontend: Pre-check before form submission
async function handleSlotSelect(slot: TimeSlot) {
  // Quick availability check (catches 95% of conflicts)
  const { available } = await api.checkSlotAvailability(
    meetingTypeId,
    new Date(slot.startTime)
  );

  if (!available) {
    showToast('This slot was just booked. Refreshing available times...');
    await refreshAvailability();
    return;
  }

  // Slot looks available, proceed to form
  setSelectedSlot(slot);
  setStep('form');
}

// Frontend: Handle 409 on submission
async function handleSubmit(formData: FormData) {
  try {
    const result = await api.createBooking({
      meetingTypeId,
      startTime: selectedSlot.startTime,
      inviteeName: formData.name,
      inviteeEmail: formData.email,
      inviteeTimezone: timezone,
    }, idempotencyKey);

    setStep('confirmation');
  } catch (error) {
    if (error.status === 409) {
      // Race condition: slot was booked between pre-check and submit
      showModal({
        title: 'Slot No Longer Available',
        message: 'Someone just booked this time. Here are alternatives:',
        alternatives: error.alternativeSlots,
        onSelectAlternative: handleSlotSelect,
      });
      refreshAvailability();
    }
  }
}
```

### Backend Multi-Layer Protection

```typescript
// backend/src/services/bookingService.ts

async createBooking(request: BookingRequest): Promise<CreateBookingResponse> {
  // Layer 1: Idempotency check (handled in route)

  // Layer 2: Distributed lock
  const lockKey = `booking:${request.hostUserId}`;
  const lock = await this.cache.acquireLock(lockKey, 5000);
  if (!lock) throw new RetryableError('Please retry');

  try {
    return await this.pool.transaction(async (tx) => {
      // Layer 3: Row-level lock
      await tx.query(
        'SELECT 1 FROM users WHERE id = $1 FOR UPDATE',
        [request.hostUserId]
      );

      // Layer 4: Explicit conflict check
      const conflicts = await tx.query(`
        SELECT id FROM bookings
        WHERE host_user_id = $1
          AND status = 'confirmed'
          AND start_time < $2
          AND end_time > $3
      `, [request.hostUserId, request.endTime, request.startTime]);

      if (conflicts.rows.length > 0) {
        // Get alternative slots for better UX
        const alternatives = await this.getAlternativeSlots(
          request.meetingTypeId,
          request.startTime
        );
        throw new SlotUnavailableError(alternatives);
      }

      // Layer 5: Insert with unique partial index
      const booking = await tx.query(`
        INSERT INTO bookings (
          meeting_type_id, host_user_id, invitee_name, invitee_email,
          start_time, end_time, invitee_timezone, status, idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8)
        RETURNING *
      `, [/* ... */]);

      // Queue notification
      await this.notificationQueue.publish({
        type: 'confirmation',
        bookingId: booking.rows[0].id,
      });

      // Invalidate cache
      await this.cache.del(`availability:${request.hostUserId}:*`);

      return this.formatResponse(booking.rows[0]);
    });
  } finally {
    await this.cache.releaseLock(lockKey);
  }
}
```

---

## Step 8: Authentication Flow

### Session-Based Auth

```typescript
// backend/src/routes/auth.ts

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (!user.rows[0]) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.rows[0].password_hash);
  if (!valid) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  // Create session in Redis
  const sessionId = crypto.randomUUID();
  await cache.set(
    `session:${sessionId}`,
    JSON.stringify({ userId: user.rows[0].id }),
    7 * 24 * 60 * 60 // 7 days
  );

  res.cookie('calendly_session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({
    user: {
      id: user.rows[0].id,
      email: user.rows[0].email,
      name: user.rows[0].name,
      timezone: user.rows[0].time_zone,
    },
  });
});

// Auth middleware
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const sessionId = req.cookies.calendly_session;
  if (!sessionId) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  const session = await cache.get(`session:${sessionId}`);
  if (!session) {
    return res.status(401).json({ message: 'Session expired' });
  }

  req.userId = JSON.parse(session).userId;
  next();
}
```

### Frontend Auth Store

```typescript
// frontend/src/stores/authStore.ts

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../services/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: true,

      login: async (email, password) => {
        const response = await api.post('/auth/login', { email, password });
        set({ user: response.data.user });
      },

      logout: async () => {
        await api.post('/auth/logout');
        set({ user: null });
      },

      checkAuth: async () => {
        try {
          const response = await api.get('/auth/me');
          set({ user: response.data.user, isLoading: false });
        } catch {
          set({ user: null, isLoading: false });
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user }),
    }
  )
);
```

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
