# Kindle Community Highlights - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for Kindle Community Highlights: readers highlight passages in books, those highlights sync across every device they own, and the platform surfaces "1,247 readers highlighted this passage" to everyone else reading that book.

Two observations shape everything below.

**First, the read/write asymmetry is extreme.** We create about 5M highlights a day — roughly **60 writes per second** globally. We serve **100K reads per second** on popular highlights for hot books. That's a ratio of well over 1,000:1. Any design that does work on the read path is wrong; the entire job is to move work to write time and to a batch pipeline, and then serve reads from precomputed data.

**Second, and less obvious: the aggregation feature is built from sensitive data.** What you read, and which sentences struck you hard enough to underline, is intimate. "Popular Highlights" takes a million private acts and publishes an aggregate. That's a privacy engineering problem sitting in the middle of what looks like a counting problem, and I'll spend a deep dive on it because it's the part most designs skip.

## 🎯 Requirements Clarification

Questions I'd ask up front:

- **Is the community feature opt-in or opt-out?** This is not a detail — it determines whether aggregation is a data-processing problem or a consent problem. I'll assume per-user opt-in for aggregation plus per-highlight visibility, and design for both.
- **Do we own the book text?** Yes. That turns out to matter enormously for how we group "the same passage" — I'll come back to it.
- **How offline is offline?** A Kindle can sit in a drawer for a month with unsynced highlights. Not "offline for 30 seconds on the subway." That sets the retention floor for the sync queue.
- **Is the popular-highlights count allowed to be stale?** Yes. Nobody notices whether it says 1,247 or 1,251. This single concession unlocks the whole read path.

### Functional Requirements

- **Highlight**: create, edit, delete, with color and an optional note
- **Sync**: propagate to all of a user's devices, correctly, including from long-offline devices
- **Discover**: popular highlights per book, ranked by count
- **Social**: follow other readers, see their highlights on books you share
- **Export**: Markdown, CSV, JSON
- **Privacy**: per-highlight visibility (private / friends / public) plus a per-user aggregation opt-in

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Cross-device sync | p95 < 2s | Highlight on Kindle, open phone, it's there |
| Highlight create | p99 < 200ms | It's a UI gesture; it must feel local |
| Popular-highlights read | p99 < 100ms, 100K RPS | The hot path, and it's cacheable to death |
| Popular-count freshness | Minutes is fine | Deliberately relaxed — this is the load-bearing concession |
| Highlight durability | No silent loss | A lost highlight is a lost thought; users don't forgive it |
| Availability | 99.9% reads, 99.5% writes | Writes can queue on-device; reads cannot |

### Scale Estimates

- 10M registered users, 1M DAU, ~2 devices each → **~2M concurrent sync connections**
- **1B highlights** stored (~500 B each → ~500 GB); **5M created/day** ≈ 60/sec average
- Bursty, though: a bestseller launch or a viral BookTok moment concentrates thousands of writes/second onto **one book**
- 5M books; ~50M aggregated passages (~5 GB) — the popular-highlights table is *tiny* compared to the raw data
- 100K RPS reads on popular highlights, heavily concentrated on a few hundred hot titles

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│         Clients — Kindle │ iOS │ Android │ Web Reader                │
│      local store, offline queue, last-sync cursor per device         │
└─────────────────┬───────────────────────────────┬────────────────────┘
                  │ HTTPS (CRUD, reads)           │ WSS (sync)
                  ▼                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│           API Gateway — TLS, auth, rate limiting, routing            │
└──┬─────────────────┬──────────────────┬───────────────────┬──────────┘
   ▼                 ▼                  ▼                   ▼
┌──────────┐  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐
│Highlight │  │    Sync     │   │ Aggregation  │   │    Social     │
│ Service  │  │   Service   │   │   Service    │   │    Service    │
│          │  │             │   │              │   │               │
│ CRUD,    │  │ WS registry │   │  read-only:  │   │ auth, follow, │
│ search,  │  │ offline q   │   │  serve       │   │ privacy,      │
│ export   │  │ conflict    │   │  precomputed │   │ share         │
└────┬─────┘  └──────┬──────┘   └──────▲───────┘   └───────┬───────┘
     │               │                 │                   │
     │ HINCRBY on    │                 │ reads             │
     │ create        │                 │                   │
     ▼               ▼                 │                   ▼
