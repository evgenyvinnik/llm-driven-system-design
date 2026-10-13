# 💼 LinkedIn (Professional Network) — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one relationship through the whole system — a click on Connect, the invitation, the accept, and the profile header that finally says '1st' — and get the contracts between the layers right. Two of them carry most of the weight: invitation writes that report what actually happened, so the client can retry and render the truth, and a relationship read that separates 'how far apart are we' from 'what can I do', so every button and badge stays honest even while caches and indexes lag."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, and targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the browser to the index workers, plus the core flows |
| Data model & API contract | 7 min | Server tables, client cache keys, and the fields both sides rely on |
| Deep dive 1: connecting two people | 8 min | Optimistic UI on top of an idempotent, race-free write |
| Deep dive 2: "how you're connected" | 7 min | The relationship contract and its caching on both sides |
| Deep dive 3: search that degrades | 6 min | Outbox-fed index, fallback, and an honest UI |
| Failures, scale, wrap-up | 4 min | What each failure looks like to a member |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Members send, accept, decline and withdraw invitations and remove connections. Every profile shows the degree (1st, 2nd, 3rd), the mutual count and a "how you're connected" path, with the right action button. My Network lists invitations, connections and People You May Know with reasons. The feed shows ranked posts from connections. People and job search with filters. Out of scope: messaging, recruiter tools, ads.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Degree and path computation | p99 < 50 ms; it runs in every profile view |
| Backend | Invite / accept | p99 < 300 ms; both members see the new state within 1 s |
| Backend | Search freshness | A profile edit is searchable within 30 s |
| Frontend | Feed load | LCP < 2.5 s cold, < 1 s repeat; 60 fps scrolling |
| Frontend | Social actions | INP < 200 ms; Connect and Like respond on the click |
| Both | Correctness | A connection is never one-sided; retries and double clicks never duplicate an invitation |
| Both | Convergence | A change made on one device shows on the others within ~2 s |

**Scale.** 900M members, 100M daily; ~50B connections (100B adjacency entries, ~5 TB of RAM with replicas); ~1B profile views a day (12K/s, 35K/s peak), each needing a degree; 1.5B feed loads a day; ~20M invitations a day. A member with 500 connections has about 250,000 second-degree members.

"The last number decides the design on both sides. The server must never enumerate a second-degree network while a member waits, and the client must never guess relationship state, because it can't see the other side of the graph."

---

## 🏗️ End-to-End Architecture (8 min)

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Browser SPA · query cache keyed by member · optimistic Connect · SSE invalidation            │
  └─────────┬───────────────────────────────────┬─────────────────────────────┬──────────────────┘
            │ (1) POST /invitations/{id}/accept │ (2) GET /feed?cursor        │ (3) GET /search?q
            │                                   │                             │
            ▼                                   ▼                             ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ API gateway · TLS · session lookup in Redis · per-member rate limits · routing               │
  └─────────┬───────────────────────────────────┬─────────────────────────────┬──────────────────┘
            ▼                                   ▼                             ▼
  ┌──────────────────────┐            ┌──────────────────────┐        ┌──────────────────────────┐
  │ Graph Service        │ connections│ Feed Service         │        │ Profile & Search API     │
  │ invitations, degree, │◀───────────┤ pull recent posts    │        │ profiles · jobs ·        │
  │ mutuals, PYMK        │            │ from connections,    │        │ applications ·           │
  │ adjacency in RAM     │            │ rank, cursor pages   │        │ people and job search    │
  └───▲─────────────┬────┘            └───────────┬──────────┘        └───┬───────────────┬──────┘
      │             │                             │                       │               │
      │             │                             │ recent post ids       │ search query  │
      │             │ tx: invitation, edge,       │ per author            │               │
      │             │ counters, outbox row        │                       │               │
      │             │                             ▼                       │               ▼
      │ edge        │                   ┌────────────────────────┐        │     ┌────────────────┐
      │ events      │                   │ Redis                  │        │     │ Elasticsearch  │
      │             │                   │ sessions · recent post │        │     │ people · jobs  │
      │             │                   │ ids · PYMK lists       │        │     └─────────▲──────┘
      │             │                   └────────────────────────┘        │ profiles, jobs│
      │             ▼                                                     ▼               │
      │   ┌───────────────────────────────────────────────────────────────────┐           │ index
      │   │ PostgreSQL · sharded by member id                                 │           │ docs
      │   │ profiles, invitations, edges, posts, jobs, outbox                 │           │
      │   └─────────────────────────────┬─────────────────────────────────────┘           │
      │                                 │ outbox relay                                    │
      │                                 ▼                                                 │
      │                     ┌───────────────────────────┐ profile, job events    ┌────────┴──────┐
      └─────────────────────┤ Kafka · change events     ├───────────────────────▶│ Index workers │
                            └───────────────────────────┘                        └───────────────┘
