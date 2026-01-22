# Health Data Pipeline - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 📋 Opening Statement (1 minute)

"I'll design the frontend for a health data pipeline like Apple Health, which displays metrics from multiple devices, visualizes health trends over time, and allows users to share data with healthcare providers. The key frontend challenges are rendering large amounts of time-series data efficiently, building responsive chart visualizations that work across date ranges, and creating intuitive interfaces for managing privacy and sharing settings.

The core technical challenges are implementing performant chart rendering with Recharts, managing complex health data state with Zustand, building accessible date range selectors for historical queries, and creating a dashboard that displays insights and recommendations prominently."

---

## 🎯 Requirements Clarification (3 minutes)

### User-Facing Features
- **Dashboard**: Daily summary with key health metrics
- **Trends**: Historical charts for each metric type
- **Insights**: AI-generated health recommendations
- **Devices**: Manage connected devices and sync status
- **Sharing**: Create and manage share tokens for providers

### Non-Functional Requirements
- **Performance**: Charts render in < 100ms with weeks of data
- **Responsiveness**: Dashboard adapts from mobile to desktop
- **Accessibility**: WCAG 2.1 AA for health-critical information
- **Offline**: Display cached data when offline

### UI Scale Estimates
- 16 health metric types across 4 categories
- Charts can show 7-365 days of data
- Up to 1,440 data points per day (heart rate at 1/min)
- Real-time sync status updates

---

## 🏗️ High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                    React Application                       |
|                                                            |
|  +----------------------+  +---------------------------+   |
|  |    Layout Shell      |  |      Route Components      |  |
|  |  - Navigation        |  |  - Dashboard (index)       |  |
|  |  - Header            |  |  - Trends (/trends/:type)  |  |
|  |  - Sync Status       |  |  - Insights (/insights)    |  |
|  +----------------------+  |  - Devices (/devices)      |  |
|                            |  - Sharing (/sharing)      |  |
|  +----------------------+  +---------------------------+   |
|  |    Zustand Store     |                                  |
|  |  - healthStore       |  +---------------------------+   |
|  |  - uiStore           |  |      Chart Components      |  |
|  |  - syncStore         |  |  - LineChart (trends)      |  |
|  +----------------------+  |  - BarChart (daily totals) |  |
|                            |  - AreaChart (ranges)       |  |
|                            +---------------------------+   |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                      API Layer                             |
|    /api/v1/samples | /api/v1/aggregates | /api/v1/insights |
+----------------------------------------------------------+
```

### Component Hierarchy

```
App
├── Layout
│   ├── Sidebar
│   │   ├── NavItem (Dashboard)
│   │   ├── NavItem (Trends)
│   │   ├── NavItem (Insights)
│   │   ├── NavItem (Devices)
│   │   └── NavItem (Sharing)
│   └── Header
│       ├── DateRangeSelector
│       ├── SyncStatusIndicator
│       └── UserMenu
├── Routes
│   ├── Dashboard (/)
│   │   ├── DailySummaryCard (steps, calories)
│   │   ├── VitalsCard (heart rate, BP)
│   │   ├── SleepCard
│   │   ├── WeightCard
│   │   └── InsightsPreview
│   ├── TrendsPage (/trends/:metricType)
│   │   ├── DateRangePicker
│   │   ├── TrendChart (Recharts)
│   │   └── StatsSummary
│   ├── InsightsPage (/insights)
│   │   ├── InsightCard (heart rate trend)
│   │   ├── InsightCard (sleep deficit)
│   │   └── InsightCard (activity change)
│   ├── DevicesPage (/devices)
│   │   ├── DeviceCard
│   │   └── AddDeviceModal
│   └── SharingPage (/sharing)
│       ├── ShareTokenList
│       └── CreateShareModal
└── Modals
    └── InsightDetailModal
