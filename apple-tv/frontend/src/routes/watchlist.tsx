import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Header } from '../components';
import { watchlistApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import type { WatchlistItem } from '../types';
import { formatDurationHuman } from '../utils';
import { Play, X } from 'lucide-react';

/**
 * Watchlist page displaying user's saved content.
 * Shows all items the user has added to "My List" for later viewing.
 *
 * Features:
 * - Grid display of saved content thumbnails
 * - Click to navigate to content detail
 * - Hover to reveal play overlay and remove button
 * - Empty state with link to browse content
 * - Requires authentication and profile selection
 */
function WatchlistPage() {
  const navigate = useNavigate();
  const { user, currentProfile } = useAuthStore();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    if (!currentProfile) {
      navigate({ to: '/profiles' });
      return;
    }

    const loadWatchlist = async () => {
      try {
        const data = await watchlistApi.getAll();
        setWatchlist(data);
      } catch (error) {
        console.error('Failed to load watchlist:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadWatchlist();
  }, [user, currentProfile, navigate]);

  const handleRemove = async (contentId: string) => {
    try {
      await watchlistApi.remove(contentId);
      setWatchlist((prev) => prev.filter((item) => item.id !== contentId));
    } catch (error) {
      console.error('Failed to remove from watchlist:', error);
    }
  };

  if (!user || !currentProfile) {
    return null;
  }

  return (
    <>
      <Header />
      <main className="pt-24 px-8 lg:px-16 pb-16 min-h-screen">
        <h1 className="text-3xl font-bold mb-8">My List</h1>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
          </div>
        ) : watchlist.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-white/60 text-lg mb-4">Your list is empty</p>
            <Link
              to="/"
              className="inline-block px-6 py-3 bg-apple-blue text-white font-semibold rounded-lg hover:bg-blue-600 transition-colors"
            >
              Browse Content
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
            {watchlist.map((item) => (
              <div key={item.id} className="group relative">
                <Link
                  to="/content/$contentId"
                  params={{ contentId: item.id }}
                  className="block"
                >
                  <div className="relative aspect-video rounded-lg overflow-hidden">
                    <img
                      src={item.thumbnail_url}
                      alt={item.title}
                      className="w-full h-full object-cover transition-transform group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Play className="w-12 h-12 fill-current" />
                    </div>
                  </div>
                  <h3 className="mt-2 font-medium truncate">{item.title}</h3>
                  <div className="text-sm text-white/60">
                    {item.content_type === 'movie' && formatDurationHuman(item.duration)}
                    {item.content_type === 'series' && 'Series'}
                    {item.rating && ` · ${item.rating}`}
                  </div>
                </Link>

                {/* Remove button */}
                <button
                  onClick={() => handleRemove(item.id)}
                  className="absolute top-2 right-2 p-2 bg-black/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-apple-red"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

/**
 * Route configuration for watchlist page (/watchlist).
 * User's saved content list, also known as "My List".
 */
export const Route = createFileRoute('/watchlist')({
  component: WatchlistPage,
});
