import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import type { Panel, QueryResult, Threshold } from '../types';
import { getPanelData } from '../services/api';
import { TIME_RANGE_OPTIONS, TimeRange } from '../types';

interface StatPanelProps {
  panel: Panel;
  dashboardId: string;
  timeRange: TimeRange;
}

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

export function StatPanel({ panel, dashboardId, timeRange }: StatPanelProps) {
  const [value, setValue] = useState<number | null>(null);
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

      if (results.length > 0 && results[0].data.length > 0) {
        // Get the latest value
        const latestValue = results[0].data[results[0].data.length - 1].value;
        setValue(latestValue);
      } else {
        setValue(null);
      }
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

  if (loading && value === null) {
    return (
      <div className="h-full flex items-center justify-center text-dashboard-muted">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (value === null) {
    return (
      <div className="h-full flex items-center justify-center text-dashboard-muted">
        No data
      </div>
    );
  }

  const color = getThresholdColor(value, panel.options?.thresholds);
  const decimals = panel.options?.decimals ?? 2;
  const displayValue = value.toFixed(decimals);
  const unit = panel.options?.unit || '';

  return (
    <div className="h-full flex flex-col items-center justify-center">
      <div className="text-4xl font-bold" style={{ color }}>
        {displayValue}
        <span className="text-xl ml-1">{unit}</span>
      </div>
    </div>
  );
}
