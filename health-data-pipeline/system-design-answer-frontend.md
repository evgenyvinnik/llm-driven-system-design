# Health Data Pipeline - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design the frontend for a health data pipeline like Apple Health, which displays metrics from multiple devices, visualizes health trends over time, and allows users to share data with healthcare providers. The key frontend challenges are rendering large amounts of time-series data efficiently, building responsive chart visualizations that work across date ranges, and creating intuitive interfaces for managing privacy and sharing settings.

The core technical challenges are implementing performant chart rendering with Recharts, managing complex health data state with Zustand, building accessible date range selectors for historical queries, and creating a dashboard that displays insights and recommendations prominently."

## Requirements Clarification (3 minutes)

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

## High-Level Architecture (5 minutes)

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

## Deep Dive: Health Dashboard Layout (8 minutes)

### Responsive Grid Layout

```tsx
// routes/index.tsx - Dashboard
import { useDailySummary, useInsights } from '../hooks/useHealthData';
import { DailySummaryCard } from '../components/dashboard/DailySummaryCard';
import { VitalsCard } from '../components/dashboard/VitalsCard';
import { SleepCard } from '../components/dashboard/SleepCard';
import { InsightsPreview } from '../components/dashboard/InsightsPreview';

export function Dashboard() {
  const { date } = useHealthStore();
  const { data: summary, isLoading } = useDailySummary(date);
  const { data: insights } = useInsights();

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        Health Summary
      </h1>

      {/* Insights banner at top for visibility */}
      {insights && insights.length > 0 && (
        <InsightsPreview insights={insights} className="mb-6" />
      )}

      {/* Responsive grid: 1 col mobile, 2 cols tablet, 3 cols desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Activity section */}
        <DailySummaryCard
          title="Activity"
          metrics={[
            { type: 'STEPS', value: summary?.STEPS, unit: 'steps', goal: 10000 },
            { type: 'DISTANCE', value: summary?.DISTANCE, unit: 'km', format: (v) => (v / 1000).toFixed(1) },
            { type: 'ACTIVE_ENERGY', value: summary?.ACTIVE_ENERGY, unit: 'kcal', goal: 500 },
          ]}
          icon={<ActivityIcon />}
          color="green"
        />

        {/* Vitals section */}
        <VitalsCard
          heartRate={summary?.HEART_RATE}
          restingHeartRate={summary?.RESTING_HEART_RATE}
          bloodOxygen={summary?.OXYGEN_SATURATION}
        />

        {/* Sleep section */}
        <SleepCard
          sleepMinutes={summary?.SLEEP_ANALYSIS}
          className="md:col-span-2 lg:col-span-1"
        />

        {/* Weight section */}
        <WeightCard
          weight={summary?.WEIGHT}
          bodyFat={summary?.BODY_FAT}
        />
      </div>
    </div>
  );
}
```

### Metric Card Component

```tsx
// components/dashboard/DailySummaryCard.tsx
interface MetricDisplay {
  type: string;
  value: number | undefined;
  unit: string;
  goal?: number;
  format?: (value: number) => string;
}

interface DailySummaryCardProps {
  title: string;
  metrics: MetricDisplay[];
  icon: React.ReactNode;
  color: 'green' | 'red' | 'blue' | 'purple';
}

const colorClasses = {
  green: 'bg-green-50 border-green-200 text-green-800',
  red: 'bg-red-50 border-red-200 text-red-800',
  blue: 'bg-blue-50 border-blue-200 text-blue-800',
  purple: 'bg-purple-50 border-purple-200 text-purple-800',
};

export function DailySummaryCard({ title, metrics, icon, color }: DailySummaryCardProps) {
  return (
    <div className={`rounded-xl border-2 p-6 ${colorClasses[color]}`}>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-white/50">
          {icon}
        </div>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>

      <div className="space-y-4">
        {metrics.map((metric) => (
          <MetricRow key={metric.type} metric={metric} />
        ))}
      </div>
    </div>
  );
}

function MetricRow({ metric }: { metric: MetricDisplay }) {
  const value = metric.value ?? 0;
  const displayValue = metric.format ? metric.format(value) : value.toLocaleString();
  const progress = metric.goal ? Math.min((value / metric.goal) * 100, 100) : null;

  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-sm font-medium opacity-80">
          {formatMetricName(metric.type)}
        </span>
        <span className="text-xl font-bold">
          {displayValue}
          <span className="text-sm font-normal ml-1 opacity-70">{metric.unit}</span>
        </span>
      </div>

      {progress !== null && (
        <div className="h-2 bg-white/30 rounded-full overflow-hidden">
          <div
            className="h-full bg-current rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
            role="progressbar"
            aria-valuenow={value}
            aria-valuemax={metric.goal}
            aria-label={`${formatMetricName(metric.type)} progress`}
          />
        </div>
      )}
    </div>
  );
}
```

