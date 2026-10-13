# Online Chess — System Design Answer (Backend Focus)

*60-minute system design round · Backend / Staff engineer · "Design an online multiplayer chess service: Elo matchmaking, WebSocket moves, game clocks"*

## 🎯 Introduction (2 minutes)

> "Chess looks like a chat app with a board. A move is a 200-byte message and only a few hundred thousand games run at once, so raw throughput is not the problem. Four other things are. First, every game needs exactly one authority that orders moves, resignations, draw offers and flag falls, even when the server holding that authority dies mid-game. Second, the clocks run in milliseconds, but players sit 20 ms or 300 ms away from us, and a naive server clock charges the slow player for the network. Third, matchmaking has to trade pairing quality against wait time. Fourth, the rating update at the end must happen exactly once, although game-end processing will be retried. I'll spend most of the time on those four."

---

## 📋 Requirements Clarification (4 minutes)

### Clarifying questions

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Real-time only, or correspondence too? | Correspondence games last days and need no clock fairness | Real-time: bullet, blitz, rapid, classical |
| Rated games? | Ratings make cheating and idempotency matter | Yes, Elo per speed |
| Spectators? | Changes the fan-out profile | Yes, including featured games with 100K viewers |
| Mobile clients on bad networks? | Drives lag compensation and reconnect | Yes, RTT up to ~300 ms |
| Anti-cheat (engine detection)? | Large separate system | Out of scope; we emit the events it needs |

### Functional requirements

1. Quick pairing by time control with rating-based matchmaking, plus direct challenges
2. Server-validated legal moves; automatic end on mate, stalemate, repetition, 50-move rule, insufficient material
3. Resign, draw offer/accept, abort before the first move, claim victory over a departed opponent
4. Server-authoritative clocks with increment, fair across network latency
5. Reconnect after a refresh or network drop with no lost moves
6. Spectate live games in real time
7. Elo rating per speed, updated exactly once per rated game; game history and PGN export

### Non-functional requirements

| Property | Target |
|----------|--------|
| Server move processing | p99 < 20 ms, including a replicated durable append |
| End-to-end move delivery | p99 < 150 ms within a region |
| Clock fairness | With RTT ≤ 200 ms, charged time per move within ~50 ms of real think time |
| Durability | A move the opponent has seen is never lost; a rating is applied exactly once |
| Availability | 99.99%; a game-server crash pauses its games and does not abort them |
| Matchmaking | p50 wait < 5 s, p95 < 30 s in popular pools |

---

## 📊 Capacity Estimation (4 minutes)

> "Let me size it so we know what's expensive. I'll assume 100 game starts per second on average, which is 8.64 million games a day, in line with the largest real chess sites. Peak is 3×."

| Quantity | Calculation | Result |
|----------|-------------|--------|
| Average game | assumption | 10 min, 80 plies (40 moves each) |
| Concurrent games | 100/s × 600 s, ×3 at peak | 60K avg, **180K peak** (360K players) |
| Moves/s | 60K × 80 / 600 s, ×3 at peak | 8K avg, **24K peak** |
| Player deliveries | 24K × 2 (mover ack + opponent) | 48K/s |
| Spectator deliveries | assume 300K spectators × 80 / 600 s | 40K/s |
| Move bandwidth | 88K msgs/s × 200 B | 17.6 MB/s ≈ 141 Mbps |
| Pings | 360K players every 2 s + 640K others every 25 s | ≈ 206K/s |
| Connections | 360K players + 300K spectators + 340K lobby | **1M** |
| Gateways | 1M / 50K per node | 20 at peak, 30 provisioned |
| CPU for moves | 24K × ~100 µs (validation + clock math) | 2.4 cores |
| Redis | ~4 ops per move × 24K | 96K ops/s → 3 shards |
| Matchmaking | 300 pairings/s × 2 players × 5 s avg wait | ~3,000 tickets waiting |
| Game archive | 1 KB × 8.64M/day | 8.64 GB/day ≈ 3.2 TB/year |

> "Two numbers stand out. Heartbeats are 2.3× the move traffic, because measuring each player's lag needs a ping every 2 seconds. So pings must terminate in the gateway and never touch game logic. And move processing is 2.4 cores for the whole planet. I'm going to shard game servers for blast radius and failover, not for CPU: 20 game nodes at ~9,000 games each means a crash touches 5% of games."

