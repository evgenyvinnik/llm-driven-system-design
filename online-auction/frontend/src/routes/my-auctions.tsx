import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { api } from '../services/api';
import { AuctionCard } from '../components/AuctionCard';
import type { Auction } from '../types';

export const Route = createFileRoute('/my-auctions')({
  component: MyAuctionsPage,
});

function MyAuctionsPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();

  const [activeTab, setActiveTab] = useState<'selling' | 'bidding'>('selling');
  const [sellingAuctions, setSellingAuctions] = useState<Auction[]>([]);
  const [biddingAuctions, setBiddingAuctions] = useState<Auction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [selling, bidding] = await Promise.all([
          api.getSellingAuctions(),
          api.getBidHistory(),
        ]);
        setSellingAuctions(selling.auctions);
        setBiddingAuctions(bidding.auctions);
      } catch (err) {
        console.error('Failed to fetch auctions:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [isAuthenticated, navigate]);

  if (!isAuthenticated) {
    return null;
  }

  const auctions = activeTab === 'selling' ? sellingAuctions : biddingAuctions;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">My Auctions</h1>
        <Link to="/create" className="btn-primary">
          Create Auction
        </Link>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-8">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab('selling')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'selling'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Selling ({sellingAuctions.length})
          </button>
          <button
            onClick={() => setActiveTab('bidding')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'bidding'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Bidding ({biddingAuctions.length})
          </button>
        </nav>
      </div>

      {isLoading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          <p className="mt-2 text-gray-600">Loading...</p>
        </div>
      ) : auctions.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-600">
            {activeTab === 'selling'
              ? "You haven't created any auctions yet."
              : "You haven't placed any bids yet."}
          </p>
          {activeTab === 'selling' && (
            <Link to="/create" className="mt-4 btn-primary inline-block">
              Create Your First Auction
            </Link>
          )}
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
