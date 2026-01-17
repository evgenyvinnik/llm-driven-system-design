# Design Calendly - Guest Booking Experience

## Problem Statement
Design the public booking page where guests can view a host's availability and book a time slot.

---

## 1. Requirements Exploration (5-7 minutes)

### Clarifying Questions

**Q: What's the core user flow we're focusing on?**
A: Guest clicks booking link → views available slots → selects time → fills form → confirms booking

**Q: What's in the booking URL?**
A: Needs to uniquely identify the event type. Two approaches:

**Option A: Human-Readable Slug**
```
/john-doe/30min
```
- ✅ Clean, shareable, memorable
- ❌ Username can be enumerated/guessed
- ❌ Can't revoke without changing username/slug

**Option B: UUID-Based (More Secure)**
```
/e/abc123-def456-ghi789
```
- ✅ Hard to guess/enumerate
- ✅ Can be rotated if leaked
- ✅ Multiple links per event type (different campaigns)
- ❌ Less human-friendly

**Real-world approach (Calendly uses this):**
```
/john-doe/30min-abc123def
```
- Human-readable prefix + random suffix
- Can rotate the `abc123def` part without changing slug
- Balance of usability and security

**Q: What devices should we support?**
A: Mobile-first (most guests book on mobile), but desktop should work well too

### Functional Requirements
1. Display event details (title, duration, description)
2. Show calendar with available time slots
3. Allow guest to select timezone
4. Collect guest information (name, email, optional notes)
5. Prevent booking already-taken slots
6. Show confirmation with calendar invite link

### Non-Functional Requirements
1. **Performance**: Calendar loads in < 2 seconds
2. **Reliability**: No double-bookings
3. **Mobile UX**: Touch-friendly, easy to complete on phone

---

## 2. Architecture / High-Level Design (8-10 minutes)

