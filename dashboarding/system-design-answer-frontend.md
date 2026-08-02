# Dashboarding System (Metrics Monitoring) - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

## Introduction

“I’ll design the frontend for a metrics monitoring product similar to Datadog or Grafana. The important frontend problem is not drawing a line chart. It is allowing many teams to own different panels while keeping the dashboard responsive, secure, observable, and resilient when one panel is slow or broken.”

I will use a dashboard shell with a versioned panel plugin contract. A centralized data coordinator will schedule panel queries. The default deployment model is same-origin plugins or Module Federation for independently shipped panel families. I will reserve iframes for untrusted or hard-isolation extensions rather than placing every chart in its own iframe.

### RADIO Map

| Stage | Dashboard focus |
|---|---|
| **R — Requirements** | Operator workflows, ownership, responsiveness, accessibility, and permissions |
| **A — Architecture** | Shell, registry, panel runtime, coordinator, and server boundary |
| **D — Data model** | Dashboard configuration, panel state, query plans, and client-only UI state |
| **I — Interfaces** | Shell-to-plugin capability contract and browser-to-server dashboard APIs |
| **O — Optimizations** | Render isolation, query coordination, caching, large-dashboard rendering, and rollout |

## R — Requirements

### Functional Requirements

I want to confirm these requirements before choosing boundaries:

1. Users can view dashboards containing many panels.
2. Users can create, edit, resize, reorder, duplicate, and delete panels.
3. Panels can render time series, gauges, stat values, tables, and future visualization types.
4. Users can select a shared time range and refresh policy.
5. The dashboard can show loading, stale, empty, permission-denied, and error states per panel.
6. Users can explore metrics and configure alert rules.
7. Different product teams can ship panel types without rebuilding the entire shell.
8. Panel data access is controlled by the backend, not by frontend visibility alone.

### Non-Functional Requirements

At production scale I would target:

- 20–50 panels per dashboard without blocking input or causing full-page re-renders.
- Sub-100ms interaction feedback for layout changes and filter changes.
- A refresh cycle that does not create one timer and one request pipeline per panel.
- Independent failure containment: one panel cannot crash the shell or hide healthy panels.
- Keyboard and screen-reader support for dashboard navigation, editing, and panel status.
- Strong tenant and metric authorization, including safe behavior for shared dashboards.
- Versioned plugin APIs, rollback support, and telemetry for load, query, and render failures.

### Scope Boundaries

The backend owns metric authorization, query execution, aggregation, retention, and alert evaluation. The frontend owns composition, layout, rendering, scheduling, caching of view state, and user feedback. A plugin can request data through a capability API, but it cannot make the browser’s authorization decision.

### Clarifying Questions and Assumptions

I would confirm whether we are designing an operator-facing desktop product, whether dashboards are mostly read-only during incidents, and whether third-party panel code is in scope. I would also ask whether the priority is sub-second streaming or a 10-second freshness target, how many panels are typical, and whether users can edit the same dashboard concurrently.

For this answer, I assume 20–50 panels, desktop-first use with tablet fallback, 10-second freshness for most metrics, first-party panels owned by several teams, and optional third-party extensions. Dashboard viewing, time-range changes, and panel configuration are in scope; offline editing and arbitrary customer code are follow-up scope.

## A — Architecture

### Capacity and Rendering Constraints

Assume 100,000 daily active users, 10,000 concurrent dashboard viewers, and 20 panels on an average dashboard. If every panel polls independently every 10 seconds, one dashboard produces 120 panel requests per minute. At 10,000 viewers, that is 20,000 requests per second before accounting for retries, duplicated queries, or multiple tabs.

The browser should therefore treat a dashboard refresh as one coordinated operation. The coordinator sends one dashboard-scoped batch request, deduplicates identical query plans, limits concurrency, and distributes partial results to panels. The server can then share Redis and time-series query caches across users.

