# Online Auction — Development with Claude

## Project Context

An auction is a distributed systems problem disguised as a shopping site. Almost every write in this system is a read-modify-write against one contended row — "read the current price, decide whether this bid beats it, write the new price" — and it has to stay correct while dozens of bidders hammer the same auction in the final ten seconds. Get the concurrency control wrong and two bidders both read $100, both bid $105, and both are told they're winning.

The second hard problem is that auctions end on a wall clock, not on a request. Nothing user-initiated happens at 14:00:00 when an auction closes, yet a winner must be determined, notifications must fan out, and every connected browser must be told. And the ending itself is mutable: snipe protection extends `end_time` whenever a bid lands inside the final window, so "when does this auction end" is a moving target right up until it isn't.

**Learning goals:** pessimistic row locking under contention, distributed locks as an admission-control layer in front of the database, idempotency for a money-adjacent write, proxy/auto-bidding resolution, time-based scheduling with a Redis sorted set, and WebSocket fan-out via Redis pub/sub.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`) | **3001** (`npm run dev` → `PORT=3001 tsx watch`) | One process: Express routes plus a `ws` server mounted on the same HTTP server at `/ws`, so no separate socket tier to run |
| **Auction scheduler** (`backend/src/services/scheduler.ts`) | In-process in every API instance: 1 s tick, 30 s reconcile | Claims due auctions from the Redis sorted set with `ZREM`; closes through `auctionLifecycle.ts` |
| **PostgreSQL 16** | 5432 (`auction`/`auction123`, db `auction_db`) | `users`, `auctions`, `bids`, `auto_bids`, `watchlist`, `notifications`, `sessions` (unused). UUID PKs via `uuid-ossp`, money as `DECIMAL(12,2)` |
| **Valkey 7** | 6379 | Sessions, per-auction admission locks, idempotency records, bid-history cache, pub/sub fan-out, and the `auction_endings` sorted set |

Read the bid path in this order: `backend/src/routes/bids.ts` (HTTP pipeline + the row-locked transaction), then `backend/src/services/bidEngine.ts` (pure proxy resolution in integer cents). Closing and cancelling live in `services/auctionLifecycle.ts`; the loop that drives closing is `services/scheduler.ts`. Redis primitives (admission lock, idempotency claim/replay, pub/sub, schedule, rate limit) are in `backend/src/redis.ts`; WebSocket subscription bookkeeping is in `services/websocket.ts`. Frontend is React 19 + TanStack Router + Zustand + Tailwind on Vite 5173, proxying `/api`, `/uploads` and `/ws` to 3001. `stores/websocketStore.ts` owns the socket, and `utils/auctionEvents.ts` applies versioned `new_bid` events on the auction page. `hooks/useCountdown.ts` drives the timer.

## Key Design Decisions

### 1. Pessimistic `SELECT … FOR UPDATE`, not optimistic version checks

Every bid opens a transaction and takes `SELECT … FOR UPDATE` on the auction row, holding the row lock through validation, proxy resolution, bid inserts, the price update and outbid notifications.

Optimistic locking is the textbook answer for high contention. It fails here for a reason specific to auctions: a bidder who loses the version race can't be retried automatically. By the time the retry runs, the price has *moved above what they authorized*. Resubmitting the same amount is now an invalid bid, and resubmitting a higher one spends money the user never agreed to. So every conflict becomes a user-visible failure, and in the closing seconds of a hot auction — exactly when contention peaks — many bidders would see "please try again" instead of a bid. Serializing on the row means the second bidder waits a few milliseconds and then gets a *correct* answer: either they're winning, or they're told the real minimum.

The cost is throughput on a single hot auction: bids against one auction are strictly serial, so the lock hold time is the ceiling. That's tolerable because auctions shard perfectly and a bid is a slow human action. `version` is still bumped on every price change, close and cancel, but it is no longer vestigial. It is the sequence number on every real-time event, which is how clients drop stale events and detect missed ones.

### 2. A Redis lock in *front* of the row lock, doing a different job

`acquireLock('auction:{id}', 5, 1500)` (a `SET NX EX` with a random token and a Lua compare-and-delete on release) is taken before the transaction begins. That looks redundant next to `FOR UPDATE`, and for correctness it is — Postgres alone is sufficient. It's there as admission control.

Without it, N concurrent bidders on one auction each occupy a `pg` pool connection while blocked on the same row lock. The pool is shared across the whole API, so one popular auction in its final seconds can exhaust it and stall unrelated requests. The Redis lock moves the queue out of the connection pool. Since 2026-10-10 it polls with 10–40 ms jitter for up to 1.5 s before answering `429` with `Retry-After`, instead of rejecting on the first collision. That absorbs a realistic burst (32 simultaneous bids across two instances finished in under 0.5 s with no `429`). A process that dies mid-transaction still blocks that auction for up to the 5 s TTL.

### 3. Client idempotency keys, scoped per user, with a durable backstop

Bids are not idempotent by nature. `POST /api/bids/:auctionId` and `/auto` accept `Idempotency-Key` (legacy `X-Idempotency-Key` too). The key is claimed in Redis with `SET NX` under `idempotency:bid:{user}:{key}` together with a fingerprint of the request. A finished key replays the stored response (`Idempotent-Replayed: true`), a key in flight gets `409` + `Retry-After`, the same key with a different body gets `422`, and a failed attempt releases the claim. The caller's bid row also stores the key under a unique `(bidder_id, idempotency_key)` index. A retry after Redis lost the record, or after a crash between `COMMIT` and storing the response, is answered from PostgreSQL instead of bidding again.

There is deliberately no server-synthesized key any more (the old `{auction}:{bidder}:{amount}:{second}` fingerprint could merge a deliberate bid or miss a retry that straddled a second). Without a header, a request is simply not deduplicated. The "leader cannot outbid themselves" rule (`409 already_leading`) catches the common double click anyway.

### 4. Auction endings: a sorted set as the index, PostgreSQL as the truth

`scheduleAuctionEnd` does `ZADD auction_endings {endTimeMs} {auctionId}`. Each scheduler tick reads up to 100 due IDs and claims each with `ZREM` — exactly one instance gets `1` — before calling `closeAuction`. A reconciler re-adds every active auction ending within two minutes (or overdue) from PostgreSQL at startup and every 30 s. A flushed Redis, a crash between claim and close, or rows inserted straight into SQL (the seed) therefore delay a close by one interval instead of stranding the auction.

Correctness comes from `closeAuction`, not from the claim. It re-reads the row under `FOR UPDATE`: not active → stop; `end_time` moved by a snipe extension → re-`ZADD` and stop; otherwise it writes status, winner, notifications and proxy deactivation in one transaction. Redis follows after `COMMIT`. The sorted set still earns its place over polling `WHERE status='active' AND end_time <= NOW()`, because `ZREM` gives every instance a share of the work without a coordinator.

### 5. Snipe protection extends the auction inside the same transaction as the bid

If a price change (manual bid or proxy) lands with less than `snipe_protection_minutes` remaining, `end_time` is pushed to now + the full window before `COMMIT`; `0` disables protection. Doing it in the bid transaction is what makes it correct: the row is locked, so no bid is judged against an end time another request is in the middle of changing. The new end is re-`ZADD`ed after commit and sent in the `new_bid` event.

The trade-off is that an auction with sustained late bidding never ends — each bid buys another window, indefinitely. There is still no maximum-extension cap.

## Current State

Runs end to end: registration and login (bcrypt, Redis-backed session tokens), auction creation with image upload via multer to `backend/uploads/`, browsing and auction detail, and bidding. Manual and proxy bids share one row-locked transaction. Proxy resolution is a pure second-price function in integer cents: ties go to the earlier proxy, a proxy never bids past its maximum, a manual bid is recorded at exactly its amount, the leader cannot outbid themselves, and only the leader keeps an active proxy. The rest:

- `Idempotency-Key` handling with a durable unique index, per-user rate limiting (10 bids/minute, atomic Lua counter), and a bounded-wait admission lock.
- Snipe protection for both bid kinds; outbid notifications only for displaced leaders and exhausted proxies.
- Exactly-once closing across instances with reserve handling in cents; seller and admin cancel under the row lock; admin force-close through the same close transaction.
- Live updates over WebSocket fanned out through Redis pub/sub, with versioned events that the auction page applies in place.
- Watchlist, in-app notifications, an admin dashboard, and Prometheus metrics with bounded label cardinality.

`cd backend && npm test` runs 26 offline vitest tests.

Seeded from `backend/db-seed/seed.sql`: **`admin@auction.com`** / **`password123`** (role `admin`) plus four bidder accounts (`nadia`, `tomas`, `priya`, `marcus`, same password), 8 auctions spanning live/sold/reserve-not-met, bid histories, proxy bids (tomas leads the Leica through a proxy, marcus the Aeron), watchlist rows and notifications.

Simplified or omitted: no payment or escrow — winning is a status change and a notification; notifications are database rows with no email/push delivery; the scheduler runs in-process in every API instance rather than in a dedicated worker; events are published to Redis after commit (no outbox, so at-most-once); `shared/circuitBreaker.ts` exists but is not wired into any route; and the frontend uses `fetch` + `useState`, not TanStack Query.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced a CLAUDE.md that was the *unmodified* blank template — every phase marked "Not started" or "In progress", and "Design Decisions Log", "Iterations and Learnings", "Questions and Discussions", and "Resources" all left as italic placeholder text. It claimed Phase 1 (Requirements and Design) had not started for a project with a complete schema, distributed locking, idempotency, proxy bidding, snipe protection, and WebSocket fan-out already built.
- **Seed credential comment is wrong (documented here, hash left alone):** `db-seed/seed.sql` says `-- Insert sample admin user (password: admin123)`, but the stored bcrypt hash verifies against **`password123`**. `scripts/screenshot-configs/online-auction.json` uses the correct one; the comment is the thing that's lying.
- **DECIMAL-as-string coercion (fixed):** `pg` returns `DECIMAL`/`NUMERIC` as JavaScript *strings* to protect precision, so `currentPrice + bidIncrement` silently concatenated — `"100" + "1.00"` became `"1001.00"`, and the minimum-bid check then compared against a nonsense value. Every read of `current_price`, `bid_increment`, and `max_amount` now goes through the `num()` helper at the top of `routes/bids.ts`.
- **Backend port pinned:** `dev` is `PORT=3001 tsx watch src/index.ts` to match the three Vite proxy targets (`/api`, `/uploads`, and the `ws://` upgrade for `/ws`). `index.ts` defaults to 3000 without `PORT`, which would break all three at once.
- **Lock release made safe:** `releaseLock` uses a Lua compare-and-delete against the stored lock value rather than a bare `DEL`, so a process whose lock already expired cannot delete a lock another request has since acquired.
- **2026-07-30 — the catalogue was empty and the guarded pages didn't work.** Three findings:
  1. **`db-seed/seed.sql` contained one user and nothing else.** The Current State section above used to claim "plus sample auctions and bids"; it was wrong. Browse filters to `status='active'`, so the front page read "No auctions found" on every fresh stack. The seed now creates 5 users and 8 auctions — six live (ending in minutes, hours and days), one ended-and-sold, one ended-below-reserve — with bid histories, an active and an exhausted proxy bid, watchlist entries, and the notification types the closing path emits. Bidders have to be separate accounts because the bid path rejects bidding on your own auction, so a single-user seed could never produce a single bid.
  2. **Every timestamp column was naive `TIMESTAMP`.** node-postgres parses those as *local* time, so with the database in UTC and the machine at −07:00, an auction seeded to end in 11 minutes rendered "Ends in 7h 10m" — and the scheduler's "what is due now" comparison was wrong by the same 7 hours. All 13 columns are now `TIMESTAMPTZ`. For a product whose entire UI is a countdown, this column type is load-bearing.
  3. **Guarded routes silently redirected to the browse page.** `authStore`'s `partialize` persists only the token, so `isAuthenticated` starts false on every load; `checkAuth` runs from a `main.tsx` effect, i.e. *after* each routed component's own guard effect. `/notifications` therefore bounced to `/login`, which saw the now-restored session and bounced to `/`. Fixed once at the root by not rendering `RouterProvider` until `isLoading` clears, which covers all five guarded routes rather than teaching each to wait. (Same class as microsoft-teams, notification-system and notion.)
