# LLM Chat Analytics — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Definitions → Requirements → Architecture → Data model → API → Deep dives → Traces → Scale*

> "Before I draw any boxes I want to agree on what the numbers mean. An analytics system rarely fails by going down. It fails by showing a chart that is confidently wrong: two teams get different 'active users' for the same day, or yesterday's number moves overnight and nobody can say why. So I'll start with metric definitions and an event contract. Then I'll build a pipeline that does four things to every number: counts each event once, buckets it by when it happened, stores it so it merges correctly over any window, and says honestly how complete it is."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Definitions and requirements | ~7 min | Written metric definitions, the event contract, capacity math that forces rollups |
| Architecture | ~6 min | Collector → Kafka → ingest → ClickHouse rollups → query API, and why each hop exists |
| Data model and API | ~7 min | Raw table plus sketch-state rollups; role-gated, cache-safe query endpoints |
| Deep dives | ~15 min | Dedup through crashes, late data and watermarks, metrics that don't add up |
| Traces, follow-ups, scale | ~10 min | One success and one failure, the follow-up answers, and what breaks first |

---

## 🎯 Requirements (~7 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who reads the dashboards? | Tenancy and access | Customer org admins and analysts see their own org; internal support sees any org's health |
| What does "near real time" mean? | Streaming versus batch | Under a minute from event to queryable, with a label saying how complete the data is |
| May a past day's number change? | Event time versus arrival time | Yes, for up to 72 hours, and visibly |
| Does message content ever enter analytics? | The privacy boundary | Never. Metadata only |
| Exact or approximate distinct counts? | Sketches versus exact sets | About ±1% is fine on charts if labelled; drill-downs are exact |
| Whose "yesterday"? | Daily bucketing | The org's calendar day in its own time zone |

### Metric definitions come first

> "I'd write these on the board and get a nod before going further. Every later decision, from the event schema to the rollup columns, falls out of these few lines."

| Term | Definition | Consequence for the design |
|------|-----------|----------------------------|
| Conversation | One `conversation_started` event, counted in the bucket of its event time, whatever happens afterwards | It can't be split by feature, because features are only known per message |
| Active user | A distinct user who sent at least one `message_sent` in the period | Opening the app or receiving a response doesn't count. It is a distinct count, so it never sums |
| Response attempt | Exactly one server-reported terminal event per generation: completed, failed or abandoned | The denominator for every rate |
| Successful response | `response_completed`: the model streamed to its natural end and the server delivered the final token | Success rate = completed ÷ attempts |
| Abandoned generation | `response_abandoned`: the user pressed Stop or disconnected after the request started and before the final token | The server reports it, because it sees the stream end. A closed tab still counts and a crashed client can't under-report |
| TTFT and total time | Server-measured, over completed responses only | Percentiles come from merged t-digests |
| Cost | Tokens × the list price in effect at event time | Billing data: admins only |

### The event contract

| Field | Rule |
|-------|------|
| `event_id` | UUID the producer generates once and reuses on every retry. This is the dedup key |
| `org_id`, `user_id` | `user_id` is pseudonymous and stable per org, never an email or a name |
| `event_type`, `source` | Client: `conversation_started`, `message_sent`. Server: `response_completed`, `response_failed`, `response_abandoned`. The source must match the type |
| `event_time` | When it happened, by the producer's clock. All bucketing uses it |
| `received_time` | Stamped by the collector. Never trusted from a device |
| `schema_version` | Version 1, strict: any unknown key rejects the event |
| `conversation_id`, `generation_id`, `model`, `feature`, `platform` | Join keys and dimensions |
| `ttft_ms`, `latency_ms`, token counts, `error_code`, `abandon_reason` | Measures, depending on the event type |

What the contract leaves out matters just as much. There is no content field. Keys that look like content (`content`, `prompt`, `text`, `message`, `completion` and similar) are rejected with their own reason, `content_field`, which pages the producing team. Rejections are recorded as metadata only: reason, partition, offset. The payload is never stored.

### Functional requirements

1. Overview tiles: active users, conversations, success, error and abandon rates, TTFT p95, tokens, and cost for admins, each compared with the previous week or month.
2. Time series by minute, hour or day, with the open bucket marked partial.
3. Breakdowns by model and feature that cross-filter the other widgets.
4. A drill-down from any bar to the conversations behind it: metadata only, from the same predicate as the bar.
5. A freshness label, plus which recent days late events revised.
6. CSV exports as background jobs; a pipeline health page.

### Non-functional requirements

