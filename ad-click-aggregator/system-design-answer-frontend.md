# Ad Click Aggregator - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend dashboard for a real-time ad click analytics system. Key challenges include:
- Real-time data visualization with high-frequency updates
- Interactive time-series charts with multiple granularities
- Responsive layout for analytics dashboards
- Efficient state management for complex filter combinations
- Performance optimization for large datasets

## Requirements Clarification

### Functional Requirements
1. **Real-time Metrics Display**: Show live click counts, fraud rates, unique users
2. **Time-Series Charts**: Visualize clicks over time with zoom/pan capabilities
3. **Campaign Analytics**: Drill-down by campaign, ad, country, device
4. **Test Click Generator**: Development tool for simulating clicks
5. **Filter Controls**: Date range, campaign, country, device type selectors

### Non-Functional Requirements
1. **Update Frequency**: Dashboard refreshes every 5 seconds
2. **Chart Performance**: Render 10,000+ data points without lag
3. **Responsiveness**: Support desktop and tablet viewports
4. **Accessibility**: WCAG 2.1 AA compliance for analytics tools

### Scale Estimates
- Dashboard users: 100-1,000 concurrent
- Data points per chart: Up to 10,000 (minute-level for 7 days)
- Refresh interval: 5 seconds
- Network payload: ~50KB per refresh (aggregated data)

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      React Application                               │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  Dashboard  │  │  Campaign   │  │   Charts    │  │   Filters   │ │
│  │   Layout    │  │   Table     │  │  (Recharts) │  │   Panel     │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│                     Zustand State Store                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │   Metrics Data  │  │  Filter State   │  │  UI State (modals)  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│                     API Service Layer                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  /api/analytics │  │  /api/clicks    │  │  Auto-refresh Hook  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Real-Time Dashboard State

### Zustand Store Architecture

```typescript
// stores/analyticsStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface TimeRange {
  start: Date;
  end: Date;
  granularity: 'minute' | 'hour' | 'day';
}

interface Filters {
  campaignId: string | null;
  advertiserId: string | null;
  country: string | null;
  deviceType: string | null;
}

interface MetricsData {
  totalClicks: number;
  uniqueUsers: number;
  fraudRate: number;
  timeSeries: TimeSeriesPoint[];
  byCampaign: CampaignMetrics[];
  byCountry: CountryMetrics[];
}

interface AnalyticsState {
  // Data
  metrics: MetricsData | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;

  // Filters
  timeRange: TimeRange;
  filters: Filters;

  // Actions
  setTimeRange: (range: TimeRange) => void;
  setFilters: (filters: Partial<Filters>) => void;
  fetchMetrics: () => Promise<void>;
  startAutoRefresh: () => () => void;
}

export const useAnalyticsStore = create<AnalyticsState>()(
  subscribeWithSelector((set, get) => ({
    metrics: null,
    isLoading: false,
    error: null,
    lastUpdated: null,

    timeRange: {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: new Date(),
      granularity: 'hour',
    },

    filters: {
      campaignId: null,
      advertiserId: null,
      country: null,
      deviceType: null,
    },

    setTimeRange: (range) => set({ timeRange: range }),

    setFilters: (newFilters) =>
      set((state) => ({
        filters: { ...state.filters, ...newFilters },
      })),

    fetchMetrics: async () => {
      set({ isLoading: true, error: null });
      try {
        const { timeRange, filters } = get();
        const params = new URLSearchParams({
          start_time: timeRange.start.toISOString(),
          end_time: timeRange.end.toISOString(),
          granularity: timeRange.granularity,
          ...(filters.campaignId && { campaign_id: filters.campaignId }),
          ...(filters.country && { country: filters.country }),
        });

        const response = await fetch(`/api/v1/analytics/aggregate?${params}`);
        const data = await response.json();

        set({
          metrics: transformApiResponse(data),
          lastUpdated: new Date(),
          isLoading: false,
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    startAutoRefresh: () => {
      const interval = setInterval(() => {
        get().fetchMetrics();
      }, 5000);

      return () => clearInterval(interval);
    },
  }))
);
```

### Auto-Refresh Hook

