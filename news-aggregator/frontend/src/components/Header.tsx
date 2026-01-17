/**
 * Application header component.
 * Provides navigation, search, and user authentication controls.
 * @module components/Header
 */

import { Link, useRouter } from '@tanstack/react-router';
import { Newspaper, Search, Settings, LogIn, LogOut, User, Shield } from 'lucide-react';
import { useAuthStore } from '../stores';
import { useState } from 'react';

/**
 * Main application header with navigation and auth controls.
 * Displays differently based on authentication state:
 * - Logged out: Shows sign in button
 * - Logged in: Shows user info, settings, and logout
 * - Admin: Additionally shows admin dashboard link
 * @returns Header element with navigation, search, and auth controls
 */
export function Header() {
  const { user, logout } = useAuthStore();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');

  /**
   * Handle search form submission.
   * Navigates to search page with query parameter.
   */
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.navigate({ to: '/search', search: { q: searchQuery } });
    }
  };

  /**
   * Handle user logout.
   * Clears session and redirects to home page.
   */
  const handleLogout = async () => {
    await logout();
    router.navigate({ to: '/' });
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <Link to="/" className="flex items-center gap-2 text-xl font-bold text-gray-900">
              <Newspaper className="w-6 h-6 text-primary-600" />
              <span>NewsAgg</span>
            </Link>

            <nav className="hidden md:flex items-center gap-6">
              <Link
                to="/"
                className="text-gray-600 hover:text-gray-900 font-medium"
                activeProps={{ className: 'text-primary-600' }}
              >
                Feed
              </Link>
              <Link
                to="/trending"
                className="text-gray-600 hover:text-gray-900 font-medium"
                activeProps={{ className: 'text-primary-600' }}
              >
                Trending
              </Link>
              <Link
                to="/topics"
                className="text-gray-600 hover:text-gray-900 font-medium"
                activeProps={{ className: 'text-primary-600' }}
              >
                Topics
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <form onSubmit={handleSearch} className="hidden sm:block">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search news..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-64 pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm"
                />
              </div>
            </form>

            {user ? (
              <div className="flex items-center gap-4">
                {user.role === 'admin' && (
                  <Link to="/admin" className="text-gray-600 hover:text-gray-900">
                    <Shield className="w-5 h-5" />
                  </Link>
                )}
                <Link to="/settings" className="text-gray-600 hover:text-gray-900">
                  <Settings className="w-5 h-5" />
                </Link>
                <div className="flex items-center gap-2">
                  <User className="w-5 h-5 text-gray-400" />
                  <span className="text-sm text-gray-700">{user.username}</span>
                </div>
                <button
                  onClick={handleLogout}
                  className="text-gray-600 hover:text-gray-900"
                  title="Logout"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <Link to="/login" className="btn btn-primary text-sm">
                <LogIn className="w-4 h-4 mr-2" />
                Sign In
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
