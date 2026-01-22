# Calendly - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction

"Today I'll design a meeting scheduling platform like Calendly, focusing on the frontend architecture. The key challenges include building an intuitive booking flow for guests, handling time zone complexity in the UI, creating responsive calendar and time slot components, and optimizing for the 100:1 availability check to booking ratio. I'll walk through the component architecture, state management, and user experience considerations."

---

## Step 1: Requirements Clarification

### User-Facing Requirements

1. **Guest Booking Experience**: View available slots, select time, submit booking form
2. **Host Dashboard**: Manage meeting types, availability rules, view bookings
3. **Calendar Interface**: Month view navigation, date selection, availability indicators
4. **Time Zone Handling**: Auto-detect guest timezone, allow switching, instant re-render
5. **Responsive Design**: Desktop, tablet, and mobile layouts
6. **Accessibility**: Screen reader support, keyboard navigation

### Technical Requirements

- **Performance**: Availability checks < 200ms, instant timezone switching
- **Offline Resilience**: Graceful degradation when network is slow
- **Caching**: Client-side caching of availability data (3-5 minute TTL)
- **Internationalization**: Support multiple locales and time formats

---

## Step 2: Component Architecture

### Directory Structure

```
frontend/src/
├── components/
│   ├── icons/                    # SVG icon components
│   │   ├── index.ts              # Barrel export
│   │   ├── CalendarIcon.tsx
│   │   ├── ClockIcon.tsx
│   │   ├── ChevronLeftIcon.tsx
│   │   ├── ChevronRightIcon.tsx
│   │   └── TimezoneIcon.tsx
│   ├── booking/                  # Guest booking flow
│   │   ├── index.ts
│   │   ├── EventHeader.tsx
│   │   ├── TimezoneSelector.tsx
│   │   ├── BookingCalendar.tsx
│   │   ├── TimeSlotList.tsx
│   │   ├── BookingForm.tsx
│   │   ├── ConfirmationScreen.tsx
│   │   └── SlotUnavailable.tsx
│   ├── meeting-types/            # Meeting type management
│   │   ├── index.ts
│   │   ├── MeetingTypeCard.tsx
│   │   ├── MeetingTypeModal.tsx
│   │   └── MeetingTypesEmptyState.tsx
│   ├── availability/             # Availability rule settings
│   │   ├── index.ts
│   │   ├── WeeklySchedule.tsx
│   │   ├── DayRuleEditor.tsx
│   │   └── TimeRangeInput.tsx
│   ├── CalendarPicker.tsx        # Reusable date picker
│   ├── LoadingSpinner.tsx
│   ├── Navbar.tsx
│   └── TimeSlotPicker.tsx
├── routes/                       # Page components (TanStack Router)
│   ├── __root.tsx
│   ├── index.tsx
│   ├── login.tsx
│   ├── register.tsx
│   ├── dashboard.tsx
│   ├── meeting-types.tsx
│   ├── availability.tsx
│   ├── bookings.tsx
│   ├── bookings.$bookingId.tsx
│   ├── book.$meetingTypeId.tsx   # Public booking page
│   └── admin.tsx
├── stores/                       # Zustand state stores
│   ├── authStore.ts
│   ├── bookingStore.ts
│   └── availabilityStore.ts
├── services/
│   └── api.ts                    # REST API client
├── hooks/
│   ├── useTimezone.ts
│   ├── useAvailability.ts
│   └── useBookingFlow.ts
├── utils/
│   ├── time.ts                   # Time/timezone utilities
│   └── validation.ts
└── types/
    └── index.ts
```

---

## Step 3: Deep Dive - Guest Booking Flow

### Progressive Disclosure Pattern

"The booking page uses progressive disclosure to reduce cognitive load. Each step reveals only after the previous is completed."

```
Step 1: Calendar (low commitment)
    ↓ User selects date
Step 2: Time slots appear
    ↓ User selects time
Step 3: Booking form slides in
    ↓ User submits form
Step 4: Confirmation screen
```

### Booking Page Component