```

---

## 📊 Deep Dive: Health Dashboard Layout (8 minutes)

### Dashboard Grid Structure

```
+------------------------------------------------------------------+
|                    INSIGHTS BANNER (full width)                   |
|  [!] Your resting heart rate has increased 5% this month         |
+------------------------------------------------------------------+
|                                                                   |
|  +------------------+  +------------------+  +------------------+  |
|  |    ACTIVITY      |  |     VITALS       |  |      SLEEP       |  |
|  +------------------+  +------------------+  +------------------+  |
|  | 🚶 Steps         |  | ❤️ Heart Rate    |  | 😴 7h 23m        |  |
|  |   8,234 / 10,000 |  |   72 bpm avg     |  |   ▓▓▓▓▓▓▓░░░     |  |
|  |   ▓▓▓▓▓▓▓▓░░     |  |                  |  |   Goal: 8h       |  |
|  |                  |  | 💓 Resting HR    |  +------------------+  |
|  | 🔥 Calories      |  |   58 bpm         |  |                   |
|  |   423 / 500      |  |                  |  +------------------+  |
|  |   ▓▓▓▓▓▓▓▓░      |  | 🩸 Blood O2     |  |     WEIGHT       |  |
|  +------------------+  |   98%            |  +------------------+  |
|                        +------------------+  | ⚖️ 72.5 kg       |  |
|                                              | 📊 22.1% body fat |  |
|                                              +------------------+  |
+------------------------------------------------------------------+
```

### Responsive Breakpoints

| Breakpoint | Grid Layout | Description |
|------------|-------------|-------------|
| Mobile (< 768px) | 1 column | Cards stack vertically |
| Tablet (768-1024px) | 2 columns | Activity + Vitals, Sleep + Weight |
| Desktop (> 1024px) | 3 columns | All cards visible at once |

### Daily Summary Card Structure

```
+--------------------------------+
|  [icon]  ACTIVITY              |
+--------------------------------+
|                                |
|  Steps              8,234      |
|  ▓▓▓▓▓▓▓▓░░░░░░░░   steps     |
|  (82% of 10,000 goal)          |
|                                |
|  Distance            5.2 km    |
|                                |
|  Active Calories      423      |
|  ▓▓▓▓▓▓▓▓░░░░░░░░   kcal      |
|  (85% of 500 goal)             |
|                                |
+--------------------------------+
```

### Progress Bar Component

```
Progress Calculation:
progress = min((value / goal) * 100, 100)

Visual representation:
▓▓▓▓▓▓▓▓░░░░░░░░  82% (value: 8234, goal: 10000)
└─filled─┘└─empty─┘

Accessibility:
role="progressbar"
aria-valuenow={8234}
aria-valuemax={10000}
aria-label="8,234 of 10,000 steps"
```

---

## 📈 Deep Dive: Trend Charts with Recharts (8 minutes)

### Chart Component Architecture

```
+------------------------------------------------------------------+
|                      TrendChart Component                         |
+------------------------------------------------------------------+
|                                                                   |
|  Props:                                                           |
|  - data: Array<{ date: string, value: number }>                   |
|  - metricType: STEPS | HEART_RATE | SLEEP | WEIGHT | ...         |
|  - dateRange: '7d' | '30d' | '90d' | '1y'                        |
|  - showTrendLine: boolean                                         |
|                                                                   |
+------------------------------------------------------------------+
         |
         v
+------------------------------------------------------------------+
|  ResponsiveContainer (100% width, 320px height)                   |
|  +--------------------------------------------------------------+ |
|  |                         LineChart                             | |
|  |  +----------------------------------------------------------+ | |
|  |  |       Y-Axis                     Chart Area               | | |
|  |  |    120 ─┤                   .                            | | |
|  |  |        │                  .   .     Goal line            | | |
|  |  |    100 ─┤ - - - - - - .-.-.-.-.-.-.-.-.-.-- ─ ─ ─ ─ ─    | | |
|  |  |        │           .         .                           | | |
|  |  |     80 ─┤        .             .                         | | |
|  |  |        │      .                  .     Trend line        | | |
|  |  |     60 ─┤ . . . . . . . . . . . . . . . . . .           | | |
|  |  |        │                                                 | | |
|  |  |     40 ─┤                                                | | |
|  |  |        └──┬────┬────┬────┬────┬────┬────┬──              | | |
|  |  |          Mon  Tue  Wed  Thu  Fri  Sat  Sun               | | |
|  |  +----------------------------------------------------------+ | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

