import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import type { Auction, AutoBid } from '../types';

interface BidFormProps {
  auction: Auction;
  userAutoBid: AutoBid | null;
  onBidPlaced: () => void;
}

export function BidForm({ auction, userAutoBid, onBidPlaced }: BidFormProps) {
  const { isAuthenticated } = useAuthStore();
  const [bidAmount, setBidAmount] = useState('');
  const [autoBidAmount, setAutoBidAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showAutoBid, setShowAutoBid] = useState(false);

  const minBid =
    parseFloat(auction.current_price) + parseFloat(auction.bid_increment || '1');

  const handlePlaceBid = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const amount = parseFloat(bidAmount);
    if (isNaN(amount) || amount < minBid) {
      setError(`Minimum bid is $${minBid.toFixed(2)}`);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.placeBid(auction.id, amount);
      setSuccess(
        result.is_winning
          ? `You are now the highest bidder at $${result.current_price.toFixed(2)}!`
          : `Bid placed. Current price: $${result.current_price.toFixed(2)}`
      );
      setBidAmount('');
      onBidPlaced();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to place bid');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetAutoBid = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const amount = parseFloat(autoBidAmount);
    if (isNaN(amount) || amount < minBid) {
      setError(`Maximum auto-bid must be at least $${minBid.toFixed(2)}`);
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.setAutoBid(auction.id, amount);
      setSuccess(
        `Auto-bid set! Maximum: $${parseFloat(result.auto_bid.max_amount).toFixed(2)}. ` +
          (result.is_winning
            ? 'You are the highest bidder.'
            : 'You have been outbid.')
      );
      setAutoBidAmount('');
      setShowAutoBid(false);
      onBidPlaced();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set auto-bid');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelAutoBid = async () => {
    setIsSubmitting(true);
    try {
      await api.cancelAutoBid(auction.id);
      setSuccess('Auto-bid cancelled');
      onBidPlaced();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel auto-bid');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="bg-gray-50 rounded-lg p-6 text-center">
        <p className="text-gray-600 mb-4">Sign in to place a bid</p>
        <a href="/login" className="btn-primary">
          Sign In
        </a>
      </div>
    );
  }

  if (auction.status !== 'active') {
    return (
      <div className="bg-gray-50 rounded-lg p-6 text-center">
        <p className="text-gray-600">This auction has ended</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md text-green-700">
          {success}
        </div>
      )}

      <form onSubmit={handlePlaceBid} className="mb-4">
        <div className="flex space-x-2">
          <div className="flex-1">
            <label htmlFor="bidAmount" className="sr-only">
              Bid Amount
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">
                $
              </span>
              <input
                type="number"
                id="bidAmount"
                value={bidAmount}
                onChange={(e) => setBidAmount(e.target.value)}
                placeholder={minBid.toFixed(2)}
                min={minBid}
                step="0.01"
                className="input pl-8"
                disabled={isSubmitting}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={isSubmitting}
            className="btn-primary whitespace-nowrap"
          >
            {isSubmitting ? 'Placing...' : 'Place Bid'}
          </button>
        </div>
        <p className="mt-2 text-sm text-gray-500">
          Minimum bid: ${minBid.toFixed(2)}
        </p>
      </form>

      <div className="border-t pt-4">
        {userAutoBid?.is_active ? (
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="flex justify-between items-center">
              <div>
                <p className="font-medium text-blue-900">Auto-Bid Active</p>
                <p className="text-sm text-blue-700">
                  Maximum: ${parseFloat(userAutoBid.max_amount).toFixed(2)}
                </p>
              </div>
              <button
                onClick={handleCancelAutoBid}
                disabled={isSubmitting}
                className="btn-danger text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : showAutoBid ? (
          <form onSubmit={handleSetAutoBid}>
            <p className="text-sm text-gray-600 mb-3">
              Set your maximum bid and we'll automatically bid for you up to that
              amount.
            </p>
            <div className="flex space-x-2">
              <div className="flex-1">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">
                    $
                  </span>
                  <input
                    type="number"
                    value={autoBidAmount}
                    onChange={(e) => setAutoBidAmount(e.target.value)}
                    placeholder="Maximum amount"
                    min={minBid}
                    step="0.01"
                    className="input pl-8"
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-success whitespace-nowrap"
              >
                Set Auto-Bid
              </button>
              <button
                type="button"
                onClick={() => setShowAutoBid(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowAutoBid(true)}
            className="text-primary-600 hover:text-primary-700 text-sm font-medium"
          >
            Set Auto-Bid
          </button>
        )}
      </div>
    </div>
  );
}