- **Answer doc:** backend trimmed 573→541 by turning the Prometheus ASCII box into a table with a note on which metric *pair* is worth watching.
- **2026-10-10 (bid engine, exactly-once closing, idempotency, docs rewrite):**
  - *Proxy bidding was wrong in money-visible ways.* A manual bid that tied a proxy's maximum was recorded at max + increment, charging the bidder more than they typed. A proxy could answer above its own maximum. A second live proxy was ignored. A proxy set by the current leader bid against themselves. Re-sending the same maximum placed another bid. Resolution is now `services/bidEngine.ts`, a pure function over integer cents with 16 unit tests, and `routes/bids.ts` runs manual and proxy bids through one row-locked transaction. Rows are inserted so that the leader is always the earliest bid at the highest amount, which is also what the close uses. The seed was made consistent with this: tomas's and marcus's active proxies now have the response bids they would have placed, with current prices 1710 and 630.
  - *Closing could not work and could not be trusted.* `closeAuction` called `.toFixed()` on a DECIMAL string, which threw for every auction with a winning bid, so those auctions retried forever. It compared the reserve as a string, so "950.00" counted as meeting a "1000.00" reserve. It never re-checked `end_time`, so a stale schedule entry closed a snipe-extended auction. Without any lock, two instances both wrote winner notifications. Seeded auctions were never in the sorted set, so they never closed. Now: `services/auctionLifecycle.ts` decides under `FOR UPDATE` (pure `decideClose`, reserve in cents) and writes status and notifications in one transaction. `scheduler.ts` claims with `ZREM` and reconciles from PostgreSQL. Seller and admin cancel moved under the same row lock (the check-then-cancel race let a bid slip in), and so did the seller's "edit before first bid" check.
  - *Idempotency.* Keys were global, so one user's key replayed another user's response. A validation failure inside the transaction leaked the in-progress marker for 30 s. And the response was stored only after outbid notifications ran. Keys are now per user, fingerprinted (`422` on reuse), released on failure, and backed by `bids.idempotency_key` with a unique `(bidder_id, idempotency_key)` index. A Redis error anywhere in the bid pipeline answers `503` + `Retry-After` instead of an unhandled rejection. The admission lock waits up to 1.5 s with jitter instead of failing on the first collision, and uses a random token. The rate limiter is one Lua call. Metrics no longer label by auction ID.
  - *Live updates never reached a browser.* `websocket.ts` pattern-subscribed with `psubscribe` but listened for `message` (ioredis emits `pmessage`). It also attached socket listeners only after an awaited session lookup, so the store's immediate `subscribe` was dropped. Both were found by the runtime check and fixed. `new_bid` now carries `version`, `end_time`, `leader_id` and the inserted rows. The auction page applies events by version (`utils/auctionEvents.ts`), refetches only on a gap, `auction_ended` or reconnect, and no longer re-subscribes on every bid. `BidForm` sends one `Idempotency-Key` per submitted draft.
  - *Schema:* `init.sql` is now re-runnable (`IF NOT EXISTS`, guarded `fk_winning_bid`, `CREATE OR REPLACE TRIGGER`), adds `bids.idempotency_key`, `idx_bids_leader` and `idx_bids_idempotency`; seed notification types match what the code writes (`auction_won` / `auction_sold` / `auction_lost`).
  - *Verified:* backend `tsc`, lint and 26 vitest tests; frontend `tsc` and `build` (its one lint error, `_get` in `authStore.ts`, predates this). Against PostgreSQL 16 and a private Redis with two API instances: schema loaded twice, then 28 runtime checks. They covered proxy answers and ties, replay/`422`/concurrent duplicates and the durable fallback, eight simultaneous $101 bids yielding exactly one acceptance, and a shuffled 24-bid burst whose rows each beat the previous price. They also covered one versioned WebSocket event per accepted bid across instances, exactly-once close notifications with two schedulers, the reserve compared as money, a stale entry rescheduled instead of closing an extended auction, force-close and the cancel rules.
  - *Docs:* `architecture.md` and the three answers rewritten around one layered overview (browser → load balancer → API / closer / gateway → Redis, PostgreSQL → Kafka → notifications) with numbered journeys, plus generated sequence diagrams for the bid, the fan-out and the close.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. Snipe protection still has no cap, so a contested auction can be extended indefinitely. Is a maximum number of extensions (an `extension_count` column) the right guard, or a decaying window where each extension is shorter than the last?
2. Events are published to Redis after `COMMIT`, so a crash in between drops one event (clients recover on the next event's version gap or on reconnect). Is a transactional outbox worth adding locally, given there is no Kafka to relay to?
3. Every API instance runs the scheduler loop. The `ZREM` claim makes the duplicate work an empty tick, but a dedicated closer process would let closing spikes and bid traffic scale separately. Is that split worth the extra process for a local project?
4. The rate limit is a per-user fixed window (10/minute, manual and proxy combined). Should raising your own proxy maximum count against it, given it never moves the price unless it meets the reserve?

## Resources

- [Redis: distributed locks (Redlock)](https://redis.io/docs/latest/develop/use-cases/patterns/distributed-locks/) — including why single-instance `SET NX` + Lua release is honest about its guarantees
- [PostgreSQL: explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) — `SELECT … FOR UPDATE` semantics
- [PostgreSQL: transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — what read-committed does and doesn't protect a bid from
- [Stripe: designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — the structure behind `auction_endings`
