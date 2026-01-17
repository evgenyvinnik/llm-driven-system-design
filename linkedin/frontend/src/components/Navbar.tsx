import { Link, useNavigate } from '@tanstack/react-router';
import {
  Home,
  Users,
  Briefcase,
  MessageSquare,
  Bell,
  Search,
  ChevronDown,
  LogOut,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useState } from 'react';

export function Navbar() {
  const { user, isAuthenticated, logout } = useAuthStore();
  const navigate = useNavigate();
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate({ to: '/search', search: { q: searchQuery } });
    }
  };

  if (!isAuthenticated) {
    return (
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between h-14">
            <Link to="/" className="text-linkedin-blue font-bold text-2xl">
              LinkedIn
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/login" className="text-gray-600 hover:text-gray-900">
                Sign in
              </Link>
              <Link to="/register" className="btn-secondary text-sm">
                Join now
              </Link>
            </div>
          </div>
        </div>
      </nav>
    );
  }

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <Link to="/" className="text-linkedin-blue font-bold text-2xl">
              in
            </Link>

            <form onSubmit={handleSearch} className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 bg-gray-100 rounded w-64 text-sm focus:outline-none focus:ring-2 focus:ring-linkedin-blue"
              />
            </form>
          </div>

          <div className="flex items-center gap-6">
            <Link
              to="/"
              className="flex flex-col items-center text-gray-500 hover:text-gray-900 text-xs"
            >
              <Home className="w-6 h-6" />
              <span>Home</span>
            </Link>

            <Link
              to="/network"
              className="flex flex-col items-center text-gray-500 hover:text-gray-900 text-xs"
            >
              <Users className="w-6 h-6" />
              <span>My Network</span>
            </Link>

            <Link
              to="/jobs"
              className="flex flex-col items-center text-gray-500 hover:text-gray-900 text-xs"
            >
              <Briefcase className="w-6 h-6" />
              <span>Jobs</span>
            </Link>

            <button className="flex flex-col items-center text-gray-500 hover:text-gray-900 text-xs">
              <MessageSquare className="w-6 h-6" />
              <span>Messaging</span>
            </button>

            <button className="flex flex-col items-center text-gray-500 hover:text-gray-900 text-xs">
              <Bell className="w-6 h-6" />
              <span>Notifications</span>
            </button>

            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex flex-col items-center text-gray-500 hover:text-gray-900 text-xs"
              >
                <div className="w-6 h-6 rounded-full bg-gray-300 flex items-center justify-center text-xs font-bold text-white">
                  {user?.first_name?.[0]}
                </div>
                <span className="flex items-center gap-0.5">
                  Me <ChevronDown className="w-3 h-3" />
                </span>
              </button>

              {showDropdown && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 py-2">
                  <Link
                    to="/profile/$userId"
                    params={{ userId: String(user?.id) }}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-gray-100"
                    onClick={() => setShowDropdown(false)}
                  >
                    <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center font-bold">
                      {user?.first_name?.[0]}
                    </div>
                    <div>
                      <div className="font-semibold">{user?.first_name} {user?.last_name}</div>
                      <div className="text-sm text-gray-600 truncate">{user?.headline}</div>
                    </div>
                  </Link>
                  <hr className="my-2" />
                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-2 w-full px-4 py-2 text-left text-gray-600 hover:bg-gray-100"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
