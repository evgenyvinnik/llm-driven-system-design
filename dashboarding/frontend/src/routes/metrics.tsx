/**
 * @fileoverview Metrics explorer page.
 *
 * Provides an interactive interface for browsing available metrics,
 * viewing their time-series data, and exploring tag dimensions.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { MetricDefinition, QueryResult, TimeRange } from '../types';
import { getMetricNames, getMetricDefinitions, queryMetrics } from '../services/api';
import { TimeRangeSelector } from '../components/TimeRangeSelector';
import { TIME_RANGE_OPTIONS } from '../types';

/**
 * Route configuration for the metrics explorer page.
 */
export const Route = createFileRoute('/metrics')({
  component: MetricsPage,
});

/**
 * Metrics explorer page component.
 *
 * Features:
 * - List of available metric names in sidebar
 * - Time-series chart for selected metric
 * - Table of metric instances (name + tag combinations)
 * - Time range selector for chart window
 *
 * @returns The rendered metrics explorer page
 */
function MetricsPage() {
  const [metricNames, setMetricNames] = useState<string[]>([]);
  const [definitions, setDefinitions] = useState<MetricDefinition[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<string>('');
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [results, setResults] = useState<QueryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMetricNames = async () => {
      try {
        const names = await getMetricNames();
        setMetricNames(names);
        if (names.length > 0) {
          setSelectedMetric(names[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch metric names');
      }
    };
    fetchMetricNames();
  }, []);

  useEffect(() => {
    if (selectedMetric) {
      fetchDefinitions();
      fetchMetricData();
    }
  }, [selectedMetric, timeRange]);

  const fetchDefinitions = async () => {
    try {
      const defs = await getMetricDefinitions(selectedMetric);
      setDefinitions(defs);
    } catch (err) {
      console.error('Failed to fetch definitions:', err);
    }
  };

  const fetchMetricData = async () => {
    try {
      setLoading(true);
      setError(null);

      const rangeOption = TIME_RANGE_OPTIONS.find((r) => r.value === timeRange);
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - (rangeOption?.ms || 60 * 60 * 1000));

      const data = await queryMetrics({
        metric_name: selectedMetric,
        start_time: startTime,
        end_time: endTime,
        aggregation: 'avg',
        interval: '1m',
      });

      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch metric data');
    } finally {
      setLoading(false);
    }
  };

  // Transform data for chart
  const chartData =
    results.length > 0 && results[0].data.length > 0
      ? results[0].data.map((point) => ({
          time: format(new Date(point.time), 'HH:mm'),
          value: point.value,
        }))
      : [];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-dashboard-text">Metrics Explorer</h1>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {error && (
        <div className="bg-red-900/50 border border-red-700 rounded-md px-4 py-2 mb-4 text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-4 gap-8">
        <div className="col-span-1">
          <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-4">Metrics</h2>
            <div className="space-y-2">
              {metricNames.map((name) => (
                <button
                  key={name}
                  onClick={() => setSelectedMetric(name)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    selectedMetric === name
                      ? 'bg-dashboard-highlight text-white'
                      : 'text-dashboard-muted hover:text-dashboard-text hover:bg-dashboard-accent'
                  }`}
                >
                  {name}
                </button>
              ))}
              {metricNames.length === 0 && (
                <p className="text-dashboard-muted text-sm">No metrics found</p>
              )}
            </div>
          </div>
        </div>

        <div className="col-span-3 space-y-8">
          {selectedMetric && (
            <>
              <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">{selectedMetric}</h2>
                  <button
                    onClick={fetchMetricData}
                    className="text-dashboard-highlight hover:underline text-sm"
                  >
                    Refresh
                  </button>
                </div>

                {loading ? (
                  <div className="h-64 flex items-center justify-center text-dashboard-muted">
                    Loading...
                  </div>
                ) : chartData.length > 0 ? (
                  <div className="h-64">
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
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="#8884d8"
                          dot={false}
                          strokeWidth={2}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="h-64 flex items-center justify-center text-dashboard-muted">
                    No data available
                  </div>
                )}
              </div>

              <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4">
                <h2 className="text-lg font-semibold mb-4">
                  Metric Instances ({definitions.length})
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-dashboard-accent">
                      <tr>
                        <th className="px-4 py-2 text-left text-sm text-dashboard-muted">ID</th>
                        <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Tags</th>
                        <th className="px-4 py-2 text-left text-sm text-dashboard-muted">
                          Created
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {definitions.map((def) => (
                        <tr key={def.id} className="border-t border-dashboard-accent">
                          <td className="px-4 py-2 text-dashboard-text">{def.id}</td>
                          <td className="px-4 py-2">
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(def.tags).map(([key, value]) => (
                                <span
                                  key={key}
                                  className="bg-dashboard-accent px-2 py-0.5 rounded text-xs"
                                >
                                  {key}={value}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-dashboard-muted text-sm">
                            {format(new Date(def.created_at), 'yyyy-MM-dd HH:mm')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
