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
│  │   [Create Key]  [Filter: All Tiers]  [Search...]           ││
│  │   ┌───────────────────────────────────────────────────┐    ││
│  │   │ Key        │ Tier   │ Usage    │ Created  │ Actions│   ││
│  │   ├───────────────────────────────────────────────────┤    ││
│  │   │ sk_live... │ Pro    │ 45%      │ Jan 15   │ Edit   │   ││
│  │   └───────────────────────────────────────────────────┘    ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│ App                                                             │
│ └── DashboardLayout                                             │
│     ├── Sidebar                                                 │
│     │   ├── NavItem (Dashboard)                                 │
│     │   ├── NavItem (API Keys)                                  │
│     │   ├── NavItem (Logs)                                      │
│     │   └── NavItem (Settings)                                  │
│     ├── Header                                                  │
│     │   ├── SearchBar                                           │
│     │   ├── AlertsDropdown                                      │
│     │   └── UserMenu                                            │
│     └── MainContent                                             │
│         ├── MetricsOverview                                     │
│         │   ├── StatCard (Requests/sec)                         │
│         │   ├── StatCard (P99 Latency)                          │
│         │   ├── StatCard (Error Rate)                           │
│         │   └── StatCard (Uptime)                               │
│         ├── ChartsSection                                       │
│         │   ├── TrafficChart                                    │
│         │   └── ServerHealthGrid                                │
│         ├── APIKeyManager                                       │
│         │   ├── CreateKeyModal                                  │
│         │   ├── KeyTable                                        │
│         │   └── UsageChart                                      │
│         └── RequestLogExplorer                                  │
│             ├── LogFilters                                      │
│             └── LogTable                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dives (25 minutes)

### Deep Dive 1: Real-Time Metrics Dashboard (8 minutes)

**Challenge**: Display live system metrics with smooth updates and historical context.

#### Metrics Store Architecture (Zustand)

```
┌─────────────────────────────────────────────────────────────────┐
│                      useMetricsStore                            │
├─────────────────────────────────────────────────────────────────┤
│ State:                                                          │
│   current: MetricsPoint | null  ──▶ Latest data point          │
│   history: MetricsPoint[]       ──▶ Last 60 points (5 min)     │
│   servers: ServerHealth[]       ──▶ All server statuses        │
│   isLoading: boolean                                            │
│   error: string | null                                          │
├─────────────────────────────────────────────────────────────────┤
│ Actions:                                                        │
│   fetchMetrics()  ──▶ GET /admin/metrics/current                │
│                   ──▶ GET /admin/servers/health                 │
│   startPolling()  ──▶ setInterval(5000ms)                       │
│   stopPolling()   ──▶ clearInterval()                           │
└─────────────────────────────────────────────────────────────────┘
```

#### MetricsPoint Interface

| Field | Type | Description |
|-------|------|-------------|
| timestamp | number | Unix timestamp |
| requestsPerSec | number | Current throughput |
| latencyP50 | number | Median latency (ms) |
| latencyP99 | number | 99th percentile (ms) |
| errorRate | number | Error percentage |
| activeConnections | number | Current connections |

#### ServerHealth Interface

| Field | Type | Description |
|-------|------|-------------|
| id | string | Server identifier |
| name | string | Display name |
| status | enum | healthy / degraded / unhealthy |
| cpu | number | CPU usage percentage |
| memory | number | Memory usage percentage |
| connections | number | Active connections |
| lastCheck | number | Last health check timestamp |

#### Polling Lifecycle

```
┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  Component   │     │ MetricsStore  │     │   API        │
│   Mount      │     │               │     │              │
└──────┬───────┘     └───────┬───────┘     └──────┬───────┘
       │                     │                    │
       │  startPolling()     │                    │
       │────────────────────▶│                    │
       │                     │                    │
       │                     │  GET /metrics      │
       │                     │───────────────────▶│
       │                     │                    │
       │                     │◀─────── JSON ──────│
       │                     │                    │
       │  state update       │                    │
       │◀────────────────────│                    │
       │                     │                    │
       │   ... every 5s ...  │                    │
       │                     │                    │
       │  stopPolling()      │                    │
       │────────────────────▶│                    │
       │  (on unmount)       │                    │
       ▼                     ▼                    ▼
```

#### StatCard Component

