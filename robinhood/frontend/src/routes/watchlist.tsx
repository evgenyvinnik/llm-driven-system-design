/**
 * Watchlist page route (/watchlist).
 * Manages user's stock watchlists and price alerts.
 * Requires authentication.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { usePortfolioStore } from '../stores/portfolioStore';
import { WatchlistView } from '../components/Watchlist';

/** Route definition with auth guard */
export const Route = createFileRoute('/watchlist')({
  beforeLoad: () => {
    const { isAuthenticated } = useAuthStore.getState();
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: WatchlistPage,
});

/**
 * Watchlist page component.
 * Provides interface for creating/deleting watchlists and managing price alerts.
 * Displays all user watchlists with their stocks and active price alerts.
 */
function WatchlistPage() {
  const {
    watchlists,
    alerts,
    fetchWatchlists,
    fetchAlerts,
    createWatchlist,
    deleteWatchlist,
    createAlert,
    deleteAlert,
  } = usePortfolioStore();

  const [showNewWatchlist, setShowNewWatchlist] = useState(false);
  const [newWatchlistName, setNewWatchlistName] = useState('');
  const [showNewAlert, setShowNewAlert] = useState(false);
  const [alertSymbol, setAlertSymbol] = useState('');
  const [alertPrice, setAlertPrice] = useState('');
  const [alertCondition, setAlertCondition] = useState<'above' | 'below'>('above');

  useEffect(() => {
    fetchWatchlists();
    fetchAlerts();
  }, [fetchWatchlists, fetchAlerts]);

  const handleCreateWatchlist = async () => {
    if (!newWatchlistName.trim()) return;
    try {
      await createWatchlist(newWatchlistName.trim());
      setNewWatchlistName('');
      setShowNewWatchlist(false);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleDeleteWatchlist = async (watchlistId: string) => {
    if (window.confirm('Are you sure you want to delete this watchlist?')) {
      try {
        await deleteWatchlist(watchlistId);
      } catch (error) {
        alert((error as Error).message);
      }
    }
  };

  const handleCreateAlert = async () => {
    if (!alertSymbol || !alertPrice) return;
    try {
      await createAlert(alertSymbol.toUpperCase(), parseFloat(alertPrice), alertCondition);
      setAlertSymbol('');
      setAlertPrice('');
      setShowNewAlert(false);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Watchlists */}
        <div className="lg:col-span-2 space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-white">Watchlists</h1>
            <button
              onClick={() => setShowNewWatchlist(true)}
              className="bg-robinhood-green text-black px-4 py-2 rounded-lg font-medium hover:bg-opacity-90 transition-colors"
            >
              New Watchlist
            </button>
          </div>

          {/* New Watchlist Form */}
          {showNewWatchlist && (
            <div className="bg-robinhood-gray-800 rounded-lg p-4">
              <div className="flex items-center space-x-4">
                <input
                  type="text"
                  value={newWatchlistName}
                  onChange={(e) => setNewWatchlistName(e.target.value)}
                  placeholder="Watchlist name"
                  className="flex-1 bg-robinhood-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
                />
                <button
                  onClick={handleCreateWatchlist}
                  className="bg-robinhood-green text-black px-4 py-2 rounded-lg font-medium"
                >
                  Create
                </button>
                <button
                  onClick={() => setShowNewWatchlist(false)}
                  className="text-robinhood-gray-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <WatchlistView />

          {/* Delete Watchlist Buttons */}
          {watchlists.length > 0 && (
            <div className="space-y-2">
              {watchlists.map((watchlist) => (
                <div
                  key={watchlist.id}
                  className="flex items-center justify-between bg-robinhood-gray-800 rounded-lg p-4"
                >
                  <span className="text-white">{watchlist.name}</span>
                  <button
                    onClick={() => handleDeleteWatchlist(watchlist.id)}
                    className="text-robinhood-red text-sm hover:underline"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Price Alerts */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-white">Price Alerts</h2>
            <button
              onClick={() => setShowNewAlert(true)}
              className="bg-robinhood-gray-700 text-white px-3 py-1 rounded-lg text-sm hover:bg-robinhood-gray-600 transition-colors"
            >
              Add Alert
            </button>
          </div>

          {/* New Alert Form */}
          {showNewAlert && (
            <div className="bg-robinhood-gray-800 rounded-lg p-4 space-y-4">
              <input
                type="text"
                value={alertSymbol}
                onChange={(e) => setAlertSymbol(e.target.value)}
                placeholder="Symbol (e.g., AAPL)"
                className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
              />
              <div className="flex space-x-2">
                <select
                  value={alertCondition}
                  onChange={(e) => setAlertCondition(e.target.value as 'above' | 'below')}
                  className="bg-robinhood-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
                >
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                </select>
                <input
                  type="number"
                  value={alertPrice}
                  onChange={(e) => setAlertPrice(e.target.value)}
                  placeholder="Price"
                  className="flex-1 bg-robinhood-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
                />
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={handleCreateAlert}
                  className="flex-1 bg-robinhood-green text-black py-2 rounded-lg font-medium"
                >
                  Create Alert
                </button>
                <button
                  onClick={() => setShowNewAlert(false)}
                  className="px-4 py-2 text-robinhood-gray-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Alerts List */}
          <div className="bg-robinhood-gray-800 rounded-lg p-6">
            {alerts.length === 0 ? (
              <p className="text-robinhood-gray-400">No price alerts</p>
            ) : (
              <div className="space-y-4">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`flex items-center justify-between p-4 rounded-lg ${
                      alert.triggered
                        ? 'bg-robinhood-green bg-opacity-10 border border-robinhood-green'
                        : 'bg-robinhood-gray-700'
                    }`}
                  >
                    <div>
                      <p className="text-white font-medium">{alert.symbol}</p>
                      <p className="text-sm text-robinhood-gray-400">
                        {alert.condition === 'above' ? 'Above' : 'Below'} $
                        {alert.target_price.toFixed(2)}
                      </p>
                    </div>
                    <div className="flex items-center space-x-4">
                      {alert.triggered && (
                        <span className="text-robinhood-green text-sm">Triggered!</span>
                      )}
                      <button
                        onClick={() => deleteAlert(alert.id)}
                        className="text-robinhood-red text-sm hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
