# Rate Limiter - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a rate limiter dashboard that allows developers to configure rate limiting rules, visualize usage metrics, and test their API limits interactively. As a frontend engineer, I'll focus on the dashboard UI, real-time metrics visualization, interactive testing interface, and responsive design. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Algorithm Visualization** - Interactive demo of all 5 rate limiting algorithms
2. **Metrics Dashboard** - Real-time charts showing allowed/denied requests
3. **Testing Interface** - Send test requests and observe rate limiting behavior
4. **Configuration Panel** - Set limits, window sizes, burst capacity
5. **Response Headers Display** - Show X-RateLimit-* headers in real-time

### Non-Functional Requirements

- **Real-time Updates** - Metrics refresh within 1 second
- **Responsive Design** - Work on desktop and tablet
- **Performance** - Handle 1000+ data points in charts smoothly
- **Accessibility** - Keyboard navigation, screen reader support

### Frontend-Specific Considerations

- State management for complex form state and API responses
- Chart library selection for time-series visualization
- WebSocket vs polling for real-time updates
- Error handling and loading states

---

## 2. High-Level Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         React Application                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │ Algorithm Panel  │  │  Metrics Charts  │  │  Request Tester  │   │
│  │ - Algorithm pick │  │  - Line chart    │  │  - Send requests │   │
│  │ - Configuration  │  │  - Success/deny  │  │  - View headers  │   │
│  │ - Visual demo    │  │  - Latency hist  │  │  - Batch test    │   │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘   │
│           │                     │                     │              │
│           └─────────────────────┼─────────────────────┘              │
│                                 │                                     │
│                    ┌────────────▼────────────┐                       │
│                    │     Zustand Store       │                       │
│                    │  - selectedAlgorithm    │                       │
│                    │  - config (limit, win)  │                       │
│                    │  - metrics[]            │                       │
│                    │  - testResults[]        │                       │
│                    └────────────┬────────────┘                       │
│                                 │                                     │
│                    ┌────────────▼────────────┐                       │
│                    │    API Service Layer    │                       │
│                    │  - fetchMetrics()       │                       │
│                    │  - testRateLimit()      │                       │
│                    │  - batchTest()          │                       │
│                    └─────────────────────────┘                       │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │    Backend API         │
                    │    /api/ratelimit/*    │
                    └────────────────────────┘
```

---

## 3. Deep Dive: Zustand State Management (8 minutes)

### State Architecture

"I chose Zustand over Redux for its simpler API, excellent TypeScript support, and minimal boilerplate. The store centralizes algorithm selection, configuration, test results, and metrics data."

```
┌─────────────────────────────────────────────────────────────────────┐
│                      RateLimiterState Store                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Algorithm Selection                                                 │
│  ├── selectedAlgorithm: 'fixed' | 'sliding' | 'token' | 'leaky'    │
│  └── algorithms: Algorithm[]                                        │
│      ├── id, name, description                                      │
│      └── configFields: ConfigField[]                                │
│                                                                      │
│  Configuration                                                       │
│  └── config                                                         │
│      ├── identifier: string (e.g., 'test-user')                    │
│      ├── limit: number                                              │
│      ├── windowSeconds: number                                      │
│      ├── burstCapacity: number                                      │
│      ├── refillRate: number                                         │
│      └── leakRate: number                                           │
│                                                                      │
│  Test Results                                                        │
│  ├── testResults: TestResult[] (max 100)                            │
│  └── isTestRunning: boolean                                         │
│                                                                      │
│  Metrics                                                             │
│  ├── metrics: MetricPoint[]                                         │
│  └── metricsLoading: boolean                                        │
│                                                                      │
│  Connection                                                          │
│  └── isConnected: boolean                                           │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  Actions                                                             │
│  ├── setAlgorithm(id) ──▶ Update selectedAlgorithm                 │
│  ├── updateConfig(partial) ──▶ Merge config changes                │
│  ├── runTest() ──▶ POST /api/ratelimit/check, record result        │
│  ├── runBatchTest(count, intervalMs) ──▶ Sequential test loop      │
│  ├── clearResults() ──▶ Empty testResults array                    │
│  └── fetchMetrics() ──▶ GET /api/metrics, update metrics[]         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Algorithm Definitions

| Algorithm | Name | Description | Config Fields |
|-----------|------|-------------|---------------|
| fixed | Fixed Window | Simple counter that resets at fixed intervals | limit, windowSeconds |
| sliding | Sliding Window | Weighted average of current and previous window | limit, windowSeconds |
| sliding_log | Sliding Log | Exact count using timestamp log | limit, windowSeconds |
| token | Token Bucket | Tokens refill over time, requests consume tokens | burstCapacity, refillRate |
| leaky | Leaky Bucket | Requests queue and drain at fixed rate | burstCapacity, leakRate |

### Test Result Data Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TestResult                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  TestResult                                                          │
│  ├── id: string (UUID)                                              │
│  ├── timestamp: number (ms since epoch)                             │
│  ├── allowed: boolean                                               │
│  ├── remaining: number                                              │
│  ├── limit: number                                                  │
│  ├── resetAt: number (ms since epoch)                               │
│  └── latencyMs: number                                              │
│                                                                      │
│  MetricPoint                                                         │
│  ├── timestamp: number                                              │
│  ├── allowed: number (count in period)                              │
│  ├── denied: number (count in period)                               │
│  ├── p50Latency: number                                             │
│  └── p99Latency: number                                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dive: Algorithm Visualization Panel (8 minutes)

### Component Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│                      AlgorithmPanel Component                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                  Algorithm Selection Grid (2x2)                │  │
│  │  ┌─────────────────┐  ┌─────────────────┐                     │  │
│  │  │ Fixed Window    │  │ Sliding Window  │                     │  │
│  │  │ [description]   │  │ [description]   │                     │  │
│  │  └─────────────────┘  └─────────────────┘                     │  │
│  │  ┌─────────────────┐  ┌─────────────────┐                     │  │
│  │  │ Token Bucket    │  │ Leaky Bucket    │                     │  │
│  │  │ [description]   │  │ [description]   │                     │  │
│  │  └─────────────────┘  └─────────────────┘                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                  Configuration Fields                          │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ Identifier: [test-user____________]                     │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ {Dynamic fields based on selected algorithm}            │  │  │
│  │  │ - Requests per window / Bucket capacity                 │  │  │
│  │  │ - Window (seconds) / Tokens per second                  │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                  Algorithm Visualization                       │  │
│  │  [Animated visual based on algorithm type]                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Algorithm Visualizations

"Each algorithm gets a unique animated visualization that helps developers understand the underlying mechanism."

```
┌─────────────────────────────────────────────────────────────────────┐
│                Token Bucket Visualization                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │    Token Bucket                                               │   │
│  │    ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌─┐ ┌ ┐ ┌ ┐ ┌ ┐                 │   │
│  │    │█│ │█│ │█│ │█│ │█│ │█│ │█│ │ │ │ │ │ │                 │   │
│  │    └─┘ └─┘ └─┘ └─┘ └─┘ └─┘ └─┘ └ ┘ └ ┘ └ ┘                 │   │
│  │    filled ██████████████████████░░░░░░░░░░░ empty            │   │
│  │                    7 / 10 tokens                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Animation: Tokens refill at refillRate per second                  │
│  On request: One token disappears (if available)                    │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                Leaky Bucket Visualization                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │    Leaky Bucket                                               │   │
│  │         ┌────────┐                                            │   │
│  │         │        │                                            │   │
│  │         │ ░░░░░░ │ ◀── Water level (queued requests)         │   │
│  │         │ ██████ │                                            │   │
│  │         │ ██████ │                                            │   │
│  │         └───┬────┘                                            │   │
│  │             │ ◀── Leak (requests drain at fixed rate)        │   │
│  │             ▼                                                 │   │
│  │          3.5 / 10 queued                                      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Animation: Water level drops at leakRate per second                │
│  On request: Water level rises (if not overflowing)                 │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│             Fixed/Sliding Window Visualization                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │    Progress Bar                                               │   │
│  │    ┌──────────────────────────────────────────────────────┐  │   │
│  │    │████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  │   │
│  │    └──────────────────────────────────────────────────────┘  │   │
│  │                    6 / 10 requests in window                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Fixed: Resets to 0 at window boundary                              │
│  Sliding: Smoothly transitions based on time position               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Animation Implementation

"I use a useEffect hook with setInterval to animate the visualizations. Token buckets refill, leaky buckets drain, and window counters update in real-time. The animation rate is 100ms for smooth visual feedback."

---

## 5. Deep Dive: Metrics Charts (8 minutes)

### Chart Library Selection

"I chose Recharts for its React-first design, declarative API, and responsive container support. It handles 1000+ data points smoothly with proper optimization."

### Metrics Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│                      MetricsDashboard Component                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                  Request Volume (AreaChart)                    │  │
│  │                                                                │  │
│  │  allowed ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                                  │  │
│  │  denied  ░░░░░░░░░                                             │  │
│  │          ────────────────────────────────────▶ time           │  │
│  │                                                                │  │
│  │  Stacked area chart showing allowed (green) and denied (red)  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                  Latency (LineChart)                           │  │
│  │                                                                │  │
│  │  p99 ─────┐   ┌─────                                          │  │
│  │           └───┘        (orange)                                │  │
│  │  p50 ─────────────────── (blue)                               │  │
│  │          ────────────────────────────────────▶ time           │  │
│  │                                                                │  │
│  │  Two lines: P50 (blue) and P99 (orange) latency in ms         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                  Success Rate Gauge                            │  │
│  │                                                                │  │
│  │                      ╭───────╮                                 │  │
│  │                    ╱    │    ╲                                │  │
│  │                   ╱     │     ╲                               │  │
│  │                  │    87.5%    │                               │  │
│  │                   ╲           ╱                               │  │
│  │                    ╲         ╱                                │  │
│  │                      ╰─────╯                                   │  │
│  │                                                                │  │
│  │  Circular gauge with color coding:                            │  │
│  │  - Green (>=90%), Yellow (70-89%), Red (<70%)                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Real-time Update Strategy

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Metrics Polling Flow                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Component Mount                                                     │
│       │                                                              │
│       ▼                                                              │
│  ┌────────────────┐                                                 │
│  │ fetchMetrics() │ ◀── Initial fetch                              │
│  └───────┬────────┘                                                 │
│          │                                                           │
│          ▼                                                           │
│  ┌────────────────┐                                                 │
│  │ setInterval    │                                                 │
│  │ (5 seconds)    │                                                 │
│  └───────┬────────┘                                                 │
│          │                                                           │
│          ├──────────────────────────────────────────┐               │
│          ▼                                          │               │
│  ┌────────────────┐                                 │               │
│  │ fetchMetrics() │ ◀── Poll every 5s              │               │
│  └───────┬────────┘                                 │               │
│          │                                          │               │
│          ▼                                          │               │
│  ┌────────────────┐                                 │               │
│  │ Update store   │                                 │               │
│  │ with new data  │                                 │               │
│  └───────┬────────┘                                 │               │
│          │                                          │               │
│          ▼                                          ▼               │
│  ┌────────────────┐                        Component Unmount        │
│  │ Charts re-render│                               │                │
│  │ with animations │                               ▼                │
│  └─────────────────┘                       clearInterval()          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Request Tester (6 minutes)

### Test Interface Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│                      RequestTester Component                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Action Buttons                             │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │  │
│  │  │ Send Request │  │ Batch Test   │  │    Clear     │        │  │
│  │  │   (blue)     │  │   (green)    │  │   (border)   │        │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘        │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Batch Settings                             │  │
│  │  Count: [20____]     Interval (ms): [100___]                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Results List (scrollable)                  │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ ✓ Allowed                                      2.3ms    │  │  │
│  │  │   X-RateLimit-Remaining: 8                              │  │  │
│  │  │   X-RateLimit-Limit: 10                                 │  │  │
│  │  │   X-RateLimit-Reset: 12:34:56                           │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ ✗ Denied                                       1.8ms    │  │  │
│  │  │   X-RateLimit-Remaining: 0                              │  │  │
│  │  │   X-RateLimit-Limit: 10                                 │  │  │
│  │  │   X-RateLimit-Reset: 12:35:00                           │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │  [... more results ...]                                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Test Result Card Styling

| State | Background | Border | Icon |
|-------|------------|--------|------|
| Allowed | Light green (green-50) | Green left border | Checkmark |
| Denied | Light red (red-50) | Red left border | X mark |

### Batch Test Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Batch Test Execution                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  User clicks "Batch Test"                                            │
│       │                                                              │
│       ▼                                                              │
│  ┌────────────────────┐                                             │
│  │ isTestRunning=true │ ──▶ Button shows "Running..."              │
│  └─────────┬──────────┘                                             │
│            │                                                         │
│            ▼                                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Loop: i = 0 to count-1                                       │   │
│  │       │                                                        │   │
│  │       ├──▶ runTest() ──▶ POST /api/ratelimit/check           │   │
│  │       │                      │                                 │   │
│  │       │                      ▼                                 │   │
│  │       │              Append to testResults                     │   │
│  │       │              (keep max 100)                            │   │
│  │       │                                                        │   │
│  │       └──▶ await setTimeout(intervalMs)                       │   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│            │                                                         │
│            ▼                                                         │
│  ┌─────────────────────┐                                            │
│  │ isTestRunning=false │ ──▶ Button returns to normal              │
│  └─────────────────────┘                                            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| State management | Zustand | Less tooling than Redux | Redux (more ecosystem) |
| Charts | Recharts | Learning curve | Chart.js (simpler) |
| Styling | Tailwind CSS | Utility classes everywhere | CSS Modules (scoped) |
| Updates | Polling (5s) | Not truly real-time | WebSocket (complexity) |
| Animations | CSS transitions | Limited control | Framer Motion (heavier) |

---

## 8. Accessibility Considerations

### Keyboard Navigation

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Algorithm Selector A11y                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ARIA Attributes                                                     │
│  ├── role="radiogroup" on container                                 │
│  ├── aria-label="Select rate limiting algorithm"                    │
│  └── Each button:                                                   │
│      ├── role="radio"                                               │
│      ├── aria-checked={isSelected}                                  │
│      └── tabIndex={isFocused ? 0 : -1}                             │
│                                                                      │
│  Keyboard Handlers                                                   │
│  ├── ArrowRight ──▶ Focus next algorithm                           │
│  ├── ArrowLeft ──▶ Focus previous algorithm                        │
│  ├── Enter ──▶ Select focused algorithm                            │
│  └── Space ──▶ Select focused algorithm                            │
│                                                                      │
│  Focus Management                                                    │
│  ├── Roving tabindex pattern                                        │
│  ├── Only focused item is tabbable                                  │
│  └── Arrow keys move focus within group                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Screen Reader Support

- All interactive elements have descriptive labels
- Status changes (allowed/denied) announced via aria-live regions
- Charts include accessible descriptions of data trends

---

## 9. Future Enhancements

1. **WebSocket Updates** - Real-time metrics without polling
2. **Dark Mode** - Theme toggle with system preference detection
3. **Export Data** - Download test results as CSV/JSON
4. **Comparison Mode** - Run same test with different algorithms
5. **Mobile App** - React Native version for on-the-go monitoring

---

## Summary

"To summarize, I've designed a rate limiter dashboard with:

1. **Algorithm visualization panel** with interactive animations showing token refill, water leak, and window counters
2. **Zustand state management** for clean, TypeScript-friendly state with minimal boilerplate
3. **Recharts-based metrics** showing request volume, latency percentiles, and success rates
4. **Interactive request tester** with batch testing and real-time header display
5. **Responsive design** with Tailwind CSS working on desktop and tablet
6. **Accessibility support** with keyboard navigation and ARIA attributes

The key insight is that rate limiting concepts can be abstract and confusing. Visual animations of token buckets filling and leaking, combined with immediate feedback from test requests, make the system behavior intuitive and helps developers choose the right algorithm for their use case."
