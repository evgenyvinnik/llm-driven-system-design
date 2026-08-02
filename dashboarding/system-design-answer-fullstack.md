# Dashboarding System (Metrics Monitoring) - System Design Answer (Fullstack Focus)

## 45-minute system design interview format - Fullstack Engineer Position

---

## Introduction

"Today I'll design a metrics monitoring and visualization system similar to Datadog or Grafana. This system collects time-series metrics from servers, stores them efficiently, and provides real-time dashboards and alerting. As a fullstack engineer, I'll focus on the boundary between a stable dashboard shell, independently owned panel plugins, a coordinated data API, and the time-series backend."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the core end-to-end functionality:

1. **Metrics Ingestion**: Agents push metrics to API, stored in time-series database
2. **Dashboard Viewing**: Frontend queries backend, renders charts with auto-refresh
3. **Dashboard Editing**: Drag-and-drop UI, changes persist to backend
4. **Alert Configuration**: Create rules in UI, backend evaluates and sends notifications
    5. **Time Range Selection**: Frontend controls time range, backend queries appropriate tables
    6. **Panel Extensibility**: Domain teams can ship panel families without coupling every release to the shell
    7. **Data Authorization**: Backend enforces tenant and metric access for every panel query"

### Non-Functional Requirements

"For a fullstack monitoring system:

- **End-to-End Latency**: User action to UI update < 200ms
- **API Contract Stability**: Breaking changes require versioning
- **Type Safety**: Shared types between frontend and backend
    - **Real-Time Feel**: 10-second refresh without flicker
    - **Failure Isolation**: One panel or plugin failure does not hide healthy panels"

---

## Step 2: API Contract and Shared Types

### Shared Type Definitions

Types shared by frontend and backend include:

**Metrics Types**: MetricPoint (name, value, tags, timestamp), MetricDataPoint (time, value), QueryParams (query, start, end, aggregation, step, tags), QueryResult (data array, meta with table/resolution/cached)

**Dashboard Types**: Dashboard (id, name, description, ownerId, panels, layout, timestamps), Panel (id, dashboardId, title, type, query, options, position), PanelType ('line' | 'area' | 'bar' | 'gauge' | 'stat'), Position (x, y, w, h), PanelLayout (i, x, y, w, h), PanelPluginDescriptor (id, version, renderer, editor, requiredCapabilities)

**Alert Types**: AlertRule (id, name, query, condition, threshold, duration, severity, enabled, notification), AlertCondition ('gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'), AlertSeverity ('info' | 'warning' | 'critical'), AlertEvent (id, ruleId, status, value, triggeredAt, resolvedAt)

**API Response Types**: ApiResponse<T> with data and optional meta (total, page, pageSize), BatchPanelResult keyed by panel ID with results or a panel-level error, ApiError with error, code, and details

### Zod Validation Schemas

Validation schemas used by both frontend and backend:

- **MetricPointSchema**: Validates name (regex pattern), value (finite number), tags (optional record), timestamp (optional positive integer)
- **QueryParamsSchema**: Validates query, start/end (datetime with refinement that start < end), aggregation, step, tags
- **CreatePanelSchema**: Validates title, type, query, options (unit, color, showLegend, thresholds, calculation, min/max), position (x, y, w, h with constraints)
- **CreateAlertRuleSchema**: Validates name, query, condition, threshold, duration (regex for interval), severity, notification

---

## Step 3: End-to-End Data Flow

