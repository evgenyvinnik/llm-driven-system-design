# Online Chess - Architecture Design

## System Overview

An online multiplayer chess service: players press "Play 3+0", get paired with someone of similar rating within seconds, play a real-time game over WebSockets with server-authoritative clocks, and see their Elo rating change the moment the game ends. Anyone can spectate a live game. The system looks like a chat app with a board, but the hard parts are elsewhere. Every move must be validated and ordered by exactly one authority. A clock that runs in milliseconds has to be fair to a player on a 250 ms mobile connection. A game must survive the server hosting it dying mid-move. And the rating update at the end must happen exactly once, even though the game end is retried.

**Learning goals:**
- Single-owner stateful actors (one game, one owner) with fenced leases and failover
- Fair real-time clocks using server timestamps and bounded lag compensation
- Durable, ordered event logs with sequence numbers for reconnect and gap-fill
- Matchmaking pools whose rating window widens with wait time
- Fan-out to spectators through a gateway tier and sharded pub/sub
- Exactly-once side effects (Elo update) from at-least-once game-end processing

## Requirements

### Functional Requirements

1. **Quick pairing:** a player picks a time control (e.g. 1+0, 3+0, 3+2, 10+0, 15+10) and rated/casual, and is paired with an opponent of similar rating
2. **Direct challenges:** challenge a friend by username or share a challenge link
3. **Real-time play:** only legal moves are accepted, validated on the server; checkmate, stalemate, threefold repetition, the 50-move rule and insufficient material end the game automatically
4. **Game actions:** resign, offer/accept/decline a draw, abort before the first move, claim victory when the opponent has left
5. **Clocks:** base time plus Fischer increment, run by the server, fair to players on slow connections; a player whose clock reaches zero loses (or draws if the opponent cannot mate)
6. **Reconnect:** a page refresh, a network drop or a device switch resumes the game with no lost moves
7. **Spectating:** watch any live game with real-time moves and clocks; a featured "TV" game for the top boards
8. **Ratings:** Elo rating per speed (bullet, blitz, rapid, classical), updated exactly once per rated game
9. **History:** game archive per user, PGN export, rating history chart
10. **Admin:** live view of game-server nodes and their games, matchmaking queue depth, annul a game and revert its rating change

### Non-Functional Requirements

| Property | Target |
|----------|--------|
| Move processing (server) | p99 < 20 ms from arrival at the owner to publish, including the durable append |
| Move delivery (same region) | p99 < 150 ms from the mover's drop to the opponent's render |
| Clock fairness | With RTT ≤ 200 ms, the time charged per move is within ~50 ms of the player's actual think time |
| Durability | No move is lost once the opponent has seen it; no finished result is lost; the rating is applied exactly once |
| Availability | 99.99% for game play; a game-server crash pauses its games for seconds and does not abort them |
| Scale | 180K concurrent games, 1M concurrent WebSocket connections, 24K moves/s at peak |
| Matchmaking | p50 wait < 5 s and p95 < 30 s in popular pools |

### Out of Scope

- Engine-assisted cheating detection (the design emits the events a fair-play pipeline would consume)
- Tournaments, puzzles, server-side analysis, chess variants, correspondence chess
- Chat moderation beyond rate limits

## Capacity Estimation

### Production Scale

Assumptions, used identically in every document of this project:

| Assumption | Value |
|------------|-------|
| Game starts | 100/s average (8.64M games/day), 300/s at peak (3×) |
| Average game | 10 minutes (600 s), 80 plies (40 moves per player) |
| Spectators at peak | 300K connections |
| Lobby and idle connections at peak | 340K |
| Move message | ~200 bytes; ping/pong ~50 bytes |
| Gateway capacity | 50K WebSocket connections per node |

Derived numbers:

