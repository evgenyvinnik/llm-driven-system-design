# Web Crawler - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 📋 Introduction (2 minutes)

"Thank you for having me. Today I'll design the frontend for a distributed web crawler dashboard. While crawling is primarily a backend system, the dashboard is critical for operators and presents interesting frontend challenges:

1. **Real-time monitoring** displaying thousands of URLs being crawled per second
2. **Virtualized data tables** handling millions of frontier URLs efficiently
3. **Live statistics visualization** with charts and metrics
4. **Admin controls** for managing seeds, domains, and worker health

The frontend challenge is presenting massive amounts of real-time data without overwhelming users or the browser. Let me clarify the requirements."

---

## 🎯 Requirements Clarification (5 minutes)

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

## 🏗️ High-Level Design (8 minutes)

### Dashboard Layout Architecture

```
+-----------------------------------------------------------------------+
|                        Crawler Dashboard UI                            |
+-----------------------------------------------------------------------+
|  +---------------------------------------------------------------+    |
|  |                    Navigation Bar                              |    |
|  |    Logo  |  Dashboard  |  Frontier  |  Domains  |  Workers    |    |
|  +---------------------------------------------------------------+    |
|                                                                        |
|  +------------------------+   +--------------------------------+       |
|  |    Live Statistics     |   |      Throughput Chart          |       |
|  |  +------+  +------+    |   |                                |       |
|  |  |URLs/s|  |Queue |    |   |    ~~~~~~~~~~~~~~~~~~~~~~~~    |       |
|  |  |10.2K |  | 2.5M |    |   |   Pages/second over time       |       |
|  |  +------+  +------+    |   |                                |       |
|  |  +------+  +------+    |   +--------------------------------+       |
|  |  |Active|  |Failed|    |                                            |
|  |  |  8   |  | 124  |    |   +--------------------------------+       |
|  |  +------+  +------+    |   |      Domain Distribution       |       |
|  +------------------------+   |         [Pie Chart]            |       |
|                               +--------------------------------+       |
|                                                                        |
|  +---------------------------------------------------------------+    |
|  |                    URL Frontier Table                          |    |
|  |  +-----------------------------------------------------------+ |    |
|  |  | Status |   URL                  | Priority | Domain       | |    |
|  |  |---------+------------------------+----------+-------------| |    |
|  |  | * Crawl | https://example.com/  |   High   | example.com  | |    |
|  |  | o Pend  | https://other.com/pg  |   Med    | other.com    | |    |
|  |  | + Done  | https://blog.io/post  |   Low    | blog.io      | |    |
|  |  |   ...virtualized rows (only visible rendered)...          | |    |
|  |  +-----------------------------------------------------------+ |    |
|  +---------------------------------------------------------------+    |
|                                                                        |
+-----------------------------------------------------------------------+
```

### Route Structure

| Route | View | Description |
|-------|------|-------------|
| / | Dashboard | Overview with live stats and charts |
| /frontier | Frontier | Virtualized URL table with filters |
| /domains | Domain List | All domains with status |
| /domains/:domain | Domain Detail | Rate limits, robots.txt, statistics |
| /workers | Workers | Grid of worker cards with health |

---

## 🔍 Deep Dive: Real-Time Statistics Dashboard (10 minutes)

### Why WebSocket over Polling?

| Approach | Pros | Cons |
|----------|------|------|
| **WebSocket** | True real-time (~50ms latency), lower server load (push model), efficient for high-frequency updates | Connection management complexity, must handle reconnection |
| Polling | Simple HTTP, automatic error handling, universal support | 1-2s latency minimum, constant server requests, not true real-time |
| Server-Sent Events | Simpler than WebSocket, auto-reconnect | One-way only, less browser support |

**Decision: WebSocket**

"For a crawl dashboard showing 10K URLs/second, operators need to see changes immediately. Polling at 1-second intervals would miss transient issues. WebSocket gives us true real-time visibility with lower overhead since the server pushes only when data changes."

### WebSocket Statistics Flow

