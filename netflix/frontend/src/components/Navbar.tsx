import React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Search, Bell, ChevronDown, User } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';

export function Navbar() {
  const { currentProfile, clearProfile, logout } = useAuthStore();
  const navigate = useNavigate();
  const [isScrolled, setIsScrolled] = React.useState(false);
  const [showSearch, setShowSearch] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [showProfileMenu, setShowProfileMenu] = React.useState(false);

  React.useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 0);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate({ to: '/search', search: { q: searchQuery } });
    }
  };

  const handleSwitchProfile = () => {
    clearProfile();
    navigate({ to: '/profiles' });
  };

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-colors duration-300 ${
        isScrolled ? 'bg-netflix-black' : 'bg-gradient-to-b from-black/80 to-transparent'
      }`}
    >
      <div className="flex items-center justify-between px-4 md:px-12 py-4">
        {/* Left side */}
        <div className="flex items-center gap-8">
          {/* Logo */}
          <Link to="/browse" className="text-netflix-red font-bold text-2xl">
            NETFLIX
          </Link>

          {/* Navigation links */}
          <div className="hidden md:flex items-center gap-6 text-sm">
            <Link
              to="/browse"
              className="text-white hover:text-netflix-light-gray transition-colors"
            >
              Home
            </Link>
            <Link
              to="/browse/series"
              className="text-netflix-light-gray hover:text-white transition-colors"
            >
              TV Shows
            </Link>
            <Link
              to="/browse/movies"
              className="text-netflix-light-gray hover:text-white transition-colors"
            >
              Movies
            </Link>
            <Link
              to="/my-list"
              className="text-netflix-light-gray hover:text-white transition-colors"
            >
              My List
            </Link>
          </div>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-4">
          {/* Search */}
          <div className="relative">
            {showSearch ? (
              <form onSubmit={handleSearch} className="flex items-center">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Titles, people, genres"
                  className="bg-black/80 border border-white px-3 py-1 text-white text-sm w-48 md:w-64 focus:outline-none"
                  autoFocus
                  onBlur={() => {
                    if (!searchQuery) setShowSearch(false);
                  }}
                />
              </form>
            ) : (
              <button
                onClick={() => setShowSearch(true)}
                className="text-white hover:text-netflix-light-gray"
              >
                <Search size={20} />
              </button>
            )}
          </div>

          {/* Notifications */}
          <button className="text-white hover:text-netflix-light-gray">
            <Bell size={20} />
          </button>

          {/* Profile dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu(!showProfileMenu)}
              className="flex items-center gap-2 hover:opacity-80"
            >
              <div className="w-8 h-8 rounded bg-netflix-red flex items-center justify-center">
                {currentProfile?.avatarUrl ? (
                  <img
                    src={currentProfile.avatarUrl}
                    alt={currentProfile.name}
                    className="w-full h-full rounded object-cover"
                  />
                ) : (
                  <User size={20} className="text-white" />
                )}
              </div>
              <ChevronDown
                size={16}
                className={`text-white transition-transform ${showProfileMenu ? 'rotate-180' : ''}`}
              />
            </button>

            {showProfileMenu && (
              <div className="absolute right-0 top-full mt-2 w-48 bg-black/95 border border-zinc-700 rounded py-2">
                <div className="px-4 py-2 border-b border-zinc-700">
                  <p className="text-white font-medium">{currentProfile?.name}</p>
                </div>
                <button
                  onClick={handleSwitchProfile}
                  className="w-full px-4 py-2 text-left text-sm text-netflix-light-gray hover:text-white"
                >
                  Switch Profile
                </button>
                <button
                  onClick={handleLogout}
                  className="w-full px-4 py-2 text-left text-sm text-netflix-light-gray hover:text-white"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
