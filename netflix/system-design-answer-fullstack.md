# 🎬 Netflix — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one evening of viewing end to end — pick a profile, browse, press Play, stop halfway, finish on another device — and get the contracts between the player and the backend right. Three contracts carry the weight: a playback session that says yes or no exactly once and hands the player signed URLs, a progress report stamped with the time the player saw that position so late reports can never move you backwards, and a profile scope that both the server's queries and the client's caches respect."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the player to the CDN and back, plus the core flows |
| Data model & API contract | 7 min | Server stores, client state, and the fields both sides rely on |
| Deep dive 1: pressing Play | 8 min | Session, entitlement and screen limits, and what the UI does with each answer |
| Deep dive 2: a resume point that never goes backwards | 8 min | Heartbeats, timestamps, exit flushes, last writer wins |
| Deep dive 3: profile-scoped personalization | 6 min | Maturity, caches on both sides, My List |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a member |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Members pick a profile, browse a personalized homepage, search, open a title, and play a movie or episode with quality that adapts to the network. Playback resumes where the profile stopped, on any device. Profiles have maturity levels; plans cap resolution (720p/1080p/4K) and screens (1/2/4). Members keep a My List. Out of scope: billing, offline downloads, live events, encoding tools.

| Side | Requirement | Target |
|------|-------------|--------|
| Frontend | Time to first frame | p95 < 2 s after pressing Play |
| Frontend | Browse | LCP < 2.5 s on a mid-range TV; 60 fps row scrolling; INP < 200 ms |
| Frontend | Rebuffering | < 0.5% of viewing time |
| Backend | Playback start | Entitlement + manifest + license < 200 ms server-side |
| Backend | Homepage | p99 < 300 ms server-side |
| Both | Resume | Within one heartbeat of where you stopped; never backwards |
| Both | Safety | A kids profile never receives a restricted title, URL or license |

**Scale.** About 300M accounts and 750M profiles; 15M concurrent streams at peak, which is roughly 75 Tbps of video and — with a heartbeat every 30 seconds — 500K position writes a second. Homepage loads peak around 100K a second.

"Those numbers split the design in two. Video bytes must come from a CDN inside internet providers, and the API must never be on the path of a segment. And the heartbeat write must be blind — no read before write — so the client has to send enough information for the server to order writes without looking."

---

## 🏗️ End-to-End Architecture (8 min)

```
 ┌────────────────────────────┐                                 ┌────────────────────────────────┐
 │ Web app (React SPA)        │  GET segments (signed URLs)     │ Open Connect CDN               │
 │ query cache · player       ├────────────────────────────────▶│ appliances inside ISPs         │
 │ MSE + EME (DRM)            │                                 │ video segments on disk         │
 └────────────┬───────────────┘                                 └────────────────────────────────┘
              │ (1) GET /homepage   (2) POST /playback                            ▲
              │ (3) POST /progress every 10 s                                     │ fill nightly
              ▼                                                                   │
 ┌────────────────────────────────────────────────────────────┐   ┌───────────────┴───────────────┐
 │ API gateway · session check · routing · rate limits        │   │ Encoding pipeline + S3 origin │
 └────────────┬────────────────────────────────────────────┬──┘   │ transcode · package · encrypt │
              │ (1)                                (2) (3) │      └───────────────────────────────┘
              │                                            │
              ▼                                            ▼
 ┌─────────────────────────┐     ┌────────────────────────────────────────────────────┐
 │ Homepage API            │     │ Playback API                                       │
 │ rows · search           │     │ entitlement · manifest · stream slots              │
 │ A/B layout              │     │ DRM licenses · progress writes                     │
 └──────┬───────────────┬──┘     └──────┬───────────────────┬─────────────────────┬───┘
        │ GET rows      │ in-progress   │ (3) LWW write     │ slot lease          │ (3) event
        │               │               │                   │                     │
        ▼               ▼               ▼                   ▼                     ▼
 ┌─────────────────┐  ┌────────────────────────────┐  ┌───────────────┐  ┌─────────────────┐
 │ EVCache         │  │ Cassandra                  │  │ Redis         │  │ Kafka           │
 │ rows · catalog  │  │ progress · viewing history │  │ stream slots  │  │ playback-events │
 └───┬─────────────┘  └────────────────────────────┘  └───────────────┘  └────────┬────────┘
     │ miss      ▲                           ▲                                    │ consume
     ▼           │ ranked rows, hourly       │ append views                       │
 ┌────────────┐  │                           │                                    ▼
 │ PostgreSQL │ ┌───────────────────────────────────────────────────────────────────────────┐
 │ accounts   │ │ Recommendation + history pipeline · Flink stream jobs, Spark batch        │
 │ catalog    │ │ completions → viewing history · features → ranked rows per profile        │
 └────────────┘ └───────────────────────────────────────────────────────────────────────────┘
```

