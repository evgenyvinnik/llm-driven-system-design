# Gallery — backend system design interview

A proposed backend for an upload-backed image gallery, paced for 45 minutes. The
repository currently has no backend or database; this answer describes the service we
would add beyond its frontend layout demonstration.

## 🎯 Scope and requirements — 4 minutes

> “I’ll design the service that turns an uploaded photo into a ready gallery item
> and delivers an appropriate rendition to a viewer. My main concern is keeping
> publication and deletion correct when storage, workers, and API requests fail
> independently.”

The core requirements are owner-managed galleries, still-image uploads, metadata browsing,
responsive display variants, and private or public viewing. Slideshow, masonry, and tiles
consume the same metadata; the backend does not need a separate image database for each
layout.

I would support JPEG, PNG, and WebP inputs initially, with explicit byte and decoded pixel
limits. Animated and unusual formats require separate policies. Image editing, visual
similarity, comments, and social features are outside this first design.

For targets, I would propose p95 regional metadata responses below 150 ms and 99.9%
browsing availability. A typical supported 5 MB image should reach ready state within ten
seconds at admitted load. That target excludes the user's transfer time and requires a
defined pixel/codec workload, not just a file-size average.

The important correctness rule is that ready metadata references verified durable image
bytes. Upload completion does not mean processing completion. A retry must not create
another image entry or charge quota twice unless the user deliberately starts another
upload.

Private media requires authorization on bytes as well as metadata. Public-to-private
changes need an explicit revocation window. I will design revocable galleries with
short-lived delivery authority rather than promise that a database flag can recall an
image already downloaded into a browser.

| Requirement | Backend consequence |
|---|---|
| Large uploads | Direct transfer to scoped staging storage |
| Reliable processing | Durable session, outbox, retryable worker job |
| Fast display | Finite versioned rendition profiles and CDN delivery |
| Ordered browsing | Stable metadata keys and explicit listing revision policy |
| Delete/cancel | Block stale workers and reconcile object cleanup |
| Private viewing | Authorization before delivery cache hits |

## 📏 Capacity and storage estimates — 4 minutes

I will assume 100 million stored originals, one million new uploads per day, and 100
million delivered images per day. At 5 MB per original, stored originals occupy about 500
TB and new original bytes add about 5 TB per day before replication.

One million uploads per day is approximately 11.6 uploads/s on average. Using a 5× peak
gives about 58/s. Request counts alone are not enough to size workers: a heavily
compressed image with many decoded pixels can cost more than a larger file containing a
simple small photo.

At 200 KB per delivered variant, client egress is about 20 TB/day. The corresponding
request rate is around 1,157/s on average and 5,787/s at the assumed peak. A CDN reduces
origin work but does not eliminate those bytes delivered to clients.

If eight output variants were useful per input, the system would create eight million
outputs per day. That does not require eight independent queue messages; one job can
decode once and produce a bounded set. I would measure CPU, memory, and storage per
profile before choosing the worker topology.

Variant storage is a measured distribution, not a fixed multiplier. Different formats,
quality levels, source dimensions, and crops change output size. I would estimate total
cost using observed usage and current provider contracts, rather than hardcode a universal
codec saving or a cloud price into this interview.

Partition metadata by gallery or owner when necessary. Start with one relational primary
and sensible indexes while scaling stateless API and workers separately. The first
bottleneck may be decode/encode capacity or hot-object delivery, not the number of
metadata rows.

## 🏗️ Architecture and responsibility — 5 minutes

```
┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│        Browser         │ ──▶ │ Metadata / upload API  │ ──▶ │      SQL + outbox      │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘

┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│     Object staging     │ ──▶ │   Processing workers   │ ──▶ │     Variants / CDN     │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘
```

The top row handles metadata and durable coordination. The API creates upload sessions in
SQL; an outbox dispatcher sends committed processing work to a queue. The bottom row
handles image bytes: direct staging upload, worker transformations, and verified variants
served through a CDN.

Original and output objects live in private storage. The browser receives scoped upload
authority after the API authenticates the owner and reserves quota. The worker receives a
server-chosen input key/version, not an arbitrary URL to fetch on the user's behalf.

SQL holds gallery ownership, image state, upload sessions, variant manifests, and the
outbox. Redis can accelerate metadata reads or rate limiting, but it is not the only
record of a pending upload or its quota reservation. Losing a cache entry must not forget
work that already owns storage bytes.

The API returns transfer/processing/ready/failed states. Polling the upload status is
sufficient for the first product; a push channel is optional. The UI can show progress
without requiring a long HTTP request that spans transfer and all codecs.

