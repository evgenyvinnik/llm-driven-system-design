# Gallery architecture

## System Overview

Gallery is a **frontend-only layout demonstration**: 50 hardcoded image IDs, three views, a shared overlay, and direct browser requests to an external placeholder service. There is no backend, database, processing worker, or API client in this project. Its main learning value is comparing layout, image-loading, state, and keyboard behavior.

This document separates a proposed production growth path from the exact local implementation in the final section. The proposed service would replace the fixed manifest with owned gallery metadata and a processing/delivery pipeline; it is not software already present in the repository. [README.md](./README.md) is the setup and feature guide.

## Requirements

### Proposed production scope

Browse galleries in tiles, masonry, and slideshow modes; open a keyboard-operable lightbox; upload supported still images; generate useful display variants; and expose processing/failed/ready states. Owners manage their galleries, which may be private or public under a defined revocation policy. Search, visual similarity, social features, arbitrary editing, and collaborative albums are separate extensions.

| Requirement | Proposed target |
|---|---|
| Metadata API | p95 below 150 ms within one region at admitted load |
| First visible image | p75 LCP below 2.5 s on a specified mobile/network benchmark |
| Layout stability | p75 CLS below 0.1, with space reserved before image arrival |
| Interaction | p95 navigation response below 100 ms locally, excluding uncached image transfer |
| Publication | Typical supported 5 MB still image ready within 10 s at admitted load |
| Availability | 99.9% for browsing; uploads may queue during transient processing outages |
| Correctness | A ready image references verified durable variants; retries do not duplicate publication/quota charges |
| Accessibility | Modal focus containment/restoration, meaningful controls, controlled autoplay, reduced-motion behavior |

These are proposed engineering objectives, not measurements or certification. “Page load below 200 ms globally” is not a useful promise without device, network, bytes, and percentile boundaries.

## Capacity Estimation

Example production assumptions: 100 million stored originals, one million uploads/day, 100 million delivered images/day, 5 MB per original, and 200 KB average delivered variant. Use decimal units and a 5× traffic peak for this sketch.

| Quantity | Calculation | Planning consequence |
|---|---|---|
| Original storage | 100M × 5 MB = 500 TB | Add variant, index, backup, and replication budgets separately |
| Original ingress | 1M × 5 MB = 5 TB/day | Upload bytes should bypass the metadata API |
| Upload rate | 1M / 86,400 ≈ 11.6/s average, 58/s peak | Admit by bytes and decoded pixels as well as request count |
| Image delivery | 100M / 86,400 ≈ 1,157/s average, 5,787/s peak | CDN reduces origin traffic, not client bandwidth |
| Delivered bytes | 100M × 200 KB = 20 TB/day | Measure real codec/crop distributions before projecting cost |
| Optional eight variant outputs | 1M × 8 = 8M/day | This is an output count, not a requirement for eight independent jobs |

Variant storage cannot be inferred as a fixed percentage of originals. Photo content, dimensions, codec, quality, and crop profile change the result. No provider prices or universal compression ratios are assumed.

### Local Development Scale

There are 50 image IDs, 10–59. Tiles/masonry each mount all 50 image buttons. Slideshow mounts a main image plus 50 eager thumbnail images. There is no pagination, virtualized DOM, owned image cache, upload traffic, or local data service.

## High-Level Architecture

The proposed API authenticates users, returns authorized metadata, and creates durable upload sessions. Browsers upload directly to staging storage. Finalization binds a verified immutable input version and records processing work in a transactional outbox. Workers decode and transform the input, publish a variant manifest, and expose ready images through authorized CDN delivery.

```
┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
│     Browser gallery     │ ──▶ │  Metadata / upload API  │ ──▶ │   PostgreSQL + outbox   │
└─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘

┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
│  Staged object storage  │ ──▶ │    Processing workers   │ ──▶ │      Variants + CDN     │
└─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘
```