### Dashboard Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Dashboard View Flow                                 │
└─────────────────────────────────────────────────────────────────────────────┘

  1. User navigates to /dashboard/:id

  ┌──────────────────────┐
  │   Frontend Router    │
  │   (TanStack Router)  │
  └──────────┬───────────┘
             │ Route match → dashboardStore.fetchDashboard(id)
             ▼
  ┌──────────────────────┐      GET /api/v1/dashboards/:id
  │   API Client         │─────────────────────────────────────────┐
  │   (fetch wrapper)    │                                         │
  └──────────┬───────────┘                                         ▼
             │                                          ┌──────────────────────┐
             │                                          │   API Server         │
             │                                          │   (Express)          │
             │                                          └──────────┬───────────┘
             │                                                     │
             │                                                     ▼
             │                                          ┌──────────────────────┐
             │                                          │   PostgreSQL         │
             │                                          │   SELECT dashboard,  │
             │                                          │   panels JOIN        │
             │                                          └──────────┬───────────┘
             │                                                     │
  ┌──────────▼───────────┐      { dashboard, panels }              │
  │   Zustand Store      │◄────────────────────────────────────────┘
  │   (dashboardStore)   │
  └──────────┬───────────┘
             │ State update triggers shell render
             ▼
  ┌──────────────────────┐
  │   DashboardGrid      │  Registers panels with coordinator:
  │   Component          │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐      POST /api/v1/dashboards/:id/data
  │ Data Coordinator     │─────────────────────────────────────────┐
  │ batch · dedupe       │                                         │
  │ refresh · cancel     │                                         ▼
  └──────────┬───────────┘                              ┌──────────────────────┐
             │                                          │   Query Service      │
             │                                          │   - Cache check      │
             │                                          │   - Table selection  │
             │                                          │   - Query execution  │
             │                                          └──────────┬───────────┘
             │                                                     │
             │                                                     ▼
             │                                          ┌──────────────────────┐
             │                                          │   TimescaleDB        │
             │                                          │   - metrics_raw      │
             │                                          │   - metrics_1min     │
             │                                          │   - metrics_1hour    │
             │                                          └──────────┬───────────┘
             │                                                     │
  ┌──────────▼───────────┐      { panels: { id: result } }          │
  │   Chart Component    │◄────────────────────────────────────────┘
  │   (Recharts)         │
  └──────────────────────┘

  2. Auto-refresh every 10 seconds in one dashboard coordinator; results fan out to panels
```

### Panel Ownership and Data Coordination

The frontend keeps the panel renderer boundary independent from the data boundary. The shell resolves a panel type through a versioned registry, while the coordinator collects all visible panel query plans and sends one dashboard-scoped batch request. The backend authorizes the dashboard and each query, then returns an independent result for every panel. A slow or forbidden panel therefore becomes a panel state instead of a dashboard-wide failure.

Trusted first-party panel families can be delivered as same-origin remotes or Module Federation modules. I would use a sandboxed iframe only for untrusted extensions or cases requiring a separate origin and CSP. The iframe decision is a security boundary, not a substitute for backend authorization.

### Panel Update Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Panel Edit Flow                                     │
└─────────────────────────────────────────────────────────────────────────────┘

  1. User drags panel to new position

  ┌──────────────────────┐
  │   react-grid-layout  │
  │   onLayoutChange     │
  └──────────┬───────────┘
             │ Debounced callback (500ms)
             ▼
  ┌──────────────────────┐
  │   dashboardStore     │
  │   updateLayout()     │
  │   - Immediate local  │
  └──────────┬───────────┘
             │
             ├──► Optimistic UI update (instant feedback)
             │
             ▼
  ┌──────────────────────┐      PUT /api/v1/dashboards/:id
  │   API Client         │─────────────────────────────────────────┐
  │   (async, fire once) │                                         │
  └──────────────────────┘                                         ▼
                                                        ┌──────────────────────┐
                                                        │   API Server         │
                                                        │   - Validate layout  │
                                                        │   - Check ownership  │
                                                        └──────────┬───────────┘
                                                                   │
                                                                   ▼
                                                        ┌──────────────────────┐
                                                        │   PostgreSQL         │
                                                        │   UPDATE panels      │
                                                        │   SET position = ... │
                                                        └──────────┬───────────┘
                                                                   │
                                                                   │ 200 OK
                                                                   ▼
                                                        ┌──────────────────────┐
                                                        │   Cache Invalidation │
                                                        │   DEL cache:dash:id  │
                                                        └──────────────────────┘

  Success: No visible change (already updated optimistically)
  Failure: Show error toast, optionally revert to server state
```

---

## Step 4: API Layer Implementation

### Backend API Routes