1. **Browse (1).** The SPA asks for the selected profile's homepage. The Homepage API reads precomputed ranked rows from EVCache, merges Continue Watching from Cassandra, filters by maturity, and returns title ids and artwork; the SPA's query cache keys everything by profile.
2. **Play (2).** The player creates a playback session. The Playback API checks maturity, region and plan, claims a screen in Redis, reads the resume point and returns a manifest of signed segment URLs; the player then fetches segments from an Open Connect appliance, not from us.
3. **Heartbeat (3).** While playing, the player posts `{position, timestamp, session}` every 10–30 seconds and on pause and exit. The server keeps the newest position by timestamp, renews the screen lease, and emits an event that stream jobs turn into history and recommendations.

| Layer | Choice | Why |
|-------|--------|-----|
| Web app | React SPA; TanStack Query for server state; a small player store | Authenticated app, no SEO; query cache handles dedupe, retries and profile-scoped invalidation |
| Player | MSE for segments, EME for DRM, ABR picker | Segment-by-segment quality switching; keys never touch JavaScript |
| Playback API | Stateless; sessions, entitlement, licenses, heartbeats | The one place that says "yes, play" |
| Homepage API | Stateless; reads precomputed rows | Ranking can't happen at 100K requests a second |
| Cassandra | Resume positions and history, by profile | 500K blind writes a second |
| Redis | Screen leases | Atomic acquire-or-renew script |
| Open Connect | Segments | Appliances inside ISPs; verifies URL tokens locally |

### Flow: pressing Play across the wire

```
User              Player (SPA)                  Playback API          Redis    CDN
  │                     │                             │                 │       │
  │ 1 click Play        │                             │                 │       │
  │────────────────────▶│                             │                 │       │
  │                     │ 2 POST /playback            │                 │       │
  │                     │────────────────────────────▶│                 │       │
  │                     │                             │ 3 acquire slot  │       │
  │                     │                             │────────────────▶│       │
  │                     │ 4 201 manifest | 403 | 409  │                 │       │
  │                     │◀────────────────────────────│                 │       │
  │                     │ 5 pick rung by bandwidth    │                 │       │
  │                     │ 6 GET segment?token                                   │
  │                     │──────────────────────────────────────────────────────▶│
  │                     │ 7 media bytes                                         │
  │                     │◀──────────────────────────────────────────────────────│
  │ 8 resumes at 41:20  │                             │                 │       │
  │◀────────────────────│                             │                 │       │
  │                     │                             │                 │       │
```

"Step 4 is a three-way contract the UI has to handle: `201` with a manifest, `403 maturity_restricted` with a 'not available on this profile' screen, or `409 stream_limit` with 'your plan allows 2 screens — stop playback on another device'. Step 5 happens in the player, not on the server: the manifest lists every rendition the plan allows, and the player chooses per segment."

### Flow: heartbeats and leaving

```
Player (SPA)                    Playback API                Cassandra
      │                               │                         │
      │ 1 every 10 s: {pos, ts, sid}  │                         │
      │──────────────────────────────▶│                         │
      │                               │ 2 write if ts is newer  │
      │                               │────────────────────────▶│
      │ 3 200 {applied, lease}        │                         │
      │◀──────────────────────────────│                         │
      │ 4 retry: same {pos, ts}       │                         │
      │──────────────────────────────▶│                         │
      │ 5 200 {applied: false}        │                         │
      │◀──────────────────────────────│                         │
      ······················· tab closed ························
      │ 6 final pos (keepalive)       │                         │
      │──────────────────────────────▶│                         │
      │ 7 DELETE /sessions/{sid}      │                         │
      │──────────────────────────────▶│                         │
      │                               │                         │
```

"Steps 4 and 5 are why I can retry heartbeats blindly: the retry carries the original timestamp, so the server sees nothing newer and answers `applied: false`. Steps 6 and 7 are the exit path. A normal `fetch` is cancelled when the tab closes, so both requests use `keepalive`, and the final report omits the session id so it doesn't renew the screen it's about to free."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `accounts`, `profiles` | plan; `maturity_level`, `is_kids` | Plan drives ladder cap and screen limit |
| PostgreSQL | `titles`, `episodes` | `maturity_level`, `genres`; `(title_id, season, number)` | Cached in EVCache |
| Cassandra | `viewing_progress` | partition `profile_id`; clustering `(title_id, content_id)` | Write timestamp = client's position time |
| Cassandra | `viewing_history` | partition `profile_id`; clustering `(watched_at, content_id)` | One row per completed view, replay-safe |
| Redis | `streams:{account_id}` | session → lease expiry | Screen leases |
| EVCache | `rows:{profile_id}:v{n}` | ranked rows | Version bumped by My List and profile edits |

