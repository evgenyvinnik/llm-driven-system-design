# Scalable API Platform — System Design Answer (Frontend Focus)

*45-minute system design interview — Frontend Engineer Position*

---

## 📋 Opening Statement

"I'll design the admin dashboard for a scalable API platform — a real-time monitoring interface that displays live metrics, manages API keys, visualizes server health, and provides a request log explorer. The core frontend challenges are rendering live-updating data efficiently, managing multiple polling streams without overwhelming the browser, and presenting complex system health information in a scannable layout that helps operators make quick decisions during incidents."

---

## 🎯 Requirements

### Functional Requirements

- Real-time metrics dashboard showing requests/sec, latency percentiles, error rates, and uptime
- API key management interface with create, revoke, and usage visibility
- Server health status grid with CPU, memory, and connection indicators
- Request log explorer with filtering by status, method, path, and time range
- Rate limit usage visualization per API key

### Non-Functional Requirements

- **Refresh rate**: Metrics update every 5 seconds via polling
- **Render performance**: Dashboard initial paint in under 2 seconds; re-renders under 16ms
- **Accessibility**: WCAG 2.1 AA compliance across all dashboard views
- **Responsiveness**: Full functionality on tablet (768px+) and desktop
- **Graceful degradation**: Dashboard remains usable when backend is temporarily unreachable

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Admin Dashboard (SPA)                        │
│                                                                     │
│  ┌──────────┐  ┌──────────────────────────────────────────────────┐ │
│  │          │  │  Header Bar          [Search]  [Alerts]  [User] │ │
│  │ Sidebar  │  ├──────────────────────────────────────────────────┤ │
│  │          │  │                                                  │ │
│  │ Dashboard│  │  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ │ │
│  │ API Keys │  │  │ Req/sec  │ │ P99 ms   │ │ Errors │ │Uptime│ │ │
│  │ Logs     │  │  └──────────┘ └──────────┘ └────────┘ └──────┘ │ │
│  │ Settings │  │                                                  │ │
│  │          │  │  ┌────────────────────┐ ┌──────────────────────┐ │ │
│  │          │  │  │  Traffic Chart     │ │  Server Health Grid  │ │ │
│  │          │  │  │  (Area + Line)     │ │  (Status Cards)      │ │ │
│  │          │  │  └────────────────────┘ └──────────────────────┘ │ │
│  │          │  │                                                  │ │
│  │          │  │  ┌──────────────────────────────────────────────┐│ │
│  │          │  │  │  API Key Management / Request Log Explorer   ││ │
│  │          │  │  └──────────────────────────────────────────────┘│ │
│  └──────────┘  └──────────────────────────────────────────────────┘ │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                    Polling (5s) │ REST API
                                 │
                                 ▼
                  ┌──────────────────────────────┐
                  │      Backend API Gateway     │
                  │   /api/v1/admin/metrics       │
                  │   /api/v1/admin/servers       │
                  │   /api/v1/admin/keys          │
                  │   /api/v1/admin/logs          │
                  └──────────────────────────────┘
```

---

## 🧩 Component Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  App                                                             │
│  ├── AuthGuard (checks session, redirects to /login)             │
│  └── DashboardLayout                                             │
│      ├── Sidebar ──── NavItem (x4: Dashboard, Keys, Logs, etc.) │
│      ├── Header                                                  │
│      │   ├── SearchBar                                           │
│      │   ├── AlertsDropdown                                      │
│      │   └── UserMenu                                            │
│      └── MainContent (route outlet)                              │
│          ├── MetricsOverview                                     │
│          │   └── StatCard (x4: RPS, P99, Error Rate, Uptime)    │
│          ├── ChartsSection                                       │
│          │   ├── TrafficChart (Recharts AreaChart)               │
│          │   └── ServerHealthGrid                                │
│          │       └── ServerCard (xN per backend instance)        │
│          ├── APIKeyManager                                       │
│          │   ├── CreateKeyModal                                  │
│          │   ├── KeyTable with UsageBars                         │
│          │   └── RevokeConfirmModal                              │
│          └── RequestLogExplorer                                  │
│              ├── LogFilters (date, status, method, path)         │
│              └── LogTable with expandable rows                   │
└──────────────────────────────────────────────────────────────────┘
```

