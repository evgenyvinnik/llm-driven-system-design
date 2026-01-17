import { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { TrendingResponse } from '../types';

interface TrendingListProps {
  onSelect?: (phrase: string) => void;
  limit?: number;
}

export function TrendingList({ onSelect, limit = 10 }: TrendingListProps) {
  const [trending, setTrending] = useState<TrendingResponse['trending']>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTrending = async () => {
      try {
        const response = await api.getTrending(limit);
        setTrending(response.trending);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load trending');
      } finally {
        setIsLoading(false);
      }
    };

    fetchTrending();
    // Refresh every 30 seconds
    const interval = setInterval(fetchTrending, 30000);
    return () => clearInterval(interval);
  }, [limit]);

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-200 rounded w-1/3" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-gray-100 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <p className="text-red-500 text-sm">{error}</p>
      </div>
    );
  }

  if (trending.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="font-semibold text-gray-800 mb-3">Trending Now</h3>
        <p className="text-gray-500 text-sm">No trending queries yet. Start searching!</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
        <svg className="w-5 h-5 text-orange-500" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z"
            clipRule="evenodd"
          />
        </svg>
        Trending Now
      </h3>
      <ul className="space-y-2">
        {trending.map((item, index) => (
          <li
            key={item.phrase}
            className="flex items-center gap-3 p-2 rounded hover:bg-gray-50 cursor-pointer transition-colors"
            onClick={() => onSelect?.(item.phrase)}
          >
            <span className="text-gray-400 font-medium text-sm w-6">
              {index + 1}
            </span>
            <span className="text-gray-800 flex-1">{item.phrase}</span>
            <span className="text-xs text-gray-400">
              {item.score.toFixed(0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