```
+-----------------------------------------------------------------------+
|                    WebSocket Statistics Flow                           |
+-----------------------------------------------------------------------+
|                                                                        |
|    +---------+        +--------------+        +-------------+          |
|    | Backend |------->|  WebSocket   |------->| Stats Store |          |
|    | Server  |        |  Connection  |        |  (Zustand)  |          |
|    +---------+        +--------------+        +-------------+          |
|                             |                       |                  |
|                             |                       v                  |
|                    Auto-reconnect           +-------------+            |
|                    on disconnect            |  Components |            |
|                       (3s delay)            |  Subscribe  |            |
|                             |               +-------------+            |
|                             v                       |                  |
|                    +--------------+                 v                  |
|                    | Reconnection |         +-------------+            |
|                    |   Handler    |         |  Re-render  |            |
|                    +--------------+         |  UI Cards   |            |
|                                             +-------------+            |
|                                                                        |
+-----------------------------------------------------------------------+
```

### Why Zustand over Redux or Context?

| Approach | Pros | Cons |
|----------|------|------|
| **Zustand** | Minimal boilerplate, simple selectors prevent re-renders, built-in subscribe for WebSocket | Smaller ecosystem than Redux |
| Redux Toolkit | Mature ecosystem, Redux DevTools, middleware | More boilerplate, overkill for dashboard |
| React Context | Built-in, no dependencies | Re-renders all consumers on any change |
| TanStack Query | Great for REST APIs, caching, deduplication | Designed for request/response, not WebSocket streams |

**Decision: Zustand**

"The dashboard has a single WebSocket pushing updates every second. Zustand's selector pattern means only the component displaying 'URLs/second' re-renders when that value changes, not the entire dashboard. With Redux, we'd write 3x more code for the same result."

### Live Statistics Grid Design

```
+---------------------------------------------------------------------+
|                     Statistics Cards Grid                            |
+---------------------------------------------------------------------+
|                                                                      |
|   +-----------+  +-----------+  +-----------+  +----------+          |
|   |   URLs/s  |  |Queue Depth|  |   Active  |  |  Failed  |          |
|   |           |  |           |  |  Workers  |  |  Today   |          |
|   |   10.2K   |  |    2.5M   |  |     8     |  |   124    |          |
|   |           |  |           |  |           |  |          |          |
|   |  * Live   |  | (compact) |  |  (count)  |  | (trend)  |          |
|   +-----------+  +-----------+  +-----------+  +----------+          |
|                                                                      |
|   +---------------+  +---------------+  +---------------+            |
|   | High Priority |  |Medium Priority|  |  Low Priority |            |
|   |    +-----+    |  |    +-----+    |  |    +-----+    |            |
|   |    | 125K|    |  |    | 890K|    |  |    | 1.5M|    |            |
|   |    +-----+    |  |    +-----+    |  |    +-----+    |            |
|   |  (red accent) |  |(yellow accent)|  |(green accent) |            |
|   +---------------+  +---------------+  +---------------+            |
|                                                                      |
+---------------------------------------------------------------------+
```

### Number Formatting for Compact Display

| Value Range | Format | Example |
|-------------|--------|---------|
| >= 1B | X.XB | 1.2B |
| >= 1M | X.XM | 2.5M |
| >= 1K | X.XK | 10.2K |
| < 1K | raw number | 892 |

### Why Recharts over D3.js?

| Approach | Pros | Cons |
|----------|------|------|
| **Recharts** | React-native, declarative, built-in responsive | Less customizable than raw D3 |
| D3.js | Ultimate flexibility, any visualization possible | Imperative, fights React's model, steep learning curve |
| Chart.js | Simple API, good defaults | Canvas-based (harder to style), less React-friendly |
| Visx | D3 primitives as React components | More code than Recharts for common charts |

**Decision: Recharts**

"For a throughput line chart, we don't need D3's full power. Recharts gives us responsive, animated charts with 10 lines of JSX. D3 would take 100+ lines and require manual lifecycle management."

---

## 🔍 Deep Dive: Virtualized URL Frontier Table (10 minutes)

### Why Virtual Scrolling is Essential

