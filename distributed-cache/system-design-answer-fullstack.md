# Distributed Cache - System Design Answer (Fullstack Focus)

## 45-minute system design interview format - Fullstack Engineer Position

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements
- **Core Operations**: GET, SET, DELETE with string keys and arbitrary values
- **TTL Support**: Per-key expiration with configurable time-to-live
- **Distribution**: Partition data across multiple cache nodes
- **Admin Dashboard**: Monitor cluster health and manage cache entries
- **Replication**: Data redundancy for fault tolerance

### Non-Functional Requirements
- **Latency**: < 5ms for cache operations through coordinator
- **Availability**: Survive single node failures
- **Consistency**: Configurable via quorum settings
- **Usability**: Intuitive admin interface for operations

### Integration Points
- Frontend dashboard communicates with coordinator REST API
- Coordinator routes requests to cache nodes
- Nodes store data locally with LRU eviction

---

## 2. Shared Type Definitions (5 minutes)

### API Types

```typescript
// shared/types/cache.ts

// Core cache entry
export interface CacheEntry {
  key: string;
  value: unknown;
  ttl?: number;           // TTL in milliseconds
  createdAt?: number;     // Unix timestamp
  expiresAt?: number;     // Unix timestamp
  size?: number;          // Estimated size in bytes
}

// API request/response types
export interface SetRequest {
  value: unknown;
  ttl?: number;
}

export interface SetResponse {
  key: string;
  stored: boolean;
  replicas?: number;
  quorum?: number;
}

export interface GetResponse {
  key: string;
  value: unknown;
  source?: 'hot-key-cache' | 'node';
}

export interface DeleteResponse {
  key: string;
  deleted: boolean;
  nodesUpdated?: number;
}

// Cluster types
export interface NodeHealth {
  id: string;
  address: string;
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
}

export interface NodeStats {
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

export interface ClusterStatus {
  totalNodes: number;
  healthyNodes: number;
  nodes: NodeHealth[];
  replicationFactor: number;
  writeQuorum: number;
  readQuorum: number;
}

export interface KeyDistribution {
  sampleSize: number;
  virtualNodesPerNode: number;
  distribution: Record<string, {
    count: number;
    percentage: string;
  }>;
}
```

### Validation Schemas

```typescript
// shared/validation/cache.ts
import { z } from 'zod';

export const setRequestSchema = z.object({
  value: z.unknown(),
  ttl: z.number().positive().optional(),
});

export const keyParamSchema = z.object({
  key: z.string().min(1).max(512),
});

export const searchQuerySchema = z.object({
  pattern: z.string().min(1).max(256),
  limit: z.coerce.number().min(1).max(1000).default(100),
});

// Type inference from schemas
export type SetRequestInput = z.infer<typeof setRequestSchema>;
export type KeyParamInput = z.infer<typeof keyParamSchema>;
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
```

---

## 3. Backend: LRU Cache Implementation (6 minutes)

### Cache Node Core