```typescript
// hooks/useAutoRefresh.ts
import { useEffect, useRef } from 'react';
import { useAnalyticsStore } from '../stores/analyticsStore';

export function useAutoRefresh(enabled: boolean = true) {
  const fetchMetrics = useAnalyticsStore((state) => state.fetchMetrics);
  const timeRange = useAnalyticsStore((state) => state.timeRange);
  const filters = useAnalyticsStore((state) => state.filters);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Initial fetch
    fetchMetrics();

    if (enabled) {
      intervalRef.current = setInterval(fetchMetrics, 5000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [enabled, fetchMetrics]);

  // Refetch when filters change
  useEffect(() => {
    fetchMetrics();
  }, [timeRange, filters, fetchMetrics]);
}
```

## Deep Dive: Time-Series Visualization

### Recharts Integration

```tsx
// components/ClicksChart.tsx
import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Brush,
} from 'recharts';
import { useAnalyticsStore } from '../stores/analyticsStore';

interface ChartDataPoint {
  timestamp: number;
  clicks: number;
  uniqueUsers: number;
  fraudClicks: number;
}

export function ClicksChart() {
  const timeSeries = useAnalyticsStore((state) => state.metrics?.timeSeries);
  const granularity = useAnalyticsStore((state) => state.timeRange.granularity);

  // Memoize chart data transformation
  const chartData = useMemo(() => {
    if (!timeSeries) return [];

    return timeSeries.map((point) => ({
      timestamp: new Date(point.time_bucket).getTime(),
      clicks: point.click_count,
      uniqueUsers: point.unique_users,
      fraudClicks: point.fraud_count,
    }));
  }, [timeSeries]);

  // Format x-axis based on granularity
  const formatXAxis = (timestamp: number) => {
    const date = new Date(timestamp);
    switch (granularity) {
      case 'minute':
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      case 'hour':
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      case 'day':
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      default:
        return date.toISOString();
    }
  };

  if (!chartData.length) {
    return (
      <div className="flex h-80 items-center justify-center text-gray-500">
        No data available for the selected time range
      </div>
    );
  }

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.8} />
              <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorFraud" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#EF4444" stopOpacity={0.8} />
              <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200" />
          <XAxis
            dataKey="timestamp"
            tickFormatter={formatXAxis}
            tick={{ fontSize: 12 }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(value) => value.toLocaleString()}
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ stroke: '#6B7280', strokeDasharray: '5 5' }}
          />
          <Area
            type="monotone"
            dataKey="clicks"
            stroke="#3B82F6"
            fillOpacity={1}
            fill="url(#colorClicks)"
            name="Total Clicks"
          />
          <Area
            type="monotone"
            dataKey="fraudClicks"
            stroke="#EF4444"
            fillOpacity={1}
            fill="url(#colorFraud)"
            name="Fraud Clicks"
          />
          {/* Brush for zoom/pan on large datasets */}
          <Brush
            dataKey="timestamp"
            height={30}
            stroke="#3B82F6"
            tickFormatter={formatXAxis}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  const date = new Date(label);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
      <p className="mb-2 text-sm font-medium text-gray-600">
        {date.toLocaleString()}
      </p>
      {payload.map((entry: any, index: number) => (
        <p key={index} className="text-sm" style={{ color: entry.stroke }}>
          {entry.name}: {entry.value.toLocaleString()}
        </p>
      ))}
      {payload[0] && payload[1] && (
        <p className="mt-2 text-xs text-gray-500">
          Fraud Rate: {((payload[1].value / payload[0].value) * 100).toFixed(2)}%
        </p>
      )}
    </div>
  );
}
```

### Chart Performance Optimization

```tsx
// hooks/useChartData.ts
import { useMemo, useCallback } from 'react';

export function useChartData(rawData: TimeSeriesPoint[], maxPoints: number = 500) {
  // Downsample data for performance
  const downsampledData = useMemo(() => {
    if (rawData.length <= maxPoints) return rawData;

    const step = Math.ceil(rawData.length / maxPoints);
    return rawData.filter((_, index) => index % step === 0);
  }, [rawData, maxPoints]);

  // Memoize expensive calculations
  const statistics = useMemo(() => {
    if (!rawData.length) return null;

    const totalClicks = rawData.reduce((sum, p) => sum + p.click_count, 0);
    const totalFraud = rawData.reduce((sum, p) => sum + p.fraud_count, 0);
    const avgClicksPerBucket = totalClicks / rawData.length;
    const maxClicks = Math.max(...rawData.map((p) => p.click_count));

    return {
      totalClicks,
      totalFraud,
      avgClicksPerBucket,
      maxClicks,
      fraudRate: (totalFraud / totalClicks) * 100,
    };
  }, [rawData]);

  return { downsampledData, statistics };
}
```

