# 📅 Design a scheduling application: frontend interview

> “I would focus on a guest choosing a time, making one reservation, and understanding
> the result even if the connection drops. The calendar is the main visual element,
> but the difficult work is keeping dates, availability, and booking state
> consistent.”

This is a proposed production design for a 45-minute interview, grounded in the local
React scheduling demo. Mechanisms proposed here are not all implemented.
[Implementation Notes](./architecture.md#implementation-notes) distinguish the current
source from the design.

| Time | Discussion |
|------|------------|
| 4 minutes | Product scope and visible states |
| 5 minutes | UI architecture and API boundaries |
| 9 minutes | Deep dive: dates, timezones, and calendar coverage |
| 9 minutes | Deep dive: booking across uncertain responses |
| 8 minutes | Deep dive: availability and asynchronous state |
| 6 minutes | Host editing, accessibility, and performance |
| 4 minutes | Verification and growth |

## 🎯 Product scope and visible states — 4 minutes

I would clarify that we are scheduling one guest with one host. The host defines
weekly working hours and event types, each with a duration and buffers. The guest
opens a shared link, chooses a timezone and time, enters contact details, and books
without creating an account.

The guest can subsequently cancel or reschedule through a scoped management link. The
host has a signed-in dashboard for upcoming meetings, event types, and availability.
Group events, round-robin assignment, payments, and recurring appointment series are
outside this first discussion.

I would ask whether external calendars must participate. For the initial design, the
service owns its reservations. An external-calendar extension needs freshness
indicators and reconciliation; the UI must not promise that every independently edited
calendar is synchronized at the instant of booking.

The calendar needs distinct loading, available, fully booked, outside working hours,
and unavailable states. A failed request does not establish that the host has no free
time. Likewise, an empty response must not cause the date picker to enable every
future day.

The booking form has a draft, an attempt in progress, a confirmed result, a rejected
choice, and an unknown outcome. Those states determine which actions remain possible.
A timeout after submitting is different from discovering that the chosen slot was
taken.

A confirmation includes the actual date, time, timezone, duration, host, and booking
reference returned by the server. Email delivery is a separate status. Showing
“Booked” is reasonable after the reservation commits; showing “Email sent” requires
evidence from that separate delivery process.

> “I would design the failure states before polishing the calendar. They determine
> whether someone retries safely or accidentally creates a second appointment.”

## 🏗️ UI architecture and API boundaries — 5 minutes

I would draw three screens and two server responsibilities:

```
┌────────────────┐       ┌────────────────┐
│ Guest calendar │──────▶│ Availability   │
│ Booking form   │──────▶│ Booking API    │
└────────────────┘       └───────┬────────┘
                                 │
┌────────────────┐               │
│ Host dashboard │───────────────┘
│ Rules editor   │
└────────────────┘
```

React components own focus, open dialogs, and editable form fields. A query layer owns
server-derived event types, availability, and booking lists. Shared state contains
session status and any operation reference needed to recover a submitted booking after
navigation.

I would avoid copying a selected booking into multiple stores. One authoritative
result can feed the confirmation and management view. Derived labels, such as a
formatted time, are recalculated from that result and the chosen display zone.

The URL identifies the public event type and, when useful, the displayed month.
Private guest capabilities require deliberate handling so that analytics and request
logs do not capture them. Email addresses and notes should not become query parameters
merely to preserve a form.

| API responsibility | What the browser supplies | What the server decides |
|--------------------|---------------------------|-------------------------|
| Public event metadata | Event-type identifier | Current published policy |
| Availability range | Event type, interval, display zone | Eligible candidate instants and coverage |
| Create booking | Selected instant, contact details, operation identity | Current eligibility and reservation result |
| Recover attempt | Operation identity and recovery proof | Committed result or known pending state |
| Change booking | Booking reference, capability, expected revision | Authorization and valid transition |
| Save host rules | Complete edited policy and expected revision | Validation and new policy revision |

These are responsibilities, not a requirement for six independently deployed services.
I would start with ordinary HTTP requests. Availability changes do not initially
justify maintaining a persistent connection for every visitor.

A server-side conflict check remains mandatory even if the browser refreshes
immediately before submission. Another guest can book between the refresh and the
write. The frontend can improve the choice presented, but it cannot reserve time by
disabling a button.

The public flow can load independently from the host session check. Private routes
wait for an explicit authenticated or anonymous result before loading account data.
“Authentication is still loading” must not accidentally act as permission to render a
private page.

## 🔧 Deep dive: dates, timezones, and calendar coverage — 9 minutes

I would separate three concepts: a host's recurring local working time, a calendar
date in a chosen zone, and a booking instant. A Monday 09:00 rule is local intent. A
booking has a particular start and end on the global timeline.

That distinction matters when offsets change. A host who works at 09:00 expects the
schedule to remain at 09:00 locally. Repeating a fixed UTC hour can shift those
working hours after a seasonal transition. Timezone rules also change over time; I
would use IANA zone identifiers and maintained runtime data. [IANA timezone
database](https://www.iana.org/time-zones).

The browser should receive candidate start and end instants from the server. It
displays them in the guest's selected zone and submits the selected instant unchanged.
Reconstructing the timestamp from a text label such as “9:30 AM” loses the date, zone,
and repeated-hour distinction.

For a visible calendar day, I would define the interval from midnight in the selected
zone to the next midnight in that same zone. It may span parts of two host dates. It
is not always a fixed 24-hour interval, and browser-local midnight is irrelevant if
the guest selected another zone.

The API must state which interval it covered. When the guest changes timezone,
existing instants can be reformatted immediately, but they may not cover the newly
visible day. I would fetch any missing range before claiming that the day has no
additional slots.

For example, late afternoon in Los Angeles can be the next calendar day in Tokyo.
Changing the display zone may move a selected meeting to tomorrow without changing the
meeting itself. The calendar highlight, date heading, and confirmation must move
together.

The product needs an explicit rule for timezone changes. In the time-selection step, I
would preserve the instant only if it remains in the loaded valid range and visibly
move the date selection. If the policy is instead to clear the selection, I would
return to time selection and explain the change.

I would not leave the person on the contact-details step with a missing slot and a
submit button that silently does nothing. That is a state-transition bug, even if
clearing the underlying value was intended to prevent a stale booking.

Daylight-saving transitions add two edge cases. A spring transition can remove a local
clock time. An autumn transition can repeat it. The server's policy should omit
nonexistent candidate times and distinguish repeated times by their actual instants;
the UI can append an offset when the labels would otherwise be identical.

This is a policy decision, not something to hide behind a date library's default
conversion. I would test the exact helpers we use and verify what happens to ambiguous
or nonexistent inputs. A valid-looking timestamp is not evidence that the host's
intended wall time was preserved.

Buffers are usually host-facing occupied time rather than extra meeting duration shown
to the guest. The UI can explain that a 30-minute meeting lasts 30 minutes while the
host's surrounding time remains unavailable. It should not display a 50-minute
appointment merely because prep and recovery each take ten minutes.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Server returns instants with explicit range coverage | One scheduling authority; display remains flexible | More careful range and timezone contracts |
| ❌ Browser generates slots from local labels | Simple initial calendar component | Duplicates policy and mishandles cross-zone dates |
| ❌ UTC-only weekly rules | Easy recurring arithmetic | Host working hours can move seasonally |

The cost of the chosen model is additional metadata and edge-case testing. I would
accept that cost because a calendar that occasionally books the wrong day is not made
usable by a faster rendering path.

> “I would put one host-local day and one guest-local day on the whiteboard, then map
> both to the timeline. That example explains the API contract more clearly than a
> long list of date-library functions.”

## 🔧 Deep dive: booking across uncertain responses — 9 minutes

When the guest submits, I would freeze the meaningful attempt input: event type,
selected instant, contact details, and timezone. A stable operation identity belongs
to that attempt. Further edits either wait for its outcome or explicitly start a new
attempt after the old one is resolved.

Disabling the submit button is useful immediate feedback, but it only prevents
repeated clicks in this component. It does not cover browser retries, refreshes,
multiple tabs, or a response lost after the server commits.

The server binds the operation identity to the normalized input and stores a durable
result. Retrying the same attempt returns that result. Reusing the identity with
different details is a conflict that the UI should expose, not permission to silently
book a different time.

I would retain a minimal recovery reference across refresh, with a guest-scoped proof
that permits reading that attempt's outcome. Contact notes and email addresses do not
need to be copied into general persistent browser state for this purpose.

The guest should not have to infer success from whether an email arrives. Delivery may
be delayed or unavailable, and the address may contain a typo. The booking system
itself must provide outcome recovery.

| Result | Guest experience | Next action |
|--------|------------------|-------------|
| Confirmed | Show returned booking and management link | Allow deliberate later changes |
| Slot conflict | Explain that the time was taken; retain contact draft | Refresh choices and select another slot |
| Validation failure | Identify the relevant field | Correct it before a new attempt |
| Known processing | Keep the attempt reference and show progress | Poll with bounded backoff |
| Unknown after timeout | Explain that confirmation is being checked | Recover the same attempt; do not create another |

I would distinguish a transport retry from a new booking. After a conflict, choosing a
different slot is new intent and receives a new operation identity. After a timeout
with unchanged input, retrying uses the existing identity.

The confirmation view reads only from the returned booking snapshot. It does not
combine the old selected slot with the current email field. A user may have changed
the draft while the request was pending, or a background availability request may have
cleared the old selection.

If the server reports notification pending, the reservation remains confirmed. I would
show the management link and a concise delivery status. Re-running booking creation to
resend an email would mix two different operations and can produce duplicate meetings.

Cancellation and rescheduling also need recoverable operations. A reschedule submits
the expected booking revision and a new slot. If someone changed the appointment in
another tab, the server returns the latest state so the person can decide whether
their intent still applies.

A failed reschedule must preserve the original appointment. The UI keeps the old
confirmed time visible until the replacement commits, then swaps to the new server
result. Optimistically erasing the old appointment creates confusion if the new time
is unavailable.

A guest management capability should authorize only the intended booking and actions.
The public booking identifier alone should not be sufficient to expose names, notes,
email addresses, or unrestricted changes. Host access is a separate authenticated
path.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Confirm from a recoverable server operation | Handles committed writes with missing responses | Requires recovery UI and a durable server receipt |
| ❌ Confirm optimistically on submit | Appears immediate | Can claim ownership of a slot another guest won |
| ❌ Treat every timeout as failure | Simple error handling | Encourages duplicate attempts after successful commits |

I would use optimistic UI for local drafts and reversible display preferences. A
reservation is scarce shared capacity, so a server-confirmed transition is worth the
round trip. The important responsiveness work is preserving input and explaining
progress while that round trip happens.

## 🔧 Deep dive: availability and asynchronous state — 8 minutes

Availability is derived data. Its query identity includes the event type, requested
interval, display interpretation, and the server's policy or availability revision.
Different hosts or months must not share a single global slots array without a
corresponding identity.

Consider opening event type A and then B while A's request is slow. If A resolves
last, it must not replace B's slots. Cancelling obsolete requests reduces wasted work,
while checking the active query identity prevents a late result from being displayed
even if cancellation arrives too late.

The same rule applies to timezone changes and rapid date clicks. I would scope loading
and error state to the request being shown. One shared loading boolean can turn off
the spinner when an unrelated request finishes.

A month summary tells the calendar which days have choices. A selected-day query
supplies the actual slots. Month navigation must fetch the newly visible range;
fetching only the next 30 days once and then allowing unlimited month navigation
produces misleading disabled dates.

I would distinguish “this range has not loaded” from “this range loaded with no
choices.” The picker should neither invent availability during an error nor
permanently disable every date because a summary request failed.

The cache can serve recent choices quickly. I would show a refresh state when
revisiting a stale range and always revalidate at booking. A cache TTL is a bound on
intended reuse, not a promise that every policy edit was propagated correctly.

A booking affects all event types sharing the host. Invalidating only the event type
used for that booking leaves the host's other public pages stale. The server should
expose host-wide revisions or invalidation events; the client refetches the active
range after a successful mutation or conflict.

Daily caps need careful presentation. If one booking remains under the cap, there may
still be many alternative times at which it can be used. Displaying only the earliest
slot confuses remaining capacity with the number of valid choices.

I would start with fetching on navigation, focus, relevant mutations, and short
bounded revalidation while the booking screen is active. This is simpler to recover
after network loss than a mandatory streaming connection for every guest.

Push becomes useful if measurements show that hot hosts repeatedly produce conflicts
between refreshes. Even then, a pushed “availability changed” revision can invalidate
the range rather than requiring the browser to rebuild the host's complete schedule
from individual events.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Cached ranges plus transactional revalidation | Fast browsing with one acceptance authority | Some displayed choices can be taken before submission |
| ❌ Reserve every displayed slot | Stronger apparent browsing guarantee | Idle visitors hold scarce host capacity |
| ❌ Push as the only source of truth | Quick updates while connected | Missed events and reconnects need another recovery path |

A temporary hold could be justified for a longer paid checkout, but it needs expiry
and abuse controls. For a short name/email form, I would first measure conflict
frequency and improve recovery rather than introducing holds automatically.

## 🛠️ Host editing, accessibility, and performance — 6 minutes

The host editor should preserve the data model it loads. If multiple working intervals
are allowed, a Monday with 09:00–12:00 and 14:00–17:00 must remain two intervals after
an unrelated edit. A one-row-per-day component must not silently overwrite the second
interval.

I would label the host's stored timezone next to the weekly rules. A browser in
another zone should not relabel those rules using its local zone. Changing the host
timezone is a deliberate policy edit with a preview of its effect on future
availability.

Policy saves include an expected revision. A conflict offers the current saved policy
and preserves the local draft. This avoids one tab overwriting another host edit
without notice.

The event editor should support every policy field it promises, including daily caps
if they are part of the product. Disabling an event type stops new bookings; deleting
it should not unexpectedly erase historical appointments. The server must define those
semantics before the UI offers the action.

For accessibility, I would make dates and slots keyboard reachable, expose the
selected date and timezone in text, and announce loading or conflict updates without
moving focus unexpectedly. Error messages belong near their fields, and confirmation
should move focus to a meaningful heading.

Long host lists use pagination and bounded queries. A month calendar and a few dozen
slots do not need virtualization by default. I would virtualize a large agenda only
after measuring its item count and rendering cost, preserving keyboard navigation and
accessible list meaning.

Static assets can be cached at the edge. Private booking details and guest
capabilities need separate caching rules. I would measure time to usable choices,
booking outcome latency, and recovery success, with no attendee notes or email
addresses in analytics events.

## 🧪 Verification and growth — 4 minutes

I would demonstrate a complete guest booking, then deliberately lose its response and
recover it. Next I would open two guest sessions on the same slot and verify that one
receives a conflict without losing its contact draft. These tests exercise the product
promise more directly than checking that a page contains a main element.

Timezone cases include a guest day crossing two host dates, a non-hour offset, a
spring gap, a repeated autumn hour, and browser/server zones that differ from the
selected zone. Request-race tests resolve old date and event-type requests after the
newer ones.

I would also test cancellation after a stale detail read, rescheduling into a taken
interval, expired guest access, an availability outage, and an account switch while
private queries are pending. Each test should assert the visible state and the
persisted reservation outcome.

The current local demo is a useful starting UI, but it uses draft-derived
confirmation, has no rescheduling screen, and conflates some empty/error states. Its
timezone changes and request dependencies can leave selection inconsistent. These are
documented limitations, not assumed production features.

At higher scale, I would first inspect availability cache hit rate, range-query cost,
and conflict frequency by host. Those measurements tell us whether we need broader
prefetching, a push invalidation channel, or server-side admission controls. They do
not justify replacing the entire frontend architecture merely because the total user
count grew.