The frontend also has a rendering budget. A chart should not render every raw point if the viewport cannot display it. The query contract should return an appropriate bucket size, and the renderer should preserve extrema when it downsamples locally. Historical ranges can use coarser server-side rollups; recent ranges can use finer buckets.

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Dashboard Shell                                                             │
│ Routing · auth context · layout · time range · accessibility · telemetry   │
├───────────────────────────────┬─────────────────────────────────────────────┤
│ Panel Registry                 │ Dashboard Data Coordinator                  │
│ versioned plugin metadata      │ batch · dedupe · cache · refresh · cancel    │
├───────────────────────────────┴─────────────────────────────────────────────┤
│ Panel Runtime                                                               │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────────────┐ │
│ │ Metrics      │ │ Billing      │ │ Tracing      │ │ Third-party iframe  │ │
│ │ plugin       │ │ plugin       │ │ plugin       │ │ (optional boundary) │ │
│ └──────────────┘ └──────────────┘ └──────────────┘ └─────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│ Server API boundary · authorization · dashboard data · plugin manifests     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Shell Responsibilities

The shell is deliberately boring and stable. It owns:

- Routing, dashboard loading, authentication context, and tenant context.
- Grid layout, responsive breakpoints, edit mode, and persistence of layout changes.
- Global time range, refresh policy, page visibility, and manual refresh.
- The panel registry, plugin lifecycle, capability API, and compatibility checks.
- Error boundaries, loading placeholders, stale-data indicators, and retry actions.
- Telemetry such as plugin load time, query latency, render duration, and failures.

The shell does not know how a CPU chart calculates a y-axis or how a billing panel formats currency. That knowledge belongs to the plugin.

### Panel Registry

The registry maps a stable panel type to a plugin descriptor. A descriptor contains:

| Field | Responsibility |
|---|---|
| `id` and `version` | Stable identity and compatibility negotiation |
| `renderer` | Visualization mounted inside the panel boundary |
| `editor` | Configuration UI used in dashboard edit mode |
| `queryBuilder` | Converts configuration into a normalized query plan |
| `requiredCapabilities` | Declares data and actions the plugin needs |
| `metadata` | Display name, icon, minimum size, and accessibility label |
| `health` | Optional readiness and diagnostics hooks |

The registry is an indirection point, not a security boundary. The shell filters what it can display, but the backend validates every query and capability request.

### Ownership and Deployment

I would assign ownership by domain rather than by chart shape:

- The observability team owns CPU, memory, latency, and log-volume panels.
- The billing team owns cost and quota panels.
- The security team owns audit and threat panels.
- The platform team owns the shell, registry contract, data coordinator, and design system.

For a same-origin first-party plugin, Module Federation or an equivalent remote-module system lets a team deploy a compatible panel bundle independently. The shell pins an approved version, performs a manifest and contract check, and supports rollback to the previous known-good version.

I would usually ship a family of related panels as one remote, not one remote for every chart. That preserves team autonomy without creating dozens of independent runtimes.

### Plugin Runtime Contract

### Renderer Lifecycle

The shell mounts a panel in these stages:

1. Read the persisted panel configuration and plugin identifier.
2. Resolve the plugin from the local registry or approved remote manifest.
3. Check compatibility with the shell runtime and required capabilities.
4. Ask the data coordinator for the panel’s normalized data snapshot.
5. Mount the renderer inside a panel-level error boundary.
6. Send updated snapshots without remounting the plugin when possible.
7. Unmount and release subscriptions when the panel leaves the viewport.

The plugin receives panel configuration, dimensions, locale, theme, user capability context, and a data snapshot. It should not receive database credentials or construct arbitrary cross-tenant URLs.

### Configuration and Query Ownership

The editor owns user-facing configuration. The query builder converts that configuration into a normalized query plan containing metric identity, filters, aggregation, grouping, time range, and desired resolution. The coordinator canonicalizes the plan before deduplication.

This avoids a common failure mode where two panels request the same metric with different JSON property ordering and miss the cache. It also gives the backend one stable shape to validate and authorize.