## Deep Dive: Dashboard Layout

### Responsive Grid System

```tsx
// components/DashboardLayout.tsx
export function DashboardLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">
            Ad Click Analytics
          </h1>
          <div className="flex items-center gap-4">
            <LastUpdatedIndicator />
            <RefreshButton />
          </div>
        </div>
      </header>

      {/* Filters Bar */}
      <div className="border-b border-gray-200 bg-white px-6 py-3">
        <FilterControls />
      </div>

      {/* Main Content */}
      <main className="p-6">
        {/* KPI Cards */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Total Clicks"
            metric="totalClicks"
            format="number"
            icon={<ClickIcon />}
          />
          <MetricCard
            title="Unique Users"
            metric="uniqueUsers"
            format="number"
            icon={<UsersIcon />}
          />
          <MetricCard
            title="Fraud Rate"
            metric="fraudRate"
            format="percent"
            icon={<AlertIcon />}
            threshold={{ warning: 3, critical: 5 }}
          />
          <MetricCard
            title="Avg. Clicks/Min"
            metric="avgClicksPerMinute"
            format="number"
            icon={<ChartIcon />}
          />
        </div>

        {/* Charts Row */}
        <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Clicks Over Time">
            <ClicksChart />
          </Card>
          <Card title="Geographic Distribution">
            <CountryChart />
          </Card>
        </div>

        {/* Tables Row */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Campaign Performance">
            <CampaignTable />
          </Card>
          <Card title="Recent Fraud Detections">
            <FraudTable />
          </Card>
        </div>
      </main>
    </div>
  );
}
```

### Metric Card Component

```tsx
// components/MetricCard.tsx
import { useAnalyticsStore } from '../stores/analyticsStore';
import { cn } from '../utils/cn';

interface MetricCardProps {
  title: string;
  metric: keyof MetricsData;
  format: 'number' | 'percent' | 'currency';
  icon: React.ReactNode;
  threshold?: { warning: number; critical: number };
}

export function MetricCard({ title, metric, format, icon, threshold }: MetricCardProps) {
  const value = useAnalyticsStore((state) => state.metrics?.[metric] ?? 0);
  const isLoading = useAnalyticsStore((state) => state.isLoading);

  const formattedValue = formatValue(value as number, format);

  const status = threshold
    ? getThresholdStatus(value as number, threshold)
    : 'normal';

  return (
    <div
      className={cn(
        'rounded-lg border bg-white p-6 shadow-sm',
        status === 'critical' && 'border-red-300 bg-red-50',
        status === 'warning' && 'border-yellow-300 bg-yellow-50'
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-gray-500">{icon}</div>
        {status !== 'normal' && (
          <span
            className={cn(
              'rounded-full px-2 py-1 text-xs font-medium',
              status === 'critical' && 'bg-red-100 text-red-700',
              status === 'warning' && 'bg-yellow-100 text-yellow-700'
            )}
          >
            {status === 'critical' ? 'Critical' : 'Warning'}
          </span>
        )}
      </div>
      <div className="mt-4">
        <p className="text-sm font-medium text-gray-600">{title}</p>
        {isLoading ? (
          <div className="mt-1 h-8 w-24 animate-pulse rounded bg-gray-200" />
        ) : (
          <p className="mt-1 text-3xl font-semibold text-gray-900">
            {formattedValue}
          </p>
        )}
      </div>
    </div>
  );
}

function formatValue(value: number, format: 'number' | 'percent' | 'currency') {
  switch (format) {
    case 'number':
      return value.toLocaleString();
    case 'percent':
      return `${value.toFixed(2)}%`;
    case 'currency':
      return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }
}

function getThresholdStatus(
  value: number,
  threshold: { warning: number; critical: number }
): 'normal' | 'warning' | 'critical' {
  if (value >= threshold.critical) return 'critical';
  if (value >= threshold.warning) return 'warning';
  return 'normal';
}
```

## Deep Dive: Filter Controls

### Date Range Picker

