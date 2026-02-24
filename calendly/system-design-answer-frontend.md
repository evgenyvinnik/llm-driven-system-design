# Calendly - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## Introduction

"I'll design a meeting scheduling platform like Calendly, focusing on the **guest booking experience** - the public-facing page where someone clicks a shared link and books a meeting. This is distinct from the host dashboard (where calendar owners manage their availability).

The guest booking flow is the highest-traffic, highest-stakes part of the frontend. Guests arrive via shared link, often on mobile, often with low patience. The key challenges are: handling timezone complexity, creating a booking flow that minimizes abandonment, and deciding whether guests should authenticate. I'll focus on making the browsing experience feel instant while ensuring bookings are reliable."

---

## 🎯 Requirements Clarification

> "I'm focusing specifically on the guest booking experience - the public page guests see when they click a booking link. The host dashboard (managing availability, viewing bookings) is out of scope for this discussion."

### Guest-Facing Requirements

1. **View Available Slots** - Calendar interface showing when host is free
2. **Select Time** - Choose a specific slot with clear timezone display
3. **Complete Booking** - Fill minimal form (name, email), submit without friction
4. **Receive Confirmation** - See confirmation with "add to calendar" options
5. **No Authentication Required** - Guests should book without creating accounts
6. **Mobile-First** - Most guests arrive via shared links on mobile

### Technical Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Availability render | < 100ms | Users browse many dates rapidly |
| Timezone switch | Instant | No refetch - just re-render |
| Form submission | < 500ms | Acceptable for booking action |
| Bundle size | < 200KB gzipped | Fast initial load for guests |

> "The critical insight is that guests arrive via link, often on mobile. First contentful paint matters enormously - if the calendar doesn't appear within 2 seconds, they leave."

---

## 🏗️ Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        App Shell                                 │
│              (Router, Auth Provider, Timezone Context)           │
└─────────────────────────────────────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Guest Booking  │  │ Host Dashboard  │  │  Admin Panel    │
│    (Public)     │  │ (Authenticated) │  │ (Authenticated) │
└────────┬────────┘  └────────┬────────┘  └─────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Shared Components                             │
│   Calendar Picker, Time Slots, Timezone Selector, Form Fields   │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    State & Services                              │
│      Zustand Stores, API Client, Timezone Utilities             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Deep Dive: API Design for Guest Booking

> "The API contract shapes everything the frontend can do. I need endpoints that support fast browsing, handle timezone complexity, and prevent double bookings. Let me walk through what the guest booking page needs from the backend."

### Core Endpoints

| Endpoint | Purpose | When Called |
|----------|---------|-------------|
| GET `/book/:username/:slug` | Fetch meeting type details | Page load |
| GET `/availability` | Fetch available time slots | Date range selection |
| GET `/availability/check` | Verify single slot still available | Before showing form |
| POST `/bookings` | Create the booking | Form submission |

### API 1: Get Meeting Type

**Request:** `GET /book/john-doe/30min-x7k2m9`

**Response includes:**
- Meeting type name, duration, description
- Host name and avatar (for display)
- Booking constraints (min notice, max future days, buffer times)
- Whether email verification is required

**Key decision - what constraints to expose:**

> "The frontend needs to know the booking window (14 days? 60 days?) to render the calendar correctly. It needs minimum notice to gray out too-soon slots. But it doesn't need internal details like 'max 5 bookings per day' - the server just returns fewer available slots."

### API 2: Get Availability (The Critical One)

**Request:** `GET /availability?meeting_type_id=X&start_date=2024-01-15&end_date=2024-01-29`

**Trade-off: Response shape**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Slots grouped by date | Easy to render calendar, natural pagination | Slightly larger response |
| ❌ Flat list of all slots | Simpler response | Frontend must group, harder to paginate |
| ❌ Return availability rules + existing bookings | Most flexible | Frontend does complex calculation |

**Why grouped by date:**

> "The frontend needs to show availability indicators on the calendar (blue dot on dates with slots). If the API returns a flat list of 200 slots, I have to group them client-side to know which dates have availability. By grouping server-side, the response structure matches the UI structure.