### Dashboard Data Coordinator

### Why Coordination Matters

Independent panel hooks are simple, but they multiply timers, duplicate requests, and create unpredictable completion order. A global coordinator gives the dashboard one refresh clock and lets us make deliberate decisions about priority.

The coordinator performs the following work:

1. Collect visible and prefetchable panel query plans.
2. Normalize and deduplicate equivalent plans.
3. Read fresh data from a client cache when allowed.
4. Send a dashboard-scoped batch request to the backend.
5. Apply concurrency limits and cancellation when the time range changes.
6. Preserve the last successful snapshot while a refresh is in flight.
7. Return independent success, empty, stale, forbidden, and error states.
8. Notify only the panels whose data changed.

The batch response is keyed by panel ID or query ID. A panel failure should not turn the whole response into a failure. The coordinator also records partial failure rate so a dashboard that is technically rendering but mostly stale is visible to operators.

### Refresh Scheduling

Refresh is adaptive rather than a blind interval:

- Pause or slow refresh for a hidden browser tab.
- Refresh visible panels first and prefetch below-the-fold panels afterward.
- Apply jitter so thousands of tabs do not refresh on the same second.
- Back off after repeated failures and expose a stale timestamp.
- Abort an in-flight request when the user changes the time range.
- Use push updates for high-priority use cases later without changing the panel contract.

Polling is a reasonable local default because it is cacheable and operationally simple. The coordinator keeps the transport replaceable so WebSockets or server-sent events can be introduced for selected panel families.

### Cache Semantics

The client cache key includes tenant, dashboard permissions, normalized query, time range, resolution, and plugin-independent data version. Recent data has a short freshness window. Historical data can be reused longer because it is effectively immutable.

The cache must never be used to bypass authorization. A shared browser cache should be partitioned by tenant and user capability context, and sensitive panels should opt out of persistence.

## D — Frontend Data Model

The model separates data received from the server from persisted dashboard configuration and short-lived browser state. That keeps the plugin runtime declarative: renderers consume a panel snapshot rather than owning a hidden network cache.

| Source | Entity | Owner | Important fields |
|---|---|---|---|
| Server | Dashboard | Shell/store | `id`, `name`, `permissions`, `layoutVersion`, `panels` |
| Server | Panel configuration | Registry + editor | `id`, `pluginId`, `pluginVersion`, `queryConfig`, `displayConfig`, `position` |
| Derived | Query plan | Data coordinator | normalized metric selector, filters, aggregation, range, resolution, capability scope |
| Server | Panel snapshot | Data coordinator | `results`, `fetchedAt`, `staleAt`, `status`, `error` |
| Client persisted | View preferences | Shell/store | selected range, refresh preference, collapsed navigation, theme |
| Client ephemeral | Interaction state | Local component | drag preview, editor draft, focus target, tooltip, retrying state |

The panel configuration is persisted with a `layoutVersion`, so a debounced layout save can use optimistic concurrency. The snapshot is not persisted in the dashboard store: it is cacheable server state whose lifecycle belongs to the coordinator.

### State and Render Lifecycle

I would separate state into three layers:

| Layer | Examples | Owner |
|---|---|---|
| URL state | dashboard ID, time range, selected variable | Router |
| Dashboard state | panel configuration, layout, edit mode | Shell/store |
| Server state | panel snapshots, freshness, errors, request status | Data coordinator |

Zustand is sufficient for local shell state. For a larger product, a server-state library can provide request deduplication, invalidation, retries, and focus-aware refetching. I would not put every data point into a global store; panel snapshots should be scoped and structurally shared.

The grid should virtualize or otherwise defer panels that are outside the viewport when dashboards become large. Layout changes update local state immediately and persist through a debounced mutation with a version number. A conflict response triggers a merge or asks the user to reload rather than silently overwriting another editor.

### Cross-Cutting Runtime Concerns

### Failure Isolation and Observability

Each panel has at least three independent boundaries:

