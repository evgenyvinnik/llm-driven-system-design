# Apple Music — full-stack system design interview

> “I would follow a listener through three actions: play a song, save it to their
> library, and discover something new. Each action crosses the browser/backend
> boundary, but each needs a different consistency and recovery policy.”

This is a proposed 45-minute production design, not a description of Apple's
internal architecture. The final section identifies which parts exist in the
repository's smaller learning implementation.

## 🧭 Scope and targets — 4 minutes

I would include online web playback, browsing/search, personal libraries,
ordered playlists, and basic personalized sections. Offline media licensing,
user-upload matching, lyrics, and simultaneous collaborative playlist editing
would expand the scope and are not assumed here.

A user can select a track, continue listening while navigating, save an album,
and see that edit from another device. Playback should remain usable when a
recommendation request fails or a library edit is still awaiting confirmation.

| Discussion | Minutes |
|------------|---------|
| Scope and targets | 4 |
| Architecture and shared contracts | 5 |
| Deep dive: Play to audible audio | 10 |
| Deep dive: Save to cross-device convergence | 10 |
| Deep dive: Listening to discovery | 8 |
| Failure handling and validation | 5 |
| Trade-offs and local boundary | 3 |
| Total | 45 |

I would propose p95 audible start within one second on supported networks and
p99 playback authorization below 200 ms. These are separate measurements.
A successful response containing an audio URL does not prove that music started.

Library edits should feel immediate, while acknowledged results must survive
retries. Recommendation freshness can be bounded rather than instantaneous.
For playback availability, I would propose 99.99% successful authorized starts
and measure the entire media path rather than only API uptime.

## 🏗️ Architecture and shared contracts — 5 minutes

My first diagram separates media delivery, user state, and event processing:

```
┌──────────────────────────────────────────────────────────────┐
│ Browser: persistent player, routed pages, library state      │
└─────────┬─────────────────────┬─────────────────────┬────────┘
          ▼                     ▼                     ▼
┌───────────────────┐ ┌───────────────────┐ ┌──────────────────┐
│ Playback grants   │ │ Catalog/library   │ │ Listening        │
│ Available assets  │ │ Queries + edits   │ │ Event ingestion  │
└─────────┬─────────┘ └─────────┬─────────┘ └─────────┬────────┘
          ▼                     ▼                     ▼
┌───────────────────┐ ┌───────────────────┐ ┌──────────────────┐
│ CDN/media origin  │ │ State + revisions │ │ History +        │
│ Client gets bytes │ │ Edit receipts     │ │ Recommendations  │
└───────────────────┘ └───────────────────┘ └──────────────────┘
```

The browser's playback controller lives outside routed page content. It owns
one active playback instance and the media lifecycle. A small store exposes
state to the player bar and track rows without making each page own an audio element.

Catalog and recommendation results live in a request cache. The library model
holds a confirmed base plus pending edits. Query caches and pending operations
are scoped to the signed-in account, with explicit cleanup on account changes.

The backend owns authorization, catalog publication, and committed library state.
Media bytes come from the delivery tier. A durable event pipeline feeds history
and recommendation projections independently of the playback request.

At ten million concurrent listeners and 256 kbit/s, audio egress is 2.56 Tbit/s.
If each listener starts a three-minute song, authorization averages roughly
55,600 requests/s before skips and retries. Scaling the API cannot substitute
for scaling media delivery.

### Agree on identity before implementing screens

| Concept | Shared identity | Why it matters |
|---------|-----------------|----------------|
| Recording | Catalog track ID | Metadata may change while the recording stays the same |
| Media rendition | Track, format/quality, immutable asset version | Client knows which compatible bytes it received |
| Playback | Playback-instance ID and client generation | Replays, retries, and late events remain distinguishable |
| Queue/playlist occurrence | Entry ID | The same track may intentionally appear twice |
| Library edit | Actor, operation ID, expected/accepted revision | Retry and reconciliation preserve one logical edit |
| Listening event | Stable event ID within a playback instance | Network retries do not inflate popularity |

These contracts are more useful on a whiteboard than a full database schema.
They let us reason about what happens when requests arrive twice or finish in
an unexpected order.

## 🔧 Deep dive 1: Play to audible audio — 10 minutes

### Follow one playback intent

1. The user selects a queue occurrence; the browser creates a new intent generation.
2. The API authenticates and intersects entitlement, available renditions, and
   supported formats, considering preference and useful network hints.
