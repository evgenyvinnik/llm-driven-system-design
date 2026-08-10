import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { trendsApi } from '../services/api';
import { Trend } from '../types';
import { formatNumber } from '../utils/format';

/** Renders the trending hashtags sidebar with auto-refresh and rising indicators. */
export function TrendingSidebar() {
  const [trends, setTrends] = useState<Trend[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchTrends = async () => {
      try {
        // Real Twitter shows a handful; the API defaults to 10, which makes the
        // sidebar taller than the timeline it sits beside.
        const { trends } = await trendsApi.getTrends(6);
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
      <div className="bg-twitter-background rounded-2xl">
        <h2 className="text-xl font-extrabold p-4 text-twitter-dark">Trends for you</h2>
        <div className="animate-pulse space-y-4 px-4 pb-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 bg-twitter-border rounded w-24"></div>
              <div className="h-4 bg-twitter-border rounded w-32"></div>
              <div className="h-3 bg-twitter-border rounded w-20"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (trends.length === 0) {
    return (
      <div className="bg-twitter-background rounded-2xl p-4">
        <h2 className="text-xl font-extrabold text-twitter-dark">Trends for you</h2>
        <p className="text-twitter-gray mt-4 text-[15px]">No trends available</p>
      </div>
    );
  }

  return (
    <div className="bg-twitter-background rounded-2xl overflow-hidden">
      <h2 className="text-xl font-extrabold p-4 text-twitter-dark">Trends for you</h2>
      <div>
        {trends.map((trend, index) => (
          <Link
            key={trend.hashtag}
            to="/hashtag/$tag"
            params={{ tag: trend.hashtag }}
            className="block px-4 py-3 hover:bg-twitter-dark/5 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[13px] text-twitter-gray">{index + 1} · Trending</p>
                <p className="font-bold text-twitter-dark text-[15px]">#{trend.hashtag}</p>
                <p className="text-[13px] text-twitter-gray">
                  {formatNumber(trend.tweetCount)} {trend.tweetCount === 1 ? 'tweet' : 'tweets'}
                </p>
              </div>
              {trend.isRising && (
                <span className="text-twitter-retweet text-[13px] flex items-center gap-1">
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
      <Link
        to="/explore"
        className="block px-4 py-4 text-twitter-blue text-[15px] hover:bg-twitter-dark/5 transition-colors"
      >
        Show more
      </Link>
    </div>
  );
}