```
┌─────────────────────────────────────────┐
│  ┌───────────────────────┬───────────┐  │
│  │ Title (gray-500)      │ TrendBadge│  │
│  │ "P99 Latency"         │  ↑ 5.2%   │  │
│  └───────────────────────┴───────────┘  │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  Value (3xl font)      Unit     │    │
│  │  "245"                 "ms"     │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ ThresholdBar (optional)         │    │
│  │ ████████████░░░░░ 70%          │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

**StatCard Props:**
- `title`: Display label
- `value`: Current numeric value
- `previousValue`: For trend calculation
- `unit`: Optional suffix (ms, %, /sec)
- `format`: number | percent | duration
- `threshold`: { warning: number, critical: number }

**Color Logic:**
- Green: Below warning threshold
- Amber: Between warning and critical
- Red: Above critical threshold

#### TrendBadge Logic

```
  Trend = ((current - previous) / previous) * 100

  if |trend| < 1%  ──▶ Gray background (neutral)
  if trend > 0     ──▶ Red background (increase = bad for latency/errors)
  if trend < 0     ──▶ Green background (decrease = improvement)

  Display: "↑ 5.2%" or "↓ 3.1%"
```

#### Traffic Chart (Recharts)

```
┌─────────────────────────────────────────────────────────────────┐
│  Traffic Overview                                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  req/s│                                                         │
│   500 │                    ╭───╮                                │
│   400 │              ╭────╯   ╰──╮                              │
│   300 │        ╭────╯            ╰───╮                          │
│   200 │  ╭────╯                      ╰────╮                     │
│   100 │──╯                                ╰───                  │
│       └─────────────────────────────────────────                │
│         10:00  10:05  10:10  10:15  10:20  10:25                │
│                                                                 │
│  Chart Type: AreaChart with gradient fill                       │
│  Data: history[] mapped to { time, requests, latencyP50/P99 }   │
│  Update: Re-renders when history changes (every 5s poll)        │
└─────────────────────────────────────────────────────────────────┘
```

**Chart Configuration:**
- `ResponsiveContainer`: 100% width, 300px height
- `linearGradient`: Blue gradient for area fill (30% to 0% opacity)
- `CartesianGrid`: Dashed stroke (#E5E7EB)
- `XAxis`: Time labels (HH:MM format)
- `YAxis`: No axis line, clean look
- `Tooltip`: White background with border radius

---

### Deep Dive 2: Server Health Grid (6 minutes)

**Challenge**: Visualize multiple server statuses with quick scanning capability.

#### Health Summary Bar

```
┌─────────────────────────────────────────────────────────────────┐
│  Server Health                 ● 5 Healthy  ● 1 Degraded  ● 0   │
└─────────────────────────────────────────────────────────────────┘
```

Count servers by status for at-a-glance overview.

#### Server Card Layout

```
┌───────────────────────────────────────────┐
│  ● api-server-1            "2 min ago"    │  ◀── Status dot + name + last check
├───────────────────────────────────────────┤
│  CPU       ████████████░░░░  78%          │  ◀── ResourceBar
│  Memory    ██████████████░░  85%          │  ◀── Warning color at 80%+
│  Connections                 1,234        │  ◀── Plain text
└───────────────────────────────────────────┘
```

**Card Styling by Status:**

| Status | Border Color | Background |
|--------|--------------|------------|
| healthy | border-green-200 | bg-green-50 |
| degraded | border-amber-200 | bg-amber-50 |
| unhealthy | border-red-200 | bg-red-50 |

**Status Dot:**
- Green/Amber/Red with `animate-pulse` for visual attention
- 3x3 rounded-full

#### ResourceBar Component

```
┌─────────────────────────────────────────────────────────────────┐
│  Props:                                                         │
│    label: string ("CPU", "Memory")                              │
│    value: number (0-100)                                        │
│    thresholds: { warning: 70, critical: 90 }                    │
├─────────────────────────────────────────────────────────────────┤
│  Color Logic:                                                   │
│    value >= critical  ──▶ bg-red-500                            │
│    value >= warning   ──▶ bg-amber-500                          │
│    else               ──▶ bg-green-500                          │
├─────────────────────────────────────────────────────────────────┤
│  Render:                                                        │
│    ┌────────────────────────────────┐                           │
│    │ Label               Value%    │                           │
│    ├────────────────────────────────┤                           │
│    │ ████████████░░░░░░░░░░░░░░░░░░ │  ◀── 2px height bar      │
│    └────────────────────────────────┘      with transition      │
└─────────────────────────────────────────────────────────────────┘
```

#### Grid Layout

- `grid-cols-1` on mobile
- `md:grid-cols-2` on tablet
- `lg:grid-cols-3` on desktop
- `gap-4` between cards

#### Loading State: ServerHealthSkeleton

```
┌───────────────────────────────────────────┐
│  ░░░░░░░░░░░░░░░░░░░░            ░░░░░░   │  animate-pulse
├───────────────────────────────────────────┤
│  ░░░░  ░░░░░░░░░░░░░░░░░░░░░░░░  ░░░%    │
│  ░░░░  ░░░░░░░░░░░░░░░░░░░░░░░░  ░░░%    │
│  ░░░░░░░░░░░░░                   ░░░░░   │
└───────────────────────────────────────────┘
  Repeat 3x in grid
