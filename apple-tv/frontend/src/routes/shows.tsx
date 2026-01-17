import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Header } from '../components';
import { contentApi } from '../services/api';
import type { Content } from '../types';
import { Play } from 'lucide-react';

function ShowsPage() {
  const [shows, setShows] = useState<Content[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadShows = async () => {
      try {
        const data = await contentApi.getAll({ type: 'series' });
        setShows(data);
      } catch (error) {
        console.error('Failed to load shows:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadShows();
  }, []);

  return (
    <>
      <Header />
      <main className="pt-24 px-8 lg:px-16 pb-16 min-h-screen">
        <h1 className="text-3xl font-bold mb-8">TV Shows</h1>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
          </div>
        ) : shows.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-white/60 text-lg">No TV shows available</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
            {shows.map((show) => (
              <Link
                key={show.id}
                to="/content/$contentId"
                params={{ contentId: show.id }}
                className="group"
              >
                <div className="relative aspect-video rounded-lg overflow-hidden">
                  <img
                    src={show.thumbnail_url}
                    alt={show.title}
                    className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Play className="w-12 h-12 fill-current" />
                  </div>
                  {show.featured && (
                    <div className="absolute top-2 left-2 px-2 py-1 bg-apple-blue text-xs font-medium rounded">
                      Featured
                    </div>
                  )}
                </div>
                <h3 className="mt-2 font-medium truncate group-hover:text-apple-blue transition-colors">
                  {show.title}
                </h3>
                <div className="text-sm text-white/60">
                  {show.genres?.slice(0, 2).join(' · ')}
                  {show.rating && ` · ${show.rating}`}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

export const Route = createFileRoute('/shows')({
  component: ShowsPage,
});
