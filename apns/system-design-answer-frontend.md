# APNs (Apple Push Notification Service) - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design APNs from a frontend engineering perspective, focusing on building an admin dashboard for monitoring and managing the push notification infrastructure. The key challenges are real-time visualization of notification delivery metrics, managing device tokens and subscriptions, and providing a responsive interface for operations teams.

For this discussion, I'll emphasize the React component architecture, real-time data updates via WebSocket, state management patterns, and building accessible, performant admin interfaces."

## Requirements Clarification (3 minutes)

### Functional Requirements
1. **Dashboard Overview**: Real-time metrics showing notification throughput, delivery rates, and queue depth
2. **Device Management**: Search, view, and manage registered device tokens
3. **Notification Testing**: Send test notifications to specific devices
4. **Topic Management**: View and manage topic subscriptions
5. **Feedback Viewer**: Browse invalid token reports for debugging

### Non-Functional Requirements
1. **Real-time Updates**: Dashboard refreshes within 5 seconds of new data
2. **Responsiveness**: Usable on tablet and desktop (admin tool)
3. **Performance**: Handle displaying 10,000+ device records with virtualization
4. **Accessibility**: WCAG 2.1 AA compliance for admin interfaces

### Key User Personas
- **DevOps Engineer**: Monitors delivery health, responds to alerts
- **App Developer**: Tests notifications, debugs token issues
- **Support Agent**: Looks up device status for user tickets

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           APNs Admin Dashboard                                       │
│                                                                                      │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │   Dashboard    │  │    Devices     │  │    Topics      │  │   Feedback     │   │
│  │                │  │                │  │                │  │                │   │
│  │ - Metrics      │  │ - Token search │  │ - Topic list   │  │ - Invalid list │   │
│  │ - Charts       │  │ - Device table │  │ - Subscribers  │  │ - Export       │   │
│  │ - Alerts       │  │ - Actions      │  │ - Broadcast    │  │ - Filtering    │   │
│  └────────────────┘  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                         Shared Components                                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │   │
│  │  │  Metric  │  │ DataTable│  │ Timeline │  │  Modal   │  │  Toast   │       │   │
│  │  │   Card   │  │          │  │  Chart   │  │  Dialog  │  │ Notifier │       │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              State Management                                        │
│                                                                                      │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐                 │
│  │  TanStack Query │    │     Zustand     │    │    WebSocket    │                 │
│  │                 │    │                 │    │                 │                 │
│  │ - API caching   │    │ - UI state      │    │ - Real-time     │                 │
│  │ - Mutations     │    │ - Filters       │    │ - Live metrics  │                 │
│  │ - Pagination    │    │ - Selection     │    │ - Delivery feed │                 │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              Backend API                                             │
│         GET /admin/stats  |  GET /admin/devices  |  POST /admin/send-test          │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Real-Time Dashboard (8 minutes)

### Dashboard Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DashboardRoute                                       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Metrics Grid (4-column)                           │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐    │   │
│  │  │ Notifs/sec │  │ Delivery % │  │ Active     │  │ Pending    │    │   │
│  │  │ throughput │  │ rate       │  │ connections│  │ queue      │    │   │
│  │  │ + trend %  │  │ vs target  │  │            │  │ + warning  │    │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    DeliveryChart (full width)                        │   │
│  │  Timeline showing delivered, queued, failed, latencyP99             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌───────────────────────────────┐  ┌───────────────────────────────┐     │
│  │     LiveDeliveryFeed          │  │      RecentErrors             │     │
│  │  (half width)                 │  │  (half width)                 │     │
│  └───────────────────────────────┘  └───────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Pattern

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Initial Load  │     │   WebSocket      │     │   UI Render      │
│                 │     │   Connection     │     │                  │
│ useQuery with   │────▶│ Subscribe to     │────▶│ Merge API data   │
│ 30s refetch     │     │ admin_metrics    │     │ with real-time   │
│ fallback        │     │ channel          │     │ updates          │
└─────────────────┘     └──────────────────┘     └──────────────────┘
         │                      │                        │
         ▼                      ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     WebSocket State Machine                          │