---

## 🏗️ High-Level Architecture (6 minutes)

```
┌─────────────┐  wss   ┌──────────────────────┐   move RPC   ┌──────────────────────┐
│ Clients     │───────▶│ WebSocket Gateways   │─────────────▶│ Game Service (×20)   │
│ web/mobile  │◀───────│ (×30) auth · pings · │◀── events ───│ one actor per game   │
└──────┬──────┘        │ fan-out · gap-fill   │  (sharded    │ rules · clocks · lag │
       │ https         └──────────┬───────────┘   pub/sub)   └──┬────────────────┬──┘
       ▼                          │ presence, directory         │ fenced append  │ finalize
┌─────────────┐                   ▼                             ▼ + WAIT         ▼
│ API Service │       ┌───────────────────────────────────────────────┐  ┌──────────────┐
│ seeks · auth│──────▶│ Redis Cluster: game state · move log streams  │  │ PostgreSQL   │
│ history     │       │ owner directory · leases · pools · pub/sub    │  │ ratings ·    │
└─────────────┘       └───────────────────────▲───────────────────────┘  │ games ·      │
                                              │                          │ outbox       │
                                   ┌──────────┴───────────┐  createGame  └──────┬───────┘
                                   │ Matchmaking: one     │──▶ Game Service     │ relay
                                   │ pool actor per pool  │                     ▼
                                   └──────────────────────┘             Kafka game.ended
                                                                        → fair-play, stats
```

| Component | Responsibility |
|-----------|----------------|
| WebSocket Gateway | Owns sockets: session auth, server-initiated pings for RTT, routing commands to a game's owner, local fan-out, sequence gap-fill |
| Game Service | Hosts game actors: one single-threaded owner per game that validates, runs clocks, appends to the log, publishes |
| Redis Cluster | Hot game state and per-game move log (streams), owner directory, node leases, matchmaking pools, sessions, sharded pub/sub |
| Matchmaking | One pool actor per (speed, time control, rated) that pairs every 500 ms |
| PostgreSQL | Users, ratings, finished games, rating history, transactional outbox |
| Kafka | `game.ended` for fair-play analysis, leaderboards, PGN archive |

> "The key structural choice is that gateways own sockets and game nodes own games. If a game node dies, a million sockets stay up and I can pause and resume its games. If a gateway dies, clients reconnect elsewhere and no game state is lost. The price is one extra 1 ms hop inside the datacenter."

### One move, end to end

1. The client sends a move with the game id, the ply number this move would become, the UCI string, a client-generated move id, and its measured think time.
2. The gateway forwards it over RPC to the game's owner, taken from its cached directory entry. The player's color comes from the authenticated session, never from the message.
3. The actor checks turn and ply, validates legality with the rules engine, and computes the charged time with lag compensation.
4. A Lua script appends the event to the game's Redis stream and updates its state hash, only if the stored ownership epoch matches. Then the actor waits for one replica to confirm (`WAIT`).
5. Only then does it publish to the game's channel. Every gateway with a player or spectator of that game pushes the event. The total is ~85 ms for two players with 80 ms RTT, of which the server takes ~3 ms.

---

## 💾 Data Model (3 minutes)

### PostgreSQL (durable results)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username, password_hash, role, is_banned | unique lower(username) | Session auth |
| ratings | (user_id, speed) PK, rating, games_played, peak_rating | (speed, rating desc) where games ≥ 30 | One row per speed, created lazily |
| games | id (UUIDv7 PK), pairing_id (unique), white_id, black_id, speed, base_ms, increment_ms, rated, status, result, termination, moves_uci, clock_ms[], final_fen, rating before/delta per side | (white_id, ended_at), (black_id, ended_at), partial on status = active | Created at pairing, completed at the end; monthly partitions at scale |
| rating_history | (game_id, user_id) PK, rating_before, rating_after, k_factor, reverted | (user_id, speed, created_at) | The PK is the second idempotency guard |
| challenges | id, challenger_id, challenged_id (null = open link), time control, color, status, game_id | (challenged_id) where pending | Direct challenges |
| outbox_events | id, aggregate_id, event_type, payload, published_at | unique (aggregate_id, event_type); partial on unpublished | Written in the result transaction |

