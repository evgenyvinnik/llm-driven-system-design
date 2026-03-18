# Distributed Cache - Architecture Design

## System Overview

A high-performance distributed caching layer that partitions data across multiple nodes using consistent hashing, evicts entries via LRU when capacity is reached, and supports TTL-based expiration. The system demonstrates core distributed systems concepts: data partitioning, fault tolerance, graceful rebalancing, and comprehensive observability.

## Requirements

### Functional Requirements

- **Key-Value Operations**: GET, SET, DELETE with optional TTL per key
- **Eviction Policies**: LRU (Least Recently Used) eviction when capacity or memory limit is reached
- **Sharding**: Consistent hashing with virtual nodes for even key distribution across cache nodes
- **TTL Support**: Time-to-live with lazy expiration (check on access) and active expiration (background sampling)
- **Cluster Management**: Dynamic node addition/removal with graceful key rebalancing
- **Hot Key Detection**: Identify keys receiving disproportionate traffic within sliding time windows
- **Persistence**: Periodic snapshots for warm restarts after node failures
- **Admin Operations**: Cluster topology management, forced health checks, manual rebalancing

### Non-Functional Requirements

- **Scalability**: Horizontal scaling via consistent hashing -- adding a node rehashes only ~1/N of keys
- **Availability**: 99.9% uptime with automatic health checking, circuit breakers, and node failover
- **Latency**: Sub-5ms p99 for cache operations (in-memory storage with network hop)
- **Consistency**: Eventual consistency -- no replication, single-owner per key
- **Throughput**: 50,000+ ops/sec per node for sub-KB payloads

## Capacity Estimation

### Production Scale (100-node cluster)

| Metric | Value | Calculation |
|--------|-------|-------------|
| Total nodes | 100 | Scaled based on data volume |
| Per-node capacity | 1M entries, 10 GB memory | Memory-optimized instances |
| Total capacity | 100M entries, 1 TB | 100 nodes x 10 GB |
| Throughput | 5M ops/sec | 50K ops/sec x 100 nodes |
| Virtual nodes | 150 per physical node | 15,000 ring positions |
| Key distribution variance | < 5% | With 150 virtual nodes |
| Rebalance on node add | ~1% of keys migrate | 1/100 of total |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Nodes | 3 cache nodes + 1 coordinator |
| Per-node capacity | 10,000 entries, 100 MB |
| Total capacity | 30,000 entries, 300 MB |
| Expected throughput | ~10,000 ops/sec per node |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Applications                          │
│                    (Services, Frontends, CLI tools)                     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            API Gateway / LB                            │
│                    (Rate limiting, TLS termination)                     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Coordinator Layer                             │
│                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│  │  Coordinator 1   │  │  Coordinator 2   │  │  Coordinator N   │     │
│  │  ┌────────────┐  │  │  ┌────────────┐  │  │  ┌────────────┐  │     │
│  │  │ Hash Ring  │  │  │  │ Hash Ring  │  │  │  │ Hash Ring  │  │     │
│  │  │ (150 VN/  │  │  │  │ (150 VN/  │  │  │  │ (150 VN/  │  │     │
│  │  │  node)    │  │  │  │  node)    │  │  │  │  node)    │  │     │
│  │  └────────────┘  │  │  └────────────┘  │  │  └────────────┘  │     │
│  │  ┌────────────┐  │  │  ┌────────────┐  │  │  ┌────────────┐  │     │
│  │  │ Circuit    │  │  │  │ Circuit    │  │  │  │ Circuit    │  │     │
│  │  │ Breakers   │  │  │  │ Breakers   │  │  │  │ Breakers   │  │     │
│  │  └────────────┘  │  │  └────────────┘  │  │  └────────────┘  │     │
│  │  ┌────────────┐  │  │  ┌────────────┐  │  │  ┌────────────┐  │     │
│  │  │ Health     │  │  │  │ Health     │  │  │  │ Health     │  │     │
│  │  │ Monitor    │  │  │  │ Monitor    │  │  │  │ Monitor    │  │     │
│  │  └────────────┘  │  │  └────────────┘  │  │  └────────────┘  │     │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘     │
└─────────────────────┬──────────────┬──────────────┬────────────────────┘
                      │              │              │
          ┌───────────┘    ┌─────────┘    ┌────────┘
          ▼                ▼              ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│  Cache Node 1  │ │  Cache Node 2  │ │  Cache Node N  │