| Property | Target | Note |
|----------|--------|------|
| Ingest | 500K events/s peak, 20B/day | Each user message produces 2–4 events |
| Freshness | p99 ingest-to-queryable < 60 s; watermark lag < 2 min (server), < 15 min (client) | What a support engineer can act on |
| Correctness | Duplicates never double-count; events up to 72 h late land in their own bucket | Numbers compared across days must be explainable |
| Query latency | p95 < 500 ms for 28 days daily; < 2 s for 90 days hourly | Filters change several times a second |
| Availability | 99.9% for queries; ingest may lag but never loses events | Kafka retention absorbs warehouse outages |
| Privacy | Zero content; breakdowns under 5 distinct users suppressed | Analytics must not single anyone out |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Events | 20B/day ≈ 230K/s average, 500K/s peak | 50M daily active users × ~400 events each |
| Raw storage | ≈ 1.2 TB/day, ≈ 480 TB at 400 days | ~60 bytes per compressed event, with no content and low-cardinality columns |
| Day rollup rows | ≈ 3M/day across 200K orgs | One row per (org, local day, model, feature) |
| 28-day org chart | ≈ 420 rollup rows read | 28 days × ~3 models × ~5 features, whatever sits underneath |
| Dashboard queries | ≈ 3K/s | 20K viewers × 8 widgets refreshing every 60 s, mostly cache hits |
| Dedup claims held | ≈ 80B | 230K/s × 96 h claim lifetime |

> "Three numbers drive the design. 500K events a second puts this in Kafka and a columnar store, not PostgreSQL. 1.2 TB a day means no dashboard can scan raw events over weeks, so rollups are mandatory: a 28-day chart reads about 420 rows instead of hundreds of millions of events, and that's how I hit 500 ms. And 80 billion live dedup claims is the number I'll come back to at the end, because it's what breaks first."

---

## 🏗️ Architecture (~6 min)

```
 ┌──────────────┐   ┌──────────────┐
 │ Chat clients │   │ Chat servers │
 └──────┬───────┘   └──────┬───────┘
        │ client events    │ server events   (metadata only, never content)
        ▼                  ▼
 ┌─────────────────────────────────────┐
 │ (1) Collector (stateless)           │  validate · stamp received_time
 └──────────────────┬──────────────────┘
                    ▼
 ┌─────────────────────────────────────┐
 │ (2) Kafka: chat-events              │  key = org_id · 7-day retention
 └──────────────────┬──────────────────┘
                    ▼
 ┌─────────────────────────────────────┐      ┌──────────────────────────────┐
 │ (3) Ingest consumers                ├─────▶│ Valkey                       │
 │ dedup claim · late check · enrich   │◀─────┤ dedup claims (96 h)          │
 └──────────────────┬──────────────────┘      │ inserted-through · positions │
                    │ (4) insert + dedup token│ day revisions · query cache  │
                    ▼                         └──────────────▲───────────────┘
 ┌─────────────────────────────────────┐                     │ (7) cache key,
 │ (5) ClickHouse                      │                     │     watermarks
 │  events (ReplacingMergeTree)        │      ┌──────────────┴───────────────┐
 │   ├─MV─▶ rollup_minute     (3 d)    │◀─────┤ (6) Query API (stateless)    │
 │   ├─MV─▶ rollup_hour      (90 d)    │ plan │ catalog · planner · access   │
 │   └─MV─▶ rollup_day_local  (∞)      │      │ drill-down · freshness       │
 └──────────────────▲──────────────────┘      └──────────────┬───────────────┘
                    │ raw FINAL, one day at a time           │ (8) roles, tz,
 ┌──────────────────┴──────────────────┐                     │ coverage, jobs
 │ (9) Export workers (leased jobs)    │      ┌──────────────▼───────────────┐
 │ CSV → object storage                ├─────▶│ PostgreSQL                   │
 └─────────────────────────────────────┘      │ orgs + tz · users · roles ·  │
                                              │ prices · coverage · exports  │
                                              └──────────────────────────────┘
```

**Walking the diagram:**

1. Clients and chat servers send events to a stateless collector. It checks the schema, stamps `received_time`, and answers only after Kafka has acknowledged the write.
2. Kafka partitions by `org_id`. Each partition is in arrival order, which the watermark depends on, and seven days of retention cover a warehouse outage.
3. Ingest consumers read chunks of up to 2,000 messages from one partition. They claim each `event_id` in Valkey, flag late events, and enrich each row with the org-local date and cost. Org time zones and the price table are cached from PostgreSQL and refreshed every 15 s.
4. Each chunk goes to ClickHouse as one insert with a deterministic dedup token.
5. Three materialized views turn every insert into minute, hour and org-local-day rollup rows.
6. The query API resolves the metric from the catalog, checks access, plans the window across rollups, and reads ClickHouse.
7. It keys its result cache on the canonical query, the caller's permissions and the revisions of the days covered. It reads watermarks from the partition positions in Valkey.
8. PostgreSQL holds the small relational things: orgs and time zones, memberships, versioned prices, metric coverage, export jobs.
9. Export workers lease jobs from PostgreSQL and write CSVs one local day at a time.