**State management split**: Zustand stores hold server-fetched data (metrics, API keys, auth state) because this data is shared across components and must survive route changes. Local React state handles ephemeral UI concerns — modal visibility, filter selections, search input text — that reset naturally on navigation.

---

## 🔌 API Contract

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/admin/metrics/current | Current RPS, latency percentiles, error rate, uptime |
| GET | /api/v1/admin/servers/health | Status, CPU, memory, connections per server instance |
| GET | /api/v1/admin/keys | List all API keys with usage stats (paginated) |
| POST | /api/v1/admin/keys | Create new API key with tier and scopes |
| DELETE | /api/v1/admin/keys/:id | Revoke an API key (soft delete) |
| GET | /api/v1/admin/logs | Request logs with filter params (status, method, path, date range) |
| POST | /api/v1/admin/login | Authenticate admin, establish session cookie |
| POST | /api/v1/admin/logout | Destroy session |
| GET | /api/v1/admin/me | Check current session validity |

All responses follow a consistent envelope: a data field on success, an error object with message and code on failure, and a meta object containing requestId, timestamp, and optional pagination info.

---

## 💾 Client-Side Data Model

**Metrics Store (Zustand)**

| Field | Type | Purpose |
|-------|------|---------|
| current | MetricsPoint or null | Latest snapshot: RPS, latency percentiles, error rate, connections |
| history | MetricsPoint[] (max 60) | Rolling 5-minute window for chart rendering |
| servers | ServerHealth[] | Per-instance status, CPU, memory, connection count, last check time |
| isLoading | boolean | Initial fetch in progress |
| isStale | boolean | True after 3 consecutive poll failures |
| error | string or null | Most recent fetch error message |

**API Key Store (Zustand)**

| Field | Type | Purpose |
|-------|------|---------|
| keys | APIKey[] | All keys with prefix, tier, daily usage, daily limit, status |
| isLoading | boolean | Fetch or mutation in progress |
| createKey | async function | POST to create, appends to list on success |
| revokeKey | async function | DELETE by id, marks as revoked optimistically |

**Auth Store (Zustand)**

| Field | Type | Purpose |
|-------|------|---------|
| user | AdminUser or null | Current admin session (id, email, role) |
| isLoading | boolean | Session check in progress |
| login | async function | POST credentials, set user on success |
| logout | async function | POST logout, clear user |
| checkSession | async function | GET /admin/me on app mount |

---

## 🔧 Deep Dive: Real-Time Metrics Polling

**Challenge**: Keep the dashboard current with minimal performance impact and graceful handling of backend outages.

```
┌──────────────┐         ┌───────────────┐         ┌──────────────┐
│  Component   │         │ MetricsStore  │         │   Backend    │
│  (mounts)    │         │  (Zustand)    │         │   API        │
└──────┬───────┘         └───────┬───────┘         └──────┬───────┘
       │                         │                        │
       │  startPolling()         │                        │
       │────────────────────────▶│                        │
       │                         │  GET /metrics/current  │
       │                         │───────────────────────▶│
       │                         │◀───────── JSON ────────│
       │                         │                        │
       │  Zustand state update   │                        │
       │◀────────────────────────│                        │
       │  (re-render StatCards   │                        │
       │   + TrafficChart)       │                        │
       │                         │                        │
       │     ... 5s interval ... │                        │
       │                         │                        │
       │  stopPolling()          │                        │
       │  (on unmount)           │                        │
       │────────────────────────▶│                        │
       ▼                         ▼                        ▼
```

The polling hook tracks consecutive failures. After three failures (15 seconds of silence), the store sets isStale to true. The UI responds by dimming the metrics cards and showing a warning banner: "Data may be outdated. Last update: X seconds ago." Critically, the last known values remain visible — operators still see the most recent metrics rather than an empty screen.

> "I chose polling over WebSockets here because the dashboard tolerates 5-second staleness. WebSockets would add connection management complexity — heartbeats, reconnection with exponential backoff, state synchronization on reconnect — that is unjustified for a 5-second refresh cycle. The exception is critical alerts, where I would add a dedicated WebSocket channel to push urgent notifications immediately."

**StatCard rendering optimization**: Each StatCard receives its specific value via a Zustand selector. When RPS changes but P99 stays the same, only the RPS card re-renders. The TrafficChart appends the new point to the history array and shifts old points out — Recharts handles the animation transition smoothly because the data shape is stable.

