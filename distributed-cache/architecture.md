# Distributed Cache - Architecture Design

## System Overview

A high-performance distributed caching layer with consistent hashing, LRU eviction, and TTL support. This implementation demonstrates key distributed systems concepts including data partitioning, fault tolerance, and cache management.

## Requirements

### Functional Requirements

- **Key-Value Operations**: GET, SET, DELETE with optional TTL
- **Eviction Policies**: LRU (Least Recently Used) eviction when capacity is reached
- **Sharding**: Consistent hashing with virtual nodes for even key distribution
- **TTL Support**: Time-to-live with lazy and active expiration
- **Cluster Management**: Dynamic node addition/removal

### Non-Functional Requirements

- **Scalability**: Horizontal scaling via consistent hashing (add nodes without full rehash)
- **Availability**: Automatic health checking and node failover
- **Latency**: Sub-10ms for cache operations (in-memory storage)
- **Consistency**: Eventual consistency (no replication in current version)

## Capacity Estimation

For a learning/demo environment:

- **Nodes**: 3 cache nodes + 1 coordinator
- **Per Node Capacity**: 10,000 entries, 100 MB memory
- **Total Capacity**: 30,000 entries, 300 MB memory
- **Expected Throughput**: ~10,000 ops/sec per node

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Client Applications                           │
│                       (curl, dashboard, apps)                        │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ HTTP
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Coordinator                                 │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              Consistent Hash Ring                            │    │
│  │   [vn1] [vn2] ... [vn150] [vn1] [vn2] ... [vn150] [vn1] ... │    │
│  │    └─ Node 1 ─┘           └─ Node 2 ─┘           └─ Node 3 ─│    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  • Routes requests based on key hash                                │
│  • Health checks nodes periodically                                 │
│  • Aggregates cluster statistics                                    │
└──────┬──────────────────────┬──────────────────────┬────────────────┘
       │                      │                      │
       ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Cache Node 1  │    │   Cache Node 2  │    │   Cache Node 3  │
│   Port: 3001    │    │   Port: 3002    │    │   Port: 3003    │
│                 │    │                 │    │                 │
│  ┌───────────┐  │    │  ┌───────────┐  │    │  ┌───────────┐  │
│  │ LRU Cache │  │    │  │ LRU Cache │  │    │  │ LRU Cache │  │
│  │           │  │    │  │           │  │    │  │           │  │
│  │ head ←──→ │  │    │  │ head ←──→ │  │    │  │ head ←──→ │  │
│  │ ← MRU     │  │    │  │ ← MRU     │  │    │  │ ← MRU     │  │
│  │           │  │    │  │           │  │    │  │           │  │
│  │ ←──→ tail │  │    │  │ ←──→ tail │  │    │  │ ←──→ tail │  │
│  │ LRU →     │  │    │  │ LRU →     │  │    │  │ LRU →     │  │
│  └───────────┘  │    │  └───────────┘  │    │  └───────────┘  │
│                 │    │                 │    │                 │
│  • TTL Expiry   │    │  • TTL Expiry   │    │  • TTL Expiry   │
│  • Stats        │    │  • Stats        │    │  • Stats        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Core Components

1. **Coordinator** (`coordinator.js`)
   - HTTP server accepting client requests
   - Maintains consistent hash ring
   - Routes requests to appropriate cache node
   - Performs periodic health checks
   - Aggregates cluster-wide statistics

2. **Cache Node** (`server.js`)
   - HTTP server for cache operations
   - In-memory LRU cache with TTL support
   - Reports health and statistics

3. **Consistent Hash Ring** (`lib/consistent-hash.js`)
   - MD5-based hashing
   - 150 virtual nodes per physical node
   - Binary search for O(log n) node lookup

4. **LRU Cache** (`lib/lru-cache.js`)
   - Doubly-linked list for O(1) LRU operations
   - Hash map for O(1) key lookup
   - Lazy + active TTL expiration
   - Configurable size and memory limits

