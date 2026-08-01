# r/place — Collaborative Real-time Pixel Canvas — Development with Claude

## Project Context

A shared pixel canvas: every user can place one colored pixel at a time (subject to a cooldown), and every placement must appear on everyone else's screen in near-real-time. The hard problems are all about *fan-out and hot state* — a single canvas is a global shared object that thousands of clients read and write concurrently, so the design lives or dies on how fast a write propagates and how cheaply the canvas can be read.

**Learning goals:** real-time synchronization (WebSocket + pub/sub) across horizontally-scaled servers, atomic hot-state storage in Redis, race-free rate limiting, and keeping durable history off the write hot path.

## Architecture at a Glance (what actually runs)

Three infrastructure services in `docker-compose.yml`, each with a sharply different job:

| Store | Role | Why this one |
|-------|------|--------------|
| **Valkey/Redis** (`ioredis`) | Canvas byte array (`SETRANGE`), rate-limit cooldowns, sessions, **and pub/sub** for cross-server broadcast | In-memory + atomic byte ops = the only thing fast enough for the read/write hot path; pub/sub fans placements to every server |
| **PostgreSQL** (`pg`) | Pixel-event history + snapshots (durable record for timelapse/analytics) | The provable "who placed what, when" log — durability the ephemeral canvas doesn't provide |
| **RabbitMQ** (`amqplib`) | Queue of pixel events consumed by the persistence worker | Decouples durable writes from the WebSocket path so a DB slowdown never stalls pixel placement |

Backend: Express + a `ws` WebSocket server (`websocket.ts`), routes `auth`/`canvas`, services `canvas`/`redis`/`database`/`auth`, a standalone `workers/persistence-worker.ts`, shared `circuitBreaker` (Opossum), `metrics` (prom-client), `logger` (pino). Frontend: React 19 + Zustand + Tailwind, HTML5 Canvas with zoom/pan, 16-color palette, cooldown timer. Runs as 1–3 instances (`dev:server1..3`).

## Key Design Decisions

### 1. Canvas as a single Redis byte array, updated with SETRANGE
The 500×500 canvas is one Redis value (250 KB, one byte per pixel = a palette index). A placement is `SETRANGE canvas:main (x + y*width) colorByte` — an atomic byte write, no read-modify-write, no lock. A full read is a single `GET`. Trade-off given up: a single key can't be sharded, so a much larger canvas would need a tile-based scheme (many keys) — but at this size one key is simplest and fastest, and there's no concurrency bug possible on an atomic single-byte write.

### 2. WebSocket for clients + Redis pub/sub between servers
Clients hold a WebSocket; when a pixel lands, the receiving server writes Redis then `PUBLISH`es to `canvas:updates`, and *every* server (subscribed to the same channel) pushes it to its own connected clients. This makes horizontal scaling linear — a new server just subscribes and serves its own sockets. Why not Kafka: pixel updates are ephemeral; a client that missed updates just refetches the whole 250 KB canvas on reconnect, so Kafka's durable, ordered streams buy nothing but broker/partition/offset operational cost. What we give up: pub/sub has no replay, so a disconnected client has a gap — mitigated by the full-canvas refetch on reconnect.

### 3. Rate limiting via `SET NX EX` cooldown
The per-user cooldown is a single atomic `SET cooldown:{userId} 1 NX EX {seconds}`: it succeeds only if no key exists, and auto-expires. That check-and-set is race-free without a lock, so two rapid clicks can't both slip through. Trade-off: it's a simple fixed cooldown, not a sliding window or token bucket — fine for "one pixel every N seconds," but a burst-tolerant policy would need a different structure.

### 4. Async, batched persistence off the hot path
Placement writes Redis and enqueues a pixel event to RabbitMQ; the persistence worker consumes and **batch-inserts** (100 events / 1s window) into Postgres. The WebSocket path never touches Postgres, so history durability and analytics can't slow down or fail pixel placement. Trade-off: history is eventually-consistent with the live canvas (up to a batch window behind) — acceptable because the canvas of record is Redis and Postgres is for replay/timelapse, not live rendering.

