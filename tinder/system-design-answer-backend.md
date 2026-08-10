# Tinder - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **User Registration & Profiles**: Account creation with photos, bio, preferences
- **Geospatial Discovery**: Find potential matches within configurable radius
- **Swipe System**: Like/Pass actions with persistence and deduplication
- **Match Detection**: Real-time mutual like detection
- **Messaging**: Chat between matched users only
- **Unmatch**: Remove matches and conversation history

### Non-Functional Requirements
- **Low Latency**: Swipe processing p99 < 50ms, discovery p99 < 200ms
- **High Availability**: 99.9% for core matching; discovery may degrade independently
- **Scalability**: Millions of concurrent users, tens of thousands of swipes per second
- **Data Consistency**: No duplicate matches, no lost swipes, no re-shown profiles
- **Privacy**: Coordinates never leave the server; only bucketed relative distance

The 50ms swipe budget is the one that constrains the architecture, because a swipe is not a fire-and-forget write — the mutual-like check happens inside it, so the budget covers a write plus a read plus a conditional second write. The 200ms discovery budget is comparatively generous, which is what makes it affordable to run a multi-clause query against a separate search cluster and then hydrate the results from Postgres.

### Scale Estimation
- 50M daily active users
- 1.5B swipes per day (~17K/second average, call it 50K/s at evening peak)
- 30M matches per day — a ~2% match rate on swipes
- 500M messages per day

Three consequences fall out of those numbers before any component is chosen.

**Swipes dominate writes by an order of magnitude.** 1.5B swipes against 30M matches means 98% of the write volume produces nothing but a row and a set membership. So the swipe path has to be cheap, and anything expensive — notifications, feed recomputation, analytics — belongs off it.

**Reads are concentrated, not uniform.** A deck request returns ~20 profiles but must consider every eligible user in a radius, so one read amplifies into a large candidate scan. That is what makes discovery the component that needs a purpose-built index while everything else is content with Postgres.

**Peak is regional and time-shifted.** Dating traffic peaks in the evening, locally. Because the workload is already partitioned by geography, capacity follows the sun rather than spiking globally — which is a genuine argument for geosharding later, since a shard's peak is predictable from its longitude.

The questions I would ask before committing to any of this: is the exclusion list required to be exact, or is silently hiding ~1% of profiles acceptable? (It changes whether a bloom filter is on the table.) And does a match need to be strictly ordered against an unmatch — if A unmatches at the same instant B swipes right, which wins? I will assume unmatch wins and the pair does not resurface until the swipe TTL expires.

---

## 2. High-Level Design (5 minutes)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Mobile    │────▶│ API Gateway  │────▶│ Authentication  │
│    Apps     │     │ (Rate Limit) │     │    Service      │
└─────────────┘     └──────────────┘     └─────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│   Discovery     │ │   Swipe     │ │    Messaging    │
│    Service      │ │  Service    │ │     Service     │
└────────┬────────┘ └──────┬──────┘ └────────┬────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│  Elasticsearch  │ │ Redis Sets  │ │ Redis Pub/Sub   │
│  (Geo Search)   │ │ (Swipes)    │ │ (Real-time)     │
└─────────────────┘ └─────────────┘ └─────────────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           ▼
                  ┌─────────────────┐
                  │   PostgreSQL    │
                  │   + PostGIS     │
                  └─────────────────┘
