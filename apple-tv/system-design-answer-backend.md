# Apple TV+ — backend system design interview

A proposed subscription video-on-demand backend, discussed in 45 minutes. This is not
a description of Apple's private infrastructure. The local repository has
catalog/account APIs and simulated streaming routes; the production design
deliberately extends them.

| Discussion | Minutes |
|------------|---------|
| Scope and scale | 4 |
| Architecture and data ownership | 5 |
| Deep dive: publish complete media | 10 |
| Deep dive: authorize scalable playback | 9 |
| Deep dive: progress and viewing history | 8 |
| Catalog, operations and scaling | 5 |
| Validation and implementation comparison | 4 |
| Total | 45 |

## 🎯 Scope and scale — 4 minutes

> “I will design a subscription library rather than live broadcasting. That lets us
> encode ahead of time and concentrate on reliable publication, fast playback starts
> and cross-device resume.”

The core requirements are movie/series discovery, protected playback for entitled
accounts, household profiles, progress and watchlists. Content administrators need to
ingest, validate and publish a title, then withdraw it when rights change.

I would ask whether we own the clients and rights policy. I will assume supported web
and native clients, a billing provider, and region-specific availability. Exact
subscription prices and licensing terms are product inputs, not architecture
constants.

Offline downloads and live channels are later extensions. Offline playback adds a
device license lifecycle; live streaming adds ingestion timing and live-edge
constraints that this VOD design does not need.

Proposed service targets are p99 authorization below 200 milliseconds within a region,
and 99.99% authorization availability. The end-to-end p95 first-frame goal is two
seconds on an agreed network/device cohort. We must measure that on the client,
because the backend can respond quickly while media still fails to decode.

For planning, assume ten million daily viewers averaging two viewing hours and two
million concurrent streams at peak. These are exercise assumptions, not measurements
of the repository or Apple.

| Quantity | Rough estimate | Design consequence |
|----------|----------------|--------------------|
| Average concurrency | 20 million viewing hours / 24 ≈ 833,000 | Sustained media demand |
| Peak media bandwidth | 2 million × 6 Mb/s = 12 Tb/s | CDN delivery is essential |
| Video segment rate | 2 million / 6 seconds ≈ 333,000/s | Account APIs cannot sit in every segment path |
| Progress updates | 2 million / 15 seconds ≈ 133,000/s | Coalesce and partition writes |
| Encoded storage | 50,000 hours at aggregate 40 Mb/s ≈ 900 TB | Encoding and replication need cost control |

The segment estimate excludes separate audio, retries and startup requests. I would
keep units explicit and refine assumptions with traffic data rather than quoting a
database's universal writes-per-second capacity.

## 🏗️ Architecture and data ownership — 5 minutes

> “I would separate the control path from the media path. The account service decides
> whether someone can play; the CDN delivers the bytes.”

```
┌────────────────┐                  ┌────────────────┐
│ Viewer apps    │─ media ─────────▶│ CDN + shield   │
│                │                  │                │
└────────────────┘                  └────────────────┘
        │ control                           │ cache miss
        ▼                                   ▼
┌────────────────┐                  ┌────────────────┐
│ Domain APIs    │                  │ Private origin │
│ SQL / cache    │                  │                │
└────────────────┘                  └────────────────┘
                                            ▲ publish
                                            │
                                    ┌────────────────┐
                                    │ Encode workers │
                                    │ Queue / jobs   │
                                    └────────────────┘
```

The domain APIs own catalog, accounts/profiles, entitlement, progress and subscription
state. The license service is a separate protected dependency of playback, with access
to key management. I would draw its connection when discussing authorization rather
than add every dependency to the opening picture.

Catalog metadata changes infrequently compared with media requests. PostgreSQL is a
reasonable authority for title revisions, rights and subscription references. Redis
can hold sessions and bounded caches, while object storage holds immutable media.

Ingestion workers run independently of latency-sensitive APIs. They consume durable
jobs, produce encoded assets and record validation results. A publication coordinator
switches the active media revision only after required work succeeds.

The ownership model is small enough to explain at the board:

| Entity | Identity and important fields | Invariant |
|--------|-------------------------------|-----------|
| Account/profile | Account ID, profile ID, policy/version | Personal requests validate association |
| Title/revision | Title ID, source revision, active media revision | Published pointer refers to a validated set |
| Encoding job | Source revision + encoding profile | Repeated delivery has one accepted result |
| Playback session | Session ID, account/profile, title revision, expiry | Bounded authorization for a fixed context |
| Progress | Profile/title, active generation, sequence, position | Older session cannot silently overwrite handoff |
| Completion event | Event ID, playback session, title | Replay does not duplicate its contribution |
| Subscription | Provider ID, status, expiry, processed events | Provider retries do not repeat transitions |

