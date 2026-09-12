# Apple Music — backend system design interview

> “I would separate moving audio bytes from deciding what can be played and
> maintaining the listener's library. Media delivery needs enormous bandwidth;
> library synchronization needs a precise ordering and recovery contract.”

This is a proposed production design for a 45-minute interview, not a description
of Apple's internal services. The repository's current implementation is smaller
and is described in the final section.

## 🧭 Scope and targets — 4 minutes

I would include online music playback, catalog search, personal libraries,
playlists, and basic recommendations. User-upload matching, offline licenses,
lyrics, and collaborative editing are extensions. They should not crowd out the
core playback and synchronization problems in a single interview.

A user can select a track, obtain authorized playable media, save it, and see that
library edit on another device. Listening events inform history and discovery,
but delayed analytics must not interrupt the current track.

| Discussion | Minutes |
|------------|---------|
| Scope and targets | 4 |
| Capacity and architecture | 5 |
| Data and API contracts | 4 |
| Deep dive: authorized media delivery | 10 |
| Deep dive: complete and recoverable library sync | 11 |
| Deep dive: listening events and recommendations | 8 |
| Failure priorities and local boundary | 3 |
| Total | 45 |

I would target p99 authorization below 200 ms and p95 audible playback start below
one second on supported networks. Availability is a successful authorized playback
start, not merely an HTTP response containing a URL. A proposed 99.99% target
needs to include failures in both the API and media paths.

An acknowledged library edit must be durable. Discovery can be eventually updated,
but a sync cursor must never silently hide an earlier committed edit.

## 🏗️ Capacity and architecture — 5 minutes

Assume a 100-million-track catalog and ten million concurrent listeners.
At 256 kbit/s, those listeners require 2.56 Tbit/s of media egress before overhead.
Even perfect API caching would not remove that delivery workload.

A three-minute track at that bitrate occupies about 5.76 MB. One rendition of the
catalog is therefore roughly 576 TB before replication. Lossless sizes vary with
the recording; a fixed multiplier is only a sizing assumption, not a codec guarantee.

With one new track every three minutes per active listener, authorization averages
about 55,600 requests/s. Skips and retries increase that. Progress every 15 seconds
would create roughly 667,000 reports/s, so I would not casually persist each report
through the same transactional path as a library edit.

My first diagram keeps media delivery independent of the control API:

```
┌────────────────────────────┐    ┌────────────────────────────┐
│ Clients                    │───▶│ CDN + private media origin │
└──────────────┬─────────────┘    └────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ API edge: identity, validation, bounded admission            │
└─────────┬─────────────────────┬─────────────────────┬────────┘
          ▼                     ▼                     ▼
┌──────────────────┐ ┌────────────────────┐ ┌──────────────────┐
│ Playback grants  │ │ Library/playlist   │ │ Catalog/search   │
│ Allowed assets   │ │ State + revisions  │ │ Discovery reads  │
└──────────────────┘ └────────────────────┘ └─────────▲────────┘
                                                      │
┌─────────────────────────────────────────────────────┴────────┐
│ Durable events → aggregates → recommendations                │
└──────────────────────────────────────────────────────────────┘
```

Catalog metadata is shared and read-heavy. Personal libraries are partitioned by
owner so their state and revisions remain together. Media objects are immutable
and independently cached. Listening events feed asynchronous projections.

I would begin with clear module boundaries and a small deployable system, then
separate services where their scaling and failure characteristics demand it.
The diagram describes ownership; it does not require a network hop for every box.

## 💾 Data and API contracts — 4 minutes

The data model separates a recording, a playable rendition, and a playlist entry.
Those identities have different lifetimes and cannot safely be collapsed into
one track ID everywhere.

