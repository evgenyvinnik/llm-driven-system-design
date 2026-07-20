# Robinhood — Development with Claude

## Project Context

A brokerage is two systems bolted together with opposite requirements. The market-data side is high-volume, lossy-tolerant, and read-only: twenty symbols ticking every second, fanned out to every connected client, where dropping one tick is invisible because another arrives in a moment. The order side is low-volume, transactional, and unforgiving: a buy that executes twice is a real financial loss, and a position that disagrees with its executions is a reconciliation incident.

Mixing them is the interesting failure. If quote broadcasting shares a code path with order execution, a burst of ticks delays a fill; if order writes block on the quote feed, a market-data outage stops trading. So the two are deliberately separated here: quotes flow through an in-process pub/sub to WebSocket subscribers and out to Kafka for anything else, while orders go through validated Postgres transactions with `FOR UPDATE` on the balance row and an idempotency key guarding the whole operation.

**Learning goals:** WebSocket fan-out with per-client subscription filtering, idempotency as a financial-correctness requirement rather than a nicety, transactional position and buying-power updates, event streaming to decouple portfolio recomputation from the order path, and circuit breakers around a market-data provider you don't control.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`) | **3001** | One `http.Server` carries both Express routes and the `ws` server at `/ws`, so a client needs one connection and one auth token |
| **PostgreSQL 16** | 5432 | Money. `users.buying_power`, `positions`, `orders`, `executions` all need ACID; execution is a single transaction across four tables |
| **Valkey (Redis)** | 6379 | Quote hash (`quote:{symbol}`), the `quote_updates` pub/sub channel, and idempotency records with a 24h TTL |
| **Kafka + Zookeeper** | 9092 / 2181 | Three topics (quotes, orders, trades) so portfolio recomputation and analytics consume events instead of sharing the order transaction |
| **quote-broadcaster** worker | 3010 (health) | Kafka consumer; `dev:quote-broadcaster2` runs a second consumer group on 3012 |
| **portfolio-updater** worker | 3011 (health) | Consumes `trades`, updates portfolio values and cache off the hot path |
| **Frontend** (Vite) | 5173 | Proxies both `/api` → 3001 and `/ws` → `ws://localhost:3001` |

The order path is split across `backend/src/services/order/`: `order-validation.ts` (symbol, quantity, required prices, buying power, share availability), `execution.ts` (`fillOrder` — the transaction), `position-updates.ts`, `limit-orders.ts` (the background matcher), `order-cancellation.ts`, `order-queries.ts`. Market data is `services/quoteService.ts`; `websocket.ts` holds the connection registry. Cross-cutting modules in `backend/src/shared/`: `kafka.ts`, `idempotency.ts`, `circuitBreaker.ts` (Opossum), `audit.ts`, `metrics.ts`, `logger.ts`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind, with `stores/quoteStore.ts` fed by `services/websocket.ts` and `stores/portfolioStore.ts` over REST.

## Key Design Decisions

### 1. WebSocket push with server-side subscription filtering, not polling

Quotes tick once per second in `quoteService.start()`. Clients open one WebSocket, send `subscribe` with a symbol list, and `broadcastQuotes` filters each client's payload to `ws.subscribedSymbols` before sending.

Polling fails here on arithmetic, not on taste. A portfolio screen showing ten symbols that needs sub-second freshness means polling at ~1s intervals; at a thousand concurrent users that's 1,000 requests per second of pure overhead, each paying HTTP parsing, session lookup, and a quote read, to deliver data that changed by a few cents. Push inverts it: one interval tick produces one serialization per *connection*, and clients that aren't watching a symbol don't receive it at all. The filtering matters as much as the push — broadcasting all twenty symbols to every client would make the payload independent of what the user is looking at, which is exactly the waste we're avoiding.

What we give up is connection state. The server now owns a `Map` of authenticated clients and a `Set` of subscriptions per socket, needs a 30-second ping/pong heartbeat to reap sockets that died without a close frame, and — critically — this state is per-process. `sendToUser` can only reach a user connected to *this* instance, so running `dev:server2` and `dev:server3` gives you three disjoint client registries. The Redis `quote_updates` channel and the Kafka `quotes` topic exist to make cross-instance fan-out possible; the WebSocket handler doesn't consume them yet.

### 2. Idempotency keys on order placement, stored in Redis for 24 hours

`shared/idempotency.ts` records each order operation under `idempotency:{key}` with a status (`pending`/`completed`/`failed`) and the result payload; a repeat with the same key returns the stored result instead of re-executing.

