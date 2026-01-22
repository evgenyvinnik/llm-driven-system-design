# Dashboarding System (Metrics Monitoring) - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Introduction

"Today I'll design a metrics monitoring and visualization system similar to Datadog or Grafana. This system provides real-time dashboards for visualizing time-series metrics from thousands of servers. As a frontend engineer, I'll focus on the dashboard builder, chart rendering, responsive layouts, time range selection, and real-time data updates."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the core frontend functionality:

1. **Dashboard Builder**: Drag-and-drop panel layout with grid system
2. **Multiple Chart Types**: Line, area, bar, gauge, and stat panels
3. **Time Range Selector**: Preset ranges and custom date picker
4. **Real-Time Updates**: Auto-refresh with configurable intervals
5. **Metrics Explorer**: Browse and search available metrics
6. **Alert Management**: Create, edit, and monitor alert rules
7. **Responsive Design**: Usable on desktop and tablet"

### Non-Functional Requirements

"For a monitoring dashboard frontend:

- **Performance**: Render 20+ panels per dashboard smoothly
- **Responsiveness**: Sub-100ms interaction feedback
- **Update Rate**: 10-second auto-refresh without flicker
- **Large Datasets**: Handle 10,000+ data points per chart
- **Accessibility**: WCAG 2.1 AA compliance for critical functions"

---

## Step 2: Component Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│                         App Shell                                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Navbar                                                       │   │
│  │  - Logo                                                       │   │
│  │  - Navigation links (Dashboards, Alerts, Metrics, Settings)  │   │
│  │  - Time range selector                                        │   │
│  │  - User menu                                                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Main Content (TanStack Router Outlet)                        │   │
│  │                                                                │   │
│  │  ┌────────────────────────────────────────────────────────┐   │   │
│  │  │  Dashboard Page                                         │   │   │
│  │  │  ┌─────────────────────────────────────────────────┐   │   │   │
│  │  │  │  Dashboard Header (title, edit mode, refresh)   │   │   │   │
│  │  │  └─────────────────────────────────────────────────┘   │   │   │
│  │  │  ┌─────────────────────────────────────────────────┐   │   │   │
│  │  │  │  Dashboard Grid (react-grid-layout)             │   │   │   │
│  │  │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐           │   │   │   │
│  │  │  │  │ Panel 1 │ │ Panel 2 │ │ Panel 3 │           │   │   │   │
│  │  │  │  │ (Line)  │ │ (Gauge) │ │ (Stat)  │           │   │   │   │
│  │  │  │  └─────────┘ └─────────┘ └─────────┘           │   │   │   │
│  │  │  │  ┌──────────────────────┐ ┌─────────┐          │   │   │   │
│  │  │  │  │      Panel 4         │ │ Panel 5 │          │   │   │   │
│  │  │  │  │      (Area)          │ │ (Bar)   │          │   │   │   │
│  │  │  │  └──────────────────────┘ └─────────┘          │   │   │   │
│  │  │  └─────────────────────────────────────────────────┘   │   │   │
│  │  └────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
frontend/src/
├── components/
│   ├── charts/                 # Chart components
│   │   ├── index.ts            # Barrel export
│   │   ├── LineChart.tsx       # Line/area chart
│   │   ├── BarChart.tsx        # Bar chart
│   │   ├── GaugeChart.tsx      # Gauge visualization
│   │   ├── StatDisplay.tsx     # Single stat display
│   │   └── chartUtils.ts       # Shared chart utilities
│   ├── dashboard/              # Dashboard components
│   │   ├── index.ts
│   │   ├── DashboardGrid.tsx   # Grid layout wrapper
│   │   ├── DashboardPanel.tsx  # Panel container
│   │   ├── PanelEditor.tsx     # Panel configuration modal
│   │   └── DashboardHeader.tsx # Dashboard controls
│   ├── alerts/                 # Alert components
│   │   ├── index.ts
│   │   ├── AlertRuleForm.tsx   # Create/edit alert
│   │   ├── AlertRuleCard.tsx   # Alert display
│   │   ├── AlertRuleList.tsx   # List container
│   │   └── AlertHistoryTable.tsx
│   ├── layout/                 # Layout components
│   │   ├── Navbar.tsx
│   │   ├── Sidebar.tsx
│   │   └── PageContainer.tsx
│   └── common/                 # Shared components
│       ├── TimeRangeSelector.tsx
│       ├── MetricPicker.tsx
│       ├── LoadingSpinner.tsx
│       └── ErrorBoundary.tsx
├── hooks/                      # Custom React hooks
│   ├── useQuery.ts             # Data fetching with polling
│   ├── useDashboard.ts         # Dashboard state
│   ├── useAlerts.ts            # Alert state
│   └── useTimeRange.ts         # Time range state
├── stores/                     # Zustand state stores
│   ├── dashboardStore.ts
│   ├── timeRangeStore.ts
│   └── alertStore.ts
├── services/                   # API client
│   └── api.ts
├── routes/                     # TanStack Router pages
│   ├── __root.tsx
│   ├── index.tsx               # Dashboard list
│   ├── dashboard.$id.tsx       # Dashboard view
│   ├── alerts.tsx              # Alert management
│   └── metrics.tsx             # Metrics explorer
├── types/                      # TypeScript types
│   └── index.ts
└── utils/                      # Utilities
    ├── formatters.ts           # Number/date formatting
    └── colors.ts               # Chart color palette
