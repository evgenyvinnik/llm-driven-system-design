# Apple TV+ architecture

## System Overview

Design a subscription video-on-demand service for discovering movies and series, starting protected playback, and resuming across household devices. The main learning problems are separating media delivery from account APIs, publishing complete media revisions, making quality decisions under uncertain bandwidth, and preserving user intent when progress updates race.

**Scope of this document:** the production sections describe a proposed system, not Apple's private architecture or a deployed implementation. The repository implements a catalog/account application and a timer-based player simulation. Its actual schema is reproduced below; the final [Implementation Notes](#implementation-notes) map the proposal to source and explain limitations.

## Requirements

### Functional requirements — proposed production service

- Discover available movies/series, search, inspect episodes and maintain profile-specific watchlists.
- Publish validated, encoded media with audio and caption tracks; remove unavailable titles safely.
- Authorize playback against current account, profile, territory, device and rights policy.
- Deliver adaptive video with accessible controls and an explicit unsupported-device path.
- Save progress, resume on another device, and keep completion events separate from position.
- Support audited administration and a real subscription provider integration.

Offline licensed playback is a later platform-specific extension. It needs both downloadable encrypted bytes and a supported persistent license lifecycle. Ordinary browser caching alone does not satisfy that contract.

### Non-functional requirements — design targets, not measurements

| Concern | Proposed target and scope |
|---------|---------------------------|
| Playback start | p95 below 2 seconds on a defined supported-device/network cohort |
| Authorization | p99 below 200 ms within the owning region, excluding media download |
| Availability | 99.99% playback authorization; existing buffered playback degrades independently |
| Resume | Acknowledged progress survives an API restart; handoff normally within 15 seconds |
| Experience | Measure rebuffer time, failed starts, quality changes and accessibility by device class |
| Publication | No active revision points to missing or unvalidated mandatory media |

First-frame time includes manifest, license, first segment, decode and buffering. A fast playback-info response alone cannot establish the first target. Rights denials are distinguished from service failures.

## Capacity Estimation

Assume 10 million daily viewers watching two hours each, with 2 million concurrent viewers at peak. These are planning inputs, not reported Apple figures.

| Estimate | Calculation | Implication |
|----------|-------------|-------------|
| Average concurrency | 20 million viewing hours / 24 ≈ 833,000 | Delivery is sustained, not only a launch spike |
| Peak media throughput | 2 million × 6 Mb/s = 12 Tb/s | Send media from CDN edges, not Express |
| Video segment requests | 2 million / 6 seconds ≈ 333,000/s | Separate audio adds requests; manifests/licenses add startup work |
| Progress traffic | 2 million / 15 seconds ≈ 133,000 updates/s | Coalesce writes and partition by profile after measuring |
| Daily media bytes | 20 million hours × 3,600 × 6 Mb/s / 8 ≈ 54 PB | Delivery cost dominates small JSON payloads |
| Encoded library | 50,000 hours × 3,600 × 40 Mb/s / 8 ≈ 900 TB | Aggregate ladder estimate, before masters and replicas |

A six-second segment at 6 Mb/s is roughly 4.5 MB. Shortening segments improves opportunities to switch quality but increases request overhead. Measure the trade-off against startup and rebuffering objectives; VOD does not need live-edge latency machinery.

### Local Development Scale

One React development server, one Express process, PostgreSQL, Valkey and MinIO are sufficient for the seeded demo. Additional API instances demonstrate shared sessions and independent process state, not validated streaming throughput. No benchmark or resource ceiling has been measured.

## High-Level Architecture

Proposed production topology; media and control requests take different paths.

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

Domain APIs include catalog/profile services, playback authorization, progress and subscription state. A separate license service uses a protected key service. Neither clear content keys nor user-specific license responses belong in a shared public CDN cache. Workers receive source revisions through an ingestion service and publish versioned objects to origin.

## Core Components / Request Flows

### Ingestion and publication — proposed