1. **Network boundary:** request timeout, retry policy, cancellation, and stale fallback.
2. **Data boundary:** schema validation, empty-state handling, and forbidden-state handling.
3. **Render boundary:** an error boundary around the plugin renderer.

If a chart throws during rendering, the shell replaces only that panel with a retryable fallback. The error event includes dashboard ID, panel ID, plugin version, query fingerprint, and browser context, but not raw sensitive metric values.

The frontend should emit:

- Plugin manifest load success, failure, and duration.
- Time to first panel and time to usable dashboard.
- Query batch size, deduplication ratio, cache hit rate, and partial failures.
- Render duration and long-task count by plugin type.
- Stale age, forbidden panel count, and retry rate.

This makes the dashboard observable as a product, not just a collection of charts.

### Authorization and Security

A frontend plugin cannot safely enforce data access by itself. The backend must authorize the dashboard, panel, tenant, metric, tags, and requested time range. The browser can use capability metadata to hide unavailable editors and avoid unnecessary requests, but a malicious user can still modify JavaScript and network calls.

For first-party plugins:

- Use same-origin or an allowlisted remote origin.
- Verify signed manifests or deploy through a trusted artifact pipeline.
- Restrict plugin capabilities to the minimum required scope.
- Validate configuration and query plans at the API boundary.
- Include tenant and permission context in cache isolation.
- Apply CSP, Trusted Types where feasible, and dependency scanning.

For third-party or untrusted plugins, use an iframe with a narrow `postMessage` protocol, sandbox attributes, a separate origin, and a per-plugin CSP. The host should validate message schemas, enforce request quotas, and never pass raw session tokens into the frame.

### Responsive Design and Accessibility

The shell defines responsive layout behavior; plugins receive the available size and must support a minimum render size. A narrow viewport may collapse a multi-column dashboard into a single column while retaining panel order and heading hierarchy.

Charts need accessible alternatives. Each renderer should expose a text summary or data table, announce meaningful status changes, and avoid relying on color alone for thresholds. Keyboard users must be able to move through panels, enter edit mode, resize or reorder with an alternate control, and reach retry and configuration actions.

Loading and stale states should be announced politely rather than on every polling tick. Focus must remain stable when a panel refreshes.

## I — Interface Definitions

The browser-facing server contract should be dashboard-scoped for coordinated reads:

```
GET  /api/v1/dashboards                         → list accessible dashboards
GET  /api/v1/dashboards/:id                     → dashboard metadata and panel configs
POST /api/v1/dashboards/:id/data                → batch data for authorized panel IDs
POST /api/v1/dashboards/:id/panels               → create a panel configuration
PUT  /api/v1/dashboards/:id/panels/:panelId     → update configuration or layout
DELETE /api/v1/dashboards/:id/panels/:panelId   → remove a panel
GET  /api/v1/panel-plugins/manifest             → approved plugin metadata and versions
```

The batch endpoint returns a result per requested panel. Each result can be successful, empty, stale, forbidden, or failed. A response-level error is reserved for a dashboard-level authorization or availability failure.

The frontend API client owns serialization and cancellation. Plugins use a capability API rather than importing the raw fetch client, which prevents every remote from inventing a different retry, authentication, or telemetry policy.

### Shell-to-Plugin Interfaces

| Interface | Inputs | Output or event | Why it exists |
|---|---|---|---|
| Plugin renderer | panel configuration, dimensions, theme, data snapshot | rendered panel | Separates rendering from fetching |
| Panel editor | current configuration, available metrics, user capabilities | validated configuration change | Keeps configuration ownership with the plugin |
| Query builder | configuration, shared time range, variables | normalized query plan | Allows deduplication and server validation |
| Capability API | declared scope, query plan, cancellation signal | authorized snapshot or typed error | Prevents direct ad hoc fetch behavior |
| Shell event channel | panel ID, event name, payload | telemetry, resize, retry, edit request | Keeps plugins decoupled from shell internals |