Workers write outputs before publishing their manifest. The manifest identifies image
generation, transformation version, dimensions, formats, and durable keys. Consumers only
receive complete required profiles for a ready generation, while optional formats may be
added through a controlled later update.

An object store and a SQL database do not share one transaction. I would therefore make
partial success explicit and recoverable. Unreferenced objects are cleaned later;
committed manifests are never rolled back by pretending their earlier network writes did
not happen.

## 💾 Data and API model — 5 minutes

| Record | Key fields and constraints | Purpose |
|---|---|---|
| User | ID, used/reserved bytes, quota | Atomic admission/accounting |
| Gallery | Owner, visibility, listing/access revisions | Authorization and browsing context |
| Image | ID, gallery, generation, processing state, dimensions | Stable entry independent of rendition URL |
| Variant | Image/generation/profile/format uniqueness, key, checksum, dimensions | Verified display manifest |
| Upload session | Owner-scoped client key, digest, staging key, state, expiry | Recoverable upload and retry outcome |
| Outbox event | Image/generation/event uniqueness, publication state | Reliable handoff to workers |

The content checksum verifies bytes. It does not identify the user's intent. Two identical
files may intentionally become two gallery entries; a repeated request with the same
upload key should instead return one session. Cross-user deduplication would require
reference tracking and a confidentiality model, so I would defer it.

The image generation changes when content is replaced or invalidated. Transformation
version changes when crop/resize/codec rules change. Both belong in output identity, so a
later deployment cannot replace the bytes under a supposedly immutable URL.

| Method | Proposed endpoint | Contract |
|---|---|---|
| POST | `/api/v1/galleries/:id/uploads` | Reserve quota and create/replay session |
| POST | `/api/v1/uploads/:id/complete` | Verify immutable input and queue processing |
| GET | `/api/v1/uploads/:id` | Recover current processing/result state |
| GET | `/api/v1/galleries/:id/images` | Bounded authorized metadata page |
| GET | `/api/v1/images/:id` | Current state and variant descriptors |
| DELETE | `/api/v1/images/:id` | Mark unavailable and schedule cleanup |
| PATCH | `/api/v1/galleries/:id` | Owner changes with expected revision |

Image responses include oriented dimensions and meaningful alt/caption fields. They expose
actual available renditions, not fabricated URLs for profiles still processing. Variant
width descriptors correspond to the encoded bytes, while the frontend decides the rendered
slot size for its chosen layout.

## 🔧 Deep Dive 1: Reliable upload and atomic publication — 7 minutes

> “I would keep the API responsible for authority and state, while storage handles
> bytes and workers handle expensive transformations. The connection between them
> is a durable state machine, not a long-running database transaction.”

Initiation authenticates the gallery owner, validates the declared file constraints, and
locks the quota/accounting boundary. In one transaction it reserves bytes, creates a
pending image/session, and records the request digest under an owner-scoped client key.
Concurrent uploads cannot each spend the same remaining quota.

A duplicate key with the same digest returns the same session. A changed digest under that
key returns a conflict. If the upload URL expires while the session is still valid, renew
transfer authority for that session under the same reservation. Do not create another
hidden reservation merely to replace an expired URL.

The browser transfers bytes directly to a server-generated staging key. The transfer
capability binds the intended key, expiry, and enforceable constraints. The client cannot
claim completion for another owner's key or choose an arbitrary source that the worker
will download.

Finalization checks actual object existence and size, then binds an immutable input
version. This matters because an upload URL can remain usable after the first transfer:
verifying a mutable object and later decoding changed bytes is a race. Capture the
object-store version or copy verified input to a new immutable private key before queuing
it.

The finalization transaction rechecks session expiry/state and records both the processing
transition and outbox event. If the client loses the response, polling or repeating
completion finds the same outcome. A database commit followed by a failed queue publish
does not lose the work because the outbox remains retryable.

The worker validates decoded content, not merely a MIME string supplied by the browser.
Enforce dimensions/pixel count, supported frame count, memory, CPU time, and output
limits. Normalize orientation and remove sensitive metadata from public display variants.
Original downloads follow a separate explicit access policy.

Generate deterministic profiles under the image generation and transform version. Write
outputs first and verify their metadata/checksums. Then publish the manifest in a short
SQL transaction that checks current image state and worker ownership. If the image was
deleted or superseded, the old job cannot make it ready again.

Quota settlement occurs once with the terminal session transition. Convert the reservation
to actual accounted bytes, or release it on an eligible failure/cancellation. Retries
check the prior outcome. A cleanup job and a worker must not both refund the same
reservation because they observed an earlier state.

If a worker crashes after output writes but before publication, a retry can reuse verified
outputs or create an isolated attempt set and choose one manifest. Orphan cleanup waits
beyond upload/worker ownership horizons and checks references before deletion. SQL
rollback alone does not remove objects written earlier.