```

---

## Step 3: Core Components

### Dashboard Grid with Drag-and-Drop

```tsx
// components/dashboard/DashboardGrid.tsx
import { Responsive, WidthProvider } from 'react-grid-layout';
import type { Layout } from 'react-grid-layout';
import { DashboardPanel } from './DashboardPanel';
import type { Panel } from '../../types';

const ResponsiveGridLayout = WidthProvider(Responsive);

interface DashboardGridProps {
  panels: Panel[];
  isEditing: boolean;
  onLayoutChange: (layout: Layout[]) => void;
  onPanelEdit: (panel: Panel) => void;
  onPanelDelete: (panelId: string) => void;
}

/**
 * Responsive grid layout for dashboard panels.
 * Supports drag-and-drop repositioning and resizing in edit mode.
 */
export function DashboardGrid({
  panels,
  isEditing,
  onLayoutChange,
  onPanelEdit,
  onPanelDelete,
}: DashboardGridProps) {
  // Convert panels to grid layout format
  const layout = panels.map((panel) => ({
    i: panel.id,
    x: panel.position.x,
    y: panel.position.y,
    w: panel.position.w,
    h: panel.position.h,
    minW: 2,
    minH: 2,
  }));

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={{ lg: layout, md: layout, sm: layout }}
      breakpoints={{ lg: 1200, md: 996, sm: 768 }}
      cols={{ lg: 12, md: 10, sm: 6 }}
      rowHeight={80}
      isDraggable={isEditing}
      isResizable={isEditing}
      onLayoutChange={(newLayout) => onLayoutChange(newLayout)}
      draggableHandle=".panel-drag-handle"
      margin={[16, 16]}
    >
      {panels.map((panel) => (
        <div key={panel.id} className="bg-dashboard-card rounded-lg overflow-hidden">
          <DashboardPanel
            panel={panel}
            isEditing={isEditing}
            onEdit={() => onPanelEdit(panel)}
            onDelete={() => onPanelDelete(panel.id)}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
```

### Dashboard Panel Container

```tsx
// components/dashboard/DashboardPanel.tsx
import { useMemo } from 'react';
import { LineChart, BarChart, GaugeChart, StatDisplay } from '../charts';
import { useQuery } from '../../hooks/useQuery';
import { useTimeRangeStore } from '../../stores/timeRangeStore';
import { GripVertical, Settings, Trash2 } from 'lucide-react';
import type { Panel } from '../../types';

interface DashboardPanelProps {
  panel: Panel;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * Container for a single dashboard panel.
 * Routes to appropriate chart type based on panel configuration.
 */
export function DashboardPanel({ panel, isEditing, onEdit, onDelete }: DashboardPanelProps) {
  const { start, end } = useTimeRangeStore();

  // Fetch data for this panel
  const { data, isLoading, error } = useQuery({
    queryKey: ['panel', panel.id, start.toISOString(), end.toISOString()],
    queryFn: () => api.executeQuery({
      query: panel.query,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    refetchInterval: 10000, // Auto-refresh every 10 seconds
  });

  // Memoize chart component to prevent unnecessary re-renders
  const ChartComponent = useMemo(() => {
    switch (panel.type) {
      case 'line':
      case 'area':
        return LineChart;
      case 'bar':
        return BarChart;
      case 'gauge':
        return GaugeChart;
      case 'stat':
        return StatDisplay;
      default:
        return LineChart;
    }
  }, [panel.type]);

  return (
    <div className="h-full flex flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-dashboard-accent">
        {isEditing && (
          <div className="panel-drag-handle cursor-move mr-2">
            <GripVertical size={16} className="text-dashboard-muted" />
          </div>
        )}
        <h3 className="text-sm font-medium text-dashboard-text truncate flex-1">
          {panel.title}
        </h3>
        {isEditing && (
          <div className="flex items-center gap-1">
            <button
              onClick={onEdit}
              className="p-1 hover:bg-dashboard-accent rounded"
              aria-label="Edit panel"
            >
              <Settings size={14} className="text-dashboard-muted" />
            </button>
            <button
              onClick={onDelete}
              className="p-1 hover:bg-red-900/50 rounded"
              aria-label="Delete panel"
            >
              <Trash2 size={14} className="text-red-400" />
            </button>
          </div>
        )}
      </div>

      {/* Panel content */}
      <div className="flex-1 p-4 min-h-0">
        {isLoading ? (
          <div className="h-full flex items-center justify-center">
            <LoadingSpinner size="sm" />
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-400 text-sm">
            Failed to load data
          </div>
        ) : (
          <ChartComponent
            data={data?.data || []}
            options={panel.options}
            type={panel.type}
          />
        )}
      </div>
    </div>
  );
}
```

### Line Chart with Recharts

```tsx
// components/charts/LineChart.tsx
import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart as RechartsLineChart,
  AreaChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { formatTimestamp, formatValue } from '../../utils/formatters';
import { CHART_COLORS } from '../../utils/colors';
import type { ChartData, ChartOptions } from '../../types';

interface LineChartProps {
  data: ChartData[];
  options?: ChartOptions;
  type: 'line' | 'area';
}

/**
 * Line or area chart for time-series data.
 * Uses Recharts with responsive container for automatic sizing.
 */
export function LineChart({ data, options = {}, type }: LineChartProps) {
  // Format data for Recharts
  const formattedData = useMemo(() => {
    return data.map((point) => ({
      time: new Date(point.time).getTime(),
      value: point.value,
    }));
  }, [data]);

  // Calculate Y-axis domain
  const yDomain = useMemo(() => {
    if (data.length === 0) return [0, 100];
    const values = data.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.1 || 10;
    return [Math.max(0, min - padding), max + padding];
  }, [data]);

  const ChartContainer = type === 'area' ? AreaChart : RechartsLineChart;
  const DataElement = type === 'area' ? Area : Line;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ChartContainer data={formattedData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
        <XAxis
          dataKey="time"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(ts) => formatTimestamp(ts, options.timeFormat)}
          stroke="#718096"
          fontSize={11}
          tickLine={false}
        />
        <YAxis
          domain={yDomain}
          tickFormatter={(v) => formatValue(v, options.unit)}
          stroke="#718096"
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1a1f2e',
            border: '1px solid #2d3748',
            borderRadius: '8px',
          }}
          labelFormatter={(ts) => formatTimestamp(ts, 'full')}
          formatter={(value: number) => [formatValue(value, options.unit), options.label || 'Value']}
        />
        {options.showLegend && <Legend />}
        <DataElement
          type="monotone"
          dataKey="value"
          stroke={options.color || CHART_COLORS[0]}
          fill={type === 'area' ? `${options.color || CHART_COLORS[0]}33` : undefined}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
        />
      </ChartContainer>
    </ResponsiveContainer>
  );
}
```

### Gauge Chart

```tsx
// components/charts/GaugeChart.tsx
import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { formatValue } from '../../utils/formatters';
import type { ChartData, GaugeOptions } from '../../types';

interface GaugeChartProps {
  data: ChartData[];
  options?: GaugeOptions;
}

/**
 * Gauge visualization for single-value metrics.
 * Shows current value as a semicircular gauge with color thresholds.
 */
export function GaugeChart({ data, options = {} }: GaugeChartProps) {
  const { min = 0, max = 100, thresholds = { warning: 70, critical: 90 } } = options;

  // Get latest value
  const currentValue = useMemo(() => {
    if (data.length === 0) return 0;
    return data[data.length - 1].value;
  }, [data]);

  // Clamp value to range
  const clampedValue = Math.max(min, Math.min(max, currentValue));
  const percentage = ((clampedValue - min) / (max - min)) * 100;

  // Determine color based on thresholds
  const gaugeColor = useMemo(() => {
    if (currentValue >= thresholds.critical) return '#ef4444'; // red
    if (currentValue >= thresholds.warning) return '#f59e0b'; // amber
    return '#22c55e'; // green
  }, [currentValue, thresholds]);

  // Create gauge data for Recharts
  const gaugeData = [
    { name: 'value', value: percentage },
    { name: 'remaining', value: 100 - percentage },
  ];

  return (
    <div className="h-full flex flex-col items-center justify-center">
      <ResponsiveContainer width="100%" height="60%">
        <PieChart>
          <Pie
            data={gaugeData}
            cx="50%"
            cy="80%"
            startAngle={180}
            endAngle={0}
            innerRadius="60%"
            outerRadius="80%"
            paddingAngle={0}
            dataKey="value"
          >
            <Cell fill={gaugeColor} />
            <Cell fill="#2d3748" />
          </Pie>
        </PieChart>
      </ResponsiveContainer>

      {/* Value display */}
      <div className="text-center -mt-8">
        <span className="text-3xl font-bold text-dashboard-text">
          {formatValue(currentValue, options.unit)}
        </span>
        {options.label && (
          <p className="text-sm text-dashboard-muted mt-1">{options.label}</p>
        )}
      </div>

      {/* Min/max labels */}
      <div className="flex justify-between w-full px-4 mt-2 text-xs text-dashboard-muted">
        <span>{formatValue(min, options.unit)}</span>
        <span>{formatValue(max, options.unit)}</span>
      </div>
    </div>
  );
}
```

### Stat Panel

```tsx
// components/charts/StatDisplay.tsx
import { useMemo } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { formatValue } from '../../utils/formatters';
import type { ChartData, StatOptions } from '../../types';

interface StatDisplayProps {
  data: ChartData[];
  options?: StatOptions;
}

/**
 * Single stat display with optional trend indicator.
 * Shows current value and percent change from previous period.
 */
export function StatDisplay({ data, options = {} }: StatDisplayProps) {
  const { calculation, showTrend = true, decimals = 2 } = options;

  // Calculate the display value
  const displayValue = useMemo(() => {
    if (data.length === 0) return null;
    const values = data.map((d) => d.value);

    switch (calculation) {
      case 'avg':
        return values.reduce((a, b) => a + b, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      case 'last':
      default:
        return values[values.length - 1];
    }
  }, [data, calculation]);

  // Calculate trend (compare first half to second half)
  const trend = useMemo(() => {
    if (!showTrend || data.length < 2) return null;

    const midpoint = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, midpoint).map((d) => d.value);
    const secondHalf = data.slice(midpoint).map((d) => d.value);

    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    if (firstAvg === 0) return null;
    const percentChange = ((secondAvg - firstAvg) / firstAvg) * 100;

    return {
      value: percentChange,
      direction: percentChange > 0 ? 'up' : percentChange < 0 ? 'down' : 'flat',
    };
  }, [data, showTrend]);

  const TrendIcon = trend?.direction === 'up' ? ArrowUp : trend?.direction === 'down' ? ArrowDown : Minus;
  const trendColor = trend?.direction === 'up' ? 'text-green-400' : trend?.direction === 'down' ? 'text-red-400' : 'text-dashboard-muted';

  if (displayValue === null) {
    return (
      <div className="h-full flex items-center justify-center text-dashboard-muted">
        No data
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center">
      <span className="text-4xl font-bold text-dashboard-text">
        {formatValue(displayValue, options.unit, decimals)}
      </span>

      {options.label && (
        <span className="text-sm text-dashboard-muted mt-2">{options.label}</span>
      )}

      {trend && (
        <div className={`flex items-center gap-1 mt-2 ${trendColor}`}>
          <TrendIcon size={16} />
          <span className="text-sm">
            {Math.abs(trend.value).toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}
```

---

## Step 4: Time Range Selector

```tsx
// components/common/TimeRangeSelector.tsx
import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown, Clock } from 'lucide-react';
import { useTimeRangeStore } from '../../stores/timeRangeStore';

const PRESET_RANGES = [
  { label: 'Last 5 minutes', value: '5m' },
  { label: 'Last 15 minutes', value: '15m' },
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 3 hours', value: '3h' },
  { label: 'Last 6 hours', value: '6h' },
  { label: 'Last 12 hours', value: '12h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
];

/**
 * Time range selector with preset ranges and custom date picker.
 * Stores selection in Zustand for global access.
 */
export function TimeRangeSelector() {
  const { preset, setPreset, setCustomRange, getDisplayLabel } = useTimeRangeStore();
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handlePresetSelect = (value: string) => {
    setPreset(value);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-dashboard-card border border-dashboard-accent rounded-lg text-dashboard-text text-sm hover:bg-dashboard-accent transition-colors"
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        <Clock size={16} className="text-dashboard-muted" />
        <span>{getDisplayLabel()}</span>
        <ChevronDown size={16} className={`text-dashboard-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-64 bg-dashboard-card border border-dashboard-accent rounded-lg shadow-xl z-50">
          {/* Tab selector */}
          <div className="flex border-b border-dashboard-accent">
            <button
              onClick={() => setMode('preset')}
              className={`flex-1 px-4 py-2 text-sm ${mode === 'preset' ? 'text-dashboard-highlight border-b-2 border-dashboard-highlight' : 'text-dashboard-muted'}`}
            >
              Presets
            </button>
            <button
              onClick={() => setMode('custom')}
              className={`flex-1 px-4 py-2 text-sm ${mode === 'custom' ? 'text-dashboard-highlight border-b-2 border-dashboard-highlight' : 'text-dashboard-muted'}`}
            >
              Custom
            </button>
          </div>

          {/* Preset options */}
          {mode === 'preset' && (
            <div className="py-2 max-h-64 overflow-y-auto">
              {PRESET_RANGES.map((range) => (
                <button
                  key={range.value}
                  onClick={() => handlePresetSelect(range.value)}
                  className={`w-full px-4 py-2 text-left text-sm hover:bg-dashboard-accent transition-colors ${
                    preset === range.value ? 'text-dashboard-highlight bg-dashboard-accent/50' : 'text-dashboard-text'
                  }`}
                >
                  {range.label}
                </button>
              ))}
            </div>
          )}

          {/* Custom date picker */}
          {mode === 'custom' && (
            <CustomDatePicker
              onApply={(start, end) => {
                setCustomRange(start, end);
                setIsOpen(false);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface CustomDatePickerProps {
  onApply: (start: Date, end: Date) => void;
}

function CustomDatePicker({ onApply }: CustomDatePickerProps) {
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('00:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('23:59');

  const handleApply = () => {
    const start = new Date(`${startDate}T${startTime}`);
    const end = new Date(`${endDate}T${endTime}`);

    if (start < end) {
      onApply(start, end);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div>
        <label className="block text-xs text-dashboard-muted mb-1">Start</label>
        <div className="flex gap-2">
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="flex-1 bg-dashboard-bg border border-dashboard-accent rounded px-2 py-1 text-sm text-dashboard-text"
          />
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="w-24 bg-dashboard-bg border border-dashboard-accent rounded px-2 py-1 text-sm text-dashboard-text"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs text-dashboard-muted mb-1">End</label>
        <div className="flex gap-2">
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="flex-1 bg-dashboard-bg border border-dashboard-accent rounded px-2 py-1 text-sm text-dashboard-text"
          />
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="w-24 bg-dashboard-bg border border-dashboard-accent rounded px-2 py-1 text-sm text-dashboard-text"
          />
        </div>
      </div>
      <button
        onClick={handleApply}
        className="w-full py-2 bg-dashboard-highlight text-white rounded text-sm font-medium hover:bg-blue-600 transition-colors"
      >
        Apply
      </button>
    </div>
  );
}
```

---

## Step 5: State Management with Zustand

### Time Range Store

```typescript
// stores/timeRangeStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TimeRangeState {
  preset: string | null;
  customStart: Date | null;
  customEnd: Date | null;
  refreshInterval: number; // in seconds

  // Computed properties
  start: Date;
  end: Date;

  // Actions
  setPreset: (preset: string) => void;
  setCustomRange: (start: Date, end: Date) => void;
  setRefreshInterval: (interval: number) => void;
  getDisplayLabel: () => string;
}

function parsePreset(preset: string): { start: Date; end: Date } {
  const now = new Date();
  const match = preset.match(/^(\d+)([mhd])$/);

  if (!match) {
    return { start: new Date(now.getTime() - 3600000), end: now };
  }

  const [, value, unit] = match;
  const ms = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[unit] || 60000;

  return {
    start: new Date(now.getTime() - parseInt(value, 10) * ms),
    end: now,
  };
}

export const useTimeRangeStore = create<TimeRangeState>()(
  persist(
    (set, get) => ({
      preset: '1h',
      customStart: null,
      customEnd: null,
      refreshInterval: 10,

      get start() {
        const { preset, customStart } = get();
        if (customStart) return customStart;
        return parsePreset(preset || '1h').start;
      },

      get end() {
        const { preset, customEnd } = get();
        if (customEnd) return customEnd;
        return parsePreset(preset || '1h').end;
      },

      setPreset: (preset) => set({ preset, customStart: null, customEnd: null }),

      setCustomRange: (start, end) => set({ preset: null, customStart: start, customEnd: end }),

      setRefreshInterval: (interval) => set({ refreshInterval: interval }),

      getDisplayLabel: () => {
        const { preset, customStart, customEnd } = get();
        if (customStart && customEnd) {
          return `${customStart.toLocaleDateString()} - ${customEnd.toLocaleDateString()}`;
        }
        const labels: Record<string, string> = {
          '5m': 'Last 5 minutes',
          '15m': 'Last 15 minutes',
          '1h': 'Last 1 hour',
          '3h': 'Last 3 hours',
          '6h': 'Last 6 hours',
          '12h': 'Last 12 hours',
          '24h': 'Last 24 hours',
          '7d': 'Last 7 days',
          '30d': 'Last 30 days',
        };
        return labels[preset || '1h'] || 'Select range';
      },
    }),
    {
      name: 'dashboarding-time-range',
      partialize: (state) => ({ preset: state.preset, refreshInterval: state.refreshInterval }),
    }
  )
);
```

### Dashboard Store

```typescript
// stores/dashboardStore.ts
import { create } from 'zustand';
import { api } from '../services/api';
import type { Dashboard, Panel, Layout } from '../types';

interface DashboardState {
  dashboards: Dashboard[];
  currentDashboard: Dashboard | null;
  isEditing: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchDashboards: () => Promise<void>;
  fetchDashboard: (id: string) => Promise<void>;
  createDashboard: (name: string, description?: string) => Promise<Dashboard>;
  updateDashboard: (id: string, updates: Partial<Dashboard>) => Promise<void>;
  deleteDashboard: (id: string) => Promise<void>;
  addPanel: (dashboardId: string, panel: Omit<Panel, 'id'>) => Promise<void>;
  updatePanel: (panelId: string, updates: Partial<Panel>) => Promise<void>;
  deletePanel: (panelId: string) => Promise<void>;
  updateLayout: (layout: Layout[]) => void;
  setEditing: (isEditing: boolean) => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  dashboards: [],
  currentDashboard: null,
  isEditing: false,
  isLoading: false,
  error: null,

  fetchDashboards: async () => {
    set({ isLoading: true, error: null });
    try {
      const dashboards = await api.getDashboards();
      set({ dashboards, isLoading: false });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  },

  fetchDashboard: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const dashboard = await api.getDashboard(id);
      set({ currentDashboard: dashboard, isLoading: false });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  },

  createDashboard: async (name, description) => {
    const dashboard = await api.createDashboard({ name, description });
    set((state) => ({ dashboards: [...state.dashboards, dashboard] }));
    return dashboard;
  },

  updateDashboard: async (id, updates) => {
    await api.updateDashboard(id, updates);
    set((state) => ({
      currentDashboard: state.currentDashboard?.id === id
        ? { ...state.currentDashboard, ...updates }
        : state.currentDashboard,
      dashboards: state.dashboards.map((d) =>
        d.id === id ? { ...d, ...updates } : d
      ),
    }));
  },

  deleteDashboard: async (id) => {
    await api.deleteDashboard(id);
    set((state) => ({
      dashboards: state.dashboards.filter((d) => d.id !== id),
      currentDashboard: state.currentDashboard?.id === id ? null : state.currentDashboard,
    }));
  },

  addPanel: async (dashboardId, panel) => {
    const newPanel = await api.addPanel(dashboardId, panel);
    set((state) => ({
      currentDashboard: state.currentDashboard
        ? { ...state.currentDashboard, panels: [...state.currentDashboard.panels, newPanel] }
        : null,
    }));
  },

  updatePanel: async (panelId, updates) => {
    await api.updatePanel(panelId, updates);
    set((state) => ({
      currentDashboard: state.currentDashboard
        ? {
            ...state.currentDashboard,
            panels: state.currentDashboard.panels.map((p) =>
              p.id === panelId ? { ...p, ...updates } : p
            ),
          }
        : null,
    }));
  },

  deletePanel: async (panelId) => {
    await api.deletePanel(panelId);
    set((state) => ({
      currentDashboard: state.currentDashboard
        ? {
            ...state.currentDashboard,
            panels: state.currentDashboard.panels.filter((p) => p.id !== panelId),
          }
        : null,
    }));
  },

  updateLayout: (layout) => {
    set((state) => ({
      currentDashboard: state.currentDashboard
        ? {
            ...state.currentDashboard,
            panels: state.currentDashboard.panels.map((panel) => {
              const layoutItem = layout.find((l) => l.i === panel.id);
              if (layoutItem) {
                return {
                  ...panel,
                  position: { x: layoutItem.x, y: layoutItem.y, w: layoutItem.w, h: layoutItem.h },
                };
              }
              return panel;
            }),
          }
        : null,
    }));
  },

  setEditing: (isEditing) => set({ isEditing }),
}));
```

---

## Step 6: Data Fetching Hook with Polling

```typescript
// hooks/useQuery.ts
import { useState, useEffect, useRef, useCallback } from 'react';

interface UseQueryOptions<T> {
  queryKey: (string | number | Date)[];
  queryFn: () => Promise<T>;
  refetchInterval?: number;
  enabled?: boolean;
  onError?: (error: Error) => void;
}

interface UseQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Custom hook for data fetching with automatic polling.
 * Provides loading, error states, and manual refetch capability.
 */
export function useQuery<T>({
  queryKey,
  queryFn,
  refetchInterval,
  enabled = true,
  onError,
}: UseQueryOptions<T>): UseQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const keyRef = useRef(JSON.stringify(queryKey));

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const result = await queryFn();
      setData(result);
      setIsLoading(false);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      setIsLoading(false);
      onError?.(error);
    }
  }, [queryFn, onError]);

  // Initial fetch and key change handling
  useEffect(() => {
    const currentKey = JSON.stringify(queryKey);

    if (currentKey !== keyRef.current) {
      keyRef.current = currentKey;
      setIsLoading(true);
    }

    if (enabled) {
      fetchData();
    }
  }, [queryKey, enabled, fetchData]);

  // Polling interval
  useEffect(() => {
    if (refetchInterval && enabled) {
      intervalRef.current = setInterval(fetchData, refetchInterval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [refetchInterval, enabled, fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}
```

---

## Step 7: Alert Management UI

```tsx
// routes/alerts.tsx
import { useState } from 'react';
import { useAlerts } from '../hooks/useAlerts';
import { AlertRuleForm, AlertRuleList, AlertHistoryTable } from '../components/alerts';
import { Plus, Bell, History } from 'lucide-react';

/**
 * Alert management page with rule creation, listing, and history.
 */
export default function AlertsPage() {
  const { rules, instances, loading, error, createRule, updateRule, deleteRule, evaluateRule } = useAlerts();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'rules' | 'history'>('rules');

  const handleCreateRule = async (ruleData: AlertRuleFormData) => {
    await createRule(ruleData);
    setShowCreateForm(false);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-dashboard-text">Alerts</h1>
          <p className="text-dashboard-muted mt-1">
            Configure alert rules and view firing alerts
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-dashboard-highlight text-white rounded-lg hover:bg-blue-600 transition-colors"
        >
          <Plus size={18} />
          Create Rule
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-6 p-4 bg-red-900/20 border border-red-500 rounded-lg text-red-400">
          {error}
        </div>
      )}

      {/* Create form modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-dashboard-card rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-xl font-semibold text-dashboard-text mb-4">Create Alert Rule</h2>
            <AlertRuleForm
              onSubmit={handleCreateRule}
              onCancel={() => setShowCreateForm(false)}
            />
          </div>
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex gap-4 border-b border-dashboard-accent mb-6">
        <button
          onClick={() => setActiveTab('rules')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'rules'
              ? 'text-dashboard-highlight border-dashboard-highlight'
              : 'text-dashboard-muted border-transparent hover:text-dashboard-text'
          }`}
        >
          <Bell size={16} />
          Alert Rules ({rules.length})
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'history'
              ? 'text-dashboard-highlight border-dashboard-highlight'
              : 'text-dashboard-muted border-transparent hover:text-dashboard-text'
          }`}
        >
          <History size={16} />
          History
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'rules' ? (
        <AlertRuleList
          rules={rules}
          loading={loading}
          onToggle={(id, enabled) => updateRule(id, { enabled })}
          onEvaluate={evaluateRule}
          onDelete={deleteRule}
        />
      ) : (
        <AlertHistoryTable instances={instances} loading={loading} />
      )}
    </div>
  );
}
```

### Alert Rule Card

```tsx
// components/alerts/AlertRuleCard.tsx
import { Bell, BellOff, Play, Trash2, AlertTriangle } from 'lucide-react';
import { getSeverityColor, getConditionLabel } from './alertUtils';
import type { AlertRule } from '../../types';

interface AlertRuleCardProps {
  rule: AlertRule;
  onToggle: () => void;
  onEvaluate: () => void;
  onDelete: () => void;
}

/**
 * Card displaying alert rule details and actions.
 */
export function AlertRuleCard({ rule, onToggle, onEvaluate, onDelete }: AlertRuleCardProps) {
  return (
    <div className={`bg-dashboard-card border rounded-lg p-4 ${
      rule.enabled ? 'border-dashboard-accent' : 'border-dashboard-accent/50 opacity-60'
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${getSeverityColor(rule.severity)}`}>
            {rule.severity}
          </span>
          <h3 className="font-medium text-dashboard-text">{rule.name}</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggle}
            className="p-2 hover:bg-dashboard-accent rounded"
            aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
            title={rule.enabled ? 'Disable' : 'Enable'}
          >
            {rule.enabled ? (
              <Bell size={16} className="text-green-400" />
            ) : (
              <BellOff size={16} className="text-dashboard-muted" />
            )}
          </button>
          <button
            onClick={onEvaluate}
            className="p-2 hover:bg-dashboard-accent rounded"
            aria-label="Test rule"
            title="Test now"
          >
            <Play size={16} className="text-dashboard-muted" />
          </button>
          <button
            onClick={onDelete}
            className="p-2 hover:bg-red-900/50 rounded"
            aria-label="Delete rule"
            title="Delete"
          >
            <Trash2 size={16} className="text-red-400" />
          </button>
        </div>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2 text-dashboard-muted">
          <AlertTriangle size={14} />
          <span>
            When <code className="px-1 bg-dashboard-bg rounded">{rule.query}</code> is{' '}
            {getConditionLabel(rule.condition)} {rule.threshold}
          </span>
        </div>
        <div className="text-dashboard-muted">
          For at least {rule.duration}
        </div>
      </div>
    </div>
  );
}
```

---

## Step 8: Responsive Design and Accessibility

### Tailwind Configuration

```javascript
// tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'dashboard-bg': '#0f1419',
        'dashboard-card': '#1a1f2e',
        'dashboard-accent': '#2d3748',
        'dashboard-text': '#e2e8f0',
        'dashboard-muted': '#718096',
        'dashboard-highlight': '#3b82f6',
      },
      screens: {
        'xs': '475px',
      },
    },
  },
  plugins: [],
};
```

### Responsive Panel Grid

```tsx
// Responsive breakpoints for react-grid-layout
const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480 };
const COLUMNS = { lg: 12, md: 10, sm: 6, xs: 4 };

// Panels automatically reflow based on viewport
<ResponsiveGridLayout
  breakpoints={BREAKPOINTS}
  cols={COLUMNS}
  rowHeight={80}
  // On mobile, panels stack vertically
  layouts={{
    lg: layout,
    md: layout.map(l => ({ ...l, w: Math.min(l.w, 10) })),
    sm: layout.map(l => ({ ...l, x: 0, w: 6 })),
    xs: layout.map(l => ({ ...l, x: 0, w: 4 })),
  }}
/>
```

### Accessibility Features

```tsx
// Keyboard navigation for time range selector
function TimeRangeSelector() {
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusNext(index);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusPrev(index);
        break;
      case 'Escape':
        setIsOpen(false);
        break;
    }
  };

  return (
    <div role="listbox" aria-label="Select time range">
      {PRESET_RANGES.map((range, index) => (
        <button
          key={range.value}
          role="option"
          aria-selected={preset === range.value}
          onKeyDown={(e) => handleKeyDown(e, index)}
          tabIndex={0}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

// Screen reader announcements for data updates
function DashboardPanel({ panel }: { panel: Panel }) {
  const { data } = useQuery({ ... });

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${panel.title} panel`}
    >
      {/* Chart content */}
      <div aria-hidden="true">
        <LineChart data={data} />
      </div>
      {/* Hidden text for screen readers */}
      <span className="sr-only">
        Current value: {data?.[data.length - 1]?.value ?? 'No data'}
      </span>
    </div>
  );
}
```

---

## Step 9: Performance Optimizations

### Chart Rendering Optimization

```tsx
// Memoized chart to prevent re-renders on parent updates
const MemoizedLineChart = React.memo(LineChart, (prev, next) => {
  // Only re-render if data actually changed
  return JSON.stringify(prev.data) === JSON.stringify(next.data) &&
         JSON.stringify(prev.options) === JSON.stringify(next.options);
});

// Data point downsampling for large datasets
function downsampleData(data: ChartData[], maxPoints: number): ChartData[] {
  if (data.length <= maxPoints) return data;

  const factor = Math.ceil(data.length / maxPoints);
  const result: ChartData[] = [];

  for (let i = 0; i < data.length; i += factor) {
    const chunk = data.slice(i, i + factor);
    // Use min/max preservation for accurate rendering
    const min = chunk.reduce((a, b) => a.value < b.value ? a : b);
    const max = chunk.reduce((a, b) => a.value > b.value ? a : b);

    if (min.time < max.time) {
      result.push(min, max);
    } else {
      result.push(max, min);
    }
  }

  return result;
}
```

### Lazy Loading and Code Splitting

```tsx
// Lazy load heavy chart components
const LineChart = React.lazy(() => import('../components/charts/LineChart'));
const GaugeChart = React.lazy(() => import('../components/charts/GaugeChart'));

function DashboardPanel({ panel }: { panel: Panel }) {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      {panel.type === 'line' && <LineChart {...props} />}
      {panel.type === 'gauge' && <GaugeChart {...props} />}
    </Suspense>
  );
}
```

### Debounced Layout Updates

```tsx
// Debounce layout saves during drag operations
import { useDebouncedCallback } from 'use-debounce';

function DashboardGrid({ onLayoutChange }: Props) {
  const debouncedSave = useDebouncedCallback(
    (layout: Layout[]) => {
      api.updateDashboardLayout(dashboardId, layout);
    },
    500,
    { leading: false, trailing: true }
  );

  return (
    <ResponsiveGridLayout
      onLayoutChange={(layout) => {
        // Immediate local update
        updateLayout(layout);
        // Debounced server save
        debouncedSave(layout);
      }}
    />
  );
}
```

---

## Step 10: Error Handling and Loading States

### Error Boundary

```tsx
// components/common/ErrorBoundary.tsx
import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Dashboard error:', error, errorInfo);
    // Could send to error tracking service
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="h-full flex flex-col items-center justify-center p-8 text-center">
          <AlertTriangle size={48} className="text-red-400 mb-4" />
          <h3 className="text-lg font-medium text-dashboard-text mb-2">
            Something went wrong
          </h3>
          <p className="text-dashboard-muted mb-4 max-w-md">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-4 py-2 bg-dashboard-accent text-dashboard-text rounded hover:bg-dashboard-accent/80"
          >
            <RefreshCw size={16} />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

### Skeleton Loading States

```tsx
// components/common/Skeleton.tsx
interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div className={`animate-pulse bg-dashboard-accent rounded ${className}`} />
  );
}

// Panel skeleton
export function PanelSkeleton() {
  return (
    <div className="bg-dashboard-card rounded-lg p-4 h-full">
      <Skeleton className="h-4 w-1/3 mb-4" />
      <div className="flex-1 flex items-end gap-1 h-40">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton
            key={i}
            className="flex-1"
            style={{ height: `${Math.random() * 60 + 20}%` }}
          />
        ))}
      </div>
    </div>
  );
}

// Dashboard skeleton
export function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="col-span-4">
          <PanelSkeleton />
        </div>
      ))}
    </div>
  );
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux, Context | Lightweight, no boilerplate, TypeScript support |
| Routing | TanStack Router | React Router | Type-safe routes, better dev experience |
| Charts | Recharts | Chart.js, D3.js | React-native, good time-series support |
| Grid Layout | react-grid-layout | CSS Grid, Masonry | Built-in drag-and-drop, resize handles |
| Styling | Tailwind CSS | styled-components, CSS Modules | Rapid prototyping, consistent design |
| Data Fetching | Custom hook | TanStack Query | Simpler for this use case, learning opportunity |

---

## Summary

"To summarize the frontend architecture for this dashboarding system:

1. **Component Architecture**: Feature-based organization with barrel exports, clear separation between container and presentational components

2. **Dashboard Builder**: react-grid-layout for drag-and-drop, responsive breakpoints, memoized chart rendering

3. **State Management**: Zustand for global state (time range, dashboard), local state for UI, custom hooks for data fetching

4. **Performance**: Lazy loading charts, debounced layout saves, data downsampling for large datasets

5. **Accessibility**: ARIA roles, keyboard navigation, screen reader announcements for data updates

Key frontend insights:
- Memoization is critical when rendering 20+ charts
- Debounced saves prevent API overload during drag operations
- Skeleton loading states improve perceived performance
- Custom hooks encapsulate polling and error handling logic

What aspect would you like me to elaborate on?"
