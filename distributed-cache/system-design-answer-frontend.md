# Distributed Cache - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## 1. Requirements Clarification (3-4 minutes)

### Frontend-Specific Requirements
- **Admin Dashboard**: Monitor cluster health, node status, key distribution
- **Key Browser**: View, search, and manage cached keys
- **Real-time Updates**: Live stats refresh without page reload
- **Cache Operations**: Manual GET/SET/DELETE through UI
- **Cluster Visualization**: Visual representation of hash ring and distribution
- **Test Interface**: Interactive tool for testing cache operations

### User Experience Goals
- **Instant Feedback**: Optimistic updates for cache operations
- **Clear Status**: Obvious indicators for healthy/unhealthy nodes
- **Responsive**: Works on desktop admin workstations
- **Accessible**: Keyboard navigation, screen reader support

### Non-Functional Requirements
- **Performance**: Dashboard renders 100+ keys without lag
- **Reliability**: Graceful degradation when nodes are down
- **Usability**: Operations require minimal clicks

---

## 2. Frontend Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Admin Dashboard                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               │
│  │   Dashboard   │  │  Key Browser  │  │   Cluster     │               │
│  │   Overview    │  │    & CRUD     │  │   Monitor     │               │
│  └───────────────┘  └───────────────┘  └───────────────┘               │
│           │                 │                   │                       │
│           └─────────────────┼───────────────────┘                       │
│                             │                                           │
│  ┌──────────────────────────▼──────────────────────────┐               │
│  │                    Zustand Store                     │               │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │               │
│  │  │ clusterStore│  │  cacheStore │  │ settingsStore│ │               │
│  │  │ - nodes     │  │ - keys      │  │ - autoRefresh│ │               │
│  │  │ - health    │  │ - values    │  │ - theme      │ │               │
│  │  │ - stats     │  │ - searchQ   │  │ - polling    │ │               │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  │               │
│  └──────────────────────────────────────────────────────┘               │
│                             │                                           │
│  ┌──────────────────────────▼──────────────────────────┐               │
│  │                   API Service Layer                  │               │
│  │  - Fetch wrapper with error handling                 │               │
│  │  - Automatic retry with exponential backoff          │               │
│  │  - Response caching for stats                        │               │
│  └──────────────────────────────────────────────────────┘               │
│                             │                                           │
└─────────────────────────────┼───────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Coordinator   │
                    │   API (3000)    │
                    └─────────────────┘
```

### Technology Stack
- **Framework**: React 19 + TypeScript
- **Routing**: TanStack Router (file-based)
- **State**: Zustand for global state
- **Styling**: Tailwind CSS
- **Build**: Vite
- **Charts**: Recharts for stats visualization

---

## 3. Route Structure (4 minutes)

```
frontend/src/routes/
├── __root.tsx          # Root layout with navigation
├── index.tsx           # Dashboard overview
├── keys/
│   ├── index.tsx       # Key browser list
│   └── $key.tsx        # Individual key detail/edit
├── cluster/
│   ├── index.tsx       # Cluster overview
│   ├── nodes.tsx       # Node management
│   └── distribution.tsx # Hash ring visualization
└── test.tsx            # Interactive test interface
```

### Root Layout

```tsx
// src/routes/__root.tsx
import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center space-x-8">
              <h1 className="text-xl font-bold text-gray-900">
                Cache Admin
              </h1>
              <div className="flex space-x-4">
                <NavLink to="/">Dashboard</NavLink>
                <NavLink to="/keys">Keys</NavLink>
                <NavLink to="/cluster">Cluster</NavLink>
                <NavLink to="/test">Test</NavLink>
              </div>
            </div>
            <ClusterHealthIndicator />
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="text-gray-600 hover:text-gray-900 px-3 py-2 rounded-md text-sm font-medium"
      activeProps={{ className: 'text-blue-600 bg-blue-50' }}
    >
      {children}
    </Link>
  );
}