**Dashboard Routes (Express)**:
- `GET /dashboards` - List dashboards for authenticated user
- `GET /dashboards/:id` - Get single dashboard with panels (checks ownership or public access)
- `POST /dashboards/:id/data` - Batch data for authorized panel IDs with independent panel results
- `POST /dashboards` - Create dashboard with name/description
- `PUT /dashboards/:id` - Update dashboard (requires owner or admin), validates layout schema, invalidates cache
- `POST /dashboards/:id/panels` - Add panel to dashboard using CreatePanelSchema validation

All routes use `requireAuth` middleware and return `ApiResponse<T>` format with proper error responses.

### Frontend API Client

API client class wrapping fetch with:
- Consistent request method handling (method, path, body)
- Session cookie credentials
- Error parsing to ApiError type
- Methods: getDashboards, getDashboard, createDashboard, updateDashboard, deleteDashboard
- Panel methods: addPanel, updatePanel, deletePanel
- Query methods: executeQuery
- Plugin methods: getApprovedPanelManifest, validatePluginCapabilities
- Alert methods: getAlertRules, createAlertRule, updateAlertRule, deleteAlertRule, getAlertHistory, evaluateAlertRule
- Metric methods: ingestMetrics, listMetrics, getMetricTags

---

## Step 5: Query Service with Table Routing

### Backend Query Service

The QueryService handles metric queries with automatic table selection and caching:

**execute(params)** workflow:
1. Parse start/end dates
2. Generate cache key (hash of normalized params)
3. Check Redis cache, return if hit
4. Select appropriate table based on time range
5. Execute query with circuit breaker protection
6. Cache result (shorter TTL for live data: 10s vs 300s for historical)

**selectTable(start, end)** logic:
- Range <= 1 hour → metrics_raw (1 second resolution)
- Range <= 24 hours → metrics_1min (1 minute resolution)
- Range > 24 hours → metrics_1hour (1 hour resolution)

**executeQuery** builds SQL with:
- time_bucket for aggregation
- JOIN with metric_definitions
- Optional tag filtering with JSONB @> operator
- GROUP BY and ORDER BY time

**generateCacheKey** normalizes query params (lowercase, round timestamps to 10s) and hashes with SHA-256.

---

## Step 6: Alert System End-to-End

### Backend Alert Evaluator

**evaluateAll()**: Runs every 10 seconds, queries all enabled alert rules, evaluates each.

**evaluateRule(rule)** workflow:
1. Query recent data based on rule.duration
2. Get latest value from result
3. Check if condition is met (gt, gte, lt, lte, eq, ne)
4. Track state in Redis (firstTriggered, currentValue, firing)
5. If condition met for duration → fire alert
6. If condition not met and was firing → resolve alert

**fireAlert(rule, value)**:
1. Mark as firing in Redis
2. Insert alert_event with status='firing'
3. Send notification via notificationService

**resolveAlert(rule)**:
1. Update alert_events to status='resolved', set resolved_at
2. Clear Redis state

### Frontend Alert Hook

useAlerts hook provides:
- State: rules, events, loading, error
- Actions: createRule, updateRule, deleteRule, evaluateRule, refetch
- Auto-polling every 30 seconds for fresh data
- Optimistic updates with error rollback

---

## Step 7: Database Schema

**TimescaleDB Schema**:

- **users**: id, email, password_hash, role, created_at
- **metric_definitions**: id, name (unique), description, unit, type, created_at (indexed by name)
- **metrics_raw**: hypertable with time, metric_id, value, tags (JSONB). Indexed on (metric_id, time DESC) and tags with GIN.

**Continuous Aggregates**:
- **metrics_1min**: bucket, metric_id, tags, avg_value, min_value, max_value, sample_count. Policy: 1 hour offset, 1 minute schedule.
- **metrics_1hour**: Same structure, built from metrics_1min. Policy: 1 day offset, 1 hour schedule.

**Retention Policies**: metrics_raw (7 days), metrics_1min (30 days), metrics_1hour (365 days)

**Dashboard/Panel Tables**:
- **dashboards**: id (UUID), name, description, owner_id, is_public, layout (JSONB), timestamps
- **panels**: id (UUID), dashboard_id (FK with CASCADE), title, type, query, options (JSONB), position (JSONB), timestamps

