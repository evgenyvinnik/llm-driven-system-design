# Facebook News Feed — Full-Stack System Design Answer

A 45-minute interview proposal for a ranked social feed. Production mechanisms extend the
local teaching app and are not claims about Facebook's actual architecture.

## 🎯 Start With the Reader and Author — 4 minutes

> “The reader wants a useful feed that does not shuffle while they read. The author wants to
> know a post was saved. I would give those experiences separate, explicit contracts and
> connect them with asynchronous distribution.”

The first version covers text/image posts, a ranked home feed, profiles, follow/unfollow,
likes, comments, and deletion. I would clarify Friends visibility; here I assume mutually
active relationships. The local demo uses a weaker following interpretation and has
additional enforcement gaps.

Stories, messaging, notifications, video, and sharing can be extensions. The media service
supplies owned processed image references and dimensions. We do not need to design a
transcoder to explain feed consistency.

| Requirement | Proposed meaning |
|-------------|------------------|
| First useful feed | Target under 1.5 seconds on a defined device/network |
| Feed API | Healthy-path p95 below 300 ms |
| Freshness | Ordinary fan-out target within 10 seconds |
| Availability | 99.9% regional feed-serving target |
| Pagination | Stable selected order within a short-lived session |
| Interactions | Immediate feedback with recoverable canonical results |
| Reading | Preserve anchor and bounded resources across navigation |
| Privacy | Current audience checks even for cached/session content |

These are goals, not measured performance. I would ask about active audience, media mix,
low-end devices, retention, and acceptable ranking staleness before choosing memory or cache
budgets.

## 🏗️ Architecture and Scale — 5 minutes

```
┌─────────────────────────────────────────────────────────────┐
│ Browser: composer / virtual feed / profile                  │
│ Entity store + ordered pages + pending intent               │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP + refresh hints
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Session-aware API                                           │
│ Ranked feed sessions / current access / mutations           │
└────────────┬──────────────────────────────────▲─────────────┘
             ▼                                  │
┌──────────────────────────┐       ┌──────────────────────────┐
│ SQL records + receipts   │──────▶│ Outbox / fan-out workers │
│ Graph and engagement     │       │ Pushed + pulled IDs      │
└──────────────────────────┘       └──────────────────────────┘
```

The browser uses normalized post entities, separate page membership, a bounded draft store,
and per-post pending intent. A measured virtualizer limits mounted rows; it does not limit
the data held in the store.

The API authenticates users and owns current access checks. Canonical mutations commit with
operation receipts and outbox events. Workers distribute candidates, and feed serving merges
those candidates with followed high-fan-out author timelines before creating a ranked
reading session.

React, TypeScript, TanStack Router/Virtual, and Zustand are reasonable frontend choices
here. PostgreSQL keeps the initial transactional authority; Redis caches candidates and hot
timelines. A durable worker queue decouples fan-out. WebSocket or SSE can deliver coalesced
refresh hints while HTTP handles ordinary mutations.

For scale, assume 100 million daily users making ten feed reads per day: one billion reads,
about 11,574 per second average and 57,870 at a five-times-average peak. Twenty million
posts per day is about 231 per second average.

At 2 KB per raw post, that is 40 GB per day before media, replicas, and indexes. If 95% of
posts are pushed to 50 recipients on average, candidate inserts reach 950 million per day. A
single ten-million-follower author can still dominate a naïve push path.

The hybrid policy pushes ordinary authors and pulls expensive authors at read time. A
10,000-follower threshold is an initial heuristic, not a universal constant. Active follower
count and posting frequency affect the break-even point, and a policy transition needs
overlap/deduplication across old and new candidate sources.

## 🔍 Deep Dive 1: Stable Ranked Pages and Current Privacy — 10 minutes

### The API must give the browser something stable to restore

> “A cursor is not magic. If the score changes between requests, adding a post ID as a
> tie-breaker does not stop items moving across the cursor.”

Offset paging into a changing list can repeat or skip posts. A score-plus-ID cursor handles
equal-score ordering, but not score movement. Client deduplication hides repeats; it cannot
discover a post that was omitted before reaching the client.

I would use a bounded ranked feed session. The first request gathers pushed and pulled
candidates, deduplicates IDs, hydrates and permission-filters, then ranks and diversifies a
fixed ordered set. The server retains that order for a short lifetime, perhaps ten minutes.

