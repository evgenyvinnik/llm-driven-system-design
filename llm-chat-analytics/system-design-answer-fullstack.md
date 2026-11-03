# LLM Chat Analytics — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · near-real-time usage dashboards for an AI chat product, used by customer admins and analysts and by internal support*

> "There's a version of this answer that's all charts: a grid of widgets, a filter bar, a chart library, maybe a WebSocket for live updates. It looks finished, and it's the trap, because it never explains where a consistent number comes from. If the dashboard says 488 conversations yesterday, the CSV says 491 and the drill-down lists 476 rows, nobody will trust any of them. So I'll spend the first half on definitions and the path from event to number, and the second half on how the browser presents those numbers honestly: what's final, what's still filling in, what changed since you last looked, and what you aren't allowed to see."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements, definitions, event contract | ~8 min | What every number means before anything is drawn |
| Architecture and data model | ~6 min | The path from a chat event to a pixel |
| API, client state, widget states | ~5 min | One query object; every widget fails on its own |
| Execution traces | ~5 min | One good request and one crash, browser to warehouse |
| Deep dives | ~12 min | Query identity, late and duplicate data, time zones |
| Access, follow-ups, checklist, scale | ~9 min | Who sees what, and short answers to the questions I expect next |

---

## 🎯 Requirements and Scope (~4 min)

| Question | Assumption | Design consequence |
|----------|------------|--------------------|
| Who looks at it? | Org admins and analysts in customer orgs; internal support across all orgs | Roles per org; cost and conversation lists are permissions, not UI toggles |
| How fresh is "near real time"? | Queryable within a minute, and the screen says how complete the data is | A watermark, not a vague "live" badge |
| Does message content flow in? | Never | The event contract has no content fields and rejects anything that looks like one |
| Whose "yesterday"? | The org's | Daily buckets are local calendar days, including half-hour offsets |
| Scale? | 50M daily users across 200K orgs, ~400 events each | 20B events/day: ~230K/s average, ~500K/s peak |
| Can past numbers change? | Yes: phones go offline and producers retry | Event-time bucketing, dedup, and revisions the user can see |

**Functional requirements**

1. Overview tiles: active users, conversations, successful-response rate, error rate, abandoned-generation rate, TTFT p95, tokens, and (admins only) cost and cost per conversation, each compared with the previous week or month.
2. Time series by minute, hour or day, with the comparison aligned bucket by bucket and the open bucket marked.
3. Breakdowns by model and by feature that cross-filter every other widget.
4. Drill-down from a bar to the conversations behind it, metadata only.
5. A freshness label, exports as background jobs, and a definitions page.

**Out of scope:** alerting, ad-hoc SQL, and the chat product itself.

| Property | Target |
|----------|--------|
| Freshness | p99 ingest-to-queryable < 60 s; watermark lag < 2 min for server events |
| Correctness | A duplicate never double-counts; events up to 72 h late land in their own bucket |
| Query latency | p95 < 500 ms for 28 daily buckets; < 2 s for 90 days hourly |
| Availability | 99.9% for queries; ingest may lag but never loses an event |
| Privacy | Zero message content; any breakdown under 5 users suppressed |
| Access | Billing values never leave the server for roles without `billing:read` |

---

## 📏 Definitions First (~4 min)

> "Before I draw a box I want us to agree on four words, because the charts, the drill-down and the export all compute from these definitions, and they live in exactly one place."

| Term | Definition | Why this definition |
|------|-----------|---------------------|
| Conversation | One `conversation_started` event, counted in the bucket of its event time | Stable once counted. It also means a conversation has no feature, which matters later |
| Active user | A distinct user who sent at least one message in the period | Opening the app or receiving a reply isn't usage |
| Successful response | `response_completed`: streamed to its natural end and the final token delivered. Rate = completed ÷ (completed + failed + abandoned) | Each generation has exactly one terminal event, so the denominator is honest |
| Abandoned generation | `response_abandoned`: the user pressed Stop or disconnected after the request started and before the final token. Reported by the server | The server sees the stream end, so a closed tab still counts and a crashed client can't under-report |
| TTFT / total time | Server-measured, over completed responses only | Percentiles come from merged digests, never averaged |
| Cost | Tokens × the list price in effect at event time, computed at ingest | Billing data, role-gated |

These sit in a **metric catalog**: definition, unit, kind (sum, ratio, distinct, percentile), which event stream bounds its freshness, sensitivity, the dimensions it can be split by, and what its drill-down lists. The definitions page renders it, the query API computes from it, and the exporter names its columns from it. Two traps are enforced there:

