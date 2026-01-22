# Distributed Cache - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements
- **GET/SET/DELETE**: Core cache operations with string keys and arbitrary values
- **TTL Support**: Per-key expiration with configurable time-to-live
- **Eviction**: LRU eviction when memory limits are exceeded
- **Distribution**: Partition data across multiple nodes for scale
- **Replication**: Data redundancy for fault tolerance

### Non-Functional Requirements
- **Latency**: Sub-millisecond for local cache, < 5ms for distributed reads
- **Throughput**: 100K+ operations per second per node
- **Availability**: 99.9% uptime, survive single node failures
- **Consistency**: Eventual consistency with configurable guarantees
- **Memory Efficiency**: Maximize useful cache storage, minimize overhead

### Scale Estimation
- **Cache Size**: 10K entries per node, 100MB memory limit
- **Cluster Size**: 3-10 nodes typical deployment
- **Key Distribution**: Even spread via consistent hashing
- **Replication Factor**: 2-3 replicas per key

---

## 2. High-Level Architecture (5 minutes)

```
                                    ┌─────────────────┐
                                    │   Coordinator   │
                                    │   (Router)      │
                                    └────────┬────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
                    ▼                        ▼                        ▼
            ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
            │  Cache Node 1 │        │  Cache Node 2 │        │  Cache Node 3 │
            │   Port 3001   │        │   Port 3002   │        │   Port 3003   │
            └───────────────┘        └───────────────┘        └───────────────┘
                    │                        │                        │
                    └────────────────────────┼────────────────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Consistent     │
                                    │  Hash Ring      │
                                    └─────────────────┘
```

### Component Responsibilities
- **Coordinator**: Routes requests to appropriate nodes, health monitoring
- **Cache Nodes**: Store data, handle TTL, perform eviction
- **Hash Ring**: Determines key-to-node mapping with virtual nodes

---

## 3. Consistent Hashing Implementation (8 minutes)

### Hash Ring with Virtual Nodes

```typescript
import crypto from 'crypto';

interface VirtualNode {
  hash: number;
  nodeId: string;
  virtualIndex: number;
}

class ConsistentHashRing {
  private ring: VirtualNode[] = [];
  private nodes: Map<string, string> = new Map(); // nodeId -> address
  private readonly virtualNodes: number;

  constructor(virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
  }

  private hash(key: string): number {
    const md5 = crypto.createHash('md5').update(key).digest('hex');
    // Use first 8 hex chars (32 bits) for hash space
    return parseInt(md5.substring(0, 8), 16);
  }

  addNode(nodeId: string, address: string): void {
    this.nodes.set(nodeId, address);

    // Create virtual nodes for even distribution
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${nodeId}:${i}`;
      const hash = this.hash(virtualKey);

      this.ring.push({
        hash,
        nodeId,
        virtualIndex: i,
      });
    }

    // Keep ring sorted by hash for binary search
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter(vn => vn.nodeId !== nodeId);
  }

  getNode(key: string): string | null {
    if (this.ring.length === 0) return null;

    const keyHash = this.hash(key);

    // Binary search for first node with hash >= keyHash
    let left = 0;
    let right = this.ring.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.ring[mid].hash < keyHash) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Wrap around if we're past the last node
    const index = left % this.ring.length;
    const nodeId = this.ring[index].nodeId;

    return this.nodes.get(nodeId) || null;
  }

  // Get N distinct nodes for replication
  getNodes(key: string, count: number): string[] {
    if (this.ring.length === 0) return [];

    const keyHash = this.hash(key);
    const nodes: string[] = [];
    const seenNodeIds = new Set<string>();

    // Find starting position
    let left = 0;
    let right = this.ring.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.ring[mid].hash < keyHash) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Walk clockwise collecting distinct physical nodes
    for (let i = 0; i < this.ring.length && nodes.length < count; i++) {
      const index = (left + i) % this.ring.length;
      const nodeId = this.ring[index].nodeId;

      if (!seenNodeIds.has(nodeId)) {
        seenNodeIds.add(nodeId);
        const address = this.nodes.get(nodeId);
        if (address) nodes.push(address);
      }
    }

    return nodes;
  }

  getDistribution(sampleKeys: string[]): Map<string, number> {
    const distribution = new Map<string, number>();

    for (const nodeId of this.nodes.keys()) {
      distribution.set(nodeId, 0);
    }

    for (const key of sampleKeys) {
      const address = this.getNode(key);
      if (address) {
        // Find nodeId by address
        for (const [nodeId, addr] of this.nodes) {
          if (addr === address) {
            distribution.set(nodeId, (distribution.get(nodeId) || 0) + 1);
            break;
          }
        }
      }
    }

    return distribution;
  }
}
```

### Why 150 Virtual Nodes?

| Virtual Nodes | Standard Deviation | Memory Overhead |
|--------------|-------------------|-----------------|
| 50           | ~8%               | Low             |
| 100          | ~5%               | Medium          |
| 150          | ~3%               | Medium          |
| 500          | ~1%               | High            |

150 provides good balance: < 5% variance in key distribution with reasonable memory.

---

## 4. LRU Cache with TTL (8 minutes)

### Doubly-Linked List for O(1) Operations

```typescript
interface CacheEntry<T> {
  key: string;
  value: T;
  size: number;
  createdAt: number;
  expiresAt: number | null;
  prev: CacheEntry<T> | null;
  next: CacheEntry<T> | null;
}