3. It returns a bounded delivery grant, selected rendition, and expiry.
4. The browser accepts the response only if that generation is still current.
5. The media controller loads the source and observes whether playback actually starts.
6. Client and delivery telemetry report success, stalls, or failure for that instance.

If the user selects B while A's authorization is delayed, A's later response must
not replace B. Cancellation saves work, but a completion-time identity check is
what prevents an obsolete response from becoming current playback.

The UI can acknowledge the click immediately while showing resolving/loading.
It moves to playing when media confirms that state, not when a fetch returns JSON.
Permission, unsupported format, missing media, and buffering need distinct recovery
messages. [Browser playback behavior](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)

### Publish real assets and protect the byte path

Before a rendition becomes available, an ingestion process verifies its object,
codec/container, duration, and metadata. A track may have only some qualities ready.
Authorization must choose from what really exists and is allowed.

A signed URL for a nonexistent key is still a failed playback attempt. A fabricated
filename is not a fallback. If a lower compatible rendition is available, the
response should identify the actual selected quality; otherwise return unavailable.

> “I would keep the media origin private and issue an access grant for immutable
> media. Protecting only the API is insufficient if anyone can fetch the same
> bytes directly from a public object URL.”

Direct delivery keeps multi-minute byte transfers out of the API's request pool.
It also lets common media share delivery-cache entries while access checks remain
per request. The expiry policy and CDN cache identity must support both goals.

| Approach | Benefit | Cost for this journey |
|----------|---------|-----------------------|
| ✅ Authorized direct delivery with explicit player states | Independent delivery scaling and truthful UI | Grant expiry, asset publication, and client telemetry |
| ❌ Proxy all media through the main application API | One apparent request path | Bandwidth and long transfers couple playback to unrelated API work |
| ❌ Treat a returned URL as successful playback | Easy metrics and UI | Missing objects or browser rejection look falsely successful |

The cost of a grant is a bounded revocation window. Signing out cannot erase
already buffered bytes, and a previously issued grant may remain valid until
expiry unless the delivery system supports stronger revocation.

### Adapt within the allowed set

The server decides eligibility; the browser observes buffer depth and transfer
performance. A declared Wi-Fi connection can be slow or change midway through a
track. It should not serve as a trusted measurement or an entitlement decision.

Whole-file selection is a reasonable first version if it meets measured startup
and stall targets. It is operationally simpler than segment packaging and manifest
management, but adapts poorly after a connection change and can waste bytes on skips.

Segmented delivery allows more controlled buffering and rendition changes at
compatible boundaries. It adds a packaging/player contract that must be tested
on supported browsers. There is no general reason that music cannot benefit from
adaptation merely because its tracks are shorter than movies.

Gapless playback is another contract: a URL prefetch removes one possible delay,
but does not guarantee sample-accurate transitions. Encoding boundaries, decoding,
and scheduling matter. Crossfade is an optional effect with different behavior.

### Keep the queue independent of page navigation

The playback controller remains mounted while routed pages change. Queue entries
have stable occurrence IDs, and removing an earlier entry leaves the current
playback instance intact.

Explicit Skip, automatic completion, repeat-one, and Previous need deliberate
semantics. Shuffle should keep a traversal history so Previous reflects what the
listener heard rather than simply decrementing an unrelated array index.

Listeners and prefetch tasks are cleaned up on replacement/unmount. Duplicate
end handlers can advance twice; stale media errors can damage the new player's
state unless the controller associates them with the correct generation.

## 🔧 Deep dive 2: Save to cross-device convergence — 10 minutes

### Make a pending edit visible and recoverable

Saving a track can update the UI optimistically. The client records the desired
membership and a stable operation ID, then sends the edit. A brief pending state
is useful if confirmation is slow; it does not have to block browsing or playback.

The backend validates the target and serializes edits for the owning library.
One transaction changes membership, advances a per-owner revision, appends the
change, and records the operation result. It acknowledges after commit.

If the response disappears after commit, a retry with the same identity returns
the same result. A successful-response cache can accelerate this, but cannot replace
a durable receipt or prevent concurrent execution on a cache miss.

The API distinguishes definitive rejection from an ambiguous timeout. On rejection,
the client corrects the relevant pending operation. On timeout, it retains the
operation and retries or checks its outcome rather than assuming nothing happened.