┌─────────────────────────────────┐    │           ┌───────────────┐
│        Redis / Valkey           │    │           │  PostgreSQL   │
│  session, sync queues (30d),    │    │           │  highlights,  │
│  passage counters (HINCRBY),    │    │           │  books, users,│
│  popular cache (5-min TTL)      │    │           │  follows,     │
└──────────────┬──────────────────┘    │           │  popular_*    │
               │                       │           └───────▲───────┘
               │  drains every 5 min   │                   │
               ▼                       │                   │
        ┌──────────────────────────────┴───────────────────┘
        │        Aggregation Worker (batch)
        │  counters ──▶ passage clustering ──▶ popular_highlights
        └──────────────────────────────────────────────────
```

The structural decision worth naming: **the write path and the aggregation path are decoupled by Redis and a batch worker.** A highlight create does a PostgreSQL insert plus a Redis increment and returns. It does *not* update any ranking, recompute any top-10, or touch any hot row. The ranking is produced out-of-band, on a schedule, and the read path only ever sees the finished product. Everything that could make writes slow or reads expensive has been pushed into a worker that nobody is waiting on.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), email, username, password_hash, bio | unique email | |
| books | id (UUID PK), title, author, isbn, total_locations | isbn, title | We own the text — see Deep Dive 1 |
| user_books | (user_id, book_id) PK, progress_location, last_read_at | (user_id) | Reading progress; also "which books do I own" |
| highlights | id (UUID PK), user_id, book_id, location_start, location_end, text, note, color, visibility, updated_at, client_id | (user_id, created_at DESC), (book_id, location_start), unique (user_id, client_id) | The core table. **1B rows.** `client_id` is the idempotency anchor |
| deleted_highlights | highlight_id (PK), user_id, deleted_at | (user_id, deleted_at) | Tombstones. Retained 90 days — the reason is subtle, see Deep Dive 3 |
| popular_highlights | (book_id, passage_id) PK, passage_text, highlight_count, location_start, location_end | (book_id, highlight_count DESC) | ~50M rows. **Written only by the batch worker**, never by the request path |
| follows | (follower_id, followee_id) PK | (followee_id) | Directed graph |
| user_privacy_settings | user_id (PK), default_visibility, allow_followers, include_in_aggregation | — | `include_in_aggregation` is the consent gate |
| sessions | id (PK), user_id, expires_at | (expires_at) | Mirrored in Redis; PostgreSQL is the fallback |

Redis holds four things, and it's worth being precise about which are durable and which are disposable:

| Key | Structure | TTL | Rebuild if lost? |
|-----|-----------|-----|------------------|
| `book:{id}:passages` | Hash: passage → count | none | **Yes — from the highlights table.** Expensive but possible; this is why it's not the source of truth |
| `sync:queue:{user}:{device}` | List of pending events | 30 days | **No.** A lost queue means a device misses events — mitigated by cursor-based pull-on-reconnect, which re-derives from PostgreSQL |
| `popular:{bookId}` | Serialized top-10 | 5 min | Yes, trivially — it's a cache of a PostgreSQL table |
| `session:{id}` | Session blob | 24h | Yes, from PostgreSQL |

The critical property: **PostgreSQL is the source of truth for every durable fact.** Redis holds accelerations and ephemera. If Redis is wiped, we lose counter freshness and some sync-queue latency, and we lose nothing a user would call "their data."

## 🔌 API Design

```
POST   /api/highlights                 → Create (Idempotency-Key required)
PUT    /api/highlights/:id             → Update text/note/color/visibility
DELETE /api/highlights/:id             → Soft delete (writes a tombstone)
GET    /api/highlights?book=&cursor=   → List own highlights, cursor-paginated
GET    /api/highlights/search?q=       → Full-text over own highlights
GET    /api/highlights/export?fmt=     → Markdown / CSV / JSON

WSS    /ws/sync                        → Live sync channel (device-scoped)
POST   /api/sync/pull                  → Delta since cursor (reconnect path)
POST   /api/sync/ack                   → Advance the device's cursor

GET    /api/popular/:bookId            → Top passages for a book (the 100K RPS endpoint)
GET    /api/trending                   → Cross-book trending passages