```typescript
// backend/src/cache/lru-cache.ts
interface CacheNode<T> {
  key: string;
  value: T;
  size: number;
  expiresAt: number | null;
  prev: CacheNode<T> | null;
  next: CacheNode<T> | null;
}

export class LRUCache<T = unknown> {
  private cache = new Map<string, CacheNode<T>>();
  private head: CacheNode<T> | null = null;
  private tail: CacheNode<T> | null = null;
  private currentMemory = 0;

  constructor(
    private maxEntries: number,
    private maxMemoryBytes: number,
    private defaultTTLMs: number
  ) {}

  private estimateSize(value: T): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf-8');
  }

  private isExpired(node: CacheNode<T>): boolean {
    return node.expiresAt !== null && Date.now() > node.expiresAt;
  }

  private moveToHead(node: CacheNode<T>): void {
    if (node === this.head) return;

    // Remove from current position
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.tail) this.tail = node.prev;

    // Insert at head
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private evictLRU(): void {
    while (
      this.tail &&
      (this.cache.size >= this.maxEntries ||
        this.currentMemory >= this.maxMemoryBytes)
    ) {
      const key = this.tail.key;
      this.currentMemory -= this.tail.size;

      if (this.tail.prev) {
        this.tail.prev.next = null;
        this.tail = this.tail.prev;
      } else {
        this.head = null;
        this.tail = null;
      }

      this.cache.delete(key);
    }
  }

  get(key: string): T | null {
    const node = this.cache.get(key);

    if (!node) return null;

    // Lazy expiration
    if (this.isExpired(node)) {
      this.delete(key);
      return null;
    }

    this.moveToHead(node);
    return node.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const size = this.estimateSize(value);
    const ttl = ttlMs ?? this.defaultTTLMs;
    const expiresAt = ttl > 0 ? Date.now() + ttl : null;

    const existing = this.cache.get(key);
    if (existing) {
      this.currentMemory -= existing.size;
      this.delete(key);
    }

    this.currentMemory += size;
    this.evictLRU();

    const node: CacheNode<T> = {
      key,
      value,
      size,
      expiresAt,
      prev: null,
      next: this.head,
    };

    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;

    this.cache.set(key, node);
  }

  delete(key: string): boolean {
    const node = this.cache.get(key);
    if (!node) return false;

    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;

    this.currentMemory -= node.size;
    this.cache.delete(key);

    return true;
  }

  getStats(): NodeStats {
    // Stats implementation
    return {
      entries: this.cache.size,
      memoryBytes: this.currentMemory,
      maxEntries: this.maxEntries,
      maxMemoryBytes: this.maxMemoryBytes,
      hits: 0,  // Track in production
      misses: 0,
      hitRate: 0,
      evictions: 0,
      expirations: 0,
    };
  }
}
```

---

## 4. Backend: Consistent Hash Ring (5 minutes)

```typescript
// backend/src/routing/hash-ring.ts
import crypto from 'crypto';

export class ConsistentHashRing {
  private ring: Array<{ hash: number; nodeId: string }> = [];
  private nodes = new Map<string, string>(); // nodeId -> address

  constructor(private virtualNodes = 150) {}

  private hash(key: string): number {
    const md5 = crypto.createHash('md5').update(key).digest('hex');
    return parseInt(md5.substring(0, 8), 16);
  }

  addNode(nodeId: string, address: string): void {
    this.nodes.set(nodeId, address);

    for (let i = 0; i < this.virtualNodes; i++) {
      this.ring.push({
        hash: this.hash(`${nodeId}:${i}`),
        nodeId,
      });
    }

    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
    this.ring = this.ring.filter(vn => vn.nodeId !== nodeId);
  }

  getNode(key: string): string | null {
    if (this.ring.length === 0) return null;

    const keyHash = this.hash(key);

    // Binary search
    let left = 0, right = this.ring.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (this.ring[mid].hash < keyHash) left = mid + 1;
      else right = mid;
    }

    const nodeId = this.ring[left % this.ring.length].nodeId;
    return this.nodes.get(nodeId) || null;
  }

  getNodes(key: string, count: number): string[] {
    if (this.ring.length === 0) return [];

    const keyHash = this.hash(key);
    const nodes: string[] = [];
    const seen = new Set<string>();

    let left = 0, right = this.ring.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (this.ring[mid].hash < keyHash) left = mid + 1;
      else right = mid;
    }

    for (let i = 0; nodes.length < count && i < this.ring.length; i++) {
      const nodeId = this.ring[(left + i) % this.ring.length].nodeId;
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        const address = this.nodes.get(nodeId);
        if (address) nodes.push(address);
      }
    }

    return nodes;
  }
}
```

---

## 5. Backend: Coordinator with Quorum (6 minutes)