### Redis (hot state, one hash tag per game)

| Key | Type | Purpose |
|-----|------|---------|
| game state | Hash | FEN, ply, seq, status, both clocks, turn start time, owner node, epoch, pending draw offer |
| game log | Stream | One entry per event with seq; source for resume and gap-fill |
| game channel | Sharded pub/sub | Live events to gateways |
| node lease | String, 5 s TTL | Heartbeat every 1 s; its value is the last heartbeat time |
| node's games | Set | What to reassign when the node dies |
| matchmaking pool | Sorted set by rating | Tickets waiting in one pool |
| ticket | Hash, 15 s TTL | Refreshed by the client heartbeat so closed tabs drop out |

> "Postgres sees a game twice: once at pairing and once at the end. That's 300 writes per second at peak instead of 24,000. Move-by-move state lives in Redis because the real-time path needs a 1 ms durable append, not a disk commit."

---

## 🔌 API Design (2 minutes)

```
POST   /api/v1/seeks                    → Join a pool → ticketId
DELETE /api/v1/seeks/:ticketId          → Leave a pool (409 + gameId if already paired)
POST   /api/v1/challenges               → Challenge a user or create an open link
POST   /api/v1/challenges/:id/accept    → Accept → gameId
GET    /api/v1/games/:id                → Live snapshot or archived game
GET    /api/v1/games/:id/pgn            → PGN export
GET    /api/v1/games/live               → Live games for spectating
GET    /api/v1/users/:name/ratings      → Ratings and history
GET    /api/v1/admin/nodes              → Game nodes, lease age, game counts
POST   /api/v1/admin/games/:id/annul    → Annul a game and revert its rating change
```

| WebSocket message | Direction | Purpose |
|-------------------|-----------|---------|
| resume (gameId, lastSeq) | client → server | Replay missed events or get a snapshot |
| move (gameId, ply, uci, moveId, clientThinkMs) | client → server | Make a move |
| resign / draw_offer / draw_accept / abort / claim_victory | client → server | Game actions, ordered by the actor with moves |
| ping / pong | server → client → server | Server-initiated RTT measurement |
| move (seq, ply, san, fen, clocks) | server → clients | Authoritative event |
| move_rejected (reason, snapshot) | server → client | Illegal, stale ply, or game over |
| game_paused / game_resumed | server → clients | Owner failover in progress / done |
| game_over (result, termination, ratingDelta) | server → clients | End of game |

> "Clocks travel as durations, never timestamps. The client anchors them to its own monotonic clock when the message arrives, so I never need to synchronize client and server clocks."

---

## 🔧 Deep Dive 1: One Owner per Game, and Server Failure Mid-Game (9 minutes)

### The decision

Each live game is an actor on exactly one game-server node. The actor processes every command for its game in arrival order. Ownership is stored in the game's Redis hash as a node id plus an epoch. Every log append runs a script that rejects the write when the epoch is not the current one.

### Why one owner works for chess

Chess events race all the time: a resignation against a checkmating move, a draw offer against a move, a flag falling while a move is in flight. With one actor, the order is simply "whatever the actor processed first", and that order is written to the log before anyone sees it. The actor also owns the per-game timers: the flag timer, the 30-second abort timer, and the claim-victory timer. And it holds the per-player lag history that clock fairness depends on.

Placement is explicit: at pairing, the matchmaker asks the least-loaded healthy node to create the game. Gateways look up the owner in the directory and cache it.

> "I deliberately use a directory instead of a consistent-hash ring. With a ring, adding a node moves a slice of keys, and here the keys are live games with running clocks. With a directory, new nodes only get new games, and a live game moves only when its node drains or dies."

### How the alternatives break

**Stateless servers with compare-and-set on Redis.** Any server reads the game state, validates the move and writes back with a version check. At 24K moves/s this is feasible, and it deletes the whole ownership problem. It breaks on time. A flag must fall when *nothing* arrives, so someone must own "game X's clock expires at T". That becomes a distributed delayed-job queue. A 500 ms polling interval is a quarter of a bullet player's last two seconds, and the timeout itself now needs exactly-once processing. Each move also pays an extra read round trip and reloads the lag history.