- **Dimension applicability.** Conversations filtered by feature would silently read 0, because features are known per message. The API answers `422 DIMENSION_NOT_APPLICABLE` with that reason, and the tile says "n/a with a feature filter".
- **Coverage.** The server only started reporting abandoned generations on a known date. Earlier buckets are `not_collected`, and the chart draws a labelled gap, never zeros.

### The event contract

| Field | Notes |
|-------|-------|
| event_id | Producer-generated UUID, reused on every retry: the dedup key |
| org_id, user_id | user_id is pseudonymous and stable per org, never an email or name |
| event_type | `conversation_started`, `message_sent` (client); `response_completed`, `response_failed`, `response_abandoned` (server) |
| source | client or server; must match the event type |
| event_time | When it happened, by the producer's clock. All bucketing uses it |
| received_time | Stamped by the collector. Never trusted from a device |
| schema_version | 1 |
| conversation_id, generation_id, model, feature, platform | Joins and dimensions |
| ttft_ms, latency_ms, tokens, error_code, abandon_reason | Measures, depending on the type |

**Never content.** The schema is strict: an unknown key rejects the event, and keys that look like content (prompt, text, completion, message…) are rejected with their own reason, `content_field`, which pages the producing team. Rejections are stored as metadata (reason, partition, offset) without the payload.

---

## 🏗️ Architecture (~6 min)

```
┌──────────────┐   ┌──────────────┐
│ Chat clients │   │ Chat servers │       events only, never content
└──────┬───────┘   └──────┬───────┘
       └────────┬─────────┘
                ▼
┌────────────────────────────────┐
│ Collector                      │  validate · stamp received_time
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐
│ Kafka: chat-events             │  keyed by org_id · 7-day retention
└───────────────┬────────────────┘
                ▼
┌────────────────────────────────┐      ┌──────────────────────────────┐
│ Ingest consumers               │◀────▶│ Valkey                       │
│ dedup claim · late check ·     │      │ dedup claims (96 h) ·        │
│ enrich (local_date, cost)      │      │ partition positions ·        │
└───────────────┬────────────────┘      │ per-day revisions · cache    │
                │ insert + dedup token  └──────────────▲───────────────┘
                ▼                                      │
┌────────────────────────────────┐                     │
│ ClickHouse                     │                     │
│ events (raw, 400 d)            │                     │
│  ├─MV─▶ rollup_minute (3 d)    │                     │
│  ├─MV─▶ rollup_hour (90 d)     │                     │
│  └─MV─▶ rollup_day_local (∞)   │                     │
└───────────────┬────────────────┘                     │
                ▼                                      │
┌────────────────────────────────┐                     │
│ Query API (stateless)          │─────────────────────┘
│ catalog · planner · access ·   │      ┌──────────────────────────────┐
│ cache · drill-down · freshness │─────▶│ PostgreSQL                   │
└───────────────┬────────────────┘      │ orgs + time zones · roles ·  │
                ▼                       │ prices · coverage · exports  │
┌────────────────────────────────┐      └──────────────┬───────────────┘
│ React SPA (from a CDN)         │                     ▼
│ URL state · keyed query cache  │      ┌──────────────────────────────┐
│ per-widget states              │      │ Export workers → CSV files   │
└────────────────────────────────┘      └──────────────────────────────┘
```

| Component | Responsibility |
|-----------|----------------|
| Collector | Stateless: validates the contract, stamps received_time, keys by org_id |
| Kafka | Absorbs warehouse outages, is the replay source, and keeps per-partition order, which the watermark relies on |
| Ingest | Per chunk of up to 2,000 messages: skip offsets already inserted, validate, re-stamp client clocks more than 60 s in the future, reject events over 72 h late, claim each event_id, flag late rows, enrich, insert with a token, record, commit |
| ClickHouse | Raw events plus three rollups, maintained by materialized views on every insert |
| Query API | Parses one canonical query, checks the role, plans the window across rollups, caches, answers drill-downs |
| PostgreSQL | Configuration and jobs: org time zones, roles, versioned prices, metric coverage, export jobs |
| SPA | URL-driven filters, per-widget fetching and states, the freshness label, the drill-down panel |

### Data model