```typescript
// backend/src/coordinator/index.ts
import express from 'express';
import axios from 'axios';
import { ConsistentHashRing } from '../routing/hash-ring.js';
import { setRequestSchema, keyParamSchema } from '../../shared/validation/cache.js';
import type { ClusterStatus, SetResponse, GetResponse } from '../../shared/types/cache.js';

const app = express();
app.use(express.json());

const ring = new ConsistentHashRing(150);

// Configuration
const REPLICATION_FACTOR = 2;
const WRITE_QUORUM = 2;
const READ_QUORUM = 1;
const REQUEST_TIMEOUT = 5000;

// Node health tracking
const nodeHealth = new Map<string, {
  address: string;
  healthy: boolean;
  lastCheck: number;
  failures: number;
}>();

// Initialize nodes
const NODES = [
  { id: 'node1', address: 'http://localhost:3001' },
  { id: 'node2', address: 'http://localhost:3002' },
  { id: 'node3', address: 'http://localhost:3003' },
];

for (const node of NODES) {
  ring.addNode(node.id, node.address);
  nodeHealth.set(node.id, {
    address: node.address,
    healthy: true,
    lastCheck: Date.now(),
    failures: 0,
  });
}

// Health check loop
setInterval(async () => {
  for (const [nodeId, health] of nodeHealth) {
    try {
      await axios.get(`${health.address}/health`, { timeout: 2000 });
      health.healthy = true;
      health.failures = 0;
    } catch {
      health.failures++;
      if (health.failures >= 3) {
        health.healthy = false;
        ring.removeNode(nodeId);
      }
    }
    health.lastCheck = Date.now();
  }
}, 5000);

// GET /cache/:key
app.get('/cache/:key', async (req, res) => {
  const parseResult = keyParamSchema.safeParse(req.params);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  const { key } = parseResult.data;
  const nodes = ring.getNodes(key, REPLICATION_FACTOR);

  if (nodes.length === 0) {
    return res.status(503).json({ error: 'No healthy nodes' });
  }

  for (const nodeAddress of nodes.slice(0, READ_QUORUM)) {
    try {
      const response = await axios.get(
        `${nodeAddress}/cache/${encodeURIComponent(key)}`,
        { timeout: REQUEST_TIMEOUT }
      );
      const result: GetResponse = {
        key,
        value: response.data.value,
        source: 'node',
      };
      return res.json(result);
    } catch (error: any) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: 'Key not found' });
      }
    }
  }

  res.status(503).json({ error: 'All nodes failed' });
});

// PUT /cache/:key
app.put('/cache/:key', async (req, res) => {
  const keyParse = keyParamSchema.safeParse(req.params);
  const bodyParse = setRequestSchema.safeParse(req.body);

  if (!keyParse.success || !bodyParse.success) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const { key } = keyParse.data;
  const { value, ttl } = bodyParse.data;
  const nodes = ring.getNodes(key, REPLICATION_FACTOR);

  if (nodes.length < WRITE_QUORUM) {
    return res.status(503).json({
      error: `Need ${WRITE_QUORUM} nodes, have ${nodes.length}`,
    });
  }

  const results = await Promise.all(
    nodes.map(addr =>
      axios.put(
        `${addr}/cache/${encodeURIComponent(key)}`,
        { value, ttl },
        { timeout: REQUEST_TIMEOUT }
      ).then(() => true).catch(() => false)
    )
  );

  const successes = results.filter(Boolean).length;

  if (successes >= WRITE_QUORUM) {
    const result: SetResponse = {
      key,
      stored: true,
      replicas: successes,
      quorum: WRITE_QUORUM,
    };
    res.status(201).json(result);
  } else {
    res.status(503).json({
      error: 'Write quorum not achieved',
      successes,
      required: WRITE_QUORUM,
    });
  }
});

// DELETE /cache/:key
app.delete('/cache/:key', async (req, res) => {
  const { key } = req.params;
  const nodes = ring.getNodes(key, REPLICATION_FACTOR);

  const results = await Promise.all(
    nodes.map(addr =>
      axios.delete(`${addr}/cache/${encodeURIComponent(key)}`, {
        timeout: REQUEST_TIMEOUT,
      }).then(() => true).catch(() => false)
    )
  );

  res.json({
    key,
    deleted: results.some(Boolean),
    nodesUpdated: results.filter(Boolean).length,
  });
});

// GET /cluster/status
app.get('/cluster/status', (req, res) => {
  const nodes = Array.from(nodeHealth.entries()).map(([id, h]) => ({
    id,
    address: h.address,
    healthy: h.healthy,
    lastCheck: h.lastCheck,
    consecutiveFailures: h.failures,
  }));

  const status: ClusterStatus = {
    totalNodes: nodes.length,
    healthyNodes: nodes.filter(n => n.healthy).length,
    nodes,
    replicationFactor: REPLICATION_FACTOR,
    writeQuorum: WRITE_QUORUM,
    readQuorum: READ_QUORUM,
  };

  res.json(status);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Coordinator listening on port ${PORT}`);
});
```

---

## 6. Frontend: Zustand Store (5 minutes)

```typescript
// frontend/src/stores/clusterStore.ts
import { create } from 'zustand';
import type { ClusterStatus, NodeStats, KeyDistribution } from '../../shared/types/cache';
import { api } from '../services/api';