**Sticky sockets routed straight to the owner node.** This saves the gateway hop, but it ties socket lifetime to game lifetime. When a node dies, every one of its players disconnects at exactly the moment we need them connected to see "paused". And a featured game's 100K spectators would all pile onto whichever node owns it.

| Approach | Ordering and timers | Failure behavior | Cost |
|----------|--------------------|------------------|------|
| ✅ Single-owner actor + fenced epoch | One total order; owner arms timers | Pause ~5–6 s, then resume elsewhere | Ownership, leases, failover code |
| ❌ Stateless CAS on Redis | Order via CAS; timers need a job queue | No ownership to lose | Timer polling latency, extra round trip |
| ❌ Sockets pinned to owner node | Same as actor | Node crash drops every socket | Hot games overload one node |

### Server failure mid-game, step by step

1. Every node renews its lease each second, and the lease value is the time of that heartbeat. The TTL is 5 s.
2. Node X dies. Its lease expires after at most 5 s. A supervisor (one node elected via a Redis lock) reads X's game set, about 9,000 games at peak, and spreads them across the 19 survivors, roughly 474 each.
3. For each game, a script sets the new owner and increments the epoch, but only if X is still recorded as the owner.
4. The new owner reads the state hash (FEN, clocks, ply, seq), pipelined, well under a second for 474 games. It rebuilds the actor from the stored position. There's no need to replay the move list.
5. **The clock rule:** the side to move is charged only up to X's last heartbeat. The outage after that is not charged. A crash can give a player at most about one second of free thinking, and it never takes time away.
6. The new owner appends and publishes a resumed event with fresh clocks and re-arms the flag timer. Gateways learn the new owner from that event. A move that was in flight to X is resent by the client with the same move id and ply, and is applied exactly once.

> "Players see 'Server hiccup, clocks paused' for 5 or 6 seconds, then the game continues. No move is lost, because the actor publishes only after the append was replicated."

### Split brain and fencing

A node that is partitioned rather than dead still believes it owns its games. Two things stop it. It self-fences: if it cannot renew its lease for 4 s, it stops accepting commands, before the 5 s TTL lets anyone take over. And if that check fails too, its next append carries the old epoch and the script rejects it, so it drops the actor. The epoch is the real guarantee; self-fencing just makes the error path rare.

### What we give up

Durability rests on Redis replication, which is asynchronous. `WAIT` for one replica narrows the loss window but does not close it. If a shard's replica is unhealthy, `WAIT` times out, and we proceed anyway rather than freezing every game on that shard. During that window a primary crash can lose the last move. We alert on every replica-ack timeout. A consensus-replicated log would close the gap for another 5–10 ms per move, and I don't think chess needs it.

---

## ⏱️ Deep Dive 2: Fair Clocks Despite Network Latency (8 minutes)

### The decision

The server is the only clock. It measures each move's elapsed time between its own timestamps, then refunds network transit, but bounded: the refund is the smallest of the client's claim, the server's own RTT measurement, and a per-player quota.

### What the server actually sees

When the server sends my opponent's move, it starts my clock. The message takes RTT/2 to reach me. I think. My move takes RTT/2 to come back. So the server's elapsed time is my think time plus one full RTT. With a 200 ms RTT and 40 moves, that's 8 seconds charged to the network, 4.4% of a 3-minute game. My opponent on fiber pays 0.8 seconds. Without compensation, the clock penalizes geography.

### The compensation rule

1. The client measures its own think time, from rendering the opponent's move to sending its own, and sends it with the move.
2. The server computes claimed transit as its elapsed time minus the client's think time.
3. The server keeps a median RTT per player from its own pings every 2 s, over the last 10 samples.
4. Compensation is the minimum of the claimed transit, the measured median RTT, and the player's quota.
5. The quota is a token bucket: 2,000 ms capacity, refilled by 200 ms after every move.
6. Charged time is elapsed minus compensation. The clock drops by the charged time, then the increment is added. If the charged time exceeds what was left, the game ends on time, or as a draw if the opponent cannot mate.

