# YouTube Top K Videos - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for YouTube Trending: ingest a firehose of view events, maintain a sliding window of view counts per video, and continuously compute the top K videos overall and per category — pushing ranking changes to connected clients in near real time.

The thing that makes this hard is not the counting. It's that **"trending" is a sliding-window query over a high-cardinality stream, and both halves of that phrase are hostile.** Sliding-window means the answer changes every second even when nobody does anything, because views age out of the back of the window. High-cardinality means there are 500M videos and we cannot afford a per-video anything on the read path.

And there's a third constraint that shapes more decisions than it first appears to: **trending is a public ranking, so it is an adversarial target.** Every choice below has to survive someone actively trying to game it.

## 🎯 Requirements Clarification

Questions I'd ask before designing:

- **How exact does the ranking have to be?** This is the crux of the whole design. If "approximately the top 10" is acceptable, I can use probabilistic sketches and the system gets dramatically cheaper. I'll argue it is *not* acceptable — and that the reason is credibility, not mathematics.
- **What window?** I'll take a 60-minute sliding window as the primary. "Trending" means *right now*; "most viewed ever" is a static leaderboard and a much easier product.
- **Is a view a view?** No. A view is an event we *choose* to count, after deduplication and fraud filtering. That distinction is the difference between a ranking and a bot scoreboard.
- **How stale can the ranking be?** A few seconds. Nobody can tell whether a trending list is 2 seconds or 6 seconds old — and this concession is worth an enormous amount.

### Functional Requirements

- **Ingest views** at high throughput, with duplicate suppression
- **Maintain a sliding window** of view counts per video and per category
- **Compute top K** overall and per category, continuously
- **Push updates** to connected clients as rankings change
- **Snapshot rankings** historically for audit and analysis

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| View ingestion latency | p99 < 50ms | Fire-and-forget from the client, but it must never block playback telemetry |
| Trending query latency | p99 < 100ms | It's a page-load blocker |
| Ranking freshness | ~5 seconds | Deliberately relaxed — the load-bearing concession |
| Ranking correctness | Exact ordering within the window | A visibly wrong ranking destroys the feature's credibility |
| Availability | 99.9% | Trending being stale is survivable; trending being *wrong* is not |
| Durability of a single view | **Low** | Losing one event out of two billion is a rounding error. Saying this out loud unlocks the entire write path |

### Scale Estimates

- 100M DAU × ~20 views/day = **2B view events/day** → **~23K/sec average, ~115K/sec peak** (5× burst)
- **500M videos** total, but only **~5M "active"** — viewed at least once in the last hour
- 15–20 categories
- Redis working set: ~10 GB of counters
- Raw event log: ~15 TB over 7-day retention

That 500M-vs-5M gap is the single most useful fact in this design. We never operate on 500M videos; we operate on the ~1% anyone is actually watching, and the sliding window evicts the rest for free.

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│              Clients — players, web, mobile, API consumers           │
└──────────────┬────────────────────────────────────┬──────────────────┘
               │ POST view events (batched)         │ SSE (trending)
               ▼                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│          API Gateway — TLS, rate limiting, SSE-aware routing         │
└──────────────┬────────────────────────────────────┬──────────────────┘
               ▼                                    │
     ┌───────────────────┐                          │
     │  Ingest Servers   │                          │
     │  (stateless, ×N)  │                          │
     │                   │                          │
     │  dedupe → local   │                          │
     │  pre-aggregate    │                          │
     │  → flush every 1s │                          │
     └─────────┬─────────┘                          │
               │ batched deltas                     │
               ▼                                    │
     ┌───────────────────┐        ┌─────────────────┴──────┐
     │       Kafka       │        │     SSE Gateways       │
     │   view-events     │        │   (~10K conns each)    │
     │ (durable buffer)  │        └────────▲───────────────┘
     └────┬─────────┬────┘                 │ fan-out via
          │         │                      │ Redis pub/sub
          ▼         ▼                      │
  ┌────────────┐  ┌──────────────┐  ┌──────┴──────────────┐
  │   Redis    │  │  PostgreSQL  │  │  Trending Workers   │
  │            │  │              │  │                     │
  │ per-minute │  │ video meta,  │  │  every 5s:          │
  │ bucket     │  │ raw events   │  │  union 60 buckets   │
  │ ZSETs,     │  │ (7d, part-   │◀─│  → top-K heap       │
  │ dedupe     │  │ itioned),    │  │  → diff → publish   │
  │ keys       │  │ snapshots    │  │                     │
  └─────▲──────┘  └──────────────┘  └─────────┬───────────┘
        │                                     │
        └─────────────────────────────────────┘
             read buckets / write ranking cache