```

1. **Accept (1).** The SPA sends the accept; the Graph Service locks the pair's row, flips it to connected and writes an outbox row in one transaction, and returns the new status. The relay publishes `pair.connected`, which updates in-memory adjacency and reaches other tabs and devices as a server-sent event.
2. **Feed (2).** The Feed Service gets my connections from the Graph Service, reads each author's recent post ids from Redis, ranks, and returns a page plus a cursor that the SPA's infinite query passes back.
3. **Search (3).** The Profile & Search API queries Elasticsearch; profile and job edits reach it through the outbox and index workers. If the cluster is down the API answers from PostgreSQL full-text and says so.

| Layer | Choice | Why |
|-------|--------|-----|
| Browser | React SPA; TanStack Query for server state; URL for filters; one SSE stream per browser | The relationship is server-owned; the cache handles dedupe, retries and invalidation |
| Public pages | Server-rendered profiles and job posts | Crawlers and anonymous first paint |
| Graph Service | Invitations, degree, mutuals, PYMK serving; adjacency in RAM | Tightest latency budget; every service calls it |
| Feed Service | Fan-out on read, ranked session snapshots | 58 posts/s don't justify 2.5B timeline writes a day |
| PostgreSQL | Source of truth, sharded by member | One pair row per two members; transactions where correctness lives |
| Kafka + workers | Outbox events to adjacency, index and other tabs | Derived data converges without dual writes |

### Flow: Connect, across the wire

```
 Browser                       Graph API                      PostgreSQL    Redis
    │                              │                               │          │
    │ 1 cache: status = pending_sent                               │          │
    │ 2 POST /invitations {to: B}  │                               │          │
    │─────────────────────────────▶│                               │          │
    │                              │ 3 lock pair, reverse invite?  │          │
    │                              │──────────────────────────────▶│          │
    │                              │ 4 sent | pending | connected  │          │
    │                              │◀──────────────────────────────│          │
    │                              │ 5 bump graph versions                    │
    │                              │─────────────────────────────────────────▶│
    │ 6 {outcome, status}          │                               │          │
    │◀─────────────────────────────│                               │          │
    │ 7 server status wins; refetch                                │          │
    │                              │                               │          │
```

"Step 1 and step 7 are the two halves of the client's contract: show the expected state immediately, then replace it with whatever the server says. Steps 3–4 are the server's half: under the pair lock it finds out whether the other person already invited me — then it connects us instead of creating a second invitation — and it reports one of three outcomes. Step 5 bumps both members' graph versions so the next relationship read can't come from a stale cache."

### Flow: opening a profile

```
 Browser                            Profile API    Graph Service                              Redis
    │                                    │               │                                      │
    │ 1 GET /profiles/B (public fields)  │               │                                      │
    │───────────────────────────────────▶│               │                                      │
    │ 2 GET /members/B/relationship                      │                                      │
    │───────────────────────────────────────────────────▶│                                      │
    │                                    │               │ 3 lists of A and B (versioned keys)  │
    │                                    │               │─────────────────────────────────────▶│
    │                                    │               │ 4 F(A), F(B) (miss: load, cache)     │
    │                                    │               │◀─────────────────────────────────────│
    │                                    │               │ 5 intersect, else bridge probe       │
    │ 6 {degree: 3, status, path: A, x, y, B}            │                                      │
    │◀───────────────────────────────────────────────────│                                      │
    │ 7 header renders; button from status               │                                      │
    │                                    │               │                                      │
