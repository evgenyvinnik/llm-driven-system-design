# Scalable API - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 1. Problem Statement (2 minutes)

"Design the admin dashboard for a scalable API platform that displays real-time metrics, manages API keys, and visualizes system health."

This is a **frontend-focused problem** requiring expertise in:
- Real-time data visualization and charts
- Dashboard layout and information hierarchy
- State management for metrics streams
- Responsive design for monitoring interfaces
- Error states and loading patterns

---

## 2. Requirements Clarification (3 minutes)

### Functional Requirements
- Real-time metrics dashboard (requests/sec, latency, error rates)
- API key management interface (create, revoke, view usage)
- Server health status grid
- Rate limit usage visualization
- Request log explorer with filtering

### Non-Functional Requirements
- **Refresh Rate**: Metrics update every 5-10 seconds
- **Performance**: Dashboard renders in < 2 seconds
- **Accessibility**: WCAG 2.1 AA compliance
- **Responsiveness**: Usable on tablet and desktop

### Frontend-Specific Clarifications
- "Real-time updates?" - Polling every 5 seconds (WebSocket for alerts only)
- "Charting library?" - Recharts for simplicity and React integration
- "State management?" - Zustand for metrics store
- "Styling?" - Tailwind CSS with custom dashboard theme

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Admin Dashboard                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Sidebar   │  │   Header    │  │   Alerts    │             │
│  │  Navigation │  │  + Search   │  │   Banner    │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Metrics Overview                         ││
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       ││
│  │  │ Requests │ │ Latency  │ │  Errors  │ │  Uptime  │       ││
│  │  │  /sec    │ │   P99    │ │   Rate   │ │    %     │       ││
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       ││
│  └─────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────┐  ┌─────────────────────────────┐  │
│  │     Traffic Chart       │  │      Server Health Grid     │  │
│  │   (Area + Line Chart)   │  │   (Status Cards + Gauges)   │  │
│  └─────────────────────────┘  └─────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    API Key Management                       ││
│  │   [Create Key]  [Filter: All Tiers ▼]  [Search...]         ││
│  │   ┌───────────────────────────────────────────────────┐    ││
│  │   │ Key        │ Tier   │ Usage    │ Created  │ Actions│   ││
│  │   ├───────────────────────────────────────────────────┤    ││
│  │   │ sk_live... │ Pro    │ 45%      │ Jan 15   │ ⚙️ 🗑️ │   ││
│  │   └───────────────────────────────────────────────────┘    ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Component Hierarchy

```
App
├── DashboardLayout
│   ├── Sidebar
│   │   ├── NavItem (Dashboard)
│   │   ├── NavItem (API Keys)
│   │   ├── NavItem (Logs)
│   │   └── NavItem (Settings)
│   ├── Header
│   │   ├── SearchBar
│   │   ├── AlertsDropdown
│   │   └── UserMenu
│   └── MainContent
│       ├── MetricsOverview
│       │   ├── StatCard (Requests/sec)
│       │   ├── StatCard (P99 Latency)
│       │   ├── StatCard (Error Rate)
│       │   └── StatCard (Uptime)
│       ├── ChartsSection
│       │   ├── TrafficChart
│       │   └── ServerHealthGrid
│       ├── APIKeyManager
│       │   ├── CreateKeyModal
│       │   ├── KeyTable
│       │   └── UsageChart
│       └── RequestLogExplorer
│           ├── LogFilters
│           └── LogTable
```

---

## 4. Deep Dives (25 minutes)

### Deep Dive 1: Real-Time Metrics Dashboard (8 minutes)

**Challenge**: Display live system metrics with smooth updates and historical context.

**Metrics Store with Zustand**:

