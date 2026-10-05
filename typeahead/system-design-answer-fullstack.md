# Typeahead — System Design Answer (Full-Stack Focus)

*Staff full-stack engineer interview · 45–50 minutes · structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations*

> "In a typeahead, latency is won or lost at the boundaries between layers. The client decides how many requests exist. The API contract decides which of them can be cached. The index decides what the remaining ones cost. I'll spend most of the time on those contracts, because they're what a full-stack owner can design that a frontend or backend specialist working alone usually can't."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~5 min | Scope, an end-to-end latency budget, capacity |
| A — Architecture | ~8 min | One diagram from keystroke to index and back, plus the feedback loop |
| D — Data model | ~5 min | Entities per layer; normalization as a shared contract |
| I — Interface | ~7 min | A cache-shaped API; the component and internal interfaces |
| O — Optimizations | ~18 min | Latency budget, index + freshness, personalization/safety/feedback loop |
| Wrap-up | ~2 min | Trade-offs and what I'd validate first |

---

## 🎯 R — Requirements Exploration (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Assumption | Design consequence |
|----------|------------|--------------------|
| Product? | Web search query completion; the component is reused by other surfaces | Corpus comes from query logs; headless client component |
| Scale? | 1B searches/day, ~30 locales | Edge caching and replicated in-memory indexes |
| Personalization? | Signed-in users see their own history | Must not destroy cacheability |
| Freshness? | Breaking news within ~5 min; the rest hourly | Two index tiers |
| Safety? | Legal takedowns live within a minute; no PII in suggestions | Serve-time filtering, bounded client caches |
| Clients? | Desktop and mobile web, p75 mid-range Android on 4G; CJK and RTL locales | IME handling, small JS, preconnect |

### Functional requirements

1. Ranked completions as the user types, with the matched portion highlighted.
2. Zero state on focus: recent searches (removable) and trending.
3. Full keyboard, pointer and touch interaction; selecting a suggestion opens the results page.
4. Emerging queries appear within minutes; blocked phrases disappear within a minute.
5. Impressions and selections are logged to improve ranking.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Keystroke → suggestions painted | Same frame on a client cache hit; p75 < 150 ms on 4G otherwise |
| Origin latency | p99 < 20 ms |
| Network efficiency | ≤ ~0.4 requests per keystroke |
| Availability | 99.99%. Degraded responses (global-only, empty) count as available |
| Freshness / takedown | Trending ≤ 5 min; takedown ≤ 60 s server-side, ≤ 2 min including browser caches |
| Accessibility | WCAG 2.2 AA, APG combobox pattern |

### Capacity snapshot

| Quantity | Estimate |
|----------|----------|
| Suggest requests | 1B searches × ~5 requests ≈ 5B/day → ~175K QPS peak |
| Origin QPS | ~100K peak after ~40% edge hits |
| Indexed phrases | ~100M in the largest locale, after a distinct-user privacy threshold |
| Index memory | ~1.5 GB per locale in a compact structure vs ~60 GB as a pointer trie (deep dive 2) |

---

## 🏗️ A — Architecture / High-Level Design (~8 min)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                  │
│ ┌─────────────────┐         ┌─────────────────────┐         ┌──────────────────────────┐ │
│ │ Search input    │──keys──▶│ Controller          │─request▶│ Data access layer        │ │
│ │ role=combobox   │◀─render─│ activeId · status   │◀─merged─│ scheduler · seq guard    │ │
│ │                 │         │                     │         │ prefix cache · recents   │ │
│ └─────────────────┘         └─────┬───────────────┘         └───────┬─────────▲────────┘ │
│                                   │ select                          │ GET ?q= │ q · items│
│ ┌────────────────────┐            │                                 │         │          │
│ │ Selection effects  │◀───────────┘                                 │         │          │
│ │ navigate → results │                                              │         │          │
│ │ record recent      │                                              │         │          │
│ │ queue beacon       │                                              │         │          │
│ └───────┬────────────┘                                              │         │          │
│         │                                                           │         │          │
│         │                                                           │         │          │
└─────────┼───────────────────────────────────────────────────────────┼─────────┼──────────┘
          │ POST /v1/events (beacon)                                  │         │