The upper row is the metadata/coordination path; the lower row is the image-byte path. An outbox dispatcher feeds the processing queue from committed SQL rows. The browser obtains upload authority from the API and sends bytes to staging storage directly. Display requests travel to the CDN, which retrieves verified variants from private origin storage.

## Core Components / Request Flows

### Browse and display — proposed

1. Authorize the gallery and fetch a bounded metadata page in stable order.
2. Return image ID, generation, alt/caption, oriented dimensions, available variant descriptors, and opaque next cursor.
3. Reserve each layout slot before fetching image bytes. Use square crops for tiles and aspect-preserving variants for masonry/lightbox.
4. Let the browser select a candidate from format-specific responsive sources using an accurate display-size hint.
5. Load the first visible/hero image eagerly, defer offscreen grid images, and keep an error/retry placeholder within the reserved slot.

Metadata requests and image requests have separate timing/error states. A successful gallery API response does not imply every picture decoded. Slideshow navigation can update controls immediately while a new image loads; stale load events are ignored using image ID and request generation.

### Upload and publication — proposed

The upload session reserves quota atomically and binds owner, gallery, request digest, maximum bytes, expiry, and a generated staging key. A repeated owner-scoped request key returns the same session, while changed content under the same key is rejected. The client never chooses another tenant's object key.

After transfer, finalization verifies ownership, actual bytes, and an immutable object version. A mutable staging URL cannot remain a source the worker trusts after verification: capture a storage version or copy the verified input to an immutable private key. The session transition and outbox event commit together; SQL commit alone cannot roll back an earlier object upload.

Workers validate decoded type, pixel/frame limits, orientation, and resource budgets before publishing. Generate a small fixed catalog of output profiles and version their transformations. JPEG/PNG fallback and selected WebP profiles can be required initially; AVIF is an optional optimization based on measured benefit. A slow optional codec should not block all useful display variants.

Write outputs before committing their verified manifest. Publication conditionally checks the current image generation/state so a late worker cannot revive a deleted or superseded image. In that transaction, mark ready, record dimensions/variants, and convert reserved quota to used bytes once. Duplicate delivery sees the completed generation. Orphan input/output objects require delayed cleanup and reconciliation.

### Gallery ordering — proposed

Use keyset pagination over immutable creation order plus unique image ID for the initial product. Bind the opaque cursor to gallery, sort, viewer/access context, and a listing revision policy. For an exact browsing session, reject/reset when membership/order revision changes; immutable published manifests are another option. A cursor alone does not freeze a changing collection.

The frontend keeps a selected image ID, not merely an array offset. Loading the next page, changing layout, or removing an item must not silently select a different photo. Lightbox navigation fetches neighbors through the same listing context and does not wrap from the end of one loaded page to its beginning as if the entire gallery ended there.

## Database Schema

**No local schema exists.** The following is a compact proposed PostgreSQL foundation for a future upload-backed gallery. It is illustrative design DDL, not an existing migration or a requirement for running the frontend. Authorization, outbox claiming, worker leases, object verification, and quota transitions still need application transactions.

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  quota_bytes BIGINT NOT NULL CHECK (quota_bytes >= 0),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  CHECK (used_bytes + reserved_bytes <= quota_bytes)
);

CREATE TABLE galleries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public')),
  listing_revision BIGINT NOT NULL DEFAULT 0 CHECK (listing_revision >= 0),
  access_revision BIGINT NOT NULL DEFAULT 0 CHECK (access_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX galleries_owner_created ON galleries(owner_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_id UUID NOT NULL REFERENCES galleries(id),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'deleted')),
  original_key TEXT,
  input_version TEXT,
  content_sha256 TEXT,
  width INTEGER CHECK (width > 0),
  height INTEGER CHECK (height > 0),
  original_bytes BIGINT CHECK (original_bytes >= 0),
  alt_text TEXT NOT NULL DEFAULT '',
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK (status <> 'ready' OR
    (original_key IS NOT NULL AND input_version IS NOT NULL AND
     width IS NOT NULL AND height IS NOT NULL AND original_bytes IS NOT NULL))
);
CREATE INDEX images_gallery_ready ON images(gallery_id, created_at DESC, id DESC)
  WHERE status = 'ready' AND deleted_at IS NULL;