```

"The profile and the relationship are separate requests on purpose. The profile is public data that can be cached and server-rendered; the relationship is personal, cheap to compute, and may be slow or missing without breaking the page. The header renders the profile at once and the action area fills in when step 6 arrives."

### Flow: searching while the search cluster is down

```
 Browser              Search API               Elasticsearch   PostgreSQL              Indexer
    │                      │                         │              │                     │
    │ 1 GET /search?q=dev  │                         │              │                     │
    │─────────────────────▶│                         │              │                     │
    │                      │ 2 query, boost network  │              │                     │
    │                      │────────────────────────▶│              │                     │
    │                      │ 3 timeout -> breaker    │              │                     │
    │                      │◀────────────────────────│              │                     │
    │                      │ 4 full-text fallback                   │                     │
    │                      │───────────────────────────────────────▶│                     │
    │ 5 {users, source}    │                         │              │                     │
    │◀─────────────────────│                         │              │                     │
    ····································· meanwhile ·······································
    │                      │                         │              │ 6 claim dirty rows  │
    │                      │                         │              │◀────────────────────│
    │                      │                         │ 7 rebuild doc, backoff             │
    │                      │                         │◀───────────────────────────────────│
    │                      │                         │              │                     │
```

"The breaker in step 3 means only the first request in a 30-second window pays the timeout; the rest go straight to PostgreSQL. The `source` field in step 5 is how the backend's degradation becomes visible in the UI. Meanwhile the indexer keeps retrying with backoff, so nothing written during the outage is lost."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `member_pairs` | `(low_id, high_id)`, `state`, `requested_by`, `version` | Source of truth for invitations and connections; one row per two members |
| PostgreSQL | `adjacency` | `(member_id, other_id)`, `connected_at` | Derived from pair events, two rows per connection |
| PostgreSQL | `members`, `posts`, `jobs` | Member id, `(author_id, id)`, job id | Email is a private column, never in public projections |
| PostgreSQL | `outbox` | `id`, `topic`, `key`, `payload` | Same transaction as the change |
| Redis | `graph:ver:{member}`, `rel:…:{vA}:{vB}` | Version counters, cached relationships | Versioned keys instead of deletes |
| Redis | `pymk:{member}`, `posts:recent:{author}` | Precomputed lists | Filtered or merged at read time |
| Elasticsearch | `people`, `jobs` | Rebuilt documents | Derived from rows by workers |

### Client side

| Cache key | Holds | Invalidated by |
|-----------|-------|----------------|
| `['relationship', memberId]` | `degree`, `status`, `requestId`, `mutualCount`, `path` | Any connection mutation on that member; `pair.*` events |
| `['invitations']` | Received invitations | Accept, decline, `invitation.received` events |
| `['pymk']` | Suggestions with reasons | Connect from a card; `pair.connected` |
| `['feed']` | Pages with `nextCursor` | Time (2 min) and the "New posts" pill |
| `['search', q, filters]` | Hits and `source` | Time (1 min) |

### The contract

```
POST   /api/v1/invitations                {to, message?} → {outcome, status, invitation}
POST   /api/v1/invitations/{id}/accept    → {status, changed}   (/decline, /withdraw)
DELETE /api/v1/connections/{memberId}     → {removed}
GET    /api/v1/members/{id}/relationship  → {degree, status, request_id, mutual_count, path}
GET    /api/v1/pymk?limit=20              → {candidates[{member, reasons}]}
GET    /api/v1/feed?cursor=               → {posts, next_cursor}
GET    /api/v1/search/people?q=           → {hits, source}
GET    /api/v1/events                     text/event-stream with Last-Event-ID
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `outcome` (`sent`, `already_pending`, `connected`) | Says what the write did; repeating it is safe | Retry blindly and show the right state after a crossing invitation |
| `status` | Invitation state between the two members | Pick the button: Connect, Pending, Accept/Ignore, Connected |
| `degree` + `path` | Distance and one shortest chain, computed after the last committed change | Render the badge and the "how you're connected" line |
| `changed` | Whether the transition happened now or earlier | Skip the success toast on a duplicate accept |
| Public projections | No email or contact details outside your own profile | Render any member card without leaking data |
| `next_cursor` | Names a ranked snapshot and a position | Infinite scroll without repeats or gaps |
| `source` | Which engine answered the search | Say "results may be incomplete" when degraded |
| Event ids | Monotonic per member; replay after `Last-Event-ID` | Catch up after sleep or a network change |

