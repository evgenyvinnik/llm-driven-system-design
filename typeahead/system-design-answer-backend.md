# Typeahead — System Design Answer (Backend Focus)

*Staff backend engineer interview · 45–50 minutes · structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework) adapted to the server side: Requirements → Architecture → Data model → Interface → Optimizations*

> "Query autocomplete is one of the highest-QPS endpoints a search company runs. Every request has a budget of a few tens of milliseconds, and the corpus changes continuously. The design I'd defend precomputes aggressively, serves from immutable in-memory snapshots, gives freshness its own retrieval path, and treats safety takedowns as a serve-time concern. Most of the interesting decisions are about what *not* to do on the read path."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~5 min | Scope, targets, capacity math that rules out the naive design |
| A — Architecture | ~8 min | Serving plane vs build plane; partition by locale; one connected diagram |
| D — Data model | ~5 min | Events, derived stats, immutable index artifacts, personal and policy stores |
| I — Interface | ~6 min | External contract built for caching; internal RPCs with deadlines; publish protocol |
| O — Optimizations | ~20 min | Three deep dives: index structure, freshness, serving under load and takedowns |
| Wrap-up | ~2 min | What breaks first, trade-offs |

---

## 🎯 R — Requirements Exploration (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Query completion for web search, or entity search over a catalog? | Query completion derives its corpus from query logs; catalog search indexes a product table | Web search query completion |
| Scale and markets? | QPS, corpus size, partitioning | 1B searches/day across ~30 locales |
| Personalization? | Determines cacheability | Signed-in users get their own history blended in |
| How fresh? | Batch-only vs streaming | Breaking news within ~5 minutes; everything else hourly is fine |
| Safety and legal? | Where filtering must happen | Strict: no defamation, sexual content or personal data; legal takedowns live within a minute |
| Privacy? | Which phrases may enter the index at all | No suggestion may reveal an individual's query; enforce a distinct-user threshold |
| Typo tolerance? | A second retrieval path | Nice to have; I'll sketch it but not design it in depth |

### Functional requirements

1. Return the top k (8–10) completions for a prefix in a locale.
2. Blend the signed-in user's own history.
3. Surface emerging queries within minutes.
4. Enforce safety policy and legal takedowns globally within a minute.
5. Record impressions and selections to feed ranking and evaluation.

### Non-functional requirements

| Property | Target | Note |
|----------|--------|------|
| Origin latency | p99 < 20 ms | Leaves room for the network inside a ~100 ms user-perceived budget |
| Availability | 99.99% | A degraded response (global-only, or empty) counts as available; a 5xx doesn't |
| Freshness | Trending ≤ 5 min; base corpus ≤ 1–2 h | Two tiers, two cadences |
| Takedown | ≤ 60 s to every serving node and edge cache | Can't wait for an index rebuild |
| Event delivery | At-least-once | Counts feed thresholds and rankings, not billing |
| Privacy | A phrase appears only if ≥ N distinct users (say 50) searched it in the window | Also a memory control: it removes the long tail of singletons |

### Capacity estimation

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Suggest requests | ~5B/day ≈ 58K QPS average, ~175K peak | 1B searches × ~5 requests each after client debounce and caching; 3× peak factor |
| Origin QPS | ~100K peak | Edge cache absorbs ~40%, nearly all of it short prefixes |
| Event stream | ~50–100 MB/s into the log | Searches, sampled suggest impressions, selections |
| Indexed phrases | ~100M for the largest locale (en), ~300M overall | After the distinct-user threshold over a 90-day window |
| Largest locale as a pointer trie with top-10 at every node | ~60 GB+, ~700M heap objects | ~700M nodes × (node overhead + ten 4-byte ids) |
| Same locale as a compact sorted structure | ~1.5 GB | Front-coded strings ~1 GB, scores ~400 MB, succinct RMQ ~25 MB (deep dive 1) |

> "The last two rows drive the architecture. At 60 GB per locale I'd be forced to shard and fan out. At 1.5 GB a whole locale fits on every replica, so I replicate for throughput and never scatter-gather."

---

