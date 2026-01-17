import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState, useRef, useEffect } from 'react';

export function Header() {
  const { user, isAuthenticated, logout } = useAuthStore();
  const navigate = useNavigate();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  return (
    <header className="h-16 bg-spotify-black/80 backdrop-blur-md sticky top-0 z-10 flex items-center justify-between px-6">
      {/* Navigation arrows */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => window.history.back()}
          className="w-8 h-8 rounded-full bg-black/70 flex items-center justify-center text-white hover:bg-black/90"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
          </svg>
        </button>
        <button
          onClick={() => window.history.forward()}
          className="w-8 h-8 rounded-full bg-black/70 flex items-center justify-center text-white hover:bg-black/90"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
          </svg>
        </button>
      </div>

      {/* User menu */}
      <div className="flex items-center gap-4">
        {isAuthenticated ? (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="flex items-center gap-2 bg-black rounded-full p-1 pr-3 hover:bg-spotify-light-gray transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-spotify-light-gray flex items-center justify-center text-white text-sm font-bold overflow-hidden">
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt={user.display_name} className="w-full h-full object-cover" />
                ) : (
                  user?.display_name?.charAt(0).toUpperCase() || 'U'
                )}
              </div>
              <span className="text-white text-sm font-semibold">{user?.display_name}</span>
              <svg
                className={`w-4 h-4 text-white transition-transform ${showMenu ? 'rotate-180' : ''}`}
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M7 10l5 5 5-5z" />
              </svg>
            </button>

            {showMenu && (
              <div className="absolute right-0 mt-2 w-48 bg-spotify-light-gray rounded-md shadow-lg py-1">
                <Link
                  to="/library"
                  className="block px-4 py-2 text-sm text-white hover:bg-spotify-hover"
                  onClick={() => setShowMenu(false)}
                >
                  Your Library
                </Link>
                <hr className="border-gray-700 my-1" />
                <button
                  onClick={handleLogout}
                  className="block w-full text-left px-4 py-2 text-sm text-white hover:bg-spotify-hover"
                >
                  Log out
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <Link
              to="/register"
              className="text-spotify-text hover:text-white font-semibold text-sm"
            >
              Sign up
            </Link>
            <Link
              to="/login"
              className="bg-white text-black px-8 py-3 rounded-full font-semibold text-sm hover:scale-105 transition-transform"
            >
              Log in
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