```typescript
// frontend/src/stores/metricsStore.ts
import { create } from 'zustand';

interface MetricsPoint {
  timestamp: number;
  requestsPerSec: number;
  latencyP50: number;
  latencyP99: number;
  errorRate: number;
  activeConnections: number;
}

interface ServerHealth {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  cpu: number;
  memory: number;
  connections: number;
  lastCheck: number;
}

interface MetricsStore {
  current: MetricsPoint | null;
  history: MetricsPoint[];
  servers: ServerHealth[];
  isLoading: boolean;
  error: string | null;

  fetchMetrics: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

export const useMetricsStore = create<MetricsStore>((set, get) => {
  let pollInterval: NodeJS.Timeout | null = null;

  return {
    current: null,
    history: [],
    servers: [],
    isLoading: true,
    error: null,

    fetchMetrics: async () => {
      try {
        const [metrics, servers] = await Promise.all([
          api.get('/admin/metrics/current'),
          api.get('/admin/servers/health')
        ]);

        set(state => ({
          current: metrics,
          history: [...state.history.slice(-59), metrics], // Keep last 60 points
          servers,
          isLoading: false,
          error: null
        }));
      } catch (error) {
        set({ error: 'Failed to fetch metrics', isLoading: false });
      }
    },

    startPolling: () => {
      get().fetchMetrics();
      pollInterval = setInterval(() => get().fetchMetrics(), 5000);
    },

    stopPolling: () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }
  };
});
```

**Stat Card Component with Trend Indicator**:

```tsx
// frontend/src/components/dashboard/StatCard.tsx
interface StatCardProps {
  title: string;
  value: number | string;
  previousValue?: number;
  unit?: string;
  format?: 'number' | 'percent' | 'duration';
  threshold?: { warning: number; critical: number };
}

function StatCard({
  title,
  value,
  previousValue,
  unit,
  format = 'number',
  threshold
}: StatCardProps) {
  const numericValue = typeof value === 'number' ? value : parseFloat(value);
  const trend = previousValue !== undefined
    ? ((numericValue - previousValue) / previousValue) * 100
    : null;

  const getStatusColor = () => {
    if (!threshold) return 'text-gray-900';
    if (numericValue >= threshold.critical) return 'text-red-600';
    if (numericValue >= threshold.warning) return 'text-amber-600';
    return 'text-green-600';
  };

  const formatValue = () => {
    switch (format) {
      case 'percent':
        return `${numericValue.toFixed(2)}%`;
      case 'duration':
        return `${numericValue.toFixed(0)}ms`;
      default:
        return numericValue.toLocaleString();
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-500">{title}</h3>
        {trend !== null && (
          <TrendBadge value={trend} />
        )}
      </div>

      <div className="mt-2 flex items-baseline">
        <span className={`text-3xl font-semibold ${getStatusColor()}`}>
          {formatValue()}
        </span>
        {unit && (
          <span className="ml-1 text-sm text-gray-500">{unit}</span>
        )}
      </div>

      {threshold && (
        <div className="mt-3">
          <ThresholdBar
            value={numericValue}
            warning={threshold.warning}
            critical={threshold.critical}
          />
        </div>
      )}
    </div>
  );
}

function TrendBadge({ value }: { value: number }) {
  const isPositive = value > 0;
  const isNeutral = Math.abs(value) < 1;

  return (
    <span className={`
      inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
      ${isNeutral
        ? 'bg-gray-100 text-gray-600'
        : isPositive
          ? 'bg-red-100 text-red-700'
          : 'bg-green-100 text-green-700'
      }
    `}>
      {isPositive ? '↑' : '↓'} {Math.abs(value).toFixed(1)}%
    </span>
  );
}
```

**Traffic Chart with Historical Data**:

```tsx
// frontend/src/components/dashboard/TrafficChart.tsx
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid
} from 'recharts';

function TrafficChart() {
  const { history } = useMetricsStore();

  const chartData = history.map(point => ({
    time: new Date(point.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    }),
    requests: point.requestsPerSec,
    latencyP50: point.latencyP50,
    latencyP99: point.latencyP99
  }));

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">
        Traffic Overview
      </h3>

      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="requestsGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />

          <XAxis
            dataKey="time"
            tick={{ fontSize: 12 }}
            tickLine={false}
          />

          <YAxis
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />

          <Tooltip
            contentStyle={{
              backgroundColor: 'white',
              border: '1px solid #E5E7EB',
              borderRadius: '8px'
            }}
          />

          <Area
            type="monotone"
            dataKey="requests"
            stroke="#3B82F6"
            fill="url(#requestsGradient)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

---

### Deep Dive 2: Server Health Grid (6 minutes)

**Challenge**: Visualize multiple server statuses with quick scanning capability.

```tsx
// frontend/src/components/dashboard/ServerHealthGrid.tsx
function ServerHealthGrid() {
  const { servers, isLoading } = useMetricsStore();

  if (isLoading) {
    return <ServerHealthSkeleton count={3} />;
  }

  const healthyCount = servers.filter(s => s.status === 'healthy').length;
  const degradedCount = servers.filter(s => s.status === 'degraded').length;
  const unhealthyCount = servers.filter(s => s.status === 'unhealthy').length;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900">Server Health</h3>
        <div className="flex gap-4 text-sm">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {healthyCount} Healthy
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            {degradedCount} Degraded
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            {unhealthyCount} Unhealthy
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {servers.map(server => (
          <ServerCard key={server.id} server={server} />
        ))}
      </div>
    </div>
  );
}