┌─────────▼───────────────────────────────────────────────────────────▼─────────┴──────────┐
│ EDGE / CDN   anonymous prefix cache · coalescing · SWR · surrogate-key purge             │
└─────────┬───────────────────────────────────────────────────────────┬─────────▲──────────┘
          │                                                           │ miss    │ response
┌─────────▼─────────┐   ┌─────────────────────────────────────────────▼─────────┴──────────┐
│ Event ingest      │   │ SUGGEST SERVICE (stateless, per region)                          │
│ validate · dedupe │   │ normalize → candidate cache → fan-out 15 ms → blend → policy     │
└─────────┬─────────┘   └─────┬─────────────────┬─────────────────┬────────────────┬───────┘
          │                   │ TopK            │ TopK            │ history        │ rules
          │             ┌─────▼─────────┐ ┌─────▼─────────┐ ┌─────▼───────┐ ┌──────▼───────┐
          │             │ Base index    │ │ Fresh index   │ │ History     │ │ Policy rules │
          │             │ mmap · hourly │ │ every minute  │ │ KV by user  │ │ push ≤ 60 s  │
          │             └─────▲─────────┘ └─────▲─────────┘ └─────────────┘ └──────────────┘
          │                   │ pull            │ pull
          │             ┌─────┴─────────────────┴─────────┐
          │             │ Artifact store + rollout        │
          │             │ versions · gates · canary       │
          │             └─────▲─────────────────▲─────────┘
          │                   │ publish         │ publish
          │             ┌─────┴─────────┐ ┌─────┴─────────┐
          │             │ Base builder  │ │ Fresh builder │
          │             │ decay · gates │ │ velocity      │
          │             └─────▲─────────┘ └─────▲─────────┘
          │                   │ batch           │ windows
          │             ┌─────┴─────────┐ ┌─────┴─────────┐
          │             │ Data lake     │ │ Streaming jobs│
          │             │ authoritative │ │ sketches · HLL│
          │             └─────▲─────────┘ └─────▲─────────┘
          │                   │ archive         │ consume
