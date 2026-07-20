# Twitch — Development with Claude

## Project Context

Live streaming is two systems bolted together that happen to share a page. The video path is a bandwidth problem with a latency budget — capture, encode, ingest, transcode, segment, deliver — and almost none of it is application logic. The chat path is a fan-out problem: one message from one viewer has to reach every other viewer in the channel within a few hundred milliseconds, across however many server instances those viewers happen to be connected to. This project implements the second one for real and simulates the first, because the interesting *distributed systems* content is all in chat and moderation.

What makes chat hard isn't the WebSocket. It's that every message must pass through a gauntlet before it's allowed to exist — dedup, rate limit, ban check, badge resolution — and that gauntlet runs on the hot path of the highest-volume write in the system. Get any of it wrong and you either let a banned user through or you add 50ms to every message in a product where chat velocity is the entire atmosphere.

The third thing worth noticing: chat's delivery mechanism (Redis pub/sub) is not chat's durability mechanism (Postgres). They fail independently, and the design has to decide which one a message can survive losing.

**Learning goals:** WebSocket room management with cross-instance pub/sub fan-out, the moderation pipeline as a hot-path filter chain, per-user/per-channel rate limiting, idempotent message handling over an unreliable client connection, and graceful degradation when the fan-out layer dies.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API + WebSocket server** (`backend/src/index.ts`) | **3001** | One Express app on an `http.Server` so `ws` can attach at path `/ws/chat` — chat and REST share a port and a process |
| **PostgreSQL 16** | 5432 | System of record: users, channels, streams, followers, subscriptions, emotes, `chat_messages`, `channel_bans`, `channel_moderators`, sessions |
| **Valkey (Redis)** | 6379 | Three distinct jobs: pub/sub fan-out per channel (`chat:{channelId}`), per-user chat cooldown keys, and viewer-count storage |

Chat lives entirely in `backend/src/services/chat.ts` — it holds two in-process maps (`channelClients`: channelId → Set\<WebSocket\>, and `clientInfo`: WebSocket → user/role/joined-channels) and subscribes to a Redis channel lazily on first join. `services/streamSimulator.ts` fabricates the live-video half: it fluctuates `channels.current_viewers` on an interval and generates HLS master/media playlists so the player has something structurally real to consume. Moderation is split across `routes/moderation/{bans,timeouts,filters,moderators,logs}.ts` behind a mounting router. Utilities in `backend/src/utils/`: `logger.ts` (Pino + `logChatEvent`), `metrics.ts`, `health.ts` (liveness/readiness), `idempotency.ts`, `circuitBreaker.ts` (Opossum), `retry.ts`, `audit.ts`.

Frontend is React + TanStack Router + Zustand + Tailwind, with `hls.js` in `VideoPlayer.tsx` and chat state in `stores/chatStore.ts`. Vite proxies `/api` → `localhost:3001` and the WebSocket → `ws://localhost:3001`.

## Key Design Decisions

### 1. Redis pub/sub for chat fan-out, subscribed per channel on demand

When the first client joins a channel, `handleJoin` creates the local room set *and* calls `subscribe('chat:{channelId}')`; when the last client leaves, `handleLeave` unsubscribes. Messages are published to Redis and delivered back to every instance, including the publisher, which then broadcasts to its local sockets.

The alternative — broadcasting directly to the local socket set and skipping Redis — works perfectly on one instance and breaks silently the moment you run two. Viewers connected to instance A see each other; viewers on instance B see each other; neither group sees the other, and there is no error anywhere, just two parallel realities in the same chat room. Since the whole point of the `dev:server1/2/3` pattern in this repo is running multiple instances, the fan-out has to go through a shared bus.

Subscribing lazily per channel rather than to a wildcard matters at scale: an instance with viewers in three channels should not receive the message volume of every channel on the platform just to discard it. The cost of the choice is that Redis pub/sub is fire-and-forget — a message published while a subscriber is momentarily disconnected is simply gone. That's tolerable here precisely because durability is Postgres's job (decision 3), not the bus's.

### 2. The publish path is circuit-broken with a local-broadcast fallback