| Store | Table or key | Grain and key columns | Notes |
|-------|--------------|-----------------------|-------|
| ClickHouse | events | One row per event, ordered by (org, date, type, event_id); ingest stamps local_date, is_late, cost | ReplacingMergeTree: the eventual backstop, and what drill-downs read |
| ClickHouse | rollup_minute, rollup_hour | UTC minute or hour × org × model × feature | Sums, a HyperLogLog state for active users, t-digest states for latency, late_events, last_revised_at |
| ClickHouse | rollup_day_local | Org-local date × org × model × feature | Same states; about 420 rows answer a 28-day chart |
| PostgreSQL | orgs, memberships | Org time zone; a role per (user, org) | Roles re-read on every request |
| PostgreSQL | model_prices | (model, effective_from) | Cost uses the price in effect at event time |
| PostgreSQL | metric_coverage | metric, collected_from, available_from, note | Drives not_collected and backfill_pending |
| PostgreSQL | export_jobs | Unique (user, idempotency key); status, rows done and total, lease | One job per click |
| Valkey | `dedup:{event_id}`, `rev:{org}`, positions, cached responses | Claim value partition:offset (96 h); revision per local date; watermark inputs | Losing Valkey loses no data |

> "The rollups store sketch *states*, not finished numbers. That's the one schema choice that makes a week of active users, or a filtered p95, correct. I'll come back to it in the follow-ups."

---

## 🔌 API Contracts (~2 min)