I would not put every media segment in the hot relational request path. Validated
manifests and revisioned objects let the CDN serve playback without asking SQL which
file comes next.

## 🔧 Deep dive: publish complete media — 10 minutes

### Treat publication as a state transition

> “The most damaging ingestion bug is a ready title whose playlist points to missing
> media. I would make publication depend on a validated revision, not a manually
> edited status flag.”

An administrator first creates a draft with source identity, metadata and required
tracks. The upload service gives bounded access to private storage. It verifies the
completed upload's checksum and format before scheduling expensive work.

A source does not have to be 4K HDR to be valid. The required quality follows the
content contract. Encoding cannot create meaningful source detail that was never
present, and an SDR source should not acquire an HDR label just because a flag was
set.

The service creates durable jobs for a measured rendition ladder and required
audio/caption work. Job identity includes source revision and encoding profile.
Changing the source creates new jobs rather than mutating an output under an old URL.

Each worker writes to an immutable revision namespace. After upload, it checks
expected objects and stores a validation result. A partially uploaded directory is not
a successful rendition merely because one playlist exists.

Validation covers media references, duration/timeline agreement, compatible tracks and
representative decode checks. The exact ladder is tuned to content and supported
devices; I would avoid spending whiteboard time listing ten codec command lines.

### Recover between SQL, queue and storage

Creating a database job and publishing a queue message are two systems. If SQL commits
and queue publication fails, the title must remain visibly pending and the job must
still be discoverable.

I would write the job and an outbox dispatch record in one transaction. A dispatcher
publishes it, records acknowledgement and retries uncertain outcomes. The queue may
deliver twice; the worker claims the durable job and checks whether that
revision/profile already has a validated result.

Worker leases let another worker recover after a crash. A lease alone is not enough: a
late original worker must not overwrite the replacement's accepted result. Conditional
updates or fencing versions ensure only the current claim can advance job state.

Storage uploads also need stable object identity. If a retry finds an object, compare
the expected revision/checksum rather than assuming any matching filename is correct.
Temporary or abandoned assets can be collected after a safe retention window.

The publication coordinator reads the required rendition set and validation state. It
atomically updates the title's active revision with an expected-draft revision check.
A late encode from yesterday cannot publish over today's editorial change.

The previous active revision remains playable during this work. Viewers already
watching it keep stable URLs; new playback sessions receive the new revision after
publication. That avoids mixing old audio with new video during an update.

### Explain the cost trade-off

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Encode and validate before publish | Predictable startup, shared cache objects, simple rollback | Upfront compute/storage, including unpopular titles |
| ❌ Encode on the first viewer request | Avoids some unused work | First viewers wait; launches create unpredictable compute spikes |
| ❌ Publish each file as it finishes | Earlier partial availability | Viewers can receive incomplete or incompatible track sets |

I would accept the upfront cost because playback latency is central to this product.
To control waste, publish a valid baseline set first when policy permits and add
optional high-quality renditions as a new validated revision.

A per-title encoding analysis can reduce unnecessary bitrate. That is an optimization
after the publication invariant works; it should not make the release depend on an
opaque pipeline with no retriable job identity.

### Rollback and withdrawal differ

Rollback changes the active pointer to an earlier validated revision. Existing
playback sessions may continue their original revision, so we need a retention period
before garbage collection.

Withdrawal changes rights eligibility and denies new authorization. Old signed access
and licenses remain subject to their expiry or supported revocation behavior. Deleting
a catalog row or purging a cache cannot retract bytes already buffered on a device.

I would surface these states to administrators: processing, validation failed, ready
for publication, published and withdrawn. “Request accepted” should not appear as
“Available to viewers” while the queue is still working.

## 🔧 Deep dive: authorize scalable playback — 9 minutes

### Make one bounded decision, then deliver at the edge

> “With roughly 333,000 video-segment requests per second, checking PostgreSQL on each
> request makes the account database part of the media bottleneck. I would authorize a
> playback session, then validate bounded credentials at the delivery boundary.”

The playback API checks the authenticated account, selected profile ownership, current
subscription, territory/rights and supported device policy. It chooses a published
media revision and returns a playback session with expiring access.

The CDN validates authorization before serving protected cached bytes. Origin remains
private. Cache identity is based on immutable media revision/rendition while the edge
uses its supported mechanism to separate authorization from reusable object identity.

A unique token in every cache key can destroy reuse. Removing tokens from keys without
validating them creates an access bypass. The exact CDN integration must make both
concerns explicit.