1. Create a draft source revision and upload session, with bounded size and an expected checksum.
2. Upload the master to private storage; validate format, duration, rights metadata and required tracks.
3. Commit the job record and dispatch intent together, using an outbox so a queue outage does not lose work.
4. Workers claim jobs identified by source revision and encoding profile. Write outputs to a new immutable namespace.
5. Validate every mandatory rendition and manifest reference, including object existence, track timing and decode compatibility.
6. Atomically change the catalog's active revision pointer only after the required set passes validation.
7. Deliver a publication event to caches/search. Retry propagation, and track its revision and lag.

Duplicate worker delivery is expected. An existing validated output can satisfy a repeated job; a partial upload cannot. Publication should use a revision check so a late worker cannot replace a newer edit. Failed optional high-quality outputs may leave a valid baseline release if product policy explicitly allows that.

Removal blocks new authorization immediately at the authority. Edge credentials and existing licenses need a defined expiry/revocation policy; cache invalidation alone does not revoke already delivered media.

### Playback start and delivery — proposed

The client creates a playback session for a specific title, profile and device capability set. The server validates account/profile ownership, active rights and subscription, then returns a media revision, bounded authorization credentials and the license endpoint. Credential renewal uses the same playback session, not a new billable viewing event.

The client fetches manifests and encrypted media through the CDN, obtains a license through the protected license path, and starts conservatively. A media engine owns buffer, decoder and quality adaptation. Application state reflects actual events such as playing, waiting and ended; a button click is only a request to play.

Cache immutable media by asset revision and rendition. Validate edge authorization before serving cached protected bytes, while keeping authorized viewers of the same revision able to share cached objects. Apply the CDN's supported cache-key/authentication model explicitly; stripping a token without checking it would expose media.

HLS supports multiple renditions and both MPEG-2 transport-stream and fragmented MP4 segments. A DASH comparison must consider platform support and packaging, rather than assuming HLS inherently uses an inefficient container. [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216)