```

The decomposition follows the read/write asymmetry rather than the domain nouns. **Discovery** is read-heavy, tolerant of staleness, and the only service that touches Elasticsearch. **Swipe** is write-heavy, latency-critical, and the only one that must be correct on the first attempt. **Messaging** is connection-heavy — its scaling constraint is open sockets and memory per process, not CPU. Those three profiles want different instance types, different autoscaling signals, and different failure responses, which is the actual argument for separating them.

That also sets the dependency tiers. Postgres and Redis are required by every path; Elasticsearch is required by exactly one. The system is built to express that difference rather than treat all dependencies as equal: the process binds its port and serves auth, matches, and messaging *before* it touches Elasticsearch, and the health endpoint reports Postgres or Redis down as `unhealthy` (503) but Elasticsearch down as `degraded` (200). Getting this backwards is a common and expensive mistake — an ES 8 node with a small heap can take a minute to become useful, and initializing it before binding the port means login is unavailable for that entire minute because a search index is warming.

---

## 3. Data Model Design (7 minutes)

### PostgreSQL Schema with PostGIS

| Table | Key columns | Indexes | Notes |
|-------|-------------|---------|-------|
| `users` | id (UUID PK), email (unique), password_hash, name, birthdate, gender, bio, latitude, longitude, `location` GEOGRAPHY(Point,4326), last_active | **GIST on `location`**, (is_active, last_active DESC), gender | A trigger derives `location` from lat/lng on write, so the geography column can never drift from the coordinates the API reads back |
| `user_preferences` | user_id (PK/FK), interested_in TEXT[], age_min, age_max, distance_km, show_me | — | 1:1 with users. Split from `users` because discovery filters on it as a unit and it changes on a different cadence than the profile |
| `swipes` | id, swiper_id (FK), swiped_id (FK), direction (`like`/`pass`), idempotency_key | **UNIQUE (swiper_id, swiped_id)**, (swiper_id, created_at DESC), swiped_id WHERE direction = 'like' | The unique constraint is what makes the write idempotent — see §6 |
| `matches` | id, user1_id (FK), user2_id (FK), matched_at, unmatched_at | **UNIQUE (user1_id, user2_id)**, partial indexes on each user WHERE unmatched_at IS NULL | Application enforces `user1_id < user2_id` so a pair has exactly one row |
| `messages` | id, match_id (FK), sender_id (FK), content, sent_at, read_at | (match_id, sent_at DESC) | Pagination is keyset on `sent_at`, not OFFSET |

The partial index on `swipes.swiped_id WHERE direction = 'like'` is the one worth pointing at. "Who liked me?" is the query behind both the reciprocity boost in ranking and the match backstop, and passes are the majority of swipes — indexing only likes keeps that index a fraction of the table's size while serving the only lookup that reads it.

### Redis Data Structures

| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `swipes:{user}:liked` | SET | 24h | Mutual-like check (`SISMEMBER`) and deck exclusion |
| `swipes:{user}:passed` | SET | 24h | Deck exclusion only |
| `likes:received:{user}` | SET | 24h | Feeds the +200 reciprocity boost during ranking |
| `user:{user}:location` | STRING (JSON) | 1h | Avoids a Postgres read on every deck request |
| `ratelimit:swipes:{user}` | ZSET | sliding window | Sorted-set sliding window, scored by timestamp |

Every one of these is a cache over Postgres, never a system of record, and each read path has a SQL fallback that also repopulates the key. That is not defensive habit — it is forced by the TTLs. A 24-hour expiry on `swipes:{user}:liked` means a like from last week is simply absent, so a `SISMEMBER` miss cannot be read as "they did not like me."

### Elasticsearch Index

| Field | Type | Used for |
|-------|------|----------|
| `id` | keyword | Document identity; the value the deck query returns |
| `location` | geo_point | `geo_distance` filter and `_geo_distance` sort |
| `gender` | keyword | "Show me people of gender X" |
| `interested_in` | keyword (array) | The reverse half of bidirectional matching |
| `age` | integer | Range filter, denormalized from `birthdate` at index time |
| `show_me` | boolean | Discovery opt-out |
| `last_active` | date | Freshness filter (`now-7d`) and secondary sort |

The index deliberately carries no bio, job title, school, or photos. Those are read from Postgres for whichever candidates survive the filter — one keyed lookup on a set of IDs the query just produced. Mirroring them into Elasticsearch would mean every profile edit needs a synchronous reindex or the card renders stale text, and it would make the index the source of truth for data it has no business owning. Note the one denormalization I did accept: `age` rather than `birthdate`, because Lucene cannot compute an age at query time. The cost is that ages go stale on birthdays — a nightly reindex is the standard remedy.

---

## 4. API Design (5 minutes)

| Method | Path | Purpose | Notes |
|--------|------|---------|-------|
| GET | `/api/discovery/deck` | Ranked swipe deck | Takes `limit`; returns cards with a bucketed `distance` string, never coordinates |
| POST | `/api/swipes` | Record a like or pass | Body carries `direction` and an optional client `idempotency_key`; the response embeds the match when one is created |
| GET | `/api/matches` | Match list | Each entry carries the other user's card plus a last-message preview for the inbox |
| DELETE | `/api/matches/:id` | Unmatch | Also clears both users' Redis sets so the pair can resurface in discovery |
| GET | `/api/matches/:id/messages` | Message history | Keyset pagination by `sent_at` cursor |
| PUT | `/api/users/me/location` | Update location | Writes Postgres, Redis cache, and the Elasticsearch document |
| PUT | `/api/users/me/preferences` | Update discovery filters | Age range, radius, interested-in, discovery opt-out |
| GET | `/api/health` | Dependency health | Postgres/Redis down → 503; Elasticsearch down → 200 `degraded` |

Two things in that table are load-bearing rather than cosmetic.

**The swipe response embeds the match.** It would be more RESTful to return `201 Created` for the swipe and make the client discover the match separately — via the WebSocket event, or by polling the match list. Both lose the moment. The modal has to appear in the same round trip that recorded the swipe, so the mutual-like check is part of the swipe's response contract, not a downstream consequence of it.

**The client generates the idempotency key.** Only the client knows whether this is a new gesture or a retransmission of one the network ate; a server-generated key cannot distinguish them, since the retry looks identical to a fresh request. Pairing the key with the `UNIQUE (swiper_id, swiped_id)` constraint gives two independent layers: the constraint prevents duplicate rows even without a key, and the key preserves which original request the row belongs to.

---

## 5. Deep Dive: Geospatial Discovery (10 minutes)

### Why the deck query is hard

"Every card in the deck has to satisfy a conjunction of predicates that no single index serves well: within N kilometers of me, in my age range, of a gender I want, *and* interested in my gender, active recently, and not one of the thousands of people I have already swiped on."

The last clause is the one that breaks naive designs. It grows without bound per user, and it must be applied before ranking rather than after — filter afterwards and a heavy user's deck is mostly people they already dismissed, because the ranker faithfully returns the best candidates and then you throw them away.

The query runs as an Elasticsearch `bool`: `must` clauses for gender, age range, `show_me`, freshness (`last_active` within 7 days) and the reverse-interest term; a `must_not` carrying the seen-user IDs; a `geo_distance` filter for the radius; and a sort on `_geo_distance` ascending, then `last_active` descending. Note that the radius lives in `filter` rather than `must` — filter clauses are cacheable and contribute no relevance score, which is right for a predicate that is purely boolean.

### Why not do it all in Postgres

PostGIS can express every one of those predicates, and the GIST index on `users.location` serves the radius well. The asymmetry is in the exclusion. In Postgres, `id != ALL($8)` is an array comparison evaluated per candidate row — for an active user that is thousands of UUIDs compared against every row inside the radius, on every deck refresh, and it cannot use an index. Lucene applies the same exclusion as a bitset intersection over the doc-id space, which is close to free and is the thing a search engine is actually built for.

So Elasticsearch is the primary and PostGIS is the fallback, expressing the same intent through `ST_DWithin` for the radius and `ST_Distance` for the ordering. Keeping the fallback is not politeness: it is correct, it is what runs before the index is populated, and it turns an Elasticsearch outage into a latency regression instead of an empty screen. Discovery is also the *only* feature that touches Elasticsearch — login, matches, and messaging do not — so the health endpoint reports ES-down as `degraded` (200) rather than `unhealthy` (503).

**The trade-off I am accepting is a second copy of user data that can drift.** Two mitigations matter. First, the index carries only what the *filter* needs — the profile text a card renders is read back from Postgres for the surviving candidate IDs, so a stale index can misjudge who is eligible but can never display stale bio text. Second, the index is rebuilt from Postgres at every boot, which makes it self-healing: any path that writes users without telling Elasticsearch — a SQL fixture, a manual backfill, a restore — is corrected on the next start rather than leaving discovery permanently empty. Neither substitutes for real incremental reindexing on profile update, which is the honest gap; the correct answer is a CDC stream or a transactional outbox, and this system has neither.

### Distance is bucketed, and that is a server-side decision

Exact coordinates never leave the server. A discovery response carries a phrase, not a number: under a mile becomes "Less than a mile away", 1–5 miles rounds to the nearest mile, and anything beyond rounds to the nearest five.

The reason to do the rounding on the server rather than in the client is that anything the API returns is available to anyone who reads the network tab. An attacker who can query their own deck from three chosen locations can trilaterate an exact position from three exact distances — this is not theoretical, it is how several dating apps were deprovisioned of their users' home addresses. Bucketing to five-mile granularity at the far end makes the intersection of three circles an area rather than a point.

It is mitigation, not a fix. Repeated sampling still narrows the area, and a determined attacker with many accounts gets there eventually. The stronger version is to snap stored coordinates to a grid before any distance is computed, so the underlying value has no more precision than the display does. That costs match quality at close range — the "less than a mile away" bucket is exactly where users care most about accuracy — which is why the system currently keeps precise coordinates and rounds only at the boundary.

---

## 6. Deep Dive: Swipe Processing & Match Detection (8 minutes)

### The swipe write path

"A swipe is the highest-volume write in the system — call it 17K/second at peak — and it is also a read, because the product moment is the 'It's a Match!' modal that has to appear in the same response. So the write path has five steps, in this order:"

1. **Upsert the swipe in Postgres** — `INSERT ... ON CONFLICT (swiper_id, swiped_id) DO UPDATE`, carrying an optional client idempotency key that is preserved with `COALESCE` so a retry never overwrites the original request's key.
2. **Add the target to the swiper's Redis set** — `swipes:{swiper}:liked` or `:passed`, with a 24-hour TTL. This is what the next deck request excludes against.
3. **On a like, record the reverse edge** — add the swiper to `likes:received:{swiped}`, which is what the recipient's ranking reads to boost people who already like them.
4. **Check reciprocity** — `SISMEMBER swipes:{swiped}:liked {swiper}`. A hit is a match, decided in-request.
5. **On a miss, ask Postgres the same question** before concluding there is no match, and increment the cache-miss counter.

Step 5 is the one people leave out, and it is not optional. The Redis sets expire after 24 hours, so a like from last week is simply not there — without the SQL fallback, every mutual like older than the TTL silently fails to become a match. That is a data-loss bug that no test with fresh fixtures will ever catch. The `cacheHitsTotal` / `cacheMissesTotal` counters exist to show how often the fast path actually fires; if the miss rate climbs, the TTL is mistuned and Postgres is quietly absorbing the load Redis was supposed to.

**Why not compute matches in a batch job?** It is architecturally cleaner — one query for symmetric like pairs, no read on the write path, no cache coherence problem at all. And it is completely wrong for this product. Run it every 60 seconds and the modal becomes a notification that arrives after the user has closed the app. The feature is not "you have a match," it is "you have a match *right now, while you are still looking at their face*." Latency is the feature, so the read stays on the write path.

**What I give up:** the write path touches two systems that can disagree. Postgres has the swipe, Redis may not (or vice versa if a Redis write succeeds and the process dies before the SQL commit). I accept that because the disagreement is always recoverable in one direction — Postgres is authoritative, Redis is a cache with a fallback behind it, and the worst case is a slower request, never a wrong answer.

### Match creation and the double-swipe race

"Ordering the two UUIDs before insert — `user1_id < user2_id` — is what makes the pair a single row."

The race is real and takes milliseconds to hit: A and B swipe right on each other simultaneously. Both requests see the other's like, both call `createMatch`. Without canonical ordering, one inserts (A,B) and the other inserts (B,A); each existence check looks for the tuple the other one wrote and misses. The result is two match rows, two modals, and two conversation threads with the messages split between them — a bug users report as "my messages disappeared." With ordering, both requests compute the same tuple, the unique constraint fires, and `ON CONFLICT DO NOTHING` makes the loser a no-op. Both users then get notified through Redis pub/sub on `user:{id}` channels, so delivery works regardless of which API instance holds each WebSocket.

The cost is that the invariant lives in application code, not in the schema. Every read path has to remember to sort first, and nothing stops a future query from forgetting. A `CHECK (user1_id < user2_id)` constraint would make the database enforce it, and I would add one.

### Scaling the exclusion set

The seen-set exclusion is the part of discovery that degrades with use: it grows monotonically per user, and it has to be applied *before* ranking, not after, or the deck fills with people already dismissed. For a heavy user that is tens of thousands of UUIDs shipped into the Elasticsearch query body on every deck refresh.

A per-user bloom filter is the standard answer — roughly 10K bits and 7 hash functions per user, `GETBIT` to test and `SETBIT` to record, giving about a 1% false-positive rate for ~90% less memory. The trade-off is unusually favorable here: a false positive means one profile is silently never shown, and in a candidate pool of thousands nobody can perceive the difference between "not shown" and "not nearby today." I would not accept a 1% error rate on a payments ledger; on a recommendation feed it is free.

What makes me hesitate is not the false positives but the deletions. A bloom filter cannot remove an entry, so unmatching — which is supposed to let a pair resurface — has no way to un-see a user. That is exactly what the current implementation does when it clears both Redis sets on unmatch. A counting bloom filter or a periodic rebuild from Postgres restores it, and either one is more machinery than the exact set needs until users have swiped tens of thousands of times.

### Ranking, and the fairness problem inside it

Once the filter has produced eligible candidates, they are scored: +200 if this person has already liked you, plus 30× a profile-completeness fraction over bio, job title, company, and school. Highest score goes to the top of the deck.

The reciprocity boost is doing something specific — it front-loads the deck with guaranteed matches. Every one of those cards is a right-swipe away from the modal, so the metric it optimizes, matches per session, moves immediately. Completeness is a cheap proxy for effort: a filled-out profile correlates with an account that will actually reply, and it costs nothing to compute because the fields are already loaded.

Both are weaker than they look. "They already liked you" is heavily populated by people who like *everyone* — the indiscriminate swiper is, by construction, the most likely person to be in your received-likes set, so a boost this large systematically promotes the least selective users. The match rate rises, and the conversation rate does not follow, because a match with someone who swiped right without looking is not a signal of interest. Completeness is worse in a subtler way: it rewards a filled `company` and `school`, which encodes a credentialist bias into the deck and quietly penalizes users who left those fields blank deliberately.

The principled alternative is to predict reciprocity — estimate P(they like me back | features) and rank by expected match — rather than observe it. That fixes the indiscriminate-swiper problem, since a user who likes everyone carries almost no information and the model learns to weight them near zero. It also walks straight into desirability scoring, with all of its documented consequences: a learned model on this data will infer attractiveness proxies, concentrate exposure on a small set of profiles, and starve the tail. The current heuristic is worse at ranking and much easier to reason about, which for a system whose ranking decisions are effectively invisible to the people they affect is a defensible place to stop — but it is a stopping point, not a solution.

---

## 7. Deep Dive: Real-Time Messaging (5 minutes)

### The gateway holds connections; Redis moves messages between gateways

Each API process runs a WebSocket gateway that keeps a `Map<userId, WebSocket>` of the sockets it personally owns and a *second*, duplicated Redis client subscribed to the pattern `user:*`. When a message is sent, the receiving gateway verifies the sender belongs to the match, writes the row to Postgres, and publishes to the recipient's channel. Whichever gateway happens to hold that recipient's socket receives the publish and writes it down the wire; the others see the message and find no local connection, so they drop it.

The duplicated client is not incidental. A Redis connection in subscriber mode can issue nothing but subscribe/unsubscribe commands, so a single shared client that also does `SADD` and `SISMEMBER` for the swipe path would break the moment it subscribed. This is the standard trap with `ioredis`, and it fails at runtime rather than at compile time.

**Why not have gateways talk to each other directly?** A mesh removes the Redis hop and its latency. It also means every gateway needs a live registry of every other gateway and a connection to each — N² connections, a membership protocol, and a split-brain story — to save perhaps a millisecond on a path where the human is typing. Pub/sub buys the fan-out for the price of a hop, and the number of processes that need to know about each other stays at zero.

**What I give up: Redis pub/sub is at-most-once and has no backlog.** If the recipient's socket is not connected at the instant of the publish, the real-time delivery is simply lost. That is survivable only because Postgres holds the message: the recipient's client fetches history on reconnect and the message reappears. Pub/sub is an *accelerator over durable state*, never the transport of record — and a design that treated it as the transport would lose messages for every user who was in a tunnel. Delivery to a currently-offline user goes through push notification, not through this path.

Presence and heartbeats hang off the same structure. The gateway pings on an interval and terminates sockets that fail to pong, because a TCP connection to a phone that has moved to a different network stays open and writable for minutes while being functionally dead. Without the heartbeat, the connection map fills with sockets that will never deliver anything, and every one of them looks online.

Typing indicators and read receipts ride the same channel but get different durability. A typing indicator is published and never stored — it is worthless a second after it is sent, and writing it down would add a row per keystroke burst to the highest-volume table in the system. A read receipt does hit Postgres, because "did they see it?" must survive a reconnect; it updates `read_at` and publishes back to the sender. Same transport, opposite storage decisions, and the difference is entirely about whether the fact has value after the moment passes.

### Pagination is keyset, not offset

`GET /api/matches/:matchId/messages` takes a cursor — the timestamp of the oldest message already displayed — and returns the next page ordered by `sent_at DESC`, fetching `limit + 1` rows to determine whether more exist without a second count query.

`OFFSET` would be simpler and is wrong twice over. It degrades linearly, because the database must walk and discard every skipped row: scrolling far back in an active conversation gets slower the further you scroll. Worse, it is incorrect under concurrent writes — a message arriving between page requests shifts every subsequent offset by one, so the user scrolling back sees a message twice or misses one entirely. A keyset cursor anchors to a value in the data itself, so new arrivals at the head cannot perturb pages at the tail. The cost is that you cannot jump to "page 40" — acceptable, since nobody jumps to a page number in a chat thread.

---

## 8. Reliability & Scaling (5 minutes)

### Rate Limiting

| Action | Limit | Mechanism |
|--------|-------|-----------|
| Swipes | 50 per 15 min | Redis sorted set, scored by timestamp (sliding window) |
| Messages | 100 per min | Same sliding window, per user |
| General API | per-route ceilings | `express-rate-limit` in front of `/api` |

Swipes get a *sliding* window rather than a fixed counter with `EXPIRE` for a specific reason: a fixed window resets at a wall-clock boundary, so a bot can spend the full quota in the last second of one window and again in the first second of the next — double the intended rate across the boundary. A sorted set scored by timestamp evicts entries older than the window on each check, so the limit holds over any 15 minutes rather than only over the aligned ones. The cost is memory proportional to the number of actions in the window, versus a single integer.

The limit exists for abuse control, not capacity. Swiping 50 times in 15 minutes is already faster than a human considers profiles; anything above it is automation building a candidate map or spraying likes to farm matches.

### Failure modes and what each one costs

| Failure | Behavior | Why acceptable |
|---------|----------|----------------|
| Elasticsearch down | Discovery falls back to PostGIS; slower decks, everything else normal | Health reports `degraded`, not down; one feature is affected, not the app |
| Redis down | Swipes and matches fail | Not survivable: Redis holds the sessions, the rate limiter, and the pub/sub bus. This is the single point of failure worth fixing first |
| Postgres primary down | Writes fail; cached reads keep serving briefly | System of record; there is no correct way to accept a swipe you cannot durably record |
| One API instance dies | Its WebSocket clients reconnect to another instance | Pub/sub pattern subscription means the new instance receives that user's events with no coordination |

Writing this table out is how the Redis problem becomes obvious. It was introduced as a cache, and caches are supposed to be optional — but it has quietly accumulated three roles that are not cache-like at all, and the blast radius no longer matches the way the component is described. Splitting rate limiting and pub/sub onto separate Redis deployments would at least stop one of them from taking the others down.

### Data Retention

| Data | Retained | Rationale |
|------|----------|-----------|
| Swipes | 30 days | Needed for the seen-set exclusion; after that the profile can resurface |
| Messages after unmatch | 365 days | Preserved for abuse reports, then deleted |
| Match rows after unmatch | 365 days | Same |
| Elasticsearch documents | 90 days inactive | An account nobody has opened in three months should not fill decks |

Deletion runs as a batched job rather than one large `DELETE`, because a single statement spanning millions of rows holds locks and bloats WAL long enough to affect live traffic. Retention here is also a *product* decision disguised as an operational one: expiring swipes at 30 days is what lets a user who passed on someone see them again later, which matters more in a thin local pool than in a dense city.

### What breaks first

Asked to scale this, I would not start with the diagram below — I would name the order things fail.

**First: sessions.** They live in `express-session`'s default `MemoryStore`, so a second API instance cannot read the first one's sessions and a restart logs everyone out. Nothing else in the design blocks horizontal scaling; this does, and it is a configuration change rather than an architectural one.

**Second: the seen-set payload.** The exclusion list is serialized into every discovery query. At a few hundred swipes it is invisible; at tens of thousands the request body itself becomes the bottleneck, and no amount of Elasticsearch capacity helps because the cost is in constructing and shipping the query.

**Third: the candidate pool per shard.** A single Elasticsearch index holding every user works until the working set for one metropolitan area stops fitting comfortably in memory. The fix is geosharding — partition by geohash so a deck query touches one shard, since sharding by user ID would make every query a scatter-gather across all of them.

**Fourth: message volume.** Postgres handles the current read pattern well because a conversation is a single keyset scan on an indexed column. It is the write rate, not the queries, that eventually argues for Cassandra.

### Horizontal Scaling Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Load Balancer                                 │
│              (Geographic + Session Sticky)                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │  API 1  │    │  API 2  │    │  API 3  │
    │ (US-W)  │    │ (US-E)  │    │  (EU)   │
    └────┬────┘    └────┬────┘    └────┬────┘
         │              │              │
         ▼              ▼              ▼
    ┌─────────────────────────────────────┐
    │         Redis Cluster               │
    │    (Pub/Sub across regions)         │
    └─────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │   ES    │    │   ES    │    │   ES    │
    │ (US-W)  │    │ (US-E)  │    │  (EU)   │
    └─────────┘    └─────────┘    └─────────┘
         │              │              │
         └──────────────┼──────────────┘
                        ▼
              ┌─────────────────┐
              │   PostgreSQL    │
              │  Primary + Read │
              │    Replicas     │
              └─────────────────┘
```