│                │ │                │ │                │
│ ┌────────────┐ │ │ ┌────────────┐ │ │ ┌────────────┐ │
│ │ LRU Cache  │ │ │ │ LRU Cache  │ │ │ │ LRU Cache  │ │
│ │ (in-memory)│ │ │ │ (in-memory)│ │ │ │ (in-memory)│ │
│ └────────────┘ │ │ └────────────┘ │ │ └────────────┘ │
│ ┌────────────┐ │ │ ┌────────────┐ │ │ ┌────────────┐ │
│ │ TTL Mgr    │ │ │ │ TTL Mgr    │ │ │ │ TTL Mgr    │ │
│ │ Lazy+Active│ │ │ │ Lazy+Active│ │ │ │ Lazy+Active│ │
│ └────────────┘ │ │ └────────────┘ │ │ └────────────┘ │
│ ┌────────────┐ │ │ ┌────────────┐ │ │ ┌────────────┐ │
│ │ Hot Key    │ │ │ │ Hot Key    │ │ │ │ Hot Key    │ │
│ │ Detector   │ │ │ │ Detector   │ │ │ │ Detector   │ │
│ └────────────┘ │ │ └────────────┘ │ │ └────────────┘ │
│ ┌────────────┐ │ │ ┌────────────┐ │ │ ┌────────────┐ │
│ │ Snapshot   │ │ │ │ Snapshot   │ │ │ │ Snapshot   │ │
│ │ Persistence│ │ │ │ Persistence│ │ │ │ Persistence│ │
│ └────────────┘ │ │ └────────────┘ │ │ └────────────┘ │
└────────────────┘ └────────────────┘ └────────────────┘
        │                  │                  │
        ▼                  ▼                  ▼
   ./data/node-1/     ./data/node-2/     ./data/node-N/
   (JSON snapshots)   (JSON snapshots)   (JSON snapshots)