**Placement decisions I'd say out loud:**

- **Kafka sits between the collector and the warehouse.** A ClickHouse outage then means lag, not loss. A future alerting consumer can read the same stream, and per-partition order makes the watermark possible.
- **Materialized views instead of a stream processor.** Rollups update in the same insert that writes the raw row, with no separate state store or checkpointing to run. The price is that a duplicate reaching `events` is counted in every rollup immediately, so dedup has to finish before the insert. That's deep dive 1.
- **PostgreSQL never sits on the event path.** Ingest only reads cached reference data from it. 500K events a second never touch a relational primary.

---

## 💾 Data Model (~4 min)

| Table (ClickHouse) | Engine and sort key | Columns | Notes |
|--------------------|---------------------|---------|-------|
| events | ReplacingMergeTree; sorted by (org_id, event date, event_type, event_id); monthly partitions; 400-day TTL | Contract fields plus `ingested_at`, `local_date`, `org_tz`, `cost_micros`, `lateness_ms`, `is_late` | Source of truth. Drill-downs, exports and rebuilds read it with FINAL |
| rollup_minute | AggregatingMergeTree on (org_id, UTC minute, model, feature); 3-day TTL | Counts and token/cost sums as summed columns; `active_users` HyperLogLog state; `ttft` and `latency` t-digest states (p50/p95/p99); `late_events`; `last_revised_at` (max) | Minute charts and the ragged edges of windows |
| rollup_hour | Same shape on UTC hour; 90 days | Same | Hour charts and sub-day pieces |
| rollup_day_local | Same shape on the org-local date; kept forever | Same | Day charts and the whole days of any window |
| rejected_events | MergeTree; 30-day TTL | Reason, detail, event_id, org, type, partition, offset | Never the payload |

| Table (PostgreSQL) | Key columns | Constraints | Notes |
|--------------------|-------------|-------------|-------|
| orgs | id, name, time_zone | PK id | The zone drives `local_date` at ingest |
| users, memberships | (user_id, org_id) PK, role admin or analyst; `is_staff` marks support | FK cascade | Re-read on every request |
| model_prices | (model, effective_from) PK, input and output micros per million tokens | - | Versioned. A price change never rewrites history |
| metric_coverage | metric PK, collected_from, available_from, note | - | Drives `not_collected` and `backfill_pending` gaps |
| export_jobs | id, user_id, org_id, idempotency_key, kind, query, columns, status, rows_done/total, attempts, worker_id, lease_expires_at, file, expires_at | Unique (user_id, idempotency_key); index (status, created_at) | Fixed columns and a lease |

| Valkey key | Holds | Lifetime |
|------------|-------|----------|
| `dedup:{event_id}` | The `partition:offset` of the message that claimed the event | 96 h |
| `ingest:inserted-through` | Hash: partition → last offset already in ClickHouse | Persistent |
| `ingest:positions` | Hash: partition → position, updatedAt, lag | Rewritten every 2 s |
| `rev:{org}` | Hash: local_date → revision counter | Persistent |
| `q:{sha1}` | A cached widget response | 10 s for open windows, 600 s for sealed ones |

**Data decisions:**

- **Rollups store states, not answers.** A row holds a HyperLogLog sketch of who was active and a t-digest of latencies, not "412 users" or "p95 = 830 ms". That is what makes a week, a filter or a half-hour edge merge correctly (deep dive 3).
- **`local_date` and `cost_micros` are computed once at ingest** and stored on the raw row. The day a row belongs to and the price it was charged are facts about the event, not about the query.
- **There is no column a message could hide in.** The strict schema means nothing in the warehouse can leak conversation content.

---

## 🔌 API Design (~3 min)

