# 🎬 Netflix — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Netflix sounds like a video problem, but the video bytes are the easy part — they're files on cache appliances inside internet providers. Two things make it a real backend problem. First, saying 'yes, play' correctly in one round trip: is this profile allowed to see this title, at what quality, on how many screens, with which DRM keys. Second, remembering where fifteen million people are in their shows — half a million position writes a second — without ever moving anyone backwards. I'll design those two paths carefully and keep everything else, including recommendations, off the request path."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the two numbers that drive the design |
| High-level architecture | 10 min | Control plane vs data plane, and the three core flows |
| Data model & API | 7 min | What lives where, and the contract |
| Deep dive 1: starting playback | 8 min | Entitlement, signed URLs, DRM, screen limits |
| Deep dive 2: resume positions | 8 min | 500K writes/s, last writer wins, no read-before-write |
| Deep dive 3: the homepage | 4 min | Precomputed rows, live Continue Watching, maturity |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope, because 'design Netflix' could mean the encoding farm, the CDN, the recommender or the apps. I'll design the online backend and treat encoding and the CDN as systems I integrate with."

### Functional requirements

1. **Browse**: a personalized homepage of rows per profile, title details, and search.
2. **Play**: start a movie or an episode at a quality that fits the network and the plan, and resume where this profile left off — on any device.
3. **Remember**: Continue Watching, My List and viewing history, per profile.
4. **Profiles**: up to five per account, each with a maturity level; a kids profile never sees adult titles.
5. **Plans**: the plan caps resolution (720p, 1080p, 4K) and concurrent screens (1, 2, 4).