```
+----------------------------------------------------------------------+
|                 Virtual Scrolling Concept                             |
+----------------------------------------------------------------------+
|                                                                       |
|   Without Virtualization:              With Virtualization:           |
|   +-----------------+                  +-----------------+            |
|   | Row 1 (in DOM)  |                  |                 |            |
|   | Row 2 (in DOM)  |                  |   Empty space   |            |
|   | Row 3 (in DOM)  |                  |  (no DOM nodes) |            |
|   |      ...        |                  |                 |            |
|   | Row 10000       |                  +-----------------+            |
|   | (ALL in DOM!)   |                  | Row 50 (visible)|<--Viewport |
|   |      ...        |                  | Row 51 (visible)|            |
|   | Row 1000000     |                  | Row 52 (visible)|            |
|   +-----------------+                  | Row 53 (visible)|            |
|                                        | Row 54 (visible)|            |
|   Problem:                             +-----------------+            |
|   1M rows x 48px = 48M pixels          |                 |            |
|   1M DOM nodes = browser crash         |   Empty space   |            |
|                                        |  (no DOM nodes) |            |
|   Solution:                            +-----------------+            |
|   Only render ~20 visible rows                                        |
|   Use CSS transform for positioning    Only ~25 DOM nodes total       |
|                                                                       |
+----------------------------------------------------------------------+
```

### Why @tanstack/react-virtual over Alternatives?

| Approach | Pros | Cons |
|----------|------|------|
| **@tanstack/react-virtual** | Headless (style however), dynamic heights, great TypeScript | Must build your own table UI |
| react-window | Battle-tested, simple API | Fixed item sizes only, less maintained |
| react-virtuoso | Built-in infinite scroll, grouped lists | Larger bundle, opinionated styling |
| AG Grid | Full-featured data grid, sorting/filtering built-in | License cost ($$$), heavy bundle |
| Native DOM | No dependencies | Browser crashes at 10K+ rows |

**Decision: @tanstack/react-virtual**

"With potentially millions of URLs in the frontier, we can't render them all. Virtual scrolling gives infinite scroll UX while only rendering ~20 DOM nodes regardless of data size. TanStack gives us full control over styling while handling the hard math of what's visible."

### URL Table Columns

| Column | Width | Content | Notes |
|--------|-------|---------|-------|
| Status | 1/12 | Colored dot | Blue=processing, Gray=pending, Green=done, Red=failed |
| URL | 5/12 | Full URL | Truncated with tooltip, monospace font |
| Domain | 2/12 | Extracted domain | Links to domain detail page |
| Priority | 1/12 | Badge | Red=high, Yellow=medium, Green=low |
| Depth | 1/12 | Number | How many hops from seed |
| Discovered | 2/12 | Relative time | "just now", "5m ago", "2h ago" |

### Infinite Scroll Detection Flow

```
+----------------------------------------------------------------------+
|                    Infinite Scroll Logic                              |
+----------------------------------------------------------------------+
|                                                                       |
|   +-------------+                                                     |
|   | User scrolls|                                                     |
|   |    down     |                                                     |
|   +------+------+                                                     |
|          |                                                            |
|          v                                                            |
|   +---------------------------------------------+                     |
|   | Calculate distance from bottom:             |                     |
|   | distanceFromBottom = scrollHeight           |                     |
|   |                    - scrollTop              |                     |
|   |                    - clientHeight           |                     |
|   +----------------------+----------------------+                     |
|                          |                                            |
|                          v                                            |
|   +------------------------------------------+                        |
|   | distanceFromBottom < 500px?              |                        |
|   +-----------+-------------------+----------+                        |
|               | Yes               | No                                |
|               v                   v                                   |
|   +-------------------+   +-------------------+                       |
|   | hasNextPage &&    |   |   Do nothing      |                       |
|   | !isLoading?       |   |   (wait for       |                       |
|   |       |           |   |    more scroll)   |                       |
|   |       v           |   +-------------------+                       |
|   | fetchNextPage()   |                                               |
|   | Load next 100 URLs|                                               |
|   +-------------------+                                               |
|                                                                       |
+----------------------------------------------------------------------+
```

### Virtualization Configuration

| Parameter | Value | Purpose |
|-----------|-------|---------|
| estimateSize | 48px | Fixed row height for fast calculation |
| overscan | 10 | Extra rows above/below viewport |
| getScrollElement | parentRef | Container with fixed height (600px) |

### Why Debounced Search?

| Approach | Pros | Cons |
|----------|------|------|
| **Debounce (300ms)** | Reduces API calls, waits for user to finish typing | Slight perceived delay |
| Throttle | Guaranteed updates at interval | Still fires during typing |
| No delay | Instant feedback | API overload, wasted requests |

**Decision: Debounce at 300ms**