```

## Core Components

### Consistent Hash Ring

The hash ring maps keys to nodes using MD5 hashing with virtual nodes for uniform distribution.

**Algorithm**:
1. Each physical node gets 150 virtual nodes on the ring (positions 0 to 2^32-1)
2. A key is hashed to a position on the ring
3. Binary search finds the first virtual node clockwise from that position
4. The physical node owning that virtual node handles the request

**Why 150 virtual nodes**: Testing with 1,000 keys shows variance < 5% across nodes. Fewer than 100 virtual nodes causes significant imbalance (some nodes receive 2x the average load). Above 200 yields diminishing returns while increasing memory for the routing table.

**Why MD5**: MD5 provides excellent uniformity for hash ring distribution. Cryptographic strength is irrelevant here -- we need uniform bit distribution, not collision resistance. MD5 is fast (~500ns per hash) and has well-studied distribution properties.

### LRU Cache (per node)

Each cache node maintains an in-memory LRU cache backed by a doubly-linked list and a hash map.

**Operations (all O(1))**:
- **GET**: Hash map lookup, move to front of linked list, check TTL
- **SET**: Insert at front, evict from tail if at capacity
- **DELETE**: Hash map lookup, remove from linked list

**Eviction triggers**:
1. Entry count exceeds `maxSize` (default: 10,000)
2. Memory usage exceeds `maxMemoryMB` (default: 100 MB, estimated via JSON serialization)

**TTL expiration (dual strategy)**:
- **Lazy expiration**: On GET, check if `expiresAt < now`. If expired, delete and return miss.
- **Active expiration**: Background task samples 20 random keys every second, deleting expired ones. This prevents memory bloat from keys that are set with TTL but never accessed again.

### Coordinator

The coordinator is the single entry point for all client requests. It maintains the hash ring, routes requests to the correct cache node, and manages cluster health.

**Request flow**:
```
1. Client sends GET /cache/user:123 to Coordinator
2. Coordinator hashes "user:123" → position 0x7A3F...
3. Binary search finds Node 2 owns this position
4. Coordinator forwards request to Node 2 via circuit breaker
5. Node 2 performs LRU lookup, returns value
6. Coordinator returns response to client
```

**Why coordinator pattern (not smart client)**:
- Centralizes hash ring state -- clients don't need to track node membership
- Easier to visualize in dashboard (single endpoint)
- Circuit breakers and health monitoring live in one place
- Trade-off: extra network hop adds ~1ms latency. At production scale, a smart client library eliminates this hop, but for a learning system the coordinator simplifies operations.

### Health Monitor

The coordinator periodically probes each cache node via `GET /health`.

**Failure detection**:
- Health check interval: 5 seconds
- Node marked unhealthy after 3 consecutive failures
- Unhealthy nodes are removed from the hash ring
- Node re-added when health checks pass again

**Why not gossip protocol**: Gossip (like Memberlist or SWIM) is better at scale (O(log N) detection time) but adds significant complexity. Direct health checks from the coordinator work well for clusters under ~50 nodes.

## API Design

### Cache Operations (via Coordinator)

```
GET    /cache/:key              → Get cached value
POST   /cache/:key              → Set value { value, ttl? }
PUT    /cache/:key              → Update value { value, ttl? }
DELETE /cache/:key              → Delete key
GET    /keys                    → List all keys (with optional pattern)
POST   /cache/bulk              → Batch GET/SET { operations: [...] }
```

### Cluster Management

```
GET    /cluster/info            → Cluster topology (nodes, hash ring)
GET    /cluster/stats           → Aggregated cache statistics
GET    /health                  → Coordinator health
GET    /metrics                 → Prometheus metrics
```

### Admin Operations (protected by X-Admin-Key)

```
POST   /admin/node              → Add node to cluster { url }
DELETE /admin/node              → Remove node from cluster { url }
POST   /admin/health-check      → Force health check cycle
POST   /admin/rebalance         → Trigger key rebalancing
GET    /admin/rebalance/analyze → Preview rebalance impact
POST   /admin/snapshot          → Force snapshot on all nodes
POST   /flush                   → Clear all cache data
```

### Per-Node Endpoints (internal)

```
GET    /cache/:key              → Local cache lookup
POST   /cache/:key              → Local cache set
DELETE /cache/:key              → Local cache delete
GET    /keys                    → List local keys
GET    /stats                   → Node-level statistics
GET    /health                  → Node health
GET    /metrics                 → Node Prometheus metrics
POST   /admin/snapshot          → Force local snapshot
POST   /admin/flush             → Flush local cache
GET    /admin/hot-keys          → Current hot keys
```

## Key Design Decisions

### Consistent Hashing vs. Modular Hashing

**Chosen**: Consistent hashing with 150 virtual nodes.

**Why modular hashing fails**: With `hash(key) % N` and 3 nodes, adding a 4th node changes the mapping for ~75% of keys. All those keys become cold simultaneously, causing a cache storm that hammers the database. At 50,000 ops/sec, that is 37,500 sudden cache misses per second flowing to the origin.

**Why consistent hashing works**: Adding a 4th node to a 3-node cluster remaps only ~25% of keys (1/N), and those keys migrate gradually via the rebalance manager. The remaining 75% continue serving from their existing nodes with zero disruption.

**What we give up**: Consistent hashing requires maintaining the ring data structure and virtual node mapping. The hash ring consumes ~100 KB of memory per node (150 virtual nodes x ~700 bytes each). For a cache system managing gigabytes, this overhead is negligible.

### Coordinator Pattern vs. Smart Client

**Chosen**: Central coordinator that routes all requests.

**Why smart client would be better at scale**: A smart client library embedded in each application server hashes keys locally and connects directly to cache nodes. This eliminates the coordinator as a bottleneck and removes one network hop (~1ms savings). Memcached and Redis Cluster use this approach.

**Why coordinator works for our design**: The coordinator provides a single HTTP endpoint for any client (curl, browser, SDK). It centralizes health monitoring, circuit breakers, and admin operations. The coordinator can handle ~10,000 requests/sec, which is sufficient for our scale. At production scale, the coordinator would become a stateless pool behind a load balancer, or we would switch to a smart client.

**What we give up**: Single point of failure (mitigated by running multiple coordinators behind a load balancer), extra network hop, and throughput ceiling on the coordinator.

### In-Memory Only vs. Persistent Storage

**Chosen**: In-memory cache with periodic JSON snapshots for warm restart.

**Why not Redis-style AOF (Append-Only File)**: AOF provides durability but adds write amplification -- every SET operation appends to disk. For a cache, durability is less critical than throughput. If the cache node crashes, the origin database has the authoritative data. The snapshot approach (every 60 seconds) means at most 60 seconds of data loss, which for a cache is acceptable.

**Why not write-through to database**: A cache that writes through to a database on every SET operation defeats the purpose of caching. Write-through adds latency to every write and couples cache availability to database availability.

**What we give up**: Up to 60 seconds of data can be lost on crash. Popular keys will experience cache misses until they are naturally re-populated. The snapshot warmup restores the majority of the cache state, and the LRU policy ensures the most-accessed keys are loaded first.

## Consistency and Idempotency

### Consistency Model

The cache uses a single-owner consistency model -- each key is owned by exactly one node, determined by the hash ring. There is no replication, so reads always go to the owner node.

**Trade-off**: This means if a node goes down, all keys owned by that node are unavailable until either:
1. The node recovers and loads its snapshot
2. The health monitor removes the node from the ring and keys are re-hashed to surviving nodes (losing cached values)

For a cache, this is acceptable because the origin database remains the source of truth.

### Idempotency

Cache operations are naturally idempotent:
- **GET**: Always safe to retry
- **SET**: Setting the same key/value is idempotent
- **DELETE**: Deleting a non-existent key returns success

The coordinator forwards requests without transformation, so retries from clients are safe.

## Security

### Admin Endpoint Authentication

Admin endpoints that can modify cluster topology are protected by an API key in the `X-Admin-Key` header. The key is compared using constant-time comparison to prevent timing attacks.

**Protected operations**: Adding/removing nodes, flushing cache, forcing rebalances, triggering snapshots.

**Unprotected operations**: Cache GET/SET/DELETE (per-key operations), health checks, cluster info reads, metrics.

**Rate limiting**: Admin endpoints are limited to 10 requests per minute to prevent brute-force or accidental cluster damage.

## Observability

### Prometheus Metrics

All metrics are exposed via `/metrics` in Prometheus exposition format.

**Cache Performance**:
- `cache_hits_total{node}` / `cache_misses_total{node}` -- Hit/miss counters per node
- `cache_hit_rate{node}` -- Computed hit rate gauge (0.0 to 1.0)
- `cache_operation_duration_ms{node,operation}` -- Histogram with buckets [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100]ms

**Capacity**:
- `cache_entries_current{node}` -- Current entry count
- `cache_memory_bytes{node}` -- Current memory usage
- `cache_memory_limit_bytes{node}` -- Memory limit
- `cache_evictions_total{node}` / `cache_expirations_total{node}` -- Eviction and TTL expiration counters

**Hot Keys**:
- `cache_hot_key_accesses{node,key}` -- Access count for keys exceeding 1% of traffic in 60-second window
- `cache_key_accesses_total{node}` -- Total key accesses for hot key detection baseline

**Cluster Health**:
- `cluster_nodes_healthy` / `cluster_nodes_total` -- Node availability gauges
- `node_health_check_failures_total{node}` -- Health check failure counter

**Circuit Breakers**:
- `circuit_breaker_state{target_node}` -- 0=closed, 0.5=half-open, 1=open
- `circuit_breaker_trips_total{target_node}` -- Times circuit opened

**Rebalancing**:
- `rebalance_in_progress{node}` -- Binary gauge
- `rebalance_keys_moved_total{from_node,to_node}` -- Migration counter
- `rebalance_duration_seconds` -- Histogram of rebalance durations

**Persistence**:
- `snapshots_created_total{node}` / `snapshots_loaded_total{node}` -- Snapshot lifecycle
- `snapshot_entries_loaded{node}` -- Entries restored from last snapshot
- `snapshot_duration_seconds{node}` -- Snapshot creation time

### Structured Logging (Pino)

JSON-formatted logs with component-based child loggers for filtering:

| Logger | Events |
|--------|--------|
| `cache` | `cache_hit`, `cache_miss`, `cache_set`, `cache_delete`, `cache_eviction`, `cache_expiration` |
| `cluster` | `node_healthy`, `node_unhealthy`, `node_added`, `node_removed` |
| `admin` | `admin_auth_failure`, `admin_operation` |
| `circuit-breaker` | `circuit_breaker_state_change`, `circuit_breaker_timeout`, `circuit_breaker_reject` |
| `persistence` | `snapshot_created`, `snapshot_loaded`, `old_snapshot_deleted` |
| `rebalance` | `rebalance_start`, `rebalance_progress`, `rebalance_complete` |

Sensitive headers (`X-Admin-Key`, `Authorization`) are automatically redacted. Health check and metrics endpoints are excluded from access logs to reduce noise.

### Health Checks

```
GET /health           → Basic liveness (200 if process running)
GET /health/ready     → Readiness (checks node connectivity)
```

### Alerting Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| Cache hit rate low | `cache_hit_rate < 0.80` for 5 min | Warning |
| Cache node down | Health check fails for 30s | Critical |
| Memory usage high | `cache_memory_bytes / cache_memory_limit_bytes > 0.90` for 2 min | Warning |
| Hot key detected | `cache_hot_key_accesses > 10,000` for 1 min | Info |
| Rebalance stuck | `rebalance_in_progress == 1` for > 5 min | Warning |
| Circuit breaker open | `circuit_breaker_state == 1` for > 1 min | Warning |

## Failure Handling

### Circuit Breakers (Opossum)

Each coordinator-to-node communication path has a circuit breaker that prevents cascading failures:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Timeout | 5 seconds | Fail fast if node unresponsive |
| Error threshold | 50% | Open circuit after half of requests fail |
| Volume threshold | 5 requests | Minimum samples before opening |
| Reset timeout | 30 seconds | Time before half-open test |
| Rolling window | 10 seconds | Error rate calculation window |

**State transitions**:
- **CLOSED → OPEN**: Error rate exceeds 50% over 5+ requests in 10-second window
- **OPEN → HALF-OPEN**: 30 seconds pass, one test request allowed through
- **HALF-OPEN → CLOSED**: Test request succeeds
- **HALF-OPEN → OPEN**: Test request fails

**Fallback behavior**: When circuit is open, coordinator returns `{ success: false, circuitOpen: true }`. Clients can decide to retry, use stale data, or hit the origin database.

### Node Failure Scenarios

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Node crash | 3 failed health checks (15s) | Node removed from ring, keys re-hash to surviving nodes |
| Node slow | Circuit breaker opens after timeout | Requests fail fast, node gets breathing room |
| Node restart | Health checks resume passing | Node re-added to ring, loads snapshot for warm start |
| Network partition | Health checks fail | Same as crash -- node removed from ring |

### Graceful Rebalancing

When nodes are added or removed, the `RebalanceManager` migrates keys gradually:

1. **Identify affected keys**: Scan existing nodes, check which keys should now belong to the new node
2. **Batch migration**: Move keys in batches of 100 with 50ms delays between batches
3. **Timeout protection**: Abort after 5 minutes to prevent indefinite blocking
4. **Progress tracking**: Log and expose metrics at 10% intervals

**Why gradual migration matters**: Without it, adding a node to a 3-node cluster makes 25% of keys "cold" simultaneously. At 50,000 ops/sec, that is 12,500 sudden misses per second. Gradual migration ensures keys are warm on the new node before traffic arrives.

### Snapshot Persistence for Recovery

Each node creates JSON snapshots of its cache state every 60 seconds:
- Keeps last 3 snapshots (configurable)
- On startup, loads the most recent valid snapshot
- Filters out expired entries during load
- Loads entries ordered by `updatedAt` descending (most active keys first)
- Creates a final snapshot on graceful shutdown

## Scalability Considerations

### Horizontal Scaling Path

1. **3-10 nodes**: Single coordinator, hash ring with virtual nodes. Current architecture.
2. **10-50 nodes**: Multiple coordinators behind a load balancer. Coordinators share ring state via configuration service (etcd/ZooKeeper).
3. **50-200 nodes**: Smart client library replaces coordinator. Clients hash locally and connect directly to nodes.
4. **200+ nodes**: Hierarchical sharding -- partition key space into regions, each managed by a separate ring.

### Bottleneck Analysis

| Component | Bottleneck | Threshold | Solution |
|-----------|------------|-----------|----------|
| Coordinator | Request throughput | ~10K ops/sec | Multiple coordinators, then smart client |
| Cache node | Memory | 10 GB per node | Add more nodes, data shards automatically |
| Hash ring | Ring recomputation on node changes | ~50 nodes | Incremental ring updates, separate ring service |
| Snapshots | Disk I/O during snapshot creation | 1M+ entries | Incremental snapshots, copy-on-write |
| Health checks | O(N) probes per interval | ~100 nodes | Gossip protocol, peer-based health |

### Hot Key Mitigation (production)

The `HotKeyDetector` identifies keys receiving > 1% of traffic in 60-second windows. At production scale, mitigation strategies include:
1. **Coordinator-level cache**: Cache hot keys at the coordinator for 1 second (serves stale data but absorbs load)
2. **Key sharding**: Split `product:12345` into `product:12345:shard{0-3}`, round-robin reads
3. **Read replicas**: Replicate hot keys to multiple nodes, fan out reads

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Key distribution | Consistent hashing (150 VN) | Modular hash | Only ~1/N keys rehash on node change |
| Request routing | Coordinator pattern | Smart client | Simpler ops, single endpoint; trade-off is extra hop |
| Cache storage | In-memory + JSON snapshots | Redis-style AOF | Cache tolerates data loss; snapshots are simpler |
| Eviction | LRU with doubly-linked list | LFU, Random | O(1) operations, good general-purpose policy |
| TTL expiration | Lazy + active sampling | Lazy only | Active prevents memory bloat from unaccessed keys |
| Health detection | Direct polling (5s interval) | Gossip protocol | Simple for < 50 nodes; gossip adds complexity |
| Cluster communication | HTTP/JSON | Binary protocol (RESP) | Easier to debug, test with curl; trade-off is overhead |
| Admin auth | API key header | OAuth, mTLS | Sufficient for internal service; simple to configure |

## Implementation Notes

This section maps the production architecture above to what is actually running locally, documenting production-grade patterns implemented, simplifications made, and what was omitted.

### Local Setup

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Dashboard (:5173)                      │
│              Cluster overview, key browser, test UI             │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Coordinator (:3000)                            │
│         Hash ring routing, health monitor, admin API            │
│         Circuit breakers (Opossum), Prometheus metrics          │
└────────┬──────────────────┬──────────────────┬──────────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Cache Node 1 │   │ Cache Node 2 │   │ Cache Node 3 │
│   (:3001)    │   │   (:3002)    │   │   (:3003)    │
│ LRU + TTL    │   │ LRU + TTL    │   │ LRU + TTL    │
│ Hot Key Det. │   │ Hot Key Det. │   │ Hot Key Det. │
│ Persistence  │   │ Persistence  │   │ Persistence  │
│ Metrics      │   │ Metrics      │   │ Metrics      │
└──────────────┘   └──────────────┘   └──────────────┘
```