Out of scope: billing, downloads for offline viewing, live events, and the studio-side encoding tools (I'll sketch the pipeline, not design it).

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Playback start | p95 < 2 s from Play to first frame | Every extra second of spinner loses viewers |
| Rebuffering | < 0.5% of viewing time | Stalls are the complaint members remember |
| Streaming availability | 99.99%, and streams already playing survive control-plane outages | The data plane must not depend on us |
| Homepage | p99 < 300 ms server-side | It's the first screen of every session |
| Resume | Within one heartbeat of where you stopped, never backwards | "It forgot where I was" is a trust failure |
| Entitlement | A restricted profile never receives a restricted title, URL or license | This one is a safety requirement, not a preference |
| Screen limits | Enforced within about a minute | Brief overage is fine; locking members out is not |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Members | ~300M accounts, ~750M profiles | Personal data is keyed by profile |
| Peak concurrent streams | ~15M | The control plane sees starts and heartbeats, never bytes |
| Peak bandwidth | 15M × ~5 Mbps ≈ 75 Tbps | Only an ISP-embedded CDN carries this economically |
| Playback starts | 15M ÷ ~1 h sessions ≈ 4K/s; ~40K/s at a premiere | Entitlement + manifest + license in < 200 ms |
| Heartbeats | 15M ÷ 30 s ≈ 500K writes/s | Blind writes; no read-modify-write |
| Homepage loads | ~100K/s at peak | Ranking must happen offline |
| Viewing state | 750M × ~300 rows × ~100 B ≈ 22 TB, ×3 replicas | A wide-column store partitioned by profile |
| Screen leases | 15M × ~100 B ≈ 1.5 GB | One Redis cluster |

"Two numbers drive the whole design: 75 terabits a second, which means we never serve video from anything we run centrally, and half a million position writes a second, which means the hottest write path can't afford to read before it writes."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw it as a control plane — APIs that decide what may play and remember what happened — and a data plane, the CDN that moves bytes. Then I'll walk the three journeys: browse, play, and heartbeat."

```
 ┌────────────────────────────┐                                 ┌────────────────────────────────┐
 │ Netflix app                │  GET segments (signed URLs)     │ Open Connect CDN               │
 │ TV, phone, web             ├────────────────────────────────▶│ appliances inside ISPs         │
 │ ABR player · DRM           │                                 │ video segments on disk         │
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

1. **Browse (1).** The Homepage API reads the profile's precomputed, ranked rows from EVCache, merges in Continue Watching from Cassandra, drops anything above the profile's maturity level, and returns title ids plus artwork.
2. **Play (2).** The Playback API checks entitlement, claims a stream slot in Redis, reads the resume position, and returns a manifest whose segment URLs carry a signed token. The player then pulls segments straight from an Open Connect appliance, which verifies the token itself.
3. **Heartbeat (3).** Every 10–30 seconds the player reports its position. The Playback API writes it to Cassandra with the client's timestamp, renews the slot, and publishes an event to Kafka; stream jobs turn events into viewing history and recommendation features.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Open Connect CDN | Serve segments | Bytes | Appliances inside ISPs, filled nightly |
| API gateway | Session check, routing, rate limits | Requests | Stateless, per region |
| Homepage API | Rows, search, experiment layout | ~100K loads/s | Never ranks on the request path |
| Playback API | Entitlement, manifests, slots, licenses, heartbeats | ~4K starts/s, ~500K heartbeats/s | The only service that can say "yes, play" |
| EVCache | Ranked rows, catalog and profile metadata | Profiles | Memcached-based; a miss means fallback rows, not an error |
| Cassandra | Resume positions and viewing history | Profiles × titles | Partitioned by profile, replicated across regions |
| Redis | Screen leases | Active streams | Needs atomic scripts |
| Kafka + pipeline | Events → history, features, ranked rows | Events | Flink for streaming state, Spark for hourly ranking |
| PostgreSQL | Accounts, profiles, plans, catalog | Accounts | Low write rate, needs constraints |

"Why split Playback from Homepage when both are 'the API'? Because they fail differently. If the Homepage API is slow, members see a generic homepage. If the Playback API is slow, nobody can press Play. Separate fleets let me scale the Playback API for premiere spikes and protect it from homepage load. And the CDN is the strongest split of all: once a stream has its manifest and license, it keeps playing even if every service on this diagram is down."

### Flow 1: starting playback

```
 App                             Playback API                Redis    Cassandra   Open Connect
  │                                    │                       │          │             │
  │ 1 POST /playback {title, episode}  │                       │          │             │
  │───────────────────────────────────▶│                       │          │             │
  │                                    │ 2 maturity, plan, region         │             │
  │                                    │ 3 acquire slot (Lua)  │          │             │
  │                                    │──────────────────────▶│          │             │
  │                                    │ 4 read resume point              │             │
  │                                    │─────────────────────────────────▶│             │
  │ 5 manifest, signed URLs            │                       │          │             │
  │◀───────────────────────────────────│                       │          │             │
  │ 6 POST /license (DRM)              │                       │          │             │
  │───────────────────────────────────▶│                       │          │             │
  │ 7 device-bound keys                │                       │          │             │
  │◀───────────────────────────────────│                       │          │             │
  │ 8 GET segment?token=…                                                               │
  │────────────────────────────────────────────────────────────────────────────────────▶│
  │ 9 segment (token checked)                                                           │
  │◀────────────────────────────────────────────────────────────────────────────────────│
  │                                    │                       │          │             │
```

"Step 2 is three checks: the title's maturity rating against the profile's, the title's licence in the member's country, and — easy to forget — that the episode in the request belongs to the series in the request. Step 3 is one Lua script that claims a screen. In step 5 every segment URL is signed for this session, and the manifest lists two or three appliances so the player can fail over without asking us. Steps 6 and 7 are the DRM license, which re-checks entitlement and binds the keys to this device."

### Flow 2: heartbeats

```
 App                      Playback API         Redis    Cassandra    Kafka      Flink job
  │                             │                │          │          │            │
  │ 1 POST /progress {pos, ts}  │                │          │          │            │
  │────────────────────────────▶│                │          │          │            │
  │                             │ 2 renew lease  │          │          │            │
  │                             │───────────────▶│          │          │            │
  │                             │ 3 USING TIMESTAMP ts      │          │            │
  │                             │──────────────────────────▶│          │            │
  │                             │ 4 playback-event                     │            │
  │                             │─────────────────────────────────────▶│            │
  │ 5 200 {lease: active}       │                │          │          │            │
  │◀────────────────────────────│                │          │          │            │
  ································· asynchronously ··································
  │                             │                │          │          │ 6 consume  │
  │                             │                │          │          │───────────▶│
  │                             │                │          │       7 crossed 95%?  │
  │                             │                │          │ 8 append view         │
  │                             │                │          │◀──────────────────────│
  │                             │                │          │          │            │
```

"Step 3 is a blind write: the client's timestamp becomes Cassandra's write timestamp, so the storage engine itself keeps the newest position. The heartbeat also carries the session id, which is what renews the screen lease in step 2. Everything below the line is asynchronous: a Flink job keyed by profile notices the position crossing 95% and records one view."

### Flow 3: the homepage

```
 App                       Homepage API                      EVCache    Cassandra
  │                              │                              │           │
  │ 1 GET /homepage (profile P)  │                              │           │
  │─────────────────────────────▶│                              │           │
  │                              │ 2 GET rows:P                 │           │
  │                              │─────────────────────────────▶│           │
  │                              │ 3 ranked rows (precomputed)  │           │
  │                              │◀─────────────────────────────│           │
  │                              │ 4 in-progress titles for P               │
  │                              │─────────────────────────────────────────▶│
  │                              │ 5 merge, filter, A/B layout  │           │
  │ 6 rows: title ids + artwork  │                              │           │
  │◀─────────────────────────────│                              │           │
  ························· cache miss or timeout ···························
  │                              │ 7 popular-in-region rows     │           │
  │                              │                              │           │
```

"The expensive part — ranking — happened an hour ago. The request reads one cache key and one Cassandra partition, merges, filters by maturity, and applies the experiment layout. If the cache misses or times out, step 7 returns popular titles in the member's region rather than an error."

---

## 💾 Data Model (4 min)

"Accounts and the catalog need constraints and change slowly; viewing state is huge, hot and always read by profile. So they go to different stores."

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `accounts` | `id`, `email` (unique), `plan`, `country` | Plan drives quality cap and screen limit |
| PostgreSQL | `profiles` | `id`, `account_id`, `maturity_level`, `is_kids`, optional PIN | Up to five per account |
| PostgreSQL | `titles`, `episodes` | `id`, `type`, `maturity_level`, `genres`; episodes `(title_id, season, number)` unique | ~18K titles; cached everywhere |
| PostgreSQL | `title_availability` | `(title_id, country)`, `starts_at`, `ends_at` | Licensing windows |
| Cassandra | `viewing_progress` | partition `profile_id`; clustering `(title_id, content_id)`; `position_s`, `duration_s` | Written with the client's timestamp: per-cell last writer wins |
| Cassandra | `viewing_history` | partition `profile_id`; clustering `(watched_at DESC, content_id)` | One row per completed view; replay-safe key |
| Redis | `streams:{account_id}` | sorted set: member = session id, score = lease expiry | Screen leases |
| EVCache | `rows:{profile_id}:v{n}` | ranked rows | Rebuilt hourly; version bumped by My List and profile changes |
| Kafka | `playback-events` | partitioned by `profile_id` | Per-profile order for completion detection |

"Two keys deserve a sentence. `content_id` is what was actually played — the movie or the episode — while `title_id` is the movie or the series, so Continue Watching can show one card per show. And viewing history is keyed by the timestamp of the event that crossed 95% plus the content id, so replaying Kafka rewrites the same row instead of adding a second view."

"Why Cassandra rather than PostgreSQL for viewing state? At 500K writes a second, PostgreSQL needs dozens of shards and every write is a read-modify-write under a row lock. Cassandra makes a write an append to a commit log plus a memtable, resolves conflicts by timestamp, and replicates across regions natively. What I give up is ad-hoc queries — every read must start from a profile — and that's exactly the only way this data is read. Analytics reads Kafka instead."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/playback                 {title_id, episode_id?} → 201 manifest + session | 403 | 409
POST   /api/v1/playback/{sid}/license   DRM challenge → license bound to this device
POST   /api/v1/playback/{sid}/progress  {position_s, duration_s, ts} → 200 {applied, lease}
DELETE /api/v1/playback/{sid}           end session, free the screen → 204
GET    /api/v1/homepage                 rows for the selected profile
GET    /api/v1/titles/{id}              details | 403 above the profile's maturity
GET    /api/v1/search?q=&cursor=        titles visible to this profile
PUT    /api/v1/my-list/{title_id}       idempotent add (DELETE removes)
```

- **The profile is in the session, not the URL.** Selecting a profile updates the server-side session, so every endpoint evaluates exactly one profile and a client can't ask for another profile's rows by editing a path.
- **`Idempotency-Key` on `POST /playback`.** Starting playback consumes a screen, so a retried start must return the same session rather than take a second slot.
- **Heartbeats answer `applied: false`** for retries and late arrivals. That's success, not an error: the stored position is already as new or newer.
- **Errors are `application/problem+json`** with a code — `maturity_restricted`, `stream_limit`, `not_available_in_region` — because the apps show different screens for each.
- **Rate limits** per account and IP: 30 playback starts a minute, 60 heartbeats a minute.

---

## 🔧 Deep Dive 1: Saying "Yes, Play" (8 min)

"Playback start is where every rule about who may watch what meets. I want one decision, made once, that the edge can enforce for two hours without calling me back."

**Entitlement at session start.** The Playback API loads the profile with its account's plan and the title with its maturity rating and availability, in one round trip each — both are in EVCache. The checks are: maturity, region, episode-belongs-to-series, and plan. The plan doesn't refuse playback; it caps the ladder in the manifest, so a basic member never even sees a 1080p rendition.

**Signed URLs at the edge.** Each segment URL carries an HMAC over the session id, title, rendition and expiry, keyed with a secret the appliances share. An appliance verifies it in microseconds, from the URL alone. Editing `720p` to `2160p` breaks the signature, and so does pointing the URL at another title.

**DRM as the hard boundary.** Tokens can't be revoked before they expire, and a URL can be copied. So the bytes are encrypted, and the keys come from a license server that repeats the entitlement check, binds keys to the device's DRM module (Widevine, FairPlay or PlayReady), and issues licenses that expire within hours. A leaked URL yields ciphertext.

| Approach | Verdict |
|----------|---------|
| ❌ Appliance asks the Playback API per segment | 15M streams × a segment every 4 s ≈ 4M auth calls/s on the control plane, and an API outage stops every stream |
| ❌ Session cookie at the CDN | Appliances would need our session store; cookies don't work for every device's media stack |
| ❌ Public, unguessable URLs | Shareable forever; a basic plan could fetch 4K by guessing the path |
| ✅ Decide once, HMAC-signed URLs, DRM licenses | Edge verifies locally; revocation via short-lived licenses |

### Screen limits as leases

"The tempting design is a counter: increment on start, decrement on stop. It leaks. Phones die, tabs close, laptops sleep — stop events never arrive, and after a week a member with a two-screen plan is told both screens are in use while nothing is playing."

So each account has a Redis sorted set, `streams:{account}`: member = playback session, score = when its lease expires (90 seconds out). One Lua script handles start and renewal atomically:

1. Remove members whose lease has expired.
2. If this session is already a member, renew it — a heartbeat never loses its own slot to a newcomer.
3. Otherwise admit it only if the set is smaller than the plan's limit; else return `409 stream_limit` with the count.

The heartbeat the player already sends renews the lease, so there's no extra traffic. A device that goes quiet frees its slot within 90 seconds; a device that comes back after its slot was taken learns it from the next heartbeat's `lease: inactive` and stops.

**What I give up.** If Redis is unavailable, the check fails open — a few members briefly exceed their screen count, which costs far less than refusing playback to everyone. And the lease is enforced cooperatively by the player; the license renewal is what stops a modified client. I'd rather have a soft limit that never locks out paying members than a hard one that does.

> "The repo implements this part as designed — the Lua lease script, plan-capped ladders, and HMAC-signed `/play` URLs verified without a database lookup — with MinIO presigned URLs standing in for appliances and no DRM."

---

## 🔧 Deep Dive 2: Resume Positions at 500K Writes per Second (8 min)

"Every playing device reports its position every 10 to 30 seconds. The requirement sounds trivial — store the latest position — until you ask *latest by what?*"

**Arrival order is wrong.** A phone on a train sends position 41:20, loses signal, and the request is retried after the next one, 41:50, already landed. If the server applies whatever arrives last, the resume point jumps back thirty seconds. Worse: a member watches on the TV, then picks up the phone, which flushes a stale position from yesterday when it reconnects — and the TV's resume point is overwritten with yesterday's.

**Position time is right.** Each heartbeat carries the time the client observed that position. The server keeps the write with the newest timestamp. Cassandra already resolves conflicting writes per cell by write timestamp, so I pass the client's timestamp as the write timestamp, and the storage engine enforces "last writer wins by position time" with no read before the write.

| Approach | Verdict |
|----------|---------|
| ❌ Apply in arrival order | Late retries and stale devices move resume points backwards |
| ❌ Read, compare, write in PostgreSQL | Correct, but a locked read-modify-write at 500K/s needs dozens of shards |
| ❌ Append every heartbeat, read the max | Correct, but the table grows by 40 billion rows a day to answer a one-row question |
| ✅ Blind write with the client timestamp as the cell timestamp | One write per heartbeat; retries and late arrivals lose automatically |

**Idempotency for free.** A retried heartbeat carries the same timestamp, so it can't win against itself — retries need no idempotency keys. The API answers `applied: false`, which the client treats as success.

**Clock skew is the price.** Last-writer-wins trusts client clocks. A device whose clock runs a day ahead would win every comparison forever, so the server clamps timestamps more than a minute in the future to its own time. A device whose clock is behind loses to other devices, which is the safe direction: its writes are ignored rather than destructive.

**Completion is derived, not written.** "Watched" means crossing 95% — nobody watches the credits, and requiring 100% would leave finished shows in Continue Watching forever. Detecting the crossing needs the previous state, which is exactly the read I refused to put on the hot path. So the Playback API only publishes the heartbeat to Kafka, partitioned by profile, and a Flink job keeps per-profile state and appends one history row when a title crosses 95%. The row key comes from the event, so a replay after a crash rewrites the same row instead of counting a second view. A rewatch that goes back below 95% and finishes again is a new view.

**What I give up.** History and the "Because you watched" rows lag by seconds, and resume accuracy is one heartbeat — up to 30 seconds — unless the player also flushes on pause and on exit, which it does.

> "Locally the same rules run in PostgreSQL: insert-if-absent, then `SELECT … FOR UPDATE` and compare timestamps in one transaction, with the history row written in that transaction on the transition to completed. It's correct; it just wouldn't survive 500K writes a second."

---

## 🔧 Deep Dive 3: A Homepage per Profile (4 min)

"The homepage is 40 or so rows of up to 75 titles, ranked for one profile, in under 300 ms, a hundred thousand times a second."

1. **Rank offline.** Spark jobs score every eligible title for every profile hourly — collaborative filtering on watch time and completion, plus content similarity — and write ranked rows to EVCache. Model inference costs 100 ms to a second per profile; at 100K homepages a second it can't be on the request path.
2. **Merge the facts live.** Continue Watching is a fact, not a suggestion: finish an episode and it must update now. The request reads it from Cassandra — one partition — and merges it on top.
3. **Filter maturity in every source.** The predicate `maturity_level <= profile's` belongs in every query that produces a row and in the title, playback and license endpoints. Filtering at the response boundary means the restricted titles were already fetched into a payload or a cache a child can inspect, and a new row type that bypasses the boundary is a silent leak.
4. **Version the cache, don't delete it.** When the profile adds to My List or a parent lowers the maturity level, I bump `homepage-version:{profile}` rather than deleting the entry. A rebuild that started before the write would otherwise store the old rows *after* the delete, and they'd live until the TTL — for a maturity change, that's a child seeing adult titles for five minutes.
5. **Experiments** assign a layout by hashing `profile_id:experiment_id` into 100 buckets. Including the experiment id keeps concurrent experiments independent; persisting the assignment on first use means a later change to the bucketing can't reshuffle members mid-test.

| Approach | Verdict |
|----------|---------|
| ✅ Precomputed rows + live Continue Watching | Request = one cache read + one partition read |
| ❌ Rank on every request | 100K × up to 1 s of inference |
| ❌ Precompute everything, including Continue Watching | The row you just changed is the one you're looking at |

"What I give up is freshness of suggestions: a title you finished can be recommended for up to an hour. That's an annoyance, not a bug, so I accept it."

---

## 📈 Scale, Failures & Observability (3 min)

**What breaks first, in order:** anything with a read on the heartbeat path; playback starts at a premiere, which spike tenfold (scale the Playback API out ahead of the release; manifests per title are cacheable); and appliance fill for a surprise hit, which falls back to regional appliances and then origin until the next fill.

| Failure | What members see | Mitigation |
|---------|------------------|------------|
| Appliance down | Brief quality dip | Manifest lists two or three appliances; player fails over per segment |
| Playback API down | New plays fail; playing streams continue | They already hold a manifest and a license |
| Redis (screens) down | Nothing | Fail open; count the overage |
| Cassandra slow | Resume one heartbeat stale | Short write timeouts; the next heartbeat supersedes |
| EVCache miss | Less personal homepage | Popular-in-region rows |
| Pipeline late | Suggestions an hour old | Serve the previous version; alert on age |
| Region down | Reconnect elsewhere | Stateless services, multi-region Cassandra, gateway shifts traffic |

**What I'd watch:** time to first frame and rebuffer ratio by device, ISP and appliance — those are the real SLOs; playback starts by outcome (a rising `maturity_restricted` rate usually means a broken client, a rising `stream_limit` rate means leases aren't expiring); the share of heartbeats that were stale (rising means retry storms or clock problems); Kafka consumer lag, which is how far behind history is; and the homepage fallback rate.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Delivery | Own CDN inside ISPs | Commercial CDN | 75 Tbps; cost and path length |
| Segment auth | Decide once; signed URLs; DRM | Origin check per segment | Control plane stays off the data path |
| Screen limit | Leases renewed by heartbeats | Start/stop counter | Dead devices free their slot |
| Slot outage | Fail open | Fail closed | Overage beats refusing playback |
| Resume | LWW by position time, blind write | Arrival order or read-modify-write | Late writes can't move it back; 500K/s |
| Completion | Derived from events | Detected in the write path | Keeps the hot path blind |
| Homepage | Offline ranking + live Continue Watching | Rank per request | 100K/s within 300 ms |
| Cache invalidation | Versioned keys | Delete on write | Racing rebuilds can't restore stale rows |
| Maturity | Predicate in every query | Filter at the response | Restricted rows never leave the database |

"With more time I'd add profile PINs so maturity is a real boundary rather than a convenience, per-shot encoding to cut bandwidth another 20%, and an `Idempotency-Key` store for playback starts so retries never hold two screens even for 90 seconds."
