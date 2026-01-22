# Web Crawler - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thank you for having me. Today I'll design the frontend for a distributed web crawler dashboard. While crawling is primarily a backend system, the dashboard is critical for operators and presents interesting frontend challenges:

1. **Real-time monitoring** displaying thousands of URLs being crawled per second
2. **Virtualized data tables** handling millions of frontier URLs efficiently
3. **Live statistics visualization** with charts and metrics
4. **Admin controls** for managing seeds, domains, and worker health

The frontend challenge is presenting massive amounts of real-time data without overwhelming users or the browser. Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For the crawler dashboard:

1. **Live Statistics**: Real-time crawl rate, queue depth, worker status
2. **URL Frontier View**: Browse and search pending/crawled URLs
3. **Domain Management**: Block domains, adjust rate limits, view robots.txt
4. **Worker Monitoring**: Health status, throughput per worker
5. **Seed URL Management**: Add/remove seed URLs, bulk import

I'll focus on real-time data visualization, virtualized tables, and the admin control panel."

### Non-Functional Requirements

"Key constraints:

- **Data Volume**: Display status of millions of URLs
- **Update Frequency**: Statistics refresh every 1-2 seconds
- **Responsiveness**: Dashboard usable on tablets for on-call monitoring
- **Performance**: Handle 10,000+ rows without browser slowdown

The main challenge is balancing real-time updates with performance when dealing with massive datasets."

---

## High-Level Design (8 minutes)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Crawler Dashboard UI                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    Navigation Bar                                │    │
│  │    Logo  │  Dashboard  │  Frontier  │  Domains  │  Workers      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────────────┐  ┌──────────────────────────────────┐     │
│  │    Live Statistics       │  │      Throughput Chart            │     │
│  │  ┌──────┐ ┌──────┐      │  │                                   │     │
│  │  │URLs/s│ │Queue │      │  │    ━━━━━━━━━━━━━━━━━━━━━━━━━━    │     │
│  │  │10.2K │ │ 2.5M │      │  │   Pages/second over time          │     │
│  │  └──────┘ └──────┘      │  │                                   │     │
│  │  ┌──────┐ ┌──────┐      │  └──────────────────────────────────┘     │
│  │  │Active│ │Failed│      │                                           │
│  │  │  8   │ │ 124  │      │  ┌──────────────────────────────────┐     │
│  │  └──────┘ └──────┘      │  │      Domain Distribution          │     │
│  └──────────────────────────┘  │         [Pie Chart]              │     │
│                                └──────────────────────────────────┘     │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    URL Frontier Table                            │    │
│  │  ┌─────────────────────────────────────────────────────────┐    │    │
│  │  │ Status │   URL                    │ Priority │ Domain   │    │    │
│  │  ├─────────────────────────────────────────────────────────┤    │    │
│  │  │ ● Crawl │ https://example.com/... │   High   │example   │    │    │
│  │  │ ○ Pend  │ https://other.com/page  │   Med    │other     │    │    │
│  │  │ ✓ Done  │ https://blog.io/post    │   Low    │blog      │    │    │
│  │  │  ...virtualized rows...                                  │    │    │
│  │  └─────────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Architecture

```
src/
├── routes/
│   ├── __root.tsx           # Root layout with navigation
│   ├── index.tsx            # Dashboard overview
│   ├── frontier.tsx         # URL frontier browser
│   ├── domains/
│   │   ├── index.tsx        # Domain list
│   │   └── $domain.tsx      # Domain detail view
│   └── workers.tsx          # Worker monitoring
├── components/
│   ├── dashboard/
│   │   ├── StatsGrid.tsx    # Live statistics cards
│   │   ├── ThroughputChart.tsx
│   │   └── DomainPieChart.tsx
│   ├── frontier/
│   │   ├── URLTable.tsx     # Virtualized URL table
│   │   ├── URLFilters.tsx   # Search and filter controls
│   │   └── SeedURLModal.tsx # Add seed URLs
│   ├── domains/
│   │   ├── DomainTable.tsx
│   │   ├── RobotsViewer.tsx # Display robots.txt
│   │   └── RateLimitSlider.tsx
│   └── workers/
│       ├── WorkerGrid.tsx
│       └── WorkerCard.tsx
├── stores/
│   ├── statsStore.ts        # Real-time statistics
│   ├── frontierStore.ts     # URL frontier state
│   └── domainStore.ts       # Domain management
└── services/
    └── api.ts               # API client
```

---

## Deep Dive: Real-Time Statistics Dashboard (10 minutes)

### Live Statistics with WebSocket