### Reconcile operations, not whole stale arrays

Suppose Save is followed immediately by Remove. If Save fails later, restoring
a previous entire library array can erase Remove or unrelated edits.
The client should keep a confirmed base and apply ordered pending operations over it.

When an acknowledgement or remote change arrives, update the confirmed base,
remove acknowledged operations, and reapply the remainder under the agreed rules.
This makes the current display a projection of explicit user intent.

> “I would choose optimistic membership edits with identified operations because
> users repeat them often and expect quick feedback. I am accepting reconciliation
> complexity to avoid making network delay the pace of ordinary interaction.”

| Approach | Benefit | Cost for this journey |
|----------|---------|-----------------------|
| ✅ Optimistic operations plus transactional server receipts | Responsive and recoverable after ambiguous failures | Client reconciliation and durable operation storage |
| ❌ Roll back the whole library on any failed request | Small initial implementation | Can erase later edits or contradict a committed timeout |
| ❌ Cache a response after an uncoordinated mutation | Fast sequential replay when cached | Concurrent misses and crash windows still duplicate effects |

For a complex bulk edit, a server-confirmed preview may be a better initial product
choice. Optimism is an interaction policy, not a requirement to pretend every
operation has already succeeded.

### The sync feed must deliver every committed edit

A new device gets a consistent snapshot and revision. It then reads ordered pages
of changes, applying each page before advancing its local cursor. Changes include
stable identity and enough data to update or resolve the item.

A database sequence is not sufficient ordering. An earlier token can belong to
an uncommitted transaction while a later one becomes visible. Returning the later
token can make the earlier committed change invisible to all future delta requests.

The server also cannot fetch a page and then independently return a newer maximum
token. A commit between those reads would advance the client past an undelivered
change. The cursor must describe the actual returned page and its consistency boundary.

A per-owner counter held under a transaction lock can order that owner's writes.
Paging uses the last delivered revision and a consistent upper boundary. This
separates ordering correctness from the client's page-application rules.

When retention removes old changes, the server explicitly requires a new snapshot.
The browser stages and replaces the confirmed base atomically, preserving pending
local operations for reconciliation. Full snapshots are useful recovery tools.

Push can announce newer revisions; the delta API remains the recovery mechanism.
The client also checks on foreground/reconnect because notifications can be missed.
An offline operation queue and offline playable media are separate features.

### Handle ordered playlists as a different edit shape

A playlist contains occurrences, so deleting by track ID can remove more than the
user intended. The API should address entry IDs and reject or reconcile edits
based on a stale playlist revision.

Appending with an unlocked maximum position can collide with another append.
Sequentially swapping occupied unique positions can fail even inside a transaction.
The server needs a safe ordering update procedure, not only a BEGIN/COMMIT wrapper.

The UI can preview a drag, then acknowledge the accepted revision or explain a
conflict. I would start with single-owner serialized edits rather than claiming
collaboration simply because the API accepts requests from multiple devices.

## 🔧 Deep dive 3: Listening to discovery — 8 minutes

### Distinguish progress from a qualified event

Position is not listening time. Seeking to the last minute of a track does not
mean the user heard its first three minutes. Pausing or buffering should not
satisfy a wall-clock timer used as a play threshold.

The controller accumulates eligible listening intervals for a playback instance.
When it meets the product's stated policy, it sends one identified event with
bounded fields. Retries retain the same event ID.

The server validates and durably accepts that event before acknowledging it.
Consumers update history and popularity projections with duplicate-safe effects.
A consumer crash can replay accepted input without inventing another play.

Resume position can be short-lived and replaceable; a qualified play has a stronger
history contract. At ten million active listeners, reporting every 15 seconds
would produce roughly 667,000 reports/s, so treating every report as a permanent
transactional history row is an expensive default.

> “I would let progress be lightweight while making qualified listening events
> recoverable. That gives personalization useful evidence without putting every
> player tick through the library's strong-consistency path.”

### Build a useful baseline before adding learned ranking

Initial sections can include frequent albums, followed-artist releases, genre
candidates, unseen tracks, and general popular picks. The frontend renders typed
sections and can retain a useful cached section during refresh.

A history count is not collaborative filtering. Genre overlap is not acoustic
fingerprinting, and merely storing audio features does not mean recommendations
use them. I would name the actual signals and evaluate the output they produce.