> Returning raw rules + bookings would let the frontend calculate slots itself, but that's the wrong separation of concerns. Availability calculation involves external calendars, buffer times, daily limits - the server should own that complexity."

**Trade-off: Time format**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ UTC timestamps | Client can switch timezones without refetch | Client must convert for display |
| ❌ Pre-converted to guest timezone | Simpler display logic | Refetch required on timezone change |
| ❌ Include both UTC and formatted | No conversion needed | Response bloat, timezone still hardcoded |

**Why UTC only:**

> "Guests frequently switch timezones to verify times ('what's this in Pacific?'). If the API returns times in their detected timezone, every switch requires a new API call. With UTC, I fetch once and re-render instantly when timezone changes. The `Intl.DateTimeFormat` API handles conversion client-side."

**Trade-off: Pagination strategy**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Date-range based (2 weeks per request) | Natural calendar pagination | May need multiple requests |
| ❌ Offset/limit pagination | Standard pattern | Doesn't map to calendar UI |
| ❌ Cursor-based | Good for infinite scroll | Overkill for bounded date ranges |

**Why date-range pagination:**

> "The calendar shows months, not arbitrary page sizes. When the user clicks 'next month', I fetch that month's dates. Date-range pagination matches the UI interaction model. I prefetch the next 2 weeks when the user approaches the edge of loaded data."

### API 3: Check Slot Availability

**Request:** `GET /availability/check?meeting_type_id=X&start_time=2024-01-15T14:00:00Z`

**Response:** `{ "available": true }` or `{ "available": false, "alternatives": [...] }`

**Why this endpoint exists:**

> "Between when the guest views availability (cached for 3 minutes) and when they select a slot, someone else might have booked it. This lightweight check catches 95% of conflicts before the guest fills out the form. It's faster than re-fetching all availability."

### API 4: Create Booking

**Request:** `POST /bookings`
- Headers: `X-Idempotency-Key: <client-generated-key>`
- Body: meeting_type_id, start_time (UTC), guest_name, guest_email, guest_timezone, notes

**Trade-off: Idempotency handling**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Client-generated idempotency key | Survives network retries, client controls dedup | Client must generate keys |
| ❌ Server-generated key returned in response | Simpler client | Doesn't help if first request times out |
| ❌ No idempotency | Simplest | Duplicate bookings on retry |

**Why client-generated keys:**

> "If the guest clicks 'Book' and the network is slow, they might click again. Or their browser might auto-retry a failed request. Without idempotency, each attempt creates a new booking. The client generates a key from the booking details (hash of meeting_type + start_time + email + timestamp), so identical requests get deduplicated server-side."

**Error responses:**

| Status | Meaning | Frontend Action |
|--------|---------|-----------------|
| 201 | Booking created | Show confirmation |
| 409 | Slot no longer available | Show alternatives from response |
| 422 | Validation error | Show field-level errors |
| 429 | Rate limited | Show "too many attempts" message |

**Trade-off: Error response format**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Include alternatives in 409 | Single response gives next steps | Slightly larger error response |
| ❌ 409 alone, client refetches | Simpler error response | Extra round trip, slower recovery |

**Why include alternatives:**

> "When a slot is taken, the guest wants to know what else is available. If I return just '409 Conflict', the frontend has to make another availability request. By including nearby alternatives in the error response, the guest can immediately pick another time without waiting for a refetch."

### Summary: What Makes This API Guest-Friendly

1. **UTC timestamps** - Instant timezone switching without refetch
2. **Date-grouped availability** - Matches calendar UI structure
3. **Pre-check endpoint** - Catches conflicts before form submission
4. **Idempotency keys** - Handles network retries gracefully
5. **Alternatives in error responses** - Fast recovery from conflicts
6. **Constraints in meeting type** - Frontend knows booking window upfront

---

## 🔧 Deep Dive: Guest Booking Flow

