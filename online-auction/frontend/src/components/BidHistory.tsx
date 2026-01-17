import type { Bid } from '../types';

interface BidHistoryProps {
  bids: Bid[];
  currentUserId?: string;
}

export function BidHistory({ bids, currentUserId }: BidHistoryProps) {
  if (bids.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No bids yet. Be the first to bid!
      </div>
    );
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className="space-y-2">
      {bids.map((bid, index) => (
        <div
          key={bid.id}
          className={`flex items-center justify-between p-3 rounded-lg ${
            index === 0
              ? 'bg-green-50 border border-green-200'
              : 'bg-gray-50'
          } ${bid.bidder_id === currentUserId ? 'ring-2 ring-primary-200' : ''}`}
        >
          <div className="flex items-center space-x-3">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                index === 0
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-300 text-gray-700'
              }`}
            >
              {bid.bidder_name.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="font-medium text-gray-900">
                {bid.bidder_name}
                {bid.bidder_id === currentUserId && (
                  <span className="ml-2 text-xs text-primary-600">(You)</span>
                )}
              </p>
              <p className="text-sm text-gray-500">
                {formatTime(bid.created_at)}
                {bid.is_auto_bid && (
                  <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                    Auto-bid
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p
              className={`font-bold ${
                index === 0 ? 'text-green-600' : 'text-gray-900'
              }`}
            >
              ${parseFloat(bid.amount).toFixed(2)}
            </p>
            {index === 0 && (
              <p className="text-xs text-green-600">Highest Bid</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