### Date Formatting by Range

| Date Range | X-Axis Format | Example | Tick Count |
|------------|---------------|---------|------------|
| 7 days | Day name | Mon, Tue, Wed | 7 |
| 30 days | Month Day | Jan 5, Jan 12 | ~8 |
| 90 days | Month | Jan, Feb, Mar | ~6 |
| 1 year | Month | Jan, Apr, Jul, Oct | ~12 |

### Metric Configuration Table

| Metric | Display Name | Unit | Color | Domain | Goal |
|--------|--------------|------|-------|--------|------|
| STEPS | Steps | steps | #22c55e (green) | auto | 10,000 |
| HEART_RATE | Heart Rate | bpm | #ef4444 (red) | [40, 120] | - |
| RESTING_HEART_RATE | Resting HR | bpm | #f97316 (orange) | [40, 100] | - |
| SLEEP_ANALYSIS | Sleep | hours | #8b5cf6 (purple) | auto | 8 |
| WEIGHT | Weight | kg | #3b82f6 (blue) | auto | - |
| DISTANCE | Distance | km | #06b6d4 (cyan) | auto | - |
| ACTIVE_ENERGY | Calories | kcal | #eab308 (yellow) | auto | 500 |
| OXYGEN_SATURATION | Blood O2 | % | #0ea5e9 (sky) | [90, 100] | - |

### Tooltip Component

```
+-------------------------+
| Saturday, January 15    |
|                         |
| 8,234 steps             |
+-------------------------+

Triggered on: hover/touch
Position: follows cursor
Contains: formatted date + value with unit
```

### Trend Line Calculation

Linear regression for trend detection:

```
slope = (n × ΣXY - ΣX × ΣY) / (n × ΣX² - (ΣX)²)

Where:
  X = day index (0, 1, 2, ...)
  Y = metric value
  n = number of data points

Rendered as: dashed line overlay on chart
Visibility: only when showTrendLine=true and data.length >= 7
```

---

## 🗄️ Deep Dive: Zustand Health Store (8 minutes)

### Store Architecture

```
+------------------------------------------------------------------+
|                        healthStore                                |
+------------------------------------------------------------------+
|                                                                   |
|  State:                                                           |
|  +----------------------+  +----------------------------------+   |
|  | Date Selection       |  | Cached Data                      |   |
|  |----------------------|  |----------------------------------|   |
|  | selectedDate: Date   |  | dailySummary: Record<type, val>  |   |
|  | dateRange: {start,   |  | aggregates: Record<type,         |   |
|  |            end}      |  |             Array<{date, value}>>|   |
|  | dateRangePreset:     |  | insights: Insight[]              |   |
|  |   '7d'|'30d'|'90d'   |  +----------------------------------+   |
|  +----------------------+                                         |
|                                                                   |
|  Loading States:                                                  |
|  +----------------------------------+                             |
|  | isLoadingSummary: boolean        |                             |
|  | isLoadingAggregates: boolean     |                             |
|  +----------------------------------+                             |
|                                                                   |
+------------------------------------------------------------------+
         |
         v
+------------------------------------------------------------------+
|  Actions                                                          |
+------------------------------------------------------------------+
|  setSelectedDate(date) → triggers fetchDailySummary              |
|  setDateRangePreset('7d'|'30d'|'90d'|'1y') → updates range       |
|  fetchDailySummary(date) → GET /api/v1/users/me/summary          |
|  fetchAggregates(types[], range) → GET /api/v1/users/me/aggregates|
|  fetchInsights() → GET /api/v1/users/me/insights                 |
+------------------------------------------------------------------+
```

### Date Range Preset Logic

```
setDateRangePreset(preset):

+--------+     +-----------------------+     +------------------+
| '7d'   | --> | start = today - 7     | --> | Update dateRange |
| '30d'  | --> | start = today - 30    | --> | in store         |
| '90d'  | --> | start = today - 90    | --> |                  |
| '1y'   | --> | start = today - 365   | --> |                  |
+--------+     +-----------------------+     +------------------+
                         |
                         v
               +------------------+
               | end = today      |
               +------------------+
```