interface ClusterState {
  status: ClusterStatus | null;
  nodeStats: Map<string, NodeStats>;
  distribution: KeyDistribution | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;

  // Actions
  fetchStatus: () => Promise<void>;
  fetchDistribution: () => Promise<void>;
  fetchNodeStats: (nodeId: string) => Promise<NodeStats | null>;
}

export const useClusterStore = create<ClusterState>()((set, get) => ({
  status: null,
  nodeStats: new Map(),
  distribution: null,
  loading: false,
  error: null,
  lastUpdated: null,

  fetchStatus: async () => {
    set({ loading: true, error: null });

    try {
      const status = await api.get<ClusterStatus>('/cluster/status');

      // Fetch stats for healthy nodes in parallel
      const statsPromises = status.nodes
        .filter(n => n.healthy)
        .map(async n => {
          const stats = await get().fetchNodeStats(n.id);
          return [n.id, stats] as const;
        });

      const statsResults = await Promise.all(statsPromises);
      const nodeStats = new Map(
        statsResults.filter(([_, s]) => s !== null) as Array<[string, NodeStats]>
      );

      set({
        status,
        nodeStats,
        loading: false,
        lastUpdated: Date.now(),
      });
    } catch (error: any) {
      set({
        loading: false,
        error: error.message || 'Failed to fetch cluster status',
      });
    }
  },

  fetchDistribution: async () => {
    try {
      const distribution = await api.get<KeyDistribution>('/cluster/distribution');
      set({ distribution });
    } catch (error) {
      console.error('Failed to fetch distribution:', error);
    }
  },

  fetchNodeStats: async (nodeId: string) => {
    try {
      return await api.get<NodeStats>(`/node/${nodeId}/stats`);
    } catch {
      return null;
    }
  },
}));

// Computed values
export function useAggregatedStats() {
  const nodeStats = useClusterStore(state => state.nodeStats);

  return {
    totalEntries: Array.from(nodeStats.values()).reduce((s, n) => s + n.entries, 0),
    totalMemory: Array.from(nodeStats.values()).reduce((s, n) => s + n.memoryBytes, 0),
    avgHitRate: nodeStats.size > 0
      ? Array.from(nodeStats.values()).reduce((s, n) => s + n.hitRate, 0) / nodeStats.size
      : 0,
  };
}
```

---

## 7. Frontend: Cache Operations Store (4 minutes)

```typescript
// frontend/src/stores/cacheStore.ts
import { create } from 'zustand';
import type { CacheEntry, GetResponse, SetResponse } from '../../shared/types/cache';
import { api } from '../services/api';

interface CacheState {
  entries: CacheEntry[];
  searchQuery: string;
  loading: boolean;
  operationPending: boolean;
  error: string | null;

  setSearchQuery: (query: string) => void;
  getKey: (key: string) => Promise<CacheEntry | null>;
  setKey: (key: string, value: unknown, ttl?: number) => Promise<boolean>;
  deleteKey: (key: string) => Promise<boolean>;
}