---

## 9. Trade-offs Summary (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Geo search | Elasticsearch primary, PostGIS fallback | PostGIS only | Seen-set exclusion is a bitset intersection in Lucene, a per-row array scan in Postgres |
| Index contents | Filter fields only; profile text from Postgres | Mirror full profile into ES | Stale text on cards is user-visible; stale eligibility is not |
| Seen set | Redis SET with 24h TTL + SQL fallback | Exact set in Postgres | O(1) exclusion; the TTL is why the fallback is mandatory |
| Match detection | Synchronous on the like | Batch reconciliation job | The modal *is* the feature; a 60s delay replaces it with a notification |
| Match identity | Canonically ordered UUID pair | Insert as swiped | Collapses the simultaneous-swipe race into one row |
| Swipe write | Upsert on (swiper, swiped) + idempotency key | Plain INSERT | Retries are routine on mobile; a duplicate like double-fires match creation |
| Cross-instance delivery | Redis pub/sub | Direct gateway mesh | O(1) knowledge per process instead of N² connections |
| Startup ordering | Bind port, then index in background | Initialize ES first | Login must not wait on a search index that only discovery uses |
| Messages | PostgreSQL | Cassandra | Volume does not justify it yet; the read pattern is one thread at a time |

### Alternatives worth revisiting at 10× scale

