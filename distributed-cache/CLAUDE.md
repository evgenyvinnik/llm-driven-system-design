# Distributed Cache — Development with Claude

## Project Context

A from-scratch distributed in-memory cache — think a teaching-scale memcached/Redis-cluster — that partitions keys across independent cache nodes with **consistent hashing**, evicts with LRU, expires with TTL, and survives restarts via periodic disk snapshots. The hard problems it exists to make tangible: even key distribution without a central directory, adding/removing nodes without rehashing the whole keyspace, and detecting/rerouting around a dead node. There is **no external datastore — this project *is* the datastore.**

**Learning goals:** consistent hashing with virtual nodes, LRU + TTL cache internals, the coordinator (proxy) vs smart-client routing trade-off, graceful key rebalancing on topology change, and snapshot-based warm restarts.

## Architecture at a Glance (what actually runs)

One backend codebase runs in **two roles**; there is no database and no Redis. Matches `docker-compose.yml` (`cache-node-1/2/3`, `cache-coordinator`, `cache-frontend`) and `backend/package.json`:

| Component | Code | Role | Notes |
|-----------|------|------|-------|
| **Cache node** | `backend/src/server/` + `lib/lru-cache.ts` | Owns a shard: LRU store with TTL, bulk ops, snapshot persistence, health endpoint | `dev:server1/2/3`; each node persists JSON snapshots to `./data/{nodeId}` |
| **Coordinator** | `backend/src/coordinator/` + `lib/consistent-hash.ts` | Single client entry point: hashes keys to owning node, proxies the request via a circuit breaker, monitors health, drives rebalancing | `npm run coordinator` |
| **Shared** | `backend/src/shared/` | Snapshot `PersistenceManager`, graceful `RebalanceManager`, admin API-key auth, Opossum circuit breaker, prom-client metrics, Pino logger | — |

Dependencies are deliberately thin: `express`, `opossum`, `prom-client`, `pino`, `uuid` — no DB client, no cache client. Transport is plain **HTTP REST** (not the Redis RESP protocol). Frontend: React 19 + TanStack Router + Zustand admin dashboard (cluster topology, key browser, live test interface).

## Key Design Decisions

### 1. Consistent hashing with 150 virtual nodes (MD5)
`ConsistentHashRing` places 150 virtual nodes per physical node on a 2^32 ring (MD5 of `nodeId:vnN`), and `getNode(key)` binary-searches for the first vnode clockwise. Adding a node migrates only ~1/N of keys instead of rehashing everything. Trade-off: 150 vnodes × N nodes of routing-table memory, chosen because测 testing 1,000 keys shows <5% distribution variance at 150 (well under 100 causes 2× hot nodes; over 200 is diminishing returns). MD5 is used for uniform bit distribution, not security — collision resistance is irrelevant here.

### 2. Coordinator (proxy) routing, not a smart client
Clients talk only to the coordinator, which holds the ring, routes to the owning node, and wraps each node call in an Opossum circuit breaker. Trade-off given up: one extra network hop (~1ms) versus a smart client that hashes locally and calls nodes directly. Accepted because it centralizes the ring, health monitoring, and breaker state in one place and makes routing *visualizable* in the dashboard — the whole point of a teaching system. The production escape hatch (smart client) is documented, not built.

### 3. Snapshot persistence, not a write-ahead log
Each node's `PersistenceManager` writes a full JSON snapshot every 60s (and on graceful shutdown), keeps the last 3, and warms the cache from the newest snapshot on startup (skipping expired entries, recomputing remaining TTL). Trade-off: up to 60s of writes can be lost on a hard crash, and a full-snapshot is heavier than incremental logging. Accepted because a cache is a rebuildable tier — the snapshot buys *warm* restarts (no cold-cache stampede), and a WAL's per-write durability isn't worth its complexity for cache data.

### 4. Graceful, gradual rebalancing on topology change
When the health monitor adds/removes a node, `RebalanceManager` migrates keys in batches (default 100 keys, 50ms between batches) rather than all at once. Trade-off: a longer migration window during which some keys are briefly on the "wrong" node, chosen to avoid a cache storm — a burst migration would spike CPU/network and could knock healthy nodes over, the exact failure rebalancing is meant to prevent.

### 5. Single-owner per key — no replication (yet)
`getNode(key)` returns one owner; the write path routes there and nowhere else. The ring *can* return N nodes (`getNodes(key, 3)`) but that path is unused. Trade-off: losing a node loses its shard's keys until they repopulate from the source of truth — acceptable for a cache (misses, not data loss) and far simpler than replica consistency/read-repair. This is the single biggest gap between this and a production cache.

## Current State

Implemented and working: consistent hash ring (150 vnodes, MD5, O(log n) lookup) with live distribution stats; LRU cache with O(1) get/set/evict (doubly-linked list), approximate memory tracking, and lazy+active TTL expiration; coordinator routing of GET/SET/PUT/DELETE/INCR plus cross-node `/keys` aggregation and `/flush`; circuit-breaker-protected node calls; health monitoring with automatic node removal and graceful gradual rebalancing on node add/remove; snapshot persistence with warm-restart load and retention; admin endpoints protected by an `X-Admin-Key` (rate-limited, audit-logged); prom-client metrics at `/metrics` (cache hits/misses, snapshot create/load, rebalance progress) and Pino logging; and a React admin dashboard.

Intentionally not built: key replication (N-way, read-repair), hot-key mitigation (read replicas / client-side caching), a binary RESP protocol, a smart client that skips the coordinator hop, and multi-coordinator ring coordination.

## Iteration & Repair Log

- **Doc rewrite (2026-07):** the previous CLAUDE.md was a "Phase 3/4: Not started" checklist that **contradicted the shipped code**. It claimed persistence was "in-memory only" (there is a full snapshot `PersistenceManager` writing to `./data`), listed "add Prometheus metrics" as not-started (prom-client is wired at `/metrics`), and marked monitoring/rebalancing as future work (both `health-monitor` and `RebalanceManager` are implemented and coordinator-wired). Replaced with accurate decision/state history; the genuinely good design-decision notes were kept and grounded in the code.
- **Replication clarified:** the hash ring exposes `getNodes(key, n)` for replication, which reads like replication is present. It is not wired into the write path (`coordinator/routing.ts` uses single-owner `getNode`). Documented as the top gap rather than implied-complete.

## Open Questions

1. **Replication:** when to actually use `getNodes(key, 3)` on the write path — and then which consistency model (quorum writes? async replicas with read-repair?) fits a cache where staleness is usually fine but availability isn't.
2. **Hot keys:** a single celebrity key pins load to one node regardless of vnode count. Read replicas for that key, or a small coordinator-side/client-side cache?
3. **Snapshot window:** 60s snapshot interval bounds loss on crash. Is that acceptable, or should hot shards snapshot more often / adopt an incremental log?
4. **Coordinator SPOF:** locally there is one coordinator. Multiple coordinators need a shared, consistent view of the ring and node health — a small consensus/gossip layer — before this is truly HA.

## Resources

- [Karger et al., Consistent Hashing (1997)](https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf)
- [Redis internals](https://redis.io/docs/reference/internals/) — the RESP/replication path this project deliberately simplifies
- [Cache replacement policies (LRU)](https://en.wikipedia.org/wiki/Cache_replacement_policies#LRU)