## Data Model

### Cache Entry Structure

```javascript
{
  key: string,           // Cache key
  value: any,            // Stored value (JSON-serializable)
  size: number,          // Estimated size in bytes
  expiresAt: number,     // Unix timestamp (0 = no expiration)
  createdAt: number,     // Creation timestamp
  updatedAt: number,     // Last update timestamp
  prev: Entry,           // Previous entry in LRU list
  next: Entry            // Next entry in LRU list
}
```

### Statistics Structure

```javascript
{
  hits: number,              // Successful GET operations
  misses: number,            // Failed GET operations (key not found)
  sets: number,              // SET operations
  deletes: number,           // DELETE operations
  evictions: number,         // LRU evictions
  expirations: number,       // TTL expirations
  currentSize: number,       // Current number of entries
  currentMemoryBytes: number // Estimated memory usage
}
```

## API Design

### Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cache/:key` | Get value by key |
| POST | `/cache/:key` | Set key-value pair |
| PUT | `/cache/:key` | Update key-value pair |
| DELETE | `/cache/:key` | Delete a key |
| POST | `/cache/:key/incr` | Increment numeric value |
| POST | `/cache/:key/expire` | Set TTL on existing key |
| GET | `/keys` | List all keys |
| POST | `/flush` | Clear all keys |

### Cluster Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/cluster/info` | Cluster information |
| GET | `/cluster/stats` | Aggregated statistics |
| GET | `/cluster/locate/:key` | Find node for key |
| POST | `/admin/node` | Add a node |
| DELETE | `/admin/node` | Remove a node |
| POST | `/admin/health-check` | Force health check |

## Key Design Decisions

### Consistent Hashing

**Problem**: How to distribute keys evenly and minimize remapping when nodes change?

**Solution**: Consistent hashing with virtual nodes
- Hash function: MD5 (first 8 hex chars) -> 32-bit integer
- Ring size: 0 to 2^32 - 1
- Virtual nodes: 150 per physical node
- Node lookup: Binary search on sorted hash array

**Why 150 virtual nodes?**
- Fewer: Uneven distribution (some nodes get 20% data, others 5%)
- More: Diminishing returns, more memory overhead
- 150: Good balance with <5% variance in distribution

### LRU Implementation

**Problem**: How to efficiently track and evict least recently used entries?

**Solution**: Doubly-linked list + Hash map
- Operations: O(1) for get, set, delete, evict
- Memory overhead: ~40 bytes per entry for list pointers
- Head = most recently used, Tail = least recently used

### TTL Expiration

**Problem**: How to handle key expiration efficiently?

**Solution**: Hybrid approach
1. **Lazy expiration**: Check TTL on every GET, delete if expired
   - Pro: No CPU overhead until access
   - Con: Memory not reclaimed until accessed

2. **Active expiration**: Background sampling every 1 second
   - Sample 20 random keys
   - Delete expired ones
   - If >25% expired, run again immediately
   - Pro: Bounds memory usage
   - Con: Small CPU overhead

### Coordinator vs Smart Client

**Problem**: How should clients route requests to the correct node?

**Solution**: Coordinator pattern
- Central coordinator handles all routing
- Simpler client implementation (just HTTP calls)
- Easier to add features (caching, circuit breakers)
- Trade-off: Extra network hop (~1ms latency)

Alternative (not implemented): Smart client
- Client maintains hash ring locally
- Direct connections to cache nodes
- Lower latency, more complex client

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Backend** | Node.js + Express | Per repo standards, good for I/O-bound workloads |
| **Frontend** | React + TypeScript | Per repo standards, type safety |
| **Routing** | TanStack Router | Per repo standards, file-based routing |
| **State** | Zustand | Per repo standards, lightweight |
| **Styling** | Tailwind CSS | Per repo standards, utility-first |
| **Containers** | Docker Compose | Easy multi-node orchestration |