function ClusterHealthIndicator() {
  const { healthyNodes, totalNodes } = useClusterStore();

  const status = healthyNodes === totalNodes
    ? 'healthy'
    : healthyNodes > 0
    ? 'degraded'
    : 'down';

  const colors = {
    healthy: 'bg-green-500',
    degraded: 'bg-yellow-500',
    down: 'bg-red-500',
  };

  return (
    <div className="flex items-center space-x-2">
      <span
        className={`w-3 h-3 rounded-full ${colors[status]}`}
        role="status"
        aria-label={`Cluster ${status}`}
      />
      <span className="text-sm text-gray-600">
        {healthyNodes}/{totalNodes} nodes
      </span>
    </div>
  );
}
```

---

## 4. State Management with Zustand (6 minutes)

### Cluster Store

```tsx
// src/stores/clusterStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { api } from '../services/api';

interface NodeHealth {
  id: string;
  address: string;
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
}

interface ClusterStats {
  totalEntries: number;
  totalMemory: number;
  avgHitRate: number;
  totalEvictions: number;
}

interface ClusterState {
  nodes: NodeHealth[];
  stats: ClusterStats | null;
  distribution: Record<string, { count: number; percentage: string }> | null;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;

  // Actions
  fetchClusterStatus: () => Promise<void>;
  fetchDistribution: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useClusterStore = create<ClusterState>()(
  subscribeWithSelector((set, get) => ({
    nodes: [],
    stats: null,
    distribution: null,
    loading: false,
    error: null,
    lastUpdated: null,

    fetchClusterStatus: async () => {
      set({ loading: true, error: null });

      try {
        const response = await api.get('/cluster/status');
        const nodeStats = await Promise.all(
          response.nodes
            .filter((n: NodeHealth) => n.healthy)
            .map((n: NodeHealth) => api.get(`/node/${n.id}/stats`).catch(() => null))
        );

        const validStats = nodeStats.filter(Boolean);
        const aggregatedStats: ClusterStats = {
          totalEntries: validStats.reduce((sum, s) => sum + s.entries, 0),
          totalMemory: validStats.reduce((sum, s) => sum + s.memoryBytes, 0),
          avgHitRate: validStats.length > 0
            ? validStats.reduce((sum, s) => sum + s.hitRate, 0) / validStats.length
            : 0,
          totalEvictions: validStats.reduce((sum, s) => sum + s.evictions, 0),
        };

        set({
          nodes: response.nodes,
          stats: aggregatedStats,
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
        const response = await api.get('/cluster/distribution');
        set({ distribution: response.distribution });
      } catch (error: any) {
        console.error('Failed to fetch distribution:', error);
      }
    },

    refreshAll: async () => {
      const { fetchClusterStatus, fetchDistribution } = get();
      await Promise.all([fetchClusterStatus(), fetchDistribution()]);
    },
  }))
);

// Computed selectors
export const selectHealthyNodes = (state: ClusterState) =>
  state.nodes.filter(n => n.healthy).length;

export const selectTotalNodes = (state: ClusterState) =>
  state.nodes.length;
```

### Cache Store

```tsx
// src/stores/cacheStore.ts
import { create } from 'zustand';
import { api } from '../services/api';

interface CacheEntry {
  key: string;
  value: unknown;
  ttl?: number;
  size?: number;
  node?: string;
}

interface CacheState {
  entries: CacheEntry[];
  searchQuery: string;
  selectedKey: string | null;
  loading: boolean;
  operationLoading: boolean;
  error: string | null;

  // Actions
  setSearchQuery: (query: string) => void;
  selectKey: (key: string | null) => void;
  fetchKey: (key: string) => Promise<CacheEntry | null>;
  setKey: (key: string, value: unknown, ttl?: number) => Promise<boolean>;
  deleteKey: (key: string) => Promise<boolean>;
  searchKeys: (pattern: string) => Promise<void>;
}

export const useCacheStore = create<CacheState>()((set, get) => ({
  entries: [],
  searchQuery: '',
  selectedKey: null,
  loading: false,
  operationLoading: false,
  error: null,

  setSearchQuery: (query) => set({ searchQuery: query }),

  selectKey: (key) => set({ selectedKey: key }),

  fetchKey: async (key) => {
    set({ loading: true, error: null });

    try {
      const response = await api.get(`/cache/${encodeURIComponent(key)}`);
      set({ loading: false });
      return response as CacheEntry;
    } catch (error: any) {
      if (error.status === 404) {
        set({ loading: false, error: 'Key not found' });
        return null;
      }
      set({ loading: false, error: error.message });
      return null;
    }
  },

  setKey: async (key, value, ttl) => {
    set({ operationLoading: true, error: null });

    // Optimistic update
    const prevEntries = get().entries;
    const newEntry: CacheEntry = { key, value, ttl };

    set({
      entries: [
        newEntry,
        ...prevEntries.filter(e => e.key !== key),
      ],
    });

    try {
      await api.put(`/cache/${encodeURIComponent(key)}`, { value, ttl });
      set({ operationLoading: false });
      return true;
    } catch (error: any) {
      // Rollback on failure
      set({
        entries: prevEntries,
        operationLoading: false,
        error: error.message,
      });
      return false;
    }
  },

  deleteKey: async (key) => {
    set({ operationLoading: true, error: null });

    // Optimistic update
    const prevEntries = get().entries;
    set({
      entries: prevEntries.filter(e => e.key !== key),
      selectedKey: null,
    });

    try {
      await api.delete(`/cache/${encodeURIComponent(key)}`);
      set({ operationLoading: false });
      return true;
    } catch (error: any) {
      // Rollback
      set({
        entries: prevEntries,
        operationLoading: false,
        error: error.message,
      });
      return false;
    }
  },

  searchKeys: async (pattern) => {
    set({ loading: true, error: null });

    try {
      const response = await api.get(`/cache/search?pattern=${encodeURIComponent(pattern)}`);
      set({ entries: response.keys, loading: false });
    } catch (error: any) {
      set({ loading: false, error: error.message });
    }
  },
}));
```

---

## 5. API Service Layer (4 minutes)

```tsx
// src/services/api.ts
interface ApiConfig {
  baseUrl: string;
  timeout: number;
  retries: number;
  adminKey?: string;
}

const config: ApiConfig = {
  baseUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  timeout: 10000,
  retries: 3,
  adminKey: import.meta.env.VITE_ADMIN_KEY,
};

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries: number
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new ApiError(
          data.error || `HTTP ${response.status}`,
          response.status,
          data
        );
      }

      return response;
    } catch (error: any) {
      lastError = error;

      // Don't retry on 4xx errors (client errors)
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        throw error;
      }