For Apple-platform protection, integrate the documented FairPlay client and key-server workflow. Use its SDK and approved deployment credentials rather than inventing cryptographic message formats. Other target platforms need their supported protection systems. [Apple FairPlay Streaming](https://developer.apple.com/streaming/fps/)

### Progress, completion and discovery — proposed

Use an explicit profile/title/playback-session identity and increasing sequence number within each session. A retry repeats the same sequence and payload. The server assigns a durable revision to each accepted update and returns the accepted position/revision, including on replay.

Cross-device ordering is a product policy. This design uses an explicit handoff to establish a new active session generation. Older sessions can retain analytics events but cannot silently overwrite its resume position. An offline return offers a choice when its base revision is stale. Taking the maximum position would lose intentional rewinds, while arbitrary client wall-clock order is vulnerable to skew.

Completion is a separate event with a deduplication key; a resume pointer may later move backward on a rewatch. Commit authoritative progress and the completion/outbox record consistently. A queue projection builds recommendations and aggregate history, with observable lag. The client should not need a live push channel simply to resume; it can fetch the current revision when playback starts.

### Frontend responsibilities — proposed

Use route state for content selection and browse filters, a request cache for remote data, a small store for authenticated context and player controls, and component state for transient menus. Scope personal data by account and profile generation. On a switch, cancel pending requests, clear personal views and ignore late responses from the previous context.

Load critical title/artwork data first, fetch independent home rows concurrently, and progressively load bounded shelves. Virtualize large catalogs with focus-aware overscan. Avoid unmounting the focused card, a player or an open menu just because a viewport calculation changes.

The player owns its media engine lifecycle outside high-frequency React rendering. Keep the latest position in a stable reference for a fixed save scheduler. Save after meaningful seeks/pauses and on handoff; navigation/unload delivery remains best effort, so periodic acknowledged saves limit loss.

## Database Schema

### Current local schema

The following is the actual [backend/src/db/init.sql](./backend/src/db/init.sql). It is a fresh-schema initializer, not a production migration plan. Several tables are scaffolding; their presence does not imply connected endpoints. SQL constraints enforce only what is written here, not all the production invariants above.

```sql
-- Apple TV+ Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  subscription_tier VARCHAR(50) DEFAULT 'free' CHECK (subscription_tier IN ('free', 'monthly', 'yearly')),
  subscription_expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User profiles (multiple profiles per user for family sharing)
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  avatar_url VARCHAR(500),
  is_kids BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_profiles_user ON user_profiles(user_id);

-- User devices
CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  device_name VARCHAR(255),
  device_type VARCHAR(50),
  active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

CREATE INDEX idx_devices_user ON user_devices(user_id);

-- Content catalog
CREATE TABLE content (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  duration INTEGER NOT NULL, -- seconds
  release_date DATE,
  content_type VARCHAR(20) CHECK (content_type IN ('movie', 'series', 'episode')),
  series_id UUID REFERENCES content(id) ON DELETE SET NULL,
  season_number INTEGER,
  episode_number INTEGER,
  rating VARCHAR(10),
  genres TEXT[],
  thumbnail_url VARCHAR(500),
  banner_url VARCHAR(500),
  master_resolution VARCHAR(20),
  hdr_format VARCHAR(20),
  status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'disabled')),
  featured BOOLEAN DEFAULT false,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_content_type ON content(content_type);
CREATE INDEX idx_content_series ON content(series_id, season_number, episode_number);
CREATE INDEX idx_content_featured ON content(featured) WHERE featured = true;
CREATE INDEX idx_content_status ON content(status);

-- Encoded variants (different quality/codec versions)
CREATE TABLE encoded_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  resolution INTEGER NOT NULL,
  codec VARCHAR(20) NOT NULL,
  hdr BOOLEAN DEFAULT false,
  bitrate INTEGER NOT NULL, -- kbps
  file_path VARCHAR(500),
  file_size BIGINT,
  encoding_time INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_variants_content ON encoded_variants(content_id);

-- Video segments (HLS chunks)
CREATE TABLE video_segments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES encoded_variants(id) ON DELETE CASCADE,
  segment_number INTEGER NOT NULL,
  duration DECIMAL NOT NULL,
  segment_url VARCHAR(500),
  byte_size INTEGER
);

CREATE INDEX idx_segments_content ON video_segments(content_id, variant_id);

-- Audio tracks
CREATE TABLE audio_tracks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  codec VARCHAR(20),
  channels INTEGER DEFAULT 2,
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audio_content ON audio_tracks(content_id);

-- Subtitles
CREATE TABLE subtitles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  type VARCHAR(20) DEFAULT 'subtitle' CHECK (type IN ('caption', 'subtitle')),
  file_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_subtitles_content ON subtitles(content_id);

-- Watch progress
CREATE TABLE watch_progress (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, -- seconds
  duration INTEGER NOT NULL,
  completed BOOLEAN DEFAULT false,
  client_timestamp BIGINT, -- Client-side timestamp for last-write-wins conflict resolution
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_progress_profile ON watch_progress(profile_id, updated_at DESC);

-- Watch history (completed views)
CREATE TABLE watch_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  watched_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_history_profile ON watch_history(profile_id, watched_at DESC);

-- Downloads
CREATE TABLE downloads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  device_id VARCHAR(255) NOT NULL,
  quality VARCHAR(20),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'downloading', 'completed', 'expired')),
  license_expires TIMESTAMP,
  downloaded_at TIMESTAMP,
  last_played TIMESTAMP
);

CREATE INDEX idx_downloads_user ON downloads(user_id);
CREATE INDEX idx_downloads_expires ON downloads(license_expires);

-- Watchlist (My List)
CREATE TABLE watchlist (
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_watchlist_profile ON watchlist(profile_id, added_at DESC);

-- Content ratings by users
CREATE TABLE content_ratings (
  profile_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content_id UUID REFERENCES content(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  rated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE INDEX idx_ratings_content ON content_ratings(content_id);

-- Audit log for security-relevant events
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id VARCHAR(255),
  content_id UUID REFERENCES content(id) ON DELETE SET NULL,
  ip_address VARCHAR(45),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_event ON audit_log(event, created_at DESC);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
```

### Production changes required

| Area | Proposed addition or invariant | Missing locally |
|------|--------------------------------|-----------------|
| Publication | Source/asset revisions, job uniqueness, validation state and active revision pointer | Ready is a freely editable metadata status |
| Profile ownership | Account/profile association checked for every personal request | Separate foreign keys do not prove the profile belongs to user_id |
| Media | Unique revision/rendition/segment identity and immutable object checksum | Segment metadata is neither populated nor read by playback |
| Playback sessions | Unique session, entitlement snapshot/version, bounded device lease | Unsigned token and process-local count map |
| Progress | Session generation/sequence, accepted revision and valid content-duration bounds | Client timestamps and caller-supplied duration |
| Completion | Unique event ID with durable publication intent | Random history IDs permit duplicate completions |
| Subscription | Provider subscription/event IDs and ordered state transitions | Tier/expiry assignments, no billing record |
| Audit/retention | Restricted append path, retention policy and monitored export | audit_log table has no writer |

Catalog indexes support type, status, featured and series lookup. There is no full-text index or genre GIN index. Progress/history have profile-plus-time indexes. Production pagination needs deterministic tie-breakers and bounded limits; the current API commonly uses raw offset/limit values.

## API Design

### Existing routes

All paths below are implemented handlers, with the qualifications shown. See [routes](./backend/src/routes/) and [API client](./frontend/src/services/api.ts).

| Method | Path | Current behavior |
|--------|------|------------------|
| POST | /api/auth/register, /login, /logout | Account/session operations |
| GET | /api/auth/me | Session user fields plus owned profiles |
| POST | /api/auth/profile/:id/select | Select an owned profile in the session |
| POST / DELETE | /api/auth/profiles, /api/auth/profiles/:id | Create/delete profile; count limits race |
| GET | /api/content | Public ready non-episode catalog; type/genre/search/limit/offset |
| GET | /api/content/featured, /:id, /:id/seasons, /meta/genres | Featured/details/episodes/genres; detail restrictions differ |
| POST | /api/content/:id/view | Public counter increment, not verified playback |
| GET | /api/stream/:contentId/playback | Paid-session check and simulated playback metadata |
| GET | /api/stream/:contentId/master.m3u8 | Generated playlist text |
| GET | /api/stream/:contentId/variant/:variantId.m3u8 | Playlist derived from duration, not actual variant assets |
| POST | /api/stream/:contentId/playback/end | Adjust process-local tracking, no session ownership |
| GET / POST | /api/watch/progress/:contentId | Profile progress read/upsert |
| GET | /api/watch/progress, /continue, /history | Personal SQL reads, no response cache |
| POST | /api/watch/progress/batch | Shadowed by earlier /progress/:contentId handler |
| DELETE | /api/watch/history | Separately delete history and progress |
| GET / POST / DELETE | /api/watchlist, /:contentId, /:contentId | Read/add/remove membership |
| GET | /api/watchlist/check/:contentId | Individual membership check |
| GET | /api/recommendations | Session-aware SQL sections; no personalized cache |
| GET | /api/recommendations/trending, /new-releases, /genre/:genre | Public recommendation lists |
| POST / GET | /api/recommendations/rate/:contentId, /rating/:contentId | Store/read profile rating |
| GET | /api/subscription/plans, /status | Demo plans and current SQL subscription state |
| POST | /api/subscription/subscribe, /cancel | Simulated assignment; cancellation is message-only |
| GET | /api/admin/stats, /users, /content, /analytics/views | Admin reads |
| POST / PUT / DELETE | /api/admin/content, /:id, /:id | Admin metadata CRUD, no file ingestion |
| POST | /api/admin/content/:id/feature | Toggle featured flag |

Streaming also exposes audio/subtitle playlists and segment paths. These are scaffolding, not an upload, DRM or download API. There is no standalone `/api/search`, `/api/profiles`, DRM license or content-publish endpoint.

For example, the existing progress client sends:

```json
{"position":120,"duration":7200}
```

The browser omits the optional client timestamp. The single-update response can report success/wasUpdated/completed; the Redis stale shortcut returns a different skipped/reason shape. A production contract should always return the authoritative accepted revision and position, rather than making clients infer acceptance from a generic success flag.

### Proposed additional contracts

| Operation | Contract |
|-----------|----------|
| Create playback session | Bind account/profile/title revision/device capability; return bounded media and license access |
| Progress update | Include session generation, sequence and base revision; return accepted state or conflict |
| Publish revision | Require expected draft revision and validated asset set; replay the same durable operation |
| Provider webhook | Verify provider identity and deduplicate event ID before subscription transition |

These are design extensions, not callable local endpoints.

## Key Design Decisions

### Encode before publication

Precompute a bounded rendition ladder and validate an entire release before switching its active pointer. This lets every viewer fetch the same immutable objects, enables CDN reuse and keeps expensive encoding out of startup. Encoding on the first request might reduce work for unpopular titles but creates unpredictable first-view latency and a resource spike on releases. Eager encoding costs storage and processing for unwatched media; per-title analysis and baseline-first releases can reduce that cost without publishing missing mandatory assets.

### Keep media delivery separate from entitlement

Authorize a playback session centrally and validate bounded credentials at delivery boundaries. Sending every segment through the account API would put hundreds of thousands of requests and terabits of media on a database-dependent service. Making an entire media bucket public would avoid that bottleneck but bypass content access policy. The chosen split requires credential renewal, rights-expiry handling, private origin configuration and a stated revocation window. Existing licenses/buffered bytes cannot be recalled instantly.

### Preserve playback intent rather than trusting the largest timestamp

Within-session sequences and explicit handoff generations make retries and rewinds understandable. Simple last-write-wins by client clock lets a fast device suppress later valid updates; maximum-position merging loses rewinds. Explicit conflict policy adds state and occasionally a user choice. That is preferable to claiming there is one objectively correct resume position when two people watch the same profile on different devices.

## Consistency and Idempotency

Production metadata publication, subscription transitions and progress acceptance need durable receipts scoped by actor, operation and payload. A Redis response cache can accelerate replay but must not be the only evidence of a committed SQL write. Authentication/authorization precedes replay; an expired credential must not reuse a cached success to bypass access checks.

Use unique constraints for operation/event identity, conditional state transitions, and outbox records committed with their source change. Queue delivery can repeat. Workers apply a given event once to each projection and checkpoint only after its effects commit. These give repeatable effects within defined boundaries, not universal exactly-once execution across a billing provider, queue, SQL and browser.

The local middleware does not provide those guarantees; its scope and failure windows are detailed below.

## Security / Auth

Production enforcement belongs on the server for account/profile ownership, kids restrictions, subscription rights and administrative actions. Revalidate selected profile ownership rather than trusting a stale session field. Regenerate sessions at login, revoke changed roles/entitlements deliberately, bound login attempts and validate request bodies.

Protect media and license credentials from logs, referrers and shared caches. Use purpose-bound, expiring credentials and a supported DRM implementation. A base64 JSON object provides neither signature validation nor content protection. Offline access needs device-supported license storage and explicit expiry; a database download row is insufficient.

Catalog policy must cover direct details, playback, history and recommendation results consistently. Hiding adult titles on one home row cannot establish parental controls. Proposed administrative publication also validates rights and assets; ordinary metadata editing must not bypass these gates.

## Observability

Production quality telemetry starts at the client: failed starts, time to first rendered frame, rebuffer ratio, decode failures, selected rendition and abandonment. Report bounded, sampled dimensions such as device class and region, with a playback session ID for correlation outside metric labels.

Backend metrics track authorization availability, queue age, failed publication, progress acceptance/conflicts, outbox lag and subscription webhook delay. CDN hit rate, origin throughput and media errors come from actual delivery telemetry. Compare player success with authorization success to catch empty or corrupt media even when APIs return 200.

Local `/metrics` exposes HTTP and demo counters; it does not collect first-frame or real CDN data. `/health`, `/health/live` and `/health/ready` are API diagnostics, not proof that any title can play.

## Failure Handling

| Failure | Proposed response |
|---------|-------------------|
| Encoding worker dies | Reclaim its lease; reuse validated immutable outputs and retry unfinished work |
| Queue publish fails after draft commit | Outbox dispatcher retries; draft remains visibly unready |
| CDN edge fails | Bounded retry and alternate healthy delivery path; preserve playback session |
| License service unavailable | Explain inability to start; never return a fake successful license |
| Progress service unavailable | Continue local playback, retain bounded retryable state and show save uncertainty |
| Device sends stale progress | Return current accepted state/conflict; do not silently regress resume |
| Subscription event repeats | Deduplicate provider event and enforce event/state ordering |
| Rights withdrawn | Deny new authorization; expire/revoke existing access according to documented policy |

Circuit breakers limit repeated calls to unhealthy dependencies. They do not cancel timed-out work, persist retry jobs, or manufacture usable video as a fallback. Isolate encoding resources from latency-sensitive authorization and progress APIs.

## Scalability Considerations

CDN egress and cache misses dominate delivery. Use immutable revision URLs, origin shields and release prewarming where measurements justify the cost. Maintain compatible renditions so lower bandwidth or older devices can play without requesting unsupported codecs.

Progress is the first likely high-volume write bottleneck. Coalesce each active session's position updates, separate history events, and partition by profile while preserving its ordering/ownership. Add admission control and backpressure before accumulating an unbounded event backlog.

Catalog reads can use caches/replicas with versioned invalidation. Entitlement and publication decisions need current authoritative state. Search and recommendations can be asynchronous projections with a defined stale-result policy and a final playback authorization check. A multi-region plan must choose ownership and failover semantics rather than assuming an extra replica preserves all write invariants.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Media preparation | Validated release before publish | Encode on first play | Predictable startup and reusable objects |
| Delivery | Private origin + authorized CDN | API proxy for every segment | Separate media scale from account storage |
| Playback adaptation | Established media engine | Application-written ABR loop | Device and buffer behavior require specialized handling |
| Resume conflicts | Sequences + handoff generation | Unbounded client-clock LWW | Preserve rewinds and reject superseded sessions |
| Derived discovery | Eventual projections | Synchronous ranking in playback | Keep recommendation failures off the playback path |
| Mutation replay | Durable scoped receipts | Redis-only cached responses | Recover after SQL commit and cache loss |

## Implementation Notes

### Actual runtime and feature map

[backend/src/index.ts](./backend/src/index.ts) mounts all domains in one Express process. PostgreSQL and Valkey are shared; MinIO is initialized but no media read/write flow uses it. [Compose](./docker-compose.yml) has no queue, worker, CDN, proxy or observability server. API development uses 3001, Vite 5173; start defaults to 3000. Configuration and both fresh seed alternatives are explained in [README](./README.md).

[content.ts](./backend/src/routes/content.ts) uses PostgreSQL filters and ILIKE search. Public list requires ready non-episodes, but details and episode lists do not enforce the same readiness or kids policy. Public view increments are unauthenticated and have no playback caller in the frontend. Content creation sets processing; admin updates can set ready directly without any assets. Deleting a series sets child series_id to null, leaving orphaned episodes.

[recommendations.ts](./backend/src/routes/recommendations.ts) combines featured/trending/new releases, movies/series and history-derived genres. Trending means accumulated view_count, not recent velocity; new means the last 90 days. Main personalized sections query SQL and ignore the requested overall limit. Ratings are stored separately and unused in scoring. Continue Watching can appear twice on home: its explicit row and a recommendation section.

Current caches are featured (300 seconds), genre metadata (one hour), public trending/new releases (900 seconds) and admin stats (300 seconds). Trending/new-release keys omit the requested limit. Admin metadata changes clear only selected catalog keys, leaving other cached lists/statistics stale. Continue Watching, individual progress and main recommendations are not cached. Cache read errors commonly return 500 rather than falling back to SQL.

### Player and media scaffolding

[VideoPlayer.tsx](./frontend/src/components/VideoPlayer.tsx) calls usePlaybackSimulation, incrementing time every second. [VideoOverlay](./frontend/src/components/player/VideoOverlay.tsx) renders an image. [playerStore](./frontend/src/stores/playerStore.ts) loads playback metadata and then progress serially; it never attaches the manifest to a media element. Playback-info returns only id/title/duration/status, so the player also lacks an image source, variants and track metadata; its quality menu is empty. There is no HLS.js, native video, DRM exchange, ABR, actual buffer measurement or download manager.

The quality menu only assigns a variant in state; there is no Auto option. Volume/mute are state changes, subtitles have an inert button, and audio/subtitle store actions are uncalled. The progress bar shows a simulated full buffer and handles mouse input, without keyboard slider semantics. Several icon buttons lack accessible names, controls can hide while focused, keyboard handling does not exclude inputs, and fullscreen state does not subscribe to external fullscreen changes.

The save interval is recreated on every currentTime change. During steady one-second playback it may never reach ten seconds. Back and unmount attempt saves, but the parent watch route resets the shared player during cleanup; no durable handoff, visibility/unload sender or offline queue exists. End-of-duration can advance beyond the server's accepted bound. No playback-end request is sent. These are source findings, not runtime reproductions.

[streaming.ts](./backend/src/routes/streaming.ts) returns an unsigned base64 playbackToken that the browser and streaming authorization never consume. Cookie authentication and a stored subscription tier/expiry gate routes. Playback-info checks content ready but not selected-profile ownership, kids policy, device registration or concurrency.

Master playlists query metadata and construct fixed codec strings. Variant/audio playlists use content duration without verifying the requested track belongs to that title; lower routes do not repeat all readiness checks. video_segments is unused. Video segments return an empty Buffer, audio segments return an empty string, and captions are a fixed two-cue sample. Segment request counters use Redis keys without expiry.

The manifest builder can reference absent audio/subtitle groups and mark multiple English tracks DEFAULT=YES. Both contradict HLS group rules; codec and bandwidth metadata also need validation against actual media. [RFC 8216, rendition groups and alternative renditions](https://www.rfc-editor.org/rfc/rfc8216#section-4.3.4.1.1)

### Accounts, profiles and subscription behavior

[auth.ts](./backend/src/routes/auth.ts) hashes passwords with bcryptjs and stores session user/profile fields in Redis-backed express-session. Registration creates user and default profile separately. Login does not regenerate the session or clear a previously selected profile. `/me` reads user role/tier from the session, not a fresh users row. Profile selection verifies ownership once; subsequent personal routes often trust the stored profileId without repeating that check. Separate account/profile foreign keys do not enforce their association.

Client persistence stores only currentProfile under appletv-auth. Restored auth does not reconcile it with server selection. Logout clears the auth store but not content/player stores or pending requests; profile changes have no request-generation guards. New profile responses use isKids while the frontend model reads is_kids. The count-before-create/delete checks can race beyond six profiles or below one.

[subscription.ts](./backend/src/routes/subscription.ts) exposes illustrative prices and features. Subscribe assigns monthly/yearly expiry from now and updates only the current session; there is no payment. Cancel changes nothing. The middleware checks time against the stored expiry on each protected call, so sessions do expire with time, but other sessions do not learn intervening database changes until refreshed/login.

Kids filtering exists on selected recommendation queries, not public catalog/details or playback. No rate limiter, device lease, persistent license or download endpoints are connected. SQL user_devices/downloads and many audit event names are unused scaffolding.

### Progress and replay limitations

[watchProgress.ts](./backend/src/routes/watchProgress.ts) conditionally upserts position/duration/completed when client_timestamp increases. It always advances updated_at, even on a stale SQL update; equality can report was_updated even when position was unchanged. The browser sends no clientTimestamp, so normal ordering is server arrival time. Caller-provided future timestamps are unbounded and can suppress subsequent changes.

Completion uses position / supplied duration > 0.9; Continue Watching uses catalog duration, position > 60, fraction < 0.9 and completed=false. Exactly 90% falls into neither state. Input validation does not fully enforce positive integral canonical duration, and direct zero-duration series progress can break the continue query. Responses can describe the incoming completion flag rather than accepted stored state.

The 60-second Redis progress marker is written after upsert but before a separate random-ID history insert. Marker/history failures can produce partial outcomes; ON CONFLICT DO NOTHING does not deduplicate history by viewing session. Repeated completed updates can append multiple history rows. History clearing uses two SQL statements and does not reset all concurrent or cached progress state. The batch route is unreachable for ordinary batch payloads because the earlier parameter route consumes them.

The optional generic [idempotency middleware](./backend/src/shared/idempotency.ts) illustrates a Redis claim:

```typescript
const lockAcquired = await redis.set(lockKey, '1', {
  NX: true,
  EX: LOCK_TTL
});
```

A 30-second lock reduces simultaneous work for one key; cached JSON responses last 24 hours. However, the key binds only user-or-anonymous and supplied key, not method/path/profile/payload. Middleware runs before route authorization and validation. Replayed login responses do not recreate session side effects; reusing a key across actions can return unrelated or stale privileged data. The browser supplies no generic key.

Response interception caches errors as well as successes, asynchronously and separately from SQL. json/send interception overlaps, lock deletion has no owner token, expiration can admit another worker, and Redis errors fail open. A committed SQL change can therefore repeat after response/cache loss. Helpers such as createIdempotencyKey are not called by application routes. This is not durable exactly-once processing.

### Implemented operational patterns and their limits

**Opossum:** [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) wraps the master content SQL lookup under storage and simulated segment Redis operations under cdn. Timed calls illustrate limiting repeated dependency pressure at scale. Thresholds are error percentages with volume thresholds, not five consecutive failures. CDN uses 5 seconds/30%/10 calls, storage 10 seconds/40%/5 calls; reset periods are 15 and 30 seconds. Transcoding/DRM configurations have no active callers. Fallback objects contain no cached video; the storage fallback lacks rows and breaks the consumer, while a CDN fallback can become a non-media 200 response. Timeout does not cancel underlying work.

**Metrics:** [metrics.ts](./backend/src/shared/metrics.ts) attaches HTTP duration/count observation at response finish:

```typescript
httpRequestDuration.observe(labels, duration);
httpRequestTotal.inc(labels);
```

This is useful for API latency, but route-local paths can collide across mounts and unmatched paths create unbounded labels. PlaybackStartLatency measures metadata lookup, not a rendered frame. The active-stream map keys content/quality/device type, so starts for different viewers collide while the gauge increments each time. End removes at most one entry, accepts no ownership proof and is never called by the browser. Counts have no expiry, are process-local, and do not enforce limits. CDN/DRM/transcoding instruments are mostly declarations, not real pipeline measurements.

**Logging:** [logger.ts](./backend/src/shared/logger.ts) provides request child loggers and a separate Pino audit logger. Request middleware runs before session parsing, so it does not automatically capture authenticated account/profile context. Client request IDs are accepted unvalidated; no redaction configuration is present. Audit calls cover selected events, not an immutable ledger; the audit_log SQL table is unwritten. Production audit output uses ./logs/audit.log, whose directory/deployment handling is not provided.

**Health:** `/health` and `/health/ready` check PostgreSQL SELECT 1 and Redis PING without a total request deadline. They do not validate schema, media, MinIO, jobs or playback. Liveness is a response after global middleware and session handling, so Redis/session failure can affect it. Startup requires Redis but only warns on MinIO failure and does not require a database query before listening. SIGINT/SIGTERM close Redis and the SQL pool without first draining the HTTP listener.

### Simplified, substituted and omitted

PostgreSQL provides all catalog/personal storage; Valkey substitutes for a production cache/session cluster; MinIO is provisioned as an S3-compatible placeholder. Metadata fixtures substitute for encoded assets and subscription assignments substitute for billing. The UI is a browser demo, not a native TV application.

Omitted components include actual media upload/encoding, publication jobs, private delivery credentials, DRM, CDN, offline licensing, durable event/outbox processing, search indexing, ML recommendations, cross-region ownership, sharding and tested operational failover. The [README](./README.md) documents fresh setup, conflicting seed paths, actual scripts and smoke-test limitations. Documentation review used source/configuration and isolated password verification; no runtime playback or concurrency benchmark was performed.
