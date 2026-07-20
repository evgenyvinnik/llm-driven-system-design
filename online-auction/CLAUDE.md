# Online Auction — Development with Claude

## Project Context

An auction is a distributed systems problem disguised as a shopping site. Almost every write in this system is a read-modify-write against one contended row — "read the current price, decide whether this bid beats it, write the new price" — and it has to stay correct while dozens of bidders hammer the same auction in the final ten seconds. Get the concurrency control wrong and two bidders both read $100, both bid $105, and both are told they're winning.

The second hard problem is that auctions end on a wall clock, not on a request. Nothing user-initiated happens at 14:00:00 when an auction closes, yet a winner must be determined, notifications must fan out, and every connected browser must be told. And the ending itself is mutable: snipe protection extends `end_time` whenever a bid lands inside the final window, so "when does this auction end" is a moving target right up until it isn't.

**Learning goals:** pessimistic row locking under contention, distributed locks as an admission-control layer in front of the database, idempotency for a money-adjacent write, proxy/auto-bidding resolution, time-based scheduling with a Redis sorted set, and WebSocket fan-out via Redis pub/sub.

## Architecture at a Glance (what actually runs)

| Component | Port / detail | Why this one |
|-----------|--------------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`) | **3001** (`npm run dev` → `PORT=3001 tsx watch`) | One process: Express routes plus a `ws` server mounted on the same HTTP server at `/ws`, so no separate socket tier to run |
| **Auction scheduler** (`backend/src/services/scheduler.ts`) | In-process, 1s `setInterval` | Started by `index.ts`; polls the Redis sorted set and closes anything past due |
| **PostgreSQL 16** | 5432 (`auction`/`auction123`, db `auction_db`) | `users`, `auctions`, `bids`, `auto_bids`, `watchlist`, `notifications`, `sessions`. UUID PKs via `uuid-ossp`, money as `DECIMAL(12,2)` |
| **Valkey 7** | 6379 | Sessions, per-auction distributed locks, idempotency keys, bid/auction caches, pub/sub fan-out, and the `auction_endings` sorted set |

The whole bid path lives in `backend/src/routes/bids.ts` — it is the file worth reading first. Redis primitives (lock acquire/release, idempotency, pub/sub, scheduling, rate limiting) are all in the single module `backend/src/redis.ts`. WebSocket subscription bookkeeping is in `backend/src/services/websocket.ts`. Frontend is React 19 + TanStack Router + Zustand + Tailwind on Vite 5173, proxying `/api`, `/uploads`, and `/ws` to 3001; `stores/websocketStore.ts` and `hooks/useAuctionSubscription.ts` handle live price updates, `hooks/useCountdown.ts` drives the timer.

## Key Design Decisions

### 1. Pessimistic `SELECT … FOR UPDATE`, not optimistic version checks

Every bid opens a transaction and takes `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`, holding the row lock through validation, auto-bid resolution, bid inserts, and the price update.

Optimistic locking is the textbook answer for high contention, and the schema still has the `version INTEGER` column from that design. It fails here for a reason specific to auctions: with optimistic control, a bidder who loses the version race is told to retry — but by the time they retry, the price has *moved above what they authorized*. There is no safe automatic retry, because re-submitting the same amount is now an invalid bid and re-submitting a higher one is spending money the user never agreed to. So every conflict becomes a user-visible failure, and in the closing seconds of a hot auction — exactly when contention peaks — a large fraction of bidders would see "please try again" instead of a bid. Serializing on the row means the second bidder waits a few milliseconds and then gets a *correct* answer: either they're winning, or they're told the real minimum.

What we give up is throughput on a single hot auction: bids against one auction are strictly serial, so the row's lock hold time is the ceiling. That's tolerable because auctions shard perfectly — different auctions never contend — and because a bid is a slow human action, not a machine-rate write. Note that `version = version + 1` is still incremented on every price update but is never read in a `WHERE` clause; it is vestigial and would only become meaningful if a caller started passing an expected version.

### 2. A Redis lock in *front* of the row lock, doing a different job

`acquireLock('auction:{id}', 5)` (a `SET NX EX` with a Lua compare-and-delete on release) is taken before the transaction begins, and a failure returns **429**, not a wait. That looks redundant next to `FOR UPDATE`, and for correctness it is — Postgres alone is sufficient. It's there as admission control.

Without it, N concurrent bidders on one auction each occupy a connection from the `pg` pool while blocked on the same row lock. The pool is shared across the entire API, so a single popular auction in its final seconds can exhaust it and stall *unrelated* requests — browsing, login, other auctions. The Redis lock moves the queue out of the connection pool: only one bidder per auction is ever inside a transaction, and the rest are rejected immediately with a retryable status rather than parked on a scarce resource.

The cost is a fast-fail UX. During a burst, losers get 429s and must retry from the client, and the 5-second TTL means a process that dies mid-transaction blocks that auction for up to 5s. Both are cheaper than pool exhaustion, but a bounded wait-and-retry would be gentler than an immediate reject.

### 3. Idempotency keys with an in-progress marker, derived when the client doesn't supply one

Bids are not idempotent by nature: submit the same request twice and you have two bids. Retries are inevitable — a flaky network on the "Bid" button, a double click, a client-side retry on timeout. So `POST /api/bids/:auctionId` first checks a Redis idempotency key; a hit returns the *original* result with `_idempotent: true` rather than re-executing.

The subtle part is the in-progress marker. Checking a stored *result* only dedupes retries that arrive after the first completed. Two duplicates racing in parallel both find no result and both proceed. `markBidInProgress` closes that with a `SET NX` claim (30s TTL) taken before any work, so the second concurrent duplicate gets a 409 instead of placing a second bid.

When the client sends no `X-Idempotency-Key`, the server synthesizes one from `{auctionId}:{bidderId}:{amount}:{unixSecond}`. That's a deliberate approximation: it collapses identical rapid clicks but only within the same wall-clock second, and two *legitimate* identical bids from the same user in the same second would be wrongly merged. Given the minimum-increment rule makes a genuine duplicate-amount bid invalid anyway, the false-merge risk is close to zero — but a client-supplied key is strictly better and is honored when present.

### 4. Auction endings live in a Redis sorted set, polled every second

`scheduleAuctionEnd` does `ZADD auction_endings {endTimeMs} {auctionId}`; the scheduler runs `ZRANGEBYSCORE auction_endings 0 now` once a second and closes whatever comes back.

The obvious alternative — `SELECT * FROM auctions WHERE status='active' AND end_time < NOW()` on a timer — means a database query every second forever, whose cost grows with the auctions table even when nothing is ending. The sorted set answers "what is due right now" in O(log N + M) against data that is already in memory, and the common case returns an empty array at negligible cost. It also composes with snipe protection: extending an auction is a re-`ZADD` of the same member, which updates the score in place rather than needing a delete-then-insert.

Two things we accept. The sorted set is now authoritative state outside Postgres — if Redis loses it, auctions silently never close, and nothing currently rebuilds it from the database on boot. And the scheduler runs in-process in every API instance, so with `dev:server2`/`dev:server3` running, all three would try to close the same auction; `closeAuction` guards with `WHERE status = 'active'` so the losers no-op, but the fan-out work is genuinely racing.

### 5. Snipe protection extends the auction inside the same transaction as the bid

If a bid lands with less than `snipe_protection_minutes` (default 2) remaining, `end_time` is pushed to now + the full window before `COMMIT`. Doing it in the bid transaction is what makes it correct: the row is already locked, so there is no window where one request reads the old `end_time`, another extends it, and a third bid is rejected as "ended" against an auction that is in fact still open.

The trade-off is that an auction with sustained late bidding never ends — each bid buys another two minutes, indefinitely. eBay's hard-close plus proxy bidding is the alternative philosophy, and it trades this unbounded tail for the sniping behavior the feature exists to prevent. There is currently no maximum-extension cap, which is the obvious missing guard.

## Current State

Runs end to end: registration and login (bcrypt, Redis-backed session tokens), auction creation with image upload via multer to `backend/uploads/`, browsing and auction detail, manual bidding with full validation (active status, not ended, not your own auction, at least current price + increment), proxy/auto-bidding with competing-auto-bid resolution and deactivation of outbid proxies, per-user rate limiting (10 bids/minute), snipe protection, watchlist, an in-app notifications table populated on outbid/won/lost/sold/no-bids/reserve-not-met, scheduled auction closing with reserve-price handling, live price updates over WebSocket fanned out through Redis pub/sub, an admin route, and Prometheus metrics covering bid latency, bid totals, lock acquisition outcomes, lock hold duration, and idempotent-request counts.

Seeded from `backend/db-seed/seed.sql`: user **`admin@auction.com`** / **`password123`** (role `admin`), plus sample auctions and bids.

Simplified or omitted: no payment or escrow — winning is just a status change and a notification; notifications are database rows with no email/push delivery; the scheduler is in-process rather than a dedicated worker; `shared/circuitBreaker.ts` exists but is not wired into any route; and there is no reconstruction of the `auction_endings` sorted set from Postgres at startup.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced a CLAUDE.md that was the *unmodified* blank template — every phase marked "Not started" or "In progress", and "Design Decisions Log", "Iterations and Learnings", "Questions and Discussions", and "Resources" all left as italic placeholder text. It claimed Phase 1 (Requirements and Design) had not started for a project with a complete schema, distributed locking, idempotency, proxy bidding, snipe protection, and WebSocket fan-out already built.
- **Seed credential comment is wrong (documented here, hash left alone):** `db-seed/seed.sql` says `-- Insert sample admin user (password: admin123)`, but the stored bcrypt hash verifies against **`password123`**. `scripts/screenshot-configs/online-auction.json` uses the correct one; the comment is the thing that's lying.
- **DECIMAL-as-string coercion (fixed):** `pg` returns `DECIMAL`/`NUMERIC` as JavaScript *strings* to protect precision, so `currentPrice + bidIncrement` silently concatenated — `"100" + "1.00"` became `"1001.00"`, and the minimum-bid check then compared against a nonsense value. Every read of `current_price`, `bid_increment`, and `max_amount` now goes through the `num()` helper at the top of `routes/bids.ts`.
- **Backend port pinned:** `dev` is `PORT=3001 tsx watch src/index.ts` to match the three Vite proxy targets (`/api`, `/uploads`, and the `ws://` upgrade for `/ws`). `index.ts` defaults to 3000 without `PORT`, which would break all three at once.
- **Lock release made safe:** `releaseLock` uses a Lua compare-and-delete against the stored lock value rather than a bare `DEL`, so a process whose lock already expired cannot delete a lock another request has since acquired.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. The Redis lock rejects with 429 rather than queuing. Bidders in a closing burst therefore fail rather than wait. Is a short bounded wait (say 250ms with jitter) better UX, or does queuing just reintroduce the connection-pool pressure the lock exists to prevent?
2. `auction_endings` is authoritative and lives only in Redis, with no rebuild-on-boot. Should the scheduler reconcile against `SELECT id, end_time FROM auctions WHERE status='active'` at startup — and if so, has the sorted set actually bought anything over just polling that query?
3. Snipe protection has no cap, so a contested auction can be extended indefinitely. Is a maximum total extension the right guard, or a decaying window (each extension shorter than the last)?
4. The scheduler runs inside every API instance. With multiple instances, closes race and duplicate notification work happens even though `WHERE status='active'` prevents double-closing. Should closing move behind the same distributed lock the bid path uses, or out to a single dedicated worker process?

## Resources

- [Redis: distributed locks (Redlock)](https://redis.io/docs/latest/develop/use-cases/patterns/distributed-locks/) — including why single-instance `SET NX` + Lua release is honest about its guarantees
- [PostgreSQL: explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) — `SELECT … FOR UPDATE` semantics
- [PostgreSQL: transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — what read-committed does and doesn't protect a bid from
- [Stripe: designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — the structure behind `auction_endings`
