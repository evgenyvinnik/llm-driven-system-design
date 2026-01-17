/**
 * User settings page route.
 * Displays profile info, storage usage, and account management options.
 * Requires authentication; redirects to login if not authenticated.
 * @module routes/settings
 */

import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Sidebar } from '../components/Sidebar';
import { Loader2 } from 'lucide-react';
import { formatBytes, getStoragePercentage, getStorageColor } from '../utils/format';

/** Route definition for the settings page at /settings */
export const Route = createFileRoute('/settings')({
  component: Settings,
});

/**
 * Settings page component.
 * Shows user profile, storage quota, and account actions.
 */
function Settings() {
  const navigate = useNavigate();
  const { user, isLoading, checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!isLoading && !user) {
      navigate({ to: '/login' });
    }
  }, [isLoading, user, navigate]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-dropbox-blue" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const storagePercent = getStoragePercentage(user.usedBytes, user.quotaBytes);

  return (
    <div className="h-screen flex bg-gray-50">
      <Sidebar />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto py-8 px-6">
          <h1 className="text-2xl font-semibold text-gray-900 mb-8">Settings</h1>

          {/* Profile section */}
          <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Profile</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Name</label>
                <p className="text-gray-900">{user.name}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Email</label>
                <p className="text-gray-900">{user.email}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Role</label>
                <span className={`inline-block px-2 py-1 text-xs rounded ${
                  user.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'
                }`}>
                  {user.role === 'admin' ? 'Administrator' : 'User'}
                </span>
              </div>
            </div>
          </section>

          {/* Storage section */}
          <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Storage</h2>
            <div className="mb-4">
              <div className="flex justify-between mb-2">
                <span className="text-gray-600">Used</span>
                <span className="font-medium">{formatBytes(user.usedBytes)} of {formatBytes(user.quotaBytes)}</span>
              </div>
              <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full ${getStorageColor(storagePercent)} transition-all`}
                  style={{ width: `${storagePercent}%` }}
                />
              </div>
            </div>
            <p className="text-sm text-gray-500">
              You are using {storagePercent.toFixed(1)}% of your storage quota.
              {storagePercent >= 90 && ' Consider upgrading or deleting files.'}
            </p>
          </section>

          {/* Account section */}
          <section className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Account</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <div>
                  <p className="font-medium text-gray-900">Change password</p>
                  <p className="text-sm text-gray-500">Update your password</p>
                </div>
                <button className="px-4 py-2 text-dropbox-blue hover:bg-blue-50 rounded-lg transition-colors">
                  Change
                </button>
              </div>
              <div className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-red-600">Delete account</p>
                  <p className="text-sm text-gray-500">Permanently delete your account and all data</p>
                </div>
                <button className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                  Delete
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
