# LLM Inference API - Development with Claude

## Project Context

**Prompt.** Design a multi-tenant developer API that exposes a model: request submission, streamed or asynchronous output, cancellation, usage accounting and overload handling. ROADMAP #5.

**Signal.** Several Anthropic candidate reports (self-reported, not verified):

- an API-focused exercise on sampling, batching and request orchestration;
- a batching round: one accelerator that processes up to 100 inputs at a time, treated here as an exercise assumption and not a real serving limit;
- a routing round with sticky assignment.

**The trap**, per the roadmap, is treating this as CRUD, or diving into GPU internals before establishing the product contract. The build and the answers therefore start from the contract (modes, ownership, error types) and bring in model internals only where they change a decision: prefix caching justifies affinity, and iteration-level batching changes what a batch is.

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed, and what's open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| Gateway | 3000 | `backend/src/gateway/index.ts` | Public API (API keys), console and admin API (sessions); `dev:server1` adds 3001 |
| Dispatcher | 3100 (health/metrics) | `backend/src/dispatcher/index.ts` | Leader lease; `dev:dispatcher2` runs a standby on 3110 |
| Mock backends | 3101-3103 | `backend/src/backend/index.ts` | `BACKEND_ID`, `BACKEND_PORT`, `BACKEND_SLOTS`, `BACKEND_BATCHING=static` |
| Load generator | — | `backend/src/load/index.ts` | `npm run load -- --phases low,high,capacity` |
| Frontend | 5173 | `frontend/` | `VITE_PORT`, `API_TARGET` |
| PostgreSQL 16 / Valkey 7 | 5432 / 6379 | `docker-compose.yml` | `INFERENCE_PG_PORT`, `INFERENCE_VALKEY_PORT` override host ports |

## Development Phases

1. **Pure cores first, with tests before any I/O.**
   - The mock engine: slots, continuous vs static batching, prefix cache, drain/upgrade, chaos armed as counts. It is driven by `admit(now)` and `step(now)`, so tests use a fake clock.
   - The router: ring, bounded load, membership change.
   - The fairness picker (DRR by cost), the batch policy and class capacity, the token bucket math, the state machine table.
2. **Valkey scripts.** `ADMIT` (pre-check and real run), `REFUND`, `CLAIM`, `REQUEUE`, `UNQUEUE`, `RENEW`, all in `shared/cache.ts`.
3. **Gateway.** Principal resolution, submit (estimate → pre-check → insert → admit), the three response modes, the multiplexed event-log reader, cancel.
4. **Dispatcher.** Tick loop, executor (route → record → send group → NDJSON relay → guarded transitions), sweeps, leader lease.
5. **Live end-to-end script** against the real stack (84 checks). Then iterate on what it found (repair log below).
6. **Load generator, frontend** (developer console, request page, admin console, routing page), screenshots, smoke tests.
7. **Docs.** Architecture, three answers, this file, README.

## Key Implementation Decisions (and why)

- **`queued` includes "sent to a replica, still prefilling"; `running` starts at the first token.** This puts the "can it still move?" rule into the state machine itself. A refused, rejected or crashed group re-queues anything still `queued`; anything `running` fails. There is no extra "dispatched" state to keep in sync.
- **The first token is published only after the `queued → running` UPDATE commits.** Otherwise a cancel that won could still show the client a token. The cost is a few milliseconds of TTFT.
- **The pre-check runs the same Lua as admission, in dry-run mode.** Most rejections cost one Valkey call and no PostgreSQL write. The real run, after the insert, is the authority; a disagreement marks the row `failed`.
- **Refund exactly once, keyed on the usage insert** (`ON CONFLICT DO NOTHING`, refund only if a row was inserted). Several components can try to finalize a request: the gateway for a queued cancel, the dispatcher for everything else, and the sweeps.
- **The canceller learns from `UNQUEUE` whether it owns the cleanup.** 1 means it was still queued, so refund in full here. 0 means the dispatcher holds it, so publish a cancel and let the dispatcher bill what was generated.
- **Per-request event logs as Valkey streams, read by one blocking `XREAD` per gateway** across all its waiting requests, interrupted by `CLIENT UNBLOCK` when a subscription is added. Pub/sub would lose events published before a late attach; one connection per stream would not scale.
- **Admission groups at the dispatcher, continuous batching in the replica.** The mock charges `admitOverheadMs` of decode stall per admitted group. That is the honest reason to batch at the dispatcher at all, and it is documented next to the batch-fill panel.
- **Bulk lane min share 25% and max share 50%.** The max share was added after the first fairness run. With bulk allowed every free slot, a sync request arriving during a bulk flood waited for a bulk generation to finish.
- **Interactive queue bound 48.** It is smaller than the sum of the three big tenants' shares (24 + 24 + 12), so a 529 is reachable without any single tenant being at its own limit.
- **The console acts through the user's API keys** (`principalForMember`), through the same `submit()` as `/v1`. No console fast path.
- **Mock-only knob `metadata.mock_output_tokens`.** Tests and the load generator need predictable output lengths. It sits in `metadata` so the request shape stays Messages-API compatible.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| RabbitMQ / Kafka for queues | Valkey lists + sorted sets + Lua | Admission must charge the bucket and enqueue atomically; queues are small and hot |
| Opossum circuit breakers | Router cooldown on 529, refusal or unreachable, plus re-queue | Backend refusals are routing hints, not failures to trip on; the replica decides its own admission |
| TanStack Query | Zustand store for the run, a small `usePoll` hook for snapshots | The run is written by an async stream loop; the admin view is one aggregate |
| `postgres:16` image | `postgres:16-alpine` | Already cached locally; identical behaviour |

