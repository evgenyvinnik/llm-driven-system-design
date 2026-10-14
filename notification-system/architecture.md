# Notification System — Architecture

## System Overview

A notification system takes "tell this user about this event" from many product services and turns it into a push, an email, an SMS or an in-app message — or into nothing, when the user opted out, is asleep, or already got the same message a minute ago. Calling a provider is the easy part. The hard parts are deciding **whether and when** to send (preferences, quiet hours in the user's own time zone, duplicates, rate limits), keeping **one marketing campaign of a million messages from delaying one password-reset email**, and making retries safe: a provider can accept a message and the acknowledgement can still be lost, so the system has to be built so that **retries never double-send and accepted notifications are never lost**.

This document describes the production design first. [Implementation Notes](#implementation-notes) describes what the local Express + PostgreSQL + Redis + RabbitMQ + React project actually runs.

**Learning goals**

- Transactional outbox instead of writing to the database and the queue separately.
- At-least-once delivery made safe with an idempotent, leased, fenced claim per (notification, channel).
- Priority isolation with separate queues, and retries with a budget and a dead-letter queue.
- Preferences and quiet hours evaluated in the recipient's time zone, without a database read per send.
- Idempotency keys on the accept API.

## Requirements

### Functional requirements

1. **Accept** a notification for a user from an internal service: a template and its data (or raw content), the channels to try, and a priority (`critical`, `high`, `normal`, `low`), optionally scheduled for later.
2. **Decide** per channel: honor channel and category opt-outs, defer non-critical messages until the end of the user's quiet hours, drop duplicates, enforce per-user and per-provider rate limits.
3. **Deliver** through push (APNs, FCM), email and SMS providers, with retries, provider failover and a dead-letter queue.
4. **Track** status per channel — queued, sent, delivered, bounced, failed — including provider delivery receipts, and let callers cancel anything that has not started.
5. **Campaigns**: an operator sends one template to an audience of millions.
6. **Preference center** for users; template, campaign and delivery tooling for operators.

Out of scope: building our own push or SMS transport, A/B testing content, ML send-time optimization.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Accept latency | p99 < 100 ms for `POST /v1/notifications` |
| Durability | A `202 Accepted` notification is never lost |
| Duplicates | At most one provider call per (notification, channel), except when a worker dies between the provider's accept and recording it |
| Critical latency | Accepted → handed to the provider, p99 < 2 s, even during a campaign |
| Normal latency | p99 < 30 s; campaign and digest traffic is throughput-bound, minutes are fine |
| Opt-out freshness | A preference change applies to the next send, everywhere within 5 s |
| Availability | Accept path 99.95%; one provider's outage never blocks other channels |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Notifications | 500M/day → ~5,800/s average; campaign peaks of 1M/min ≈ 17K/s | Accept path scales horizontally; writes are sharded |
| Deliveries | ~1.5 channels each → 750M/day, ~25K/s at peak | Channel workers scale per channel |
| Channel mix | ~70% push, ~25% email, ~5% SMS | SMS is ~5% of volume and most of the cost (~$0.008 each) |
| Preference reads | One per notification → ~17K/s peak | Cache in Redis; a database read per send would be the ceiling |
| Notification rows | ~500 B × 500M/day ≈ 250 GB/day; 30-day history ≈ 7.5 TB | Shard by recipient; age out to cold storage |
| Delivery rows | ~200 B × 750M/day ≈ 150 GB/day | Same shard as their notification |
| Outbox rows | Transient: written and published within seconds, deleted after a day | Small and hot; partial index on unpublished rows |
| Redis | Preferences for ~100M users × ~200 B ≈ 20 GB, plus short-lived keys | Redis Cluster |

"A campaign burst is 17,000 messages a second. If priority were only a sort key in one queue, a password reset arriving behind a million campaign messages would wait about a minute. That number is why critical traffic gets its own queues and its own consumers."

### Local Development Scale

One API process, one worker process, PostgreSQL, Redis (Valkey) and RabbitMQ from Docker Compose, plus the Vite dev server: a handful of users and tens of notifications per minute. `dev:server1..3` run extra API instances to show that nothing is held in process memory. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
  ┌─────────────────────────────┐                         ┌────────────────────────────┐
  │ Product services            │                         │ Admin console              │
  │ auth · orders · social      │                         │ campaigns · templates      │
  └──────────────┬──────────────┘                         └─────────────┬──────────────┘
                 │ (1) POST /v1/notifications                           │ start campaign
                 ▼                                                      ▼
  ┌──────────────┴──────────────────────────────────────────────────────┴──────────────┐
  │ API gateway · service auth · per-caller quotas · TLS                               │
  └──────────────┬─────────────────────────────────────────────────────────────────────┘
                 ▼
  ┌─────────────────────────────┐                         ┌────────────────────────────┐
  │ Notification API            │  GET prefs, SET NX,     │ Redis                      │
  │ prefs · quiet hours · dedup │────────────────────────▶│ prefs cache · idempotency  │
  │ rate limits · render        │  rate-limit script      │ dedup keys · rate counters │
  └──────────────┬──────────────┘                         └────────────────────────────┘
                 │ 1 tx: notification + deliveries + outbox
                 ▼
  ┌─────────────────────────────┐  (2) SELECT due rows    ┌────────────────────────────┐
  │ PostgreSQL · by recipient   │◀────────────────────────│ Outbox relay               │
  │ notifications · deliveries  │  FOR UPDATE SKIP LOCKED │ due rows, critical first   │
  │ outbox · preferences        │                         └─────────────┬──────────────┘
  └─────────────────────────────┘                                       │ publish + confirm
          ▲             ▲                                               ▼
          │             │                                 ┌────────────────────────────┐
          │ delivered,  │                                 │ RabbitMQ                   │
          │ bounced     │                                 │ 12 queues + dead-letter    │
          │             │                                 └─────────────┬──────────────┘
          │             │                                               │ consume
          │             │ claim · mark sent                             ▼
          │             │ retry via outbox                ┌────────────────────────────┐
          │             └─────────────────────────────────┤ Channel workers            │
          │                                               │ push · email · sms pools   │
          │                                               └─────────────┬──────────────┘
          │                                                             │ send
          │                                                             ▼
  ┌───────┴─────────────────────┐  (3) POST /webhooks/ses ┌────────────────────────────┐
  │ Webhook receiver            │◀────────────────────────┤ APNs · FCM · SES · Twilio  │
  │ verify · dedupe · advance   │                         │ external providers         │
  └─────────────────────────────┘                         └────────────────────────────┘
```

1. **Accept (1).** A product service posts a notification with an `Idempotency-Key`. The Notification API reads the user's preferences from Redis, drops opted-out channels, pushes a non-critical send past the user's quiet hours, claims a dedup key and the rate-limit budget, renders the template, and commits the notification, one delivery row per channel and one outbox row per channel in a single PostgreSQL transaction. It answers `202 Accepted`; nothing has been published yet.
2. **Deliver (2).** The outbox relay selects due outbox rows, most urgent first, publishes each to its `{channel}.{priority}` RabbitMQ queue and marks it published once the broker confirms. A channel worker claims the delivery row, calls the provider, records the result and acks the message. Failures become a new outbox row due later; exhausted retries go to the dead-letter queue.
3. **Receipts (3).** Providers call back with delivered, bounced, complained or unregistered-token events. The webhook receiver verifies the signature, ignores events it has already seen and moves the delivery row forward — never backward.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, service authentication, per-caller quotas | Requests | A misbehaving caller is throttled before it reaches us |
| Notification API | Validate, preferences, quiet hours, dedup, rate limits, render, one transaction; serves SSE streams | Accept rate, open streams | Stateless; never talks to RabbitMQ |
| Redis Cluster | Preference cache, idempotency records, dedup keys, rate-limit counters | Users, request rate | Losing it slows accepts; preferences fall back to PostgreSQL |
| PostgreSQL (sharded) | Notifications, deliveries, outbox, preferences | Recipients | Sharded by `user_id`, so the accept transaction is single-shard |
| Outbox relay | Publish due rows in priority order, with confirms | Accept rate | One relay per shard; `SKIP LOCKED` lets replicas share a shard |
| RabbitMQ | 12 queues (3 channels × 4 priorities) plus a dead-letter queue | Deliveries | Quorum queues; per-message ack and redelivery |
| Channel workers | Claim, call provider, record, ack | Deliveries per channel | Separate pools per channel; breakers and token buckets per provider |
| Webhook receiver | Provider receipts → delivery status | Receipt rate | Idempotent by provider event ID |

The Notification API and the workers are separate deployments because their failure modes are different: the API must keep accepting while a provider is down, and a slow provider must back up only its own channel's workers. The relay is what lets the API not care whether RabbitMQ is up at all.

## Core Components / Request Flows

### Accepting a notification

```
Caller                       Notification API                           Redis   PostgreSQL
   │                                 │                                    │          │
   │ 1 POST, Idempotency-Key K       │                                    │          │
   │────────────────────────────────▶│                                    │          │
   │                                 │ 2 SET idem:{caller}:K NX EX 60     │          │
   │                                 │───────────────────────────────────▶│          │
   │                                 │ 3 GET prefs:{user}                 │          │
   │                                 │───────────────────────────────────▶│          │
   │                                 │ 4 deliver_at after quiet hours     │          │
   │                                 │ 5 dedup SET NX; rate-limit script  │          │
   │                                 │───────────────────────────────────▶│          │
   │                                 │ 6 1 tx: notification, deliveries, outbox      │
   │                                 │──────────────────────────────────────────────▶│
   │                                 │ 7 store 202 under K (24 h)         │          │
   │                                 │───────────────────────────────────▶│          │
   │ 8 202 {id, queued | scheduled}  │                                    │          │
   │◀────────────────────────────────│                                    │          │
   │                                 │                                    │          │
```

- The idempotency key is scoped by caller and bound to a SHA-256 fingerprint of the request body. A repeat with the same body replays the stored `202`; a repeat while the first is still running gets `409` with `Retry-After`; the same key with a different body is a client bug and gets `422`.
- Preferences come from Redis (cache-aside, invalidated on every preference write, 5-minute TTL as a backstop). Opted-out channels are removed first, so a suppressed send spends no dedup or rate-limit budget.
- Quiet hours are minutes from local midnight plus an IANA zone. "22:00–07:00 Asia/Tokyo" defers a `normal` send made at 23:10 Tokyo time to 07:00 Tokyo time, correct across DST changes. `critical` sends ignore quiet hours.
- The content dedup key is `SET NX` on a hash of user, template and data, so two identical concurrent requests cannot both pass. Rate limits for all requested channels are checked and taken in one Lua script — all or nothing.
- The transaction is the commitment point. If it rolls back, there is no notification and no message; if it commits, the relay will publish it. There is no window in which one exists without the other.

### Relaying and delivering

```
Outbox relay                   PostgreSQL   RabbitMQ         Email worker                Provider
      │                             │           │                  │                         │
      │ 1 SELECT due … SKIP LOCKED  │           │                  │                         │
      │────────────────────────────▶│           │                  │                         │
      │ 2 publish to email.high                 │                  │                         │
      │────────────────────────────────────────▶│                  │                         │
      │ 3 publisher confirm                     │                  │                         │
      │◀────────────────────────────────────────│                  │                         │
      │ 4 SET published_at; COMMIT  │           │                  │                         │
      │────────────────────────────▶│           │                  │                         │
      │                             │           │ 5 {id, channel}  │                         │
      │                             │           │─────────────────▶│                         │
      │                             │ 6 claim: pending → sending   │                         │
      │                             │◀─────────────────────────────│                         │
      │                             │           │                  │ 7 send, key = id:email  │
      │                             │           │                  │────────────────────────▶│
      │                             │           │                  │ 8 202 accepted          │
      │                             │           │                  │◀────────────────────────│
      │                             │ 9 mark sent (fenced)         │                         │
      │                             │◀─────────────────────────────│                         │
      │                             │           │ 10 ack           │                         │
      │                             │           │◀─────────────────│                         │
      │                             │           │                  │                         │
```

- The relay query is `WHERE published_at IS NULL AND available_at <= now() ORDER BY priority, available_at FOR UPDATE SKIP LOCKED LIMIT 100`. Scheduled sends, quiet-hours deferrals and retries are all just rows with a later `available_at`; no separate scheduler exists.
- Publishing waits for the broker's confirm before the row is marked published. A relay that crashes mid-batch rolls back and those rows are published again — so consumers must be idempotent, and they are.
- The claim is one `UPDATE … SET status = 'sending', attempts = attempts + 1, lease_expires_at = now() + 60 s WHERE status IN ('pending', 'retrying') OR (status = 'sending' AND lease_expires_at < now())`. A duplicate or redelivered message finds nothing to claim and is acked. `attempts` is the fencing token: the final write includes `WHERE attempts = mine`, so a worker whose lease expired cannot overwrite the result of the worker that took over.
- The provider gets `{notification_id}:{channel}` as its idempotency or collapse key where it supports one (email APIs, APNs `apns-collapse-id`), which shrinks the duplicate window that remains when a worker dies after the provider accepted.
- Recording a result locks the notification row, updates the delivery row and recomputes the aggregate status in one transaction, so two channels finishing at once cannot leave the notification stuck at `partial`.

### Failure, retry and dead-lettering

```
RabbitMQ                    Email worker         Provider           PostgreSQL   Outbox relay
    │                             │                  │                   │             │
    │ 1 message (attempt 2 of 5)  │                  │                   │             │
    │────────────────────────────▶│                  │                   │             │
    │                             │ 2 claim, attempts = 2                │             │
    │                             │─────────────────────────────────────▶│             │
    │                             │ 3 send           │                   │             │
    │                             │─────────────────▶│                   │             │
    │                             │ 4 503 / timeout  │                   │             │
    │                             │◀─────────────────│                   │             │
    │                             │ 5 retrying + outbox row due in 10 s  │             │
    │                             │─────────────────────────────────────▶│             │
    │ 6 ack                       │                  │                   │             │
    │◀────────────────────────────│                  │                   │             │
    ··································· 10 s later ·····································
    │ 7 republish (attempt 3)                                                          │
    │◀─────────────────────────────────────────────────────────────────────────────────│
    ······························ attempt 5 also fails ································
    │                             │ 8 failed, exhausted                  │             │
    │                             │─────────────────────────────────────▶│             │
    │ 9 nack → dead-letter queue  │                  │                   │             │
    │◀────────────────────────────│                  │                   │             │
    │                             │                  │                   │             │
```

- A transient failure (timeout, 5xx, throttling) puts the row back to `retrying` and inserts the retry as an outbox row due after exponential backoff with jitter (~5 s, 10 s, 20 s, 40 s), in the same transaction. The retry survives a worker crash because it is a database row, not a timer.
- When the provider's circuit breaker is open the delivery is deferred by the breaker's half-open delay and the attempt is handed back: a provider outage should not burn every message's retry budget.
- Permanent failures (unregistered device token, hard bounce, unverified address) fail immediately and feed suppression lists. After the fifth transient failure the delivery is marked failed and the message is rejected into the dead-letter queue for inspection and replay. A message that cannot be parsed goes straight there.
- A sweeper re-enqueues deliveries whose lease expired more than 30 s ago — the case where a worker died and its redelivered message was skipped because the lease still looked alive.

### Delivery receipts

"Sent" means a provider accepted the message, not that a person saw it. Providers report what happened later: SES and SendGrid post delivered, bounced and complained events; APNs and FCM answer with `Unregistered`/`410` for dead tokens; Twilio posts status callbacks. The webhook receiver verifies each callback's signature, inserts `(provider, event_id)` into `provider_events` (a duplicate insert means "already applied"), looks the delivery up by `provider_message_id`, and advances it only forward (`sent → delivered`, `sent → bounced`). Bounces and complaints add the address to a suppression list; unregistered tokens deactivate the device. Receipts that arrive before the worker recorded `sent` are kept and applied when it does.

### Live updates to browsers

The in-app inbox and the operator console are live. Every change a person can see — a new inbox item, a delivery moving to `sent`, `delivered` or `bounced` — also writes a `user_events` row with a per-user sequence number in the same transaction as the change. The relay publishes those rows to the Redis pub/sub channel `user:{id}`; the Notification API instance holding that user's server-sent events stream is subscribed and forwards them, using the sequence number as the SSE `id`. A reconnecting browser sends `Last-Event-ID`, and the API replays newer rows from PostgreSQL before going live, so nothing is lost across a dropped connection. Browsers keep one stream per user agent by electing a leader tab.

## Database Schema

### Production schema

```sql
-- Sharded by user_id: a notification, its deliveries and its outbox rows live on
-- the same shard, so accepting one is a local transaction.
CREATE TABLE notifications (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL,
  category      TEXT NOT NULL,              -- security | orders | social | marketing
  template_id   TEXT,
  template_ver  INT,
  content       JSONB NOT NULL,             -- rendered per channel at accept time
  priority      SMALLINT NOT NULL,          -- 0 critical .. 3 low
  status        TEXT NOT NULL,              -- pending | scheduled | partial | delivered | failed | cancelled
  deliver_at    TIMESTAMPTZ NOT NULL,
  dedupe_key    TEXT,                       -- e.g. campaign:{id}:{user_id}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ON notifications (user_id, created_at DESC, id);       -- history and inbox

CREATE TABLE deliveries (
  notification_id      UUID NOT NULL REFERENCES notifications (id),
  channel              TEXT NOT NULL,       -- push | email | sms | in_app
  status               TEXT NOT NULL,       -- pending | sending | retrying | sent | delivered | bounced | failed | cancelled
  attempts             INT NOT NULL DEFAULT 0,   -- also the fencing token
  lease_expires_at     TIMESTAMPTZ,
  next_attempt_at      TIMESTAMPTZ,
  provider             TEXT,
  provider_message_id  TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, channel)
);
CREATE UNIQUE INDEX ON deliveries (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE delivery_outbox (
  id               BIGSERIAL PRIMARY KEY,
  notification_id  UUID NOT NULL,
  channel          TEXT NOT NULL,
  priority         SMALLINT NOT NULL,
  available_at     TIMESTAMPTZ NOT NULL,
  published_at     TIMESTAMPTZ
);
CREATE INDEX ON delivery_outbox (priority, available_at) WHERE published_at IS NULL;

CREATE TABLE preferences (
  user_id      UUID PRIMARY KEY,
  channels     JSONB NOT NULL,              -- {"sms": {"enabled": false}}
  categories   JSONB NOT NULL,              -- {"marketing": {"email": false}}
  quiet_start  SMALLINT,                    -- minutes from local midnight
  quiet_end    SMALLINT,
  time_zone    TEXT NOT NULL DEFAULT 'UTC', -- IANA name
  version      INT NOT NULL DEFAULT 1,      -- If-Match on updates
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_events (                 -- what the SSE stream replays after Last-Event-ID
  user_id     UUID NOT NULL,
  seq         BIGINT NOT NULL,                -- per-user, strictly increasing
  type        TEXT NOT NULL,                  -- inbox.created | inbox.read | delivery.updated
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, seq)
);

CREATE TABLE provider_events (
  provider             TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  provider_message_id  TEXT NOT NULL,
  type                 TEXT NOT NULL,       -- delivered | bounced | complained | unregistered
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
```

Device tokens (`user_id`, platform, token, active), templates (versioned, one variant per channel and locale), campaigns and an email suppression list complete the relational model. Redis holds `prefs:{user}` (5-minute TTL), `idempotency:{caller}:{key}` (60 s while processing, 24 h once completed), `dedup:{user}:{sha256}` (the dedup window, 60 s by default) and `ratelimit:{scope}:{id}:{channel}` counters.

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql); every statement is re-runnable, and Docker Compose loads it into fresh volumes. It maps to the production design like this:

| Production | Local | Difference |
|------------|-------|------------|
| `notifications` | `notifications` | `channels TEXT[]` instead of a category; `scheduled_at` holds the deferred delivery time; `dedupe_key` unique when set; not sharded |
| `deliveries` | `delivery_status` | Same state machine and lease columns (`attempts`, `lease_expires_at`, `next_retry_at`); success is `sent`, receipts never move it to `delivered` |
| `delivery_outbox` | `delivery_outbox` | Adds `priority_rank`, the JSON `payload`, `publish_attempts` and `last_error` |
| `preferences` | `notification_preferences` | No `version` column; `categories` stored but not enforced |
| `provider_events`, `user_events` | — | No webhooks or live stream locally; `notification_events` stores opens, clicks and dead letters |
| — | `users`, `sessions`, `device_tokens`, `notification_templates`, `campaigns`, `campaign_stats` | Session auth lives in the same database |

## API Design

### Production API

```
POST   /v1/notifications                 accept; Idempotency-Key → 202 {id, status, deliver_at} | 409 | 422 | 429
GET    /v1/notifications/{id}            status with per-channel deliveries (caller or recipient)
DELETE /v1/notifications/{id}            cancel what has not started → 200 | 409 already sending
GET    /v1/me/notifications?cursor=…     in-app inbox and history, newest first, keyset pagination
POST   /v1/me/notifications/{id}/read    mark read (in-app) and record the open
GET    /v1/me/preferences                preferences with version
PATCH  /v1/me/preferences                If-Match: version → 200 | 412
GET    /v1/me/stream                     SSE: inbox items and delivery updates, Last-Event-ID resume
POST   /v1/campaigns/{id}/start          operator; starts the fan-out job → 202
POST   /v1/webhooks/{provider}           signed provider receipts → 200, idempotent by event ID
```

- `202 Accepted`, not `201`: the resource exists, but delivery happens later. The body says `queued` or `scheduled` with `deliver_at`, or why nothing will be sent (`suppressed`, `deduplicated`).
- Rate-limited requests get `429` with `Retry-After`; errors are `application/problem+json`.
- Callers are services authenticated at the gateway; a user token may only target its own user.

### Local routes

All under `/api/v1`, bearer session token; details in [Implementation Notes](#implementation-notes).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/login`, `/auth/register`, `/auth/logout`; GET `/auth/me` | Demo session auth |
| POST | `/notifications` | Accept; optional `Idempotency-Key`; `202` queued or scheduled, `200` deduplicated, suppressed or duplicate, `429`, `403` when a non-admin targets another user |
| GET | `/notifications`, `/notifications/:id` | Own history (`limit`/`offset`), one notification with per-channel rows |
| DELETE | `/notifications/:id` | Cancel a pending or scheduled notification |
| POST | `/notifications/:id/events` | Record opened, clicked or dismissed — recipient or admin only |
| GET | `/notifications/rate-limit/usage` | Per-channel hourly usage |
| GET, PATCH, PUT | `/preferences`, `/preferences/channels/:channel`, `/preferences/quiet-hours` | Channel toggles, quiet hours and time zone |
| GET, POST, PATCH, DELETE | `/templates…`, `/campaigns…` | Templates and campaigns (writes are admin-only) |
| GET, PATCH, POST | `/admin/…` | Stats with delivery backlog and outbox lag, users, roles, rate-limit resets, failures |
| GET | `/health`, `/health/live`, `/health/ready`, `/metrics` | Operations (outside `/api/v1`) |

## Key Design Decisions

### 1. A transactional outbox, not "insert, then publish"

The obvious accept path inserts the notification and then publishes to the queue. Those are two systems, and any crash or broker error between them leaves a notification that exists but will never be sent — or, if the order is flipped, a message for a notification that was never committed. Writing the outbox row in the same transaction as the notification makes them one fact, and the relay turns that fact into a message at least once. Two more things fall out for free: the API's availability no longer depends on RabbitMQ, and scheduling becomes a column (`available_at`) rather than a separate service — quiet-hours deferrals, scheduled sends and retry backoff are all the same relay query. The cost is extra write volume (one outbox row per delivery, deleted a day later), a relay to operate, and up to one polling interval of extra latency; the relay is woken with `LISTEN/NOTIFY` so critical messages don't wait for the next poll.

### 2. One queue per channel and priority, not a priority field

Priority as a field inside one queue does not survive a campaign: the million campaign messages already in the queue are ahead of the password reset, whatever its priority says. RabbitMQ's own priority queues reorder only what is waiting, and with prefetch the consumer already holds low-priority messages in memory. Separate queues let critical consumers sit idle and react immediately, and let push, email and SMS scale and fail independently — SMS is slow, throttled and expensive; push is cheap and huge. The outbox relay applies the same rule one step earlier: it drains critical rows first, so a campaign backlog in the outbox cannot delay them either. What we give up is queue count: 3 channels × 4 priorities is 12 queues to declare, monitor and alarm on, and a new channel adds four.

### 3. At-least-once delivery with an idempotent claim

Exactly-once delivery to an external provider does not exist: the provider can accept the message and our acknowledgement can be lost, and no transaction spans RabbitMQ, PostgreSQL and APNs. So messages are delivered at least once, and the consumer makes repeats harmless by claiming the (notification, channel) row before it calls the provider. A redelivered or replayed message finds the row already `sending` or `sent` and is acked without a send. The claim carries a 60-second lease so a dead worker's delivery is picked up again, and the attempt counter fences the dead worker's late write. The remaining duplicate window is "worker dies after the provider accepted but before it recorded `sent`" — narrowed further by provider idempotency keys and collapse IDs. We accept that window because the alternative failure, a lost password-reset email, is worse than a rare duplicate push.

### 4. Retries are outbox rows with a budget

Retrying in process (sleep, then try again) holds a worker slot and dies with the process; requeueing with `nack` retries immediately and forever. Writing the retry as an outbox row due later is durable, needs no broker plugin for delays, and lets the relay keep priority ordering for retries too. Five attempts with exponential backoff cover about a minute and a half of provider trouble; longer outages are absorbed by the circuit breaker, whose deferrals don't spend attempts. Only after the budget is spent does a message go to the dead-letter queue — not on every failed attempt.

### 5. Decide at accept time, re-check opt-outs at send time

Preferences, quiet hours and dedup are applied once, at accept time, from Redis: that keeps the database off the hot path and means suppressed messages never enter the pipeline. Quiet hours are stored as local minutes plus an IANA time zone and evaluated with the zone's rules — server-local time would wake Tokyo users at 3 a.m. — and the deferral target is computed across DST. But a message deferred for eight hours can outlive the user's consent, so workers re-check the cached opt-out (channel and category) just before sending. Preference writes invalidate the cache, so both checks see a change within seconds; the 5-minute TTL is only a backstop. Legal unsubscribes (one-click `List-Unsubscribe`) write through to PostgreSQL before they return.

### 6. RabbitMQ rather than Kafka for delivery jobs

Delivery jobs are individually acknowledged, individually retried and individually dead-lettered, and one slow provider call must not block the messages behind it. That is a work queue. In Kafka, a partition is consumed in order, so one stuck message delays everything behind it in that partition, and retries need retry topics. Kafka is the right tool for the event stream around the system — the product events that trigger notifications, and opens and clicks flowing to analytics — where replay matters. RabbitMQ with quorum queues handles 25K messages per second across 12 queues, and per-message acks, redelivery and dead-lettering are built in.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Accept | Notification, deliveries and outbox rows exist together or not at all | One transaction on the recipient's shard |
| Client retry | One notification per `Idempotency-Key` | Caller-scoped key, `SET NX` claim, body fingerprint (`422` on mismatch), stored `202` for 24 h |
| Campaign fan-out | At most one notification per recipient per campaign | Unique `dedupe_key = campaign:{id}:{user}`; a rerun inserts nothing |
| Same content twice | Sent once within the dedup window | `SET NX` on `dedup:{user}:{sha256}`, released if nothing was created |
| Publish | Every committed delivery is published at least once | Outbox, relay, publisher confirms |
| Consume | One provider call per (notification, channel), except when a worker dies mid-send | Claim with lease; `attempts` as fencing token |
| Status | Never regresses; concurrent channels can't lose an update | Row lock on the notification while recomputing; receipts only move forward |
| Cancel | Nothing that hasn't started will be sent | Deliveries → `cancelled` and unpublished outbox rows deleted in one transaction; the claim skips cancelled notifications |

## Security / Auth

- **Callers:** internal services authenticate at the gateway (mTLS or signed service tokens) and get per-caller quotas. A user session may only notify its own user; sending to others is an operator or service permission.
- **Recipients:** inbox, preferences, status and open/click events are scoped to the authenticated user; events are accepted only for the recipient's own notifications and channels.
- **Sessions:** server-side sessions in Redis; role changes and logouts evict cached sessions immediately.
- **Webhooks:** every provider callback is signature-verified (SES SNS signatures, Twilio `X-Twilio-Signature`, SendGrid signed events) and deduplicated by event ID.
- **Content:** template variables are HTML-escaped for email; links are rewritten for click tracking only to an allow-listed domain; previews render in a sandboxed iframe.
- **Abuse and cost:** per-user hourly caps per channel, SMS off by default, and per-provider token buckets so we never exceed contracted throughput.

## Observability

- **Accept path:** latency, outcomes (`queued`, `scheduled`, `suppressed`, `deduplicated`, `rate_limited`), idempotent replays and conflicts.
- **Pipeline:** outbox lag (age of the oldest due, unpublished row — the single best "is delivery working" signal), queue depth per channel and priority, consumer utilization.
- **Delivery:** outcomes per channel (`sent`, `retry_scheduled`, `deferred`, `failed`, `dead_lettered`, `skipped`), provider latency and error rate, breaker state, attempts per delivery.
- **Receipts:** delivered and bounce rates per provider; a rising bounce or complaint rate pauses campaigns.
- **SLO alerts:** critical accepted-to-sent p99 above 2 s, outbox lag above 30 s, dead-letter growth, bounce rate above 2%.
- Structured logs carry the notification ID, channel and attempt; traces span API → relay → worker → provider.

## Failure Handling

| Failure | Behavior | Mitigation |
|---------|----------|------------|
| RabbitMQ down | Accepts keep working; deliveries wait in the outbox | Relay retries with backoff; outbox lag alerts |
| Provider down | That channel's deliveries defer and retry; others unaffected | Per-provider circuit breaker, failover to a secondary provider, retry budget, DLQ |
| Worker dies mid-send | Message redelivered; claim waits out the lease | Lease sweeper re-enqueues; fencing ignores the dead worker's late write |
| Relay dies mid-batch | Batch rolls back and is republished | Idempotent claims make the duplicates harmless |
| Redis down | Preferences read from PostgreSQL; idempotency, dedup and rate limits fail open | Circuit breaker on the cache; alert, since duplicates become possible |
| PostgreSQL shard down | Accepts for that shard's users fail with `503` | Replica promotion; callers retry with the same key |
| Campaign floods the pipeline | Low-priority queues back up | Separate queues and consumers; critical traffic is unaffected |
| Poison message | Dead-lettered on first read | Parse and validate before the claim |

## Scalability Considerations

1. **Accept path:** stateless API instances; Redis Cluster for preferences and keys; PostgreSQL sharded by `user_id` so every accept is a single-shard transaction.
2. **Relay:** one relay per shard, scaled out with `SKIP LOCKED`; outbox rows are deleted after a day, so the table stays small.
3. **Delivery:** worker pools per channel scale on queue depth; prefetch per queue gives critical queues more in-flight capacity; per-provider token buckets cap throughput at what each provider contract allows.
4. **Campaigns:** fan-out runs as a resumable job that pages through the audience by user ID and enqueues in batches at `low` priority; the per-recipient dedupe key makes a resumed job safe.
5. **What breaks first:** SMS provider throughput (~100 messages/s per short code), then email reputation (warm-up and bounce rates), then the history tables' storage — aged out to object storage after 30 days.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Accept → queue | Transactional outbox | Insert, then publish | No lost or phantom notifications; API independent of the broker |
| Priority | Queue per channel and priority | Priority field or priority queue | A campaign backlog can't delay critical messages |
| Delivery semantics | At-least-once + idempotent claim | Exactly-once | Not achievable with external providers; duplicates bounded |
| Retries | Outbox rows with backoff and a budget | In-process retry or `nack` requeue | Durable, bounded, priority-ordered |
| Preferences | Redis cache-aside, invalidated on write | Database read per send | 17K reads/s off PostgreSQL; changes apply within seconds |
| Quiet hours | Recipient's IANA zone | Server time | Correct local time, DST included |
| Queue technology | RabbitMQ quorum queues | Kafka | Per-message ack, retry and DLQ; no head-of-line blocking |
| Client retries | Idempotency-Key + fingerprint | Content hash only | Distinguishes a retry from an intentional repeat |

## Implementation Notes

The local project runs the accept path, the outbox relay, the delivery workers and the operator dashboard on one machine: an Express API ([`backend/src/index.ts`](./backend/src/index.ts)), a worker process ([`backend/src/workers/index.ts`](./backend/src/workers/index.ts)), PostgreSQL 16, Valkey 7 and RabbitMQ 3 from [`docker-compose.yml`](./docker-compose.yml), and a React 19 + TanStack Router + Zustand dashboard. Providers are simulated. This section describes the code as of the 2026-10 review.

### Production design → local implementation

| Production design | Local implementation | Where |
|-------------------|----------------------|-------|
| Accept in one transaction with an outbox | Implemented as described; the API needs only PostgreSQL and Redis | [notifications.ts](./backend/src/services/notifications.ts), [outbox.ts](./backend/src/services/outbox.ts) |
| Outbox relay with confirms, priority order | Polls every 200 ms (back-to-back while batches are full), batches of 100, confirm channel with a 5 s timeout; no `LISTEN/NOTIFY` | [outbox.ts](./backend/src/services/outbox.ts), [rabbitmq.ts](./backend/src/utils/rabbitmq.ts) |
| Queue per channel and priority + DLQ | The same 12 queues and `notifications.dead_letter`, arguments unchanged | [rabbitmq.ts](./backend/src/utils/rabbitmq.ts) |
| Leased, fenced claim; outbox retries; DLQ | Implemented; lease sweeper every 15 s | [deliveryHandler.ts](./backend/src/workers/deliveryHandler.ts), [delivery.ts](./backend/src/services/delivery.ts) |
| Idempotency-Key with fingerprint | Implemented on `POST /notifications`; fails open without Redis | [idempotency.ts](./backend/src/utils/idempotency.ts), [routes/notifications.ts](./backend/src/routes/notifications.ts) |
| Preferences cache, quiet hours in the user's zone | Implemented at accept time; no re-check at send time | [preferences.ts](./backend/src/services/preferences.ts), [quietHours.ts](./backend/src/services/quietHours.ts) |
| Rate limits and provider token buckets | Per-user hourly and global per-minute fixed windows, taken atomically at accept time; no worker-side token buckets | [rateLimiter.ts](./backend/src/services/rateLimiter.ts) |
| Provider failover | One simulated provider per channel behind a Cockatiel circuit breaker | [workers/index.ts](./backend/src/workers/index.ts), [circuitBreaker.ts](./backend/src/utils/circuitBreaker.ts) |
| Webhook receipts, live SSE stream, in-app channel, digests | Not implemented | — |

### Accepting a notification

`POST /api/v1/notifications` runs: authorization (a non-admin may only target itself, `403` otherwise) → optional `Idempotency-Key` → validation → cached preferences → content dedup → rate limits → quiet hours → render → one transaction.

- **Idempotency.** The key is stored as `idempotency:{callerId}:{key}` with a SHA-256 fingerprint of the request body (keys sorted). The claim is `SET … NX EX 60`; only `2xx` responses are stored, for 24 hours, and replayed with `Idempotent-Replayed: true`. Completion and release are Lua compare-and-set scripts on a per-claim token, so a request that lost its claim cannot overwrite a newer one. A Redis error lets the request through.
- **Dedup and rate limits.** `dedup:{userId}:{sha256(templateId, data)}` is claimed with `SET NX EX window` (60 s by default, `deduplicationWindow` in the body) and released whenever no notification ends up created. Rate limits check every counter for the allowed channels — per user per hour (push 50, email 10, SMS 5) and global per minute (100,000, 10,000, 1,000) — and increment them only if all fit, in one Lua script that also sets the TTL atomically.
- **Quiet hours.** Windows are minutes from local midnight in the stored IANA zone, evaluated with `Intl.DateTimeFormat`; `start == end` means no quiet hours; `critical` bypasses them. The preferences page saves the browser's zone with the window, and an explicit `null` now clears it.
- **The transaction** inserts the notification (`pending`, or `scheduled` with `scheduled_at`), one `delivery_status` row per channel and one `delivery_outbox` row per channel with `available_at` = now, the requested time or the end of quiet hours. Campaign fan-out passes `dedupeKey = campaign:{id}:{userId}`; `ON CONFLICT (dedupe_key) … DO NOTHING` makes a repeated recipient a no-op.
- **Responses:** `202` for `queued` and `scheduled` (with `scheduledFor`), `200` for `deduplicated`, `suppressed` and `duplicate`, `429` with `Retry-After`, `400`/`404` for invalid requests, `500` otherwise. The dashboard's send form generates one key per submitted draft, reuses it when the same draft is resubmitted, and announces the outcome in an `aria-live` region.

### Relay and delivery

The worker process registers consumers for the 12 queues and the dead-letter queue, connects (retrying with backoff until RabbitMQ is up), starts the relay and a lease sweeper.

```sql
-- backend/src/services/delivery.ts: the claim that makes duplicates harmless
UPDATE delivery_status ds SET status = 'sending', attempts = ds.attempts + 1,
       lease_expires_at = NOW() + make_interval(secs => $3), ...
FROM notifications n
WHERE ds.notification_id = $1 AND ds.channel = $2 AND n.id = ds.notification_id
  AND n.status <> 'cancelled'
  AND (ds.status IN ('pending', 'retrying')
       OR (ds.status = 'sending' AND ds.lease_expires_at < NOW()))
RETURNING ds.attempts, n.user_id, n.priority, n.content
```

- [`processDelivery()`](./backend/src/workers/deliveryHandler.ts) returns `ack` or `dead-letter`: no claim → ack; success → `sent`; breaker open → retry in 30 s without spending the attempt; transient failure → `retrying` plus an outbox row due after ~5 s × 2ⁿ (20% jitter, capped at 5 minutes; `DELIVERY_RETRY_BASE_MS`); permanent failure (no device, no or unverified address) → `failed` and ack; fifth failure (`DELIVERY_MAX_ATTEMPTS`) → `failed` and `nack`, which the existing dead-letter arguments route to `notifications.dead_letter`.
- `complete()` and `scheduleRetry()` lock the notification row, update the delivery row only `WHERE status = 'sending' AND attempts = <claim>`, and recompute the aggregate (`pending`, `partial`, `delivered`, `failed`, `partial_success`, `cancelled`) in one transaction.
- `consumeQueue()` dead-letters unparseable messages, requeues after 2 s when the handler throws before claiming (for example PostgreSQL is down), and re-attaches every consumer after a reconnect (1 s → 30 s backoff). The dead-letter consumer writes a `dead_letter` row to `notification_events`.
- `reapExpiredLeases()` turns `sending` rows whose lease expired more than 30 s ago back into `retrying` with a fresh outbox row.
- Cancel (`DELETE /notifications/:id`) moves the notification and its unstarted deliveries to `cancelled` and deletes unpublished outbox rows in one transaction.
- The admin dashboard's "queue depth" is the real backlog (`delivery_status` rows pending, sending or retrying, by channel and priority) plus `outboxLagSeconds`; `/health` reports the outbox as degraded when the oldest due row has waited more than 30 s.

### Authorization and other fixes in this review

- Any logged-in user could send email and SMS to any other user by passing `userId`; now only admins can.
- `POST /notifications/:id/events` accepted events for anyone's notification; it now requires the recipient (or an admin) and one of the notification's channels.
- Role changes evict the user's cached sessions, so a demotion applies on the next request instead of up to 24 hours later.
- Campaign start claims the campaign with a conditional `UPDATE … WHERE status IN ('draft', 'scheduled')`, so two concurrent starts can't both fan out; the second gets `409`.
- Malformed IDs return `404` instead of a PostgreSQL cast error.

### Operations

Prometheus metrics ([metrics.ts](./backend/src/utils/metrics.ts)) include accept outcomes, `outbox_published_total`, `delivery_outcomes_total{channel, outcome}`, delivery attempts, processing time and breaker state. Pino writes JSON logs with request IDs, and the request serializer omits headers. `/health/live` and `/health/ready` are separate probes. The API's shutdown closes the HTTP server, PostgreSQL and Redis; the worker stops the sweeper and relay, closes RabbitMQ, then the stores.

### Verification (2026-10-10)

- `npm test` in `backend/` runs 25 offline vitest tests: quiet hours (zones, midnight-spanning windows, both DST transitions), the aggregate status, dedup keys, idempotency (claim, replay, `422`, caller scoping, owner-only release), the relay (priority order, stop on an unconfirmed publish) and every branch of the delivery handler. Backend and frontend `tsc`, ESLint and the frontend build are clean.
- Against real PostgreSQL 16 and Redis, without RabbitMQ: `init.sql` and the seed both load twice; a non-admin sending to another user gets `403`; replay, `422`, and five concurrent requests with one key (one `202`, four `409`, one row); dedup; a sixth SMS gets `429` and leaves the push counter untouched; quiet hours in `Asia/Tokyo` schedule the outbox row for the local end time while `critical` goes out now; cancel removes the outbox rows; event ownership; promotion and demotion take effect immediately; two concurrent campaign starts give `200` and `409`.
- The relay and the delivery handler were driven against the same PostgreSQL with an in-memory publisher: priority-ordered batches, scheduled rows held back, a redelivered message skipped, a transient failure retried through the outbox and then delivered, three failures ending in `dead-letter`, an expired lease re-enqueued and the dead worker's late write fenced off. The RabbitMQ consumer, publisher confirms and reconnects were not exercised against a live broker.

### Simplified or omitted

- **Auth is demo-grade:** login accepts any password for an existing email (sessions in PostgreSQL, cached in Redis).
- **Preferences are applied only at accept time;** a deferred notification is sent even if the user turns the channel off in the meantime. Category preferences are stored but not enforced.
- **Campaign fan-out runs inside the HTTP request,** one recipient at a time, targeting all users with the `user` role.
- **No delivery receipts, in-app channel, digests, provider failover or worker-side token buckets;** `sent` means the simulated provider accepted the message (push 95%, email 98%, SMS 90% success).
- **Template output is not HTML-escaped;** lists use `OFFSET` pagination; idempotency, dedup and rate limits fail open when Redis is down.
- No sharding, read replicas, CDN, multi-region deployment or Kubernetes. Five Playwright smoke tests (`npm run test:smoke notification-system` from the repository root) check page rendering only.