interface CacheConfig {
  maxEntries: number;
  maxMemoryBytes: number;
  defaultTTLMs: number;
  activeExpirationIntervalMs: number;
  activeExpirationSampleSize: number;
}

class LRUCache<T = unknown> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private head: CacheEntry<T> | null = null; // Most recently used
  private tail: CacheEntry<T> | null = null; // Least recently used
  private currentMemory = 0;
  private expirationTimer: NodeJS.Timeout | null = null;

  // Metrics
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(private config: CacheConfig) {
    this.startActiveExpiration();
  }

  private estimateSize(value: T): number {
    // Approximate memory using JSON serialization
    // Not perfect but reasonable for learning purposes
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf-8');
    } catch {
      return 1024; // Default estimate for non-serializable
    }
  }

  private moveToHead(entry: CacheEntry<T>): void {
    if (entry === this.head) return;

    // Remove from current position
    if (entry.prev) entry.prev.next = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    if (entry === this.tail) this.tail = entry.prev;

    // Insert at head
    entry.prev = null;
    entry.next = this.head;
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;
  }

  private removeTail(): CacheEntry<T> | null {
    if (!this.tail) return null;

    const entry = this.tail;

    if (this.tail.prev) {
      this.tail.prev.next = null;
      this.tail = this.tail.prev;
    } else {
      this.head = null;
      this.tail = null;
    }

    return entry;
  }

  private removeEntry(entry: CacheEntry<T>): void {
    if (entry.prev) entry.prev.next = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    if (entry === this.head) this.head = entry.next;
    if (entry === this.tail) this.tail = entry.prev;
  }

  private isExpired(entry: CacheEntry<T>): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  private evictIfNeeded(): void {
    // Evict by entry count
    while (this.cache.size >= this.config.maxEntries) {
      const evicted = this.removeTail();
      if (evicted) {
        this.cache.delete(evicted.key);
        this.currentMemory -= evicted.size;
        this.evictions++;
      } else {
        break;
      }
    }

    // Evict by memory
    while (this.currentMemory >= this.config.maxMemoryBytes) {
      const evicted = this.removeTail();
      if (evicted) {
        this.cache.delete(evicted.key);
        this.currentMemory -= evicted.size;
        this.evictions++;
      } else {
        break;
      }
    }
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Lazy expiration check
    if (this.isExpired(entry)) {
      this.delete(key);
      this.expirations++;
      this.misses++;
      return null;
    }

    // Move to head (most recently used)
    this.moveToHead(entry);
    this.hits++;

    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const size = this.estimateSize(value);
    const now = Date.now();
    const ttl = ttlMs ?? this.config.defaultTTLMs;
    const expiresAt = ttl > 0 ? now + ttl : null;

    // Check if updating existing entry
    const existing = this.cache.get(key);
    if (existing) {
      this.currentMemory -= existing.size;
      this.removeEntry(existing);
    }

    // Create new entry
    const entry: CacheEntry<T> = {
      key,
      value,
      size,
      createdAt: now,
      expiresAt,
      prev: null,
      next: null,
    };

    // Add memory before eviction check
    this.currentMemory += size;

    // Evict if necessary (before adding new entry)
    this.evictIfNeeded();

    // Add to cache and move to head
    this.cache.set(key, entry);
    this.moveToHead(entry);
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.removeEntry(entry);
    this.cache.delete(key);
    this.currentMemory -= entry.size;

    return true;
  }

  // Active expiration: sample random keys and delete expired
  private startActiveExpiration(): void {
    this.expirationTimer = setInterval(() => {
      this.sampleAndExpire();
    }, this.config.activeExpirationIntervalMs);
  }

  private sampleAndExpire(): void {
    const keys = Array.from(this.cache.keys());
    const sampleSize = Math.min(this.config.activeExpirationSampleSize, keys.length);

    // Random sampling
    for (let i = 0; i < sampleSize; i++) {
      const randomIndex = Math.floor(Math.random() * keys.length);
      const key = keys[randomIndex];
      const entry = this.cache.get(key);

      if (entry && this.isExpired(entry)) {
        this.delete(key);
        this.expirations++;
      }
    }
  }

  getStats(): CacheStats {
    return {
      entries: this.cache.size,
      memoryBytes: this.currentMemory,
      maxEntries: this.config.maxEntries,
      maxMemoryBytes: this.config.maxMemoryBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits / (this.hits + this.misses) || 0,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  shutdown(): void {
    if (this.expirationTimer) {
      clearInterval(this.expirationTimer);
    }
  }
}

interface CacheStats {
  entries: number;
  memoryBytes: number;
  maxEntries: number;
  maxMemoryBytes: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  expirations: number;
}
```

### Expiration Strategy Comparison

| Strategy | Pros | Cons |
|----------|------|------|
| Lazy only | Zero CPU overhead | Memory bloat with many expired keys |
| Active only | Predictable cleanup | CPU overhead even when idle |
| Lazy + Active | Best of both | Slightly more complex |

We use lazy + active: check on access (lazy) plus sample 20 random keys every second (active).

---

## 5. Cache Node HTTP Server (6 minutes)

```typescript
import express from 'express';
import { LRUCache } from './lru-cache.js';

const app = express();
app.use(express.json());

const cache = new LRUCache({
  maxEntries: 10000,
  maxMemoryBytes: 100 * 1024 * 1024, // 100MB
  defaultTTLMs: 300000, // 5 minutes
  activeExpirationIntervalMs: 1000,
  activeExpirationSampleSize: 20,
});

// GET /cache/:key
app.get('/cache/:key', (req, res) => {
  const { key } = req.params;
  const value = cache.get(key);

  if (value === null) {
    return res.status(404).json({ error: 'Key not found' });
  }

  res.json({ key, value });
});

// PUT /cache/:key
app.put('/cache/:key', (req, res) => {
  const { key } = req.params;
  const { value, ttl } = req.body;

  if (value === undefined) {
    return res.status(400).json({ error: 'Value is required' });
  }

  cache.set(key, value, ttl);
  res.status(201).json({ key, stored: true });
});

// DELETE /cache/:key
app.delete('/cache/:key', (req, res) => {
  const { key } = req.params;
  const deleted = cache.delete(key);

  res.json({ key, deleted });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: Date.now() });
});