| Quantity | Calculation | Result |
|----------|-------------|--------|
| Concurrent games | 100/s × 600 s (Little's law); 3× at peak | 60K average, **180K peak** |
| Players in games (peak) | 180K × 2 | 360K |
| Moves | 60K × 80 / 600 s; 3× at peak | 8K/s average, **24K/s peak** (691.2M/day) |
| Move deliveries to players | 24K × 2 (mover's ack + opponent push) | 48K/s |
| Move deliveries to spectators | 300K × 80 / 600 s | 40K/s |
| Total move traffic | 88K msgs/s × 200 B | 17.6 MB/s ≈ 141 Mbps |
| Pings | players every 2 s: 360K / 2 = 180K/s; others every 25 s: 640K / 25 = 25.6K/s | ≈ 206K/s, ~2.3× the move traffic |
| Concurrent connections (peak) | 360K + 300K + 340K | **1M** |
| Gateway nodes | 1M / 50K | 20 at peak, provision 30 for AZ loss |

Two of these numbers shape the design. First, **heartbeats outnumber moves**: lag measurement needs frequent pings, and pings are handled entirely inside the gateway without touching game logic or Redis. Second, **move processing is cheap**: at ~100 µs of CPU per move (validation, clock math, serialization), 24K moves/s is 2.4 cores. Game servers are sharded for blast radius and failover, not for CPU.

| Component | Sizing |
|-----------|--------|
| Game actor memory | ~20 KB per game (rules-engine instance, move list, clocks, lag state) × 180K = 3.6 GB total |
| Game-server nodes | 20 nodes × ~9,000 games at peak (180 MB each); one crash affects 5% of games |
| Redis hot store | ~4 ops per move × 24K = 96K ops/s → 3 shards (primary + replica) at ~32K ops/s each |
| Redis memory | ~13 KB per live game (state hash ~1 KB + 80 log entries × 150 B) × 180K = 2.34 GB, plus about the same again for finished games kept 10 minutes |
| Matchmaking | 300 pairings/s = 600 players/s; with a 5 s average wait, ~3,000 tickets waiting (Little's law) |
| PostgreSQL writes | 300 game finalizations/s at peak, each one transaction of ~6 row writes |
| Game archive | ~1 KB per game × 8.64M/day = 8.64 GB/day ≈ 3.2 TB/year |
| Rating history | 2 rows × ~100 B per game = 1.73 GB/day ≈ 0.63 TB/year |

### Latency Budget (one move, same region, 80 ms RTT players)

| Step | Time |
|------|------|
| Mover's client → gateway (RTT/2) | 40 ms |
| Gateway → owner node (in-DC RPC) | 1 ms |
| Validate + clock math | 0.1 ms |
| Fenced append to Redis + replica ack (WAIT) | 1–3 ms |
| Publish → opponent's gateway | 1 ms |
| Gateway → opponent (RTT/2) | 40 ms |
| **Total** | **~85 ms** |

### Local Development Scale

Three Node instances, ~20 concurrent games driven by a simulated-player script, a few hundred moves per minute. Postgres and a single Valkey instance handle this trivially. The local goal is to exercise failover, lag compensation and idempotent rating updates, not throughput.

## High-Level Architecture

```
┌──────────────────┐        ┌──────────────────┐
│ Web / Mobile     │        │ CDN              │  static assets, mega-event
│ clients          │───────▶│                  │  spectator stream
└────────┬─────────┘        └──────────────────┘
         │ wss + https (GeoDNS → nearest region)
         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ REGION                                                                           │
│                       ┌──────────────────────┐                                   │
│                       │ L4/L7 Load Balancer  │                                   │
│                       └───┬──────────────┬───┘                                   │
│                      REST │              │ WebSocket                             │
│             ┌─────────────┘              └──────────────┐                        │
│             ▼                                           ▼                        │
│  ┌──────────────────────┐                ┌───────────────────────────┐           │
│  │ API Service          │                │ WebSocket Gateways (×30)  │           │
│  │ auth · seeks ·       │                │ auth · ping/RTT · local   │           │
│  │ history · admin      │                │ fan-out · seq gap-fill    │           │
│  └──────────┬───────────┘                └──────┬─────────────▲──────┘           │
│             │ tickets                  move RPC │             │ events           │
│             ▼                                   ▼             │ (sharded pub/sub)│
│  ┌──────────────────────┐ createGame ┌────────────────────────┬──┐               │
│  │ Matchmaking Service  │───────────▶│ Game Service (×20)        │               │
│  │ one pool actor per   │            │ one actor per game:       │               │
│  │ speed × time control │            │ validate · clocks · lag   │               │
│  └──────────┬───────────┘            │ compensation · flag timer │               │
│             │ pools                  └──────┬─────────────┬──────┘               │
│             │                  append + WAIT│             │ finalizeGame         │
│             ▼                               ▼             │                      │
│  ┌───────────────────────────────────────────────┐        │                      │
│  │ Redis Cluster (3 shards + replicas)           │        │                      │
│  │ game state · move log streams · directory     │        │                      │
│  │ node leases · pools · sessions · pub/sub      │        │                      │
│  └───────────────────────────────────────────────┘        ▼                      │
│                                        ┌───────────────────────────────┐         │
│                                        │ PostgreSQL (primary+replicas) │         │
│                                        │ users · ratings · games ·     │         │
│                                        │ rating_history · outbox       │         │
│                                        └───────────────┬───────────────┘         │
│                                                        │ outbox relay            │
│                                                        ▼                         │
│                                        ┌───────────────────────────────┐         │
│                                        │ Kafka: game.ended             │         │
│                                        └───┬───────────┬───────────┬───┘         │
│                                            ▼           ▼           ▼             │
│                                       Fair-play   Leaderboards  PGN export       │
│                                       analysis    & stats       to S3            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Why a separate gateway tier:** the gateways own sockets and the game service owns games. A game-server crash then pauses games without dropping a million sockets, a gateway crash drops sockets without losing any game state, and spectator fan-out happens in the tier that already holds the connections. The cost is one extra in-datacenter hop (~1 ms) per move.

## Core Components / Request Flows

### Components

| Component | Responsibility | State |
|-----------|----------------|-------|
| WebSocket Gateway | Terminates sockets, authenticates the session, measures RTT with server-initiated pings, routes client commands to the game owner, fans game events out to local sockets, fills sequence gaps from the move log | Per-connection only; reconstructable |
| Game Service | Hosts game actors. Each actor serializes all commands for one game (moves, resign, draw offers, flag), validates with a chess rules engine, runs clocks and lag compensation, appends to the durable log, publishes events | In-memory actor state, checkpointed to Redis on every event |
| Owner directory | `gameId → (nodeId, epoch)` in the game's Redis state hash; node leases with 1 s heartbeats and 5 s TTL | Redis |
| Supervisor | Leader-elected role inside the game service. Detects expired node leases and reassigns their games with a bumped epoch | Redis lock |
| Matchmaking Service | One pool actor per (speed, time control, rated). Ticks every 500 ms, pairs tickets whose rating windows mutually overlap | Tickets in Redis sorted sets, mirrored in memory |
| API Service | Login, profiles, seeks, challenges, game history, PGN export, admin | Stateless; Postgres + Redis |
| PostgreSQL | Users, ratings, finished games, rating history, transactional outbox | Durable source of truth for results |
| Kafka | `game.ended` events for fair-play analysis, leaderboards, PGN export to object storage | Durable stream |

### Flow 1: Find a game

```
Client          API Service       Pool actor          Game node          Gateways
  │ POST /seeks      │                 │                   │                  │
  ├─────────────────▶│ ZADD ticket     │                   │                  │
  │◀──── ticketId ───┤ into Redis pool │                   │                  │
  │                  │                 │ tick every 500 ms │                  │
  │                  │                 │ remove A+B (Lua)  │                  │
  │                  │                 ├──────────────────▶│ createGame       │
  │                  │                 │                   │ (pairingId)      │
  │                  │                 │                   ├─────────────────▶│
  │◀──────────────── game_started {gameId, color} ────────────────────────────┤
```

1. `POST /api/v1/seeks` stores a ticket `{userId, rating, speed, tc, rated, joinedAt}` in the pool's sorted set (score = rating) with a TTL refreshed by the client's heartbeats. One ticket per user; a second seek replaces the first.
2. The pool actor ticks every 500 ms. A ticket's window starts at ±50 rating points, widens by 50 every 5 s and caps at ±500 (reached at 45 s). Two tickets match when their rating difference fits inside **both** windows, so a newcomer's narrow window is never overridden by a long waiter's wide one.
3. Pairing walks tickets oldest first and picks the closest-rated acceptable partner. A Lua script removes both tickets atomically; if either is already gone (cancelled, or paired elsewhere), the pairing is dropped.
4. The pool actor calls `createGame(pairingId)` on the least-loaded healthy game node. `pairing_id` is unique in Postgres, so a retried create returns the same game.
5. Colors alternate based on each player's recent history. `game_started` is pushed to both users via their presence entries.
6. If white makes no move within 30 s (or black within 30 s of white's first move), the game is aborted: no rating change. This disposes of "ghost" pairings from closed tabs.

### Flow 2: Make a move

```
Mover        Gateway A        Owner node (actor)          Redis shard          Gateway B      Opponent
  │ move{ply,uci,  │                 │                          │                   │              │
  │ moveId,think}  │                 │                          │                   │              │
  ├───────────────▶│ RPC to owner    │                          │                   │              │
  │                ├────────────────▶│ 1 turn + ply check       │                   │              │
  │                │                 │ 2 legal? (rules engine)  │                   │              │
  │                │                 │ 3 clock charge + lag comp│                   │              │
  │                │                 │ 4 fenced append ────────▶│ epoch ok? XADD,   │              │
  │                │                 │   WAIT 1 replica ◀───────│ HSET state        │              │
  │                │                 │ 5 SPUBLISH game:{id} ───▶│──────────────────▶│ seq check    │
  │◀── move (ack) ─┤◀────────────────┤                          │                   ├─────────────▶│
```

1. The client sends `{gameId, ply, uci, moveId, clientThinkMs}`; `ply` is the number this move would have.
2. The gateway forwards to the owner from its cached directory entry. The player's color comes from the authenticated session, never from the message.
3. The actor checks turn, ply and legality, computes the charged time (see Flow 3), and builds the event `{seq, ply, uci, san, fen, clocks, moveId}`.
4. A Lua script appends the event to `game:{id}:log` and updates `game:{id}:state` **only if the stored epoch equals the actor's epoch**. Then `WAIT 1 50` waits for the replica.
5. Only after the append does the actor publish. The move is never visible to anyone before it is durable.

### Flow 3: Clocks, lag compensation and flagging

The actor keeps `remaining[white|black]`, `turnStartedAt` (server time when the previous move was published), and per-player lag state: a median RTT over the last 10 server-initiated pings, and a compensation quota.

```ts
// Planned: backend/src/game/lag.ts. Algorithm sketch, not yet written.
const QUOTA_CAP_MS = 2000;   // bucket capacity
const QUOTA_REFILL_MS = 200; // added after every move

function chargedTime(lag: LagState, serverElapsedMs: number, clientThinkMs?: number): number {
  const claimedTransit = clientThinkMs === undefined
    ? lag.rttMedianMs
    : Math.max(0, serverElapsedMs - clientThinkMs);
  const comp = Math.min(claimedTransit, lag.rttMedianMs, lag.quotaMs, serverElapsedMs);
  lag.quotaMs = Math.min(QUOTA_CAP_MS, lag.quotaMs - comp + QUOTA_REFILL_MS);
  return serverElapsedMs - comp;
}
```

- `serverElapsedMs = arrivalTime − turnStartedAt` includes the downlink of the opponent's move, the player's think time and the uplink of this move. Without compensation, a player is charged one full RTT on every move: 200 ms × 40 moves = 8 s, or 4.4% of a 3-minute game.
- Compensation is the smallest of three values: what the client claims was transit, what the server measured, and what the quota allows. A client cannot simply lie, because the server's own RTT measurement caps it. A client that also delays its pongs is capped by the quota: at most 2,000 + 39 × 200 = 9,800 ms over a 40-move game. That is comparable to the 8 s an honest 200 ms connection legitimately receives, and the pattern is flagged for fair-play review.
- An honest 200 ms player consumes 200 and refills 200 per move, so the bucket stays full. A 300 ms player drains it by 100 per move and from about move 19 on pays ~100 ms per move.
- After a move: `remaining[side] = remaining[side] − charged + increment`. If `charged > remaining`, the move is rejected and the game ends on time (a draw if the opponent has insufficient mating material).
- **Flag timer:** the actor arms one timer for the side to move at `turnStartedAt + remaining + grace`, where `grace = min(rttMedian, quota)`, so a move already in flight is not flagged early. Timeouts are always decided by the server; a client showing 0.0 can only nudge the server to check.
- Time inside a node uses a monotonic clock. `turn_started_at` is persisted as wall-clock milliseconds, because a failover moves the game to a node with a different monotonic origin (NTP keeps skew to a few ms).

### Flow 4: Reconnect and resume

1. Every game event carries `seq`, which increases by one per event in that game (moves, draw offers, resign, flag, pause/resume).
2. On reconnect the client sends `resume {gameId, lastSeq}`. The gateway replies with `XRANGE game:{id}:log (lastSeq +` if the log still has those entries, otherwise with a full snapshot `{seq, fen, moves, clocks, turn, status, drawOffer}`.
3. A pending client move is resent with the same `moveId` and `ply`. If the log already holds that `moveId` at that ply, the owner re-acks it instead of applying it twice.
4. The disconnected player's clock keeps running: the server cannot tell a dropped connection from a player using a second device to think. When the absence exceeds 30 s (blitz and slower), the opponent may claim victory. In bullet the clock decides first.

### Flow 5: Spectate

1. Subscribe first, snapshot second: the gateway subscribes to `game:{id}` (one subscription per gateway per game, reference-counted), then reads the snapshot and drops buffered events with `seq ≤ snapshot.seq`. The reverse order loses any move made in between.
2. Each gateway serializes an event once and writes it to all local spectators. A hot game with 100K spectators across 30 gateways is ~3,300 writes per gateway per move.
3. Spectators get **conflated** delivery: if a spectator's socket buffer is backed up, intermediate positions are dropped and only the latest snapshot is sent. Players always get every event.
4. High-stakes games can run with a spectator delay (e.g. 3 plies) to blunt real-time relaying of engine help.

### Flow 6: Game end and rating update

1. The actor detects the end (mate, resign, flag, agreement, abandonment), appends `game_over` to the log, publishes it with the result, and calls `finalizeGame(gameId)`.
2. Finalization runs one Postgres transaction (see [Consistency and Idempotency](#consistency-and-idempotency)): a conditional status update, the Elo update for both players, rating history rows, and an outbox row.
3. The client shows the result immediately and the rating delta once the transaction commits, typically within 10 ms. If Postgres is unavailable, the result is already durable in the Redis log, and a sweeper retries finalization.

Elo: `E_A = 1 / (1 + 10^((R_B − R_A) / 400))`, `R'_A = R_A + K × (S_A − E_A)`, with K = 40 for provisional players (< 30 games), 20 normally, and 10 at 2400+. Example: a 1500 player beats a 1700 player at K = 20. E_A = 1 / (1 + 10^0.5) = 0.24, so A gains 20 × 0.76 ≈ +15 and B loses 15.

## Database Schema

### PostgreSQL

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(30) NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_banned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));

-- One row per user per speed; created lazily on the first rated game.
CREATE TABLE ratings (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  speed        VARCHAR(10) NOT NULL CHECK (speed IN ('bullet', 'blitz', 'rapid', 'classical')),
  rating       INTEGER NOT NULL DEFAULT 1500 CHECK (rating BETWEEN 100 AND 3500),
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  peak_rating  INTEGER NOT NULL DEFAULT 1500,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, speed)
);
CREATE INDEX ratings_leaderboard_idx ON ratings (speed, rating DESC) WHERE games_played >= 30;

-- Row created at pairing (status 'active'), completed by finalizeGame.
-- Live move-by-move state is in Redis; this row holds the archive.
CREATE TABLE games (
  id                  UUID PRIMARY KEY,                  -- UUIDv7, time-ordered
  pairing_id          UUID NOT NULL UNIQUE,              -- idempotent creation
  white_id            UUID NOT NULL REFERENCES users(id),
  black_id            UUID NOT NULL REFERENCES users(id),
  speed               VARCHAR(10) NOT NULL CHECK (speed IN ('bullet', 'blitz', 'rapid', 'classical')),
  base_ms             INTEGER NOT NULL CHECK (base_ms > 0),
  increment_ms        INTEGER NOT NULL DEFAULT 0 CHECK (increment_ms >= 0),
  rated               BOOLEAN NOT NULL,
  status              VARCHAR(10) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'finished', 'aborted', 'annulled')),
  result              VARCHAR(7) CHECK (result IN ('1-0', '0-1', '1/2-1/2')),
  termination         VARCHAR(24) CHECK (termination IN ('checkmate', 'resign', 'timeout',
                        'stalemate', 'repetition', 'fifty_moves', 'insufficient_material',
                        'agreement', 'abandoned', 'aborted', 'timeout_vs_insufficient')),
  moves_uci           TEXT NOT NULL DEFAULT '',          -- space-separated UCI
  clock_ms            INTEGER[] NOT NULL DEFAULT '{}',   -- mover's remaining ms after each ply
  final_fen           TEXT,
  white_rating_before INTEGER,
  black_rating_before INTEGER,
  white_delta         INTEGER,
  black_delta         INTEGER,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  CHECK (white_id <> black_id),
  CHECK ((status = 'finished') = (result IS NOT NULL)),
  CHECK (status = 'active' OR ended_at IS NOT NULL)
);
CREATE INDEX games_white_history_idx ON games (white_id, ended_at DESC);
CREATE INDEX games_black_history_idx ON games (black_id, ended_at DESC);
CREATE INDEX games_active_idx ON games (started_at) WHERE status = 'active';  -- orphan sweeper