## Scalability Considerations

### Horizontal Scaling

Adding nodes:
1. Add node URL to coordinator's CACHE_NODES list
2. Node registers via health check
3. Ring is updated, ~1/N keys remapped
4. No data migration (keys become "cold" on old nodes)

### Vertical Scaling

Per-node tuning:
- `MAX_SIZE`: Increase for more entries
- `MAX_MEMORY_MB`: Increase for larger values
- Node.js heap: Adjust via `--max-old-space-size`

### Current Limitations

1. No replication (single point of failure per key)
2. No persistence (data lost on restart)
3. No cluster consensus (split-brain possible)
4. Memory-only (limited by RAM)

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Trade-off |
|----------|--------|-------------|-----------|
| Partitioning | Consistent Hashing | Range-based | Better balance vs simpler implementation |
| Eviction | LRU | LFU, Random | Good general-purpose vs specific patterns |
| TTL | Lazy + Active | Lazy only | Memory bounds vs CPU overhead |
| Routing | Coordinator | Smart client | Simplicity vs latency |
| Protocol | HTTP/JSON | Redis RESP | Ease of use vs performance |

## Monitoring and Observability

### Key Metrics

- **Hit Rate**: `hits / (hits + misses) * 100`
- **Memory Usage**: Current memory vs max memory
- **Eviction Rate**: Evictions per second
- **Node Health**: Healthy nodes vs total nodes

### Alerts (Recommended)

- Hit rate < 80%: Cache may be too small
- Memory > 90%: Risk of eviction storms
- Node failures > 0: Investigate network/node issues

## Security Considerations

### Current Implementation

- No authentication (suitable for internal networks)
- No encryption (plain HTTP)
- No input sanitization (trust all inputs)

### Production Recommendations

1. Add API key authentication
2. Enable HTTPS with TLS
3. Rate limiting per client
4. Input validation and size limits
5. Network isolation (private subnet)

## Replication and Consistency Strategy

### Replication Model

For a learning project with 3 nodes, we use a **replication factor of 2** (each key is stored on 2 nodes):

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Consistent Hash Ring                          │
│                                                                      │
│    Key "user:123" hashes to position 42,500                         │
│    → Primary: Node 2 (owns range 30,000 - 60,000)                   │
│    → Replica: Node 3 (next node clockwise on ring)                  │
│                                                                      │
│         Node 1              Node 2              Node 3              │
│      [0 - 30,000]       [30,001 - 60,000]   [60,001 - 100,000]      │
│           │                   │                   │                  │
│           │            ┌──────┴──────┐            │                  │
│           │            │  "user:123" │────────────▶│ "user:123"      │
│           │            │  (primary)  │            │  (replica)       │
│           │            └─────────────┘            │                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Quorum Configuration

| Operation | Nodes Written/Read | Quorum Formula | Local Setup (RF=2) |
|-----------|-------------------|----------------|-------------------|
| **Write** | W | W > RF/2 | W=2 (both nodes) |
| **Read** | R | R > RF/2 | R=1 (single node) |
| **Strong Consistency** | | W + R > RF | 2 + 1 = 3 > 2 |

**Default configuration (eventual consistency for speed)**:
- Writes: Async replication (write to primary, async copy to replica)
- Reads: Single node (R=1), fastest response wins

**Strong consistency mode** (configurable per request):
- Writes: Synchronous to both nodes (W=2), fail if either unavailable
- Reads: Read from both, compare values, return most recent

### Read Repair

When a read detects inconsistency (strong consistency mode):

```javascript
// Read repair pseudocode
async function getWithRepair(key) {
  const [primary, replica] = await Promise.all([
    readFromNode(primaryNode, key),
    readFromNode(replicaNode, key)
  ]);

  if (primary.updatedAt !== replica.updatedAt) {
    const latest = primary.updatedAt > replica.updatedAt ? primary : replica;
    const stale = primary.updatedAt > replica.updatedAt ? replica : primary;

    // Repair stale node asynchronously
    repairNode(stale.node, key, latest.value, latest.updatedAt);

    return latest.value;
  }

  return primary.value;
}
```

