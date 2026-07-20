# Notification System — Development with Claude

## Project Context

A notification system is mostly a routing and fan-out problem wearing a delivery costume. The hard parts aren't "call the push provider" — they're deciding *whether* to send at all (preferences, dedup, rate limits), *when* (priority), and *what happens when the provider fails* (retries, dead-lettering) — all while a burst of a million campaign notifications must not delay the one password-reset email someone is staring at.

That last constraint is what shapes the whole design: priority can't be a field you sort by, because a single queue with a million low-priority messages in front means the critical one waits regardless of its priority value. It has to be a separate queue with its own consumers.

**Learning goals:** priority-based queue processing, multi-channel routing, at-least-once delivery with retries and dead-letter handling, and honoring user preferences without putting a database read on the hot path.

## Architecture at a Glance (what actually runs)

| Component | Role |
|-----------|------|
| **API server** (`src/index.ts`, port **3001**) | Accepts notification requests, validates, checks preferences/dedup/rate limits, enqueues |
| **Workers** (`src/workers/index.ts`) | Consume per-channel/per-priority queues and invoke the (simulated) providers |
| **RabbitMQ** | **13 queues**: `{push,email,sms} × {critical,high,normal,low}` plus one shared `notifications.dead_letter` |
| **PostgreSQL** | `notifications`, `delivery_status`, `notification_events`, `notification_preferences`, `device_tokens`, `notification_templates`, `campaigns`, `campaign_stats`, `users`, `sessions` |
| **Redis** | Preference cache (5-min TTL), rate-limit counters, dedup keys, session cache |

Services in `src/services/`: `notifications.ts` (orchestration), `preferences.ts` (cached per-user channel prefs), `rateLimiter.ts` (per-user + global), `delivery.ts` (dedup window + provider dispatch), `templates.ts`. Cross-cutting utilities in `src/utils/`: `rabbitmq.ts`, `redis.ts`, `database.ts`, `circuitBreaker.ts` (breakers for push/email/sms), `metrics.ts`, `logger.ts`. Frontend is a React dashboard ("NotifyHub") over notifications, preferences, templates, campaigns, and an admin view.

Push/email/SMS providers are **simulated** with randomized success rates — which is the point: it exercises the retry and dead-letter paths on every run, something real providers would only do occasionally.

## Key Design Decisions

### 1. A queue per channel *and* per priority (13 queues), not one queue with a priority field
Priority as a sort key inside one queue doesn't survive contact with a campaign: a million queued marketing pushes sit ahead of the password-reset email, and no amount of "priority: critical" moves it forward — the consumer still has to work through what's already in flight. Separate queues let critical consumers stay idle and instantly available, and let us scale workers per channel independently (SMS is rate-limited and expensive; push is cheap and high-volume — they should never share a worker pool). What we give up is a combinatorial queue count: 3 channels × 4 priorities is already 13 queues to declare, monitor, and alarm on, and adding a channel adds four more. At a larger channel count this stops being manageable and would push toward RabbitMQ priority queues or a partitioned log.

### 2. At-least-once, with idempotency pushed to the consumer
Delivery is at-least-once: on failure we retry with exponential backoff, and after 3 attempts the message is dead-lettered. Exactly-once across an external provider isn't achievable anyway — the provider can succeed and the ack can still be lost, and there's no distributed transaction spanning "RabbitMQ ack" and "APNs accepted". So we chose the failure mode we can live with: a duplicate notification is a minor annoyance, a *missing* password reset is a support ticket. `delivery.ts` narrows the window with a Redis dedup key, but the real contract is that consumers must tolerate duplicates.

### 3. Preferences cached in Redis with a 5-minute TTL
Every notification needs a preference check, so an uncached design puts a Postgres read in front of every single send — the database becomes the throughput ceiling for a system whose whole job is volume. The 5-minute TTL means a user who disables notifications can still receive one for up to five minutes. That's the explicit trade: bounded, short-lived staleness in exchange for taking the database off the hot path. It's acceptable here because the failure is one late notification, not a privacy violation — for a hard opt-out (legal/compliance), this cache would need write-through invalidation on preference update.