## Deep Dive: Trend Charts with Recharts (8 minutes)

### TrendChart Component

```tsx
// components/charts/TrendChart.tsx
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { format, parseISO } from 'date-fns';

interface TrendChartProps {
  data: Array<{ date: string; value: number }>;
  metricType: string;
  dateRange: '7d' | '30d' | '90d' | '1y';
  color?: string;
  showTrendLine?: boolean;
}

export function TrendChart({
  data,
  metricType,
  dateRange,
  color = '#3b82f6',
  showTrendLine = true,
}: TrendChartProps) {
  const config = getMetricConfig(metricType);

  // Calculate trend line using linear regression
  const trendLine = useMemo(() => {
    if (!showTrendLine || data.length < 7) return null;
    return calculateTrendLine(data);
  }, [data, showTrendLine]);

  // Format date based on range
  const formatDate = (dateStr: string) => {
    const date = parseISO(dateStr);
    switch (dateRange) {
      case '7d':
        return format(date, 'EEE');  // Mon, Tue, etc.
      case '30d':
        return format(date, 'MMM d');  // Jan 5
      case '90d':
      case '1y':
        return format(date, 'MMM');  // Jan
      default:
        return format(date, 'MMM d');
    }
  };

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            stroke="#9ca3af"
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
          />
          <YAxis
            stroke="#9ca3af"
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            domain={config.domain || ['auto', 'auto']}
            tickFormatter={(v) => config.formatValue?.(v) ?? v}
          />
          <Tooltip
            content={<CustomTooltip metricType={metricType} />}
          />

          {/* Main data line */}
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={dateRange === '7d'}
            activeDot={{ r: 6, fill: color }}
          />

          {/* Trend line overlay */}
          {trendLine && (
            <ReferenceLine
              segment={trendLine}
              stroke={color}
              strokeDasharray="5 5"
              strokeOpacity={0.5}
            />
          )}

          {/* Goal reference line for applicable metrics */}
          {config.goal && (
            <ReferenceLine
              y={config.goal}
              stroke="#22c55e"
              strokeDasharray="3 3"
              label={{ value: 'Goal', position: 'right', fill: '#22c55e' }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Custom tooltip for better formatting
function CustomTooltip({ active, payload, label, metricType }: any) {
  if (!active || !payload?.length) return null;

  const config = getMetricConfig(metricType);
  const value = payload[0].value;

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3">
      <p className="text-sm text-gray-500 mb-1">
        {format(parseISO(label), 'EEEE, MMMM d')}
      </p>
      <p className="text-lg font-bold text-gray-900">
        {config.formatValue?.(value) ?? value.toLocaleString()}
        <span className="text-sm font-normal text-gray-500 ml-1">
          {config.unit}
        </span>
      </p>
    </div>
  );
}
```

### Metric Configuration