> "The booking page is the most critical user journey. A guest arrives via shared link, sees a calendar, picks a date, picks a time, fills a form, confirms. Every friction point increases abandonment."

### Progressive Disclosure Pattern

The booking flow reveals complexity gradually:

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: Calendar                                                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │      < January 2024 >                                    │    │
│  │   Su  Mo  Tu  We  Th  Fr  Sa                            │    │
│  │        1   2   3   4   5   6                            │    │
│  │   7    8   9  10  [11] 12  13   ← User clicks date      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                          │                                       │
│                          ▼ Date selected                         │
│  Step 2: Time Slots appear alongside calendar                    │
│  ┌───────────────────┐                                          │
│  │ Morning           │                                          │
│  │ [9:00] [9:30]     │  ← User clicks time                      │
│  │ Afternoon         │                                          │
│  │ [1:00] [1:30]     │                                          │
│  └───────────────────┘                                          │
│                          │                                       │
│                          ▼ Time selected                         │
│  Step 3: Booking Form slides in                                  │
│  ┌───────────────────┐                                          │
│  │ Name: [________]  │                                          │
│  │ Email: [________] │                                          │
│  │ [Confirm Booking] │                                          │
│  └───────────────────┘                                          │
│                          │                                       │
│                          ▼ Form submitted                        │
│  Step 4: Confirmation screen                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Trade-off Analysis: Single Page vs. Multi-Step Wizard

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Progressive disclosure (single page) | Lower abandonment, visible context | More complex state management |
| ❌ Multi-page wizard | Simpler per-page logic | Users abandon between pages |
| ❌ Show everything at once | Simplest implementation | Overwhelming, especially mobile |

**Why progressive disclosure:**

> "Multi-step wizards (page 1: date, page 2: time, page 3: form) have measurably higher abandonment. Each page transition is a chance for the user to leave. Research shows that users who see a spinner or page load during a booking flow are 3x more likely to abandon.

> Showing everything at once seems simpler to implement, but it's terrible UX. On mobile, the user sees a cluttered screen with calendar, time slots, and form fields fighting for attention. They don't know where to start.

> Progressive disclosure keeps the user focused: first they make the easy choice (pick a date), then the medium choice (pick a time), then the commitment (fill form). By the time they reach the form, they've already invested effort - sunk cost reduces abandonment.

> The trade-off is state complexity. I'm managing step transitions, animations, and conditional rendering. But this complexity lives in one component with clear state transitions, not scattered across multiple pages with URL routing."

---

## 🔧 Deep Dive: Timezone Handling

> "Timezone handling is where scheduling apps fail users. A guest in Tokyo booking with a host in New York needs absolute clarity about what time the meeting actually happens."

### The Core Challenge

The API returns slots in UTC. The guest's browser is in `America/New_York`. The host is in `America/Los_Angeles`. The guest needs to see times in their timezone while being aware that the host is 3 hours behind.

### Trade-off Analysis: Display Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Store UTC, convert on client | Instant timezone switching, single source of truth | Requires Intl API support |
| ❌ Server converts to guest's timezone | Simpler client code | Refetch on timezone change |
| ❌ Store local time | Simpler display | DST breaks everything |

**Why client-side conversion:**

> "If I have the server return times in the guest's timezone, every timezone change requires a new API call. User selects 'Pacific Time' from dropdown → spinner → API call → re-render. That's 200ms minimum, and it breaks the browsing experience.

> With UTC storage and client conversion, timezone switching is instant. The slots are already in memory - I just re-render with different Intl.DateTimeFormat options. User clicks 'Pacific Time' → immediate re-render with no network request. This matters because users frequently switch timezones to verify 'wait, what time is this really?'

> The trade-off is browser support. `Intl.DateTimeFormat` is available in all modern browsers, but we lose IE11 support. For a scheduling tool in 2024, that's acceptable - our target users have modern browsers."

### Timezone UI Patterns