## 🏗️ A — Architecture / High-Level Design (~8 min)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ CLIENTS  web · iOS · Android (debounced, prefix-cached requests)                         │
└─────┬────────────────────────────────────────────────▲───────────────────────────────────┘
      │ GET /v1/suggest?q=&locale=                     │ items · Cache-Control · index_version
┌─────▼────────────────────────────────────────────────┴───────────────────────────────────┐
│ EDGE / CDN  anonymous (locale, prefix) cache · request coalescing · SWR · rate limiting  │
└─────┬────────────────────────────────────────────────▲───────────────────────────────────┘
      │ miss or signed-in                              │ response (public or private)
┌─────▼────────────────────────────────────────────────┴───────────────────────────────────┐
│ SUGGEST SERVICE (stateless, per region)                                                  │
│ normalize → candidate cache → parallel fan-out (deadline 15 ms) → blend → policy → top-k │
└─────┬──────────────────┬───────────────────┬──────────────────────┬──────────────────────┘
      │ TopK base        │ TopK fresh        │ user history         │ rule snapshot
┌─────▼────────────┐ ┌───▼──────────────┐ ┌──▼─────────────────┐ ┌──▼──────────────────────┐
│ Base index       │ │ Fresh index      │ │ Personal store     │ │ Policy rules            │
│ replicas         │ │ replicas         │ │ KV by user id      │ │ in-memory copy          │
│ mmap snapshot    │ │ rebuilt each min │ │ authoritative      │ │ pushed ≤ 60 s           │
└─────▲────────────┘ └───▲──────────────┘ └────────────────────┘ └──▲──────────────────────┘
      │ pull · verify    │ pull                                     │ push + CDN tag purge
      │ · warm · swap    │                                          │
┌─────┴──────────────────┴─────────────────────┐                ┌───┴──────────────────────┐
│ ARTIFACT STORE + ROLLOUT CONTROLLER          │                │ POLICY SERVICE           │
│ immutable versions · manifest · canary       │                │ versioned rules · audit  │
└─────▲──────────────────▲─────────────────────┘                └──────────────────────────┘
      │ publish          │ publish
┌─────┴────────────┐ ┌───┴──────────────────┐
│ Base builder     │ │ Fresh builder        │
│ hourly · gates   │ │ every minute · gates │
└─────▲────────────┘ └───▲──────────────────┘
      │ batch scan       │ velocity candidates
┌─────┴────────────┐ ┌───┴──────────────────┐
│ Data lake        │ │ Stream processor     │
│ authoritative    │ │ windows · sketches · │
│ query history    │ │ HLL distinct users   │
└─────▲────────────┘ └───▲──────────────────┘
      │ archive          │ consume
