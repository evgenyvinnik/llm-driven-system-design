import { Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Avatar } from './Avatar';

export function Navbar() {
  const { user, isAuthenticated, logout } = useAuthStore();

  return (
    <nav className="bg-white border-b border-border-gray sticky top-0 z-40">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link to="/" className="text-2xl font-semibold">
          Instagram
        </Link>

        <div className="flex items-center gap-5">
          {isAuthenticated ? (
            <>
              <Link to="/" className="text-2xl" title="Home">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                  />
                </svg>
              </Link>
              <Link to="/explore" className="text-2xl" title="Explore">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </Link>
              <Link to="/create" className="text-2xl" title="Create">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
              </Link>
              <Link
                to="/profile/$username"
                params={{ username: user?.username || '' }}
              >
                <Avatar
                  src={user?.profilePictureUrl}
                  alt={user?.username || ''}
                  size="sm"
                />
              </Link>
              <button
                onClick={() => logout()}
                className="text-sm text-text-gray hover:text-gray-600"
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="px-4 py-1.5 bg-primary text-white rounded font-semibold text-sm"
              >
                Log In
              </Link>
              <Link to="/register" className="text-primary font-semibold text-sm">
                Sign Up
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
