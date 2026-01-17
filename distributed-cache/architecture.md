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

## Implementation Notes

This section documents the WHY behind key implementation decisions, connecting system design theory to operational reality.

### Why Hit/Miss Metrics Enable Cache Sizing Optimization

Hit/miss metrics are the most critical observability signal for a cache because they directly measure cache effectiveness and guide capacity planning:

1. **Right-sizing cache memory**: If hit rate is 95% with 100MB per node, adding more memory yields diminishing returns. If hit rate is 60%, the cache is too small and needs expansion. Without metrics, operators are guessing.

2. **Detecting workload changes**: A sudden drop in hit rate (e.g., from 90% to 70%) indicates either:
   - Working set grew larger than cache capacity
   - Access patterns changed (temporal locality decreased)
   - A deployment changed key naming conventions

3. **Cost optimization**: In cloud environments, memory is expensive. Hit/miss metrics let you find the minimum cache size that maintains acceptable performance. A 1% hit rate improvement might save $10,000/month in database costs.

4. **SLA validation**: If your SLA requires < 10ms P99 latency, and cache misses take 50ms (database roundtrip), you need hit rate > 80% to meet that SLA. Metrics prove compliance.

**Implementation**: We use Prometheus counters (`cache_hits_total`, `cache_misses_total`) with node labels, enabling per-node and cluster-wide aggregation. The `/metrics` endpoint exposes these in Prometheus format for scraping.

### Why Hot Key Detection Prevents Uneven Load

Hot keys are the most common cause of cache cluster instability. A single key receiving 10% of traffic breaks the consistent hashing promise of even distribution:

1. **Single node overload**: If `product:popular-item` receives 100K requests/sec but only routes to Node 1, that node saturates while Node 2 and 3 are idle. The cluster has 3x theoretical capacity but only 1x usable capacity.

2. **Cascading failures**: Overloaded Node 1 starts timing out. Clients retry. Retries increase load further. Node 1 crashes. Now all hot key requests fail. This is a classic thundering herd.

3. **Invisible in aggregate metrics**: Cluster-wide hit rate might be 90% (healthy), but Node 1 is at 99% CPU. Without per-key tracking, the root cause is invisible.

4. **Proactive mitigation**: Once detected, hot keys can be mitigated via:
   - Local caching at coordinator (1 second TTL)
   - Key sharding (`product:popular-item:shard0`, `shard1`, `shard2`)
   - Read replicas on multiple nodes

**Implementation**: The `HotKeyDetector` class samples key accesses in 60-second windows. Keys exceeding 1% of total traffic are flagged. The `/hot-keys` endpoint exposes current hot keys, and `cache_hot_key_accesses` Prometheus metric enables alerting.

### Why Admin Auth Protects Cluster Operations

Admin endpoints can destroy the entire cache cluster in one API call. Without authentication, any network-adjacent attacker (or misconfigured script) can:

1. **Flush all data**: `POST /flush` clears every key. If this hits production during peak traffic, databases receive 100% of load and collapse. Recovery takes hours.

2. **Add malicious nodes**: `POST /admin/node` could add an attacker-controlled server. That server now receives a fraction of all traffic, stealing data or injecting corrupted responses.

3. **Remove healthy nodes**: `DELETE /admin/node` removes nodes from the ring. With 3 nodes, removing 2 means 66% of requests fail until the ring rebalances.

4. **Denial of service**: Even rate-limited, repeated `/admin/health-check` forces health probes that consume CPU and network.

**Implementation**: The `requireAdminKey` middleware validates `X-Admin-Key` header using constant-time comparison (preventing timing attacks). Rate limiting (10 requests/minute) prevents brute-force. All admin operations are logged with client IP for audit trails. The key is configured via `ADMIN_KEY` environment variable, defaulting to `dev-admin-key` for local development.

### Why Graceful Rebalancing Prevents Cache Storms

When nodes are added or removed, consistent hashing reassigns ~1/N of keys to their new homes. Without graceful migration, those keys become "cold" (cache misses) simultaneously:

1. **Cache storm scenario**: Add Node 4 to a 3-node cluster. 25% of keys now hash to Node 4. But Node 4 is empty. 25% of all requests become cache misses. Databases receive 25% more load instantly. If databases were at 60% capacity, they jump to 75%+ and latency spikes.

2. **Thundering herd amplification**: Popular keys that moved to Node 4 don't just miss once; they miss for every concurrent request. 1000 concurrent users requesting the same product page all hit the database simultaneously.