### Persistence Strategy

```
persist middleware configuration:
+------------------------------------------+
|  name: 'health-store'                    |
|                                          |
|  partialize: (state) => ({               |
|    dateRangePreset: state.dateRangePreset|
|  })                                      |
|                                          |
|  NOT persisted (fetched fresh):          |
|  - dailySummary                          |
|  - aggregates                            |
|  - insights                              |
+------------------------------------------+
```

Rationale: Persist user preferences (date range), but always fetch fresh health data on app load.

### Sync Status Store

```
+------------------------------------------------------------------+
|                         syncStore                                 |
+------------------------------------------------------------------+
|                                                                   |
|  devices: Array<{                                                 |
|    id: string                                                     |
|    name: "Apple Watch Series 9"                                   |
|    type: "apple_watch"                                            |
|    lastSync: Date | null                                          |
|    isSyncing: boolean                                             |
|  }>                                                               |
|                                                                   |
|  overallStatus: 'synced' | 'syncing' | 'error' | 'offline'       |
|                                                                   |
+------------------------------------------------------------------+
```

### Status Indicator UI

```
+---------------------------+
| Overall Status Display    |
+---------------------------+
| synced  → ● (green)  "All devices synced"         |
| syncing → ◐ (blue)   "Syncing..." (animated)      |
| error   → ● (red)    "Sync error - tap to retry"  |
| offline → ○ (gray)   "Offline - cached data"      |
+---------------------------+
```

---

## 💡 Deep Dive: Insights Display (5 minutes)

### Insight Card Design

```
+------------------------------------------------------------------+
| HIGH SEVERITY (red border)                                        |
+------------------------------------------------------------------+
| ⚠️  Your resting heart rate has increased over the past month    |
|                                                                   |
|     Consider scheduling a check-up with your doctor if           |
|     this trend continues.                                         |
|                                                               [X] |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
| MEDIUM SEVERITY (yellow border)                                   |
+------------------------------------------------------------------+
| 😴  You've averaged 5.8 hours of sleep over the past 2 weeks     |
|                                                                   |
|     Try setting a consistent bedtime to improve sleep quality.   |
|                                                               [X] |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
| LOW SEVERITY (blue border)                                        |
+------------------------------------------------------------------+
| 📈  Great job! You're 23% more active than your 4-week average   |
|                                                               [X] |
+------------------------------------------------------------------+
```

### Insight Types and Icons

| Insight Type | Icon | Condition | Severity |
|--------------|------|-----------|----------|
| HEART_RATE_TREND (up) | 📈 | slope > 0.5 BPM/day | medium |
| HEART_RATE_TREND (down) | 📉 | slope < -0.5 BPM/day | low |
| SLEEP_DEFICIT | 😴 | avg < 6 hours | high |
| ACTIVITY_CHANGE (up) | 🏃 | > +20% vs 4-week avg | low |
| ACTIVITY_CHANGE (down) | ⚠️ | < -20% vs 4-week avg | medium |
| WEIGHT_CHANGE | ⚖️ | > 3% change in 30 days | medium |

### Severity Styling

| Severity | Background | Border | Text |
|----------|------------|--------|------|
| high | bg-red-50 | border-red-500 | text-red-800 |
| medium | bg-yellow-50 | border-yellow-500 | text-yellow-800 |
| low | bg-blue-50 | border-blue-500 | text-blue-800 |

### Insights Sorting

Insights are displayed by severity (high → medium → low), limited to top 3 on dashboard preview.

---

## 📅 Deep Dive: Date Range Selector (3 minutes)

### Selector Component Layout

```
+------------------------------------------------------------------+
|  +-------+-------+-------+-------+        Jan 8 - Jan 15, 2024   |
|  |  7D   |  30D  |  90D  |  1Y   |                               |
|  +-------+-------+-------+-------+                               |
|     ↑                                                            |
|   selected (white bg, shadow)                                    |
+------------------------------------------------------------------+
```