      // Exponential backoff for retries
      if (attempt < retries) {
        await new Promise(resolve =>
          setTimeout(resolve, Math.pow(2, attempt) * 100)
        );
      }
    }
  }

  throw lastError || new Error('Request failed');
}

function buildHeaders(): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (config.adminKey) {
    headers['X-Admin-Key'] = config.adminKey;
  }

  return headers;
}

export const api = {
  async get(path: string): Promise<any> {
    const response = await fetchWithRetry(
      `${config.baseUrl}${path}`,
      {
        method: 'GET',
        headers: buildHeaders(),
      },
      config.retries
    );
    return response.json();
  },

  async put(path: string, body: unknown): Promise<any> {
    const response = await fetchWithRetry(
      `${config.baseUrl}${path}`,
      {
        method: 'PUT',
        headers: buildHeaders(),
        body: JSON.stringify(body),
      },
      config.retries
    );
    return response.json();
  },

  async delete(path: string): Promise<any> {
    const response = await fetchWithRetry(
      `${config.baseUrl}${path}`,
      {
        method: 'DELETE',
        headers: buildHeaders(),
      },
      config.retries
    );
    return response.json();
  },
};
```

---

## 6. Dashboard Overview Component (6 minutes)

```tsx
// src/routes/index.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useClusterStore } from '../stores/clusterStore';
import { StatsCard } from '../components/StatsCard';
import { NodeList } from '../components/NodeList';
import { HitRateChart } from '../components/HitRateChart';

export const Route = createFileRoute('/')({
  component: Dashboard,
});