The shell validates plugin events and configuration at its boundary. The server independently validates the resulting query, so a remote plugin cannot obtain data just by claiming a broader capability.

## O — Optimizations and Deep Dives

### Deep Dive 1: Plugin Architecture Versus One SPA

I choose a plugin boundary because panel teams need independent ownership and deployment. A single SPA gives excellent shared-memory performance and the simplest debugging model, but every chart imports the same dependency graph and ships on the shell’s release train. Over time, team boundaries become implicit and a new panel can destabilize the entire dashboard.

Module Federation or a versioned plugin runtime addresses that organizational bottleneck. A team can ship a panel family independently, use a specialized visualization library, and roll back its remote without rebuilding the shell. The shell still provides shared layout, data access, telemetry, and error handling.

The cost is runtime compatibility. Remote modules can break because of React, design-system, or contract version mismatches. I mitigate that with a small stable contract, shared dependency policy, manifest validation, canary loading, and a fallback renderer. I would not split every chart into a separately deployed remote because the operational overhead would exceed the benefit.

### Deep Dive 2: Module Federation Versus Iframes

Iframes provide the strongest browser isolation. A bad or untrusted plugin cannot directly corrupt the shell’s DOM, CSS, JavaScript heap, or dependency graph. They also support separate CSPs, origins, and deployment pipelines. This is the right choice for customer-supplied extensions, plugins owned by unrelated security domains, or content that must be treated as untrusted.

I would not make every chart an iframe. Twenty charts would mean twenty document runtimes, duplicated React and chart libraries, separate network lifecycles, expensive memory use, and a large `postMessage` surface. Resizing, focus management, deep links, tooltips, keyboard navigation, and coordinated theming also become harder. A slow frame may be isolated, but the dashboard still pays the resource cost.

Therefore my default is same-origin plugins or Module Federation for trusted first-party panel families. I use iframes selectively when hard isolation is more valuable than shared performance and interaction quality.

### Deep Dive 3: Independent Panel Fetching Versus Coordinated Data

Independent fetching is attractive because each panel is self-contained. It fails at dashboard scale: twenty timers drift, identical queries are duplicated, retries create bursts, and changing a global time range creates a thundering herd. It is also difficult to show whether the dashboard is partially stale.

A coordinator creates one place for scheduling, deduplication, cancellation, cache policy, and partial failure semantics. It can batch requests at the HTTP boundary and later fan out to query workers or use a query plan service. Panels remain independent at the rendering boundary, while the system is coordinated at the data boundary.

The trade-off is a more sophisticated shell and a less autonomous plugin API. A plugin must declare its query needs and accept the coordinator’s lifecycle. That is worthwhile because the coordinator protects the backend and makes the user’s view consistent. For a small dashboard with five panels, independent hooks may be acceptable; I would evolve toward coordination before the product reaches dozens of panels or multiple teams.

### Deep Dive 4: Data Authorization Versus Frontend Isolation

Putting each chart in an iframe does not automatically grant it a safe data boundary. The iframe may still call a backend endpoint that returns data for the wrong tenant, and a same-origin plugin can still be tampered with in the browser. Authorization must happen on the server for every query.

The frontend should still expose capability-scoped APIs because they reduce accidental overreach and make plugin ownership explicit. The backend validates the capability, dashboard membership, metric scope, tag filters, and tenant context. The trade-off is duplicated policy metadata and more contract work, but it gives users fast feedback while preserving real security at the only boundary that can be trusted.

### Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Reasoning |
|---|---|---|---|
| Panel boundary | Versioned plugin contract | One giant SPA | Independent ownership without giving up shell coordination |
| Trusted deployment | Module Federation or same-origin remote | One iframe per chart | Independent releases with lower runtime and interaction cost |
| Untrusted deployment | Sandboxed iframe | Same-origin plugin | Hard DOM, CSP, origin, and dependency isolation |
| Data access | Dashboard data coordinator | One polling hook per panel | Batching, deduplication, cancellation, and consistent freshness |
| Authorization | Backend capability enforcement | Frontend permission checks | Browser code is mutable and cannot be a security boundary |
| Updates | Adaptive polling first | WebSocket everywhere | Simpler operations and cacheability; push can be added selectively |
| State | URL + shell state + server state | All data in global store | Clear ownership and fewer unnecessary re-renders |
| Visualization | Plugin-owned renderer | Shell-owned chart switch | Domain teams can evolve visualizations without shell changes |
| Layout | CSS/grid runtime with virtualization | Render every panel eagerly | Keeps input responsive on large dashboards |

### Rollout and Testing

I would migrate from a monolithic chart switch in stages rather than introducing remote bundles on day one:

1. Define the panel descriptor and capability contract while keeping all renderers in the existing bundle.
2. Move data fetching into the dashboard coordinator and add panel-level error boundaries.
3. Add manifest validation, plugin telemetry, and a compatibility test matrix.
4. Extract one low-risk panel family as a remote and run it behind a feature flag.
5. Add canary rollout, version pinning, automatic fallback, and a kill switch before expanding adoption.

The test strategy follows the boundaries:

- Contract tests validate plugin descriptors, capability declarations, and batch response schemas.
- Coordinator tests cover deduplication, cancellation, stale fallback, retry backoff, and partial failures.
- Renderer tests use fixed snapshots for empty, loading, stale, forbidden, and large-data states.
- Browser tests verify keyboard navigation, layout persistence, focus stability, and a failed panel next to healthy panels.
- Performance tests measure time to first usable panel, long tasks, memory, and batch request reduction.
- Security tests verify that cache keys include tenant context and that plugin messages cannot request undeclared capabilities.

The success metric for the migration is not “we use Module Federation.” It is that teams can release a panel independently while dashboard load time, failure rate, and data authorization remain within the same budgets.

If the interviewer asks what breaks first, I would prioritize three risks. At the browser edge, too many simultaneously rendered panels cause long tasks and memory pressure, so I virtualize and prioritize visible work. At the service edge, synchronized refreshes create query bursts, so I batch, jitter, cache, and back off. At the organization edge, plugin contracts drift between teams, so I version the manifest, keep compatibility tests, and provide a shell-owned fallback.

## Local Implementation Mapping

The current local React + Vite project is the migration starting point rather than the full production architecture:

- `DashboardGrid` and `DashboardPanel` remain shell components.
- The existing type switch and per-panel polling are sufficient for the demo, but do not yet provide plugin or refresh isolation.
- The first local increment is a registry that maps the current line, area, bar, gauge, and stat types to renderers.
- The next increment is a dashboard data hook and batch API that supply independently renderable panel snapshots.
- A panel error boundary is added before loading remote plugins.
- Recharts remains a reasonable local renderer choice, but it is an implementation detail rather than the central architectural decision.
- The local project uses HTTP polling and a single Vite bundle; production can replace the registry loader with approved remote manifests and Module Federation.

I would not add iframes to the local demo merely to demonstrate isolation. The demo should make the boundary explicit in the contract and document when a sandboxed iframe becomes justified.

## Summary

“My final design is a stable dashboard shell around independently owned panel plugins. The shell controls layout, lifecycle, authorization context, refresh scheduling, accessibility, and failure isolation. A dashboard data coordinator batches and deduplicates requests, preserves stale data, and reports partial failures. Trusted first-party panels use a versioned plugin or Module Federation boundary; untrusted extensions use sandboxed iframes. The backend remains the source of truth for data authorization.”

The most important senior-level decisions are:

1. Make ownership and deployment boundaries explicit with a plugin registry.
2. Coordinate data access at dashboard scope instead of polling independently from every chart.
3. Isolate rendering failures at the panel boundary.
4. Treat iframes as a targeted hard-isolation tool, not the default composition model.
5. Keep authorization on the backend and use frontend capabilities for ergonomics, not security.
