/**
 * VideoCard Component
 *
 * Displays a single video as a card in content rows.
 * Features hover expansion with additional info and quick actions.
 * Supports progress bar display for continue watching items.
 */
import React from 'react';
import { Link } from '@tanstack/react-router';
import { Play, Plus, Check, ChevronDown } from 'lucide-react';
import type { Video } from '../types';
import { useBrowseStore } from '../stores/browseStore';

/** Props for VideoCard component */
interface VideoCardProps {
  /** Video to display */
  video: Video;
  /** Whether to show progress bar */
  showProgress?: boolean;
  /** Progress percentage (0-100) */
  progressPercent?: number;
}

/**
 * Video card with hover expansion effect.
 * Shows poster thumbnail, expands on hover to reveal actions and metadata.
 */
export function VideoCard({ video, showProgress, progressPercent = 0 }: VideoCardProps) {
  const [isHovered, setIsHovered] = React.useState(false);
  const [inMyList, setInMyList] = React.useState(false);
  const { addToMyList, removeFromMyList } = useBrowseStore();

  const posterUrl = video.posterUrl || '/placeholder-poster.jpg';

  const handleMyListToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (inMyList) {
      await removeFromMyList(video.id);
      setInMyList(false);
    } else {
      await addToMyList(video.id);
      setInMyList(true);
    }
  };

  return (
    <div
      className="relative flex-shrink-0 w-[200px] md:w-[240px] transition-transform duration-300 group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Link to="/video/$videoId" params={{ videoId: video.id }}>
        {/* Poster */}
        <div className="relative aspect-video rounded overflow-hidden bg-zinc-800">
          <img
            src={posterUrl}
            alt={video.title}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).src = '/placeholder-poster.jpg';
            }}
          />

          {/* Progress bar */}
          {showProgress && progressPercent > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-600">
              <div
                className="h-full bg-netflix-red"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
        </div>

        {/* Hover card */}
        {isHovered && (
          <div className="absolute top-0 left-0 right-0 bg-netflix-dark rounded shadow-xl z-10 transform scale-110 origin-center">
            {/* Poster */}
            <div className="aspect-video rounded-t overflow-hidden">
              <img
                src={posterUrl}
                alt={video.title}
                className="w-full h-full object-cover"
              />
            </div>

            {/* Info */}
            <div className="p-3">
              {/* Action buttons */}
              <div className="flex items-center gap-2 mb-3">
                <Link
                  to="/watch/$videoId"
                  params={{ videoId: video.id }}
                  className="w-8 h-8 rounded-full bg-white flex items-center justify-center hover:bg-white/80"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Play size={16} fill="black" className="ml-0.5" />
                </Link>

                <button
                  onClick={handleMyListToggle}
                  className="w-8 h-8 rounded-full border-2 border-zinc-400 flex items-center justify-center hover:border-white"
                >
                  {inMyList ? (
                    <Check size={16} className="text-white" />
                  ) : (
                    <Plus size={16} className="text-white" />
                  )}
                </button>

                <Link
                  to="/video/$videoId"
                  params={{ videoId: video.id }}
                  className="w-8 h-8 rounded-full border-2 border-zinc-400 flex items-center justify-center hover:border-white ml-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ChevronDown size={16} className="text-white" />
                </Link>
              </div>

              {/* Title */}
              <h3 className="text-white font-medium text-sm mb-1 truncate">
                {video.title}
              </h3>

              {/* Metadata */}
              <div className="flex items-center gap-2 text-xs text-netflix-light-gray">
                {video.rating && (
                  <span className="px-1 border border-netflix-gray">{video.rating}</span>
                )}
                {video.releaseYear && <span>{video.releaseYear}</span>}
                {video.type === 'series' && <span>Series</span>}
              </div>

              {/* Genres */}
              <div className="flex flex-wrap gap-1 mt-2">
                {video.genres.slice(0, 2).map((genre, index) => (
                  <React.Fragment key={genre}>
                    {index > 0 && <span className="text-zinc-600">•</span>}
                    <span className="text-xs text-netflix-light-gray">{genre}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}
      </Link>
    </div>
  );
}