function ServerCard({ server }: { server: ServerHealth }) {
  const statusColors = {
    healthy: 'border-green-200 bg-green-50',
    degraded: 'border-amber-200 bg-amber-50',
    unhealthy: 'border-red-200 bg-red-50'
  };

  const statusDotColors = {
    healthy: 'bg-green-500',
    degraded: 'bg-amber-500',
    unhealthy: 'bg-red-500'
  };

  return (
    <div className={`
      rounded-lg border-2 p-4 transition-colors
      ${statusColors[server.status]}
    `}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`
            w-3 h-3 rounded-full animate-pulse
            ${statusDotColors[server.status]}
          `} />
          <span className="font-medium text-gray-900">{server.name}</span>
        </div>
        <span className="text-xs text-gray-500">
          {formatRelativeTime(server.lastCheck)}
        </span>
      </div>

      <div className="space-y-2">
        <ResourceBar
          label="CPU"
          value={server.cpu}
          thresholds={{ warning: 70, critical: 90 }}
        />
        <ResourceBar
          label="Memory"
          value={server.memory}
          thresholds={{ warning: 80, critical: 95 }}
        />
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Connections</span>
          <span className="font-medium">{server.connections}</span>
        </div>
      </div>
    </div>
  );
}

function ResourceBar({
  label,
  value,
  thresholds
}: {
  label: string;
  value: number;
  thresholds: { warning: number; critical: number };
}) {
  const getColor = () => {
    if (value >= thresholds.critical) return 'bg-red-500';
    if (value >= thresholds.warning) return 'bg-amber-500';
    return 'bg-green-500';
  };

  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-500">{label}</span>
        <span className="font-medium">{value}%</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full ${getColor()} transition-all duration-300`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
```

---

### Deep Dive 3: API Key Management Interface (6 minutes)

**Challenge**: Allow admins to create, view, and revoke API keys with clear usage visibility.

```tsx
// frontend/src/components/apikeys/APIKeyManager.tsx
function APIKeyManager() {
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [filterTier, setFilterTier] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const { keys, isLoading, createKey, revokeKey } = useAPIKeyStore();

  const filteredKeys = useMemo(() => {
    return keys.filter(key => {
      const matchesTier = filterTier === 'all' || key.tier === filterTier;
      const matchesSearch = key.prefix.includes(searchQuery) ||
                           key.name?.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesTier && matchesSearch;
    });
  }, [keys, filterTier, searchQuery]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">API Keys</h3>
          <button
            onClick={() => setCreateModalOpen(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg
                       hover:bg-blue-700 transition-colors"
          >
            Create New Key
          </button>
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search by key prefix or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg
                         focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <select
            value={filterTier}
            onChange={(e) => setFilterTier(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg
                       focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Tiers</option>
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase tracking-wider">
                Key
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase tracking-wider">
                Tier
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase tracking-wider">
                Usage (Today)
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase tracking-wider">
                Created
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium
                           text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {filteredKeys.map(key => (
              <APIKeyRow
                key={key.id}
                apiKey={key}
                onRevoke={revokeKey}
              />
            ))}
          </tbody>
        </table>
      </div>

      <CreateKeyModal
        isOpen={isCreateModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreate={createKey}
      />
    </div>
  );
}

function APIKeyRow({
  apiKey,
  onRevoke
}: {
  apiKey: APIKey;
  onRevoke: (id: string) => void;
}) {
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

  const tierBadgeColors = {
    free: 'bg-gray-100 text-gray-700',
    pro: 'bg-blue-100 text-blue-700',
    enterprise: 'bg-purple-100 text-purple-700'
  };

  const usagePercent = (apiKey.usageToday / apiKey.dailyLimit) * 100;

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 whitespace-nowrap">
        <div>
          <code className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">
            {apiKey.prefix}...
          </code>
          {apiKey.name && (
            <p className="text-sm text-gray-500 mt-1">{apiKey.name}</p>
          )}
        </div>
      </td>

      <td className="px-6 py-4 whitespace-nowrap">
        <span className={`
          px-2 py-1 text-xs font-medium rounded-full capitalize
          ${tierBadgeColors[apiKey.tier]}
        `}>
          {apiKey.tier}
        </span>
      </td>

      <td className="px-6 py-4 whitespace-nowrap">
        <div className="w-32">
          <div className="flex justify-between text-sm mb-1">
            <span>{apiKey.usageToday.toLocaleString()}</span>
            <span className="text-gray-500">
              / {apiKey.dailyLimit.toLocaleString()}
            </span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                usagePercent > 90 ? 'bg-red-500' :
                usagePercent > 75 ? 'bg-amber-500' : 'bg-green-500'
              }`}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
        </div>
      </td>

      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {formatDate(apiKey.createdAt)}
      </td>

      <td className="px-6 py-4 whitespace-nowrap">
        {apiKey.isActive ? (
          <span className="flex items-center gap-1 text-green-600">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            Active
          </span>
        ) : (
          <span className="text-gray-400">Revoked</span>
        )}
      </td>

      <td className="px-6 py-4 whitespace-nowrap text-right">
        <div className="flex justify-end gap-2">
          <button
            onClick={() => {/* View details */}}
            className="p-2 text-gray-400 hover:text-gray-600"
            title="View Details"
          >
            <EyeIcon className="w-5 h-5" />
          </button>

          {apiKey.isActive && (
            <button
              onClick={() => setShowRevokeConfirm(true)}
              className="p-2 text-gray-400 hover:text-red-600"
              title="Revoke Key"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          )}
        </div>

        <RevokeConfirmModal
          isOpen={showRevokeConfirm}
          onClose={() => setShowRevokeConfirm(false)}
          onConfirm={() => {
            onRevoke(apiKey.id);
            setShowRevokeConfirm(false);
          }}
          keyPrefix={apiKey.prefix}
        />
      </td>
    </tr>
  );
}
```

---

### Deep Dive 4: Request Log Explorer (5 minutes)

**Challenge**: Searchable, filterable log viewer for debugging API issues.

```tsx
// frontend/src/components/logs/RequestLogExplorer.tsx
function RequestLogExplorer() {
  const [filters, setFilters] = useState<LogFilters>({
    startTime: subHours(new Date(), 1),
    endTime: new Date(),
    status: 'all',
    method: 'all',
    minLatency: undefined,
    path: ''
  });

  const { logs, isLoading, fetchLogs } = useLogStore();

  useEffect(() => {
    fetchLogs(filters);
  }, [filters]);

  const statusCounts = useMemo(() => {
    return logs.reduce((acc, log) => {
      const category = Math.floor(log.statusCode / 100);
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {} as Record<number, number>);
  }, [logs]);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Filter Bar */}
      <div className="p-4 border-b border-gray-200 space-y-4">
        <div className="flex gap-4">
          <DateRangePicker
            start={filters.startTime}
            end={filters.endTime}
            onChange={(start, end) =>
              setFilters(f => ({ ...f, startTime: start, endTime: end }))
            }
          />

          <select
            value={filters.status}
            onChange={(e) => setFilters(f => ({ ...f, status: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg"
          >
            <option value="all">All Status</option>
            <option value="2xx">2xx Success</option>
            <option value="4xx">4xx Client Error</option>
            <option value="5xx">5xx Server Error</option>
          </select>

          <select
            value={filters.method}
            onChange={(e) => setFilters(f => ({ ...f, method: e.target.value }))}
            className="px-3 py-2 border border-gray-300 rounded-lg"
          >
            <option value="all">All Methods</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
          </select>

          <input
            type="text"
            placeholder="Filter by path..."
            value={filters.path}
            onChange={(e) => setFilters(f => ({ ...f, path: e.target.value }))}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>

        {/* Quick Stats */}
        <div className="flex gap-4 text-sm">
          <span className="text-gray-500">
            {logs.length} requests
          </span>
          <span className="text-green-600">
            {statusCounts[2] || 0} success
          </span>
          <span className="text-amber-600">
            {statusCounts[4] || 0} client errors
          </span>
          <span className="text-red-600">
            {statusCounts[5] || 0} server errors
          </span>
        </div>
      </div>

      {/* Log Table */}
      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
        <table className="w-full">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase">Time</th>
              <th className="px-4 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase">Method</th>
              <th className="px-4 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase">Path</th>
              <th className="px-4 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase">Latency</th>
              <th className="px-4 py-3 text-left text-xs font-medium
                           text-gray-500 uppercase">Size</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {logs.map(log => (
              <LogRow key={log.id} log={log} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogRow({ log }: { log: RequestLog }) {
  const [isExpanded, setExpanded] = useState(false);

  const statusColor = {
    2: 'text-green-600 bg-green-50',
    3: 'text-blue-600 bg-blue-50',
    4: 'text-amber-600 bg-amber-50',
    5: 'text-red-600 bg-red-50'
  }[Math.floor(log.statusCode / 100)] || 'text-gray-600 bg-gray-50';

  return (
    <>
      <tr
        className="hover:bg-gray-50 cursor-pointer"
        onClick={() => setExpanded(!isExpanded)}
      >
        <td className="px-4 py-3 text-sm font-mono text-gray-500">
          {formatTime(log.timestamp)}
        </td>
        <td className="px-4 py-3">
          <MethodBadge method={log.method} />
        </td>
        <td className="px-4 py-3 text-sm font-mono truncate max-w-xs">
          {log.path}
        </td>
        <td className="px-4 py-3">
          <span className={`px-2 py-1 rounded text-xs font-medium ${statusColor}`}>
            {log.statusCode}
          </span>
        </td>
        <td className="px-4 py-3 text-sm">
          <LatencyBadge ms={log.responseTimeMs} />
        </td>
        <td className="px-4 py-3 text-sm text-gray-500">
          {formatBytes(log.responseSize)}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={6} className="px-4 py-4 bg-gray-50">
            <LogDetails log={log} />
          </td>
        </tr>
      )}
    </>
  );
}
```

---

## 5. Loading and Error States (2 minutes)

```tsx
// Skeleton loading for metrics
function MetricsSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="bg-white rounded-lg shadow-sm p-6 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-4" />
          <div className="h-8 bg-gray-200 rounded w-3/4" />
        </div>
      ))}
    </div>
  );
}