## Iteration & Repair Log

Bugs and corrections found by running the stack:

1. **The router used stale health reports and spilled affinity.** `inUse = max(local in-flight, reported)` kept an idle replica looking busy for up to one 500 ms poll after a burst, so a prefix's first request went to a neighbour, a cache miss. The live affinity and crash checks failed intermittently. Fix: trust the local count, and use the report only when taken after the last local release (`dispatcher/backends.ts`, unit-tested).
2. **Ring imbalance.** FNV-1a + an avalanche step on labels like `b1#0…b1#99` gave the three replicas 25/36/39% of the key space. Switched point and key hashing to SHA-256 with 160 virtual nodes, now within a few points of a third each; a test asserts ±4%.
3. **The load generator imported the seed module**, whose top level runs the seed (truncating every table). Caught before the first run: fixtures moved to `db/fixtures.ts`.
4. **Refunds hid the free tier's limit in the load test.** Initech reserved 1,250 tokens per request but used ~130, so refunds kept the bucket nearly full. The load generator now asks Initech for long outputs, so its 429s come from real usage.
5. **No 529 under load at first.** The interactive bound (60) equalled the sum of the heavy tenants' shares, so every tenant hit its own 429 first. The bound is now 48.
6. **Bulk crowding out interactive.** Added `batchMaxShare` (see decisions).
7. **The screenshot harness reported "Login error banner: failed".** It matched the red `failed` status chip in the history table (`.bg-red-50`). The chip now uses rose tones; nothing was wrong with login.
8. **Seeded example rows were invisible to alice.** The seeded failed and cancelled requests belonged to Umbrella. They were moved to Acme's key, and the failed row's message now names the backend it ran on.
9. **API key order in the picker was nondeterministic** (same `created_at` within the seed transaction). Ordered by `created_at, name`.

## Open Questions

- **Gateway crash leaves sync and stream requests running.** The process that would detect the disconnect is gone. A heartbeat per open connection (gateway → dispatcher) would let the dispatcher cancel orphans.
- **Adaptive max wait**: shorter when the queue is empty, longer when a batch is close to full. Currently a fixed runtime knob per lane.
- **Pricing cached input.** The bucket charges cached input tokens like any others; a real API discounts them, which changes the reservation math.
- **Cells and tenant homing.** One dispatcher per cell, with tenants homed by bounded-load hashing at the edge, is designed but not built.
- **Chunked prefill.** The mock stalls decode per admitted group. Chunked prefill would trade that stall for slower decode steps and change the dispatcher's best batch size.
- **Per-key limits** (in addition to per-org) and spend caps.

## Verification Environment Notes

- **Verified on alternate ports** while other projects ran: PostgreSQL 5452, Valkey 6399 (`INFERENCE_PG_PORT`, `INFERENCE_VALKEY_PORT`), gateways 3020/3021, dispatcher 3120, backends 3121-3123 (`BACKEND_URLS=b1=http://localhost:3121,…`), frontend 5175 (`VITE_PORT=5175 API_TARGET=http://localhost:3020`).
- **Live end-to-end checks**: 84, all passing on a fresh seed:
  - sync, stream and async with usage rows; 429 vs 529;
  - fairness; disconnect vs survive; the cancel race (24 runs, both outcomes);
  - batch triggers; cache hits; drain and rollout; mid-stream crash with re-route; console and admin.

  The script lives outside the repo (a scratch file). The scenarios are listed in README "Things to try".
- **Unit tests**: 66, plus 2 PostgreSQL race tests that run when `TEST_DATABASE_URL` is set.
- **Screenshots**: taken with `SCREENSHOT_FRONTEND_PORT=5175 node scripts/screenshots.mjs llm-inference-api` while `npm run load` drove traffic, so the admin screens show live queues and batches.
- **System sleep breaks timing checks.** On battery, macOS enters Maintenance Sleep even while tests run. One full run failed a single check because the machine slept from 15:35:31 to 15:37:48 right after the test aborted a sync request. Every process froze; on wake, the 120 s sync timer and the socket-close callback fired in the same tick, and the timer's cancel won (`cancel_reason = sync_timeout`). Check `pmset -g log` before chasing a one-off timing failure, and run long suites under `caffeinate -im`.
- **Stopping services**: stop by port (`lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`); killing an `npx tsx` PID leaves the node listener running.
- **Reseeding**: `npm run db:seed` truncates everything and deletes `inf:*` keys. Restart the dispatcher after a reseed, since its in-memory fairness credit and flights refer to the old data.
