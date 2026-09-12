# Gallery — fullstack system design interview

A proposed upload-backed gallery, paced for a 45-minute interview. The repository's
running project is frontend-only; this answer explains a possible service and browser
contract beyond its fixed Picsum image set.

## 🎯 Scope and user journey — 4 minutes

> “I’ll follow a photo from upload to a ready gallery tile, then open it in a
> lightbox and return to the same place. The challenge is making asynchronous
> storage and image processing produce a predictable browsing experience.”

The core scope is owner-managed galleries, supported still-image uploads, three layouts,
responsive variants, a lightbox, and private/public viewing. Search, image editing,
comments, collaboration, and video are extensions. The three views share one collection;
they are not independent products with unrelated data models.

I would clarify whether gallery order matters and whether published images must be
revocable. I will use a stable metadata order with an explicit listing revision, and a
bounded revocation policy for media delivery. Already downloaded images cannot be recalled
from a viewer's device.

For capacity, assume 100 million stored originals, one million uploads per day, and 100
million image deliveries per day. A typical original is 5 MB; an average display rendition
is 200 KB. Those are planning assumptions, not measurements or promises about every photo
and device.

The proposed targets are p95 regional metadata latency below 150 ms, p75 first visible
image within 2.5 seconds on a specified mobile/network benchmark, and p75 layout shift
below 0.1. Typical supported 5 MB uploads should become ready within ten seconds after
transfer at admitted processing load.

Correctness means ready metadata references verified durable bytes. Transfer at 100% is
not ready. The UI must retain a clear pending/processing/failed state and recover lost
responses without creating another gallery entry or charging quota twice.

| Journey | Browser responsibility | Service responsibility |
|---|---|---|
| Browse | Reserve slots and select useful renditions | Authorized metadata and stable listing context |
| Upload | Show transfer and processing separately | Durable session, quota, verified input |
| Publish | Replace pending preview with stable server identity | Conditional manifest publication |
| Inspect | Scoped viewer controls and current-image loading | Appropriate full-view rendition and access |
| Return | Restore focus/anchor to the same photo | Stable IDs and defined list-change behavior |

## 🏗️ Architecture and ownership — 5 minutes

```
┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│    Gallery + viewer    │ ──▶ │ Metadata / upload API  │ ──▶ │      SQL + outbox      │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘

┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│     Direct upload      │ ──▶ │   Processing workers   │ ──▶ │  Responsive variants   │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘
```

The browser's gallery route owns collection context. A metadata layer owns fetched pages,
status, and request generations. UI state owns layout choice and selected image ID.
Individual image loaders own transfer/decode status for a particular resource generation.
A viewer controller owns focus and slideshow playback.

The API authenticates users and manages SQL records for galleries, images, uploads, quota,
and outbox events. It issues scoped upload authority, while the browser sends bytes
directly to staging storage. Workers consume durable jobs and generate a small set of
display variants.

The bottom row is the image-byte path. Outputs are stored under versioned keys and served
through a CDN with the authorization policy appropriate to the gallery. The metadata API
does not proxy every image byte, and the worker does not receive arbitrary user-selected
URLs to download.

Only the selected layout is mounted in a small implementation. Switching views retains the
collection and selected identity, not a separate dataset for each mode. The lightbox
follows the same order and pagination context as the underlying gallery.

One owner controls each kind of state. A slideshow index is derived from selected identity
and listing order. A timer cannot advance after the view is inactive or a modal takes over
keyboard input. An image decode cannot change metadata identity. These rules prevent small
components from producing conflicting global behavior.

The local 50-image demo needs only in-memory state and direct image URLs. A backend and
query cache become useful when metadata, uploads, or access policy actually exist. I would
not hide that change in scope behind a large architecture diagram.

## 💾 Shared contracts and state — 5 minutes