│                                                                      │
│  'connecting' ──▶ 'connected' ──▶ 'disconnected' ──▶ (reconnect)   │
│                        │                                             │
│                        ▼                                             │
│              Message Types:                                          │
│              - metrics_update  ──▶ Update metrics state             │
│              - delivery_event  ──▶ Prepend to deliveries (max 100) │
└─────────────────────────────────────────────────────────────────────┘
```

### MetricCard Component Design

"The MetricCard uses Framer Motion for subtle animations when values change. Each card displays a title, current value, optional trend percentage, optional target, and a status indicator (healthy/warning/critical) that controls the border color."

```
┌─────────────────────────────────────────┐
│  MetricCard                              │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │ Title (gray-600)       [Icon]      │ │
│  │                                    │ │
│  │ VALUE (2xl bold, animates)         │ │
│  │ Target: {target}                   │ │
│  │                                    │ │
│  │ [Arrow] +X% from last hour         │ │
│  └────────────────────────────────────┘ │
│                                          │
│  Status Colors:                          │
│  - healthy:  green border + bg          │
│  - warning:  yellow border + bg         │
│  - critical: red border + bg            │
└─────────────────────────────────────────┘
```

---

## Deep Dive: Device Management (7 minutes)

### Virtualized Device Table

"For 10,000+ devices, we use TanStack Virtual with infinite query pagination. The table fetches 50 devices at a time and automatically loads more when scrolling near the bottom."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DevicesRoute                                         │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Search & Filters Bar                                                │   │
│  │  ┌─────────────────────────────┐  ┌─────────┐  ┌─────────────────┐  │   │
│  │  │ Search by token, bundle... │  │ Filters │  │ Bulk Actions    │  │   │
│  │  └─────────────────────────────┘  └─────────┘  │ (when selected) │  │   │
│  │                                                 └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Device Table (virtualized, calc(100vh-200px) height)               │   │
│  │  ┌─────────────────────────────────────────────────────────────┐    │   │
│  │  │ [x] │ Device ID      │ App Bundle    │ Status │ Last Seen │    │   │
│  │  ├─────────────────────────────────────────────────────────────┤    │   │
│  │  │     │                │               │        │           │    │   │
│  │  │  Virtual rows with absolute positioning                    │    │   │
│  │  │  - Each row 64px height                                    │    │   │
│  │  │  - Overscan: 10 items                                      │    │   │
│  │  │  - Auto-fetch when near bottom                             │    │   │
│  │  │                                                             │    │   │
│  │  └─────────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Device Row Actions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DeviceRow                                                                   │
│                                                                             │
│  ┌────┬────────────────────────┬─────────────┬────────┬──────────┬──────┐ │
│  │ [] │ a1b2c3...              │ com.app.id  │ Active │ 5m ago   │ [><] │ │
│  └────┴────────────────────────┴─────────────┴────────┴──────────┴──────┘ │
│         │                                                           │       │
│         │ Checkbox for bulk                                        │       │
│         │ selection (toggle)                                       │       │
│                                                                    │       │
│                                                          Actions:  │       │
│                                                          - Send test notif │
│                                                          - Invalidate token │
│                                                                             │
│  Row hover: bg-gray-50                                                      │
│  Row selected: bg-blue-50                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Device Store (Zustand)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           useDeviceStore                                     │
│                                                                             │
│  State:                                                                     │
│  ├── selectedDevices: string[]                                              │
│  ├── searchQuery: string                                                    │
│  └── filters: { status: 'all'|'active'|'invalid', appBundle: string|null } │
│                                                                             │
│  Actions:                                                                   │
│  ├── toggleDevice(deviceId) ──▶ Add/remove from selection                  │
│  ├── selectAll(deviceIds) ──▶ Bulk selection                               │
│  ├── clearSelection() ──▶ Reset selection                                  │
│  ├── setSearchQuery(query) ──▶ Triggers API refetch                        │
│  └── setFilter(key, value) ──▶ Update filter state                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Notification Testing Modal (5 minutes)

### Send Test Notification Form

"The modal uses react-hook-form with Zod validation. It supports both a simple mode (title/body fields) and an advanced JSON editor for custom payloads."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SendTestModal                                            │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  Send Test Notification                                         [X]  │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │                                                                       │ │
│  │  Device Token *                                                       │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │  │ a1b2c3d4e5f6... (64 chars)                                     │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                       │ │
│  │  Priority                                                             │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │  │ 10 - Immediate (wake device)                           [▼]     │ │ │
│  │  │ 5 - Background (power nap)                                     │ │ │
│  │  │ 1 - Low (opportunistic)                                        │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                       │ │
│  │  Collapse ID (optional)                                               │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │  │ e.g., sports-score-12345                                       │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                       │ │
│  │  Notification Payload                                                 │ │
│  │  ┌──────────────┐ ┌──────────────┐                                   │ │
│  │  │   [Simple]   │ │   JSON       │                                   │ │
│  │  └──────────────┘ └──────────────┘                                   │ │
│  │                                                                       │ │
│  │  Simple Mode:                   JSON Mode:                           │ │
│  │  ┌─────────────────┐           ┌─────────────────┐                   │ │
│  │  │ Title           │           │ { "aps": {      │                   │ │
│  │  │ Body (textarea) │           │   "alert": {}   │                   │ │
│  │  └─────────────────┘           │ }}              │                   │ │
│  │                                └─────────────────┘                   │ │
│  │                                                                       │ │
│  │                          ┌──────────┐  ┌──────────────────┐          │ │
│  │                          │ Cancel   │  │ Send Notification │          │ │
│  │                          └──────────┘  └──────────────────┘          │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Validation Schema

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Zod Schema: testNotificationSchema                        │
│                                                                             │
│  deviceToken:  z.string().min(64).max(64)                                   │
│  priority:     z.enum(['10', '5', '1'])                                     │
│  collapseId:   z.string().optional()                                        │
│  payload:      z.object({                                                   │
│                  aps: z.object({                                            │
│                    alert: z.union([                                         │
│                      z.string(),                                            │
│                      z.object({ title: z.string(), body: z.string() })     │
│                    ]),                                                      │
│                    badge: z.number().optional(),                            │
│                    sound: z.string().optional()                             │
│                  })                                                         │
│                })                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Delivery Timeline Chart (5 minutes)

### Recharts Implementation

"The chart uses Recharts with dual Y-axes: count metrics on the left, latency on the right. A reference line shows the 500ms SLO threshold."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DeliveryChart                                        │
│                                                                             │
│  Delivery Timeline                                                          │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                                                                       │ │
│  │  count │                                               │ latency(ms) │ │
│  │  (Y1)  │          ████                                 │    (Y2)     │ │
│  │        │    ████  ████  ████                          │             │ │
│  │        │    ████  ████  ████  ████              ....  │  ─ ─ ─ 500ms│ │
│  │        │────████──████──████──████───────────────SLO──│─ ─ ─ ─ ─ ─ ─│ │
│  │        │    ████  ████  ████  ████                    │             │ │
│  │        └───────────────────────────────────────────────┘             │ │
│  │         14:00  14:05  14:10  14:15  ...                              │ │
│  │                                                                       │ │
│  │  Lines:                                                               │ │
│  │  ── Delivered (green)  ── Queued (blue)                              │ │
│  │  ── Failed (red)       ── P99 Latency (purple)                       │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐            │
│  │Total Delivered│ Total Queued│ Total Failed │  Avg P99     │            │
│  │    12,345    │    234      │      12      │    245ms     │            │
│  └──────────────┴──────────────┴──────────────┴──────────────┘            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Chart Configuration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LineChart Configuration                                                     │
│                                                                             │
│  XAxis:                                                                     │
│  ├── dataKey: "timestamp"                                                   │
│  └── tickFormatter: format(val, 'HH:mm')                                   │
│                                                                             │
│  YAxis (count):                                                             │
│  ├── orientation: left                                                      │
│  └── yAxisId: "count"                                                       │
│                                                                             │
│  YAxis (latency):                                                           │
│  ├── orientation: right                                                     │
│  ├── unit: "ms"                                                             │
│  └── yAxisId: "latency"                                                     │
│                                                                             │
│  ReferenceLine:                                                             │
│  ├── y: 500                                                                 │
│  ├── yAxisId: "latency"                                                     │
│  ├── strokeDasharray: "5 5"                                                 │
│  └── label: "SLO: 500ms"                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Accessibility and Keyboard Navigation (5 minutes)

### Accessible Data Table

"Tables use proper ARIA roles (grid, row, columnheader, gridcell). Keyboard navigation supports Arrow keys for row movement, Enter/Space for selection, and Delete for actions."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Keyboard Navigation Map                                    │
│                                                                             │
│  Key           │ Action                                                     │
│  ──────────────┼───────────────────────────────────────────────────────────│
│  ArrowDown     │ Focus next row                                             │
│  ArrowUp       │ Focus previous row                                         │
│  Enter/Space   │ Trigger 'select' action on row                            │
│  Delete        │ Trigger 'delete' action on row                            │
│  Tab           │ Move through focusable elements                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Admin Layout Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AdminLayout                                          │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ [Skip to main content] (sr-only, visible on focus)                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  <header role="banner">                                              │   │
│  │    <nav aria-label="Main navigation">                                │   │
│  │      Dashboard | Devices | Topics | Feedback                         │   │
│  │    </nav>                                                            │   │
│  │  </header>                                                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  <main id="main-content" tabIndex={-1} role="main">                 │   │
│  │    {children}                                                        │   │
│  │  </main>                                                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  <div role="status" aria-live="polite" aria-atomic="true">          │   │
│  │    (Live announcements for screen readers)                          │   │
│  │  </div>                                                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### announce() Helper

"Screen reader announcements are done by updating a live region's textContent, then clearing it after 1 second to allow subsequent announcements."

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Frontend Rationale |
|----------|--------|-------------|---------------------|
| Real-time updates | WebSocket | Polling | Lower latency, reduced server load |
| Large data display | Virtual scrolling | Pagination | Better UX for browsing devices |
| State management | TanStack Query + Zustand | Redux | Query handles server state, Zustand for UI |
| Charts | Recharts | D3 | Declarative React API, good defaults |
| Form validation | Zod + react-hook-form | Formik | Type inference, smaller bundle |
| Styling | Tailwind CSS | CSS Modules | Rapid iteration, consistent design system |

---

## Future Frontend Enhancements

### 1. Advanced Visualization
- Geographic heat map of device connections
- Real-time delivery flow animation
- Topic subscription network graph

### 2. Developer Experience
- Notification payload builder with preview
- API explorer with cURL export
- WebSocket connection debugger

### 3. Performance
- Service Worker for offline dashboard access
- Optimistic updates for admin actions
- Background sync for batch operations

### 4. Accessibility
- Screen reader announcements for real-time updates
- High contrast theme
- Reduced motion support