```tsx
// utils/metricConfig.ts
interface MetricConfig {
  displayName: string;
  unit: string;
  color: string;
  domain?: [number | 'auto', number | 'auto'];
  goal?: number;
  formatValue?: (value: number) => string;
}

const metricConfigs: Record<string, MetricConfig> = {
  STEPS: {
    displayName: 'Steps',
    unit: 'steps',
    color: '#22c55e',
    goal: 10000,
    formatValue: (v) => v.toLocaleString(),
  },
  HEART_RATE: {
    displayName: 'Heart Rate',
    unit: 'bpm',
    color: '#ef4444',
    domain: [40, 120],
    formatValue: (v) => Math.round(v).toString(),
  },
  RESTING_HEART_RATE: {
    displayName: 'Resting Heart Rate',
    unit: 'bpm',
    color: '#f97316',
    domain: [40, 100],
  },
  SLEEP_ANALYSIS: {
    displayName: 'Sleep',
    unit: 'hours',
    color: '#8b5cf6',
    goal: 8,
    formatValue: (v) => (v / 60).toFixed(1),  // Convert minutes to hours
  },
  WEIGHT: {
    displayName: 'Weight',
    unit: 'kg',
    color: '#3b82f6',
    formatValue: (v) => v.toFixed(1),
  },
  DISTANCE: {
    displayName: 'Distance',
    unit: 'km',
    color: '#06b6d4',
    formatValue: (v) => (v / 1000).toFixed(2),
  },
  ACTIVE_ENERGY: {
    displayName: 'Active Calories',
    unit: 'kcal',
    color: '#eab308',
    goal: 500,
  },
  OXYGEN_SATURATION: {
    displayName: 'Blood Oxygen',
    unit: '%',
    color: '#0ea5e9',
    domain: [90, 100],
  },
};

export function getMetricConfig(type: string): MetricConfig {
  return metricConfigs[type] || {
    displayName: type,
    unit: '',
    color: '#6b7280',
  };
}
```

## Deep Dive: Zustand Health Store (8 minutes)

### Store Structure

```tsx
// stores/healthStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { format, subDays, startOfDay } from 'date-fns';

interface DateRange {
  start: Date;
  end: Date;
}

interface HealthState {
  // Current view date
  selectedDate: Date;

  // Date range for trends
  dateRange: DateRange;
  dateRangePreset: '7d' | '30d' | '90d' | '1y' | 'custom';

  // Cached data
  dailySummary: Record<string, number> | null;
  aggregates: Record<string, Array<{ date: string; value: number }>>;
  insights: Insight[];

  // Loading states
  isLoadingSummary: boolean;
  isLoadingAggregates: boolean;

  // Actions
  setSelectedDate: (date: Date) => void;
  setDateRange: (range: DateRange) => void;
  setDateRangePreset: (preset: '7d' | '30d' | '90d' | '1y') => void;
  fetchDailySummary: (date: Date) => Promise<void>;
  fetchAggregates: (types: string[], range: DateRange) => Promise<void>;
  fetchInsights: () => Promise<void>;
}

export const useHealthStore = create<HealthState>()(
  persist(
    (set, get) => ({
      selectedDate: startOfDay(new Date()),
      dateRange: {
        start: subDays(new Date(), 7),
        end: new Date(),
      },
      dateRangePreset: '7d',
      dailySummary: null,
      aggregates: {},
      insights: [],
      isLoadingSummary: false,
      isLoadingAggregates: false,

      setSelectedDate: (date) => {
        set({ selectedDate: startOfDay(date) });
        get().fetchDailySummary(date);
      },

      setDateRange: (range) => {
        set({ dateRange: range, dateRangePreset: 'custom' });
      },

      setDateRangePreset: (preset) => {
        const end = new Date();
        let start: Date;

        switch (preset) {
          case '7d':
            start = subDays(end, 7);
            break;
          case '30d':
            start = subDays(end, 30);
            break;
          case '90d':
            start = subDays(end, 90);
            break;
          case '1y':
            start = subDays(end, 365);
            break;
        }

        set({
          dateRangePreset: preset,
          dateRange: { start, end },
        });
      },

      fetchDailySummary: async (date) => {
        set({ isLoadingSummary: true });
        try {
          const response = await fetch(
            `/api/v1/users/me/summary?date=${format(date, 'yyyy-MM-dd')}`
          );
          const summary = await response.json();
          set({ dailySummary: summary, isLoadingSummary: false });
        } catch (error) {
          console.error('Failed to fetch summary:', error);
          set({ isLoadingSummary: false });
        }
      },

      fetchAggregates: async (types, range) => {
        set({ isLoadingAggregates: true });
        try {
          const params = new URLSearchParams({
            types: types.join(','),
            period: 'day',
            startDate: format(range.start, 'yyyy-MM-dd'),
            endDate: format(range.end, 'yyyy-MM-dd'),
          });

          const response = await fetch(`/api/v1/users/me/aggregates?${params}`);
          const data = await response.json();

          // Transform to chart-friendly format
          const aggregates: Record<string, Array<{ date: string; value: number }>> = {};
          for (const [type, values] of Object.entries(data)) {
            aggregates[type] = (values as any[]).map((v) => ({
              date: v.date,
              value: v.value,
            }));
          }

          set({ aggregates, isLoadingAggregates: false });
        } catch (error) {
          console.error('Failed to fetch aggregates:', error);
          set({ isLoadingAggregates: false });
        }
      },

      fetchInsights: async () => {
        try {
          const response = await fetch('/api/v1/users/me/insights');
          const insights = await response.json();
          set({ insights });
        } catch (error) {
          console.error('Failed to fetch insights:', error);
        }
      },
    }),
    {
      name: 'health-store',
      partialize: (state) => ({
        dateRangePreset: state.dateRangePreset,
        // Don't persist data, only preferences
      }),
    }
  )
);
```

