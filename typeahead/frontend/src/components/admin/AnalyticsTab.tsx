import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import type { HourlyStats, TopPhrase } from '../../types';
import { LoadingState } from './LoadingState';

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
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="font-semibold text-gray-900 mb-4">Query Volume (Last 24 Hours)</h3>
      {hourly.length > 0 ? (
        <div className="h-64 flex items-end gap-1">
          {hourly.slice(0, 24).reverse().map((h, i) => {
            const maxCount = Math.max(...hourly.map(x => x.queryCount));
            const height = maxCount > 0 ? (h.queryCount / maxCount) * 100 : 0;
            return (
              <div
                key={i}
                className="flex-1 bg-blue-500 rounded-t hover:bg-blue-600 transition-colors cursor-pointer group relative"
                style={{ height: `${Math.max(height, 2)}%` }}
              >
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  {h.queryCount} queries
                </div>
              </div>
            );
          })}
        </div>
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