| Response concept | Purpose |
|------------------|---------|
| Feed session ID | Names the viewer's fixed reading order |
| Opaque next cursor | Position within that session |
| Mode | Followed/ranked or labeled public discovery |
| Expiry/reset behavior | Tells the client when continuity ends |
| Post entity ID/version | Supports deduplication and newer-state reconciliation |
| Media dimensions | Lets the client reserve layout space |

A position index is safe inside an immutable session list. It is not safe as an offset into
a freshly reranked database query. Bind the cursor to the viewer, session, and contract
version, and let the client store/return it without interpreting it.

The browser normalizes returned entities by post ID and keeps the server's page order
separately. New entities can update known content/version without moving every card. Older
responses are rejected if they belong to a previous account, feed session, or request
generation.

### Privacy is not frozen with ranking

A viewer can unfollow, lose a mutual friendship, or encounter a deleted post after the
session was created. The server must recheck current access when hydrating each page. Stable
order does not preserve a former permission grant.

Scan forward through examined session positions, skipping revoked content and filling the
page from remaining eligible IDs within a work budget. The cursor advances over the skipped
positions too. Otherwise a hidden row could repeatedly block progress.

The same audience rule applies to post detail, comments, likes, and image access. Checking
the feed while leaving the comments endpoint public still exposes private discussion. A
permanent unrestricted image URL also defeats private metadata.

Invalidate caches and notify active clients about removals, but do not rely on invalidation
arriving before every read. A stale pushed candidate is a hint to consider a post, not
permission to return it.

### New content becomes an invitation to refresh

A live hint says that a newer feed session may be useful. Coalesce hints into a banner,
optionally with a capped approximate count. Do not buffer every full post or blindly prepend
other users' content while someone is reading.

On explicit refresh, request a new ranked session and move to its top. When the old session
expires during navigation or paging, explain the reset rather than reusing its cursor
against a different ranking.

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Short-lived ordered session | Stable pagination and return navigation | Server state and temporary rank staleness |
| ✅ Current access on each hydration | Revocation survives stale candidates | Batched authorization work |
| ❌ Fresh rank with a score cursor | Maximum score freshness | Score movement can omit/repeat posts |
| ❌ Trust cached feed membership | Cheap serving | Old relationships can leak private content |

A discovery fallback needs a response mode so the UI can label it. A generic “You've seen
all posts!” message is also misleading when the system only exhausted a selected candidate
window. The end state should describe this session, with a refresh/history option where
appropriate.

## 🔍 Deep Dive 2: Optimistic Intent Meets Durable Mutations — 10 minutes

### There are two kinds of state

For a like, the browser keeps a canonical base from the server and the user's latest desired
intent. The interface can respond immediately by displaying an overlay, while the operation
remains pending.

The server accepts “set liked=true/false.” It updates the unique viewer/post membership and
adjusts the count only if membership changes. A repeated desired state should not increment
twice or become a generic conflict requiring a blind client rollback.

| Client state | Meaning | Handling |
|--------------|---------|----------|
| Canonical base | Last accepted state/count/version | Replace only with newer authoritative data |
| Pending intent | User's current desired state | Show optimistic overlay |
| In-flight operation | Request ID for the current mutation | Resolve before sending the next coalesced intent |
| Unknown outcome | Timeout/disconnection after send | Retry/read back the same operation |
| Definite rejection | Server did not permit that mutation | Explain and reconcile that operation only |

I would allow one in-flight operation per viewer/post and coalesce rapid taps. If the viewer
taps like, unlike, then like, the latest intent remains clear even while the first request
is pending.

When a versioned result arrives, update the base and determine whether another operation is
needed. An old failure must not decrement whatever count happens to be visible now. That
could undo a later success or make a count negative.

The canonical transaction changes membership, count, and result/event together. At much
larger hot-post scale, counts may become delayed aggregates, but the response must then
describe that staleness. The system cannot promise a strongly consistent count while
updating its pieces independently.

### One entity across home and profile

The same post should not have unrelated like state in the home store and a profile component
array. Keep one normalized entity record and let each view own only its ordered membership.
Otherwise an interaction from a profile may modify the wrong store or fail to find its post
at all.

Refresh data also participates in reconciliation. Do not simply skip all server updates
while an operation is pending; retain the newer canonical base and overlay only the
outstanding intent. Other viewers can change the total while my action is in flight.

