import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Search, Bell, Plus, Menu, X, GitBranch } from 'lucide-react';

export function Header() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate({ to: '/search', search: { q: searchQuery } });
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  return (
    <header className="bg-github-surface border-b border-github-border sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo and Navigation */}
          <div className="flex items-center space-x-4">
            <Link to="/" className="flex items-center space-x-2">
              <GitBranch className="w-8 h-8 text-white" />
              <span className="text-xl font-bold text-white hidden sm:block">GitHub</span>
            </Link>

            {/* Search */}
            <form onSubmit={handleSearch} className="hidden md:block">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-github-muted" />
                <input
                  type="text"
                  placeholder="Search or jump to..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-64 pl-10 pr-4 py-1.5 bg-github-bg border border-github-border rounded-md text-sm focus:outline-none focus:border-github-accent focus:ring-1 focus:ring-github-accent"
                />
              </div>
            </form>

            {/* Nav Links */}
            <nav className="hidden md:flex items-center space-x-4">
              <Link to="/explore" className="text-sm text-github-text hover:text-white">
                Explore
              </Link>
            </nav>
          </div>

          {/* Right side */}
          <div className="flex items-center space-x-4">
            {user ? (
              <>
                <button className="text-github-text hover:text-white">
                  <Bell className="w-5 h-5" />
                </button>

                {/* Create dropdown */}
                <div className="relative">
                  <button
                    onClick={() => navigate({ to: '/new' })}
                    className="flex items-center space-x-1 text-github-text hover:text-white"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>

                {/* User menu */}
                <div className="relative">
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center space-x-2"
                  >
                    <div className="w-8 h-8 rounded-full bg-github-accent flex items-center justify-center text-white text-sm font-medium">
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                  </button>

                  {userMenuOpen && (
                    <div className="absolute right-0 mt-2 w-48 bg-github-surface border border-github-border rounded-md shadow-lg py-1 z-50">
                      <div className="px-4 py-2 text-sm text-github-muted border-b border-github-border">
                        Signed in as <span className="font-semibold text-github-text">{user.username}</span>
                      </div>
                      <Link
                        to={`/${user.username}`}
                        className="block px-4 py-2 text-sm text-github-text hover:bg-github-bg"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        Your profile
                      </Link>
                      <Link
                        to="/settings"
                        className="block px-4 py-2 text-sm text-github-text hover:bg-github-bg"
                        onClick={() => setUserMenuOpen(false)}
                      >
                        Settings
                      </Link>
                      <button
                        onClick={() => {
                          setUserMenuOpen(false);
                          handleLogout();
                        }}
                        className="block w-full text-left px-4 py-2 text-sm text-github-text hover:bg-github-bg border-t border-github-border"
                      >
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center space-x-4">
                <Link to="/login" className="text-sm text-github-text hover:text-white">
                  Sign in
                </Link>
                <Link
                  to="/register"
                  className="text-sm px-4 py-1.5 bg-github-success text-white rounded-md hover:bg-green-600"
                >
                  Sign up
                </Link>
              </div>
            )}

            {/* Mobile menu button */}
            <button
              className="md:hidden text-github-text hover:text-white"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-github-border">
            <form onSubmit={handleSearch} className="mb-4">
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-2 bg-github-bg border border-github-border rounded-md text-sm"
              />
            </form>
            <nav className="space-y-2">
              <Link
                to="/explore"
                className="block text-github-text hover:text-white py-2"
                onClick={() => setMobileMenuOpen(false)}
              >
                Explore
              </Link>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