| Record | Main fields | Important invariant |
|--------|-------------|---------------------|
| Track/catalog item | ID, artist, album, metadata, availability | Stable identity despite metadata edits |
| Rendition | Track ID, codec/container, quality, object/version, state | Only verified compatible assets are published |
| Library membership | Owner, item type, item ID | One desired membership state per owner/item |
| Library head/change | Owner, revision, operation, affected item | Revisions follow committed owner edits |
| Operation receipt | Actor, operation ID, payload hash, result | A retry recovers one logical outcome |
| Playlist entry | Entry ID, playlist ID, track ID, position | Duplicate recordings have distinct occurrences |
| Playback event | Event ID, playback ID, track, eligible duration | Repeated delivery does not count another play |

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /catalog/search | Search with bounded query/filter/page parameters |
| POST | /playback/grants | Authorize a specific track and compatible rendition set |
| PUT / DELETE | /library/items/:type/:id | Set desired membership with operation identity |
| GET | /library/snapshot | Obtain a consistent initial library and revision |
| GET | /library/changes | Fetch a bounded page after an applied revision |
| POST | /playlists/:id/operations | Edit entries against an expected playlist revision |
| POST | /listening/events | Durably accept a bounded batch of identified events |
| GET | /recommendations | Read eligible personalized or fallback candidates |

These are proposed contracts, not the exact local endpoints. The local inventory
is in the README. Availability, unsupported format, bad input, authorization
failure, stale revision, and transient dependency failure need distinct outcomes.

## 🔧 Deep dive 1: authorized media delivery — 10 minutes

### Publish a playable asset before granting access

I would ingest source media into a private staging area, validate it, and produce
supported renditions. Each rendition records its actual codec, container, duration,
object version, and processing status.

Publication verifies that the object exists and matches its metadata. An atomic
catalog-state transition then makes it eligible for playback. Failed or incomplete
encodes remain unavailable rather than being represented by plausible filenames.

A catalog item can exist before every quality is ready. The authorization path
must intersect requested preference, entitlement, supported formats, and available
renditions. A missing high-quality encode can use an allowed lower quality, or
return a clear unavailable result when no compatible asset exists.

### Keep bytes away from the control service

> “I would issue a bounded delivery grant and let the client fetch media from
> the delivery tier. That keeps an API replica's capacity tied to authorization
> requests rather than the duration and bitrate of every listening session.”

A private origin prevents bypassing the authorization path through an unsigned
object URL. The delivery layer validates the grant and serves immutable content.
Its caching policy should share common bytes without sharing one user's authorization.

For example, a CDN can verify access before serving a cached object whose key is
based on media identity/version. If every user's signature unnecessarily becomes
part of the cache identity, the same recording may be fetched repeatedly from origin.

A grant expires, and a cached client URL must not outlive it. The client can obtain
a fresh grant for an active playback intent when reuse or a new range request
requires it. Issuing a grant does not create a permanent account entitlement.

| Approach | Benefit | Cost for this workload |
|----------|---------|------------------------|
| ✅ Authorized direct media delivery | Independent bandwidth scaling and shared object caching | Delivery policy, expiry, and client outcome telemetry |
| ❌ Proxy all audio through the main API | One apparent authorization and byte path | Long transfers dominate sockets/bandwidth and couple API failures |
| ❌ Public media with protected metadata only | Very simple delivery | Knowing the object URL bypasses playback authorization |

Proxying can be reasonable for a small internal file service. At ten million
listeners, its operational cost would be driven by media transfer even though
most API business logic is lightweight. That is the specific scaling mismatch.

The cost of direct delivery is reduced immediate control after issuance. A session
revocation cannot erase bytes already buffered, and a grant may remain usable until
its expiry or an explicit delivery-side revocation mechanism takes effect.

### Separate entitlement from network adaptation

The server enforces content rights and subscription capabilities. The client sees
buffer depth, download performance, codec support, and user data-saving choices.
A self-reported network label is a hint; it is not evidence of bandwidth or fraud.

For a first version, selecting a whole file per track keeps the implementation
small. It is a defensible trade-off if measured startup and stall rates meet our
targets. The server cannot guarantee the connection remains unchanged for the song.

Segmented streaming permits adaptation at compatible boundaries and more controlled
prefetch. It adds packaging, manifests, rendition alignment, and request volume.
I would introduce it for measured delivery needs rather than claim music never
benefits from client-driven adaptation.