### 5. Session auth with anonymous guests
Redis-backed sessions (bcryptjs, cookie-parser) plus an anonymous-guest path (`POST /api/auth/anonymous`) that mints a session with a unique user ID. Lowering the friction to place a pixel is the whole point of r/place. Trade-off: anonymous identities don't persist across sessions, so cooldown evasion by dropping a session is possible — accepted for a demo.

## Current State

Implemented end to end: Express + `ws` WebSocket server, canvas stored as a Redis byte array with atomic `SETRANGE`, cross-server broadcast via Redis pub/sub, `SET NX EX` cooldown rate limiting, session auth with anonymous guests, RabbitMQ + batching persistence worker writing pixel history to Postgres, Opossum circuit breakers, Prometheus metrics (incl. circuit-breaker state and persistence counters), pino logging, and a React canvas UI with zoom/pan, 16-color palette, and a live cooldown timer. Seed data creates `alice`/`bob` (+ an admin) with password `password123`. Runs as 1–3 instances behind the same Redis channel.

Intentionally omitted / simulated: a timelapse viewer UI, canvas moderation/reset tooling, WebSocket message batching for extreme update rates, a tile-sharded canvas for larger dimensions, and multi-region. The canvas is fixed at 500×500 locally.

## Iteration & Repair Log

- **2026-07 (CLAUDE.md rewrite):** Replaced the template phase checklist (Phase 3 "Scaling" / Phase 4 "Polish" marked *Not started* while the features were already built) with an accurate Current State plus the Architecture table and this log. Added the RabbitMQ + persistence-worker decision the old file omitted. Kept the (correct) canvas-storage, pub/sub, rate-limit, and auth reasoning.
- **Persistence worker:** confirmed to batch-insert pixel events (batch 100 / 1s) from RabbitMQ into Postgres — a durability path deliberately kept off the WebSocket hot path.
- **Repo-wide fixes that touched this project:** schema-apply via `db/migrate.ts` + `npm run db:migrate` (also mounted at `docker-entrypoint-initdb.d`) and `db:seed`; seed users normalized to `password123`; DB/Redis/RabbitMQ connection-string fallbacks to the docker-compose creds (`rplace`/`rplace_dev`, RabbitMQ `guest:guest`); `pino`/pino-pretty logging.
- **2026-07-31 — the canvas was blank, which is the one thing r/place must not be.** The canvas is a **Redis byte array**, not a Postgres table, so `db/seed.ts` — which only opens a `pg` pool — could never put a pixel on it. A freshly seeded stack rendered 250,000 white pixels. Added `db/seed-canvas.ts`, chained into `db:seed`, which paints starting artwork (an "R/PLACE" banner drawn from a 5×7 bitmap font, a colour bar, a heart, a contested checkerboard, a bordered block, and ~400 scattered single pixels) and inserts the matching `pixel_events` rows so the durable history agrees with the live canvas — a canvas with no history behind it would misrepresent what the persistence worker does.
  - It writes the whole 250 KB key with one `SET` rather than 4,000 `SETRANGE` calls. Per-pixel atomic writes are right for the *app*, where each placement is independent and concurrent; a bulk initial paint has no concurrency to protect against and one round trip is far cheaper.
- **Screenshots:** 2 → 3, adding a zoomed view. At 100% one canvas pixel is one screen pixel, so a 500×500 canvas is a postage stamp in the corner of a 1440px viewport — the art is only legible zoomed in.
- **CI:** the repo-wide smoke-test workflow was removed (no Docker services in CI).

## Open Questions

1. Should high-frequency WebSocket updates be batched (coalesce N placements into one frame) to cut client render churn during a hot event?
2. What's the optimal snapshot interval for timelapse — periodic full-canvas snapshots vs. replaying the pixel-event log, and where does each win on storage vs. reconstruction cost?
3. Every server processes every pub/sub message even for pixels no local client is viewing — at what scale does viewport-scoped subscription (or regional channels) become worth the complexity?
4. Anonymous guests can evade cooldown by dropping their session — is IP/device fingerprinting worth it, or does that undermine the low-friction design?

## Resources

- [Reddit r/place: how we built it](https://www.reddit.com/r/place/)
- [Redis SETRANGE / bitfields](https://redis.io/commands/setrange/) and [Pub/Sub](https://redis.io/docs/manual/pubsub/)
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