All services run as Node.js processes using `tsx watch` for hot reload. No external databases -- the cache nodes are the storage layer.

### Production-Grade Patterns Implemented

**Consistent hashing with virtual nodes** (`backend/src/lib/consistent-hash.ts`): Full implementation with MD5 hashing, 150 virtual nodes per physical node, binary search for O(log N) lookups, and dynamic node add/remove. This is the core data partitioning algorithm used by DynamoDB, Cassandra, and similar systems.

**LRU cache with O(1) operations** (`backend/src/lib/lru-cache.ts`): Doubly-linked list + hash map providing O(1) GET/SET/DELETE. Implements both entry-count and memory-based limits with approximate memory tracking via JSON serialization.

**TTL with lazy + active expiration** (`backend/src/lib/lru-cache.ts`): Lazy expiration checks on access; active expiration samples 20 random keys per second in the background, deleting expired ones. This dual approach is the same strategy Redis uses.

**Circuit breakers (Opossum)** (`backend/src/shared/circuit-breaker.ts`): Full circuit breaker pattern for coordinator-to-node communication. Configurable timeout, error threshold, reset timeout, and volume threshold. Integrates with Prometheus metrics and Pino logging on state transitions. Prevents cascading failures when a cache node becomes unresponsive.

**Prometheus metrics (prom-client)** (`backend/src/shared/metrics.ts`): 25+ metrics covering cache performance (hits, misses, hit rate, latency histograms), capacity (entries, memory), hot keys, cluster health, circuit breaker state, rebalancing progress, and persistence. Exposed via `/metrics` endpoint. Includes default Node.js metrics (CPU, memory, event loop).