Read repair runs in the background and does not block the response.

### Failover Behavior

**Node Failure Detection**:
- Health check interval: 5 seconds
- Failure threshold: 3 consecutive failures (15 seconds to declare dead)
- Health check endpoint: `GET /health` returns `{ status: "ok", uptime: 123 }`

**Failover Scenarios**:

| Scenario | Behavior | Data Impact |
|----------|----------|-------------|
| Primary fails | Promote replica to primary, next node becomes new replica | No data loss (replica has copy) |
| Replica fails | Continue serving from primary, mark replica as degraded | Writes succeed, durability reduced |
| Both fail | Return 503 for affected keys, other keys unaffected | Data unavailable until recovery |

**Recovery Process**:
```
1. Node comes back online
2. Coordinator detects via health check
3. Node added back to ring
4. Anti-entropy process syncs missing keys:
   - New node requests key list from neighbors
   - Neighbor sends keys that hash to new node's range
   - Background sync completes within ~60 seconds for 10K keys
```

**Split-Brain Prevention** (for local development):
- Single coordinator acts as authority for ring membership
- Nodes do not make independent decisions about cluster state
- Trade-off: Coordinator is single point of failure (acceptable for learning)

## Persistence and Cache Warmup

### Persistence Strategy

For a learning project, we implement **periodic snapshots** (simpler than WAL):

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Persistence Flow                                 │
│                                                                      │
│   LRU Cache (memory)                                                │
│       │                                                              │
│       │ Every 60 seconds (configurable)                             │
│       ▼                                                              │
│   ┌─────────────────┐                                               │
│   │  JSON Snapshot  │  → ./data/node-{id}/snapshot-{timestamp}.json │
│   │  {              │                                               │
│   │    entries: [...],                                              │
│   │    stats: {...}  │                                               │
│   │  }              │                                               │
│   └─────────────────┘                                               │
│                                                                      │
│   Retention: Keep last 3 snapshots (180 seconds of history)         │
└─────────────────────────────────────────────────────────────────────┘
```

**Snapshot Format**:
```javascript
{
  version: 1,
  nodeId: "node-1",
  timestamp: 1705420800000,
  entries: [
    {
      key: "user:123",
      value: { name: "Alice" },
      expiresAt: 1705424400000,
      createdAt: 1705420700000,
      updatedAt: 1705420750000
    }
    // ... more entries
  ],
  stats: {
    hits: 1500,
    misses: 200,
    sets: 500,
    evictions: 50
  }
}
```

**Configuration**:
```javascript
const PERSISTENCE_CONFIG = {
  enabled: true,                    // Toggle persistence
  snapshotIntervalMs: 60_000,       // Snapshot every 60 seconds
  snapshotDir: './data',            // Local directory for snapshots
  maxSnapshots: 3,                  // Keep last 3 snapshots
  compressSnapshots: false          // JSON for readability (gzip for production)
};
```

### Write-Behind (Async Persistence)

For frequently updated keys, we batch writes to reduce I/O:

```javascript
// Write-behind queue pseudocode
class WriteBuffer {
  constructor(flushIntervalMs = 5000, maxBufferSize = 100) {
    this.buffer = new Map();
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
  }

  add(key, value) {
    this.buffer.set(key, { value, timestamp: Date.now() });
    if (this.buffer.size >= this.maxBufferSize) {
      this.flush();  // Flush immediately if buffer full
    }
  }