| Contract | Essential fields | Why the client needs them |
|---|---|---|
| Gallery listing | Gallery, ordered IDs, revision, opaque next cursor | Consistent traversal across layouts |
| Image | Stable ID, generation, oriented dimensions, alt/caption, state | Identity, geometry, and understandable status |
| Variant | Profile, format, width/height, URL, transformation version | Correct crop and responsive resource choice |
| Upload session | ID, state, expiry, transfer authority, result | Recovery after timeout or refresh |
| Error | Scope, code, retry/reset guidance | Distinguish failed image, page, and upload |

Oriented dimensions reserve display space before downloading pixels. Tiles request a
deliberate square crop; masonry and the lightbox use aspect-preserving profiles. Within
one responsive source set, candidates have the same crop and aspect ratio. A size label is
not enough to express that contract.

The server returns actual encoded dimensions, including when a source is smaller than a
maximum profile size. The browser supplies the rendered slot size and lets responsive
selection account for display density. An 80-pixel thumbnail does not count as a preloaded
full-view image.

Image identity is independent of a rendition URL. URLs change with content generation,
transformation version, profile, or temporary access authority. An index or current URL is
therefore a poor universal key for selection, history, and metadata merging.

The upload state machine distinguishes pending transfer, processing, ready, failed,
expired, and cancelled. The UI renders these states rather than infer success from a
network request completing. A local preview can be displayed while processing, but it is
clearly a local resource with its own lifetime.

A shared versioned runtime schema can reduce contract drift. It does not remove server
authorization or make a SQL row automatically match an API response. Validate network
inputs and outputs at the boundaries that matter, and preserve compatibility when a new
rendition profile or state is introduced.

| Proposed endpoint | Purpose |
|---|---|
| GET `/api/v1/galleries/:id/images` | Bounded authorized metadata page |
| GET `/api/v1/images/:id` | Current selected image and variant manifest |
| POST `/api/v1/galleries/:id/uploads` | Create/replay a durable upload session |
| POST `/api/v1/uploads/:id/complete` | Verify uploaded input and record processing work |
| GET `/api/v1/uploads/:id` | Recover progress/result state |
| DELETE `/api/v1/images/:id` | Remove access and enqueue byte cleanup |

## 🔄 Trace the first gallery page — 3 minutes

The route requests a metadata page and records its request generation. A response for a
different gallery/account generation is discarded. The page returns stable image IDs and
dimensions, so the layout can reserve its slots immediately.

The first visible or hero image loads eagerly. Offscreen grid images are deferred. For
each slot, the browser selects a format/resolution from compatible candidates. The image
loader tracks requested ID, content generation, and loading/error state.

When the user opens a tile, the viewer selects its stable ID and follows the same listing
context. It moves focus into the modal and suspends background shortcuts. The larger image
can load while controls and a correctly labeled placeholder remain usable. Late decodes
for a previous selection do not replace the current photo.

Closing returns focus to the initiating photo and restores an appropriate scroll anchor.
If the image was deleted or virtualized away, resolve a valid target before moving focus.
A successful metadata request alone does not complete this journey; image loading and
interaction behavior are equally part of the system.

## 🔧 Deep Dive 1: Geometry, layout order, and image delivery — 7 minutes

> “I would make image geometry available before image bytes. That lets the browser
> create a stable page and choose an appropriate rendition instead of guessing
> dimensions after each photo loads.”

Metadata supplies the dimensions after orientation normalization. The client uses them to
reserve aspect ratio for masonry and full viewing. Tiles reserve a square crop slot. A
placeholder uses the same geometry, so replacing it with decoded bytes does not change the
page height.

A blurred placeholder can improve perceived loading, but it does not inherently prevent
layout shift. Its container needs the correct dimensions. Likewise, CSS columns avoid
application positioning code but still perform browser layout and can rebalance as content
sizes or item counts change.

For a small unordered gallery, column-first masonry is a reasonable density trade-off. For
a chronological long collection, row-major tiles provide a more predictable order.
Explicitly positioned masonry is possible, but needs a clear relation between DOM reading
order, visual placement, and keyboard traversal.