POST   /api/social/follow/:userId      → Follow
GET    /api/social/friends-highlights/:bookId → Followed users' visible highlights
PUT    /api/privacy/settings           → Visibility defaults + aggregation opt-in
```

`GET /api/popular/:bookId` is the endpoint everything else exists to protect. It is a pure read of precomputed data, cacheable at every layer, and it must never touch the `highlights` table.

## 🔧 Deep Dive 1: Aggregation — The Hard Part Isn't Counting, It's Deciding *What* to Count

Everyone jumps to the counting infrastructure. The counting is the easy half. The hard half is that **no two readers highlight the same thing.**

Reader A drags across characters 1000–1150. Reader B, moved by the same sentence, catches 1005–1200 because they included the next clause. Reader C starts a word early at 990. They highlighted "the same passage" in every sense a human cares about, and their raw records agree on nothing.

**Exact-match grouping on (start, end) is dead on arrival.** A passage that 50,000 people highlighted fragments into 30,000 distinct "passages" with counts of 1, 2, and 3. Popular Highlights renders an empty list on the most-highlighted sentence in the book. This isn't a tuning problem; the feature simply doesn't exist.

**Fixed normalized windows** — snap each highlight's start to a 100-character bucket — is the obvious next move, it's O(1), and it's what you reach for when you need a real-time counter. It also has a specific, systematic flaw: it's a grid, and passages don't respect grids. Two readers highlighting the identical sentence land in different buckets if that sentence happens to straddle a boundary at character 1000. The undercount isn't random noise; it *reliably* penalizes exactly the passages that sit on boundaries, and no amount of tuning the window size fixes it — it just moves which passages get penalized.

**The insight that resolves it: we own the book text.** We don't have to infer passage boundaries from where people happened to drag their fingers — we can read them out of the book. A quotable passage is a sentence, or a run of sentences. So the batch job snaps each highlight's character range to the sentences it covers and counts *per sentence*. A, B, and C all covered the same sentence, so they all count toward it. Sentence boundaries are the natural unit because they're the unit the author wrote in and the unit a reader would quote.

So the design is **two-tier**, and the tiers have different jobs:

| Tier | Grouping | When | Purpose |
|------|----------|------|---------|
| Real-time counter | 100-char window (cheap, approximate) | On every create — one `HINCRBY` | Keeps a live signal; nothing is displayed from it directly |
| Batch clustering | Sentence-anchored, from the book text | Worker, every 5 minutes | Produces the passage text and count that users actually see |

> "The reason I'm willing to run two different grouping schemes is that they're solving different problems. The hot path needs an O(1) operation with no book-text lookup — it just needs to know *something happened near here*. The display path needs to be *right*, and it has a five-minute budget and access to the full book, so it can do real work: pull the highlight ranges for a book, snap them to sentence boundaries, merge, and rank. Trying to do sentence-anchoring on the write path would mean loading book text into the highlight-create request, which turns a 20ms insert into a text-processing job. Trying to *display* from the window counter would mean showing users passages that begin mid-word at character 1000. Neither scheme can do both jobs — so I run both."

**Now the counting infrastructure**, which is the easy half but has one sharp edge.

Why Redis `HINCRBY` and a batch drain, rather than just `UPDATE popular_highlights SET count = count + 1` on create? At 60 writes/sec you might reasonably ask whether PostgreSQL cares at all. Two reasons it does:

1. **The counter is the indexed column.** The whole point of `popular_highlights` is the index on `(book_id, highlight_count DESC)` that makes the top-10 query instant. Every increment changes an indexed value, which means every increment is a non-HOT update: a new tuple version, an index entry rewrite, a dead tuple for autovacuum to chase. 5M of those a day, concentrated on the *few thousand rows for hot books*, produces index bloat and vacuum pressure completely out of proportion to the actual data. **You cannot cheaply maintain an index on a column you increment on every write** — and that index is the entire reason the table exists.

2. **The average rate is a lie.** 60/sec is the global average. A book launch or a viral moment concentrates thousands of writes per second onto *one book's* handful of hot rows, and those all serialize on the same row locks. The system doesn't fall over at the average; it falls over at the moment the feature is most visible.

Redis absorbs both problems. `HINCRBY` on a hash field is lock-free and single-threaded — a hot key is fine, because there's no row lock to contend for and no index to maintain. The worker then drains 5 minutes of accumulated deltas into PostgreSQL as one batched write per book, collapsing thousands of individual increments into a single `UPDATE`. **We converted 5M index-churning updates a day into ~288 batched writes per book per day.**

**What we give up: the count is up to 5 minutes stale.** I'll take that trade every time. Nobody has ever refreshed a page to see whether a highlight count went from 1,247 to 1,248, and a reading session lasts far longer than the staleness window. This is the concession that pays for the entire read path.

## 🔧 Deep Dive 2: Privacy — When a Count Becomes an Identifier

This is the deep dive I'd most want to be asked about, because it's where a straightforward system has a genuinely dangerous edge.

Reading is sensitive. Books about addiction recovery, a medical diagnosis, sexuality, leaving a religion, leaving a marriage. And a highlight is *more* revealing than a purchase — it's the specific sentence that landed. Now we take that data and publish an aggregate. The question is: **at what point does an aggregate stop protecting the individuals inside it?**

The naive answer is "counts are anonymous, they don't have names on them." That's wrong, and the failure is easy to construct. Consider a book with 40 total readers. A passage shows a count of 1. That tells the world: exactly one of those 40 people highlighted this sentence. Now add the social layer we also built — I can follow people, I can see which books they're reading. The candidate set collapses fast. In a small enough population, **a count of 1 is a name.**

So the aggregation pipeline needs three defenses, and they're layered because they fail differently:

**1. Consent (`include_in_aggregation`).** A highlight only enters the counter if its owner has opted in *and* the highlight itself is public. This is checked at increment time, not at read time — an opted-out user's highlight never enters the counting system at all, so there's no path by which a later bug can leak it. Filtering at read time would mean the sensitive data is *in* the pipeline and we're relying on a query predicate to keep it out of the response. Consent should be enforced where the data is created, not where it's served.

**2. A k-anonymity threshold on display.** A passage is not shown in Popular Highlights unless at least **k readers** (I'd start at k=10 and tune) have highlighted it. Below the threshold, the passage doesn't appear at all.

> "The subtlety here — and it's the thing people get wrong — is that it's not enough to *hide the count* below the threshold. Showing the passage with the count suppressed still reveals that *at least one person* highlighted it, and in a small readership that's the entire leak. Presence is the disclosure, not the number. So the suppression has to be on the passage's existence in the response, not on the numeral. The cost is real and I want to name it: **books with small readerships get no community highlights, ever.** A niche poetry collection with 200 readers will show an empty Popular tab forever. That's not a bug I'd fix — it's the feature working. The population is too small for an aggregate to hide anyone in, so we don't publish an aggregate."

**3. Never attribute in the aggregate.** Popular Highlights is counts only, with no path back to identities — the pipeline stores passage → count, and does not store passage → user list. The Friends' Highlights feature is the *attributed* surface, and it is a different code path with a different rule: it requires an explicit follow relationship *and* the individual highlight's own visibility setting to permit it. Keeping these two features on separate paths, with separate data, means a bug in the aggregation ranking can't produce an attribution.

**Why not differential privacy?** It's the academically correct answer and I'd reject it here. DP works by adding calibrated noise to published counts. But our counts are displayed exactly and prominently — "1,247 readers highlighted this passage" — and users would notice the number drifting. More importantly, noise is most damaging precisely in the low-count tail, which is exactly the region where the privacy risk lives, and where the k-threshold already gives a *hard* guarantee rather than a probabilistic one. DP would buy a weaker protection in the dangerous region while degrading the numbers in the safe region. The k-threshold dominates it for this specific access pattern.

**What this leaves exposed, honestly:** the counter store itself holds sub-threshold data — you can't cross k=10 without first counting to 9. That means Redis and `popular_highlights` contain rows that are *deliberately never served*, and they must be treated as sensitive infrastructure: no debug endpoint that dumps a book's raw passage map, no analytics export of the counter hash, access-controlled like user data. The suppression is a serving-layer rule, and serving-layer rules are one careless internal tool away from being bypassed.

## 🔧 Deep Dive 3: Sync — Why Last-Write-Wins Is Right Here (and Where It Isn't)

The requirement: highlight on a Kindle, and it's on the phone in under 2 seconds. Plus the Kindle-in-a-drawer case: a device offline for weeks that must catch up correctly on reconnect.

**Push, not poll — and the numbers aren't close.** 2M concurrent devices polling every 2 seconds is **1M requests/second**, against a global highlight-creation rate of ~60/second. Over 99.99% of those polls return "nothing new." We'd be building a million-RPS tier of infrastructure whose entire purpose is to say "no" — and it would *still* have a 1-second average latency, missing the requirement it was built for. A persistent connection costs a socket and a few KB of memory and delivers the event the instant it exists. There's no version of the arithmetic where polling wins.

WebSocket over SSE, because sync is genuinely bidirectional: the device sends cursor acknowledgments, requests deltas, and reports its state. SSE would need a second HTTP channel for the upstream half, which is just a WebSocket with extra steps.

**The offline path is the one that has to be right.** Each device has a cursor. When it's connected, events are pushed live. When it's not, events are queued in Redis per `(user, device)` with a 30-day TTL. On reconnect, the device sends its cursor and pulls the delta — and critically, the **pull path reads from PostgreSQL, not from the queue.** The queue is a latency optimization; the cursor-plus-PostgreSQL pull is the correctness mechanism. If Redis loses a queue, nothing is lost — the device just discovers the same changes a beat later through the durable path.

**Deletes are the trap.** If we hard-deleted a highlight row, here's what happens: a device that was offline when the delete occurred reconnects, sees a highlight in its local store that the server doesn't have, and helpfully *re-uploads it*. The highlight resurrects. The user deletes it again on their phone. It comes back again the next time the Kindle syncs. This is a zombie-data bug, it's maddening to reproduce, and it's entirely prevented by tombstones: the delete is a **row**, and it syncs like any other event.

The retention arithmetic has to line up, and it's the kind of thing that silently breaks a year later: **tombstones are kept 90 days, which must exceed the 30-day sync queue TTL, which must exceed the longest plausible device absence we intend to support.** If tombstones expired *before* the queue did, a device could reconnect inside its supported window and find no record of a delete — and resurrect the highlight. Three retention numbers, and they have to be ordered correctly or the system has a data-corruption bug that only manifests for users who leave a device off for a while.

**Conflict resolution: last-write-wins on `updated_at`.**

The conflict this must handle: the same user edits the same highlight's note on two devices, both offline, then both sync. Note that the *only* person who can conflict with you is you — highlights are single-owner. There is no concurrent-authorship problem here at all.

| Approach | Fit for this problem | Verdict |
|----------|---------------------|---------|
| ✅ Last-write-wins on timestamp | Single-owner data, conflicting edits are vanishingly rare, and "keep the newer one" is what a user would expect anyway | **Chosen** |
| ❌ CRDTs | Guarantee convergence without coordination — but require modeling every field as a CRDT type and carrying merge metadata on 1B rows | Rejected |
| ❌ Operational Transform | Built for concurrent multi-user character-level editing of a shared document | Rejected — wrong problem entirely |

> "I want to be careful not to reject CRDTs for the lazy reason. They're not 'too complicated' — they're *solving a problem this data model doesn't have*. A CRDT earns its complexity when concurrent writers are the normal case and you need convergence without a coordinator: a collaborative editor, a multiplayer canvas. Here, concurrent writes are a single user editing one note on two devices that are simultaneously offline. That's not a scenario I'd design a merge algebra for; it's a scenario I'd resolve by keeping the later edit, which is also what the user expects. And the cost isn't just implementation — it's per-row metadata on a table with a billion rows, and a merge semantics that has to be preserved across every client platform including a Kindle with a slow processor. Now, if the product added *shared* annotations — a book club where several people annotate the same passage — I'd revisit immediately, because that flips the data from single-owner to multi-writer, and LWW would start silently eating people's contributions."

**What LWW costs us, concretely: we're trusting client clocks.** A device with a badly wrong clock — set to next year — wins every conflict it ever participates in, permanently, and its stale edits overwrite good ones. The mitigations are unglamorous but necessary: the server rejects any `updated_at` more than a few minutes in the future, and when both edits arrive online the server uses its own receipt order rather than the client's claim. For genuinely offline edits, the client timestamp is all the information that exists, and we accept a bounded amount of unfairness. In the rare true conflict, one edit is silently lost — and for a highlight note, the user can simply retype it. That's a survivable failure. It would not be survivable for a shared document, which is exactly the line where this design stops applying.

## 🔎 The Read Paths We *Don't* Precompute

We precompute Popular Highlights aggressively. It's worth being explicit about why we do **not** precompute the other two read surfaces, because the reasoning is the same in both cases and it's a useful counterweight to "just cache everything."

**Friends' Highlights** — "show me what people I follow highlighted in this book" — is resolved at query time, joining `highlights` against `follows` and `user_privacy_settings`. The obvious optimization is a materialized "highlights visible to user X" view. I'd reject it, and the reason is a cardinality argument:

| Surface | Cardinality of the precomputed thing | Precompute? |
|---------|--------------------------------------|-------------|
| Popular Highlights | ~50M passages, ~5 GB. Bounded by *books*, and one row serves every reader of that book | ✅ Yes — one computation amortized over millions of reads |
| Friends' Highlights | 10M users × the highlights visible to each. Bounded by *nothing useful*, and one row serves exactly one reader | ❌ No |

> "The distinguishing question isn't 'is this expensive to compute' — it's 'how many readers does one precomputed row serve?' A popular-highlight row is read by every one of the book's millions of readers, so computing it once is a spectacular deal. A friends-visibility row is read by exactly one person, so precomputing it buys you nothing but an invalidation problem — and what an invalidation problem: a single unfollow, a single privacy-setting change, or one highlight flipped from public to friends invalidates an unbounded slice of the materialization. You'd spend more engineering keeping it correct than you'd ever spend just running the join. And the join is cheap: my follow list is a few hundred people, and the query is bounded by one book. It's a small, indexed, user-scoped read — precisely the thing PostgreSQL is good at."

There's a correctness argument too, and it's the stronger one. **Privacy filters evaluated at read time are always correct as of *now*.** A materialized view is correct as of the last refresh — which means the window between "user sets a highlight to private" and "the materialization catches up" is a window in which we serve data the user has explicitly asked us not to serve. For a privacy control, a stale answer isn't a performance bug, it's the failure the control exists to prevent. This is the exact opposite of the popular-count decision, where staleness was free — the difference is that one is a statistic and the other is a permission.

**Export** is the other read we don't precompute, for the opposite reason: it's rare and enormous. Exporting a heavy user's 20,000 highlights to Markdown is a full scan of their partition plus a formatting pass, and it's requested a handful of times a year per user. Doing it synchronously means a request that holds a connection open for tens of seconds. So export becomes an **asynchronous job**: the request enqueues, a worker generates the file, uploads it to object storage, and the user gets a link. Rate-limited to ~10/hour per user, because the cost is real and the demand is not. The general rule this follows: any read whose cost scales with a user's entire history belongs in a worker, not in a request handler.

## 🔒 Auth, Authorization, and Rate Limiting

Session-based auth: bcrypt-verified credentials mint a token in Redis with a 24-hour TTL, mirrored in PostgreSQL so a Redis failure degrades to a slower lookup rather than logging everyone out. Sessions are revocable server-side by deleting the key — which JWTs would not give us, and which matters for a system holding data this personal.

Authorization is entirely about visibility, and it resolves against three inputs on every read of someone else's data: the highlight's own `visibility`, the owner's `user_privacy_settings`, and the existence of a `follows` edge. The rule that keeps this from becoming a source of bugs is that **the visibility check lives in one place** — a single query helper that every read path for non-owned highlights goes through. Ten different endpoints each writing their own `WHERE visibility = ...` clause is how privacy leaks happen.

| Endpoint | Limit | Scope | Why this number |
|----------|-------|-------|-----------------|
| Create highlight | 100/min | Per user | A human reading a book cannot highlight faster than this. Anything above it is a script |
| Auth attempts | 5/min | Per IP | Credential stuffing |
| Export | 10/hour | Per user | Each one is a full-history scan and a worker job |
| Search | 30/min | Per user | CPU-bound; the most expensive read a user can trigger on demand |
| General API | 1,000/min | Per user | Backstop |
| Follow | 60/hour | Per user | Follow-spam is how you farm visibility into other people's `friends`-scoped highlights |

The create limit is doing double duty: it's a load control *and* it's the first line of defense against counter manipulation, since inflating a passage's public count requires volume. It won't stop a distributed attack, but it makes the naive one useless.

The follow limit is the one people forget. Follows are the key that unlocks `friends`-visibility highlights, so an account that follows ten thousand people has quietly assembled a read permission over ten thousand people's semi-private annotations. Rate-limiting follows isn't about database load — it's an access-control measure wearing a rate-limiter's clothes.

## 🛡️ Idempotency and Failure Handling

**Idempotent creates.** A Kindle on hotel wifi sends a highlight, the connection drops before the response lands, and the device retries. Without protection, the reader now owns the same highlight twice — and worse, the passage counter got incremented twice, corrupting a public statistic.

Two layers that fail differently: a Redis check on the client-generated key (sub-millisecond, 24h TTL, returns the *original* highlight rather than a bare "seen" flag, so the client can reconcile its local row), backed by a unique constraint on `(user_id, client_id)` in PostgreSQL. The constraint is what saves us when Redis is cold — the duplicate insert fails loudly instead of quietly creating a second highlight.

The counter increment **must happen inside the same idempotency boundary as the insert.** If the insert is deduplicated but the increment isn't, retries silently inflate the public count for a passage — a data-integrity bug in the one number we display to everyone, and one that leaves no trace to debug.

**Degradation, graded by what's at stake:**

| Component down | Behavior |
|----------------|----------|
| Aggregation worker | Counts freeze at their last value. Reads still serve; nobody notices for a while. **The worker is not on any critical path** — that's the whole reason it exists |
| Redis | Popular highlights serve from `popular_highlights` in PostgreSQL (slower, still correct). Sessions fall back to PostgreSQL. Counter increments are **dropped**, not queued — see below |
| Sync service | Highlights still create and persist. Cross-device propagation stops; devices catch up via cursor pull on reconnect. **Zero data loss**, just latency |
| Search | Feature disabled, browse-only UI. Search failing should never take down highlighting |
| PostgreSQL | Creates fail with a retryable error. The client queues locally — which it's built to do anyway, because it's an offline-first client. This is the one failure users would actually feel, and even here nothing is lost |

That "counter increments are dropped" row is a deliberate choice worth defending: if Redis is down, I will not block a highlight create to preserve a statistic. A dropped increment means a popular count is a few short — a number nobody can verify and nobody will miss. A blocked create means a reader's thought is lost. The counters can be rebuilt from the `highlights` table by a backfill job if the drift ever becomes visible; the highlight cannot be rebuilt from anything.

Circuit breakers wrap Redis (1s timeout) and PostgreSQL (3s) so a degraded dependency fails fast rather than piling up timed-out requests until the connection pool is exhausted and the whole service dies alongside it.

## 📦 Data Lifecycle

Four retention policies, and I want them in one place because three of them are coupled and the coupling is where the bugs hide.

| Data | Retention | Mechanism | If you get it wrong |
|------|-----------|-----------|---------------------|
| `highlights` | **Permanent** | None | Deleting a user's highlights is deleting their thinking. This is the one thing we never garbage-collect |
| `deleted_highlights` (tombstones) | 90 days | Daily sweep | Too short → long-offline devices resurrect deleted highlights |
| Sync queues (Redis) | 30 days | TTL | Too short → a device offline longer falls back to cursor pull, which is fine. **This one is safe to get wrong** |
| Passage counters (Redis) | None (until drained) | Batch worker | Unbounded growth if the drain stalls — the counters accumulate but never shrink |

The ordering constraint, stated once and clearly: **tombstone retention > sync queue TTL > longest supported device absence.** Ninety days beats thirty beats "a month in a drawer." Violate that ordering and you get a data-corruption bug that only appears for users who left a device off for a while — which is to say, a bug that will not appear in testing and will appear in production, intermittently, in a way nobody can reproduce.

At production scale I'd also tier the `highlights` table by age: recent highlights on fast storage with full indexing, older ones on cheaper storage with lighter indexing. The access pattern justifies it — people read and search their recent highlights constantly and their five-year-old ones almost never — but "almost never" is not "never," so this is a *storage tiering* decision, never a deletion one.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Sync latency histogram (create → device delivery) | The p95 < 2s SLO. Measured end-to-end, not at the WebSocket send |
| Aggregation worker lag | If the drain falls behind its 5-minute cycle, counts silently go stale. This is the metric most likely to rot unnoticed |
| Redis counter/PostgreSQL count drift | A periodic reconciliation sample. Growing drift means increments are being lost — the silent failure mode of the whole aggregation design |
| Popular-highlights cache hit rate | Target > 90%. A drop means the hot-book working set exceeded the cache, and the database is about to feel it |
| Sync queue depth per device, p99 | A rising tail means devices are connecting but not acking — a client-side sync bug |
| Suppressed-passage rate (below k) | Both a privacy control and a product signal: how many books are too small to have a community |

Structured JSON logs with `requestId`, `userId`, `bookId`, `highlightId`. The sync debugging story is the one that matters: "my highlight didn't reach my phone" has to be answerable by tracing one highlight ID across create → counter → sync push → device ack, across four services, on a single correlation ID. Without that, it's unanswerable.

The metric I'd stare at hardest is the **counter/table drift check**, because it's the only thing that catches the failure mode this architecture is uniquely exposed to. Everything about the aggregation design — Redis increments, a batch drain, dropped increments under failure — trades exactness for throughput. Each of those trades is individually correct, and each one is a place where a count can quietly diverge from reality. A periodic job that re-derives a sample of passage counts from the `highlights` table and compares them to what we're publishing is the only way to find out that we've been serving a wrong number for three weeks. Without it, the aggregation pipeline has no correctness test at all, and "the numbers are approximately right" degrades into "the numbers are whatever survived" without anyone noticing.

Health checks are the usual three per service — liveness, readiness (gating whether the load balancer routes traffic here), and a deep check. The one non-obvious readiness signal is on the aggregation worker: **it can be alive and idle.** A process whose background loop has silently stopped still answers a naive health check with a cheerful 200 while counts freeze forever. Readiness has to assert that the loop actually completed a cycle recently, not just that the process is running.

## 📈 Scalability: What Breaks First

1. **The hot book.** Popular Highlights on the #1 bestseller is 100K RPS on a *single cache key*. That's not a Redis capacity problem, it's a single-shard-hotspot problem — one node in the cluster eats all of it. The fix is nearly free given a concession we already made: since the data is already up to 5 minutes stale, an **in-process cache on each API server with a 5-second TTL** is a strict improvement over nothing. That turns 100K RPS into roughly *one Redis read per server per 5 seconds*. The hottest key in the system stops being hot. This is the highest-leverage change in the design and it's about ten lines of thinking.

2. **WebSocket connections.** 2M concurrent at ~50K per gateway is ~40 gateways. Gateways are stateless, but the sync event is created on whichever Highlight Service instance handled the write, and it has no idea which gateway holds the device. That needs a Redis pub/sub connection registry (or a Kafka topic per gateway shard) to route the event. The thing to plan for isn't steady state — it's the **reconnect storm** when a gateway dies and 50K devices simultaneously reconnect and each immediately issues a cursor pull. Jittered client backoff, and a pull path cheap enough to absorb the herd.

3. **The `highlights` table at 1B rows.** Fortunately, every read of it is user-scoped — "my highlights," "my highlights in this book," "search my highlights" — so it **shards cleanly by `user_id`** with no cross-shard queries on the hot path. The query that *would* be cross-shard ("count everyone's highlights on this passage") never runs, because that's precisely what the counter pipeline exists to precompute. The aggregation architecture isn't just a performance optimization; it's what makes the sharding key viable.

4. **Search.** PostgreSQL full-text over 1B rows is a losing battle. Move to Elasticsearch — and note that search is *also* always user-scoped, so the index shards by user and stays small per shard. This is a straightforward migration, not a redesign.

5. **The aggregation worker itself.** A single worker scanning every book's counter hash every 5 minutes eventually can't finish inside its window — and the failure is silent, which is the worst kind. Partition by `book_id` hash across parallel workers; the books are fully independent, so this is embarrassingly parallel. The thing to alert on is cycle time approaching the interval, not cycle time exceeding it.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Aggregation timing | ✅ Redis counters + 5-min batch drain | ❌ Synchronous SQL increment | The counter *is* the indexed column — every increment would churn the index it exists to serve |
| Passage grouping (display) | ✅ Sentence-anchored, batch | ❌ Fixed 100-char windows | We own the book text; grids systematically mis-group boundary-straddling passages |
| Passage grouping (counter) | ✅ Fixed window, O(1) | ❌ Sentence-anchor on write | Write path can't afford a book-text lookup — the two tiers do different jobs |
| Aggregate privacy | ✅ k-anonymity threshold, suppress *presence* | ❌ Hide count, show passage | Presence is the disclosure; in a small readership a count of 1 is a name |
| Privacy enforcement | ✅ Consent at increment time | ❌ Filter at read time | Opted-out data never enters the pipeline, so no query bug can leak it |
| Noise | ✅ None; hard threshold | ❌ Differential privacy | Counts are displayed exactly; DP degrades the safe region and is weaker in the dangerous one |
| Sync transport | ✅ WebSocket push | ❌ Polling | 2M devices × 0.5 Hz = 1M RPS to serve 60 events/sec globally |
| Conflict resolution | ✅ Last-write-wins on timestamp | ❌ CRDT / OT | Single-owner data; concurrent writes aren't a real case. Revisit if annotations become shared |
| Deletes | ✅ Tombstones, 90-day retention | ❌ Hard delete | Without them, long-offline devices resurrect deleted highlights |
| Counter durability | ✅ Drop increments if Redis is down | ❌ Block the write | Never lose a reader's thought to protect a statistic |
| Hot-key reads | ✅ In-process cache, 5s TTL | ❌ Redis only | Staleness was already conceded — spend it to kill the hotspot |
| Friends' Highlights | ✅ Query-time join | ❌ Materialized per-user view | One precomputed row would serve exactly one reader — and stale privacy is a leak, not a lag |
| Export | ✅ Async worker + object storage | ❌ Synchronous response | Cost scales with a user's entire history; that belongs in a worker |
| Sharding key | ✅ `user_id` | ❌ `book_id` | Every read of raw highlights is user-scoped; the cross-user query is precomputed away |

## 🚀 Closing: What I'd Build Next

Three threads. **Fraud on the counters** — Popular Highlights is a public ranking, which means it's a thing people will want to manipulate; an author botting their own book's key passage is the obvious attack, and the defense is the same behavioral machinery any ranking needs (account age, velocity, whether the "reader" has plausible reading progress in the book at all). **Sentence-anchored clustering across editions**, because the same book has different pagination in hardcover, paperback, and Kindle, and character offsets don't survive that — the passage identity really wants to be anchored to the *text*, not to a location integer. And **the shared-annotation case**, because if the product ever grows book clubs, the conflict-resolution decision above flips, and I'd rather know that's coming than discover it after LWW starts eating people's work.

The thing I'd want to leave the interviewer with: this looks like a CRUD app with a counter bolted on, and the counter is the whole system. Every interesting decision — the batch worker, the two-tier grouping, the k-threshold, even the sharding key — falls out of the fact that we're publishing a public statistic derived from a million private acts, at a read rate a thousand times the write rate.