The failure this prevents is not hypothetical and not rare. A user taps Buy, the request succeeds server-side, the response is lost to a subway tunnel, the app retries. Without a key, that's two orders, two fills, two positions, and double the buying power consumed — and unlike a duplicate email, there's no apology that undoes it. Doing it with database uniqueness alone would mean a UNIQUE constraint on some natural key of the order, but there *is* no natural key: buying 10 AAPL twice in a minute is a completely legitimate thing a user might mean to do. Only a client-supplied token can distinguish "I meant that twice" from "the network stuttered."

The cost is that correctness now depends on Redis, and Redis here has no persistence guarantee across a restart in this setup. A lost key window means duplicate protection lapses for orders placed in it. The financially safe version would write the key in the same Postgres transaction as the order (as the ticketmaster project does with its `idempotency_keys` table); Redis was chosen for speed and simplicity, and that's the trade.

### 3. Order execution is one transaction across four tables

`fillOrder` opens a transaction and inside it: inserts into `executions`, updates `orders` (filled quantity, average fill price, status), updates `positions` via `updatePositionForBuy`/`ForSell`, and adjusts `users.buying_power`. Validation before it runs uses `SELECT … FOR UPDATE` on both the user row and the position row.

The tempting alternative is to update these incrementally as each step succeeds — it's simpler and each statement is fast. It fails at the first crash. A process that dies after inserting the execution but before decrementing buying power has given a user free shares; die in the other order and they've paid for nothing. There is no compensating action that reliably fixes this after the fact, because the user may have already traded against the wrong balance. `FOR UPDATE` on `users.buying_power` during validation is the other half: without it, two concurrent buy orders both read a balance of $1,000, both conclude a $600 order is affordable, and both commit.

What we give up is concurrency on a single user's row. All of that user's order activity serializes behind their own balance lock — fine, because a user is one person clicking, and pathological only if that same user is also a high-frequency algorithm, which this system isn't for.

### 4. Limit orders are matched by a polling scanner, not an order book

`LimitOrderMatcher` wakes every 2 seconds, selects all orders in `('pending','submitted','partial')` of type limit/stop/stop_limit ordered by `created_at`, and fills the ones whose conditions the current quote satisfies.

This is the deliberate simplification of the project and worth being explicit about, because it's the one place the model diverges from a real venue. A genuine exchange maintains a price-ordered book and matches on every incoming order — bids against asks, price-time priority, real counterparties. Here there is no counterparty: fills come from the simulated quote at the current ask (buys) or bid (sells), so a limit order is really "a trigger evaluated on a timer." That means an order that *should* have filled during a 2-second window where the price dipped through the limit and recovered will not fill, because the scanner only sees the price at wake-up. Real price-time priority is impossible for the same reason: two users with the same limit both fill, since neither is consuming the other's liquidity.

The alternative — a real matching engine — is a genuinely different project (in-memory book, sequencer, deterministic replay). Polling gives a believable UX for portfolio and order-history screens at roughly 200 lines. The cost is that the scan is a full table query every 2 seconds with no index on `(status, order_type)`, which is fine at seed scale and is the first thing that breaks with real order volume.

### 5. Kafka carries derived work; the order path doesn't depend on it

`fillOrder` publishes to the `orders` and `trades` topics — but only `if (isProducerConnected())`, and Kafka init failure at startup logs a warning and continues.

This is the priority ordering the domain demands. Portfolio dashboards, analytics, and notifications are *derived* from trades; they can lag or be rebuilt from the executions table. The trade itself cannot be lost or delayed. So publishing is best-effort and strictly after `COMMIT`: the transaction is the durable record, and the event is a convenience. Putting the publish inside the transaction would be worse in both directions — a broker hiccup would roll back a legitimate fill, and you'd still have no atomicity across two systems anyway.

The honest consequence is that the event stream can miss messages. If the producer disconnects between commit and publish, that trade never reaches `portfolio-updater`, and nothing reconciles it. A production system would use a transactional outbox: write the event to a Postgres table in the same transaction, and have a relay drain it to Kafka. That's the correct fix and it isn't implemented here.

## Current State