### Sync Status Store

```tsx
// stores/syncStore.ts
import { create } from 'zustand';

interface SyncState {
  devices: Array<{
    id: string;
    name: string;
    type: string;
    lastSync: Date | null;
    isSyncing: boolean;
  }>;
  overallStatus: 'synced' | 'syncing' | 'error' | 'offline';

  updateDeviceSync: (deviceId: string, status: Partial<SyncState['devices'][0]>) => void;
  setOverallStatus: (status: SyncState['overallStatus']) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  devices: [],
  overallStatus: 'synced',

  updateDeviceSync: (deviceId, status) =>
    set((state) => ({
      devices: state.devices.map((d) =>
        d.id === deviceId ? { ...d, ...status } : d
      ),
    })),

  setOverallStatus: (status) => set({ overallStatus: status }),
}));
```

## Deep Dive: Insights Display (5 minutes)

### Insights Preview Component

```tsx
// components/dashboard/InsightsPreview.tsx
import { AlertTriangle, TrendingUp, TrendingDown, Moon, Activity } from 'lucide-react';

interface Insight {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  direction?: 'increasing' | 'decreasing';
  message: string;
  recommendation?: string;
}

interface InsightsPreviewProps {
  insights: Insight[];
  className?: string;
}

export function InsightsPreview({ insights, className }: InsightsPreviewProps) {
  // Show up to 3 most important insights
  const topInsights = insights
    .sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity))
    .slice(0, 3);

  return (
    <div className={`space-y-3 ${className}`}>
      {topInsights.map((insight) => (
        <InsightCard key={insight.id} insight={insight} />
      ))}
    </div>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  const { icon, bgColor, borderColor, textColor } = getInsightStyle(insight);

  return (
    <div
      className={`rounded-lg border-l-4 p-4 ${bgColor} ${borderColor}`}
      role="alert"
      aria-label={`Health insight: ${insight.message}`}
    >
      <div className="flex items-start gap-3">
        <div className={`p-1 rounded ${textColor}`}>
          {icon}
        </div>
        <div className="flex-1">
          <p className={`font-medium ${textColor}`}>
            {insight.message}
          </p>
          {insight.recommendation && (
            <p className="text-sm text-gray-600 mt-1">
              {insight.recommendation}
            </p>
          )}
        </div>
        <button
          className="text-gray-400 hover:text-gray-600"
          aria-label="Dismiss insight"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function getInsightStyle(insight: Insight) {
  const baseStyles = {
    high: {
      bgColor: 'bg-red-50',
      borderColor: 'border-red-500',
      textColor: 'text-red-800',
    },
    medium: {
      bgColor: 'bg-yellow-50',
      borderColor: 'border-yellow-500',
      textColor: 'text-yellow-800',
    },
    low: {
      bgColor: 'bg-blue-50',
      borderColor: 'border-blue-500',
      textColor: 'text-blue-800',
    },
  };

  const style = baseStyles[insight.severity];

  // Choose icon based on insight type
  let icon;
  switch (insight.type) {
    case 'HEART_RATE_TREND':
      icon = insight.direction === 'increasing'
        ? <TrendingUp className="w-5 h-5" />
        : <TrendingDown className="w-5 h-5" />;
      break;
    case 'SLEEP_DEFICIT':
      icon = <Moon className="w-5 h-5" />;
      break;
    case 'ACTIVITY_CHANGE':
      icon = <Activity className="w-5 h-5" />;
      break;
    default:
      icon = <AlertTriangle className="w-5 h-5" />;
  }

  return { ...style, icon };
}

function severityOrder(severity: string): number {
  return { high: 3, medium: 2, low: 1 }[severity] || 0;
}
```