The queue is at-least-once. Job uniqueness and conditional publication make repeated
delivery harmless. A dead-letter path records a failed state and reason after bounded
retries; it does not leave an owner staring at “Processing” forever.

| Approach | Why it fits | Cost |
|---|---|---|
| ✅ Direct upload, durable session, outbox | Separates byte transfer from API capacity and survives partial failure | More explicit lifecycle/reconciliation state |
| ❌ Synchronous API upload plus all codecs | Straightforward request flow for tiny workloads | Long requests, memory pressure, ambiguous timeouts |
| ❌ SQL transaction around object writes | Appears to promise atomicity | Cannot roll back storage and holds locks during expensive work |

## 🔧 Deep Dive 2: Variant profiles, caching, and deletion — 7 minutes

> “I would pre-generate a small useful profile catalog, then measure whether
> additional formats or sizes earn their processing and storage cost.”

Tiles need square crops, while masonry and the lightbox generally need the full
composition. These are separate profiles. A responsive candidate set must not mix square
and uncropped images simply because one is labeled small and another large. The browser
chooses resolution; it should not accidentally choose a different crop.

For aspect-preserving profiles, do not enlarge a small original unnecessarily. Return the
actual encoded width and height, even when the profile name describes a maximum bound. A
tiny source cannot become detailed simply because its URL says “large.” The viewer can
display its limits honestly.

A baseline set might include thumbnails plus medium and large display renditions, with
JPEG/PNG fallback and selected WebP outputs. AVIF can be generated when measurements show
useful savings at acceptable processing cost. Optional codecs should not block publication
of an otherwise complete required manifest.

Pre-generation makes frequently requested variants available at predictable latency. The
cost is storing outputs some users never view. On-demand transforms can suit rare
dimensions, but require a constrained parameter set, shared work suppression, and limits
so a burst does not generate thousands of unique expensive requests.

Keys include image identity, content generation, transform version, profile, and format.
Clients can cache verified bytes without receiving changed content under the same key.
Updating a caption does not require regenerating image bytes; replacing content creates a
new generation and new rendition URLs.

Cache identity and authorization remain separate. For revocable galleries, the edge
validates short-lived authority before serving a cached object, and origin storage remains
private. A cache hit must not skip the access check. Shared byte storage inside the edge
is acceptable only after that request is authorized.

I would state a maximum capability lifetime, such as 60 seconds, and a matching revocation
promise. After privacy changes, new capabilities stop; existing ones expire within the
stated window. Browser caching uses a revalidation/no-store policy consistent with that
promise. Already downloaded copies cannot be recalled.

One-year publicly cacheable immutable URLs are useful for intentionally persistent public
content, but they imply a different product policy. A CDN purge or database visibility
flag cannot revoke a browser's valid local copy. Calling every variant public and
immutable while promising instant private deletion is inconsistent.

Deletion first makes metadata unavailable and advances the generation/status. Workers
recheck that state before publishing. A durable cleanup event removes the original and all
rendition generations with retries. The user-visible deletion boundary is
authorization/state; physical reclamation is a separate observable task.

I would reconcile storage inventory against published manifests and active jobs. Failed
cleanup should consume storage, not make the image visible again. Restoring a deleted
entry is an explicit policy with fresh authorization and generation, not an accidental
consequence of retrying an old processing message.

| Approach | Benefit | Trade-off |
|---|---|---|
| ✅ Finite pre-generated profiles | Predictable common-path delivery and cache reuse | Some unused processing/storage |
| ❌ Unrestricted transform URLs | Flexible dimensions | Unbounded cache keys and expensive cold requests |
| ✅ Authorized cache hits for revocable content | Defined privacy window with CDN byte reuse | Edge authorization and short-lived capability handling |
| ❌ Public browser caching for all media | Simple high cacheability | Incompatible with strong later revocation claims |

## 🔧 Deep Dive 3: Browsing order, metadata caches, and readiness — 7 minutes

> “A gallery API needs to preserve image identity and explain when its collection
> changes. An opaque cursor helps traversal, but it does not automatically freeze
> an album that someone is editing.”

I would initially order ready images by creation timestamp plus unique ID. The composite
index supports seeking after the last item without scanning every previous offset. Return
a bounded page and one extra candidate to determine whether another page is available
under that listing policy.

A cursor binds gallery, sort, last key, and the relevant listing context. Its contents are
validated, not trusted because they were base64 encoded. Authorization is checked on every
request. Knowing a cursor or image ID is not permission to read the associated metadata or
variants.