### Posting and commenting need durable identity

A post/comment contains meaningful text, so retain a draft and create an operation ID before
submission. It can appear as explicitly pending, or the UI can wait for acceptance while
showing progress. Immediate feedback does not require calling the content confirmed.

1. Validate the draft locally and retain text plus operation ID.
2. Send the authenticated mutation with that ID and media references.
3. The server binds it to actor/request digest and commits the record, receipt, and outbox
together.
4. Return the accepted canonical ID/result.
5. Replace the pending item and retain any draft edits typed after submission began.
6. On timeout, resolve the same operation instead of silently creating a new one.

The last draft detail matters: if typing continues while a post request is in flight, a
successful response must not clear newer text. Track the submitted draft revision
independently of the current editable draft.

The server may acknowledge before fan-out finishes. That allows the author's confirmed own
view to show the post while recipient distribution is still pending. Workers retry bounded
chunks using viewer/post uniqueness; a process crash cannot discard accepted delivery work
because it is recorded durably.

A Redis cache of successful responses is useful but insufficient for strong retry
guarantees. Separate GET and SET steps allow concurrent misses, and a response cached after
the insert can be lost between commit and storage. The durable operation receipt closes that
boundary.

| Approach | Why it fits | Trade-off |
|----------|-------------|-----------|
| ✅ Intent overlay plus versioned desired-state result | Rapid toggles and retries converge | Per-entity operation tracking |
| ✅ Durable content receipt and outbox | Accepted post survives a lost reply/publish gap | Transactional storage and worker operations |
| ❌ Blind inverse rollback | Simple happy path | Late errors can reverse newer intent |
| ❌ New ID on every retry | Easy request code | Timeout after commit creates duplicate content |

> “Optimism is a display policy, not a durability guarantee. The browser can feel immediate
> while the server gives every important mutation a result that can be recovered.”

## 🔍 Deep Dive 3: Rendering, Navigation, and Bounded Memory — 9 minutes

### Virtualization solves mounted rows, not retained everything

A long feed contains variable-height text, images, and expanded comments. I would estimate
row sizes, measure actual elements, and use a small overscan tuned on the target low-end
device.

Post ID must also be the virtualizer's item key, not only the React key. Measurement
identity based on array index can shift when a new post is inserted or removed. If the
scroll container includes a composer above the list, account for that offset when mapping
scroll position to virtual rows.

Media dimensions are part of the API contract. Reserve an aspect ratio before the image
loads to avoid an unnecessary height correction. If dimensions are unavailable, choose a
fixed-ratio placeholder/crop and acknowledge the trade-off.

Responsive image derivatives reduce bytes and decoded memory. Lazy loading and asynchronous
decoding hints help scheduling, but do not replace a resource budget. CSS scaling a large
source image still downloads the large asset.

| Resource | Example bound or policy |
|----------|--------------------------|
| Working pages | Five 20-post pages around the anchor, with controlled reload |
| Mounted rows | Visible rows plus a small measured overscan |
| Drafts/pending comments | Account-scoped quota, expiry, explicit discard |
| Refresh hints | Coalesced flag or capped approximate count |
| Media players if video is added | One active and perhaps one nearby warm player |
| Concurrent prefetch | Small budget; cancel obsolete session requests |

Keep image/media resources independent of the count of pages ever visited. If video is
added, pause off-screen playback and save position by post ID before disposing distant
players. Keeping every scrolled-past player mounted would defeat the memory bound.

### Unmounting a card must not discard meaningful work

Expanded comments can load lazily, but a typed comment belongs in a bounded draft store
rather than only in card-local state. Virtualization deliberately unmounts off-screen rows;
that should not erase text without an explicit decision.

Update drafts in memory immediately and persist asynchronously with a short bounded debounce
and a navigation flush. Account-scope text and upload references, handle quota failure, and
clear submitted/discarded records. A browser crash can still lose an unsaved tail; do not
promise perfect durability from a timer.

Uploads can complete separately from post submission, with owned upload IDs, status,
dimensions, retry, and orphan cleanup. This reduces repeated transfer after a failed post
request. It does not mean a combined upload must lose draft text; draft safety is a separate
responsibility.

### Return to the same content, not merely a pixel

