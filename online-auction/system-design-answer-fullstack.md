# 🔨 Online Auction (eBay-style) — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one bid through its whole life: tapped in a browser, judged against a contended row, pushed to ten thousand watchers, and — when the clock runs out — turned into exactly one winner and one notification. Three contracts between the layers carry most of the weight. An idempotency key makes a bid safe to retry. A version number lets every screen agree on the latest price and notice what it missed. And a server-owned end time keeps a last-second extension from fooling anyone's countdown."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and the targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the Bid button to the database and back to every watcher |
| Data model & API contract | 7 min | Server tables, client cache, and the fields both sides rely on |
| Deep dive 1: one tap, one bid | 8 min | Idempotency from the button to a unique index |
| Deep dive 2: a price everyone agrees on | 7 min | Row lock, versioned events, client gap detection |
| Deep dive 3: the last ten seconds | 7 min | Snipe extensions, the countdown, exactly-once closing |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Sellers list items with a starting price, increment, optional hidden reserve and duration. Bidders place manual bids or set a proxy maximum that bids for them. Everyone watching sees price, leader, bid history and countdown update live. A bid in the last two minutes extends the auction. At the end the system declares the winner, "reserve not met" or "no bids", and notifies everyone involved. Admins can force-close or cancel. Out of scope: payment, shipping, ratings.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Bid latency | p99 < 300 ms, including waiting behind other bids |
| Backend | Closing | Winner decided within 2 s of the end, exactly once |
| Backend | Durability | An acknowledged bid is never lost |
| Frontend | Item page load | LCP < 2.0 s on mid-range mobile (server-rendered) |
| Frontend | Responsiveness | INP < 200 ms while prices and timers tick |
| Both | Live freshness | New price on every watcher's screen < 1 s after acceptance |
| Both | Correctness | One tap places at most one bid; no screen shows a price going backwards; "You won" only from the server |

**Scale.** 2M daily users, 200K concurrent at peak, 1M live auctions, 10M bids/day (~115/s average, ~1,500/s peak). A hot item can take 50 bids in its final 10 seconds with 10K people watching.

"Those last numbers shape both sides. On the server, the problem is contention on one row, not throughput. On the wire, one accepted bid becomes 10,000 pushes, so every client must be able to apply an event without calling back. Otherwise the last ten seconds of a hot auction turn into 10,000 refetches per bid."

---