function Dashboard() {
  const {
    nodes,
    stats,
    loading,
    error,
    lastUpdated,
    refreshAll,
  } = useClusterStore();

  // Auto-refresh every 5 seconds
  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 5000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  if (loading && !stats) {
    return <LoadingSpinner />;
  }

  if (error && !stats) {
    return <ErrorMessage message={error} onRetry={refreshAll} />;
  }

  const healthyNodes = nodes.filter(n => n.healthy).length;

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <div className="flex items-center space-x-4">
          {lastUpdated && (
            <span className="text-sm text-gray-500">
              Updated {formatRelativeTime(lastUpdated)}
            </span>
          )}
          <button
            onClick={refreshAll}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            aria-label="Refresh dashboard"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Cluster Health"
          value={`${healthyNodes}/${nodes.length}`}
          subtitle="healthy nodes"
          status={healthyNodes === nodes.length ? 'good' : 'warning'}
        />
        <StatsCard
          title="Total Entries"
          value={formatNumber(stats?.totalEntries ?? 0)}
          subtitle="cached keys"
        />
        <StatsCard
          title="Memory Usage"
          value={formatBytes(stats?.totalMemory ?? 0)}
          subtitle="across cluster"
        />
        <StatsCard
          title="Hit Rate"
          value={`${((stats?.avgHitRate ?? 0) * 100).toFixed(1)}%`}
          subtitle="cache efficiency"
          status={
            (stats?.avgHitRate ?? 0) >= 0.9
              ? 'good'
              : (stats?.avgHitRate ?? 0) >= 0.7
              ? 'warning'
              : 'bad'
          }
        />
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Node Status */}
        <section className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">Node Status</h3>
          <NodeList nodes={nodes} />
        </section>

        {/* Hit Rate Chart */}
        <section className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">Hit Rate Over Time</h3>
          <HitRateChart />
        </section>
      </div>
    </div>
  );
}

// Helper components
function LoadingSpinner() {
  return (
    <div
      className="flex items-center justify-center h-64"
      role="status"
      aria-label="Loading"
    >
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
    </div>
  );
}

function ErrorMessage({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="bg-red-50 border border-red-200 rounded-lg p-6 text-center"
      role="alert"
    >
      <p className="text-red-800 mb-4">{message}</p>
      <button
        onClick={onRetry}
        className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
      >
        Retry
      </button>
    </div>
  );
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
```

### Stats Card Component

```tsx
// src/components/StatsCard.tsx
interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle: string;
  status?: 'good' | 'warning' | 'bad';
}

export function StatsCard({ title, value, subtitle, status }: StatsCardProps) {
  const statusColors = {
    good: 'text-green-600',
    warning: 'text-yellow-600',
    bad: 'text-red-600',
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <dt className="text-sm font-medium text-gray-500 truncate">{title}</dt>
      <dd
        className={`mt-1 text-3xl font-semibold ${
          status ? statusColors[status] : 'text-gray-900'
        }`}
      >
        {value}
      </dd>
      <dd className="text-sm text-gray-500">{subtitle}</dd>
    </div>
  );
}
```

---

## 7. Key Browser Component (6 minutes)

```tsx
// src/routes/keys/index.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState, useCallback } from 'react';
import { useCacheStore } from '../../stores/cacheStore';
import { useDebounce } from '../../hooks/useDebounce';

export const Route = createFileRoute('/keys/')({
  component: KeyBrowser,
});