```typescript
// stores/statsStore.ts
import { create } from 'zustand';

interface CrawlStats {
  urlsPerSecond: number;
  queueDepth: number;
  activeWorkers: number;
  failedToday: number;
  totalCrawled: number;
  byPriority: {
    high: number;
    medium: number;
    low: number;
  };
  throughputHistory: Array<{
    timestamp: number;
    value: number;
  }>;
}

interface StatsStore {
  stats: CrawlStats;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
}

export const useStatsStore = create<StatsStore>((set, get) => {
  let ws: WebSocket | null = null;
  let reconnectTimeout: NodeJS.Timeout;

  return {
    stats: {
      urlsPerSecond: 0,
      queueDepth: 0,
      activeWorkers: 0,
      failedToday: 0,
      totalCrawled: 0,
      byPriority: { high: 0, medium: 0, low: 0 },
      throughputHistory: []
    },
    isConnected: false,

    connect: () => {
      if (ws?.readyState === WebSocket.OPEN) return;

      ws = new WebSocket(`${import.meta.env.VITE_WS_URL}/stats`);

      ws.onopen = () => {
        set({ isConnected: true });
        clearTimeout(reconnectTimeout);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        set((state) => ({
          stats: {
            ...data,
            throughputHistory: [
              ...state.stats.throughputHistory.slice(-60), // Keep last 60 points
              { timestamp: Date.now(), value: data.urlsPerSecond }
            ]
          }
        }));
      };

      ws.onclose = () => {
        set({ isConnected: false });
        // Reconnect after 3 seconds
        reconnectTimeout = setTimeout(() => get().connect(), 3000);
      };
    },

    disconnect: () => {
      ws?.close();
      clearTimeout(reconnectTimeout);
    }
  };
});
```

### Statistics Grid Component

```tsx
// components/dashboard/StatsGrid.tsx
import { useStatsStore } from '../../stores/statsStore';

interface StatCardProps {
  label: string;
  value: number | string;
  trend?: 'up' | 'down' | 'neutral';
  format?: 'number' | 'compact';
}

function StatCard({ label, value, trend, format = 'number' }: StatCardProps) {
  const formatted = format === 'compact'
    ? formatCompact(value as number)
    : value.toLocaleString();

  return (
    <div className="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
      <p className="text-sm text-gray-500 uppercase tracking-wide">{label}</p>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-3xl font-bold text-gray-900">{formatted}</span>
        {trend && (
          <span className={`text-sm ${
            trend === 'up' ? 'text-green-600' :
            trend === 'down' ? 'text-red-600' : 'text-gray-400'
          }`}>
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}
          </span>
        )}
      </div>
    </div>
  );
}

function formatCompact(num: number): string {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

export function StatsGrid() {
  const { stats, isConnected } = useStatsStore();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${
          isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'
        }`} />
        <span className="text-sm text-gray-500">
          {isConnected ? 'Live' : 'Disconnected'}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="URLs/second"
          value={stats.urlsPerSecond}
          format="compact"
        />
        <StatCard
          label="Queue Depth"
          value={stats.queueDepth}
          format="compact"
        />
        <StatCard
          label="Active Workers"
          value={stats.activeWorkers}
        />
        <StatCard
          label="Failed Today"
          value={stats.failedToday}
          trend={stats.failedToday > 100 ? 'down' : 'neutral'}
        />
      </div>

      <div className="grid grid-cols-3 gap-4 mt-4">
        <PriorityCard
          priority="High"
          count={stats.byPriority.high}
          color="red"
        />
        <PriorityCard
          priority="Medium"
          count={stats.byPriority.medium}
          color="yellow"
        />
        <PriorityCard
          priority="Low"
          count={stats.byPriority.low}
          color="green"
        />
      </div>
    </div>
  );
}

function PriorityCard({ priority, count, color }: {
  priority: string;
  count: number;
  color: string;
}) {
  const colorClasses = {
    red: 'bg-red-100 text-red-800 border-red-300',
    yellow: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    green: 'bg-green-100 text-green-800 border-green-300'
  };

  return (
    <div className={`rounded-lg border p-3 ${colorClasses[color]}`}>
      <p className="text-sm font-medium">{priority} Priority</p>
      <p className="text-2xl font-bold">{formatCompact(count)}</p>
    </div>
  );
}
```

### Throughput Chart with Recharts

```tsx
// components/dashboard/ThroughputChart.tsx
import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { useStatsStore } from '../../stores/statsStore';