┌─────────▼───────────────────┴─────────────────┴─────────┐
│ EVENT LOG (Kafka)   query · impression · selection      │
└─────────────────────────────────────────────────────────┘
```

**Journey 1: a keystroke.**

1. The input notifies the controller, which updates state synchronously and asks the data access layer for suggestions with a new sequence number.
2. The data access layer answers from the prefix cache if it can, including filtering an exhaustive parent. Otherwise it schedules a `GET /v1/suggest?q=` after an adaptive debounce. Local recent searches are matched at the same time.
3. The edge answers anonymous short prefixes directly. On a miss, the suggest service normalizes the prefix, checks its candidate cache, fans out to the base and fresh indexes (plus history for signed-in users) under a 15 ms deadline, blends, applies policy, and returns k items with cache headers.
4. The response flows back through the edge, which caches it if public. The data access layer accepts it only if its sequence number and echoed `q` still match the input, then the controller renders.

**Journey 2: a selection.** The controller hands off to selection effects: navigate to the results page, record the recent search locally, and queue a beacon with the impression list and chosen position.

**Journey 3: the feedback loop.** Beacons go through event ingest to Kafka. Streaming jobs compute velocity every minute and the fresh builder publishes a small index. The lake feeds an hourly base build. Both artifacts pass validation gates and a canary before replicas pull them, verify them and swap atomically. Policy rules bypass all of this and are pushed straight to every node.

### The three decisions that shape everything

1. **The client controls request count; the contract controls cacheability; the server controls cost.** I design each boundary to protect the next one. Client caching and debouncing cut requests to ~0.4 per keystroke. A public GET keyed by normalized prefix lets the edge absorb the hottest 40%. An origin candidate cache and in-memory indexes make the rest cheap.
2. **Indexes are immutable, versioned snapshots,** built offline and swapped atomically, with a separate fresh tier for emerging queries. The read path never takes a lock or waits for a write, and every replica gives the same answer.
3. **Personalization is a thin layer over shared global candidates,** never a reason to make the expensive part per-user.

---

## 💾 D — Data Model (~5 min)

| Layer | Entity | Key fields | Owner and lifetime |
|-------|--------|-----------|--------------------|
| Client | TypeaheadState | `inputValue`, `isComposing`, status, items, `activeId`, `lastAcceptedSeq` | Controller; widget lifetime |
| Client | PrefixCacheEntry | key (locale + user scope + normalized prefix), response, `complete`, `fetchedAt` | Data access layer; server TTL; LRU ~200 |
| Client | RecentSearch | normalized and display text, `lastUsedAt`, count, synced flag | IndexedDB + memory mirror; capped at 50 |
| Wire | SuggestResponse | `q` echo, items (id, text, kind, match ranges, badges), `complete`, `ttl`, `index_version`, `policy_version` | Cached per prefix at each layer |
| Server | Base index artifact | sorted phrase table, scores, RMQ structure, manifest (watermark, checksum, counts) | Immutable; last N versions kept |
| Server | Fresh index artifact | ≤100K high-velocity phrases, same format | Immutable; replaced every minute |
| Server | User history | user id → last 500 queries with recency and count | Authoritative KV; user-deletable |
| Server | Policy rules | match type, scope, action, reason, expiry; versioned | Policy service → every node |
| Server | Query events | event id, prefix, shown ids + positions, selection, index version | Kafka (at-least-once) → lake (authoritative history) |

**Normalization is a shared contract, not an implementation detail.** The client computes a cache key before it sends anything; the server normalizes before lookup. If the two disagree (Unicode NFKC, locale case folding such as Turkish dotted İ, whitespace collapsing, and *keeping a trailing space*, because "new" and "new " complete differently), cache hit rates quietly drop and the echo check starts rejecting valid responses. I'd write normalization as a versioned spec with shared test vectors that run in both the JS and server CI pipelines. The server's `q` echo then doubles as runtime drift detection: a mismatch counter that should stay at zero.

Two more fields carry design weight. **`complete`** marks an exhaustive result set, which is the only case where a client can derive a child prefix's top k by filtering. **`policy_version`** lets clients flush cached entries after a takedown (deep dive 3).

---

## 🔌 I — Interface Definition (~7 min)

### External API

```
GET    /v1/suggest?q={prefix}&locale={l}&limit=8&client={c}   → top-k completions (public if anonymous)
GET    /v1/suggest/zero?locale={l}                             → zero state: trending for an empty focus
GET    /v1/history?limit=50     DELETE /v1/history/{id}         → sync / remove signed-in recent searches
POST   /v1/events               (sendBeacon, batched)           → impressions, selections; idempotent by event id
```

| Contract element | Why it's there |
|------------------|----------------|
| GET with the prefix in the URL | The URL is the cache key for the browser, the edge and coalescing. GraphQL or a WebSocket would push every keystroke to the origin |
| `Cache-Control` | Anonymous: `public, max-age=60, s-maxage=300, stale-while-revalidate=60`. Signed-in: `private, max-age=30` |
| `Surrogate-Key` | Phrase ids, prefix and locale, so a takedown purges the edge with one tag |
| `q` echo + client sequence number | Out-of-order protection that doesn't depend on abort succeeding |
| Match ranges, never HTML | Only the server knows what its normalization matched; text-only rendering closes an XSS vector |
| `index_version` | Joins every selection to the index that produced it |

### Component and internal interfaces (briefly)

- **Component:** a headless hook with prop getters (input, listbox, option) that own ids, roles and ARIA state; render slots for rows, group headers, empty and loading states; callbacks `onSelect(item, how)`, `onInputChange`, `onOpenChange`. Sources take a query and an abort signal, so every source can be cancelled.
- **Internal:** `Index.TopK(locale, prefix, k)` with a 5 ms deadline and hedging; `Fresh.TopK` and `History.Recent(user, prefix)`, both optional and dropped at their deadlines; `Artifacts.Publish(manifest)` gated by validation; `Policy.Push(version)`, with every node heartbeating its applied version.

---

## 🔧 O — Optimizations and Deep Dives (~18 min)

### Deep dive 1: The keystroke-to-pixel latency budget (~6 min)

> "Users don't experience 'API latency'. They experience the gap between pressing a key and seeing a list that matches what they typed. I'll budget that gap hop by hop, then show where requests disappear before they cost anything."

| Hop | Budget | How it's met |
|-----|--------|--------------|
| Input event → controller | < 1 ms | Synchronous local state; nothing async on the keystroke path |
| Client prefix cache | 0 ms | Backspace, retyping and children of exhaustive parents never touch the network |
| Debounce | 0–80 ms | Skipped on cache hits; on misses, adapts to the user's typing rhythm |
| Network to edge | 20–60 ms | Preconnect on focus (TLS costs 1–2 RTTs on mobile); HTTP/2; cookieless anonymous requests |
| Edge hit | ~1 ms | Prefixes of 1–3 characters are a ~50K-key space per locale, so effectively always hot |
| Edge → origin | 10–40 ms | Regional serving; request coalescing on hot keys |
| Origin | < 10 ms p50, < 20 ms p99 | Candidate cache, in-memory indexes, hedged lookups |
| Render | < 16 ms | 8–10 fixed-height rows, no virtualization, no layout shift |

```
┌─ keystrokes typed ................................. 100%
├─ answered by the client prefix cache ............. ~35%   backspace, retype, exhaustive parents
├─ absorbed by debounce ............................ ~25%   prefixes a fast typist never pauses on
└─┬ sent to the network ............................ ~40%   ≈ 0.4 requests per keystroke
  ├─ answered at the edge .......................... ~40% of sent   mostly 1–3 character prefixes
  └─┬ reach origin ................................. ~60% of sent
    ├─ candidate-cache hit ......................... ~70%
    └─ index lookup ................................ ~30%   ≈ 7% of keystrokes do real index work