**Trend badge logic**: Each StatCard computes a percentage change between the current value and the previous value. Changes under 1% display a neutral gray badge. Positive changes (increase) display red for metrics where up is bad (latency, errors) and green where up is good (throughput). This inverted color logic prevents operators from misreading a latency spike as positive.

---

## 🔧 Deep Dive: Server Health Grid

**Challenge**: Display N server instances in a scannable layout where operators can spot problems in under 2 seconds.

```
┌────────────────────────────────────────────────────────────────┐
│  Server Health               ● 5 Healthy  ● 1 Degraded  ● 0  │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────┐  ┌──────────────────────┐            │
│  │ ● api-server-1       │  │ ● api-server-2       │            │
│  │   "2 min ago"        │  │   "30 sec ago"       │            │
│  ├──────────────────────┤  ├──────────────────────┤            │
│  │ CPU  ████████░░  78% │  │ CPU  ██████░░░░  55% │            │
│  │ Mem  █████████░  85% │  │ Mem  ███████░░░  70% │            │
│  │ Conn       1,234     │  │ Conn         891     │            │
│  └──────────────────────┘  └──────────────────────┘            │
│                                                                │
│  ┌──────────────────────┐                                      │
│  │ ● api-server-3       │  (degraded — amber border + bg)      │
│  │   "5 min ago"        │                                      │
│  ├──────────────────────┤                                      │
│  │ CPU  ██████████  95% │  ◀── red bar (above 90% critical)   │
│  │ Mem  █████████░  88% │  ◀── amber bar (above 80% warning)  │
│  │ Conn       2,456     │                                      │
│  └──────────────────────┘                                      │
└────────────────────────────────────────────────────────────────┘
```

**Summary bar**: Before the grid, a single row aggregates server counts by status — "5 Healthy, 1 Degraded, 0 Unhealthy." This lets an operator glance at the page and immediately know whether investigation is needed.

**Card border and background by status**: Healthy cards use green-50 background with green-200 border. Degraded uses amber tones. Unhealthy uses red tones with a pulsing status dot to draw attention. The status dot uses CSS animation (pulse) rather than JavaScript to avoid triggering React re-renders for the animation.

**Resource bars**: Each CPU and memory bar uses threshold-based coloring. Below 70% is green, 70-90% is amber, above 90% is red. This three-tier system matches industry-standard monitoring conventions and requires no legend.

**Responsive grid**: The cards use CSS grid with 1 column on mobile, 2 on tablet (md breakpoint), and 3 on desktop (lg breakpoint). Gap spacing is 16px. When a server goes unhealthy, its card visually stands out because of the contrasting red background, even in a dense grid.

**Loading skeleton**: On initial load, 3 placeholder cards render with animated pulse backgrounds matching the card dimensions. This prevents layout shift when data arrives.

---

## 🔧 Deep Dive: API Key Management

**Challenge**: Allow admins to create, view, search, and revoke API keys with clear usage visibility and destructive action safety.

```
┌────────────────────────────────────────────────────────────────┐
│  API Keys                                   [+ Create New Key] │
├────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────┐  ┌────────────────────┐          │
│  │ Search by prefix or name │  │ Filter: All Tiers ▼│          │
│  └──────────────────────────┘  └────────────────────┘          │
├────────────────────────────────────────────────────────────────┤
│  Key        │ Tier       │ Usage Today   │ Created  │ Actions  │
├────────────────────────────────────────────────────────────────┤
│  sk_live... │ Pro        │ ████░░  45%   │ Jan 15   │ [V] [X]  │
│  sk_test... │ Free       │ ██░░░░  22%   │ Jan 10   │ [V] [X]  │
│  sk_old...  │ Enterprise │ ░░░░░░   0%   │ Dec 05   │ Revoked  │
└────────────────────────────────────────────────────────────────┘
```

**Client-side filtering**: The key list is typically small (under 100 keys per account), so filtering by tier and search query happens in the browser using a memoized filter function. This avoids an API round-trip on every keystroke and delivers instant feedback.

**Usage bar coloring**: The usage percentage (usageToday / dailyLimit) drives the bar color. Above 90% is red with a warning that the key is approaching its limit. Above 75% is amber. Below is green. The numeric display shows "1,234 / 10,000" alongside the visual bar for accessibility.