```
┌─────────────────────────────────────┐
│           SERVER API                │
│  - Event type data                  │
│  - Available slots                  │
│  - Create booking                   │
└────────────┬────────────────────────┘
             │
             │ REST API
             │
┌────────────▼────────────────────────┐
│         CONTROLLER                  │
│  - API calls                        │
│  - Data transformation              │
│  - Client-side validation           │
└────────────┬────────────────────────┘
             │
             │
┌────────────▼────────────────────────┐
│       CLIENT STORE                  │
│  - Event type info                  │
│  - Available slots (by date)        │
│  - Selected slot                    │
│  - Form data                        │
│  - UI state (timezone, loading)     │
└────────────┬────────────────────────┘
             │
             │
┌────────────▼─────────────────────────────────┐
│              VIEW LAYER                      │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │      Event Header                    │   │
│  │  - Host name, avatar                 │   │
│  │  - Event title, duration             │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │      Calendar Selector               │   │
│  │  - Month navigation                  │   │
│  │  - Date grid with availability       │   │
│  │  - Timezone selector                 │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │      Time Slot List                  │   │
│  │  - Available times for selected date │   │
│  │  - Displayed in guest's timezone     │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │      Booking Form                    │   │
│  │  - Name, Email                       │   │
│  │  - Optional notes                    │   │
│  │  - Confirm button                    │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │      Confirmation Screen             │   │
│  │  - Booking details                   │   │
│  │  - Add to calendar link              │   │
│  └──────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

### Component Flow
1. Page loads → Fetch event type details
2. Auto-detect guest timezone → Fetch available slots for current + next 2 weeks
3. Guest selects date → Show time slots for that day
4. Guest selects time → Show booking form
5. Guest submits form → Create booking → Show confirmation

---

## 3. Data Model (4-5 minutes)

### Key Entities

**EventType** (Server data)
```typescript
{
  id: string
  name: string              // "30 Minute Meeting"
  duration: number          // 15, 20, 30, 45, or 60 (minutes)
  description: string
  host: {
    name: string
    avatar_url: string
  }
}
```

**AvailableSlot** (Server data)
```typescript
{
  start_time: string        // "2025-01-15T14:00:00Z" (UTC)
  end_time: string          // "2025-01-15T14:30:00Z"
}
```

**BookingFormData** (Client data, user input)
```typescript
{
  selected_slot: AvailableSlot
  guest_name: string
  guest_email: string
  guest_notes: string
  timezone: string          // "America/New_York"
}
```

**UIState** (Client ephemeral state)
```typescript
{
  selected_date: Date
  selected_timezone: string
  current_month: Date
  is_loading: boolean
  is_submitting: boolean
  error: string | null
}
```

---

## 4. API Design (6-8 minutes)

### API 1: Get Event Type

**Two URL Patterns to Consider:**

**Pattern A: Username + Slug**
```
GET /api/:username/:event-slug
Example: /api/john-doe/30min
```

**Pattern B: Direct UUID Lookup**
```
GET /api/events/:event_uuid
Example: /api/events/abc123-def456-ghi789
```

**Pattern C: Hybrid (Recommended)**
```
GET /api/:username/:slug-:token
Example: /api/john-doe/30min-x7k2m9
```
- Validate username + slug + token combination
- Token can be rotated without changing slug
- Prevents URL enumeration attacks

**Response:**
```json
{
  "id": "evt_123",
  "booking_token": "x7k2m9",  // Include for subsequent API calls
  "name": "30 Minute Meeting",
  "duration": 30,
  "description": "Quick sync",
  "host": {
    "name": "John Doe",
    "avatar_url": "https://..."
  }
}
```

**Security Discussion:**
- **Why token matters:** Without it, anyone could enumerate `/john-doe/*` to find all event types
- **Revocation:** Host can regenerate token if link is leaked/shared inappropriately
- **Multiple tokens:** Host could create multiple tokens for same event (e.g., different marketing campaigns, track which channel converts better)

### API 2: Get Available Slots

```
GET /api/availability/:event_id
```

**Query Params:**
```
?start_date=2025-01-15
&end_date=2025-01-29    // Max 2 weeks from start
```

**Response (Approach A - UTC Only):**
```json
{
  "slots": {
    "2025-01-15": [
      {
        "start_time": "2025-01-15T19:00:00Z",  // UTC timestamps
        "end_time": "2025-01-15T19:30:00Z"
      }
    ]
  }
}
```

**Alternative Response (Approach B - Include Timezone):**
```json
{
  "slots": {
    "2025-01-15": [
      {
        "start_time": "2025-01-15T19:00:00Z",
        "end_time": "2025-01-15T19:30:00Z"
      }
    ]
  },
  "timezone": "America/Los_Angeles",  // Host's timezone for reference
  "host_offset": "-08:00"             // Current offset (handles DST)
}
```

**Trade-offs Discussion:**

**Option A: UTC Only (Recommended)**
- ✅ Client can switch timezones without re-fetching
- ✅ Simpler API contract
- ✅ One response works for all guests
- ❌ Client must handle all timezone logic

**Option B: Include Host Timezone Info**
- ✅ Useful for showing "Host's local time: 11:00 AM PST"
- ✅ Helps guest understand host's working hours context
- ❌ Adds complexity if not needed
- ❌ Still need UTC for accurate conversion

**My recommendation:** Start with Option A (UTC only). If user research shows guests want to see host's timezone, add it as optional metadata in Option B without changing the core slot format.

### API 3: Create Booking

```
POST /api/bookings
```

**Request:**
```json
{
  "event_type_id": "evt_123",
  "start_time": "2025-01-15T19:00:00Z",  // UTC
  "guest_name": "Jane Smith",
  "guest_email": "jane@example.com",
  "guest_notes": "Looking forward to it",
  "guest_timezone": "America/New_York"  // For calendar invite
}
```

**Success Response (201):**
```json
{
  "id": "book_456",
  "status": "confirmed",
  "start_time": "2025-01-15T14:00:00Z",
  "calendar_url": "https://calendar.google.com/..."
}
```

**Error Response (409 Conflict):**
```json
{
  "error": "slot_unavailable",
  "message": "This slot was just booked"
}
```

---

## 5. Deep Dive & Optimizations (18-22 minutes)

### 5.1 Race Condition: Double Booking Prevention

**Problem:** Two guests select same slot simultaneously

**Question to discuss:** Where should we validate slot availability?

**Option A: Client Pre-Check + Server Validation (Recommended)**

```javascript
async function handleBooking(formData) {
  setIsSubmitting(true);

  try {
    // Client-side: Re-check availability before submit
    const stillAvailable = await checkSlotAvailability(
      formData.selected_slot
    );

    if (!stillAvailable) {
      showError("This slot was just booked. Here are alternatives:");
      refreshAvailability();
      return;
    }

    // Server will also validate (race condition could still happen here)
    const booking = await createBooking(formData);
    showConfirmation(booking);

  } catch (error) {
    if (error.status === 409) {
      // Server caught conflict
      showError("Someone just booked this slot");
      refreshAvailability();
      showAlternativeSlots();
    }
  } finally {
    setIsSubmitting(false);
  }
}
```

**Pros:**
- ✅ Catches most conflicts before form submission
- ✅ Better UX (fails early)
- ✅ Server still has final say
- ❌ Extra API call (pre-check)

**Option B: Server-Only Validation**

Skip the pre-check, rely only on server 409 response.

**Pros:**
- ✅ Simpler implementation
- ✅ One less API call
- ❌ Guest fills entire form, then gets error
- ❌ Worse UX

**Option C: Optimistic Locking**

Include a version/timestamp with booking request:
```javascript
{
  "start_time": "2025-01-15T19:00:00Z",
  "availability_version": "v12345",  // Last known state
  ...
}
```

**Pros:**
- ✅ Precise conflict detection
- ✅ Server can check against exact state
- ❌ More complex API contract
- ❌ Need to track versions client-side

**My recommendation:** Start with Option A (pre-check + server validation). If pre-check API call is too expensive, fall back to Option B with great error UX.

### 5.2 Performance Optimization

**Challenge:** Keep UI responsive while loading availability data

#### Look-Ahead Window Strategy

**Question to discuss:** How far ahead should we let guests book?

**Option A: 2 Weeks (Conservative)**
- ✅ Fast initial load
- ✅ Most bookings happen within 2 weeks
- ✅ Reduces server computation
- ❌ Limits flexibility for longer-term planning
- **Use case:** Quick meetings, sales calls, support

**Option B: 4 Weeks (Moderate)**
- ✅ Accommodates monthly planning cycles
- ✅ Still manageable data size
- ❌ Slightly slower initial load
- **Use case:** Consulting, executive meetings

**Option C: Rolling Window (Dynamic)**
- Load 2 weeks initially
- Load next batch when user clicks "Show more dates"
- ✅ Best of both worlds
- ❌ More complex implementation

**My recommendation:** Start with Option A (2 weeks), add pagination for Option C if needed.

```javascript
const INITIAL_WINDOW_DAYS = 14; // 2 weeks
const endDate = addDays(startDate, INITIAL_WINDOW_DAYS);
```

#### Client-Side Caching Strategy

**Question to discuss:** Should we cache availability responses client-side?

**Option A: No Caching (Always Fresh)**
- ✅ Always accurate availability
- ✅ Simpler implementation
- ❌ More API calls
- ❌ Slower when navigating back/forth
- ❌ Higher server load for popular pages

**Option B: Short TTL Cache (3-5 minutes)**
- ✅ Instant timezone switching (UTC data cached)
- ✅ Fast back/forth navigation
- ✅ Reduces server load
- ❌ Potential for 3-5 min stale data
- ❌ Need cache invalidation on booking

```javascript
const CACHE_DURATION = 3 * 60 * 1000; // 3 minutes
const availabilityCache = new Map();

async function getAvailability(eventId, startDate, endDate) {
  const cacheKey = `${eventId}-${startDate}-${endDate}`;
  const cached = availabilityCache.get(cacheKey);

  // Return cached if fresh
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

  // Fetch fresh data
  const data = await api.getAvailability(eventId, startDate, endDate);
  availabilityCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });

  return data;
}

// Clear cache after booking
function onBookingCreated() {
  availabilityCache.clear(); // Force fresh data
}
```

**Option C: Optimistic Cache + Background Refresh**
- Show cached data immediately
- Fetch fresh data in background
- Update if changes detected
- ✅ Best UX (instant display)
- ❌ Most complex
- ❌ Potential UI flicker if data changes

**My recommendation:** Option B (3-5 min cache) with clear-on-booking. Good balance of performance vs. accuracy. Could discuss upgrading to Option C if we see users frequently encountering stale data.

**Trade-off to highlight:** "The 3-5 minute cache means there's a small window where a guest might see a slot as available that was just booked. We handle this with pre-submit verification and a 409 error with alternative slots if the slot is taken."

#### Rendering Optimization

```javascript
// Memoize expensive timezone conversions
const DayCell = React.memo(({ date, slots, timezone }) => {
  const displaySlots = useMemo(
    () => slots.map(slot => convertToTimezone(slot, timezone)),
    [slots, timezone]
  );

  return <div>{/* render day */}</div>;
});
```

### 5.3 Timezone Handling

**Critical Challenge:** Host in PST, Guest in IST - show correct local times

#### API Design Approaches

**Question to discuss:** Should the API accept a timezone parameter or always return UTC?

**Option A: API Returns UTC Only (No Timezone Param)**

```javascript
GET /api/availability/:event_id?start_date=2025-01-15&end_date=2025-01-29
// Returns UTC timestamps only
```

- ✅ Guest can switch timezones without re-fetching
- ✅ Simpler API (no timezone parameter)
- ✅ Client-side caching very effective (one response for all timezones)
- ✅ Less server computation
- ❌ Client must do all timezone conversion
- ❌ More complex client-side logic

**Option B: API Accepts Timezone Parameter**

```javascript
GET /api/availability/:event_id?start_date=2025-01-15&end_date=2025-01-29&timezone=America/New_York
// Returns slots already converted to guest's timezone
```

- ✅ Server handles timezone complexity
- ✅ Simpler client implementation
- ❌ Must re-fetch when guest changes timezone (common!)
- ❌ Can't cache across timezones
- ❌ More server computation

**My recommendation:** Option A. Timezone switching is common user behavior (guests often check their home timezone vs. meeting location timezone), so avoiding re-fetches is valuable.

#### Client-Side Implementation (Option A)

1. **Auto-detect guest timezone:**
   ```javascript
   const guestTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
   // e.g., "America/New_York"
   ```

2. **Display conversion:**
   ```javascript
   import { utcToZonedTime, format } from 'date-fns-tz';

   function displayTime(utcTimestamp, guestTimezone) {
     const zonedTime = utcToZonedTime(utcTimestamp, guestTimezone);
     return format(zonedTime, 'h:mm a zzz', { timeZone: guestTimezone });
   }

   // Example:
   // UTC: "2025-01-15T19:00:00Z"
   // Guest in LA: "11:00 AM PST"
   // Guest in India: "12:30 AM IST (next day)"
   ```

3. **Timezone selector UX:**
   - Show auto-detected timezone first: "Local time (EST)"
   - Common options: Eastern, Pacific, Central, GMT, IST
   - When changed → instant re-render, no loading spinner

#### Alternative: Show Both Timezones

**Question:** Should we show both guest's timezone AND host's timezone?

```javascript
// Display could show:
"2:00 PM EST (11:00 AM PST host time)"
```

**Trade-offs:**
- ✅ Helpful context for guest
- ✅ Avoids confusion about working hours
- ❌ Cluttered UI on mobile
- ❌ Need host timezone in API response (breaks Option A purity)

**Compromise approach:**
- Show guest's timezone prominently
- Add small tooltip/hint: "Host is in Pacific Time"
- Don't show dual times on every slot (too busy)

#### Edge Cases to Handle

```javascript
// Midnight boundaries - show date in guest's timezone
const localDate = utcToZonedTime(utcTime, guestTimezone);
const displayDate = format(localDate, 'MMM d, yyyy');