```tsx
// routes/book.$meetingTypeId.tsx

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import {
  EventHeader,
  TimezoneSelector,
  BookingCalendar,
  TimeSlotList,
  BookingForm,
  ConfirmationScreen,
  SlotUnavailable,
} from '../components/booking';
import { useAvailability } from '../hooks/useAvailability';
import { useTimezone } from '../hooks/useTimezone';
import { useBookingFlow } from '../hooks/useBookingFlow';

export const Route = createFileRoute('/book/$meetingTypeId')({
  component: BookingPage,
});

type BookingStep = 'calendar' | 'time' | 'form' | 'confirmation' | 'unavailable';

function BookingPage() {
  const { meetingTypeId } = Route.useParams();
  const { timezone, setTimezone, autoDetectedTimezone } = useTimezone();
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [step, setStep] = useState<BookingStep>('calendar');

  const {
    meetingType,
    availableSlots,
    isLoading,
    error,
    refreshAvailability,
  } = useAvailability(meetingTypeId, selectedDate, timezone);

  const { createBooking, isSubmitting, bookingResult } = useBookingFlow();

  // Handle date selection
  const handleDateSelect = (date: Date) => {
    setSelectedDate(date);
    setSelectedSlot(null);
    setStep('time');
  };

  // Handle slot selection
  const handleSlotSelect = (slot: TimeSlot) => {
    setSelectedSlot(slot);
    setStep('form');
  };

  // Handle form submission
  const handleSubmit = async (formData: BookingFormData) => {
    if (!selectedSlot) return;

    try {
      await createBooking({
        meetingTypeId,
        startTime: selectedSlot.startTime,
        ...formData,
      });
      setStep('confirmation');
    } catch (error) {
      if (error.status === 409) {
        // Slot was taken
        setStep('unavailable');
        refreshAvailability();
      } else {
        throw error;
      }
    }
  };

  // Handle timezone change - instant re-render, no refetch
  const handleTimezoneChange = (newTimezone: string) => {
    setTimezone(newTimezone);
    // Slots are stored in UTC, just re-render with new timezone
  };

  if (!meetingType) {
    return <LoadingSpinner />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 lg:p-8">
        {/* Event Header - Always visible */}
        <EventHeader
          hostName={meetingType.userName}
          hostAvatar={meetingType.userAvatar}
          eventTitle={meetingType.name}
          duration={meetingType.durationMinutes}
          description={meetingType.description}
        />

        {/* Timezone Selector */}
        <TimezoneSelector
          selectedTimezone={timezone}
          autoDetectedTimezone={autoDetectedTimezone}
          onChange={handleTimezoneChange}
          className="mt-4"
        />

        {/* Main Content - Progressive Disclosure */}
        <div className="mt-6 bg-white rounded-lg shadow-sm p-4 sm:p-6">
          {step === 'calendar' && (
            <BookingCalendar
              meetingTypeId={meetingTypeId}
              selectedDate={selectedDate}
              onDateSelect={handleDateSelect}
              timezone={timezone}
            />
          )}

          {step === 'time' && selectedDate && (
            <>
              <BookingCalendar
                meetingTypeId={meetingTypeId}
                selectedDate={selectedDate}
                onDateSelect={handleDateSelect}
                timezone={timezone}
                compact
              />
              <TimeSlotList
                slots={availableSlots}
                selectedSlot={selectedSlot}
                onSlotSelect={handleSlotSelect}
                isLoading={isLoading}
                timezone={timezone}
                className="mt-4"
              />
            </>
          )}

          {step === 'form' && selectedSlot && (
            <BookingForm
              slot={selectedSlot}
              timezone={timezone}
              onSubmit={handleSubmit}
              onBack={() => setStep('time')}
              isSubmitting={isSubmitting}
            />
          )}

          {step === 'confirmation' && bookingResult && (
            <ConfirmationScreen
              booking={bookingResult}
              hostTimezone={meetingType.userTimezone}
              guestTimezone={timezone}
            />
          )}

          {step === 'unavailable' && (
            <SlotUnavailable
              onSelectAnother={() => {
                setSelectedSlot(null);
                setStep('time');
              }}
              alternativeSlots={availableSlots.slice(0, 3)}
              timezone={timezone}
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

---

## Step 4: Deep Dive - Timezone Handling

### Timezone Hook

```tsx
// hooks/useTimezone.ts

import { useState, useEffect, useCallback } from 'react';