CREATE TABLE image_variants (
  image_id UUID NOT NULL REFERENCES images(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  transform_version INTEGER NOT NULL CHECK (transform_version > 0),
  profile TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('jpeg', 'png', 'webp', 'avif')),
  object_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  checksum TEXT NOT NULL,
  PRIMARY KEY (image_id, generation, transform_version, profile, format)
);

CREATE TABLE upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  image_id UUID NOT NULL REFERENCES images(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  client_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  staging_key TEXT NOT NULL UNIQUE,
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes > 0),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'ready', 'failed', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, client_key),
  UNIQUE (image_id, generation)
);
CREATE INDEX upload_sessions_expiry ON upload_sessions(expires_at)
  WHERE state = 'pending';

CREATE TABLE outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id UUID NOT NULL REFERENCES images(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (image_id, generation, event_type)
);
CREATE INDEX outbox_pending ON outbox(created_at, id) WHERE published_at IS NULL;
```

Six tables and four explicit secondary indexes are shown. Unique and primary-key constraints create additional indexes. There is no global hash uniqueness: a checksum verifies content, while a durable owner-scoped client key identifies a retry. Cross-user deduplication and reference-counted blob deletion are deliberately deferred. Ready-state constraints cannot prove an object exists in storage; publication/reconciliation must verify that boundary.

## API Design

These routes are **proposed**; the local app only serves `/` and static assets.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/galleries/:id/images` | Authorized metadata page with bounded opaque cursor |
| GET | `/api/v1/images/:id` | Current image state and permitted variant descriptors |
| POST | `/api/v1/galleries/:id/uploads` | Reserve quota and create/replay an upload session |
| POST | `/api/v1/uploads/:id/complete` | Verify uploaded input, record processing work |
| GET | `/api/v1/uploads/:id` | Pending/processing/ready/failed outcome |
| DELETE | `/api/v1/images/:id` | Mark unavailable, advance generation, enqueue cleanup |
| PATCH | `/api/v1/galleries/:id` | Owner metadata/visibility change with expected revision |

Example display metadata separates image identity from one resolution's URL:

```json
{"id":"image-uuid","generation":2,"width":1600,"height":1200,"alt":"A wooded lakeshore","variants":[{"profile":"display-800","format":"webp","width":800,"height":600,"url":"https://images.example.test/image-uuid/g2/display-800.webp"}]}
```

URLs and IDs are illustrative. A private/revocable image requires authorized delivery in addition to metadata access. Responses also carry pagination/status/error fields appropriate to the endpoint; no single image response is a promise that every optional variant exists.

## Key Design Decisions

### CSS layout with an explicit order contract

CSS columns suit the local fixed, unordered collection because they avoid application positioning logic. They still require browser layout and can rebalance after image arrival, resize, or appended content. The visual flow is down each column; it is not row-major masonry. Known slot dimensions reduce shifts but do not turn column balancing into an immutable feed order.

For a chronological/infinite feed, start with row-major tiles or a positioned layout using metadata dimensions and an explicit reading-order policy. A JavaScript layout is not inherently prone to thrashing: batch measurements/writes and avoid measuring intrinsic sizes after every image load. The trade-off is greater implementation and focus/virtualization complexity in exchange for more stable placement.

### Pre-generated profiles versus arbitrary transforms

Generate a finite set of useful variants so repeated requests share cache keys and the first viewer avoids transformation work. Keep aspect-preserving display profiles separate from deliberate square crops. Every candidate within a responsive source set must describe the same crop/aspect ratio. Its width descriptor reports actual encoded width; the client supplies the rendered slot size.

