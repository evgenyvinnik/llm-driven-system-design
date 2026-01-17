import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useAuctionSubscription } from '../hooks/useAuctionSubscription';
import { CountdownTimer } from '../components/CountdownTimer';
import { BidForm } from '../components/BidForm';
import { BidHistory } from '../components/BidHistory';
import type { AuctionDetail, WebSocketMessage } from '../types';

export const Route = createFileRoute('/auction/$auctionId')({
  component: AuctionPage,
});

function AuctionPage() {
  const { auctionId } = Route.useParams();
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuthStore();

  const [auctionData, setAuctionData] = useState<AuctionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isWatching, setIsWatching] = useState(false);

  const fetchAuction = useCallback(async () => {
    try {
      const data = await api.getAuction(auctionId);
      setAuctionData(data);
      setIsWatching(data.isWatching);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load auction');
    } finally {
      setIsLoading(false);
    }
  }, [auctionId]);

  useEffect(() => {
    fetchAuction();
  }, [fetchAuction]);

  const handleWebSocketMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type === 'new_bid' && auctionData) {
        setAuctionData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            auction: {
              ...prev.auction,
              current_price: String(message.current_price || prev.auction.current_price),
            },
          };
        });
        // Refetch to get updated bid history
        fetchAuction();
      } else if (message.type === 'auction_ended') {
        fetchAuction();
      }
    },
    [auctionData, fetchAuction]
  );

  useAuctionSubscription(auctionId, handleWebSocketMessage);

  const handleWatch = async () => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    try {
      if (isWatching) {
        await api.unwatchAuction(auctionId);
        setIsWatching(false);
      } else {
        await api.watchAuction(auctionId);
        setIsWatching(true);
      }
    } catch (err) {
      console.error('Failed to update watchlist:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        <p className="mt-2 text-gray-600">Loading auction...</p>
      </div>
    );
  }

  if (error || !auctionData) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <p className="text-red-600">{error || 'Auction not found'}</p>
        <button onClick={() => navigate({ to: '/' })} className="mt-4 btn-primary">
          Back to Home
        </button>
      </div>
    );
  }

  const { auction, bids, userAutoBid } = auctionData;
  const isOwner = user?.id === auction.seller_id;
  const isWinner = auction.winner_id === user?.id;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Content */}
        <div className="lg:col-span-2">
          {/* Image */}
          <div className="bg-gray-200 rounded-lg overflow-hidden mb-6">
            {auction.image_url ? (
              <img
                src={auction.image_url}
                alt={auction.title}
                className="w-full h-96 object-contain bg-white"
              />
            ) : (
              <div className="w-full h-96 flex items-center justify-center bg-gray-100">
                <svg
                  className="w-24 h-24 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </div>
            )}
          </div>

          {/* Details */}
          <div className="bg-white rounded-lg shadow-md p-6 mb-6">
            <h1 className="text-2xl font-bold text-gray-900 mb-4">
              {auction.title}
            </h1>

            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <span
                  className={`px-3 py-1 rounded-full text-sm font-medium ${
                    auction.status === 'active'
                      ? 'bg-green-100 text-green-800'
                      : auction.status === 'ended'
                        ? 'bg-gray-100 text-gray-800'
                        : 'bg-red-100 text-red-800'
                  }`}
                >
                  {auction.status.charAt(0).toUpperCase() + auction.status.slice(1)}
                </span>
                {isWinner && (
                  <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                    You Won!
                  </span>
                )}
              </div>
              <button
                onClick={handleWatch}
                className={`flex items-center space-x-1 ${
                  isWatching ? 'text-red-500' : 'text-gray-500'
                } hover:text-red-600`}
              >
                <svg
                  className="w-5 h-5"
                  fill={isWatching ? 'currentColor' : 'none'}
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
                <span>{isWatching ? 'Watching' : 'Watch'}</span>
              </button>
            </div>

            {auction.description && (
              <div className="prose max-w-none">
                <h3 className="text-lg font-semibold mb-2">Description</h3>
                <p className="text-gray-600 whitespace-pre-wrap">
                  {auction.description}
                </p>
              </div>
            )}

            <div className="mt-6 pt-6 border-t grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Seller</span>
                <p className="font-medium">{auction.seller_name}</p>
              </div>
              <div>
                <span className="text-gray-500">Starting Price</span>
                <p className="font-medium">
                  ${parseFloat(auction.starting_price).toFixed(2)}
                </p>
              </div>
              <div>
                <span className="text-gray-500">Bid Increment</span>
                <p className="font-medium">
                  ${parseFloat(auction.bid_increment).toFixed(2)}
                </p>
              </div>
              <div>
                <span className="text-gray-500">Reserve Price</span>
                <p className="font-medium">
                  {auction.reserve_price
                    ? `$${parseFloat(auction.reserve_price).toFixed(2)}`
                    : 'None'}
                </p>
              </div>
            </div>
          </div>

          {/* Bid History */}
          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-lg font-semibold mb-4">Bid History</h2>
            <BidHistory bids={bids} currentUserId={user?.id} />
          </div>
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1">
          <div className="sticky top-24">
            {/* Price and Timer */}
            <div className="bg-white rounded-lg shadow-md p-6 mb-6">
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500 mb-1">Current Bid</p>
                <p className="text-4xl font-bold text-primary-600">
                  ${parseFloat(auction.current_price).toFixed(2)}
                </p>
                <p className="text-sm text-gray-500 mt-2">
                  {bids.length} bid{bids.length !== 1 ? 's' : ''}
                </p>
              </div>

              <div className="text-center mb-6 p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-500 mb-2">
                  {auction.status === 'ended' ? 'Auction Ended' : 'Time Remaining'}
                </p>
                <CountdownTimer endTime={auction.end_time} size="lg" />
              </div>

              {auction.snipe_protection_minutes > 0 && auction.status === 'active' && (
                <p className="text-xs text-gray-500 text-center mb-4">
                  Snipe protection: Extends {auction.snipe_protection_minutes} min if
                  bid in final {auction.snipe_protection_minutes} min
                </p>
              )}
            </div>

            {/* Bid Form */}
            {!isOwner && (
              <BidForm
                auction={auction}
                userAutoBid={userAutoBid}
                onBidPlaced={fetchAuction}
              />
            )}

            {isOwner && (
              <div className="bg-yellow-50 rounded-lg p-4 text-center">
                <p className="text-yellow-800">This is your auction</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