**Revoke confirmation flow**: Clicking the revoke button opens a confirmation modal that displays the key prefix and warns that revocation is permanent and immediate — any applications using this key will begin receiving 401 errors. The confirm button uses red styling and requires a deliberate click. On confirmation, the UI optimistically marks the key as revoked (gray styling, actions disabled) before the API response returns. If the API call fails, the key reverts to active and an error toast appears.

**Create key modal**: The creation form collects a friendly name, tier selection, and optional scope restrictions. On submission, the backend returns the full API key exactly once. The modal displays it with a copy button and a prominent warning: "This key will only be shown once. Copy it now." The modal cannot be dismissed without the user either copying the key or explicitly acknowledging the warning.

**Tier badge styling**: Free keys use a gray badge. Pro uses blue. Enterprise uses purple. These colors are consistent across the dashboard wherever tier information appears, building visual familiarity.

---

## 🔧 Deep Dive: A Dashboard That Can Lie by Omission

The hardest UI problem here isn't rendering numbers — it's that several *distinct* system states produce the same-looking dashboard, and an operator has to be able to tell them apart.

| What the operator sees | Could mean | Also could mean |
|------------------------|------------|-----------------|
| Request rate drops to zero | Traffic genuinely stopped | The dashboard's own polling died |
| Allow rate jumps to 100% | Abuse stopped | The limiter is **failing open** and enforcing nothing |
| Cache hit rate 0% | Cold cache | Redis is unreachable and every lookup is silently missing |
| All instances "healthy" | They are | Health checks pass while the gateway sends them no traffic |

Every row on the right is worse than the row on the left, and none of them is distinguishable from the metrics alone. That's why the dashboard renders **dependency state next to the counters** — Redis connectivity, circuit-breaker state per dependency, and per-instance health — rather than treating them as a separate "system" page. A number without its dependency's status is not interpretable.

> "The specific failure I'd design against is the second row. A rate limiter that's failing open looks *better* than one that's working — rejections drop to zero, everything turns green. If the only thing on screen is the allow rate, the operator concludes the system is healthy at exactly the moment it has stopped protecting anything. Showing breaker state beside it is what makes the difference visible."

**The polling interval is part of this, not just a performance knob.** At a 5-second refresh, a counter that stops moving is ambiguous for 5 seconds — is it idle or is the poll failing? So the UI stamps "last updated" and treats a failed refresh as a visible state rather than silently keeping the previous render, which would show a frozen dashboard indistinguishable from a quiet one.

**What we give up** by polling at all is that the dashboard is always a few seconds behind, and every connected operator multiplies the load on the very API they're inspecting — an observability tool that degrades the thing it observes. That's acceptable here because the audience is one or two operators, and it's the first thing that would flip to a server-sent stream if the dashboard were ever put in front of a team.

## ⚖️ Trade-offs Summary

| Decision | Approach | Pros | Cons |
|----------|----------|------|------|
| ✅ Polling (5s) | Simple interval-based fetching | Simple, reliable, no connection management | 5s max staleness |
| ❌ WebSocket | Persistent bidirectional connection | Sub-second updates | Connection complexity, reconnection logic |
| ✅ Zustand | Lightweight state management | Minimal boilerplate, selector-based re-renders | Smaller ecosystem than Redux |
| ❌ Redux | Full-featured state management | Devtools, middleware ecosystem | Excessive ceremony for this use case |
| ✅ Recharts | React-native charting library | Declarative API, good React integration | Less customizable than D3 |
| ❌ D3 | Low-level visualization | Total control over rendering | Imperative API fights React's model |
| ✅ Client-side filtering | Filter keys in browser | Instant feedback, no API round-trips | Memory grows with key count |
| ❌ Server-side filtering | Filter via API params | Scales to thousands of keys | Network latency on every filter change |
| ✅ Optimistic revocation | Update UI before API confirms | Instant feedback for destructive actions | Must handle rollback on API failure |
| ❌ Pessimistic revocation | Wait for API before UI update | Simpler error handling | User sees delay, may double-click |

### Deep Trade-off: Polling vs WebSocket for Dashboard Metrics