  async flush() {
    if (this.buffer.size === 0) return;
    const entries = Array.from(this.buffer.entries());
    this.buffer.clear();
    await appendToLog(entries);  // Append to append-only log file
  }
}
```

### Cache Warmup on Startup

**Warmup Process**:
```
1. Node starts, cache is empty
2. Check for snapshot files in ./data/node-{id}/
3. Load most recent valid snapshot
4. Filter out expired entries (check expiresAt < now)
5. Populate LRU cache (respecting MAX_SIZE limit)
6. Resume normal operations
7. Log warmup stats: "Loaded 8,500 entries in 1.2 seconds"
```

**Warmup Configuration**:
```javascript
const WARMUP_CONFIG = {
  enabled: true,
  maxWarmupTimeMs: 30_000,     // Abort warmup if taking too long
  skipExpired: true,           // Don't load expired entries
  prioritizeRecent: true       // Load most recently updated entries first
};
```

**Warmup Order** (when cache is smaller than snapshot):
1. Sort entries by `updatedAt` descending
2. Load entries until MAX_SIZE reached
3. Most active keys are warmed first

## Admin Endpoint Authentication

### Authentication Model

For local development, we use simple API key authentication for admin endpoints:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Authentication Flow                              │
│                                                                      │
│   Client                          Coordinator                        │
│     │                                 │                              │
│     │ POST /admin/node                │                              │
│     │ X-Admin-Key: secret123          │                              │
│     │─────────────────────────────────▶│                              │
│     │                                 │                              │
│     │                    ┌────────────┼────────────┐                 │
│     │                    │ Check key  │            │                 │
│     │                    │ matches    │            │                 │
│     │                    │ ADMIN_KEY? │            │                 │
│     │                    └────────────┼────────────┘                 │
│     │                                 │                              │
│     │ 200 OK / 401 Unauthorized       │                              │
│     │◀─────────────────────────────────│                              │
└─────────────────────────────────────────────────────────────────────┘
```

**Protected Endpoints**:

| Endpoint | Method | Protection | Description |
|----------|--------|------------|-------------|
| `/admin/node` | POST | Admin key | Add a node to cluster |
| `/admin/node` | DELETE | Admin key | Remove a node from cluster |
| `/admin/health-check` | POST | Admin key | Force health check cycle |
| `/admin/rebalance` | POST | Admin key | Trigger key rebalancing |
| `/admin/snapshot` | POST | Admin key | Force snapshot on all nodes |
| `/flush` | POST | Admin key | Clear all cache data |

