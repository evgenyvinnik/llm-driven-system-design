import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useVideoStore } from '../stores/videoStore';
import AuthModal from './AuthModal';
import UploadModal from './UploadModal';

export default function Header() {
  const { user, logout } = useAuthStore();
  const { searchVideos, clearSearch } = useVideoStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      searchVideos(searchQuery.trim());
    }
  };

  const handleLogoClick = () => {
    clearSearch();
    setSearchQuery('');
  };

  return (
    <>
      <header className="fixed top-0 left-0 right-0 h-14 bg-yt-dark flex items-center justify-between px-4 z-50">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-1" onClick={handleLogoClick}>
          <svg viewBox="0 0 90 20" className="h-5 w-auto">
            <g fill="none">
              <path d="M27.9727 3.12324C27.6435 1.89323 26.6768 0.926623 25.4468 0.597366C23.2197 2.24288e-07 14.285 0 14.285 0C14.285 0 5.35042 2.24288e-07 3.12323 0.597366C1.89323 0.926623 0.926623 1.89323 0.597366 3.12324C2.24288e-07 5.35042 0 10 0 10C0 10 2.24288e-07 14.6496 0.597366 16.8768C0.926623 18.1068 1.89323 19.0734 3.12323 19.4026C5.35042 20 14.285 20 14.285 20C14.285 20 23.2197 20 25.4468 19.4026C26.6768 19.0734 27.6435 18.1068 27.9727 16.8768C28.5701 14.6496 28.5701 10 28.5701 10C28.5701 10 28.5677 5.35042 27.9727 3.12324Z" fill="#FF0000"/>
              <path d="M11.4253 14.2854L18.8477 10.0004L11.4253 5.71533V14.2854Z" fill="white"/>
            </g>
            <text x="32" y="15" fill="white" fontSize="14" fontWeight="bold" fontFamily="Arial, sans-serif">YouTube</text>
          </svg>
        </Link>

        {/* Search bar */}
        <form onSubmit={handleSearch} className="flex-1 max-w-2xl mx-4">
          <div className="flex">
            <input
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-yt-dark border border-gray-700 text-white px-4 py-2 rounded-l-full focus:border-yt-blue focus:outline-none"
            />
            <button
              type="submit"
              className="bg-yt-dark-hover px-6 py-2 rounded-r-full border border-l-0 border-gray-700 hover:bg-gray-600"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
              </svg>
            </button>
          </div>
        </form>

        {/* User actions */}
        <div className="flex items-center gap-4">
          {user ? (
            <>
              {/* Upload button */}
              <button
                onClick={() => setShowUploadModal(true)}
                className="p-2 hover:bg-yt-dark-hover rounded-full"
                title="Upload video"
              >
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M14 13h-3v3H9v-3H6v-2h3V8h2v3h3v2zm3-7H3v12h14v-6.39l4 1.83V8.56l-4 1.83V6m1-1v3.83L22 7v8l-4-1.83V19H2V5h16z"/>
                </svg>
              </button>

              {/* User menu */}
              <div className="relative">
                <button
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  className="w-8 h-8 rounded-full bg-yt-red flex items-center justify-center text-white font-bold"
                >
                  {user.username.charAt(0).toUpperCase()}
                </button>

                {showUserMenu && (
                  <div className="absolute right-0 top-10 bg-yt-dark-lighter border border-gray-700 rounded-lg shadow-lg py-2 min-w-[200px]">
                    <div className="px-4 py-2 border-b border-gray-700">
                      <p className="font-medium">{user.channelName}</p>
                      <p className="text-sm text-gray-400">@{user.username}</p>
                    </div>
                    <Link
                      to="/channel/$channelId"
                      params={{ channelId: user.id }}
                      className="block px-4 py-2 hover:bg-yt-dark-hover"
                      onClick={() => setShowUserMenu(false)}
                    >
                      Your channel
                    </Link>
                    <Link
                      to="/studio"
                      className="block px-4 py-2 hover:bg-yt-dark-hover"
                      onClick={() => setShowUserMenu(false)}
                    >
                      YouTube Studio
                    </Link>
                    <button
                      onClick={() => {
                        logout();
                        setShowUserMenu(false);
                      }}
                      className="w-full text-left px-4 py-2 hover:bg-yt-dark-hover text-red-400"
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <button
              onClick={() => setShowAuthModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 border border-yt-blue text-yt-blue rounded-full hover:bg-blue-900/30"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
              </svg>
              Sign in
            </button>
          )}
        </div>
      </header>

      {/* Modals */}
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      {showUploadModal && <UploadModal onClose={() => setShowUploadModal(false)} />}
    </>
  );
}