> **Decision: 5-second polling over WebSocket for metrics updates**
>
> "I chose polling because the dashboard has a well-defined tolerance for staleness — operators reviewing trends and health status don't need sub-second updates. A 5-second polling interval means the data is at most 5 seconds behind reality, which is acceptable for a monitoring dashboard that displays time-series data already averaged over intervals.
>
> WebSocket would have reduced latency to near-instant, but introduces significant complexity: I need heartbeat mechanisms to detect stale connections, exponential backoff reconnection when the admin's laptop wakes from sleep, state synchronization to handle what happens when the client misses updates during a disconnect, and multiplexing logic if I want metrics and alerts on the same connection. Each of these is a potential bug surface.
>
> The trade-off is that during an acute incident where metrics are changing rapidly, operators see data that is up to 5 seconds old. For critical alerts — circuit breaker trips, server failures — I would add a separate lightweight WebSocket channel specifically for push notifications. This gives the best of both worlds: simple polling for the data that tolerates delay, and push for the events that demand immediacy."

### Deep Trade-off: Recharts vs D3 for Traffic Visualization

> **Decision: Recharts over D3 for the traffic area chart**
>
> "I chose Recharts because it operates within React's component model — the chart is a composition of React components (AreaChart, XAxis, Tooltip) that re-render efficiently when their data props change. With D3, I would need to manage a separate imperative rendering lifecycle that fights React's declarative updates: refs to DOM elements, useEffect hooks to synchronize D3 mutations with React state, and careful cleanup to avoid memory leaks.
>
> The cost is customization ceiling. Recharts provides good defaults for standard chart types, but if we needed custom interactions — dragging to zoom into a time range, overlaying deployment markers on the timeline, or rendering a heatmap of error rates — D3 gives full pixel-level control. For a standard area chart with tooltip and responsive sizing, Recharts delivers in hours what D3 would take days to build and maintain.
>
> If the dashboard evolves to need advanced visualizations, I would incrementally introduce D3 for those specific charts while keeping Recharts for the standard ones, rather than migrating everything."

---

## 🧭 Making the Actions Panel Safe

The dashboard exposes destructive controls — Clear Cache, Reset Metrics — alongside read-only ones, and they run against the live system with no confirmation step.

That's a deliberate simplification with a real edge. "Clear Cache" on a production API tier is a thundering-herd trigger: every subsequent read misses, and the database absorbs the full uncached load at once. It is a one-click action sitting directly beside a harmless "Fetch Resources" button, distinguished only by colour.

| Guard | Protects against | Cost |
|-------|------------------|------|
| ✅ Colour + grouping (current) | Nothing, really — it's a hint | Free |
| Confirmation dialog | The misclick | One extra step on a rarely-used control |
| Typed confirmation | Misclick *and* muscle memory | Annoying enough that people script around it |
| Role gating | The wrong person entirely | Needs a permission model this project doesn't have |

> "I'd add the confirmation and stop there. The typed-confirmation pattern is right for irreversible things — dropping a database — and cache clearing isn't irreversible, it's just briefly expensive. Matching the friction to the actual blast radius matters, because a guard that's disproportionate is a guard people route around, and then you've spent the annoyance and bought nothing."

The related gap is that these actions have no visible consequence beyond a toast. Clearing the cache should visibly drive hit rate to zero and then watch it climb back — which the panel is well positioned to show, since it already renders hit rate live. Making an action's *effect* observable in the same view is what turns a control panel into a teaching tool rather than a set of buttons that report success.

> "The through-line for this whole UI: it is the only window onto a system whose defining property — that three instances behave identically — is invisible by construction. Every panel earns its place by making one otherwise-unobservable thing visible, and the ones that don't are just decoration."

## 🚀 Future Improvements

1. **WebSocket channel for critical alerts** — Push circuit breaker trips, server failures, and rate limit threshold crossings immediately rather than waiting for the next poll cycle
2. **Custom dashboard layouts** — Let operators drag and rearrange widgets, save layout preferences per user in the backend, and support multiple dashboard configurations for different on-call roles
3. **Saved filter presets for log explorer** — Allow operators to save common filter combinations ("5xx errors in the last hour", "slow POST requests") and share them with the team
4. **Deployment annotations on traffic charts** — Mark deployment timestamps on the time-series chart so operators can visually correlate traffic changes with releases
5. **Keyboard shortcuts** — Quick navigation between dashboard sections (D for dashboard, K for keys, L for logs) and action shortcuts (R to refresh, F to focus search) for power users during incidents
6. **Virtual scrolling for request logs** — When the log explorer grows beyond hundreds of visible rows, use TanStack Virtual to render only the rows in the viewport, preventing DOM bloat and scroll jank