Every query endpoint takes the same canonical filters: `org`, `from` and `to` (local midnights in the org's zone for day charts, whole minutes otherwise), `grain`, `models`, `features`, `compare`.

```
POST /api/v1/auth/login                → Session cookie; orgs with role, time zone, permissions
GET  /api/v1/query/overview            → KPI tiles with comparison, coverage, not-applicable flags
GET  /api/v1/query/series?metric=      → Buckets: value, partial, open, coverage, suppressed, lateEvents, revisedAt
GET  /api/v1/query/latency             → p50/p95/p99 TTFT and total time per bucket
GET  /api/v1/query/breakdown?metric=&dim=   → Rows by model or feature, small groups pooled or hidden
GET  /api/v1/query/drilldown?metric=&bucket= → The bar's rollup count, raw matched count, one page of conversations
GET  /api/v1/freshness?org=            → Watermark per stream, backlog, revised days
GET  /api/v1/pipeline                  → Partition positions, counters, rejections
GET  /api/v1/meta                      → Metric catalog, event contract, coverage
POST /api/v1/exports                   → Idempotency-Key required: 202 new job, 200 same job again
GET  /api/v1/exports/:id               → Status, rowsDone / rowsTotal
GET  /api/v1/exports/:id/download      → CSV, permissions re-checked
```

| Status | When | Why this code |
|--------|------|---------------|
| `400 UNALIGNED_RANGE` / `TOO_MANY_BUCKETS` | A day range not on local midnights, an hour or minute range not on a whole minute, or > 1,500 buckets | Aligned ranges keep cache keys finite and plans bounded |
| `403 METRIC_FORBIDDEN` | An analyst or support user asks for a cost series | The value is never computed for them |
| `403 FORBIDDEN` | Support asks for a drill-down or export | Support sees health, not conversations |
| `404 ORG_NOT_FOUND` | An org the caller doesn't belong to | Same answer as a nonexistent org, so IDs reveal nothing |
| `422 DIMENSION_NOT_APPLICABLE` | Conversations filtered or broken down by feature | A silent 0 would be a wrong answer that looks right |
| `499 CLIENT_CLOSED` | The browser aborted the request | The warehouse query is cancelled too |

**Access is enforced on the server.** Roles are re-read from PostgreSQL on every request.

| Role | Metrics | Billing (cost) | Drill-down | Export |
|------|---------|----------------|------------|--------|
| admin | yes | yes | yes | yes, with cost columns |
| analyst | yes | no: tiles omitted, series 403, no cost column | yes | yes, without cost |
| support (any org) | yes | no | no | no |

- **The permission scope is part of the cache key.** The key hashes the widget, the canonical query, the caller's sorted permissions and the revision vector. Otherwise an analyst could be served an admin's cached response with cost in it. A test asserts that never happens.
- **Small cohorts.** Breakdown rows, filtered series buckets and drill-downs covering fewer than 5 distinct users are suppressed. Two or more small groups may be pooled into "other", but only when their *merged* distinct-user count reaches 5. Summing their counts would count one person in three groups three times. A single small group is never pooled, because "other" would just be that group under a new name.
- **Exports are leased background jobs.** The POST inserts with "on conflict do nothing" on (user, Idempotency-Key), so a double-click or a retry gets the original job back. A worker claims with `FOR UPDATE SKIP LOCKED` and a 30 s lease, and writes one local day at a time. Each progress update is fenced on `worker_id` and renews the lease. A worker that lost its lease stops, a dead worker's job is reclaimed (3 attempts), and the file is written as a partial and renamed when complete. Columns are fixed from the requester's permissions at creation and checked again at download. A demoted admin can't fetch the cost column, and the worker refuses to run if the requester has lost access to the org.

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: Counting each event exactly once, through crashes and retries

**Decision.** Dedup happens in ingest, before the insert, in three layers. (1) A Valkey claim per `event_id` whose value is the Kafka `partition:offset` of the message that carried it, set with SET-if-absent-and-return-old-value in one pipeline per chunk. (2) A deterministic `insert_deduplication_token` per chunk, `p{partition}-{first}-{last}`. (3) An `inserted-through` offset per partition. ReplacingMergeTree on the raw table is a backstop, not the mechanism.

**Why it works here.** The claim's value tells two different events apart. If the claim is absent, this message now owns the event. If it holds *this* message's own `partition:offset`, Kafka is redelivering a message we already saw before a crash, so I keep it. If it holds any other value, a second copy of the event exists, typically a client that retried after losing its acknowledgement. That copy is dropped. The other two layers cover the crash windows. A retried insert of the same chunk carries the same token, so ClickHouse ignores it. A chunk that landed before the crash is skipped by `inserted-through`. The claim lives 96 h, longer than the 72 h maximum lateness. The original arrived no earlier than its event time, so its claim outlives any copy that could still be accepted.

**The finding from testing.** The first version put the dedup window only on `events`. A forced retry with the same token was correctly dropped from the raw table, but the materialized views still fired, and every rollup counted the chunk twice. The dashboard was wrong while the raw table looked perfect. Every rollup table needs its own `non_replicated_deduplication_window`, and the insert needs dedup enabled for dependent views. On a replicated production cluster this block dedup is native, but the lesson holds: test dedup against the derived tables, not just the source.

**How the alternatives break.**

- *ReplacingMergeTree alone* removes duplicates from the raw table only eventually, at background merge time, and never from rollups. The views already aggregated the duplicate on insert, and nothing un-counts it.
- *A plain "set if absent" claim with no value* loses data. If ingest crashes after claiming but before inserting, the redelivered message finds the claim, is treated as a duplicate and dropped. The event is never counted.
- *Dedup at query time* (FINAL or exact distinct on `event_id` in every query) is correct, but every chart then scans raw events. The 420-row read becomes hundreds of millions of rows, and the 500 ms target is gone.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Claim with `partition:offset` + insert token + inserted-through, RMT as backstop | Rollups never see a duplicate; every crash window covered | A Valkey round trip per chunk; ~100 bytes per event held for 96 h |
| ❌ ReplacingMergeTree only | No extra store | Rollups double-count permanently |
| ❌ Plain set-if-absent claim | Simplest | Crash between claim and insert loses events |
| ❌ Dedup at query time | Exact | Scans raw on every chart |

**What I give up.** Memory: 96 hours of claims is the biggest state in the system and what breaks first. And a subtlety I'd raise myself: the token only protects a retry of the *identical* chunk. The insert retry loop always resends the identical chunk. A redelivery after a crash could cut the chunk differently if more messages had arrived meanwhile, so the consumer records the in-flight offset range before inserting, and the new owner re-forms exactly that range first. If Valkey ever loses claims, raw duplicates collapse at merge, the drill-down shows the rollup and raw counts disagreeing, and a sealed-day rebuild repairs the rollup.

### Deep dive 2: Late data, watermarks, and a freshness label that doesn't lie

**Decision.** Bucket by `event_time`, never arrival time. Track how complete each stream is with a watermark. Let late events reopen closed buckets, flag them, and stamp a revision on every day they touch. Reject events more than 72 h late.

**How the watermark is computed.** Every 2 s, each ingest instance reports a position for each partition it owns: the newest `received_time` it has written to ClickHouse, or *now* if the partition has no backlog. A partition is in arrival order, so everything received before its position is in the warehouse. The watermark for a stream is the minimum position over *all* partitions, minus that stream's allowance: 1 minute for server events from our own services, 10 minutes for client events from phones and laptops that go offline. A metric's watermark is the minimum over the streams it reads, so cost per conversation uses both. If a partition has never reported, the watermark is *unknown*, not optimistic. If a partition's owner stops reporting for 30 s, the partition is marked stalled and holds the watermark at its last position. Both cases show on the pipeline page, and the freshness label turns red.

**What a late event does.** On arrival, `is_late = event_time < watermark(stream)`: this event changes a bucket the dashboard has already called complete. The row still lands in its own bucket. The rollups add to `late_events` and move `last_revised_at`, and ingest increments `rev:{org}[local_date]` for every day a late row touched. Cache keys include the revision vector of the days in the window, plus the comparison period's days. So a cached "last 7 days" becomes unreachable exactly when one of its days changes, and a sealed window can safely be cached for 10 minutes. After 72 h an event is rejected as `too_late` and recorded. That makes a day *sealed*: it can no longer change through ingest, which is what makes rebuilds safe.

**How the alternatives break.**

- *Processing-time buckets* give stable numbers in the wrong buckets. A phone offline for an hour moves a 09:00 conversation to 10:00. A 20-minute ingest outage draws a hole followed by a spike. A backfill lands a week of history in one minute.
- *Windows emitted once at the watermark, with late data dropped* (the classic stream-processor default) give numbers that never change but systematically undercount. Mobile users on flaky networks are the late ones, so the bias isn't random: it hides exactly the platform a product team is most likely asking about.
- *Waiting 72 h before showing a day* is stable and correct, and useless to a support engineer during an incident.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Event time + watermark + per-day revisions | Right buckets; honest partial labels; explainable changes | Past numbers move; revision-aware caching |
| ❌ Processing time | Never changes | Wrong buckets for offline devices, outages, backfills |
| ❌ Emit once, drop late data | Never changes | Biased undercount of mobile users |
| ❌ Show only sealed days | Stable and right | Not near real time |

**What I give up.** Yesterday's number can change, so the product has to explain it. The bar shows a revised marker, and the freshness popover says something like "+200 late events at 20:18". The watermark is also only as good as the allowance. A client event arriving 30 minutes late is still behind a 10-minute allowance, which is precisely why `is_late` exists. Finally, one slow partition holds back freshness for every org, a cost I revisit under scaling.

### Deep dive 3: Metrics that don't add up, and whose "day" it is

**Decision.** Rollups store mergeable states: summed columns for counts, tokens and cost, `uniqCombined64` (HyperLogLog-based) states for active users, and t-digest states for p50/p95/p99. Ratios are always computed from summed numerators and denominators at query time. Daily rollups are keyed by `local_date`, computed at ingest from the org's time zone. A planner splits any requested window into pieces each table can answer exactly.

**Why it works here.** Active users this week is a merge of seven daily sketches, not their sum. A daily p95 is a merged digest, not an average of 24 hourly p95s. Because every piece produces the same state columns, the planner can take "this week so far" and split it into raw, minute, hour, whole-local-day, hour, minute and raw pieces. One query unions them and merges once. Take Asia/Kolkata (UTC+5:30), where local midnight is 18:30 UTC. Whole days come from `rollup_day_local`, the half-hour between 18:30 and 19:00 UTC from minute rollups (or raw events once minute rollups have expired), and whole hours after that from `rollup_hour`. Hour charts in such a zone clip their first and last buckets at the range edge and say so. Week-over-week shifts by local wall-clock time, so Monday 09:00 compares with the previous Monday 09:00 even across the DST change.

**How the alternatives break.**

- *Storing finished numbers* (unique users per hour, p95 per hour) looks fine on a one-hour chart and is wrong everywhere else. Someone active in five hours is counted five times in the daily total. A quiet hour with ten slow responses weighs the same as a busy hour with 100K fast ones in an averaged p95.
- *Exact user sets per bucket* are correct, but a large org's bucket would carry millions of IDs, and merging 28 days of them per widget per refresh blows the latency budget.
- *Keeping only UTC hours and grouping them into local days at query time* works for whole-hour zones. It breaks for India (+5:30), Nepal (+5:45) and Newfoundland (−3:30), and reads 24 rows per day per dimension combination. *UTC days* make a Los Angeles org's "yesterday" run from 4 pm to 4 pm.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Sketch states + `local_date` at ingest + planner | Correct over any window, filter and zone | ≈ ±1% on distinct counts; larger rows; a zone change needs a rebuild |
| ❌ Finished counts and percentiles | Small and exact per bucket | Wrong for every multi-bucket window |
| ❌ Exact sets per bucket | Exact | Storage and merge cost explode |
| ❌ UTC hours grouped at query time | One fewer table | Breaks half-hour zones; 24× the rows |

**What I give up.** Distinct counts are estimates, so the UI marks them ≈, and the drill-down explains that its exact count can differ slightly. Rollup rows are larger. And `local_date` is frozen at ingest: if an org changes its time zone, new events follow the new zone, and old days are re-localized by a rebuild of sealed days.

---

## 🧭 Execution Traces (~4 min)

### Successful trace: a late event revises yesterday

1. A user on a flight starts a conversation at 14:05 yesterday in Los Angeles (22:05 UTC). The phone generates the `event_id` immediately and queues the event offline.
2. 30 hours later the phone reconnects. The collector finds no content keys, stamps `received_time` = now, writes the event to the org's partition, and acknowledges once Kafka has.
3. The ingest consumer that owns the partition reads it in a chunk. The offset is past `inserted-through`. The event isn't from the future, and 30 h is under the 72 h limit.
4. The claim returns nothing, so the event is now owned by this message's `partition:offset`.
5. The client watermark is about ten minutes behind now, and the event is far behind it, so `is_late = 1`. `local_date` is yesterday in America/Los_Angeles.
6. The chunk is inserted with its token. The views add 1 to `conversations` and to `late_events`, and set `last_revised_at`, in yesterday's day row and in the 22:05 minute and 22:00 hour rows.
7. Ingest records `inserted-through`, bumps `rev:{org}` for yesterday's date, then commits the Kafka offset.
8. An analyst's dashboard refreshes. The revision vector changed, so the cache key is new. ClickHouse returns 489 for yesterday instead of 488, with a late-event count and a revision time, and the bar shows its revised marker.
9. The analyst drills into the bar. The rollup count and the raw count from `events FINAL` for that local date both say 489.

### Failed trace: ingest dies mid-chunk while a client retries

1. A client sends `message_sent` E. Kafka stores it at partition 0, offset 100, but the acknowledgement is lost. The client retries with the same `event_id`, and Kafka now also holds E at offset 140.
2. Consumer A reads offsets 100–199. E at 100 claims `0:100`. E at 140 finds `0:100`, which isn't its own, so it's dropped as a duplicate.
3. A inserts the surviving rows with token `p0-100-199`, ClickHouse acknowledges, and A is killed before recording `inserted-through` or committing.
4. The group rebalances. Consumer B gets partition 0 and refetches from the committed offset, 100.
5. `inserted-through` is still 99, so nothing is skipped. E at 100 finds its own claim and is kept. E at 140 is dropped again. Every other event in the chunk also finds its own claim.
6. B inserts the identical rows with the identical token. `events` and all three rollup tables recognise the token and ignore the block.
7. B records `inserted-through` = 199 and commits 200. The count is unchanged and the pipeline page shows one more duplicate. If A had died *after* recording `inserted-through`, B would have skipped the chunk outright. If A had died after claiming but *before* inserting, B's own claims would let every event through exactly once.

---

## ❓ Follow-up Questions (~5 min)

**"Events arrive late or twice. How do the charts change?"** A second copy changes nothing: its claim belongs to another message, so it is dropped before any table sees it, and only the duplicate counter moves. A late event lands in the bucket of its event time. If that bucket was already behind the watermark, it is flagged late. The bar grows, shows a revised marker with the count of late events, and the day's revision counter invalidates every cached window covering it. The open edge of each chart is drawn as partial because more events are still expected there.

**"Why does yesterday's number differ today?"** Up to 72 h after a day ends, late events can still land in it: offline phones, retried uploads, a stalled partition catching up. Each one is flagged and counted, so the answer isn't "the data changed" but "+200 late events at 20:18". A rebuild of a sealed day (a backfill or a repair) also bumps the revision. After 72 h, ingest can no longer change the day.

**"How do time zones affect daily buckets?"** A day is the org's calendar day. `local_date` is computed at ingest from the org's zone and keys the daily rollup, so a 23- or 25-hour DST day and a +5:30 offset are both handled by one column. Windows that don't align to local days are planned across hour, minute and raw pieces. Comparisons shift by local wall-clock time.

**"Can we add hourly unique users, or average the hourly p95s?"** Hourly uniques, yes, as their own per-hour values from each hour's sketch. But never sum them into a day: a user active in five hours would count five times. The day is a merge of the 24 states. Averaging p95s is wrong for the same reason, so a day's p95 comes from the merged digest. Rates follow the same rule: success rate is the sum of completions over the sum of attempts, not an average of hourly rates.

**"How do you keep analytics from exposing conversation content?"** By never collecting it. The contract has no content field. Content-like keys are rejected with their own reason and page the producer's team, and rejected payloads are never stored. `user_id` is pseudonymous. Drill-downs show metadata only, and support staff can't list conversations at all. Groups under 5 distinct users are suppressed, and pooled only on merged distinct counts.

**"What freshness guarantee can the UI honestly display?"** Two clocks, never one. "Complete through 14:02" is the watermark: events that happened before it have almost certainly all been counted. "Last refreshed" is when the browser last fetched. A dashboard can refresh every 15 s while the data is an hour behind. Buckets after the watermark are hatched as partial. If any partition is missing or stalled, the label says "unknown" in red rather than guessing. The fine print I'd show: days in the last 72 h may still be revised, and revised days are marked. The SLO behind it: watermark lag under 2 min for server events and under 15 min for client events.

**"The user changes filters several times a second. What reaches the server?"** The client aborts superseded requests. On the server, a closed connection fires an abort signal that is passed to every ClickHouse query that request started, so abandoned work stops instead of finishing for nobody. In production I'd also make sure the warehouse cancels read-only queries when the client goes away. Every query is capped at 8 s. Ranges must be bucket-aligned, and the canonical query string (fixed key order, sorted and de-duplicated lists, ISO instants) gives one cache key per distinct question. Toggling a chip off and on again within the cache lifetime is a hit, and so is a colleague with the same permissions opening the same view. The server echoes the canonical query so the client can drop a late answer to an old question.

**"A new metric needs a backfill. What do charts show before it existed?"** Each metric has two dates in `metric_coverage`. Before `collected_from`, the raw events never carried the data: those buckets are `not_collected`, and the chart draws a labelled gap, never zeros. Abandoned generations are the real example. Until the server started reporting them, the abandon rate is a gap and the success rate's denominator excludes them. Between `collected_from` and `available_from`, the raw data exists but old rollup rows lack the new column: `backfill_pending`. The backfill rebuilds sealed days only (older than 72 h) from `events FINAL`. It deletes and re-inserts the day and hour rollups for those days, bumps their revisions, and moves `available_from` back. Recent days wait until they seal, because rebuilding a day that can still receive events would race the live views. Replaying Kafka isn't the backfill path: retention is 7 days against 400 days of raw events, and a replay after claims expire would double-count.

---

## ✅ Design Review Checklist (~2 min)

1. **Source of truth, and when a write succeeds.** `events FINAL` is the truth for numbers; PostgreSQL for configuration and jobs. A producer's event is safe once the collector gets Kafka's acknowledgement. It counts once its ClickHouse insert returns and `inserted-through` is recorded; the Kafka commit follows. An export exists once its row commits.
2. **A client retries after losing the response.** A producer resends with the same `event_id`, and the copy is dropped at the claim. An export POST with the same Idempotency-Key returns the original job with `200`. Dashboard reads are idempotent, and a retry is usually a cache hit.
3. **Failure between two steps.** Between claim and insert: the redelivered message owns its claim and is kept. Between insert and `inserted-through`: the identical chunk's token makes the retry a no-op. Between `inserted-through` and commit: the chunk is skipped. An export worker dies mid-file: its lease lapses, another worker reclaims the job, and the old worker's fenced writes match nothing.
4. **What ordering is actually required.** Only arrival order within a partition, and only for the watermark. Rollups are commutative merges, so the order of events inside a bucket never matters, and nothing is ordered across orgs.
5. **Access with caches, indexes and async jobs.** Every query is scoped by `org_id`, the leading sort key of every table. Permissions are re-read per request and are part of the cache key. Export columns are fixed at creation, re-checked at download, and the worker re-checks org access before it runs. Suppression is applied before a response or a CSV row is built.
6. **What breaks first at scale, and the evidence.** The dedup claim set and hot-org partitions. Evidence: Valkey `used_memory` and the p99 of `analytics_ingest_batch_seconds` for the first; per-partition lag on the pipeline page and `analytics_watermark_lag_seconds` for the second.

---

## 📈 What Breaks First and How It Scales (~3 min)

| Pressure | First symptom and evidence | Response |
|----------|----------------------------|----------|
| Dedup claims | ≈ 80B live claims at ~100 B each is terabytes of RAM; `used_memory` climbs and batch p99 follows | Shard claims by `event_id` across a Valkey cluster; or shorten the window to the client retry horizon (minutes) and rely on ReplacingMergeTree plus nightly sealed-day rebuilds for the long tail; or keep per-day dedup sets inside ClickHouse |
| Hot org | One giant org saturates its partition; that partition's lag grows and, because the watermark is a minimum, freshness degrades for every org | Key the largest orgs by (org_id, hash(user_id) mod N). Per-org order was only ever needed for the watermark, which takes the minimum anyway |
| Ingest throughput | Consumer lag across partitions | 256 partitions, ~20 consumer instances, scaled with partitions |
| ClickHouse | Insert part rate and merge backlog on one node | Shard `events` by a hash of `org_id` with two replicas each (replicated tables make block dedup native); rollups are small enough to replicate everywhere |
| Query load | ≈ 3K queries/s | Result cache absorbs repeats; day-grain reads are hundreds of rows; the costly path is raw edges, bounded to minutes |

> "If I could instrument only two things on day one, they'd be claim-store memory and per-partition lag. The first tells me when dedup stops fitting in memory. The second tells me when one customer's traffic is making everyone else's dashboards look stale."

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Dedup | Valkey claim with `partition:offset` + insert token + inserted-through | ReplacingMergeTree only | Rollups never see a duplicate; RMT stays as the backstop |
| Bucketing | Event time + watermark + revisions | Processing time | Right buckets, honestly labelled as partial |
| Distinct users, percentiles | HyperLogLog and t-digest states | Stored counts and p95s | Merge over any window; ≈ ±1% |
| Daily buckets | `local_date` at ingest | UTC hours grouped at query time | Works for half-hour zones; a zone change needs a rebuild |
| Windows | Planner over day/hour/minute/raw | Fixed grains only | Exact "to date" comparisons in any zone |
| Rollups | ClickHouse materialized views | Stream processor + KV store | Fewer moving parts; updated on insert |
| Broker | Kafka keyed by org | RabbitMQ | Replay, multiple consumers, per-partition order |
| Access | Server omits billing; scope in cache key | Hide columns in the UI | The browser isn't a security boundary |
| Small cohorts | Suppress < 5; pool on merged distinct only | Show everything | No singling out individuals |
| Exports | Leased background jobs with idempotency keys | Stream CSV from the API | Survives navigation; resumable; bounded load |
| Backfill | Rebuild sealed days from raw | Replay Kafka | 400-day raw retention versus 7 days |

---

## 📝 Wrap-up (~1 min)

> "To sum up: I wrote the definitions down before the pipeline, so every number has one meaning shared by the charts, drill-downs and exports. Ingest counts each event once, even through crashes and retries, and it does that before the materialized views can see a duplicate. Testing showed the dedup window has to cover every rollup table, not just the raw one. Buckets follow event time. The watermark says honestly how complete each stream is, and late events revise their own days visibly. Rollups hold sketch states, and a planner stitches day, hour, minute and raw pieces, so distinct users and percentiles stay correct over any window in any time zone. With more time I'd go deeper on scaling the dedup state, since that's the first thing to break."

### How the local implementation compares

The repo runs the design on one machine. A generator plays the collector: it simulates traffic for four fictitious orgs (including a half-hour time zone), stamps `received_time`, injects 2% duplicates and 3% late client events, and writes straight to Kafka. There is one Kafka broker with 3 partitions and one non-replicated ClickHouse, so insert dedup relies on `non_replicated_deduplication_window` on all four tables rather than replicated block dedup. Exports go to a local directory instead of object storage with signed URLs. Dedup, watermarks, the planner, role gating and scope-aware caching are implemented as described and covered by unit tests. A live run showed 288 re-sent duplicates leaving counts unchanged, 200 late events moving yesterday from 288 to 488 with a visible revision, the drill-down reconciling at 488, and a sealed-day rebuild leaving counts and distinct users identical. The in-flight range from deep dive 1 was added after review raised the gap: before it, a redelivered chunk cut at different boundaries after a crash would not have shared the original's token.