Learned ranking can follow when it improves measurable discovery quality. It adds
feature consistency, training, evaluation, and serving work. Diversity, cold start,
and unavailable-content filtering remain product concerns under either approach.

| Approach | Benefit | Cost for this journey |
|----------|---------|-----------------------|
| ✅ Cached explainable sections fed by identified events | Understandable results and independent playback availability | Bounded delay before recent listening changes discovery |
| ❌ Recompute personalized aggregates on every request | Fresh database view | Repeated expensive history scans under heavy read traffic |
| ❌ Block playback until event processing finishes | Immediate downstream consistency | Analytics failures become audible interruptions |

I would coalesce refresh work or publish recommendation generations periodically.
The exact delay follows the product's freshness needs. We should not invent an
“80% of ML value” estimate to justify a simpler implementation.

### Make discovery failures local to discovery

If one personalized section fails, the page can show cached or general eligible
content with a retry option. The current track, queue, and pending library edits
remain intact. Account-specific results must never be reused under another account.

Search uses a query generation as well as debounce. Old results cannot overwrite
new text. Empty results, unavailable search, and stale cached results are different
states that should lead to different explanations.

Genre/search parameters should be part of validated route state when users expect
them to survive sharing or navigation. A URL that changes without changing the
query is not a functioning filter.

Large library pages need both pagination and virtualization. Paging bounds transfer;
virtualization bounds rendered rows. A small discovery shelf does not need those
extra mechanics simply because a large library does.

## 🛠️ Failure handling and validation — 5 minutes

### Make cross-layer recovery observable

| Failure | Browser behavior | Backend/delivery responsibility |
|---------|------------------|---------------------------------|
| Media missing or unsupported | Explain unavailability; retain queue | Publish only real compatible renditions |
| Playback request becomes obsolete | Discard old completion | Return request/playback identity |
| Library response lost | Keep pending operation and reconcile | Replay durable result |
| Delta cursor expires | Stage a new snapshot | Explicit retention floor and reset response |
| Recommendations delayed | Keep current listening usable | Serve eligible fallback or recoverable error |
| Account changes mid-request | Isolate caches and cancel old work | Enforce actor ownership and current entitlement |

Session caches need an invalidation/version policy for role or tier changes.
Deleting a database session while leaving an accepted cached snapshot can preserve
access. Conversely, a Redis outage should have a deliberately designed policy
rather than an accidental exception before the intended database fallback.

The delivery grant has its own lifetime. A successful session revocation does
not imply already issued media access disappears immediately. The UI and operational
expectations should reflect that boundary.

### Test promises across both layers

I would use controlled responses and fixtures to test:

- A Play request for A finishes after the user has selected B.
- The browser refuses playback after authorization succeeds.
- A real compatible asset is fetched and decoded, not just represented by a URL.
- Save commits but its response is lost, then the same operation is retried.
- Two library transactions complete out of allocation order.
- A sync page is read while another edit commits.
- Playlist duplicates and reorder conflicts preserve occurrence identity.
- Duplicate listening events do not increase history/popularity twice.

Measure audible-start latency, stalls, sync completeness, operation replay outcomes,
and recommendation age. URL-handler timing cannot measure audio first byte, and
an active-stream gauge based on issued URLs cannot establish actual concurrency.

## ⚖️ Trade-offs and local implementation boundary — 3 minutes

The proposed design separates playback generations, library operations, and listening
events because their recovery needs differ. Its cost is explicit identity and
lifecycle management across the browser and backend.

The repository runs React, TanStack Router, Zustand, Express, PostgreSQL, Valkey,
and MinIO. It has catalog/library/playlist APIs and a single-element player, but
the seed includes no playable audio objects or audio-file records.

Quality is chosen once per track; there is no ABR or gapless pipeline. Search uses
PostgreSQL substring queries; Elasticsearch is unused. The browser has no delta-sync
consumer, offline operation queue, query cache, or virtualization. Some settings,
playlist-editing, and admin controls are display-only.

Library state and change logs are separate writes, sync cursors can skip changes,
and playlist idempotency only caches completed responses. Listening events lack
deduplication. These limitations are traced in the
[architecture](./architecture.md#implementation-notes).

I would first establish a real playable fixture, reliable playback lifecycle,
and recoverable library operations. Those foundations make later improvements to
delivery scale and discovery quality meaningful to the listener.
