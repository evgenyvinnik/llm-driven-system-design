# Apple Music architecture

## System Overview

A music service has a large media-delivery workload and a smaller, correctness-sensitive
control workload. The first moves encoded audio to listeners. The second decides
what they may play, maintains libraries and playlists, and turns listening events
into useful discovery features.

The production design below is **proposed**, not a description of Apple's internal
systems. The final [Implementation Notes](#implementation-notes) trace the current
React/Express/PostgreSQL/Valkey/MinIO application. Its seed supplies catalog metadata
only; it does not include playable audio, a transcoder, or an offline/DRM pipeline.

## Requirements

### Functional requirements

- Search and browse tracks, albums, artists, and curated discovery sections.
- Authorize playback and deliver a compatible audio representation.
- Maintain a personal library and ordered playlists across devices.
- Recover acknowledged library operations after retries or disconnection.
- Record identified listening events and produce history/recommendations.
- Give operators controlled catalog publication and availability tools.

The initial design supports online web playback and temporary buffering. Offline
licenses, upload matching, social activity, lyrics, and simultaneous collaborative
playlist editing are separate extensions. Subscription labels in the local code
are teaching fixtures, not current Apple Music product or pricing claims.

### Non-functional requirements

| Concern | Proposed target / invariant |
|---------|-----------------------------|
| Playback start | p95 below one second from accepted Play intent to audible audio on supported networks |
| URL authorization | p99 below 200 ms, measured separately from media delivery |
| Availability | 99.99% monthly successful authorized playback starts |
| Library durability | An acknowledged operation survives retries and process failure |
| Sync completeness | Advancing a cursor cannot hide an earlier committed change |
| Playlist integrity | Stable entry identity and consistent ordering after each committed edit |
| Recommendation freshness | Bounded delay acceptable; does not block current playback |
| Access control | Enforce current entitlement before issuing a usable delivery grant |

A short API response time does not prove fast audible playback. DNS, TLS, origin
availability, buffering, codec support, and browser playback permission also matter.
Targets need measurement on representative devices and networks.

## Capacity Estimation

Assume 100 million catalog tracks and ten million concurrent listeners. At
256 kbit/s, media egress is **2.56 Tbit/s**, or 320 GB/s, before overhead. That is
a delivery-network problem even if authorization uses very little CPU.

A three-minute track at 256 kbit/s is 5.76 MB, so one representation of that
catalog is about 576 TB before replication. Compressed lossless size varies by
content. Stereo 24-bit/192 kHz PCM is 9.216 Mbit/s before compression; that number
is not a universal bitrate for an ALAC encode.

If each active listener starts one track every three minutes, authorization is
roughly 55,600 requests/s before skips, retries, and prefetch. Reporting progress
every 15 seconds produces about 667,000 reports/s. Most progress does not need to
become a permanent play event; these workloads need distinct acceptance policies.

For personal data, assume an average 1,000 saved references across 100 million
accounts: 100 billion library rows. Partitioning by user keeps a user's mutations
and sync log together, while catalog metadata remains shared.

### Local Development Scale

The SQL seed creates 3 accounts, 5 artists, 8 albums, 26 tracks, 4 radio stations,
4 playlists, and sample library/history/genre records. It inserts no audio-file
rows and performs no object uploads. Browsing this fixture does not benchmark
streaming throughput, synchronization, or recommendation quality.

## High-Level Architecture

The media and API paths separate at the client:

```text
┌────────────────────────────┐    ┌────────────────────────────┐
│ Browser / native player    │───▶│ CDN: media and artwork     │
└──────────────┬─────────────┘    └──────────────▲─────────────┘
               ▼                                 │
┌────────────────────────────┐    ┌──────────────┴─────────────┐
│ API edge + identity        │    │ Private object origin      │
└──────────────┬─────────────┘    │ Verified media publication │
               ▼                  └────────────────────────────┘
┌────────────────────────────┐    ┌────────────────────────────┐
│ Playback authorization     │    │ Catalog + search           │
│ Library / playlist service │───▶│ Metadata + search index    │
└──────────────┬─────────────┘    └──────────────▲─────────────┘
               ▼                                 │
┌────────────────────────────┐    ┌──────────────┴─────────────┐
│ User database + change log │    │ Durable listening events   │
│ Operation receipts         │    │ Aggregates/recommendations │
└────────────────────────────┘    └────────────────────────────┘
```

The listener fetches bytes from the delivery tier after authorization. Audio does
not pass through the library service. Catalog publication verifies object presence,
format, and metadata before exposing a rendition as available.

A listening-event pipeline feeds discovery and analytics independently. A failure
to refresh recommendations should not stop an already authorized track.

## Core Components / Request Flows

### Playback authorization and delivery

1. Authenticate the request and resolve current account/content entitlement.
2. Intersect allowed renditions with available assets and client codec support.
3. Apply quality preference and measured network/buffer policy within that set.
4. Issue a short-lived delivery grant for a specific immutable object or manifest.
5. Let the client fetch media directly, reporting first-play and stall outcomes.

Authorization and network adaptation answer different questions. The server controls
which assets may be accessed. The client observes its buffer and connection more
directly; a declared “Wi-Fi” hint is neither a trusted entitlement nor a throughput
guarantee. Choosing one file at track start is whole-file selection, not ABR.

The initial product can use whole-file delivery where it meets measured startup
and stall targets. Segmented streaming adds adaptation and bounded prefetch, at the
cost of packaging, manifests, compatible timelines, and more requests.
Gapless playback additionally requires correct boundary/timing handling; generating
a URL or starting another element from an `ended` handler does not establish it.

### Library mutation and sync

A proposed mutation transaction serializes writes for the owning library, checks
a stable operation ID, changes membership, appends a change with the next library
revision, and records the operation result. A per-user counter row locked until
commit can establish this order without serializing all users globally.

A device applies a consistent initial snapshot, then ordered change pages. It
advances only to the cursor represented by the page it applied. A retention floor
explicitly requires a new snapshot when a device's old cursor is no longer supported.

A PostgreSQL sequence provides unique allocation, but its values are not rolled
back and can have gaps. It does not by itself order transaction visibility.
[PostgreSQL sequence semantics](https://www.postgresql.org/docs/16/functions-sequence.html)
Consequently, “token 101 was visible” cannot prove that every lower allocated token
has already committed. The local feed has this problem and a separate two-query race.

### Playlist editing

Each occurrence has a stable entry ID distinct from the catalog track ID. A user
may intentionally include one song twice. Deletion and reordering should address
that occurrence, not accidentally affect every appearance of the song.

Serialize edits to one playlist or require an expected revision. Position changes
must respect database uniqueness throughout the chosen update procedure. Wrapping
a sequence of colliding position assignments in a transaction does not defer an
immediate unique constraint.

Collaborative editing would add a defined conflict protocol. It should not be
claimed merely because two authenticated clients can call the same REST endpoints.

### Listening events and discovery

Playback instances have identities separate from track IDs. A qualifying play is
based on accumulated eligible listening time under a stated policy, not simply a
large seek position or a client-supplied completed flag.

The durable event path deduplicates repeated reports of one event, then updates
history and materialized aggregates. Progress state can be short-lived and lossy;
qualified events need a stronger recovery contract. Royalty accounting would need
additional validation and reconciliation beyond this learning design.

Start discovery with understandable candidates: recent favorites, followed-artist
releases, genre candidates, and unseen tracks. Add learned retrieval/ranking only
when measured discovery quality justifies the pipeline. Popularity and genre
queries are not collaborative filtering, and storing audio features does not mean
recommendations use them.

## Database Schema

The authoritative local SQL is [backend/src/db/init.sql](./backend/src/db/init.sql).
It creates 16 tables directly; table/index/trigger creation is not rerunnable.
The following inventory describes the supplied schema, not proposed guarantees.

| Tables | Key structure | Current constraint or limitation |
|--------|---------------|----------------------------------|
| `users`, `sessions` | Unique email/username/token; session expiry | Roles/tiers/preferences are strings without enum checks |
| `artists`, `albums`, `tracks` | UUIDs and catalog foreign keys | Track artist and album artist can disagree |
| `audio_files` | Track FK, quality, format, object key | No unique track/quality or verified-asset state |
| `library_items` | Primary key on user/type/item | Polymorphic item ID has no catalog FK |
| `library_changes` | User/token index, global token sequence | No durable operation ID or per-user commit-order protocol |
| `playlists`, `playlist_tracks` | Playlist owner; unique playlist/position | Entry ID exists but API generally addresses track ID |
| `listening_history` | User/time and track indexes | No unique playback/event identity or validation of completion |
| `track_genres`, `user_genre_preferences` | Track/genre and user/genre keys | SQL score increments; no learned features |
| `radio_stations`, `radio_station_tracks` | Station/track uniqueness | Personal stations have no owning user column |
| `uploaded_tracks` | User/object/matched-track fields | Schema only; no ingestion or matching workflow |

Album and playlist triggers recompute totals from child rows. The album trigger
fires on every track update, including play-count changes. Moving a track to a new
album only recomputes the new album; changing its duration does not recompute totals
for playlists containing it. Trigger presence is not complete denormalization maintenance.

A production schema would add operation receipts, library/playlist revisions,
asset publication state, validated constraints, and event identities. These should
be introduced through migrations and compatible API changes, not inferred from
columns whose names resemble the proposed features.

## API Design

The local API prefix is `/api`, with eight route groups. Important actual contracts:

| Method | Path | Current semantics |
|--------|------|-------------------|
| POST | `/api/auth/register`, `/login`, `/logout` | Paths under `/api/auth`; cookie plus returned login token |
| GET / PATCH | `/api/auth/me`, `/api/auth/preferences` | Current session / preference update |
| GET | `/api/catalog/search` | `q`, optional type/limit/offset; substring search |
| GET | `/api/catalog/tracks`, `/albums`, `/artists`, `/genres` | Lists under `/api/catalog` |
| GET | `/api/catalog/{tracks,albums,artists}/:id` | Details; album includes its tracks |
| GET / POST | `/api/library` | Read saved membership / insert and separately log an add |
| DELETE | `/api/library/:itemType/:itemId` | Delete and separately log a removal |
| GET | `/api/library/sync?lastSyncToken=N` | All changes above N plus a separately queried maximum token |
| GET / POST | `/api/library/history` | Read / insert caller-reported listening history |
| GET | `/api/library/recently-played`, `/api/library/check/:itemType/:itemId` | Recent subset / membership check |
| GET / POST | `/api/playlists`, `/api/playlists/public` | Own lists/create; public listing is GET only |
| GET / PATCH / DELETE | `/api/playlists/:id` | Read/update/delete metadata |
| POST / DELETE | `/api/playlists/:id/tracks`, `/api/playlists/:id/tracks/:trackId` | Append / remove all matching occurrences |
| PUT | `/api/playlists/:id/tracks/reorder` | Attempt sequential position updates in a transaction |
| GET | `/api/stream/:trackId` | URL preparation with quality/network query parameters |
| POST | `/api/stream/prefetch`, `/progress`, `/end` | Helpers under `/api/stream`; not called by browser playback |
| GET | `/api/stream/:trackId/qualities`, `/api/stream/playback/current` | Declared quality list / last reported progress |
| GET / POST | `/api/radio/*` | Station reads and personal-station creation |
| GET | `/api/recommendations/for-you`, `/browse`, `/similar/:trackId`, `/similar-artists/:artistId` | Routes under `/api/recommendations` |
| GET / POST / PATCH | `/api/admin/*` | Stats/users, catalog and station creation, cache clearing |

There is no `/api/catalog/browse`, `/api/recommendations/history`, upload/download
endpoint, device-sync push, or error-report ingestion service. The README explains
setup and the limitations of existing stream responses.

## Key Design Decisions

### Separate authorization from byte delivery

Keeping media off the API servers lets bandwidth capacity and request-processing
capacity scale independently. Immutable rendition keys make shared caching useful.
The authorization service still needs to resolve a real available representation,
not merely produce a syntactically valid URL.

The cost is less direct visibility into playback and a revocation window for an
issued grant. URL issuance cannot count bytes played. Private origins, delivery
policy, expiration, and client outcome reporting are separate pieces of this design.
The local public buckets and fabricated fallback URLs do not establish that boundary.

### Serialize a user's edits, not all listeners

A transaction linking membership, revision, change log, and operation receipt makes
acknowledged edits recoverable and gives sync a defensible cursor. Different users
can still mutate independently. A library's modest edit rate normally makes this
serialization much cheaper than debugging silent missed changes.

The cost is contention within a hot owner/playlist and the need for snapshot/retention
rules. At exceptionally high collaborative edit rates, a different conflict model
may be appropriate. Device wall-clock timestamps alone cannot resolve every edit
correctly, particularly with skewed clocks and ordered playlist operations.

### Keep personalization off the playback critical path

SQL-based sections offer an understandable starting point using existing data.
They are useful even before a trained model exists. Candidate diversity and freshness
can be explicit, testable policies rather than unsupported percentage-of-ML-value claims.

Caching those sections accepts a bounded delay after listening. A shared aggregate
or async invalidation avoids recomputing the user's entire history for every page.
The cost is a less immediate response to new tastes and the eventual need to move
expensive ranking/analytics away from transactional serving.

## Consistency and Idempotency

Proposed library changes and operation receipts commit together. Retry identity is
scoped to actor and operation, with a payload hash to detect reuse for a different
request. A cached HTTP response can accelerate replay but cannot replace the durable
receipt or serialize concurrent execution by itself.

A paged sync response has a stable upper boundary and advances to the last delivered
revision. Initial snapshots, deletion tombstones, retention floors, and metadata
resolution are explicit. Merely returning a maximum token from a later query can
skip a change committed between the page read and that query.

Listening events use their own event IDs. Replaying one completed event should not
increment popularity again, while two legitimate listens to the same track should
remain distinct. A blanket user/track/30-second time bucket is not a substitute
for defining the playback event being retried.

The local implementation has no durable mutation receipts, no listening-event
deduplication, and no transactional membership/change-log write. Details follow below.

## Security / Auth

Proposed session identity and current entitlement are distinct. A cached session
that embeds a subscription tier needs invalidation or version checks when the tier
changes. Revoking a session also does not revoke audio already downloaded or a
previously issued delivery grant without an additional delivery mechanism.

Locally, authentication uses bcrypt and opaque UUID tokens, with PostgreSQL sessions
and Redis user snapshots. Admin routes require the cached `admin` role; playlist
mutations check ownership. There is no real subscription purchase, DRM, territory
rights, device-license lifecycle, or trusted listening accounting.

Input validation mostly checks presence. Pagination, durations, completion flags,
roles/tiers, media metadata, and catalog relationships lack a complete validation
policy. SQL values are parameterized and list sort columns are allowlisted.
These protections do not turn arbitrary client-reported listening into valid plays.

## Observability

Proposed playback telemetry distinguishes authorization time, first audible frame,
stalls, buffering time, rendition, and termination reason. Library metrics cover
acknowledged edits, retry results, cursor lag, and reconciliation failures.

The current `apple_music_stream_start_latency_seconds` measures the URL handler,
not media first byte. `apple_music_active_streams` is a process-local gauge driven
by URL requests and optional report endpoints. It cannot reliably measure listening
concurrency or capacity without instance-safe playback identity and expiry handling.

HTTP metrics, rate-limit hits, session-cache outcomes, and playlist counters are
wired. Search latency is declared but unused; library counters mainly track playlist
side effects, not ordinary membership/sync routes. Pino request IDs are returned,
but most route logs use a base logger or console rather than the request child.
No Prometheus server, Grafana dashboard, tracing collector, or alerts are configured.

## Failure Handling

| Failure | Proposed response |
|---------|-------------------|
| Missing/unsupported audio asset | Explicit unavailable rendition; choose only an allowed compatible fallback |
| Authorization temporarily unavailable | Keep permitted buffered playback; bound retries for a new grant |
| Search/recommendations unavailable | Preserve active playback and show a recoverable discovery error |
| Library response lost after commit | Replay the durable operation result |
| Sync cursor below retention floor | Return reset-required and a consistent new snapshot |
| Media URL expires before reuse | Obtain a fresh grant for the current playback intent |
| Event processor crashes | Replay durable identified events without duplicate aggregates |

There are no circuit breakers or application retry/backoff wrappers in the local
code. Redis reconnects at the client level, but cache/auth reads can still fail
requests. Health checks omit MinIO, assets, schema readiness, and actual playback.
The presence of a presigning helper does not prove that the storage origin is reachable.

## Scalability Considerations

Scale media delivery by bytes, authorization by request rate, personal data by
owner, and discovery by candidate/aggregation workload. A single global popularity
counter updated for every play eventually becomes a contention hotspot.

Use bounded event batches and asynchronous popularity projections at larger scale.
A real search index needs an import/update/reconciliation pipeline; adding an
Elasticsearch container does not create one. Library log growth needs retention
and reset semantics before merely adding indexes or replicas.

The local primary database handles all history, catalog, and recommendation queries.
Whole-library sync responses and station/playlist detail lists are unbounded.
Every play-count update also triggers album-total recomputation, adding unrelated
work to the history path. These costs should be measured and separated before
claiming the service scales by starting more Express instances.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Media delivery | Authorized direct delivery | Proxy all audio through the API | Scale bandwidth independently |
| Quality policy | Server eligibility plus client observations | Trust network label as full decision | Separate rights from buffer conditions |
| Library sync | Transactional per-owner revisions | Unordered sequence allocation alone | Prevent skipped committed edits |
| Playlist mutations | Stable entry identity and revision checks | Track ID plus uncoordinated MAX position | Preserve intentional duplicates and ordering |
| Listening events | Durable event identity | Count every completed request | Retry without inflating plays |
| Personalization | Explainable candidates then measured ranking | Declare embeddings necessary immediately | Match complexity to evidence and quality needs |

## Implementation Notes

### Runtime and setup

[backend/src/index.ts](./backend/src/index.ts) runs one Express process with eight
route groups. Dev scripts set 3001–3003; the entry point defaults to 3000, while
Vite proxies `/api` to 3001. `npm start` executes TypeScript with `tsx`, not `dist`.
No entry point loads `.env`. PostgreSQL and MinIO defaults match Compose.

The schema initializes only on a fresh Docker volume. The `seed` npm script points
to absent `src/db/seed.ts`; the actual fixture is
[backend/db-seed/seed.sql](./backend/db-seed/seed.sql). Both schema and seed need
one-time application. The README uses `psql` with error stopping and a transaction.
The three seed hashes are identical and verified as `password123`, despite the
login page and seed comments advertising other passwords.

Elasticsearch and its client dependency are unused. Compose's MinIO initializer
creates two public-download buckets, but no audio or artwork objects. No startup
routine verifies schema, buckets, object existence, or readiness before listening.

### Streaming and player boundaries

[routes/streaming.ts](./backend/src/routes/streaming.ts) chooses from `256_aac`,
`256_aac_plus`, `lossless`, and `hi_res_lossless`. It takes the minimum of preference,
tier ceiling, and network ceiling. Free/student/individual-or-family ceilings are
AAC/lossless/hi-res; Wi-Fi/5G/LTE/3G ceilings are hi-res/lossless/AAC-plus/AAC.
Unknown network hints fall back to lossless; invalid preferences fall back to AAC.
The browser supplies neither hint and uses the cached account preference.

An existing `audio_files` row is signed for one hour through
[services/minio.ts](./backend/src/services/minio.ts). No object HEAD or decode check
occurs. A missing row produces a hardcoded unsigned localhost filename even if a
lower-quality real file exists. The qualities endpoint declares all options
available when no rows exist, including for an unknown track ID.

Prefetch always fabricates that filename instead of consulting audio rows or
signing their keys. Its Redis record is not consumed by playback. The upload/public-URL
helpers are unused. There is no transcoding, segmentation, DRM, or offline artifact.

[stores/playerStore.ts](./frontend/src/stores/playerStore.ts) requests a URL and
assigns it to one audio element. It does not prefetch, report progress/end, renew
URLs, or use a playback-generation guard. A slower earlier selection can replace
a newer track. Errors are stored but not displayed by the player; play/pause flags
can diverge from browser failures or stalls.

[Player.tsx](./frontend/src/components/Player.tsx) registers `timeupdate` and `ended`
listeners without cleanup. Development StrictMode can register duplicates. There
are no waiting/error handlers, media-session controls, keyboard shortcuts, or
accessible names for the transport sliders and most icon buttons. Whole-store
subscriptions propagate frequent progress updates to track rows and other consumers.

The 30-second timer checks current track ID and progress greater than 30,000 ms
once. It does not measure accumulated listening, retry after a pause, or cancel
old same-track timers. Every recorded context is `library`, irrespective of the
source. Manual next at the end of an un-repeated queue changes the flag without
pausing existing audio. Shuffle may repeat the same random index immediately.

### Library and playlist correctness

[routes/library.ts](./backend/src/routes/library.ts) writes membership and change
records in separate statements. Adds use `ON CONFLICT DO NOTHING`, but still append
a new change; removals append even if nothing existed. Item type is checked on add,
but referenced item existence/access is not. Seeded membership has no change records.

Sync first reads changes, then queries MAX(token) separately. A commit between
those reads can be skipped. Concurrent sequence allocation can also become visible
out of order. The response omits each row's token/data, has no pagination or retention
floor, and is not a consistent initial snapshot. No browser client calls this feed.

[routes/playlists.ts](./backend/src/routes/playlists.ts) creates/deletes playlists
and library references without a shared transaction or change-log entry. Metadata
and track edits do not emit sync changes. Appends read MAX(position)+1 without a
lock; concurrent requests can collide on unique position, and `ON CONFLICT DO NOTHING`
returns success even when the intended track was not inserted.

Repeated track IDs are allowed in different entries. Deletion removes all matches;
reorder addresses every matching track ID and sequentially assigns occupied positions.
An ordinary swap can violate the immediate unique constraint despite the transaction.
Delete and renumber are separate statements and do not serialize other editors.

[shared/idempotency.ts](./backend/src/shared/idempotency.ts) wraps only playlist
creation and track append with optional `X-Idempotency-Key` replay caching. Its core
behavior is a read followed later by a response write:

```typescript
const cached = await redis.get(key);
// A cache miss does not reserve the operation.
await redis.setex(key, 24 * 60 * 60, JSON.stringify(response));
```

There is no NX lock, in-progress state, payload binding, or durable receipt.
Concurrent misses execute twice; response writes are fire-and-forget and fail open.
Keys include user ID but not method/path, so reuse across endpoints can replay the
wrong successful response. The browser sends no idempotency keys.

### History, search, and recommendations

Both history and stream-progress endpoints accept caller-declared completion and
perform history/count updates separately without deduplication. The history route
also increments each stored genre score; progress does not. Invalid/duplicate reports
can distort counts, and partial failures can separate history from its derived scores.

[routes/catalog.ts](./backend/src/routes/catalog.ts) uses case-folded LIKE patterns,
not Elasticsearch, full-text ranking, or autocomplete. Search values are parameterized;
SQL wildcards still broaden matching. Pagination lacks bounded validation and stable
ID tie-breaks. Track/album/artist lists have five-minute Redis caches and genre counts
one hour, contrary to the historical note claiming catalog has no cache.

[routes/recommendations.ts](./backend/src/routes/recommendations.ts) uses 30-day
history counts for Heavy Rotation, 90-day followed-artist releases, three top genres
excluding the previous seven days, and unseen/popular tracks. The personal response
lasts 30 minutes; general Browse lasts 15 minutes. History/library writes do not
invalidate either cache. Similar tracks score same artist plus genre overlap;
audio features and other listeners' embeddings are not used.

Recently-played queries apply LIMIT while ordered by track ID, then sort that
subset by time in JavaScript. They do not return the globally most-recent distinct
tracks when more candidates exist. The seeded history does not update play_count,
so popularity and history-derived sections can initially disagree.

[routes/radio.ts](./backend/src/routes/radio.ts) stores generated personal tracks
without an owner or transaction. Detail reads those rows, but `/tracks` treats
`personal` as the random fallback and ignores them. Seeded `genre` station detail
also differs from its dynamic genre-filtered shuffle list. Station creation leaves
list caches stale; there is no continuous queue replenishment or acoustic matching.

### Authentication, limits, and operations

[routes/auth.ts](./backend/src/routes/auth.ts) hashes passwords with bcrypt cost 10
and writes seven-day sessions to PostgreSQL and Redis. The cookie is HttpOnly,
SameSite=Lax, and Secure in production; login/register also return the bearer token.
A required Redis read error returns 500 before any database fallback. Cache misses
query PostgreSQL and cache for one hour without capping TTL to session expiry.

Optional authentication only reads Redis, so private playlist access can fail on
a cache miss even while its PostgreSQL session is valid. Preference updates extend
the current cache for seven days without extending the database session; other
sessions retain old preferences. Admin role/tier updates invalidate no session caches.
Logout deletes PostgreSQL first, then Redis, leaving cached access if the latter
fails. Browser logout ignores errors and does not reset the player/queue.

[shared/rateLimit.ts](./backend/src/shared/rateLimit.ts) uses a custom Redis counter
store, not the imported `rate-limit-redis` package or a sliding window. INCR and
first-hit EXPIRE are separate; an interruption can leave an unexpired counter.
Errors fail open. Global 100/minute, stream 300/minute, and admin 50/minute are
mounted before authentication and therefore use IP, not user ID. Login/register
share 5 attempts/15 minutes; playlist creation gets 10/hour after authentication.
The declared search limiter is unused, and the global ceiling still applies to streams.

[routes/admin.ts](./backend/src/routes/admin.ts) exposes user updates and metadata
creation without an upload pipeline. Artist creation deletes the literal key
`artists:*`, which does not invalidate matching list keys. Several other catalog
writes invalidate nothing. Empty-pattern cache clearing runs FLUSHDB, removing
session caches, rate limits, stream state, and replay records as well as catalog data.

[shared/metrics.ts](./backend/src/shared/metrics.ts) increments active streams for
every URL request, while Redis uses one user/track key. Repeated requests, absent
end reports, expiration, concurrent decrements, and different serving instances
make the process-local gauge inaccurate. URL latency cannot observe direct MinIO
bytes. Route labels can collide across router mounts or grow for unknown paths.

[shared/health.ts](./backend/src/shared/health.ts) checks PostgreSQL SELECT 1 and
Redis PING in parallel without explicit deadlines. It does not check MinIO, schema,
or playable assets. [shared/logger.ts](./backend/src/shared/logger.ts) attaches
request context before auth, so the child usually lacks user ID; route logs mostly
do not use it. Shutdown closes the pool/Redis but never closes the HTTP listener
or waits for in-flight requests under a bounded drain protocol.

### UI scope and omitted systems

[Root layout](./frontend/src/routes/__root.tsx) retains the player during ordinary
client routing, but auth-loading states replace the shell. The sidebar fetches
playlists only when the user changes, so creates/deletes do not refresh it. Genre
links are not consumed by Browse, and home genre anchors cause full page navigation.
Search/detail requests have no cancellation or response-identity guards.

Settings' quality selector has no save handler. Admin creation buttons are inert;
Clear Cache does not check response success. Playlist Edit links back to the same
page; there is no track-add picker or reorder UI. Album hover-play needs embedded
tracks absent from listing responses. Library changes wait for server responses;
there is no optimistic store, query cache, virtualization, or offline operation queue.

One PostgreSQL database replaces partitioned user data and analytics, direct MinIO
replaces CDN delivery, and SQL sections replace learned ranking. Media publication,
private content grants, DRM/licenses, fingerprint matching, offline downloads,
device sync notifications, durable event processing, and multi-region services are
omitted. The five Playwright smoke tests cover page visibility/login, not playback
or concurrency. This review checked source and seed credentials, not a running stack.