### Interaction Flow

```
User clicks "30D" button
         |
         v
+----------------------------------+
| setDateRangePreset('30d')        |
+----------------------------------+
         |
         v
+----------------------------------+
| Calculate new date range:        |
| start = today - 30 days          |
| end = today                      |
+----------------------------------+
         |
         v
+----------------------------------+
| Update store:                    |
| - dateRangePreset = '30d'        |
| - dateRange = { start, end }     |
+----------------------------------+
         |
         v
+----------------------------------+
| Chart components re-render       |
| with new date range              |
+----------------------------------+
```

### Accessibility

```
Button attributes:
- aria-pressed={isSelected}
- Focus ring visible on keyboard nav
- Grouped logically for screen readers
```

---

## ⚖️ Trade-offs and Alternatives (5 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Chart Library | ✅ Recharts | ❌ D3.js, Chart.js | React-native, declarative API, good TypeScript support |
| State Management | ✅ Zustand | ❌ Redux, Context | Minimal boilerplate, built-in persistence, no providers needed |
| Date Library | ✅ date-fns | ❌ Moment, Day.js | Tree-shakeable, immutable, comprehensive API |
| Styling | ✅ Tailwind CSS | ❌ CSS Modules | Utility-first for rapid prototyping, consistent design system |
| Data Fetching | ✅ Custom hooks | ❌ React Query | Simpler for this use case, less dependency |

### Chart Performance Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| SVG (Recharts) ✅ | Crisp at any resolution, easy tooltips, declarative | Performance degrades with 1000+ points |
| Canvas | Better performance for large datasets | No native DOM events, harder accessibility |

**Mitigation**: For 1-year views (365 points), SVG is sufficient. For minute-level data, aggregate to hourly before rendering.

### Data Aggregation Strategy

| Approach | Pros | Cons |
|----------|------|------|
| Server-side ✅ | Smaller payloads, consistent aggregation | Additional API calls for granularity changes |
| Client-side | More flexible visualizations | Large payloads, inconsistent across clients |

**Decision**: Server-side aggregation - request period parameter (hour, day, week) in API call.

---

## ♿ Accessibility Considerations (2 minutes)

### Screen Reader Support

```
Chart accessibility:
+------------------------------------------+
| aria-label="Steps trend chart showing    |
|             7 days of data"              |
+------------------------------------------+

Progress bar:
+------------------------------------------+
| role="progressbar"                       |
| aria-valuenow={8234}                     |
| aria-valuemax={10000}                    |
| aria-label="8,234 of 10,000 steps"       |
+------------------------------------------+

Insight alerts:
+------------------------------------------+
| role="alert"                             |
| aria-live="polite"                       |
+------------------------------------------+
```

### Color Accessibility

In addition to colors, use patterns for colorblind users:

| Metric | Color | Pattern |
|--------|-------|---------|
| Steps | Green (#22c55e) | Solid line |
| Heart Rate | Red (#ef4444) | Dashed line |
| Sleep | Purple (#8b5cf6) | Dotted line |

All color combinations meet WCAG 2.1 AA contrast requirements (4.5:1 minimum).

---

## 🚀 Closing Summary (1 minute)

"The health data pipeline frontend is built around three key principles:

1. **Dashboard-first design** - The daily summary provides an at-a-glance view of key health metrics with progress indicators toward goals. Insights are prominently displayed to surface AI-generated recommendations.

2. **Responsive chart visualizations** - Recharts provides declarative, React-native charts for trend analysis. Date range presets (7d, 30d, 90d, 1y) enable quick navigation through historical data with appropriate date formatting for each range.

3. **Zustand for health state** - A single store manages date selection, cached aggregates, and insights with persist middleware for user preferences. This enables consistent state across the dashboard, trends, and insights views.

The main trade-off is simplicity versus flexibility. Server-side aggregation means smaller payloads and consistent data, but requires additional API calls when users want different time granularities. For a health dashboard where users typically view daily aggregates, this trade-off favors simpler client code."
