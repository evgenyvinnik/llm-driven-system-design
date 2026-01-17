/**
 * Main navigation header component.
 * Displays the site logo, navigation links, and user authentication status.
 * Shows different options for authenticated vs. guest users.
 */
import { Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/auth.store';

/**
 * Header component with navigation and auth controls.
 * @returns The rendered header element
 */
export function Header() {
  const { user, isAuthenticated, logout } = useAuthStore();

  return (
    <header className="bg-ticketmaster-darkBlue text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link to="/" className="flex items-center space-x-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-8 h-8 text-ticketmaster-blue"
            >
              <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
              <path d="M13 5v2" />
              <path d="M13 17v2" />
              <path d="M13 11v2" />
            </svg>
            <span className="font-bold text-xl">Ticketmaster</span>
          </Link>

          <nav className="flex items-center space-x-6">
            <Link
              to="/"
              className="text-gray-300 hover:text-white transition-colors"
            >
              Events
            </Link>

            {isAuthenticated ? (
              <>
                <Link
                  to="/orders"
                  className="text-gray-300 hover:text-white transition-colors"
                >
                  My Orders
                </Link>
                <div className="flex items-center space-x-4">
                  <span className="text-sm text-gray-400">
                    {user?.name}
                  </span>
                  <button
                    onClick={() => logout()}
                    className="text-gray-300 hover:text-white transition-colors text-sm"
                  >
                    Logout
                  </button>
                </div>
              </>
            ) : (
              <Link
                to="/login"
                className="bg-ticketmaster-blue hover:bg-blue-600 px-4 py-2 rounded-md transition-colors"
              >
                Sign In
              </Link>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}
