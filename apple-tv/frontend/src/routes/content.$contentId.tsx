import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Header } from '../components';
import { contentApi, watchlistApi, watchProgressApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import type { Content, Episode, WatchProgress } from '../types';
import { formatDurationHuman, formatYear } from '../utils';
import { Play, Plus, Check, Star } from 'lucide-react';

function ContentDetailPage() {
  const { contentId } = Route.useParams();
  const navigate = useNavigate();
  const { currentProfile } = useAuthStore();

  const [content, setContent] = useState<Content | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [progress, setProgress] = useState<WatchProgress | null>(null);
  const [selectedSeason, setSelectedSeason] = useState(1);

  useEffect(() => {
    const loadContent = async () => {
      setIsLoading(true);
      try {
        const data = await contentApi.getById(contentId);
        setContent(data);

        // Check watchlist status
        if (currentProfile) {
          const watchlistStatus = await watchlistApi.check(contentId);
          setInWatchlist(watchlistStatus.inWatchlist);

          // Get watch progress
          const progressData = await watchProgressApi.getContentProgress(contentId);
          if (progressData.position > 0) {
            setProgress(progressData);
          }
        }
      } catch (error) {
        console.error('Failed to load content:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadContent();
  }, [contentId, currentProfile]);

  const handleWatchlistToggle = async () => {
    try {
      if (inWatchlist) {
        await watchlistApi.remove(contentId);
        setInWatchlist(false);
      } else {
        await watchlistApi.add(contentId);
        setInWatchlist(true);
      }
    } catch (error) {
      console.error('Watchlist error:', error);
    }
  };

  const handlePlay = (episodeId?: string) => {
    const id = episodeId || contentId;
    navigate({ to: '/watch/$contentId', params: { contentId: id } });
  };

  if (isLoading) {
    return (
      <>
        <Header />
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
        </div>
      </>
    );
  }

  if (!content) {
    return (
      <>
        <Header />
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-semibold mb-4">Content not found</h1>
            <Link to="/" className="text-apple-blue hover:underline">
              Go back home
            </Link>
          </div>
        </div>
      </>
    );
  }

  const seasons = content.seasons ? Object.keys(content.seasons).map(Number).sort() : [];
  const currentSeasonEpisodes = content.seasons?.[selectedSeason] || [];

  return (
    <>
      <Header />
      <main>
        {/* Hero section */}
        <div className="relative h-[70vh] min-h-[500px]">
          <div className="absolute inset-0">
            <img
              src={content.banner_url || content.thumbnail_url}
              alt={content.title}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />
          </div>

          <div className="absolute bottom-0 left-0 right-0 p-8 lg:p-16">
            <div className="max-w-3xl">
              <h1 className="text-4xl lg:text-6xl font-bold mb-4">{content.title}</h1>

              <div className="flex items-center gap-4 text-sm text-white/80 mb-4">
                {content.release_date && <span>{formatYear(content.release_date)}</span>}
                {content.duration > 0 && <span>{formatDurationHuman(content.duration)}</span>}
                {content.rating && (
                  <span className="px-2 py-0.5 border border-white/40 rounded">{content.rating}</span>
                )}
                {content.content_type === 'series' && seasons.length > 0 && (
                  <span>{seasons.length} Season{seasons.length > 1 ? 's' : ''}</span>
                )}
              </div>

              {content.genres && content.genres.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-white/60 mb-4">
                  {content.genres.map((genre, index) => (
                    <span key={genre}>
                      {genre}
                      {index < content.genres.length - 1 && ' · '}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-base lg:text-lg text-white/80 mb-6">{content.description}</p>

              <div className="flex items-center gap-4">
                <button
                  onClick={() => handlePlay()}
                  className="flex items-center gap-2 px-8 py-3 bg-white text-black font-semibold rounded-lg hover:bg-white/90 transition-colors"
                >
                  <Play className="w-5 h-5 fill-current" />
                  {progress && progress.position > 60 ? 'Resume' : 'Play'}
                </button>

                <button
                  onClick={handleWatchlistToggle}
                  className="flex items-center gap-2 px-6 py-3 bg-white/20 text-white font-semibold rounded-lg hover:bg-white/30 transition-colors"
                >
                  {inWatchlist ? (
                    <>
                      <Check className="w-5 h-5" />
                      In My List
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5" />
                      My List
                    </>
                  )}
                </button>
              </div>

              {progress && progress.position > 60 && (
                <div className="mt-4">
                  <div className="w-64 h-1 bg-white/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-white"
                      style={{ width: `${(progress.position / progress.duration) * 100}%` }}
                    />
                  </div>
                  <p className="text-sm text-white/60 mt-1">
                    {Math.round((progress.duration - progress.position) / 60)} minutes remaining
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Episodes section (for series) */}
        {content.content_type === 'series' && seasons.length > 0 && (
          <section className="px-8 lg:px-16 py-12">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold">Episodes</h2>

              {/* Season selector */}
              {seasons.length > 1 && (
                <select
                  value={selectedSeason}
                  onChange={(e) => setSelectedSeason(Number(e.target.value))}
                  className="px-4 py-2 bg-apple-gray-800 border border-white/20 rounded-lg focus:outline-none focus:ring-2 focus:ring-apple-blue"
                >
                  {seasons.map((season) => (
                    <option key={season} value={season}>
                      Season {season}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-4">
              {currentSeasonEpisodes.map((episode) => (
                <EpisodeCard
                  key={episode.id}
                  episode={episode}
                  onPlay={() => handlePlay(episode.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Technical details */}
        <section className="px-8 lg:px-16 py-12 border-t border-white/10">
          <h2 className="text-xl font-semibold mb-6">Details</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {content.variants && content.variants.length > 0 && (
              <div>
                <h3 className="text-sm text-white/60 mb-1">Quality</h3>
                <p>
                  {content.variants.some((v) => v.resolution >= 2160) ? '4K Ultra HD' : 'HD'}
                  {content.variants.some((v) => v.hdr) && ' · HDR'}
                </p>
              </div>
            )}
            {content.audioTracks && content.audioTracks.length > 0 && (
              <div>
                <h3 className="text-sm text-white/60 mb-1">Audio</h3>
                <p>{content.audioTracks.map((t) => t.name).join(', ')}</p>
              </div>
            )}
            {content.subtitles && content.subtitles.length > 0 && (
              <div>
                <h3 className="text-sm text-white/60 mb-1">Subtitles</h3>
                <p>{content.subtitles.map((s) => s.name).join(', ')}</p>
              </div>
            )}
            {content.rating && (
              <div>
                <h3 className="text-sm text-white/60 mb-1">Rating</h3>
                <p>{content.rating}</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}

function EpisodeCard({ episode, onPlay }: { episode: Episode; onPlay: () => void }) {
  return (
    <div className="flex gap-4 p-4 bg-apple-gray-800 rounded-xl hover:bg-apple-gray-700 transition-colors group">
      <div className="relative w-48 h-28 flex-shrink-0 rounded-lg overflow-hidden">
        <img
          src={episode.thumbnail_url}
          alt={episode.title}
          className="w-full h-full object-cover"
        />
        <button
          onClick={onPlay}
          className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Play className="w-10 h-10 fill-current" />
        </button>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-white/60 text-sm">
            Episode {episode.episode_number}
          </span>
          <span className="text-white/40">·</span>
          <span className="text-white/60 text-sm">
            {formatDurationHuman(episode.duration)}
          </span>
        </div>
        <h3 className="font-semibold mb-2">{episode.title}</h3>
        <p className="text-sm text-white/60 line-clamp-2">{episode.description}</p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/content/$contentId')({
  component: ContentDetailPage,
});