The cost is processing/storage for profiles some users never request. On-demand processing can suit rare dimensions, but needs a strict parameter catalog, shared generation lock, and resource limits. Do not expose unrestricted width/height/quality requests as a cheap CDN API. Codec savings depend on content and quality; measure them rather than promise a universal percentage.

### Publication state instead of a cross-system transaction

SQL cannot atomically roll back object uploads. Choose durable sessions, an outbox, idempotent generation-specific jobs, and conditional manifest publication. The user sees transfer completion followed by processing, then ready or a recoverable failure. This is more state than a synchronous upload endpoint, but it explains worker failure and lost responses without holding a database transaction open during decoding.

Content hashes do not replace authorization or request idempotency. Two uploads of identical bytes may intentionally be separate gallery entries. Global deduplication needs ownership/reference tracking and a confidentiality model; generated per-image keys are the initial choice.

## Consistency and Idempotency

Upload initiation reserves quota and creates records in one transaction keyed by owner plus client key. Finalization verifies the immutable input and records the pending job in the same transaction as the state transition. The dispatcher retries publication, and the worker checks image generation and terminal state before publishing a manifest or changing quota.

If storage succeeds but SQL fails, outputs are unreferenced and eligible for later cleanup. If SQL commits but an ACK is lost, the client polls/retries the same session to recover its result. If deletion races processing, advancing the generation/status prevents late publication; asynchronous deletion retries remove the original and all generation outputs. Cleanup must wait beyond signed-upload and worker lease horizons to avoid deleting still-owned work.

Listing revisions provide an explicit change/reset boundary for exact browsing sessions. Permission and deletion are checked under current authority even if a browsing session uses older order metadata. A cached cursor is not a permission grant, and invalidating Redis only after returning stale private content is too late.

## Security / Auth

The proposal validates sessions on metadata, upload, status, and mutation routes. Signed upload authority binds a server-generated object key, byte constraints where supported, and a short expiry. The worker verifies actual encoded/decoded content, strips sensitive metadata from published variants, normalizes orientation, and enforces resource budgets. Original files remain private unless explicitly exposed under an appropriate download policy.

For revocable galleries, authorize CDN requests before cache hits, keep origin objects private, and issue short-lived capabilities with an explicit maximum revocation delay, for example 60 seconds. Browser responses use a revalidation/no-store policy consistent with that promise; internal edge caching of bytes does not bypass authorization. New capabilities stop after a privacy change. Previously downloaded bytes cannot be recalled.

Long-lived publicly cacheable immutable URLs are appropriate only when the product accepts persistent public copies. Do not give revocable private media a one-year public browser cache policy and imply that a later database flag or CDN purge can undo it. No auth, sharing, quotas, or signed delivery is implemented locally.

## Observability

Production measurements should distinguish metadata latency, first visible image decode, delivered bytes, layout shift, lightbox navigation, upload transfer, queue age, processing duration, publication failures, and orphan/quota reconciliation. Avoid high-cardinality image labels or logging signed URLs and private EXIF. Metadata API health, object delivery, and worker backlog have different failure meanings.

The local project has no Pino, Prometheus, health endpoint, monitoring client, or custom image error handler. Vite serving the HTML does not prove Picsum is reachable. Existing screenshot scripts wait for elements and fixed delays rather than asserting successful decoding or accessibility.

## Failure Handling

| Failure | Proposed behavior | Current local behavior |
|---|---|---|
| One image fails | Reserved placeholder, retry, usable navigation | Browser's native broken-image/alt behavior |
| Slow next image | Loading status, ignore stale decode, bounded adjacent preload | Immediately changes src with no custom state |
| Upload response lost | Recover the durable session using the same key | Upload absent |
| Worker fails | Retry bounded job, preserve failed/processing state | Worker absent |
| Metadata page fails | Retain loaded items and show a next-page retry | Metadata paging absent |
| Listing/order changes | Refresh/reset explicitly, preserve selected ID where valid | Fixed list only |
| Privacy changes | Block new delivery capabilities and honor bounded expiry | Sharing absent |