export function ThroughputChart() {
  const throughputHistory = useStatsStore((s) => s.stats.throughputHistory);

  const chartData = useMemo(() => {
    return throughputHistory.map((point) => ({
      time: new Date(point.timestamp).toLocaleTimeString(),
      value: point.value
    }));
  }, [throughputHistory]);

  const maxValue = useMemo(() => {
    const max = Math.max(...throughputHistory.map((p) => p.value), 100);
    return Math.ceil(max * 1.1); // 10% headroom
  }, [throughputHistory]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Crawl Throughput
      </h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 12 }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, maxValue]}
              tick={{ fontSize: 12 }}
              tickFormatter={(v) => v >= 1000 ? `${v/1000}K` : v}
            />
            <Tooltip
              formatter={(value: number) => [`${value.toLocaleString()} URLs/s`, 'Throughput']}
              labelStyle={{ fontWeight: 'bold' }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#3B82F6"
              fillOpacity={1}
              fill="url(#colorValue)"
              isAnimationActive={false}  // Disable for real-time performance
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

---

## Deep Dive: Virtualized URL Frontier Table (10 minutes)

### URL Table with TanStack Virtual

```tsx
// components/frontier/URLTable.tsx
import { useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFrontierStore } from '../../stores/frontierStore';

interface FrontierURL {
  id: number;
  url: string;
  domain: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: 'high' | 'medium' | 'low';
  depth: number;
  discoveredAt: string;
}

export function URLTable() {
  const parentRef = useRef<HTMLDivElement>(null);
  const {
    urls,
    totalCount,
    isLoading,
    hasNextPage,
    fetchNextPage
  } = useFrontierStore();

  const virtualizer = useVirtualizer({
    count: hasNextPage ? urls.length + 1 : urls.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // Row height
    overscan: 10
  });

  // Infinite scroll detection
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    if (distanceFromBottom < 500 && hasNextPage && !isLoading) {
      fetchNextPage();
    }
  }, [hasNextPage, isLoading, fetchNextPage]);

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      {/* Header */}
      <div className="border-b bg-gray-50">
        <div className="grid grid-cols-12 gap-2 px-4 py-3 text-sm font-medium text-gray-600">
          <div className="col-span-1">Status</div>
          <div className="col-span-5">URL</div>
          <div className="col-span-2">Domain</div>
          <div className="col-span-1">Priority</div>
          <div className="col-span-1">Depth</div>
          <div className="col-span-2">Discovered</div>
        </div>
      </div>

      {/* Virtualized body */}
      <div
        ref={parentRef}
        className="h-[600px] overflow-auto"
        onScroll={handleScroll}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const isLoaderRow = virtualRow.index === urls.length;

            if (isLoaderRow) {
              return (
                <div
                  key="loader"
                  style={{
                    position: 'absolute',
                    top: virtualRow.start,
                    left: 0,
                    right: 0,
                    height: virtualRow.size
                  }}
                  className="flex items-center justify-center text-gray-500"
                >
                  Loading more...
                </div>
              );
            }

            const url = urls[virtualRow.index];
            return (
              <URLRow
                key={url.id}
                url={url}
                style={{
                  position: 'absolute',
                  top: virtualRow.start,
                  left: 0,
                  right: 0,
                  height: virtualRow.size
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Footer with count */}
      <div className="border-t bg-gray-50 px-4 py-2 text-sm text-gray-500">
        Showing {urls.length.toLocaleString()} of {totalCount.toLocaleString()} URLs
      </div>
    </div>
  );
}

function URLRow({ url, style }: { url: FrontierURL; style: React.CSSProperties }) {
  const statusColors = {
    pending: 'bg-gray-400',
    processing: 'bg-blue-500 animate-pulse',
    completed: 'bg-green-500',
    failed: 'bg-red-500'
  };

  const priorityColors = {
    high: 'text-red-600 bg-red-100',
    medium: 'text-yellow-600 bg-yellow-100',
    low: 'text-green-600 bg-green-100'
  };

  return (
    <div
      style={style}
      className="grid grid-cols-12 gap-2 px-4 items-center border-b hover:bg-gray-50"
    >
      <div className="col-span-1">
        <span
          className={`w-3 h-3 rounded-full inline-block ${statusColors[url.status]}`}
          title={url.status}
        />
      </div>
      <div className="col-span-5 truncate font-mono text-sm" title={url.url}>
        {url.url}
      </div>
      <div className="col-span-2 truncate text-sm text-gray-600">
        {url.domain}
      </div>
      <div className="col-span-1">
        <span className={`px-2 py-1 rounded text-xs font-medium ${priorityColors[url.priority]}`}>
          {url.priority}
        </span>
      </div>
      <div className="col-span-1 text-sm text-gray-600">
        {url.depth}
      </div>
      <div className="col-span-2 text-sm text-gray-500">
        {formatTimeAgo(url.discoveredAt)}
      </div>
    </div>
  );
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
```

### URL Filters Component

```tsx
// components/frontier/URLFilters.tsx
import { useState } from 'react';
import { useFrontierStore } from '../../stores/frontierStore';

export function URLFilters() {
  const { filters, setFilters, resetFilters } = useFrontierStore();
  const [searchInput, setSearchInput] = useState(filters.search || '');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setFilters({ search: searchInput });
  };

  return (
    <div className="bg-white rounded-lg shadow p-4 mb-4">
      <form onSubmit={handleSearch} className="flex gap-4">
        {/* Search */}
        <div className="flex-1">
          <label className="sr-only">Search URLs</label>
          <div className="relative">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by URL or domain..."
              className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <SearchIcon className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" />
          </div>
        </div>

        {/* Status filter */}
        <select
          value={filters.status || ''}
          onChange={(e) => setFilters({ status: e.target.value || undefined })}
          className="border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>

        {/* Priority filter */}
        <select
          value={filters.priority || ''}
          onChange={(e) => setFilters({ priority: e.target.value || undefined })}
          className="border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        {/* Buttons */}
        <button
          type="submit"
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Search
        </button>
        <button
          type="button"
          onClick={resetFilters}
          className="px-4 py-2 border rounded-lg hover:bg-gray-50"
        >
          Reset
        </button>
      </form>
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}
```

---

## Deep Dive: Domain Management (8 minutes)

### Domain Detail View

```tsx
// routes/domains/$domain.tsx
import { useParams } from '@tanstack/react-router';
import { useDomainStore } from '../../stores/domainStore';
import { RobotsViewer } from '../../components/domains/RobotsViewer';
import { RateLimitSlider } from '../../components/domains/RateLimitSlider';

export function DomainDetailPage() {
  const { domain } = useParams({ from: '/domains/$domain' });
  const { domainInfo, isLoading, blockDomain, unblockDomain, updateCrawlDelay } =
    useDomainStore();

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (!domainInfo) {
    return <NotFound message={`Domain "${domain}" not found`} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{domain}</h1>
          <p className="text-gray-500">
            {domainInfo.totalPages.toLocaleString()} pages crawled
          </p>
        </div>
        <div className="flex gap-2">
          {domainInfo.isBlocked ? (
            <button
              onClick={() => unblockDomain(domain)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              Unblock Domain
            </button>
          ) : (
            <button
              onClick={() => blockDomain(domain)}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              Block Domain
            </button>
          )}
        </div>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatusCard label="Status" value={domainInfo.isBlocked ? 'Blocked' : 'Active'} />
        <StatusCard label="Pending URLs" value={domainInfo.pendingUrls} />
        <StatusCard label="Avg Response" value={`${domainInfo.avgResponseMs}ms`} />
        <StatusCard label="Last Crawl" value={formatTimeAgo(domainInfo.lastCrawlAt)} />
      </div>

      {/* Rate limit control */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Crawl Rate Limit</h2>
        <RateLimitSlider
          value={domainInfo.crawlDelayMs}
          onChange={(value) => updateCrawlDelay(domain, value)}
          min={500}
          max={10000}
          step={100}
        />
        <p className="text-sm text-gray-500 mt-2">
          Currently: 1 request every {domainInfo.crawlDelayMs}ms
        </p>
      </div>

      {/* robots.txt viewer */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">robots.txt</h2>
        <RobotsViewer content={domainInfo.robotsTxt} />
        <p className="text-sm text-gray-500 mt-2">
          Last fetched: {formatTimeAgo(domainInfo.robotsFetchedAt)}
        </p>
      </div>
    </div>
  );
}
```

### robots.txt Viewer with Syntax Highlighting

```tsx
// components/domains/RobotsViewer.tsx
interface RobotsViewerProps {
  content: string | null;
}

export function RobotsViewer({ content }: RobotsViewerProps) {
  if (!content) {
    return (
      <div className="text-gray-500 italic">
        No robots.txt found for this domain
      </div>
    );
  }

  const lines = content.split('\n');

  return (
    <div className="font-mono text-sm bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto">
      {lines.map((line, index) => (
        <RobotsLine key={index} line={line} lineNumber={index + 1} />
      ))}
    </div>
  );
}

function RobotsLine({ line, lineNumber }: { line: string; lineNumber: number }) {
  const getLineColor = (line: string): string => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return 'text-gray-500';
    if (trimmed.startsWith('User-agent:')) return 'text-blue-400';
    if (trimmed.startsWith('Disallow:')) return 'text-red-400';
    if (trimmed.startsWith('Allow:')) return 'text-green-400';
    if (trimmed.startsWith('Crawl-delay:')) return 'text-yellow-400';
    if (trimmed.startsWith('Sitemap:')) return 'text-purple-400';
    return 'text-gray-100';
  };

  return (
    <div className="flex">
      <span className="w-8 text-right pr-4 text-gray-600 select-none">
        {lineNumber}
      </span>
      <span className={getLineColor(line)}>{line || '\u00A0'}</span>
    </div>
  );
}
```

---

## Deep Dive: Worker Monitoring (5 minutes)

### Worker Grid Component

```tsx
// components/workers/WorkerGrid.tsx
import { useStatsStore } from '../../stores/statsStore';

interface Worker {
  id: string;
  status: 'active' | 'idle' | 'error';
  urlsProcessed: number;
  currentDomain: string | null;
  uptime: number;
  lastHeartbeat: string;
}

export function WorkerGrid() {
  const workers = useStatsStore((s) => s.workers);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {workers.map((worker) => (
        <WorkerCard key={worker.id} worker={worker} />
      ))}
    </div>
  );
}

function WorkerCard({ worker }: { worker: Worker }) {
  const statusColors = {
    active: 'bg-green-500',
    idle: 'bg-yellow-500',
    error: 'bg-red-500'
  };

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-sm font-medium">{worker.id}</span>
        <span className={`w-3 h-3 rounded-full ${statusColors[worker.status]}`} />
      </div>

      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-500">Status</dt>
          <dd className="font-medium capitalize">{worker.status}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">URLs Processed</dt>
          <dd className="font-medium">{worker.urlsProcessed.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Current Domain</dt>
          <dd className="font-medium truncate max-w-[120px]">
            {worker.currentDomain || '-'}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Uptime</dt>
          <dd className="font-medium">{formatDuration(worker.uptime)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">Last Heartbeat</dt>
          <dd className="font-medium">{formatTimeAgo(worker.lastHeartbeat)}</dd>
        </div>
      </dl>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
```

---

## Accessibility and Performance (3 minutes)

### Accessibility

```tsx
// Keyboard navigation for URL table
function URLTableWithA11y() {
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, urls.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        if (focusedIndex >= 0) {
          handleRowSelect(urls[focusedIndex]);
        }
        break;
    }
  };

  return (
    <div
      role="grid"
      aria-label="URL Frontier"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Table content */}
    </div>
  );
}

// ARIA live region for real-time updates
function LiveStats() {
  const urlsPerSecond = useStatsStore((s) => s.stats.urlsPerSecond);

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      Current crawl rate: {urlsPerSecond} URLs per second
    </div>
  );
}
```

### Performance Optimizations

```typescript
// Debounce expensive operations
import { useMemo, useCallback } from 'react';
import { debounce } from 'lodash-es';

function useURLSearch() {
  const setFilters = useFrontierStore((s) => s.setFilters);

  // Debounce search to avoid excessive API calls
  const debouncedSearch = useMemo(
    () => debounce((query: string) => setFilters({ search: query }), 300),
    [setFilters]
  );

  return debouncedSearch;
}

// Memoize expensive chart calculations
function ThroughputChart() {
  const history = useStatsStore((s) => s.stats.throughputHistory);

  const chartData = useMemo(() => {
    return history.map((point) => ({
      time: formatTime(point.timestamp),
      value: point.value
    }));
  }, [history]);

  // Only re-render when data actually changes
  return useMemo(() => <Chart data={chartData} />, [chartData]);
}
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time Updates | WebSocket | Polling | True real-time for live dashboard |
| Virtualization | TanStack Virtual | react-window | Better API, same performance |
| Charts | Recharts | D3.js directly | Simpler API, sufficient for dashboard |
| State Management | Zustand | Redux | Simpler for this scope |
| Table | Custom virtualized | AG Grid | Control over UX, no license cost |

---

## Future Enhancements

With more time, I would add:

1. **URL detail modal** with crawl history and linked pages
2. **Domain health heatmap** showing status across all domains
3. **Export functionality** for crawl reports
4. **Dark mode** for on-call monitoring
5. **Mobile-responsive** layout for phone access

---

## Summary

"I've designed a web crawler dashboard with:

1. **Real-time WebSocket stats** with live throughput charts
2. **Virtualized URL table** handling millions of rows efficiently
3. **Domain management UI** with robots.txt viewer and rate controls
4. **Worker monitoring grid** showing health and status
5. **Accessible keyboard navigation** and screen reader support

The design prioritizes real-time visibility into crawl operations while maintaining performance with large datasets."
