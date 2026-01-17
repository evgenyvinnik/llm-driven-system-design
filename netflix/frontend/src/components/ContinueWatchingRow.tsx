/**
 * ContinueWatchingRow Component
 *
 * Specialized row for displaying in-progress content.
 * Shows larger thumbnails with episode info and progress bars.
 * Links directly to resume playback at the saved position.
 */
import React from 'react';
import { Link } from '@tanstack/react-router';
import { Play } from 'lucide-react';
import type { ContinueWatchingItem } from '../types';

/** Props for ContinueWatchingRow component */
interface ContinueWatchingRowProps {
  /** In-progress items with viewing progress data */
  items: ContinueWatchingItem[];
}

/**
 * Row displaying in-progress content for quick resume.
 * Shows progress bar, time remaining, and episode info for series.
 */
export function ContinueWatchingRow({ items }: ContinueWatchingRowProps) {
  if (items.length === 0) return null;

  return (
    <div className="py-4">
      <h2 className="row-title">Continue Watching</h2>

      <div className="flex gap-2 overflow-x-auto scrollbar-hide px-4 md:px-12">
        {items.map((item) => {
          const videoId = item.video.id;
          const episodeId = item.episode?.id;

          return (
            <Link
              key={`${videoId}-${episodeId || ''}`}
              to="/watch/$videoId"
              params={{ videoId }}
              search={episodeId ? { episodeId } : undefined}
              className="relative flex-shrink-0 w-[280px] md:w-[320px] group"
            >
              {/* Thumbnail */}
              <div className="relative aspect-video rounded overflow-hidden bg-zinc-800">
                <img
                  src={item.episode?.thumbnailUrl || item.video.backdropUrl || '/placeholder-backdrop.jpg'}
                  alt={item.video.title}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = '/placeholder-backdrop.jpg';
                  }}
                />

                {/* Play overlay */}
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-14 h-14 rounded-full bg-white/90 flex items-center justify-center">
                    <Play size={28} fill="black" className="ml-1" />
                  </div>
                </div>

                {/* Progress bar */}
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-600">
                  <div
                    className="h-full bg-netflix-red"
                    style={{ width: `${item.percentComplete}%` }}
                  />
                </div>
              </div>

              {/* Info */}
              <div className="mt-2">
                <h3 className="text-white font-medium text-sm truncate">
                  {item.video.title}
                </h3>
                {item.episode && (
                  <p className="text-netflix-light-gray text-xs mt-0.5">
                    S{item.episode.seasonNumber} E{item.episode.episodeNumber}: {item.episode.title}
                  </p>
                )}
                <p className="text-netflix-gray text-xs mt-1">
                  {formatTimeRemaining(item.durationSeconds - item.positionSeconds)} remaining
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Formats remaining time for display.
 *
 * @param seconds - Remaining time in seconds
 * @returns Formatted string (e.g., "1h 23m" or "45m")
 */
function formatTimeRemaining(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