"Users type 'example.com' letter by letter. Without debouncing, we'd fire 11 API requests. With 300ms debounce, we wait until they pause, then fire once. The slight delay is imperceptible but reduces server load by 90%."

---

## 🔍 Deep Dive: Domain Management (8 minutes)

### Domain Detail Page Layout

```
+----------------------------------------------------------------------+
|                     Domain Detail View                                |
|                     example.com                                       |
+----------------------------------------------------------------------+
|                                                                       |
|   +-------------------------------------------+  +---------------+    |
|   | example.com                               |  | Block Domain  |    |
|   | 125,432 pages crawled                     |  |    (red)      |    |
|   +-------------------------------------------+  +---------------+    |
|                                                                       |
|   +-----------+ +-----------+ +-----------+ +-----------+             |
|   |   Status  | |   Pending | |Avg Response| | Last Crawl|            |
|   |   Active  | |    1,234  | |   245ms   | |   5m ago  |             |
|   +-----------+ +-----------+ +-----------+ +-----------+             |
|                                                                       |
|   +-----------------------------------------------------------------+ |
|   | Crawl Rate Limit                                                | |
|   |                                                                 | |
|   | 500ms ---------------*------------------------------ 10000ms   | |
|   |                      ^                                          | |
|   |                   2000ms                                        | |
|   |                                                                 | |
|   | Currently: 1 request every 2000ms                               | |
|   +-----------------------------------------------------------------+ |
|                                                                       |
|   +-----------------------------------------------------------------+ |
|   | robots.txt                              Last fetched: 2h ago    | |
|   | +-------------------------------------------------------------+ | |
|   | |  1  # Robots.txt for example.com     (gray - comment)       | | |
|   | |  2  User-agent: *                    (blue - user-agent)    | | |
|   | |  3  Disallow: /private/              (red - disallow)       | | |
|   | |  4  Allow: /public/                  (green - allow)        | | |
|   | |  5  Crawl-delay: 2                   (yellow - delay)       | | |
|   | |  6  Sitemap: /sitemap.xml            (purple - sitemap)     | | |
|   | +-------------------------------------------------------------+ | |
|   +-----------------------------------------------------------------+ |
|                                                                       |
+----------------------------------------------------------------------+
```

### Why Range Slider over Number Input for Rate Limiting?

| Approach | Pros | Cons |
|----------|------|------|
| **Range Slider** | Visual, prevents invalid values, shows scale | Less precise |
| Number Input | Exact values, familiar | Easy to enter invalid values, no context |
| Preset Buttons | One-click, curated options | Not flexible enough |

**Decision: Range Slider with value display**

"Rate limiting ranges from 500ms to 10000ms. A slider shows the full range at a glance and prevents operators from accidentally entering 50ms (too aggressive) or 1000000ms (essentially blocked). We show the current value below for precision."

### robots.txt Syntax Highlighting