> "An honest 200 ms player uses 200 and gets 200 back each move, so the bucket stays full and they're charged their real think time. A 300 ms player drains the bucket by 100 per move, and from about move 19 on pays roughly 100 ms per move. That's partial but bounded. A cheater who claims huge transit and also delays pongs to inflate my RTT measurement gets at most 2,000 plus 39 × 200 = 9.8 seconds over 40 moves. That's about what an honest 200 ms connection legitimately gets, and the pattern shows up in fair-play analysis."

### Flagging

The actor arms a timer for the side to move at the turn start plus their remaining time plus a grace period. The grace is the smaller of their RTT and their quota, so a move already in flight isn't flagged early. Only the server decides a timeout. A client showing 0.0 can at most ask the server to check.

Within a node I use a monotonic clock. The turn start time is also persisted as wall-clock milliseconds, because after a failover a different node, with a different monotonic origin, continues the clock. NTP keeps cross-node skew to a few milliseconds.

### How the alternatives break

**Trust client-reported clocks.** The client says "I have 41.3 s left" and the server checks plausibility. The cheat is to report 50 ms of thinking on every move. A plausibility bound wide enough for real mobile jitter, hundreds of milliseconds, hands the cheater hundreds of milliseconds per move, which decides bullet games.

**Raw server time, no compensation.** It can't be cheated, but it charges a 250 ms mobile player 10 seconds over 40 moves of a 3+0 game while the fiber opponent pays 0.8 seconds. That's a systematic penalty by connection quality.

| Approach | Cheat resistance | Fairness to slow links | Complexity |
|----------|-----------------|------------------------|------------|
| ✅ Server clock + bounded compensation | Abuse capped (~9.8 s per 40 moves) | Full up to ~200 ms RTT, partial beyond | Lag tracking per player |
| ❌ Client-reported clocks | Weak: lie about think time | Perfect | Plausibility rules that never fit |
| ❌ Raw server time | Strong | Pays a full RTT per move | Trivial |

### What we give up

Parameters, not principles, decide fairness at the margins. I tune capacity and refill per speed, tighter for bullet and looser for classical, and those values are a policy argument rather than an engineering one. Connections above ~300 ms are never fully compensated. I think that's correct: past a point we can't tell bad network from manipulation.

---

## 🏆 Deep Dive 3: Game End and an Exactly-Once Elo Update (5 minutes)

### The decision

When the actor detects the end of the game, it appends the game-over event to the log and publishes it, so players see the result instantly. Then it calls finalize, which is one Postgres transaction:

1. A conditional update marks the game finished, storing result, termination, moves, per-ply clocks and final FEN, **only if its status is still active**. Zero rows updated means someone already finalized it, so we return the stored result and stop.
2. Insert missing rating rows lazily, then lock both players' rating rows for this speed in user-id order, so two concurrent finalizations can't deadlock.
3. Compute Elo. Expected score is 1 / (1 + 10^((R_opp − R_me)/400)), and the new rating is R + K × (score − expected). K is 40 for provisional players (under 30 games), 20 normally, and 10 at 2400+.
4. Update both rating rows, insert two rating-history rows keyed by (game, user), store the deltas on the game row, and write a game-ended outbox row. Commit.

> "Concrete example: a 1500 beats a 1700 at K = 20. Expected score is 1 / (1 + 10^0.5), which is 0.24, so the winner gains 20 × 0.76, about 15, and the loser drops 15."

### Why this works

Finalization will be retried: the actor retries after a timeout, a new owner retries after failover, and a sweeper retries games stuck in "ended but not archived". Every retry hits the status guard and becomes a no-op. The rating-history primary key is a second guard if the code ever regresses. The result, both ratings and the downstream event commit atomically, so there is no state where the game is recorded but the rating isn't.

### How the alternative breaks

An asynchronous rating service consuming game-ended events from Kafka decouples ratings from game completion, but it creates two problems. The player stares at "rating pending" for Kafka's lag on the screen where they most want to see "+15". And the consumer needs its own processed-events table with its own transaction boundary, which is exactly the problem the same-transaction approach avoids. Downstream consumers still get an event, through the outbox relay, at least once, deduplicated by game id.