function KeyBrowser() {
  const {
    entries,
    searchQuery,
    setSearchQuery,
    searchKeys,
    deleteKey,
    loading,
    operationLoading,
  } = useCacheStore();

  const [showAddModal, setShowAddModal] = useState(false);

  // Debounced search
  const debouncedSearch = useDebounce(searchQuery, 300);

  useEffect(() => {
    if (debouncedSearch) {
      searchKeys(debouncedSearch);
    }
  }, [debouncedSearch, searchKeys]);

  const handleDelete = useCallback(async (key: string) => {
    if (window.confirm(`Delete key "${key}"?`)) {
      await deleteKey(key);
    }
  }, [deleteKey]);

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-900">Key Browser</h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
        >
          Add Key
        </button>
      </header>

      {/* Search Bar */}
      <div className="relative">
        <input
          type="search"
          placeholder="Search keys (e.g., user:*, session:123)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-3 pl-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          aria-label="Search cache keys"
        />
        <SearchIcon className="absolute left-3 top-3.5 h-5 w-5 text-gray-400" />
        {loading && (
          <span className="absolute right-3 top-3.5">
            <LoadingSpinner size="small" />
          </span>
        )}
      </div>

      {/* Results Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Key
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Value Preview
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Node
              </th>
              <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {entries.map((entry) => (
              <KeyRow
                key={entry.key}
                entry={entry}
                onDelete={() => handleDelete(entry.key)}
                disabled={operationLoading}
              />
            ))}
            {entries.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                  {searchQuery
                    ? 'No keys match your search'
                    : 'Enter a search pattern to find keys'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAddModal && (
        <AddKeyModal onClose={() => setShowAddModal(false)} />
      )}
    </div>
  );
}

function KeyRow({
  entry,
  onDelete,
  disabled,
}: {
  entry: CacheEntry;
  onDelete: () => void;
  disabled: boolean;
}) {
  const valuePreview = useMemo(() => {
    if (typeof entry.value === 'string') {
      return entry.value.length > 50
        ? entry.value.substring(0, 50) + '...'
        : entry.value;
    }
    const json = JSON.stringify(entry.value);
    return json.length > 50 ? json.substring(0, 50) + '...' : json;
  }, [entry.value]);

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 whitespace-nowrap">
        <Link
          to="/keys/$key"
          params={{ key: entry.key }}
          className="text-blue-600 hover:text-blue-800 font-mono text-sm"
        >
          {entry.key}
        </Link>
      </td>
      <td className="px-6 py-4">
        <code className="text-sm text-gray-600 bg-gray-100 px-2 py-1 rounded">
          {valuePreview}
        </code>
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {entry.node || 'Unknown'}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-right">
        <button
          onClick={onDelete}
          disabled={disabled}
          className="text-red-600 hover:text-red-800 disabled:opacity-50"
          aria-label={`Delete key ${entry.key}`}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}
```

---

## 8. Hash Ring Visualization (5 minutes)

```tsx
// src/components/HashRingVisualization.tsx
import { useMemo } from 'react';

interface HashRingProps {
  nodes: Array<{ id: string; healthy: boolean }>;
  distribution: Record<string, { count: number; percentage: string }>;
  virtualNodesPerNode: number;
}

export function HashRingVisualization({
  nodes,
  distribution,
  virtualNodesPerNode,
}: HashRingProps) {
  const ringData = useMemo(() => {
    const totalVirtualNodes = nodes.length * virtualNodesPerNode;
    const nodeColors = [
      '#3B82F6', // blue
      '#10B981', // green
      '#F59E0B', // amber
      '#EF4444', // red
      '#8B5CF6', // purple
    ];

    return nodes.map((node, index) => ({
      ...node,
      color: nodeColors[index % nodeColors.length],
      percentage: distribution[node.id]?.percentage || '0%',
      arcDegrees: 360 / nodes.length,
      startAngle: (360 / nodes.length) * index,
    }));
  }, [nodes, distribution, virtualNodesPerNode]);

  const size = 300;
  const center = size / 2;
  const radius = size / 2 - 30;
  const innerRadius = radius - 40;

  return (
    <div className="flex flex-col items-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Hash ring visualization showing key distribution across nodes"
      >
        {/* Ring segments */}
        {ringData.map((node, index) => {
          const startAngle = (node.startAngle - 90) * (Math.PI / 180);
          const endAngle = (node.startAngle + node.arcDegrees - 90) * (Math.PI / 180);

          const x1 = center + radius * Math.cos(startAngle);
          const y1 = center + radius * Math.sin(startAngle);
          const x2 = center + radius * Math.cos(endAngle);
          const y2 = center + radius * Math.sin(endAngle);

          const x1Inner = center + innerRadius * Math.cos(startAngle);
          const y1Inner = center + innerRadius * Math.sin(startAngle);
          const x2Inner = center + innerRadius * Math.cos(endAngle);
          const y2Inner = center + innerRadius * Math.sin(endAngle);

          const largeArc = node.arcDegrees > 180 ? 1 : 0;

          const pathData = [
            `M ${x1} ${y1}`,
            `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
            `L ${x2Inner} ${y2Inner}`,
            `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x1Inner} ${y1Inner}`,
            'Z',
          ].join(' ');

          return (
            <g key={node.id}>
              <path
                d={pathData}
                fill={node.healthy ? node.color : '#9CA3AF'}
                opacity={node.healthy ? 1 : 0.5}
                stroke="white"
                strokeWidth="2"
              >
                <title>{`${node.id}: ${node.percentage}`}</title>
              </path>
            </g>
          );
        })}

        {/* Center text */}
        <text
          x={center}
          y={center - 10}
          textAnchor="middle"
          className="text-lg font-bold fill-gray-900"
        >
          {nodes.filter(n => n.healthy).length}/{nodes.length}
        </text>
        <text
          x={center}
          y={center + 15}
          textAnchor="middle"
          className="text-sm fill-gray-500"
        >
          nodes healthy
        </text>
      </svg>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap justify-center gap-4">
        {ringData.map((node) => (
          <div key={node.id} className="flex items-center space-x-2">
            <span
              className="w-4 h-4 rounded-full"
              style={{
                backgroundColor: node.healthy ? node.color : '#9CA3AF',
                opacity: node.healthy ? 1 : 0.5,
              }}
            />
            <span className={`text-sm ${node.healthy ? 'text-gray-900' : 'text-gray-400'}`}>
              {node.id} ({node.percentage})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 9. Test Interface Component (4 minutes)

```tsx
// src/routes/test.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useCacheStore } from '../stores/cacheStore';

export const Route = createFileRoute('/test')({
  component: TestInterface,
});

function TestInterface() {
  const { fetchKey, setKey, deleteKey, operationLoading } = useCacheStore();

  const [operation, setOperation] = useState<'get' | 'set' | 'delete'>('get');
  const [key, setKeyInput] = useState('');
  const [value, setValue] = useState('');
  const [ttl, setTtl] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [resultType, setResultType] = useState<'success' | 'error' | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!key.trim()) {
      setResult('Key is required');
      setResultType('error');
      return;
    }

    try {
      switch (operation) {
        case 'get': {
          const entry = await fetchKey(key);
          if (entry) {
            setResult(JSON.stringify(entry.value, null, 2));
            setResultType('success');
          } else {
            setResult('Key not found');
            setResultType('error');
          }
          break;
        }
        case 'set': {
          let parsedValue: unknown;
          try {
            parsedValue = JSON.parse(value);
          } catch {
            parsedValue = value; // Use as string if not valid JSON
          }

          const ttlMs = ttl ? parseInt(ttl, 10) * 1000 : undefined;
          const success = await setKey(key, parsedValue, ttlMs);

          if (success) {
            setResult('Key set successfully');
            setResultType('success');
          } else {
            setResult('Failed to set key');
            setResultType('error');
          }
          break;
        }
        case 'delete': {
          const success = await deleteKey(key);
          setResult(success ? 'Key deleted' : 'Key not found');
          setResultType(success ? 'success' : 'error');
          break;
        }
      }
    } catch (error: any) {
      setResult(error.message);
      setResultType('error');
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Test Interface</h2>

      <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 space-y-4">
        {/* Operation Selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Operation
          </label>
          <div className="flex space-x-4" role="radiogroup">
            {(['get', 'set', 'delete'] as const).map((op) => (
              <label
                key={op}
                className={`
                  flex items-center px-4 py-2 rounded-md cursor-pointer
                  ${operation === op
                    ? 'bg-blue-100 text-blue-800 border-2 border-blue-600'
                    : 'bg-gray-100 text-gray-700 border-2 border-transparent'}
                `}
              >
                <input
                  type="radio"
                  name="operation"
                  value={op}
                  checked={operation === op}
                  onChange={() => setOperation(op)}
                  className="sr-only"
                />
                {op.toUpperCase()}
              </label>
            ))}
          </div>
        </div>

        {/* Key Input */}
        <div>
          <label htmlFor="key" className="block text-sm font-medium text-gray-700 mb-1">
            Key
          </label>
          <input
            id="key"
            type="text"
            value={key}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="e.g., user:123"
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>

        {/* Value Input (only for SET) */}
        {operation === 'set' && (
          <>
            <div>
              <label htmlFor="value" className="block text-sm font-medium text-gray-700 mb-1">
                Value (JSON or string)
              </label>
              <textarea
                id="value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder='{"name": "John", "age": 30}'
                rows={4}
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
            </div>
            <div>
              <label htmlFor="ttl" className="block text-sm font-medium text-gray-700 mb-1">
                TTL (seconds, optional)
              </label>
              <input
                id="ttl"
                type="number"
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                placeholder="300"
                min="1"
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={operationLoading}
          className="w-full py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 font-medium"
        >
          {operationLoading ? 'Processing...' : `Execute ${operation.toUpperCase()}`}
        </button>
      </form>

      {/* Result Display */}
      {result !== null && (
        <div
          className={`p-4 rounded-lg ${
            resultType === 'success'
              ? 'bg-green-50 border border-green-200'
              : 'bg-red-50 border border-red-200'
          }`}
          role="status"
        >
          <h3 className={`font-medium mb-2 ${
            resultType === 'success' ? 'text-green-800' : 'text-red-800'
          }`}>
            Result
          </h3>
          <pre className={`text-sm font-mono whitespace-pre-wrap ${
            resultType === 'success' ? 'text-green-700' : 'text-red-700'
          }`}>
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}
```

---

## 10. Custom Hooks (3 minutes)

### useDebounce Hook

```tsx
// src/hooks/useDebounce.ts
import { useState, useEffect } from 'react';

export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
```

### usePolling Hook

```tsx
// src/hooks/usePolling.ts
import { useEffect, useRef, useCallback } from 'react';

export function usePolling(
  callback: () => Promise<void>,
  interval: number,
  enabled = true
) {
  const savedCallback = useRef(callback);
  const timeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  const poll = useCallback(async () => {
    try {
      await savedCallback.current();
    } catch (error) {
      console.error('Polling error:', error);
    }

    if (enabled) {
      timeoutRef.current = setTimeout(poll, interval);
    }
  }, [interval, enabled]);

  useEffect(() => {
    if (enabled) {
      poll();
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [poll, enabled]);
}
```

---

## 11. Accessibility Considerations

### Keyboard Navigation

```tsx
// All interactive elements are keyboard accessible
// Tab order follows logical flow
// Focus indicators are visible

// Example: Keyboard-navigable node list
function NodeList({ nodes }: { nodes: NodeHealth[] }) {
  return (
    <ul role="list" className="divide-y divide-gray-200">
      {nodes.map((node) => (
        <li
          key={node.id}
          className="py-4 focus-within:ring-2 focus-within:ring-blue-500 rounded"
        >
          <button
            className="w-full text-left focus:outline-none"
            onClick={() => showNodeDetails(node.id)}
            aria-label={`${node.id}, ${node.healthy ? 'healthy' : 'unhealthy'}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{node.id}</span>
              <span
                className={`px-2 py-1 rounded-full text-xs ${
                  node.healthy
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}
                role="status"
              >
                {node.healthy ? 'Healthy' : 'Unhealthy'}
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

### Screen Reader Support

```tsx
// Live regions for dynamic updates
function ClusterAlerts() {
  const { nodes } = useClusterStore();
  const unhealthyCount = nodes.filter(n => !n.healthy).length;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="sr-only"
    >
      {unhealthyCount > 0 && (
        `Warning: ${unhealthyCount} node${unhealthyCount > 1 ? 's' : ''} unhealthy`
      )}
    </div>
  );
}
```

---

## 12. Key Frontend Trade-offs

| Decision | Trade-off |
|----------|-----------|
| Polling vs WebSocket | Polling simpler, WebSocket more real-time |
| Optimistic updates | Better UX, risk of showing incorrect state briefly |
| Local search filtering | Faster for small datasets, needs server for large |
| SVG for visualization | Flexible, but complex; could use D3 for larger visualizations |
| Zustand vs Redux | Lighter, less boilerplate; Redux has better dev tools |

---

## Summary

This frontend design for a distributed cache admin dashboard demonstrates:

1. **File-based Routing**: TanStack Router with clear URL structure
2. **State Management**: Zustand stores for cluster and cache state
3. **API Layer**: Fetch wrapper with retry and error handling
4. **Real-time Updates**: Polling with configurable intervals
5. **Visualizations**: Hash ring SVG and stats charts
6. **Testing Interface**: Interactive GET/SET/DELETE tool
7. **Accessibility**: Keyboard navigation, ARIA labels, live regions
8. **Performance**: Debounced search, optimistic updates

The dashboard provides operators with visibility into cache health, key distribution, and the ability to manually manage cache entries for debugging and operations.