interface UseTimezoneResult {
  timezone: string;
  setTimezone: (tz: string) => void;
  autoDetectedTimezone: string;
  formatTime: (utcDate: Date | string) => string;
  formatDate: (utcDate: Date | string) => string;
  formatDatetime: (utcDate: Date | string) => string;
  isUnusualHour: (utcDate: Date | string) => boolean;
}

export function useTimezone(): UseTimezoneResult {
  // Auto-detect timezone on mount
  const autoDetectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Load saved preference or use auto-detected
  const [timezone, setTimezoneState] = useState<string>(() => {
    const saved = localStorage.getItem('preferred_timezone');
    return saved || autoDetectedTimezone;
  });

  // Persist preference
  const setTimezone = useCallback((tz: string) => {
    setTimezoneState(tz);
    localStorage.setItem('preferred_timezone', tz);
  }, []);

  // Format time in selected timezone
  const formatTime = useCallback((utcDate: Date | string): string => {
    const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    }).format(date);
  }, [timezone]);

  // Format date in selected timezone
  const formatDate = useCallback((utcDate: Date | string): string => {
    const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: timezone,
    }).format(date);
  }, [timezone]);

  // Format both date and time
  const formatDatetime = useCallback((utcDate: Date | string): string => {
    const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
      timeZoneName: 'short',
    }).format(date);
  }, [timezone]);

  // Check if time is outside typical working hours (6am - 10pm)
  const isUnusualHour = useCallback((utcDate: Date | string): boolean => {
    const date = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
    const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    const hour = localDate.getHours();
    return hour < 6 || hour >= 22;
  }, [timezone]);

  return {
    timezone,
    setTimezone,
    autoDetectedTimezone,
    formatTime,
    formatDate,
    formatDatetime,
    isUnusualHour,
  };
}
```

### Timezone Selector Component

```tsx
// components/booking/TimezoneSelector.tsx

import { useState, useMemo } from 'react';
import { TimezoneIcon, ChevronDownIcon } from '../icons';

interface TimezoneSelectorProps {
  selectedTimezone: string;
  autoDetectedTimezone: string;
  onChange: (timezone: string) => void;
  className?: string;
}

// Common timezones for quick selection
const COMMON_TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'Europe/London', label: 'GMT/BST' },
  { value: 'Europe/Paris', label: 'Central European (CET)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
];

