# Webhook Platform - Development with Claude

## Project Context

**Prompt.** Design a webhook platform: customers register callback URLs, the platform sends them HTTP notifications when events occur, retries failed deliveries, keeps delivery history and supports manual replay ([ROADMAP entry 6](../ROADMAP.md#6-webhook-platform)).

**Signal.** OpenAI, community attribution. It is not verified, and the team, date and round are unknown. The payment-system and stripe projects deliver webhooks as one component; here delivery is the whole product.

**The trap** named in the roadmap is claiming exactly-once delivery because a queue is involved. The docs and the code never do: the contract is at-least-once, with a stable `Webhook-Id` for receiver-side dedupe, and the e2e suite demonstrates both lost-ack paths (a receiver that drops the acknowledgment, and a worker killed mid-request).

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed when it ran, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Default port | Entry point | Notes |
|---------|--------------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Intake, console API, operator overview, receiver proxy; `dev:server1/2` add 3001/3002 |
| Outbox publisher | 3100 (metrics) | `backend/src/publisher/index.ts` | `LISTEN/NOTIFY` wake-up plus a 1 s poll; confirm channel; supervised reconnect |
| Delivery workers | 3101, 3102 (metrics) | `backend/src/worker/index.ts` | `WORKER_ID`, `WORKER_PORT`, `WORKER_CONCURRENCY` (prefetch) |
| Retry scheduler | 3103 (metrics) | `backend/src/scheduler/index.ts` | Fair dispatch, lease reclaim, stuck-queued sweep, outbox prune |
| Mock receiver | 3300 | `backend/src/receiver/index.ts` | `/hooks/:name`, fault toggles, `/_control/*` |
| Frontend | 5173 | `frontend/` | `VITE_PORT`, `API_TARGET` |
| PostgreSQL 16 | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| RabbitMQ 3.13 | 5672 / 15672 | — | One quorum queue `deliveries` plus `deliveries.poison` |
| Valkey 7 | 6379 | — | Sessions, login rate limit, per-endpoint semaphores; named `redis` in compose for the repo scripts |

Every host port in `docker-compose.yml` is overridable (`WEBHOOK_PG_PORT`, `WEBHOOK_AMQP_PORT`, `WEBHOOK_AMQP_MGMT_PORT`, `WEBHOOK_VALKEY_PORT`).

## Development Phases

1. **Pure domain first, with tests before any I/O.**
   - `signing.ts`: HMAC, rotation overlap, replay window.
   - `ssrf.ts`: IPv4/IPv6 ranges, wrapper unwrapping, WHATWG normalisation, allowlist.
   - `backoff.ts` and `classify.ts`: full jitter, Retry-After, the outcome decision.
   - `filter.ts`, and `sender.ts` against a local server (redirects, timeouts, dropped sockets, IP pinning).

   54 tests passed on the first run.
2. **Schema and services.**
   - The emit transaction: advisory lock, request hash, sequences, fan-out, outbox.
   - The publisher with per-row marks.
   - The worker: conditional claim, lease token, semaphore, park, record.
   - The scheduler: lateral per-endpoint dispatch.
   - The mock receiver, with a unit-tested state module.
3. **Live stack and a scripted end-to-end suite** (scratch, not committed): 16 sections and 80 checks against the real processes. Iterated until green; the repair log below is mostly what that run found.
4. **Frontend:**
   - endpoints with health;
   - endpoint detail (filter, limits, secret rotation, replay, delivery log);
   - delivery attempt timeline;
   - event log with a "retry with the same key" button;
   - mock receiver toggles and log;
   - notifications and an operator page.

   All of it polls (no SSE), so the screenshot harness doesn't stall on `networkidle`.
5. **Demo scripts** (`demo:story`, `demo:load`), screenshots, smoke tests, docs. The frontend and full-stack interview answers were written in parallel by subagents from architecture.md and the code, then checked against the no-code and length rules.

## Key Implementation Decisions (and why)

- **Tickets are pointers (`{deliveryId, dispatchSeq}`), claimed with a conditional UPDATE.** One mechanism absorbs outbox republishes, stale tickets after a replay or reschedule, and RabbitMQ redeliveries after a crash. A redelivered ticket may take over an `in_flight` row because the broker only redelivers after the previous consumer's channel closed; the lease token fences the old worker's write (`superseded`).
- **Parking instead of requeueing or waiting.** A worker that can't get an endpoint slot writes `scheduled, now() + ~300 ms` and acks. The scheduler's dispatch query counts `queued + in_flight` per endpoint and only tops it up to the limit, so parking stays rare after the first burst.
- **Probe mode as an effective limit of 1** after 5 consecutive failures, instead of a separate circuit-breaker state machine. It is simple to explain and does the same job.
- **429 pauses the whole endpoint** (`paused_until`), not just the delivery: the receiver asked us to slow down.
- **Only transient failures and 410 count toward the failure streak.** A 400 means the endpoint is up and answering, so it neither probes nor disables.
- **The receiver acknowledges duplicates with 200.** That is what a correct consumer does, and it lets the platform stop retrying.
- **The mock receiver fetches its secrets from an internal endpoint** (`X-Internal-Token`), standing in for a customer pasting the secret into their config. `pinnedSecrets` simulates a receiver that missed a rotation.
- **The receiver proxy filters by the caller's endpoint paths.** Both demo orgs share one receiver process, so the proxy is where org isolation is enforced for that page.
- **ULIDs with prefixes** (`evt_`, `dlv_`, `ep_`): time-ordered index inserts, and an id you can paste and recognise.
- **No TanStack Query and no SSE.** A `usePoll` hook (1.5-3 s, paused when the tab is hidden) is all the console needs, and every refetch goes through the same org-scoped endpoints.

## Deviations from Repo Defaults

| Default | Here | Why |
|---------|------|-----|
| `postgres:16`, `rabbitmq:3.13-management` images | `postgres:16-alpine`, `rabbitmq:3-management` (3.13.7) | The named tags were still pulling after 3 minutes on the build machine; these were already local and are the same major versions |
| SSE for live UI | Polling | Delivery state changes on the order of seconds; avoids the screenshot harness's `networkidle` wait |
| Retry timing in hours and days | Seconds (`RETRY_*` env vars) | The full retry → exhausted → disabled story plays out in minutes |

## Iteration & Repair Log

Found by running the stack, in order:

1. **Signal handlers never registered** in the publisher and scheduler: `process.on('SIGTERM')` sat after an infinite top-level `while` loop. Moved above the loop (caught before the first run, while reading the code back).
2. **The lost attempt was attributed to the new worker.** The claim's `RETURNING d.*` returns the *new* `claimed_by`, so "worker-1 stopped…" was logged with worker-1 as both the dead worker and the taker. The claim now reads the previous owner and claim time in a `FOR UPDATE` CTE.
3. **The isolation check measured the wrong thing.** DB `in_flight` rows briefly peaked at 5 for a limit of 4, because a delivery is claimed before it tries for a slot and is parked a moment later. HTTP concurrency (semaphore slots) never exceeded 4. The receiver now counts concurrent open requests per path, and the check uses that: what the customer actually feels.
4. **The retry window was measured from event creation.** The laptop slept for two minutes mid-demo. The first attempt after waking was already past the 45 s deadline, so one connection reset "exhausted" the delivery and disabled a healthy endpoint. The window now opens at the first attempt (and again at the first attempt after a replay). Unit-tested in `classify.test.ts`.
5. **Host/VM clock skew shifted retries.** After sleeps the Docker VM clock lagged the host by 1.5-3 s. Workers wrote `next_attempt_at` from the host clock, the scheduler compared it with the database's `now()`, and every 429 retry ran 3 s late. Workers now only decide a delay; the database writes `now() + delay`. Attempt timestamps use a per-attempt offset to the DB clock read at claim time, so every persisted timestamp shares one clock.
6. **Broker connections didn't survive a sleep.** After the laptop slept past two heartbeats, every AMQP connection died ("Heartbeat timeout") and delivery stopped silently. `superviseRabbit` (`shared/queue.ts`) now reconnects with backoff and re-registers the consumer. A new e2e section stops RabbitMQ mid-run: intake keeps accepting into the outbox, and both processes reconnect and drain.
7. **Emit responses listed deliveries in a different order on replay.** ULIDs from the same millisecond aren't monotonic. Sorted by id in both paths.
8. **Write cost was 8.0 row writes per delivery.** Every emit updated `api_keys.last_used_at`, and every success rewrote the endpoint health row even when nothing changed. Both are now conditional (at most once a minute; only when the streak or freshness changes). Measured afterwards: 6.6.
9. **Test bugs, not product bugs**, kept here because they look like product bugs at first:
   - the ordering test armed two 500s, which hit both events;
   - the bulk-replay test took `since` from the host clock while `created_at` comes from the database.

## Open Questions

- **"Retry waiting now" after recovery.** With a 6 h backoff cap, an endpoint that recovers mid-outage may wait hours for its scheduled deliveries. Options: a console action, or shrinking pending delays after the first success in probe mode.
- **Strict FIFO as an opt-in per endpoint** (concurrency 1, block on failure) for customers who insist, with the cost stated in the UI.
- **CDC (Debezium) instead of the polling publisher** at high volume; it removes the outbox mark write.
- **A "ready endpoints" sorted set** instead of the scheduler scanning every active endpoint each tick.
- **IPv6-only receivers.** The sender prefers an IPv4 address when a name has both; production should honour Happy Eyeballs while still vetting every address.
- **Signature versioning.** `v1` is HMAC. A `v2` with asymmetric signatures (Ed25519) would let receivers verify without holding a shared secret.
- **Per-org emit rate limits and per-org retry policies** (shorter horizons for low-value events).
- **Retention:** daily partitions for events, deliveries and attempts, and archival of attempts beyond 30 days.

## Verification Environment Notes

- **Ports used here:**
  - PostgreSQL 5462, RabbitMQ 5682/15682, Valkey 6409;
  - APIs 3030/3031, publisher 3130, workers 3131/3132, scheduler 3133;
  - mock receiver 3040 (`RECEIVER_PORT=3040`; the SSRF allowlist default follows it), frontend 5176 proxied to 3031.

  The defaults follow the repo conventions; everything is overridable by env var.
- **Stop processes by port, never by name:** `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`. Other projects run the same entry paths.
- **The build machine was a laptop on battery in Low Power Mode with frequent DarkWake/Deep Idle cycles.** Every process paused for 1-7 s about once a minute, and the machine slept for minutes at a time even with a keep-awake hold. The e2e script detects host stalls and excludes stalled samples from latency assertions, and extends waits by stalled time. Purely timing checks may rerun at most twice and say so; correctness checks never rerun. These pauses are also how defects 4-6 above were found.
- **E2E result:** 16 sections, 80 checks, run against the live stack with a 20 s retry window. The final fresh run passed **80/80** with no timing reruns, despite a 775 s machine sleep mid-run. The run before it passed 78; its two isolation-latency checks had every sample inside a 407 s sleep and passed when that section was rerun alone. Final isolation numbers: Acme p50 12 → 11 ms and p90 19 → 13 ms while Globex's endpoint hung; receiver peak 4 concurrent requests.
- **Write cost** was measured with `pg_stat_database` deltas, read about 12 s after the batch: PostgreSQL 16 flushes per-backend stats lazily, so reading sooner undercounts badly.
- **`demo:load` result:** Acme p50 19 → 18 ms, p95 24 → 22 ms while globex-main hung; globex-main at 4/4 slots, then probing at 1/1, with its backlog waiting in PostgreSQL and 0 messages ready in the queue.
- **Screenshots:**
  - Taken with `SCREENSHOT_FRONTEND_PORT=5176 node scripts/screenshots.mjs webhook-platform` (no `--start`) after `npm run demo:story`.
  - `10-ops.png` comes from a second pass taken while `npm run demo:load -- --keep-down` was running.
  - The script's "Login error banner" warning is a false positive: it treats any `.bg-red-50` or `.text-red-700` element as a login error, and the red "Disabled" chip matches.
- **Smoke tests:** the repo root has `playwright` 1.57 but not `@playwright/test`, and its Chromium revision isn't installed (WebKit is, which the screenshot script uses). The generated tests were run with a scratch shim re-exporting `playwright/test` via `NODE_PATH`, with `--browser=webkit`, `SMOKE_BASE_URL=http://localhost:5176` and `SKIP_WEBSERVER=1`.
