import { Outlet, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { AuthModal } from './AuthModal';

export function RootLayout() {
  const { user, isLoading, fetchUser, logout } = useAuthStore();
  const { connect, disconnect, authenticate } = useChatStore();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (user) {
      authenticate(user.id, user.username);
    }
  }, [user, authenticate]);

  const handleShowLogin = () => {
    setAuthMode('login');
    setShowAuthModal(true);
  };

  const handleShowRegister = () => {
    setAuthMode('register');
    setShowAuthModal(true);
  };

  return (
    <div className="min-h-screen bg-surface-dark">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 h-14 bg-surface-darker z-50 flex items-center px-4 border-b border-gray-800">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2">
            <svg className="w-8 h-8 text-twitch-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
            </svg>
            <span className="text-xl font-bold text-white hidden sm:block">Twitch</span>
          </Link>

          <nav className="flex gap-4 ml-8">
            <Link
              to="/browse"
              className="text-gray-300 hover:text-twitch-400 font-semibold text-sm"
            >
              Browse
            </Link>
            {user && (
              <Link
                to="/following"
                className="text-gray-300 hover:text-twitch-400 font-semibold text-sm"
              >
                Following
              </Link>
            )}
          </nav>
        </div>

        <div className="flex-1 max-w-md mx-4">
          <input
            type="text"
            placeholder="Search"
            className="w-full bg-surface-light border border-gray-700 rounded px-4 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-twitch-500"
          />
        </div>

        <div className="flex items-center gap-3">
          {isLoading ? (
            <div className="w-8 h-8 bg-gray-700 rounded-full animate-pulse" />
          ) : user ? (
            <>
              <Link
                to="/dashboard"
                className="px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700 rounded"
              >
                Dashboard
              </Link>
              <div className="relative group">
                <button className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-twitch-500 rounded-full flex items-center justify-center text-white font-bold">
                    {user.displayName?.[0]?.toUpperCase() || user.username[0].toUpperCase()}
                  </div>
                </button>
                <div className="absolute right-0 top-full mt-2 w-48 bg-surface-lighter rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all">
                  <div className="p-3 border-b border-gray-700">
                    <p className="font-semibold text-white">{user.displayName || user.username}</p>
                    <p className="text-sm text-gray-400">@{user.username}</p>
                  </div>
                  <div className="p-2">
                    <Link
                      to={`/${user.username}`}
                      className="block px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 rounded"
                    >
                      Channel
                    </Link>
                    <button
                      onClick={() => logout()}
                      className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 rounded"
                    >
                      Log Out
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <button
                onClick={handleShowLogin}
                className="px-4 py-1.5 text-sm font-semibold text-white hover:bg-gray-700 rounded"
              >
                Log In
              </button>
              <button
                onClick={handleShowRegister}
                className="px-4 py-1.5 text-sm font-semibold text-white bg-twitch-500 hover:bg-twitch-600 rounded"
              >
                Sign Up
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="pt-14">
        <Outlet />
      </main>

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal
          mode={authMode}
          onClose={() => setShowAuthModal(false)}
          onSwitchMode={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
        />
      )}
    </div>
  );
}