## Deep Dive: Date Range Selector (3 minutes)

```tsx
// components/DateRangeSelector.tsx
import { format } from 'date-fns';
import { useHealthStore } from '../stores/healthStore';

export function DateRangeSelector() {
  const {
    dateRangePreset,
    dateRange,
    setDateRangePreset,
    setDateRange,
  } = useHealthStore();

  const presets = [
    { value: '7d', label: '7 Days' },
    { value: '30d', label: '30 Days' },
    { value: '90d', label: '90 Days' },
    { value: '1y', label: '1 Year' },
  ] as const;

  return (
    <div className="flex items-center gap-2">
      {/* Preset buttons */}
      <div className="flex bg-gray-100 rounded-lg p-1">
        {presets.map((preset) => (
          <button
            key={preset.value}
            onClick={() => setDateRangePreset(preset.value)}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              dateRangePreset === preset.value
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
            aria-pressed={dateRangePreset === preset.value}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Date range display */}
      <span className="text-sm text-gray-500">
        {format(dateRange.start, 'MMM d')} - {format(dateRange.end, 'MMM d, yyyy')}
      </span>
    </div>
  );
}
```

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Chart Library | Recharts | D3.js, Chart.js | React-native, declarative API, good TypeScript support |
| State Management | Zustand | Redux, Context | Minimal boilerplate, built-in persistence, no providers needed |
| Date Library | date-fns | Moment, Day.js | Tree-shakeable, immutable, comprehensive API |
| Styling | Tailwind CSS | CSS Modules, styled-components | Utility-first for rapid prototyping, consistent design system |
| Data Fetching | Custom hooks | React Query | Simpler for this use case, less dependency |

### Chart Performance Trade-offs

**SVG Charts (Recharts) - Chosen**
- Pro: Crisp at any resolution, easy tooltips and interactions
- Pro: Declarative React components
- Con: Performance degrades with 1000+ data points

**Canvas Charts (Alternative)**
- Pro: Better performance for large datasets
- Con: No native DOM events, harder to make accessible

**Mitigation**: For 1-year views with 365 data points, SVG is sufficient. For minute-level data, aggregate to hourly before rendering.

### Data Aggregation Strategy

**Aggregate on Server (Chosen)**
- Pro: Smaller payloads, consistent aggregation logic
- Pro: Can request different periods (hour, day, week)
- Con: Additional API calls when changing granularity

**Raw Data with Client Aggregation**
- Pro: More flexible visualizations
- Con: Large payloads (1,440 points/day for heart rate)
- Con: Inconsistent aggregation across clients

## Accessibility Considerations (2 minutes)

### Screen Reader Support

```tsx
// Chart with accessible description
<TrendChart
  data={data}
  metricType="STEPS"
  aria-label={`Steps trend chart showing ${data.length} days of data`}
/>

// Progress bars with ARIA
<div
  role="progressbar"
  aria-valuenow={steps}
  aria-valuemax={10000}
  aria-label={`${steps.toLocaleString()} of 10,000 steps`}
/>

// Insight alerts
<div role="alert" aria-live="polite">
  {insight.message}
</div>
```

### Color Contrast and Patterns

```tsx
// Use patterns in addition to colors for colorblind users
const CHART_PATTERNS = {
  STEPS: { color: '#22c55e', pattern: 'solid' },
  HEART_RATE: { color: '#ef4444', pattern: 'dashed' },
  SLEEP: { color: '#8b5cf6', pattern: 'dotted' },
};
```

## Closing Summary (1 minute)

"The health data pipeline frontend is built around three key principles:

1. **Dashboard-first design** - The daily summary provides an at-a-glance view of key health metrics with progress indicators toward goals. Insights are prominently displayed to surface AI-generated recommendations.

2. **Responsive chart visualizations** - Recharts provides declarative, React-native charts for trend analysis. Date range presets (7d, 30d, 90d, 1y) enable quick navigation through historical data with appropriate date formatting for each range.

3. **Zustand for health state** - A single store manages date selection, cached aggregates, and insights with persist middleware for user preferences. This enables consistent state across the dashboard, trends, and insights views.

The main trade-off is simplicity versus flexibility. Server-side aggregation means smaller payloads and consistent data, but requires additional API calls when users want different time granularities. For a health dashboard where users typically view daily aggregates, this trade-off favors simpler client code."
