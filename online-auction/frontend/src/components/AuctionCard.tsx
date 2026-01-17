import { Link } from '@tanstack/react-router';
import type { Auction } from '../types';
import { useCountdown } from '../hooks/useCountdown';

interface AuctionCardProps {
  auction: Auction;
}

export function AuctionCard({ auction }: AuctionCardProps) {
  const countdown = useCountdown(auction.end_time);

  const statusColors = {
    active: 'bg-green-100 text-green-800',
    ended: 'bg-gray-100 text-gray-800',
    cancelled: 'bg-red-100 text-red-800',
    pending: 'bg-yellow-100 text-yellow-800',
  };

  return (
    <Link to="/auction/$auctionId" params={{ auctionId: auction.id }}>
      <div className="card hover:shadow-lg transition-shadow cursor-pointer">
        <div className="aspect-w-16 aspect-h-9 bg-gray-200">
          {auction.image_url ? (
            <img
              src={auction.image_url}
              alt={auction.title}
              className="w-full h-48 object-cover"
            />
          ) : (
            <div className="w-full h-48 flex items-center justify-center bg-gray-100">
              <svg
                className="w-16 h-16 text-gray-400"
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

        <div className="p-4">
          <div className="flex items-start justify-between mb-2">
            <h3 className="font-semibold text-gray-900 truncate flex-1">
              {auction.title}
            </h3>
            <span
              className={`ml-2 px-2 py-1 text-xs rounded-full ${statusColors[auction.status]}`}
            >
              {auction.status}
            </span>
          </div>

          <div className="flex justify-between items-center mb-3">
            <div>
              <p className="text-sm text-gray-500">Current bid</p>
              <p className="text-xl font-bold text-primary-600">
                ${parseFloat(auction.current_price).toFixed(2)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500">
                {countdown.isExpired ? 'Ended' : 'Ends in'}
              </p>
              <p
                className={`text-lg font-semibold ${
                  countdown.totalSeconds < 300 && !countdown.isExpired
                    ? 'text-red-600 animate-pulse'
                    : 'text-gray-900'
                }`}
              >
                {countdown.formatted}
              </p>
            </div>
          </div>

          <div className="flex justify-between items-center text-sm text-gray-500">
            <span>{auction.bid_count || 0} bids</span>
            <span>by {auction.seller_name}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