---

## 🔧 Deep Dive 1: Connecting Two People (8 min)

"The scenario: Alice clicks Connect on Ethan's profile on a flaky train connection, the request times out, she clicks again — and Ethan, at the same moment, clicks Connect on Alice's profile. Without care we create two crossing invitations, inflate counters, or show Alice an error for something that worked."

**Browser.** The mutation snapshots `['relationship', ethan]`, writes `pending_sent`, and sends. On success it writes the server's `status` (which may be `connected`), invalidates `['pymk']`, and refetches the relationship to pick up the new path. On error it restores the snapshot and announces the message (`429` shows the retry time). A retry after a timeout is safe because the server's answer to a duplicate is `already_pending`, not an error.

**Server.** One transaction: lock the pair `(low, high)`; if they're already connected answer `409 already_connected`; if Ethan has a pending invitation to Alice, accept it — counters move once, the outbox row is written — and answer `outcome: connected`; otherwise insert or re-open Alice's invitation, or report `already_pending`. Accepts use a compare-and-set on `state = 'pending'`, so twenty concurrent accepts produce one change and nineteen `changed: false` responses.

**After commit.** Both members' graph versions are bumped before the response goes out, so Alice's next relationship read can't come from a cache filled a moment before. The outbox event updates adjacency and reaches Ethan's open tabs, which invalidate their `['relationship', alice]`.

| Approach | Verdict |
|----------|---------|
| ✅ Optimistic client + idempotent outcomes + pair lock | Instant, correct under retries, double clicks and crossing invitations |
| ❌ Client-side dedupe (disable the button) | Prevents double clicks, not timeouts, refreshes, other tabs or the other person |
| ❌ Idempotency-Key header per click | Dedupes Alice's retries but not Ethan's crossing invitation; the pair row already is the natural key |
| ❌ Unique constraint and surface the error | Turns a retry into a red error banner for an action that succeeded |

"What I give up: a lock per pair, which serializes only operations between the same two people — fine — and a slightly richer response shape that both sides must keep in sync. I'd generate the client types from the API schema so `outcome` and `status` can't drift."

---

## 🔧 Deep Dive 2: "How You're Connected" (7 min)

"The decision: one relationship endpoint that returns distance and invitation state separately, computed by a bidirectional search, cached with versions on the server and invalidated by events on the client."

**Why two fields.** Degree is graph distance; status is the invitation state between the two members. They're independent: a 3rd-degree stranger can have invited me (`pending_received`, Accept and Ignore buttons), and someone 2nd degree can be someone I already invited (`pending_sent`, a Pending button with Withdraw). Early versions of this kind of UI derive the button from the degree and end up offering Connect to someone who invited you, which fails with a confusing error.

**Server.** Read both first-degree sets (about 500 ids each, from in-memory adjacency or a versioned cache). If they intersect, the answer is 2nd degree, and the intersection gives the mutual count and the middle of the path. If not, expand the smaller side one hop (~500 lookups, batched) and look for a hit — that's the 3rd-degree path A → x → y → B. Hub members are capped by a budget. Path members are returned as public summaries (name, headline, avatar), never with contact details.

**Client.** `['relationship', id]` never goes stale on a timer; it's invalidated by mutations and by `pair.*` events. The `ConnectionPath` component renders "You → Bob → Ethan" with links and nothing for 1st degree; out of network shows "Outside your network" instead of a badge.

| Approach | Verdict |
|----------|---------|
| ✅ Separate `degree` and `status`, bidirectional search | Right button in every case; two lookups for most views |
| ❌ Button derived from degree | Offers Connect to people who already invited you |
| ❌ Precomputed second-degree sets | ~30 trillion stored ids, stale after every new edge in the neighborhood |
| ❌ Client computes degree from connection lists | Needs other members' connection lists — a privacy leak and megabytes per view |