## 🏗️ End-to-End Architecture (8 min)

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Browser · auction page: BidForm (one Idempotency-Key per draft), BidHistory                  │
  │ WebSocket store: version-gated events, refetch on gap or reconnect                           │
  └─────┬────────────────────────────────────────────────────────────────────────────────────────┘
        │ (1) POST /api/v1/auctions/{id}/bids, Idempotency-Key                          ▲
        │                                                                (2) WebSocket  │
        ▼                                                                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS · /api/* → Auction API · /ws → Realtime gateway                          │
  └─────┬────────────────────────────────────────────────────────────────────────────────────────┘
        │                                                                     WebSocket ▲
        ▼                                                                               ▼
  ┌───────────────┐          ┌────────────────────┐          ┌───────────────┐ ┌─────────────────┐
  │ Auction API   │ lock, key│ Redis              │ (3) claim│ Closing       │ │ Realtime        │
  │ bids, browse  │─────────▶│ bid locks, idem    │◀─────────│ workers       │ │ gateway: subs,  │
  │ stateless     │          │ keys, endings ZSET │ due, ZREM│ every 1 s     │ │ fan-out         │
  └──────┬────────┘          └────────────────────┘          └──────┬────────┘ └─────────────────┘
         │ row-locked bid tx + outbox row                           │ close tx          ▲
         │                                                          │                   │ consume
         ▼                                                          ▼                   │
  ┌─────────────────────────────────────────────────────────────────────┐      ┌────────┴────────┐
  │ PostgreSQL · auctions, bids, auto_bids, notifications, outbox       │─────▶│ Kafka           │
  │ source of truth · primary + read replicas                           │relay │ auction-events  │
  └─────────────────────────────────────────────────────────────────────┘      └────────┬────────┘
                                                                                        │ consume
                                                                                        ▼
                                                                               ┌─────────────────┐
                                                                               │ Notification    │
                                                                               │ workers: email, │
                                                                               │ push, in-app    │
                                                                               └─────────────────┘
```

1. **Bid (1).** `BidForm` freezes the draft with an idempotency key and posts it. The Auction API claims the key and a per-auction admission lock in Redis, then decides the bid in one PostgreSQL transaction under the auction's row lock, and answers with the outcome and the new version.
2. **Live update (2).** The committed change goes through an outbox to Kafka, keyed by auction ID. Realtime gateways push `new_bid` to every subscribed socket, and each browser applies it by version.
3. **Close (3).** Closing workers claim due auctions from a Redis sorted set and close each under the same row lock. `auction_ended` flows back through the outbox to every watching browser and to the notification workers.

| Layer | Choice | Why |
|-------|--------|-----|
| Item and browse pages | Server-rendered, then hydrated SPA | Search traffic and shared links need fast, indexable item pages |
| Client state | Query cache for server data, one version-checked writer; Zustand for the socket and session | One place decides what's newest |
| Auction API | Stateless; synchronous bid decisions | The bidder must know the outcome immediately |
| PostgreSQL | Source of truth, row lock per auction, outbox | Correctness lives in one transaction |
| Redis | Admission locks, idempotency keys, endings sorted set | Coordination that can be rebuilt |
| Kafka + gateways | Versioned events, local fan-out | One event per bid across the backbone, not one per watcher |

### Flow: a bid across the wire

```
Bidder                       BidForm                    Auction API           PostgreSQL
   │                            │                            │                     │
   │ 1 Place bid $1,735         │                            │                     │
   │───────────────────────────▶│                            │                     │
   │                            │ 2 key K for "manual:1735"  │                     │
   │                            │ 3 POST /bids/{id}, key K   │                     │
   │                            │───────────────────────────▶│                     │
   │                            │                            │ 4 row lock, COMMIT  │
   │                            │                            │────────────────────▶│
   │                            │ 5 201 {1760, winning: no}  │                     │
   │                            │◀───────────────────────────│                     │
   │ 6 "Outbid by an auto-bid"  │                            │                     │
   │◀───────────────────────────│                            │                     │
   ························ timeout instead of a response ··························
   │                            │ 7 retry with the same K    │                     │
   │                            │───────────────────────────▶│                     │
   │                            │ 8 same 201, replayed       │                     │
   │                            │◀───────────────────────────│                     │
   │                            │                            │                     │
```

"Step 2 and the retry in step 7 are two halves of one contract. The browser promises to send the same key for the same bid — even after a refresh, because the key lives with the draft in `sessionStorage`. The server promises that a repeated key returns the original answer instead of bidding again. And step 6 shows why the bid is not optimistic: a hidden proxy maximum beat this bidder instantly, which only the server could know."

### Flow: the end of an auction

```
Auction page          Gateway                         Closing worker               PostgreSQL
      │                  │                                   │                          │
      │ 1 timer hits 0: "Closing…"                           │                          │
      │                  │                                   │ 2 close tx, FOR UPDATE   │
      │                  │                                   │─────────────────────────▶│
      │                  │                                   │ 3 sold to tomas, $1,800  │
      │                  │                                   │◀─────────────────────────│
      │                  │ 4 auction_ended (outbox → Kafka)  │                          │
      │                  │◀──────────────────────────────────│                          │
      │ 5 auction_ended  │                                   │                          │
      │◀─────────────────│                                   │                          │
      │ 6 refetch: "You won" / "Sold"                        │                          │
      │                  │                                   │                          │
```

"At zero, the page shows 'Closing…' rather than a winner. The server owns the deadline, and a bid may have landed in the final second and extended it. The winner appears when `auction_ended` arrives. If it hasn't come within a few seconds, the page refetches."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `auctions` | `id`, `current_cents`, `increment_cents`, `reserve_cents`, `status`, `end_time`, `version`, `winner_id` | `version` +1 on every price change, close, cancel |
| PostgreSQL | `bids` | `auction_id`, `bidder_id`, `amount_cents`, `is_auto`, `seq`, `idempotency_key` | Leader = first by `(amount DESC, seq)`; unique `(bidder_id, idempotency_key)` |
| PostgreSQL | `proxies` | `(auction_id, bidder_id)`, `max_cents`, `is_active` | Only the leader's proxy is active |
| PostgreSQL | `outbox` | `auction_id`, `type`, `version`, `payload` | Committed with the change |
| Redis | `idem:{user}:{key}` | Fingerprint, state, response | Claim 60 s, result 24 h |
| Redis | `auction_endings` | Sorted set by end time | Rebuilt from PostgreSQL by a reconciler |

### Client side

| Cache key / store | Holds | Updated by |
|-------------------|-------|------------|
| `['auction', id]` | Snapshot: price, end time, status, version, leader-first bids, my proxy | Events (version rule), bid responses (version rule), refetch on gap |
| `['auctions', filters]` | Cursor pages of cards | 30 s refresh while visible |
| Realtime store | One socket, subscriptions, listeners | Reconnect with backoff, resubscribe, then refetch |
| `sessionStorage['bid-draft']` | Frozen amount, kind, idempotency key | Cleared on a definitive answer |

### The contract

```
POST   /api/v1/auctions/{id}/bids     {amount} + Idempotency-Key → 201 {current_price, is_winning, version, end_time}
PUT    /api/v1/auctions/{id}/proxy    {max_amount} + Idempotency-Key → 200 {same fields}
GET    /api/v1/auctions/{id}          → {auction (with version), bids (leader first), my_proxy}
WS     /ws  subscribe {auction_id}    ← new_bid {version, current_price, leader_id, end_time, bids}
                                      ← auction_ended {version, outcome, winner_id, final_price}
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same body → same answer for 24 h; different body → `422`; in flight → `409` + `Retry-After` | Retry after timeouts and refreshes without bidding twice |
| `version` | +1 per change, in the same transaction, on every event and snapshot | Apply `v+1`, drop stale, refetch on a gap |
| `is_winning` + `current_price` in the `201` | The decision, including hidden proxy effects | Say "You're winning" or "Outbid by an auto-bid" without guessing |
| `minimum_bid` in `400` | The real next minimum under the lock | Correct the input in place |
| `end_time` on events and responses | The authoritative deadline, moved by snipe protection | Drive the countdown; show "Extended" |
| `auction_ended.outcome` | Decided once under the row lock | Switch to "You won", "Sold" or "Reserve not met" |

---

## 🔧 Deep Dive 1: One Tap, One Bid (8 min)

"The scenario: a bidder on a train taps Bid, the request times out, and they tap again. Without care we place two bids — maybe at two different prices — or show 'failed' for a bid that actually went through. Each layer has a job."

**Browser.** On submit, `BidForm` freezes the draft (amount and kind) and generates a key with `crypto.randomUUID()`, stored with the draft in `sessionStorage`. Every retry of that draft resends the key: the Retry button, an automatic retry on a network error, or a reload that finds a pending draft. Changing the amount makes a new draft and a new key. The button is disabled while pending, but correctness never depends on that.

**API.** Before touching the database, the API claims the key with `SET idem:{user}:{key} pending NX EX 60`, storing a fingerprint of the request. If the key has finished, it replays the stored answer with `Idempotent-Replayed: true`. If it's still in flight, it answers `409` and `Retry-After: 1`, and the client tries again shortly. If the fingerprint differs, it answers `422`, because reusing a key for a different bid is a client bug and should fail loudly. A failed attempt releases the claim so the same key can be retried.

**Database.** The caller's bid row stores the key under a unique `(bidder_id, idempotency_key)` index. That covers the gap Redis can't: the process committing the bid and dying before it stores the response, or Redis losing the record. The retry then finds the bid inside the transaction and answers from it.

| Approach | Verdict |
|----------|---------|
| ✅ Key per draft + Redis claim + unique index | Correct across double taps, timeouts, refreshes, concurrent duplicates and a lost Redis record |
| ❌ Disable the button only | Stops a double click; does nothing for a retry after a timeout or a reload |
| ❌ Server dedupe by `{user, auction, amount, second}` | Misses retries that straddle a second; can merge deliberate bids |
| ❌ Optimistic "bid placed" in the UI | The outcome depends on hidden proxies and the latest price |

"What I give up: one Redis round trip per bid, stored responses for a day, and a client that has to manage a draft lifecycle. That's cheap for the most consequential button on the site."

---

## 🔧 Deep Dive 2: A Price Everyone Agrees On (7 min)

"Ten thousand screens, one price. The server has to decide bids in one order, and every screen has to converge on that order — even if it misses events or receives them twice."

**Server: one order.** Every bid takes `SELECT … FOR UPDATE` on the auction row, so bids on one auction are strictly serial. Each sees the committed result of the previous one. Proxy resolution happens inside that lock, as a pure second-price function in integer cents. The resulting price, the inserted rows, `version + 1` and an outbox event commit together. A Redis admission lock with a 1.5 s bounded wait keeps a burst queued in Redis instead of in the database connection pool.

**Transport: keep the order.** The outbox relay publishes to Kafka with the auction ID as the key, so events for one auction stay in order. Gateways keep no history: they forward each event to the sockets subscribed to that auction.

```
PostgreSQL               Relay                        Kafka       Gateway          Watcher
     │                     │                            │            │                │
     │ 1 read outbox rows  │                            │            │                │
     │◀────────────────────│                            │            │                │
     │ 2 new_bid v42       │                            │            │                │
     │────────────────────▶│                            │            │                │
     │                     │ 3 publish, key auction_id  │            │                │
     │                     │───────────────────────────▶│            │                │
     │                     │                            │ 4 consume  │                │
     │                     │                            │◀───────────│                │
     │                     │                            │            │ 5 new_bid v42  │
     │                     │                            │            │───────────────▶│
     │                     │                            │       6 42 = 41 + 1: apply  │
     ·························· socket drops and reconnects ···························
     │                     │                            │            │ 7 new_bid v45  │
     │                     │                            │            │───────────────▶│
     │                     │                            │    8 gap: refetch snapshot  │
     │                     │                            │            │                │
```

**Client: converge.** The page holds a snapshot with its version. Event `v+1` is applied in place — price, end time, leader, new rows merged by ID, leader-first. Anything at or below the current version is ignored. A gap triggers one refetch, as does a re-subscription after reconnect. A refetched snapshot replaces the current one only if it's at least as new. The bid's own `201` response goes through the same version check, because the WebSocket event for a later bid may already have arrived.

| Approach | Verdict |
|----------|---------|
| ✅ Row lock + versioned events + client version rule | One order on the server; every screen converges; missed events detected |
| ❌ Refetch the auction on every event | 10K watchers × 50 bids of extra load in the final seconds; slow responses can roll the price back |
| ❌ Optimistic version check on the server | A losing bid can't be retried without spending more than the user authorized |
| ❌ Gateways replaying history per client | Stateful gateways; the version rule plus a refetch achieves the same with none |

"What I give up: every event carries a version and the rows it created, and the client funnels every write through one function. That function is the whole client-side consistency model, so it's the first thing I'd unit-test."

---

## 🔧 Deep Dive 3: The Last Ten Seconds (7 min)

"Two things change in the last seconds: the deadline can move, and someone has to declare a winner while people are still bidding."

**Snipe protection lives in the bid transaction.** If a price change lands with less than the snipe window left, `end_time` moves to now + window in the same transaction, under the same row lock. No bid is ever judged against a deadline another request is in the middle of changing. The new end time is in the `201` and in the `new_bid` event, so every countdown jumps forward together with an "Extended +2:00" cue. I cap extensions with a counter so a bidding war can't run forever.

**The countdown follows the server.** The client keeps a server-time offset and counts down to the server's `end_time`. At zero it says "Closing…" and disables the form — it never declares a result itself.

**The closer is exactly-once.** End times live in a Redis sorted set. Each closing worker reads due IDs every second and claims each with `ZREM`; only one worker gets it. The close then runs under the auction's row lock and re-checks the state:

- already ended → stop;
- `end_time` moved → put the new time back in the set and stop;
- otherwise → pick the leader (earliest bid at the highest amount), compare to the reserve in cents, and commit status, winner, notifications and the `auction_ended` event together.

A reconciler re-adds active auctions that end within two minutes, from PostgreSQL, so a lost Redis entry delays a close instead of stranding it.

**Late bids are impossible regardless.** The bid transaction rejects anything after `end_time`, under the lock, so a slow closer delays the announcement but never lets a bid in.

| Approach | Verdict |
|----------|---------|
| ✅ Extend in the bid tx; server-time countdown; close under the row lock | Deadline, bids and close are serialized by the same lock; the UI never guesses |
| ❌ Client declares "Ended" at zero | Wrong whenever a last-second bid extended the auction |
| ❌ Closer without re-checking under the lock | Closes an extended auction early, or two workers notify twice |
| ❌ Hard close with no extension | Simpler, but rewards sniping bots over people |

"What I give up: a second or two of 'Closing…' instead of an instant result, and an auction that can run longer than its listing said. Both are easier to explain to users than a wrong winner."

---

## 📈 Failures & Scale (2 min)

| Failure | What the bidder sees | What a watcher sees | Mitigation |
|---------|----------------------|---------------------|------------|
| Burst on one auction | A short pending state; rarely "try again in 1 s" | Prices update in quick succession | Bounded admission wait; row lock |
| Bid response lost | "Still sending…", then the original result | Nothing unusual | Same key; durable unique index |
| Socket drops | "Reconnecting…" badge; bidding still works | Same | Resubscribe, then refetch by version |
| Kafka lag | Own bid result is immediate | Prices late by seconds | The `201` is authoritative; the version rule catches up |
| Redis down | "Bidding is temporarily unavailable" | Prices freeze | Fail closed with `503`; closer falls back to the partial index |
| Closer slow at 8 p.m. | "Closing…" a little longer | Same | More workers; claims spread the load; late bids still rejected |

**What breaks first:** fan-out on hot items (handled at the gateways), then closing spikes at round times (more workers), then bid storage (~550 GB/year, sharded by auction ID so each bid stays on one shard).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Bid safety | Key per draft + Redis claim + unique index | Disabled button or server fingerprint | Retries can't duplicate; deliberate bids are never merged |
| Bid concurrency | Row lock, synchronous `201` | Optimistic checks, or queue + `202` | Correct answers without asking users to re-bid |
| Live view | Versioned events applied in place | Refetch per event, or polling | Constant load per bid; gaps detected; never backwards |
| Bid UI | Pessimistic, server-decided outcome | Optimistic "You're winning" | Hidden proxies decide; the UI must not lie |
| Deadline | Snipe extension in the bid tx; server-time countdown | Client-side end; hard close | One lock serializes bids, extensions and the close |
| Closing | Sorted set + `ZREM` + close under the row lock | DB polling or timers | Parallel, exactly once, PostgreSQL stays the truth |

"With more time: a post-close checkout with its own idempotent payment state machine, push notifications for 'outbid' and 'ending soon' on watched items, and offline-first caching of the item shell so a bidder on a bad connection still sees the last known price and its age."