### Client side

| State | Owner | Notes |
|-------|-------|-------|
| `['home', profileId]`, `['title', id]`, `['search', profileId, q]` | TanStack Query | Every key includes the profile, so a profile switch can never show the previous profile's data |
| Playback session, current position, lease state | Player store (Zustand) | Updated four times a second; components subscribe to slices |
| Selected profile and its maturity | Session store, filled from `/me` | Display only — the server enforces maturity |
| Title, episode, timestamp to resume at | URL (`/watch/$id?episode=&t=`) | Deep links and back/forward work |

### The contract

```
POST   /api/v1/playback                 {title_id, episode_id?} → 201 | 403 | 409
POST   /api/v1/playback/{sid}/progress  {position_s, duration_s, ts} → 200 {applied, lease}
DELETE /api/v1/playback/{sid}           → 204 (sent with keepalive on exit)
GET    /api/v1/homepage                 rows for the session's profile
PUT    /api/v1/my-list/{title_id}       idempotent add (DELETE removes)
GET    https://{oca}/…/{segment}?t=…    signed segment URL
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| Playback session | One entitlement decision; a ladder already capped by plan; URLs valid for hours | Render the quality menu from the manifest without knowing plan rules |
| `403` / `409` codes | Machine-readable reason, screen count and limit | Show the right message instead of a generic error |
| `ts` on progress | Newest position by `ts` wins; equal or older is a no-op | Retry and flush freely, from any device |
| `applied` | Tells whether this write changed the stored position | Ignore stale responses; no rollback needed |
| `lease.active` | False once another device took the last screen | Pause and explain, instead of playing on |
| Profile in the session | Every response is filtered for that profile | Treat a profile switch as a cache boundary |

---

## 🔧 Deep Dive 1: Pressing Play (8 min)

"Pressing Play is where the most rules meet, and where a wrong answer is either a safety bug or a member locked out of the plan they pay for."

**Server.** The Playback API loads the profile with its plan, and the title with its rating and regional availability. It checks maturity, region, and that the requested episode belongs to the requested series — otherwise a harmless series id in the path could carry a restricted episode id in the body. Then it claims a screen: an atomic script on the account's sorted set of sessions removes expired leases, renews this session if present, and admits a new one only under the plan's limit. The manifest's ladder is filtered by plan, and every segment URL is signed with an HMAC over session, title, rendition and expiry, which appliances verify without calling us.

**Client.** The SPA calls `POST /playback` when the watch route mounts, keyed by an idempotency key per click, so a retried request after a timeout returns the same session instead of holding a second screen. It renders the three answers as three screens. On `201` it seeks to the resume point before the first frame, starting at a modest rung (480p or 720p) so the first segment is small, then lets ABR climb. A manual quality change swaps the rendition but keeps the current position.

| Approach | Verdict |
|----------|---------|
| ✅ One session call; signed URLs; DRM license; leases | One decision, enforced at the edge; dead devices free their screen |
| ❌ Check entitlement in the client before playing | The client can't be trusted, and the rules (region, plan) live on the server |
| ❌ Authorize every segment at the origin | ~4M checks a second, and an API outage stops every stream |
| ❌ Count screens with start/stop events | Stop events go missing; members get locked out of their own plan |

"What I give up: a URL stays valid until it expires, so a copied URL works for hours. That's acceptable only because segments are encrypted and the DRM license — device-bound, short-lived, renewed during playback — is the real gate. And screen limits are soft: if Redis is down I let people watch."

---

## 🔧 Deep Dive 2: A Resume Point That Never Goes Backwards (8 min)

"The promise is simple: open Netflix on any device and it starts where you stopped. Breaking it is easy in three ways — the client never sends the position, a late request overwrites a newer one, or the last few minutes vanish when the tab closes."

**Client: send it.** The player reports every 10 seconds while playing (production devices use up to 30), on pause, and on exit. The interval timer must not be tied to `timeupdate` — that event fires four times a second, and an effect that restarts its timer on every tick never fires at all. Each report carries the position, the duration, the session id, and `ts`: the client clock at the moment the position was read.

**Client: don't lose the end.** Leaving the watch page and closing the tab both flush: the final report and the session `DELETE` go out with `keepalive`, from a snapshot taken before the player state is cleared. The final report deliberately omits the session id so it can't renew the screen it's about to release.

**Server: order by `ts`, not arrival.** The write keeps the position with the newest `ts`; in Cassandra that's simply the write timestamp, so there's no read before the write. A retried report has the same `ts` and changes nothing; a report delayed behind a newer one loses; a phone that reconnects and flushes yesterday's position loses to today's TV. The server clamps `ts` more than a minute in the future, so one device with a fast clock can't win forever.

**Server: completion once.** Crossing 95% means watched. That transition is detected downstream from the event stream and written with a key derived from the event, so the dozen heartbeats during the credits produce one view, and a Kafka replay rewrites it rather than adding another.

| Approach | Verdict |
|----------|---------|
| ✅ Client `ts` + last writer wins + keepalive exit flush | Retries are free; late writes lose; the last minutes survive closing the tab |
| ❌ Server arrival order | Flaky networks move resume points backwards |
| ❌ Save only on exit | Crashes, dead batteries and killed apps lose the whole session |
| ❌ Read-compare-write per heartbeat | Correct but 500K locked read-modify-writes a second |

"What I give up: trusting client clocks, bounded by the clamp, and up to one heartbeat of accuracy if a device dies without flushing."

---

## 🔧 Deep Dive 3: Profile-Scoped Personalization (6 min)

"A profile is a boundary on both sides of the wire: the server must never select a title above the profile's maturity, and the client must never show one profile's cached data to another."

**Server: maturity is a predicate, not a filter.** Every row source, the title-details endpoint, search, the playback session and the license server carry `maturity_level <= profile's`. Filtering at the response boundary would mean the restricted titles were already fetched — into a cache entry or a payload a child can read in devtools.

