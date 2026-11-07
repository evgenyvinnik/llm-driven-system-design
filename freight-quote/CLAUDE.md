# Freight Quote Service - Development with Claude

## Project Context

**Prompt (ROADMAP #22).** Shippers request price quotes for moving freight (origin, destination, commodity, car type, volume). A quote depends on slow internal services: tariff and contract pricing, network capacity, fuel surcharge and car availability. Traffic is heavy, from portals and from API integrations that re-quote often. Design the endpoint so it stays fast and correct while dependencies are slow.

**Signals, as reported and not verified:**

- **BNSF candidate report**: a high-traffic quote endpoint whose dependent services are slow, and what architecture would improve service quality. Self-reported; team, date and round unknown.
- **A curated PracHub account of a September 2026 screen**: the candidate was first asked to *implement the service-layer logic* of a freight rate inquiry endpoint, then the discussion moved to heavy traffic and downstream latency. That is why this project has a coding exercise ([coding-exercise.md](./coding-exercise.md)) as well as the design docs.

Nothing in this project comes from BNSF data. Stations are real city names used illustratively; every rate, mileage, customer, contract, volume and latency is an assumption. The only public figures cited (route miles, fleet size) come from the BNSF FY2025 10-K via the ROADMAP's rail section.

The design is in [architecture.md](./architecture.md) and the event catalog in [events.md](./events.md). This file records how the project was built, the choices that aren't obvious from the code, and what's open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| Quote API | 3000 (`dev:server1/2` → 3001/3002) | `backend/src/api/index.ts` | Fan-out, breakers, admission, idempotency, outbox relay (advisory-lock leader), ops snapshots |
| Mock dependencies | 3010 | `backend/src/deps/index.ts` | Four routes, knobs per dependency, pricing admin emits pricing events |
| Completer | 3011 (metrics) | `backend/src/completer/index.ts` | Groups `completer`, `webhooks`, `invalidator`; expiry sweeper; webhook dispatcher |
| Projector | 3012 (metrics) | `backend/src/projector/index.ts` | Group `projector`, analytics tables |
| Webhook receiver | 3020 | `backend/src/receiver/index.ts` | The customer's side |
| Frontend | 5173 | `frontend/` | `VITE_PORT` and `API_URL` override |
| PostgreSQL 16 / Valkey 7 | 5432 / 6379 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |

## Development Phases

1. **Domain and contracts first.** Reference data, price components, the event schemas with a v1 → v2 upcaster, and the pure composer (firm vs indicative), all unit-tested before any I/O.
2. **The quote path.** Deadline-aware dependency client with `X-Deadline`, breakers (opossum), single-flight, hedging with a token-bucket budget, the versioned component cache with Lua floor checks, admission by client class, per-customer token buckets, idempotent submit.
3. **Mock dependencies** with latency, tail, error, hang, worker-pool and outage knobs, deterministic answers per 5-minute bucket, and deadline handling that counts abandoned vs wasted work.
4. **The event-driven side.** Outbox table with per-stream versions and an append-only trigger, relay, consumer framework (ack after commit, XPENDING + XCLAIM with exponential backoff, heartbeats, DLQ, per-group redrive), completer, invalidator, expiry, webhooks with signatures, projector with replay.
5. **Coding exercise.** Types, stub, reference solution, a 19-test suite, `practice` and `practice:reset`. A mutation pass (contract-blind key, customer key, remembered failures, unscoped keys, no abort) confirmed each mistake fails at least one test.
6. **Frontend.** Portal, quote detail with timeline, ops console, event log, streams/DLQ, analytics.
7. **Load script and verification.** Hedging, coalescing and retry-storm scenarios; every event-driven flow exercised with curl; screenshots inspected and fixed.

## Key Implementation Decisions (and why)

- **"Firm" has one definition, in one pure function** (`shared/compose.ts`). Linehaul and fuel live or at the current version; capacity and car supply live. Everything else is indicative, labeled, and widens the band. A superseded tariff is never served, even as a fallback; no linehaul means 503.
- **Versioned cache entries with floors instead of TTLs.** Each cached value carries a sortable version (`v000007`, `2026-11-02|<published_at>`, a snapshot timestamp). `TariffPublished` raises a floor; a Lua script refuses writes below it, so a slow call can't write an old version back after invalidation.
- **The fuel version includes `published_at`.** Keyed by week alone, a same-week correction never invalidated the cache. `FuelSurchargeChanged` therefore carries `published_at` and both the floor and "current" use the pair.
- **Single-flight outside the breaker, hedging inside it.** Fifty identical requests are one call and one breaker outcome; a hedged call is one logical call to the breaker. A follower races its own deadline so it never waits past it.
- **The coalescing key includes the contract id** (or "tariff") for pricing, the same rule as the cache key.
- **Admission and rate limiting before the idempotency lookup.** Refusing a request never costs a database query. A retried request with the same key may be refused too; its stored result is still there for the next try.
- **Consumers filter by a `type` stream field before parsing** (like a Kafka header). Without it, a poison `QuoteRequested` landed in the `webhooks` DLQ too, a group that never handles that type.
- **Per-group redrive streams** (`fq:redrive:<group>`). Redriving into the shared partition would replay to every group; they'd dedupe, but it hides who the redrive was for.
- **Exponential redelivery from XPENDING + XCLAIM** with a JUSTID heartbeat, rather than XAUTOCLAIM's single idle threshold, so retries back off (1, 2, 4, 8 s) and a slow handler isn't claimed by another consumer.
- **The completer counts attempts across a redrive** (`max(deliveries, firm_attempts + 1)`). A redriven message starts again at delivery 1, and the first version reported "attempt 1" for a quote that had failed five times.
- **The completer processes up to 8 messages at once.** It's order-insensitive (it decides from the quote row), and one slow dependency call shouldn't hold up every other completion. The projector stays sequential; it's fast.
- **The relay holds a PostgreSQL advisory lock** so only one API instance publishes. Two relays with SKIP LOCKED could publish two events of one quote out of order.
- **Analytics deltas are commutative and bucketed by event time**, so replay equals live regardless of delivery order, and `verify` compares only the events the live projector has applied (lag isn't a mismatch).
- **The mock pricing system persists its tariff versions to Valkey.** Restarting it used to roll published tariffs back to v7 while the cache floor said v8.
- **Webhook URLs are registered per customer**, never taken from the request; secrets are derived per customer for development (`shared/webhook-secrets.ts`).
- **Polling, not SSE.** The quote resource is the source of truth; pending lasts seconds. The ops pages poll every 2 s.
- **The practice suite runs against the reference by default** (`npm test` stays green) and against the attempt with `PRACTICE_TARGET=attempt` (`npm run practice`). The stub is committed both as `starter/` (pristine) and `attempt/` (yours); `practice:reset` copies one over the other.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| Kafka / RabbitMQ | Valkey Streams as Kafka | One fewer service; partitions modelled as four streams; Kafka mapping in architecture.md |
| ClickHouse for analytics | PostgreSQL tables | Local scale is tiny; the projection logic is what matters |
| TanStack Query | `usePolling` hook + Zustand for auth | Replace-not-merge semantics in ~40 lines |
| Chart library | Hand-written SVG bar chart | Small bundle; follows the repo's dataviz guidance |

## Iteration & Repair Log

1. **Floating-point hedge budget.** Ten calls at 10% added 0.9999 tokens, so the tenth call couldn't hedge. Tokens are now counted in hundredths.
2. **Fuel corrections didn't invalidate** (see decisions).
3. **Poison messages in uninterested groups' DLQs** (see decisions).
4. **Completer backlog during an outage.** Sequential handling with 5-second budgets left 58 messages of lag after an availability outage; bounded concurrency fixed it.
5. **v1 firm completions counted twice in analytics.** An upcast v1 `QuoteIssued` has reason `unknown`, and both the initial and the firm-completion issue were counted as "issued", so firm quotes exceeded requests. The projector now treats `unknown` with revision 1 as the initial issue. Fixing it was the replay use case: change the projection code, run `npm run replay -- analytics`, same checksum on verify.
6. **Restarted mock pricing rolled tariffs back** (see decisions).
7. **UI fixes from screenshots**: the indicative price block wrapped under the lane text; breaker badges wrapped in narrow cards; the consumer-group table listed every stream on its own line and pushed the DLQ off screen; stacked bar segments under 2 px rendered below the baseline; y-axis ticks weren't round numbers; "1 cars".
8. **A screenshot wait matched the wrong text.** `text=Firm` is a case-insensitive substring match and found "firm price expected"; the wait now uses an exact match.

## Verification Notes

- Verified without Docker: PostgreSQL 16 and redis-server 7.0 started natively on non-default ports, every service configured by environment variables. The docker-compose file was written but not run.
- Flows exercised against the running stack: indicative → firm with a signed callback that failed twice first; a tariff publication re-pricing an open indicative quote; a duplicate pricing event (`duplicate`) and a late older version (`stale`); completer retries exhausting into the DLQ and a redrive completing the quote; a poison message dead-lettered on its first delivery; the completer killed after its commit and before XACK (one `FirmQuoteCompleted`, one webhook after restart); `npm run replay -- analytics` matching the live tables before and after a rebuild.
- Load numbers in architecture.md come from one `npm run load` run on a shared machine.
- Reseeding truncates every table and deletes `fq:*` keys. Consumers recreate their groups (NOGROUP recovery), but restarting the workers after a reseed is cleaner.
- Stop services by PID or port. Other projects use the same entry paths, so never `pkill -f src/api/index.ts`.

## Open Questions / Next Steps

- **Quote reuse for re-quotes.** Return the customer's existing valid firm quote for identical inputs instead of computing a new one. Needs a second idempotency mapping (new key → existing quote).
- **Cross-instance coalescing.** Consistent-hash routing by pricing key, or a short Redis lock with result sharing.
- **Capacity as events.** Lane utilization changes a few times an hour; publishing it would take the slowest dependency off the request path.
- **Contract amendments** as events with their own cache floor.
- **Cancellation propagation for hedge losers.** The mock counts "wasted" work when a cancelled loser keeps running; HTTP/2 or gRPC cancellation would fix it.
- **The booking saga** (car order, capacity slot, waybill) with compensation: where orchestration would replace choreography.
- **A Python version of the practice stub**, in case the screen is taken in Python.
