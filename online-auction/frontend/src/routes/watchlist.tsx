import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { AuctionCard } from '../components/AuctionCard';
import type { Auction } from '../types';

/**
 * Route definition for watchlist page (/watchlist).
 * Protected route - redirects unauthenticated users to login.
 */
export const Route = createFileRoute('/watchlist')({
  component: WatchlistPage,
});

/**
 * User's watchlist page component.
 *
 * Displays grid of auctions the user has marked as "watching".
 * Watching an auction provides notifications for bidding activity.
 *
 * Shows helpful empty state with instructions when no auctions
 * are being watched.
 *
 * @returns JSX element for the watchlist page
 */
function WatchlistPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();

  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    const fetchWatchlist = async () => {
      setIsLoading(true);
      try {
        const data = await api.getWatchlist();
        setAuctions(data.auctions);
      } catch (err) {
        console.error('Failed to fetch watchlist:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchWatchlist();
  }, [isAuthenticated, navigate]);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Watchlist</h1>

      {isLoading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <p className="mt-2 text-gray-600">Loading...</p>
        </div>
      ) : auctions.length === 0 ? (
        <div className="text-center py-12">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
            />
          </svg>
          <p className="mt-4 text-gray-600">Your watchlist is empty</p>
          <p className="text-sm text-gray-500 mt-2">
            Click the heart icon on any auction to add it to your watchlist
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {auctions.map((auction) => (
            <AuctionCard key={auction.id} auction={auction} />
          ))}
        </div>
      )}
    </div>
  );
}