```tsx
// components/DateRangePicker.tsx
import { useState, useCallback } from 'react';
import { useAnalyticsStore } from '../stores/analyticsStore';

const PRESETS = [
  { label: 'Last Hour', hours: 1, granularity: 'minute' as const },
  { label: 'Last 24 Hours', hours: 24, granularity: 'hour' as const },
  { label: 'Last 7 Days', hours: 168, granularity: 'hour' as const },
  { label: 'Last 30 Days', hours: 720, granularity: 'day' as const },
];

export function DateRangePicker() {
  const timeRange = useAnalyticsStore((state) => state.timeRange);
  const setTimeRange = useAnalyticsStore((state) => state.setTimeRange);
  const [activePreset, setActivePreset] = useState<number>(1); // Default: Last 24 Hours

  const handlePresetClick = useCallback((preset: typeof PRESETS[0], index: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - preset.hours * 60 * 60 * 1000);

    setTimeRange({
      start,
      end,
      granularity: preset.granularity,
    });
    setActivePreset(index);
  }, [setTimeRange]);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-600">Time Range:</span>
      <div className="flex rounded-lg border border-gray-200 bg-white p-1">
        {PRESETS.map((preset, index) => (
          <button
            key={preset.label}
            onClick={() => handlePresetClick(preset, index)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              activePreset === index
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-600 hover:bg-gray-100'
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

### Campaign Filter Dropdown

```tsx
// components/CampaignFilter.tsx
import { useState, useEffect } from 'react';
import { useAnalyticsStore } from '../stores/analyticsStore';

interface Campaign {
  id: string;
  name: string;
  advertiser_name: string;
}