True gapless playback also depends on timing, encoding boundaries, and the client
pipeline. A prefetch endpoint that returns a URL can reduce lookup latency, but
cannot by itself guarantee a seamless audible transition.

### Measure the entire playback attempt

The authorization service records grant latency and rejection reason. The delivery
tier records object errors and transfer performance. The client records whether
playback actually began, buffering, and its terminal outcome.

A playback-instance ID connects those events. A user/track key is insufficient:
the same listener can retry, use multiple devices, or intentionally replay the
same recording while an earlier report is still arriving.

I would not increment a “currently listening” gauge for every URL request and trust
clients to decrement it exactly once. Active-session estimates need leases or
aggregation with defined expiry and duplicate handling.

## 🔧 Deep dive 2: complete and recoverable library sync — 11 minutes

### Put the state change and its receipt in one transaction

For an edit, I would lock the owning library's head row. Inside the transaction,
check the operation receipt, validate the target, update membership, increment the
owner's revision, append the change, and record the result.

The lock remains held until commit. Another edit for that owner cannot allocate
a later committed revision while this one is unfinished. Different owners still
proceed independently, matching the natural partition key.

If the operation already exists with the same payload, return its prior result.
If the same ID is reused for a different edit, reject it. The response cache may
speed up replay, but the durable receipt remains authoritative after cache loss.

> “I would serialize edits within one person's library because their edit rate
> is modest and correctness is visible. I would not serialize every listener
> behind a global counter.”

### Explain why a sequence alone is insufficient

Suppose transaction A allocates token 100 but has not committed. Transaction B
allocates 101 and commits first. A sync client sees 101 and advances. When A later
commits, a query for tokens above 101 can never deliver change 100.