```

---

### Deep Dive 3: API Key Management Interface (6 minutes)

**Challenge**: Allow admins to create, view, and revoke API keys with clear usage visibility.

#### APIKeyManager Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  API Keys                                    [Create New Key]   │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────┐  ┌────────────────────┐ │
│  │ Search by key prefix or name...   │  │ All Tiers      ▼  │ │
│  └────────────────────────────────────┘  └────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Key       │ Tier    │ Usage (Today) │ Created  │ Status │ Act │
├─────────────────────────────────────────────────────────────────┤
│  sk_liv... │ Pro     │ ████░░ 45%    │ Jan 15   │ Active │ ... │
│  sk_tes... │ Free    │ ██░░░░ 22%    │ Jan 10   │ Active │ ... │
│  sk_old... │ Enterp. │ ░░░░░░  0%    │ Dec 05   │ Revoked│ ... │
└─────────────────────────────────────────────────────────────────┘
```

#### State Management

```
┌─────────────────────────────────────────────────────────────────┐
│  Local State (useState):                                        │
│    isCreateModalOpen: boolean                                   │
│    filterTier: 'all' | 'free' | 'pro' | 'enterprise'           │
│    searchQuery: string                                          │
├─────────────────────────────────────────────────────────────────┤
│  Store State (useAPIKeyStore):                                  │
│    keys: APIKey[]                                               │
│    isLoading: boolean                                           │
│    createKey: (params) => Promise                               │
│    revokeKey: (id) => Promise                                   │
└─────────────────────────────────────────────────────────────────┘
```

#### Filtering Logic (useMemo)

```
  filteredKeys = keys.filter(key => {
    matchesTier = (filterTier === 'all') OR (key.tier === filterTier)
    matchesSearch = key.prefix.includes(query) OR
                    key.name?.toLowerCase().includes(query)
    return matchesTier AND matchesSearch
  })
```

#### APIKey Interface

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier |
| prefix | string | Display prefix (sk_live_...) |
| name | string? | Optional friendly name |
| tier | enum | free / pro / enterprise |
| usageToday | number | Requests made today |
| dailyLimit | number | Tier-based daily limit |
| createdAt | Date | Creation timestamp |
| isActive | boolean | Not revoked |

#### Tier Badge Colors

| Tier | Background | Text |
|------|------------|------|
| free | bg-gray-100 | text-gray-700 |
| pro | bg-blue-100 | text-blue-700 |
| enterprise | bg-purple-100 | text-purple-700 |

#### Usage Bar in Row

```
  usagePercent = (usageToday / dailyLimit) * 100

  Bar color:
    > 90%  ──▶ bg-red-500
    > 75%  ──▶ bg-amber-500
    else   ──▶ bg-green-500

  Display: "1,234 / 10,000" with visual bar below
```

#### Action Buttons

```
  ┌─────────────────────────────────────────┐
  │  [Eye Icon]  ──▶ View details modal     │
  │  [Trash Icon] ──▶ Revoke confirmation   │  (only if isActive)
  └─────────────────────────────────────────┘
```

#### Revoke Confirmation Flow

```
  User clicks Trash ──▶ showRevokeConfirm = true
                        ──▶ RevokeConfirmModal opens
                            ──▶ Shows key prefix
                            ──▶ Warns action is permanent
                        ──▶ On confirm: revokeKey(id)
                        ──▶ Close modal
```

---

### Deep Dive 4: Request Log Explorer (5 minutes)

**Challenge**: Searchable, filterable log viewer for debugging API issues.