-- Primary key doubles as the idempotency guard for rating updates.
CREATE TABLE rating_history (
  game_id       UUID NOT NULL REFERENCES games(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  speed         VARCHAR(10) NOT NULL,
  rating_before INTEGER NOT NULL,
  rating_after  INTEGER NOT NULL,
  k_factor      SMALLINT NOT NULL CHECK (k_factor IN (10, 20, 40)),
  reverted      BOOLEAN NOT NULL DEFAULT FALSE,           -- set when an admin annuls the game
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX rating_history_user_idx ON rating_history (user_id, speed, created_at DESC);

CREATE TABLE challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenger_id UUID NOT NULL REFERENCES users(id),
  challenged_id UUID REFERENCES users(id),                -- NULL = open link challenge
  base_ms       INTEGER NOT NULL CHECK (base_ms > 0),
  increment_ms  INTEGER NOT NULL DEFAULT 0 CHECK (increment_ms >= 0),
  rated         BOOLEAN NOT NULL DEFAULT TRUE,
  color         VARCHAR(6) NOT NULL DEFAULT 'random' CHECK (color IN ('white', 'black', 'random')),
  status        VARCHAR(10) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  game_id       UUID REFERENCES games(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  CHECK (challenged_id IS NULL OR challenged_id <> challenger_id)
);
CREATE INDEX challenges_inbox_idx ON challenges (challenged_id, created_at DESC) WHERE status = 'pending';

-- Transactional outbox: written in the same transaction as the result.
CREATE TABLE outbox_events (
  id           BIGSERIAL PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  event_type   VARCHAR(40) NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX outbox_dedupe_idx ON outbox_events (aggregate_id, event_type);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;
```

At production scale `games` is range-partitioned by month (the UUIDv7 id embeds the timestamp). Partitions older than a year are exported as PGN to object storage and dropped from the hot database.

### Redis (hot game state)

All keys of one game share the hash tag `{gameId}`, so they land on the same cluster shard and Lua scripts can touch them atomically.

| Key | Type | Contents | Lifetime |
|-----|------|----------|----------|
| `game:{id}:state` | Hash | `fen`, `ply`, `seq`, `status`, `white_ms`, `black_ms`, `turn_started_at`, `owner`, `epoch`, `draw_offer` | Deleted 10 min after finalization |
| `game:{id}:log` | Stream | One entry per event: `seq`, `type`, `uci`, `san`, `white_ms`, `black_ms`, `move_id`, `at` | Same |
| `game:{id}` | Sharded pub/sub channel | Live events for gateways | — |
| `node:{nodeId}:lease` | String | Last heartbeat (epoch ms), `PX 5000`, renewed every 1 s | TTL |
| `node:{nodeId}:games` | Set | Games owned by the node, used by failover | Until node retired |
| `mm:pool:{speed}:{tc}:{rated}` | Sorted set | `ticketId` scored by rating | — |
| `mm:ticket:{ticketId}` | Hash | `userId`, `rating`, `joinedAt`, `gatewayId` | 15 s TTL, refreshed by client heartbeat |
| `presence:{userId}` | String | Gateway node holding the user's socket | 60 s TTL, refreshed |
| `session:{sid}` | Hash | `userId`, `role` | 30 days |
| `live:featured` | Sorted set | `gameId` scored by average rating × spectator count | — |

## API Design

### REST Endpoints

```
POST   /api/v1/auth/login                    → Create session (cookie)
POST   /api/v1/auth/logout                   → Destroy session
GET    /api/v1/me                            → Current user + ratings + active game id

POST   /api/v1/seeks                         → Join matchmaking pool → { ticketId }
DELETE /api/v1/seeks/:ticketId               → Leave pool (409 + gameId if already paired)
POST   /api/v1/challenges                    → Challenge a user or create an open link
POST   /api/v1/challenges/:id/accept         → Accept → { gameId }
POST   /api/v1/challenges/:id/decline        → Decline

GET    /api/v1/games/:id                     → Snapshot (live) or archived game
GET    /api/v1/games/:id/pgn                 → PGN export
GET    /api/v1/games/live?sort=featured      → Live games for spectating / TV
GET    /api/v1/users/:username/games         → Game history (cursor-paginated)
GET    /api/v1/users/:username/ratings       → Ratings per speed + history
GET    /api/v1/leaderboard/:speed            → Top players (≥ 30 games)

GET    /api/v1/admin/nodes                   → Game nodes, lease age, game counts
POST   /api/v1/admin/nodes/:id/drain         → Stop new games, migrate live games
GET    /api/v1/admin/matchmaking             → Queue depth and wait percentiles per pool
POST   /api/v1/admin/games/:id/annul         → Annul a game and revert its rating change
```

Example seek request and response:

```json
POST /api/v1/seeks
{ "baseMs": 180000, "incrementMs": 0, "rated": true }

201 Created
{ "ticketId": "8c1e…", "pool": "blitz:3+0:rated", "window": 50 }
```

### WebSocket Protocol (`wss://…/ws`, session cookie on the handshake)

| Direction | Type | Payload |
|-----------|------|---------|
| C → S | `resume` | `{ gameId, lastSeq }` |
| C → S | `move` | `{ gameId, ply, uci, moveId, clientThinkMs }` |
| C → S | `resign` / `draw_offer` / `draw_accept` / `draw_decline` / `abort` / `claim_victory` | `{ gameId }` |
| C → S | `spectate` / `unspectate` | `{ gameId }` |
| S → C | `ping` → C replies `pong` | `{ id }` (server-initiated, used for RTT) |
| S → C | `game_started` | `{ gameId, color, opponent, clocks }` |
| S → C | `move` | `{ gameId, seq, ply, uci, san, fen, clocks: { whiteMs, blackMs }, moveId }` |
| S → C | `move_rejected` | `{ gameId, moveId, reason, snapshot }` |
| S → C | `game_paused` / `game_resumed` | `{ gameId, seq, clocks }` (server failover) |
| S → C | `opponent_status` | `{ gameId, connected, claimableInMs }` |
| S → C | `game_over` | `{ gameId, seq, result, termination, ratingDelta? }` |
| S → C | `snapshot` | full game state (resume, spectate, resync) |

Example move event:

```json
{ "t": "move", "gameId": "0192…", "seq": 37, "ply": 36, "uci": "g1f3", "san": "Nf3",
  "fen": "r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R b KQkq - 3 3",
  "clocks": { "whiteMs": 151240, "blackMs": 148910 }, "moveId": "c7a2…" }
```

Clocks are sent as **durations**, not timestamps. Clients anchor them to their own monotonic clock on receipt, so no client-server clock synchronization is needed.

## Key Design Decisions

### 1. One owner per game: a game actor with fenced ownership

**Chosen:** each live game is an actor on exactly one game-server node. All commands for that game (moves, resignations, draw offers, flag checks) are processed in arrival order by that actor. Ownership is recorded as `(nodeId, epoch)` in the game's Redis state, and every write to the move log checks the epoch.

Chess needs a single total order of events. Resign and checkmate can race, a draw offer can race a move, and a flag can race a move in flight. With one actor the answer is "whichever the actor processed first", and that answer is written to the log before anyone sees it. The actor also owns the per-game timers (flag fall, abort, claim victory) and the per-player lag state, which are awkward to keep anywhere else.

**Alternative rejected: stateless servers with compare-and-set on Redis.** Any server could process any move by reading the state, validating it and writing back with a version check. At 24K moves/s this is feasible, and it removes ownership and failover entirely. It fails on timers: a flag must fire when no message arrives, so something has to own "the clock of game X expires at T". That becomes a distributed delayed-job queue with its own polling latency (a 500 ms poll is a quarter of a bullet player's last two seconds) and its own exactly-once problem. It also costs an extra read round trip per move and needs the lag history reloaded on every move.

**Alternative rejected: sticky sockets straight to the owner.** Routing the players' sockets to the owner node saves the gateway hop. But it couples socket lifetime to game lifetime: a node crash disconnects every player on it at the moment we most need them connected, and spectators (who can number 100K for one game) would pile onto whichever node owns that game.

**Fencing:** a partitioned old owner may still believe it owns a game. The supervisor bumps the epoch before handing the game to a new node, and the append script rejects writes with a stale epoch. The old owner's next move fails and it drops the actor. Nodes also self-fence: one that cannot renew its lease for 4 s stops accepting commands before its 5 s TTL expires.

### 2. Server-timestamped clocks with bounded lag compensation

**Chosen:** the server is the only clock authority, measures elapsed time between its own timestamps, and refunds network transit up to the minimum of the client's claim, the server's RTT measurement and a token-bucket quota (Flow 3).

**Alternative rejected: trust client-reported clocks.** Clients would report their remaining time, and the server would check it for plausibility. The cheat is trivial: report 50 ms of thinking on every move. Plausibility bounds wide enough for real network jitter (hundreds of ms) give a cheater hundreds of ms per move, which decides bullet games.

**Alternative rejected: raw server time, no compensation.** It is simple and impossible to cheat, but it charges every player a full RTT per move. A 250 ms mobile player pays 10 s over 40 moves of a 3+0 game, against an opponent on fiber who pays 0.8 s. That is a systematic penalty by geography.

**What we give up:** a cheater who inflates both pongs and claims can gain up to ~9.8 s per 40-move game, and a legitimately bad connection (300 ms+) is not fully compensated. The quota parameters trade fairness to slow connections against exposure to manipulation, so they are tuned per speed: tighter for bullet, looser for classical.

### 3. Durable hot log in Redis, acknowledged before broadcast

**Chosen:** every accepted event is appended to a per-game Redis Stream on the primary and replicated (`WAIT 1 50`) before it is published or acknowledged. Postgres receives the whole game once, at the end.

**Alternative rejected: write every move to Postgres.** 24K inserts/s at peak is achievable, but it puts a disk commit (2–10 ms, with fsync tails) in front of every move. It also makes Postgres the bottleneck of the real-time path, when its real job is the result and the rating. Writing the game once at the end is 300 transactions/s.

**Alternative rejected: Kafka as the move log.** Kafka with `acks=all` is durable and ordered per partition, but produce latency is typically 5–20 ms. Reading the current state of one game for failover or resume means scanning a partition shared with thousands of other games. Redis gives O(1) state reads and `XRANGE` by sequence for gap-fill.

**What we give up:** Redis replication is asynchronous, and `WAIT` narrows the loss window without closing it. If the primary dies after `WAIT` times out (the replica is unhealthy) and before replication, the last move can be lost. When `WAIT` returns 0 we still proceed, because stalling every game on a shard whose replica is down is worse. We alert and repair the replica. A consensus-replicated log would close the gap at the cost of ~5–10 ms more per move.

### 4. Gateway tier with sharded pub/sub and sequence gap-fill

**Chosen:** the actor publishes each event once to `game:{id}` with Redis 7 sharded pub/sub (`SPUBLISH`). Each gateway that has a player or spectator of that game subscribes once and fans out locally. Every event carries `seq`, and a gateway or client that sees a gap fetches the missing range from the stream.

Classic `PUBLISH` in Redis Cluster broadcasts every message to every node in the cluster. That is fine at 3 shards and wasteful at 30. Sharded pub/sub keeps a channel on the shard that owns its hash slot. Pub/sub is fire-and-forget, so it is used only for latency. Correctness comes from the stream plus sequence numbers.

### 5. Matchmaking: one pool actor per pool, widening mutual windows, 500 ms ticks

**Chosen:** pools are keyed by (speed, time control, rated). Peak load is 300 pairings/s across a few dozen pools, which a single-threaded actor per pool handles easily. Batch ticks pair better than pair-on-arrival: on arrival, the first acceptable partner wins, whereas a tick sees everyone who arrived in the last 500 ms and pairs the closest.

**Alternative rejected: multiple workers scanning one shared sorted set.** Two workers can select the same ticket. The atomic two-ticket removal prevents a double pairing but turns contention into wasted work and retries.

### 6. Finalization and Elo in one Postgres transaction

**Chosen:** the game row, both rating rows, both rating history rows and the outbox event commit together, guarded by `UPDATE games … WHERE status = 'active'`.

**Alternative rejected: an asynchronous rating consumer** reading `game.ended` from Kafka with a processed-events table. It decouples rating from game completion, but the player waits on Kafka lag to see "+15", and it needs its own deduplication. Doing it in the same transaction that records the result gives exactly-once for free. Downstream consumers (leaderboards, fair-play) still get an event, through the outbox.

## Consistency and Idempotency

| Operation | Idempotency mechanism | Retry behavior |
|-----------|----------------------|----------------|
| Seek | One ticket per user per pool (`SET mm:user:{id} ticketId NX` replaces older) | Retried POST returns the existing ticket |
| Pairing | Lua removes both tickets atomically, or neither | A lost race drops the pairing; tickets remain |
| Game creation | `games.pairing_id UNIQUE`; node-side create keyed by `pairingId` | Retried create returns the same `gameId` |
| Move | `(ply, moveId)`: a move for an already-applied ply is re-acked if the stored `moveId` matches, rejected with a snapshot otherwise | Client resends after reconnect with the same `moveId` |
| Move log write | Lua checks `epoch` and `ply = stored ply + 1` | Stale owner gets `STALE_EPOCH` and drops the actor |
| Finalization | `UPDATE games SET status='finished' … WHERE id=$1 AND status='active'`; 0 rows means already done | Any node or the sweeper can retry safely |
| Rating update | Same transaction; `rating_history` PK `(game_id, user_id)` as second guard | Duplicate insert aborts the transaction |
| Outbox publish | At-least-once relay; `(aggregate_id, event_type)` unique; consumers dedupe on `gameId` | Relay re-publishes unconfirmed rows |

The finalization transaction:

```sql
BEGIN;
UPDATE games
   SET status = 'finished', result = $2, termination = $3, moves_uci = $4,
       clock_ms = $5, final_fen = $6, ended_at = $7
 WHERE id = $1 AND status = 'active'
RETURNING white_id, black_id, speed, rated;
-- 0 rows → already finalized: ROLLBACK and return the stored result.

INSERT INTO ratings (user_id, speed) VALUES ($w, $speed), ($b, $speed) ON CONFLICT DO NOTHING;
SELECT user_id, rating, games_played FROM ratings
 WHERE speed = $speed AND user_id IN ($w, $b)
 ORDER BY user_id FOR UPDATE;            -- fixed lock order avoids deadlocks between concurrent games
-- Compute Elo in the application (K by games_played and rating).
UPDATE ratings SET rating = $new, games_played = games_played + 1,
       peak_rating = GREATEST(peak_rating, $new), updated_at = now()
 WHERE user_id = $uid AND speed = $speed;  -- once per player
INSERT INTO rating_history (game_id, user_id, speed, rating_before, rating_after, k_factor) VALUES (…), (…);
UPDATE games SET white_rating_before = …, black_rating_before = …, white_delta = …, black_delta = … WHERE id = $1;
INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1, 'game.ended', $payload);
COMMIT;
```

Ratings use the player's rating **at commit time**, not at game start. A player in two simultaneous games (allowed for correspondence-style challenges) has them applied one after the other under the row lock.

**Annulment:** an admin annul sets `games.status = 'annulled'` and `rating_history.reverted = true`, and subtracts the deltas from `ratings` in one transaction. It does not try to replay later games. Elo deltas are small and later games already used the inflated rating, so a full recomputation is a batch job, not an online operation.

## Security / Auth

- **Sessions:** cookie-based sessions in Redis (`session:{sid}`), checked on the WebSocket handshake and the Origin header verified. No JWTs: revoking a banned player's session must take effect immediately, including on open sockets (the gateway subscribes to `user:{id}:control` for kicks).
- **Authorization:** the color a player may move comes from the session's user id matched against the game's `white_id`/`black_id`. Message fields are never trusted for identity. Spectators cannot send game commands.
- **Validation:** every message is schema-validated (size, types, UCI format) before routing. The rules engine is the only judge of legality.
- **Rate limits:** 20 messages/s per socket (bullet with premoves stays far below this), 10 seeks/min per user, and an abort budget: 3 aborts in 10 minutes means a 5-minute matchmaking cooldown, which stops opponent-shopping.
- **Fair play:** server authority prevents illegal moves and clock manipulation, not engine use. Every finished game is emitted to a fair-play pipeline (move-time statistics, engine-match rates, lag-claim anomalies). Spectator delay is available for titled events.
- **Admin:** `role = 'admin'` on the session, enforced on `/api/v1/admin/*`, and every admin action is audit-logged.

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Why |
|--------|------|--------|-----|
| `chess_move_processing_seconds` | Histogram | `node` | Arrival-to-publish latency, the server's share of the 150 ms budget |
| `chess_redis_append_seconds` | Histogram | `shard` | Fenced append + WAIT, the largest server-side term |
| `chess_wait_replica_timeouts_total` | Counter | `shard` | Moves acknowledged without replica confirmation |
| `chess_active_games` | Gauge | `node` | Load balance across game nodes |
| `chess_ws_connections` | Gauge | `gateway`, `role` (player/spectator/lobby) | Gateway capacity planning |
| `chess_lag_compensation_ms` | Histogram | `speed` | How much transit is refunded |
| `chess_lag_quota_exhausted_total` | Counter | `speed` | Players paying for their lag; also a fair-play signal |
| `chess_matchmaking_wait_seconds` | Histogram | `pool` | Pairing SLO (p50 < 5 s, p95 < 30 s) |
| `chess_matchmaking_queue_depth` | Gauge | `pool` | Liquidity per pool |
| `chess_game_failovers_total` | Counter | `reason` | Node-loss events |
| `chess_failover_pause_seconds` | Histogram | — | Pause seen by players |
| `chess_seq_gap_resyncs_total` | Counter | `source` (gateway/client) | Pub/sub loss rate |
| `chess_finalizations_total` | Counter | `outcome` (applied/duplicate/retry) | Rating idempotency in action |
| `chess_game_end_total` | Counter | `termination`, `speed` | Abort and abandonment rates |

### Alerts

- Move processing p99 > 50 ms for 5 minutes
- Any `chess_wait_replica_timeouts_total` increase (a shard is running without durable replication)
- Matchmaking p95 wait > 30 s in a pool with more than 100 tickets waiting
- Finalization retry backlog > 100 (Postgres trouble)
- Seq-gap resync rate > 1% of events (pub/sub instability)

### Logging and Tracing

Structured JSON logs (Pino) carry `gameId`, `seq`, `ply`, `nodeId` and `epoch` on every game event, so one game's history can be reconstructed across a failover. A trace spans gateway → owner → Redis → publish for 1% of moves.

### Health Checks

- `/health/live`: the process is up
- `/health/ready`: gateway: Redis reachable; game node: Redis reachable **and** the node lease is held. A node without its lease must not receive new games.

## Failure Handling

| Failure | Detection | Response | Player experience |
|---------|-----------|----------|-------------------|
| Game node crash | Lease not renewed for 5 s | Supervisor reassigns the node's games with epoch + 1, spread across survivors | `game_paused`, then `game_resumed` ~5–6 s later; no move lost |
| Game node partitioned (alive) | Cannot renew lease | Self-fences after 4 s; any write after reassignment fails on epoch | Same as crash |
| Gateway crash | Sockets close | Clients reconnect through the LB to another gateway and `resume` | Brief "reconnecting", clock running |
| Redis shard primary loss | Replica promoted by cluster failover | Actors retry appends with backoff (≤ 2 s) while their games pause | Pause; at worst the last unreplicated move is lost (see decision 3) |
| Pub/sub message loss | Seq gap at gateway or client | `XRANGE` from the last seen seq | Invisible |
| Postgres unavailable | Circuit breaker opens | Game ends normally from the Redis log; finalization queued and retried by the sweeper | Result shown, "rating update pending" |
| Matchmaker crash | Pool lock lease expires | Another instance takes the pool; tickets are already in Redis | Wait grows by a few seconds |
| Region loss | Health checks / GeoDNS | Clients re-home to the next region; games resume from the async cross-region log replica, or are aborted unrated if the replica is behind what players saw | Pause or unrated abort |

### Game Server Failure Mid-Game (in detail)

1. Node X stops renewing `node:X:lease`. After 5 s the key expires.
2. The supervisor (leader via a Redis lock) reads `node:X:games` (~9,000 games at peak) and spreads them across the 19 survivors, ~474 games each. For each game, a Lua script sets `owner = newNode` and `epoch = epoch + 1`, but only if `owner` is still X.
3. Each new owner reads `game:{id}:state` (pipelined; under a second for ~474 games) and rebuilds the actor from the stored FEN and clocks. It does not replay the whole move list.
4. **Clock rule:** the side to move is charged only up to X's last recorded heartbeat (`lastHeartbeat − turn_started_at`). The pause after that is not charged. A crash costs the side to move at most the ~1 s heartbeat interval of free thinking time, and never time on the clock.
5. The new owner appends `game_resumed {clocks}`, publishes it, and re-arms the flag timer. Gateways see the new owner in the event and update their route cache. A client move that was in flight to X is resent with its `moveId` and accepted once.

### Circuit Breakers (Opossum)

- Around Postgres in `finalizeGame` and the API's history queries. While open, finalizations go to the retry queue rather than blocking the actor.
- Around `createGame` from the matchmaker to a game node. A failing node is skipped for new games.
- **Not** around the Redis append on the move path. With Redis unavailable, the correct behavior is to pause the game (fail-closed), not to accept moves that are not durable.

## Scalability Considerations

### Horizontal Scaling

- **Gateways:** stateless apart from sockets. Scale on connection count (50K per node).
- **Game nodes:** new games go to the least-loaded node. Live games never move unless a node is drained or fails, which is why the directory is explicit rather than a consistent-hash ring. Adding a node to a ring would migrate live games.
- **Redis:** shard by `{gameId}` hash tag. Adding shards migrates slots, which Redis Cluster does online.
- **Matchmaking:** pools are independent; shard them across instances by pool key.
- **PostgreSQL:** 300 write transactions/s fits one primary. Reads (history, profiles, leaderboards) go to replicas and caches.

### What Breaks First

1. **Hot-game fan-out:** a world-championship game with 1M spectators is 1M writes per move. Beyond ~100K spectators, spectating moves to a relay tier, or to a CDN-cached stream with a 1–2 s delay that viewers do not notice.
2. **Redis pub/sub at higher shard counts:** classic `PUBLISH` scales with total cluster size, which is why sharded pub/sub is in the design from the start.
3. **Gateway connection memory:** at 10× (10M connections) we need ~200 gateway nodes. Lobby connections can drop to SSE or polling to cut the socket count.
4. **Archive growth:** 3.2 TB/year of games is fine. At 10× (32 TB/year), monthly partitions and PGN export to object storage become mandatory.

Move processing itself (2.4 cores at peak) is far from the bottleneck even at 10×.

### Multi-Region

Each region runs the full stack apart from accounts and ratings, which live in one primary region with read replicas everywhere. 300 rating transactions/s tolerate a cross-region write. Pools are regional first and widen to cross-region after 15 s for rare ratings. A cross-region game is hosted in the region that minimizes the worse player's RTT.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Game authority | Single-owner actor with fenced epoch | Stateless servers + CAS on Redis | One total order per game and owned flag timers |
| Socket topology | Gateway tier + RPC to owner | Sticky sockets to the owner node | Node failure doesn't drop sockets; fan-out in the gateways |
| Owner placement | Explicit directory + node leases | Consistent hashing ring | Membership changes don't migrate live games |
| Clock authority | Server timestamps + bounded lag compensation | Client-reported clocks | Can't be cheated by claiming short think times |
| Lag compensation cap | min(claim, measured RTT, quota) | Uncapped refund of claimed transit | Bounds abuse to ~9.8 s per 40 moves |
| Move durability | Redis Stream + WAIT before publish | Postgres insert per move | ~1–3 ms vs disk commit; Postgres sees one write per game |
| Event delivery | Sharded pub/sub + seq gap-fill from stream | Reliable per-subscriber queues | Low latency; correctness from sequence numbers |
| Matchmaking | Per-pool actor, 500 ms ticks, mutual widening window | Pair on arrival with shared workers | Better pairs, no ticket contention |
| Rating update | Same Postgres transaction as the result | Async Kafka consumer | Exactly-once without separate dedupe; instant "+15" |
| Redis outage on move path | Pause the game (fail-closed) | Accept non-durable moves | A move the opponent saw must never disappear |
| Spectator delivery | Conflated, latest-state-wins | Every event like players | Slow spectators can't build up backlogs on a gateway |

## Implementation Notes

Nothing in this project is implemented yet. This section describes the **planned** local build and how it maps onto the production design above. All paths below are planned, not existing.

### Planned Local Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Local machine                                                        │
│                                                                      │
│  ┌──────────────┐     ┌──────────────────────┐                       │
│  │ Frontend     │────▶│ LB (nginx or Node    │                       │
│  │ Vite :5173   │     │ proxy) :3000         │                       │
│  └──────────────┘     └──┬────────┬───────┬──┘                       │
│                          ▼        ▼       ▼                          │
│               ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│               │ chess-1  │ │ chess-2  │ │ chess-3  │  gateway + game │
│               │ :3001    │ │ :3002    │ │ :3003    │  node + API     │
│               └────┬─────┘ └────┬─────┘ └────┬─────┘  (one process)  │
│                    └────────────┼────────────┘                       │
│                    ┌────────────┴───────────┐                        │
│                    ▼                        ▼                        │
│             ┌─────────────┐          ┌─────────────┐                 │
│             │ Valkey      │          │ PostgreSQL  │                 │
│             │ :6379       │          │ :5432       │                 │
│             └─────────────┘          └─────────────┘                 │
└──────────────────────────────────────────────────────────────────────┘
```

Each of the three instances plays all three roles (gateway, game node, API), which is how the brief's "three Node WebSocket servers coordinated through Redis" maps onto the production split. A WebSocket landing on chess-1 for a game owned by chess-3 exercises the same gateway → owner path as production: an internal HTTP call to the owner, with events back over Valkey sharded pub/sub. Matchmaking runs in whichever instance holds the `mm:leader` lock. Killing chess-2 with `kill -9` exercises lease expiry, reassignment and the clock rule.

### Production-Grade Patterns Planned

| Pattern | Planned location | Why it matters at scale |
|---------|------------------|-------------------------|
| Fenced ownership + node leases | `backend/src/game/ownership.ts` (planned) | Prevents two nodes from both accepting moves for one game after a partition |
| Lag compensation token bucket | `backend/src/game/lag.ts` (planned) | Fair clocks without trusting the client |
| Idempotent moves `(ply, moveId)` | `backend/src/game/actor.ts` (planned) | Reconnect and failover retries never double-apply a move |
| Idempotent finalization | `backend/src/rating/finalize.ts` (planned) | Exactly-once Elo despite retried game ends |
| Circuit breaker (Opossum) | `backend/src/shared/circuit-breaker.ts` (planned) | Postgres trouble delays ratings instead of stalling actors |
| Prometheus metrics (prom-client) | `backend/src/shared/metrics.ts` (planned), `GET /metrics` | The histograms and counters listed under Observability |
| Structured logging (Pino) | `backend/src/shared/logger.ts` (planned) | `gameId`/`seq`/`epoch` on every line for cross-node reconstruction |
| Health checks | `/health/live`, `/health/ready` (planned) | Readiness tied to holding the node lease |
| Rate limiting | `backend/src/gateway/rate-limit.ts` (planned) | Per-socket message budget, seek and abort limits |

A planned snippet of the fenced append, to show the pattern:

```lua
-- Planned: backend/src/game/append.lua
-- KEYS[1] = game:{id}:state   KEYS[2] = game:{id}:log
-- ARGV: epoch, ply, seq, event fields...
if redis.call('HGET', KEYS[1], 'epoch') ~= ARGV[1] then
  return redis.error_reply('STALE_EPOCH')
end
if tonumber(redis.call('HGET', KEYS[1], 'ply')) + 1 ~= tonumber(ARGV[2]) then
  return redis.error_reply('PLY_CONFLICT')
end
redis.call('XADD', KEYS[2], '*', 'seq', ARGV[3], 'uci', ARGV[4], 'white_ms', ARGV[5], 'black_ms', ARGV[6], 'move_id', ARGV[7])
redis.call('HSET', KEYS[1], 'ply', ARGV[2], 'seq', ARGV[3], 'fen', ARGV[8],
           'white_ms', ARGV[5], 'black_ms', ARGV[6], 'turn_started_at', ARGV[9])
return 'OK'
```

### Simplified or Simulated

| Production | Local plan | Impact |
|------------|------------|--------|
| 30 gateways + 20 game nodes | 3 combined instances on 3001–3003 | Same code paths, small numbers |
| Redis Cluster, 3 shards + replicas | Single Valkey; `WAIT` returns 0 and is logged | Replica durability not exercised |
| Kafka for `game.ended` | Outbox relay worker that logs and marks rows published | Outbox pattern exercised without a broker |
| Real players over real networks | Simulated-player script (random legal moves, configurable think time) plus a per-socket artificial delay to emulate RTT | Lag compensation measurable on localhost |
| Rules engine | chess.js on server and client | Same rules code on both sides |
| Multi-region, GeoDNS | One region | Region failover described, not built |

### Omitted

- Fair-play/engine detection, tournaments, puzzles, analysis board
- CDN and relay tier for mega-event spectating
- Kubernetes, autoscaling, multi-region replication
- Glicko-2 (Elo only, as the prompt specifies; Glicko-2's rating deviation would be the next step)