Every query endpoint takes the same canonical parameters: org, from and to (ISO instants aligned to the grain in the org's zone), grain, models, features and compare. Every response echoes the canonical string it answered.

```
GET  /api/v1/query/overview?…            → tiles: value, previous, delta, coverage, notApplicable
GET  /api/v1/query/series?…&metric=      → buckets: value, partial, open, coverage, suppressed,
                                           lateEvents, revisedAt, previous {value, toDate, clamped}
GET  /api/v1/query/latency?…             → p50 / p95 / p99 TTFT and total per bucket
GET  /api/v1/query/breakdown?…&dim=      → rows: key, value, users, share, suppressed
GET  /api/v1/query/drilldown?…&bucket=   → rollupCount, matched, users, one page of conversations
GET  /api/v1/freshness?org=              → watermarks per stream, backlog, recently revised days
GET  /api/v1/meta                        → metric catalog, event contract, coverage
POST /api/v1/exports  (Idempotency-Key)  → 202 new job · 200 the existing job for that key
GET  /api/v1/exports/:id                 → status, rowsDone / rowsTotal
GET  /api/v1/exports/:id/download        → CSV, permissions re-checked
```

| Response | Meaning | What the widget shows |
|----------|---------|-----------------------|
| 400 UNALIGNED_RANGE | from or to isn't a bucket boundary in the org's zone | A client bug, logged; never a user-facing state |
| 403 METRIC_FORBIDDEN | A billing metric for a role without billing:read | Lock icon, "not available for your role" |
| 404 ORG_NOT_FOUND | Also returned for orgs you aren't in | Same as nonexistent, deliberately |
| 422 DIMENSION_NOT_APPLICABLE | e.g. conversations split by feature | "Not available with these filters" plus the reason |
| 499 | The browser closed the request | Nothing; the warehouse query behind it was cancelled |

---

## 🖥️ The Dashboard: Where State Lives (~3 min)

I start from the screen, because it tells me which states exist:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Larkspur Labs ▾        ● Up to date · complete through Nov 2 14:05 PST   │
│ [Last 7 days ▾] [Day ▾] [vs previous week ▾]    model: orion-large ×     │
├────────────┬────────────┬────────────┬────────────┬──────────────────────┤
│ Active     │ Convers.   │ Success    │ Abandoned  │ TTFT p95             │
│ ≈ 612      │ 2,734      │ 97.8%      │ 1.2%       │ ≈ 840 ms             │
│ ▲ 4.1%     │ ▼ 2.0%     │ ▲ 0.3 pt   │ ▼ 0.1 pt   │ ▲ 6%                 │
├────────────┴────────────┴────────────┴──────┬─────┴──────────────────────┤
│ Conversations by day          Updating…     │ Feature adoption           │
│  ▇   ▇   ▆   ▇   ▃   ▃   ▒                  │ chat         ███████  96%  │
│                      ↻       ▒ = partial    │ web search   ███      31%  │
│ ── previous week (today: same time)         │ code exec    ██       18%  │
├─────────────────────────────────────────────┴────────────────────────────┤
│ Drill-down · Sun Nov 1 · bar 141 · raw 141 · rows add up to the bar      │
└──────────────────────────────────────────────────────────────────────────┘
```

| State | Lives in | Why there |
|-------|----------|-----------|
| Filters: range intent ("7d"), grain, compare, models, features, metric, open drill bucket | URL search params | Refresh, the back button and a pasted link reproduce the exact view |
| Resolved query: absolute, bucket-aligned instants | Derived from URL + org time zone + current time | What gets fetched, cached, drilled into and exported |
| Widget responses | Query cache keyed by (widget, canonical string) | A response can only land in the entry for the question it answers |
| Session, orgs with role and permissions, export progress | Small app store | Decides which widgets and menu items exist |
| Hover, open popovers | Component state | Never worth persisting |

Every widget renders its own state, so one slow query never blanks the page:

| State | Trigger | What the user sees |
|-------|---------|--------------------|
| loading | First fetch, nothing to show yet | Skeleton |
| refreshing | New key loading while older data exists | Previous chart dimmed, "Updating" badge |
| partial | Buckets ending after the watermark | Hatched bars; tooltip "events may still arrive" |
| revised | lateEvents > 0 in a bucket | ↻ under the bar; tooltip "+20 late events, revised 04:15" |
| gap | Under 5 users, not_collected, backfill_pending | A labelled hatched band; the line breaks instead of dropping to 0 |
| empty | The query worked and matched nothing | "Nothing matches these filters" |
| not applicable · forbidden | 422 · 403 | The server's reason · a lock |
| error | 5xx or a warehouse timeout | This widget only, with Retry; a failed refresh keeps the last good result with a note |

---

## 🔁 Execution Traces (~5 min)

### ✅ Success: an analyst filters to one model and drills into yesterday

1. **Browser.** An analyst at Larkspur Labs (America/Los_Angeles) clicks the `orion-large` chip. The URL updates immediately (replace, not push), so the chip highlights at once.
2. **Browser.** After the filters have been stable for 200 ms, the client resolves "last 7 days" into Oct 27 07:00 UTC to Nov 3 08:00 UTC, aligned to local midnights, and builds the canonical string. Five widgets derive five keys. The model breakdown drops its own dimension, so it still shows every model.
3. **Browser.** Requests for the previous keys still in flight are aborted. Each widget keeps its previous answer dimmed under "Updating".
4. **API.** It loads the session, re-reads the analyst's role for this org from PostgreSQL, checks that from and to are aligned in Los Angeles time, and computes the cache key: a hash of widget, canonical string, the sorted permission scope, and the revision counter of every day in the window and its comparison week. It's a miss.
5. **API → ClickHouse.** The series reads `rollup_day_local` for seven local dates, filtered to orion-large, and merges the states. The previous week is shifted back by wall-clock time. Today, the open bucket, is compared to last Monday *up to the same elapsed minute*. Buckets ending after the watermark are flagged partial.
6. **API.** The response carries the echo and goes into the cache with a 10-second TTL, because the window includes now.
7. **Browser.** The echo matches the key, so it paints. Today's bar is hatched, and yesterday carries ↻ because of late arrivals this morning.
8. **Browser.** The analyst clicks yesterday's bar. The URL gains `drill=<bucket start>`, and the drill-down request carries the chart's own resolved query plus that bucket.
9. **API.** It confirms the bucket belongs to that query, reads the bar's count from the same rollup (141), and re-runs the same predicate against raw events: local_date = yesterday, model = orion-large. It finds 141 and returns 25 conversations with their metadata. There's no cost column, because the caller is an analyst. The panel says "rows add up to the bar".

### ❌ Failure: an ingest consumer dies mid-chunk while support watches "Today"

1. **Ingest.** A consumer claims every event_id in offsets 4,000–5,999 of partition 7. One event is a client retry: the same event_id arrived at 4,200 and again at 5,100, so the second copy is dropped as a duplicate. The consumer inserts the chunk with token `p7-4000-5999`, then is killed before it records inserted-through or commits to Kafka.
2. **Watermark.** Partition 7 stops reporting positions. Once its last report is stale, it's flagged stalled, and because the watermark is the *minimum* over partitions, it stops advancing.
3. **Browser.** The freshness poll (every 15 s) turns the label red: "Ingest stalled · complete through 14:05". Buckets after 14:05 are hatched. They look low, but they say they're partial, so nobody files a "traffic dropped" incident.
4. **Kafka.** A rebalance gives partition 7 to another consumer, starting at the committed offset 4,000.
5. **Ingest.** The new owner rebuilds the same chunk. Each event finds a claim holding its *own* partition:offset, which marks a redelivery, so it's kept. The copy at 5,100 finds the claim of 4,200 and is dropped again.
6. **ClickHouse.** The insert with the same token is ignored by the raw table and by all three rollups. Nothing is counted twice.
7. **Ingest.** It records inserted-through, commits, and resumes reporting. The watermark jumps forward.
8. **Browser.** Within one refresh, the label goes green, the hatched minutes fill in with their real values, and the pipeline page shows one more duplicate dropped.

> "The token only matches if the replay cuts the same boundaries, and Kafka may hand the new owner a longer batch. So the chunk's offset range is recorded as in flight before the insert, and the replay cuts its first chunk at exactly that range. If that ever fails, the raw table still collapses the duplicate, and the drill-down's reconciliation is what exposes a rollup that drifted."

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: One query object, end to end

**Decision.** The URL holds intent ("last 7 days, vs previous week, orion-large"). The client resolves it, using the org's time zone and the current time, into absolute instants aligned to bucket boundaries. It then canonicalizes: fixed key order, sorted and de-duplicated lists, empty values dropped. That one string is the client cache key, the core of the server cache key, and the echo on every response. The drill-down and the export carry the same object.

**Why it works here.** Resolution takes "now" as an input, so the resolved query only changes when a boundary passes: "7d" at the org's midnight, "24h" on the hour, "1h" on the minute. In between, a 60-second refresh asks the identical question and hits warm caches. The server validates alignment instead of resolving again, so "yesterday" can't mean one thing in the browser and another on a server whose clock is two seconds past midnight. The echo closes the last gap: a response whose echo differs from the key it was fetched for is never painted. Cross-filtering falls out of the same object. Each breakdown fetches the query *minus its own dimension*, so the model chart keeps all models with the selected one highlighted while everything else narrows. Without that, picking orion-large collapses the model chart to one bar, and you can't pick a second model. The drill-down sends the chart's exact query plus a bucket. The server reads the bar's number from the same rollup and re-runs the same predicate on raw events, bucketed the way the rollup was: by local_date for day bars, by event-time range otherwise. If the counts disagree, the panel says so. For HyperLogLog metrics it says the bar is an estimate and the list is exact.

**How the alternatives break.** Sending `range=7d` and resolving on the server lets two widgets resolve a second apart around midnight and disagree, lets a cache keyed by "7d" serve last week's window after midnight, and leaves the drill-down unable to name its bucket. Filters in component state die on refresh and can't be shared. A drill-down written as its own query, "conversations on date X", eventually uses a UTC date where the chart used a local one, or forgets a filter. Its list then doesn't add up to the bar, and users conclude the bar is wrong.

**What I give up.** The alignment rules and the canonical string exist twice, in the browser and in the API, and must match byte for byte. A test asserts both produce identical strings for the same filters. The client also needs the org's time zone before it can fetch anything.

| Approach | Widgets, drill and export agree | Stale responses | Cost |
|----------|---------------------------------|-----------------|------|
| ✅ URL intent → aligned instants → one canonical string | Yes | Dropped by key and echo | Alignment logic on both sides, tested for equality |
| ❌ Relative range resolved by the server | No: drifts at boundaries | A cache can serve a different window under one key | Simplest |
| ❌ Filters in component state | Only within one widget | Last response wins | No shareable links |
| ❌ Drill-down as a separate query | Drifts from the bar | — | Two definitions of one number |

### Deep dive 2: Late and duplicate events, all the way to the screen

**Decision.** Bucket by event time. Deduplicate *before* the insert, so rollups never see a duplicate. Make incompleteness visible with a watermark and per-day revisions.

**Dedup in three layers**, one per crash window:

1. **Claim.** For each event, ingest does a set-if-absent on `dedup:{event_id}` that also returns any existing value, pipelined once per chunk, with a 96 h TTL. The value is the partition:offset of the message carrying the event. Absent means claimed. The *same* partition:offset means Kafka redelivered this exact message after a crash, so it's kept. A different value means a producer retry, so it's dropped.
2. **Insert token.** A chunk's token is derived from its partition and offsets, so a retried insert is a no-op, materialized views included. That last part holds only when every rollup table also has a dedup window. In testing, without one, the raw table dropped the retry while the views counted it twice.
3. **Inserted-through offset.** It skips messages already in ClickHouse from a run that crashed before committing.

**Watermark.** Every 2 s, each ingest instance reports a position per partition: the newest received_time it has written, or now if the partition has no backlog. Kafka keeps each partition in arrival order, so everything received before a position has been ingested. The watermark for a stream is the minimum position minus an allowance: 1 min for server events, 10 min for client events, because phones go offline. A partition that never reported makes it unknown; a stalled one holds it back. An event older than the watermark is **late**: it changes a bucket we already called complete. It's flagged, counted in the bucket's late_events, stamps last_revised_at, and bumps `rev:{org}` for its local date.

**To the screen.** Buckets ending after the watermark come back `partial` and are drawn hatched. The server cache key includes the revision of every day in the window, so a late event invalidates exactly the cached answers whose numbers changed. Sealed windows can then cache for 10 minutes, while open ones get 10 seconds. The next fetch paints the new number, the bar gets ↻, and the freshness popover lists "Nov 1: +201 late, last at 04:15". The header shows two different clocks: **complete through** (the watermark) and **last refreshed** (the browser's last fetch). A dashboard can refresh every 15 seconds while ingest is an hour behind, and only the first clock tells you so.

**How the alternatives break.** Processing-time buckets are stable but wrong. A phone offline for an hour moves a 09:00 conversation into 10:00, a backfill dumps a week into one minute, and an ingest outage draws a dip and a spike that never happened. Relying on ReplacingMergeTree alone deduplicates raw rows eventually, at merge time, and rollups never: every producer retry inflates the chart forever, and the drill-down disagrees with the bar. Dropping late events keeps yesterday frozen but systematically undercounts mobile users, which biases the platform comparisons people care about most.

**What I give up.** Yesterday's number can move for 72 hours, and the UI has to explain that rather than hide it. Dedup costs a Valkey round trip per chunk and about 100 bytes per event for 96 hours, which is the first thing to break at scale. Events more than 72 h late are rejected as `too_late` and counted on the pipeline page, because those days are sealed for rebuilds.

| Approach | Correct counts | Past numbers | Honest about it |
|----------|----------------|--------------|-----------------|
| ✅ Event time + pre-insert dedup + watermark + revisions | Yes | Move for 72 h, visibly | Hatched partial, ↻ revised, complete-through |
| ❌ Processing time | No: offline devices and backfills misplace events | Stable | Looks honest, isn't |
| ❌ Event time, ReplacingMergeTree only | Raw eventually; rollups never | Inflated | Drill-down mismatches |
| ❌ Event time, late events dropped | Undercounts mobile | Stable | Silent bias |

### Deep dive 3: Time zones and comparison periods

**Decision.** Store UTC. Ingest computes each event's local_date in its org's zone, and the daily rollup groups by it. Comparisons shift by local wall-clock time. A planner splits any window into whole local days, whole UTC hours, minutes and raw edges, all with identical state columns, and merges them once.

**Why it works here.** On Monday Nov 2, 2026, Larkspur's "last 7 days" runs from Oct 27 00:00 PDT to Nov 3 00:00 PST. In UTC that's seven days *and one hour*, because DST ended on Nov 1, which makes Sunday a 25-hour bucket. Week-over-week shifts each bucket back seven days on the wall clock (Monday 09:00 → the previous Monday 09:00), not 168 hours, so hourly bars don't slide across the change. Month-over-month shifts a calendar month, clamps Mar 31 to Feb 28, and flags the clamped bucket. The open bucket is compared with the previous bucket *up to the same elapsed time*, and tiles compare [from, now) with the same span shifted. Otherwise 2 pm today against all of last Monday reads as a 40% drop. Kestrel Health is on Asia/Kolkata (UTC+5:30), where local midnight is 18:30 UTC. Day charts there read `rollup_day_local` directly. A window like "this week so far" gets whole local days from it, minute rollups for the half-hours, and UTC hours in between. Hour charts clip their first and last bucket, and the tooltip says "part of a UTC hour".

**How the alternatives break.** UTC days put Larkspur's evening into "tomorrow": their "yesterday" ends at 4 pm local, and no number matches their own spreadsheet or invoice. Grouping UTC hours into local days at query time works for whole-hour offsets, splits hours for +5:30, +5:45 and −3:30, and reads 24 times the rows. Fixed 168-hour shifts misalign every hourly comparison for a week after each DST change.

**What I give up.** Changing an org's time zone only affects new events; old days must be re-localized by a rebuild. The planner is real code with real edge cases, so DST and +5:30 have their own tests.

| Approach | Half-hour zones | DST weeks | Rows for a 28-day daily chart |
|----------|-----------------|-----------|-------------------------------|
| ✅ local_date at ingest + wall-clock shifts + planner | Correct | Aligned | ~420 |
| ❌ UTC days | Wrong "yesterday" for everyone but UTC | No shift, but the wrong days | ~420 |
| ❌ Group UTC hours at query time | Splits hours | Needs care | ~10,000 |

---

## 🔐 Access, Privacy and Exports (~2 min)

- **Roles per org,** re-read on every request: admin (metrics, billing, drill-down, export), analyst (no billing), and internal support (any org, metrics only: no billing, no conversation lists).
- **The server omits, the client never hides.** The overview leaves billing tiles out entirely, a cost series returns 403, and drill-down and export rows have no cost column. A column hidden in the browser is still in the network tab.
- **Permission scope is in the cache key.** Without it, an analyst could be served an admin's cached response, cost included. A test asserts that can't happen.
- **Small cohorts.** Filtered series buckets, breakdown rows and drill-downs under 5 distinct users are suppressed before the response is built. Two or more small groups are pooled into "other (n)" only when their *merged* distinct count reaches 5, because summing counts double-counts a person in two groups. A single small group is never pooled on its own: "other" would just be that group renamed.
- **Exports are jobs.** Each click gets an Idempotency-Key that's reused if the POST is retried, and a unique (user, key) constraint returns the original job. Columns are fixed from the requester's permissions at creation and re-checked at download. Workers claim jobs with skip-locked rows and a 30-second lease, and their progress writes are fenced on the worker ID. The progress card polls every second and survives navigation. A streamed CSV would tie a minutes-long export to one connection, a deploy would kill it, and the user's re-click would double the load.

---

## 💬 Follow-up Questions (~4 min)

**Late or duplicate events: how do the charts change?** Duplicates don't change them at all, because they're dropped at the claim before any rollup sees them. A late event lands in the bucket of its event time. The bar's number grows on the next fetch, it gets ↻ with the count and time of the revision, and any cached answer covering that day is invalidated through the revision counter.

**Why did yesterday's number change?** Because late events arrived: a phone that was offline, or a client whose first send failed and whose retry got through hours later. The tooltip and the freshness popover say how many and when ("+200 late events at 20:18"). The drill-down marks which conversations arrived late. After 72 hours the day is sealed, and anything later is rejected and counted rather than silently added.

**Time zones and daily buckets?** Daily means the org's calendar day, fixed at ingest as local_date. Weeks compare on the wall clock across DST, and half-hour zones go through the planner (deep dive 3).

**Can we store hourly unique users and add them up, or average hourly p95s?** No. A user active in five hours is counted five times, and the p95 of a day isn't any function of 24 hourly p95s: averaging weights a quiet 3 am hour the same as a busy noon. Rollups store HyperLogLog and t-digest states, which merge correctly across any set of buckets and filters. Values are approximate (about ±1% for distinct counts), the UI marks them with ≈, and the drill-down explains why its exact count can differ.

**How do you protect conversation content?** By never collecting it. The contract has no content fields, unknown keys are rejected, and content-like keys raise an alert to the producing team. Rejected payloads are never stored. user_id is pseudonymous, drill-downs show metadata only, support can't list conversations, and cohorts under 5 users are suppressed.

**What freshness can you honestly promise?** "Events that happened before T have almost certainly been counted", where T is the watermark. The target is that T trails now by under 2 minutes for server events and 15 for client events. If a partition is missing, the label says "freshness unknown"; if one stalls, it turns red. It never shows a green "live". The words "almost certainly" are deliberate: an event can still arrive up to 72 h late and revise a day, and the UI shows when that happens.

**Filters change several times a second: what reaches the server, and what reaches the screen?** The chips and the URL update instantly. Requests follow the filters only after they've been stable for 200 ms, so a burst of six clicks becomes one request per widget. A request still running when the filters move on is aborted. The browser closes the connection, the API sees the close and cancels the ClickHouse query, so no warehouse time goes to answers nobody wants. Toggling back to a recent combination is a cache hit. On screen, each response can only fill the cache entry for its own key, and the echo check rejects any mismatch. Until the new answer arrives, the old chart stays dimmed under "Updating": no blank flash, and never old numbers under new chips.

**A new metric needs a backfill.** I add it to the catalog and as a rollup column, and the materialized view fills it from deployment on. A coverage row records collected_from (when its inputs started existing in raw events) and available_from (when the rollups became complete). Buckets in between render as a labelled "backfill pending" band, not zeros. A rebuild then recomputes sealed days, older than 72 h, from raw events. Raw events are kept for 400 days and Kafka only 7, so I rebuild from the raw table rather than replaying the topic. The rebuild bumps those days' revisions and moves available_from back. Days that weren't sealed yet are rebuilt once they are.

---

## ✅ Design Review Checklist (~1 min)

| Question | Answer |
|----------|--------|
| Source of truth, and when is a write successful? | Raw events in ClickHouse for numbers; PostgreSQL for configuration and jobs. An event is written once the insert returns and inserted-through is recorded; the Kafka commit follows |
| A client retries after losing the response? | Producers resend the same event_id and the claim drops the copy. A retried export POST with the same key returns the original job |
| A worker fails between two steps? | After the claim, before the insert: the redelivery finds its own claim and is kept. After the insert, before recording: the token makes the retry a no-op. After recording, before the commit: the offset is skipped. A dead export worker's lease expires and the job is reclaimed |
| Which ordering is actually required? | Only per partition, and only for the watermark. Rollups are commutative merges |
| Access with caches and async jobs? | Roles re-read per request, part of the cache key, fixed into export columns and re-checked at download; suppression before the response is built |
| What breaks first? | The dedup claim set, then hot orgs, below |

---

## 📈 What Breaks First (~1 min)

| Rank | Component | Why | Fix |
|------|-----------|-----|-----|
| 1 | Valkey dedup claims | 230K events/s × 96 h ≈ 80B claims, far beyond one instance's memory | Shard claims by event_id across a cluster, or shorten the window to the client retry horizon and lean on ReplacingMergeTree plus nightly sealed-day rebuilds |
| 2 | Hot org partitions | Keying by org_id puts a giant org on one partition and one consumer | Key the largest orgs by (org, hash(user) mod N); only the watermark used partition order, and it takes the minimum anyway |
| 3 | Raw edges and drill-downs | Rollup reads are tiny; raw scans are not | Planner edges bounded to minutes, drill pages of 25, query timeouts per widget |
| 4 | Refresh fan-out | 20K viewers × 8 widgets every 60 s ≈ 3K queries/s | Shared result cache; sealed windows cached for 10 minutes |

> "I'd watch ingest chunk duration p99 and Valkey memory for the first, and watermark lag per partition for the second. They fail differently: one slows every org, the other delays one big customer."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Metric meaning | One catalog for charts, drills, exports | Per-widget queries | One number, one definition |
| Bucketing | Event time + watermark | Processing time | Right numbers, honestly labelled partial |
| Dedup | Claim per event_id + insert token | ReplacingMergeTree only | Rollups never see a duplicate |
| Uniques and percentiles | HLL and t-digest states | Stored counts and p95s | Merge across any buckets; ≈ ±1% |
| Daily buckets | local_date at ingest | Group UTC hours at query time | Works in half-hour zones; a tz change needs a rebuild |
| Query identity | Canonical resolved query: key + echo | Relative ranges | Widgets, drill and export agree |
| Filter bursts | 200 ms debounce + abort to the warehouse | Request per click | Bounded load; only current filters paint |
| Access | Server omits billing; scope in cache key | Hide columns in the UI | The browser is not a boundary |
| Small cohorts | Suppress < 5; pool on merged distinct | Show everything | Nobody can be singled out |
| Exports | Background job + idempotency key + lease | Streamed CSV | Survives navigation and deploys |
| Backfill | Rebuild sealed days from raw | Replay Kafka | 400-day raw retention vs 7 days |

---

## 📝 Wrap-up (~1 min)

> "To sum up: every number starts as a written definition with one implementation. Events carry an ID and an event time and never content. Ingest drops duplicates before the rollups can count them, buckets by when things happened, and publishes a watermark, so the dashboard can say how complete it is and which days late data revised. Rollups keep sketch states, so any window and filter merges correctly, in the org's own calendar. On the client, one canonical query drives every widget, the drill-down and the export, so they can't disagree, and stale responses are dropped by key and echo. Access and privacy are enforced where the data is, not where it's drawn. What I'd validate first is the watermark under a real partition stall, and the dedup memory curve, because that's the wall."

### How the local implementation compares

The repo runs this design on one machine: Kafka with three partitions, a single non-replicated ClickHouse, PostgreSQL and Valkey in Docker, plus a generator that plays the collector, seeding 35 days for four fictitious orgs (including Los Angeles, Kolkata and Auckland) and adding live traffic with about 2% duplicates and 3% late events. The frontend is React with TanStack Query for widget data and Zustand for session and export state. Compared with this answer, there's no HTTP collector, CDN, multi-region mirroring or gateway rate limiter. Insert dedup relies on a non-replicated dedup window instead of replicated block dedup, and exports go to a local directory instead of object storage. The in-flight chunk range was added after review found that a replay could cut different boundaries. Verified live: 288 re-sent duplicates left counts unchanged, 200 late events moved yesterday from 288 to 488 with a visible revision, the drill-down reconciled at 488 = 488, and rapid chip toggles against a 1.5-second simulated warehouse delay aborted 12 superseded requests, with only the final filters painting.