The client requests a license through a protected service. License issuance rechecks
the relevant session and rights policy, and uses a controlled key-management boundary.
User-specific licenses and clear keys are not publicly cached media objects.

For Apple-platform DRM, I would use the documented FairPlay SDK and approved
production credentials. The service and client follow the supported key exchange
rather than inventing their own SPC/CKC cryptography. [Apple FairPlay
Streaming](https://developer.apple.com/streaming/fps/)

HLS allows alternate renditions and fragmented MP4 as well as transport-stream media.
I would choose packaging based on actual device and protection compatibility, not
claim that HLS is inherently less efficient than DASH. [RFC
8216](https://www.rfc-editor.org/rfc/rfc8216)

### Bound authorization staleness

Short-lived access reduces the time after a rights or subscription change during which
old authorization remains usable. Very short expiry increases renewal traffic and can
interrupt otherwise healthy playback during an authorization outage.

I would define a renewal window with jitter and coordinate one renewal per playback
session. The client renews before expiry, while the server retains the session
identity and fixed media revision.

A cancelled renewal or billing webhook does not necessarily mean an immediate stop.
Product policy distinguishes entitlement paid through a date from revocation for a
security or rights reason. The backend models those transitions explicitly.

Device/concurrency enforcement uses uniquely identified playback leases with heartbeat
expiry, scoped to the account. An in-memory counter keyed only by title or device
class cannot establish which viewer owns a stream or recover cleanly after a crash.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Authorized CDN access with bounded lifetime | Scales media independently; preserves access policy | Credential renewal and revocation-window complexity |
| ❌ Proxy every segment through account APIs | Central checks are straightforward | Media traffic and dependency failures overwhelm the control path |
| ❌ Public origin bucket | Easy caching | Anyone with an object URL bypasses entitlement |

The chosen design gives up instant universal revocation of all delivered material. I
would state the actual revocation window and platform guarantees rather than call any
token TTL “secure” without context.

### Fail without manufacturing success

If a CDN request fails, try a bounded retry or alternate healthy delivery path. Do not
route an unbounded failover wave directly to an origin sized only for cache misses.

If a license service fails, new protected playback may be unavailable while already
licensed buffered playback continues. Returning a placeholder license with HTTP 200
cannot repair that dependency.

Circuit breakers and bulkheads protect scarce downstream capacity. Their timeout does
not guarantee cancellation, so work already sent may finish later. Retrying a mutating
operation therefore still requires durable identity.

I would alert on the gap between successful authorization and actual client
first-frame events. That detects failures hidden by happy API status codes, such as
empty segments or unsupported packaging.

## 🔧 Deep dive: progress and viewing history — 8 minutes

### Preserve the latest accepted intent

> “A resume pointer is mutable user intent. Viewing history is a sequence of events.
> Combining the two leads to incorrect rewinds and duplicate completions.”

The progress key is profile plus title. Each update also carries playback session
generation, an increasing sequence and position. Within a session, lower or repeated
sequences cannot replace a newer accepted value.

A duplicate request with the same identity and payload returns the stored accepted
result. Reusing its identity with a different payload is a conflict. The receipt and
progress transition commit together so a lost response can be recovered after a
restart.

The server validates position against canonical media duration and the chosen
timeline/revision. It does not trust a caller to redefine a two-hour film as ten
seconds long and declare it complete.

For a handoff, the service establishes a newer active generation. A delayed update
from the old device can be retained for analytics but cannot move the resume pointer.
This is a deliberate product policy that needs an understandable client experience.

Taking maximum position is insufficient: a viewer can rewind. Ordering entirely by
wall-clock time is also insufficient: a clock far in the future can win indefinitely.
Server arrival order alone mistakes delayed offline delivery for current intent.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Session sequences and explicit handoff | Stable retries, intentional rewinds, bounded conflicts | Extra session state and ownership policy |
| ❌ Highest position wins | Simple monotonic merge | Rewinds and restarts disappear |
| ❌ Client-clock last-write-wins | Minimal coordination | Skew or delayed uploads can suppress valid progress |

If simultaneous independent viewing on one profile is required, I would clarify which
session owns resume or present both candidates. There is no universal timestamp rule
that knows what the person wants.

### Keep completion repeatable

Crossing the completion policy creates a uniquely identified completion event for that
viewing session. Store its contribution and outbox record consistently with the
accepted transition. A repeated final progress update must not add another completed
viewing.

A later rewatch gets a new viewing session and can have its own completion. Completion
and current position are separate enough that rewinding does not erase historical
evidence or force the pointer to remain at the end.

Continue Watching is a projection of accepted progress and catalog metadata. Use one
documented threshold policy, including exact boundary values, and filter
unavailable/restricted titles. Do not compare caller duration in one path with catalog
duration in another.

Deleting history needs an explicit policy for pending devices. A deletion generation
or tombstone can prevent an old queued update from immediately resurrecting cleared
history. Privacy expectations matter more than an implementation that simply runs two
DELETE statements.

### Scale without losing acknowledgement meaning

At the proposed 133,000 updates per second, I would coalesce snapshots within each
session and partition ownership by profile. Critical ordering stays within one owner;
aggregate analytics and recommendations are asynchronous.

If acceptance moves to a durable log, define whether the acknowledgement means durably
queued or visible in the resume view. A handoff read must be able to obtain the
acknowledged revision even when a projection lags.

Retries need backoff, jitter and bounded storage. A temporary progress outage should
let video continue while exposing unsaved state; it should not trigger a synchronous
write storm that harms playback authorization.

I would start with relational conditional updates at a measured smaller scale, then
preserve the same acceptance contract when partitioning. “Add Kafka” is not a
substitute for specifying ordering, deduplication and read-after-ack behavior.

## ⚙️ Catalog, operations and scaling — 5 minutes

Catalog search and recommendations can be eventually consistent. Publication and
playback authorization remain authoritative. If a stale recommendation points to a
withdrawn title, playback denies it gracefully and discovery converges to the newer
revision.

Start with metadata search and explicit indexes suited to the access pattern. Add a
search projection when relevance, query shape or load requires it. Track projection
revision and lag so a failed index update is recoverable.

For recommendations, a genre/popularity baseline is explainable and useful. A model
can improve ranking later, but it does not belong on the critical media path. A
fallback list should still respect rights and profile policy.

Use deterministic pagination and capped limits. Caches must include dimensions that
affect the response, such as profile/policy, filters and page size, or cache a
canonical complete result and slice deliberately.

Subscription webhooks are verified and deduplicated by provider event ID. Out-of-order
events use provider state/version or reconciliation so an old success cannot undo a
later cancellation. The browser's Subscribe success message alone is not proof of paid
entitlement.

| Operational signal | Why it matters |
|--------------------|----------------|
| Failed starts and first-frame latency | Measures the viewer's actual outcome |
| CDN hit rate and origin bytes | Explains media delivery cost and failover pressure |
| Oldest unprocessed encoding job | Detects stalled releases even when workers are alive |
| Outbox/projection lag | Shows accepted changes not yet propagated |
| Progress conflict/replay rate | Exposes device races and retry storms |
| Entitlement denial versus service error | Separates policy behavior from outages |

Use bounded metric dimensions; title, account and session IDs belong in controlled
event/log correlation, not unbounded histogram labels. Logs should redact credentials,
license material and sensitive personal context.

Readiness should reflect the dependencies needed for the intended operation, with a
deadline. A SELECT 1 proves a connection, not a valid schema, completed publication or
decodable title. An ongoing synthetic playback check provides different evidence.

For multiple regions, choose ownership for mutable profile and subscription state and
define failover. Media replicas and a global CDN help reads, but do not automatically
preserve write ordering during a partition.

## 🧪 Validation and implementation comparison — 4 minutes

I would verify failure windows rather than only endpoint responses. Kill a worker
after upload but before recording completion, then redeliver the job. Exactly one
validated revision should become active, and incomplete assets should remain
unpublished.

Commit a progress update and lose its response. A retry must return the accepted
position without another history contribution. Then delay an old-device update until
after a handoff and confirm it cannot overwrite the new session.

Try expired credentials against cached media, withdraw rights during playback, and
simulate a license outage. The observed behavior must match the stated authorization
lifetime and recovery policy.

Load tests need realistic cache-hit ratios, segment sizes, device cohorts and progress
frequency. A high rate of tiny JSON responses cannot substantiate terabit delivery or
a two-second first-frame claim.

| Decision | Main benefit | Cost accepted |
|----------|--------------|---------------|
| Revision-gated publication | Viewers receive complete, consistent media | Durable job/release coordination |
| Edge delivery with bounded authorization | Separates media scale from account storage | Renewal and revocation policy |
| Durable progress identity | Predictable retries and handoff | Explicit conflict/ownership model |

The repository currently uses one Express application, PostgreSQL, Valkey and
provisioned MinIO. It generates playlist text but returns empty video/audio segments;
no upload, encoding worker, real CDN or DRM service is connected. Subscription updates
are simulated.

Its timestamp upserts and Redis replay cache illustrate useful patterns with
limitations: progress/history writes are separate, batch routing is shadowed, and
replay keys lack operation/payload binding. The [architecture implementation
notes](./architecture.md#implementation-notes) contain the source audit. I would
present those as gaps to build and test, not as production guarantees already
achieved.