export function TimezoneSelector({
  selectedTimezone,
  autoDetectedTimezone,
  onChange,
  className = '',
}: TimezoneSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Get current offset for display
  const currentOffset = useMemo(() => {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: selectedTimezone,
      timeZoneName: 'short',
    });
    const parts = formatter.formatToParts(now);
    return parts.find(p => p.type === 'timeZoneName')?.value || '';
  }, [selectedTimezone]);

  // Find display label for selected timezone
  const displayLabel = useMemo(() => {
    const common = COMMON_TIMEZONES.find(tz => tz.value === selectedTimezone);
    if (common) return common.label;
    return selectedTimezone.replace(/_/g, ' ').split('/').pop() || selectedTimezone;
  }, [selectedTimezone]);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900
                   px-3 py-2 rounded-lg hover:bg-gray-100 transition-colors"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <TimezoneIcon className="w-4 h-4" />
        <span>{displayLabel}</span>
        <span className="text-gray-400">({currentOffset})</span>
        <ChevronDownIcon className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div
            className="absolute top-full left-0 mt-1 w-64 bg-white rounded-lg shadow-lg
                       border border-gray-200 py-1 z-20"
            role="listbox"
          >
            {/* Auto-detected option */}
            {selectedTimezone !== autoDetectedTimezone && (
              <button
                onClick={() => {
                  onChange(autoDetectedTimezone);
                  setIsOpen(false);
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50
                           flex items-center justify-between"
              >
                <span>Use detected timezone</span>
                <span className="text-gray-400 text-xs">
                  {autoDetectedTimezone.split('/').pop()?.replace(/_/g, ' ')}
                </span>
              </button>
            )}

            {/* Divider */}
            {selectedTimezone !== autoDetectedTimezone && (
              <div className="border-t border-gray-100 my-1" />
            )}

            {/* Common timezones */}
            {COMMON_TIMEZONES.map((tz) => (
              <button
                key={tz.value}
                onClick={() => {
                  onChange(tz.value);
                  setIsOpen(false);
                }}
                className={`w-full px-4 py-2 text-left text-sm hover:bg-gray-50
                           flex items-center justify-between
                           ${selectedTimezone === tz.value ? 'bg-blue-50 text-blue-700' : ''}`}
                role="option"
                aria-selected={selectedTimezone === tz.value}
              >
                <span>{tz.label}</span>
                {selectedTimezone === tz.value && (
                  <span className="text-blue-600">&#10003;</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

---

## Step 5: Deep Dive - Calendar Component

### Booking Calendar

```tsx
// components/booking/BookingCalendar.tsx

import { useState, useMemo } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from '../icons';

interface BookingCalendarProps {
  meetingTypeId: string;
  selectedDate: Date | null;
  onDateSelect: (date: Date) => void;
  timezone: string;
  compact?: boolean;
}

export function BookingCalendar({
  meetingTypeId,
  selectedDate,
  onDateSelect,
  timezone,
  compact = false,
}: BookingCalendarProps) {
  const [viewMonth, setViewMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  // Pre-fetch availability for visible month
  const { availableDates, isLoading } = useMonthAvailability(
    meetingTypeId,
    viewMonth,
    timezone
  );

  // Generate calendar grid
  const calendarDays = useMemo(() => {
    const days: CalendarDay[] = [];
    const firstDay = new Date(viewMonth);
    const lastDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);

    // Add padding days from previous month
    const startPadding = firstDay.getDay();
    for (let i = startPadding - 1; i >= 0; i--) {
      const date = new Date(firstDay);
      date.setDate(date.getDate() - i - 1);
      days.push({ date, isPadding: true, hasAvailability: false });
    }

    // Add days of current month
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const date = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d);
      const dateKey = date.toISOString().split('T')[0];
      const isPast = date < new Date(new Date().setHours(0, 0, 0, 0));
      days.push({
        date,
        isPadding: false,
        hasAvailability: !isPast && availableDates.includes(dateKey),
        isPast,
      });
    }

    // Add padding days for next month
    const endPadding = 42 - days.length; // 6 rows * 7 days
    for (let i = 1; i <= endPadding; i++) {
      const date = new Date(lastDay);
      date.setDate(date.getDate() + i);
      days.push({ date, isPadding: true, hasAvailability: false });
    }

    return days;
  }, [viewMonth, availableDates]);

  const handlePrevMonth = () => {
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));
  };

  // Prevent navigating to past months
  const canGoPrev = viewMonth > new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  return (
    <div className={compact ? 'max-w-sm' : ''}>
      {/* Month Navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handlePrevMonth}
          disabled={!canGoPrev}
          className={`p-2 rounded-full hover:bg-gray-100
                     ${!canGoPrev ? 'opacity-50 cursor-not-allowed' : ''}`}
          aria-label="Previous month"
        >
          <ChevronLeftIcon className="w-5 h-5" />
        </button>

        <h2 className="text-lg font-semibold">
          {viewMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
        </h2>

        <button
          onClick={handleNextMonth}
          className="p-2 rounded-full hover:bg-gray-100"
          aria-label="Next month"
        >
          <ChevronRightIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Weekday Headers */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <div
            key={day}
            className="text-center text-xs font-medium text-gray-500 py-2"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7 gap-1">
        {calendarDays.map((day, index) => {
          const isSelected = selectedDate &&
            day.date.toDateString() === selectedDate.toDateString();
          const isToday = day.date.toDateString() === new Date().toDateString();

          return (
            <button
              key={index}
              onClick={() => day.hasAvailability && onDateSelect(day.date)}
              disabled={!day.hasAvailability || day.isPadding}
              className={`
                aspect-square flex items-center justify-center rounded-full text-sm
                transition-colors relative
                ${day.isPadding ? 'text-gray-300' : ''}
                ${day.isPast ? 'text-gray-300 cursor-not-allowed' : ''}
                ${day.hasAvailability && !isSelected
                  ? 'text-gray-900 hover:bg-blue-50 cursor-pointer font-medium'
                  : ''
                }
                ${!day.hasAvailability && !day.isPadding && !day.isPast
                  ? 'text-gray-400 cursor-not-allowed'
                  : ''
                }
                ${isSelected
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : ''
                }
                ${isToday && !isSelected
                  ? 'ring-2 ring-blue-200 ring-inset'
                  : ''
                }
              `}
              aria-label={`${day.date.toLocaleDateString()}, ${
                day.hasAvailability ? 'available' : 'unavailable'
              }`}
            >
              {day.date.getDate()}
              {/* Availability dot indicator */}
              {day.hasAvailability && !isSelected && (
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2
                                 w-1 h-1 bg-blue-600 rounded-full" />
              )}
            </button>
          );
        })}
      </div>

      {isLoading && (
        <div className="absolute inset-0 bg-white/50 flex items-center justify-center">
          <LoadingSpinner size="sm" />
        </div>
      )}
    </div>
  );
}
```

---

## Step 6: Deep Dive - Time Slot List

### Time Slot Component

```tsx
// components/booking/TimeSlotList.tsx

import { useMemo } from 'react';
import { ClockIcon, WarningIcon } from '../icons';
import { useTimezone } from '../../hooks/useTimezone';

interface TimeSlot {
  startTime: string; // ISO UTC
  endTime: string;   // ISO UTC
}

interface TimeSlotListProps {
  slots: TimeSlot[];
  selectedSlot: TimeSlot | null;
  onSlotSelect: (slot: TimeSlot) => void;
  isLoading: boolean;
  timezone: string;
  className?: string;
}

export function TimeSlotList({
  slots,
  selectedSlot,
  onSlotSelect,
  isLoading,
  timezone,
  className = '',
}: TimeSlotListProps) {
  const { formatTime, isUnusualHour } = useTimezone();

  // Group slots by morning/afternoon/evening
  const groupedSlots = useMemo(() => {
    const groups = {
      morning: [] as TimeSlot[],
      afternoon: [] as TimeSlot[],
      evening: [] as TimeSlot[],
    };

    slots.forEach((slot) => {
      const date = new Date(slot.startTime);
      const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
      const hour = localDate.getHours();

      if (hour < 12) {
        groups.morning.push(slot);
      } else if (hour < 17) {
        groups.afternoon.push(slot);
      } else {
        groups.evening.push(slot);
      }
    });

    return groups;
  }, [slots, timezone]);

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center py-8 ${className}`}>
        <LoadingSpinner />
        <span className="ml-2 text-gray-500">Loading available times...</span>
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <div className={`text-center py-8 ${className}`}>
        <ClockIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
        <p className="text-gray-500">No available times for this date.</p>
        <p className="text-sm text-gray-400 mt-1">Try selecting a different date.</p>
      </div>
    );
  }

  const isSelected = (slot: TimeSlot) =>
    selectedSlot?.startTime === slot.startTime;

  const renderSlotGroup = (title: string, groupSlots: TimeSlot[]) => {
    if (groupSlots.length === 0) return null;

    return (
      <div className="mb-4">
        <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
          {title}
        </h4>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {groupSlots.map((slot) => {
            const unusual = isUnusualHour(slot.startTime);
            const selected = isSelected(slot);

            return (
              <button
                key={slot.startTime}
                onClick={() => onSlotSelect(slot)}
                className={`
                  px-3 py-2 rounded-lg text-sm font-medium transition-all
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
                  ${selected
                    ? 'bg-blue-600 text-white shadow-md scale-105'
                    : 'bg-gray-50 text-gray-900 hover:bg-blue-50 hover:text-blue-700 border border-gray-200'
                  }
                `}
                aria-pressed={selected}
              >
                <span className="flex items-center justify-center gap-1">
                  {formatTime(slot.startTime)}
                  {unusual && !selected && (
                    <WarningIcon
                      className="w-3 h-3 text-amber-500"
                      title="Outside typical hours"
                    />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={className}>
      <h3 className="text-sm font-medium text-gray-700 mb-4">
        Select a time
      </h3>
      {renderSlotGroup('Morning', groupedSlots.morning)}
      {renderSlotGroup('Afternoon', groupedSlots.afternoon)}
      {renderSlotGroup('Evening', groupedSlots.evening)}
    </div>
  );
}
```

---

## Step 7: State Management

### Availability Store

```typescript
// stores/availabilityStore.ts

import { create } from 'zustand';
import { api } from '../services/api';

interface AvailabilityCache {
  data: Record<string, TimeSlot[]>; // dateKey -> slots
  timestamp: number;
  meetingTypeId: string;
}

interface AvailabilityState {
  cache: Map<string, AvailabilityCache>;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchAvailability: (
    meetingTypeId: string,
    startDate: Date,
    endDate: Date
  ) => Promise<Record<string, TimeSlot[]>>;
  getAvailability: (
    meetingTypeId: string,
    date: Date
  ) => TimeSlot[] | null;
  invalidateCache: (meetingTypeId: string) => void;
  clearCache: () => void;
}

const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

export const useAvailabilityStore = create<AvailabilityState>((set, get) => ({
  cache: new Map(),
  isLoading: false,
  error: null,

  fetchAvailability: async (meetingTypeId, startDate, endDate) => {
    const cacheKey = `${meetingTypeId}:${startDate.toISOString().split('T')[0]}:${endDate.toISOString().split('T')[0]}`;
    const cached = get().cache.get(cacheKey);

    // Return cached data if still fresh
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    set({ isLoading: true, error: null });

    try {
      const response = await api.get('/availability', {
        params: {
          meeting_type_id: meetingTypeId,
          start_date: startDate.toISOString(),
          end_date: endDate.toISOString(),
        },
      });

      const data = response.data.slots;

      // Update cache
      set((state) => {
        const newCache = new Map(state.cache);
        newCache.set(cacheKey, {
          data,
          timestamp: Date.now(),
          meetingTypeId,
        });
        return { cache: newCache, isLoading: false };
      });

      return data;
    } catch (error) {
      set({ error: error.message, isLoading: false });
      throw error;
    }
  },

  getAvailability: (meetingTypeId, date) => {
    const dateKey = date.toISOString().split('T')[0];

    // Search all cached entries for this meeting type
    for (const [, cached] of get().cache) {
      if (cached.meetingTypeId === meetingTypeId && cached.data[dateKey]) {
        if (Date.now() - cached.timestamp < CACHE_TTL) {
          return cached.data[dateKey];
        }
      }
    }

    return null;
  },

  invalidateCache: (meetingTypeId) => {
    set((state) => {
      const newCache = new Map(state.cache);
      for (const [key, value] of newCache) {
        if (value.meetingTypeId === meetingTypeId) {
          newCache.delete(key);
        }
      }
      return { cache: newCache };
    });
  },

  clearCache: () => {
    set({ cache: new Map() });
  },
}));
```

### Booking Flow Hook

```typescript
// hooks/useBookingFlow.ts

import { useState, useCallback } from 'react';
import { api } from '../services/api';
import { useAvailabilityStore } from '../stores/availabilityStore';

interface BookingRequest {
  meetingTypeId: string;
  startTime: string;
  inviteeName: string;
  inviteeEmail: string;
  notes?: string;
}

interface BookingResult {
  id: string;
  startTime: string;
  endTime: string;
  hostName: string;
  meetingTypeName: string;
}

export function useBookingFlow() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bookingResult, setBookingResult] = useState<BookingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidateCache = useAvailabilityStore((state) => state.invalidateCache);

  const createBooking = useCallback(async (request: BookingRequest) => {
    setIsSubmitting(true);
    setError(null);

    // Generate idempotency key to prevent duplicate submissions
    const idempotencyKey = `${request.meetingTypeId}:${request.startTime}:${request.inviteeEmail}:${Date.now()}`;

    try {
      // Pre-check: Verify slot is still available (optimistic check)
      const checkResponse = await api.get('/availability/check', {
        params: {
          meeting_type_id: request.meetingTypeId,
          start_time: request.startTime,
        },
      });

      if (!checkResponse.data.available) {
        const err = new Error('This slot was just booked');
        (err as any).status = 409;
        throw err;
      }

      // Create booking
      const response = await api.post('/bookings', request, {
        headers: {
          'X-Idempotency-Key': idempotencyKey,
        },
      });

      const result = response.data;
      setBookingResult(result);

      // Invalidate cache to force refresh
      invalidateCache(request.meetingTypeId);

      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  }, [invalidateCache]);

  const reset = useCallback(() => {
    setBookingResult(null);
    setError(null);
    setIsSubmitting(false);
  }, []);

  return {
    createBooking,
    isSubmitting,
    bookingResult,
    error,
    reset,
  };
}
```

---

## Step 8: Confirmation Screen

### Dual Timezone Display

```tsx
// components/booking/ConfirmationScreen.tsx

import { CheckCircleIcon, CalendarIcon } from '../icons';
import { useTimezone } from '../../hooks/useTimezone';

interface ConfirmationScreenProps {
  booking: {
    id: string;
    startTime: string;
    endTime: string;
    hostName: string;
    meetingTypeName: string;
    duration: number;
  };
  hostTimezone: string;
  guestTimezone: string;
}

export function ConfirmationScreen({
  booking,
  hostTimezone,
  guestTimezone,
}: ConfirmationScreenProps) {
  const { formatDatetime } = useTimezone();

  // Format time in both timezones
  const guestTime = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: guestTimezone,
    timeZoneName: 'short',
  }).format(new Date(booking.startTime));

  const hostTime = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: hostTimezone,
    timeZoneName: 'short',
  }).format(new Date(booking.startTime));

  // Generate calendar links
  const calendarLinks = generateCalendarLinks(booking);

  return (
    <div className="text-center py-8">
      {/* Success Icon */}
      <div className="mb-6">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
          <CheckCircleIcon className="w-10 h-10 text-green-600" />
        </div>
      </div>

      {/* Confirmation Message */}
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        You're Confirmed!
      </h2>
      <p className="text-gray-600 mb-8">
        A calendar invitation has been sent to your email.
      </p>

      {/* Meeting Details Card */}
      <div className="bg-gray-50 rounded-lg p-6 text-left max-w-md mx-auto mb-8">
        <h3 className="font-semibold text-lg mb-1">{booking.meetingTypeName}</h3>
        <p className="text-gray-600 mb-4">with {booking.hostName}</p>

        <div className="space-y-3">
          {/* Guest's timezone */}
          <div className="flex items-start gap-3">
            <CalendarIcon className="w-5 h-5 text-gray-400 mt-0.5" />
            <div>
              <p className="font-medium text-gray-900">Your Time</p>
              <p className="text-gray-600">{guestTime}</p>
            </div>
          </div>

          {/* Host's timezone (if different) */}
          {guestTimezone !== hostTimezone && (
            <div className="flex items-start gap-3 text-sm">
              <div className="w-5" /> {/* Spacer for alignment */}
              <div className="text-gray-500">
                <p>Host's time: {hostTime}</p>
              </div>
            </div>
          )}

          {/* Duration */}
          <div className="flex items-center gap-3 text-gray-600">
            <div className="w-5 h-5 flex items-center justify-center">
              <span className="text-xs">&#128340;</span>
            </div>
            <span>{booking.duration} minutes</span>
          </div>
        </div>
      </div>

      {/* Add to Calendar Buttons */}
      <div className="space-y-2">
        <p className="text-sm text-gray-500 mb-3">Add to your calendar</p>
        <div className="flex flex-wrap justify-center gap-2">
          <CalendarButton
            href={calendarLinks.google}
            icon="google"
            label="Google Calendar"
          />
          <CalendarButton
            href={calendarLinks.outlook}
            icon="outlook"
            label="Outlook"
          />
          <CalendarButton
            href={calendarLinks.ical}
            icon="ical"
            label="iCal (.ics)"
            download
          />
        </div>
      </div>
    </div>
  );
}

function CalendarButton({
  href,
  icon,
  label,
  download = false,
}: {
  href: string;
  icon: 'google' | 'outlook' | 'ical';
  label: string;
  download?: boolean;
}) {
  return (
    <a
      href={href}
      target={download ? undefined : '_blank'}
      rel={download ? undefined : 'noopener noreferrer'}
      download={download ? 'event.ics' : undefined}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border
                 border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
    >
      <span className="text-lg">
        {icon === 'google' && '📅'}
        {icon === 'outlook' && '📧'}
        {icon === 'ical' && '📎'}
      </span>
      <span className="text-sm">{label}</span>
    </a>
  );
}

function generateCalendarLinks(booking: {
  startTime: string;
  endTime: string;
  meetingTypeName: string;
  hostName: string;
}) {
  const start = new Date(booking.startTime);
  const end = new Date(booking.endTime);

  // Format for Google Calendar
  const googleDateFormat = (date: Date) =>
    date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const title = encodeURIComponent(`${booking.meetingTypeName} with ${booking.hostName}`);

  return {
    google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${googleDateFormat(start)}/${googleDateFormat(end)}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?subject=${title}&startdt=${start.toISOString()}&enddt=${end.toISOString()}`,
    ical: generateICalFile(booking),
  };
}

function generateICalFile(booking: any): string {
  const ical = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:${new Date(booking.startTime).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}
DTEND:${new Date(booking.endTime).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}
SUMMARY:${booking.meetingTypeName} with ${booking.hostName}
END:VEVENT
END:VCALENDAR`;

  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ical)}`;
}
```

---

## Step 9: Accessibility and Mobile

### Accessibility Features

```tsx
// Keyboard navigation for calendar
function BookingCalendar({ ... }) {
  const handleKeyDown = (e: React.KeyboardEvent, date: Date) => {
    const days = calendarDays.filter(d => d.hasAvailability);
    const currentIndex = days.findIndex(
      d => d.date.toDateString() === date.toDateString()
    );

    switch (e.key) {
      case 'ArrowRight':
        if (currentIndex < days.length - 1) {
          focusDate(days[currentIndex + 1].date);
        }
        break;
      case 'ArrowLeft':
        if (currentIndex > 0) {
          focusDate(days[currentIndex - 1].date);
        }
        break;
      case 'ArrowDown':
        // Move to same day next week
        const nextWeek = days.find(
          d => d.date.getTime() >= date.getTime() + 7 * 24 * 60 * 60 * 1000
        );
        if (nextWeek) focusDate(nextWeek.date);
        break;
      case 'ArrowUp':
        // Move to same day previous week
        const prevWeek = days.reverse().find(
          d => d.date.getTime() <= date.getTime() - 7 * 24 * 60 * 60 * 1000
        );
        if (prevWeek) focusDate(prevWeek.date);
        break;
      case 'Enter':
      case ' ':
        onDateSelect(date);
        break;
    }
  };

  return (
    <div
      role="grid"
      aria-label="Select a date for your meeting"
      aria-describedby="calendar-instructions"
    >
      <p id="calendar-instructions" className="sr-only">
        Use arrow keys to navigate dates. Press Enter or Space to select.
      </p>
      {/* ... calendar content */}
    </div>
  );
}
```

### Mobile Responsive Styles

```css
/* Booking page responsive styles */
@media (max-width: 640px) {
  /* Stack calendar and time slots vertically */
  .booking-layout {
    @apply flex flex-col;
  }

  /* Larger touch targets for time slots */
  .time-slot-button {
    @apply min-h-[44px] min-w-[44px];
  }

  /* Sticky timezone selector */
  .timezone-selector {
    @apply sticky top-0 z-10 bg-white border-b py-2;
  }

  /* Bottom sheet for booking form */
  .booking-form-container {
    @apply fixed inset-x-0 bottom-0 bg-white rounded-t-2xl shadow-2xl
           max-h-[80vh] overflow-y-auto animate-slide-up;
  }
}
```

---

## Step 10: Trade-offs Summary

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API for moderate complexity |
| Timezone Display | UTC storage + client conversion | Server-side conversion | Instant timezone switching without refetch |
| Calendar Caching | 3-min client TTL | Server-side only | Reduces availability API calls by 80% |
| Progressive Disclosure | Step-by-step reveal | Show all at once | Reduces cognitive load, better mobile UX |
| Slot Conflict Handling | Pre-check + 409 handler | Optimistic only | Better UX with early conflict detection |
| Calendar Links | Client-side generation | Server-provided | Works offline, no extra API call |

---

## Summary

"To summarize the frontend architecture for Calendly:

1. **Progressive Disclosure**: Calendar -> Time Slots -> Form -> Confirmation, reducing cognitive load at each step
2. **Timezone Handling**: Store UTC, convert on client with `Intl.DateTimeFormat`, enable instant timezone switching
3. **Client-Side Caching**: 3-minute TTL on availability data reduces API calls for browsing behavior
4. **Conflict Prevention**: Pre-check slot availability before form submission, graceful 409 handling with alternatives
5. **Accessibility**: Full keyboard navigation, ARIA labels, screen reader support for calendar interactions
6. **Mobile Optimization**: Touch-friendly targets (44px+), sticky elements, bottom sheet for forms

The key insight is that the 100:1 availability check to booking ratio means optimizing the browsing experience is critical. Client-side caching and instant timezone switching make the experience feel snappy even with multiple date selections."