| Approach | Exactly-once | Latency to "+15" | Coupling |
|----------|--------------|------------------|----------|
| ✅ Same transaction, status guard | Built in | ~10 ms | Rating logic in the finalize path |
| ❌ Async Kafka rating consumer | Needs separate dedupe | Kafka lag | Decoupled |

### What we give up

Ratings use the player's rating at commit time, not at game start. With simultaneous games, the second result applies on top of the first, which is fine for Elo. If Postgres is down, the game still ends correctly from the Redis log, and the circuit breaker sends finalization to the retry queue. The player sees "rating update pending" instead of a stalled game. Annulling a cheater's game reverts that game's delta. It does not replay later games, which is a batch job.

---

## 🎲 Matchmaking Pools That Widen Over Time (4 minutes)

Pools are keyed by speed, time control and rated/casual. Peak is 300 pairings per second across a few dozen pools, so one single-threaded actor per pool is plenty.

1. A seek adds a ticket to the pool's sorted set (score = rating). The ticket has a 15 s TTL refreshed by the client heartbeat, so closed tabs fall out. One ticket per user.
2. A ticket's window starts at ±50, widens by 50 every 5 s, and caps at ±500, reached at 45 s.
3. Every 500 ms the actor walks tickets oldest first and pairs each with the closest-rated ticket whose difference fits **both** windows. Mutual fit means a newcomer's narrow window isn't overridden by a long waiter's wide one.
4. A script removes both tickets atomically; if either is already gone, because of a cancel or a race, the pairing is dropped.
5. The actor calls create-game with a pairing id. The games table has a unique pairing id, so a retried create returns the same game.
6. If white doesn't move within 30 s (or black within 30 s of white's first move), the game is aborted unrated. That cleans up ghost pairings.

> "Ticking beats pairing on arrival. On arrival, the first acceptable partner wins. A tick sees everyone who arrived in the last half-second and picks the closest. The cost is up to 500 ms of extra wait, invisible next to a 5-second median. Little's law says ~3,000 tickets wait at peak, which is tiny."

Abuse: 3 aborts in 10 minutes earns a 5-minute matchmaking cooldown, which stops opponent-shopping.

---

## 📡 Reconnection and Spectator Fan-Out (3 minutes)

### Reconnection

Every event in a game has a sequence number that increases by one. On reconnect the client sends resume with the last seq it saw. The gateway replays the missing range from the stream, or sends a full snapshot if the range is gone. A pending move is resent with its original move id and ply. The owner re-acks it if the log already holds that move id at that ply, and rejects it with a snapshot otherwise.

The disconnected player's clock keeps running. The server can't tell a dropped connection from someone thinking on a second device. After 30 s of absence in blitz or slower, the opponent may claim victory; in bullet the clock decides first.

### Spectators

1. The gateway subscribes to the game's channel first, then reads the snapshot, and drops buffered events whose seq is not newer. The reverse order loses any move made in between.
2. One subscription per gateway per game, reference-counted. The actor publishes once, and each gateway serializes once and writes to all its local spectators. 100K spectators spread over 30 gateways is about 3,300 writes per gateway per move.
3. Spectator delivery is conflated: a spectator with a backed-up socket gets the latest snapshot and skips intermediate positions. Players always get every event.
4. Pub/sub is fire-and-forget, so correctness comes from seq: any gap triggers a range read from the stream.

> "I use Redis 7 sharded pub/sub. Classic PUBLISH in cluster mode broadcasts every message to every node, so its cost grows with cluster size. Sharded pub/sub keeps a channel on the shard that owns its slot."

---

## 📈 Scalability: What Breaks First (3 minutes)

| Rank | Bottleneck | When | Fix |
|------|------------|------|-----|
| 1 | Hot-game fan-out | A championship game with 1M spectators = 1M writes per move | Relay tier or CDN-cached stream with a 1–2 s delay for very large audiences |
| 2 | Pub/sub across shards | Classic PUBLISH at 30+ shards | Sharded pub/sub from day one |
| 3 | Gateway memory | 10× = 10M connections ≈ 200 nodes | Move lobby users to SSE or polling |
| 4 | Archive growth | 3.2 TB/year now, 32 TB/year at 10× | Monthly partitions, PGN to object storage |