export function CampaignFilter() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedCampaignId = useAnalyticsStore((state) => state.filters.campaignId);
  const setFilters = useAnalyticsStore((state) => state.setFilters);

  useEffect(() => {
    fetch('/api/v1/campaigns')
      .then((res) => res.json())
      .then((data) => setCampaigns(data.campaigns));
  }, []);

  const filteredCampaigns = campaigns.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.advertiser_name.toLowerCase().includes(search.toLowerCase())
  );

  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm"
      >
        <span className="text-gray-600">Campaign:</span>
        <span className="font-medium">
          {selectedCampaign?.name ?? 'All Campaigns'}
        </span>
        <ChevronDownIcon className="h-4 w-4" />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="border-b p-2">
            <input
              type="text"
              placeholder="Search campaigns..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-2">
            <button
              onClick={() => {
                setFilters({ campaignId: null });
                setIsOpen(false);
              }}
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-gray-100"
            >
              All Campaigns
            </button>
            {filteredCampaigns.map((campaign) => (
              <button
                key={campaign.id}
                onClick={() => {
                  setFilters({ campaignId: campaign.id });
                  setIsOpen(false);
                }}
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left text-sm hover:bg-gray-100',
                  campaign.id === selectedCampaignId && 'bg-blue-50'
                )}
              >
                <p className="font-medium">{campaign.name}</p>
                <p className="text-xs text-gray-500">{campaign.advertiser_name}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

## Deep Dive: Test Click Generator

### Developer Tool Component

```tsx
// components/TestClickGenerator.tsx
import { useState, useCallback } from 'react';

const COUNTRIES = ['US', 'UK', 'DE', 'FR', 'JP', 'CA', 'AU', 'BR'];
const DEVICES = ['mobile', 'desktop', 'tablet'];

export function TestClickGenerator() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [clicksPerSecond, setClicksPerSecond] = useState(10);
  const [duration, setDuration] = useState(10);
  const [stats, setStats] = useState({ sent: 0, success: 0, duplicate: 0, fraud: 0 });

  const generateClicks = useCallback(async () => {
    setIsGenerating(true);
    setStats({ sent: 0, success: 0, duplicate: 0, fraud: 0 });

    const totalClicks = clicksPerSecond * duration;
    const interval = 1000 / clicksPerSecond;

    for (let i = 0; i < totalClicks; i++) {
      const click = {
        ad_id: `ad_${Math.floor(Math.random() * 10)}`,
        campaign_id: `camp_${Math.floor(Math.random() * 5)}`,
        advertiser_id: `adv_${Math.floor(Math.random() * 3)}`,
        country: COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)],
        device_type: DEVICES[Math.floor(Math.random() * DEVICES.length)],
      };

      try {
        const response = await fetch('/api/v1/clicks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(click),
        });

        const result = await response.json();

        setStats((prev) => ({
          sent: prev.sent + 1,
          success: prev.success + (result.success && !result.is_duplicate ? 1 : 0),
          duplicate: prev.duplicate + (result.is_duplicate ? 1 : 0),
          fraud: prev.fraud + (result.is_fraudulent ? 1 : 0),
        }));
      } catch (error) {
        console.error('Click generation error:', error);
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    setIsGenerating(false);
  }, [clicksPerSecond, duration]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="mb-4 text-lg font-semibold">Test Click Generator</h3>

      <div className="mb-4 grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm text-gray-600">Clicks/Second</label>
          <input
            type="range"
            min={1}
            max={100}
            value={clicksPerSecond}
            onChange={(e) => setClicksPerSecond(Number(e.target.value))}
            className="w-full"
            disabled={isGenerating}
          />
          <span className="text-sm font-medium">{clicksPerSecond}</span>
        </div>
        <div>
          <label className="text-sm text-gray-600">Duration (seconds)</label>
          <input
            type="range"
            min={5}
            max={60}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full"
            disabled={isGenerating}
          />
          <span className="text-sm font-medium">{duration}s</span>
        </div>
      </div>

      <button
        onClick={generateClicks}
        disabled={isGenerating}
        className={cn(
          'w-full rounded-lg px-4 py-2 font-medium text-white',
          isGenerating ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
        )}
      >
        {isGenerating ? `Generating... (${stats.sent} sent)` : 'Generate Test Clicks'}
      </button>

      {stats.sent > 0 && (
        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          <div className="rounded bg-gray-100 p-2">
            <p className="text-xs text-gray-600">Sent</p>
            <p className="text-lg font-semibold">{stats.sent}</p>
          </div>
          <div className="rounded bg-green-100 p-2">
            <p className="text-xs text-gray-600">Success</p>
            <p className="text-lg font-semibold text-green-700">{stats.success}</p>
          </div>
          <div className="rounded bg-yellow-100 p-2">
            <p className="text-xs text-gray-600">Duplicate</p>
            <p className="text-lg font-semibold text-yellow-700">{stats.duplicate}</p>
          </div>
          <div className="rounded bg-red-100 p-2">
            <p className="text-xs text-gray-600">Fraud</p>
            <p className="text-lg font-semibold text-red-700">{stats.fraud}</p>
          </div>
        </div>
      )}
    </div>
  );
}
```

## Accessibility Considerations

### ARIA Labels and Keyboard Navigation

```tsx
// components/AccessibleChart.tsx
export function AccessibleChart({ data, title }: { data: ChartData[]; title: string }) {
  const summaryRef = useRef<HTMLParagraphElement>(null);

  // Generate text summary for screen readers
  const summary = useMemo(() => {
    const total = data.reduce((sum, d) => sum + d.clicks, 0);
    const max = Math.max(...data.map((d) => d.clicks));
    const maxDate = data.find((d) => d.clicks === max);

    return `${title}: Total ${total.toLocaleString()} clicks. Peak of ${max.toLocaleString()} clicks occurred at ${new Date(maxDate!.timestamp).toLocaleString()}.`;
  }, [data, title]);

  return (
    <div role="figure" aria-labelledby="chart-title" aria-describedby="chart-summary">
      <h3 id="chart-title" className="sr-only">{title}</h3>
      <p id="chart-summary" ref={summaryRef} className="sr-only">
        {summary}
      </p>
      <div aria-hidden="true">
        <ResponsiveContainer>
          <AreaChart data={data}>
            {/* Chart implementation */}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* Accessible data table alternative */}
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-blue-600">
          View data as table
        </summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Clicks</th>
              <th scope="col">Unique Users</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i}>
                <td>{new Date(row.timestamp).toLocaleString()}</td>
                <td>{row.clicks.toLocaleString()}</td>
                <td>{row.uniqueUsers.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Zustand over Context | Simple API, selective subscriptions | Learning curve for team |
| Recharts | Easy integration, responsive | Less customizable than D3 |
| 5-second refresh interval | Near real-time updates | Network overhead |
| Client-side downsampling | Smooth chart rendering | Data loss in detailed view |
| Tailwind CSS | Rapid prototyping, consistent | Large class strings |

## Future Frontend Enhancements

1. **WebSocket Updates**: Replace polling with real-time push
2. **D3.js Charts**: Custom visualizations for advanced analytics
3. **Virtual Scrolling**: Virtualized tables for large datasets
4. **Dashboard Builder**: Drag-and-drop widget arrangement
5. **Export Functionality**: CSV/PDF report generation
6. **Dark Mode**: Theme toggle with CSS variables
