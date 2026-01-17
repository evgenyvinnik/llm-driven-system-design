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

## Future Optimizations

1. **Replication**: Leader-follower for fault tolerance
2. **Persistence**: WAL or periodic snapshots
3. **Hot Key Handling**: Read replicas, client-side caching
4. **Connection Pooling**: Reuse connections between coordinator and nodes
5. **Pipelining**: Batch multiple operations in single request
6. **Binary Protocol**: Switch to RESP for lower overhead
7. **Cluster Consensus**: Use Raft for configuration management
