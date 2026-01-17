import { Link, useNavigate } from '@tanstack/react-router';
import {
  Home,
  Search,
  Library,
  Radio,
  ListMusic,
  Plus,
  LogOut,
  Settings,
  User
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { useState } from 'react';

interface SidebarProps {
  playlists?: { id: string; name: string }[];
}

export function Sidebar({ playlists = [] }: SidebarProps) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <div className="w-64 bg-apple-card border-r border-apple-border flex flex-col h-full">
      {/* Logo */}
      <div className="p-6 border-b border-apple-border">
        <Link to="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-apple-red to-apple-pink flex items-center justify-center">
            <span className="text-white text-xl font-bold">M</span>
          </div>
          <span className="text-xl font-semibold">Music</span>
        </Link>
      </div>

      {/* Main Navigation */}
      <nav className="p-4">
        <ul className="space-y-1">
          <li>
            <Link
              to="/"
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition text-apple-text-secondary hover:text-white [&.active]:text-apple-red [&.active]:bg-white/5"
            >
              <Home className="w-5 h-5" />
              <span>Listen Now</span>
            </Link>
          </li>
          <li>
            <Link
              to="/browse"
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition text-apple-text-secondary hover:text-white [&.active]:text-apple-red [&.active]:bg-white/5"
            >
              <Search className="w-5 h-5" />
              <span>Browse</span>
            </Link>
          </li>
          <li>
            <Link
              to="/radio"
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition text-apple-text-secondary hover:text-white [&.active]:text-apple-red [&.active]:bg-white/5"
            >
              <Radio className="w-5 h-5" />
              <span>Radio</span>
            </Link>
          </li>
          {user && (
            <li>
              <Link
                to="/library"
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition text-apple-text-secondary hover:text-white [&.active]:text-apple-red [&.active]:bg-white/5"
              >
                <Library className="w-5 h-5" />
                <span>Library</span>
              </Link>
            </li>
          )}
        </ul>
      </nav>

      {/* Playlists */}
      {user && (
        <div className="flex-1 overflow-y-auto px-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-apple-text-secondary uppercase tracking-wider">
              Playlists
            </h3>
            <Link
              to="/playlists/new"
              className="p-1 rounded hover:bg-white/10 transition"
            >
              <Plus className="w-4 h-4 text-apple-text-secondary" />
            </Link>
          </div>
          <ul className="space-y-1">
            {playlists.map((playlist) => (
              <li key={playlist.id}>
                <Link
                  to="/playlists/$id"
                  params={{ id: playlist.id }}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition text-apple-text-secondary hover:text-white text-sm [&.active]:text-white"
                >
                  <ListMusic className="w-4 h-4" />
                  <span className="truncate">{playlist.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* User Section */}
      <div className="p-4 border-t border-apple-border">
        {user ? (
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition"
            >
              <div className="w-8 h-8 rounded-full bg-apple-border flex items-center justify-center">
                <User className="w-4 h-4" />
              </div>
              <div className="text-left flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user.displayName}</p>
                <p className="text-xs text-apple-text-secondary capitalize">
                  {user.subscriptionTier}
                </p>
              </div>
            </button>

            {showUserMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-apple-card border border-apple-border rounded-lg shadow-xl overflow-hidden">
                <Link
                  to="/settings"
                  className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition"
                  onClick={() => setShowUserMenu(false)}
                >
                  <Settings className="w-4 h-4" />
                  <span className="text-sm">Settings</span>
                </Link>
                {user.role === 'admin' && (
                  <Link
                    to="/admin"
                    className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition"
                    onClick={() => setShowUserMenu(false)}
                  >
                    <Settings className="w-4 h-4" />
                    <span className="text-sm">Admin Dashboard</span>
                  </Link>
                )}
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition text-red-400"
                >
                  <LogOut className="w-4 h-4" />
                  <span className="text-sm">Sign Out</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <Link
            to="/login"
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-apple-red hover:bg-apple-red/80 rounded-lg transition font-medium"
          >
            Sign In
          </Link>
        )}
      </div>
    </div>
  );
}
