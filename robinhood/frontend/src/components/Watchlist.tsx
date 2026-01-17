/**
 * Watchlist and stock search components.
 * Allows users to track stocks, add to watchlists, and search for new symbols.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { usePortfolioStore } from '../stores/portfolioStore';
import { useQuoteStore } from '../stores/quoteStore';
import { QuoteCard } from './QuoteDisplay';
import { quotesApi } from '../services/api';
import type { Stock } from '../types';

/**
 * Displays all user watchlists with their items and real-time quotes.
 * Allows removing items from watchlists.
 */
export function WatchlistView() {
  const { watchlists, fetchWatchlists, removeFromWatchlist } = usePortfolioStore();
  const { quotes, subscribe, unsubscribe } = useQuoteStore();

  const symbols = useMemo(
    () => watchlists.flatMap((w) => w.items.map((i) => i.symbol)),
    [watchlists]
  );

  useEffect(() => {
    fetchWatchlists();
  }, [fetchWatchlists]);

  useEffect(() => {
    if (symbols.length > 0) {
      subscribe(symbols);
      return () => unsubscribe(symbols);
    }
  }, [symbols, subscribe, unsubscribe]);

  if (watchlists.length === 0) {
    return (
      <div className="bg-robinhood-gray-800 rounded-lg p-6">
        <p className="text-robinhood-gray-400">No watchlists yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {watchlists.map((watchlist) => (
        <div key={watchlist.id} className="bg-robinhood-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">{watchlist.name}</h3>
          {watchlist.items.length === 0 ? (
            <p className="text-robinhood-gray-400">No stocks in this watchlist</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {watchlist.items.map((item) => (
                <div key={item.id} className="relative group">
                  <Link to="/stock/$symbol" params={{ symbol: item.symbol }}>
                    <QuoteCard
                      symbol={item.symbol}
                      quote={quotes.get(item.symbol)}
                    />
                  </Link>
                  <button
                    onClick={() => removeFromWatchlist(watchlist.id, item.symbol)}
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-robinhood-gray-700 rounded-full p-1 hover:bg-robinhood-gray-600"
                  >
                    <span className="text-robinhood-gray-400 text-sm">x</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Props for the AddToWatchlistModal component.
 */
interface AddToWatchlistModalProps {
  /** Stock symbol to add to a watchlist */
  symbol: string;
  /** Callback to close the modal */
  onClose: () => void;
}

/**
 * Modal dialog for adding a stock to an existing or new watchlist.
 * @param symbol - Stock symbol to add
 * @param onClose - Callback to close the modal
 */
export function AddToWatchlistModal({ symbol, onClose }: AddToWatchlistModalProps) {
  const { watchlists, fetchWatchlists, addToWatchlist, createWatchlist } = usePortfolioStore();
  const [newWatchlistName, setNewWatchlistName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWatchlists();
  }, [fetchWatchlists]);

  const handleAddToWatchlist = async (watchlistId: string) => {
    try {
      await addToWatchlist(watchlistId, symbol);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCreateWatchlist = async () => {
    if (!newWatchlistName.trim()) return;

    setIsCreating(true);
    try {
      const watchlist = await createWatchlist(newWatchlistName.trim());
      await addToWatchlist(watchlist.id, symbol);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-robinhood-gray-800 rounded-lg p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-white">
            Add {symbol} to Watchlist
          </h2>
          <button onClick={onClose} className="text-robinhood-gray-400 hover:text-white">
            x
          </button>
        </div>

        {error && (
          <div className="bg-robinhood-red bg-opacity-20 text-robinhood-red rounded-lg p-3 mb-4 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-2 mb-6">
          {watchlists.map((watchlist) => (
            <button
              key={watchlist.id}
              onClick={() => handleAddToWatchlist(watchlist.id)}
              className="w-full text-left p-3 bg-robinhood-gray-700 rounded-lg hover:bg-robinhood-gray-600 transition-colors text-white"
            >
              {watchlist.name}
              <span className="text-robinhood-gray-400 text-sm ml-2">
                ({watchlist.items.length} items)
              </span>
            </button>
          ))}
        </div>

        <div className="border-t border-robinhood-gray-700 pt-4">
          <p className="text-robinhood-gray-400 text-sm mb-2">Or create a new watchlist</p>
          <div className="flex space-x-2">
            <input
              type="text"
              value={newWatchlistName}
              onChange={(e) => setNewWatchlistName(e.target.value)}
              placeholder="Watchlist name"
              className="flex-1 bg-robinhood-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
            />
            <button
              onClick={handleCreateWatchlist}
              disabled={!newWatchlistName.trim() || isCreating}
              className="bg-robinhood-green text-black px-4 py-2 rounded-lg font-medium disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Stock search component with filter functionality.
 * Displays all available stocks in a searchable grid with real-time quotes.
 */
export function StockSearch() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const { quotes, subscribe, unsubscribe } = useQuoteStore();

  useEffect(() => {
    const loadStocks = async () => {
      try {
        const data = await quotesApi.getStocks();
        setStocks(data);
        subscribe(data.map((s) => s.symbol));
      } catch (error) {
        console.error('Error loading stocks:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadStocks();

    return () => {
      if (stocks.length > 0) {
        unsubscribe(stocks.map((s) => s.symbol));
      }
    };
  }, []);

  const filteredStocks = useMemo(() => {
    if (!search.trim()) return stocks;
    const searchLower = search.toLowerCase();
    return stocks.filter(
      (s) =>
        s.symbol.toLowerCase().includes(searchLower) ||
        s.name.toLowerCase().includes(searchLower)
    );
  }, [stocks, search]);

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 bg-robinhood-gray-700 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search stocks..."
          className="w-full bg-robinhood-gray-800 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredStocks.map((stock) => (
          <Link
            key={stock.symbol}
            to="/stock/$symbol"
            params={{ symbol: stock.symbol }}
          >
            <QuoteCard
              symbol={stock.symbol}
              name={stock.name}
              quote={quotes.get(stock.symbol)}
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
