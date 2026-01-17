/**
 * Shared with me page route.
 * Displays files and folders shared with the current user by others.
 * Requires authentication; redirects to login if not authenticated.
 * @module routes/shared
 */

import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Sidebar } from '../components/Sidebar';
import { FileIcon } from '../components/FileIcon';
import { sharingApi } from '../services/api';
import { FileItem } from '../types';
import { Loader2 } from 'lucide-react';
import { formatBytes, formatRelativeDate } from '../utils/format';

/** Route definition for the shared items page at /shared */
export const Route = createFileRoute('/shared')({
  component: SharedWithMe,
});

/**
 * Shared items list component.
 * Shows files and folders that others have shared with the current user.
 */
function SharedWithMe() {
  const navigate = useNavigate();
  const { user, isLoading: authLoading, checkAuth } = useAuthStore();
  const [sharedItems, setSharedItems] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: '/login' });
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (user) {
      loadSharedItems();
    }
  }, [user]);

  const loadSharedItems = async () => {
    setIsLoading(true);
    setError('');

    try {
      const items = await sharingApi.getSharedWithMe();
      setSharedItems(items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-dropbox-blue" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="h-screen flex bg-gray-50">
      <Sidebar />

      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-white">
          <h1 className="text-2xl font-semibold text-gray-900">Shared with me</h1>
        </div>

        <div className="flex-1 overflow-y-auto bg-white">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <Loader2 className="w-8 h-8 animate-spin text-dropbox-blue" />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center p-8 text-red-500">
              {error}
            </div>
          ) : sharedItems.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-gray-500">
              <div className="text-6xl mb-4">📤</div>
              <p className="text-lg font-medium">Nothing shared with you yet</p>
              <p className="text-sm">When someone shares a folder with you, it will appear here</p>
            </div>
          ) : (
            <div>
              {sharedItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center px-6 py-4 border-b border-gray-100 hover:bg-gray-50"
                >
                  <div className="mr-4">
                    <FileIcon mimeType={item.mimeType} isFolder={item.isFolder} size={32} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{item.name}</p>
                    <p className="text-sm text-gray-500">
                      Shared by {(item as unknown as { ownerName: string }).ownerName} - {formatRelativeDate(item.updatedAt)}
                      {!item.isFolder && ` - ${formatBytes(item.size)}`}
                    </p>
                  </div>
                  <span className="px-3 py-1 text-xs bg-gray-100 rounded-full text-gray-600">
                    {(item as unknown as { shareAccessLevel: string }).shareAccessLevel === 'edit' ? 'Can edit' : 'Can view'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
