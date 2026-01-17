import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Header } from '../components';
import { contentApi } from '../services/api';
import type { Content } from '../types';
import { formatDurationHuman } from '../utils';
import { Play } from 'lucide-react';

/**
 * Movies catalog page displaying all available movies.
 * Shows a grid of movie thumbnails with hover effects and metadata.
 *
 * Features:
 * - Responsive grid layout (2-5 columns based on viewport)
 * - Thumbnail with hover zoom and play overlay
 * - Featured badge for promoted content
 * - Duration and rating display
 * - Links to content detail page
 */
function MoviesPage() {
  const [movies, setMovies] = useState<Content[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadMovies = async () => {
      try {
        const data = await contentApi.getAll({ type: 'movie' });
        setMovies(data);
      } catch (error) {
        console.error('Failed to load movies:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadMovies();
  }, []);

  return (
    <>
      <Header />
      <main className="pt-24 px-8 lg:px-16 pb-16 min-h-screen">
        <h1 className="text-3xl font-bold mb-8">Movies</h1>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
          </div>
        ) : movies.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-white/60 text-lg">No movies available</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
            {movies.map((movie) => (
              <Link
                key={movie.id}
                to="/content/$contentId"
                params={{ contentId: movie.id }}
                className="group"
              >
                <div className="relative aspect-video rounded-lg overflow-hidden">
                  <img
                    src={movie.thumbnail_url}
                    alt={movie.title}
                    className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Play className="w-12 h-12 fill-current" />
                  </div>
                  {movie.featured && (
                    <div className="absolute top-2 left-2 px-2 py-1 bg-apple-blue text-xs font-medium rounded">
                      Featured
                    </div>
                  )}
                </div>
                <h3 className="mt-2 font-medium truncate group-hover:text-apple-blue transition-colors">
                  {movie.title}
                </h3>
                <div className="text-sm text-white/60">
                  {formatDurationHuman(movie.duration)}
                  {movie.rating && ` · ${movie.rating}`}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

/**
 * Route configuration for movies page (/movies).
 * Displays the full movie catalog for browsing.
 */
export const Route = createFileRoute('/movies')({
  component: MoviesPage,
});