// Late night/early morning warning
const hour = utcToZonedTime(slotTime, guestTimezone).getHours();
if (hour < 6 || hour > 22) {
  showWarning("Note: This is outside typical working hours in your timezone");
}

// DST transitions - library handles automatically
// (No special handling needed with date-fns-tz)
```

**Open question for interviewer:** "Should we warn guests when they're booking outside typical business hours in their timezone? Or is that overstepping since they chose the time?"

### 5.4 Mobile UX Optimization

**Key Considerations:**

1. **Touch targets:** Min 44x44px for date/time buttons
2. **Swipe gestures:** Swipe to change months
3. **Vertical layout:** Stack calendar above form
4. **Bottom sheet:** Form slides up on mobile
5. **Sticky confirmation:** Button stays visible while scrolling

```javascript
// Mobile-optimized layout
<div className="flex flex-col">
  <EventHeader />
  <div className="sticky top-0 bg-white z-10">
    <TimezoneSelector />
  </div>
  <CalendarView />
  {selectedSlot && (
    <div className="fixed bottom-0 w-full">
      <BookingForm />
    </div>
  )}
</div>
```

### 5.5 User Experience Flow

**Progressive Disclosure:**

Step 1: Show calendar (low commitment)
```
┌─────────────────┐
│   📅 Calendar   │  ← Start here
└─────────────────┘
```

Step 2: After date selection → Show time slots
```
┌─────────────────┐
│   📅 Calendar   │
└─────────────────┘
┌─────────────────┐
│ 🕒 Time Slots   │  ← Appears
└─────────────────┘
```

Step 3: After time selection → Show form
```
┌─────────────────┐
│ ✅ Selected:     │
│ Jan 15, 2:00 PM │
└─────────────────┘
┌─────────────────┐
│ 📝 Your Details │  ← Appears
└─────────────────┘
```

**Smart defaults:**
- Auto-detect timezone from browser
- Pre-select next available date
- Remember form data in session (email, name)
- Default to next 2 weeks view

### 5.6 Error Handling & Edge Cases

**Loading States:**
```javascript
{isLoading ? (
  <CalendarSkeleton />  // Show skeleton UI
) : slots.length === 0 ? (
  <EmptyState message="No availability in this period" />
) : (
  <Calendar slots={slots} />
)}
```

**Network Failures:**
- Show retry button
- Use exponential backoff for retries
- Graceful degradation (show cached data if available)

**Validation:**
```javascript
function validateBookingForm(data) {
  const errors = {};

  if (!data.guest_name?.trim()) {
    errors.name = "Name is required";
  }

  if (!isValidEmail(data.guest_email)) {
    errors.email = "Valid email required";
  }

  if (!data.selected_slot) {
    errors.slot = "Please select a time slot";
  }

  return errors;
}
```

### 5.7 Security & Privacy Considerations

**URL Security**

**Challenge:** How do we prevent unauthorized access and URL enumeration?

**Pattern Evolution:**

1. **Naive approach:** `/john-doe/30min`
   - ❌ Anyone can guess patterns: `/john-doe/15min`, `/john-doe/60min`
   - ❌ Can enumerate all of a user's event types
   - ❌ Can't revoke if leaked

2. **UUID only:** `/e/abc123-def456-ghi789`
   - ✅ Can't be enumerated
   - ✅ Can be rotated/revoked
   - ❌ Completely opaque, not shareable verbally
   - ❌ Can't tell what it's for by looking at URL

3. **Hybrid (Recommended):** `/john-doe/30min-x7k2m9`
   - ✅ Human-readable for context
   - ✅ Token prevents enumeration
   - ✅ Can rotate token without breaking slug
   - ✅ Multiple tokens per event (tracking, revocation)

**Implementation:**

```javascript
// Server validates all three parts
function validateEventUrl(username, slug, token) {
  const event = db.findEvent({
    owner_username: username,
    slug: slug,
    active_tokens: token  // Check against array of valid tokens
  });

  if (!event) {
    return { error: 404, message: "Event not found" };
  }

  return { event };
}
```

**Token rotation use cases:**
- Link shared publicly (Twitter) → revoke, generate new
- Different marketing channels → separate tokens, track conversion
- Temporary access → expiring tokens for limited-time campaigns

**Additional Security Measures:**

1. **Rate limiting:**
   ```javascript
   // Prevent slot enumeration attacks
   // Max 20 availability checks per IP per minute
   ```

2. **Bot detection:**
   - Track rapid-fire booking attempts
   - CAPTCHA for suspicious patterns
   - Honeypot fields in form

3. **Email verification (optional):**
   - Send confirmation email with link to verify
   - Booking not finalized until clicked
   - Prevents spam bookings with fake emails
   - **Trade-off:** Adds friction, reduces conversion

**Question for interviewer:** "Should we require email verification for bookings, or trust the email and handle abuse reactively? Verification prevents spam but adds friction."

### 5.8 Quick Wins Worth Mentioning

1. **Skeleton loading:** Show calendar skeleton while fetching
2. **Optimistic UI:** Show booking immediately, sync async
3. **Email validation:** Check format client-side before submit
4. **Timezone warning:** If guest's timezone differs significantly from host
5. **Calendar navigation:** Keyboard shortcuts (arrow keys, Enter)
6. **Confirmation email:** Send immediately, no page reload needed

### What I Covered (in order):
1. ✅ Scoped to guest booking flow only
2. ✅ Defined clear requirements (functional + non-functional)
3. ✅ Drew simple architecture (Server → Controller → Store → View)
4. ✅ Defined 4 key entities with essential fields
5. ✅ Specified 3 critical APIs with request/response
6. ✅ Deep-dived into: race conditions, performance, timezone, mobile UX

### Key Talking Points:
- **Biggest challenge:** Race conditions in booking (discussed 3 validation approaches)
- **API design trade-off:** UTC-only response enables instant timezone switching vs. server-side conversion for simpler client
- **Caching trade-off:** 3-5 min cache improves performance but risks showing stale slots (mitigated by pre-submit verification)
- **UX:** Progressive disclosure, mobile-first design

### Strong Closing:
"The core challenges are preventing double-bookings and handling timezones correctly. For race conditions, I'd recommend client pre-check plus server validation—catches most issues early with good UX. For timezones, returning UTC-only from the API lets guests instantly switch timezones without re-fetching, which is more responsive. We'd cache for 3-5 minutes to optimize the common case of guests browsing dates, but clear cache and re-verify before submission. I'm happy to explore any of these trade-offs in more depth—like whether the timezone warning for late-night slots is helpful or annoying."

---

**Total Length:** ~5 pages (realistic for 45-min interview)
**Time Distribution:** 5 + 10 + 5 + 7 + 18 = 45 minutes
