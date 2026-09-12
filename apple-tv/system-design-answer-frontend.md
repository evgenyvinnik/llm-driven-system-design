# Apple TV+ — frontend system design interview

A proposed streaming-service frontend, explained in 45 minutes. This is a design
exercise, not a claim about Apple's internal software. The local project is a React
catalog and timer-player demo; production additions are intentional.

| Discussion | Minutes |
|------------|---------|
| Clarify the viewing experience | 4 |
| Draw the client and its contracts | 5 |
| Deep dive: reliable playback | 10 |
| Deep dive: account and profile context | 8 |
| Deep dive: resume across devices | 8 |
| Performance and accessibility | 6 |
| Failures, validation and local comparison | 4 |
| Total | 45 |

## 🎯 Clarify the viewing experience — 4 minutes

> “I would first establish whether we are building live television or a subscription
> library. I will assume video on demand, where the hard experience is getting from a
> title to uninterrupted playback, then resuming elsewhere.”

The primary journeys are browsing a household profile's recommendations, opening a
movie or episode, starting playback, and returning to Continue Watching. Users also
need search, a watchlist, accessible captions and an understandable
subscription-required state.

I would focus this interview on a responsive web client. A television app adds
directional focus and platform media integration; a native mobile app adds its own
lifecycle and license storage. I can share contracts and design principles without
pretending one React tree solves every platform.

Offline downloads are a follow-up. Cached posters are useful when disconnected, but
protected offline playback needs supported media and license storage. I would not
offer a Download button until that lifecycle exists.

My proposed target is p95 under two seconds from Play to first frame on a specified
network/device cohort. I would also track failed starts, rebuffering and abandonment.
An average that mixes a fast desktop with an unsupported television hides the problem.

The catalog should remain useful when recommendations fail. Once a stream is running,
a delayed watchlist or progress request should not interrupt video.

I would ask whether profiles are a convenience or a parental-control boundary. I will
assume profile-specific history and kids restrictions, with the server enforcing
access rather than relying on hidden cards.

A small set of concrete acceptance cases keeps the discussion grounded:

| Journey | Expected behavior |
|---------|-------------------|
| Select another episode | Old responses cannot replace the new selection |
| Network slows | Lower quality before exhausting the buffer where possible |
| Switch to a Kids profile | Personal rows clear and restricted playback is rechecked |
| Close and reopen | Resume from acknowledged progress, with bounded possible loss |
| Session expires | Explain the access problem and preserve recoverable context |

## 🏗️ Draw the client and its contracts — 5 minutes

> “I would draw the interface, the media engine and the two server paths. The
> interface manages intent; the media engine manages actual playback.”

```
┌────────────────┐                  ┌────────────────┐
│ Routes + UI    │─ control ───────▶│ Account APIs   │
│                │                  │ Catalog / sync │
└────────────────┘                  └────────────────┘
        │ intent
        ▼
┌────────────────┐                  ┌────────────────┐
│ Media engine   │─ media ─────────▶│ CDN + origin   │
│ Video surface  │                  │                │
└────────────────┘                  └────────────────┘
```

The media engine reports local playback events back to application state. A separate
protected license request accompanies media startup where required. I would add that
arrow verbally instead of crowding the first drawing.

The route identifies the title and browse filters. A server-data cache holds catalog
pages and personal lists. A small client store holds account/profile context and
control preferences. Transient menus and hovered cards remain local component state.

The playback controller owns one media-engine instance per playback generation. It has
an explicit lifecycle: loading metadata, authorizing, preparing media, playing,
waiting, paused, ended or failed. These states describe what happened, not just what
button was last pressed.

I would keep player progress out of a whole-application render loop. Media events
update a lightweight controller; the time display subscribes at a useful visual
frequency, while the browse shelf does not rerender every fraction of a second.

The server contract matters more than a library list:

| Contract | What the frontend needs |
|----------|--------------------------|
| Catalog/detail | Stable IDs, media revision, availability and episode relationships |
| Playback session | Session ID, supported rendition metadata, access expiry and license location |
| Progress read/update | Accepted position, revision and explicit stale/conflict outcome |
| Personal lists | Account/profile identity and a bounded page or complete small set |
| Error response | Stable category, retryability and a correlation ID |

