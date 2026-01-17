import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

export function Header() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate({ to: '/search', search: { q: searchQuery.trim() } });
    }
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-4 h-12 flex items-center gap-4">
        <Link to="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-reddit-orange rounded-full flex items-center justify-center">
            <span className="text-white font-bold text-lg">r</span>
          </div>
          <span className="font-bold text-xl hidden sm:block">reddit</span>
        </Link>

        <form onSubmit={handleSearch} className="flex-1 max-w-xl">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Reddit"
              className="w-full bg-gray-100 border border-gray-100 rounded-full py-1.5 px-4 pl-10 text-sm focus:outline-none focus:border-reddit-blue focus:bg-white"
            />
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
        </form>

        <div className="flex items-center gap-2">
          {user ? (
            <>
              <Link
                to="/submit"
                className="hidden sm:flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded-full text-sm hover:bg-gray-100"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                Create Post
              </Link>
              <div className="relative group">
                <button className="flex items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded">
                  <div className="w-6 h-6 bg-gray-300 rounded-full" />
                  <span className="hidden sm:block text-sm">{user.username}</span>
                  <span className="hidden sm:block text-xs text-gray-500">
                    {user.karma_post + user.karma_comment} karma
                  </span>
                </button>
                <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded shadow-lg hidden group-hover:block">
                  <Link
                    to="/u/$username"
                    params={{ username: user.username }}
                    className="block px-4 py-2 text-sm hover:bg-gray-100"
                  >
                    Profile
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100"
                  >
                    Log Out
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="px-4 py-1.5 border border-reddit-blue text-reddit-blue rounded-full text-sm font-medium hover:bg-blue-50"
              >
                Log In
              </Link>
              <Link
                to="/register"
                className="hidden sm:block px-4 py-1.5 bg-reddit-blue text-white rounded-full text-sm font-medium hover:bg-blue-700"
              >
                Sign Up
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
