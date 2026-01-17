import { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import type { Panel, QueryResult, PanelOptions, Threshold } from '../types';
import { getPanelData } from '../services/api';
import { TIME_RANGE_OPTIONS, TimeRange } from '../types';

interface PanelChartProps {
  panel: Panel;
  dashboardId: string;
  timeRange: TimeRange;
}

const COLORS = [
  '#8884d8',
  '#82ca9d',
  '#ffc658',
  '#ff7300',
  '#00C49F',
  '#0088FE',
  '#FFBB28',
  '#FF8042',
];

function getThresholdColor(value: number, thresholds?: Threshold[]): string {
  if (!thresholds || thresholds.length === 0) return '#82ca9d';

  const sorted = [...thresholds].sort((a, b) => b.value - a.value);
  for (const threshold of sorted) {
    if (value >= threshold.value) {
      return threshold.color;
    }
  }
  return '#82ca9d';
}

function formatValue(value: number, options?: PanelOptions): string {
  const decimals = options?.decimals ?? 2;
  const formatted = value.toFixed(decimals);
  return options?.unit ? `${formatted}${options.unit}` : formatted;
}

export function PanelChart({ panel, dashboardId, timeRange }: PanelChartProps) {
  const [data, setData] = useState<QueryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      const rangeOption = TIME_RANGE_OPTIONS.find((r) => r.value === timeRange);
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - (rangeOption?.ms || 60 * 60 * 1000));

      const results = await getPanelData(dashboardId, panel.id, startTime, endTime);
      setData(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [dashboardId, panel.id, timeRange]);

  if (loading && data.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-dashboard-muted">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  if (data.length === 0 || data[0]?.data.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-dashboard-muted">
        No data
      </div>
    );
  }

  // Transform data for Recharts
  const chartData = data[0].data.map((point, index) => {
    const entry: Record<string, number | string> = {
      time: format(new Date(point.time), 'HH:mm'),
      fullTime: format(new Date(point.time), 'yyyy-MM-dd HH:mm:ss'),
    };
    data.forEach((series, seriesIndex) => {
      const key =
        Object.values(series.tags).join('-') || `series-${seriesIndex}`;
      entry[key] = series.data[index]?.value ?? 0;
    });
    return entry;
  });

  const seriesKeys = data.map((series, index) => {
    return Object.values(series.tags).join('-') || `series-${index}`;
  });

  const renderChart = () => {
    switch (panel.panel_type) {
      case 'line_chart':
        return (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis dataKey="time" stroke="#a0a0a0" fontSize={10} />
              <YAxis stroke="#a0a0a0" fontSize={10} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#16213e',
                  border: '1px solid #0f3460',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: '#eaeaea' }}
              />
              {panel.options?.legend !== false && <Legend />}
              {seriesKeys.map((key, index) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={COLORS[index % COLORS.length]}
                  dot={false}
                  strokeWidth={2}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        );

      case 'area_chart':
        return (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis dataKey="time" stroke="#a0a0a0" fontSize={10} />
              <YAxis stroke="#a0a0a0" fontSize={10} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#16213e',
                  border: '1px solid #0f3460',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: '#eaeaea' }}
              />
              {panel.options?.legend !== false && <Legend />}
              {seriesKeys.map((key, index) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={COLORS[index % COLORS.length]}
                  fill={COLORS[index % COLORS.length]}
                  fillOpacity={0.3}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        );

      case 'bar_chart':
        return (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f3460" />
              <XAxis dataKey="time" stroke="#a0a0a0" fontSize={10} />
              <YAxis stroke="#a0a0a0" fontSize={10} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#16213e',
                  border: '1px solid #0f3460',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: '#eaeaea' }}
              />
              {panel.options?.legend !== false && <Legend />}
              {seriesKeys.map((key, index) => (
                <Bar
                  key={key}
                  dataKey={key}
                  fill={COLORS[index % COLORS.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        );

      default:
        return (
          <div className="h-full flex items-center justify-center text-dashboard-muted">
            Unsupported chart type: {panel.panel_type}
          </div>
        );
    }
  };

  return <div className="h-full w-full">{renderChart()}</div>;
}