## Scalability Considerations

The local 50-image manifest is intentionally small. Browser lazy loading is sufficient to demonstrate deferred fetches, but not memory/windowing for a million-image feed. Responsive selection, reserved dimensions, bounded decode/prefetch queues, and stable selection should precede a complex virtualized masonry engine.

At service scale, direct uploads separate ingress bytes from metadata CPU. Workers scale by queue age and pixel/codec cost, not request count alone. CDN hit rates reduce origin work but do not remove client egress. Partition metadata by gallery/owner when needed, bound listing pages, and avoid storing complete signed-URL lists in broadly shared caches.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Local masonry | CSS columns | Positioned masonry | Small fixed collection accepts column-first reflow |
| Long ordered browsing | Row-major layout or explicit positions | Infinite balanced columns | Keep order and scroll anchors understandable |
| Image delivery | Finite versioned profiles | Arbitrary per-request transforms | Bound work and share cache keys |
| Publication | Session/outbox/conditional manifest | One presumed SQL+storage transaction | Recover partial success across systems |
| Idempotency | Owner-scoped session key | Content hash alone | A retry and a duplicate photo are different intents |
| Revocable media | Authorized cache hits, short capabilities | One-year public browser cache | Enforce an honest revocation window |
| Selection | Stable image ID | Global array index | Survive pagination and list changes |

## Implementation Notes

### Actual local architecture

```
┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
│   React gallery views   │ ──▶ │   Browser image loader  │ ──▶ │      picsum.photos      │
└─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘
```

The SPA uses React 19, TanStack Router, Zustand, Tailwind CSS 3, and Vite 6. [main.tsx](./frontend/src/main.tsx) mounts StrictMode and one generated `/` route. The [root layout](./frontend/src/routes/__root.tsx) provides a header, main content, and an inline Lightbox sibling. The [index route](./frontend/src/routes/index.tsx) mounts exactly one view based on `activeTab`.

### Components and state

| Component | Source-backed behavior |
|---|---|
| [GalleryTabs](./frontend/src/components/gallery/GalleryTabs.tsx) | Three normal buttons with selected styling, no tablist/tab semantics or arrow-key tab model |
| [TilesGrid](./frontend/src/components/gallery/TilesGrid.tsx) | Two columns below md, three at md, four at lg, five at xl; square buttons, fixed 300×300 sources, lazy loading |
| [MasonryGrid](./frontend/src/components/gallery/MasonryGrid.tsx) | Two columns below md, three at md, four at lg; fixed width-400 sources with six synthetic heights; lazy loading |
| [Slideshow](./frontend/src/components/gallery/Slideshow.tsx) | In-page 16:9 area, 1200×675 main source, 50 eager 80×56 thumbnails, arrows, counter, three-second autoplay |
| [Lightbox](./frontend/src/components/gallery/Lightbox.tsx) | Fixed z-50 inline overlay, 1920×1080 source, arrows/counter, Escape/backdrop close, body overflow toggle |
| [galleryStore](./frontend/src/stores/galleryStore.ts) | Tiles default, lightbox ID or null, slide index zero, totalImages hardcoded 50; no persistence or validation |

Slideshow's `isPlaying` is component-local state, not in Zustand. Unmounting clears its interval; returning retains the store index but starts paused. Manual navigation does not stop an active interval. There is no configurable interval, focus/hover/visibility pause, reduced-motion handling, image preloader, or slideshow-main-image lightbox action.

The store's next/previous actions wrap using its independent constant 50. `setSlideshowIndex` and `openLightbox` accept invalid indices/IDs without checks. Lightbox navigation uses `imageIds.length`, so editing only the manifest can produce inconsistent behavior between the two viewers. Lightbox and slideshow selections are independent. Whole-store subscriptions in tabs, slideshow, and lightbox are not selective; grids subscribe only to the open action. No React.memo or subscribeWithSelector middleware is used.