**Hot key detection** (`backend/src/shared/metrics.ts` -- `HotKeyDetector` class): Tracks per-key access counts in sliding 60-second windows. Keys exceeding 1% of total traffic are flagged and exposed via Prometheus gauges and an admin endpoint.

**Structured logging (Pino)** (`backend/src/shared/logger.ts`): JSON output in production, pretty-print in development. Component-based child loggers (cache, cluster, admin, persistence, rebalance, circuit-breaker). Automatic redaction of sensitive headers. HTTP request logging via pino-http with auto-generated request IDs.

**Graceful rebalancing** (`backend/src/shared/rebalance.ts`): Batched key migration (100 keys at a time, 50ms delay between batches) when nodes are added or removed. Includes timeout protection, progress tracking, and impact analysis preview via `/admin/rebalance/analyze`.

**Snapshot persistence** (`backend/src/shared/persistence.ts`): Periodic JSON snapshots every 60 seconds. Warm restart from latest snapshot on node startup, filtering expired entries and prioritizing recently-updated keys. Configurable retention (default: 3 snapshots). Final snapshot on graceful shutdown.

**Admin authentication** (`backend/src/shared/auth.ts`): API key middleware protecting cluster-modifying operations. Rate limited to 10 requests/minute. Audit logging of all admin operations with client IP.

