import React from 'react';
import { useParams, useNavigate, Link } from '@tanstack/react-router';
import { Play, Plus, Check, ChevronDown, X } from 'lucide-react';
import { Navbar, VideoRow } from '../components';
import { videoService } from '../services/videos';
import type { Video, Season, Episode } from '../types';
import { useBrowseStore } from '../stores/browseStore';

export function VideoDetailPage() {
  const { videoId } = useParams({ from: '/video/$videoId' });
  const navigate = useNavigate();
  const { addToMyList, removeFromMyList } = useBrowseStore();

  const [video, setVideo] = React.useState<Video | null>(null);
  const [similarVideos, setSimilarVideos] = React.useState<Video[]>([]);
  const [selectedSeason, setSelectedSeason] = React.useState<Season | null>(null);
  const [inMyList, setInMyList] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    loadVideo();
  }, [videoId]);

  const loadVideo = async () => {
    setIsLoading(true);
    try {
      const [{ video: videoData }, { videos: similar }, { inList }] = await Promise.all([
        videoService.getVideo(videoId),
        videoService.getSimilar(videoId),
        videoService.checkMyList(videoId),
      ]);

      setVideo(videoData);
      setSimilarVideos(similar);
      setInMyList(inList);

      // Select first season by default for series
      if (videoData.seasons && videoData.seasons.length > 0) {
        setSelectedSeason(videoData.seasons[0]);
      }
    } catch (error) {
      console.error('Failed to load video:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMyListToggle = async () => {
    if (inMyList) {
      await removeFromMyList(videoId);
      setInMyList(false);
    } else {
      await addToMyList(videoId);
      setInMyList(true);
    }
  };

  const handlePlay = (episodeId?: string) => {
    if (episodeId) {
      navigate({
        to: '/watch/$videoId',
        params: { videoId },
        search: { episodeId },
      });
    } else {
      navigate({ to: '/watch/$videoId', params: { videoId } });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-netflix-black flex items-center justify-center">
        <div className="w-16 h-16 border-4 border-netflix-red border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!video) {
    return (
      <div className="min-h-screen bg-netflix-black flex items-center justify-center">
        <p className="text-white">Video not found</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-netflix-black">
      <Navbar />

      {/* Hero section */}
      <div className="relative h-[70vh] min-h-[500px]">
        {/* Background */}
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${video.backdropUrl || '/placeholder-backdrop.jpg'})`,
            backgroundColor: '#333',
          }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/50 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-netflix-black via-transparent to-transparent" />
        </div>

        {/* Close button */}
        <button
          onClick={() => navigate({ to: '/browse' })}
          className="absolute top-20 right-8 z-20 w-10 h-10 rounded-full bg-netflix-dark flex items-center justify-center hover:bg-zinc-700"
        >
          <X size={24} className="text-white" />
        </button>

        {/* Content */}
        <div className="absolute bottom-0 left-0 right-0 px-4 md:px-12 pb-12">
          <div className="max-w-2xl">
            <h1 className="text-4xl md:text-6xl font-bold text-shadow mb-4">
              {video.title}
            </h1>

            {/* Metadata */}
            <div className="flex items-center gap-4 text-sm mb-4">
              {video.releaseYear && (
                <span className="text-white">{video.releaseYear}</span>
              )}
              {video.rating && (
                <span className="px-2 py-0.5 border border-netflix-gray text-netflix-light-gray text-xs">
                  {video.rating}
                </span>
              )}
              {video.type === 'movie' && video.durationMinutes && (
                <span className="text-netflix-light-gray">
                  {Math.floor(video.durationMinutes / 60)}h {video.durationMinutes % 60}m
                </span>
              )}
              {video.type === 'series' && video.seasons && (
                <span className="text-netflix-light-gray">
                  {video.seasons.length} Season{video.seasons.length > 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-3 mb-6">
              <button
                onClick={() => handlePlay(video.type === 'series' ? selectedSeason?.episodes[0]?.id : undefined)}
                className="flex items-center gap-2 bg-white text-black px-8 py-2 rounded font-semibold hover:bg-white/80 transition-colors"
              >
                <Play size={24} fill="black" />
                Play
              </button>

              <button
                onClick={handleMyListToggle}
                className="w-10 h-10 rounded-full border-2 border-netflix-gray flex items-center justify-center hover:border-white transition-colors"
              >
                {inMyList ? (
                  <Check size={20} className="text-white" />
                ) : (
                  <Plus size={20} className="text-white" />
                )}
              </button>
            </div>

            {/* Description */}
            <p className="text-white/90 leading-relaxed mb-4">
              {video.description}
            </p>

            {/* Genres */}
            <div className="flex flex-wrap gap-2">
              {video.genres.map((genre, index) => (
                <span key={genre}>
                  {index > 0 && <span className="text-netflix-gray mr-2">,</span>}
                  <span className="text-netflix-light-gray">{genre}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Episodes section for series */}
      {video.type === 'series' && video.seasons && (
        <div className="px-4 md:px-12 py-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-white text-2xl font-bold">Episodes</h2>

            {/* Season selector */}
            {video.seasons.length > 1 && (
              <div className="relative">
                <select
                  value={selectedSeason?.id}
                  onChange={(e) => {
                    const season = video.seasons?.find((s) => s.id === e.target.value);
                    if (season) setSelectedSeason(season);
                  }}
                  className="bg-netflix-dark border border-netflix-gray text-white px-4 py-2 rounded appearance-none pr-10 cursor-pointer"
                >
                  {video.seasons.map((season) => (
                    <option key={season.id} value={season.id}>
                      Season {season.seasonNumber}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={20}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white pointer-events-none"
                />
              </div>
            )}
          </div>

          {/* Episodes list */}
          <div className="space-y-4">
            {selectedSeason?.episodes.map((episode) => (
              <EpisodeCard
                key={episode.id}
                episode={episode}
                seasonNumber={selectedSeason.seasonNumber}
                onPlay={() => handlePlay(episode.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Similar videos */}
      {similarVideos.length > 0 && (
        <div className="py-8">
          <VideoRow title="More Like This" videos={similarVideos} />
        </div>
      )}
    </div>
  );
}

interface EpisodeCardProps {
  episode: Episode;
  seasonNumber: number;
  onPlay: () => void;
}

function EpisodeCard({ episode, seasonNumber, onPlay }: EpisodeCardProps) {
  return (
    <div
      onClick={onPlay}
      className="flex gap-4 p-4 rounded hover:bg-zinc-800 cursor-pointer group transition-colors"
    >
      {/* Episode number */}
      <div className="text-netflix-light-gray text-2xl font-medium w-8 flex-shrink-0">
        {episode.episodeNumber}
      </div>

      {/* Thumbnail */}
      <div className="relative w-32 md:w-40 aspect-video rounded overflow-hidden bg-zinc-800 flex-shrink-0">
        <img
          src={episode.thumbnailUrl || '/placeholder-backdrop.jpg'}
          alt={episode.title}
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).src = '/placeholder-backdrop.jpg';
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-10 h-10 rounded-full border-2 border-white flex items-center justify-center">
            <Play size={16} fill="white" className="ml-0.5" />
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-white font-medium truncate">{episode.title}</h3>
          {episode.durationMinutes && (
            <span className="text-netflix-light-gray text-sm flex-shrink-0 ml-4">
              {episode.durationMinutes}m
            </span>
          )}
        </div>
        <p className="text-netflix-gray text-sm line-clamp-2">{episode.description}</p>
      </div>
    </div>
  );
}
