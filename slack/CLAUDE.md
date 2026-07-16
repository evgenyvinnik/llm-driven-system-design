# Slack (team messaging) — Development with Claude

## Project Context

A team messaging platform: workspaces contain channels and DMs, messages deliver in real time to everyone connected, and every message is searchable. The core hard problem is **real-time fan-out** — a message to a busy channel has to reach many WebSocket connections spread across gateway instances in under ~200ms — layered on top of **workspace isolation** and **full-text search over a growing message corpus**.

**Learning goals:** WebSocket delivery with Redis pub/sub across multiple backend instances, threading as a self-referential data model, TTL-based presence that self-cleans, and a search tier (Elasticsearch) that degrades to a Postgres fallback instead of failing.

## Architecture at a Glance (what actually runs)

Three datastores from `docker-compose.yml`:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL 16** (`pg`) | Source of truth: users, workspaces, channels, messages (with `thread_ts`), reactions, DMs | ACID; a thread reply insert + parent `reply_count` bump must be atomic. GIN FTS index doubles as the search fallback |
| **Valkey/Redis** (`ioredis`) | Cross-instance pub/sub for message delivery, presence (TTL), typing, sessions, rate-limit counters | Pub/sub lets any gateway serve any user; TTL keys auto-expire stale presence |
| **Elasticsearch 8** (`@elastic/elasticsearch`) | Ranked full-text message search | BM25 relevance + highlighting that Postgres FTS can't match at scale |

Backend: Express + **`ws`** WebSocket server (default port 3001, runnable as 3001–3003 sharing one Postgres/Redis), `express-session` + `connect-redis`, `bcrypt`, `pino`, `prom-client`. Frontend: React 19 + TanStack Router + Zustand + Tailwind + `date-fns`, with a `useWebSocket` hook. Schema is applied via `npm run db:migrate` (`src/db/migrate.ts`, idempotent `CREATE TABLE IF NOT EXISTS`) and seeded via `npm run db:seed` (`src/db/seed.ts`, TypeScript).

## Key Design Decisions

### 1. User-level Redis pub/sub for fan-out (not channel-level)
Every connected socket subscribes to exactly one Redis channel, `user:{userId}:messages`. When a message is sent, the message service looks up `channel_members` and publishes once per recipient to their personal channel. Gateways stay stateless — they hold no channel-membership map and never filter messages. Trade-off: one Redis subscription per online user (more channels) versus channel-level pub/sub, which would force every gateway to subscribe to every channel its sockets touch and re-run a membership filter on every published message. Delivery is fire-and-forget; a disconnected client backfills missed messages from Postgres by last-seen id on reconnect.

### 2. Threading as a message attribute (`thread_ts`), not a separate table
A reply is a `messages` row whose `thread_ts` references the parent id; the parent's denormalized `reply_count` is incremented in the same transaction. This keeps replies on the identical persist → fan-out path as normal messages and avoids a two-path delivery model or a join on every read. Trade-off: a denormalized counter, but it's only ever mutated inside the insert transaction, so it can't drift.

### 3. Elasticsearch primary + Postgres FTS fallback
Search hits Elasticsearch (BM25 ranking, highlighting, tenant-scoped by a mandatory `workspace_id` filter); if ES is unreachable, `search.ts` catches the error and falls back to Postgres `to_tsvector`/`plainto_tsquery` over the GIN index. Indexing is asynchronous so it never adds latency to a send. Trade-off: two systems to operate and a few seconds of index lag, bought in exchange for real relevance ranking plus graceful degradation.

### 4. TTL-based presence (not a presence table)
Presence is a Redis key `presence:{workspaceId}:{userId}` with a 60s TTL refreshed by heartbeats; a crashed client simply expires. Listing online users uses `SCAN`, never `KEYS`. Presence changes fan out only to users who share a channel with the changed user, so a 100K-member workspace doesn't broadcast 100K pushes per idle flip. Trade-off: eventual consistency (up to the TTL window) for zero cleanup jobs.

### 5. Session auth in Redis + sliding-window rate limits
`express-session` backed by `connect-redis` gives revocable server-side sessions. Write endpoints are protected by a Redis sorted-set sliding-window limiter (send 60/min, edit/delete/react 30/min, create-channel 10/min, search 20/min). Idempotency keys on sends (24h Redis TTL) stop mobile-retry duplicates.

## Current State

**Implemented end to end:** workspace CRUD + role-based membership; public/private channels with membership and read cursors; messages (send/edit/delete) delivered live over WebSocket via Redis pub/sub across instances; threading with reply counts; emoji reactions; 1:1 and group DMs; presence + typing indicators; Elasticsearch search with Postgres FTS fallback and filters; session auth, RBAC middleware, idempotency and rate-limit middleware, Prometheus metrics.

**Intentionally omitted:** file attachments/uploads; mentions and a notification system; webhooks / slash commands / bot users (the "integration platform"); a Kafka async pipeline (the production design routes notifications/indexing through Kafka — locally indexing is enqueued directly); multi-region.

## Iteration & Repair Log

- **2026-07 (backend answer parity):** `system-design-answer-backend.md` was substantive but lacked the repo's answer conventions — no emoji section headers and no first-person rationale, and it undersold failure handling. Rewrote to add emoji headers, quoted trade-off rationale (user-level vs channel-level pub/sub, ES vs PG-only search, presence fan-out), a capacity-estimation section, DM handling, and a failure/degradation table, matching the `coinbase` exemplar. Content was cross-checked against the schema and middleware (UUID users/workspaces, BIGSERIAL messages, `thread_ts`, real rate-limit values, 24h idempotency TTL).
- **2026-07 (README Node version):** README listed "Node.js 18+"; the repo requires ≥20. Bumped.
- **Search fallback is real, not aspirational:** verified `routes/search.ts` catches the Elasticsearch error path and runs a Postgres `tsvector` query — the "graceful degradation" claim in the docs is backed by code.

## Open Questions

1. Fire-and-forget pub/sub relies on clients backfilling by last-seen id — is there a reliable last-read cursor per channel to make "catch up on reconnect" exact, or can edge cases drop a message from the unread count?
2. Presence fan-out does a membership query per flip; at 100K-user workspaces should this move to a precomputed "co-channel" set in Redis to avoid the query entirely?
3. The design calls for async ES indexing via a queue; locally it's a direct enqueue — when does a real Kafka/worker pipeline become necessary, and how is indexing retried on ES outage so nothing is permanently unsearchable?
4. Sharding is by `workspace_id`; how are enterprise workspaces with millions of messages handled when a single tenant outgrows one shard?

## Resources

- [Slack Engineering — real-time messaging](https://slack.engineering/real-time-messaging/)
- [Slack Engineering — search at scale](https://slack.engineering/search-at-slack/)
- [Redis pub/sub](https://redis.io/docs/latest/develop/interact/pubsub/)
