/**
 * Application sidebar component.
 * Contains navigation links, storage usage bar, and user info.
 * Shows admin link only for users with admin role.
 * @module components/Sidebar
 */

import { Link, useNavigate } from '@tanstack/react-router';
import { HardDrive, Users, Settings, LogOut, Shield } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { formatBytes, getStoragePercentage, getStorageColor } from '../utils/format';

/**
 * Renders the left sidebar with navigation and user info.
 * Returns null if no user is authenticated.
 */
export function Sidebar() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  if (!user) return null;

  const storagePercent = getStoragePercentage(user.usedBytes, user.quotaBytes);

  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
      {/* Logo */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <img src="/dropbox.svg" alt="Dropbox" className="w-8 h-8" />
          <span className="text-xl font-semibold text-gray-900">Dropbox</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          <li>
            <Link
              to="/"
              className="flex items-center gap-3 px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors [&.active]:bg-blue-50 [&.active]:text-dropbox-blue"
            >
              <HardDrive size={20} />
              <span>My files</span>
            </Link>
          </li>
          <li>
            <Link
              to="/shared"
              className="flex items-center gap-3 px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors [&.active]:bg-blue-50 [&.active]:text-dropbox-blue"
            >
              <Users size={20} />
              <span>Shared with me</span>
            </Link>
          </li>
          {user.role === 'admin' && (
            <li>
              <Link
                to="/admin"
                className="flex items-center gap-3 px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors [&.active]:bg-blue-50 [&.active]:text-dropbox-blue"
              >
                <Shield size={20} />
                <span>Admin</span>
              </Link>
            </li>
          )}
        </ul>
      </nav>

      {/* Storage */}
      <div className="p-4 border-t border-gray-200">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-gray-600">Storage</span>
          <span className="text-gray-900 font-medium">
            {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}
          </span>
        </div>
        <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full ${getStorageColor(storagePercent)} transition-all`}
            style={{ width: `${storagePercent}%` }}
          />
        </div>
      </div>

      {/* User */}
      <div className="p-4 border-t border-gray-200">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-dropbox-blue flex items-center justify-center text-white font-medium">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-gray-900 truncate">{user.name}</p>
            <p className="text-sm text-gray-500 truncate">{user.email}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            to="/settings"
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <Settings size={16} />
            <span>Settings</span>
          </Link>
          <button
            onClick={handleLogout}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <LogOut size={16} />
            <span>Logout</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
