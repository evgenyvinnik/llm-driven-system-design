/**
 * Application header component with navigation and user controls.
 * Displays logo, navigation links, connection status indicator,
 * and authentication controls (login/logout).
 */

import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useQuoteStore } from '../stores/quoteStore';

/**
 * Main application header component.
 * Shows navigation for authenticated users and login/register for guests.
 * Includes real-time connection status indicator.
 */
export function Header() {
  const { user, isAuthenticated, logout } = useAuthStore();
  const { isConnected } = useQuoteStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <header className="bg-robinhood-dark border-b border-robinhood-gray-700">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-8">
            <Link to="/" className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-robinhood-green rounded-full flex items-center justify-center">
                <span className="text-black font-bold text-lg">R</span>
              </div>
              <span className="text-xl font-semibold text-white">Robinhood</span>
            </Link>

            {isAuthenticated && (
              <nav className="hidden md:flex items-center space-x-6">
                <Link
                  to="/"
                  className="text-robinhood-gray-300 hover:text-white transition-colors"
                  activeProps={{ className: 'text-white' }}
                >
                  Portfolio
                </Link>
                <Link
                  to="/stocks"
                  className="text-robinhood-gray-300 hover:text-white transition-colors"
                  activeProps={{ className: 'text-white' }}
                >
                  Stocks
                </Link>
                <Link
                  to="/orders"
                  className="text-robinhood-gray-300 hover:text-white transition-colors"
                  activeProps={{ className: 'text-white' }}
                >
                  Orders
                </Link>
                <Link
                  to="/watchlist"
                  className="text-robinhood-gray-300 hover:text-white transition-colors"
                  activeProps={{ className: 'text-white' }}
                >
                  Watchlist
                </Link>
              </nav>
            )}
          </div>

          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  isConnected ? 'bg-robinhood-green' : 'bg-robinhood-red'
                }`}
              />
              <span className="text-xs text-robinhood-gray-400">
                {isConnected ? 'Live' : 'Offline'}
              </span>
            </div>

            {isAuthenticated ? (
              <div className="flex items-center space-x-4">
                <span className="text-robinhood-gray-300 text-sm">
                  {user?.firstName || user?.email}
                </span>
                <button
                  onClick={handleLogout}
                  className="text-sm text-robinhood-gray-400 hover:text-white transition-colors"
                >
                  Logout
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-4">
                <Link
                  to="/login"
                  className="text-sm text-robinhood-gray-300 hover:text-white transition-colors"
                >
                  Log In
                </Link>
                <Link
                  to="/register"
                  className="text-sm bg-robinhood-green text-black px-4 py-2 rounded-full font-medium hover:bg-opacity-90 transition-colors"
                >
                  Sign Up
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