export const useCacheStore = create<CacheState>()((set, get) => ({
  entries: [],
  searchQuery: '',
  loading: false,
  operationPending: false,
  error: null,

  setSearchQuery: (query) => set({ searchQuery: query }),

  getKey: async (key) => {
    set({ loading: true, error: null });

    try {
      const response = await api.get<GetResponse>(`/cache/${encodeURIComponent(key)}`);
      set({ loading: false });
      return { key, value: response.value };
    } catch (error: any) {
      set({
        loading: false,
        error: error.status === 404 ? 'Key not found' : error.message,
      });
      return null;
    }
  },

  setKey: async (key, value, ttl) => {
    const prevEntries = get().entries;

    // Optimistic update
    set({
      operationPending: true,
      error: null,
      entries: [
        { key, value, ttl },
        ...prevEntries.filter(e => e.key !== key),
      ],
    });

    try {
      await api.put<SetResponse>(`/cache/${encodeURIComponent(key)}`, { value, ttl });
      set({ operationPending: false });
      return true;
    } catch (error: any) {
      // Rollback
      set({
        entries: prevEntries,
        operationPending: false,
        error: error.message,
      });
      return false;
    }
  },

  deleteKey: async (key) => {
    const prevEntries = get().entries;

    // Optimistic update
    set({
      operationPending: true,
      error: null,
      entries: prevEntries.filter(e => e.key !== key),
    });

    try {
      await api.delete(`/cache/${encodeURIComponent(key)}`);
      set({ operationPending: false });
      return true;
    } catch (error: any) {
      // Rollback
      set({
        entries: prevEntries,
        operationPending: false,
        error: error.message,
      });
      return false;
    }
  },
}));
```

---

## 8. Frontend: Dashboard Component (5 minutes)

```tsx
// frontend/src/routes/index.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useClusterStore, useAggregatedStats } from '../stores/clusterStore';
import { StatsCard } from '../components/StatsCard';
import { NodeStatusList } from '../components/NodeStatusList';
import { HashRingViz } from '../components/HashRingViz';

export const Route = createFileRoute('/')({
  component: Dashboard,
});