### Image loading and layout

[picsum.ts](./frontend/src/utils/picsum.ts) constructs `https://picsum.photos/id/{id}/{width}/{height}` URLs. The provider documents ID-based images and separate metadata endpoints, but the app does not fetch metadata or verify the hardcoded range's availability. [Picsum documentation](https://picsum.photos/).

`getAspectRatio` selects a height/width factor from 0.75, 1, 1.25, 1.5, 0.8, and 1.2 by ID modulo six. At width 400, the requested heights are 300, 400, 500, 600, 320, and 480. These are synthetic layout proportions, not source-photo dimensions. The random URL and info URL helpers are unused.

There is no `srcset`, `sizes`, format negotiation, eager hero priority hint, IntersectionObserver, blur placeholder, decode handler, load/error state, cache manager, or adjacent-image preloading. Slideshow thumbnails are eager; the main and lightbox requests are distinct larger URLs, so thumbnail downloads are not full-image preloading. Browser HTTP caching may reuse identical URLs, but the app does not control provider headers or guarantee instant tab switches.

Tiles reserve square slots and slideshow reserves a 16:9 area. Masonry images have no width/height attributes or CSS aspect ratio despite knowing the requested sizes, so their initially unknown height can cause reflow as they load. Explicit dimensions are the browser mechanism for reserving space; a blurred placeholder alone would not fix geometry. [MDN image element reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img).

### Keyboard, focus, and overlay boundaries

Lightbox has labeled arrow/close buttons and a window key handler, but no dialog role, modal state, focus entry/trap/return, inert background, or portal. It changes body overflow to hidden and clears it on close/cleanup instead of restoring an earlier inline value. Clicking the image/arrows stops backdrop propagation; the close button can also bubble to the backdrop, calling the idempotent close action twice.

Slideshow arrows and Space are also window-wide, without focused-control checks. If slideshow and lightbox states coexist, both arrow handlers can run. The absence of modal focus containment lets keyboard users reach background view controls. Generic “Image ID” alt text identifies an item but does not describe its content.

The proposed accessible version should implement the modal's focus/inert behavior and carousel's stop controls, including pause on focus/hover and explicit restart. These are not achieved merely by adding an Escape listener. [WAI modal pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [WAI carousel pattern](https://www.w3.org/WAI/ARIA/apg/patterns/carousel/).

A portal is an optional placement technique, not a focus manager or guaranteed top layer. React context and event propagation remain associated with the React parent tree even when the DOM node moves. The earlier claim that a portal loses React context was incorrect. [React portal reference](https://react.dev/reference/react-dom/createPortal).

### Operational patterns, simplifications, and omissions

No backend patterns are implemented: there are no circuit breakers, rate limits, server logs, metrics, health checks, SQL, object storage, sessions, or upload jobs. Native CSS layout and native image lazy loading are the actual techniques demonstrated. The production pipeline, authorization, responsive candidates, metadata paging, virtualized lists, and upload state machine are all omitted locally.

[package.json](./frontend/package.json) offers dev/build/preview/lint/type-check scripts. Build uses `tsc -b` and Vite. The standalone type-check script uses `tsc --noEmit` against a files-empty reference config, so it does not check the referenced app project; use an explicit project check or build mode for that purpose. No ESLint config exists in the project/repository ancestor chain. The HTML also references `/vite.svg`, but no public asset with that name is checked in.

There is no project test package. The repository [screenshot configuration](../scripts/screenshot-configs/gallery.json) switches views without validating every decoded image. The 2026-09-10 documentation review read all source and used six isolated mocked source checks for IDs/heights, count drift, image attributes, simultaneous keyboard handlers, scroll restoration, and the TypeScript reference configuration. It did not start a server, download images, run a build, or measure runtime performance.