3. **Recovery time**: Without migration, keys only warm up when accessed. If access is uniform, 25% of cache is cold for hours. If access follows power-law (80/20 rule), popular keys warm quickly but the tail takes days.

4. **Graceful migration solution**: Before adding a node to the ring, we:
   - Identify keys that will move to the new node
   - Copy those keys to the new node (batched, rate-limited)
   - Only then add the node to the ring
   - Keys are already warm when traffic arrives

**Implementation**: The `RebalanceManager` handles node additions and removals. It:
- Processes keys in batches of 100 with 50ms delays (configurable)
- Times out after 5 minutes to prevent indefinite blocking
- Tracks progress via `rebalance_keys_moved_total` and `rebalance_duration_seconds` metrics
- Logs progress at 10% intervals for visibility

The admin endpoint `POST /admin/rebalance` can trigger manual rebalancing, and `GET /admin/rebalance/analyze` previews impact before execution.

### Why Circuit Breakers Prevent Cascading Failures

When a cache node becomes unhealthy (overloaded, network partitioned, or crashed), continuing to send requests makes everything worse:

1. **Connection pool exhaustion**: Each request to a slow node ties up a connection. With 100 concurrent requests and 5-second timeout, you need 100 connections waiting. This exhausts client-side resources even though the server is unresponsive.

2. **Retry amplification**: Without circuit breakers, clients retry failed requests. Each retry adds load to an already struggling node. 3 retries means 3x the load.

3. **Coordinator impact**: The coordinator waiting on slow nodes can't serve other requests. One bad node degrades the entire cluster.

4. **Recovery prevention**: A temporarily overloaded node that could recover in 10 seconds never gets the chance because requests keep arriving.

**Implementation**: We use Opossum circuit breakers with:
- 5-second timeout per request
- Opens after 50% failure rate (minimum 5 requests)
- Half-open testing after 30 seconds
- Prometheus metrics: `circuit_breaker_state`, `circuit_breaker_trips_total`
- Structured logs on state transitions for debugging

When the circuit opens, requests fail fast (< 1ms) instead of waiting for timeout (5 seconds). This preserves resources for healthy nodes and lets the failing node recover.

### Why Snapshot Persistence Enables Fast Recovery

In-memory caches lose all data on restart. Without persistence, a restart means:

1. **Cold cache**: 100% of requests become misses until the cache warms up
2. **Database overload**: Full traffic to databases during warmup
3. **Extended degraded performance**: Popular keys warm quickly, but long-tail takes hours

Periodic snapshots solve this:

1. **Warm restart**: Load snapshot, resume with ~90% of data intact
2. **Point-in-time recovery**: Roll back to previous snapshot if corruption detected
3. **Disaster recovery**: Restore cache on a new server if hardware fails

**Implementation**: The `PersistenceManager`:
- Saves JSON snapshots every 60 seconds (configurable)
- Keeps last 3 snapshots (configurable retention)
- Filters expired entries on load (no stale data)
- Loads most-recently-updated entries first (prioritizes active data)
- Tracks via `snapshots_created_total`, `snapshot_entries_loaded` metrics

Snapshots are stored in `./data/{nodeId}/` with timestamp-based filenames.

### Why Structured Logging (Pino) Improves Debuggability

Console.log statements are unusable at scale. Structured JSON logging enables:

1. **Log aggregation**: Ship to ELK, Loki, or CloudWatch. Query across all nodes.
2. **Correlation**: Request IDs let you trace a single request across coordinator and cache nodes.
3. **Filtering**: Find all "admin_auth_failure" events, or all events from a specific node.
4. **Alerting**: Trigger PagerDuty when "circuit_breaker_state_change" event has `state: "open"`.
5. **Performance**: Pino is 5x faster than winston/bunyan because it avoids synchronous operations.

**Implementation**: We use pino with:
- JSON format in production, pretty-print in development
- Automatic redaction of sensitive headers (`X-Admin-Key`, `Authorization`)
- Component-based child loggers (`cacheLogger`, `clusterLogger`, `adminLogger`)
- HTTP request logging via pino-http with automatic request IDs
- Log levels configurable via `LOG_LEVEL` environment variable

Example log output:
```json
{"level":"info","time":"2024-01-16T10:30:00.000Z","nodeId":"node-1","component":"cache","key":"user:123","hit":true,"msg":"cache_hit"}
```