// GET /stats
app.get('/stats', (req, res) => {
  res.json(cache.getStats());
});

// Prometheus metrics endpoint
app.get('/metrics', (req, res) => {
  const stats = cache.getStats();

  const metrics = `
# HELP cache_entries Current number of entries in cache
# TYPE cache_entries gauge
cache_entries ${stats.entries}

# HELP cache_memory_bytes Current memory usage in bytes
# TYPE cache_memory_bytes gauge
cache_memory_bytes ${stats.memoryBytes}

# HELP cache_hits_total Total cache hits
# TYPE cache_hits_total counter
cache_hits_total ${stats.hits}

# HELP cache_misses_total Total cache misses
# TYPE cache_misses_total counter
cache_misses_total ${stats.misses}

# HELP cache_hit_rate Current cache hit rate
# TYPE cache_hit_rate gauge
cache_hit_rate ${stats.hitRate}

# HELP cache_evictions_total Total evictions due to capacity
# TYPE cache_evictions_total counter
cache_evictions_total ${stats.evictions}

# HELP cache_expirations_total Total expirations due to TTL
# TYPE cache_expirations_total counter
cache_expirations_total ${stats.expirations}
`.trim();

  res.set('Content-Type', 'text/plain');
  res.send(metrics);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Cache node listening on port ${PORT}`);
});
```

---

## 6. Coordinator Service (6 minutes)

```typescript
import express from 'express';
import axios from 'axios';
import { ConsistentHashRing } from './hash-ring.js';

const app = express();
app.use(express.json());

const ring = new ConsistentHashRing(150);

interface NodeHealth {
  address: string;
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
}

const nodeHealth: Map<string, NodeHealth> = new Map();
const HEALTH_CHECK_INTERVAL = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;
const REPLICATION_FACTOR = 2;
const WRITE_QUORUM = 2;
const READ_QUORUM = 1;

// Initialize nodes from config
const initialNodes = [
  { id: 'node1', address: 'http://localhost:3001' },
  { id: 'node2', address: 'http://localhost:3002' },
  { id: 'node3', address: 'http://localhost:3003' },
];

for (const node of initialNodes) {
  ring.addNode(node.id, node.address);
  nodeHealth.set(node.id, {
    address: node.address,
    healthy: true,
    lastCheck: Date.now(),
    consecutiveFailures: 0,
  });
}

// Health check loop
setInterval(async () => {
  for (const [nodeId, health] of nodeHealth) {
    try {
      const response = await axios.get(`${health.address}/health`, {
        timeout: 2000,
      });

      if (response.status === 200) {
        health.healthy = true;
        health.consecutiveFailures = 0;
      }
    } catch (error) {
      health.consecutiveFailures++;

      if (health.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        health.healthy = false;
        ring.removeNode(nodeId);
        console.log(`Node ${nodeId} removed from ring after ${MAX_CONSECUTIVE_FAILURES} failures`);
      }
    }

    health.lastCheck = Date.now();
  }
}, HEALTH_CHECK_INTERVAL);

// GET /cache/:key - Read with quorum
app.get('/cache/:key', async (req, res) => {
  const { key } = req.params;
  const nodes = ring.getNodes(key, REPLICATION_FACTOR);

  if (nodes.length === 0) {
    return res.status(503).json({ error: 'No healthy nodes available' });
  }

  // Read from first available node (read quorum = 1)
  for (const nodeAddress of nodes.slice(0, READ_QUORUM)) {
    try {
      const response = await axios.get(`${nodeAddress}/cache/${encodeURIComponent(key)}`, {
        timeout: 5000,
      });
      return res.json(response.data);
    } catch (error: any) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: 'Key not found' });
      }
      // Try next node
      continue;
    }
  }

  res.status(503).json({ error: 'All nodes failed' });
});

// PUT /cache/:key - Write with quorum
app.put('/cache/:key', async (req, res) => {
  const { key } = req.params;
  const { value, ttl } = req.body;

  const nodes = ring.getNodes(key, REPLICATION_FACTOR);

  if (nodes.length < WRITE_QUORUM) {
    return res.status(503).json({
      error: `Insufficient nodes for write quorum (need ${WRITE_QUORUM}, have ${nodes.length})`
    });
  }

  // Write to all replica nodes in parallel
  const writePromises = nodes.map(nodeAddress =>
    axios.put(
      `${nodeAddress}/cache/${encodeURIComponent(key)}`,
      { value, ttl },
      { timeout: 5000 }
    ).then(() => ({ success: true, node: nodeAddress }))
     .catch(err => ({ success: false, node: nodeAddress, error: err.message }))
  );

  const results = await Promise.all(writePromises);
  const successes = results.filter(r => r.success);

  if (successes.length >= WRITE_QUORUM) {
    res.status(201).json({
      key,
      stored: true,
      replicas: successes.length,
      quorum: WRITE_QUORUM,
    });
  } else {
    res.status(503).json({
      error: 'Write quorum not achieved',
      successes: successes.length,
      required: WRITE_QUORUM,
    });
  }
});

// DELETE /cache/:key - Delete from all replicas
app.delete('/cache/:key', async (req, res) => {
  const { key } = req.params;
  const nodes = ring.getNodes(key, REPLICATION_FACTOR);

  const deletePromises = nodes.map(nodeAddress =>
    axios.delete(`${nodeAddress}/cache/${encodeURIComponent(key)}`, { timeout: 5000 })
      .then(() => ({ success: true, node: nodeAddress }))
      .catch(() => ({ success: false, node: nodeAddress }))
  );

  const results = await Promise.all(deletePromises);
  const successes = results.filter(r => r.success).length;

  res.json({ key, deleted: successes > 0, nodesUpdated: successes });
});

// GET /cluster/status
app.get('/cluster/status', (req, res) => {
  const nodes = Array.from(nodeHealth.entries()).map(([id, health]) => ({
    id,
    ...health,
  }));

  res.json({
    totalNodes: nodes.length,
    healthyNodes: nodes.filter(n => n.healthy).length,
    nodes,
    replicationFactor: REPLICATION_FACTOR,
    writeQuorum: WRITE_QUORUM,
    readQuorum: READ_QUORUM,
  });
});

// GET /cluster/distribution - Show key distribution across nodes
app.get('/cluster/distribution', (req, res) => {
  const sampleSize = 10000;
  const sampleKeys = Array.from({ length: sampleSize }, (_, i) => `sample-key-${i}`);
  const distribution = ring.getDistribution(sampleKeys);

  const result: Record<string, { count: number; percentage: string }> = {};
  for (const [nodeId, count] of distribution) {
    result[nodeId] = {
      count,
      percentage: ((count / sampleSize) * 100).toFixed(2) + '%',
    };
  }

  res.json({
    sampleSize,
    distribution: result,
    virtualNodesPerNode: 150,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Coordinator listening on port ${PORT}`);
});
```

---

## 7. Replication and Consistency (5 minutes)

### Quorum Configuration

```typescript
// Configurable consistency levels
interface QuorumConfig {
  replicationFactor: number;  // N: total replicas
  writeQuorum: number;        // W: writes that must succeed
  readQuorum: number;         // R: reads that must succeed
}