Catalog availability is advisory. Playback authorization makes the final decision
because a subscription or regional right can change between browsing and pressing
Play.

## 🔧 Deep dive: reliable playback — 10 minutes

### Make the media engine authoritative

> “I would use a supported media engine behind a small adapter, then spend my effort
> on the experience around it. Codec support, buffering and recovery are too
> consequential to infer from a timer.”

On supported Apple platforms, HLS and the platform playback/protection facilities are
a natural integration path. A web compatibility plan still has to establish the
supported browser, media engine and DRM combinations. FairPlay protects playback
through Apple's documented client and key-server workflow; ordinary JavaScript state
is not a replacement. [Apple FairPlay
Streaming](https://developer.apple.com/streaming/fps/)

When a user presses Play, capture title, profile and playback generation. Request
authorization, fetch resume state and prepare the selected media revision. Independent
requests can overlap, but the controller must validate context before applying either
response.

After metadata is ready, clamp the saved position to the valid timeline and ask the
engine to seek. Only then request playback. Autoplay restrictions or decoder errors
can reject that request, so the UI must wait for actual playback events before showing
a confident Playing state.

A loading indicator should distinguish a normal short preparation phase from a
persistent problem. After a bounded wait, show a useful action such as Retry, Choose
another title or Sign in. A spinner with no state transition is not recovery.

### Adapt to measured conditions

The engine starts with a conservative compatible rendition. It estimates sustainable
throughput and observes buffered duration, then adjusts quality with headroom. If
bandwidth falls, a lower rendition may keep the next segment from arriving too late.

I would use hysteresis: lower quality promptly under pressure, but require stronger
evidence before increasing it. Otherwise a connection near a threshold causes repeated
switching, which users can notice even without a full stall.

Manual quality is a preference or cap, with clearly defined behavior if it cannot be
sustained. The interface should not promise uninterrupted 4K on a link that cannot
deliver it. Auto is the default because users usually care more about continuity than
controlling a resolution number.

A quality label should come from the rendition actually selected by the engine. HDR
and audio capabilities need valid packaged assets and compatible decoding/output, not
a boolean copied from a catalog card.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Established media engine with adapter | Handles buffering and platform events; UI remains portable | Integration, bundle and device compatibility work |
| ❌ Handwritten application ABR loop | Complete control over a narrow experiment | Easy to mishandle buffer, decode and recovery behavior |
| ❌ Fixed highest rendition | Simple selection logic | Poor links repeatedly stall and some devices cannot decode it |

The chosen approach gives up control over some low-level decisions. I would expose
measured events and limited configuration, then verify performance on representative
devices rather than promising one optimal setting for all viewers.

### Recovery is part of the state machine

Network failure, authorization expiry and an unsupported codec require different
responses. A short transient fetch failure gets bounded retry with jitter. Expired
access gets one coordinated renewal. Repeated decoder failure ends the attempt with a
visible explanation.

Renewal retains the playback session and media revision so progress identity does not
change during routine credential refresh. Multiple simultaneous segment errors should
share one renewal attempt rather than creating a request storm.

Switching titles increments the generation before starting asynchronous work. Cleanup
detaches listeners, cancels pending fetches, stops the prior engine and invalidates
late callbacks. Cancellation alone is insufficient because a response or event may
already be queued.

If the first title's authorization arrives after a second selection, the generation
check discards it. The same rule applies to saved progress, subtitle metadata and
error messages. A stale error should not replace a successfully playing new title.

The key trade-off is explicit lifecycle complexity in exchange for predictable
behavior. Several independent booleans are easier to begin with, but permit
combinations such as Playing and Failed with media belonging to another selection.

## 🔧 Deep dive: account and profile context — 8 minutes

### Define what a profile switch means

> “A profile switch changes the identity of personal data. I would treat it as a
> context transition, not just replace the avatar in the header.”

A persisted profile is a preference to restore, not proof of current authorization. On
startup, the client asks the server for account and valid profile context before
displaying personal data. If the stored preference was deleted or belongs to another
account, the UI returns to profile selection.

A switch first stops or hands off the current playback according to product policy. It
then submits the selected profile, waits for server acceptance, clears personal views
and starts a new request generation. Public artwork can remain cached.

The server must check profile ownership for every personal operation. Even a perfectly
managed client cannot prevent a forged request, deleted profile or stale cookie from
reaching an API.

For the request cache I would include account, profile and relevant filters in keys. A
request captures those values at dispatch. Its result can update that cache entry, but
cannot repaint a different active profile.

Logout invalidates requests and clears personal state even if the logout network call
fails. The UI should explain any server logout uncertainty rather than silently
implying all remote sessions were revoked.

### Scope optimistic changes narrowly

Watchlist membership is a useful optimistic interaction because adding an
already-present title can have the same final state. The server contract should set
membership explicitly, not toggle based on whatever state happens to exist when the
request arrives.

Each mutation records its context and sequence. A late failed Add should not undo a
later successful Remove. Reconciliation applies the authoritative response only if it
still corresponds to the relevant pending intent.

If a new account signs in while an old request is in flight, its result must not enter
the new account's store. That matters for privacy as well as visual correctness.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Context-keyed cache and request generations | Prevents stale cross-profile display; supports reuse within context | More explicit invalidation and mutation handling |
| ❌ One shared list for all profiles | Small implementation | Old requests can overwrite the next person's watchlist/history |
| ❌ Clear everything and trust cancellation | Simple visible reset | Late responses can repopulate cleared state |

I would accept a short skeleton during the switch. Showing the previous viewer's
history while pretending the next profile is active is a worse experience than a brief
acknowledged loading state.

### Keep parental controls consistent

A Kids profile can have a filtered discovery experience, but direct links and playback
still need server authorization. Search, detail, history and recommendations should
apply a coherent visibility policy.

If a restricted title disappears while its detail page is open, stop offering Play and
display its current availability. I would avoid silently routing to another title,
which makes it unclear what the viewer authorized.

Administrative screens use separate permissions and request keys. Hiding their
navigation entry is useful interface behavior, but it is not the authorization
boundary.

## 🔧 Deep dive: resume across devices — 8 minutes

### Separate a position from a viewing event

> “I want the last accepted viewing intention, not necessarily the largest number of
> seconds. A viewer may intentionally rewind or restart an episode.”

The controller sends progress periodically and after a meaningful seek, pause or
handoff. Each update includes playback session, increasing sequence, position and the
base revision known to the client. A retry reuses the same identity and payload.

The server acknowledges a durable revision. The client can mark that snapshot saved,
while continuing to show its more recent local position. Losing a response should
trigger a retry or status lookup, not a new event with a fresh identity.

For a proposed fifteen-second interval, a viewer who abruptly loses power may lose up
to roughly one interval plus in-flight delay. That is an explicit product trade-off.
An unload request is a useful final attempt but cannot guarantee delivery after a
crash.

The periodic scheduler should be stable and read the latest position from the
controller. Recreating a fifteen-second timer every time the display updates can
prevent it from ever firing during continuous playback.

I would not send a write for every time update. At two million simultaneous viewers,
fifteen-second updates are already about 133,000 requests per second before retries.
Every-second writes would multiply pressure with little improvement for ordinary
handoff.

### Resolve competing sessions explicitly

Suppose the television has reached minute forty while a laptop rewinds to minute ten.
Maximum-position merging ignores the rewind. Client-clock last-write-wins can also
choose the wrong update if a clock is wrong or an offline batch arrives later.

This design gives an explicit new playback handoff a newer session generation. Within
that generation, sequence numbers order updates. Older sessions can report analytics
without moving the shared resume pointer.

If simultaneous viewing on one profile is allowed, the product must define whether to
choose an active device or ask which position to resume. I would not claim that a
timestamp can infer the viewer's intention in every case.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Sequence within session, explicit handoff | Retries and rewinds are understandable | Requires session generation and conflict UX |
| ❌ Maximum position | Monotonic and easy to merge | Discards deliberate rewinds and restarts |
| ❌ Unbounded device clock order | Little coordination | Clock skew and delayed offline writes can dominate |

### Bound offline and completion behavior

During a short disconnect, keep a bounded latest progress snapshot per session. If
persistence is permitted, store it with account/profile identity and an expiry. Flush
it only after authenticating and checking the server's current revision.

An old offline snapshot cannot silently overwrite a newer television session. Show the
conflict or retain it as local recovery context, according to the chosen product
policy.

Completion is a separate deduplicated event. Reaching the credits can remove a title
from Continue Watching, but a later rewatch should still have its own position.
Repeating a completed progress update must not create dozens of viewing-history
entries.

When navigating away, capture the final snapshot before resetting the controller. Send
it with its original context. A cleanup function that reads a store after another
cleanup erased it cannot save what the viewer just watched.

## ⚡ Performance and accessibility — 6 minutes

The home page needs one useful hero and a first row quickly. I would prioritize that
image, reserve image dimensions and lazy-load lower shelves. Independent
recommendation sections can load concurrently and fail separately.

Large libraries need pagination and bounded rendering. Use virtualization when
measured list size makes it valuable; maintain focused items in the rendered window
and avoid layout changes that move focus unexpectedly.

I would not issue an individual membership request for every visible card if the shelf
response can include membership for the selected profile. That turns one browse action
into dozens of serial or competing requests.

Search stores its query in the route, debounces requests and applies the same
response-generation check used elsewhere. A slow result for “space” should not replace
a newer result for “space comedy.” Keep empty results distinct from a failed request.

Code-split player-specific code away from lightweight browsing where the integration
permits. Prefetch detail metadata with a small budget after clear user intent; do not
eagerly authorize or download media for every hovered card.

Accessibility is a functional requirement. Controls need names, the seek slider needs
keyboard operation and meaningful time values, captions must be selectable, and
dialogs must manage focus and Escape consistently.

Do not hide controls while focus is inside them. Keyboard shortcuts should ignore text
inputs and should not prevent ordinary page navigation outside the player. Touch users
need explicit controls instead of hover-only actions.

A TV version needs a predictable directional focus graph, restoration to the launching
card and scroll behavior that keeps focus visible. That deserves its own validation
matrix rather than being inferred from a responsive desktop layout.

I would test screen-reader announcements for major state changes, not announce the
clock every second. Reduced-motion preferences should disable decorative movement
while preserving useful playback feedback.

## 🧪 Failures, validation and local comparison — 4 minutes

My tests would emphasize races and user outcomes. Start title A, immediately select B,
then delay A's responses. B must remain selected. Switch profiles during a watchlist
write and confirm neither data nor errors cross the boundary.

For playback, exercise slow startup, bandwidth drops, expired access, unsupported
media and an engine error after a successful start. Confirm the displayed state
matches actual media events and that retries are bounded.

For progress, verify that steady playback really emits periodic saves, a rewind
survives, duplicated updates do not duplicate history, and closing the page has a
documented loss window. An API success assertion alone does not prove those outcomes.

I would correlate authorization and first-frame telemetry by playback session. A
rising gap between them points toward delivery, licensing or decode rather than
catalog latency. Keep personal IDs out of unbounded metric labels.

| Decision | Why I would choose it | Cost to acknowledge |
|----------|------------------------|---------------------|
| Media-engine adapter | Real playback events drive UI | Platform integration and lifecycle work |
| Profile-scoped request state | Protects correctness and privacy | Explicit context invalidation |
| Acknowledged progress snapshots | Predictable recovery and handoff | Small bounded loss window and conflict policy |

In this repository, React, TanStack Router, Zustand, catalog browsing, profile actions
and SQL progress are present. The player is an image and one-second timer; HLS.js,
real media, offline sync and DRM are absent. Its save interval resets on position
changes, profile caches lack context guards, and several visible controls are
placeholders.

Those boundaries make the demo useful for studying the contracts, but I would
implement and validate one real playable title before claiming streaming performance.
The detailed source comparison belongs in
[architecture.md](./architecture.md#implementation-notes); the interview explanation
stays focused on the decisions above.