**Auto-detection with override:**
- Detect browser timezone on mount: `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Persist user's choice to localStorage
- Show detected timezone as default with easy switching

**Dual timezone display on confirmation:**
- Show guest's time prominently: "Monday, Jan 15 at 2:00 PM EST"
- Show host's time smaller: "11:00 AM PST for Alice"
- This eliminates "wait, whose timezone?" confusion

**Unusual hours warning:**
- If slot is before 6 AM or after 10 PM in guest's timezone, show warning icon
- Common when booking across large timezone differences
- "This is 5:00 AM in your timezone - are you sure?"

---

## 🔧 Deep Dive: Client-Side Caching

> "Users browse 5-10 dates before booking. Without caching, that's 5-10 API calls. With caching, it's usually 1-2."

### Trade-off Analysis: Cache Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ 3-minute client TTL | Fast browsing, reasonable freshness | Possible stale slots |
| ❌ No cache | Always fresh | Sluggish browsing experience |
| ❌ Long TTL (30 min) | Great for returning users | Unacceptable staleness |
| ❌ Service Worker cache | Works offline | Complexity, cache invalidation hard |

**Why short TTL with optimistic updates:**

> "The typical booking session lasts 2-5 minutes: land on page, browse a few dates, pick a slot, fill form, submit. If I cache availability for 3 minutes, most users never see stale data because they book within the TTL.

> The risk is: user caches 2:00 PM as available, spends 4 minutes on the form, submits, gets '409 Slot Unavailable'. This is annoying but recoverable - I show alternative slots. This happens rarely enough that the UX trade-off (fast browsing 99% of the time vs. occasional conflict) is worth it.

> Service worker caching would let the page work offline, but scheduling fundamentally requires network access - you can't actually book without hitting the server. The complexity isn't justified."

### Cache Invalidation

When a booking succeeds:
1. Immediately clear all cached availability for that meeting type
2. On 409 conflict: clear cache, show alternatives from server response
3. On timezone change: no invalidation needed (just re-render existing data)

---

## 🔧 Deep Dive: Booking URL Design

> "The booking URL is the host's public interface. It needs to be shareable, memorable, but also secure and revocable. This is a frontend concern because it affects routing, the host dashboard UX, and how we communicate link status to users."

### The URL Trade-off

Hosts share their booking links on LinkedIn, email signatures, Twitter bios. The URL matters.

**Option A: Human-readable slug**
```
calendly.com/john-doe/30min
```
- Memorable, easy to share verbally
- Professional appearance

**Option B: UUID-only**
```
calendly.com/e/abc123-def456-ghi789
```
- Impossible to guess or enumerate
- Can be rotated without changing username

**Option C: Hybrid (human-readable + token)**
```
calendly.com/john-doe/30min-x7k2m9
```
- Readable prefix for context
- Token suffix for security
- Can rotate token without changing slug

### Trade-off Analysis

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Hybrid (slug + token) | Readable, secure, rotatable | Slightly longer URL |
| ❌ Slug only | Clean, memorable | Enumerable, can't revoke |
| ❌ UUID only | Most secure | Opaque, can't share verbally |

**Why hybrid URLs:**

> "With slug-only URLs like `/john-doe/30min`, anyone can enumerate a host's event types by guessing: `/john-doe/15min`, `/john-doe/60min`, `/john-doe/interview`. This leaks information about how someone uses their calendar.

> More critically, slug-only URLs can't be revoked. If a host accidentally shares their link on a public forum and gets spammed with fake bookings, their only option is to change their username or event slug - breaking every existing link they've shared.

> UUID-only URLs solve security but create UX problems. Try reading `abc123-def456-ghi789` over the phone. It's also not obvious what the link is for - is it a 30-minute meeting or a 60-minute consultation?

> The hybrid approach gives us both: the human-readable part (`/john-doe/30min`) tells recipients what they're booking, while the token (`-x7k2m9`) prevents enumeration and enables revocation. If a link is leaked, the host rotates the token - existing links break, but the new link has the same readable prefix."

### Frontend Implementation Considerations

**Host Dashboard - Link Management:**
- Show current URL with copy button
- "Regenerate Link" action with confirmation warning
- Show when link was last rotated
- Optional: multiple tokens per event (track which channel converts better)

**Routing:**
- Parse URL as `/:username/:slug-:token` or `/:username/:slug`
- If token is missing, could redirect to a landing page or show "link expired"
- Consider: should old tokens show "this link has been updated" with a request for new link?

**Error States:**
- Invalid token: "This booking link has been updated. Please request a new link from [host name]."
- Not enumerable error: Show generic 404, don't reveal whether the slug exists

---

## 🔧 Deep Dive: Guest Authentication

> "Should guests need to log in before booking? This seems like a simple question, but it has profound UX and security implications."

### The Core Trade-off

Requiring authentication reduces spam and enables features like booking history. But it adds friction that kills conversion.

### Option Analysis

**Option A: No authentication (anonymous booking)**
- Guest provides name + email in form
- No account creation required
- Email verification optional

**Option B: Required authentication**
- Guest must log in or create account before booking
- Can use social login (Google, Microsoft)

**Option C: Optional authentication**
- Anonymous booking available
- "Log in to see your booking history" prompt
- Returning guests recognized by email

| Approach | Pros | Cons |
|----------|------|------|
| ✅ No auth (anonymous) | Zero friction, highest conversion | Spam risk, no booking history |
| ❌ Required auth | Spam prevention, rich features | Massive friction, lower conversion |
| ⚡ Optional auth | Best of both for returning users | More complex UX |

**Why I chose anonymous booking with optional verification:**

> "The guest booking page serves one purpose: convert a link click into a confirmed meeting. Every friction point - every extra click, every form field, every 'create account' prompt - reduces that conversion.

> Required authentication would devastate conversion rates. Imagine clicking a '30-minute meeting' link and seeing 'Log in to continue.' Many guests would close the tab. They're not invested in the platform - they just want to book with Alice. Forcing account creation treats guests as product users when they're really just trying to accomplish a task.

> The spam concern is real but manageable. I'd use rate limiting (20 bookings per IP per hour), honeypot fields in the form, and optional email verification. If a host experiences spam, they can enable CAPTCHA or email verification for their links specifically.

> Optional authentication works for returning guests: if someone books frequently, they can create an account to see their history, reschedule easily, and pre-fill forms. But this is opt-in, not required."

### Frontend Implementation

**Anonymous flow:**
- Form collects name, email, optional notes
- On submit: create booking, send confirmation email
- No session created, no cookies beyond CSRF

**Email verification (optional, host-configurable):**
- After form submit: "Check your email to confirm"
- Guest clicks link in email → booking finalized
- Prevents fake email bookings but adds 30-60 seconds of friction

**Returning guest recognition:**
- If email matches previous booking, pre-fill name
- Show "You've booked with [host] before" friendly message
- Offer "Sign up to manage your bookings" (not required)

**Spam mitigation without auth:**
- Rate limiting per IP
- Honeypot form fields (hidden field that bots fill)
- CAPTCHA as escalation (only show if suspicious behavior)
- Host-level setting to require email verification

---

## 🔧 Deep Dive: Scheduling Configuration

> "Hosts have different needs - a therapist wants 50-minute sessions with 10-minute buffers, a sales rep wants 15-minute calls booked up to 60 days out, a consultant wants 90-minute sessions booked at least 48 hours in advance. The frontend needs to handle this variability gracefully."

### Variable Slot Durations

**The problem:** Different meeting types have different durations (15, 30, 45, 60, 90 minutes), and the UI needs to adapt.

**Considerations:**
- Slot display density changes with duration (more 15-min slots than 60-min slots)
- Buffer times (before/after) affect actual availability gaps
- Some hosts want custom durations (25 minutes, 50 minutes)

| Duration | Typical Use Case | UI Consideration |
|----------|------------------|------------------|
| 15 min | Quick calls, screeners | Many slots - consider grouping or scrolling |
| 30 min | Standard meetings | Default, fits well in list view |
| 60 min | Deep dives, interviews | Fewer slots - calendar feels sparse |
| 90+ min | Workshops, consulting | Very few slots - may need week view |

**Frontend approach:**

> "The UI shouldn't change dramatically based on duration - consistency matters. But I do adjust density. For 15-minute slots, I might show times in a compact grid (4 columns). For 60-minute slots, a single-column list works better because there are fewer options.

> The key is that hosts configure duration on their end. The guest just sees 'available times' without needing to understand the underlying math. The API returns computed slots, not raw availability windows."

### Booking Window Limits

**The problem:** How far ahead can guests book? This is host-configurable and affects what the calendar shows.

**Common configurations:**
- **Minimum notice**: Can't book within X hours (gives host prep time)
- **Maximum future**: Can't book more than X days out (prevents calendar clutter)
- **Rolling window**: Always shows next 14/30/60 days from today

| Window | Use Case | Trade-off |
|--------|----------|-----------|
| 7 days | High-demand hosts, urgent bookings | Limited flexibility |
| 14 days | Standard default | Good balance |
| 30 days | Consultants, monthly planning | More data to load |
| 60+ days | Executive scheduling | Calendar can feel overwhelming |

**Trade-off Analysis: How much to fetch upfront?**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Fetch visible window + prefetch next | Fast initial load, smooth scrolling | Slight delay on far-future months |
| ❌ Fetch entire booking window | No loading states when browsing | Slow initial load for 60-day windows |
| ❌ Fetch on-demand only | Minimal initial data | Spinner on every month change |

**Why incremental fetching:**

> "If a host allows booking 60 days out, fetching all 60 days of availability on page load is wasteful. Most guests book within 2 weeks. I fetch the current 2-week window initially, then prefetch the next 2 weeks when the user shows intent to browse further (hovering near 'next month' or scrolling down).

> The calendar should communicate the booking window clearly. If a host only allows bookings 14 days out, the calendar should disable or hide dates beyond that - not let guests click and then show an error. Gray out unavailable dates with a tooltip: 'Bookings open up to 14 days in advance.'"

### Minimum Notice Period

**The problem:** Hosts often need lead time - can't book a meeting 30 minutes from now.

**Common settings:**
- 1 hour minimum (quick availability)
- 4 hours minimum (same-day prep)
- 24 hours minimum (next-day bookings)
- 48+ hours (consulting, requires preparation)

**Frontend handling:**

> "Today's slots require special handling. If minimum notice is 4 hours and it's 2 PM, any slot before 6 PM today should be disabled. This changes in real-time as the clock ticks - a slot that was unavailable at 1:59 PM becomes available at 2:00 PM.

> I handle this client-side by filtering slots against current time + minimum notice. The server returns all theoretically available slots for the day, and the client filters based on the notice period. This avoids refetching when the clock ticks past a threshold."

### Configuration Display

**What guests need to see:**
- Meeting duration prominently displayed ("30 Minute Meeting")
- Booking window limits communicated via disabled dates (not error messages)
- Minimum notice reflected in grayed-out slots for today

**What guests DON'T need to see:**
- Buffer times (internal to host's schedule)
- Maximum bookings per day limits (just show slots as unavailable)
- Complex availability rules (host's concern, not guest's)

> "The guest experience should feel simple even when the underlying configuration is complex. A host might have 15-minute buffers, 4-hour minimum notice, 30-day maximum window, and 5 bookings/day limit. The guest just sees: some dates are available (blue dot), some aren't (gray), some times work, some don't. The complexity is hidden."

---

## 🔧 Deep Dive: Mobile-First Design

> "Most guests arrive via shared links on mobile - texted by a friend, tapped from an email signature, clicked from a social bio. The mobile experience isn't a scaled-down desktop; it's the primary experience."

### Why Mobile Dominates

| Traffic Source | Typical Device | Implication |
|----------------|---------------|-------------|
| Email signature link | Phone (checking email) | Thumb-friendly touch targets |
| Text from friend | Phone | Fast load on cellular |
| LinkedIn/Twitter bio | Phone (scrolling social) | Minimal data usage |
| Calendar invite link | 50/50 | Must work on both |

### Trade-off Analysis: Mobile Layout Pattern

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Bottom sheet for time slots/form | Native mobile feel, thumb zone friendly | Different code path from desktop |
| ❌ Same layout scaled down | Single codebase | Tiny touch targets, awkward scrolling |
| ❌ Separate mobile site | Optimized experience | Maintenance burden, URL complexity |

**Why bottom sheet pattern:**

> "When a guest taps a date, the time slots should slide up from the bottom - exactly where their thumb already is. Desktop users can see calendar and slots side-by-side because they have screen width. Mobile users need vertical stacking with smart interaction patterns.

> The bottom sheet is familiar from iOS/Android native apps. It can be swiped down to dismiss, dragged up to see more options. The booking form slides up the same way. This feels native to mobile users rather than 'a website on a phone.'

> The trade-off is implementation complexity. I need conditional rendering based on viewport, plus touch gesture handling for the sheet. But the UX improvement is substantial - mobile bookings feel intentionally designed, not cramped."

### Mobile-Specific Considerations

**Touch targets:**
- Minimum 44x44px for all tappable elements (Apple HIG standard)
- Time slot buttons spaced with 8px gaps to prevent mis-taps
- Form fields full-width for easy input

**Performance:**
- Target < 3 second first contentful paint on 3G
- Lazy-load non-critical assets (host avatar can be placeholder)
- Inline critical CSS for initial calendar render
- Avoid layout shifts as data loads

**Input patterns:**
- Email field: `type="email"` for @ keyboard
- Date selection: tap, not hover (no hover states on mobile)
- Form submission: sticky button at bottom of sheet

**Cellular reliability:**
- Show optimistic UI while booking request is in flight
- Clear feedback if network fails ("Couldn't reach server - tap to retry")
- Don't lose form data on network error

### Accessibility

- Keyboard navigation on desktop: arrow keys for dates, Enter to select
- Screen readers: `role="grid"` on calendar, `aria-live` for errors
- Focus management through progressive disclosure steps

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why Alternative Fails |
|----------|--------|-------------|----------------------|
| Booking flow | Progressive disclosure | Multi-page wizard | Higher abandonment between pages |
| Guest authentication | Anonymous (no login) | Required auth | Massive friction destroys conversion |
| Timezone conversion | Client-side | Server-side | Requires refetch on timezone change |
| Booking URL | Hybrid (slug + token) | Slug only | Enumerable, can't revoke leaked links |
| Booking window fetch | Incremental (2 weeks + prefetch) | Fetch all 60 days | Slow initial load, wasted data |
| Minimum notice | Client-side filtering | Server recalculation | Avoids refetch as clock ticks |
| Client cache TTL | 3 minutes | No cache | Sluggish browsing experience |
| Form submission | Pre-check + submit | Submit only | User fills form then gets conflict |

---

## 🎯 Summary

"This design focuses on the **guest booking experience** - the public-facing flow where someone clicks a shared link and books a meeting. The host dashboard is a separate concern.

**Anonymous booking** (no login required) maximizes conversion. Guests aren't platform users - they just want to book with Alice. Requiring authentication would add friction that kills conversion. Spam is handled through rate limiting, honeypots, and optional email verification.

**Progressive disclosure** reduces cognitive load by revealing the booking flow step by step. Users make easy choices first (date), then harder choices (time), then the commitment (form). This keeps them engaged rather than overwhelmed.

**Client-side timezone handling** enables instant timezone switching without API calls. Since slots are stored in UTC, changing the display timezone is just a re-render. This matters because users frequently verify times in different zones.

**Hybrid booking URLs** (slug + token) balance shareability with security. Hosts get memorable links they can share verbally, but can rotate the token if a link is leaked or abused.

**The key insight** is that guests are transient visitors, not committed users. They arrive via link, browse a few dates, book, and leave. I optimize for this transactional flow - minimal friction, fast interactions, clear feedback - rather than building features that assume guest engagement with the platform itself."