┌─────┴──────────────────┴─────────────────────┐
│ EVENT LOG (Kafka)  query + selection events  │◀── POST /v1/events · results-page logs
└──────────────────────────────────────────────┘
```

**Walking the diagram:**

1. **Read path.** An anonymous request for a short prefix is usually answered at the edge. On a miss, or for a signed-in user, the stateless suggest service normalizes the prefix (NFKC, locale-aware case folding, whitespace collapsing, trailing space kept) and checks an in-process **candidate cache** of the global candidates for that prefix.
2. On a candidate-cache miss, it fans out in parallel to the **base index** and the **fresh index**. For signed-in users it also reads the **personal store**, all under a 15 ms deadline. Optional dependencies that miss the deadline are dropped, never waited for.
3. It blends the candidates and applies the **policy filter as the last step on every response**, then truncates to k. Anonymous responses are marked `public` with surrogate keys for purging; personalized ones are `private`.
4. **Write path.** Search and selection events go to Kafka. The **stream processor** keeps per-minute windows and sketches and emits velocity candidates. The **fresh builder** turns those into a small index every minute.
5. The **data lake** is the authoritative history. The **base builder** recomputes decayed scores hourly, applies privacy and safety gates, builds an immutable artifact, validates it, and publishes a manifest.
6. The **rollout controller** canaries each version. Replicas pull it, verify the checksum, warm it, and swap atomically, keeping the previous version mapped for rollback.
7. **Takedowns** bypass the build entirely: the policy service pushes a new rule version to every suggest node and purges edge entries by surrogate key.

### Three architectural decisions

**Separate the serving plane from the build plane.** The read path never takes a lock, never waits on a write, and never does I/O for the index itself. Indexes are derived, disposable artifacts that can be rebuilt from the lake. Kafka plus the lake is the source of truth, so a bad build is fixed by rolling back and rebuilding, not by repairing data in place.

**Partition by locale and replicate whole locales.** Each locale's index fits in RAM on one node, so routing is by locale and a request touches exactly one replica of each index.

| Partitioning | Pros | Cons |
|--------------|------|------|
| ✅ By locale, full replicas | No scatter-gather; matches real traffic boundaries; trivially multi-region | Small locales waste a little memory per replica |
| ❌ By first character | Simple to explain | 50×+ skew between letters; meaningless for CJK (thousands of first characters); the real hotspot is temporal (one news prefix), not alphabetical |
| ❌ Hash of full phrase | Even distribution | Every prefix query must fan out to all shards; p99 becomes the slowest of N |

If a single locale ever outgrew RAM, I'd range-partition it by prefix, with split points chosen from traffic rather than the alphabet. A prefix then maps to one range, except at split boundaries.

**Freshness gets its own retrieval path.** I'll argue this in deep dive 2. In short, ranking can't surface what retrieval didn't return.

---

## 💾 D — Data Model (~5 min)

| Store | Key | Fields | Authority and lifetime |
|-------|-----|--------|------------------------|
| Kafka `query-events` | partitioned by hash(session) | event id, timestamp, locale, salted user hash, typed prefix, final query, suggestion ids shown with positions, selected position, index version, client | At-least-once; 7-day retention; deduped by event id downstream |
| Data lake | daily partitions | raw and sessionized events | Authoritative history; 90-day scoring window; runs privacy-deletion jobs |
| `phrase_stats` (batch output) | (locale, normalized phrase) | decayed score, 7/30/90-day counts, distinct users (HLL), first/last seen, safety labels | Derived; recomputed every build |
| Base index artifact | (locale, version) | front-coded sorted phrase table, score array, RMQ structure, display forms; manifest with source watermark, row count, checksum | Immutable; last N versions kept for rollback |
| Fresh index artifact | (locale, minute) | ≤100K phrases with velocity scores, same format as base | Immutable; superseded every minute |
| Trending state | (locale, window) | heavy-hitter summary, count-min sketch, per-candidate HLL, baseline rate | Stream-processor state; checkpointed |
| Personal history | user id | last 500 queries: normalized and display text, last used, count | Authoritative; user-deletable; KV store (Bigtable / Cassandra class) |
| Policy rules | rule id | match type (exact / prefix / token / entity + predicate), scope, action (drop / demote), reason, author, expiry | Authoritative in the policy service; versioned; replicated to every node |

Data decisions worth saying out loud:

- **A phrase id is its lexicographic rank in the sorted table.** A prefix is then a contiguous id range found by binary search, and scores live in a parallel array indexed by id. Deep dive 1 relies on this.
- **Scoring is computed at build time:** an exponentially time-decayed count (half-life ~7 days) blended with long-term popularity, log-damped and normalized per locale. The online path adds only cheap features: freshness tier, personal match, prefix match quality.
- **Privacy is enforced by the builder, not the server.** Distinct users ≥ N, and PII patterns (emails, phone numbers, ID numbers) excluded. That's also why a brand-new phrase can't appear instantly even in the fresh tier: it needs enough distinct people first. A user's deletion request removes their history and events; because the index only holds aggregates above a threshold, their next rebuild excludes their contribution without special handling.

---

## 🔌 I — Interface Definition (~6 min)

### External API

```
GET    /v1/suggest?q={prefix}&locale={l}&limit={k}&client={c}  → top-k completions
POST   /v1/events                                              → batched impressions/selections (202, idempotent by event id)
GET    /v1/history?limit={n}                                   → the signed-in user's recent queries
DELETE /v1/history/{id}     DELETE /v1/history                 → delete one / all; purges personal caches
```

| Response element | Purpose |
|------------------|---------|
| `q` (normalized echo) | The client checks it before rendering; it also makes the normalization contract explicit |
| items: id, display text, kind, match ranges, badges | Ranges because only the server knows what its normalization matched |
| `index_version` | Joins selections to the version that produced them; part of the edge cache identity |
| `complete` flag | Tells the client the set is exhaustive, so it can filter longer prefixes locally |
| `Cache-Control` | Anonymous: `public, s-maxage=300, max-age=60, stale-while-revalidate=60`. Personalized: `private, max-age=30` |
| `Surrogate-Key` | Locale, prefix, and every phrase id in the response, so one tag purge removes a phrase everywhere |

> "The external API is a GET with query parameters specifically because the URL is the cache key. That's what lets the edge absorb ~40% of traffic. Internally I'd use gRPC; externally, cacheability wins."

### Internal interfaces

```
Index.TopK(locale, prefix, k)                     → [(phrase_id, score)]          deadline 5 ms, hedged
Fresh.TopK(locale, prefix, k)                     → [(phrase, velocity)]          deadline 5 ms, optional
Personal.Recent(user, prefix, n)                  → [(phrase, last_used, count)]  deadline 10 ms, optional
Builder → Artifacts.Publish(manifest)             → version accepted / rejected by gates
Rollout → Replica.Load(locale, version)           → ack(version, warmed)  |  Replica.Rollback(version)
Policy.Push(rules_version) → all suggest nodes    → applied-version heartbeat; CDN purge by surrogate key
```

Semantics I'd make explicit:

- **Deadlines and optionality are part of the contract.** Base is required. Fresh and personal are best-effort. The suggest service owns a 15 ms internal budget and returns what it has.
- **Publishing is all-or-nothing per version.** A replica serves version V only after verifying the checksum and warming every page. It reports the version it's serving, so the controller can tell when the fleet has converged.
- **Events are idempotent by id.** At-least-once delivery plus dedupe inside each window, so a replayed batch can't inflate a phrase past a threshold.

---

## 🔧 O — Optimizations and Deep Dives (~20 min)

> "Three deep dives: the index structure and why it's immutable; freshness, where the subtle bug is a recall ceiling rather than a latency problem; and serving under load, including takedowns."

### Deep dive 1: The serving index — structure, memory and immutable snapshots (~7 min)

| Structure | Lookup | Memory (en, 100M phrases) | Updates | Verdict |
|-----------|--------|---------------------------|---------|---------|
| Pointer trie, top-k precomputed at every node | O(L) | ~60 GB+, ~700M objects | In place, needs locking | ❌ |
| Pointer trie, top-k only at heavy nodes, traverse small subtrees | O(L) + bounded walk | ~30 GB | In place | ❌ still pointer-heavy |
| Search engine completion suggester (FST in segments) | ~1–5 ms + a network hop | Moderate | Near-real-time | ❌ for this path: segment merges and an extra hop hurt p99. Good for catalog search |
| ✅ Sorted phrase array + range-maximum query (RMQ) over scores | O(L log n) + O(k log k) | ~1.5 GB | Rebuild and swap | ✅ |

**How the sorted-array index answers top-k:**

1. Phrases are sorted lexicographically after normalization; the id is the position.
2. A prefix maps to a contiguous id range found with two binary searches. Strings are front-coded in blocks of 16, so the search runs over block headers and then a short scan.
3. RMQ returns the highest-scoring position in any range in O(1). Push the whole range's maximum into a heap; each time you pop one, split its range around it and push the maxima of the two halves. k pops give the top k in O(k log k).
4. A succinct RMQ costs about two bits per phrase. Top-k for *every* prefix is implicit, with no per-node lists.

> "The textbook answer, a trie with the top 10 stored at every node, is right about the core idea: precompute so the shortest, most frequent prefixes don't trigger a subtree walk. It's wrong about the representation at this scale. Precomputed lists cost memory proportional to nodes × k. RMQ gets the same O(prefix) behavior with O(n) bits."

**Why flat and immutable matters as much as the asymptotics:**

- **Garbage collection is the real p99 risk.** Seven hundred million small objects in a JVM or V8 heap means long collector pauses. The p99 cliff wouldn't come from the lookup; it would come from the collector. Flat arrays in an mmap'd file are invisible to the GC and live in the OS page cache.
- **Lock-free reads and instant restarts.** A version is a read-only file, and swapping is an atomic pointer flip. A restarted process maps the file and serves within seconds instead of rebuilding from a database, which is what the local demo does on every start.
- **Determinism.** Every replica at version V answers identically. Edge caching stays coherent, and "why did X appear for prefix Y?" is answered by loading V on a laptop.
- **Rollback is a pointer flip** to the previous mapped version.

**A bad index deployed everywhere is worse than a stale one.** So publishing is gated:

- **Builder gates:** row count within ±10% of the previous version; result overlap for the top 1,000 prefixes above a Jaccard threshold; a full scan against current policy rules; checksum.
- **Rollout:** one canary replica per region. Compare empty-result rate, selection rate and latency for ~10 minutes, then roll out to the fleet.
- **Failure mode:** if a build fails, the fleet keeps serving the last good version and we alert when index age exceeds three hours. Stale suggestions are a minor incident; wrong ones are a major one.

What I give up: no in-place updates (freshness needs the second tier), a real build pipeline, and infix matching ("york" → "new york"). Infix matching would need extra entries for each word-boundary suffix, about 3× the rows, so it's a v2 decision.

### Deep dive 2: Freshness — base + fresh tiers and the candidate-generation ceiling (~7 min)

**The subtle bug: ranking can only reorder what retrieval returns.** A common design keeps one index and applies a trending boost to its top-k at query time; our local demo does exactly this with a 0.20 weight. But "earthquake lisbon", searched for the first time four minutes ago, isn't in the base index's top 10 for "ear". It may not be in the index at all. No boost can surface a candidate that was never retrieved. Freshness is a **recall** problem, so it needs its own retrieval path.

**Fresh tier pipeline:**

1. **Counting at high cardinality.** Hundreds of millions of distinct strings per hour, mostly singletons. Exact per-phrase counters in minute windows would be enormous and mostly wasted. Per locale and window, keep a heavy-hitter summary (Space-Saving, top few thousand), a count-min sketch for estimates, and a HyperLogLog of distinct users per candidate.
2. **Velocity, not volume.** "weather" is huge every day and is not trending. Score each candidate by its current rate against its expected rate: the base-index baseline adjusted for hour of day, with additive smoothing so 1 → 5 searches doesn't read as a 5× spike.
3. **Gates, stricter than the base tier.** At least ~200 distinct users in 10 minutes, bot-filtered traffic only, policy rules plus a classifier. Phrases matching *entity + negative predicate* ("<person> arrested", "<person> dead") go to human review or need much higher thresholds. This tier is where coordinated manipulation and death hoaxes happen, and it carries the most liability.
4. **Every minute**, the fresh builder emits ≤100K phrases in the *same artifact format* as the base index. Replicas load it like any snapshot, and the code path is shared.
5. **Merge at read time:** base top-k ∪ fresh top-3, with scores calibrated onto one scale. Fresh items are capped at two of eight slots unless velocity is extreme, and their boost decays over hours as the next base builds absorb them.

| Approach | Freshness | Risk | Cost |
|----------|-----------|------|------|
| ❌ Mutate one in-memory trie from a write buffer | Seconds | Locks or copy-on-write in the hot path; each replica buffers separately and they diverge; no rollback | Lowest infrastructure |
| ❌ Rebuild the full base index every minute | 1–2 min | 100M-phrase builds per locale per minute; the gates can't keep up | Very high compute |
| ✅ Hourly immutable base + per-minute fresh tier merged at read | 2–5 min | Two-source merge and score calibration | Small: the fresh corpus is tiny |

Replica divergence is worth spelling out. In the mutate-in-place design, three instances each buffer what they saw and apply it to their own trie, so the same prefix returns different lists depending on which instance you hit. That breaks edge caching and debugging. Here every replica loads the same artifact, so they're identical by construction.

**Delivery semantics.** I don't need exactly-once. At-least-once delivery with event-id dedupe inside windows is enough, because counts feed thresholds and rankings. Events later than the watermark are dropped from the fresh tier, but still land in the lake for the next base build.

### Deep dive 3: Serving under load — caching, personalization, tail latency and takedowns (~6 min)

**Caching that matches the request distribution.**

- **Edge:** keyed by (locale, normalized prefix). Prefixes of 1–3 characters are a tiny keyspace, about 50K keys per Latin-script locale, and they're the most frequent requests, so their hit rate is effectively 100%. Long-tail prefixes rarely hit. Request coalescing (one origin fetch per key on expiry) plus stale-while-revalidate prevents a thundering herd when a hot key expires during a news spike.
- **Origin candidate cache.** Personalization makes the full response private, but the *global candidate set* for a prefix (base ∪ fresh) is identical for everyone. Cache that in-process (~1M entries, 30 s TTL) and blend the personal layer on top, so signed-in traffic still shares the expensive part. The local demo makes the same move (cache unranked candidates, rank after the read) but then does two Redis round trips *per candidate* for personal and trending scores. The fix: one batched personal-history fetch per request, and trending comes from the fresh index rather than a per-candidate lookup.
- **Personal blend:** prefix-match the user's ≤500-entry history in memory, boost by recency and frequency, and cap personal items at three of eight slots so global intent still shows. Deletion must take effect immediately, so personal results are never cached beyond a short private TTL, and `DELETE /history` evicts the user's entries.

| Where personalization happens | Pros | Cons |
|-------------------------------|------|------|
| ✅ Server blend on top of a shared candidate cache | Cross-device history; can use server-only signals; global work stays shared | Signed-in responses can't be edge-cached |
| ❌ Personalized end-to-end ranking keyed by user | Richest model | Cache per user per prefix means near-zero hit rate; full cost on every keystroke |
| ❌ Client-only blend of local recents | Response stays public and cookieless | No cross-device history, no server signals. Still a good complement for recents, as in the frontend design |

**Tail latency.**

- Fan-out makes p99 the slowest of the dependencies, so each gets its own deadline and the optional ones are dropped at that deadline.
- **Hedged requests:** if the base replica hasn't answered by its p95 (~3 ms), send the same lookup to a second replica and take the first response. Lookups are idempotent and cheap, so ~5% extra load cuts p99 sharply (the "tail at scale" pattern).
- **Load shedding in quality order:** shed personal first, then fresh, then serve stale candidate-cache entries, and as a last resort return an empty list (the client shows recents). Never let 5xx storms trigger client retries that amplify the overload.

**Takedowns within 60 seconds.**

- Policy is enforced **at serve time as the final filter on every response**, not only in the builder. Builds take an hour, and edge caches hold copies for minutes.
- Rules are versioned and pushed to every suggest node. Nodes heartbeat the version they've applied, and any node lagging more than a minute pages on-call.
- **Purging by surrogate key.** Every response carries the ids of the phrases in it, so blocking phrase P purges every cached prefix response that contains it with one tag purge. The alternative is enumerating all L prefixes of P across every locale and parameter combination.
- The next base build excludes P too (defense in depth). A client-side bound remains: browser caches may hold the phrase for up to `max-age` + SWR (two minutes here), which is why those are kept short.

**Abuse is a data problem as much as a traffic problem.** Rate limits at the edge stop scrapers, but the bigger threat is *poisoning the corpus*. Bot-classified traffic is therefore excluded from counting entirely, not just rate-limited, and distinct-user thresholds mean one actor with many requests counts once.

### Failure handling (~1 min)

| Failure | Detection | Behavior |
|---------|-----------|----------|
| Base replica crashes | Health check; the hedge absorbs it immediately | Load balancer drops it; the restarted process maps the current version and is serving within seconds |
| Builder emits a bad index | Publish gates; canary metrics | Rejected before rollout, or rolled back by a pointer flip; the fleet stays on the last good version |
| Kafka consumer lag | Lag on the fresh-tier watermark | Fresh tier goes stale and is suppressed after 15 minutes; the base tier is unaffected |
| Personal store slow | Deadline misses | Global-only responses; nobody sees an error |
| Policy push stalls on a node | Applied-version heartbeat | Page on-call; drain the node from the load balancer rather than let it serve unfiltered |
| Region loss | Edge health | DNS/anycast shifts traffic; every region holds full replicas, so only capacity is at stake |

### Typo tolerance (sketch)

A secondary path, run only when the primary result is thin (fewer than k results, or weak scores) so it never costs anything on the common path. For prefixes of four or more characters, a symmetric-delete index over the last token finds candidates within edit distance 1, weighted by keyboard adjacency. Corrected results are tagged so the client can render "Showing results for…". It's a separate artifact with the same build-and-publish lifecycle.

---

## 📈 What Breaks First and How It Scales (~2 min)

| Pressure | First symptom | Response |
|----------|---------------|----------|
| Origin QPS | CPU on suggest nodes | Stateless; scale horizontally; raise the edge TTL for short prefixes |
| Index build time | Base builds exceed their hourly slot | Parallelize by locale and id range; merge sorted runs |
| Locale outgrows RAM | Replica memory pressure | Traffic-chosen range partitions within the locale |
| News spike | Hot keys at the edge and in the fresh tier | Coalescing + SWR at the edge; the fresh tier is tiny and replicated everywhere |
| Multi-region | Artifact distribution lag | Replicate artifacts to each region's blob store; serving is regional and read-only, so active-active is trivial |

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Index representation | Sorted array + succinct RMQ, mmap | Pointer trie with top-k per node | ~1.5 GB vs ~60 GB; no GC pressure |
| Index mutability | Immutable versioned snapshots | In-place updates | Lock-free, deterministic, instant rollback |
| Partitioning | By locale, full replicas | First-character shards | No fan-out; no alphabet skew |
| Freshness | Separate fresh tier merged at read | Trending boost on base top-k | A boost can't surface unretrieved phrases |
| Trending signal | Velocity vs baseline with sketches | Raw windowed counts | Detects bursts, not perennial volume |
| Personalization | Server blend over a shared candidate cache | Per-user ranked cache | Keeps the expensive work shared |
| Tail latency | Deadlines + hedging + quality shedding | Retries | Bounded p99 without amplifying load |
| Safety | Serve-time filter + surrogate-key purge | Build-time filtering only | Takedown in seconds, not an hour |
| External API | HTTP GET | gRPC / GraphQL | The URL is the edge cache key |
| Event delivery | At-least-once + dedupe | Exactly-once | Counts feed thresholds, not billing |

---

## 📝 Wrap-up (~2 min)

> "In summary: two planes, a read path built entirely on immutable, locale-replicated in-memory snapshots, and a build path that can be rebuilt from the log at any time. The textbook trie is replaced by a structure that fits in 1.5 GB and doesn't fight the garbage collector. Freshness gets its own retrieval tier because ranking can't fix recall. Safety is enforced where it can act in seconds. If I had more time, I'd go into learning-to-rank from selection logs. The catch there is position bias: users click what we already put on top, so training on raw clicks reinforces the current ranker. You need a small randomized exploration slice or interleaving experiments to get unbiased signal."

### How the local implementation compares

The repo's `backend/` is a single Express process. It holds an in-heap pointer trie with top-10 lists at every node (`data-structures/trie.ts`), rebuilt from Postgres `phrase_counts` on startup. Redis caches unranked candidates for 60 s, and `ranking-service.ts` applies five hand-set weights with per-candidate Redis lookups. `aggregation-service.ts` buffers counts in process and flushes to Postgres and the trie every 30 s, and trending is a 5-minute Redis zset applied as a boost to the trie's top-k. So the demo is the "mutate one in-memory trie" row of deep dive 2: no sharding, no immutable artifacts, and multiple instances diverge. It's a faithful small-scale model of the read-path ideas (precomputed top-k, caching candidates before personalization, buffered writes), and this answer describes what it would grow into.
