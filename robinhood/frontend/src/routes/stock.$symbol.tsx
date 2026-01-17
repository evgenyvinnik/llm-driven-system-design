import { createFileRoute, redirect, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useQuoteStore } from '../stores/quoteStore';
import { usePortfolioStore } from '../stores/portfolioStore';
import { TradeForm } from '../components/TradeForm';
import { PriceDisplay } from '../components/QuoteDisplay';
import { AddToWatchlistModal } from '../components/Watchlist';
import { quotesApi } from '../services/api';

export const Route = createFileRoute('/stock/$symbol')({
  beforeLoad: () => {
    const { isAuthenticated } = useAuthStore.getState();
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: StockDetailPage,
});

interface StockDetails {
  symbol: string;
  name: string;
  marketCap: number;
  peRatio: number;
  week52High: number;
  week52Low: number;
  avgVolume: number;
  dividend: string | null;
  description: string;
}

function StockDetailPage() {
  const { symbol } = useParams({ from: '/stock/$symbol' });
  const [details, setDetails] = useState<StockDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showWatchlistModal, setShowWatchlistModal] = useState(false);

  const { getQuote, subscribe, unsubscribe } = useQuoteStore();
  const { portfolio } = usePortfolioStore();

  const quote = getQuote(symbol);
  const position = portfolio?.holdings.find((h) => h.symbol === symbol.toUpperCase());

  useEffect(() => {
    subscribe([symbol]);
    return () => unsubscribe([symbol]);
  }, [symbol, subscribe, unsubscribe]);

  useEffect(() => {
    const loadDetails = async () => {
      try {
        const data = await quotesApi.getStockDetails(symbol);
        setDetails(data);
      } catch (error) {
        console.error('Error loading stock details:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadDetails();
  }, [symbol]);

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-robinhood-gray-700 rounded w-1/4 mb-4" />
          <div className="h-12 bg-robinhood-gray-700 rounded w-1/3 mb-8" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 h-64 bg-robinhood-gray-700 rounded" />
            <div className="h-96 bg-robinhood-gray-700 rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h1 className="text-3xl font-bold text-white">{symbol}</h1>
                <p className="text-robinhood-gray-400">{details?.name}</p>
              </div>
              <button
                onClick={() => setShowWatchlistModal(true)}
                className="bg-robinhood-gray-700 text-white px-4 py-2 rounded-lg hover:bg-robinhood-gray-600 transition-colors"
              >
                Add to Watchlist
              </button>
            </div>
            <PriceDisplay quote={quote} size="lg" />
          </div>

          {/* Position Info */}
          {position && (
            <div className="bg-robinhood-gray-800 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Your Position</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-robinhood-gray-400 text-sm">Shares</p>
                  <p className="text-white font-semibold">
                    {position.quantity.toFixed(position.quantity % 1 === 0 ? 0 : 4)}
                  </p>
                </div>
                <div>
                  <p className="text-robinhood-gray-400 text-sm">Market Value</p>
                  <p className="text-white font-semibold">
                    ${position.marketValue.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-robinhood-gray-400 text-sm">Avg Cost</p>
                  <p className="text-white font-semibold">
                    ${position.avgCostBasis.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-robinhood-gray-400 text-sm">Total Return</p>
                  <p
                    className={`font-semibold ${
                      position.gainLoss >= 0
                        ? 'text-robinhood-green'
                        : 'text-robinhood-red'
                    }`}
                  >
                    {position.gainLoss >= 0 ? '+' : ''}
                    ${position.gainLoss.toFixed(2)} ({position.gainLossPercent.toFixed(2)}
                    %)
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Stock Stats */}
          <div className="bg-robinhood-gray-800 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Statistics</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <StatItem label="Open" value={`$${quote?.open.toFixed(2) || '--'}`} />
              <StatItem label="High" value={`$${quote?.high.toFixed(2) || '--'}`} />
              <StatItem label="Low" value={`$${quote?.low.toFixed(2) || '--'}`} />
              <StatItem
                label="Volume"
                value={formatVolume(quote?.volume || 0)}
              />
              <StatItem
                label="52W High"
                value={`$${details?.week52High.toFixed(2) || '--'}`}
              />
              <StatItem
                label="52W Low"
                value={`$${details?.week52Low.toFixed(2) || '--'}`}
              />
              <StatItem
                label="Market Cap"
                value={formatMarketCap(details?.marketCap || 0)}
              />
              <StatItem
                label="P/E Ratio"
                value={details?.peRatio.toFixed(2) || '--'}
              />
            </div>
          </div>

          {/* About */}
          {details?.description && (
            <div className="bg-robinhood-gray-800 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-white mb-4">About</h3>
              <p className="text-robinhood-gray-300">{details.description}</p>
            </div>
          )}
        </div>

        {/* Trade Panel */}
        <div>
          <TradeForm symbol={symbol} />
        </div>
      </div>

      {/* Watchlist Modal */}
      {showWatchlistModal && (
        <AddToWatchlistModal
          symbol={symbol}
          onClose={() => setShowWatchlistModal(false)}
        />
      )}
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-robinhood-gray-400 text-sm">{label}</p>
      <p className="text-white font-medium">{value}</p>
    </div>
  );
}

function formatVolume(volume: number): string {
  if (volume >= 1000000000) {
    return (volume / 1000000000).toFixed(2) + 'B';
  }
  if (volume >= 1000000) {
    return (volume / 1000000).toFixed(2) + 'M';
  }
  if (volume >= 1000) {
    return (volume / 1000).toFixed(2) + 'K';
  }
  return volume.toString();
}

function formatMarketCap(marketCap: number): string {
  if (marketCap >= 1000000000000) {
    return '$' + (marketCap / 1000000000000).toFixed(2) + 'T';
  }
  if (marketCap >= 1000000000) {
    return '$' + (marketCap / 1000000000).toFixed(2) + 'B';
  }
  if (marketCap >= 1000000) {
    return '$' + (marketCap / 1000000).toFixed(2) + 'M';
  }
  return '$' + marketCap.toString();
}