```

*(Funnel percentages are planning assumptions to validate with telemetry, not measurements.)*

**Correctness inside the budget.** A fast path is useless if it renders the wrong prefix. Abort alone doesn't prevent that: a synchronous cache hit for "weat" doesn't cancel the in-flight "wea" request, and when "wea" lands it overwrites the correct list. The guard is a sequence number plus the echoed `q`; abort is only a bandwidth optimization. On slow networks I allow two requests in flight and *don't* abort a request for an ancestor of the current input. When "wea" lands while the input reads "weat", I render it filtered to "weat…" as an interim list. Without that, a fast typist on a 400 ms connection would see nothing until they stopped typing.

| Approach | Outcome |
|----------|---------|
| ❌ Fixed 150 ms debounce + abort-all | Adds 150 ms to every miss, starves slow networks, still races on cache hits |
| ❌ No client logic, rely on the CDN | Every keystroke becomes a request; long-tail prefixes miss the edge anyway |
| ✅ Cache-first, adaptive debounce, seq + echo guard, ancestor-filtered interim, edge for short prefixes | More moving parts on both sides, but each layer removes load before the next, and the client is correct by construction |

**What's deliberately not in the budget.** I don't prefetch "the next character": at this scale, low-hit speculation multiplies origin load. I do prefetch the *destination*. When a suggestion has been highlighted for ~100 ms, a Speculation Rules prefetch loads its results page, so Enter feels instant. Time to results is what users actually call "fast search".

### Deep dive 2: The serving index — structure, snapshots and freshness (~6 min)

**Structure.** The textbook answer is a trie with the top-k stored at every node. The idea is right: precompute, so one- and two-letter prefixes, the most frequent requests, don't trigger a subtree walk. The representation doesn't scale. For ~100M phrases that's ~700M nodes, ~60 GB, and hundreds of millions of heap objects. In a garbage-collected runtime the p99 cliff comes from the collector, not the lookup. Instead:

- Sort the normalized phrases; a phrase's id is its position, so every prefix maps to a contiguous id range found by binary search.
- A range-maximum-query structure over the score array returns the top k of any range in O(k log k): take the maximum, split the range around it, repeat with a heap.
- Front-coded strings, a 4-byte score per phrase and a succinct RMQ come to ~1.5 GB, in flat arrays that are mmap'd and invisible to the GC. Every replica holds a whole locale. Routing is by locale, with no first-character sharding and no scatter-gather.

**Immutable snapshots.** A version is a read-only file. Replicas pull, verify the checksum, warm and swap a pointer, keeping the previous version mapped. Rollback is another pointer swap, restarts serve within seconds, and every replica at version V returns identical results, which keeps edge caching coherent. Because a bad index deployed everywhere is worse than a stale one, publishing is gated (row count within bounds, result overlap on the top prefixes, a policy scan) and canaried per region.

**Freshness is a recall problem.** If trending were only a boost applied to the base index's top 10, a phrase that started trending four minutes ago, and isn't in that top 10 or in the index at all, could never appear. Ranking can only reorder what retrieval returned. So emerging queries get their own retrieval path:

1. Streaming jobs keep per-minute heavy-hitter sketches and HyperLogLog distinct-user counts per locale.
2. Candidates are scored on **velocity**: the current rate against an hour-of-day baseline, smoothed so 1 → 5 searches isn't a spike. "weather" is huge every day but isn't trending.
3. Stricter gates than the base tier: ≥ ~200 distinct users, bot traffic excluded, classifier review, and human review for "<person> + negative event" patterns, where manipulation and death hoaxes concentrate.
4. Every minute a ≤100K-phrase fresh index ships in the same artifact format and is merged at read time, capped at two of eight slots.

| Approach | Freshness | Main risk |
|----------|-----------|-----------|
| ❌ Mutate one in-memory trie from a write buffer | Seconds | Each replica buffers separately and they diverge; locking in the hot path; no rollback |
| ❌ Rebuild the full index every minute | 1–2 min | Enormous build cost; validation can't keep up |
| ✅ Hourly immutable base + per-minute fresh tier | 2–5 min | Calibrating scores across the two tiers |

### Deep dive 3: Personalization, takedowns and the feedback loop (~6 min)

**Where personalization happens.**

| Option | Pros | Cons |
|--------|------|------|
| ✅ Client blends synced recents; server blends history over a shared candidate cache for signed-in requests | Anonymous responses stay public and cookieless; the expensive global candidates are computed once per prefix for everyone | Signed-in responses can't be edge-cached; the merge rules live in two places |
| ❌ Fully personalized server ranking cached per user | Richest ranking | One cache entry per user per prefix means near-zero hit rate and full cost on every keystroke |
| ❌ Client-only personalization | Cheapest | No cross-device history; no server-side signals |

The merger caps personal items at three of eight slots, dedupes by normalized text, and keeps rows stable. A recent search that jumps position between keystrokes reads as flicker.

**Takedown latency is the sum of every cache you added.** Adding a caching layer also adds a place where a blocked phrase can survive:

| Layer | Holds a blocked phrase for | How it's cleared |
|-------|---------------------------|------------------|
| Serve-time policy filter | 0 | It *is* the enforcement; rules pushed to every node in ≤ 60 s |
| Origin candidate cache | Until purged | Flushed for affected prefixes when a new rule version is applied |
| Edge | Until purged | One surrogate-key purge by phrase id, instead of enumerating every prefix × locale |
| Browser HTTP cache | Up to `max-age` + SWR (2 min) | Can't be purged, so those values are capped at the takedown SLO |
| Client prefix cache | Until the next response | Any response carrying a newer `policy_version` flushes the in-memory cache |
| Next base build | Excluded permanently | Defense in depth |

> "The layers you *can't* purge set your worst case. That's the full-stack argument for short browser TTLs even when longer ones would raise the hit rate: they bound takedown latency."

**Closing the feedback loop.**

- **Impressions must be logged by the client.** Only the client knows what was actually rendered after interim filtering, merging recents, and freezing the list while the user navigates. The server only knows what it sent. Each beacon carries the prefix, the shown ids and positions, the selection and its position, latency, cache source and `index_version`.
- **Metrics that capture autocomplete quality:** selection rate, mean selected position, **keystrokes saved per search** (characters the user didn't have to type), and abandonment. Latency is tracked by cache source.
- **Position bias.** Users click what we already rank first, so training a ranker on raw clicks reinforces the current one. A small exploration slice (randomly swapping positions 2 and 3 for 1% of impressions) and interleaving experiments give unbiased signal for comparing rankers.

---

## 🛡️ Failure and Degradation (~1 min)

| Failure | User-visible behavior |
|---------|-----------------------|
| Suggest API slow or 5xx | Recents and filtered cached results stay visible; typing and Enter still work. The client retries on the next keystroke, not in a loop |
| Personal store slow | Global-only results; nobody sees an error |
| Fresh pipeline lagging | Fresh tier suppressed after 15 minutes; base suggestions continue |
| Bad index build | Rejected by gates or rolled back by a pointer swap; the last good version keeps serving |
| JS not loaded yet | The server-rendered input is a real form; Enter does a plain search, and hydration picks up the typed value |
| Overload | Shed in quality order: personal, then fresh, then stale cache, then an empty list. Never a 5xx storm that triggers client retries |

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| API shape | GET with the prefix in the URL | GraphQL / WebSocket | The URL is the cache key at every layer |
| Normalization | Versioned spec + shared test vectors + echo | Each side implements its own | Silent drift destroys hit rate and correctness |
| Client ordering | Seq + echo guard; abort as an optimization | Abort-only | Closes the cache-hit race |
| Request timing | Cache-first + adaptive debounce | Fixed 150 ms debounce | No added latency on hits or for slow typists |
| Index | Sorted array + RMQ, mmap, per-locale replicas | Pointer trie, first-character shards | 1.5 GB vs 60 GB; no GC cliff; no fan-out |
| Updates | Immutable snapshots + fresh tier | In-place trie mutation | Deterministic replicas, rollback, real recall for new queries |
| Personalization | Thin layer over shared candidates | Per-user cached responses | Keeps the expensive part shared |
| Safety | Serve-time filter + tag purge + bounded browser TTLs | Build-time filtering only | Takedown in seconds, bounded worst case |
| Prefetch | Results page on highlight | Next-character speculation | Optimizes what users feel; avoids load amplification |
| Ranking data | Client-logged impressions + exploration slice | Server logs and raw clicks | True impressions; unbiased training signal |

---

## 📝 Wrap-up (~2 min)

> "In summary: the client removes most requests and guarantees it never shows the wrong prefix. The API is shaped so whatever's left is cacheable. The server answers from immutable, locale-replicated snapshots with a separate fresh tier, because ranking can't fix recall. Personalization stays a thin layer, and safety is enforced at serve time with every cache bounded. What I'd validate first: instrument keystroke-to-paint by cache source and the request funnel above, because every later tuning decision depends on those numbers. Second, test the combobox with real screen readers and CJK IMEs. Third, canary the index pipeline's gates against a deliberately broken build before trusting them in production."

### How the local implementation compares

The repo implements a single-node version of this design. On the frontend, the search page runs `SearchBox` over a Zustand store with a 150 ms debounce. Four widgets on the `/widgets` route share a `useTypeahead` hook that adds an IndexedDB suggestion cache. Both paths order responses by request sequence number, with abort as an optimization, and share a memory LRU keyed by prefix, user, limit and fuzzy flag. A service worker runs in production builds only. The backend is one Express process with an in-heap trie storing a top-10 at every node, rebuilt from Postgres on start, and readiness stays 503 until it loads. Redis caches unranked candidates, the "shared candidates, personalize after" idea: anonymous responses are `public, max-age=60`, and personalized ones are `private, no-cache` with a weak ETag. Ranking uses five fixed weights with per-candidate Redis lookups. Trending is a boost on the trie's top-k. Counts are buffered in process and flushed every 30 s. Admin takedowns remove the phrase from the trie, trending and every cached prefix at once. Relative to this answer: no immutable artifacts, fresh tier, edge or policy versioning; the client's guard is the sequence number alone, not an echoed `q`; and multiple instances stay consistent by polling a Postgres change marker (plus a pub/sub nudge) rather than by loading identical immutable artifacts.