**Alert Tables**:
- **alert_rules**: id (UUID), name, query, condition, threshold, duration (INTERVAL), severity, enabled, notification (JSONB), timestamps
- **alert_events**: id (UUID), rule_id (FK), status, value, triggered_at, resolved_at. Indexed on (rule_id, triggered_at DESC).

---

## Step 8: Real-Time Data Synchronization

### Polling with Optimistic Updates

**Dashboard Data Coordinator Pattern**:
- Collect visible panel query plans and normalize them
- Deduplicate equivalent queries and send one dashboard-scoped batch request
- Keep prior successful results while a refresh is in flight
- Cancel obsolete requests when the time range changes
- Return panel-level loading, stale, empty, forbidden, and error states
- Refresh visible panels first, pause hidden tabs, and add jitter to avoid synchronized bursts

**Dashboard Layout Pattern**:
- Local state update immediate via updateLayout()
- Debounced save to server (500ms)
- On failure: show toast, optionally revert

**Alert Toggle Pattern**:
- Optimistic local state change
- Async API call
- Revert and show error toast on failure

### Cache Invalidation Pattern

**Backend**: On dashboard/panel update, DEL cache:dashboard:{id} in Redis.

**Frontend**: Zustand store updates local state after mutation. Query cache is time-based, no explicit invalidation needed.

---

## Step 9: Error Handling Across the Stack

### Backend Error Handling

Express error middleware handles:
- **ZodError**: 400 with VALIDATION_ERROR code and field details
- **NotFoundError**: 404 with NOT_FOUND code
- **UnauthorizedError**: 401 with UNAUTHORIZED code
- **ForbiddenError**: 403 with FORBIDDEN code
- **Unique constraint violations**: 409 with CONFLICT code
- **Generic errors**: 500 with INTERNAL_ERROR code

### Frontend Error Handling

**Panel Error Boundary**: Catches a plugin renderer error and replaces only that panel with a retryable fallback. The event includes panel ID and plugin version for diagnostics.

**Coordinator Error Handling**: Keeps stale data visible during refresh, validates each panel result, and exposes partial failures without replacing successful sibling panels.

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Type Sharing | Shared TypeScript types | OpenAPI codegen | Simpler for monorepo, direct imports |
| Validation | Zod (both ends) | Joi, Yup | Type inference, same library both ends |
| Real-time Updates | Polling | WebSocket | Simpler, caching-friendly, sufficient for 10s refresh |
| State Management | Zustand | Redux, Context | Lightweight, TypeScript support |
| Error Handling | Error boundaries + try/catch | Global error store | React-native pattern, localized recovery |
| Cache Strategy | Redis + short TTL | Stale-while-revalidate | Backend-controlled freshness |
| Panel architecture | Versioned plugin registry | One giant SPA | Independent domain ownership and deployment |
| Panel transport | Dashboard batch endpoint | One request per panel | Deduplication, cancellation, and partial failure semantics |
| Untrusted extensions | Sandboxed iframe | Same-origin remote | Hard origin, CSP, and dependency isolation |

---

## Summary

"To summarize the fullstack architecture for this dashboarding system:

1. **Shared Types**: TypeScript interfaces and Zod schemas used by both frontend and backend ensure type safety across the stack

2. **API Contract**: RESTful endpoints with consistent response format, validation errors include field-level details

    3. **Data Flow**: A frontend coordinator batches and deduplicates panel queries every 10 seconds, while the backend routes each query to appropriate TimescaleDB tables based on time range

4. **State Management**: Zustand stores on frontend mirror backend data, optimistic updates provide instant feedback

    5. **Error Handling**: Zod validation on both ends, panel-level error boundaries, partial batch results, and consistent error response format

Key fullstack insights:
- Shared types prevent drift between frontend and backend
- Plugin contracts let domain teams ship panels without shell-wide releases
- Coordinated data access avoids a polling thundering herd
- Optimistic updates + debounced saves provide responsive UX
- Table routing (raw vs. aggregated) is transparent to frontend
- Cache invalidation is time-based for simplicity

What aspect would you like me to elaborate on?"