"What I give up: a second request per profile view and real graph work on the server. It's cheap in the common case, and isolating it means a slow graph partition costs a badge, not the page."

---

## 🔧 Deep Dive 3: Search That Degrades Instead of Failing (6 min)

"The decision: profile and job edits reach Elasticsearch through a transactional outbox; when the cluster is unavailable, search answers from PostgreSQL full-text and the response says so."

**Write side.** Saving a profile commits the row and an outbox entry together, then returns — the request never waits on Elasticsearch. Workers claim entries (`FOR UPDATE SKIP LOCKED`, so several can run), rebuild the document from the current rows — profile, skills, companies — index it, and delete the entry only if nobody re-dirtied it meanwhile. Failures back off from seconds to minutes. Because each document is rebuilt from the source of truth, retries and out-of-order processing still converge.

**Read side.** A breaker stops calling Elasticsearch for 30 s after a connection failure or timeout. During that window the API queries generated full-text columns in PostgreSQL with GIN indexes — exact and prefix matches on names and headlines, no typo tolerance — and returns `source: postgres`.

**Client.** Typeahead debounces 200 ms, aborts the previous request with an `AbortController`, caches by normalized query and keeps the query in the URL. When `source` is `postgres`, it shows "Results may be incomplete" under the box.

| Approach | Verdict |
|----------|---------|
| ✅ Outbox + rebuild from rows + fallback with `source` | Edits never fail on search; index converges; search degrades visibly |
| ❌ Dual write in the request | An Elasticsearch timeout fails a profile edit that already committed; the retry then hits "email already exists" on sign-up |
| ❌ Async message published after commit | A crash between commit and publish loses the update silently |
| ❌ Return 503 when the cluster is down | Search is how people find each other; partial results beat none |

"What I give up: up to 30 seconds of index lag in normal operation, a worker fleet to watch, and a fallback that is noticeably worse — which is exactly why the UI tells the member."

---

## 📈 Failures & Scale (3 min)

| Failure | What the member sees | Mitigation |
|---------|----------------------|------------|
| Graph partition down | Profiles without the badge or path; actions still work | Replicas; the relationship query has its own timeout |
| Kafka or edge consumer lag | Other tabs update late; third parties see old adjacency | Outbox drains on recovery; the accepting member already has the new status |
| SSE stream lost | Changes from other devices appear on navigation | Reconnect with `Last-Event-ID`; fall back to polling the badge every 60 s |
| Elasticsearch down | "Results may be incomplete" | Breaker + PostgreSQL full-text; outbox retries |
| Invitation rate limit | "Try again in 3 minutes" on Connect | `429` + `Retry-After`; per-member token bucket |
| Shard primary down | Connect and post fail with a retry message; reading works | Replica promotion; reads from replicas and caches |

**What breaks first as we grow:** hub members in degree checks (expand the smaller side, cap the budget), feed candidate gathering (batched multi-gets, capped lists), the PYMK batch window (partition by member, nearline recompute), and, on the client, memory on marathon feed sessions (keep ~20 pages of data, drop older pages but keep their cursors).

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Invitation writes | Idempotent outcomes under a pair lock | Client dedupe or idempotency keys | Covers retries, other tabs and the other person |
| Connect UI | Optimistic, server status wins | Spinner, or boolean optimism | Instant and correct after crossing invitations |
| Relationship API | `degree` and `status` separately | Button derived from degree | Right action for every invitation state |
| Degree | Bidirectional search, versioned caches | Precomputed second-degree sets | Exact, fresh, two lookups in the common case |
| Search sync | Outbox, rebuild from rows | Dual write | Edits never fail on the index |
| Search outage | PostgreSQL fallback + `source` | Error page | Degraded and honest beats broken |
| Live updates | SSE events invalidate cache keys | Polling | Convergence in seconds at one connection per browser |

"With more time: privacy controls that hide connection lists from degree paths, invitation abuse controls ('I don't know this person' lowering a sender's limit), and schema-generated client types so the contract above is checked at build time."