When opening a profile or detail view, retain the feed-session ID, anchor post and offset,
page references, and useful measurements. Restore the compatible page and measure around
that anchor. A bare scroll offset is meaningless if the content or heights changed.

Keeping one bounded feed mounted behind an in-app detail route can simplify return, provided
the hidden view is inert and media/background work pauses. It must not retain an unbounded
stack of old feed trees. A full reload or expired server session still needs explicit
recovery.

If the anchor was deleted or permission was revoked, choose the nearest valid retained post
and explain the transition when useful. Scroll restoration must not restore forbidden
content simply to reproduce an old view.

### Accessibility is part of the bound

Use article semantics and meaningful accessible button state. Retain a currently
focused/editing row within a small exception budget, or move focus deliberately before
disposal. Recycling a focused subtree can strand a keyboard user at the document body.

Virtualized off-screen content is absent from find-in-page and some screen-reader
navigation. Provide an accessible loading/navigation strategy and server-backed search where
the product requires full-history search. Do not claim virtualization preserves every
browser capability automatically.

| Decision | Benefit | Cost |
|----------|---------|------|
| ✅ Measured virtual rows plus bounded page cache | Controls DOM and data memory separately | Page reload and anchor management |
| ✅ Anchor/session-based restoration | Preserves reading context | Needs server retention and remeasurement |
| ❌ Keep all cards/media mounted | Easy local state retention | Unbounded resources during long sessions |
| ❌ Pixel offset alone | Small state record | Drifts when pages/media/permissions change |

## 🧪 Contracts and Failure Tests — 5 minutes

I would agree on a small serialized contract rather than share dozens of implementation
classes. TypeScript or generated schemas reduce drift, and runtime validation protects each
server boundary.

| Contract | Information the other side needs |
|----------|----------------------------------|
| Feed page | Viewer-bound session/cursor, mode, expiry, ordered IDs/entities |
| Post entity | Stable identity, visibility/version, media dimensions |
| Like result | Operation ID, canonical desired state/count/version |
| Content receipt | Accepted ID or structured rejection/unknown resolution |
| Refresh hint | Authorized session freshness signal; no private payload required |
| Session reset | Reason and a path to a new compatible feed |

| Scenario | Expected result |
|----------|-----------------|
| Engagement/rank changes between pages | Same session order; new session reflects changes |
| Unfollow during delayed fan-out | Stale candidate cannot bypass current access |
| Same post appears from push and pull | One entity and one session position |
| Like/unlike/like with reordered outcomes | Final desired state matches canonical result |
| Reset response arrives after own post creation | Newer local work is reconciled, not silently erased |
| Virtualized card unmounts during drafting | Text remains in its scoped draft store |
| Logout/login while page request runs | Old account response cannot populate the new feed |

Use generated feeds and delayed responses for browser tests, and transactional/worker fault
injection for the durable boundary. Assert store state for identity/reconciliation and
browser behavior for focus, anchoring, input latency, and heap growth.

Track API latency separately from first useful rendered content. Observe fan-out age,
partial failures, candidate coverage, session resets, and authorization drops. A high
cache-hit rate can coexist with stale or incomplete results.

Request volume still matters. Image loading, comment expansion, search on each keystroke,
prefetch, and refresh storms can pressure the backend. Debounce/cancel stale search, cap
prefetch, and coalesce hints; one virtualized list does not imply one inexpensive request.

## 📝 Close and Local Boundary — 2 minutes

> “The server provides a stable selected order and current access decisions; the browser
> preserves that order and the user's intent within bounded resources. Durable operation
> results and retryable fan-out let posting stay reliable without waiting for the whole
> audience.”

The local project demonstrates the stack and hybrid candidate paths, but not the full
contract. Fan-out is awaited inline and has no durable retry worker. The home cursor is
incompatible with its cache parsing, rank changes across pages, and privacy is not
consistently enforced.

The home store retains an unbounded array without request generations or deduplication.
Profile likes use the home store, late rollback can corrupt newer state, and card-local
comment drafts disappear when unmounted. The composer waits for the response and does not
persist its draft or send an idempotency key.

A WebSocket server exists, but its broadcast helper is unused and no frontend socket
connects. Shares, video, uploads, and profile editing UI are not implemented.
[Architecture](./architecture.md#implementation-notes) traces these limits to source; the
[README](./README.md) supplies actual setup. No full-stack runtime or load benchmark was
performed in this review.