Move processing is not on the list. At 10× it's 24 cores across the fleet. Redis at 10× is ~960K ops/s, ~30 shards, which is routine.

---

## ❓ Follow-up Questions (3 minutes)

**"What if you have 10× more users?"** Gateways scale with connections (~200 nodes), game nodes with blast-radius policy, Redis with shard count, and pools get more liquid, so wait times *fall*. The first real redesign is spectating for mega-events, moving off per-socket pushes to a relay or CDN tier.

**"What if a data center goes down?"** Clients re-home through GeoDNS to the next region. The move log streams replicate asynchronously across regions. A game resumes in the new region from the last replicated move. If the replica is behind a move the players already saw, we don't resume a rewritten game: a rated game is aborted without rating change and we say so. Accounts and ratings live in one primary region. 300 rating transactions per second tolerate a cross-region write.

**"Ship an MVP in two weeks?"** One region, one game node with in-memory actors, a single Redis, chess.js validation, server clocks with the lag rule from day one (it's 30 lines and fairness is the product), Elo in the finalize transaction, and spectators on the same channel. I'd cut premoves, multi-node failover, tournaments and anti-cheat. Durable appends stay in from day one, so I can add failover later without changing the data.

**"How do you stop engine cheating?"** Server authority prevents illegal moves and clock manipulation, not engine use. Every finished game goes to a fair-play pipeline through Kafka: move-time variance, engine-agreement rates, lag-claim anomalies. High-stakes games run with a spectator delay so an accomplice can't relay live.

---

## 📊 Observability (1 minute)

| Metric | Why |
|--------|-----|
| Move processing latency histogram per node | The server's share of the 150 ms budget |
| Replica-ack timeouts per shard | A shard running without durable replication |
| Lag compensation histogram, quota-exhausted counter | Fairness, plus a fair-play signal |
| Matchmaking wait histogram and depth per pool | The pairing SLO |
| Failovers and pause duration | Node health as players feel it |
| Seq-gap resyncs | Pub/sub loss rate |
| Finalizations by outcome (applied / duplicate / retried) | Idempotency at work |

Every log line carries game id, seq, node and epoch, so one game's history can be reconstructed across a failover.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Game authority | ✅ Single-owner actor, fenced epoch | ❌ Stateless CAS | One total order; owned flag timers |
| Socket topology | ✅ Gateways + RPC to owner | ❌ Sockets pinned to owner | Node death doesn't drop sockets |
| Placement | ✅ Explicit directory + leases | ❌ Consistent hashing | Live games never migrate on scale-out |
| Clocks | ✅ Server time + bounded compensation | ❌ Client-reported clocks | Can't lie about think time |
| Move durability | ✅ Redis stream + replica ack | ❌ Postgres insert per move | ~2 ms vs disk commit; Postgres sees 300 writes/s |
| Delivery | ✅ Sharded pub/sub + seq gap-fill | ❌ Per-subscriber durable queues | Latency from pub/sub, correctness from seq |
| Matchmaking | ✅ 500 ms ticks, mutual widening window | ❌ Pair on arrival | Better pairs for a half-second |
| Rating | ✅ Same transaction as result | ❌ Async consumer | Exactly-once and instant "+15" |
| Redis down on move path | ✅ Pause game | ❌ Accept non-durable moves | A seen move must never vanish |

---

## 📝 Summary

> "The design comes down to four ideas. First, every game has one owner, a single-threaded actor with a fenced epoch. That gives a total order for moves, resignations and flags, and lets a dead node's games resume elsewhere in about 5 seconds without losing a move or charging anyone for the outage. Second, the server owns the clock but refunds network transit, bounded by its own RTT measurement and a token-bucket quota. That makes a 200 ms player's clock as fair as a fiber player's, while capping what a cheater can steal. Third, matchmaking pools tick every 500 ms with rating windows that widen with wait time and must fit both players. Fourth, the result and the Elo update commit in one Postgres transaction guarded by the game's status, so retries are harmless. The surprise in the numbers is that moves are cheap, 2.4 cores at peak. The engineering effort goes into ownership, time and idempotency, not throughput."