// Strong consistency: W + R > N
const strongConsistency: QuorumConfig = {
  replicationFactor: 3,
  writeQuorum: 2,
  readQuorum: 2,
};

// Eventual consistency (favor availability)
const eventualConsistency: QuorumConfig = {
  replicationFactor: 3,
  writeQuorum: 1,
  readQuorum: 1,
};

// Read-heavy workload
const readHeavy: QuorumConfig = {
  replicationFactor: 3,
  writeQuorum: 3,  // All replicas must ack
  readQuorum: 1,   // Any replica can serve
};
```

### Read Repair

```typescript
async function getWithRepair(key: string): Promise<{ value: unknown; repaired: boolean }> {
  const nodes = ring.getNodes(key, REPLICATION_FACTOR);

  const responses = await Promise.allSettled(
    nodes.map(node => axios.get(`${node}/cache/${encodeURIComponent(key)}`))
  );

  const values: { node: string; value: unknown; version?: number }[] = [];

  for (let i = 0; i < responses.length; i++) {
    const response = responses[i];
    if (response.status === 'fulfilled') {
      values.push({
        node: nodes[i],
        value: response.value.data.value,
        version: response.value.data.version,
      });
    }
  }

  if (values.length === 0) {
    throw new Error('Key not found on any replica');
  }

  // Find newest version (if versioned)
  const newest = values.reduce((a, b) =>
    (b.version ?? 0) > (a.version ?? 0) ? b : a
  );

  // Repair stale replicas asynchronously
  const staleNodes = values
    .filter(v => v.version !== newest.version)
    .map(v => v.node);

  if (staleNodes.length > 0) {
    setImmediate(async () => {
      for (const node of staleNodes) {
        try {
          await axios.put(`${node}/cache/${encodeURIComponent(key)}`, {
            value: newest.value,
          });
          console.log(`Read repair: updated ${node} for key ${key}`);
        } catch (error) {
          console.error(`Read repair failed for ${node}: ${error}`);
        }
      }
    });
  }

  return {
    value: newest.value,
    repaired: staleNodes.length > 0,
  };
}
```

---

## 8. Hot Key Detection and Mitigation (4 minutes)

```typescript
class HotKeyDetector {
  private accessCounts: Map<string, number> = new Map();
  private windowStart: number = Date.now();
  private readonly windowMs: number;
  private readonly threshold: number;