### 4. The dead-letter queue must be declared *without* its own dead-letter exchange
This was a real bug, not a hypothetical. The queue list was iterated uniformly and every queue — including `notifications.dead_letter` — was declared with `x-dead-letter-exchange` arguments pointing at the dead-letter queue. RabbitMQ then saw the same queue declared with two different argument sets and returned **406 PRECONDITION_FAILED**, which killed the channel and, because nothing handled the error event, took down the whole API process. The fix is ordering plus an exclusion: declare `DEAD_LETTER` first with no DLX arguments, then declare the 12 work queues dead-lettering into it, skipping `DEAD_LETTER` in the loop. A dead-letter queue that dead-letters into itself is a cycle; it has to be the terminus.

### 5. The API binds its port before RabbitMQ finishes connecting
RabbitMQ is slow to become available and is only needed for *delivery* — login and reads don't touch it. Initializing it before `app.listen()` meant the API was unreachable for the entire broker startup, and any broker failure prevented the server from ever serving traffic. Now the port binds first and `initRabbitMQ()` runs in the background, logging a warning on failure ("delivery degraded") rather than aborting startup. Connection and channel `error` handlers were added for the same reason: a non-critical subsystem should not be able to crash the process. The trade-off is that enqueue attempts made during that window fail — acceptable, because the alternative was total unavailability.

## Current State

Runs end to end: API on 3001 (Vite proxies `/api` → 3001), workers consuming all 12 work queues, priority/channel routing, preference caching, per-user and global rate limiting, dedup windows, retry with exponential backoff, dead-letter handling, circuit breakers per channel (push/email/sms, states exposed on `/health`), Prometheus metrics, structured logging with request IDs, liveness (`/health/live`) and readiness (`/health/ready`) probes, and the NotifyHub React dashboard. Seed users: `admin@example.com` (admin), plus `john@`, `jane@`, `bob@example.com`.

**Auth is demo-grade on purpose:** `POST /api/v1/auth/login` looks the user up by email and accepts any password, then issues a UUID session token stored in Postgres and cached in Redis. This project is about delivery mechanics, not authentication.

Not implemented: in-app notifications over WebSocket, open/click tracking beyond basic event rows, and alerting.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md — which listed "Circuit breakers" as unbuilt under Phase 3 while `utils/circuitBreaker.ts` was in use and reporting state on `/health` — with this structure. Added the 13-queue rationale and the DLQ/startup bugs the old file predated.
- **RabbitMQ 406 PRECONDITION_FAILED (fixed):** dead-letter queue declared with conflicting arguments crashed the API at startup; see decision 4. Added `connection.on('error')` / `channel.on('error')` handlers so a broker problem degrades delivery instead of killing the process.
- **Startup ordering (fixed):** `app.listen()` now precedes `initRabbitMQ()`; see decision 5.
- **Harness false negative (repo-wide fix, surfaced here):** the verification detector grepped for the literal string "Login error", which matched the harness's own diagnostic line `Login error message: 0` (meaning *zero* error banners found) — so a successful login was reported as a failure. The harness now only reports an error banner when the text is prose-like, and logs a single unambiguous verdict. Verified: login=OK, 5/5 screens captured.
- **Backend port resolution (repo-wide):** the harness previously waited for port 3000 while this backend binds 3001, so it drove the browser before the API was ready and login surfaced as "Request failed". `scripts/screenshots.mjs` now derives the port from config → `PORT=` in the `dev` script → the Vite proxy target → 3000.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. 13 queues for 3 channels × 4 priorities is already awkward. At what channel count does this flip to being better served by RabbitMQ priority queues (one queue, `x-max-priority`) despite the head-of-line risk?
2. The 5-minute preference TTL is a guess. Should preference *writes* invalidate the cache key directly, making the TTL a backstop rather than the mechanism?
3. Dead-lettered messages currently just accumulate — what's the right operator workflow: automatic replay after provider recovery, or manual inspection first?
4. Campaign sends and transactional sends share the same worker pool per channel. Should campaigns get dedicated workers so a large campaign can't consume the normal-priority consumers a transactional send also uses?

## Resources

- [RabbitMQ dead letter exchanges](https://www.rabbitmq.com/dlx.html) — the semantics behind decision 4
- [RabbitMQ priority queues](https://www.rabbitmq.com/priority.html) — the alternative to queue-per-priority
- [APNs documentation](https://developer.apple.com/documentation/usernotifications)
- [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging)
- [SendGrid API](https://docs.sendgrid.com/)