PostgreSQL sequence allocation is distinct from transactional visibility and may
also leave gaps after aborted work. The issue is not that a client needs every
integer; it needs every committed change before its cursor.
[Sequence behavior](https://www.postgresql.org/docs/16/functions-sequence.html)

A separate race exists if the server reads change rows and then queries a newer
maximum token. A change committed between those two reads can be omitted from the
response even when only one writer is active at a time.

The cursor must describe the returned page, with a consistent upper boundary.
A transactional per-owner counter addresses ordering, while snapshot/page rules
address what the reader actually observed. We need both.

### Bootstrap, page, and recover explicitly

A new device obtains a consistent membership snapshot and revision. It stages the
snapshot locally, then adopts it atomically before applying later changes.
A partial download should not replace a complete local library with half a new one.

For deltas, the server returns ordered pages and advances only to the last delivered
revision. The client applies each page before persisting its cursor. Reapplying an
already delivered change must be harmless or detectable by revision/operation ID.

A retention floor bounds log growth. A client below that floor receives an explicit
reset-required response and obtains a new snapshot. Pending local operations remain
identified so reconnect does not erase unsent user intent.

Push notifications can announce that newer data exists. They do not replace the
change feed, since connections break and notifications can be missed. Foreground
and reconnect checks provide recovery even when the notification path fails.

| Approach | Benefit | Cost for this problem |
|----------|---------|-----------------------|
| ✅ Per-owner transactional revisions plus snapshots/deltas | Complete recoverable sync with bounded retention | Owner contention and careful paging/reset protocol |
| ❌ Sequence allocation plus a later MAX query | Short implementation | Cursor can silently skip committed edits |
| ❌ Replace server state with a device's entire old library | Simple upload semantics | Offline devices can erase unrelated newer edits |

A full snapshot is still useful for initial sync and recovery. It does not inherently
lose data; the unsafe choice is treating a stale device snapshot as authoritative
for every concurrent edit without a merge or revision policy.

### Use the same discipline for ordered playlists

Playlist entries have occurrence IDs because duplicate tracks can be intentional.
An edit is applied against an expected revision, with serialized position updates
or another ordering representation whose uniqueness rules are maintained.

An uncoordinated MAX(position)+1 append can choose the same position twice. Ignoring
the resulting conflict and returning success loses one user's requested entry.
Likewise, moving entry A directly into entry B's occupied unique position can fail
before a transaction gets to move B out of the way.

I would choose a simple serialized single-owner protocol first, with a safe position
update procedure and explicit stale-revision conflicts. Fractional ordering keys
or collaborative structures have their own compaction/conflict costs and should
follow a real need for concurrent editing.

## 🔧 Deep dive 3: listening events and recommendations — 8 minutes

### Define one logical play

A playback attempt, periodic progress, a qualifying listen, and a completed track
are different events. I would define the product's qualifying-listen policy and
track accumulated eligible listening time rather than trusting a seek position.

The client sends stable event IDs. The ingestion layer validates bounded input and
acknowledges durable acceptance. Consumers apply duplicate-safe effects to history
and popularity projections, with a replay mechanism after interruption.

A Redis response cache alone does not guarantee one effect: concurrent cache misses
can execute twice, and a crash after the database write but before caching the
response leaves an ambiguous retry. Durable identity must cover the actual effect.

I would keep short-lived resume progress separate from durable qualified events.
That reduces write amplification while preserving the important history contract.
If financial settlement were in scope, it would require stronger independent
validation and reconciliation than self-reported client events.

### Start with understandable candidates

Initial recommendation sections can use frequently played albums, followed-artist
releases, genre matches, and tracks the user has not heard. Popularity can supply
fallbacks for accounts without history.

These queries are understandable and inexpensive to develop, but they still need
quality evaluation. Counting one user's history is not collaborative filtering,
and storing tempo/energy fields does not make a query use acoustic similarity.

Learned candidate retrieval and ranking can improve nuanced discovery later.
They introduce training, evaluation, feature consistency, and freshness work.
Cold start and diversity need explicit policies under either SQL or learned ranking.

| Approach | Benefit | Cost for this stage |
|----------|---------|---------------------|
| ✅ Simple candidates with measured ranking improvements | Explainable baseline and fast iteration | Limited similarity and eventual need for separate serving |
| ❌ Build a full ML platform before a baseline | Broad modeling options | Large operational scope before proving incremental value |
| ❌ Recompute all history aggregates on every page | Immediately reflects current rows | Expensive repeated work under read-heavy discovery traffic |

> “I would accept a bounded recommendation delay and cache or materialize sections.
> Playback should not wait while we recompute a user's taste profile.”

Cache identity includes the user and relevant version. Listening can trigger a
coalesced invalidation or schedule a refresh, rather than making every event cause
an immediate expensive rebuild. A popular cached fallback preserves discovery
availability when personalization is delayed.

### Preserve query meaning as data grows

Recently played means the most recent distinct tracks globally within that user's
history. Limiting an intermediate result ordered by track ID and then sorting the
subset by time does not answer that question once more candidates exist.

Similarly, a recommendation section called new releases needs an explicit date
window and eligibility filters. A finite randomly generated station is not a live
radio service; continuous radio needs refill, diversity, and repeat-history rules.

I would compare output against reference datasets and measure successful listening,
skips, diversity, and freshness. A universal claim that simple SQL gives “80% of
ML value” is not evidence about this product or catalog.

## ⚖️ Failure priorities and local implementation boundary — 3 minutes

The first priorities are playable asset publication, complete library revisions,
and identified listening events. A healthy process and valid database connection
cannot establish any of those promises by themselves.

I would test a missing rendition, an expired grant, a retry after commit, out-of-order
transaction completion, a sync page interrupted by another edit, duplicate playlist
occurrences, and event replay after consumer failure.

The local repository runs one Express API with PostgreSQL, Valkey, and MinIO.
It selects whole-file qualities, but the seed provides neither audio rows nor objects.
Missing media produces a fabricated URL. Search uses PostgreSQL LIKE; Elasticsearch
is declared but unused.

Library membership and its log are separate writes, and the sync cursor can skip
changes. Playlist replay caching has no in-flight lock or durable receipt. History
has no event deduplication; recommendations are SQL sections with TTL caching.
Session caches can retain old entitlements after admin changes.

Those source boundaries are detailed in the [architecture](./architecture.md#implementation-notes).
I would establish the three correctness contracts before adding a CDN rollout,
segmented playback, or a more sophisticated recommendation system.
