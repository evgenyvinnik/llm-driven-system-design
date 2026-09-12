# 🔗 Design a URL shortener: frontend interview

> “I would design a small link-management application around a precise promise: after
> I create a link, I can tell which destination it represents, whether it is usable,
> and what the reported activity means. The redirect itself belongs to the server and
> should work without loading this application.”

This is a proposed production design for a 45-minute discussion. The checked-in React
application provides the starting product, but does not implement every mechanism
proposed here. [Architecture Implementation
Notes](./architecture.md#implementation-notes) describe its actual behavior.

| Time | Discussion |
|------|------------|
| 4 minutes | Product scope and visible states |
| 5 minutes | UI architecture and API responsibilities |
| 9 minutes | Deep dive: creating a link across uncertain responses |
| 8 minutes | Deep dive: account context and link lifecycle |
| 9 minutes | Deep dive: useful, honest analytics |
| 6 minutes | Rendering, accessibility, and performance |
| 4 minutes | Verification and scaling decisions |

## 🎯 Product scope and visible states — 4 minutes

I would start with three tasks: paste a URL and get a short link, manage previously
created links, and inspect one link's activity. Administrators can deactivate abusive
links and inspect operational summaries. Custom domains, QR codes, campaign billing,
and a general analytics report builder can wait.

Anonymous creation is useful because it makes the first interaction quick. I would
tell the person that an anonymous link will not appear in an account later unless we
deliberately implement a claim mechanism. Merely signing in after creation must not
silently assign ownership.

The management page can depend on authentication, but opening a short link should not.
A person receiving a link in a message goes directly to the resolver and then the
destination. A dashboard deployment or JavaScript failure should not break that
journey.

I would distinguish a draft, a submitted attempt, a confirmed link, and an attempt
whose outcome is unknown. The first two describe local work; a confirmed link is
server state. A spinner is a presentation of one state, not enough information to
recover a failed request.

For existing links, the important states are active, expired, and deactivated. Expired
and deactivated links may still belong in the owner's history. Removing a row from the
screen is not equivalent to erasing the mapping or stopping every cached redirect.

Analytics needs its own vocabulary: loading, current through a stated time, delayed,
unavailable, and empty. A zero from a successful query and an error fetching the query
should never share the same visual treatment.

> “The frontend's hardest job here is preserving the meaning of an operation while
> requests, navigation, and account state change around it. Rendering a short string
> is the easy part.”

## 🏗️ UI architecture and API responsibilities — 5 minutes

I would draw one small diagram and use it for the remaining discussion:

```
┌────────────────┐       ┌────────────────┐
│ Form and list  │──────▶│ Management API │
│ Analytics view │◀──────│ Auth + links   │
└────────────────┘       │ Reports        │
                         └────────────────┘
┌────────────────┐       ┌────────────────┐
│ Open short URL │──────▶│ Resolver       │──────▶ Destination
└────────────────┘       └────────────────┘
```

React components own the form draft, open panels, focus, and copy feedback. Shared
application state contains the current authenticated identity and durable operation
references needed across navigation. Server-derived lists and reports live in a query
layer with explicit keys and invalidation rules.

I would use a router for the dashboard, login, and selected link. Search, status
filters, and report range belong in the URL when they are useful to bookmark or share.
Passwords, raw tokens, and full form drafts do not belong there.

The query identity includes the account as well as the resource. A report for link A,
the last seven days, and a particular timezone is different from a report for link A
over a month. A global “latest analytics” object would make it too easy to display the
wrong result.

| Request | Frontend responsibility | Server responsibility |
|---------|-------------------------|-----------------------|
| Create link | Preserve submitted input and operation identity | Validate, claim code, commit one result |
| List owned links | Preserve filters and stable selection | Enforce ownership and return status plus cursor |
| Deactivate link | Show pending state and accepted result | Authorize mutation and report propagation semantics |
| Read analytics | Identify range, timezone, and freshness | Authorize, aggregate, and describe coverage |
| Check session | Reconcile visible account state | Determine current access and expiry |

The current resource paths use `/api/v1/urls` and `/api/v1/analytics/:shortCode`. I
would extend their contracts with operation recovery, explicit lifecycle fields, and
report freshness. Those additions cannot be implemented by changing browser state
alone.

The browser can reject an obviously malformed URL early, but the server decides
acceptance. Both layers must agree on alias length and allowed characters. If the
server stores at most ten characters while the UI permits twenty, users receive
avoidable failures even though both pieces appear individually validated.

## 🔧 Deep dive: creating a link across uncertain responses — 9 minutes

Consider a person submitting a campaign URL on a train. The server creates the link,
but the response disappears when the connection changes. If the page simply offers
“Try again” as a new request, the person can end up with two different links and split
analytics.

I would generate an operation identity when a particular draft is submitted. The
submitted URL, alias, and expiration become a stable snapshot for that attempt.
Transport retries reuse the same identity and contents. Editing the draft creates new
work rather than modifying an already submitted operation.

The server binds that identity to the caller and a digest of the accepted inputs. Its
durable receipt and mapping commit together. A retry can then recover the same short
code, and reuse of an identity with different input produces a conflict. For anonymous
users, the server needs a bounded anonymous operation context with unguessable
recovery access.

The browser should not invent or optimistically display a usable short code. Namespace
allocation is authoritative server work, especially for custom aliases. It can
immediately show a pending card with the submitted destination, then replace it with
the confirmed link after the server returns.

That card matters when the person edits the form while a request is pending. I would
either disable editing for the short submission interval or preserve draft and
submitted snapshot separately. Success must not erase a newer draft the user started
while waiting.

A network timeout moves the attempt to “Checking whether the link was created.”
Recovery looks up or retries the original operation. If recovery is temporarily
unavailable, keep the destination and attempt visible so the user can return later. Do
not turn an uncertain server outcome into a definite “creation failed” statement.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Confirmed result plus recoverable attempt | One identifiable result across retries | Requires a durable backend contract and recovery UI |
| ❌ New creation after every timeout | Simple client request handling | Duplicate links and fragmented activity |
| ❌ Optimistically invent the short code | Immediate appearance of completion | Can display an alias the server never granted |

Disabling the submit button helps prevent accidental double clicks in one component.
It does not handle a browser reload, a second tab, an interrupted response, or a
server retry. I would use it for interaction clarity while relying on the operation
protocol for correctness.

For a custom alias, the database's final claim is decisive. An optional availability
hint can improve the experience, but two people can both see “available” before either
submits. The final conflict should preserve the destination and offer a generated code
or a different alias.

I would avoid calling such a hint a reservation. A real reservation would require an
owner, expiry, and rules for abandonment. That complexity is unnecessary unless
holding a name is itself a product requirement.

Expiration input should state the unit and resulting deadline. The form may offer days
for convenience, but the server returns the actual expiration timestamp. I would show
that authoritative value on the result so clock and timezone assumptions do not
quietly change the user's expectation.

Copy feedback is a separate operation: “Link created” and “Copied” are different
successes. Clipboard access can fail. Keep the URL selectable and show a useful
failure message; a console log is not feedback for the person trying to share it.

> “I am accepting a little more state and a server receipt because creation has a
> durable side effect. I would not apply the same recovery machinery to opening a
> collapsible panel or changing a local filter.”

If the interviewer asks about offline support, I would preserve the draft locally with
an explicit privacy choice. I would not automatically submit it hours later without a
clear user intent and operation policy. Offline drafting is much simpler than offline
ownership of a globally unique alias.

## 🔧 Deep dive: account context and link lifecycle — 8 minutes

Now imagine Alice's link list is loading when she signs out and Bob signs in. If
Alice's response arrives late and writes into a shared list, Bob can see stale private
content even though every API request was individually authorized when sent.

I would scope server data to the authenticated account and maintain a session
generation for in-flight work. Logout invalidates the generation, clears
account-derived caches, and removes private selections. A response only updates
visible state if its account and generation still match.

Canceling requests is useful to reduce work, but cancellation alone is insufficient.
The request may have completed already, or a promise callback may be queued. The
identity check is the final protection against applying a response to a different
context.

A persisted user object can improve initial rendering, but it is not proof of a
current session. On startup, the application reconciles it with the server before
exposing privileged actions. A 401 or 403 should update access state and preserve
recoverable work without repeatedly retrying a forbidden operation.

Server ownership checks remain mandatory. Hiding an analytics button for someone
else's code does not protect the analytics endpoint. Short codes are meant to be
shared, so knowledge of a code cannot grant access to its raw activity records.

For deactivation, I would keep the row visible with a pending state and disable
conflicting actions on that row. After acceptance, show the server's lifecycle result.
This makes the relationship between the action and the historical record easier to
understand than immediately making the row disappear.

The label should match the behavior. “Deactivate link” is clearer than “Delete” if the
service retains ownership, history, and analytics. If ordinary deactivation can take
five seconds to reach every serving region, the response and UI should distinguish
acceptance from completed enforcement.

This is a backend constraint expressed in the interface. The browser cannot make an
old cached mapping disappear. For a high-risk administrative takedown, I would show
enforcement progress or a failure that needs action, rather than a success toast based
only on one SQL update.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Explicit lifecycle with pending mutation | Users can understand history and enforcement | More states than simply removing a row |
| ❌ Treat a removed row as completed deletion | Minimal visual state | Hides uncertainty and can contradict reloads |
| ❌ Trust persisted account state indefinitely | Fast initial render | Stale privileges and cross-account responses |

A list read started before a successful mutation can also arrive late. I would
invalidate that query and compare returned resource revisions before applying it.
Optimistic presentation can be useful, but it should not let an older read resurrect
an active badge after deactivation.

For a first version, I would prefer a confirmed lifecycle update with clear row-level
progress. Deactivation is uncommon enough that an immediate optimistic removal is not
worth the added rollback ambiguity. If measured interaction needs later justify
optimism, the revision protocol still has to exist.

List responses need stable status fields and a deterministic cursor. New links can
arrive while someone pages through history. A cursor based on creation time plus a
unique tie-breaker avoids the shifting offsets that can skip or repeat rows during
inserts.

I would keep the currently selected link stable by code, not array index. If a refresh
changes row order, an open analytics panel must continue referring to the same link.
If access is revoked, close or replace that panel with an explicit access state.

## 🔧 Deep dive: useful, honest analytics — 9 minutes

Before selecting a chart library, I would define the metric. A redirect request is not
necessarily a person: messaging previews, crawlers, retries, and repeated opens can
all generate traffic. Conversely, a request may redirect successfully but never reach
the destination.

I would label the primary metric “Redirect requests” or another name agreed with the
product team. If we later offer estimated people or filtered human activity, that
becomes a separate metric with its own method and limitations.

The frontend cannot reconstruct missing observations. It needs the API to distinguish
the end of the requested range, the latest processed data, and known collection gaps.
“Updated just now” can otherwise mean only that an old aggregate was fetched again.

A useful report response contains the selected code, range, timezone, totals, buckets,
and freshness metadata. I would keep those together in one query result so the title,
chart, and total cannot accidentally come from different requests.

Suppose the person opens link A and then quickly selects B. A's slower response must
not replace B's chart. The same rule applies to changing date range. Query identity
and a response guard make this deterministic; one global loading flag does not.

I would allow the last successful report to remain visible during refresh, with an
indication that it is being refreshed. An error then leaves useful historical context
while showing that it may be stale. On the first load, an error should not display an
empty chart that implies no activity.

Missing time buckets require a deliberate interpretation. A zero is appropriate only
when the query covers that bucket and collection is known to be complete under the
metric's contract. An unprocessed interval or admission outage should be marked
unavailable or incomplete.

Timezone is part of the query, not just a date formatter. Converting UTC labels in the
browser after the server grouped by another timezone produces misleading daily totals.
I would have the server aggregate using the requested zone and return explicit bucket
boundaries.

A 24-hour report also needs full timestamps. Grouping only by hour number mixes
portions of different dates and can make midnight appear in the wrong place. This is
an example where the UI must question a convenient API shape rather than decorate it.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Poll aggregated reports with freshness | Simple recovery and understandable lag | Updates arrive at a bounded interval |
| ❌ Push every click to the browser | Appears live at low traffic | Bursts, reconnect gaps, and client counting complexity |
| ❌ Replace errors or missing buckets with zero | Easy chart construction | Misrepresents activity and outages |

For the initial dashboard, I would poll while the report is visible and stop when it
is hidden. Back off after failures and refresh when the user returns. A campaign owner
usually needs a stable summary more than a rapidly changing stream of individual
clicks.

If a live monitoring requirement emerges, I would push aggregate versions or
invalidations and fetch a fresh snapshot. Reconnect should recover from a server
snapshot rather than assuming the browser saw every intermediate event. This keeps the
report query as the authority.

For daily activity, a bar chart with an accompanying table is enough. Device and
referrer breakdowns can be small ranked lists. I would avoid rendering raw events by
default: they are expensive, potentially sensitive, and usually less useful for the
core task.

A total in the link list and a total in a detail report may use different processing
times. The product should either align them to one defined projection or explain the
difference. Silently treating a mutable mapping counter and an event-derived total as
interchangeable invites confusion.

> “The trade-off is accepting visible delay in return for a report that has a stable
> meaning. Making a number animate faster does not improve its accuracy.”

## ⚡ Rendering, accessibility, and performance — 6 minutes

The frontend workload is much smaller than redirect traffic. A service may handle
billions of redirects while an individual owner views fifty rows. I would size the UI
around actual dashboard interactions rather than importing the resolver's traffic
figure into a browser rendering problem.

Paginate link history and aggregate report data at the server. A modest first page
does not need virtualization. If users later browse hundreds of retained rows in one
continuous view, a virtualized list can help, but it introduces focus, measurement,
and accessibility work that should solve a measured problem.

I would route-load the admin area and any substantial chart code so an anonymous
visitor can use the basic form promptly. The initial page needs little JavaScript
beyond validation, submission, and result handling. A server-rendered landing page is
optional for marketing needs, not necessary for the redirect path.

Long destination URLs can overflow a narrow screen. Show a readable host and truncated
visual text while keeping the complete destination accessible on inspection. Preserve
a selectable short URL, visible labels, and keyboard access to advanced fields.

After validation failure, focus the first invalid field and associate its error text.
After success, announce the created result without unexpectedly moving focus away from
someone continuing to type. Copy feedback should be announced without relying only on
color.

An analytics overlay needs a name, initial focus, escape handling, and focus
restoration to the opening control. If the screen is narrow, a dedicated detail route
may be more usable than squeezing a complex modal into the viewport.

Administrative tables need horizontally usable layouts and explicit button states.
Avoid a whole-page spinner for one row mutation. A failed action should remain
associated with that row so an administrator knows which link still needs attention.

I would measure time to usable form, submission responsiveness, report render time,
and failed or recovered operations. Request counts alone do not reveal whether users
can copy a result or understand a failed deactivation.

## 🧪 Verification and scaling decisions — 4 minutes

The most valuable tests cross state transitions. I would lose a creation response
after commit and verify that recovery returns one link. I would then edit a draft
during a pending request and confirm that the old success does not erase the new
input.

For account isolation, delay Alice's list response, sign in as Bob, and release it.
Bob's view must remain unchanged. For lifecycle handling, deliver an older list after
a deactivation response and verify that it cannot restore an active state.

For analytics, rapidly switch links and ranges, simulate a failed refresh, and return
an incomplete collection window. The chart title, buckets, totals, and freshness label
must remain attached to the same query identity.

I would test keyboard-only creation, clipboard failure, narrow layouts, and a report
with no eligible events. These exercise real user outcomes rather than merely checking
that a page contains a `main` element.

The local implementation currently lacks these recovery and context guarantees. It
uses direct fetch calls, shared URL loading state, persisted user data without
unconditional reconciliation, and one-page lists. Its analytics is fetched on demand
without a freshness watermark.

> “I would first make creation recoverable and account changes safe, then make report
> freshness explicit. Pagination and a small chart are enough until measured usage
> justifies more rendering complexity.”