function Dashboard() {
  const { status, distribution, loading, lastUpdated, fetchStatus, fetchDistribution } =
    useClusterStore();
  const aggregated = useAggregatedStats();

  useEffect(() => {
    fetchStatus();
    fetchDistribution();

    const interval = setInterval(() => {
      fetchStatus();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchStatus, fetchDistribution]);

  if (loading && !status) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Cache Dashboard</h1>
        <div className="text-sm text-gray-500">
          Last updated: {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : 'Never'}
        </div>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatsCard
          title="Cluster Health"
          value={`${status?.healthyNodes ?? 0}/${status?.totalNodes ?? 0}`}
          subtitle="nodes healthy"
          status={
            status?.healthyNodes === status?.totalNodes
              ? 'good'
              : (status?.healthyNodes ?? 0) > 0
              ? 'warning'
              : 'bad'
          }
        />
        <StatsCard
          title="Total Entries"
          value={aggregated.totalEntries.toLocaleString()}
          subtitle="cached keys"
        />
        <StatsCard
          title="Memory Usage"
          value={formatBytes(aggregated.totalMemory)}
          subtitle="across cluster"
        />
        <StatsCard
          title="Hit Rate"
          value={`${(aggregated.avgHitRate * 100).toFixed(1)}%`}
          subtitle="cache efficiency"
          status={
            aggregated.avgHitRate >= 0.9
              ? 'good'
              : aggregated.avgHitRate >= 0.7
              ? 'warning'
              : 'bad'
          }
        />
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Node Status</h2>
          <NodeStatusList nodes={status?.nodes ?? []} />
        </section>

        <section className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Key Distribution</h2>
          {distribution && status && (
            <HashRingViz
              nodes={status.nodes}
              distribution={distribution.distribution}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

---

## 9. End-to-End Data Flow (4 minutes)

### Cache SET Operation

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           SET user:123 = {...}                               │
└──────────────────────────────────────────────────────────────────────────────┘

Frontend                    Coordinator                   Cache Nodes
   │                            │                             │
   │ PUT /cache/user:123        │                             │
   │ {value: {...}, ttl: 300}   │                             │
   ├───────────────────────────►│                             │
   │                            │                             │
   │                            │ hash("user:123") = 0x4A2B   │
   │                            │ getNodes(key, RF=2)         │
   │                            │ → [node1, node2]            │
   │                            │                             │
   │                            │ PUT /cache/user:123 (parallel)
   │                            ├─────────────────────────────►│ Node 1
   │                            ├─────────────────────────────►│ Node 2
   │                            │                             │
   │                            │     {stored: true} ◄────────┤
   │                            │     {stored: true} ◄────────┤
   │                            │                             │
   │                            │ successes >= WRITE_QUORUM?  │
   │                            │ 2 >= 2 ✓                    │
   │                            │                             │
   │   201 Created              │                             │
   │   {stored: true,           │                             │
   │    replicas: 2,            │                             │
   │    quorum: 2}              │                             │
   │◄───────────────────────────┤                             │
   │                            │                             │
   │ Optimistic update verified │                             │
   │ (already showed success)   │                             │
   │                            │                             │
```

### Cache GET Operation

```
Frontend                    Coordinator                   Cache Nodes
   │                            │                             │
   │ GET /cache/user:123        │                             │
   ├───────────────────────────►│                             │
   │                            │                             │
   │                            │ hash("user:123") = 0x4A2B   │
   │                            │ getNodes(key, RF=2)         │
   │                            │ → [node1, node2]            │
   │                            │                             │
   │                            │ READ_QUORUM = 1             │
   │                            │ GET from node1 first        │
   │                            ├─────────────────────────────►│ Node 1
   │                            │                             │
   │                            │  Check TTL expiration       │
   │                            │  If not expired:            │
   │                            │  - Move to head (LRU)       │
   │                            │  - Return value             │
   │                            │                             │
   │                            │    {key, value} ◄───────────┤
   │                            │                             │
   │   200 OK                   │                             │
   │   {key: "user:123",        │                             │
   │    value: {...}}           │                             │
   │◄───────────────────────────┤                             │
   │                            │                             │
```

### Node Failure Handling

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Node 2 becomes unhealthy                            │
└──────────────────────────────────────────────────────────────────────────────┘

                          Health Check Loop (every 5s)
                                   │
                   ┌───────────────┴───────────────┐
                   │                               │
                   ▼                               ▼
              GET /health                    GET /health
              Node 1 ✓                       Node 2 ✗ (timeout)
                                                  │
                                    consecutiveFailures++
                                    (now: 1)
                                                  │
                   ┌──────────────────────────────┘
                   │        5 seconds later
                   ▼
              GET /health                    GET /health
              Node 1 ✓                       Node 2 ✗ (timeout)
                                                  │
                                    consecutiveFailures++
                                    (now: 2)
                                                  │
                   ┌──────────────────────────────┘
                   │        5 seconds later
                   ▼
              GET /health                    GET /health
              Node 1 ✓                       Node 2 ✗ (timeout)
                                                  │
                                    consecutiveFailures >= 3
                                    → ring.removeNode("node2")
                                    → health.healthy = false
                                                  │
┌─────────────────────────────────────────────────┴─────────────────────────────┐
│                                                                               │
│   Subsequent requests:                                                        │
│   - getNodes("user:123", 2) → [node1, node3]  (node2 excluded)               │
│   - Keys that were on node2 now route to next node on ring                   │
│   - Write quorum may fail if only 1 healthy node remains                     │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Testing Strategy (3 minutes)

### Backend Integration Tests

```typescript
// backend/src/coordinator/app.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from './app.js';

// Mock axios for node communication
vi.mock('axios');

describe('Coordinator API', () => {
  describe('PUT /cache/:key', () => {
    it('should store key with write quorum', async () => {
      const axios = await import('axios');
      vi.mocked(axios.default.put).mockResolvedValue({ data: { stored: true } });

      const response = await request(app)
        .put('/cache/test-key')
        .send({ value: { name: 'test' }, ttl: 60000 });

      expect(response.status).toBe(201);
      expect(response.body.stored).toBe(true);
      expect(response.body.replicas).toBeGreaterThanOrEqual(2);
    });

    it('should fail if quorum not achieved', async () => {
      const axios = await import('axios');
      vi.mocked(axios.default.put)
        .mockResolvedValueOnce({ data: { stored: true } })
        .mockRejectedValueOnce(new Error('timeout'));

      // With RF=2, W=2, one failure means quorum not met
      const response = await request(app)
        .put('/cache/test-key')
        .send({ value: 'test' });

      expect(response.status).toBe(503);
      expect(response.body.error).toContain('quorum');
    });
  });

  describe('GET /cache/:key', () => {
    it('should return cached value', async () => {
      const axios = await import('axios');
      vi.mocked(axios.default.get).mockResolvedValue({
        data: { key: 'test-key', value: 'test-value' },
      });

      const response = await request(app).get('/cache/test-key');

      expect(response.status).toBe(200);
      expect(response.body.value).toBe('test-value');
    });

    it('should return 404 for missing key', async () => {
      const axios = await import('axios');
      const error = new Error('Not found') as any;
      error.response = { status: 404 };
      vi.mocked(axios.default.get).mockRejectedValue(error);

      const response = await request(app).get('/cache/missing-key');

      expect(response.status).toBe(404);
    });
  });
});
```

### Frontend Component Tests

```typescript
// frontend/src/components/StatsCard.test.tsx
import { render, screen } from '@testing-library/react';
import { StatsCard } from './StatsCard';

describe('StatsCard', () => {
  it('renders value and subtitle', () => {
    render(
      <StatsCard
        title="Cache Entries"
        value="1,234"
        subtitle="total keys"
      />
    );

    expect(screen.getByText('Cache Entries')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('total keys')).toBeInTheDocument();
  });

  it('applies status color when provided', () => {
    const { rerender } = render(
      <StatsCard title="Hit Rate" value="95%" subtitle="efficiency" status="good" />
    );

    expect(screen.getByText('95%')).toHaveClass('text-green-600');

    rerender(
      <StatsCard title="Hit Rate" value="65%" subtitle="efficiency" status="warning" />
    );

    expect(screen.getByText('65%')).toHaveClass('text-yellow-600');
  });
});
```

---

## 11. Error Handling Across the Stack

### Backend Error Middleware

```typescript
// backend/src/shared/error-handler.ts
import { Request, Response, NextFunction } from 'express';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error(`[${req.method} ${req.path}]`, err);

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
  }

  // Validation errors from Zod
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: (err as any).errors,
    });
  }

  res.status(500).json({
    error: 'Internal server error',
  });
}
```

### Frontend Error Boundary

```tsx
// frontend/src/components/ErrorBoundary.tsx
import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-8 text-center">
          <h2 className="text-xl font-bold text-red-600 mb-4">
            Something went wrong
          </h2>
          <p className="text-gray-600 mb-4">
            {this.state.error?.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded"
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

---

## 12. Key Fullstack Trade-offs

| Layer | Decision | Trade-off |
|-------|----------|-----------|
| **Shared** | Zod for validation | Runtime overhead, but type-safe API contracts |
| **Backend** | HTTP REST vs Redis protocol | Easier debugging, higher latency |
| **Backend** | Coordinator vs smart client | Extra hop, but simpler clients |
| **Frontend** | Polling vs WebSocket | Simpler, but higher latency for updates |
| **Frontend** | Optimistic updates | Better UX, risk of showing incorrect state |
| **Both** | Quorum configuration | Tuneable consistency vs availability |

### Consistency Modes

```typescript
// Configure based on use case

// Strong consistency (banking, auth tokens)
const STRONG = { RF: 3, W: 2, R: 2 }; // W + R > N

// Eventual consistency (sessions, recommendations)
const EVENTUAL = { RF: 3, W: 1, R: 1 };

// Read-heavy workload (product catalog)
const READ_HEAVY = { RF: 3, W: 3, R: 1 };
```

---

## Summary

This fullstack distributed cache design demonstrates:

1. **Shared Types**: TypeScript interfaces and Zod schemas used by both layers
2. **Backend Core**: LRU cache with O(1) operations, consistent hashing, quorum replication
3. **API Design**: RESTful coordinator with proper error handling and validation
4. **Frontend State**: Zustand stores with optimistic updates and polling
5. **Visualization**: Hash ring display and cluster monitoring dashboard
6. **Error Handling**: Consistent error patterns across the stack
7. **Testing**: Integration tests for coordinator, component tests for UI

The coordinator pattern adds latency but provides a clean separation between clients and cache topology, enabling features like health monitoring, hot key detection, and quorum management in a single place.
