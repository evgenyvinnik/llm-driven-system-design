/**
 * @fileoverview Header component with navigation, search, and user menu.
 * Provides site-wide navigation including logo, search bar, and user controls.
 * Search results appear in a dropdown with real-time filtering.
 */

import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Avatar } from './Avatar';
import { useAuthStore } from '@/stores/authStore';
import { usersApi } from '@/services/api';
import type { User } from '@/types';

/**
 * Site header with logo, search, navigation, and user menu.
 * Shows login button when unauthenticated, profile dropdown when authenticated.
 * Search fetches users in real-time as user types.
 *
 * @returns JSX element rendering the header
 */
export function Header() {
  const { user, isAuthenticated, logout } = useAuthStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const navigate = useNavigate();

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }

    try {
      const response = await usersApi.searchUsers(query);
      setSearchResults(response.users);
      setShowResults(true);
    } catch (error) {
      console.error('Search failed:', error);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <header className="fixed top-0 left-0 right-0 bg-white shadow-sm z-50">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <Link to="/" className="text-facebook-blue">
            <svg className="w-10 h-10" viewBox="0 0 36 36" fill="currentColor">
              <path d="M20.181 35.87C29.094 34.791 36 27.202 36 18c0-9.941-8.059-18-18-18S0 8.059 0 18c0 4.991 2.032 9.507 5.313 12.763l.006.006C7.877 33.328 11.67 35.136 15.9 35.809v-9.915h-4.4V21.5h4.4v-3.1c0-4.357 2.588-6.76 6.531-6.76 1.897 0 3.87.34 3.87.34v4.27h-2.18c-2.15 0-2.82 1.335-2.82 2.705V21.5h4.8l-.77 4.394h-4.03v9.976z" />
            </svg>
          </Link>

          {/* Search */}
          <div className="relative ml-2">
            <div className="flex items-center bg-gray-100 rounded-full px-3 py-2">
              <svg className="w-4 h-4 text-facebook-darkGray" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                onFocus={() => searchResults.length > 0 && setShowResults(true)}
                onBlur={() => setTimeout(() => setShowResults(false), 200)}
                className="bg-transparent border-0 outline-none text-sm ml-2 w-48 placeholder-facebook-darkGray"
              />
            </div>

            {/* Search Results Dropdown */}
            {showResults && searchResults.length > 0 && (
              <div className="absolute top-full left-0 mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 max-h-96 overflow-y-auto">
                {searchResults.map((result) => (
                  <Link
                    key={result.id}
                    to="/profile/$username"
                    params={{ username: result.username }}
                    className="flex items-center gap-3 p-3 hover:bg-gray-100 transition-colors"
                    onClick={() => {
                      setShowResults(false);
                      setSearchQuery('');
                    }}
                  >
                    <Avatar src={result.avatar_url} name={result.display_name} size="md" />
                    <div>
                      <div className="font-semibold text-facebook-text">
                        {result.display_name}
                        {result.is_celebrity && (
                          <span className="ml-1 text-facebook-blue">
                            <svg className="w-4 h-4 inline" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-facebook-darkGray">@{result.username}</div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex items-center gap-2">
          <Link
            to="/"
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-facebook-darkGray [&.active]:text-facebook-blue"
          >
            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
            </svg>
          </Link>
        </nav>

        {/* User Menu */}
        <div className="flex items-center gap-2">
          {isAuthenticated && user ? (
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="flex items-center gap-2 p-1 rounded-full hover:bg-gray-100 transition-colors"
              >
                <Avatar src={user.avatar_url} name={user.display_name} size="sm" />
                <svg className="w-3 h-3 text-facebook-darkGray" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>

              {showMenu && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 py-2">
                  <Link
                    to="/profile/$username"
                    params={{ username: user.username }}
                    className="flex items-center gap-3 p-3 hover:bg-gray-100 transition-colors"
                    onClick={() => setShowMenu(false)}
                  >
                    <Avatar src={user.avatar_url} name={user.display_name} size="md" />
                    <div>
                      <div className="font-semibold text-facebook-text">{user.display_name}</div>
                      <div className="text-sm text-facebook-darkGray">See your profile</div>
                    </div>
                  </Link>
                  <div className="border-t border-gray-200 my-2" />
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      handleLogout();
                    }}
                    className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-gray-100 transition-colors"
                  >
                    <div className="w-9 h-9 bg-gray-200 rounded-full flex items-center justify-center">
                      <svg className="w-5 h-5 text-facebook-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                      </svg>
                    </div>
                    <span className="font-medium text-facebook-text">Log Out</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              to="/login"
              className="bg-facebook-blue text-white px-4 py-1.5 rounded-md font-semibold hover:bg-blue-600 transition-colors"
            >
              Log in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