I would not claim every JavaScript masonry implementation causes layout thrashing. Known
metadata permits batched position calculation without waiting for intrinsic image loads.
The extra cost is maintaining positions on resize and integrating scroll anchors,
virtualization, and focus. That cost should earn a visible benefit.

Switching layout preserves a stable anchor image and approximate viewport offset. Reusing
the same raw scrollTop across different geometry can move the user to an unrelated photo.
The metadata order stays the same even when visual placement changes.

On the service side, I would pre-generate a finite set of useful profiles. The client can
select among them without causing arbitrary new transforms on every request. Rare sizes
can be an on-demand extension, but parameters and concurrency must be bounded to avoid a
burst of expensive unique cache misses.

Content generation and transformation version are part of rendition identity. A new crop
algorithm or replacement photo produces a new URL. Caption changes do not require
rewriting image bytes. The browser and CDN can therefore reuse verified resources without
ambiguity about which content a key represents.

Codec choice is measured. JPEG/PNG fallback and selected WebP variants can form the
required set, with AVIF added when its bandwidth benefit justifies processing cost. An
optional format failure should not make every useful rendition unavailable. The metadata
advertises only verified available outputs.

At the assumed workload, 100 million deliveries averaging 200 KB consume about 20 TB/day.
Sending 5 MB originals for those views would be a much larger byte budget. The actual
saving depends on scene content and display sizes, so I would measure bytes per visible
image and decode latency rather than quote a universal ratio.

The browser preloads only a small likely adjacent set after the current viewer image is
ready. It retains loading feedback because preloading may not finish or may be evicted.
Discard old application references and scope completion to the current selected
generation. Thumbnail downloads alone do not warm a larger URL.

For very long galleries, pagination bounds metadata work and virtualization bounds DOM
work. Native image lazy loading does neither completely. I would virtualize tile rows
first, where geometry is simple, and preserve focused items deliberately. A masonry
position cache must be invalidated when container width changes.

| Approach | Benefit | Cost or failure |
|---|---|---|
| ✅ Dimensioned slots and responsive profiles | Stable layout and useful byte selection | Metadata/renderer contract must stay aligned |
| ❌ Wait for each image to reveal its size | Minimal initial metadata | Reflow and unstable scroll positions |
| ✅ Finite pre-generated variants | Predictable common-path delivery | Processing/storage for some unused outputs |
| ❌ Originals or unrestricted transforms everywhere | Simple or flexible URL interface | Excess bytes or unbounded cold transform work |

## 🔧 Deep Dive 2: Upload progress versus durable publication — 7 minutes

> “The browser finishing its transfer is one milestone. I would expose a separate
> processing state until the server has verified usable variants and published
> their manifest.”

Initiation creates an owner-scoped upload session with a stable client key and request
digest. In one SQL transaction, reserve quota and create the pending entry. If the
response is lost, retrying that key returns the same session rather than another invisible
reservation or gallery item.

A request with changed content under the same key is rejected. Uploading identical bytes
intentionally under a new key can create a separate entry. A content hash verifies data;
it cannot distinguish a retry from a user choosing to add the same photo twice.

The API returns scoped authority for a server-generated staging key. The browser transfers
directly to storage and shows progress. It keeps the session ID so it can recover from a
lost completion response. An expired transfer URL is refreshed for the same still-valid
session under its existing quota reservation.

Finalization verifies ownership, actual bytes, and an immutable input version. An upload
URL might still permit changing the staging object, so workers must use the verified
version or a private immutable copy. Merely checking a mutable key and decoding it later
leaves a race between validation and processing.

The state transition to processing and an outbox event commit together. A dispatcher
retries queue publication from committed rows. This prevents a database success followed
by queue failure from leaving an upload permanently forgotten. Polling upload state is
enough initially; push updates can be added later.