```

The structural decision worth naming: **ingest, aggregation, and ranking are three separate tiers with a queue between them.** An ingest server's only job is to say "accepted" as fast as possible — it ranks nothing, reads nothing, and holds no state anyone depends on. The ranking is computed by a small number of workers on a schedule, and the read path serves a *cached artifact* those workers produced. **Nothing on the request path ever computes a top-K.**

## 💾 Data Model

**PostgreSQL** — the durable, low-throughput side:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| videos | id (UUID PK), title, channel_name, category, duration_seconds, total_views (BIGINT) | (category), (total_views DESC) | ~500M rows. Read-mostly. `total_views` is a lifetime counter drained in batches — **not** the trending signal |
| view_events | id, video_id (FK), viewed_at, session_id, idempotency_key | (viewed_at) for retention; unique partial on idempotency_key | The raw log. **~2B rows/day, 7-day retention.** Partitioned by day, so expiry is a `DROP PARTITION` |
| trending_snapshots | id, window_type, category, video_rankings (JSONB), snapshot_at | (window_type, snapshot_at) | One row per category per interval. Tiny. The audit trail for "why was this trending at 3pm" |

**Redis** — the hot side, where the algorithm actually lives:

| Key | Structure | TTL | Contents |
|-----|-----------|-----|----------|
| `views:bucket:{category}:{minute}` | Sorted set | 70 min | video_id → views *in that one minute*. ~70 live keys per category |
| `views:total` | Hash | none | video_id → lifetime views. Drained to PostgreSQL; rebuildable from it |
| `dedupe:{video}:{session}:{10s-bucket}` | String | 1 hour | Presence means "already counted" |
| `trending:{category}` | Serialized blob | 10s | The published top-K. **This is what the read path actually serves** |

The division of labor is the point: **PostgreSQL never participates in a trending query.** It holds metadata (hydrated onto the ranking afterward) and the raw log (for forensics). If PostgreSQL is down, trending keeps working. That is a deliberate blast-radius decision, not an accident.

## 🔌 API Design

```
POST   /api/videos/:id/view      → Record one view (idempotent, fire-and-forget)
POST   /api/videos/batch-view    → Record many views in one request  ← the real ingest path
GET    /api/videos/:id           → Video metadata

GET    /api/trending?category=   → Top K for a category   ← the 100ms SLO
GET    /api/trending/all         → Top K for every category in one response
GET    /api/trending/categories  → Category list
GET    /api/trending/stats       → Cache hit rate, last-update time, worker health