`redisChatBreaker` wraps `publishMessage` with a 1s timeout, 50% error threshold, 5s reset, volume threshold 10 — and a `.fallback()` that calls `localBroadcast()` and logs "Redis unavailable, using local broadcast only".

Without this, a Redis hiccup makes every chat message await a doomed publish. That's not a chat outage, it's a *process* outage: each of thousands of concurrent chatters holds a pending promise and an open socket while the event loop fills with retries. The breaker converts a hang into a fast failure, and the fallback converts a fast failure into a partial feature — viewers on your instance still see each other's messages. Chat visibly fractures across instances during the outage, which is bad, but it's the correct thing to prefer over a chat that stops entirely. The 1s timeout is deliberately aggressive: for a local Redis publish, anything approaching a second already means something is wrong.

### 3. Messages are written to Postgres *before* being published to Redis

`handleChat` inserts into `chat_messages`, then fires the breaker. The ordering is the point. Reverse it and a crash between publish and insert means viewers saw a message that no longer exists — it won't appear in the 50-message scrollback `handleJoin` serves to the next person who joins, and it can't be moderated after the fact because there's no row to delete. Writing first means the worst case is the opposite: a persisted message that nobody saw live, which the next join will surface. For a moderation-bearing system, "durable but undelivered" is a recoverable state and "delivered but not durable" is not.

The trade-off is that a synchronous Postgres insert now sits in the latency path of every chat message, and it's the slowest thing in `handleChat`. Note the asymmetry this creates: guests can chat but their messages are never inserted (`if (info.userId)` guards the insert), so guest messages are live-only and vanish from scrollback.

### 4. Rate limiting is a single Redis key with `EX`, not a sliding window

`checkRateLimit` reads `ratelimit:{channelId}:{userId}`, compares the stored timestamp against a cooldown, and re-sets the key with an expiry equal to the cooldown. One `GET` plus one `SET` per message.