Runs end to end with `docker-compose up -d` (Postgres, Valkey, Kafka, Zookeeper) and `npm run dev` (API on 3001). Implemented: session auth, twenty simulated symbols with per-symbol volatility on a random walk, WebSocket quote streaming with subscribe/unsubscribe/subscribe_all and heartbeat, market and limit and stop orders with validation and partial-fill support, the background limit matcher, positions with average cost basis and P&L, buying-power accounting, watchlists, price alerts, order history and cancellation, idempotent placement via `X-Idempotency-Key`, Opossum circuit breakers on the (simulated) market-data fetch and on Redis publishing with last-known-quote fallback, an audit log, Prometheus metrics at `/metrics`, structured pino logging with request IDs, `/health` `/health/ready` `/health/live`, and graceful shutdown. Two Kafka workers (`quote-broadcaster`, `portfolio-updater`) run as separate processes with their own health ports.

Seeded logins: `demo@example.com` / `password123` (starting buying power $25,000, positions in AAPL/GOOGL/MSFT and a five-symbol watchlist) and `admin@example.com` / `password123` ($100,000, admin role).

Simulated or omitted: there is no real market data — `fetchMarketData` is a stub that throws 0.1% of the time purely to exercise the breaker, and all prices come from `simulatePriceMovement`. There is no matching engine or counterparty, no settlement (T+2), no options or crypto, no market-hours enforcement (the simulator ticks at 3am), no PDT or regulatory rules, and no real payment/ACH funding.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template CLAUDE.md, whose "Next Steps" listed **`- [ ] Implement MVP`** and `- [ ] Choose technology stack` as unchecked against a codebase with a full order lifecycle, Kafka workers, and circuit breakers — and whose "Design Decisions Log" and "Resources" sections were literally the placeholder text *"Decisions and their rationale will be documented here."* Phase 3 also claimed monitoring was "Not started" while `/metrics` was serving prom-client output.
- **docker-compose `services:`/`volumes:` malformation (fixed):** the `zookeeper` and `kafka` blocks had ended up nested under the top-level `volumes:` key, so Compose never started a broker and `initKafkaProducer()` always fell into its warning path — event streaming silently disabled with no error a reader would notice. They were moved back under `services:`. Kept (unlike strava, where the identical malformation was resolved by deleting the block) because this backend genuinely uses `kafkajs`: two worker entry points consume from it.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 tsx watch src/index.ts`, matching both proxy targets in `frontend/vite.config.ts` (`/api` and the `/ws` upgrade). The WebSocket proxy is the reason the port can't drift — a mismatched `/api` port shows an error, a mismatched `/ws` port just silently never delivers quotes.
- **Startup banner prints the wrong password:** `index.ts` advertises `Email: demo@example.com / Password: password`, while the seeded bcrypt hash is for **`password123`** (as `db-seed/seed.sql` correctly documents and the screenshot config uses). The banner is the defect.
- **Kafka is non-fatal at startup:** `initKafkaProducer()` is wrapped so a missing broker warns and continues rather than aborting boot, and every publish is guarded by `isProducerConnected()`. Trading works with Kafka down; only the derived workers idle.
- **CI:** the repo-wide smoke-test workflow was removed — a runner can't stand up Postgres, Valkey, and Kafka for these paths. Verification is local (`npm run triage robinhood`).

## Open Questions

1. Kafka publishing happens after `COMMIT` and can be lost. Is a transactional outbox table worth the extra relay process here, or is "portfolio views are eventually consistent and rebuildable from `executions`" a good enough contract for this project?
2. WebSocket client state is per-process, so `sendToUser` can't reach a user on another instance. Should the handler subscribe to the Redis `quote_updates` channel (already published to) and route user-targeted messages through pub/sub, or does that only matter once there's a load balancer?
3. The limit matcher scans all open orders every 2 seconds with no `(status, order_type)` index. At what open-order count does that become the bottleneck — and is the right answer an index, or moving to quote-triggered evaluation (check only orders on the symbol that just ticked)?
4. Buying power is decremented at *validation* using an estimate (`limit_price || ask`), then reconciled at fill time by refunding the difference. Should funds instead be explicitly reserved in a separate column, the way `positions.reserved_quantity` already does for shares? The asymmetry is suspicious.
5. Idempotency records live only in Redis with no persistence guarantee. Is moving them into the order transaction worth losing the fast path, given this is the one guarantee whose failure costs real money?

## Resources

- [kafkajs documentation](https://kafka.js.org/docs/getting-started) — producer/consumer API used by the two workers
- [ws (WebSocket) documentation](https://github.com/websockets/ws) — the heartbeat and `terminate()` pattern in `websocket.ts` comes from its FAQ
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — the breaker plus `.fallback()` behavior around market data
- [Stripe: designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) — `FOR UPDATE` on the balance and position rows