GET    /api/sse/trending         → Server-Sent Events stream of ranking updates
GET    /metrics                  → Prometheus
GET    /health/ready             → PG + Redis + trending-worker freshness
```

Two notes. **The batch endpoint is the primary ingest path, not a convenience** — a player reports views alongside other telemetry, and at 115K events/sec the per-request HTTP overhead exceeds the work being requested. And `GET /api/trending` returns a *precomputed blob*; its only work is a cache read plus metadata hydration.

## 🔧 Deep Dive 1: Sliding-Window Counting — Why Buckets, and Why One Minute

**The problem.** "Views in the last 60 minutes" is a *sliding* window: at 14:32:01 it means 13:32:01→14:32:01, and one second later it means something different, because a second of views just aged out of the back. The answer changes continuously even if no one watches anything.

**The obvious approaches, and exactly how each one dies:**

*Scan the raw events.* Counting and grouping the last hour of `view_events` means scanning ~83M rows (an hour at 23K/sec). It's precisely correct and it takes minutes. Against a 5-second refresh, that isn't slow — it's *infinitely* slow, because it can never finish before it's needed again.

*One counter per video, incremented on view.* Now the counter never *decreases*. There is no mechanism by which a view from 61 minutes ago removes itself. You've built an all-time leaderboard and mislabeled it "trending" — a different and much less interesting product.

*Exact sliding window per video: store every event timestamp, evict as they age.* Correct, and it costs a per-video structure holding an hour of timestamps. Across 5M active videos and 83M events, that's the raw log again with extra steps.

**The resolution: discretize time.** Break the window into 1-minute buckets, each a Redis sorted set mapping video → views *in that minute*. A view increments exactly one bucket — one `ZINCRBY`, O(log N), one round trip. The 60-minute window is the union of the last 60 buckets. And old buckets need no eviction logic at all: they carry a 70-minute TTL and Redis deletes them. **The window slides for free, as a side effect of expiry.**

Discretizing costs precision at the edge. At 14:32:30, the oldest bucket in our union is 13:32 — only half of which is truly inside a strict 60-minute window. So the window is really "somewhere between 59 and 60 minutes," jittering by up to one bucket. For a *ranking* that's immaterial: the boundary error applies to every video roughly proportionally, so it barely perturbs the ordering, which is the only thing we publish.

**Why one minute, specifically?** A real tension, with a bad answer on each side:

| Bucket size | Keys per category | Failure mode |
|-------------|-------------------|--------------|
| 10 seconds | ~360 | 6× the keys and 6× the union cost, for a precision improvement no human can perceive |
| ✅ **1 minute** | ~70 | Union stays cheap; scores move smoothly |
| 15 minutes | ~5 | **The ranking visibly lurches.** An entire bucket drops off the back at once — up to 25% of a video's score vanishes in one step |

> "The coarse-bucket failure is the one people don't anticipate, and it isn't a correctness bug — the counts stay perfectly accurate. It's a *perception* bug, and it's fatal anyway. With 15-minute buckets the window doesn't slide, it hops: a video's score sits flat for fifteen minutes and then falls off a cliff when its oldest bucket expires. Users watching a live-updating leaderboard see items teleport several ranks at once, conclude the numbers are made up, and stop trusting the feature. A trending list's entire value is that people believe it. So I'll pay 14× the key count to make the score curve smooth. One minute is where smoothness stops improving perceptibly while cost keeps rising — which is exactly where you want to sit on a curve like this."

**What we give up:** ~70 sorted sets per category × ~20 categories ≈ 1,400 live keys, and Redis memory proportional to *active videos × buckets they appear in* (~10 GB) rather than a fixed sketch size. That bill is the crux of the next decision.

## 🔧 Deep Dive 2: Exact Counts vs. Sketches — Where Approximation Actually Fails

Here is the decision an interviewer is really fishing for: at 115K events/sec across millions of videos, why not use a probabilistic counter?

**The case for sketches is genuinely strong.** A Count-Min Sketch gives O(1) updates, uses a *fixed* amount of memory regardless of cardinality (single-digit MB versus our 10 GB), and needs no aggregation step at all. Space-Saving tracks stream heavy-hitters in O(1) amortized and is *designed* for precisely this problem. On paper they are strictly better on every axis I've named so far.

**And I'd still choose exact counts — because of the specific way approximation breaks this product.**

Count-Min Sketch's guarantee is *bounded overestimation*: the estimate is never below the true count, and exceeds it by at most ε·N with high probability. That error bound is on **the count**. We don't publish counts. We publish an **ordering**.

Make it concrete. Two videos near the K-th boundary: A has a true count of 100,000; B has 102,000, so B genuinely outranks A by 2%. CMS estimates are inflated by hash collisions with the long tail, and *the inflation is not uniform*. A collides with a couple of busy videos and comes back at 104,000. B collides with nothing much and comes back at 102,300. **The sketch has now reversed the true order** — and it did so while perfectly honoring its error bound. Nothing failed. The guarantee simply wasn't about the thing we care about.

> "This is the trap, and it's why 'approximate counting' is the wrong frame for a top-K product. The error bound is on *magnitude* and the requirement is on *rank*, and those two decouple exactly where the stakes are highest: near the boundary between rank 9 and rank 11, where the true counts are closest together and therefore where a small absolute error most easily flips them. The sketch is least trustworthy at precisely the point where its output gets the most scrutiny. And the consequence isn't a slightly-off number — it's a creator whose video was genuinely #8 showing up at #12, and a competitor who wasn't in the top 10 showing up at #9. Trending is a ranking people build careers on and file complaints about. It has to be defensible, and 'the sketch's expected error was within bounds' is not a defense anyone will accept."

**The cost of exactness, stated plainly:** ~10 GB of Redis instead of a few MB, an O(N log K) aggregation pass every 5 seconds instead of nothing, and a footprint that grows with active cardinality instead of staying flat. That's a real bill.

**Why it's affordable — and this is the number that decides it:** 500M videos exist, but only **~5M are active** in any hour. Sketches earn their keep when cardinality is so high you *cannot* hold the counts, and 5M counters is simply not that regime. The sliding window is already doing the job a sketch would do: it evicts the tail automatically. A `ZUNIONSTORE` over 60 buckets of ~5K members each (per category) finishes in single-digit milliseconds, and we run it once every 5 seconds on a background worker — never per request.

**Where I'd switch, and I'd volunteer this unprompted:** if active cardinality reached ~5M *per category* rather than in total, the union becomes the bottleneck and exactness stops being affordable. The right move then is **not** Count-Min Sketch — it's **Space-Saving**, which gives *guaranteed top-K membership* (it can prove which items are definitely in the top K) rather than CMS's per-item magnitude bound. It's approximate along the dimension we actually care about. Knowing *which* approximation to reach for is the whole skill; "use a sketch, they're fast" is not an answer.

**The top-K extraction itself** is the least interesting part, which is worth saying because it looks like the algorithmic centerpiece:

1. `ZUNIONSTORE` the last 60 bucket keys into a temporary sorted set, per category
2. Iterate its members, pushing each `{videoId, score}` into a **min-heap capped at size K**
3. If the heap is full and the new score exceeds the heap's minimum, pop the min and push the new item
4. Drain the heap and reverse — the top K, descending

O(N log K) time, O(K) space. With K=10 and N≈5K per category, it's microseconds. **A full sort would be O(N log N)** and would honestly also be fine today — the heap matters for the same reason exactness matters: it's the choice that still holds up when N grows two orders of magnitude and sorting doesn't.

## 🔧 Deep Dive 3: The Write Path — Absorbing 115K Events/Sec Without a Hot Key

The ranking math is settled. The remaining problem is that 115K peak events per second all want to touch Redis, and a disproportionate share want to touch the *same* keys — the `all` category's current-minute bucket receives **every single view**, and within it a handful of viral videos absorb a huge fraction of the increments.

Redis is single-threaded per shard, and **a hot key cannot be sharded away.** It is one key; it lives on one node; Redis Cluster's hash-slot routing will faithfully deliver all 115K ops/sec to that node. Partitioning by category doesn't help either, because the `all` bucket is by definition the hottest and is a single key no matter how the categories are split.

**So the fix is to stop sending 115K increments.** Ingest servers aggregate in-process before touching Redis:

1. A view arrives. Check the dedupe key. If it's a duplicate, drop it and bump a counter.
2. Otherwise increment an **in-memory local counter** for `(category, videoId)` and return `202 Accepted` immediately. Total server-side work: a hash-map bump.
3. Every **1 second**, flush the accumulated map to Redis as one pipelined batch — one `ZINCRBY` per *distinct video this server saw in the last second*, not one per event.
4. In parallel, emit the raw events to Kafka for the durable log and downstream consumers.

The arithmetic: with 50 ingest servers each touching, say, 20K distinct videos per second, Redis sees **50 × 20K = 1M ops/sec spread across many keys** — but critically, the hottest single video now receives **50 increments per second (one per server) instead of 30,000.** Pre-aggregation collapses a hot key into a warm one. The batch also amortizes network round-trips: one pipelined flush instead of thousands of individual commands.

> "This is a write-behind cache, and the reason it's safe here is a requirement I called out at the very top: **a single view event is not durable and doesn't need to be.** If an ingest server dies with a second of un-flushed counts in memory, we lose up to one second of that server's views — a few thousand events out of two billion a day. That is a rounding error on a *ranking*. I would never do this to a payment, an order, or a message. I do it here because I asked 'what does it cost us to lose one event' early, got the answer 'nothing,' and then spent that answer on a roughly 600× reduction in hot-key pressure. Noticing which of your requirements is *weak* is usually worth more than optimizing the strong ones."

**Deduplication — which is really fraud prevention.** The idempotency key is `{videoId}:{sessionId}:{10-second bucket}`, claimed with `SETNX` and a 1-hour TTL. A repeat inside the same 10-second bucket is dropped.

The stated purpose is retry safety: flaky networks, double-taps, client bugs. The *real* purpose is that **trending is an adversarial ranking, and the cheapest attack on it is to send the same view a thousand times.** Without dedupe, a trivial script inflates a video 2–3× and outranks legitimately more popular content. The trending list becomes a ranking of whoever wrote the best bot — and at that point the feature isn't degraded, it's dead, because its only value was that people believed it.

Dedupe alone won't stop a determined attacker (rotate session IDs, rotate IPs). It's a floor, layered with per-IP and per-session rate limits, a requirement for plausible watch-time telemetry rather than a bare "view" ping, and — the layer that actually works — anomaly detection on the *shape* of a video's view curve. Organic virality has a characteristic ramp; a botnet produces a step function. The duplicate-suppression rate is itself our best early warning: a sudden spike on one video is an attack in progress.

**What dedupe costs:** a legitimate re-watch within 10 seconds is silently dropped, and the dedupe keys are ~2B `SETNX` operations a day with an hour-long TTL — a meaningful chunk of Redis memory in their own right. Both are cheap next to the alternative.

## 📡 Serving the Read Path

The trending workers run every 5 seconds: union the buckets, extract top-K per category, **diff against the previous result**, and only if the ranking actually changed, write the new blob to Redis and publish to a pub/sub channel. SSE gateways subscribe to that channel and push to their connected clients. Snapshots land in PostgreSQL as the audit trail.

Two details carry the load:

**Diff-before-publish.** Most 5-second intervals produce *no change* in the top 10 — the ranking is far more stable than the counts underneath it. Publishing unconditionally would push a full payload to every connected client every 5 seconds whether or not anything happened. Diffing turns a constant-rate broadcast into an event-driven one and drops fan-out volume by an order of magnitude during quiet periods.

**SSE, not WebSocket.** The data flow is strictly server→client: rankings change, clients observe. SSE gives auto-reconnection with `Last-Event-ID` for free from the browser's `EventSource`, rides plain HTTP (so every proxy, CDN, and load balancer already understands it), and multiplexes over HTTP/2. A WebSocket would add a bidirectional channel we have no use for, plus protocol-upgrade handling in every intermediary — complexity with no corresponding capability. Polling is simply arithmetic: 100K clients at a 5-second interval is 20K RPS of pure overhead to deliver an update that usually says "nothing changed."

The REST `GET /api/trending` serves the same cached blob, so a cache miss is structurally impossible in steady state — the worker writes the cache before anyone reads it.

## 🧮 Why Not a Stream Processor?

The textbook answer to "sliding-window aggregation over an event stream" is a stream-processing framework — Flink or Kafka Streams, with a windowed aggregation and a top-K operator. Kafka is already in our architecture. An interviewer should ask why I hand-rolled the window in Redis instead, and I'd want a better answer than "I didn't think of it."

| | ✅ Redis buckets (chosen) | ❌ Flink / Kafka Streams |
|---|---|---|
| Window mechanism | Bucket keys + TTL | Native windowed aggregation, watermarks, event-time semantics |
| Late/out-of-order events | Land in the bucket for their timestamp if it still exists; otherwise dropped | Handled properly via watermarks and allowed-lateness |
| Serving the result | Redis *is* the serving layer — the worker writes a blob everyone reads | Needs an external sink anyway; the framework doesn't serve reads |
| Operational surface | Redis + a cron-shaped worker | A cluster with checkpointing, state backends, savepoints, and rebalance semantics |
| Recovery | Buckets refill in 60 minutes. Nothing to restore | Checkpoint restore, state-backend recovery |

> "Flink is genuinely the *correct* tool if event-time correctness is a requirement — if a view that arrives 20 minutes late must still land in the right window, watermarks are the real answer and my TTL scheme just quietly drops it. But look at what we're producing: a top-10 list, refreshed every 5 seconds, where the underlying counts already tolerate a whole-bucket boundary jitter. A late view perturbs a ranking by nothing measurable. I'd be adopting a distributed stateful stream processor — with its checkpointing, its state backend, its rebalance storms, its whole operational personality — to correctly handle events whose correct handling doesn't change the output. That's the trade I'm refusing. And note that even with Flink I'd *still* need Redis or an equivalent in front of the read path, because a stream processor computes results, it doesn't serve 100K RPS of them. So the framework wouldn't replace a component; it would add one."

Where I'd change my mind: the moment the product wants **multiple window sizes** (5-minute, 1-hour, 24-hour trending simultaneously), or session-based windows, or exactly-once semantics on a downstream that actually cares. At that point I'd be reimplementing a stream processor badly, and the honest move is to adopt one rather than keep bolting windows onto Redis keys.

## 🔒 Rate Limiting and View Fraud

Rate limiting here is not primarily a capacity control — the ingest path is cheap and batched. It's an **integrity control**, defending the one number the product exists to publish.

| Layer | Limit | Scope | What it stops |
|-------|-------|-------|---------------|
| Dedupe window | 1 view per 10s bucket | (video, session) | Retries, double-taps, naive replay |
| Session rate limit | ~30 views/min | Per session | A single client hammering the endpoint |
| IP rate limit | ~300 views/min | Per IP | A script behind one address (also catches shared NAT, so it must be generous) |
| Per-video velocity | Anomaly threshold | Per video, global | The only layer that sees a *distributed* attack at all |
| Watch-time validation | Reject views without plausible playback telemetry | Per event | Bare "view" pings from a bot that never actually played anything |

The uncomfortable truth is that **the first three layers do not stop a competent attacker.** Session IDs are client-generated; rotate them. IPs are cheap; rent a botnet or a residential proxy pool. Any per-identity limit is defeated by acquiring more identities, and acquiring identities is a commodity purchase.

What actually works is the fourth layer, and it works because it doesn't depend on identity at all: **a video's view curve has a shape, and fabricated attention has a different shape than real attention.** Organic virality ramps — a video climbs as it gets recommended, shared, and re-shared, and the derivative is smooth. A botnet produces a step function: near-zero, then a plateau at whatever rate the attacker provisioned, then nothing. The attacker can defeat any single identity check; they cannot easily fake the *second derivative* of a hundred thousand independent humans discovering something.

> "I'd frame the rate limits as raising the price of the attack rather than preventing it — they force the adversary from 'a for-loop' to 'a distributed botnet with realistic pacing,' which is a genuinely different cost tier and eliminates the overwhelming majority of attempts. But I would not tell the interviewer I'd solved view fraud, because nobody has. The design commitment I *would* make is architectural: **the trending pipeline must be able to retroactively invalidate counted views.** That's why the raw `view_events` log exists with 7-day retention even though the ranking never reads it — when the fraud pipeline flags a video tomorrow, we need the receipts to recompute the window without it. A system that only keeps aggregates can detect fraud but can never undo it."

## 🔀 Consistency Model

Worth stating explicitly, because this system deliberately runs at several different consistency levels and the mismatches are intentional:

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| View counting | Eventual (up to ~1s from pre-aggregation flush) | A view's contribution appears within a flush cycle. Nobody can observe the difference |
| Trending ranking | Eventual (~5s) | The refresh interval *is* the consistency bound. The relaxation that funds the whole design |
| Video metadata | Strong | Ordinary transactional CRUD; there's no reason to relax it and no benefit if we did |
| Raw event log | Eventual, lossy | Explicitly best-effort. Gaps during a Kafka outage are acceptable |
| Lifetime `total_views` | Eventual, batch-drained | Displayed on the video page; drifts by seconds from the Redis hash and nobody notices |

The one place I'd *not* accept eventual consistency is the **ordering within a single computed ranking**. A ranking must be internally consistent — it must be derived from one atomic snapshot of the buckets, not assembled from reads taken across several seconds. Otherwise video A's score comes from 14:32:01 and video B's from 14:32:04, and they can be ordered wrongly relative to each other by an artifact of read timing rather than by anything real. That's why `ZUNIONSTORE` materializes a single temporary set that the heap then reads, rather than the worker streaming scores video-by-video.

## 🛡️ Failure Handling

| Component down | Behavior |
|----------------|----------|
| **Redis** | View recording fails (503) — there's nowhere to count. Trending **keeps serving** from the workers' in-process cache until it ages out. Recovery: rebuild `views:total` from PostgreSQL; the window buckets refill on their own within 60 minutes |
| **PostgreSQL** | Raw event logging stops; metadata reads fail. **Trending still works** — it never touches PostgreSQL. Hydration degrades to IDs-only or a stale local metadata cache |
| **Kafka** | Ingest servers still increment Redis, so the counting path is unaffected. The durable log gains a gap — acceptable, because it exists for forensics and recomputation, not for serving |
| **Trending worker stalls** | The insidious one. SSE clients stop receiving updates, `/api/trending` serves an ever-staler blob, and **the process is still happily alive.** Readiness must assert *"a cycle completed within the last N seconds,"* not "the process responds" |

That last row deserves the emphasis. A worker whose background loop silently died still passes a naive health check, and the failure is invisible: trending doesn't error, it just quietly freezes. Users see a plausible-looking ranking that happens to be three hours old. **Freshness has to be an explicit health signal**, because staleness is the one failure this system has that doesn't announce itself.

One pleasant property worth calling out: because the window is built from TTL'd buckets, **a total Redis wipe is not a data-loss event — it's a 60-minute warm-up.** There is nothing to restore. That falls directly out of choosing a design where the durable state is small and the hot state is disposable.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Trending cycle duration, and **time since last successful cycle** | The freshness SLO, and the only detector for the silent-stall failure above |
| View ingestion latency histogram (p99 < 50ms) | The write-path SLO |
| Duplicate-suppression rate, **per video** | Doubles as the fraud tripwire — a spike on one video is an attack in progress |
| `ZUNIONSTORE` duration | The scaling canary. When this creeps up, active cardinality is growing and the exact-counting decision is nearing its expiry date |
| Redis memory + ops/sec on the hottest key | Verifies that pre-aggregation is still collapsing the hot key |
| Ingest-server flush size (events per distinct video) | If this drops toward 1, pre-aggregation has stopped buying anything and the fan-in ratio needs re-tuning |
| SSE connections per gateway | A connection cliff means a gateway died and a reconnect herd is inbound |

Structured JSON logs with request IDs throughout. The ranking snapshots in PostgreSQL are the audit trail: when a creator asks "why did my video drop out of trending at 3pm," the answer has to be reconstructible, and "we recompute every 5 seconds and don't keep the results" is not an answer anyone accepts.

The metric I'd watch most nervously is **time since last successful trending cycle**, and it's worth explaining why it beats the more obvious "cycle duration." Duration tells you a cycle was slow. Freshness tells you a cycle *didn't happen* — which is the failure that actually occurs, because a worker doesn't usually get gradually slower, it gets stuck. A hung Redis call, a wedged event loop, an unhandled rejection that killed the interval: in every one of those, cycle duration reports nothing at all, because no cycle finished to be measured. **You cannot detect an absence by measuring the things that are present.** So the alert has to be on the gap, and its threshold has to be tight — a few multiples of the interval, not minutes — because every second past it, we are confidently serving a stale ranking as if it were live.

Health checks are the standard three per service. The non-obvious one is the trending worker's readiness probe, which must assert freshness rather than liveness. A process that is up, answering HTTP, connected to Redis, and doing absolutely nothing will pass every naive check ever written.

## 📈 Scalability: What Breaks First

1. **The hot bucket key in Redis.** The `all` category's current-minute sorted set takes every view — single-threaded, single-shard, un-shardable by definition. This is the first wall, and it's why in-process pre-aggregation isn't an optimization but a load-bearing part of the design. When even the flushed rate saturates one node, the next move is to **shard the bucket itself**: keep `views:bucket:all:{minute}:{shard}` across 16 shards with ingest servers hashing by video ID, and have the worker union all shards. The union work grows 16× — and the union runs on a background worker, so it doesn't matter.

2. **`ZUNIONSTORE` over 60 buckets.** The aggregation cost grows linearly with active videos per category. Fine at ~5K members; painful at 5M. This is the trigger for the Space-Saving migration, and I'd instrument for it (see the union-duration metric) rather than wait to be surprised by it.

3. **`view_events` writes to PostgreSQL.** 2B inserts/day is ~23K/sec sustained, well past what one primary handles for an indexed table. Kafka is already the buffer; the consumer batches inserts, and the table is **time-partitioned by day** so 7-day retention is a `DROP PARTITION` rather than a two-billion-row `DELETE` that would trigger a vacuum catastrophe. At real scale this table doesn't belong in PostgreSQL at all — it's an append-only analytical log scanned by time range, which is ClickHouse's exact shape.

4. **SSE connections.** ~10K per gateway means a dedicated SSE tier behind the Redis pub/sub fan-out. Gateways are stateless, so this scales horizontally and near-linearly. Plan for the **reconnect herd**: when a gateway dies, 10K clients reconnect at once and each immediately fetches the current ranking — which is a cached blob, so the herd is absorbed by construction.

5. **Trending compute across categories.** Categories are fully independent, so this is embarrassingly parallel — partition categories across workers. The thing to alert on is cycle time *approaching* the interval, not exceeding it: once a cycle takes longer than 5 seconds, the worker falls permanently behind and freshness degrades without any component reporting an error.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Window mechanism | ✅ Time-bucketed sorted sets + TTL | ❌ Scan raw events / single counter | The window slides for free via expiry; scanning can't finish, a plain counter never decreases |
| Bucket granularity | ✅ 1 minute | ❌ 10s / 15min | 10s multiplies keys for imperceptible precision; 15min makes the ranking visibly lurch |
| Counting | ✅ Exact | ❌ Count-Min Sketch | CMS bounds *magnitude* error; we publish *rank*, and the two decouple exactly at the K-boundary |
| If cardinality explodes | ✅ Space-Saving | ❌ Count-Min Sketch | SS gives top-K *membership* guarantees — approximate in the dimension we actually care about |
| Top-K extraction | ✅ Min-heap, size K | ❌ Full sort | O(N log K) vs O(N log N); irrelevant today, decisive at 100× |
| Write path | ✅ In-process pre-aggregate, 1s flush | ❌ Direct `ZINCRBY` per event | Collapses the hot key ~600×. Safe *only because* one view event is disposable |
| View dedupe | ✅ Redis `SETNX`, 10s session bucket | ❌ PostgreSQL unique constraint | Hot-path dedupe must be sub-millisecond; the database isn't on this path at all |
| Real-time push | ✅ SSE | ❌ WebSocket / polling | Unidirectional data, free reconnection, proxy-transparent. Polling is 20K RPS to say "nothing changed" |
| Publish policy | ✅ Diff, publish only on change | ❌ Broadcast every cycle | Rankings are far more stable than the counts beneath them |
| Trending's dependencies | ✅ Redis only | ❌ Redis + PostgreSQL | PostgreSQL can be down and trending still works — a deliberate blast-radius choice |
| Event log retention | ✅ Time-partitioned, `DROP PARTITION` | ❌ Row-level `DELETE` sweep | 2B rows/day makes row-wise deletion a vacuum catastrophe |

## 🚀 Closing: What I'd Build Next

Three threads. **Fraud detection as a first-class pipeline** rather than a rate limit — the duplicate-suppression metric is a tripwire, but the real defense is modeling the *shape* of a view curve, because organic virality ramps and botnets step. **Geographic and personalized trending**, which multiplies the ranking dimensions and forces the question of whether you compute the cross-product (you can't) or restructure aggregation around per-video counters with per-segment filters. And **moving the raw event log out of PostgreSQL into ClickHouse**, because it is an append-only analytical table we only ever scan by time range — which is to say, it is in the wrong database today and I know it.

The thing I'd want to leave the interviewer with: the two decisions that define this system are both about **which requirement to treat as weak.** Ranking freshness is weak, so everything expensive moves off the request path onto a 5-second worker. Single-event durability is weak, so 115K writes/sec collapse into a batched trickle. Meanwhile the one requirement I refused to relax — *exact ordering* — is the one everyone's instinct says to approximate, and it's precisely the one the product cannot survive being wrong about.