For exact slideshow navigation, I would choose a listing revision that resets when
membership/order changes. That can interrupt browsing during active uploads, but makes
semantics clear. An immutable published manifest is a stronger alternative for stable
exhibitions or albums that should remain fixed during viewing.

A live feed could instead allow insertions above the current cursor and tolerate some
shifting membership. That is a valid product choice if explained. Using offsets in a
frequently reordered gallery is weaker: deleting an early image can make later pages skip
an entry, while insertion can repeat one.

The frontend selects by image ID and asks for neighbors in the same listing context. The
last loaded item is not necessarily the gallery's end. Pagination responses must
distinguish no more items, temporary failure, and listing reset. Otherwise slideshow
wraparound can silently jump back to the first loaded page.

Metadata includes oriented dimensions, alt/caption, content generation, processing state,
and available profiles. Raw EXIF is not required for displaying a grid and may disclose
sensitive details. Large original metadata can be fetched separately under an explicit
owner policy when the product needs it.

Cache stable descriptive metadata by image generation and gallery/listing revision. Keep
delivery authority and current access separate. A broad cache key that omits viewer or
permission context must never contain another user's private signed URLs. Changing
visibility invalidates future authority, not just one cached list response.

Avoid wildcard cache scans as the correctness mechanism for every mutation. Versioned keys
and bounded TTLs can make stale descriptive data expire naturally, while current
authorization remains checked. A stale caption may be acceptable; a stale public flag
permitting private media is a different class of error.

Ready is a publication contract. It means required variants have verified durable
references and metadata is consistent with them. If one optional format is unavailable,
return the supported alternatives. Do not emit a fabricated AVIF URL and ask the browser
to discover that the job has not finished.

Service health must distinguish metadata, delivery, and processing. A growing worker
backlog may degrade uploads while existing galleries remain fully browsable. Do not remove
every read-serving instance because an optional codec worker is slow. Conversely, an API
that returns 200 with unreachable variants is not evidence that image delivery is healthy.

| Approach | Why it works | Cost or limitation |
|---|---|---|
| ✅ Keyset traversal with explicit revision policy | Efficient pages and understandable reset behavior | Cannot jump arbitrarily to page N without extra indexing |
| ❌ Offset pages for frequently changing order | Simple page-number UI | Skipped/repeated entries under concurrent changes |
| ✅ Versioned metadata separate from authority | Cache reusable descriptions safely | More careful response composition |
| ❌ One shared cache containing private URLs | Easy cache hit path | Cross-viewer disclosure or stale access |

## 🧪 Failure handling and validation — 4 minutes

I would exercise initiation, transfer, finalization, processing, and publication as
separate failure points. A screenshot of a ready gallery does not test those boundaries or
establish an upload durability guarantee.

| Scenario | Expected result |
|---|---|
| Initiation response lost | Same client key returns the existing session/reservation |
| Complete called twice | One state transition and one logical processing event |
| Staging object changes after verification | Worker uses the bound immutable version |
| Worker crashes after some output writes | No partial required manifest is exposed |
| Delete races worker completion | Generation/state check prevents resurrection |
| Quota cleanup races success | One conditional accounting outcome |
| Listing changes during slideshow | Explicit reset or documented live-list behavior |
| Private URL is cached at edge | Authorization still runs before delivery |

Operational metrics include upload/processing age, decoded pixel cost, retries,
publication failures, CDN/origin requests, delivered bytes, orphan storage, and quota
reconciliation. Use bounded labels and avoid logging signed URLs or sensitive EXIF. A
stuck session should be discoverable without inspecting arbitrary object contents.

Capacity tests should include large dimensions, transparency, varied photographic content,
and repeated requests for one hot image. Worker limits protect the service when bytes are
small but decode cost is large. Query benchmarks include deep traversal and gallery
revisions, not only the first page.

## ⚖️ Trade-offs and close — 2 minutes

| Decision | Chosen approach | Alternative |
|---|---|---|
| Upload lifecycle | ✅ Durable session plus outbox | ❌ Long cross-system request treated as atomic |
| Renditions | ✅ Finite versioned profiles | ❌ Arbitrary transforms on every request |
| Browsing | ✅ Keyset with explicit listing policy | ❌ Assume a cursor freezes all changes |
| Privacy | ✅ Authorized delivery with stated expiry | ❌ Public cache headers for revocable images |

> “The service publishes an image only after its usable bytes exist, and it keeps
> upload retries distinct from duplicate-photo intent. The same discipline connects
> processing state, quota, metadata, and delivery authorization.”

The local project implements none of this backend. It constructs Picsum URLs in a
browser-only React application. [architecture.md](./architecture.md) separates the
proposed schema and service flows from that actual implementation.