**Unprotected Endpoints** (read-only or per-key operations):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/cache/:key` | GET/POST/PUT/DELETE | Normal cache operations |
| `/keys` | GET | List keys (can be rate-limited) |
| `/health` | GET | Health check |
| `/cluster/info` | GET | Cluster topology |
| `/cluster/stats` | GET | Aggregated statistics |

**Configuration**:
```bash
# .env file
ADMIN_KEY=your-secret-admin-key-here
ADMIN_KEY_HEADER=X-Admin-Key
```

**Middleware Implementation**:
```javascript
function requireAdminKey(req, res, next) {
  const providedKey = req.headers['x-admin-key'];
  const expectedKey = process.env.ADMIN_KEY || 'dev-admin-key';

  if (!providedKey) {
    return res.status(401).json({ error: 'Missing X-Admin-Key header' });
  }

  if (providedKey !== expectedKey) {
    console.warn(`Failed admin auth attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid admin key' });
  }

  next();
}

// Usage
app.post('/admin/node', requireAdminKey, addNodeHandler);
app.delete('/admin/node', requireAdminKey, removeNodeHandler);
```

**Rate Limiting for Admin Endpoints**:
```javascript
const adminRateLimit = {
  windowMs: 60_000,      // 1 minute window
  maxRequests: 10,       // 10 requests per minute
  message: 'Too many admin requests, try again later'
};
```

## Observability and Monitoring

### Metrics Collection

All metrics are collected in-memory and exposed via `/metrics` endpoint (Prometheus format):

```prometheus
# Cache performance metrics
cache_hits_total{node="node-1"} 15234
cache_misses_total{node="node-1"} 1823
cache_hit_rate{node="node-1"} 0.893

# Operation latencies (histogram buckets in ms)
cache_operation_duration_ms_bucket{op="get",le="1"} 12500
cache_operation_duration_ms_bucket{op="get",le="5"} 14800
cache_operation_duration_ms_bucket{op="get",le="10"} 15100
cache_operation_duration_ms_bucket{op="set",le="1"} 4200
cache_operation_duration_ms_bucket{op="set",le="5"} 4900

# Memory and capacity
cache_entries_current{node="node-1"} 8523
cache_memory_bytes{node="node-1"} 45234567
cache_memory_limit_bytes{node="node-1"} 104857600

# Eviction and expiration
cache_evictions_total{node="node-1"} 234
cache_expirations_total{node="node-1"} 1567

# Cluster health
cluster_nodes_healthy 3
cluster_nodes_total 3
```

### Hit/Miss Rate Tracking

**Per-Key Hit/Miss** (for debugging, not enabled by default):
```javascript
// Enable with DEBUG_KEY_STATS=true
const keyStats = new Map();  // key -> { hits: 0, misses: 0, lastAccess: timestamp }

function trackKeyAccess(key, isHit) {
  if (!process.env.DEBUG_KEY_STATS) return;

  const stats = keyStats.get(key) || { hits: 0, misses: 0, lastAccess: 0 };
  if (isHit) stats.hits++;
  else stats.misses++;
  stats.lastAccess = Date.now();
  keyStats.set(key, stats);
}
```

**Hit Rate Dashboard Widget**:
```
┌─────────────────────────────────────────────────────────┐
│  Cache Hit Rate (Last 5 Minutes)                        │
│                                                         │
│  Overall: 89.3%  ████████████████████░░░░░ Target: 85%  │
│                                                         │
│  By Node:                                               │
│  Node 1: 91.2%  █████████████████████░░░░               │
│  Node 2: 88.1%  ███████████████████░░░░░░               │
│  Node 3: 88.7%  ████████████████████░░░░░               │
└─────────────────────────────────────────────────────────┘
```

### Hot Key Detection

**Definition**: A key is "hot" if it receives >1% of all requests in a 60-second window.

**Detection Algorithm**:
```javascript
class HotKeyDetector {
  constructor(windowMs = 60_000, threshold = 0.01) {
    this.windowMs = windowMs;
    this.threshold = threshold;  // 1% of traffic
    this.accessCounts = new Map();  // key -> count
    this.totalAccesses = 0;
  }

  recordAccess(key) {
    this.accessCounts.set(key, (this.accessCounts.get(key) || 0) + 1);
    this.totalAccesses++;
  }

  getHotKeys() {
    const minCount = this.totalAccesses * this.threshold;
    const hotKeys = [];

    for (const [key, count] of this.accessCounts) {
      if (count >= minCount) {
        hotKeys.push({
          key,
          accessCount: count,
          percentage: (count / this.totalAccesses * 100).toFixed(2) + '%'
        });
      }
    }

    return hotKeys.sort((a, b) => b.accessCount - a.accessCount);
  }

  // Reset counts every window
  reset() {
    this.accessCounts.clear();
    this.totalAccesses = 0;
  }
}
```

**Hot Key Metrics**:
```prometheus
# Top 10 hot keys exposed via /admin/hot-keys endpoint
cache_hot_keys{key="product:12345"} 15234
cache_hot_keys{key="user:session:abc"} 12100
cache_hot_keys{key="config:feature-flags"} 9876
```

**Hot Key Mitigation Strategies** (documented for learning):
1. **Local caching**: Coordinator caches hot keys for 1 second
2. **Read replicas**: Fan out reads across primary + replica
3. **Key sharding**: Split `product:12345` into `product:12345:shard{0-3}`

### Rebalancing Impact Monitoring

**Metrics During Rebalance**:
```prometheus
# Rebalance progress
rebalance_in_progress{node="node-1"} 1
rebalance_keys_moved{node="node-1"} 2345
rebalance_keys_total{node="node-1"} 3500
rebalance_duration_seconds{node="node-1"} 45

# Performance impact
cache_latency_p99_during_rebalance_ms 12.5
cache_latency_p99_normal_ms 3.2
cache_hit_rate_during_rebalance 0.72
cache_hit_rate_normal 0.89
```

**Rebalance Events Log**:
```
2024-01-16T10:30:00Z [REBALANCE] Started: adding node-4
2024-01-16T10:30:00Z [REBALANCE] Keys to migrate: ~3,500 (25% of total)
2024-01-16T10:30:15Z [REBALANCE] Progress: 1,000/3,500 keys migrated
2024-01-16T10:30:30Z [REBALANCE] Progress: 2,000/3,500 keys migrated
2024-01-16T10:30:45Z [REBALANCE] Progress: 3,500/3,500 keys migrated
2024-01-16T10:30:45Z [REBALANCE] Completed in 45 seconds
2024-01-16T10:30:45Z [REBALANCE] Hit rate recovered to 89% within 60 seconds
```

**Dashboard Rebalance Widget**:
```
┌─────────────────────────────────────────────────────────┐
│  Rebalance Status                                       │
│                                                         │
│  Status: In Progress                                    │
│  Reason: Node added (node-4)                            │
│                                                         │
│  Progress: ████████████████░░░░░░░░ 67% (2,345/3,500)   │
│  Duration: 30 seconds                                   │
│  Est. Remaining: 15 seconds                             │
│                                                         │
│  Impact:                                                │
│  • Latency P99: 12.5ms (normal: 3.2ms)                  │
│  • Hit Rate: 72% (normal: 89%)                          │
│  • Requests/sec: 8,500 (normal: 10,000)                 │
└─────────────────────────────────────────────────────────┘
```

### Chaos Testing

**Purpose**: Validate failover behavior and measure recovery time.

**Chaos Test Scenarios**:

| Test | Command | Expected Outcome |
|------|---------|------------------|
| Kill node | `docker stop cache-node-1` | Traffic fails over to replica within 15s |
| Network partition | `docker network disconnect` | Affected node marked unhealthy |
| Slow node | `tc qdisc add dev eth0 delay 500ms` | Requests timeout, circuit breaker opens |
| Memory pressure | Set `MAX_MEMORY_MB=10` | Eviction rate spikes, hit rate drops |
| CPU saturation | `stress --cpu 4` | Latency increases, health checks may fail |

**Chaos Test Script** (`scripts/chaos-test.sh`):
```bash
#!/bin/bash
# Simple chaos test for local development

echo "=== Chaos Test Suite ==="

# Test 1: Node failure
echo -e "\n[Test 1] Simulating node-1 failure..."
docker stop distributed-cache-node-1
sleep 5
curl -s http://localhost:3000/cluster/info | jq '.nodes[] | select(.healthy==false)'
echo "Waiting for failover detection (15 seconds)..."
sleep 15
echo "Cluster status after failover:"
curl -s http://localhost:3000/cluster/info | jq '.healthyNodes, .totalNodes'

# Verify requests still work
echo "Testing cache operations..."
RESULT=$(curl -s -X POST http://localhost:3000/cache/test-key \
  -H "Content-Type: application/json" \
  -d '{"value": "chaos-test"}')
echo "Set result: $RESULT"

# Restore
echo "Restoring node-1..."
docker start distributed-cache-node-1
sleep 10
echo "Cluster status after recovery:"
curl -s http://localhost:3000/cluster/info | jq '.healthyNodes, .totalNodes'

# Test 2: Verify data availability
echo -e "\n[Test 2] Verifying data survived failover..."
RESULT=$(curl -s http://localhost:3000/cache/test-key)
echo "Get result: $RESULT"

echo -e "\n=== Chaos Test Complete ==="
```

**Chaos Test Metrics**:
```prometheus
# Track chaos test results
chaos_test_node_failure_recovery_seconds 14.2
chaos_test_data_loss_keys 0
chaos_test_requests_failed_during_failover 23
chaos_test_requests_succeeded_during_failover 4977
```

**Weekly Chaos Test Schedule** (for active development):
- Monday: Node failure and recovery
- Wednesday: Network latency injection
- Friday: Memory pressure test

### Alerting Rules

**Prometheus Alert Rules** (`alerts.yml`):
```yaml
groups:
  - name: distributed-cache
    rules:
      - alert: CacheHitRateLow
        expr: cache_hit_rate < 0.80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 80%"
          description: "Hit rate is {{ $value | humanizePercentage }}"

      - alert: CacheNodeDown
        expr: up{job="cache-node"} == 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "Cache node {{ $labels.instance }} is down"

      - alert: CacheMemoryHigh
        expr: cache_memory_bytes / cache_memory_limit_bytes > 0.90
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Cache memory usage above 90%"

      - alert: HotKeyDetected
        expr: cache_hot_keys > 10000
        for: 1m
        labels:
          severity: info
        annotations:
          summary: "Hot key detected: {{ $labels.key }}"

      - alert: RebalanceStuck
        expr: rebalance_in_progress == 1 and rebalance_duration_seconds > 300
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Rebalance taking longer than 5 minutes"
```

### Grafana Dashboard Panels

**Recommended Dashboard Layout**:
```
┌─────────────────────────────────────────────────────────────────────┐
│  Row 1: Overview                                                     │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────┐ │
│  │ Hit Rate      │ │ Total Entries │ │ Memory Usage  │ │ Nodes Up  │ │
│  │    89.3%      │ │    24,532     │ │  67% / 300MB  │ │   3 / 3   │ │
│  └───────────────┘ └───────────────┘ └───────────────┘ └───────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Row 2: Performance                                                  │
│  ┌─────────────────────────────────┐ ┌─────────────────────────────┐ │
│  │  Operations/sec (by type)       │ │  Latency P50/P95/P99        │ │
│  │  ▁▃▅▇█▇▅▃▁▂▄▆█▇▅▃▂▁▃▅▇█▇▅▃▁   │ │  ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅▆▇█   │ │
│  └─────────────────────────────────┘ └─────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Row 3: Capacity                                                     │
│  ┌─────────────────────────────────┐ ┌─────────────────────────────┐ │
│  │  Memory by Node                 │ │  Evictions + Expirations    │ │
│  │  Node1: ████████░░ 80%          │ │  ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅▆▇█   │ │
│  │  Node2: ██████░░░░ 60%          │ │  Evictions   Expirations    │ │
│  │  Node3: ███████░░░ 70%          │ │                             │ │
│  └─────────────────────────────────┘ └─────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Row 4: Hot Keys and Issues                                          │
│  ┌─────────────────────────────────┐ ┌─────────────────────────────┐ │
│  │  Top 10 Hot Keys                │ │  Recent Alerts              │ │
│  │  1. product:12345    (15.2K)    │ │  • HotKeyDetected 2m ago    │ │
│  │  2. user:session:abc (12.1K)    │ │  • CacheMemoryHigh 5m ago   │ │
│  │  3. config:flags     (9.8K)     │ │                             │ │
│  └─────────────────────────────────┘ └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Future Optimizations

1. **Replication**: Leader-follower for fault tolerance
2. **Persistence**: WAL or periodic snapshots
3. **Hot Key Handling**: Read replicas, client-side caching
4. **Connection Pooling**: Reuse connections between coordinator and nodes
5. **Pipelining**: Batch multiple operations in single request
6. **Binary Protocol**: Switch to RESP for lower overhead
7. **Cluster Consensus**: Use Raft for configuration management