// Error state with retry
function MetricsError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
      <ExclamationCircleIcon className="w-12 h-12 text-red-400 mx-auto mb-4" />
      <h3 className="text-lg font-medium text-red-800 mb-2">
        Failed to Load Metrics
      </h3>
      <p className="text-red-600 mb-4">{error}</p>
      <button
        onClick={onRetry}
        className="px-4 py-2 bg-red-600 text-white rounded-lg
                   hover:bg-red-700 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
```

---

## 6. Trade-offs Summary (2 minutes)

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Polling vs WebSocket | Simpler but higher latency | 5s delay acceptable for dashboard |
| Recharts | Less customizable than D3 | React-native integration, faster development |
| Client-side filtering | Memory usage for large datasets | Faster UX, server handles pagination |
| Single-page dashboard | Initial load time | Monitoring context preserved |
| Zustand | Less ecosystem than Redux | Simpler API, sufficient for dashboard |

---

## 7. Future Enhancements

1. **WebSocket for Alerts**: Push critical alerts immediately
2. **Custom Dashboard Layouts**: Drag-and-drop widget arrangement
3. **Saved Filter Presets**: Quick access to common log queries
4. **Metric Annotations**: Mark deployments and incidents on charts
5. **Mobile Dashboard**: Responsive design for on-call monitoring