| Alternative | When it becomes the right call |
|-------------|-------------------------------|
| Cassandra for messages | When message write throughput, not query complexity, is the constraint |
| Bloom filter for seen sets | When exclusion lists reach tens of thousands per user — accepting that unmatch can no longer un-see |
| Geosharding | When the candidate pool for one region stops fitting on one machine; shard by geohash, not by user ID, or every deck query becomes a scatter-gather |
| Redis Streams | When at-most-once pub/sub delivery stops being acceptable and events need replay |
| CDC / outbox to Elasticsearch | The real fix for index drift; boot-time reindexing is only a self-healing floor |

---

## 10. Summary

The design rests on four decisions:

1. **Elasticsearch filters, Postgres renders.** The index answers "who is eligible and how far away," and nothing else — which is what keeps a drifting index from ever showing wrong profile text.
2. **Reciprocity is checked on the write path.** Matching is a read performed during a write, because the product moment is a modal, and any batch design turns it into a notification.
3. **Redis is always a cache, never a record.** Every set has a TTL and every read has a SQL fallback that repopulates it. The observability for this — cache hit/miss counters on the swipe path — exists specifically so a mistuned TTL is visible rather than silent.
4. **Dependencies are tiered.** Postgres and Redis are required; Elasticsearch is not. That distinction is expressed in the startup order and in the health endpoint, and it is the difference between an outage and a degradation.

The honest gaps: sessions are in-memory, which blocks horizontal scaling of the API tier despite everything else being ready for it; and nothing incrementally reindexes Elasticsearch on profile change, so the index is only as fresh as the last boot.
