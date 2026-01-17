import { Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Search, User, Menu, X } from 'lucide-react';
import { useState } from 'react';

export function Header() {
  const { user, currentProfile, logout } = useAuthStore();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-gradient-to-b from-black/90 to-transparent">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center space-x-2">
            <svg
              className="w-8 h-8"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 17 2.94 12.45 4.7 9.39C5.57 7.87 7.13 6.91 8.82 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.09 16.67C20.06 16.74 19.67 18.11 18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" />
            </svg>
            <span className="text-xl font-semibold tracking-tight">tv+</span>
          </Link>

          {/* Navigation - Desktop */}
          <nav className="hidden md:flex items-center space-x-8">
            <Link
              to="/"
              className="text-sm font-medium text-white/80 hover:text-white transition-colors"
            >
              Home
            </Link>
            <Link
              to="/movies"
              className="text-sm font-medium text-white/80 hover:text-white transition-colors"
            >
              Movies
            </Link>
            <Link
              to="/shows"
              className="text-sm font-medium text-white/80 hover:text-white transition-colors"
            >
              TV Shows
            </Link>
            {currentProfile && (
              <Link
                to="/watchlist"
                className="text-sm font-medium text-white/80 hover:text-white transition-colors"
              >
                My List
              </Link>
            )}
          </nav>

          {/* Right side */}
          <div className="flex items-center space-x-4">
            {/* Search */}
            {showSearch ? (
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search..."
                  className="w-48 px-4 py-2 bg-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-apple-blue"
                  autoFocus
                  onBlur={() => setShowSearch(false)}
                />
              </div>
            ) : (
              <button
                onClick={() => setShowSearch(true)}
                className="p-2 text-white/80 hover:text-white transition-colors"
              >
                <Search className="w-5 h-5" />
              </button>
            )}

            {/* User menu */}
            {user ? (
              <div className="relative">
                <button
                  onClick={() => setIsMenuOpen(!isMenuOpen)}
                  className="flex items-center space-x-2 p-2 text-white/80 hover:text-white transition-colors"
                >
                  <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
                    {currentProfile?.name.charAt(0).toUpperCase() || <User className="w-4 h-4" />}
                  </div>
                </button>

                {isMenuOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-apple-gray-800 rounded-lg shadow-xl py-2 animate-fade-in">
                    <div className="px-4 py-2 border-b border-white/10">
                      <p className="text-sm font-medium">{user.name}</p>
                      <p className="text-xs text-white/60">{user.email}</p>
                    </div>

                    {currentProfile && (
                      <div className="px-4 py-2 border-b border-white/10">
                        <p className="text-xs text-white/60">Profile</p>
                        <p className="text-sm">{currentProfile.name}</p>
                      </div>
                    )}

                    <Link
                      to="/profiles"
                      className="block px-4 py-2 text-sm text-white/80 hover:bg-white/10"
                      onClick={() => setIsMenuOpen(false)}
                    >
                      Switch Profile
                    </Link>

                    <Link
                      to="/account"
                      className="block px-4 py-2 text-sm text-white/80 hover:bg-white/10"
                      onClick={() => setIsMenuOpen(false)}
                    >
                      Account Settings
                    </Link>

                    {user.role === 'admin' && (
                      <Link
                        to="/admin"
                        className="block px-4 py-2 text-sm text-white/80 hover:bg-white/10"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        Admin Dashboard
                      </Link>
                    )}

                    <button
                      onClick={() => {
                        logout();
                        setIsMenuOpen(false);
                      }}
                      className="block w-full text-left px-4 py-2 text-sm text-apple-red hover:bg-white/10"
                    >
                      Sign Out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Link
                to="/login"
                className="px-4 py-2 bg-apple-blue text-white text-sm font-medium rounded-lg hover:bg-blue-600 transition-colors"
              >
                Sign In
              </Link>
            )}

            {/* Mobile menu button */}
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="md:hidden p-2 text-white/80 hover:text-white"
            >
              {isMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile navigation */}
      {isMenuOpen && (
        <div className="md:hidden bg-black/95 animate-fade-in">
          <nav className="px-4 py-4 space-y-2">
            <Link
              to="/"
              className="block px-4 py-2 text-white/80 hover:text-white"
              onClick={() => setIsMenuOpen(false)}
            >
              Home
            </Link>
            <Link
              to="/movies"
              className="block px-4 py-2 text-white/80 hover:text-white"
              onClick={() => setIsMenuOpen(false)}
            >
              Movies
            </Link>
            <Link
              to="/shows"
              className="block px-4 py-2 text-white/80 hover:text-white"
              onClick={() => setIsMenuOpen(false)}
            >
              TV Shows
            </Link>
            {currentProfile && (
              <Link
                to="/watchlist"
                className="block px-4 py-2 text-white/80 hover:text-white"
                onClick={() => setIsMenuOpen(false)}
              >
                My List
              </Link>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