#### Filter Bar Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  [DateRangePicker] [Status ▼] [Method ▼] [Filter by path...  ] │
├─────────────────────────────────────────────────────────────────┤
│  1,234 requests  |  1,180 success  |  42 client  |  12 server  │
└─────────────────────────────────────────────────────────────────┘
```

#### LogFilters Interface

| Field | Type | Default |
|-------|------|---------|
| startTime | Date | 1 hour ago |
| endTime | Date | now |
| status | string | 'all' |
| method | string | 'all' |
| minLatency | number? | undefined |
| path | string | '' |

#### Status Filter Options

| Value | Label |
|-------|-------|
| all | All Status |
| 2xx | 2xx Success |
| 4xx | 4xx Client Error |
| 5xx | 5xx Server Error |

#### Method Filter Options

| Value |
|-------|
| all |
| GET |
| POST |
| PUT |
| DELETE |

#### Status Counts (Quick Stats)

```
  statusCounts = logs.reduce((acc, log) => {
    category = Math.floor(log.statusCode / 100)  // 2, 3, 4, or 5
    acc[category] = (acc[category] || 0) + 1
    return acc
  }, {})

  Display with colors:
    2xx ──▶ text-green-600
    4xx ──▶ text-amber-600
    5xx ──▶ text-red-600
```

#### Log Table Structure

```
┌─────────────────────────────────────────────────────────────────┐
│ Time     │ Method │ Path          │ Status │ Latency │ Size    │
├─────────────────────────────────────────────────────────────────┤
│ 10:23:45 │ GET    │ /api/users    │  200   │  45ms   │ 1.2 KB  │
│ 10:23:44 │ POST   │ /api/auth     │  401   │ 120ms   │ 0.3 KB  │
│ 10:23:42 │ GET    │ /api/products │  500   │ 2.3s    │ 0.1 KB  │
└─────────────────────────────────────────────────────────────────┘
  max-height: 600px with overflow-y: auto
  sticky header in bg-gray-50
```

#### Status Code Colors

| Range | Background | Text |
|-------|------------|------|
| 2xx | bg-green-50 | text-green-600 |
| 3xx | bg-blue-50 | text-blue-600 |
| 4xx | bg-amber-50 | text-amber-600 |
| 5xx | bg-red-50 | text-red-600 |

#### Expandable Log Row

```
  Click row ──▶ isExpanded = !isExpanded

  If expanded:
    ┌─────────────────────────────────────────────────────────────┐
    │  LogDetails Component (spans all 6 columns)                 │
    │    - Request headers                                        │
    │    - Response headers                                       │
    │    - Request body (if applicable)                           │
    │    - Error message (if 4xx/5xx)                             │
    └─────────────────────────────────────────────────────────────┘
```

#### MethodBadge Component

```
  GET    ──▶ Blue badge
  POST   ──▶ Green badge
  PUT    ──▶ Amber badge
  DELETE ──▶ Red badge
```

#### LatencyBadge Logic

```
  < 100ms   ──▶ text-green-600
  < 500ms   ──▶ text-amber-600
  >= 500ms  ──▶ text-red-600 (slow request)
```

---

## 5. Loading and Error States (2 minutes)

#### MetricsSkeleton

```
┌─────────────────────────────────────────────────────────────────┐
│  grid-cols-4 with gap-4                                         │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ ░░░░░░░░ │  │ ░░░░░░░░ │  │ ░░░░░░░░ │  │ ░░░░░░░░ │        │
│  │ ░░░░░░░░ │  │ ░░░░░░░░ │  │ ░░░░░░░░ │  │ ░░░░░░░░ │        │
│  │ ░░░░░░   │  │ ░░░░░░   │  │ ░░░░░░   │  │ ░░░░░░   │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                 │
│  Each card: animate-pulse with gray-200 rectangles             │
└─────────────────────────────────────────────────────────────────┘
```

#### MetricsError Component

```
┌─────────────────────────────────────────────────────────────────┐
│                    bg-red-50 border-red-200                     │
│                                                                 │
│                    [ExclamationCircle Icon]                     │
│                         (red-400, 12x12)                        │
│                                                                 │
│              "Failed to Load Metrics" (red-800)                 │
│                                                                 │
│                    {error message} (red-600)                    │
│                                                                 │
│                        [Retry Button]                           │
│                    bg-red-600 hover:red-700                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Retry Flow:**
- Button calls `fetchMetrics()` from store
- Sets `isLoading = true` during fetch
- Clears error on success

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
