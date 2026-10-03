import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import type { HourlyStats, TopPhrase } from '../../types';
import { LoadingState } from './LoadingState';

const HOUR_MS = 60 * 60 * 1000;
const CHART_HOURS = 24;

interface HourSlot {
  start: number; // epoch ms
  queryCount: number;
}

/**
 * One slot per hour for the last 24 hours, oldest first. The API only returns hours that had
 * queries, so missing hours become 0 instead of disappearing (which would put bars many hours
 * apart next to each other).
 */
function toHourSlots(hourly: HourlyStats[], now = Date.now()): HourSlot[] {
  const counts = new Map<number, number>();
  for (const h of hourly) {
    const slot = Math.floor(new Date(h.hour).getTime() / HOUR_MS);
    counts.set(slot, (counts.get(slot) ?? 0) + h.queryCount);
  }

  const current = Math.floor(now / HOUR_MS);
  return Array.from({ length: CHART_HOURS }, (_, i) => {
    const slot = current - (CHART_HOURS - 1) + i;
    return { start: slot * HOUR_MS, queryCount: counts.get(slot) ?? 0 };
  });
}

function formatHour(start: number): string {
  return new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * AnalyticsTab - Displays analytics data including query volume charts and top phrases.
 * Shows hourly query distribution and a ranked list of most searched phrases.
 */
export function AnalyticsTab() {
  const [hourly, setHourly] = useState<HourlyStats[]>([]);
  const [topPhrases, setTopPhrases] = useState<TopPhrase[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    /**
     * Fetches hourly statistics and top phrases data.
     */
    const fetchData = async () => {
      try {
        const [hourlyData, phrasesData] = await Promise.all([
          api.getHourlyStats(),
          api.getTopPhrases(20),
        ]);
        setHourly(hourlyData.hourly);
        setTopPhrases(phrasesData.phrases);
      } catch (err) {
        console.error('Failed to load analytics:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <HourlyChart hourly={hourly} />
      <TopPhrasesTable phrases={topPhrases} />
    </div>
  );
}

/**
 * HourlyChart - A bar chart visualization of query volume over the last 24 hours.
 */
interface HourlyChartProps {
  hourly: HourlyStats[];
}

function HourlyChart({ hourly }: HourlyChartProps) {
  const slots = toHourSlots(hourly);
  const maxCount = Math.max(...slots.map(s => s.queryCount));

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="font-semibold text-gray-900 mb-4">Query Volume (Last 24 Hours)</h3>
      {maxCount > 0 ? (
        <>
          <div className="h-64 flex items-end gap-1">
            {slots.map(slot => {
              const height = (slot.queryCount / maxCount) * 100;
              return (
                <div
                  key={slot.start}
                  className={`flex-1 rounded-t transition-colors cursor-pointer group relative ${
                    slot.queryCount > 0 ? 'bg-blue-500 hover:bg-blue-600' : 'bg-gray-100'
                  }`}
                  style={{ height: `${Math.max(height, 2)}%` }}
                >
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    {formatHour(slot.start)}: {slot.queryCount} queries
                  </div>
                </div>
              );
            })}
          </div>
          {/* Hour axis: a label every 6 hours */}
          <div className="flex gap-1 mt-2 text-xs text-gray-400">
            {slots.map((slot, i) => (
              <div key={slot.start} className="flex-1 whitespace-nowrap">
                {i % 6 === 0 ? formatHour(slot.start) : ''}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-gray-500 text-center py-8">No data yet</p>
      )}
    </div>
  );
}

/**
 * TopPhrasesTable - A table displaying the most searched phrases with their counts.
 */
interface TopPhrasesTableProps {
  phrases: TopPhrase[];
}

function TopPhrasesTable({ phrases }: TopPhrasesTableProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="font-semibold text-gray-900 mb-4">Top Phrases</h3>
      {phrases.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left border-b">
                <th className="pb-3 text-sm font-medium text-gray-500">Rank</th>
                <th className="pb-3 text-sm font-medium text-gray-500">Phrase</th>
                <th className="pb-3 text-sm font-medium text-gray-500 text-right">Count</th>
              </tr>
            </thead>
            <tbody>
              {phrases.map((phrase, index) => (
                <tr key={phrase.phrase} className="border-b last:border-0">
                  <td className="py-3 text-sm text-gray-500">{index + 1}</td>
                  <td className="py-3 text-sm text-gray-900">{phrase.phrase}</td>
                  <td className="py-3 text-sm text-gray-600 text-right">
                    {phrase.count.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-gray-500 text-center py-8">No phrases yet</p>
      )}
    </div>
  );
}