  constructor(windowMs = 60000, threshold = 1000) {
    this.windowMs = windowMs;
    this.threshold = threshold;
  }

  recordAccess(key: string): boolean {
    const now = Date.now();

    // Reset window if expired
    if (now - this.windowStart > this.windowMs) {
      this.accessCounts.clear();
      this.windowStart = now;
    }

    const count = (this.accessCounts.get(key) || 0) + 1;
    this.accessCounts.set(key, count);

    return count >= this.threshold;
  }

  getHotKeys(): Array<{ key: string; count: number }> {
    return Array.from(this.accessCounts.entries())
      .filter(([_, count]) => count >= this.threshold)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }
}

// Integration with coordinator
const hotKeyDetector = new HotKeyDetector(60000, 1000);
const localHotKeyCache: Map<string, { value: unknown; expiresAt: number }> = new Map();
const HOT_KEY_LOCAL_TTL = 1000; // 1 second local cache for hot keys

app.get('/cache/:key', async (req, res) => {
  const { key } = req.params;

  // Check local hot key cache first
  const localEntry = localHotKeyCache.get(key);
  if (localEntry && Date.now() < localEntry.expiresAt) {
    return res.json({ key, value: localEntry.value, source: 'hot-key-cache' });
  }

  const isHot = hotKeyDetector.recordAccess(key);

  // Normal routing...
  const nodes = ring.getNodes(key, REPLICATION_FACTOR);
  const response = await axios.get(`${nodes[0]}/cache/${encodeURIComponent(key)}`);

  // Cache hot keys locally at coordinator
  if (isHot) {
    localHotKeyCache.set(key, {
      value: response.data.value,
      expiresAt: Date.now() + HOT_KEY_LOCAL_TTL,
    });
  }

  res.json(response.data);
});
```

### Hot Key Mitigation Strategies

| Strategy | Pros | Cons |
|----------|------|------|
| Local caching | Simple, effective | Stale data briefly |
| Read replicas | Distributes load | More infrastructure |
| Key sharding | Eliminates bottleneck | Complex key management |
| Rate limiting | Protects system | Impacts users |

---

## 9. Cache Invalidation Patterns (3 minutes)

```typescript
// Pattern 1: Write-through (sync invalidation)
async function writeThrough(key: string, value: unknown): Promise<void> {
  // Update database first
  await database.update(key, value);

  // Then update cache
  await cache.set(key, value);
}