Workers validate actual decoded content and enforce byte, pixel, frame, memory, and time
budgets. They normalize orientation and remove sensitive metadata from display variants.
The original remains private unless the product provides a separate authorized
original-download feature.

Outputs are written and verified before a short publication transaction installs the
manifest. That transaction checks image generation/state and settles quota once. A worker
finishing after deletion cannot mark an old generation ready again. Duplicate messages
find an existing terminal result or retry the same generation safely.

SQL cannot roll back object writes. A worker crash after some output uploads may leave
unreferenced bytes. Retries can reuse verified outputs, and a reconciler later deletes
confirmed orphans after ownership/expiry horizons. A long transaction around decoding
would hold locks without solving cross-system atomicity.

The browser replaces its local preview only when the server reports ready and provides the
stable image identity. It may need to refresh the listing revision before integrating the
new item. Arrival order of asynchronous jobs should not silently become gallery order.

If processing fails, keep a visible failed item in the owner's upload view with a reason
and a bounded retry action. The public gallery only includes ready entries. Transfer at
100% must not be labeled “Published” while required variants are missing.

Cancelling or deleting is also a state transition. It blocks future publication, releases
or adjusts quota under a guarded terminal outcome, and schedules physical cleanup. If
cleanup fails, the image stays unavailable while storage reclamation retries; failure does
not make it public again.

| Approach | Why it fits | Cost |
|---|---|---|
| ✅ Session, outbox, conditional publication | Recoverable partial success and honest progress | More states and reconciliation work |
| ❌ One request from upload through all codecs | Simple happy path | Timeouts, API memory pressure, unclear retry outcome |
| ❌ Treat object writes as part of SQL rollback | Appears atomic | Leaves objects behind despite database rollback |

## 🔧 Deep Dive 3: Stable viewing, focus, and private delivery — 7 minutes

> “A viewer should stay attached to one photo and one collection context. That
> identity has to survive pagination, layout changes, and media authorization.”

The API uses keyset traversal over creation order plus unique ID and returns an opaque
cursor bound to gallery, sort, and listing policy. For an exact browsing session,
membership/order changes invalidate its listing revision and trigger a visible refresh. An
immutable published manifest is another choice for exhibitions.

A cursor by itself does not freeze a mutable gallery. Offset pagination is easy, but
inserting or deleting earlier items can repeat or skip later ones. I would choose explicit
reset behavior rather than promise stable chronology from an unversioned cursor or a list
index.

The browser stores the selected ID. At a page boundary, it fetches the next range under
the same context, rather than wrapping among currently loaded items as though the whole
gallery ended. No-more-items, request failure, and listing-reset responses produce
different UI behavior.

The lightbox records its initiating image/focus target. It moves focus inside, contains
Tab traversal, prevents background interaction, and offers Escape and a visible close
control. On close, it restores a valid target, remounting a virtualized item first if
necessary.

Root-level placement or a portal can avoid particular clipping problems, but neither is a
complete modal implementation. A portal retains React context and event ancestry; it
changes DOM placement. Focus containment and background inertness still need a tested
controller or accessible primitive.

Keyboard events have one active owner. Lightbox arrows cannot also advance an underlying
slideshow. View buttons use either ordinary button semantics or a complete tab pattern.
The selected underline alone does not establish that keyboard model.

Autoplay is explicit and pausable. Entering focus or hover stops rotation, as do view
changes, a modal opening, or a hidden page. It does not restart unexpectedly.
Reduced-motion preferences and concise announcements preserve user control without turning
automatic slide changes into constant screen-reader interruptions.

Private media access also follows current identity. Metadata authorization is not enough
if returned object URLs bypass every check. For revocable galleries, the CDN validates
short-lived authority before serving even a cached image, and origin storage remains
private.

I would state a maximum capability lifetime, for example 60 seconds, and use browser cache
policies consistent with that revocation window. A privacy change prevents new
capabilities while prior ones expire. Already downloaded bytes remain outside the
service's ability to recall.