### Simplifications

| Production Design | Local Simplification |
|-------------------|---------------------|
| Multiple coordinators behind LB | Single coordinator process |
| Smart client SDK for high throughput | HTTP API via coordinator for all requests |
| Binary protocol (RESP) for wire efficiency | HTTP/JSON for debuggability |
| etcd/ZooKeeper for ring state consensus | Ring state in coordinator memory |
| WAL or AOF for durability | JSON snapshots every 60s |
| Memory estimation via native allocator stats | JSON serialization for size estimation |
| TLS for inter-node communication | Plaintext HTTP |
| Docker compose orchestration available | Processes started via npm scripts or Docker |

### What Was Omitted

- **Replication**: No leader-follower or multi-primary replication. Single owner per key.
- **Gossip protocol**: Health detection uses direct polling, not peer-based gossip.
- **Connection pooling**: Each coordinator request creates a new HTTP connection to cache nodes.
- **Binary protocol**: HTTP/JSON instead of RESP or custom binary wire format.
- **CDN / edge caching**: No content delivery network layer.
- **Multi-region**: No geographic distribution or cross-datacenter replication.
- **Kubernetes**: No container orchestration, health-based pod replacement, or horizontal pod autoscaling.
- **Consensus protocol**: No Raft/Paxos for ring state agreement across coordinators.