// Pattern 2: Write-behind (async invalidation)
const writeQueue: Array<{ key: string; value: unknown }> = [];

async function writeBehind(key: string, value: unknown): Promise<void> {
  // Update cache immediately
  await cache.set(key, value);

  // Queue database write
  writeQueue.push({ key, value });
}

// Background worker flushes queue
setInterval(async () => {
  const batch = writeQueue.splice(0, 100);
  for (const { key, value } of batch) {
    await database.update(key, value);
  }
}, 1000);

// Pattern 3: Cache-aside with TTL
async function cacheAside(key: string): Promise<unknown> {
  // Try cache first
  const cached = await cache.get(key);
  if (cached !== null) return cached;

  // Miss: fetch from database
  const value = await database.get(key);

  // Populate cache with TTL
  await cache.set(key, value, 300000); // 5 min TTL

  return value;
}

// Pattern 4: Pub/Sub invalidation for multi-node
import { createClient } from 'redis';

const pubsub = createClient();
await pubsub.subscribe('cache-invalidation', (message) => {
  const { key, action } = JSON.parse(message);

  if (action === 'delete') {
    cache.delete(key);
  } else if (action === 'update') {
    // Trigger refresh on next access
    cache.delete(key);
  }
});

async function invalidateAcrossCluster(key: string): Promise<void> {
  await pubsub.publish('cache-invalidation', JSON.stringify({
    key,
    action: 'delete',
    timestamp: Date.now(),
  }));
}
```

---

## 10. Key Backend Trade-offs

### Decision Matrix

| Decision | Choice | Trade-off |
|----------|--------|-----------|
| Hash function | MD5 | Fast, good distribution, not cryptographic (fine for hashing) |
| Virtual nodes | 150 | ~3% variance, moderate memory overhead |
| Expiration | Lazy + Active | CPU for sampling, but prevents memory bloat |
| Protocol | HTTP | Higher overhead than binary, but easier to debug |
| Consistency | Quorum-based | Configurable W/R for CAP trade-offs |
| Replication | Synchronous writes | Higher latency, but strong durability |

### When to Use Each Consistency Level

```
Strong Consistency (W + R > N):
- Financial data
- User authentication tokens
- Configuration that must be consistent