Long-lived public immutable browser URLs are appropriate for deliberately persistent
public media, but have different consequences. A CDN purge cannot remove a valid browser
cache entry or a saved copy. I would not offer that caching policy and also promise
immediate privacy changes for the same resource.

Metadata caches separate reusable descriptions from current access and temporary signed
authority. Client requests and caches are scoped by account and resource generation. A
stale result after logout cannot repopulate a private gallery under another user, and
retries of expired authority remain bounded.

| Approach | Benefit | Cost or failure |
|---|---|---|
| ✅ Stable IDs and listing revision policy | Predictable selection and neighbor traversal | Explicit refresh when the collection changes |
| ❌ Independent array indices per view | Small amount of initial state | Selected photo changes meaning as lists grow |
| ✅ Modal/focus/playback controller | One owner of interaction and return path | More lifecycle work than an overlay div |
| ❌ Public cache headers for revocable private media | Easy byte caching | Incompatible with the stated access guarantee |

## 🧪 Scaling and failure validation — 5 minutes

I would scale the metadata API, processing workers, and byte delivery independently.
Direct uploads prevent original bytes from filling API memory. Workers scale by queue age
and decoded pixel/codec cost; the CDN absorbs hot read traffic. Gallery indexes and
bounded pages keep metadata work predictable.

The browser has its own limits: mounted rows, fetched pages, decoded resources, preloads,
and local previews. Revoke preview object URLs when no longer owned and release abandoned
request references. A long gallery should not become a long-lived cache of every
full-resolution image the user passed.

| Failure exercise | Expected outcome |
|---|---|
| Initiation or completion response lost | Same session and one quota outcome |
| Worker dies before manifest commit | No partial required publication |
| Image deleted during processing | Late output cannot become visible |
| Metadata succeeds but bytes fail | Reserved image error state, useful surrounding gallery |
| Rapid viewer navigation | Old decode cannot replace current selection |
| List changes at next-page boundary | Explicit refresh/reset, not silent wraparound |
| Modal closes after list virtualization | Logical focus and scroll restoration |
| Access changes while URLs are cached | Delivery follows the documented capability window |

Measure metadata latency, first image decode, layout shift, bytes per displayed image,
navigation responsiveness, queue age, publication latency, orphan storage, and quota
reconciliation. Keep telemetry free of private photos, sensitive EXIF, and signed URL
credentials. A broad “page load time” hides too many separate paths.

Browser testing covers keyboard-only use, reduced motion, zoomed text, image errors, and
slow networks. Service tests inject failures between object writes, SQL commits, and queue
handoffs. Contract tests verify dimensions, profile/crop compatibility, state transitions,
and listing context rather than mirror a schema implementation.

The first rollout can support one gallery, a small profile catalog, and polling upload
status. Prove idempotent publication and reliable viewing before adding more codecs,
unbounded collections, or complex masonry virtualization. Each extension should preserve
the same identity and lifecycle boundaries.

## ⚖️ Trade-offs and close — 2 minutes

| Decision | Chosen approach | Alternative |
|---|---|---|
| Display | ✅ Dimensioned slots and appropriate profiles | ❌ Originals everywhere |
| Publication | ✅ Durable states and verified manifest | ❌ Transfer complete means ready |
| Browsing | ✅ Stable identity and explicit list changes | ❌ Mutable global index |
| Viewer | ✅ Focus/keyboard/playback ownership | ❌ Independent global event handlers |

> “The shared contract is image identity, geometry, publication state, and current
> access. Those fields let the browser stay stable while transfers and processing
> happen independently, and they let the service recover failures without lying
> about what is ready.”

The repository currently demonstrates layouts with fixed Picsum URLs and in-memory state.
It has no upload API, worker, schema validation, responsive manifest, query cache, or
complete modal focus behavior. The README and architecture distinguish those limitations
from the proposed system in this interview.