| Directive | Color | Example |
|-----------|-------|---------|
| Comments (#) | Gray | # This is a comment |
| User-agent | Blue | User-agent: * |
| Disallow | Red | Disallow: /private/ |
| Allow | Green | Allow: /public/ |
| Crawl-delay | Yellow | Crawl-delay: 2 |
| Sitemap | Purple | Sitemap: /sitemap.xml |

"Color-coding helps operators quickly scan robots.txt files. Red for Disallow immediately highlights what's blocked."

---

## 🔍 Deep Dive: Worker Monitoring (5 minutes)

### Worker Grid Layout

```
+----------------------------------------------------------------------+
|                      Worker Monitoring Grid                           |
+----------------------------------------------------------------------+
|                                                                       |
|  +---------------+  +---------------+  +---------------+              |
|  | worker-001  * |  | worker-002  * |  | worker-003  * |              |
|  | (green=active)|  | (yellow=idle) |  | (green)       |              |
|  +---------------+  +---------------+  +---------------+              |
|  | Status: Active|  | Status: Idle  |  | Status: Active|              |
|  | URLs: 45,231  |  | URLs: 38,102  |  | URLs: 51,890  |              |
|  | Domain: news  |  | Domain: -     |  | Domain: blog  |              |
|  | Uptime: 4h 23m|  | Uptime: 4h 20m|  | Uptime: 4h 25m|              |
|  | Heartbeat: 2s |  | Heartbeat: 5s |  | Heartbeat: 1s |              |
|  +---------------+  +---------------+  +---------------+              |
|                                                                       |
|  +---------------+  +---------------+  +---------------+              |
|  | worker-004  * |  | worker-005  * |  | worker-006  * |              |
|  | (red=error)   |  | (green)       |  | (green)       |              |
|  +---------------+  +---------------+  +---------------+              |
|  | Status: Error |  | Status: Active|  | Status: Active|              |
|  | URLs: 22,150  |  | URLs: 48,776  |  | URLs: 43,221  |              |
|  | Domain: -     |  | Domain: shop  |  | Domain: forum |              |
|  | Uptime: 2h 15m|  | Uptime: 4h 22m|  | Uptime: 4h 24m|              |
|  | Heartbeat: 45s|  | Heartbeat: 3s |  | Heartbeat: 2s |              |
|  +---------------+  +---------------+  +---------------+              |
|                                                                       |
+----------------------------------------------------------------------+
```

### Why Card Grid over Data Table for Workers?

| Approach | Pros | Cons |
|----------|------|------|
| **Card Grid** | Visual status at a glance, fits 6-12 workers well, responsive | Doesn't scale to 100+ workers |
| Data Table | Compact, sortable, scales to many rows | Status less visible, requires scanning |
| Heat Map | Great for 50+ workers, pattern recognition | Overkill for <20 workers |

**Decision: Card Grid**

"Most crawler deployments have 4-12 workers. Cards give operators immediate visual status - a red card stands out instantly. If we scaled to 50+ workers, we'd add a heat map view as an alternative."

### Status Color Meanings

| Status | Color | Description |
|--------|-------|-------------|
| active | Green | Currently processing URLs |
| idle | Yellow | Waiting for work (queue empty or rate limited) |
| error | Red | Connection issue or crash |

### Heartbeat Warning Threshold

"If a worker's heartbeat exceeds 30 seconds, the card border turns orange. Over 60 seconds, it turns red. This lets operators spot stalled workers before they're marked as crashed."

---

## ⚖️ Trade-offs Summary (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time Updates | WebSocket | Polling | True real-time for live dashboard, operators need immediate visibility |
| Virtualization | @tanstack/react-virtual | react-window | Dynamic row heights, better TypeScript, actively maintained |
| Charts | Recharts | D3.js | React-native, sufficient for throughput charts, 10x less code |
| State Management | Zustand | Redux | Simpler for dashboard scope, selector pattern prevents re-renders |
| URL Table | Custom virtualized | AG Grid | Full UX control, no license cost, tailored to crawler needs |
| Rate Limit Control | Range Slider | Number Input | Visual, prevents invalid values, shows full range |
| Worker Display | Card Grid | Data Table | Visual status at a glance for 4-12 workers |

### Key Trade-off: Complexity vs. Features

"I chose simpler technologies (Zustand over Redux, Recharts over D3) because the dashboard's complexity doesn't warrant enterprise-grade tools. This keeps the codebase maintainable for a small team while delivering all required functionality."

---

## 🚀 Future Enhancements

With more time, I would add:

1. **URL detail modal** with crawl history and linked pages
2. **Domain health heatmap** showing status across all domains at scale
3. **Export functionality** for crawl reports in CSV/JSON
4. **Dark mode** for on-call monitoring (reduces eye strain)
5. **Mobile-responsive** layout for phone access during incidents
6. **Keyboard shortcuts** for power users (j/k navigation, / to search)

---

## 📝 Summary

"I've designed a web crawler dashboard with:

1. **Real-time WebSocket stats** with live throughput charts and auto-reconnection - chose WebSocket over polling for true real-time visibility
2. **Virtualized URL table** handling millions of rows efficiently with infinite scroll - only ~20 DOM nodes regardless of data size
3. **Domain management UI** with robots.txt syntax highlighting and rate limit slider controls
4. **Worker monitoring grid** showing health status and throughput per worker - card layout for quick visual scanning
5. **Accessible keyboard navigation** and ARIA live regions for screen readers

The design prioritizes real-time visibility into crawl operations while maintaining performance with large datasets. Virtualization is the key technique - rendering only visible rows allows the table to handle millions of URLs without browser slowdown. Technology choices favor simplicity (Zustand, Recharts) over enterprise complexity because this dashboard serves a focused use case."