**Server: precompute suggestions, merge facts.** Ranked rows are built hourly offline; Continue Watching is read live, because it's the row you just changed. My List writes and profile edits bump a per-profile version in the homepage cache key instead of deleting the entry, so a rebuild that started a moment earlier can't store the old rows back — which, after a parent lowers a maturity level, would mean five more minutes of adult titles.

**Client: the profile is part of every cache key.** Switching profiles calls the server (the session now holds the new profile), then clears the query cache and the player store. Keys include the profile id anyway, so even a stale in-flight response lands under the old profile's key and is never rendered.

**Client: optimistic My List.** Adding a title flips the button immediately, writes the title into the cached My List row, and sends `PUT`. On failure it rolls back and shows a toast. `PUT` and `DELETE` are idempotent, so the query cache can retry them safely while offline.

| Approach | Verdict |
|----------|---------|
| ✅ Server-side maturity predicate + profile-keyed client caches | Restricted data never reaches the device; no cross-profile leaks |
| ❌ Client-side maturity filter | The data is already on the device |
| ❌ Delete-on-write homepage cache | A racing rebuild restores stale rows until the TTL |

---

## 📈 Failures & Scale (3 min)

| Failure | What the member sees | What the system does |
|---------|----------------------|----------------------|
| Appliance down | A brief quality dip | Player fails over to the next appliance in the manifest |
| Playback API down | "Can't play right now" on new plays; current stream continues | The player already has a manifest and license; heartbeats retry with backoff |
| Redis (screens) down | Nothing | Slot checks fail open; overage is counted |
| Cassandra slow | Resume may be one heartbeat old | Heartbeats time out quickly; the next one supersedes |
| Homepage cache miss | A less personal homepage | Popular-in-region rows instead of an error |
| Offline mid-session | Playback continues from buffer; My List changes queue | Query cache pauses mutations and retries on reconnect |

**What breaks first:** the heartbeat write path if it ever reads before writing; playback starts at a premiere (ten times normal); and appliance fill for a surprise hit.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Playback auth | One session; signed URLs; DRM | Per-segment origin auth | Control plane off the data path |
| Screen limit | Leases renewed by heartbeats | Start/stop counter | Dead devices free their screen |
| Resume ordering | Client `ts`, last writer wins | Arrival order | Late reports can't move it back |
| Exit save | `keepalive` flush + periodic reports | Save on exit only | Survives crashes and closed tabs |
| Maturity | Server predicate in every query | Client filter | Restricted data never ships |
| Client state | Query cache keyed by profile + small player store | Everything in one global store | Profile switch is a clean boundary |
| Homepage | Offline rows + live Continue Watching | Rank per request | 100K/s in 300 ms |

"With more time: profile PINs so a kid can't just switch to a parent's profile, a downloads mode with offline licenses, and per-title server-side ABR hints from QoE data so the first segment is right more often."
