import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { trendsApi } from '../services/api';
import { Trend } from '../types';
import { formatNumber } from '../utils/format';

export function TrendingSidebar() {
  const [trends, setTrends] = useState<Trend[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchTrends = async () => {
      try {
        const { trends } = await trendsApi.getTrends();
        setTrends(trends);
      } catch (error) {
        console.error('Failed to fetch trends:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchTrends();
    const interval = setInterval(fetchTrends, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className="bg-twitter-background rounded-xl p-4">
        <h2 className="text-xl font-bold mb-4">Trends for you</h2>
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (trends.length === 0) {
    return (
      <div className="bg-twitter-background rounded-xl p-4">
        <h2 className="text-xl font-bold mb-4">Trends for you</h2>
        <p className="text-twitter-gray">No trends available</p>
      </div>
    );
  }

  return (
    <div className="bg-twitter-background rounded-xl overflow-hidden">
      <h2 className="text-xl font-bold p-4">Trends for you</h2>
      <div>
        {trends.map((trend, index) => (
          <Link
            key={trend.hashtag}
            to={`/hashtag/${trend.hashtag}`}
            className="block p-4 hover:bg-gray-100 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-twitter-gray">{index + 1} · Trending</p>
                <p className="font-bold text-twitter-dark">#{trend.hashtag}</p>
                <p className="text-xs text-twitter-gray">
                  {formatNumber(trend.tweetCount)} tweets
                </p>
              </div>
              {trend.isRising && (
                <span className="text-green-500 text-xs flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5.293 7.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 5.414V17a1 1 0 11-2 0V5.414L6.707 7.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
                  </svg>
                  Rising
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