Eventual Consistency (W=1, R=1):
- Session data
- View counts
- Recommendations
- Any data that tolerates brief staleness
```

---

## 11. Production Considerations

### Circuit Breaker for Node Failures

```typescript
import Opossum from 'opossum';

function createNodeClient(address: string) {
  const breaker = new Opossum(
    async (key: string) => {
      const response = await axios.get(`${address}/cache/${encodeURIComponent(key)}`, {
        timeout: 5000,
      });
      return response.data;
    },
    {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    }
  );

  breaker.on('open', () => {
    console.log(`Circuit open for ${address}`);
  });

  breaker.on('halfOpen', () => {
    console.log(`Circuit half-open for ${address}`);
  });

  return breaker;
}
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');

  // Stop accepting new requests
  server.close();

  // Persist cache state if configured
  if (config.persistence.enabled) {
    await persistCacheSnapshot();
  }

  // Close health check timers
  cache.shutdown();

  process.exit(0);
});
```

---

## Summary

This distributed cache implementation demonstrates key backend concepts:

1. **Consistent Hashing**: O(log n) lookup with virtual nodes for even distribution
2. **LRU Cache**: O(1) operations with doubly-linked list
3. **TTL Expiration**: Lazy + active hybrid for efficiency
4. **Replication**: Quorum-based for configurable consistency
5. **Hot Key Handling**: Detection and local caching at coordinator
6. **Invalidation**: Multiple patterns for different use cases
7. **Observability**: Prometheus metrics, health checks, circuit breakers

The coordinator pattern adds a network hop but simplifies client implementation and enables cluster-wide features like hot key detection and health monitoring.