This is deliberately weaker than the sorted-set sliding windows used elsewhere in this repo, and it's the right weakness here. A sliding window stores one entry per request — at chat volume, in a channel with 100K viewers, that's an enormous number of short-lived sorted-set members whose only purpose is to enforce a rule that can be expressed as "not more often than every N seconds". The cooldown formulation collapses the whole window into one key with a self-cleaning TTL. What we give up is burst tolerance: a sliding window lets someone send 5 messages quickly and then wait, which is exactly how humans actually type in chat; the cooldown enforces strict spacing and will reject the second message of a legitimate double-post. Given that Twitch-style chat *wants* strict spacing (that's what slow mode is), this is a feature more than a cost.

### 5. Dedup runs before rate limiting, and the duplicate is dropped silently

`handleChat` resolves a message ID (client-supplied or generated), calls `checkChatMessageDedup`, and returns without any response if it's a duplicate. Only then does it check the rate limit.

The ordering matters because a retry must not consume rate-limit budget. Consider a client on a flaky connection that sends a message, loses the ack, and resends: with rate limiting first, the retry is rejected as "Slow down!" — the user sees an error for a message that already succeeded, and the UI now has no way to tell whether it went through. With dedup first, the retry is a no-op. The silence is also deliberate: sending an error back would make the client think the message failed. The give-up is that a genuine duplicate is indistinguishable from a bug to anyone reading logs, which is why the drop is logged at debug with the message ID.

## Current State

Runs end to end: API + WebSocket on 3001, session auth with Redis-backed session keys, channel and category browsing, follow and subscription records, a creator dashboard, simulated go-live/go-offline with fluctuating viewer counts and generated HLS manifests, real-time chat with join/leave rooms, 50-message scrollback on join, badges (admin, moderator, subscriber with tier), emote picker, per-user cooldown rate limiting, and message dedup.

Moderation is fully implemented and mounted at `/api/moderation`: permanent and timed bans, timeouts with early removal, channel moderator add/remove, chat filters including **slow mode** and emote-only mode, message deletion, and an audit log (`utils/audit.ts` defines the action vocabulary, including `enable_slow_mode` / `disable_slow_mode`). Ban enforcement runs on the message hot path — `handleChat` checks `channel_bans` with an `expires_at IS NULL OR expires_at > NOW()` predicate before accepting.

Observability: Prometheus `/metrics` with chat-message, rate-limited, and WebSocket-connection counters; `/health`, `/health/live`, `/health/ready` registered after dependencies initialize.

Seeded channels/users include `shroud`, `pokimane`, `xqc`, `ninja` (password `password123`). The screenshot flow runs unauthenticated — `auth.enabled` is `false` in the harness config because the browsable surface doesn't require login.

**Simulated or omitted:** there is no RTMP ingest and no FFmpeg transcoding — `streamSimulator.ts` generates playlist text rather than segments, so `hls.js` has a manifest but no media. Viewer counts are randomized rather than derived from connections. No VOD archival, no clips, no CDN. `handleAuth` trusts the `userId` the client sends over the WebSocket rather than deriving it from the HTTP session — fine for a local demo, and the reason this chat is not safe to expose.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It listed `- [ ] Moderation tools (ban, timeout)` and `- [ ] Slow mode configuration` as unbuilt under "Phase 3: Chat System (Completed)" — while `routes/moderation/` contained five sub-routers covering exactly those features, mounted at `/api/moderation` in `index.ts`, with a full audit-action vocabulary in `utils/audit.ts`. It also duplicated architecture.md's HLS latency budget rather than recording anything about how this implementation actually works.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 tsx watch src/index.ts` to match both Vite proxy targets (`/api` and the `/ws` upgrade). `index.ts` otherwise falls back to `process.env.PORT || 3000` and the proxy lands on nothing. Note that `scripts/screenshot-configs/twitch.json` still declares `"backendPort": 3000`; the harness prefers the config value over the `dev` script, so that entry is stale.
- **Health checks registered after dependency init:** `createHealthChecks({ pool, redis })` needs live clients, so `/health`, `/health/live`, and `/health/ready` are registered inside `start()` after `initDatabase()` and `initRedis()` resolve — not at module load. A readiness probe that reports healthy because it holds an undefined client is worse than no probe.
- **Redis publish wrapped in a breaker with local fallback:** see decision 2. Before this, a Redis stall propagated into every in-flight chat message.
- **Channel subscriptions torn down on empty rooms:** `handleLeave` deletes the local room and unsubscribes when the last client goes, so a long-running instance doesn't accumulate subscriptions to channels nobody is watching.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. `chat_messages` grows without bound and every join reads the most recent 50 rows from it. Is time-partitioning the table the right move, or should the scrollback be served from a capped Redis list per channel with Postgres kept purely for moderation history?
2. Badge resolution costs up to three extra queries per message (role, subscription, moderator). Those change rarely. Should they be resolved once at `auth` time and cached on `clientInfo` — accepting that a ban or mod promotion wouldn't take effect until the user reconnects?
3. Viewer count is currently whatever the simulator wrote to Postgres, while the true count on a single instance is `channelClients.get(id).size`. With multiple instances neither is right. Is a Redis `HINCRBY` per instance with periodic reconciliation good enough, or does an accurate concurrent-viewer number fundamentally require a separate presence service?
4. The `.fallback()` local broadcast makes chat silently inconsistent across instances during a Redis outage. Is silent partial delivery actually better than telling the user "chat is degraded", given that a viewer can't tell the difference between a quiet chat and a broken one?

## Resources

- [Redis pub/sub](https://redis.io/docs/latest/develop/interact/pubsub/) — the fan-out primitive, and its at-most-once delivery semantics
- [ws](https://github.com/websockets/ws) — the WebSocket server attached to the HTTP server at `/ws/chat`
- [hls.js](https://github.com/video-dev/hls.js) — the player consuming the simulated manifests
- [Apple HTTP Live Streaming](https://developer.apple.com/streaming/) — the manifest format `streamSimulator.ts` generates
- [Twitch engineering blog](https://blog.twitch.tv/en/tags/engineering/) — how the real chat fan-out and IRC-derived protocol evolved
